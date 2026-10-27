"""Reports, the owner queue, removal and suspension (Trading #303), through signed HTTP against PostgreSQL.

WP-A section: the plumbing and the carry-forwards. Migration 149, the discovery helpers, the generalised Friend command
payload, the suspended-sender refusals, a suspended Friend's Trade List, the Trades-tab flag and the conversation
watermark that suspension moves.
"""
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from app.main import app, connect  # noqa: F401
from app.social import conversations, reports
from app.social.discovery import (account_state, remove_from_discovery, restore_discovery, switch_off)
from app.social.friends import command_payload
from stranger_fixtures import far_zip, propose_to, strangers, trader_of
from test_catalog_references import migrate
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_conversations import detail, pulse, say, say_to, start, swapped, view
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, detail as deck_detail, hold, line
from test_for_trade_locations import mark
from test_friend_copies import befriend, block, collector, node, ok, place
from test_friends import invite_token, lookup, send
from test_handover import accepted_loan, handover
from test_holdings import call
from test_lend_offers import offer
from test_loans import pair, send as borrow
from test_open_discovery import discoverable, new_user, put
from test_trade_swap import confirm
from test_trades import accept_trade, propose, read
from test_want_list import want_list
from test_trade_migrations import collector as scratch_collector, run_again, scratch  # noqa: F401
from want_list_swap_fixtures import seed_swap_catalog

MIGRATION = '149_trade_reports.sql'


def suspend_sql(user):
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (user,))


def unsuspend_sql(user):
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = NULL WHERE user_id = %s', (user,))


def commands(user):
    with connect() as conn:
        return conn.execute(
            "SELECT count(*) AS n FROM handle_lookup_event WHERE user_id = %s AND kind = 'friend_command'",
            (user,)).fetchone()['n']


def setting(user):
    with connect() as conn:
        return conn.execute('SELECT enabled, zip, removed_at FROM discovery_setting WHERE user_id = %s',
                            (user,)).fetchone()


def changed_at(a, b):
    low, high = sorted((a, b))
    with connect() as conn:
        return conn.execute('SELECT changed_at FROM conversation WHERE user_low = %s AND user_high = %s',
                            (low, high)).fetchone()['changed_at']


def refused(response):
    return response.status_code, response.json()['detail']


def test_migration_149_creates_the_report_tables_and_runs_again(scratch):
    migrate(scratch)
    run_again(scratch, MIGRATION)
    run_again(scratch, MIGRATION)
    reporter, reported = 'collector-' + uuid4().hex, 'collector-' + uuid4().hex
    report, trade = uuid4(), uuid4()
    with psycopg.connect(scratch, row_factory=dict_row, autocommit=True) as conn:
        scratch_collector(conn, reporter)
        scratch_collector(conn, reported)
        conn.execute("""INSERT INTO trade_report (id, reporter_id, reported_id, reporter_name, reported_name,
            reporter_handle, reported_handle, reason, source)
            VALUES (%s, %s, %s, 'Ash K.', 'Misty W.', 'ashk', 'mistyw', 'harassment', 'conversation')""", (report, reporter, reported))
        conn.execute("INSERT INTO trade_report_message (report_id, message_id, from_reporter, body, at) "
                     "VALUES (%s, %s, true, 'hi', now())", (report, uuid4()))
        conn.execute("INSERT INTO trade_report_trade (report_id, trade_id, facts) VALUES (%s, %s, '{}')",
                     (report, trade))
        event = uuid4()
        conn.execute("""INSERT INTO moderation_event (id, subject_id, subject_name, report_id, action, owner_id)
          VALUES (%s, %s, 'Misty W.', %s, 'dismiss', 'owner')""", (event, reported, report))
        conn.execute('DELETE FROM inventory_owner WHERE user_id = ANY(%s)', ([reporter, reported],))
        row = conn.execute('SELECT * FROM trade_report WHERE id = %s', (report,)).fetchone()
        assert (row['reporter_id'], row['reported_id']) == (None, None)
        assert (row['reporter_name'], row['reported_name'], row['reporter_handle'], row['reported_handle']) == (
            'Ash K.', 'Misty W.', 'ashk', 'mistyw')
        for table in ('trade_report_message', 'trade_report_trade'):
            assert conn.execute(f'SELECT count(*) AS n FROM {table}').fetchone()['n'] == 1
        assert conn.execute('SELECT count(*) AS n FROM moderation_event').fetchone()['n'] == 1
        keys = conn.execute("""SELECT conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
          WHERE c.confrelid = 'inventory_owner'::regclass AND c.contype = 'f' AND c.confdeltype = 'n'
            AND c.conrelid IN ('trade_report'::regclass, 'trade_report_message'::regclass,
                               'trade_report_trade'::regclass, 'moderation_event'::regclass)""").fetchall()
        assert sorted((key['tbl'], key['col']) for key in keys) == [('trade_report', 'reported_id'),
                                                                     ('trade_report', 'reporter_id')]
        every = conn.execute("""SELECT count(*) AS n FROM pg_constraint
          WHERE confrelid = 'inventory_owner'::regclass AND contype = 'f'
            AND conrelid IN ('trade_report'::regclass, 'trade_report_message'::regclass,
                             'trade_report_trade'::regclass, 'moderation_event'::regclass)""").fetchone()['n']
        assert every == 2
        with pytest.raises(psycopg.errors.RaiseException):
            conn.execute("UPDATE moderation_event SET note = 'x' WHERE id = %s", (event,))
        with pytest.raises(psycopg.errors.RaiseException):
            conn.execute('DELETE FROM moderation_event WHERE id = %s', (event,))
        base = """INSERT INTO trade_report (id, reporter_name, reported_name, reporter_handle, reported_handle,
            reason, source, note, status) VALUES (%s, 'A', 'B', 'a', 'b', %s, 'trade', %s, %s)"""
        for reason, note, status in (('spam', None, 'open'), ('other', '', 'open'), ('other', None, 'dismissed')):
            with pytest.raises(psycopg.errors.CheckViolation):
                conn.execute(base, (uuid4(), reason, note, status))


def test_the_discovery_helpers_remove_restore_and_switch_off(store):
    (bare, _), on = collector(), new_user()
    discoverable(on)
    with connect() as conn, conn.transaction():
        remove_from_discovery(conn, bare)
    row = setting(bare)
    assert row['enabled'] is False and row['removed_at'] is not None
    with connect() as conn, conn.transaction():
        remove_from_discovery(conn, on)
    first = setting(on)
    assert first['enabled'] is False and first['removed_at'] is not None
    with connect() as conn, conn.transaction():
        remove_from_discovery(conn, on)
    assert setting(on)['removed_at'] == first['removed_at']
    with connect() as conn, conn.transaction():
        assert restore_discovery(conn, on) is True
    after = setting(on)
    assert after['removed_at'] is None and after['enabled'] is False
    with connect() as conn, conn.transaction():
        assert restore_discovery(conn, on) is False
    again = new_user()
    discoverable(again)
    with connect() as conn, conn.transaction():
        switch_off(conn, again)
        switch_off(conn, new_user())  # no setting row: nothing happens
    off = setting(again)
    assert off['enabled'] is False and off['zip'] == '00010'
    with connect() as conn:
        assert account_state(conn, 'nobody-' + uuid4().hex) is None
        state = account_state(conn, on)
        assert (state.suspended, state.removed) == (False, False)
        suspend_sql(on)
    with connect() as conn:
        state = account_state(conn, on)
        assert (state.suspended, state.removed) == (True, False)
        assert account_state(conn, bare).removed is True


def test_existing_friend_commands_keep_their_digest_and_answer(store):
    (ash, _), (misty, _) = collector(), collector()
    for action, path, body in (('block', '/api/social/blocks', {'collector_id': misty}),
                               ('block_trader', f'/api/social/traders/{trader_of(misty)}/block', {})):
        key = uuid4()
        response = call('POST', path, ash, {**body, 'idempotency_key': str(key)})
        assert response.status_code == 200, response.text
        digest = hashlib.sha256(json.dumps({'action': action, 'collector_id': misty}, sort_keys=True,
                                           default=str).encode()).hexdigest()
        with connect() as conn:
            row = conn.execute('SELECT request_digest, response FROM location_command '
                               'WHERE owner_id = %s AND request_key = %s', (ash, key)).fetchone()
        assert row['request_digest'] == digest
        assert row['response'] == {'relation': 'blocked'}
        call('POST', f'/api/social/traders/{trader_of(misty)}/unblock', ash, {'idempotency_key': str(uuid4())})
    assert command_payload('x', 'y') == {'action': 'x', 'collector_id': 'y'}
    assert command_payload('x', 'y', {'z': 1}) == {'action': 'x', 'collector_id': 'y', 'z': 1}


def test_friend_requests_borrow_requests_and_lend_offers_refuse_a_suspended_sender(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, node(misty, 'Unsorted')['id'], iono, 3)
    binder = place(ash, 'Binder')
    hold(ash, binder, iono, 2)
    brock, brock_handle = collector()
    token_owner, _ = collector()
    suspend_sql(ash)
    by_handle = ok(lookup(ash, brock_handle))['collector_id']
    by_invite = ok(call('GET', f'/api/social/invites/{invite_token(token_owner)}', ash))['collector_id']
    before = commands(ash)
    suspended = (403, {'code': 'ACCOUNT_SUSPENDED'})
    assert refused(send(ash, by_handle)) == suspended
    assert refused(send(ash, by_invite)) == suspended
    assert commands(ash) == before
    assert refused(borrow(ash, misty, [(iono, 1)])) == suspended
    assert refused(offer(ash, misty, [(binder, iono, 1)])) == suspended
    unsuspend_sql(ash)
    assert send(ash, by_handle).status_code == 200
    assert send(ash, by_invite).status_code == 200
    assert borrow(ash, misty, [(iono, 1)]).status_code == 201
    assert offer(ash, misty, [(binder, iono, 1)]).status_code == 201


def test_a_suspended_friend_has_no_trade_list_but_keeps_their_collection(store):
    seed_swap_catalog()
    (ash, _), (misty, misty_handle), (_, stranger_handle) = collector(), collector(), collector()
    befriend(ash, misty)
    assert call('GET', f'/api/social/trade-lists/{misty_handle}', ash).status_code == 200
    suspend_sql(misty)
    hidden = call('GET', f'/api/social/trade-lists/{misty_handle}', ash)
    unknown = call('GET', f'/api/social/trade-lists/{stranger_handle}', ash)
    assert (hidden.status_code, hidden.content) == (unknown.status_code, unknown.content)
    assert hidden.status_code == 404 and hidden.json() == {'detail': {'code': 'FRIEND_NOT_FOUND'}}
    assert call('GET', f'/api/social/collections/{misty_handle}', ash).status_code == 200


def test_the_conversation_list_says_when_the_reader_is_suspended(store):
    (ash, _), (misty, _) = collector(), collector()
    befriend(ash, misty)
    start(ash, misty)
    listed = ok(call('GET', '/api/social/conversations', ash))
    assert listed['suspended'] is False and len(listed['conversations']) == 1
    suspend_sql(ash)
    listed = ok(call('GET', '/api/social/conversations', ash))
    assert listed['suspended'] is True and len(listed['conversations']) == 1


def test_account_changed_moves_every_conversation_of_the_account_but_the_skipped(store):
    (ash, _), (misty, _), (brock, _), (gary, _), (oak, _) = (collector() for _ in range(5))
    for other in (ash, brock, gary):
        befriend(misty, other)
    befriend(oak, ash)
    skipped = start(ash, misty)
    start(brock, misty)
    start(gary, misty)
    start(oak, ash)
    before = {pair_: changed_at(*pair_) for pair_ in ((ash, misty), (brock, misty), (gary, misty), (oak, ash))}
    with connect() as conn, conn.transaction():
        conversations.account_changed(conn, misty, [skipped])
    assert changed_at(ash, misty) == before[(ash, misty)]
    assert changed_at(brock, misty) > before[(brock, misty)]
    assert changed_at(gary, misty) > before[(gary, misty)]
    assert changed_at(oak, ash) == before[(oak, ash)]


# WP-B: the Report route, the owner routes, suspension and its races.

UNKNOWN = (404, b'{"detail":{"code":"COLLECTOR_NOT_FOUND"}}')
UNAVAILABLE = (409, {'code': 'COLLECTOR_UNAVAILABLE'})
SUSPENDED = (403, {'code': 'ACCOUNT_SUSPENDED'})


def as_owner():
    user = 'owner-' + uuid4().hex
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING', (user,))
        conn.execute('DELETE FROM owner_binding')
        conn.execute('INSERT INTO owner_binding(singleton, user_id) VALUES (true, %s)', (user,))
    return user


def report(reporter, trader_id, reason='harassment', source='conversation', note=None, trade_id=None, key=None):
    body = {'trader_id': str(trader_id), 'reason': reason, 'source': source, 'idempotency_key': str(key or uuid4())}
    if note is not None:
        body['note'] = note
    if trade_id is not None:
        body['trade_id'] = str(trade_id)
    return call('POST', '/api/social/reports', reporter, body)


def filed(reporter, reported, age=0):
    """An open report inserted by SQL, for tests that are not about the Report route. Returns its id."""
    with connect() as conn:
        people = {row['user_id']: row for row in conn.execute(
            'SELECT user_id, display_name, handle FROM collector_profile WHERE user_id = ANY(%s)',
            ([reporter, reported],))}
        found = uuid4()
        conn.execute("""INSERT INTO trade_report (id, reporter_id, reported_id, reporter_name, reported_name,
            reporter_handle, reported_handle, reason, source, created_at)
          VALUES (%s, %s, %s, %s, %s, %s, %s, 'harassment', 'conversation', now() - make_interval(secs => %s))""",
                     (found, reporter, reported, people[reporter]['display_name'], people[reported]['display_name'],
                      people[reporter]['handle'], people[reported]['handle'], age))
    return found


def decide(owner, report_id, action, note=None):
    body = {'action': action}
    if note is not None:
        body['note'] = note
    return call('POST', f'/api/admin/trade-reports/{report_id}/decision', owner, body)


def restore(owner, user, what, note=None):
    body = {'what': what}
    if note is not None:
        body['note'] = note
    return call('POST', f'/api/admin/collectors/{user}/restore', owner, body)


def owner_detail(owner, report_id):
    return ok(call('GET', f'/api/admin/trade-reports/{report_id}', owner))


def block_trader(user, trader_id, key=None):
    return call('POST', f'/api/social/traders/{trader_id}/block', user, {'idempotency_key': str(key or uuid4())})


def unblock_by_id(user, block_id):
    return call('POST', f'/api/social/blocked/{block_id}/unblock', user, {'idempotency_key': str(uuid4())})


def block_row(blocker, other):
    with connect() as conn:
        return conn.execute('SELECT id, via, handle_shown FROM block WHERE blocker_id = %s AND blocked_id = %s',
                            (blocker, other)).fetchone()


def near_pair(name='Pair'):
    """Two new collectors, both in open discovery at 00010 and 00011: strangers in reach, with no cards."""
    (first, _), (second, _) = collector(f'{name} A'), collector(f'{name} B')
    discoverable(first, '00010')
    discoverable(second, '00011')
    return first, second


def handle_of(user):
    with connect() as conn:
        return conn.execute('SELECT handle FROM collector_profile WHERE user_id = %s', (user,)).fetchone()['handle']


def rows(sql, *args):
    with connect() as conn:
        return conn.execute(sql, args).fetchall()


def events(**where):
    column, value = next(iter(where.items()))
    return rows(f'SELECT * FROM moderation_event WHERE {column} = %s ORDER BY created_at, id', value)


def inbox_kinds(user):
    return [row['kind'] for row in rows('SELECT kind FROM inbox_update WHERE recipient_id = %s', user)]


def decline(user, trade):
    return call('POST', f"/api/social/trades/{trade['id']}/decline", user,
                {'revision': ok(read(user, trade))['revision'], 'idempotency_key': str(uuid4())})


def world():
    """strangers() topped up to 10 of each card, with a conversation of three messages (Misty, Ash, Misty).
    Returns (ids, ash, misty, conversation, iono, arven)."""
    ids, ash, misty, binder, box = strangers()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    hold(misty, binder, iono, 7)
    hold(ash, box, arven, 8)
    conversation = start(misty, ash, 'Hi Ash')
    ok(say(ash, conversation, 'Hi Misty'), 201)
    ok(say(misty, conversation, 'Want to swap?'), 201)
    return ids, ash, misty, conversation, iono, arven


def swap(iono, arven, misty, ash):
    return ok(propose_to(misty, trader_of(ash), give=[(iono, 1)], get=[(arven, 1)]), 201)


def four_trades(iono, arven, misty, ash):
    proposed = swap(iono, arven, misty, ash)
    accepted = ok(accept_trade(ash, swap(iono, arven, misty, ash)))
    half = ok(accept_trade(ash, swap(iono, arven, misty, ash)))
    ok(confirm(ash, half))
    declined = swap(iono, arven, misty, ash)
    ok(decline(ash, declined))
    return proposed, accepted, half, declined


def test_a_report_blocks_and_snapshots_the_conversation_and_every_trade(store):
    ids, ash, misty, conversation, iono, arven = world()
    proposed, accepted, half, declined = four_trades(iono, arven, misty, ash)
    owner = as_owner()
    before = commands(ash)
    response = report(ash, trader_of(misty), note='  Never showed up  ')
    assert response.status_code == 201 and response.content == b'{"reported":true}'
    assert commands(ash) == before + 1
    row = block_row(ash, misty)
    assert (row['via'], row['handle_shown']) == ('trader', False)
    with connect() as conn:
        closed = {str(row['id']): row for row in conn.execute(
            'SELECT id, state, closed_reason, closed_by FROM trade WHERE id = ANY(%s)',
            ([proposed['id'], accepted['id'], half['id']],))}
    for trade in (proposed, accepted):
        assert (closed[trade['id']]['closed_reason'], closed[trade['id']]['closed_by']) == ('cancelled', ash)
    assert closed[half['id']]['state'] == 'accepted'
    [stored] = rows('SELECT id FROM trade_report WHERE reporter_id = %s', ash)
    seen = owner_detail(owner, stored['id'])
    assert [(m['sender'], m['body']) for m in seen['messages']] == [
        ('reported', 'Hi Ash'), ('reporter', 'Hi Misty'), ('reported', 'Want to swap?')]
    assert [t['state'] for t in seen['trades']] == ['proposed', 'accepted', 'accepted', 'closed']
    assert [t['ended_by_report'] for t in seen['trades']] == [True, True, False, False]
    assert seen['trades'][3]['closed_reason'] == 'declined' and seen['trades'][3]['closed_by'] == 'reporter'
    first = seen['trades'][0]
    assert first['proposed_by'] == 'reported'
    assert first['reporter_gives'] == [{'name': first['reporter_gives'][0]['name'], 'set_code': 'SVI', 'number': '166',
                                        'quantity': 1}]
    assert first['reported_gives'][0]['set_code'] == 'PAL' and first['reported_gives'][0]['number'] == '185'
    assert first['reporter_gives'][0]['name'] and first['reported_gives'][0]['name']
    assert seen['trades'][2]['reporter_confirmed_at'] is not None and seen['trades'][2]['reported_confirmed_at'] is None
    report_row = seen['report']
    assert (report_row['reason'], report_row['source']) == ('harassment', 'conversation')
    assert seen['note'] == 'Never showed up'
    assert report_row['reporter'] == {'user_id': ash, 'display_name': 'Ash K.', 'handle': handle_of(ash)}
    assert report_row['reported'] == {'user_id': misty, 'display_name': 'Misty W.', 'handle': handle_of(misty)}
    assert seen['conversation_id'] == conversation and seen['account'] == {
        'exists': True, 'suspended': False, 'removed': False}


def test_the_snapshot_is_unchanged_by_later_messages_after_an_unblock(store):
    ids, ash, misty, conversation, iono, arven = world()
    four_trades(iono, arven, misty, ash)
    owner = as_owner()
    ok(report(ash, trader_of(misty)), 201)
    [stored] = rows('SELECT id FROM trade_report WHERE reporter_id = %s', ash)
    first = owner_detail(owner, stored['id'])
    ok(unblock_by_id(ash, block_row(ash, misty)['id']))
    ok(say(ash, conversation, 'After'), 201)
    ok(say(misty, conversation, 'Also after'), 201)
    ok(propose_to(ash, trader_of(misty), give=[(arven, 1)], get=[(iono, 1)]), 201)
    again = owner_detail(owner, stored['id'])
    assert again['messages'] == first['messages'] and again['trades'] == first['trades']
    assert len(again['messages']) == 3 and len(again['trades']) == 4


def test_the_snapshot_survives_the_deletion_of_either_account(store):
    ids, ash, misty, conversation, iono, arven = world()
    swap(iono, arven, misty, ash)
    other_reporter, other_reported = near_pair('Gone')
    start(other_reporter, other_reported)
    owner = as_owner()
    ok(report(ash, trader_of(misty)), 201)
    ok(report(other_reporter, trader_of(other_reported)), 201)
    misty_handle = handle_of(misty)
    first = rows('SELECT id FROM trade_report WHERE reporter_id = %s', ash)[0]['id']
    second = rows('SELECT id FROM trade_report WHERE reporter_id = %s', other_reporter)[0]['id']
    with connect() as conn:
        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (misty,))
        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (other_reporter,))
    gone = owner_detail(owner, first)
    assert len(gone['messages']) == 3 and len(gone['trades']) == 1
    assert gone['report']['reported']['user_id'] is None and gone['report']['reported']['display_name'] == 'Misty W.'
    assert gone['report']['reported']['handle'] == misty_handle
    assert gone['account'] == {'exists': False, 'suspended': False, 'removed': False}
    left = owner_detail(owner, second)
    assert left['report']['reporter']['user_id'] is None and len(left['messages']) == 1
    for action in ('remove_from_discovery', 'suspend'):
        assert refused(decide(owner, first, action)) == (409, {'code': 'REPORTED_ACCOUNT_GONE'})
    assert decide(owner, first, 'dismiss').status_code == 200
    [event] = events(report_id=first)
    assert event['subject_id'] is None and event['subject_name'] == 'Misty W.' and event['action'] == 'dismiss'


def test_report_after_being_blocked_matches_report_of_suspended(store):
    blocked_pair, suspended_pair, open_pair = near_pair('Blocked'), near_pair('Suspended'), near_pair('Open')
    for first, second in (blocked_pair, suspended_pair, open_pair):
        start(first, second)
    ok(block_trader(blocked_pair[1], trader_of(blocked_pair[0])))
    suspend_sql(suspended_pair[1])
    answers = [report(first, trader_of(second)) for first, second in (blocked_pair, suspended_pair, open_pair)]
    assert {(a.status_code, a.content) for a in answers} == {(201, b'{"reported":true}')}
    for first, second in (blocked_pair, suspended_pair, open_pair):
        assert block_row(first, second)['via'] == 'trader'


def scrub(value, names):
    text = re.sub(r'"(cursor|next_before)": "[^"]*"', '"\\1": "<cursor>"', json.dumps(value, sort_keys=True))
    text = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', text)
    text = re.sub(r'\d{4}-\d\d-\d\dT[\d:.]+(?:[+-]\d\d:\d\d|Z)?', '<time>', text)
    for name in names:
        text = text.replace(name, '<name>')
    return text


def test_the_reported_collector_is_never_told(store):
    seen = []
    for reporting in (True, False):
        ids, ash, misty, conversation, iono, arven = world()
        swap(iono, arven, misty, ash)
        if reporting:
            ok(report(ash, trader_of(misty)), 201)
        else:
            ok(block_trader(ash, trader_of(misty)))
        paths = [f'/api/social/conversations/{conversation}', f'/api/social/traders/{trader_of(ash)}',
                 '/api/social/inbox', '/api/social/conversations', '/api/social/conversations/pulse',
                 '/api/social/blocks', '/api/social/friends']
        answers = [call('GET', path, misty) for path in paths]
        assert all(answer.status_code == 200 for answer in answers), [a.text for a in answers]
        pulse_body = ok(call('GET', '/api/social/conversations/pulse', misty))
        names = [handle_of(ash), handle_of(misty), ash, misty]
        bodies = [scrub(answer.json(), names) for answer in answers[:4] + answers[5:]]
        for answer in answers:
            assert 'report' not in answer.text.replace('can_report', '').lower()
        seen.append((bodies, pulse_body['unread_conversations']))
    assert seen[0] == seen[1]


def test_a_report_needs_reach_a_conversation_or_their_trade(store):
    ids, ash, misty, binder, box = strangers()
    far, _ = collector('Far W.')
    discoverable(far, far_zip())
    foreign_a, foreign_b = collector('Foreign A')[0], collector('Foreign B')[0]
    with connect() as conn:
        others = swapped(conn, foreign_a, foreign_b)
    sent_before, reports_before = commands(ash), rows('SELECT count(*) AS n FROM trade_report')[0]['n']
    misses = [report(ash, uuid4()), report(ash, trader_of(ash)), report(ash, trader_of(far))]
    assert {(m.status_code, m.content) for m in misses} == {UNKNOWN}
    foreign = report(ash, trader_of(far), source='trade', trade_id=others)
    assert refused(foreign) == (404, {'code': 'TRADE_NOT_FOUND'})
    assert report(ash, trader_of(far), source='trade').status_code == 422
    assert report(ash, trader_of(far), source='conversation', trade_id=uuid4()).status_code == 422
    assert commands(ash) == sent_before
    assert rows('SELECT count(*) AS n FROM trade_report')[0]['n'] == reports_before
    with connect() as conn:
        theirs = swapped(conn, ash, far)  # a completed Trade gives reach of its own, so it comes after the misses
    ok(report(ash, trader_of(far), source='trade', trade_id=theirs), 201)
    start(ash, misty)
    for user in (ash, misty):
        ok(put(user, {'enabled': False}))
    ok(report(ash, trader_of(misty)), 201)


def test_a_report_replays_by_key_and_its_digest_covers_every_field(store):
    ids, ash, misty, binder, box = strangers()
    key = uuid4()
    first = report(ash, trader_of(misty), source='discovery', note='n', key=key)
    assert first.status_code == 201
    after = commands(ash)
    again = report(ash, trader_of(misty), source='discovery', note='n', key=key)
    assert (again.status_code, again.content) == (first.status_code, first.content)
    assert commands(ash) == after
    assert rows('SELECT count(*) AS n FROM trade_report WHERE reporter_id = %s', ash)[0]['n'] == 1
    for change in ({'reason': 'other'}, {'note': 'different'}, {'source': 'conversation'}):
        args = {'source': 'discovery', 'note': 'n', **change}
        assert refused(report(ash, trader_of(misty), key=key, **args)) == (409, {'code': 'IDEMPOTENCY_KEY_REUSED'})
    far, _ = collector('Far W.')
    discoverable(far, far_zip())
    with connect() as conn:
        one, two = swapped(conn, ash, far), swapped(conn, ash, far)
    trade_key = uuid4()
    ok(report(ash, trader_of(far), source='trade', trade_id=one, key=trade_key), 201)
    assert refused(report(ash, trader_of(far), source='trade', trade_id=two, key=trade_key)) == (
        409, {'code': 'IDEMPOTENCY_KEY_REUSED'})
    for round_ in range(4):
        reporter, reported = near_pair(f'Dup{round_}')
        duplicate, before = uuid4(), commands(reporter)
        with ThreadPoolExecutor(4) as pool:
            answers = list(pool.map(lambda _: report(reporter, trader_of(reported), source='discovery',
                                                      key=duplicate), range(4)))
        assert {(a.status_code, a.content) for a in answers} == {(201, b'{"reported":true}')}
        assert rows('SELECT count(*) AS n FROM trade_report WHERE reporter_id = %s', reporter)[0]['n'] == 1
        assert commands(reporter) == before + 1


def test_the_report_note_is_normalised(store):
    first, second = near_pair('Note')
    start(first, second)
    target = trader_of(second)
    for note in ('  Hi\r\nthere \u202e', '   ', None, 'a' * 1000):
        ok(report(first, target, note=note), 201)
    stored = [row['note'] for row in rows('SELECT note FROM trade_report WHERE reporter_id = %s ORDER BY created_at',
                                          first)]
    assert stored == ['Hi\nthere', None, None, 'a' * 1000]
    assert detail(report(first, target, note='a' * 1001)) == (422, {'code': 'MESSAGE_TOO_LONG'})


def test_owner_routes_are_403_for_non_owners(store):
    as_owner()
    ash, _ = collector('Ash K.')
    misty, _ = collector('Misty W.')
    stored = filed(ash, misty)
    forbidden = (403, {'detail': 'Owner access required'})
    for response in (call('GET', '/api/admin/trade-reports', ash),
                     call('GET', f'/api/admin/trade-reports/{stored}', ash), decide(ash, stored, 'suspend'),
                     restore(ash, misty, 'suspension')):
        assert (response.status_code, response.json()) == forbidden
    assert rows('SELECT status FROM trade_report WHERE id = %s', stored)[0]['status'] == 'open'
    assert events(report_id=stored) == [] and events(subject_id=misty) == []
    assert account_state_of(misty) == (False, False)


def account_state_of(user):
    with connect() as conn:
        state = account_state(conn, user)
    return state.suspended, state.removed


def test_the_owner_list_pages_newest_first_and_counts_open_reports(store):
    owner = as_owner()
    with connect() as conn:
        conn.execute('DELETE FROM trade_report')
    reporter, _ = collector('Reporter')
    common, _ = collector('Common')
    rare, _ = collector('Rare')
    for age in range(1, 51):
        filed(reporter, common, age)
    filed(reporter, rare, 100)
    dismissed = filed(reporter, rare, 101)
    with connect() as conn:
        conn.execute("""UPDATE trade_report SET status = 'dismissed', decision = 'dismiss', decided_at = now()
          WHERE id = %s""", (dismissed,))
    first = ok(call('GET', '/api/admin/trade-reports', owner))
    assert len(first['reports']) == 50 and first['next_before'] and first['open_count'] == 51
    stamps = [row['created_at'] for row in first['reports']]
    assert stamps == sorted(stamps, reverse=True)
    assert {row['reported_count'] for row in first['reports']} == {50}
    second = ok(call('GET', f"/api/admin/trade-reports?before={first['next_before']}", owner))
    assert len(second['reports']) == 1 and second['next_before'] is None
    assert second['reports'][0]['reported_count'] == 2 and second['reports'][0]['status'] == 'open'
    only = ok(call('GET', '/api/admin/trade-reports?status=dismissed', owner))
    assert [row['id'] for row in only['reports']] == [str(dismissed)] and only['open_count'] == 51
    assert detail(call('GET', '/api/admin/trade-reports?before=nonsense', owner)) == (422, {'code': 'INVALID_CURSOR'})
    assert call('GET', '/api/admin/trade-reports?status=bogus', owner).status_code == 422


def test_the_owner_detail_answers_the_snapshot_only(store):
    ids, ash, misty, conversation, iono, arven = world()
    four_trades(iono, arven, misty, ash)
    owner = as_owner()
    older = filed(ash, misty, 500)
    with connect() as conn:
        conn.execute("""INSERT INTO moderation_event (id, subject_id, subject_name, report_id, action, owner_id)
          VALUES (%s, %s, 'Misty W.', %s, 'dismiss', %s)""", (uuid4(), misty, older, owner))
    ok(report(ash, trader_of(misty)), 201)
    stored = rows('SELECT id FROM trade_report WHERE reporter_id = %s AND id <> %s', ash, older)[0]['id']
    first = owner_detail(owner, stored)
    assert set(first) == {'report', 'note', 'conversation_id', 'trade_id', 'decided_at', 'decided_by', 'messages',
                          'trades', 'account', 'other_reports', 'events'}
    assert [row['id'] for row in first['other_reports']] == [str(older)]
    assert [row['report_id'] for row in first['events']] == [str(older)]
    ok(unblock_by_id(ash, block_row(ash, misty)['id']))
    ok(say(misty, conversation, 'Later'), 201)
    ok(propose_to(ash, trader_of(misty), give=[(arven, 1)], get=[(iono, 1)]), 201)
    # The live conversation and Trades could vanish: the review reads report-owned rows only.
    with connect() as conn:
        conn.execute('DELETE FROM trade WHERE conversation_id = %s', (conversation,))
        conn.execute('DELETE FROM conversation WHERE id = %s', (conversation,))
    assert owner_detail(owner, stored) == first
    suspend_sql(misty)
    assert owner_detail(owner, stored)['account'] == {'exists': True, 'suspended': True, 'removed': False}
    assert call('GET', f'/api/admin/trade-reports/{uuid4()}', owner).json() == {'detail': {'code': 'REPORT_NOT_FOUND'}}


def test_each_decision_writes_an_event_and_a_second_is_refused(store):
    owner = as_owner()
    for action, status in (('dismiss', 'dismissed'), ('remove_from_discovery', 'actioned'), ('suspend', 'actioned')):
        reporter, _ = collector('Reporter')
        reported, _ = collector('Reported')
        discoverable(reported, '00010')
        stored = filed(reporter, reported)
        response = decide(owner, stored, action, note='  a note ')
        assert (response.status_code, response.json()) == (200, {'status': status, 'decision': action})
        row = rows('SELECT * FROM trade_report WHERE id = %s', stored)[0]
        assert (row['status'], row['decision'], row['decided_by']) == (status, action, owner)
        assert row['decided_at'] is not None
        [event] = events(report_id=stored)
        assert (event['action'], event['subject_id'], event['owner_id'], event['note']) == (
            action, reported, owner, 'a note')
        assert refused(decide(owner, stored, 'dismiss')) == (409, {'code': 'REPORT_DECIDED'})
        assert len(events(report_id=stored)) == 1
        state, on = account_state_of(reported), setting(reported)
        assert state == (action == 'suspend', action == 'remove_from_discovery')
        assert on['enabled'] is (action == 'dismiss')
    assert refused(decide(owner, uuid4(), 'dismiss')) == (404, {'code': 'REPORT_NOT_FOUND'})


def test_removal_switches_discovery_off_and_restore_lets_the_collector_switch_on_again(store):
    ids, ash, misty, binder, box = strangers()
    owner = as_owner()
    stored = filed(ash, misty)
    with connect() as conn:
        assert misty in {row['other_id'] for row in conn.execute(
            'SELECT other_id FROM nearby_collectors(%s, 4::smallint, 100)', (ash,))}
    ok(decide(owner, stored, 'remove_from_discovery'))
    assert ok(call('GET', '/api/social/discovery', misty))['status'] == 'removed'
    with connect() as conn:
        assert misty not in {row['other_id'] for row in conn.execute(
            'SELECT other_id FROM nearby_collectors(%s, 4::smallint, 100)', (ash,))}
    assert refused(put(misty, {'enabled': True})) == (409, {'code': 'DISCOVERY_UNAVAILABLE'})
    assert ok(restore(owner, misty, 'discovery')) == {'restored': 'discovery'}
    assert ok(call('GET', '/api/social/discovery', misty))['status'] == 'off'
    assert ok(put(misty, {'enabled': True}))['status'] == 'on'
    assert refused(restore(owner, misty, 'discovery')) == (409, {'code': 'NOTHING_TO_RESTORE'})
    assert refused(restore(owner, 'nobody-' + uuid4().hex, 'discovery')) == (404, {'code': 'COLLECTOR_NOT_FOUND'})
    assert [event['action'] for event in events(subject_id=misty)] == ['remove_from_discovery', 'restore_discovery']


def test_lifting_a_suspension_restores_contact_and_nothing_to_restore_after(store):
    ids, ash, misty, binder, box = strangers()
    conversation = start(ash, misty)
    owner = as_owner()
    ok(decide(owner, filed(ash, misty), 'suspend'))
    assert detail(say(misty, conversation, 'hi')) == SUSPENDED
    assert ok(view(ash, conversation))['status'] == 'unavailable'
    assert ok(restore(owner, misty, 'suspension', note='mistake')) == {'restored': 'suspension'}
    ok(say(misty, conversation, 'back'), 201)
    ok(say(ash, conversation, 'welcome'), 201)
    assert ok(view(ash, conversation))['status'] == 'open'
    assert ok(call('GET', '/api/social/discovery', misty))['status'] == 'off'
    assert refused(restore(owner, misty, 'suspension')) == (409, {'code': 'NOTHING_TO_RESTORE'})
    assert [event['action'] for event in events(subject_id=misty)] == ['suspend', 'lift_suspension']


def partner_trades(send, misty, other, iono, arven):
    """A proposal each way, an accepted Trade, and an accepted Trade ``other`` confirmed, between Misty and ``other``.
    ``send(sender, receiver, give, get)`` answers the Trade."""
    out = send(misty, other, [(iono, 1)], [(arven, 1)])
    incoming = send(other, misty, [(arven, 1)], [(iono, 1)])
    accepted = ok(accept_trade(other, send(misty, other, [(iono, 1)], [(arven, 1)])))
    half = ok(accept_trade(other, send(misty, other, [(iono, 1)], [(arven, 1)])))
    ok(confirm(other, half))
    return out, incoming, accepted, half


def loan_world():
    """Misty W. lends Gary (a Friend) an accepted Loan and holds 15 Iono for trade; Ash K. is a stranger in reach.
    Returns (iono, arven, gary, misty, binder, loan, ash)."""
    iono, gary, misty, binder, loan = accepted_loan(held=15, asked=3)
    with connect() as conn:  # the catalog is already seeded: seeding again would replace every Edition and Holding
        arven = next(str(row['id']) for row in conn.execute(
            "SELECT e.id, e.descriptor FROM catalog_edition e JOIN catalog_printing p ON p.id = e.printing_id "
            "WHERE p.source_id = 'sv01-166'")
            if (row['descriptor'].get('type') or row['descriptor'].get('finish')) == 'normal')
    ok(mark(misty, binder))
    gary_box = place(gary, 'Box')
    hold(gary, gary_box, arven, 10)
    ok(mark(gary, gary_box))
    ash, _ = collector('Ash K.')
    ash_box = place(ash, 'Box')
    hold(ash, ash_box, arven, 10)
    ok(mark(ash, ash_box))
    discoverable(misty, '00010')
    discoverable(ash, '00011')
    return iono, arven, gary, misty, binder, loan, ash


def test_suspensions_cancellations_have_the_suspended_account_as_actor_and_tell_the_counterparties(store):
    iono, arven, gary, misty, binder, loan, ash = loan_world()
    friend_trades = partner_trades(lambda a, b, give, get: ok(propose(a, b, give, get), 201), misty, gary, iono, arven)
    stranger_trades = partner_trades(
        lambda a, b, give, get: ok(propose_to(a, trader_of(b), give, get), 201), misty, ash, iono, arven)
    owner = as_owner()
    told = {user: inbox_kinds(user).count('cancelled') for user in (misty, gary, ash)}
    assert ok(decide(owner, filed(ash, misty), 'suspend')) == {'status': 'actioned', 'decision': 'suspend'}
    for partner, (out, incoming, accepted, half) in ((gary, friend_trades), (ash, stranger_trades)):
        for trade in (out, incoming, accepted):
            found = ok(read(partner, trade))
            assert (found['state'], found['closed_reason'], found['closed_by']) == ('closed', 'cancelled', 'them')
        assert inbox_kinds(partner).count('cancelled') == told[partner] + 3
        assert ok(read(partner, half))['state'] == 'accepted'
        assert ok(confirm(misty, half))['closed_reason'] == 'swapped'
    assert inbox_kinds(misty).count('cancelled') == told[misty]
    assert {row['closed_by'] for row in rows("SELECT closed_by FROM trade WHERE closed_reason = 'cancelled' AND "
                                              "(proposer_id = %s OR recipient_id = %s)", misty, misty)} == {misty}
    assert ok(handover(misty, loan))['id'] == loan['id']
    assert ok(handover(gary, loan))['id'] == loan['id']
    assert gary in call('GET', '/api/social/friends', misty).text
    assert setting(misty)['enabled'] is False


def test_a_suspension_and_its_lift_move_every_partners_watermark(store):
    ids, ash, misty, binder, box = strangers()
    brock, _ = collector('Brock')
    discoverable(brock, '00010')
    with_ash, with_brock = start(ash, misty), start(brock, misty)
    ok(propose_to(misty, trader_of(ash), give=[(ids['PAL 185'], 1)], get=[(ids['SVI 166'], 1)]), 201)
    owner = as_owner()

    def marks():
        return [pulse(user)['watermark'] for user in (misty, ash, brock)]
    first = marks()
    ok(decide(owner, filed(ash, misty), 'suspend'))
    second = marks()
    assert all(a != b for a, b in zip(first, second))
    assert ok(view(brock, with_brock))['status'] == 'unavailable'
    ok(restore(owner, misty, 'suspension'))
    third = marks()
    assert all(a != b for a, b in zip(second, third))
    assert ok(view(brock, with_brock))['status'] == 'open' and ok(view(ash, with_ash))['status'] == 'open'
    ok(decide(owner, filed(ash, misty), 'remove_from_discovery'))
    assert pulse(brock)['watermark'] == third[2]


def counted(wrapper_calls, real, plan):
    """A stand-in for ``unconfirmed_partners`` that counts its calls and lets ``plan(call_number, result)`` change the
    answer."""
    def wrapper(conn, user_id):
        wrapper_calls.append(user_id)
        return plan(len(wrapper_calls), real(conn, user_id))
    return wrapper


def test_a_send_committed_between_the_suspension_read_and_its_locks_makes_it_retry(store, monkeypatch):
    ids, ash, misty, binder, box = strangers()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    owner, stored = as_owner(), None
    stored = filed(ash, misty)
    sent, calls = [], []

    def plan(number, result):
        if number == 1:
            sent.append(ok(propose_to(ash, trader_of(misty), give=[(arven, 1)], get=[(iono, 1)]), 201))
        return result  # the answer computed before the send
    monkeypatch.setattr(reports, 'unconfirmed_partners', counted(calls, reports.unconfirmed_partners, plan))
    assert decide(owner, stored, 'suspend').status_code == 200
    assert len(calls) == 4
    [proposal] = sent
    [row] = rows('SELECT state, closed_reason, closed_by FROM trade WHERE id = %s', proposal['id'])
    assert (row['state'], row['closed_reason'], row['closed_by']) == ('closed', 'cancelled', misty)
    assert 'cancelled' in inbox_kinds(ash)


def test_a_suspension_whose_counterparties_keep_changing_answers_503_and_changes_nothing(store, monkeypatch):
    ids, ash, misty, binder, box = strangers()
    owner, stored, calls = as_owner(), filed(ash, misty), []
    monkeypatch.setattr(reports, 'unconfirmed_partners', counted(
        calls, reports.unconfirmed_partners, lambda number, _: ([], []) if number % 2 else ([ash], [])))
    assert refused(decide(owner, stored, 'suspend')) == (503, {'code': 'INVENTORY_TEMPORARILY_UNAVAILABLE'})
    assert len(calls) == 6
    assert account_state_of(misty) == (False, False)
    assert rows('SELECT status FROM trade_report WHERE id = %s', stored)[0]['status'] == 'open'
    assert events(report_id=stored) == []


def test_a_suspended_collector_keeps_their_own_data(store):
    iono, arven, gary, misty, binder, loan, brock = loan_world()
    gyarados = deck(misty, 'Gyarados', 0)
    line(misty, gyarados, iono, 1)
    token_owner, _ = collector('Inviter')
    conversation = start(brock, misty)
    with connect() as conn:
        completed = swapped(conn, misty, brock)
    brock_handle = handle_of(brock)
    owner = as_owner()
    ok(decide(owner, filed(brock, misty), 'suspend'))
    for response in (call('GET', '/api/location-tree', misty), call('GET', f'/api/decks/{gyarados}', misty),
                     call('GET', '/api/want-list', misty), call('GET', '/api/social/friends', misty),
                     call('GET', '/api/social/discovery', misty), handover(misty, loan), handover(gary, loan)):
        assert response.status_code == 200, response.text
    assert deck_detail(misty, gyarados) and want_list(misty)
    assert ok(call('GET', '/api/social/discovery', misty))['status'] == 'suspended'
    by_handle = ok(lookup(misty, brock_handle))['collector_id']
    by_invite = ok(call('GET', f'/api/social/invites/{invite_token(token_owner)}', misty))['collector_id']
    refusals = [send(misty, by_handle), send(misty, by_invite),
                call('POST', f'/api/social/trades/{completed}/add-friend', misty, {'idempotency_key': str(uuid4())}),
                borrow(misty, gary, [(iono, 1)]), offer(misty, gary, [(binder, iono, 1)]),
                put(misty, {'enabled': True}),
                say(misty, conversation, 'hello'), propose_to(misty, trader_of(brock), [(iono, 1)], [(arven, 1)])]
    assert [refused(response) for response in refusals] == [SUSPENDED] * len(refusals)


def stranger_world(iono_copies=7, arven_copies=8):
    ids, ash, misty, binder, box = strangers()
    hold(misty, binder, ids['PAL 185'], iono_copies)
    hold(ash, box, ids['SVI 166'], arven_copies)
    return ids['PAL 185'], ids['SVI 166'], ash, misty


def open_between(a, b):
    return rows("""SELECT id FROM trade WHERE state IN ('proposed', 'accepted') AND proposer_swap_at IS NULL
      AND recipient_swap_at IS NULL AND ((proposer_id = %s AND recipient_id = %s)
        OR (proposer_id = %s AND recipient_id = %s))""", a, b, b, a)


def test_a_suspension_racing_sends_and_messages_never_deadlocks(store):
    iono, arven, ash, misty = stranger_world()
    brock, _ = collector('Brock')
    discoverable(brock, '00010')
    with_brock = start(brock, misty)
    start(ash, misty)
    owner = as_owner()
    for round_ in range(4):
        if round_:
            ok(restore(owner, misty, 'suspension'))
        stored = filed(ash, misty)
        ok(propose_to(ash, trader_of(misty), give=[(arven, 1)], get=[(iono, 1)]), 201)
        with ThreadPoolExecutor(5) as pool:
            work = {'decision': pool.submit(decide, owner, stored, 'suspend'),
                    'ash': pool.submit(propose_to, ash, trader_of(misty), [(arven, 1)], [(iono, 1)]),
                    'misty': pool.submit(propose_to, misty, trader_of(ash), [(iono, 1)], [(arven, 1)]),
                    'say': pool.submit(say, brock, with_brock, 'hi'),
                    'say_to': pool.submit(say_to, brock, trader_of(misty), 'hey')}
            answers = {name: future.result() for name, future in work.items()}
        assert all(answer.status_code < 500 for answer in answers.values()), [a.text for a in answers.values()]
        assert answers['decision'].status_code == 200
        for name in ('ash', 'misty'):
            assert answers[name].status_code == 201 or detail(answers[name]) in (SUSPENDED, UNAVAILABLE), name
        for name in ('say', 'say_to'):
            assert answers[name].status_code == 201 or detail(answers[name]) == UNAVAILABLE, name
        assert open_between(ash, misty) == []


def test_a_suspension_racing_accepts_and_confirm_swaps_never_deadlocks(store):
    iono, arven, ash, misty = stranger_world(14, 14)
    start(ash, misty)
    owner = as_owner()
    for round_ in range(3):
        if round_:
            ok(restore(owner, misty, 'suspension'))
        stored = filed(ash, misty)
        p1 = ok(propose_to(ash, trader_of(misty), give=[(arven, 1)], get=[(iono, 1)]), 201)
        p2 = swap(iono, arven, misty, ash)
        t3 = ok(accept_trade(ash, swap(iono, arven, misty, ash)))
        t4 = ok(accept_trade(ash, swap(iono, arven, misty, ash)))
        ok(confirm(misty, t4))
        with ThreadPoolExecutor(5) as pool:
            work = [pool.submit(decide, owner, stored, 'suspend'), pool.submit(accept_trade, misty, p1),
                    pool.submit(accept_trade, ash, p2), pool.submit(confirm, ash, t3), pool.submit(confirm, ash, t4)]
            answers = [future.result() for future in work]
        assert all(answer.status_code < 500 for answer in answers), [a.text for a in answers]
        assert answers[0].status_code == 200
        [final] = rows('SELECT state, closed_reason FROM trade WHERE id = %s', t4['id'])
        assert (final['state'], final['closed_reason']) == ('closed', 'swapped')
        assert open_between(ash, misty) == []


def test_two_suspensions_of_trading_partners_at_once_never_deadlock(store):
    iono, arven, ash, misty = stranger_world(14, 14)
    brock, _ = collector('Brock')
    discoverable(brock, '00010')
    with_misty, with_ash = start(brock, misty), start(brock, ash)
    start(ash, misty)
    owner = as_owner()
    for round_ in range(4):
        if round_:
            for user in (misty, ash):
                ok(restore(owner, user, 'suspension'))
        swap(iono, arven, misty, ash)
        ok(propose_to(ash, trader_of(misty), give=[(arven, 1)], get=[(iono, 1)]), 201)
        first, second = filed(brock, misty), filed(brock, ash)
        with ThreadPoolExecutor(4) as pool:
            work = [pool.submit(decide, owner, first, 'suspend'), pool.submit(decide, owner, second, 'suspend'),
                    pool.submit(say, brock, with_misty, 'hi'), pool.submit(say, brock, with_ash, 'hi')]
            answers = [future.result() for future in work]
        assert all(answer.status_code < 500 for answer in answers), [a.text for a in answers]
        assert answers[0].status_code == 200 and answers[1].status_code == 200
        for answer in answers[2:]:
            assert answer.status_code == 201 or detail(answer) == UNAVAILABLE
        assert account_state_of(misty)[0] and account_state_of(ash)[0]
        assert open_between(ash, misty) == []
