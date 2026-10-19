"""The pure allocation, ``copy_allocation.allocate_rows``, over hand-built ``AllocationRows`` (trading #265).

``allocate`` is ``allocate_rows`` over ``read_allocation_rows``; the Want List, Deck counting, cost, Swap hint and import
tests prove the two together give every figure they gave before the split. These tests need no database: they pin the
counting itself from rows written by hand. One Deck counts its own copies, then Spare Copies; two Decks short of one
Spare Copy leave it to the older Deck (by ``created_at``, never by id) under Every Deck built at once and both count it
under One Deck at a time; lent copies count for the Deck they were picked from first; Borrowed Copies fill their own
Deck's line and no other; reserved copies are placed at their picks, so One Deck at a time counts other Decks' unpicked
copies. Rows of Editions or Decks the call isn't about take no part, and the rows are never changed.
"""
import copy
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.copy_allocation import AllocationRows, allocate_rows

E, F = UUID(int=101), UUID(int=102)                       # Card Editions
# Decks: OLD is the oldest but has the larger id, so a test that passes orders by age, not by id.
NEW, OLD, MID, OTHER = (UUID(int=n) for n in (1, 2, 3, 4))
LOOSE = UUID(int=10)                                      # a Location that isn't a Deck
T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
CREATED = {OLD: T0, MID: T0 + timedelta(days=1), NEW: T0 + timedelta(days=2), OTHER: T0 + timedelta(days=3)}
SETTINGS = ('all_at_once', 'one_at_a_time')


def rows(holdings=(), lines=(), **inputs) -> AllocationRows:
    """Rows of (place, Edition, copies) Holdings and (Deck, Edition, quantity) lines, every Deck with its creation time."""
    return AllocationRows(holdings=tuple(holdings), lines=tuple(lines), deck_created=dict(CREATED), **inputs)


def figures(allocation) -> dict:
    """(Deck, Edition) -> (held, borrowed, spare, other_decks, lent, need), after checking every line adds up."""
    for line in allocation.lines.values():
        assert line.held + line.borrowed + line.spare + line.other_decks + line.lent + line.need == line.quantity
    return {key: (line.held, line.borrowed, line.spare, line.other_decks, line.lent, line.need)
            for key, line in allocation.lines.items()}


@pytest.mark.parametrize('counting', SETTINGS)
def test_one_deck_counts_its_own_copies_then_the_spare_copies(counting):
    found = allocate_rows(rows([(OLD, E, 2), (LOOSE, E, 1)], [(OLD, E, 4)]), [E], counting)
    assert figures(found) == {(OLD, E): (2, 0, 1, 0, 0, 1)}
    assert found.counting == counting and found.order == (OLD,)
    assert found.owned == {E: 3} and found.places == {E: {OLD: 2, LOOSE: 1}}
    assert (found.copies[E].own, found.copies[E].spare) == ({OLD: 2}, 1)


def test_two_decks_short_of_one_spare_copy_leave_it_to_the_older_deck_under_every_deck_built_at_once():
    # NEW's line comes first in the rows and NEW has the smaller id: only age decides.
    found = allocate_rows(rows([(LOOSE, E, 1)], [(NEW, E, 1), (OLD, E, 1)]), [E], 'all_at_once')
    assert found.order == (OLD, NEW)
    assert figures(found) == {(NEW, E): (0, 0, 0, 0, 0, 1), (OLD, E): (0, 0, 1, 0, 0, 0)}


def test_two_decks_short_of_one_spare_copy_both_count_it_under_one_deck_at_a_time():
    found = allocate_rows(rows([(LOOSE, E, 1)], [(NEW, E, 1), (OLD, E, 1)]), [E], 'one_at_a_time')
    assert found.order == (OLD, NEW)
    assert figures(found) == {(NEW, E): (0, 0, 1, 0, 0, 0), (OLD, E): (0, 0, 1, 0, 0, 0)}


@pytest.mark.parametrize('counting, new_line, from_decks', [
    ('all_at_once', (0, 0, 0, 0, 0, 2), ()),
    ('one_at_a_time', (0, 0, 0, 2, 0, 0), ((OLD, 2),)),
])
def test_another_decks_own_copies_count_only_under_one_deck_at_a_time(counting, new_line, from_decks):
    found = allocate_rows(rows([(OLD, E, 2)], [(OLD, E, 2), (NEW, E, 2)]), [E], counting)
    assert figures(found) == {(OLD, E): (2, 0, 0, 0, 0, 0), (NEW, E): new_line}
    assert found.line(NEW, E).from_decks == from_decks and found.line(OLD, E).from_decks == ()


@pytest.mark.parametrize('counting, lent_at, old_line, new_line', [
    # Picked from OLD: that copy counts for OLD first; the loose one is a pool, oldest Deck first.
    ('all_at_once', {OLD: 1, LOOSE: 1}, (1, 0, 0, 0, 2, 0), (0, 0, 0, 0, 0, 1)),
    # Under One Deck at a time NEW counts OLD's own copy before any lent one.
    ('one_at_a_time', {OLD: 1, LOOSE: 1}, (1, 0, 0, 0, 2, 0), (0, 0, 0, 1, 0, 0)),
    # Picked from NEW: that copy counts for NEW, and only the loose one is left for OLD.
    ('all_at_once', {NEW: 1, LOOSE: 1}, (1, 0, 0, 0, 1, 1), (0, 0, 0, 0, 1, 0)),
])
def test_lent_copies_count_for_the_deck_they_were_picked_from_first_then_as_spare_copies_go(
        counting, lent_at, old_line, new_line):
    found = allocate_rows(rows([(OLD, E, 1)], [(OLD, E, 3), (NEW, E, 1)], lent={E: 2}, lent_at={E: lent_at}),
                          [E], counting)
    assert figures(found) == {(OLD, E): old_line, (NEW, E): new_line}
    # Lent copies are in no Holding: they are never owned or spare.
    assert found.owned == {E: 1} and found.copies[E].spare == 0


@pytest.mark.parametrize('counting, old_line, new_line', [
    ('all_at_once', (0, 0, 0, 0, 1, 0), (0, 0, 0, 0, 0, 1)),
    ('one_at_a_time', (0, 0, 0, 0, 1, 0), (0, 0, 0, 0, 1, 0)),
])
def test_lent_copies_picked_from_no_line_go_to_the_older_deck_or_to_every_deck(counting, old_line, new_line):
    found = allocate_rows(rows([], [(NEW, E, 1), (OLD, E, 1)], lent={E: 1}, lent_at={E: {LOOSE: 1}}), [E], counting)
    assert figures(found) == {(OLD, E): old_line, (NEW, E): new_line}
    assert found.owned == {} and found.places == {}


@pytest.mark.parametrize('counting, new_line, from_decks', [
    ('all_at_once', (0, 0, 1, 0, 0, 1), ()),
    ('one_at_a_time', (0, 0, 1, 1, 0, 0), ((OLD, 1),)),
])
def test_borrowed_copies_fill_their_own_decks_line_and_no_other(counting, new_line, from_decks):
    # OLD holds 1 of its 3 and has 3 Borrowed Copies in it: two fill its line, the third is no one's Spare Copy.
    found = allocate_rows(rows([(OLD, E, 1), (LOOSE, E, 1)], [(OLD, E, 3), (NEW, E, 2)], borrowed={(OLD, E): 3}),
                          [E], counting)
    assert figures(found) == {(OLD, E): (1, 2, 0, 0, 0, 0), (NEW, E): new_line}
    assert found.line(NEW, E).from_decks == from_decks
    assert found.owned == {E: 2} and found.copies[E].spare == 1


@pytest.mark.parametrize('counting', SETTINGS)
def test_reserved_copies_come_out_of_the_spare_copies_first(counting):
    found = allocate_rows(rows([(LOOSE, E, 2)], [(OLD, E, 2)], reserved={E: 1}, picked={E: {LOOSE: 1}}),
                          [E], counting)
    assert figures(found) == {(OLD, E): (0, 0, 1, 0, 0, 1)}
    assert (found.copies[E].spare, found.copies[E].reserved_beyond) == (1, {LOOSE: 1})


@pytest.mark.parametrize('picked, reserved_own, from_decks', [
    # No picks: the reserved copy goes to the Deck holding the most for its line, the id breaking the tie (OLD).
    ({}, {OLD: 1}, ((OLD, 1), (MID, 1))),
    # A pick in MID places it there, so NEW counts both of OLD's copies.
    ({MID: 1}, {MID: 1}, ((OLD, 2),)),
])
def test_reserved_copies_are_placed_at_their_picks_and_one_deck_at_a_time_counts_only_the_unpicked_ones(
        picked, reserved_own, from_decks):
    inputs = rows([(OLD, E, 2), (MID, E, 2)], [(OLD, E, 2), (MID, E, 2), (NEW, E, 2)],
                  reserved={E: 1}, picked={E: picked})
    found = allocate_rows(inputs, [E], 'one_at_a_time')
    assert found.copies[E].reserved_own == reserved_own
    # A reserved copy stays in its Deck and keeps counting for that Deck's own line.
    assert figures(found) == {(OLD, E): (2, 0, 0, 0, 0, 0), (MID, E): (2, 0, 0, 0, 0, 0), (NEW, E): (0, 0, 0, 2, 0, 0)}
    assert found.line(NEW, E).from_decks == from_decks
    # Every Deck built at once never counts another Deck's own copies, picked or not.
    assert figures(allocate_rows(inputs, [E], 'all_at_once'))[(NEW, E)] == (0, 0, 0, 0, 0, 2)


@pytest.mark.parametrize('counting', SETTINGS)
def test_rows_of_other_editions_and_decks_take_no_part(counting):
    # OTHER lists only F, and F's copies and Loans are in the rows too; the call is about E alone.
    inputs = rows([(OLD, E, 1), (LOOSE, E, 1), (LOOSE, F, 3), (OTHER, F, 1)],
                  [(OLD, E, 2), (OTHER, F, 4), (OLD, F, 1)],
                  reserved={F: 1}, picked={F: {LOOSE: 1}}, lent={F: 1}, lent_at={F: {OTHER: 1}},
                  borrowed={(OTHER, F): 1})
    found = allocate_rows(inputs, [E], counting)
    assert figures(found) == {(OLD, E): (1, 0, 1, 0, 0, 0)}
    assert found.order == (OLD,)
    assert (found.owned, found.places, set(found.copies)) == ({E: 2}, {E: {OLD: 1, LOOSE: 1}}, {E})


def test_no_editions_count_nothing_whatever_the_rows():
    found = allocate_rows(rows([(OLD, E, 1)], [(OLD, E, 2)]), [], 'all_at_once')
    assert (found.lines, found.order, found.owned, found.places, found.copies) == ({}, (), {}, {}, {})


@pytest.mark.parametrize('counting', SETTINGS)
def test_the_rows_are_never_changed(counting):
    inputs = rows([(OLD, E, 2), (MID, E, 2), (LOOSE, E, 1)], [(NEW, E, 3), (MID, E, 2), (OLD, E, 2)],
                  reserved={E: 1}, picked={E: {MID: 1}}, lent={E: 1}, lent_at={E: {NEW: 1}}, borrowed={(NEW, E): 1})
    before = copy.deepcopy(inputs)
    first = allocate_rows(inputs, [E], counting)
    assert inputs == before
    assert allocate_rows(inputs, [E], counting) == first
