"""Thread API contracts against migrated PostgreSQL, independent of step writers."""
from contextlib import nullcontext
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.main import app, connect
from app.social.threads import (EventView, ThreadParty, decode_cursor, encode_cursor, event_data,
                                normalize_text, touch_threads, write_event)
from test_api_contract import route_table
from test_deck_cost import launches, store  # noqa: F401
from test_friend_copies import collector, ok
from test_holdings import call


def thread(a, b, kind='trade', closed=False, age=0, *, conn=None):
    """A mapped round and its members, optionally inside a caller's fixture transaction."""
    tid, rid = uuid4(), uuid4()
    low, high = sorted((a, b))
    with (nullcontext(conn) if conn is not None else connect()) as conn:
        conn.execute("""INSERT INTO thread(id,kind,user_low,user_high,created_at,last_activity_at,changed_at)
          VALUES (%s,%s,%s,%s,now()-make_interval(days=>%s),now()-make_interval(days=>%s),now())""",
                     (tid, kind, low, high, age, age))
        conn.execute('INSERT INTO thread_member(thread_id,member_id) VALUES (%s,%s),(%s,%s)', (tid, a, tid, b))
        if kind == 'trade':
            conn.execute("""INSERT INTO trade(id,thread_id,state,closed_reason,proposer_id,recipient_id,
              proposer_name,recipient_name,created_at,closed_at)
              VALUES (%s,%s,%s,%s,%s,%s,'Ash','Misty',now(),CASE WHEN %s THEN now() END)""",
                         (rid, tid, 'closed' if closed else 'proposed', 'declined' if closed else None, a, b, closed))
        else:
            conn.execute("""INSERT INTO loan(id,thread_id,kind,state,lender_id,borrower_id,lender_name,borrower_name)
              VALUES (%s,%s,'borrow_request',%s,%s,%s,'Ash','Misty')""",
                         (rid, tid, 'requested', a, b))
            if closed:
                conn.execute("UPDATE loan SET state='closed',closed_reason='declined',closed_at=now() WHERE id=%s", (rid,))
        conn.execute('INSERT INTO thread_round_source(kind,round_id,thread_id) VALUES (%s,%s,%s)', (kind, rid, tid))
    return tid, rid


def message(user, tid, body='Hello', key=None, kind='trades'):
    return call('POST', f'/api/{kind}/{tid}/messages', user,
                {'body': body, 'idempotency_key': str(key or uuid4())})


def timeline(user, tid, kind='trades', before=''):
    return ok(call('GET', f'/api/{kind}/{tid}/timeline' + (f'?before={before}' if before else ''), user))


def test_message_normalization_replay_read_and_closed_chat(store):
    a, _ = collector('Ash')
    b, _ = collector('Misty')
    tid, _ = thread(a, b, closed=True)
    key = uuid4()
    first = ok(message(a, tid, ' \r\nCafe\u0301\x00\u202e\t! ', key), 201)
    assert first['body'] == 'Café\t!'
    assert ok(message(a, tid, 'Different replay body', key), 201) == first
    page = timeline(b, tid)
    assert page['you_are'] == ('low' if b < a else 'high')
    items = page['items']
    assert len(items) == 1 and items[0]['message']['from'] == 'them'
    result = ok(call('POST', f'/api/trades/{tid}/read', b, {'through': items[0]['cursor']}))
    assert result == {'read': True}
    assert ok(call('GET', '/api/threads/pulse', b))['trades']['unread'] == 0


@pytest.mark.parametrize('body,code', [(' \x00\u202e ', 'EMPTY_MESSAGE'), ('x' * 1001, 'MESSAGE_TOO_LONG')])
def test_message_text_refusals(body, code):
    with pytest.raises(HTTPException) as exc:
        normalize_text(body)
    assert exc.value.status_code == 422 and exc.value.detail['code'] == code


def test_block_is_read_only_and_replay_still_works(store):
    a, _ = collector()
    b, _ = collector()
    tid, _ = thread(a, b)
    key = uuid4()
    sent = ok(message(a, tid, key=key), 201)
    with connect() as conn:
        conn.execute('INSERT INTO block(blocker_id,blocked_id) VALUES (%s,%s)', (b, a))
    assert message(a, tid).status_code == 409
    assert message(b, tid).status_code == 409
    assert ok(message(a, tid, key=key), 201) == sent
    assert timeline(b, tid)['items'][0]['message']['body'] == 'Hello'


def test_membership_kind_and_deleted_old_routes(store):
    a, _ = collector()
    b, _ = collector()
    stranger, _ = collector()
    tid, _ = thread(a, b)
    assert message(stranger, tid).status_code == 404
    assert message(a, tid, kind='loans').status_code == 404
    assert call('GET', f'/api/loans/{tid}/timeline', a).status_code == 404
    assert not any(path.startswith('/api/social/conversations') for _,path,_ in route_table())
    assert call('POST', f'/api/social/traders/{uuid4()}/messages', a,
                {'body': 'Hello', 'idempotency_key': str(uuid4())}).status_code == 404


def test_read_uses_stored_item_boundary_and_never_moves_back(store):
    a, _ = collector()
    b, _ = collector()
    tid, rid = thread(a, b)
    ok(message(a, tid), 201)
    with connect() as conn:
        write_event(conn, tid, 'accepted', rid, actor='low')
        touch_threads(conn, [tid, tid])
    page = timeline(b, tid)
    newest, oldest = page['items']
    assert newest['kind'] == 'event'
    for cursor in (newest['cursor'], oldest['cursor']):
        ok(call('POST', f'/api/trades/{tid}/read', b, {'through': cursor}))
    with connect() as conn:
        read = conn.execute('SELECT read_at FROM thread_member WHERE thread_id=%s AND member_id=%s',
                            (tid, b)).fetchone()['read_at']
    assert read.isoformat().replace('+00:00', 'Z') == newest['at']
    forged = encode_cursor(datetime.now(timezone.utc), 'message', UUID(oldest['message']['id']))
    assert call('POST', f'/api/trades/{tid}/read', b, {'through': forged}).status_code == 422


@pytest.mark.parametrize('value', ['!', 'a' * 201, 'eA', 'wrong-kind'])
def test_invalid_timeline_cursors(value):
    if value == 'wrong-kind':
        value = encode_cursor(datetime.now(timezone.utc), 'trade', uuid4())
    with pytest.raises(HTTPException):
        decode_cursor(value, ('message', 'event'))


def test_thread_schema_id_kind_and_event_privacy():
    assert 'trader_id' in ThreadParty.model_fields
    assert not {'collector_id', 'user_id', 'handle', 'location_id', 'deck_id'} & ThreadParty.model_fields.keys()
    assert EventView.model_fields['actor'].annotation is not str
    for private in ('location_id', 'deck_id', 'pick', 'handle', 'user_id'):
        with pytest.raises(ValidationError):
            event_data({private: 'secret'})
        with pytest.raises(ValidationError):
            event_data({'returned': [{'edition_id': str(uuid4()), 'quantity': 1, private: 'secret'}]})
    assert event_data({'lines': [{'giver': 'low', 'edition_id': str(uuid4()), 'from_qty': 0, 'to_qty': 1}]})


def test_new_contact_limit_exempts_shared_threads_and_friends(store):
    from app.social.discovery import count_new_contact, new_contact_lock
    from app.social.owners import lock_owners
    from test_friend_copies import befriend
    a, _ = collector()
    b, _ = collector()
    c, _ = collector()
    d, _ = collector()
    thread(a, b)
    befriend(a, c)
    with connect() as conn, conn.transaction():
        new_contact_lock(conn, a)
        lock_owners(conn, a, b, c, d)
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'new_conversation' FROM generate_series(1,10)", (a,))
        count_new_contact(conn, a, b)
        count_new_contact(conn, a, c)
        with pytest.raises(HTTPException) as exc:
            count_new_contact(conn, a, d)
        assert exc.value.status_code == 429


def test_message_rate_limit_rolls_back_and_replay_does_not_count(store):
    a, _ = collector()
    b, _ = collector()
    tid, _ = thread(a, b)
    key = uuid4()
    first = ok(message(a, tid, key=key), 201)
    with connect() as conn:
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'message' FROM generate_series(1,119)", (a,))
    assert ok(message(a, tid, key=key), 201) == first
    limited = message(a, tid)
    assert limited.status_code == 429
    assert limited.json()['detail']['code'] == 'MESSAGE_RATE_LIMITED'
    assert len(timeline(a, tid)['items']) == 1


def test_timeline_pages_have_no_duplicates_and_message_times_match_touch(store):
    from app.social.threads import ThreadTouch
    a, _ = collector()
    b, _ = collector()
    tid, rid = thread(a, b, closed=True)
    with connect() as conn:
        for _ in range(51):
            write_event(conn, tid, 'declined', rid)
        touch_threads(conn, [tid])
    newest = ok(message(a, tid), 201)
    first = timeline(b, tid)
    second = timeline(b, tid, before=first['next_before'])
    assert len(first['items']) == 50 and len(second['items']) == 2
    cursors = [item['cursor'] for item in first['items'] + second['items']]
    assert len(set(cursors)) == 52 and second['next_before'] is None
    with connect() as conn:
        row = conn.execute('SELECT * FROM thread WHERE id=%s', (tid,)).fetchone()
        slot = 'last_from_low_at' if row['user_low'] == a else 'last_from_high_at'
        assert row[slot] == row['last_activity_at']
        assert row[slot].isoformat().replace('+00:00', 'Z') == newest['at']
        before = row['last_activity_at']
        touch_threads(conn, [ThreadTouch(id=tid, activity=False)])
        assert conn.execute('SELECT last_activity_at FROM thread WHERE id=%s', (tid,)).fetchone()['last_activity_at'] == before


def test_legacy_contact_exempts_first_new_trade_and_unseen_contact_is_counted(store):
    from app.social.discovery import count_new_contact, new_contact_lock
    from app.social.owners import lock_owners
    a, _ = collector()
    b, _ = collector()
    c, _ = collector()
    low, high = sorted((a, b))
    with connect() as conn:
        conn.execute('INSERT INTO legacy_contact VALUES (%s,%s)', (low, high))
        new_contact_lock(conn, a)
        lock_owners(conn, a, b, c)
        count_new_contact(conn, a, b)
        assert conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE user_id=%s AND kind='new_conversation'",
                            (a,)).fetchone()['n'] == 0
        count_new_contact(conn, a, c)
        assert conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE user_id=%s AND kind='new_conversation'",
                            (a,)).fetchone()['n'] == 1


@pytest.mark.parametrize('deleted_slot', ['low', 'high'])
def test_deleted_counterpart_keeps_timeline_and_retained_name(store, deleted_slot):
    prefix = 'thread-deletion-' + uuid4().hex
    a, b = prefix + '-a', prefix + '-z'
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s),(%s)', (a, b))
        conn.execute("UPDATE collector_profile SET display_name='Ash' WHERE user_id=%s", (a,))
        conn.execute("UPDATE collector_profile SET display_name='Misty' WHERE user_id=%s", (b,))
    deleted, survivor = (a, b) if deleted_slot == 'low' else (b, a)
    tid, _ = thread(a, b, closed=True)
    ok(message(deleted, tid), 201)
    with connect() as conn:
        conn.execute('DELETE FROM inventory_owner WHERE user_id=%s', (deleted,))
    assert timeline(survivor, tid)['items'][0]['message']['from'] == 'them'
    rows = ok(call('GET', '/api/trades?group=needs_you', survivor))
    assert len(rows) == 1 and rows[0]['id'] == str(tid)
    assert rows[0]['unread'] == 1
    assert rows[0]['other']['trader_id'] is None
    assert rows[0]['other']['display_name'] == ('Ash' if deleted_slot == 'low' else 'Misty')
    counts = ok(call('GET', '/api/threads/pulse', survivor))['trades']
    assert counts == {'needs_you': 1, 'waiting': 0, 'unread': 1}
    assert message(survivor, tid).status_code == 409


@pytest.mark.parametrize('partner_kind', ['trade', 'loan', 'legacy'])
def test_discovery_visibility_uses_durable_partners_and_current_reach(store, partner_kind):
    from test_open_discovery import discovery
    a, _ = collector()
    b, _ = collector()
    if partner_kind == 'legacy':
        with connect() as conn:
            conn.execute('INSERT INTO legacy_contact VALUES (%s,%s)', tuple(sorted((a, b))))
    else:
        thread(a, b, kind=partner_kind, closed=True)
    with connect() as conn:
        assert conn.execute('SELECT 1 FROM conversation WHERE user_low=%s AND user_high=%s',
                            tuple(sorted((a, b)))).fetchone() is None
    assert discovery(a)['status'] == 'off'
    assert discovery(a)['visible_beyond_friends'] is True
    with connect() as conn:
        conn.execute('INSERT INTO block(blocker_id,blocked_id) VALUES (%s,%s)', (b, a))
    assert discovery(a)['visible_beyond_friends'] is False
    with connect() as conn:
        conn.execute('DELETE FROM block WHERE blocker_id=%s AND blocked_id=%s', (b, a))
        conn.execute('UPDATE collector_profile SET suspended_at=now() WHERE user_id=%s', (b,))
    assert discovery(a)['visible_beyond_friends'] is False


@pytest.mark.parametrize('confirmer', ['lender', 'borrower'])
def test_either_partial_handover_belongs_to_out_now(store, confirmer):
    a, _ = collector()
    b, _ = collector()
    tid, rid = thread(a, b, kind='loan')
    with connect() as conn:
        conn.execute(f"UPDATE loan SET state='accepted',accepted_at=now(),{confirmer}_handover_at=now() WHERE id=%s", (rid,))
    reader = a if confirmer == 'lender' else b
    out_now = ok(call('GET', '/api/loans?group=out_now', reader))
    assert [item['id'] for item in out_now] == [str(tid)]
    assert out_now[0]['state'] == 'accepted' and out_now[0]['section'] == 'out_now'
    assert ok(call('GET', '/api/loans?group=pending', reader)) == []


def test_trade_list_summary_counts_all_lines_caps_thumbnails_and_orients_cash(store):
    from want_list_swap_fixtures import seed_swap_catalog
    editions = list(seed_swap_catalog().values())[:4]
    a, _ = collector()
    b, _ = collector()
    tid, rid = thread(a, b, closed=True)
    with connect() as conn:
        for position, edition in enumerate(editions):
            conn.execute('INSERT INTO trade_line(trade_id,side,edition_id,position,quantity) VALUES (%s,%s,%s,%s,%s)',
                         (rid, 'proposer' if position < 2 else 'recipient', edition, position, position + 1))
        conn.execute("UPDATE trade SET cash_cents=1250,cash_payer='recipient' WHERE id=%s", (rid,))
    for reader, give, get, payer in ((a, '3', '7', 'them'), (b, '7', '3', 'you')):
        item = ok(call('GET', '/api/trades?group=done', reader))[0]
        assert item['you_are'] == ('low' if reader == min(a, b) else 'high')
        assert item['closed_reason'] is None
        summary = item['summary']
        assert summary['you_give'] == give and summary['you_get'] == get
        assert summary['cash'] == {'cents': '1250', 'payer': payer}
        assert len(summary['cards']) == 3
        assert all(set(card) == {'edition_id', 'name', 'image_url', 'copies', 'side'} for card in summary['cards'])
        assert {card['side'] for card in summary['cards']} == {'you_give', 'you_get'}


@pytest.mark.parametrize('closed,reason,accepted,promised,quantity', [
    (False, None, False, 0, '5'),
    (True, 'declined', False, 0, '5'),
    (True, 'withdrawn', False, 0, '5'),
    (True, 'cancelled', False, 0, '5'),
    (True, 'cancelled', True, 3, '3'),
    (True, 'returned', True, 3, '3'),
    (True, 'written_off', True, 3, '3'),
])
def test_loan_list_summary_orients_requested_and_promised_quantities(store, closed, reason, accepted, promised, quantity):
    from want_list_swap_fixtures import seed_swap_catalog
    edition = seed_swap_catalog()['PAL 185']
    a, _ = collector()
    b, _ = collector()
    tid, rid = thread(a, b, kind='loan', closed=closed)
    with connect() as conn:
        if closed:
            conn.execute('UPDATE loan SET closed_reason=%s,accepted_at=CASE WHEN %s THEN now() END WHERE id=%s',
                         (reason, accepted, rid))
        conn.execute('INSERT INTO loan_line(loan_id,edition_id,position,requested,promised) VALUES (%s,%s,0,5,%s)',
                     (rid, edition, promised))
    for reader, side in ((a, 'you_give'), (b, 'you_get')):
        groups = ('needs_you', 'done') if closed else ('needs_you', 'open')
        rows = [item for group in groups for item in ok(call('GET', '/api/loans?group=' + group, reader))]
        item = next(item for item in rows if item['id'] == str(tid))
        detail = ok(call('GET', f'/api/loans/{tid}', reader))
        assert item['closed_reason'] == detail['live_terms']['closed_reason'] == reason
        summary = item['summary']
        assert summary[side] == quantity
        assert summary['you_get' if side == 'you_give' else 'you_give'] == '0'
        assert summary['cash'] is None and summary['cards'][0]['side'] == side
    outsider, _ = collector()
    for group in ('needs_you', 'open', 'out_now', 'pending', 'done'):
        assert ok(call('GET', '/api/loans?group=' + group, outsider)) == []
    assert call('GET', f'/api/loans/{tid}', outsider).status_code == 404


@pytest.mark.parametrize('viewer_role', ['lender', 'borrower'])
@pytest.mark.parametrize('condition', ['active', 'closed', 'blocked_by_viewer', 'blocked_by_other',
                                       'suspended_viewer', 'suspended_other', 'deleted_other'])
def test_loan_detail_public_party_never_reveals_more_than_its_list(store, viewer_role, condition):
    a, _ = collector('Ash')
    b, _ = collector('Misty')
    tid, _ = thread(a, b, kind='loan', closed=condition == 'closed')
    viewer, other = (a, b) if viewer_role == 'lender' else (b, a)
    with connect() as conn:
        if condition.startswith('blocked_'):
            blocker, blocked = (viewer, other) if condition == 'blocked_by_viewer' else (other, viewer)
            conn.execute('INSERT INTO block(blocker_id,blocked_id) VALUES (%s,%s)', (blocker, blocked))
        elif condition.startswith('suspended_'):
            suspended = viewer if condition == 'suspended_viewer' else other
            conn.execute('UPDATE collector_profile SET suspended_at=now() WHERE user_id=%s', (suspended,))
        elif condition == 'deleted_other':
            conn.execute('DELETE FROM inventory_owner WHERE user_id=%s', (other,))
    listed = [item for group in ('needs_you', 'open', 'out_now', 'pending', 'done')
              for item in ok(call('GET', f'/api/loans?group={group}', viewer)) if item['id'] == str(tid)]
    assert listed
    detail = ok(call('GET', f'/api/loans/{tid}', viewer))
    assert detail['other'] == listed[0]['other']
    assert set(detail['other']) == {'trader_id', 'display_name', 'friend', 'available'}
    assert detail['live_terms']['other']['collector_id'] == (None if condition == 'deleted_other' else other)
    assert (detail['other']['trader_id'] is None) == (condition == 'deleted_other')
    if condition.startswith(('blocked_', 'suspended_')) or condition == 'deleted_other':
        assert detail['other']['available'] is False
        assert detail['other']['friend'] is False
    assert not {'collector_id', 'user_id', 'handle', 'location_id', 'deck_id'} & detail['other'].keys()


def test_each_timeline_page_resolves_all_public_event_editions_without_mutating_data(store):
    from want_list_swap_fixtures import seed_swap_catalog
    ids = seed_swap_catalog()
    a, _ = collector('Ash')
    b, _ = collector('Misty')
    tid, rid = thread(a, b, closed=True)
    data = {'lines': [{'giver': 'low', 'edition_id': ids['PAL 185'], 'from_qty': 1, 'to_qty': 0}],
            'not_lent': [{'edition_id': ids['SVI 166'], 'quantity': 1}],
            'returned': [{'edition_id': ids['PAL 185'], 'quantity': 1}]}
    with connect() as conn:
        for _ in range(52):
            write_event(conn, tid, 'countered', rid, actor='low', data=data)
    seen = []
    before = ''
    while True:
        page = timeline(b, tid, before=before)
        for item in page['items']:
            assert item['event']['data'] == data
            labels = item['event']['editions']
            assert {card['edition_id'] for card in labels} == {ids['PAL 185'], ids['SVI 166']}
            assert all(set(card) == {'edition_id', 'name', 'set_code', 'collector_number', 'variant_label'} for card in labels)
            seen.append(item['event']['id'])
        if not page['next_before']:
            break
        before = page['next_before']
    assert len(seen) == len(set(seen)) == 52
    with connect() as conn:
        assert all(row['data'] == data for row in conn.execute('SELECT data FROM thread_event WHERE thread_id=%s', (tid,)))


@pytest.mark.parametrize('low', [True, False])
def test_private_closure_projection_fences_every_public_event_field(low):
    from app.social.threads import timeline_item
    row = dict(id=uuid4(), created_at=datetime.now(timezone.utc), item_kind='event',
               actor='high' if low else 'low', round_id=uuid4(), return_id=None, data={})
    blocked = timeline_item(dict(row, kind='closed_blocked'), low).model_dump(mode='json')
    suspended = timeline_item(dict(row, kind='closed_suspended'), low).model_dump(mode='json')
    assert blocked == suspended
    assert blocked['event']['actor'] is None and blocked['event']['data'] == {}
    # Even a historical anomalous payload cannot identify the private action.
    contaminated = dict(row, kind='closed_suspended', return_id=uuid4(),
                        data={'return_by': {'from': None, 'to': '2026-12-01'}})
    assert timeline_item(contaminated, low).model_dump(mode='json') == suspended
    own = timeline_item(dict(row, kind='closed_blocked'), not low)
    assert own.event.kind == 'closed_blocked' and own.event.actor == row['actor']


def test_event_variant_identity_is_typed_and_never_projects_arbitrary_descriptor_data():
    from app.social.threads import EventEdition, public_variant_label
    assert set(EventEdition.model_fields) == {'edition_id', 'name', 'set_code', 'collector_number', 'variant_label'}
    assert EventEdition.model_fields['variant_label'].annotation is str
    cases = [({}, 'Unspecified Variant'), ({'finish': 'reverse'}, 'Reverse Holo'),
             ({'type': 'normal', 'stamps': ['first-edition'], 'size': 'standard'}, 'Normal, First Edition'),
             ({'kind': 'unspecified', 'label': 'ignored'}, 'Unspecified Variant'),
             ({'label': ' Reviewed foil '}, 'Reviewed foil'),
             ({'finish': 'holo', 'productId': 'secret', 'location': 'secret',
               'foil': {'private': 'secret'}, 'stamps': [{'deck': 'secret'}]}, 'Holo')]
    for descriptor, expected in cases:
        assert public_variant_label(descriptor) == expected
