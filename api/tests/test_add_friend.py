"""Add as Friend (Trading #304): from a Trade both sides confirmed, between collectors who are not Friends.

The refusals and their order, the request the requester follows only on the Trade (``TraderView.add_friend``, never in
``GET /friends``), accepting and withdrawing it, the decline cool-off, a Block or a second tap racing it, and the
completed-trade count with a deleted account.
"""
import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from app.main import connect  # noqa: F401
from app.social import friends as friends_module
from app.social import trades
from stranger_fixtures import propose_to, strangers, trader_of
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_conversations import detail, swapped
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_friend_copies import befriend, block, collector, ok
from test_friends import age_decline, commands_counted, rows
from test_holdings import call
from test_open_discovery import discoverable, put

UNAVAILABLE = b'{"detail":{"code":"COLLECTOR_UNAVAILABLE"}}'
NO_TRADE = b'{"detail":{"code":"TRADE_NOT_FOUND"}}'


def add(user, trade, key=None):
    return call('POST', f'/api/social/trades/{trade}/add-friend', user, {'idempotency_key': str(key or uuid4())})


def withdraw(user, trade, key=None):
    return call('POST', f'/api/social/trades/{trade}/add-friend/withdraw', user,
                {'idempotency_key': str(key or uuid4())})


def header(viewer, other):
    return ok(call('GET', f'/api/social/traders/{trader_of(other)}', viewer))


def traded():
    ids, ash, misty, _, _ = strangers()
    with connect() as conn:
        trade = swapped(conn, misty, ash)
    return ash, misty, trade


def pair_with_trade(discovery=True):
    """A requester and an other who are strangers, both in open discovery, with a Trade both confirmed."""
    requester, _ = collector('Requester')
    other, _ = collector('Other')
    if discovery:
        discoverable(requester, '00010')
        discoverable(other, '00011')
    with connect() as conn:
        trade = swapped(conn, other, requester)
    return requester, other, trade


def stored(a, b):
    low, high = sorted((a, b))
    with connect() as conn:
        return conn.execute('SELECT state, requested_by, via_trade FROM friendship WHERE user_low = %s AND user_high = %s',
                            (low, high)).fetchall()


def test_add_as_friend_is_refused_before_both_confirmations(store):
    ids, ash, misty, _, _ = strangers()
    proposal = ok(propose_to(misty, trader_of(ash), give=[(ids['PAL 185'], 1)], get=[(ids['SVI 166'], 1)]), 201)['id']
    assert detail(add(ash, proposal)) == (409, {'code': 'TRADE_NOT_SWAPPED'})
    with connect() as conn:
        one_sided = swapped(conn, misty, ash, both=False)
    assert detail(add(ash, one_sided)) == (409, {'code': 'TRADE_NOT_SWAPPED'})
    assert rows(ash, misty) == [] and commands_counted(ash) == 0


def test_a_non_party_and_an_unknown_trade_get_the_same_404(store):
    ash, misty, trade = traded()
    brock, _ = collector('Brock')
    answers = [(r.status_code, r.content) for r in (add(brock, trade), withdraw(brock, trade), add(ash, uuid4()))]
    assert answers == [(404, NO_TRADE)] * 3


def test_a_suspended_requester_is_refused_first(store):
    ash, misty, trade = traded()
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (ash,))
    assert detail(add(ash, trade)) == (403, {'code': 'ACCOUNT_SUSPENDED'})
    assert detail(add(ash, uuid4())) == (403, {'code': 'ACCOUNT_SUSPENDED'})
    assert rows(ash, misty) == []
    assert ok(withdraw(ash, trade)) == {'relation': 'none'}


def test_a_suspended_requester_can_still_withdraw_a_request_sent_before(store):
    ash, misty, trade = traded()
    ok(add(ash, trade))
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (ash,))
    assert ok(withdraw(ash, trade)) == {'relation': 'none'}
    assert stored(ash, misty) == []


def test_a_suspended_requester_cannot_withdraw_once_the_other_blocked_them(store):
    ash, misty, trade = traded()
    ok(add(ash, trade))
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (ash,))
    block(misty, ash)
    response = withdraw(ash, trade)
    assert (response.status_code, response.content) == (409, UNAVAILABLE)


def test_add_as_friend_is_unavailable_alike_when_blocked_suspended_or_deleted(store):
    blocked_by, suspended, deleted, blocking = (pair_with_trade() for _ in range(4))
    block(blocked_by[1], blocked_by[0])
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (suspended[1],))
        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (deleted[1],))
    block(blocking[0], blocking[1])
    for requester, other, trade in (blocked_by, suspended, deleted, blocking):
        response = add(requester, trade)
        assert (response.status_code, response.content) == (409, UNAVAILABLE)
        assert stored(requester, other) == []
    for requester, other, _ in (blocked_by, suspended):
        assert header(requester, other)['add_friend'] is None


def test_add_as_friend_rechecks_reach_under_the_locks(store, monkeypatch):
    ash, misty, trade = traded()
    real = friends_module.lock_owners

    def lock_then_block(conn, *ids):
        real(conn, *ids)
        with connect() as other:
            other.execute('INSERT INTO block (blocker_id, blocked_id) VALUES (%s, %s)', (misty, ash))

    monkeypatch.setattr(friends_module, 'lock_owners', lock_then_block)
    response = add(ash, trade)
    assert (response.status_code, response.content) == (409, UNAVAILABLE)
    assert rows(ash, misty) == [] and commands_counted(ash) == 1


def test_add_as_friend_sends_a_request_the_requester_follows_only_on_the_trade(store):
    ash, misty, trade = traded()
    key = uuid4()
    first = add(ash, trade, key)
    assert ok(first) == {'relation': 'request_sent'}
    row = stored(ash, misty)
    assert len(row) == 1 and row[0]['state'] == 'pending' and row[0]['requested_by'] == ash and row[0]['via_trade']
    assert ok(call('GET', '/api/social/friends', ash)) == {'received': [], 'friends': [], 'sent': []}
    with connect() as conn:
        handle = conn.execute('SELECT handle FROM collector_profile WHERE user_id = %s', (ash,)).fetchone()['handle']
    assert ok(call('GET', '/api/social/friends', misty))['received'] == [
        {'collector_id': ash, 'handle': handle, 'display_name': 'Ash K.'}]
    assert header(ash, misty)['add_friend'] == 'sent' and header(misty, ash)['add_friend'] == 'received'
    assert add(ash, trade, key).content == first.content and commands_counted(ash) == 1
    assert ok(add(ash, trade)) == {'relation': 'request_sent'}
    assert len(stored(ash, misty)) == 1 and commands_counted(ash) == 2


def test_both_tapping_add_as_friend_makes_them_friends(store):
    ash, misty, trade = traded()
    assert ok(add(ash, trade)) == {'relation': 'request_sent'}
    assert ok(add(misty, trade)) == {'relation': 'friends'}
    assert [r['state'] for r in stored(ash, misty)] == ['accepted']
    for viewer, other in ((ash, misty), (misty, ash)):
        listed = ok(call('GET', '/api/social/friends', viewer))['friends']
        assert [person['collector_id'] for person in listed] == [other]
        shown = header(viewer, other)
        assert shown['add_friend'] is None and shown['friend'] is True
        assert ok(add(viewer, trade)) == {'relation': 'friends'}


def test_the_recipient_accepts_an_add_as_friend_request_in_the_friends_drawer(store):
    ash, misty, trade = traded()
    ok(add(ash, trade))
    accepted = call('POST', f'/api/social/friend-requests/{ash}/accept', misty, {'idempotency_key': str(uuid4())})
    assert ok(accepted) == {'relation': 'friends'}
    with connect() as conn:
        handle = conn.execute('SELECT handle FROM collector_profile WHERE user_id = %s', (misty,)).fetchone()['handle']
    assert [(p['collector_id'], p['handle']) for p in ok(call('GET', '/api/social/friends', ash))['friends']] == [
        (misty, handle)]


def test_withdrawing_add_as_friend_deletes_only_the_callers_trade_request(store):
    ash, misty, trade = traded()
    ok(add(ash, trade))
    assert ok(withdraw(misty, trade)) == {'relation': 'request_received'}
    assert len(stored(ash, misty)) == 1
    assert ok(withdraw(ash, trade)) == {'relation': 'none'}
    assert stored(ash, misty) == []
    assert ok(call('GET', '/api/social/friends', misty))['received'] == []
    assert header(ash, misty)['add_friend'] == 'offer'
    assert ok(withdraw(ash, trade)) == {'relation': 'none'}


def test_withdraw_leaves_a_handle_request_in_place(store):
    ash, misty, trade = traded()
    ok(call('POST', '/api/social/friend-requests', ash, {'collector_id': misty, 'idempotency_key': str(uuid4())}))
    assert header(ash, misty)['add_friend'] is None  # a Trade cannot withdraw a Handle request, so no control
    assert ok(withdraw(ash, trade)) == {'relation': 'request_sent'}
    assert header(ash, misty)['add_friend'] is None and header(misty, ash)['add_friend'] == 'received'
    assert [p['collector_id'] for p in ok(call('GET', '/api/social/friends', ash))['sent']] == [misty]
    assert [r['via_trade'] for r in stored(ash, misty)] == [False]


def test_withdraw_on_a_proposal_cannot_link_a_handle_to_a_trader(store):
    ids, ash, misty, _, _ = strangers()
    ok(propose_to(misty, trader_of(ash), give=[(ids['PAL 185'], 1)], get=[(ids['SVI 166'], 1)]), 201)
    with connect() as conn:
        proposal = conn.execute('SELECT id FROM trade WHERE proposer_id = %s', (misty,)).fetchone()['id']
    ok(call('POST', '/api/social/friend-requests', ash, {'collector_id': misty, 'idempotency_key': str(uuid4())}))
    assert detail(withdraw(ash, proposal)) == (409, {'code': 'TRADE_NOT_SWAPPED'})
    assert [p['collector_id'] for p in ok(call('GET', '/api/social/friends', ash))['sent']] == [misty]
    assert commands_counted(ash) == 1


def test_withdraw_is_refused_like_add_when_the_other_is_unavailable(store):
    ash, misty, trade = traded()
    ok(add(ash, trade))
    block(misty, ash)
    response = withdraw(ash, trade)
    assert (response.status_code, response.content) == (409, UNAVAILABLE)
    assert stored(ash, misty) == []  # the Block itself ended the request; the withdraw changed nothing


def test_a_key_from_one_friend_route_is_never_replayed_on_another(store):
    ash, misty, trade = traded()
    key = uuid4()
    ok(add(ash, trade, key))
    for response in (call('POST', '/api/social/friend-requests', ash,
                          {'collector_id': misty, 'idempotency_key': str(key)}), withdraw(ash, trade, key)):
        assert detail(response) == (409, {'code': 'IDEMPOTENCY_KEY_REUSED'})
        assert misty not in response.text
    assert len(stored(ash, misty)) == 1


def test_a_declined_add_as_friend_waits_out_the_cool_off(store):
    ash, misty, trade = traded()
    ok(add(ash, trade))
    ok(call('POST', f'/api/social/friend-requests/{ash}/decline', misty, {'idempotency_key': str(uuid4())}))
    assert header(ash, misty)['add_friend'] == 'offer'
    assert detail(add(ash, trade)) == (409, {'code': 'TRY_LATER'})
    age_decline(ash, misty, '8 days')
    assert ok(add(ash, trade)) == {'relation': 'request_sent'}
    assert stored(ash, misty)[0]['via_trade'] is True


def test_add_friend_is_offered_only_after_both_confirmed_and_never_to_friends(store):
    ids, ash, misty, _, _ = strangers()
    ok(propose_to(misty, trader_of(ash), give=[(ids['PAL 185'], 1)], get=[(ids['SVI 166'], 1)]), 201)
    assert header(ash, misty)['add_friend'] is None
    with connect() as conn:
        swapped(conn, misty, ash, both=False)
    assert header(ash, misty)['add_friend'] is None
    with connect() as conn:
        swapped(conn, misty, ash)
    assert header(ash, misty)['add_friend'] == 'offer' and header(misty, ash)['add_friend'] == 'offer'
    ok(put(misty, {'enabled': False}))
    assert header(ash, misty)['add_friend'] == 'offer'
    brock, _ = collector('Brock')
    gary, _ = collector('Gary')
    befriend(brock, gary)
    with connect() as conn:
        swapped(conn, brock, gary)
    assert header(brock, gary)['add_friend'] is None
    block(ash, misty)
    blocked = header(ash, misty)
    assert blocked['status'] == 'you_blocked' and blocked['add_friend'] is None


def test_completed_trades_count_friend_and_stranger_trades_and_not_a_one_sided_close_after_a_deletion(store):
    (ash, _), (misty, _), (brock, _), (gary, _) = (collector(n) for n in ('Ash', 'Misty', 'Brock', 'Gary'))
    for user, zip_code in ((ash, '00010'), (brock, '00011'), (gary, '00011')):
        discoverable(user, zip_code)
    befriend(ash, misty)
    with connect() as conn:
        swapped(conn, ash, misty)
        swapped(conn, brock, ash)
        assert trades.completed_trades(conn, [ash]) == {ash: 2}
        swapped(conn, ash, gary, both=False)
        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (gary,))
        assert trades.completed_trades(conn, [ash]) == {ash: 2}
        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (misty,))
        assert trades.completed_trades(conn, [ash]) == {ash: 2}
    assert header(brock, ash)['completed_trades'] == 2
    assert header(ash, brock)['completed_trades'] == 1


def test_a_block_racing_add_as_friend_never_leaves_a_request(store):
    pairs = [pair_with_trade() for _ in range(8)]

    def add_one(pair):
        return add(pair[0], pair[2])

    def block_one(pair):
        return call('POST', '/api/social/blocks', pair[1], {'collector_id': pair[0], 'idempotency_key': str(uuid4())})

    gates = [threading.Barrier(2) for _ in pairs]

    def raced(fn, pair, gate):
        gate.wait(timeout=30)
        return fn(pair)

    with ThreadPoolExecutor(16) as pool:
        futures = []
        for pair, gate in zip(pairs, gates):
            futures.append((pool.submit(raced, add_one, pair, gate), pool.submit(raced, block_one, pair, gate)))
        added = [a.result() for a, _ in futures]
        blocked = [b.result() for _, b in futures]
    for pair, adding, blocking in zip(pairs, added, blocked):
        assert ok(blocking) == {'relation': 'blocked'}
        assert (adding.status_code == 200 and adding.json() == {'relation': 'request_sent'}) or (
            adding.status_code, adding.content) == (409, UNAVAILABLE), adding.text
        assert stored(pair[0], pair[1]) == []
        with connect() as conn:
            assert conn.execute('SELECT count(*) AS n FROM block WHERE blocker_id = %s AND blocked_id = %s',
                                (pair[1], pair[0])).fetchone()['n'] == 1


def test_add_as_friend_from_both_sides_at_once_makes_one_friendship(store):
    pairs = [pair_with_trade() for _ in range(6)]
    work = [(a, trade) for a, _, trade in pairs] + [(b, trade) for _, b, trade in pairs]
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda job: add(*job), work))
    assert all(r.status_code == 200 for r in results), [r.text for r in results]
    for index, (a, b, _) in enumerate(pairs):
        assert {results[index].json()['relation'], results[index + len(pairs)].json()['relation']} == {
            'request_sent', 'friends'}
        row = stored(a, b)
        assert len(row) == 1 and row[0]['state'] == 'accepted'
