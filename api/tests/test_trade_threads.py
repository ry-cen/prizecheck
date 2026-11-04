"""Thread-addressed Trade replacement, races, log slots and command replay."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest

from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import launches, store  # noqa: F401
from app.main import connect
from app.social.trades import end_trades_between
from app.social.owners import lock_owners
from test_friend_copies import ok
from test_holdings import call
from test_loans import revision_of
from test_trade_promises import reserved, trade_picks
from test_trade_swap import confirm
from test_trades import (accept_trade, counter, detail, proposed, read, row_of,
                         trade_step, trading)


def events(trade):
    with connect() as conn:
        return conn.execute('SELECT * FROM thread_event WHERE thread_id=%s ORDER BY created_at,id',
                            (trade['thread_id'],)).fetchall()


def race(a, b):
    barrier = Barrier(2)
    def run(fn):
        barrier.wait(timeout=10)
        return fn()
    with ThreadPoolExecutor(max_workers=2) as pool:
        left, right = pool.submit(run, a), pool.submit(run, b)
        return left.result(timeout=30), right.result(timeout=30)


def test_agreed_edit_releases_both_sides_and_advances_each_revision_once(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(misty, ash, give=[(iono, 2)], get=[(arven, 1)])
    agreed = ok(accept_trade(ash, original))
    before = revision_of(misty), revision_of(ash)
    changed = ok(counter(misty, agreed, give=[(iono, 1)], get=[(arven, 2)]))
    assert changed['thread_id'] == original['thread_id']
    assert changed['offer_id'] != original['offer_id']
    assert row_of(original)['state'] == 'closed'
    assert row_of(original)['closed_reason'] == 'countered'
    assert trade_picks(original['id']) == []
    assert trade_picks(changed['id']) == [('proposer', misty, binder, 1)]
    assert reserved(misty, iono) == (1, 1) and reserved(ash, arven) == (0, 0)
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1] + 1)
    event = events(changed)[-1]
    assert event['kind'] == 'changed_after_agreement'
    assert {line['giver'] for line in event['data']['lines']} == {'low', 'high'}


@pytest.mark.parametrize('refusal', ['caps', 'cash'])
def test_refused_replacement_preserves_round_picks_revisions_and_log(store, refusal):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(misty, ash, give=[(iono, 2)], get=[(arven, 1)])
    agreed = ok(accept_trade(ash, original))
    before = row_of(original), trade_picks(original['id']), revision_of(misty), revision_of(ash), events(original)
    response = counter(misty, agreed, give=[(iono, 4)], get=[(arven, 1)]) if refusal == 'caps' else counter(
        misty, agreed, get=[(arven, 1)], cash={'cents': '100', 'payer': 'you'})
    assert detail(response)[0] == 409
    assert detail(response)[1]['code'] == ('NOT_TRADEABLE' if refusal == 'caps' else 'CASH_ONLY_NOT_OPEN')
    assert (row_of(original), trade_picks(original['id']), revision_of(misty), revision_of(ash), events(original)) == before


@pytest.mark.parametrize('mode', ['counters', 'edit_accept', 'edit_confirm', 'counter_confirm', 'cancel_confirm'])
def test_racing_thread_steps_have_one_winner(store, mode):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    current = ok(accept_trade(ash, original)) if mode in ('edit_confirm', 'counter_confirm', 'cancel_confirm') else original
    if mode == 'counters':
        a = lambda: counter(ash, current, give=[(arven, 1)], get=[(iono, 1)])
        b = lambda: counter(ash, current, give=[(arven, 2)], get=[(iono, 1)])
    else:
        a = (lambda: trade_step(misty, current, 'cancel')) if mode == 'cancel_confirm' else (
            lambda: counter(misty, current, give=[(iono, 2)], get=[(arven, 1)]))
        b = (lambda: accept_trade(ash, current)) if mode == 'edit_accept' else (
            lambda: confirm(ash, current, revision=current['revision']))
    if mode == 'counter_confirm':
        a = lambda: counter(ash, current, give=[(arven, 2)], get=[(iono, 1)])
        b = lambda: confirm(misty, current, revision=current['revision'])
    results = race(a, b)
    assert sorted(response.status_code for response in results) == [200, 409]
    loser = next(response for response in results if response.status_code == 409)
    assert detail(loser)[1]['code'] in {'OFFER_CHANGED', 'STEP_NOT_ALLOWED', 'TRADE_CHANGED'}
    if mode == 'counters':
        assert detail(loser)[1]['code'] == 'OFFER_CHANGED'
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM trade WHERE thread_id=%s AND state <> 'closed'",
                            (original['thread_id'],)).fetchone()['n'] <= 1


def test_replacement_replays_its_original_response_after_later_changes(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    key = uuid4()
    first = counter(ash, original, give=[(arven, 1)], get=[(iono, 2)], key=key)
    changed = ok(first)
    ok(counter(misty, changed, give=[(iono, 1)], get=[(arven, 1)]))
    before = events(original)
    replay = counter(ash, original, give=[(arven, 1)], get=[(iono, 2)], key=key)
    assert replay.status_code == 200 and replay.json() == first.json()
    assert events(original) == before


def test_bulk_closure_returns_threads_without_touching_and_logs_each_item(store):
    ids, ash, misty, binder, box = trading()
    items = [proposed(misty, ash, give=[(ids['PAL 185'], 1)]) for _ in range(2)]
    with connect() as conn, conn.transaction():
        lock_owners(conn, ash, misty)
        before = conn.execute('SELECT id,changed_at FROM thread WHERE id=ANY(%s)',
                              ([item['thread_id'] for item in items],)).fetchall()
        touched = end_trades_between(conn, ash, misty, 'closed_blocked')
        assert {str(item) for item in touched} == {item['thread_id'] for item in items}
        assert conn.execute('SELECT id,changed_at FROM thread WHERE id=ANY(%s)',
                            ([item['thread_id'] for item in items],)).fetchall() == before
    for item in items:
        assert row_of(item)['state'] == 'closed'
        assert [event['kind'] for event in events(item)].count('closed_blocked') == 1


def test_round_ids_and_old_mutation_routes_cannot_act_on_a_thread(store):
    ids, ash, misty, binder, box = trading()
    item = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    body = {'offer_id': item['id'], 'revision': item['revision'], 'idempotency_key': str(uuid4())}
    assert call('GET', f"/api/trades/{item['id']}", misty).status_code == 404
    assert call('POST', f"/api/trades/{item['id']}/accept", ash, body).status_code == 404
    assert call('POST', f"/api/trades/{item['thread_id']}/counter", ash, body).status_code == 404
    assert call('POST', f"/api/social/trades/{item['id']}/withdraw", misty, body).status_code == 404
    resolved = ok(call('GET', f"/api/trades/resolve/{item['id']}", misty))
    assert resolved == {'thread_id': item['thread_id']}
    assert ok(read(misty, item))['offer_id'] == item['id']


def test_second_swap_keeps_strict_revision_and_retries_same_key_after_refetch(store):
    ids, ash, misty, binder, box = trading()
    original = proposed(misty, ash, give=[(ids['PAL 185'], 1)], get=[(ids['SVI 166'], 1)])
    agreed = ok(accept_trade(ash, original))
    ok(confirm(ash, agreed, revision=agreed['revision']))
    key = uuid4()
    stale = confirm(misty, agreed, key=key, revision=agreed['revision'])
    assert detail(stale) == (409, {'code': 'TRADE_CHANGED'})
    fresh = ok(read(misty, agreed))
    done = confirm(misty, fresh, key=key, revision=fresh['revision'])
    assert ok(done)['closed_reason'] == 'swapped'
    assert confirm(misty, fresh, key=key, revision=fresh['revision']).json() == done.json()


def message_count(user):
    with connect() as conn:
        return conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE user_id=%s AND kind='message'",
                            (user,)).fetchone()['n']


def open_trade(user, recipient, edition, *, message=None, key=None):
    body = {'recipient_id': recipient, 'you_give': [{'edition_id': edition, 'quantity': '1'}],
            'idempotency_key': str(key or uuid4())}
    if message is not None:
        body['message'] = message
    return call('POST', '/api/trades', user, body)


def opening_rows(user):
    with connect() as conn:
        return conn.execute("""SELECT
          (SELECT count(*) FROM trade WHERE proposer_id=%(me)s) AS trades,
          (SELECT count(*) FROM thread WHERE user_low=%(me)s OR user_high=%(me)s) AS threads,
          (SELECT count(*) FROM thread_message m JOIN thread t ON t.id=m.thread_id
            WHERE t.user_low=%(me)s OR t.user_high=%(me)s) AS messages,
          (SELECT count(*) FROM trade_pick WHERE owner_id=%(me)s) AS picks,
          (SELECT count(*) FROM handle_lookup_event WHERE user_id=%(me)s AND kind='trade_command') AS commands""",
                            {'me': user}).fetchone()


def test_opening_message_over_quota_rolls_back_the_whole_trade(store):
    ids, ash, misty, binder, box = trading()
    with connect() as conn:
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'message' FROM generate_series(1,120)",
                     (misty,))
    before = opening_rows(misty), revision_of(misty), revision_of(ash)
    refused = open_trade(misty, ash, ids['PAL 185'], message='One more message')
    assert refused.status_code == 429
    assert refused.json()['detail']['code'] == 'MESSAGE_RATE_LIMITED'
    assert (opening_rows(misty), revision_of(misty), revision_of(ash)) == before
    assert before[0] == {'trades': 0, 'threads': 0, 'messages': 0, 'picks': 0, 'commands': 0}
    assert message_count(misty) == 120


def test_opening_message_counts_once_and_replays_even_at_quota(store):
    ids, ash, misty, binder, box = trading()
    key = uuid4()
    first = open_trade(misty, ash, ids['PAL 185'], message='Want to swap?', key=key)
    assert first.status_code == 201
    assert message_count(misty) == 1
    assert opening_rows(misty) == {'trades': 1, 'threads': 1, 'messages': 1, 'picks': 1, 'commands': 1}
    with connect() as conn:
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'message' FROM generate_series(1,119)",
                     (misty,))
    before = opening_rows(misty), revision_of(misty)
    replay = open_trade(misty, ash, ids['PAL 185'], message='Want to swap?', key=key)
    assert replay.status_code == 201 and replay.json() == first.json()
    assert message_count(misty) == 120
    assert (opening_rows(misty), revision_of(misty)) == before


def test_opening_without_message_uses_no_message_quota(store):
    ids, ash, misty, binder, box = trading()
    with connect() as conn:
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'message' FROM generate_series(1,120)",
                     (misty,))
    assert open_trade(misty, ash, ids['PAL 185']).status_code == 201
    assert message_count(misty) == 120
    assert opening_rows(misty) == {'trades': 1, 'threads': 1, 'messages': 0, 'picks': 1, 'commands': 1}


def test_each_agreed_side_waits_until_its_own_physical_confirmation(store):
    ids, ash, misty, _, _ = trading()
    original = proposed(misty, ash, give=[(ids['PAL 185'], 1)], get=[(ids['SVI 166'], 1)])
    agreed = ok(accept_trade(ash, original))
    for actor in (ash, misty):
        before = ok(read(actor, agreed))
        assert before['waiting'] == 'confirm_swap' and before['needs_you'] is True
        assert before['section'] == 'needs_you'
    ok(confirm(misty, agreed, revision=agreed['revision']))
    mine, theirs = ok(read(misty, agreed)), ok(read(ash, agreed))
    assert mine['waiting'] is None and mine['needs_you'] is False
    assert theirs['waiting'] == 'confirm_swap' and theirs['needs_you'] is True


def test_cash_only_counter_keeps_the_setting_off_and_replays_once(store):
    from test_trades import trade_settings
    ids, ash, misty, _, _ = trading()
    trade_settings(ash, True)
    assert trade_settings(misty) is False
    original = proposed(misty, ash, get=[(ids['SVI 166'], 1)],
                        cash={'cents': '1000', 'payer': 'you'})
    key = uuid4()
    body = {'offer_id': original['offer_id'], 'revision': original['revision'],
            'idempotency_key': str(key), 'you_give': [{'edition_id': ids['SVI 166'], 'quantity': '1'}],
            'you_get': [], 'cash': {'cents': '1500', 'payer': 'them'}}
    changed = ok(call('POST', f"/api/trades/{original['thread_id']}/offer", ash, body))
    assert trade_settings(misty) is False
    assert changed['thread_id'] == original['thread_id'] and changed['offer_id'] != original['offer_id']
    assert changed['cash'] == body['cash']
    before = trade_picks(changed['id']), revision_of(ash), revision_of(misty), events(changed)
    assert ok(call('POST', f"/api/trades/{original['thread_id']}/offer", ash, body)) == changed
    assert (trade_picks(changed['id']), revision_of(ash), revision_of(misty), events(changed)) == before
