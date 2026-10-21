"""Deck switches at Confirm swap (Trading #279), through signed HTTP against PostgreSQL, modelled on
``test_trade_swap.py`` and ``test_want_list_swap.py``.

A card the collector gets only through a widened Will accept rule for one of their Decks' wants can switch that Deck's
line to the received card: ``GET /api/trades/{id}/side`` offers the switches, ``POST /api/trades/{id}/confirm-swap``
applies the ones left ticked in the same transaction as Deck List changes (``decks.write_deck_list``) and answers each
switched Deck's new revision with the inverse batch that undoes it. A refusal at any point changes nothing.

In these tests A is PAL 254 (the wanted Edition) and B is PAL 185 (the received one, the same Card Identity), so
``identity`` on A accepts B.
"""
import os
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from test_batch_add import batch as add_batch, undo, undo_records
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import counting, deck, detail as deck_detail, hold, line
from test_for_trade_locations import deck_in, hide
from test_friend_copies import ok, place
from test_handover import whole_collection
from test_holdings import call
from test_loans import revision_of
from test_trade_swap import code, getting_iono, held, section_lines, unsorted
from test_trade_wants import lines_of, set_rule, set_want, wants
from test_trades import accept_trade, commands, proposed, read, row_of, trading
from test_want_list import want_list
from test_want_list_swap import batch, deck_list
from want_list_swap_fixtures import seed_swap_catalog  # noqa: F401


def side(user, trade, destination=None):
    suffix = f'?destination_id={destination}' if destination else ''
    return ok(call('GET', f"/api/trades/{trade['id']}/side{suffix}", user))


def switch_body(switch):
    if isinstance(switch, dict):
        return {key: switch[key] for key in ('deck_id', 'from_edition_id', 'to_edition_id', 'count')}
    deck_id, from_edition, to_edition, count = switch
    return {'deck_id': deck_id, 'from_edition_id': from_edition, 'to_edition_id': to_edition, 'count': count}


def confirm(user, trade, destination=None, switches=(), key=None, revision=None):
    """``user``'s Confirm swap with the given switches (offers from ``side`` or 4-tuples), on the revision they read now
    unless ``revision`` says otherwise."""
    return call('POST', f"/api/trades/{trade['id']}/confirm-swap", user,
                {'revision': revision or ok(read(user, trade))['revision'], 'idempotency_key': str(key or uuid4()),
                 'destination_id': destination, 'deck_switches': [switch_body(item) for item in switches]})


def offers(body):
    return [(o['deck_id'], o['from_edition_id'], o['to_edition_id'], o['count']) for o in body['deck_switches']]


def identity_deck(ash, ids, quantity=1, name='Ladder', days=None):
    """A Deck listing PAL 254 x ``quantity``, with Ash's Will accept rule ``identity`` on PAL 254. With ``days``, the
    Deck is dated through ``deck``."""
    ladder = deck_in(ash, name) if days is None else deck(ash, name, days)
    line(ash, ladder, ids['PAL 254'], quantity)
    ok(set_rule(ash, ids['PAL 254'], 'identity'))
    return ladder


def ladder_setup(get=1):
    """``getting_iono(get)`` with Ladder listing A x1 under ``identity``. Returns (ids, ash, misty, ladder, trade)."""
    ids, ash, misty, box, trade = getting_iono(get)
    return ids, ash, misty, identity_deck(ash, ids), trade


def by_edition(lines):
    return sorted(lines, key=lambda item: item['edition_id'])


def test_a_ticked_switch_moves_the_deck_line_and_the_need_goes(store):
    ids, ash, misty, ladder, trade = ladder_setup()
    a, b = ids['PAL 254'], ids['PAL 185']
    ok(set_want(ash, ids['PAF 80'], 1))
    body = side(ash, trade)
    assert offers(body) == [(ladder, a, b, '1')]
    [offer] = body['deck_switches']
    assert offer['deck_name'] == 'Ladder'
    assert offer['from_card']['collector_number'] == '254' and offer['to_card']['collector_number'] == '185'
    assert offer['to_card']['set_code'] == 'PAL'
    answer = ok(confirm(ash, trade, switches=body['deck_switches']))
    revision, lines = deck_list(ash, ladder)
    assert lines == {b: '1'}
    assert answer['switched_decks'] == [{'deck_id': ladder, 'revision': revision, 'undo': by_edition(
        [{'edition_id': a, 'quantity': '1'}, {'edition_id': b, 'quantity': '0'}])}]
    assert not [entry for entry in section_lines(want_list(ash), ladder) if entry['edition_id'] == a]
    assert lines_of(wants(ash)) == [(ids['PAF 80'], '1')]
    assert held(ash, unsorted(ash)) == {b: '1'}


def test_an_unticked_switch_leaves_the_deck_list_alone(store):
    ids, ash, misty, ladder, trade = ladder_setup()
    a = ids['PAL 254']
    before = deck_list(ash, ladder)
    answer = ok(confirm(ash, trade))
    assert answer['switched_decks'] == []
    assert deck_list(ash, ladder) == before and before[1] == {a: '1'}
    [needed] = section_lines(want_list(ash), ladder)
    assert (needed['edition_id'], needed['need']) == (a, '1')


def test_a_stale_switch_gives_deck_switch_changed_and_changes_nothing(store):
    for case in ('too_many', 'unknown_deck', 'swapped', 'covered', 'line_gone'):
        ids, ash, misty, ladder, trade = ladder_setup()
        a, b = ids['PAL 254'], ids['PAL 185']
        [offer] = side(ash, trade)['deck_switches']
        switch = switch_body(offer)
        if case == 'too_many':
            switch['count'] = '2'
        elif case == 'unknown_deck':
            switch['deck_id'] = str(uuid4())
        elif case == 'swapped':
            switch['from_edition_id'], switch['to_edition_id'] = b, a
        elif case == 'covered':
            hold(ash, unsorted(ash), a, 1)
        else:
            line(ash, ladder, a, 0)
        collection, inventory, revision = whole_collection(ash), revision_of(ash), ok(read(ash, trade))['revision']
        ladder_list, theirs = deck_list(ash, ladder), whole_collection(misty)
        assert code(confirm(ash, trade, switches=[switch])) == (409, 'DECK_SWITCH_CHANGED'), case
        assert whole_collection(ash) == collection and revision_of(ash) == inventory, case
        assert row_of(trade)['recipient_swap_at'] is None, case
        assert ok(read(ash, trade))['revision'] == revision, case
        assert deck_list(ash, ladder) == ladder_list and whole_collection(misty) == theirs, case


@pytest.mark.parametrize('setting', ['all_at_once', 'one_at_a_time'])
def test_a_switch_never_exceeds_the_lines_need_and_fills_decks_oldest_first(store, setting):
    def setup():
        ids, ash, misty, box, trade = getting_iono(3)
        counting(ash, setting)
        old, new = deck(ash, 'Old', 0), deck(ash, 'New', 1)
        line(ash, old, ids['PAL 254'], 1)
        line(ash, new, ids['PAL 254'], 4)
        ok(set_rule(ash, ids['PAL 254'], 'identity'))
        return ids, ash, trade, old, new

    ids, ash, trade, old, new = setup()
    a, b = ids['PAL 254'], ids['PAL 185']
    body = side(ash, trade)
    assert offers(body) == [(old, a, b, '1'), (new, a, b, '2')]
    ok(confirm(ash, trade, switches=body['deck_switches']))
    assert deck_list(ash, old)[1] == {b: '1'} and deck_list(ash, new)[1] == {a: '2', b: '2'}
    ids, ash, trade, old, new = setup()
    a, b = ids['PAL 254'], ids['PAL 185']
    assert code(confirm(ash, trade, switches=[(new, a, b, '3')])) == (409, 'DECK_SWITCH_CHANGED')


def test_copies_the_decks_or_trade_wants_need_of_the_received_card_are_never_switched(store):
    def setup(wanted):
        ids, ash, misty, box, trade = getting_iono(3)
        exact, wanting = deck(ash, 'Exact', 0), deck(ash, 'Wanting', 1)
        line(ash, exact, ids['PAL 185'], 1)
        line(ash, wanting, ids['PAL 254'], 5)
        ok(set_rule(ash, ids['PAL 254'], 'identity'))
        ok(set_want(ash, ids['PAL 185'], wanted))
        return ids, ash, trade, exact, wanting

    ids, ash, trade, exact, wanting = setup(1)
    a, b = ids['PAL 254'], ids['PAL 185']
    body = side(ash, trade)
    assert offers(body) == [(wanting, a, b, '1')]
    ok(confirm(ash, trade, switches=body['deck_switches']))
    assert deck_list(ash, exact)[1] == {b: '1'} and deck_list(ash, wanting)[1] == {a: '4', b: '1'}
    assert b not in [edition for edition, _ in lines_of(wants(ash))]
    ids, ash, trade, exact, wanting = setup(2)
    assert offers(side(ash, trade)) == []


def test_only_the_switched_decks_lists_move_and_no_inventory_undo_is_written(store):
    ids, ash, misty, ladder, trade = ladder_setup()
    a, b = ids['PAL 254'], ids['PAL 185']
    other = deck_in(ash, 'Other')
    line(ash, other, ids['SVI 166 Reverse Holo'], 1)
    shelf = place(ash, 'Shelf')
    ok(add_batch(ash, shelf, [(ids['PAF 80'], '1')]))
    records = undo_records(ash)
    assert records
    other_before, ladder_before, inventory = deck_list(ash, other), deck_list(ash, ladder), revision_of(ash)
    answer = ok(confirm(ash, trade, switches=side(ash, trade)['deck_switches']))
    [switched] = answer['switched_decks']
    assert deck_list(ash, other) == other_before
    assert deck_list(ash, ladder)[0] == switched['revision'] > ladder_before[0]
    assert undo_records(ash) == records and revision_of(ash) == inventory + 1
    ok(undo(ash, records[0]['id']))
    assert held(ash, shelf) == {} and deck_list(ash, ladder)[1] == {b: '1'}


def test_the_deck_builders_inverse_batch_undoes_a_switch_and_is_refused_once_the_list_changed(store):
    ids, ash, misty, ladder, trade = ladder_setup()
    a, b = ids['PAL 254'], ids['PAL 185']
    [switched] = ok(confirm(ash, trade, switches=side(ash, trade)['deck_switches']))['switched_decks']
    changes = [(item['edition_id'], item['quantity']) for item in switched['undo']]
    ok(batch(ash, ladder, switched['revision'], changes))
    assert deck_list(ash, ladder)[1] == {a: '1'}
    ids, ash, misty, ladder, trade = ladder_setup()
    [switched] = ok(confirm(ash, trade, switches=side(ash, trade)['deck_switches']))['switched_decks']
    line(ash, ladder, ids['PAF 80'], 1)
    after = deck_list(ash, ladder)
    changes = [(item['edition_id'], item['quantity']) for item in switched['undo']]
    assert code(batch(ash, ladder, switched['revision'], changes)) == (409, 'STALE_DECK_LIST')
    assert deck_list(ash, ladder) == after


def test_a_destination_that_is_the_switched_deck_is_not_counted_twice(store):
    ids, ash, misty, ladder, trade = ladder_setup()
    a, b = ids['PAL 254'], ids['PAL 185']
    body = side(ash, trade, destination=ladder)
    assert offers(body) == [(ladder, a, b, '1')]
    answer = ok(confirm(ash, trade, destination=ladder, switches=body['deck_switches']))
    [switched] = answer['switched_decks']
    assert deck_list(ash, ladder)[1] == {b: '1'} and held(ash, ladder) == {b: '1'}
    assert switched['undo'] == [{'edition_id': a, 'quantity': '1'}]
    ok(batch(ash, ladder, switched['revision'], [(a, '1')]))
    assert deck_list(ash, ladder)[1] == {a: '1', b: '1'}


def test_copies_sent_to_a_deck_are_offered_for_that_deck_only(store):
    ids, ash, misty, box, trade = getting_iono(1)
    a, b = ids['PAL 254'], ids['PAL 185']
    old, new = identity_deck(ash, ids, name='Old', days=0), identity_deck(ash, ids, name='New', days=1)
    assert offers(side(ash, trade)) == [(old, a, b, '1')]
    assert offers(side(ash, trade, destination=new)) == [(new, a, b, '1')]
    assert offers(side(ash, trade, destination=place(ash, 'Shelf'))) == [(old, a, b, '1')]
    assert code(confirm(ash, trade, destination=new, switches=[(old, a, b, '1')])) == (409, 'DECK_SWITCH_CHANGED')


def test_switches_in_one_deck_that_share_a_card_fold_together_and_hidden_decks_count(store):
    ids, ash, misty, ladder, trade = ladder_setup(2)
    a, b, c = ids['PAL 254'], ids['PAL 185'], ids['PAF 80']
    line(ash, ladder, c, 1)
    ok(set_rule(ash, c, 'identity'))
    hide(ash, ladder)
    body = side(ash, trade)
    expected = [(ladder, from_edition, b, '1') for from_edition in sorted((a, c), key=str)]
    assert offers(body) == expected
    [switched] = ok(confirm(ash, trade, switches=body['deck_switches']))['switched_decks']
    assert deck_list(ash, ladder)[1] == {b: '2'}
    assert switched['deck_id'] == ladder
    assert switched['undo'] == by_edition([{'edition_id': a, 'quantity': '1'}, {'edition_id': c, 'quantity': '1'},
                                           {'edition_id': b, 'quantity': '0'}])


def test_a_switch_targets_only_an_edition_that_may_start_a_line_unless_the_deck_lists_it(store):
    def activate(edition, active):
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            conn.execute("""UPDATE catalog_generation_edition SET active=%s WHERE edition_id=%s AND generation_id=
              (SELECT active_generation FROM catalog_state WHERE singleton)""", (active, edition))

    ids, ash, misty, ladder, trade = ladder_setup(2)
    a, b = ids['PAL 254'], ids['PAL 185']
    activate(b, False)
    try:
        assert offers(side(ash, trade)) == []
    finally:
        activate(b, True)
    ids, ash, misty, ladder, trade = ladder_setup(2)
    a, b = ids['PAL 254'], ids['PAL 185']
    line(ash, ladder, b, 1)
    activate(b, False)
    try:
        body = side(ash, trade)
        assert offers(body) == [(ladder, a, b, '1')]
        ok(confirm(ash, trade, switches=body['deck_switches']))
        assert deck_list(ash, ladder)[1] == {b: '2'}
    finally:
        activate(b, True)


def test_the_side_read_offers_switches_only_while_the_reader_has_to_confirm(store):
    ids, ash, misty, binder, box = trading()
    a, b = ids['PAL 254'], ids['PAL 185']
    ladder = identity_deck(ash, ids)
    trade = proposed(misty, ash, give=[(b, 1)], get=[(ids['SVI 166'], 1)])
    assert side(ash, trade)['deck_switches'] == []
    trade = ok(accept_trade(ash, trade))
    body = side(ash, trade)
    assert offers(body) == [(ladder, a, b, '1')]
    assert side(misty, trade)['deck_switches'] == []
    ok(confirm(ash, trade))
    assert side(ash, trade)['deck_switches'] == []
    for text in (read(ash, trade).text, read(misty, trade).text, call('GET', '/api/social/trades', ash).text,
                 call('GET', '/api/social/trades', misty).text):
        assert 'deck_switches' not in text and 'switched_decks' not in text and 'Ladder' not in text


def test_deck_switch_lists_are_capped_and_checked_before_anything_is_read(store):
    ids, ash, misty, ladder, trade = ladder_setup()
    a, b = ids['PAL 254'], ids['PAL 185']
    triple = (str(uuid4()), a, b)
    cases = [([(*triple, '0')], 'INVALID_QUANTITY'), ([(*triple, 'x')], 'INVALID_QUANTITY'),
             ([(*triple, '10000')], 'INVALID_QUANTITY'), ([(*triple, '1'), (*triple, '1')], 'DUPLICATE_EDITION'),
             ([(str(uuid4()), a, b, '1') for _ in range(51)], 'TOO_MANY_LINES'),
             ([(str(uuid4()), a, b, '1') for _ in range(50)] + [(str(uuid4()), a, b, 'x')], 'INVALID_QUANTITY')]
    sent, collection, row = commands(ash), whole_collection(ash), row_of(trade)
    for switches, expected in cases:
        assert code(confirm(ash, trade, switches=switches)) == (422, expected), switches
    assert commands(ash) == sent and row_of(trade) == row and whole_collection(ash) == collection


def test_a_confirm_with_switches_replayed_with_its_key_answers_the_same_and_switches_once(store):
    ids, ash, misty, ladder, trade = ladder_setup()
    body, key = side(ash, trade), uuid4()
    revision = ok(read(ash, trade))['revision']
    first = ok(confirm(ash, trade, switches=body['deck_switches'], key=key, revision=revision))
    after = deck_list(ash, ladder)
    second = ok(confirm(ash, trade, switches=body['deck_switches'], key=key, revision=revision))
    assert first == second and first['switched_decks'] and deck_list(ash, ladder) == after
    assert code(confirm(ash, trade, key=key, revision=revision)) == (409, 'IDEMPOTENCY_KEY_REUSED')


def test_a_received_copy_of_the_wanted_card_itself_fills_its_line_before_any_switch(store):
    ids, ash, misty, binder, box = trading()
    a, b = ids['PAL 254'], ids['PAL 185']
    hold(misty, binder, a, 1)
    trade = ok(accept_trade(ash, proposed(misty, ash, give=[(a, 1), (b, 1)], get=[(ids['SVI 166'], 1)])))
    ladder = identity_deck(ash, ids, quantity=2)
    body = side(ash, trade)
    assert offers(body) == [(ladder, a, b, '1')]
    ok(confirm(ash, trade, switches=body['deck_switches']))
    assert deck_list(ash, ladder)[1] == {a: '1', b: '1'}


def test_a_destination_deck_whose_line_the_arrival_did_not_raise_still_gains_the_switched_copies(store):
    """The switch's max rule: a spare B outside any Deck covers Ladder's B line, so the arriving B raises nothing
    (migration 115) and the switch must still raise the line to its total before the swap plus the copies switched."""
    ids, ash, misty, ladder, trade = ladder_setup()
    a, b = ids['PAL 254'], ids['PAL 185']
    line(ash, ladder, b, 1)
    hold(ash, unsorted(ash), b, 1)
    body = side(ash, trade, destination=ladder)
    assert offers(body) == [(ladder, a, b, '1')]
    [switched] = ok(confirm(ash, trade, destination=ladder, switches=body['deck_switches']))['switched_decks']
    assert deck_list(ash, ladder)[1] == {b: '2'}
    assert switched['undo'] == by_edition([{'edition_id': a, 'quantity': '1'}, {'edition_id': b, 'quantity': '1'}])
