"""Send a Friend a Trade Proposal and withdraw it (Trading #270): ``POST /api/trades`` (``app.trade_inventory``), the
Trade reads and the withdraw step under ``/api/social/trades`` (``app.social.trades``) and the Trade Pick List
(``app.trade_picks``), through signed HTTP against PostgreSQL.

Every test seeds the Swap catalog (``want_list_swap_fixtures``) and starts new collectors: Misty W. and Ash K. are
Friends (``test_loans.pair``). Copies are on a Trade List only from a For trade Location (``test_for_trade_locations.mark``).
"""
import os
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app import trade_inventory
from app.social import trades
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
from test_trade_lists import friend_cards, own_cards
from test_trade_promises import reserved, trade_picks
from want_list_swap_fixtures import seed_swap_catalog

UNKNOWN = b'{"detail":{"code":"TRADE_NOT_FOUND"}}'


def lines(cards):
    return [{'edition_id': edition, 'quantity': str(count)} for edition, count in cards]


def propose(sender, recipient, give=(), get=(), key=None):
    return call('POST', '/api/trades', sender, {'recipient_id': recipient, 'you_give': lines(give),
                                                'you_get': lines(get), 'idempotency_key': str(key or uuid4())})


def proposed(sender, recipient, give=(), get=()):
    return ok(propose(sender, recipient, give, get), 201)


def trade_step(user, trade, action, key=None, revision=None):
    return call('POST', f"/api/social/trades/{trade['id']}/{action}", user,
                {'revision': revision or trade['revision'], 'idempotency_key': str(key or uuid4())})


def read(user, trade):
    return call('GET', f"/api/social/trades/{trade['id']}", user)


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


def test_only_a_friend_can_be_sent_a_proposal(store):
    ids, ash, misty, binder, box = trading()
    (gary, _) = collector('Gary O.')
    assert detail(propose(misty, gary, give=[(ids['PAL 185'], 1)])) == (409, {'code': 'NOT_FRIENDS'})
    block(ash, misty)
    assert detail(propose(misty, ash, give=[(ids['PAL 185'], 1)])) == (409, {'code': 'NOT_FRIENDS'})
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM trade WHERE proposer_id=%s', (misty,)).fetchone()['n'] == 0


def test_a_swap_reserves_only_the_senders_copies_at_once_and_a_withdraw_releases_them(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    before = revision_of(misty), revision_of(ash)
    trade = proposed(misty, ash, give=[(iono, 2)], get=[(arven, 1)])
    assert (trade['state'], trade['role'], trade['section'], trade['actions']) == (
        'proposed', 'proposer', 'pending', ['withdraw'])
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
    assert detail(trade_step(misty, trade, 'withdraw')) == (429, {'code': 'TOO_MANY_CHANGES', 'retry_after_minutes': 30})
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
        'recipient', 'proposed', 'answer', True, 'needs_you', [])
    assert sides(seen) == ([(arven, '1')], [(iono, '2')])
    assert seen['other'] == {'collector_id': misty, 'display_name': 'Misty W.', 'handle': handle_of(misty),
                             'open_to_cash_offers': False}
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
    ('proposed', 'proposer', (None, None), True, ['withdraw']),
    ('proposed', 'proposer', (None, None), False, ['withdraw']),
    ('proposed', 'recipient', (None, None), True, []),
    ('proposed', 'recipient', (None, None), False, []),
    ('accepted', 'proposer', (None, None), True, []),
    ('accepted', 'recipient', ('now', None), True, []),
    ('closed', 'proposer', (None, None), True, []),
    ('closed', 'recipient', (None, None), False, []),
])
def test_allowed_lists_only_the_proposers_withdraw_of_an_unanswered_proposal(state, reader, swaps, gives, expected):
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
                                               'open_to_cash_offers': False}
    # Withdrawing still releases the copies; nobody is left to tell.
    ok(trade_step(misty, trade, 'withdraw'))
    assert reserved(misty, ids['PAL 185']) == (0, 0)
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM inbox_update WHERE trade_id=%s',
                            (trade['id'],)).fetchone()['n'] == 0


def test_the_other_sides_open_to_cash_offers_is_read_from_their_profile(store):
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET open_to_cash_offers = true WHERE user_id=%s', (misty,))
    assert ok(read(ash, trade))['other']['open_to_cash_offers'] is True
    assert ok(read(misty, trade))['other']['open_to_cash_offers'] is False


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


def _waiting_on_a_lock(watch, submitted):
    """Waits until a session waits on a lock, a row's or the Trade command lock, while every submitted call still runs.
    """
    deadline = time.monotonic() + 10
    while not watch.execute("""SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND wait_event IN ('advisory','transactionid','tuple')""").fetchone():
        assert time.monotonic() < deadline and not any(call_.done() for call_ in submitted), 'no step waited on a lock'
        time.sleep(0.01)


def _without_command_lock(conn, user_id, key, payload):
    """``trades.begin_trade_command`` without the caller's command lock: the owner row is the only lock left between
    two of one collector's Trade steps."""
    trades.ensure_owner(conn, user_id)
    digest, stored = trades.replay(conn, user_id, key, payload)
    if stored is None:
        trades.count_trade_command(conn, user_id)
    return digest, stored


@pytest.mark.parametrize('command_lock', [True, False])
def test_two_sends_of_the_same_copies_run_one_after_the_other(store, monkeypatch, command_lock):
    if not command_lock:
        monkeypatch.setattr(trade_inventory, 'begin_trade_command', _without_command_lock)
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
