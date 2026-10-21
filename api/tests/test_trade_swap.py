"""Each side's own view of a Trade, Use suggested picks and Confirm swap (Trading #272): ``GET /api/trades/{id}/side``,
``POST /api/trades/{id}/picks/use-suggested`` and ``POST /api/trades/{id}/confirm-swap`` (``app.trade_inventory``) over
the Trade Pick List (``app.trade_picks``), through signed HTTP against PostgreSQL.

Each side confirms the in-person swap for their own inventory only: the copies they give leave their Collection with
Removal semantics and no Undo record, the copies they get arrive as new Holdings where they chose (Unsorted by default),
their revision moves once, and the second confirmation closes the Trade as swapped. A pick a Move or a Removal left out
of date is flagged with a suggestion and replaced first. Steps on one collector's copies wait for each other.

Every test seeds the Swap catalog and starts new collectors through ``test_trades.trading``: Misty W. (3 Iono PAL 185
in her For trade Trade Binder) and Ash K. (2 Arven SVI 166 in his For trade Box), Friends.
"""
import ast
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app import trade_inventory
from app.social import trades
import test_holdings
from test_batch_add import undo, undo_records
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import counting, detail as deck_detail, hold, line
from test_for_trade_locations import deck_in, hide, mark
from test_friend_copies import befriend, collector, copies, node, ok, place
from test_handover import _asleep, _sleeping, whole_collection
from test_holdings import call
from test_loan_promises import _waiting_on_a_row, holding, remove
from test_loans import pair, revision_of
from test_moves import commit, selected, stage, start
from test_trade_lists import friend_cards, own_cards
from test_trade_promises import reserved, trade_picks
from test_trades import (UNKNOWN, accept_trade, commands, detail, handle_of, move_one, proposed, read, row_of,
                         trade_step, trading, updates)
from test_trade_wants import lines_of, set_rule, set_want, wants
from test_want_list import want_list
from want_list_swap_fixtures import seed_swap_catalog


def side(user, trade):
    return call('GET', f"/api/trades/{trade['id']}/side", user)


def picks(user, trade):
    """The reader's picks as [(Location name, copies, short)], in the side read's order."""
    return [(pick['name'], pick['copies'], pick['short']) for pick in ok(side(user, trade))['picks']]


def suggested(user, trade):
    return sorted((pick['name'], pick['copies']) for pick in ok(side(user, trade))['suggested'])


def confirm(user, trade, destination=None, key=None, revision=None):
    """``user``'s Confirm swap, on the revision they read now unless ``revision`` says otherwise."""
    return call('POST', f"/api/trades/{trade['id']}/confirm-swap", user,
                {'revision': revision or ok(read(user, trade))['revision'], 'idempotency_key': str(key or uuid4()),
                 'destination_id': destination})


def use_suggested(user, trade, key=None, revision=None):
    return call('POST', f"/api/trades/{trade['id']}/picks/use-suggested", user,
                {'revision': revision or ok(read(user, trade))['revision'], 'idempotency_key': str(key or uuid4())})


def held(owner, location):
    """The Holdings of one Location as {Edition: copies}."""
    body = ok(call('GET', f'/api/holdings/{location}', owner))
    return {item['edition_id']: item['quantity'] for item in body['holdings']}


def unsorted(owner):
    return node(owner, 'Unsorted')['id']


def swapping(give=1, get=1):
    """``trading``'s collectors with an accepted Trade: Misty gives ``give`` Iono for ``get`` of Ash's Arven. Returns
    (ids, ash, misty, binder, box, trade as Ash read it after accepting)."""
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], give)] if give else (),
                     get=[(ids['SVI 166'], get)] if get else ())
    return ids, ash, misty, binder, box, ok(accept_trade(ash, trade))


def code(response):
    return response.status_code, response.json()['detail']['code']


# The side read.


def test_each_side_reads_only_its_own_picks_with_its_own_location_names_and_a_stranger_gets_not_found(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    (gary, _) = collector('Gary O.')
    trade = proposed(misty, ash, give=[(iono, 2)], get=[(arven, 1)])
    # While the proposal waits only Misty's copies are promised; Ash's side has no picks yet.
    mine = ok(side(misty, trade))
    assert set(mine) == {'trade_id', 'picks', 'suggested', 'deck_switches'} and mine['trade_id'] == trade['id']
    assert [(pick['edition_id'], pick['location_id'], pick['name'], pick['copies'], pick['short'])
            for pick in mine['picks']] == [(iono, binder, 'Trade Binder', '2', '0')]
    assert mine['suggested'] == [] and ok(side(ash, trade)) == {'trade_id': trade['id'], 'picks': [], 'suggested': [],
                                                 'deck_switches': []}
    ok(accept_trade(ash, trade))
    assert picks(ash, trade) == [('Box', '1', '0')] and picks(misty, trade) == [('Trade Binder', '2', '0')]
    # Neither side's read names the other's Locations.
    assert 'Box' not in side(misty, trade).text and 'Trade Binder' not in side(ash, trade).text
    for response in (side(gary, trade), side(misty, {'id': str(uuid4())})):
        assert (response.status_code, response.content) == (404, UNKNOWN)
    # A side that gives nothing has no picks; a closed Trade has none left.
    gift = ok(accept_trade(ash, proposed(misty, ash, give=[(iono, 1)])))
    assert picks(ash, gift) == []
    ok(trade_step(misty, ok(read(misty, trade)), 'cancel'))
    assert picks(misty, trade) == [] and picks(ash, trade) == []


def test_the_side_read_lists_picks_in_line_order_then_the_largest_first(store):
    ids, ash, misty, binder, box = trading()
    iono, arven, boss = ids['PAL 185'], ids['SVI 166'], ids['PAL 172']
    shelf = place(misty, 'Shelf')
    hold(misty, shelf, iono, 1)
    hold(misty, binder, boss, 1)
    ok(mark(misty, shelf))
    trade = proposed(misty, ash, give=[(boss, 1), (iono, 4)], get=[(arven, 1)])
    assert picks(misty, trade) == [('Trade Binder', '1', '0'), ('Trade Binder', '3', '0'), ('Shelf', '1', '0')]
    assert [pick['edition_id'] for pick in ok(side(misty, trade))['picks']] == [boss, iono, iono]


# Confirm swap.


def test_the_cards_a_side_gives_leave_with_no_undo_and_the_cards_it_gets_arrive_in_unsorted(store):
    ids, ash, misty, binder, box, trade = swapping()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    records, before = undo_records(ash), (revision_of(ash), revision_of(misty))
    misty_before = whole_collection(misty)
    confirmed = ok(confirm(ash, trade))
    assert (confirmed['state'], confirmed['role'], confirmed['actions'], confirmed['waiting'], confirmed['needs_you'],
            confirmed['revision']) == ('accepted', 'recipient', [], None, False, trade['revision'] + 1)
    # Ash's copy left his Box and Misty's arrived in his Unsorted, with no Undo record and one revision.
    assert held(ash, box) == {arven: '1'} and held(ash, unsorted(ash)) == {iono: '1'}
    assert undo_records(ash) == records and revision_of(ash) == before[0] + 1
    assert row_of(trade)['recipient_swap_at'] is not None and row_of(trade)['proposer_swap_at'] is None
    # His reservation ended with his picks; Misty's stays until she confirms, and nothing of hers moved.
    assert trade_picks(trade['id']) == [('proposer', misty, binder, 1)]
    assert reserved(ash, arven) == (0, 0) and reserved(misty, iono) == (1, 1)
    assert revision_of(misty) == before[1] and whole_collection(misty) == misty_before
    assert held(misty, binder) == {iono: '3'} and own_cards(misty) == {iono: ('2', {'Trade Binder': '2'})}
    assert own_cards(ash) == {arven: ('1', {'Box': '1'})} and friend_cards(misty, handle_of(ash)) == {arven: '1'}
    # The first confirmation stores no update; Misty is asked to confirm hers, and only that (or fix her picks).
    assert updates(trade) == [(misty, 'accepted', 'Ash K.')]
    theirs = ok(read(misty, trade))
    assert (theirs['waiting'], theirs['needs_you'], theirs['actions']) == (
        'confirm_swap', True, ['confirm_swap', 'use_suggested_picks'])
    assert detail(trade_step(misty, theirs, 'cancel')) == (409, {'code': 'STEP_NOT_ALLOWED'})
    assert detail(trade_step(ash, ok(read(ash, trade)), 'cancel')) == (409, {'code': 'STEP_NOT_ALLOWED'})


def test_the_second_confirmation_closes_the_trade_as_swapped_and_tells_the_first(store):
    ids, ash, misty, binder, box, trade = swapping(give=2, get=1)
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ok(confirm(ash, trade))
    before = revision_of(misty)
    done = ok(confirm(misty, trade))
    assert (done['state'], done['closed_reason'], done['closed_by'], done['section'], done['actions']) == (
        'closed', 'swapped', 'you', 'history', [])
    assert held(misty, binder) == {iono: '1'} and held(misty, unsorted(misty)) == {arven: '1'}
    assert revision_of(misty) == before + 1 and trade_picks(trade['id']) == []
    assert reserved(misty, iono) == (0, 0) and own_cards(misty) == {iono: ('1', {'Trade Binder': '1'})}
    assert updates(trade) == [(misty, 'accepted', 'Ash K.'), (ash, 'swapped', 'Misty W.')]
    seen = ok(read(ash, trade))
    assert (seen['state'], seen['closed_reason'], seen['closed_by'], seen['actions']) == (
        'closed', 'swapped', 'them', [])
    # Nothing is left to do on a swapped Trade, by either side.
    for user in (ash, misty):
        assert code(confirm(user, trade)) == (409, 'STEP_NOT_ALLOWED')
        assert code(use_suggested(user, trade)) == (409, 'STEP_NOT_ALLOWED')


def test_the_received_cards_go_to_the_chosen_storage_leaf_or_deck_and_a_deck_raises_its_lines(store):
    ids, ash, misty, binder, box, trade = swapping(give=2, get=1)
    iono, arven = ids['PAL 185'], ids['SVI 166']
    shelf = place(ash, 'Shelf')
    ok(confirm(ash, trade, destination=shelf))
    assert held(ash, shelf) == {iono: '2'} and held(ash, unsorted(ash)) == {}
    # Into a Deck whose line is already there: a hold(...) Add made it (0 to 1), and the swap grows it as an Add does.
    ladder = deck_in(misty, 'Ladder')
    hold(misty, ladder, arven, 1)
    before = revision_of(misty)
    ok(confirm(misty, trade, destination=ladder))
    assert held(misty, ladder) == {arven: '2'} and revision_of(misty) == before + 1
    assert [(entry['edition_id'], entry['quantity']) for entry in deck_detail(misty, ladder)['deck_list']['lines']] == [
        (arven, '2')]
    ids2, ash2, misty2, binder2, box2, trade2 = swapping(give=1, get=2)
    deck = deck_in(misty2, 'Charizard')
    hold(misty2, deck, ids2['SVI 166'], 1)
    line(misty2, deck, ids2['SVI 166'], 1)
    ok(confirm(misty2, trade2, destination=deck))
    assert [(entry['edition_id'], entry['quantity']) for entry in deck_detail(misty2, deck)['deck_list']['lines']] == [
        (ids2['SVI 166'], '3')]


def test_a_deck_with_no_line_for_the_edition_gets_one_from_zero_when_cards_arrive(store):
    ids, ash, misty, binder, box, trade = swapping(give=1, get=2)
    empty = deck_in(misty, 'Empty')
    assert deck_detail(misty, empty)['deck_list']['lines'] == []
    ok(confirm(misty, trade, destination=empty))
    assert held(misty, empty) == {ids['SVI 166']: '2'}
    assert [(entry['edition_id'], entry['quantity']) for entry in deck_detail(misty, empty)['deck_list']['lines']] == [
        (ids['SVI 166'], '2')]


def test_a_side_that_gives_or_gets_nothing_moves_its_revision_once_and_a_gift_giver_needs_no_destination(store):
    ids, ash, misty, binder, box, gift = swapping(give=2, get=0)
    iono = ids['PAL 185']
    # Ash gets cards and gives none: he has no picks to fix, and his confirm moves his revision once.
    assert code(use_suggested(ash, gift)) == (409, 'STEP_NOT_ALLOWED')
    before = revision_of(ash)
    ok(confirm(ash, gift))
    assert held(ash, unsorted(ash)) == {iono: '2'} and revision_of(ash) == before + 1
    # Misty gives and gets nothing: the destination is ignored, even one that isn't hers, and Unsorted is not made.
    with connect() as conn:
        conn.execute("DELETE FROM location WHERE owner_id=%s AND name='Unsorted'", (misty,))
    before = revision_of(misty)
    done = ok(confirm(misty, gift, destination=str(uuid4())))
    assert done['closed_reason'] == 'swapped' and held(misty, binder) == {iono: '1'}
    assert revision_of(misty) == before + 1
    assert all(item['name'] != 'Unsorted' for item in ok(call('GET', '/api/location-tree', misty))['locations'])


def test_a_destination_that_is_not_one_of_the_confirmers_leaves_or_decks_changes_nothing(store):
    ids, ash, misty, binder, box, trade = swapping()
    with connect() as conn:
        folder = str(conn.execute("""INSERT INTO location(id, owner_id, name, kind)
          VALUES (%s, %s, 'Folder', 'organization') RETURNING id""", (uuid4(), ash)).fetchone()['id'])
    before, records = revision_of(ash), commands(ash)
    # Misty's Trade Binder, an Organizational Location of Ash's, and no Location at all.
    for destination in (binder, folder, str(uuid4())):
        assert detail(confirm(ash, trade, destination=destination)) == (404, {'code': 'LOCATION_NOT_FOUND'})
    assert revision_of(ash) == before and held(ash, box) == {ids['SVI 166']: '2'} and commands(ash) == records
    assert row_of(trade)['recipient_swap_at'] is None and len(trade_picks(trade['id'])) == 2


def test_a_missing_unsorted_is_made_and_one_that_cannot_hold_cards_refuses(store):
    ids, ash, misty, binder, box, trade = swapping()
    iono = ids['PAL 185']
    with connect() as conn:
        conn.execute("DELETE FROM location WHERE owner_id=%s AND name='Unsorted'", (ash,))
    ok(confirm(ash, trade))
    assert held(ash, unsorted(ash)) == {iono: '1'} and node(ash, 'Unsorted')['kind'] == 'storage_leaf'
    with connect() as conn:
        conn.execute("UPDATE location SET kind='organization' WHERE owner_id=%s AND name='Unsorted'", (misty,))
    before = revision_of(misty)
    assert detail(confirm(misty, trade)) == (409, {'code': 'UNSORTED_UNAVAILABLE'})
    assert revision_of(misty) == before and row_of(trade)['state'] == 'accepted'
    assert trade_picks(trade['id']) == [('proposer', misty, binder, 1)]


# Out-of-date picks.


def test_a_pick_a_move_left_out_of_date_is_flagged_and_replaced_before_the_swap(store):
    ids, ash, misty, binder, box, trade = swapping(give=2, get=1)
    iono = ids['PAL 185']
    loose = place(misty, 'Loose Box')
    shelf = place(misty, 'Shelf')
    hold(misty, loose, iono, 4)
    hold(misty, shelf, iono, 1)
    ok(mark(misty, shelf))
    # Two of the three Iono leave the Trade Binder: the pick of 2 is short of 1.
    move_one(misty, binder, iono, loose)
    move_one(misty, binder, iono, loose)
    assert picks(misty, trade) == [('Trade Binder', '2', '1')]
    # The suggestion keeps the copy still there and takes the other from a For trade Location first, over a larger
    # loose box.
    assert suggested(misty, trade) == [('Shelf', '1'), ('Trade Binder', '1')]
    assert detail(confirm(misty, trade)) == (409, {'code': 'PICKS_OUT_OF_DATE'})
    assert held(misty, binder) == {iono: '1'} and row_of(trade)['proposer_swap_at'] is None
    # Each side's picks are judged alone: Ash's are up to date.
    assert code(use_suggested(ash, trade)) == (409, 'PICKS_UP_TO_DATE')
    # Only Misty's picks and revision change.
    before, ash_before, revision = revision_of(misty), revision_of(ash), ok(read(misty, trade))['revision']
    ash_picks = [row for row in trade_picks(trade['id']) if row[0] == 'recipient']
    fixed = ok(use_suggested(misty, trade))
    assert fixed['revision'] == revision + 1 and fixed['actions'] == ['confirm_swap', 'use_suggested_picks', 'cancel']
    assert sorted(picks(misty, trade)) == [('Shelf', '1', '0'), ('Trade Binder', '1', '0')]
    assert suggested(misty, trade) == []
    assert (revision_of(misty), revision_of(ash)) == (before + 1, ash_before)
    assert [row for row in trade_picks(trade['id']) if row[0] == 'recipient'] == ash_picks
    assert code(use_suggested(misty, trade)) == (409, 'PICKS_UP_TO_DATE')
    ok(confirm(misty, trade))
    assert held(misty, binder) == {} and held(misty, shelf) == {} and held(misty, loose) == {iono: '6'}


def _all_three_into_a_deck(misty, binder, iono, name):
    deck = deck_in(misty, name)
    for _ in range(3):
        move_one(misty, binder, iono, deck)
    return deck


def test_a_pick_whose_source_location_was_deleted_reads_as_unsorted_and_must_be_fixed(store):
    ids, ash, misty, binder, box, trade = swapping(give=2, get=1)
    iono = ids['PAL 185']
    deck = _all_three_into_a_deck(misty, binder, iono, 'Ladder')
    assert suggested(misty, trade) == [('Ladder', '2')]
    ok(use_suggested(misty, trade))
    assert picks(misty, trade) == [('Ladder', '2', '0')]
    # The copies leave the Deck first (a Deck that still holds copies sends its picks to Unsorted with them), so the
    # emptied Deck's deletion leaves the pick with no source.
    shelf = place(misty, 'Shelf')
    for _ in range(3):
        move_one(misty, deck, iono, shelf)
    named = node(misty, deck)
    assert call('DELETE', f'/api/decks/{deck}', misty, {'name': named['name'], 'version': named['version'],
                                                        'idempotency_key': str(uuid4())}).status_code == 200
    gone = ok(side(misty, trade))['picks']
    assert [(pick['location_id'], pick['name'], pick['copies'], pick['short']) for pick in gone] == [
        (None, 'Unsorted', '2', '2')]
    before = revision_of(misty)
    assert detail(confirm(misty, trade)) == (409, {'code': 'PICKS_OUT_OF_DATE'})
    assert revision_of(misty) == before and row_of(trade)['proposer_swap_at'] is None
    ok(use_suggested(misty, trade))
    assert picks(misty, trade) == [('Shelf', '2', '0')]
    ok(confirm(misty, trade))
    assert held(misty, shelf) == {iono: '1'} and held(misty, unsorted(misty)) == {ids['SVI 166']: '1'}


def test_giving_a_copy_out_of_a_deck_leaves_its_deck_list_and_takes_no_undo_slot(store):
    ids, ash, misty, binder, box, trade = swapping(give=2, get=1)
    iono = ids['PAL 185']
    deck = _all_three_into_a_deck(misty, binder, iono, 'Ladder')
    line(misty, deck, iono, 3)
    ok(use_suggested(misty, trade))
    def listed():
        return [(entry['edition_id'], entry['quantity']) for entry in deck_detail(misty, deck)['deck_list']['lines']]

    lines, records = listed(), undo_records(misty)
    assert lines == [(iono, '3')] and picks(misty, trade) == [('Ladder', '2', '0')]
    ok(confirm(misty, trade))
    assert held(misty, deck) == {iono: '1'}
    assert listed() == lines
    assert undo_records(misty) == records


def test_with_no_for_trade_copies_left_the_suggestion_takes_any_location_in_the_deck_pick_list_order(store):
    ids, ash, misty, binder, box, trade = swapping(give=1, get=1)
    arven = ids['SVI 166']
    small, large = place(ash, 'Small Box'), place(ash, 'Large Box')
    hold(ash, large, arven, 1)
    # Both of Ash's For trade copies move to a Location that isn't For trade.
    move_one(ash, box, arven, small)
    move_one(ash, box, arven, small)
    assert picks(ash, trade) == [('Box', '1', '1')]
    assert suggested(ash, trade) == [('Small Box', '1')]
    ok(use_suggested(ash, trade))
    ok(confirm(ash, trade))
    assert held(ash, small) == {arven: '1'} and held(ash, large) == {arven: '1'}


def test_a_proposer_fixes_an_out_of_date_pick_while_the_proposal_waits(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    trade = proposed(misty, ash, give=[(iono, 3)])
    shelf = place(misty, 'Shelf')
    move_one(misty, binder, iono, shelf)
    assert picks(misty, trade) == [('Trade Binder', '3', '1')]
    fixed = ok(use_suggested(misty, trade))
    assert (fixed['state'], fixed['actions']) == ('proposed', ['use_suggested_picks', 'withdraw'])
    assert sorted(picks(misty, trade)) == [('Shelf', '1', '0'), ('Trade Binder', '2', '0')]
    # The recipient gives nothing yet: the step isn't theirs.
    assert code(use_suggested(ash, trade)) == (409, 'STEP_NOT_ALLOWED')


def test_a_removal_that_leaves_a_pick_covered_never_makes_it_out_of_date(store):
    ids, ash, misty, binder, box, trade = swapping(give=1, get=1)
    iono = ids['PAL 185']
    assert remove(misty, binder, iono, 2).status_code == 200
    assert picks(misty, trade) == [('Trade Binder', '1', '0')]
    # Removing the promised copy itself is refused, as for a Loan.
    assert code(remove(misty, binder, iono, 1))[0] == 409
    ok(confirm(misty, trade))
    assert held(misty, binder) == {}


# Replays and revisions.


def test_a_confirm_replayed_with_its_key_answers_the_same_and_writes_once(store):
    ids, ash, misty, binder, box, trade = swapping()
    key, revision = uuid4(), trade['revision']
    first = confirm(ash, trade, key=key, revision=revision)
    again = confirm(ash, trade, key=key, revision=revision)
    assert (first.status_code, again.status_code) == (200, 200) and first.json() == again.json()
    assert held(ash, unsorted(ash)) == {ids['PAL 185']: '1'} and commands(ash) == 2
    # The same key with another destination, or another revision, is another command.
    assert code(confirm(ash, trade, destination=box, key=key, revision=revision)) == (409, 'IDEMPOTENCY_KEY_REUSED')
    assert code(confirm(ash, trade, key=key, revision=revision + 1)) == (409, 'IDEMPOTENCY_KEY_REUSED')
    # A new key: a second confirmation by the same side is refused, and a stale revision is refused first.
    assert code(confirm(ash, trade)) == (409, 'STEP_NOT_ALLOWED')
    assert code(confirm(ash, trade, revision=revision)) == (409, 'TRADE_CHANGED')
    assert code(confirm(misty, trade, revision=revision)) == (409, 'TRADE_CHANGED')
    assert row_of(trade)['revision'] == revision + 1


def test_the_remaining_side_confirms_alone_once_the_other_account_is_gone(store):
    ids, ash, misty, binder, box, trade = swapping()
    ok(confirm(ash, trade))
    # Account deletion is not built yet (spec, "Account deletion"): the recipient id goes NULL and
    # that side's inbox rows go.
    with connect() as conn:
        conn.execute('UPDATE trade SET recipient_id=NULL WHERE id=%s', (trade['id'],))
        conn.execute('DELETE FROM inbox_update WHERE recipient_id=%s', (ash,))
    done = ok(confirm(misty, trade))
    assert (done['closed_reason'], done['other']['display_name']) == ('swapped', 'Ash K.')
    assert held(misty, unsorted(misty)) == {ids['SVI 166']: '1'}
    assert updates(trade) == [(misty, 'accepted', 'Ash K.')]


def test_older_undo_records_keep_their_usual_checks_after_a_swap(store):
    ids, ash, misty, binder, box, trade = swapping(give=3, get=1)
    iono = ids['PAL 185']
    shelf = place(misty, 'Shelf')
    move_one(misty, binder, iono, shelf)
    records = undo_records(misty)
    # No For trade copy is free, so the suggestion takes the moved copy from Shelf, and the swap takes it from there.
    assert suggested(misty, trade) == [('Shelf', '1'), ('Trade Binder', '2')]
    ok(use_suggested(misty, trade))
    ok(confirm(misty, trade))
    assert undo_records(misty) == records and held(misty, shelf) == {}
    # The Move's Undo still checks that its destination holds what arrived: the swap took it, so it is refused and
    # changes nothing.
    before = revision_of(misty)
    assert code(undo(misty, records[0]['id'])) == (409, 'UNDO_INCOMPATIBLE')
    assert revision_of(misty) == before and held(misty, binder) == {}


def test_cash_and_lines_on_the_other_side_change_nothing_for_the_confirmer(store):
    ids, ash, misty, binder, box, trade = swapping(give=2, get=1)
    with connect() as conn:
        conn.execute("UPDATE trade SET cash_cents=500, cash_payer='recipient' WHERE id=%s", (trade['id'],))
    before = whole_collection(ash)
    ok(confirm(ash, trade))
    # Ash gave 1 and got 2: one more copy, whatever the cash.
    assert int(whole_collection(ash)[0]) == int(before[0]) + 1


# Trade Lists after the swap.


def test_received_cards_in_a_for_trade_location_join_the_trade_list_and_given_ones_leave_it(store):
    ids, ash, misty, binder, box, trade = swapping(give=2, get=1)
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ok(confirm(ash, trade, destination=box))
    assert own_cards(ash) == {arven: ('1', {'Box': '1'}), iono: ('2', {'Box': '2'})}
    assert friend_cards(misty, handle_of(ash)) == {arven: '1', iono: '2'}
    ok(confirm(misty, trade))
    assert own_cards(misty) == {iono: ('1', {'Trade Binder': '1'})}
    assert friend_cards(ash, handle_of(misty)) == {iono: '1'}


# Figures stay those of the same Removal and Add.


def _figures(body):
    """A read with its digests left out: a digest covers ids, which differ between twins."""
    if isinstance(body, dict):
        return {key: _figures(value) for key, value in body.items() if not key.endswith('digest')}
    if isinstance(body, list):
        return [_figures(value) for value in body]
    return body


def _twin_setup(ids, owner):
    """A Deck Ladder listing 2 Iono with 1 held, a Deck Other listing 1 Arven with none held, and 2 Arven in a For
    trade Trade Binder. Returns (ladder, other, binder)."""
    ladder, other = deck_in(owner, 'Ladder'), deck_in(owner, 'Other')
    binder = place(owner, 'Trade Binder')
    hold(owner, ladder, ids['PAL 185'], 1)
    line(owner, ladder, ids['PAL 185'], 2)
    line(owner, other, ids['SVI 166'], 1)
    hold(owner, binder, ids['SVI 166'], 2)
    ok(mark(owner, binder))
    return ladder, other, binder


def test_a_swap_leaves_every_deck_want_list_and_loan_figure_as_a_removal_and_an_add_would(store):
    ids = seed_swap_catalog()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    gary, brock = pair()
    (twin, _) = collector('Twin T.')
    befriend(brock, twin)
    traded, twinned = _twin_setup(ids, gary), _twin_setup(ids, twin)
    giver_binder = place(brock, 'Brock Binder')
    hold(brock, giver_binder, iono, 2)
    ok(mark(brock, giver_binder))
    # Gary gives 1 Arven and gets 2 Iono into Ladder by a Trade; his twin does the same by a Removal and an Add.
    trade = proposed(gary, brock, give=[(arven, 1)], get=[(iono, 2)])
    ok(accept_trade(brock, trade))
    ok(confirm(gary, trade, destination=traded[0]))
    assert remove(twin, twinned[2], arven, 1).status_code == 200
    hold(twin, twinned[0], iono, 2)

    def same(owner, decks, body):
        for mine, theirs in zip(decks, twinned):
            body = body.replace(mine, theirs)
        return body.replace(owner, twin)

    for deck_index in (0, 1):
        assert deck_detail(gary, traded[deck_index])['deck_list']['lines'] == \
            deck_detail(twin, twinned[deck_index])['deck_list']['lines']
    assert _figures(json.loads(same(gary, traded, call('GET', '/api/want-list', gary).text))) == \
        _figures(want_list(twin))
    assert whole_collection(gary) == whole_collection(twin)
    assert copies(brock, [gary], [arven, iono])[(gary, arven)] == copies(brock, [twin], [arven, iono])[(twin, arven)]
    assert copies(brock, [gary], [arven, iono])[(gary, iono)] == copies(brock, [twin], [arven, iono])[(twin, iono)]


# Trade Wants at Confirm swap (Trading #275): the Decks' needs for the received Edition come first.


def getting_iono(get=3):
    """``trading``'s collectors with an accepted Trade: Misty gives ``get`` Iono PAL 185 for 1 of Ash's Arven. Returns
    (ids, ash, misty, box, trade as Ash read it after accepting)."""
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], get)], get=[(ids['SVI 166'], 1)])
    return ids, ash, misty, box, ok(accept_trade(ash, trade))


def test_received_copies_fill_the_decks_first_and_only_the_rest_lower_trade_wants(store):
    ids, ash, misty, box, trade = getting_iono(3)
    iono = ids['PAL 185']
    ladder = deck_in(ash, 'Ladder')
    line(ash, ladder, iono, 2)
    ok(set_want(ash, iono, 4))
    ok(set_want(ash, ids['PAF 80'], 1))
    # The spec's example: the Decks need 2, Trade Wants say 4, 3 arrive. The Decks take 2 and the line goes to 3.
    ok(confirm(ash, trade))
    assert lines_of(wants(ash)) == [(iono, '3'), (ids['PAF 80'], '1')]
    assert deck_detail(ash, ladder)['to_get'] == '0'


def test_a_trade_wants_line_the_copies_cover_goes_and_is_never_set_to_zero(store):
    for quantity in (2, 3):
        ids, ash, misty, box, trade = getting_iono(3)
        ok(set_want(ash, ids['PAL 185'], quantity))
        ok(confirm(ash, trade))
        assert wants(ash)['lines'] == [], quantity
    # Copies the Decks need are never taken off the line: with no copies left over it stays as it was.
    ids, ash, misty, box, trade = getting_iono(2)
    line(ash, deck_in(ash, 'Ladder'), ids['PAL 185'], 2)
    ok(set_want(ash, ids['PAL 185'], 1))
    ok(confirm(ash, trade))
    assert lines_of(wants(ash)) == [(ids['PAL 185'], '1')]


def test_another_card_received_through_will_accept_lowers_no_line_and_fills_no_other_deck_line(store):
    ids, ash, misty, box, trade = getting_iono(3)
    iono, other = ids['PAL 185'], ids['PAL 254']
    ladder = deck_in(ash, 'Ladder')
    line(ash, ladder, other, 1)
    ok(set_rule(ash, other, 'identity'))
    ok(set_want(ash, other, 2))
    ok(confirm(ash, trade))
    # Only the exact Edition counts: the line for PAL 254 keeps its 2, and the Deck still asks for PAL 254.
    assert lines_of(wants(ash)) == [(other, '2')]
    [needed] = section_lines(want_list(ash), ladder)
    assert (needed['edition_id'], needed['need']) == (other, '1')
    assert held(ash, unsorted(ash)) == {iono: '3'}


def section_lines(body, deck_id):
    return next(entry for entry in body['sections'] if entry['deck_id'] == deck_id)['lines']


def test_the_decks_needs_follow_the_counting_setting_and_count_hidden_decks(store):
    ids, ash, misty, box, trade = getting_iono(3)
    iono = ids['PAL 185']
    older, newer = deck_in(ash, 'Older'), deck_in(ash, 'Newer')
    for deck_id in (older, newer):
        line(ash, deck_id, iono, 2)
    counting(ash, 'one_at_a_time')
    ok(set_want(ash, iono, 4))
    # One Deck at a time: the need is the largest one Deck has, 2, so 1 copy is left over.
    ok(confirm(ash, trade))
    assert lines_of(wants(ash)) == [(iono, '3')]
    # Every Deck built at once: the needs add up to 4, so nothing is left over.
    ids, ash, misty, box, trade = getting_iono(3)
    for deck_id in (deck_in(ash, 'Older'), deck_in(ash, 'Newer')):
        line(ash, deck_id, ids['PAL 185'], 2)
    ok(set_want(ash, ids['PAL 185'], 4))
    ok(confirm(ash, trade))
    assert lines_of(wants(ash)) == [(ids['PAL 185'], '4')]
    # A Deck inside a Hidden Location counts as on the collector's own Want List.
    ids, ash, misty, box, trade = getting_iono(3)
    shelf = place(ash, 'Shelf')
    hide(ash, shelf)
    line(ash, deck_in(ash, 'Secret', parent=shelf), ids['PAL 185'], 2)
    ok(set_want(ash, ids['PAL 185'], 4))
    ok(confirm(ash, trade))
    assert lines_of(wants(ash)) == [(ids['PAL 185'], '3')]


def test_the_destination_does_not_change_how_far_trade_wants_fall(store):
    ids, ash, misty, box, trade = getting_iono(3)
    iono = ids['PAL 185']
    ladder = deck_in(ash, 'Ladder')
    line(ash, ladder, iono, 2)
    ok(set_want(ash, iono, 4))
    ok(confirm(ash, trade, destination=ladder))
    assert held(ash, ladder) == {iono: '3'} and lines_of(wants(ash)) == [(iono, '3')]


def test_a_replayed_confirm_lowers_trade_wants_once_and_a_side_that_gets_nothing_lowers_none(store):
    ids, ash, misty, box, trade = getting_iono(3)
    ok(set_want(ash, ids['PAL 185'], 5))
    ok(set_want(misty, ids['SVI 166'], 5))
    key = uuid4()
    for _ in range(2):
        ok(confirm(ash, trade, key=key, revision=trade['revision']))
    assert lines_of(wants(ash)) == [(ids['PAL 185'], '2')]
    # Misty gets 1 Arven and her Decks need none: her line falls by 1. A gift giver's lines don't move.
    ok(confirm(misty, trade))
    assert lines_of(wants(misty)) == [(ids['SVI 166'], '4')]
    ids, ash, misty, binder, box, gift = swapping(give=2, get=0)
    ok(set_want(misty, ids['PAL 185'], 5))
    ok(confirm(misty, gift))
    assert lines_of(wants(misty)) == [(ids['PAL 185'], '5')]


@pytest.mark.parametrize('first', ['confirm', 'set'])
def test_a_trade_wants_change_and_a_confirm_of_the_same_collector_run_one_after_the_other(store, first):
    ids, ash, misty, box, trade = getting_iono(3)
    iono = ids['PAL 185']
    line(ash, deck_in(ash, 'Ladder'), iono, 2)
    ok(set_want(ash, iono, 4))
    steps = {'confirm': lambda: confirm(ash, trade, revision=trade['revision']),
             'set': lambda: set_want(ash, iono, 10)}
    # The confirm sleeps adding Ash's received Holding; the change sleeps updating his line.
    held_ = (_sleeping('holding', 'INSERT', f"NEW.owner_id = '{ash}'") if first == 'confirm'
             else _sleeping('trade_want', 'UPDATE', f"NEW.owner_id = '{ash}'"))
    second = 'set' if first == 'confirm' else 'confirm'
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            winner = executor.submit(steps[first])
            _asleep(watch, 1, [winner])
            loser = executor.submit(steps[second])
            _waiting_on_a_row(watch, [winner, loser])
            winner, loser = winner.result(), loser.result()
    finally:
        held_()
    assert (winner.status_code, loser.status_code) == (200, 200), (winner.text, loser.text)
    # Set after the swap: the line is what was set. Set before it: the swap lowers the new value by the 1 left over.
    assert lines_of(wants(ash)) == [(iono, '10' if first == 'confirm' else '9')]


# Privacy.


def test_no_location_name_or_id_of_one_side_reaches_the_other(store):
    ids, ash, misty, binder, box, trade = swapping(give=2, get=1)
    iono = ids['PAL 185']
    shelf = place(misty, 'Secret Shelf')
    hold(misty, shelf, iono, 1)
    ok(mark(misty, shelf))
    move_one(misty, binder, iono, shelf)
    move_one(misty, binder, iono, shelf)
    ladder = deck_in(ash, 'Secret Deck')
    misty_secrets = {binder, shelf, 'Trade Binder', 'Secret Shelf'}
    ash_secrets = {box, ladder, 'Box', 'Secret Deck'}
    answers = [use_suggested(misty, trade), confirm(ash, trade, destination=ladder), confirm(misty, trade)]
    assert all(answer.status_code == 200 for answer in answers), [answer.text for answer in answers]
    for body in [answer.text for answer in answers] + [read(user, trade).text for user in (misty, ash)] + \
            [call('GET', '/api/social/trades', user).text for user in (misty, ash)] + \
            [side(user, trade).text for user in (misty, ash)]:
        assert not any(secret in body for secret in misty_secrets | ash_secrets), body
    # The TradeView never grows a pick, a suggestion or a destination.
    for answer in answers:
        assert not {'picks', 'suggested', 'destination_id', 'deck_switches'} & set(answer.json())


# A bug at the give step rolls back.


def test_a_holding_short_at_the_give_step_is_a_500_that_changes_nothing(store, monkeypatch):
    ids, ash, misty, binder, box, trade = swapping(give=1, get=1)
    arven = ids['SVI 166']
    other = place(ash, 'Other Box')
    move_one(ash, box, arven, other)
    move_one(ash, box, arven, other)
    # The stale check is skipped, as a bug would: take_out finds Box short and the whole step rolls back.
    monkeypatch.setattr(trade_inventory, 'stale_pick_trades', lambda conn, owner, trade_ids: set())
    monkeypatch.setattr(test_holdings, 'client', TestClient(app, raise_server_exceptions=False))
    before, counted, revision = revision_of(ash), commands(ash), ok(read(ash, trade))['revision']
    assert confirm(ash, trade).status_code == 500
    assert (revision_of(ash), commands(ash), ok(read(ash, trade))['revision']) == (before, counted, revision)
    assert held(ash, other) == {arven: '2'} and held(ash, unsorted(ash)) == {}
    assert row_of(trade)['recipient_swap_at'] is None and len(trade_picks(trade['id'])) == 2


# Concurrency: steps on one collector's copies wait for each other.


@pytest.mark.parametrize('first', ['ash', 'misty'])
def test_two_confirmations_at_once_finish_the_trade_on_the_retry(store, first):
    ids, ash, misty, binder, box, trade = swapping()
    second = misty if first == 'ash' else ash
    first = ash if first == 'ash' else misty
    revision = trade['revision']
    # Each confirmation takes only its own owner row, so they meet on the Trade row, which the first holds while it
    # sleeps deleting its picks.
    held_ = _sleeping('trade_pick', 'DELETE', f"OLD.owner_id = '{first}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            winner = executor.submit(confirm, first, trade, None, None, revision)
            _asleep(watch, 1, [winner])
            loser = executor.submit(confirm, second, trade, None, None, revision)
            _waiting_on_a_row(watch, [winner, loser])
            winner, loser = winner.result(), loser.result()
    finally:
        held_()
    assert winner.status_code == 200, winner.text
    assert detail(loser) == (409, {'code': 'TRADE_CHANGED'})
    retried = ok(confirm(second, trade))
    assert retried['closed_reason'] == 'swapped' and trade_picks(trade['id']) == []
    assert updates(trade)[-1] == (first, 'swapped', 'Misty W.' if second == misty else 'Ash K.')


@pytest.mark.parametrize('ordered', [True, False])
@pytest.mark.parametrize('first', ['confirm', 'cancel'])
def test_a_confirm_and_a_cancel_run_one_after_the_other(store, first, ordered):
    ids = seed_swap_catalog()
    ash, misty = pair(ordered)
    binder, box = place(misty, 'Trade Binder'), place(ash, 'Box')
    hold(misty, binder, ids['PAL 185'], 3)
    hold(ash, box, ids['SVI 166'], 2)
    ok(mark(misty, binder))
    ok(mark(ash, box))
    trade = ok(accept_trade(ash, proposed(misty, ash, give=[(ids['PAL 185'], 1)], get=[(ids['SVI 166'], 1)])))
    revision = trade['revision']
    steps = {'confirm': lambda: confirm(ash, trade, revision=revision),
             'cancel': lambda: trade_step(misty, trade, 'cancel', revision=revision)}
    # The confirm sleeps deleting Ash's picks; the cancel sleeps deleting the Trade's picks (Misty's first).
    held_ = _sleeping('trade_pick', 'DELETE', f"OLD.owner_id = '{ash}'" if first == 'confirm'
                      else f"OLD.owner_id = '{misty}'")
    second = 'cancel' if first == 'confirm' else 'confirm'
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            winner = executor.submit(steps[first])
            _asleep(watch, 1, [winner])
            loser = executor.submit(steps[second])
            _waiting_on_a_row(watch, [winner, loser])
            winner, loser = winner.result(), loser.result()
    finally:
        held_()
    assert winner.status_code == 200, winner.text
    assert detail(loser) == (409, {'code': 'TRADE_CHANGED'})
    if first == 'confirm':
        assert row_of(trade)['state'] == 'accepted' and row_of(trade)['recipient_swap_at'] is not None
        assert held(ash, box) == {ids['SVI 166']: '1'}
        assert detail(trade_step(misty, ok(read(misty, trade)), 'cancel')) == (409, {'code': 'STEP_NOT_ALLOWED'})
    else:
        assert (row_of(trade)['state'], row_of(trade)['closed_reason']) == ('closed', 'cancelled')
        assert held(ash, box) == {ids['SVI 166']: '2'} and trade_picks(trade['id']) == []


@pytest.mark.parametrize('first', ['move', 'confirm'])
def test_a_confirm_and_a_move_of_a_picked_copy_run_one_after_the_other(store, first):
    ids, ash, misty, binder, box, trade = swapping(give=0, get=2)
    arven = ids['SVI 166']
    other = place(ash, 'Other Box')
    revision = trade['revision']
    manifest = start(ash, box)
    assert stage(ash, manifest, [selected(arven, 2, holding(ash, box, arven)['version'])]).status_code == 200
    steps = {'move': lambda: commit(ash, manifest, other), 'confirm': lambda: confirm(ash, trade, revision=revision)}
    held_ = (_sleeping('holding', 'DELETE', f"OLD.owner_id = '{ash}'") if first == 'move'
             else _sleeping('trade_pick', 'DELETE', f"OLD.owner_id = '{ash}'"))
    second = 'confirm' if first == 'move' else 'move'
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            winner = executor.submit(steps[first])
            _asleep(watch, 1, [winner])
            loser = executor.submit(steps[second])
            _waiting_on_a_row(watch, [winner, loser])
            winner, loser = winner.result(), loser.result()
    finally:
        held_()
    assert winner.status_code == 200, winner.text
    if first == 'move':
        # The Move took the picked copies: the confirm waited and then found its picks out of date.
        assert detail(loser) == (409, {'code': 'PICKS_OUT_OF_DATE'})
        assert held(ash, other) == {arven: '2'} and row_of(trade)['recipient_swap_at'] is None
        ok(use_suggested(ash, trade))
        ok(confirm(ash, trade))
        assert held(ash, other) == {} and row_of(trade)['recipient_swap_at'] is not None
    else:
        # The confirm took them: the Move waited and then found the Holding changed.
        assert code(loser) == (409, 'STALE_HOLDING')
        assert held(ash, box) == {} and held(ash, other) == {}


@pytest.mark.parametrize('first', ['removal', 'confirm'])
def test_a_confirm_and_a_removal_of_the_same_holding_run_one_after_the_other(store, first):
    ids, ash, misty, binder, box, trade = swapping(give=1, get=0)
    iono = ids['PAL 185']
    revision = trade['revision']
    manifest = start(misty, binder)
    assert stage(misty, manifest, [selected(iono, 2, holding(misty, binder, iono)['version'])]).status_code == 200
    steps = {'removal': lambda: call('POST', f'/api/moves/manifests/{manifest}/remove', misty,
                                     {'idempotency_key': str(uuid4())}),
             'confirm': lambda: confirm(misty, trade, revision=revision)}
    held_ = (_sleeping('holding', 'UPDATE', f"OLD.owner_id = '{misty}'") if first == 'removal'
             else _sleeping('trade_pick', 'DELETE', f"OLD.owner_id = '{misty}'"))
    second = 'confirm' if first == 'removal' else 'removal'
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            winner = executor.submit(steps[first])
            _asleep(watch, 1, [winner])
            loser = executor.submit(steps[second])
            _waiting_on_a_row(watch, [winner, loser])
            winner, loser = winner.result(), loser.result()
    finally:
        held_()
    assert winner.status_code == 200, winner.text
    if first == 'removal':
        # The Removal left the promised copy: the confirm then takes it.
        assert loser.status_code == 200, loser.text
        assert held(misty, binder) == {}
    else:
        assert code(loser) == (409, 'STALE_HOLDING')
        assert held(misty, binder) == {iono: '2'}
    assert reserved(misty, iono) == (0, 0)


# Static guards, as test_handover's for Loans.


TRADE_MODULES = ('social/trades.py', 'trade_inventory.py', 'trade_picks.py')


def _string_constants(path):
    """The module's string constants, docstrings left out: its SQL."""
    tree = ast.parse(path.read_text())
    docstrings = {id(node.body[0].value) for node in ast.walk(tree)
                  if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and node.body
                  and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant)}
    return '\n'.join(node.value for node in ast.walk(tree)
                     if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings)


def test_a_trade_step_writes_its_trade_row_once():
    # Only run_trade_step's write_trade writes the row of an existing Trade (Trading #274's end_trades_between will
    # too, once per Trade); a second write would key-share the other side's owner row after the step's own locks.
    app_dir = Path(__file__).resolve().parents[1] / 'app'
    writes = {name: len(re.findall(r'\bUPDATE\s+trade\s', _string_constants(app_dir / name))) for name in TRADE_MODULES}
    assert writes == {'social/trades.py': 1, 'trade_inventory.py': 0, 'trade_picks.py': 0}


def test_no_trade_step_takes_a_lock_that_holds_off_a_foreign_key_check():
    app_dir = Path(__file__).resolve().parents[1] / 'app'
    for name in TRADE_MODULES:
        assert 'FOR UPDATE' not in _string_constants(app_dir / name).replace('FOR NO KEY UPDATE', ''), name
    source = (app_dir / 'trade_inventory.py').read_text()
    assert 'owner_and_rows(' not in source and not re.search(r'\block_owner\(', source)
