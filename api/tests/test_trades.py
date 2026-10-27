"""Send a Friend a Trade Proposal and withdraw it (Trading #270), accept, decline or cancel it (#271) and counter it
(#278): ``POST /api/trades``, ``POST /api/trades/{id}/accept`` and ``POST /api/trades/{id}/counter``
(``app.trade_inventory``), the Trade reads and the withdraw, decline
and cancel steps under ``/api/social/trades`` (``app.social.trades``) and the Trade Pick List (``app.trade_picks``),
through signed HTTP against PostgreSQL.

Every test seeds the Swap catalog (``want_list_swap_fixtures``) and starts new collectors: Misty W. and Ash K. are
Friends (``test_loans.pair``). Copies are on a Trade List only from a For trade Location
(``test_for_trade_locations.mark``).
"""
import os
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest

from app.main import connect  # noqa: F401
from app import trade_inventory
from app.social import conversations, owners, trades
from stranger_fixtures import far_zip, propose_to, strangers, trader_of
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import hold
from test_for_trade_locations import deck_in, hide, mark
from test_friend_copies import befriend, block, collector, copies, node, ok, place
from test_handover import _asleep, _sleeping, handover
from test_holdings import call
from test_lend_offers import offer
from test_loan_promises import _hold_pick_insert, _waiting_on_a_row
from test_loans import accept, pair, revision_of, sent, view
from test_moves import commit, selected, stage, start
from test_open_discovery import discoverable
from test_trade_lists import friend_cards, own_cards
from test_trade_promises import reserved, trade_picks
from want_list_swap_fixtures import seed_swap_catalog

UNKNOWN = b'{"detail":{"code":"TRADE_NOT_FOUND"}}'


def lines(cards):
    return [{'edition_id': edition, 'quantity': str(count)} for edition, count in cards]


def propose(sender, recipient, give=(), get=(), key=None, cash=None):
    body = {'recipient_id': recipient, 'you_give': lines(give), 'you_get': lines(get),
            'idempotency_key': str(key or uuid4())}
    if cash is not None:
        body['cash'] = cash
    return call('POST', '/api/trades', sender, body)


def proposed(sender, recipient, give=(), get=(), cash=None):
    return ok(propose(sender, recipient, give, get, cash=cash), 201)


def trade_settings(user, value=None):
    """Open to cash offers: read with GET, or set to ``value`` with PUT."""
    if value is None:
        return ok(call('GET', '/api/social/trade-settings', user))['open_to_cash_offers']
    return ok(call('PUT', '/api/social/trade-settings', user, {'open_to_cash_offers': value}))['open_to_cash_offers']


def trade_step(user, trade, action, key=None, revision=None):
    return call('POST', f"/api/social/trades/{trade['id']}/{action}", user,
                {'revision': revision or trade['revision'], 'idempotency_key': str(key or uuid4())})


def read(user, trade):
    return call('GET', f"/api/social/trades/{trade['id']}", user)


def accept_trade(user, trade, key=None, revision=None):
    """The recipient's accept, on the revision ``trade`` was read at unless ``revision`` says otherwise."""
    return call('POST', f"/api/trades/{trade['id']}/accept", user,
                {'revision': revision or trade['revision'], 'idempotency_key': str(key or uuid4())})


def counter(user, trade, give=(), get=(), cash=None, key=None, revision=None):
    body = {'revision': revision or trade['revision'], 'idempotency_key': str(key or uuid4()),
            'you_give': lines(give), 'you_get': lines(get)}
    if cash is not None:
        body['cash'] = cash
    return call('POST', f"/api/trades/{trade['id']}/counter", user, body)


def countered(user, trade, give=(), get=(), cash=None):
    return ok(counter(user, trade, give, get, cash))


def inbox(user):
    return ok(call('GET', '/api/social/inbox', user))


def counters_of(trade):
    """The ids of the rows that answer ``trade``."""
    with connect() as conn:
        return [str(row['id']) for row in conn.execute('SELECT id FROM trade WHERE countered_from=%s', (trade['id'],))]


def updates(trade):
    """The Trade's stored updates as [(recipient, kind, other_name)], oldest first."""
    with connect() as conn:
        return [(row['recipient_id'], row['kind'], row['other_name']) for row in conn.execute(
            'SELECT recipient_id, kind, other_name FROM inbox_update WHERE trade_id=%s ORDER BY created_at, id',
            (trade['id'],))]


def row_of(trade):
    with connect() as conn:
        return conn.execute('SELECT * FROM trade WHERE id=%s', (trade['id'],)).fetchone()


def move_one(owner, source, edition, destination):
    """One Collection Move of one copy from ``source`` to ``destination``."""
    version = next(holding['version'] for holding in ok(call('GET', f'/api/holdings/{source}', owner))['holdings']
                   if holding['edition_id'] == edition)
    manifest = start(owner, source)
    assert stage(owner, manifest, [selected(edition, 1, version)]).status_code == 200
    return ok(commit(owner, manifest, destination))


def detail(response):
    return response.status_code, response.json()['detail']


def sides(view_):
    """(you_give, you_get) as [(Edition, copies)]."""
    return ([(card['edition_id'], card['copies']) for card in view_['you_give']],
            [(card['edition_id'], card['copies']) for card in view_['you_get']])


def commands(user):
    with connect() as conn:
        return conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE user_id=%s AND kind='trade_command'",
                            (user,)).fetchone()['n']


def trading():
    """Misty W. (3 Iono PAL 185 in her For trade Trade Binder) and Ash K. (2 Arven SVI 166 in his For trade Box),
    Friends. Returns (ids, ash, misty, binder, box)."""
    ids = seed_swap_catalog()
    ash, misty = pair()
    binder, box = place(misty, 'Trade Binder'), place(ash, 'Box')
    hold(misty, binder, ids['PAL 185'], 3)
    hold(ash, box, ids['SVI 166'], 2)
    ok(mark(misty, binder))
    ok(mark(ash, box))
    return ids, ash, misty, binder, box


def test_send_refuses_each_shape_rule_in_order_before_anything_is_read_or_counted(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    many = [(str(uuid4()), 1) for _ in range(51)]
    cases = [
        (propose(misty, misty, give=[(iono, 0)]), 409, 'OWN_ACCOUNT'),
        (propose(misty, ash, give=[(iono, 0)]), 422, 'INVALID_QUANTITY'),
        (propose(misty, ash, get=[(iono, 10000)]), 422, 'INVALID_QUANTITY'),
        (propose(misty, ash, give=[(iono, '1.5')]), 422, 'INVALID_QUANTITY'),
        (propose(misty, ash, give=[(iono, 1), (iono, 1)], get=[(iono, 'x')]), 422, 'INVALID_QUANTITY'),
        (propose(misty, ash, give=[(iono, 1), (iono, 2)]), 422, 'DUPLICATE_EDITION'),
        (propose(misty, ash, get=[(arven, 1), (arven, 1)], give=[(arven, 1)]), 422, 'DUPLICATE_EDITION'),
        (propose(misty, ash, give=[(iono, 1)], get=[(iono, 1)]), 422, 'SAME_CARD_BOTH_SIDES'),
        (propose(misty, ash, give=many, get=[many[0]]), 422, 'SAME_CARD_BOTH_SIDES'),
        (propose(misty, ash, give=many), 422, 'TOO_MANY_LINES'),
        (propose(misty, ash, get=many), 422, 'TOO_MANY_LINES'),
        (propose(misty, ash), 422, 'TRADE_HAS_NO_CARDS'),
    ]
    assert [(response.status_code, response.json()['detail']['code']) for response, _, _ in cases] == \
        [(status, code) for _, status, code in cases]
    # 9999 copies is a valid line: it reaches the listable check.
    assert detail(propose(misty, ash, get=[(arven, 9999)]))[1]['code'] == 'NOT_TRADEABLE'
    # 50 Editions a side is allowed: unknown Editions have no listable copies.
    assert detail(propose(misty, ash, give=many[:50]))[1] == {
        'code': 'NOT_TRADEABLE', 'edition_id': many[0][0], 'available': '0', 'side': 'you_give'}
    # Shape refusals are never counted, and the two refused inside the transaction rolled back with their count.
    assert commands(misty) == 0


def test_a_send_by_user_id_is_refused_unless_the_two_are_friends(store):
    ids, ash, misty, binder, box = trading()
    (gary, _) = collector('Gary O.')
    assert detail(propose(misty, gary, give=[(ids['PAL 185'], 1)])) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    block(ash, misty)
    assert detail(propose(misty, ash, give=[(ids['PAL 185'], 1)])) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM trade WHERE proposer_id=%s', (misty,)).fetchone()['n'] == 0


def test_a_swap_reserves_only_the_senders_copies_at_once_and_a_withdraw_releases_them(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    before = revision_of(misty), revision_of(ash)
    trade = proposed(misty, ash, give=[(iono, 2)], get=[(arven, 1)])
    # A proposer who gives cards may also replace an out-of-date pick while the proposal waits (Trading #272).
    assert (trade['state'], trade['role'], trade['section'], trade['actions']) == (
        'proposed', 'proposer', 'pending', ['use_suggested_picks', 'withdraw'])
    assert sides(trade) == ([(iono, '2')], [(arven, '1')])
    assert (trade['waiting'], trade['needs_you'], trade['cash'], trade['countered_from']) == (None, False, None, None)
    # Misty's two copies are promised at once, from her For trade binder; nothing of Ash's is.
    assert trade_picks(trade['id']) == [('proposer', misty, binder, 2)]
    assert reserved(misty, iono) == (2, 2) and reserved(ash, arven) == (0, 0)
    assert own_cards(misty) == {iono: ('1', {'Trade Binder': '1'})}
    assert own_cards(ash) == {arven: ('2', {'Box': '2'})}
    # Only the sender's revision moved, once.
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1])
    # The promised copies stop being lendable to a Friend.
    assert copies(ash, [misty], [iono]) == {(misty, iono): (1, 0)}
    withdrawn = ok(trade_step(misty, trade, 'withdraw'))
    assert (withdrawn['state'], withdrawn['closed_reason'], withdrawn['closed_by'], withdrawn['section'],
            withdrawn['actions'], withdrawn['revision']) == ('closed', 'withdrawn', 'you', 'history', [],
                                                            trade['revision'] + 1)
    assert trade_picks(trade['id']) == [] and reserved(misty, iono) == (0, 0)
    assert own_cards(misty) == {iono: ('3', {'Trade Binder': '3'})}
    assert copies(ash, [misty], [iono]) == {(misty, iono): (3, 0)}
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 2, before[1])
    seen = ok(read(ash, trade))
    assert (seen['closed_reason'], seen['closed_by'], seen['role']) == ('withdrawn', 'them', 'recipient')


def test_a_gift_either_way_is_a_proposal_and_asking_reserves_and_moves_nothing(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    before = revision_of(misty), revision_of(ash)
    gift = proposed(misty, ash, give=[(iono, 1)])
    assert sides(gift) == ([(iono, '1')], [])
    asked = proposed(misty, ash, get=[(arven, 2)])
    assert sides(asked) == ([], [(arven, '2')]) and trade_picks(asked['id']) == []
    assert asked['actions'] == ['withdraw']
    # Only the gift reserved, so only it moved Misty's revision; asking for Ash's cards reserves none of them.
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1])
    assert reserved(ash, arven) == (0, 0) and friend_cards(misty, handle_of(ash)) == {arven: '2'}
    ok(trade_step(misty, asked, 'withdraw'))
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1])


def handle_of(owner):
    return ok(call('GET', '/api/profile', owner))['handle']


def test_each_side_is_capped_at_its_listable_copies_from_the_one_rule(store):
    ids, ash, misty, binder, box = trading()
    iono, arven, boss = ids['PAL 185'], ids['SVI 166'], ids['PAL 172']
    assert detail(propose(misty, ash, give=[(iono, 4)])) == (
        409, {'code': 'NOT_TRADEABLE', 'edition_id': iono, 'available': '3', 'side': 'you_give'})
    assert detail(propose(misty, ash, get=[(arven, 3)])) == (
        409, {'code': 'NOT_TRADEABLE', 'edition_id': arven, 'available': '2', 'side': 'you_get'})
    # The sender's lines are checked first, then the Friend's, each in the order sent.
    assert detail(propose(misty, ash, give=[(iono, 1), (boss, 1)], get=[(arven, 3)]))[1] == {
        'code': 'NOT_TRADEABLE', 'edition_id': boss, 'available': '0', 'side': 'you_give'}
    # Copies outside a For trade Location are not on the Trade List.
    hold(misty, node(misty, 'Unsorted')['id'], boss, 2)
    assert detail(propose(misty, ash, give=[(boss, 1)]))[1]['available'] == '0'
    # A Deck inside a For trade Location never counts.
    shelf = place(misty, 'Shelf')
    ok(mark(misty, shelf))
    hold(misty, deck_in(misty, 'Deck', shelf), boss, 2)
    assert detail(propose(misty, ash, give=[(boss, 1)]))[1]['available'] == '0'
    # A hidden For trade Location still counts, for both sides.
    hide(misty, binder)
    hide(ash, box)
    trade = proposed(misty, ash, give=[(iono, 3)], get=[(arven, 2)])
    assert sides(trade) == ([(iono, '3')], [(arven, '2')])


def test_borrowed_copies_never_count_for_either_side(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 1)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    assert handover(misty, loan).status_code == 200
    assert handover(ash, loan).status_code == 200
    # Ash's Borrowed Copy sits in his For trade Unsorted.
    ok(mark(ash, node(ash, 'Unsorted')['id']))
    assert detail(propose(ash, misty, give=[(iono, 1)]))[1] == {
        'code': 'NOT_TRADEABLE', 'edition_id': iono, 'available': '0', 'side': 'you_give'}
    assert detail(propose(misty, ash, get=[(iono, 1)]))[1] == {
        'code': 'NOT_TRADEABLE', 'edition_id': iono, 'available': '0', 'side': 'you_get'}


def test_a_loan_promised_copy_is_not_tradeable_and_a_lend_offer_never_takes_a_trade_promised_one(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    ok(offer(misty, ash, [(binder, iono, 1)]), 201)
    assert detail(propose(misty, ash, give=[(iono, 3)]))[1] == {
        'code': 'NOT_TRADEABLE', 'edition_id': iono, 'available': '2', 'side': 'you_give'}
    trade = proposed(misty, ash, give=[(iono, 2)])
    assert reserved(misty, iono) == (3, 2)
    assert detail(offer(misty, ash, [(binder, iono, 1)])) == (
        409, {'code': 'NOT_ENOUGH_COPIES', 'edition_id': iono, 'available': '0'})
    ok(trade_step(misty, trade, 'withdraw'))
    ok(offer(misty, ash, [(binder, iono, 1)]), 201)


def test_picks_take_the_largest_for_trade_holding_first_then_the_name_and_leave_covered_copies(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    a, b, c = place(misty, 'binder a'), place(misty, 'Binder B'), place(misty, 'Binder C')
    hold(misty, a, iono, 2)
    hold(misty, b, iono, 2)
    hold(misty, c, iono, 3)
    hold(misty, node(misty, 'Unsorted')['id'], iono, 5)
    for binder in (a, b, c):
        ok(mark(misty, binder))
    # The largest For trade Holding first.
    first = proposed(misty, ash, give=[(iono, 3)])
    assert trade_picks(first['id']) == [('proposer', misty, c, 3)]
    # Binder C's copies are covered; binder a and Binder B tie at two, so the name decides, case ignored.
    second = proposed(misty, ash, give=[(iono, 3)])
    assert trade_picks(second['id']) == sorted([('proposer', misty, a, 2), ('proposer', misty, b, 1)])
    # Unsorted isn't For trade: its copies are never listed or picked, so one copy is left on the Trade List.
    assert detail(propose(misty, ash, give=[(iono, 2)]))[1]['available'] == '1'
    third = proposed(misty, ash, give=[(iono, 1)])
    assert trade_picks(third['id']) == [('proposer', misty, b, 1)]


def test_a_retry_with_the_same_key_answers_the_same_trade_and_counts_once(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    key = uuid4()
    first = propose(misty, ash, give=[(iono, 1)], key=key)
    again = propose(misty, ash, give=[(iono, 1)], key=key)
    assert (first.status_code, again.status_code) == (201, 201) and first.json() == again.json()
    assert commands(misty) == 1 and reserved(misty, iono) == (1, 1)
    assert detail(propose(misty, ash, give=[(iono, 2)], key=key)) == (409, {'code': 'IDEMPOTENCY_KEY_REUSED'})
    trade = first.json()
    step_key = uuid4()
    withdrawn = trade_step(misty, trade, 'withdraw', key=step_key)
    assert withdrawn.status_code == 200
    assert trade_step(misty, trade, 'withdraw', key=step_key).json() == withdrawn.json()
    assert commands(misty) == 2
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM inbox_update WHERE trade_id=%s',
                            (trade['id'],)).fetchone()['n'] == 1


def test_trade_steps_have_an_hourly_limit_of_their_own(store):
    ids, ash, misty, binder, box = trading()
    with connect() as conn:
        conn.execute("""INSERT INTO handle_lookup_event(user_id, kind, created_at)
          SELECT %s, 'trade_command', now() - interval '30 minutes' FROM generate_series(1, 119)""", (misty,))
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    # The 121st Trade command this hour is refused, and leaves the proposal open.
    assert detail(trade_step(misty, trade, 'withdraw')) == (
        429, {'code': 'TOO_MANY_CHANGES', 'retry_after_minutes': 30})
    assert ok(read(misty, trade))['state'] == 'proposed'
    # Loan commands keep their own count.
    assert offer(misty, ash, [(binder, ids['PAL 185'], 1)]).status_code == 201


def test_the_friend_sees_the_proposal_from_their_side_and_a_stranger_gets_not_found(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    (gary, _) = collector('Gary O.')
    older = proposed(misty, ash, give=[(iono, 1)])
    trade = proposed(misty, ash, give=[(iono, 2)], get=[(arven, 1)])
    seen = ok(read(ash, trade))
    assert (seen['role'], seen['state'], seen['waiting'], seen['needs_you'], seen['section'], seen['actions']) == (
        'recipient', 'proposed', 'answer', True, 'needs_you', ['accept', 'decline', 'counter'])
    assert sides(seen) == ([(arven, '1')], [(iono, '2')])
    assert seen['other'] == {'collector_id': misty, 'display_name': 'Misty W.', 'handle': handle_of(misty),
                             'trader_id': trader_of(misty), 'friend': True, 'available': True,
                             'open_to_cash_offers': False, 'completed_trades': 0}
    listed = ok(call('GET', '/api/social/trades', ash))
    assert [item['id'] for item in listed['trades']] == [trade['id'], older['id']] and listed['needs_you'] == 2
    assert ok(call('GET', '/api/social/trades', misty))['needs_you'] == 0
    # A withdrawn proposal goes to history, after the open ones.
    ok(trade_step(misty, older, 'withdraw'))
    assert [(item['id'], item['section']) for item in ok(call('GET', '/api/social/trades', ash))['trades']] == [
        (trade['id'], 'needs_you'), (older['id'], 'history')]
    # A stranger and an unknown id get the same bytes, for a read and for a step.
    assert read(gary, trade).content == read(misty, {'id': str(uuid4())}).content == UNKNOWN
    assert trade_step(gary, trade, 'withdraw').content == trade_step(misty, {'id': str(uuid4()), 'revision': 1},
                                                                     'withdraw').content == UNKNOWN
    # The same for each answer and a cancel (#271).
    for action in ('decline', 'cancel'):
        assert trade_step(gary, trade, action).content == UNKNOWN
        assert trade_step(ash, {'id': str(uuid4()), 'revision': 1}, action).content == UNKNOWN
    assert (accept_trade(gary, trade).content
            == accept_trade(ash, {'id': str(uuid4()), 'revision': 1}).content == UNKNOWN)
    assert accept_trade(gary, trade).status_code == 404
    assert ok(read(ash, trade))['state'] == 'proposed' and commands(gary) == 0
    assert read(gary, trade).status_code == 404
    assert ok(call('GET', '/api/social/trades', gary)) == {'trades': [], 'needs_you': 0}


def test_withdraw_is_the_proposers_on_the_revision_they_read_and_tells_the_recipient(store):
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    assert detail(trade_step(ash, trade, 'withdraw')) == (409, {'code': 'STEP_NOT_ALLOWED'})
    assert detail(trade_step(misty, trade, 'withdraw', revision=trade['revision'] + 1)) == (
        409, {'code': 'TRADE_CHANGED'})
    ok(trade_step(misty, trade, 'withdraw'))
    with connect() as conn:
        updates = conn.execute('SELECT recipient_id, kind, loan_id, trade_id, other_name FROM inbox_update '
                               'WHERE trade_id=%s', (trade['id'],)).fetchall()
    assert [(row['recipient_id'], row['kind'], row['loan_id'], str(row['trade_id']), row['other_name'])
            for row in updates] == [(ash, 'cancelled', None, trade['id'], 'Misty W.')]
    # The inbox lists Trade updates from Trading #273; until then Ash's inbox is unchanged.
    assert ok(call('GET', '/api/social/inbox', ash))['updates'] == []
    # A closed Trade has no step left, on the revision it now has too.
    closed = ok(read(misty, trade))
    assert detail(trade_step(misty, closed, 'withdraw')) == (409, {'code': 'STEP_NOT_ALLOWED'})


@pytest.mark.parametrize('state, reader, swaps, gives, expected', [
    ('proposed', 'proposer', (None, None), True, ['use_suggested_picks', 'withdraw']),
    ('proposed', 'proposer', (None, None), False, ['withdraw']),
    ('proposed', 'recipient', (None, None), True, ['accept', 'decline', 'counter']),
    ('proposed', 'recipient', (None, None), False, ['accept', 'decline', 'counter']),
    ('accepted', 'proposer', (None, None), True, ['confirm_swap', 'use_suggested_picks', 'cancel']),
    ('accepted', 'proposer', (None, None), False, ['confirm_swap', 'cancel']),
    ('accepted', 'recipient', (None, None), True, ['confirm_swap', 'use_suggested_picks', 'cancel']),
    ('accepted', 'recipient', (None, None), False, ['confirm_swap', 'cancel']),
    # Once a side confirmed the swap (Trading #272) it has no step left, and the other side may only confirm theirs
    # (and fix its picks first): nobody cancels.
    ('accepted', 'proposer', ('now', None), True, []),
    ('accepted', 'proposer', (None, 'now'), True, ['confirm_swap', 'use_suggested_picks']),
    ('accepted', 'proposer', (None, 'now'), False, ['confirm_swap']),
    ('accepted', 'recipient', ('now', None), True, ['confirm_swap', 'use_suggested_picks']),
    ('accepted', 'recipient', ('now', None), False, ['confirm_swap']),
    ('accepted', 'recipient', (None, 'now'), True, []),
    ('closed', 'proposer', (None, None), True, []),
    ('closed', 'recipient', (None, None), False, []),
    ('closed', 'recipient', ('now', 'now'), True, []),
])
def test_allowed_lists_each_sides_steps_row_by_row(state, reader, swaps, gives, expected):
    row = {'state': state, 'proposer_id': 'misty', 'recipient_id': 'ash', 'proposer_swap_at': swaps[0],
           'recipient_swap_at': swaps[1]}
    assert trades.allowed('misty' if reader == 'proposer' else 'ash', row, gives) == expected


@pytest.mark.parametrize('state, reader, swaps, waiting, section', [
    ('proposed', 'recipient', (None, None), 'answer', 'needs_you'),
    ('proposed', 'proposer', (None, None), None, 'pending'),
    ('accepted', 'proposer', (None, None), None, 'to_swap'),
    ('accepted', 'proposer', (None, 'now'), 'confirm_swap', 'needs_you'),
    ('accepted', 'proposer', ('now', None), None, 'pending'),
    ('closed', 'recipient', (None, None), None, 'history'),
])
def test_waiting_and_section_follow_the_row(state, reader, swaps, waiting, section):
    row = {'state': state, 'proposer_id': 'misty', 'recipient_id': 'ash', 'proposer_swap_at': swaps[0],
           'recipient_swap_at': swaps[1]}
    user = 'misty' if reader == 'proposer' else 'ash'
    assert (trades.waiting_trade_step(user, row), trades.section(user, row)) == (waiting, section)


def test_a_deleted_counterparty_keeps_their_name_with_no_id_or_handle(store):
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    with connect() as conn:
        conn.execute('DELETE FROM inventory_owner WHERE user_id=%s', (ash,))
    assert ok(read(misty, trade))['other'] == {'collector_id': None, 'display_name': 'Ash K.', 'handle': None,
                                               'trader_id': None, 'friend': False, 'available': False,
                                               'open_to_cash_offers': False, 'completed_trades': None}
    # Withdrawing still releases the copies; nobody is left to tell.
    ok(trade_step(misty, trade, 'withdraw'))
    assert reserved(misty, ids['PAL 185']) == (0, 0)
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM inbox_update WHERE trade_id=%s',
                            (trade['id'],)).fetchone()['n'] == 0


def test_the_other_sides_open_to_cash_offers_is_read_from_their_profile(store):
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    trade_settings(misty, True)
    assert ok(read(ash, trade))['other']['open_to_cash_offers'] is True
    assert ok(read(misty, trade))['other']['open_to_cash_offers'] is False


def test_cash_is_an_amount_and_a_payer_or_nothing_and_is_refused_after_the_card_rules(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    bad_cash = {'cents': '0', 'payer': 'you'}
    assert detail(propose(misty, ash, cash=bad_cash))[1]['code'] == 'TRADE_HAS_NO_CARDS'
    many = [(str(uuid4()), 1) for _ in range(51)]
    assert detail(propose(misty, ash, give=many, cash=bad_cash))[1]['code'] == 'TOO_MANY_LINES'
    for cents in ('0', '01', '-1', '1.5', ' 1', '1 ', '100000000', '', 'abc', '\uff11'):
        assert detail(propose(misty, ash, give=[(iono, 1)], cash={'cents': cents, 'payer': 'you'})) == (
            422, {'code': 'INVALID_CASH'}), cents
    for cash in ({'cents': '500'}, {'cents': 500, 'payer': 'you'}, {'cents': '500', 'payer': 'proposer'}):
        response = propose(misty, ash, give=[(iono, 1)], cash=cash)
        assert response.status_code == 422 and 'code' not in response.text, cash
    for cents in ('1', '99999999'):
        assert detail(propose(misty, ash, get=[(arven, 9999)], cash={'cents': cents, 'payer': 'them'}))[1][
            'code'] == 'NOT_TRADEABLE'
    assert commands(misty) == 0
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM trade WHERE proposer_id=%s', (misty,)).fetchone()['n'] == 0


def test_a_side_giving_only_cash_needs_the_recipient_open_to_cash_offers_in_both_directions(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade_settings(misty, True)           # the sender's own setting doesn't matter
    buying = propose(misty, ash, get=[(arven, 1)], cash={'cents': '1500', 'payer': 'you'})
    assert detail(buying) == (409, {'code': 'CASH_ONLY_NOT_OPEN', 'side': 'you_give'})
    selling = propose(misty, ash, give=[(iono, 1)], cash={'cents': '1500', 'payer': 'them'})
    assert detail(selling) == (409, {'code': 'CASH_ONLY_NOT_OPEN', 'side': 'you_get'})
    assert reserved(misty, iono) == (0, 0) and commands(misty) == 0
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM trade WHERE proposer_id=%s', (misty,)).fetchone()['n'] == 0
    trade_settings(ash, True)
    bought = proposed(misty, ash, get=[(arven, 1)], cash={'cents': '1500', 'payer': 'you'})
    sold = proposed(misty, ash, give=[(iono, 1)], cash={'cents': '1500', 'payer': 'them'})
    assert bought['cash'] == {'cents': '1500', 'payer': 'you'} and sold['cash'] == {'cents': '1500', 'payer': 'them'}
    assert ok(read(ash, bought))['cash'] == {'cents': '1500', 'payer': 'them'}
    assert ok(read(ash, sold))['cash'] == {'cents': '1500', 'payer': 'you'}
    assert (row_of(bought)['cash_cents'], row_of(bought)['cash_payer']) == (1500, 'proposer')
    assert (row_of(sold)['cash_cents'], row_of(sold)['cash_payer']) == (1500, 'recipient')


def test_cash_alongside_cards_and_a_gift_plus_cash_need_no_open_to_cash_offers(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    shapes = [
        (dict(give=[(iono, 1)], get=[(arven, 1)]), {'cents': '800', 'payer': 'you'}),
        (dict(give=[(iono, 1)], get=[(arven, 1)]), {'cents': '800', 'payer': 'them'}),
        (dict(give=[(iono, 1)]), {'cents': '300', 'payer': 'you'}),
        (dict(get=[(arven, 1)]), {'cents': '300', 'payer': 'them'}),
    ]
    for cards, cash in shapes:
        assert proposed(misty, ash, cash=cash, **cards)['cash'] == cash


def test_a_stranger_sent_only_cash_by_user_id_is_refused_as_unavailable(store):
    ids, ash, misty, binder, box = trading()
    (gary, _) = collector('Gary O.')
    trade_settings(gary, True)
    response = propose(misty, gary, get=[(ids['SVI 166'], 1)], cash={'cents': '500', 'payer': 'you'})
    assert detail(response) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})


def test_cash_is_kept_through_withdraw_and_confirm_swap_moves_only_the_cards(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    withdrawn = proposed(misty, ash, give=[(iono, 1)], cash={'cents': '700', 'payer': 'you'})
    closed = ok(trade_step(misty, withdrawn, 'withdraw'))
    assert closed['state'] == 'closed' and closed['cash'] == {'cents': '700', 'payer': 'you'}
    assert ok(read(ash, withdrawn))['cash'] == {'cents': '700', 'payer': 'them'}

    for step, actor in (('decline', ash), ('cancel', misty)):
        closed = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)], cash={'cents': '900', 'payer': 'them'})
        if step == 'cancel':
            closed = ok(accept_trade(ash, closed))
        ok(trade_step(actor, closed, step))
        assert (row_of(closed)['state'], row_of(closed)['cash_cents'], row_of(closed)['cash_payer']) == (
            'closed', 900, 'recipient'), step

    trade = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)], cash={'cents': '500', 'payer': 'you'})
    ok(accept_trade(ash, trade))
    for user in (misty, ash):
        revision = ok(read(user, trade))['revision']
        ok(call('POST', f"/api/trades/{trade['id']}/confirm-swap", user,
                {'revision': revision, 'idempotency_key': str(uuid4()), 'destination_id': None}))
    final = ok(read(misty, trade))
    assert (final['state'], final['closed_reason']) == ('closed', 'swapped')
    assert final['cash'] == {'cents': '500', 'payer': 'you'}
    assert own_cards(misty) == {iono: ('2', {'Trade Binder': '2'})}
    assert own_cards(ash) == {arven: ('1', {'Box': '1'})}
    with connect() as conn:
        tables = [row['table_name'] for row in conn.execute(
            "SELECT table_name FROM information_schema.columns WHERE table_schema='public' "
            "AND column_name ILIKE '%cash%'")]
    assert set(tables) <= {'trade', 'collector_profile'}


def test_open_to_cash_offers_is_off_by_default_and_set_only_by_its_own_route(store):
    (gary, _) = collector('Gary O.')
    assert trade_settings(gary) is False
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    before = revision_of(misty)
    assert trade_settings(misty, True) is True and trade_settings(misty, True) is True
    assert trade_settings(misty) is True and revision_of(misty) == before
    assert ok(read(ash, trade))['other']['open_to_cash_offers'] is True
    assert trade_settings(ash) is False
    assert trade_settings(misty, False) is False
    assert ok(read(ash, trade))['other']['open_to_cash_offers'] is False
    assert call('PUT', '/api/social/trade-settings', misty, {'open_to_cash_offers': 'maybe'}).status_code == 422


def test_no_location_or_deck_name_or_id_reaches_either_side(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    shelf = place(misty, 'Secret Shelf')
    hold(misty, shelf, iono, 1)
    ok(mark(misty, shelf))
    hide(misty, shelf)
    trade = proposed(misty, ash, give=[(iono, 4)], get=[(arven, 1)])
    secrets = {binder, shelf, box, 'Trade Binder', 'Secret Shelf', 'Box', 'Unsorted'}
    for user in (misty, ash):
        for body in (read(user, trade).text, call('GET', '/api/social/trades', user).text):
            assert not any(secret in body for secret in secrets), (user, body)
    # Once accepted both sides have picks (#271); neither the step's answer nor either side's reads name one.
    answered = accept_trade(ash, ok(read(ash, trade)))
    assert answered.status_code == 200 and len({row[0] for row in trade_picks(trade['id'])}) == 2
    cancelled = trade_step(misty, ok(read(misty, trade)), 'cancel')
    for body in (answered.text, cancelled.text):
        assert not any(secret in body for secret in secrets), body
    for user in (misty, ash):
        for body in (read(user, trade).text, call('GET', '/api/social/trades', user).text):
            assert not any(secret in body for secret in secrets), (user, body)


def _waiting_on_a_lock(watch, submitted):
    """Waits until a session waits on a lock, a row's or the Trade command lock, while every submitted call still runs.
    """
    deadline = time.monotonic() + 10
    while not watch.execute("""SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND wait_event IN ('advisory','transactionid','tuple')""").fetchone():
        assert time.monotonic() < deadline and not any(call_.done() for call_ in submitted), 'no step waited on a lock'
        time.sleep(0.01)


def _without_command_lock(conn, user_id, key, payload, kind):
    """``owners.begin_owner_command`` without the caller's command lock: the owner row is the only lock left between
    two of one collector's Trade steps."""
    owners.ensure_owner(conn, user_id)
    digest, stored = owners.replay(conn, user_id, key, payload)
    if stored is None:
        owners.count_owner_command(conn, user_id, f'{kind}_command')
    return digest, stored


@pytest.mark.parametrize('command_lock', [True, False])
def test_two_sends_of_the_same_copies_run_one_after_the_other(store, monkeypatch, command_lock):
    if not command_lock:
        monkeypatch.setattr(trade_inventory, 'begin_owner_command', _without_command_lock)
        # The send's new-conversation advisory lock would also serialise the two; only the owner row is left to test.
        monkeypatch.setattr(trade_inventory, 'new_conversation_lock', lambda conn, user_id: None)
        # ...and open_conversation's check of it.
        monkeypatch.setattr(conversations, 'new_conversation_lock_held', lambda conn, user_id: True)
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    (brock, _) = collector('Brock S.')
    befriend(misty, brock)
    held = _sleeping('trade_pick', 'INSERT', f"NEW.owner_id = '{misty}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            first = executor.submit(propose, misty, ash, [(iono, 3)])
            _asleep(watch, 1, [first])
            second = executor.submit(propose, misty, brock, [(iono, 3)])
            (_waiting_on_a_lock if command_lock else _waiting_on_a_row)(watch, [first, second])
            first, second = first.result(), second.result()
    finally:
        held()
    assert first.status_code == 201, first.text
    assert detail(second) == (409, {'code': 'NOT_TRADEABLE', 'edition_id': iono, 'available': '0', 'side': 'you_give'})
    assert reserved(misty, iono) == (3, 3)


def test_a_lend_offer_waits_for_a_send_of_the_same_copies_and_then_finds_none_left(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    held = _sleeping('trade_pick', 'INSERT', f"NEW.owner_id = '{misty}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            sending = executor.submit(propose, misty, ash, [(iono, 3)])
            _asleep(watch, 1, [sending])
            offering = executor.submit(offer, misty, ash, [(binder, iono, 1)])
            # The Lend Offer's command lock is the Loans'; it waits on Misty's owner row.
            _waiting_on_a_row(watch, [sending, offering])
            sending, offering = sending.result(), offering.result()
    finally:
        held()
    assert sending.status_code == 201, sending.text
    assert detail(offering) == (409, {'code': 'NOT_ENOUGH_COPIES', 'edition_id': iono, 'available': '0'})
    assert reserved(misty, iono) == (3, 3)


def test_a_send_waits_for_a_loan_accept_of_the_same_copies_and_then_finds_none_left(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    loan = view(misty, sent(ash, misty, [(iono, 3)]))
    held, hold_until = _hold_pick_insert(misty)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            accepted = executor.submit(accept, misty, loan, [(iono, 3)])
            hold_until(watch, accepted)
            sending = executor.submit(propose, misty, ash, [(iono, 1)])
            _waiting_on_a_row(watch, [accepted, sending])
            accepted, sending = accepted.result(), sending.result()
    finally:
        held()
    assert accepted.status_code == 200, accepted.text
    assert detail(sending) == (409, {'code': 'NOT_TRADEABLE', 'edition_id': iono, 'available': '0', 'side': 'you_give'})
    assert reserved(misty, iono) == (3, 0)
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM trade WHERE proposer_id=%s', (misty,)).fetchone()['n'] == 0


# Accept, decline and cancel (Trading #271).


def test_accept_reserves_the_recipients_copies_at_once_and_a_cancel_releases_both_sides(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade = proposed(misty, ash, give=[(iono, 2)], get=[(arven, 1)])
    before = revision_of(misty), revision_of(ash)
    accepted = ok(accept_trade(ash, ok(read(ash, trade))))
    assert (accepted['state'], accepted['role'], accepted['section'], accepted['waiting'], accepted['needs_you'],
            accepted['actions'], accepted['revision']) == (
        'accepted', 'recipient', 'to_swap', None, False, ['confirm_swap', 'use_suggested_picks', 'cancel'],
        trade['revision'] + 1)
    assert sides(accepted) == ([(arven, '1')], [(iono, '2')])
    assert row_of(trade)['accepted_at'] is not None
    # Ash's copy is promised at once, from his For trade Box; Misty's stay promised from her send.
    assert trade_picks(trade['id']) == sorted([('proposer', misty, binder, 2), ('recipient', ash, box, 1)])
    assert reserved(misty, iono) == (2, 2) and reserved(ash, arven) == (1, 1)
    # It leaves both reads of Ash's Trade List and stops being lendable.
    assert own_cards(ash) == {arven: ('1', {'Box': '1'})}
    assert friend_cards(misty, handle_of(ash)) == {arven: '1'}
    assert copies(misty, [ash], [arven]) == {(ash, arven): (1, 0)}
    # Only the recipient's revision moved, once; Misty hears that Ash accepted.
    assert (revision_of(misty), revision_of(ash)) == (before[0], before[1] + 1)
    assert updates(trade) == [(misty, 'accepted', 'Ash K.')]
    seen = ok(read(misty, trade))
    assert (seen['state'], seen['section'], seen['actions'], seen['needs_you']) == (
        'accepted', 'to_swap', ['confirm_swap', 'use_suggested_picks', 'cancel'], False)
    # Either side may cancel while nobody has confirmed: Misty does, and both sides' copies come back at once.
    cancelled = ok(trade_step(misty, seen, 'cancel'))
    assert (cancelled['state'], cancelled['closed_reason'], cancelled['closed_by'], cancelled['section'],
            cancelled['actions']) == ('closed', 'cancelled', 'you', 'history', [])
    assert trade_picks(trade['id']) == [] and reserved(misty, iono) == (0, 0) and reserved(ash, arven) == (0, 0)
    assert own_cards(misty) == {iono: ('3', {'Trade Binder': '3'})} and own_cards(ash) == {arven: ('2', {'Box': '2'})}
    assert friend_cards(ash, handle_of(misty)) == {iono: '3'} and friend_cards(misty, handle_of(ash)) == {arven: '2'}
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1] + 2)
    # Ash is told it was cancelled, never why.
    assert updates(trade) == [(misty, 'accepted', 'Ash K.'), (ash, 'cancelled', 'Misty W.')]
    theirs = ok(read(ash, trade))
    assert (theirs['closed_reason'], theirs['closed_by'], theirs['actions']) == ('cancelled', 'them', [])


def test_the_recipient_cancels_too_and_a_side_that_gives_nothing_keeps_its_revision(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    # A gift to Ash: he gives nothing, so his accept has no cap and no pick and moves only the Trade.
    gift = proposed(misty, ash, give=[(iono, 1)])
    before = revision_of(misty), revision_of(ash)
    accepted = ok(accept_trade(ash, gift))
    assert (accepted['state'], accepted['actions']) == ('accepted', ['confirm_swap', 'cancel'])
    assert trade_picks(gift['id']) == [('proposer', misty, binder, 1)]
    assert (revision_of(misty), revision_of(ash)) == before
    cancelled = ok(trade_step(ash, accepted, 'cancel'))
    assert (cancelled['closed_reason'], cancelled['closed_by']) == ('cancelled', 'you')
    assert reserved(misty, iono) == (0, 0) and own_cards(misty) == {iono: ('3', {'Trade Binder': '3'})}
    # Cancelling released only Misty's copies, so only her revision moved; she hears it was cancelled.
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1])
    assert updates(gift) == [(misty, 'accepted', 'Ash K.'), (misty, 'cancelled', 'Ash K.')]
    # Asking Ash for his cards: his accept reserves them and moves only his revision; a decline of such an ask
    # releases nothing of Misty's, so it moves no revision.
    asked = proposed(misty, ash, get=[(arven, 2)])
    accepted = ok(accept_trade(ash, asked))
    assert trade_picks(asked['id']) == [('recipient', ash, box, 2)] and reserved(ash, arven) == (2, 2)
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1] + 1)
    ok(trade_step(ash, accepted, 'cancel'))
    assert reserved(ash, arven) == (0, 0) and (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1] + 2)
    again = proposed(misty, ash, get=[(arven, 1)])
    ok(trade_step(ash, again, 'decline'))
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1] + 2)


def test_decline_releases_the_proposers_copies_and_tells_them(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade = proposed(misty, ash, give=[(iono, 2)], get=[(arven, 1)])
    before = revision_of(misty), revision_of(ash)
    declined = ok(trade_step(ash, ok(read(ash, trade)), 'decline'))
    assert (declined['state'], declined['closed_reason'], declined['closed_by'], declined['section'],
            declined['actions'], declined['revision']) == ('closed', 'declined', 'you', 'history', [],
                                                           trade['revision'] + 1)
    assert trade_picks(trade['id']) == [] and reserved(misty, iono) == (0, 0) and reserved(ash, arven) == (0, 0)
    # Misty's copies are back on both reads of her Trade List; Ash's never left his.
    assert own_cards(misty) == {iono: ('3', {'Trade Binder': '3'})}
    assert friend_cards(ash, handle_of(misty)) == {iono: '3'}
    assert own_cards(ash) == {arven: ('2', {'Box': '2'})}
    # Only the proposer's revision moves, for the copies released; she hears it was declined.
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1])
    assert updates(trade) == [(misty, 'declined', 'Ash K.')]
    theirs = ok(read(misty, trade))
    assert (theirs['closed_reason'], theirs['closed_by'], theirs['section'], theirs['actions']) == (
        'declined', 'them', 'history', [])
    # Today's inbox view is unchanged until Trading #273 lists Trade updates.
    assert ok(call('GET', '/api/social/inbox', misty))['updates'] == []


def test_every_closed_reason_so_far_reads_from_both_sides(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    withdrawn = proposed(misty, ash, give=[(iono, 1)])
    declined = proposed(misty, ash, give=[(iono, 1)])
    cancelled = proposed(misty, ash, give=[(iono, 1)])
    ok(trade_step(misty, withdrawn, 'withdraw'))
    ok(trade_step(ash, declined, 'decline'))
    ok(trade_step(ash, ok(accept_trade(ash, cancelled)), 'cancel'))
    expected = {withdrawn['id']: ('withdrawn', misty), declined['id']: ('declined', ash),
                cancelled['id']: ('cancelled', ash)}
    for user in (misty, ash):
        listed = ok(call('GET', '/api/social/trades', user))
        assert listed['needs_you'] == 0
        found = {item['id']: (item['state'], item['closed_reason'], item['closed_by'], item['section'], item['actions'])
                 for item in listed['trades']}
        assert found == {trade_id: ('closed', reason, 'you' if by == user else 'them', 'history', [])
                         for trade_id, (reason, by) in expected.items()}
    assert reserved(misty, iono) == (0, 0) and trade_picks(cancelled['id']) == []


def test_only_the_recipient_answers_and_only_an_accepted_trade_nobody_confirmed_is_cancelled(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    refused = (409, {'code': 'STEP_NOT_ALLOWED'})
    # The proposer can't answer her own proposal, and nobody cancels a proposal: it is withdrawn or declined.
    assert detail(accept_trade(misty, trade)) == refused
    assert detail(trade_step(misty, trade, 'decline')) == refused
    assert detail(trade_step(misty, trade, 'cancel')) == refused
    assert detail(trade_step(ash, trade, 'cancel')) == refused
    # A stale revision changes nothing, for either answer.
    assert detail(accept_trade(ash, trade, revision=trade['revision'] + 1)) == (409, {'code': 'TRADE_CHANGED'})
    assert detail(trade_step(ash, trade, 'decline', revision=trade['revision'] + 1)) == (409, {'code': 'TRADE_CHANGED'})
    assert ok(read(ash, trade))['revision'] == trade['revision'] and row_of(trade)['state'] == 'proposed'
    assert trade_picks(trade['id']) == [('proposer', misty, binder, 1)] and updates(trade) == []
    # Refused steps roll back with their count.
    assert commands(ash) == 0
    accepted = ok(accept_trade(ash, trade))
    # An accepted Trade is answered: no second accept, no decline, no withdraw.
    for user, step_ in ((ash, 'decline'), (misty, 'withdraw')):
        assert detail(trade_step(user, accepted, step_)) == refused
    assert detail(accept_trade(ash, accepted)) == refused
    # Once either side has confirmed the swap nobody cancels (set here directly; test_trade_swap confirms through
    # the API): the side that confirmed has no step left, and the other may only confirm theirs.
    for confirmed_column, confirmer in (('proposer_swap_at', misty), ('recipient_swap_at', ash)):
        with connect() as conn:
            conn.execute(f'UPDATE trade SET {confirmed_column} = now() WHERE id=%s', (trade['id'],))
        for user in (misty, ash):
            seen = ok(read(user, trade))
            assert seen['actions'] == ([] if user == confirmer else ['confirm_swap', 'use_suggested_picks'])
            assert detail(trade_step(user, seen, 'cancel')) == refused
        with connect() as conn:
            conn.execute(f'UPDATE trade SET {confirmed_column} = NULL WHERE id=%s', (trade['id'],))
    closed = ok(trade_step(ash, ok(read(ash, trade)), 'cancel'))
    # A closed Trade has no step left.
    for user, step_ in ((misty, 'cancel'), (ash, 'cancel'), (ash, 'decline'), (misty, 'withdraw')):
        assert detail(trade_step(user, ok(read(user, trade)), step_)) == refused
    assert detail(accept_trade(ash, closed)) == refused


def test_accept_is_refused_across_a_block_and_changes_nothing(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    before = revision_of(ash)
    # Unfriending or an API Block would close the pair's Trades first (#274), so both go by SQL to reach the check; the
    # pair's conversation keeps the reach rule true until the Block.
    with connect() as conn:
        conn.execute('DELETE FROM friendship WHERE user_low=%s AND user_high=%s', tuple(sorted([ash, misty])))
        conn.execute('INSERT INTO block (blocker_id, blocked_id) VALUES (%s, %s)', (misty, ash))
    assert detail(accept_trade(ash, trade)) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    assert row_of(trade)['state'] == 'proposed' and trade_picks(trade['id']) == [('proposer', misty, binder, 1)]
    assert reserved(ash, arven) == (0, 0) and revision_of(ash) == before and updates(trade) == []
    assert commands(ash) == 0
    # Declining needs no friendship check.
    assert ok(trade_step(ash, trade, 'decline'))['closed_reason'] == 'declined'


def test_accept_is_refused_with_the_card_and_count_once_the_cards_left_the_for_trade_location(store):
    ids, ash, misty, binder, box = trading()
    iono, arven, boss = ids['PAL 185'], ids['SVI 166'], ids['PAL 172']
    hold(ash, box, boss, 1)
    trade = proposed(misty, ash, give=[(iono, 1)], get=[(boss, 1), (arven, 2)])
    unsorted = node(ash, 'Unsorted')['id']
    move_one(ash, box, arven, unsorted)
    before = revision_of(ash)
    # The lines Ash gives are capped in the order listed: Boss's Orders is fine, one Arven left the Box.
    assert detail(accept_trade(ash, trade)) == (
        409, {'code': 'NOT_TRADEABLE', 'edition_id': arven, 'available': '1', 'side': 'you_give'})
    assert row_of(trade)['state'] == 'proposed' and trade_picks(trade['id']) == [('proposer', misty, binder, 1)]
    assert reserved(ash, boss) == (0, 0) and revision_of(ash) == before and updates(trade) == []
    assert own_cards(ash) == {arven: ('1', {'Box': '1'}), boss: ('1', {'Box': '1'})}
    # Back in the Box, it can be accepted.
    move_one(ash, unsorted, arven, box)
    assert ok(accept_trade(ash, trade))['state'] == 'accepted'
    assert trade_picks(trade['id']) == sorted([('proposer', misty, binder, 1), ('recipient', ash, box, 2),
                                               ('recipient', ash, box, 1)])
    assert own_cards(ash) == {}


def test_a_retried_step_answers_the_same_trade_and_writes_once(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    key = uuid4()
    first = accept_trade(ash, trade, key=key)
    again = accept_trade(ash, trade, key=key)
    assert (first.status_code, again.status_code) == (200, 200) and first.json() == again.json()
    assert commands(ash) == 1 and reserved(ash, arven) == (1, 1) and len(trade_picks(trade['id'])) == 2
    assert updates(trade) == [(misty, 'accepted', 'Ash K.')] and row_of(trade)['revision'] == trade['revision'] + 1
    assert detail(accept_trade(ash, trade, key=key, revision=trade['revision'] + 1)) == (
        409, {'code': 'IDEMPOTENCY_KEY_REUSED'})
    cancel_key = uuid4()
    cancelled = trade_step(misty, first.json(), 'cancel', key=cancel_key)
    assert cancelled.status_code == 200
    assert trade_step(misty, first.json(), 'cancel', key=cancel_key).json() == cancelled.json()
    assert updates(trade) == [(misty, 'accepted', 'Ash K.'), (ash, 'cancelled', 'Misty W.')]
    decline_key = uuid4()
    other = proposed(misty, ash, give=[(iono, 1)])
    declined = trade_step(ash, other, 'decline', key=decline_key)
    assert declined.status_code == 200 and trade_step(ash, other, 'decline', key=decline_key).json() == declined.json()
    assert updates(other) == [(misty, 'declined', 'Ash K.')] and commands(ash) == 2


def test_an_accept_counts_toward_the_hourly_limit(store):
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    with connect() as conn:
        conn.execute("""INSERT INTO handle_lookup_event(user_id, kind, created_at)
          SELECT %s, 'trade_command', now() - interval '20 minutes' FROM generate_series(1, 120)""", (ash,))
    assert detail(accept_trade(ash, trade)) == (429, {'code': 'TOO_MANY_CHANGES', 'retry_after_minutes': 40})
    assert detail(trade_step(ash, trade, 'decline')) == (429, {'code': 'TOO_MANY_CHANGES', 'retry_after_minutes': 40})
    assert row_of(trade)['state'] == 'proposed'


@pytest.mark.parametrize('first', ['accept', 'withdraw'])
def test_an_accept_and_a_withdraw_of_one_proposal_run_one_after_the_other(store, first):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    # Each step takes its own collector's owner row, so they meet on the Trade row, which the first holds while it
    # sleeps writing a pick: the accept inserting Ash's, the withdraw deleting Misty's.
    held = (_sleeping('trade_pick', 'INSERT', f"NEW.owner_id = '{ash}'") if first == 'accept'
            else _sleeping('trade_pick', 'DELETE', f"OLD.owner_id = '{misty}'"))
    steps = {'accept': lambda: accept_trade(ash, trade), 'withdraw': lambda: trade_step(misty, trade, 'withdraw')}
    second = 'withdraw' if first == 'accept' else 'accept'
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            winner = executor.submit(steps[first])
            _asleep(watch, 1, [winner])
            loser = executor.submit(steps[second])
            _waiting_on_a_row(watch, [winner, loser])
            winner, loser = winner.result(), loser.result()
    finally:
        held()
    assert winner.status_code == 200, winner.text
    assert detail(loser) == (409, {'code': 'TRADE_CHANGED'})
    if first == 'accept':
        assert row_of(trade)['state'] == 'accepted'
        assert reserved(misty, iono) == (1, 1) and reserved(ash, arven) == (1, 1)
    else:
        assert (row_of(trade)['state'], row_of(trade)['closed_reason']) == ('closed', 'withdrawn')
        assert reserved(misty, iono) == (0, 0) and reserved(ash, arven) == (0, 0) and trade_picks(trade['id']) == []


@pytest.mark.parametrize('command_lock', [True, False])
def test_two_accepts_of_one_proposal_run_one_after_the_other(store, monkeypatch, command_lock):
    if not command_lock:
        monkeypatch.setattr(trades, 'begin_owner_command', _without_command_lock)
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 2)])
    held = _sleeping('trade_pick', 'INSERT', f"NEW.owner_id = '{ash}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            first = executor.submit(accept_trade, ash, trade)
            _asleep(watch, 1, [first])
            second = executor.submit(accept_trade, ash, trade)
            (_waiting_on_a_lock if command_lock else _waiting_on_a_row)(watch, [first, second])
            first, second = first.result(), second.result()
    finally:
        held()
    assert first.status_code == 200, first.text
    assert detail(second) == (409, {'code': 'TRADE_CHANGED'})
    assert reserved(ash, arven) == (2, 2) and trade_picks(trade['id']).count(('recipient', ash, box, 2)) == 1
    assert updates(trade) == [(misty, 'accepted', 'Ash K.')] and row_of(trade)['revision'] == trade['revision'] + 1


@pytest.mark.parametrize('first', ['trade', 'loan'])
def test_a_trade_accept_and_a_loan_accept_of_the_same_copies_run_one_after_the_other(store, first):
    ids, ash, misty, binder, box = trading()
    arven = ids['SVI 166']
    trade = proposed(misty, ash, get=[(arven, 2)])
    loan = view(ash, sent(misty, ash, [(arven, 2)]))
    if first == 'trade':
        held = _sleeping('trade_pick', 'INSERT', f"NEW.owner_id = '{ash}'")
        reached = lambda watch, step_: _asleep(watch, 1, [step_])  # noqa: E731
    else:
        held, reached = _hold_pick_insert(ash)
    steps = {'trade': lambda: accept_trade(ash, trade), 'loan': lambda: accept(ash, loan, [(arven, 2)])}
    second = 'loan' if first == 'trade' else 'trade'
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            winner = executor.submit(steps[first])
            reached(watch, winner)
            # The two steps have command locks of their own: the second waits on Ash's owner row.
            loser = executor.submit(steps[second])
            _waiting_on_a_row(watch, [winner, loser])
            winner, loser = winner.result(), loser.result()
    finally:
        held()
    assert winner.status_code == 200, winner.text
    if first == 'trade':
        assert detail(loser) == (409, {'code': 'NOT_ENOUGH_COPIES', 'edition_id': arven, 'available': '0'})
        assert reserved(ash, arven) == (2, 2)
    else:
        assert detail(loser) == (409, {'code': 'NOT_TRADEABLE', 'edition_id': arven, 'available': '0',
                                       'side': 'you_give'})
        assert reserved(ash, arven) == (2, 0) and row_of(trade)['state'] == 'proposed'


def test_a_counter_closes_the_proposal_and_sends_the_reply_with_the_reserved_side_swapped(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(misty, ash, give=[(iono, 2)], get=[(arven, 1)])
    before = revision_of(misty), revision_of(ash)
    new = countered(ash, original, give=[(arven, 2)], get=[(iono, 1)], cash={'cents': '500', 'payer': 'them'})
    assert (new['role'], new['state'], new['countered_from'], new['waiting'], new['section']) == (
        'proposer', 'proposed', original['id'], None, 'pending')
    assert sides(new) == ([(arven, '2')], [(iono, '1')])
    assert new['cash'] == {'cents': '500', 'payer': 'them'}
    assert new['actions'] == ['use_suggested_picks', 'withdraw'] and new['other']['display_name'] == 'Misty W.'
    old = row_of(original)
    assert (old['state'], old['closed_reason'], old['closed_by'], old['revision']) == (
        'closed', 'countered', ash, original['revision'] + 1)
    assert trade_picks(original['id']) == []
    theirs, mine = ok(read(misty, original)), ok(read(ash, original))
    assert sides(theirs) == ([(iono, '2')], [(arven, '1')])
    assert (theirs['closed_by'], theirs['actions'], mine['closed_by']) == ('them', [], 'you')
    row = row_of(new)
    assert (row['proposer_id'], row['recipient_id'], row['countered_from'], row['cash_cents'], row['cash_payer'],
            row['proposer_name'], row['recipient_name'], row['revision']) == (
        ash, misty, old['id'], 500, 'recipient', 'Ash K.', 'Misty W.', 1)
    assert trade_picks(new['id']) == [('proposer', ash, box, 2)]
    assert reserved(misty, iono) == (0, 0) and reserved(ash, arven) == (2, 2)
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1] + 1)
    assert updates(original) == [] and updates(new) == [] and commands(ash) == 1
    seen = ok(read(misty, new))
    assert (seen['role'], seen['waiting'], seen['needs_you'], seen['actions'], seen['cash']) == (
        'recipient', 'answer', True, ['accept', 'decline', 'counter'], {'cents': '500', 'payer': 'you'})
    waiting = inbox(misty)['trade_waiting']
    assert [(line['id'], line['countered_from']) for line in waiting] == [(new['id'], original['id'])]
    assert inbox(misty)['trade_updates'] == [] and inbox(ash)['trade_waiting'] == []
    # A Counter of a Counter works the same way.
    again = countered(misty, seen, give=[(iono, 1)], get=[(arven, 1)])
    assert again['countered_from'] == new['id']
    assert (row_of(new)['closed_reason'], row_of(new)['closed_by']) == ('countered', misty)
    assert reserved(ash, arven) == (0, 0) and reserved(misty, iono) == (1, 1)


def test_a_counter_keeping_every_card_the_sender_listed_exactly_succeeds(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(ash, misty, give=[(arven, 2)], get=[(iono, 1)])
    new = countered(misty, original, give=[(iono, 1)], get=[(arven, 2)])
    assert (row_of(original)['state'], row_of(original)['closed_reason']) == ('closed', 'countered')
    assert (row_of(new)['state'], str(row_of(new)['countered_from'])) == ('proposed', original['id'])
    assert reserved(ash, arven) == (0, 0) and reserved(misty, iono) == (1, 1)


def test_a_refused_counter_leaves_the_original_proposal_and_its_picks(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(ash, misty, give=[(arven, 2)], get=[(iono, 1)])
    before = revision_of(misty), revision_of(ash)
    assert detail(counter(misty, original, give=[(iono, 1)], get=[(arven, 3)])) == (
        409, {'code': 'NOT_TRADEABLE', 'edition_id': arven, 'available': '2', 'side': 'you_get'})
    old = row_of(original)
    assert (old['state'], old['revision']) == ('proposed', original['revision'])
    assert trade_picks(original['id']) == [('proposer', ash, box, 2)] and reserved(ash, arven) == (2, 2)
    assert counters_of(original) == [] and commands(misty) == 0
    assert (revision_of(misty), revision_of(ash)) == before


def test_a_counter_refuses_each_shape_rule_in_order_and_changes_nothing(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    many = [(str(uuid4()), 1) for _ in range(51)]
    cases = [
        (counter(ash, original, give=[(arven, 0)]), 422, 'INVALID_QUANTITY'),
        (counter(ash, original, give=[(arven, 10000)]), 422, 'INVALID_QUANTITY'),
        (counter(ash, original, give=[(arven, 1), (arven, 1)]), 422, 'DUPLICATE_EDITION'),
        (counter(ash, original, give=[(arven, 1)], get=[(arven, 1)]), 422, 'SAME_CARD_BOTH_SIDES'),
        (counter(ash, original, give=many), 422, 'TOO_MANY_LINES'),
        (counter(ash, original), 422, 'TRADE_HAS_NO_CARDS'),
        (counter(ash, original, give=[(arven, 1)], cash={'cents': '0', 'payer': 'you'}), 422, 'INVALID_CASH'),
    ]
    assert [(response.status_code, response.json()['detail']['code']) for response, _, _ in cases] == \
        [(status, code) for _, status, code in cases]
    assert detail(counter(ash, original, give=[(arven, 3)])) == (
        409, {'code': 'NOT_TRADEABLE', 'edition_id': arven, 'available': '2', 'side': 'you_give'})
    old = row_of(original)
    assert (old['state'], old['revision']) == ('proposed', original['revision'])
    assert trade_picks(original['id']) == [('proposer', misty, binder, 1)]
    assert counters_of(original) == [] and commands(ash) == 0


def test_cash_alongside_cards_and_a_gift_plus_cash_counter_with_no_open_to_cash_offers(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    assert trade_settings(misty) is False
    shapes = [
        dict(give=[(arven, 1)], get=[(iono, 1)], cash={'cents': '300', 'payer': 'you'}),
        dict(give=[(arven, 1)], get=[(iono, 1)], cash={'cents': '300', 'payer': 'them'}),
        dict(give=[(arven, 1)], cash={'cents': '300', 'payer': 'you'}),
        dict(get=[(iono, 1)], cash={'cents': '300', 'payer': 'them'}),
    ]
    for shape in shapes:
        original = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
        new = countered(ash, original, **shape)
        assert new['cash'] == shape['cash']
        ok(trade_step(ash, new, 'withdraw'))     # frees Ash's copy for the next shape


@pytest.mark.parametrize('original, reply', [
    ('misty_buys', 'ash_sells'), ('misty_buys', 'ash_buys'), ('misty_sells', 'ash_sells'), ('misty_sells', 'ash_buys')])
def test_a_counter_may_answer_a_cash_only_proposal_with_a_cash_only_side_whatever_its_recipients_setting(
        store, original, reply):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade_settings(ash, True)
    assert trade_settings(misty) is False
    first = {'misty_buys': dict(get=[(arven, 1)], cash={'cents': '1000', 'payer': 'you'}),
             'misty_sells': dict(give=[(iono, 1)], cash={'cents': '1000', 'payer': 'them'})}[original]
    answer = {'ash_sells': dict(give=[(arven, 1)], cash={'cents': '1500', 'payer': 'them'}),
              'ash_buys': dict(get=[(iono, 1)], cash={'cents': '500', 'payer': 'you'})}[reply]
    trade = proposed(misty, ash, **first)
    new = countered(ash, trade, **answer)
    assert new['cash'] == answer['cash'] and row_of(trade)['closed_reason'] == 'countered'


@pytest.mark.parametrize('original', ['no_cash', 'cash_beside_cards', 'gift_plus_cash'])
def test_a_counter_that_brings_a_cash_only_side_to_a_recipient_not_open_is_refused_and_leaves_the_original(
        store, original):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    first = {'no_cash': dict(give=[(iono, 1)], get=[(arven, 1)]),
             'cash_beside_cards': dict(give=[(iono, 1)], get=[(arven, 1)], cash={'cents': '300', 'payer': 'you'}),
             'gift_plus_cash': dict(give=[(iono, 1)], cash={'cents': '300', 'payer': 'you'})}[original]
    trade = proposed(misty, ash, **first)
    sells = dict(give=[(arven, 1)], cash={'cents': '1500', 'payer': 'them'})
    buys = dict(get=[(iono, 1)], cash={'cents': '500', 'payer': 'you'})
    assert detail(counter(ash, trade, **sells)) == (409, {'code': 'CASH_ONLY_NOT_OPEN', 'side': 'you_get'})
    assert detail(counter(ash, trade, **buys)) == (409, {'code': 'CASH_ONLY_NOT_OPEN', 'side': 'you_give'})
    assert (row_of(trade)['state'], row_of(trade)['revision']) == ('proposed', trade['revision'])
    assert trade_picks(trade['id']) == [('proposer', misty, binder, 1)] and commands(ash) == 0
    # The check reads the Counter recipient's setting now.
    trade_settings(misty, True)
    assert counter(ash, trade, **sells).status_code == 200


def test_a_counter_is_the_recipients_on_the_revision_they_read_and_only_while_proposed(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    (gary, _) = collector('Gary O.')
    original = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    asked = dict(get=[(iono, 1)])
    assert counter(gary, original, **asked).content == UNKNOWN
    assert counter(ash, {'id': str(uuid4()), 'revision': 1}, **asked).content == UNKNOWN
    assert commands(gary) == 0
    assert detail(counter(misty, original, give=[(iono, 1)])) == (409, {'code': 'STEP_NOT_ALLOWED'})
    assert detail(counter(ash, original, revision=original['revision'] + 1, **asked)) == (
        409, {'code': 'TRADE_CHANGED'})
    taken = ok(accept_trade(ash, proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])))
    assert detail(counter(ash, taken, **asked)) == (409, {'code': 'STEP_NOT_ALLOWED'})
    other = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    ok(trade_step(misty, other, 'withdraw'))
    assert detail(counter(ash, ok(read(ash, other)), **asked)) == (409, {'code': 'STEP_NOT_ALLOWED'})
    answered = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    countered(ash, answered, **asked)
    assert detail(counter(ash, ok(read(ash, answered)), **asked)) == (409, {'code': 'STEP_NOT_ALLOWED'})
    last = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    with connect() as conn:
        conn.execute('DELETE FROM friendship WHERE user_low=%s AND user_high=%s', tuple(sorted([ash, misty])))
        conn.execute('INSERT INTO block (blocker_id, blocked_id) VALUES (%s, %s)', (misty, ash))
    assert detail(counter(ash, last, **asked)) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    assert row_of(last)['state'] == 'proposed' and trade_picks(last['id']) == [('proposer', misty, binder, 1)]


def test_a_retried_counter_answers_the_same_trade_and_writes_once(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    key = uuid4()
    first = counter(ash, original, give=[(arven, 1)], get=[(iono, 1)], key=key)
    again = counter(ash, original, give=[(arven, 1)], get=[(iono, 1)], key=key)
    assert (first.status_code, again.status_code) == (200, 200) and first.json() == again.json()
    assert len(counters_of(original)) == 1 and commands(ash) == 1
    assert detail(counter(ash, original, give=[(arven, 2)], get=[(iono, 1)], key=key)) == (
        409, {'code': 'IDEMPOTENCY_KEY_REUSED'})


def test_a_counter_moves_only_the_revisions_of_sides_whose_cards_it_releases_or_reserves(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    asking = proposed(misty, ash, get=[(arven, 1)])
    before = revision_of(misty), revision_of(ash)
    new = countered(ash, asking, get=[(iono, 1)])
    assert (revision_of(misty), revision_of(ash)) == before and trade_picks(new['id']) == []
    giving = proposed(misty, ash, give=[(iono, 1)])
    before = revision_of(misty), revision_of(ash)
    countered(ash, giving, get=[(iono, 2)])
    assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1])


def test_a_counter_counts_toward_the_hourly_limit(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    with connect() as conn:
        conn.execute("""INSERT INTO handle_lookup_event(user_id, kind, created_at)
          SELECT %s, 'trade_command', now() - interval '20 minutes' FROM generate_series(1, 120)""", (ash,))
    assert detail(counter(ash, original, give=[(arven, 1)], get=[(iono, 1)])) == (
        429, {'code': 'TOO_MANY_CHANGES', 'retry_after_minutes': 40})
    assert row_of(original)['state'] == 'proposed'


@pytest.mark.parametrize('first', ['counter', 'withdraw'])
def test_a_counter_and_a_withdraw_of_one_proposal_run_one_after_the_other(store, first):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    original = proposed(misty, ash, give=[(iono, 1)], get=[(arven, 1)])
    before = revision_of(misty), revision_of(ash)
    # Both steps delete Misty's pick: the first to reach it holds the Trade row while it sleeps there, and the
    # second waits on that row without ever reaching its own delete.
    held = _sleeping('trade_pick', 'DELETE', f"OLD.owner_id = '{misty}'")
    steps = {'counter': lambda: counter(ash, original, give=[(arven, 1)], get=[(iono, 1)]),
             'withdraw': lambda: trade_step(misty, original, 'withdraw')}
    second = 'withdraw' if first == 'counter' else 'counter'
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            winner = executor.submit(steps[first])
            _asleep(watch, 1, [winner])
            loser = executor.submit(steps[second])
            _waiting_on_a_row(watch, [winner, loser])
            winner, loser = winner.result(), loser.result()
    finally:
        held()
    assert winner.status_code == 200, winner.text
    assert detail(loser) == (409, {'code': 'TRADE_CHANGED'})
    if first == 'counter':
        assert row_of(original)['closed_reason'] == 'countered' and len(counters_of(original)) == 1
        assert reserved(misty, iono) == (0, 0) and reserved(ash, arven) == (1, 1)
        assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1] + 1)
    else:
        assert row_of(original)['closed_reason'] == 'withdrawn' and counters_of(original) == []
        assert reserved(misty, iono) == (0, 0) and reserved(ash, arven) == (0, 0)
        assert (revision_of(misty), revision_of(ash)) == (before[0] + 1, before[1])


# Strangers in reach (Trading #299): collectors who are not Friends but are both in open discovery nearby, or share a
# conversation. They are addressed by trader id; a send by user id still needs a Friend.


def the_pair_has_nothing(a, b):
    """No Trade of either and no conversation between the two."""
    with connect() as conn:
        low, high = sorted((a, b))
        return (conn.execute('SELECT count(*) AS n FROM trade WHERE (proposer_id=%s AND recipient_id=%s) '
                             'OR (proposer_id=%s AND recipient_id=%s)', (a, b, b, a)).fetchone()['n'] == 0
                and conn.execute('SELECT count(*) AS n FROM conversation WHERE user_low=%s AND user_high=%s',
                                 (low, high)).fetchone()['n'] == 0)


def suspended(user, value=True):
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = CASE WHEN %s THEN now() END WHERE user_id = %s',
                     (value, user))


def test_nearby_strangers_send_counter_and_accept_with_caps_on_the_strangers_list(store):
    ids, ash, misty, binder, box = strangers()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    assert detail(propose_to(misty, trader_of(ash), get=[(arven, 3)])) == (
        409, {'code': 'NOT_TRADEABLE', 'edition_id': arven, 'available': '2', 'side': 'you_get'})
    trade = ok(propose_to(misty, trader_of(ash), give=[(iono, 1)], get=[(arven, 1)]), 201)
    assert trade['other'] == {'collector_id': None, 'handle': None, 'trader_id': trader_of(ash),
                              'display_name': 'Ash K.', 'open_to_cash_offers': False, 'friend': False,
                              'available': True, 'completed_trades': 0}
    assert trade['conversation_id'] is not None
    seen = ok(read(ash, trade))
    assert detail(counter(ash, seen, give=[(arven, 1)], get=[(iono, 4)])) == (
        409, {'code': 'NOT_TRADEABLE', 'edition_id': iono, 'available': '3', 'side': 'you_get'})
    answer = countered(ash, seen, give=[(arven, 1)], get=[(iono, 2)])
    assert answer['other']['friend'] is False and answer['other']['collector_id'] is None
    mine = ok(read(misty, answer))
    assert ok(accept_trade(misty, mine))['state'] == 'accepted'


def test_contact_steps_outside_reach_are_collector_unavailable(store):
    ids, ash, misty, binder, box = strangers()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    give = [(iono, 1)]
    both = {'recipient_id': ash, 'recipient_trader_id': trader_of(ash), 'you_give': lines(give), 'you_get': [],
            'idempotency_key': str(uuid4())}
    neither = {'you_give': lines(give), 'you_get': [], 'idempotency_key': str(uuid4())}
    for body in (both, neither):
        assert detail(call('POST', '/api/trades', misty, body)) == (422, {'code': 'RECIPIENT_REQUIRED'})
    assert commands(misty) == 0

    def other(name):
        (user, _) = collector(name)
        return user

    off = other('Off O.')
    discoverable(off, '00011')
    ok(call('PUT', '/api/social/discovery', off, {'enabled': False}))
    far = other('Far F.')
    far_zip()
    discoverable(far, '00019')
    blocked_me, i_blocked, gone = other('Blocker B.'), other('Blocked B.'), other('Gone G.')
    for user in (blocked_me, i_blocked, gone):
        discoverable(user, '00011')
    block(blocked_me, misty)
    block(misty, i_blocked)
    suspended(gone)
    for user in (off, far, blocked_me, i_blocked, gone):
        assert detail(propose_to(misty, trader_of(user), give=give)) == (409, {'code': 'COLLECTOR_UNAVAILABLE'}), user
        assert the_pair_has_nothing(misty, user), user
    for trader in (str(uuid4()), trader_of(misty)):
        assert detail(propose_to(misty, trader, give=give)) == (409, {'code': 'COLLECTOR_UNAVAILABLE'}), trader
    assert commands(misty) == 0
    suspended(misty)
    assert detail(propose_to(misty, str(uuid4()), give=give)) == (403, {'code': 'ACCOUNT_SUSPENDED'})
    assert detail(propose_to(misty, trader_of(ash), give=give)) == (403, {'code': 'ACCOUNT_SUSPENDED'})
    suspended(misty, False)
    # Accept and Counter on a stranger's proposal.
    trade = ok(propose_to(misty, trader_of(ash), give=give, get=[(arven, 1)]), 201)
    asked = dict(give=[(arven, 1)], get=[(iono, 1)])
    before = row_of(trade)
    suspended(ash)
    assert detail(accept_trade(ash, trade)) == (403, {'code': 'ACCOUNT_SUSPENDED'})
    assert detail(counter(ash, trade, **asked)) == (403, {'code': 'ACCOUNT_SUSPENDED'})
    suspended(ash, False)
    suspended(misty)
    assert detail(accept_trade(ash, trade)) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    assert detail(counter(ash, trade, **asked)) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    assert row_of(trade) == before


def test_counter_and_accept_still_work_after_discovery_is_switched_off(store):
    ids, ash, misty, binder, box = strangers()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade = ok(propose_to(misty, trader_of(ash), give=[(iono, 1)], get=[(arven, 1)]), 201)
    ok(call('PUT', '/api/social/discovery', misty, {'enabled': False}))
    answer = countered(ash, ok(read(ash, trade)), give=[(arven, 1)], get=[(iono, 2)])
    ok(call('PUT', '/api/social/discovery', ash, {'enabled': False}))
    accepted = ok(accept_trade(misty, ok(read(misty, answer))))
    assert accepted['state'] == 'accepted' and accepted['other']['available'] is True


def test_cash_only_not_open_applies_to_strangers(store):
    ids, ash, misty, binder, box = strangers()
    cash = {'cents': '500', 'payer': 'you'}
    assert detail(propose_to(misty, trader_of(ash), get=[(ids['SVI 166'], 1)], cash=cash)) == (
        409, {'code': 'CASH_ONLY_NOT_OPEN', 'side': 'you_give'})
    trade_settings(ash, True)
    ok(propose_to(misty, trader_of(ash), get=[(ids['SVI 166'], 1)], cash=cash), 201)


def test_a_send_by_user_id_is_refused_when_the_friendship_ends_between_resolution_and_the_locks(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    first = proposed(misty, ash, give=[(iono, 1)])
    ok(trade_step(misty, first, 'withdraw'))
    with psycopg.connect(os.environ['DATABASE_URL']) as holder, \
            psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch, \
            ThreadPoolExecutor(max_workers=1) as executor:
        holder.execute('SELECT 1 FROM inventory_owner WHERE user_id = %s FOR UPDATE', (ash,))
        sending = executor.submit(propose, misty, ash, [(iono, 1)])
        _waiting_on_a_row(watch, [sending])
        holder.execute('DELETE FROM friendship WHERE user_low = %s AND user_high = %s', tuple(sorted([ash, misty])))
        holder.commit()
        refused = sending.result()
    assert detail(refused) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM trade WHERE proposer_id=%s', (misty,)).fetchone()['n'] == 1
    # The pair's conversation still lets a send by trader id through.
    assert ok(propose_to(misty, trader_of(ash), give=[(iono, 1)]), 201)['other']['available'] is True


def test_ex_friends_with_a_conversation_still_send_and_accept(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    proposed(misty, ash, give=[(iono, 1)])
    ok(call('POST', f'/api/social/friends/{misty}/remove', ash, {'idempotency_key': str(uuid4())}))
    assert detail(propose(misty, ash, give=[(iono, 1)])) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    trade = ok(propose_to(misty, trader_of(ash), give=[(iono, 1)]), 201)
    assert (trade['other']['friend'], trade['other']['collector_id'], trade['other']['available']) == (False, None, True)
    assert ok(accept_trade(ash, ok(read(ash, trade))))['state'] == 'accepted'


def test_a_closed_trade_whose_pair_has_no_conversation_still_opens(store):
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    ok(trade_step(misty, trade, 'withdraw'))
    with connect() as conn:
        conn.execute('DELETE FROM conversation WHERE id = %s', (trade['conversation_id'],))
    assert ok(read(misty, trade))['conversation_id'] is None
    assert trade['id'] in [item['id'] for item in ok(call('GET', '/api/social/trades', misty))['trades']]


def test_a_stored_send_from_before_the_party_fields_replays(store):
    ids, ash, misty, binder, box = trading()
    key = uuid4()
    first = ok(propose_to(misty, trader_of(ash), give=[(ids['PAL 185'], 1)], key=key), 201)
    with connect() as conn:
        conn.execute("UPDATE location_command SET response = response #- '{other,trader_id}' #- '{other,friend}' "
                     "#- '{other,available}' WHERE owner_id = %s AND request_key = %s", (misty, key))
    again = ok(propose_to(misty, trader_of(ash), give=[(ids['PAL 185'], 1)], key=key), 201)
    assert again['id'] == first['id']
    assert (again['other']['trader_id'], again['other']['friend'], again['other']['available']) == (None, False, False)
