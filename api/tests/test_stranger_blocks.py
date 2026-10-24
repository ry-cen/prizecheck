"""Block for strangers (Trading #302) through signed HTTP against PostgreSQL.

A collector Blocks any existing collector by trader id, and Unblocks by trader id, by user id or by ``block_id`` from
Settings › Privacy. Covered: the Block's Stage 1 effects on the pair's Trades; ``handle_shown`` and ``via``; each
identity route lifting only its own kind and answering as if no Block stood; the Blocked list; the derived effects on
reach, reads, messages and the conversation; the pair's pulse watermark; and the two races against messages and
stranger sends, which must never deadlock.
"""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from stranger_fixtures import far_zip, propose_to, strangers, trader_of
from test_blocks import blocked, same, unblock
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_conversations import detail, pulse, say, say_to, start, view
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import hold
from test_for_trade_locations import mark
from test_friend_copies import befriend, block, collector, ok, place
from test_friends import invite_token, lookup, send, step
from test_holdings import call
from test_open_discovery import discoverable
from test_trade_swap import confirm
from test_trades import accept_trade, read
from want_list_swap_fixtures import seed_swap_catalog

UNAVAILABLE = (409, {'code': 'COLLECTOR_UNAVAILABLE'})
UNKNOWN = (404, b'{"detail":{"code":"COLLECTOR_NOT_FOUND"}}')


def block_trader(user, trader_id, key=None):
    return call('POST', f'/api/social/traders/{trader_id}/block', user, {'idempotency_key': str(key or uuid4())})


def unblock_trader(user, trader_id, key=None):
    return call('POST', f'/api/social/traders/{trader_id}/unblock', user, {'idempotency_key': str(key or uuid4())})


def unblock_by_id(user, block_id, key=None):
    return call('POST', f'/api/social/blocked/{block_id}/unblock', user, {'idempotency_key': str(key or uuid4())})


def listed(user):
    return ok(call('GET', '/api/social/blocks', user))['blocked']


def block_row(blocker, other):
    with connect() as conn:
        return conn.execute('SELECT id, via, handle_shown FROM block WHERE blocker_id = %s AND blocked_id = %s',
                            (blocker, other)).fetchone()


def commands(user):
    with connect() as conn:
        return conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE user_id = %s AND kind = 'friend_command'",
                            (user,)).fetchone()['n']


def friendship_rows(a, b):
    low, high = sorted((a, b))
    with connect() as conn:
        return conn.execute('SELECT state, requested_by FROM friendship WHERE user_low = %s AND user_high = %s',
                            (low, high)).fetchall()


def pair(name='Pair'):
    """Two new collectors, both in open discovery at 00010 and 00011: a stranger pair in reach, with no cards."""
    (first, _), (second, _) = collector(f'{name} A'), collector(f'{name} B')
    discoverable(first, '00010')
    discoverable(second, '00011')
    return first, second


def conversation_changed_at(a, b):
    low, high = sorted((a, b))
    with connect() as conn:
        return conn.execute('SELECT changed_at FROM conversation WHERE user_low = %s AND user_high = %s',
                            (low, high)).fetchone()['changed_at']


def inbox_updates(user):
    with connect() as conn:
        return conn.execute('SELECT kind FROM inbox_update WHERE recipient_id = %s', (user,)).fetchall()


def test_a_trader_block_cancels_unconfirmed_stranger_trades_and_keeps_the_half_confirmed_one(store):
    ids, ash, misty, binder, box = strangers()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    hold(misty, binder, iono, 1)
    hold(ash, box, arven, 2)

    def swap():
        return ok(propose_to(misty, trader_of(ash), give=[(iono, 1)], get=[(arven, 1)]), 201)

    proposed, accepted, half = swap(), ok(accept_trade(ash, swap())), ok(accept_trade(ash, swap()))
    ok(confirm(ash, half))
    before = len(inbox_updates(misty))
    assert ok(block_trader(ash, trader_of(misty))) == {'relation': 'blocked'}
    after_block = len(inbox_updates(misty))
    cancelled_updates = len([row for row in inbox_updates(misty) if row['kind'] == 'cancelled'])
    for trade in (proposed, accepted):
        found = ok(read(misty, trade))
        assert (found['state'], found['closed_reason'], found['closed_by']) == ('closed', 'cancelled', 'them')
    assert ok(read(misty, half))['state'] == 'accepted'
    done = ok(confirm(misty, half))
    assert done['closed_reason'] == 'swapped'
    assert after_block - before == 2 and cancelled_updates == 2
    row = block_row(ash, misty)
    assert (row['via'], row['handle_shown']) == ('trader', False)


def test_any_existing_trader_id_can_be_blocked_and_unblocked_whatever_the_reach(store):
    ids, ash, misty, _, _ = strangers()
    far, _ = collector('Far W.')
    discoverable(far, far_zip())
    off, _ = collector('Off W.')
    blocker, _ = collector('Blocker')
    block(blocker, ash)
    suspended, _ = collector('Suspended')
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (suspended,))
    for other in (misty, far, off, blocker, suspended):
        assert ok(block_trader(ash, trader_of(other))) == {'relation': 'blocked'}, other
        assert block_row(ash, other) is not None
        assert ok(unblock_trader(ash, trader_of(other))) == {'relation': 'none'}, other
        assert block_row(ash, other) is None
    for route in (block_trader, unblock_trader):
        answer = route(ash, uuid4())
        assert (answer.status_code, answer.content) == UNKNOWN
        assert route(ash, 'not-a-uuid').status_code == 422
    seen = commands(ash)
    own = block_trader(ash, trader_of(ash))
    assert own.json()['detail']['code'] == 'OWN_ACCOUNT'
    assert own.status_code == 409 and commands(ash) == seen
    key = uuid4()
    first = block_trader(ash, trader_of(misty), key)
    seen = commands(ash)
    again = block_trader(ash, trader_of(misty), key)
    assert first.json() == again.json() == {'relation': 'blocked'} and commands(ash) == seen


def test_an_unblock_with_no_block_changes_nothing_and_answers_the_current_relation(store):
    ash, _ = collector('Ash K.')
    stranger, _ = collector('Stranger')
    friend, _ = collector('Friend')
    asked, _ = collector('Asked')
    asker, _ = collector('Asker')
    for user in (ash, stranger, friend, asked, asker):
        discoverable(user, '00010')
    assert ok(unblock_trader(ash, trader_of(stranger))) == {'relation': 'none'}
    assert block_row(ash, stranger) is None and friendship_rows(ash, stranger) == []
    befriend(ash, friend)
    assert ok(unblock_trader(ash, trader_of(friend))) == {'relation': 'friends'}
    assert [row['state'] for row in friendship_rows(ash, friend)] == ['accepted']
    ok(send(ash, asked))
    ok(send(asker, ash))
    assert ok(unblock_trader(ash, trader_of(asked))) == {'relation': 'none'}
    assert ok(unblock_trader(ash, trader_of(asker))) == {'relation': 'none'}
    assert [row['state'] for row in friendship_rows(ash, asked)] == ['pending']
    assert [row['state'] for row in friendship_rows(ash, asker)] == ['pending']
    assert ok(unblock(ash, asked)) == {'relation': 'request_sent'}
    assert ok(unblock(ash, asker)) == {'relation': 'request_received'}


def _asked_for_a_friend(blocker, other):
    ok(send(blocker, other))


def _was_asked_by_a_friend(blocker, other):
    ok(send(other, blocker))


def _asked_from_a_trade(blocker, other):
    low, high = sorted((blocker, other))
    with connect() as conn:
        conn.execute("""INSERT INTO friendship (user_low, user_high, state, requested_by, via_trade)
          VALUES (%s, %s, 'pending', %s, true)""", (low, high, blocker))


def _was_asked_from_a_trade(blocker, other):
    low, high = sorted((blocker, other))
    with connect() as conn:
        conn.execute("""INSERT INTO friendship (user_low, user_high, state, requested_by, via_trade)
          VALUES (%s, %s, 'pending', %s, true)""", (low, high, other))


def _read_the_invite(blocker, other):
    ok(call('GET', f'/api/social/invites/{invite_token(other)}', blocker))


def _read_the_invite_then_asked(blocker, other):
    _read_the_invite(blocker, other)
    ok(send(blocker, other))


def _looked_up(blocker, other):
    with connect() as conn:
        handle = conn.execute('SELECT handle FROM collector_profile WHERE user_id = %s', (other,)).fetchone()['handle']
    ok(lookup(blocker, handle))


HANDLE_CASES = {
    'friends': (lambda blocker, other: befriend(blocker, other), True, True),
    'received': (_was_asked_by_a_friend, True, True),
    'sent': (_asked_for_a_friend, True, True),
    'sent_from_a_trade': (_asked_from_a_trade, False, True),
    'received_from_a_trade': (_was_asked_from_a_trade, True, True),
    'invite_read': (_read_the_invite, False, False),
    'invite_read_then_asked': (_read_the_invite_then_asked, True, True),
    'looked_up': (_looked_up, False, True),
}


# A bare Invite Link read is blocked by the collector_id it answered, so only the user-id route has that case.
HANDLE_RUNS = [(route, case) for route in ('collector', 'trader') for case in sorted(HANDLE_CASES)
               if route == 'collector' or HANDLE_CASES[case][2]]


@pytest.mark.parametrize(('route', 'case'), HANDLE_RUNS)
def test_handle_shown_is_true_only_where_the_blocker_already_knew_the_handle(store, route, case):
    prepare, shown, _ = HANDLE_CASES[case]
    blocker, _ = collector('Blocker')
    other, handle = collector('Other')
    prepare(blocker, other)
    if route == 'collector':
        block(blocker, other)
    else:
        assert ok(block_trader(blocker, trader_of(other))) == {'relation': 'blocked'}
    row = block_row(blocker, other)
    assert (row['via'], row['handle_shown']) == (route, shown)
    [entry] = listed(blocker)
    assert set(entry) == {'block_id', 'display_name', 'handle', 'trader_id'}
    assert entry['block_id'] == str(row['id'])
    assert entry['handle'] == (handle if shown else None)
    assert entry['trader_id'] == (trader_of(other) if route == 'trader' else None)


def test_a_repeat_block_by_the_other_address_keeps_the_first(store):
    for first in ('trader', 'collector'):
        blocker, other = pair('Repeat')
        start(blocker, other)

        def place_block(kind):
            return block_trader(blocker, trader_of(other)) if kind == 'trader' else call(
                'POST', '/api/social/blocks', blocker, {'collector_id': other, 'idempotency_key': str(uuid4())})
        assert ok(place_block(first)) == {'relation': 'blocked'}
        row, moved = block_row(blocker, other), conversation_changed_at(blocker, other)
        second = 'collector' if first == 'trader' else 'trader'
        assert ok(place_block(second)) == {'relation': 'blocked'}
        assert dict(block_row(blocker, other)) == dict(row) and row['via'] == first
        assert conversation_changed_at(blocker, other) == moved


def test_the_blocked_list_is_by_name_then_block_id_and_carries_no_user_id(store):
    ash, _ = collector('Ash K.')
    targets = []
    for name in ('zoe', 'Brock', 'misty', 'twin', 'twin'):
        other, _ = collector(name)
        block(ash, other)
        targets.append((name.casefold(), other))
    response = call('GET', '/api/social/blocks', ash)
    assert response.status_code == 200
    people = response.json()['blocked']
    assert all(set(person) == {'block_id', 'display_name', 'handle', 'trader_id'} for person in people)
    assert all(other not in response.text for _, other in targets)
    ids = {other: str(block_row(ash, other)['id']) for _, other in targets}
    expected = sorted((name, ids[other]) for name, other in targets)
    assert [(person['display_name'].casefold(), person['block_id']) for person in people] == expected
    assert blocked(ash) == [other for _, other in sorted(targets, key=lambda item: (item[0], ids[item[1]]))]


def test_unblock_by_block_id_lifts_either_kind_and_refuses_anyone_elses(store):
    ash, _ = collector('Ash K.')
    misty, _ = collector('Misty W.')
    brock, _ = collector('Brock')
    gary, _ = collector('Gary')
    block(ash, brock)
    ok(block_trader(ash, trader_of(gary)))
    for other in (brock, gary):
        row = block_row(ash, other)
        assert ok(unblock_by_id(ash, row['id'])) == {'relation': 'none'}
        assert block_row(ash, other) is None
        assert str(row['id']) not in str(listed(ash))
    block(misty, ash)
    mine = block_row(misty, ash)['id']
    foreign, unknown = unblock_by_id(ash, mine), unblock_by_id(ash, uuid4())
    assert (foreign.status_code, foreign.content) == (unknown.status_code, unknown.content)
    assert foreign.json()['detail']['code'] == 'BLOCK_NOT_FOUND'
    assert foreign.status_code == 404 and block_row(misty, ash) is not None
    # A replay of the success key answers the stored 200; a new key on the lifted id is 404.
    key = uuid4()
    block(ash, brock)
    lifted = block_row(ash, brock)['id']
    assert ok(unblock_by_id(ash, lifted, key)) == {'relation': 'none'}
    assert ok(unblock_by_id(ash, lifted, key)) == {'relation': 'none'}
    assert unblock_by_id(ash, lifted).status_code == 404
    # The decliner lifting a Block by id ends the wait they set.
    ok(send(gary, misty))
    ok(step(misty, 'decline', gary))
    ok(block_trader(misty, trader_of(gary)))
    ok(unblock_by_id(misty, block_row(misty, gary)['id']))
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM friend_request_declined WHERE sender_id = %s AND recipient_id = %s',
                            (gary, misty)).fetchone()['n'] == 0


def test_each_identity_unblock_lifts_only_its_own_kind_and_answers_as_if_no_block_stood(store):
    ash, _ = collector('Ash K.')
    misty, _ = collector('Misty W.')
    brock, _ = collector('Brock')
    gary, _ = collector('Gary')
    ok(block_trader(ash, trader_of(misty)))
    first = block_row(ash, misty)
    same(unblock(ash, misty), unblock(ash, brock))
    assert ok(unblock(ash, misty)) == {'relation': 'none'}
    assert dict(block_row(ash, misty)) == dict(first)
    block(ash, gary)
    second = block_row(ash, gary)
    same(unblock_trader(ash, trader_of(gary)), unblock_trader(ash, trader_of(brock)))
    assert dict(block_row(ash, gary)) == dict(second)
    for other, row in ((misty, first), (gary, second)):
        assert ok(unblock_by_id(ash, row['id'])) == {'relation': 'none'}
        assert block_row(ash, other) is None


def test_a_key_used_on_one_route_is_refused_byte_identically_on_the_others(store):
    ash, _ = collector('Ash K.')
    misty, _ = collector('Misty W.')
    brock, _ = collector('Brock')

    def reused(response):
        assert (response.status_code, response.json()['detail']['code']) == (409, 'IDEMPOTENCY_KEY_REUSED')
        return response
    # A Block key from the collector-id route, replayed on the trader-id route, whoever the target is.
    key = uuid4()
    ok(call('POST', '/api/social/blocks', ash, {'collector_id': misty, 'idempotency_key': str(key)}))
    same(reused(block_trader(ash, trader_of(misty), key)), reused(block_trader(ash, trader_of(brock), key)))
    # An Unblock key from the user-id route, replayed on the trader-id and the block-id routes.
    key = uuid4()
    ok(call('POST', f'/api/social/blocks/{misty}/unblock', ash, {'idempotency_key': str(key)}))
    same(reused(unblock_trader(ash, trader_of(misty), key)), reused(unblock_trader(ash, trader_of(brock), key)))
    block(ash, misty)
    row = block_row(ash, misty)['id']
    same(reused(unblock_by_id(ash, row, key)), reused(unblock_by_id(ash, uuid4(), key)))
    assert block_row(ash, misty) is not None


def test_a_block_ends_reach_and_contact_both_ways_and_an_unblock_restores_them(store):
    ids, ash, misty, _, _ = strangers()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ok(call('PUT', '/api/social/trade-settings', misty, {'open_to_cash_offers': True}))
    conversation = start(ash, misty)
    header = ok(call('GET', f'/api/social/traders/{trader_of(misty)}', ash))
    assert (header['status'], header['open_to_cash_offers']) == ('open', True)
    with connect() as conn:
        assert conn.execute('SELECT other_id FROM trade_reach(%s, %s::text[])', (ash, [misty])).fetchall()
    ok(block_trader(ash, trader_of(misty)))
    with connect() as conn:
        for viewer, other in ((ash, misty), (misty, ash)):
            assert conn.execute('SELECT other_id FROM trade_reach(%s, %s::text[])', (viewer, [other])).fetchall() == []
            near = conn.execute('SELECT other_id FROM nearby_collectors(%s, 4::smallint, 100)', (viewer,)).fetchall()
            assert other not in {row['other_id'] for row in near}
    for viewer, other in ((ash, misty), (misty, ash)):
        for suffix in ('/trade-list',):
            seen = call('GET', f'/api/social/traders/{trader_of(other)}{suffix}', viewer)
            assert (seen.status_code, seen.content) == UNKNOWN
    header = ok(call('GET', f'/api/social/traders/{trader_of(misty)}', ash))
    assert (header['status'], header['open_to_cash_offers']) == ('you_blocked', False)
    assert ok(call('GET', f'/api/social/traders/{trader_of(ash)}', misty))['status'] == 'unavailable'
    for viewer, status in ((ash, 'you_blocked'), (misty, 'unavailable')):
        seen = ok(view(viewer, conversation))
        assert (seen['status'], seen['can_message'], seen['can_propose'], seen['can_report']) == (
            status, False, False, True)
    for sender, other in ((ash, misty), (misty, ash)):
        assert detail(say(sender, conversation, 'hi')) == UNAVAILABLE
        assert detail(say_to(sender, trader_of(other), 'hi')) == UNAVAILABLE
        assert detail(propose_to(sender, trader_of(other), give=[(iono, 1)], get=[(arven, 1)])) == UNAVAILABLE
    ok(unblock_by_id(ash, block_row(ash, misty)['id']))
    for viewer in (ash, misty):
        assert ok(view(viewer, conversation))['status'] == 'open'
    ok(say(ash, conversation, 'hi again'), 201)


def test_a_block_and_an_unblock_move_both_sides_watermark_without_open_trades(store):
    a, b = pair('Mark')
    start(a, b)
    first = (pulse(a)['watermark'], pulse(b)['watermark'])
    ok(block_trader(a, trader_of(b)))
    second = (pulse(a)['watermark'], pulse(b)['watermark'])
    assert second[0] != first[0] and second[1] != first[1]
    ok(unblock_by_id(a, block_row(a, b)['id']))
    third = (pulse(a)['watermark'], pulse(b)['watermark'])
    assert third[0] != second[0] and third[1] != second[1]
    c, d = pair('Quiet')
    ok(block_trader(c, trader_of(d)))
    ok(unblock_by_id(c, block_row(c, d)['id']))


def trading_pair(ids, blocker_low):
    """Two stranger collectors in reach, each holding 4 cards for trade, with a conversation and two open proposals
    from the blocker. The blocker's user id sorts below the other's when ``blocker_low``. Returns (blocker, other,
    conversation)."""
    iono, arven = ids['PAL 185'], ids['SVI 166']
    first, second = sorted([collector('Racer')[0], collector('Racer')[0]])
    blocker, other = (first, second) if blocker_low else (second, first)
    for user, zip_code in ((blocker, '00010'), (other, '00011')):
        discoverable(user, zip_code)
    binder, box = place(blocker, 'Trade Binder'), place(other, 'Box')
    hold(blocker, binder, iono, 4)
    hold(other, box, arven, 4)
    ok(mark(blocker, binder))
    ok(mark(other, box))
    conversation = start(blocker, other)
    for _ in range(2):
        ok(propose_to(blocker, trader_of(other), give=[(iono, 1)], get=[(arven, 1)]), 201)
    return blocker, other, conversation


def test_a_block_racing_messages_on_both_routes_never_deadlocks(store):
    ids = seed_swap_catalog()
    pairs = [trading_pair(ids, blocker_low=index < 4) for index in range(8)]
    work = []
    for blocker, other, conversation in pairs:
        work += [('block', blocker, other, conversation), ('r1', other, blocker, conversation),
                 ('r2', other, blocker, conversation), ('r3', blocker, other, conversation)]

    def run(item):
        kind, sender, other, conversation = item
        if kind == 'block':
            return kind, block_trader(sender, trader_of(other))
        if kind == 'r2':
            return kind, say_to(sender, trader_of(other), kind)
        return kind, say(sender, conversation, kind)
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(run, work))
    assert all(response.status_code < 500 for _, response in results), [r.text for _, r in results]
    for kind, response in results:
        if kind == 'block':
            assert response.status_code == 200, response.text
        else:
            assert response.status_code == 201 or detail(response) == UNAVAILABLE, response.text
    for blocker, other, conversation in pairs:
        assert block_row(blocker, other) is not None
        assert detail(say(other, conversation, 'late')) == UNAVAILABLE


def test_a_block_racing_stranger_sends_either_way_never_deadlocks_or_leaves_an_open_trade(store):
    ids, ash, misty, binder, box = strangers()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    hold(misty, binder, iono, 7)
    hold(ash, box, arven, 8)
    start(ash, misty)
    lifted = None
    for _ in range(4):
        if lifted:
            ok(unblock_by_id(ash, lifted))
        for _ in range(2):
            ok(propose_to(misty, trader_of(ash), give=[(iono, 1)], get=[(arven, 1)]), 201)
        with ThreadPoolExecutor(3) as pool:
            sends = [pool.submit(propose_to, misty, trader_of(ash), [(iono, 1)], [(arven, 1)]),
                     pool.submit(propose_to, ash, trader_of(misty), [(arven, 1)], [(iono, 1)])]
            blocking = pool.submit(block_trader, ash, trader_of(misty))
            answers = [future.result() for future in sends]
            blocked_answer = blocking.result()
        assert blocked_answer.status_code == 200, blocked_answer.text
        for answer in answers:
            assert answer.status_code < 500, answer.text
            assert answer.status_code == 201 or detail(answer) == UNAVAILABLE, answer.text
        lifted = block_row(ash, misty)['id']
        with connect() as conn:
            assert conn.execute("""SELECT count(*) AS n FROM trade WHERE state IN ('proposed', 'accepted')
              AND proposer_id IN (%s, %s)""", (ash, misty)).fetchone()['n'] == 0


def test_the_blocked_list_and_the_block_routes_are_in_the_schema():
    spec = app.openapi()
    components = spec['components']['schemas']
    assert set(components['BlockedCollector']['properties']) == {'block_id', 'display_name', 'handle', 'trader_id'}
    assert components['BlockedList']['properties']['blocked']['items']['$ref'].endswith('/BlockedCollector')
    for path in ('/api/social/traders/{trader_id}/block', '/api/social/traders/{trader_id}/unblock',
                 '/api/social/blocked/{block_id}/unblock'):
        schema = spec['paths'][path]['post']['responses']['200']['content']['application/json']['schema']
        assert schema['$ref'].endswith('/FriendCommandResult'), path
