"""The Spare Copy rule in one place (social network #245): ``copy_allocation.spare_rule`` and the reserved copies it
takes from ``social.counts.reserved_counts``.

The pure tests pin the arithmetic: a Deck holds the lesser of its line and its Holding for its own line, every other
copy is beyond some line, and copies reserved for open Loans come out of the Spare Copies first and then out of the
copies Decks hold for their own lines. The route tests patch ``reserved_counts`` (nothing is reserved until Loans land,
#252) and check that every caller reads the rule: the Deck figures on every route, the competition warning, the Swap
hint and the copies Replace and import can count.
"""
from uuid import UUID

import pytest

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app import copy_allocation
from app.copy_allocation import held_for_line, spare_rule
from app.social import counts
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, detail, hold, iono_world, line, need, new_owner
from test_holdings import call
from test_want_list import section, want_list
from want_list_swap_fixtures import seed_swap_catalog

A, B, C, LOOSE = (UUID(int=n) for n in (1, 2, 3, 4))


def reserving(monkeypatch, found):
    """Patch ``reserved_counts`` to answer ``found`` ({Edition id: copies}) for the Editions asked about."""
    asked = []

    def reserved_counts(conn, owner_id, edition_ids):
        edition_ids = list(edition_ids)
        asked.append(edition_ids)
        return {edition: copies for edition, copies in found.items() if edition in edition_ids}

    monkeypatch.setattr(counts, 'reserved_counts', reserved_counts)
    return asked


def test_a_deck_holds_the_lesser_of_its_line_and_its_holding_and_the_rest_is_beyond():
    rule = spare_rule({A: 3, B: 1, LOOSE: 2}, {A: 2, B: 4, C: 1})
    assert rule.own == {A: 2, B: 1, C: 0}
    assert rule.beyond == {A: 1, LOOSE: 2}
    assert (rule.total, rule.claimed, rule.unclaimed, rule.spare) == (6, 3, 3, 3)
    assert (rule.reserved, rule.reserved_in_decks, rule.lendable, rule.lendable_in_deck) == (0, 0, 6, 3)


def test_a_deck_holds_for_its_line_at_most_the_line():
    assert [held_for_line(quantity, held) for quantity, held in ((4, 1), (2, 3), (3, 3), (0, 2), (2, 0))] == [1, 2, 3, 0, 0]


def test_nothing_held_or_listed_has_nothing_spare():
    rule = spare_rule({}, {})
    assert (rule.own, rule.beyond, rule.total, rule.spare, rule.lendable) == ({}, {}, 0, 0, 0)
    rule = spare_rule({}, {A: 4})
    assert (rule.own, rule.beyond, rule.spare, rule.lendable) == ({A: 0}, {}, 0, 0)


def test_a_location_with_no_line_is_all_beyond():
    rule = spare_rule({A: 2, LOOSE: 1}, {})
    assert (rule.own, rule.beyond, rule.spare) == ({}, {A: 2, LOOSE: 1}, 3)


def test_reserved_copies_come_out_of_the_spare_copies_first():
    rule = spare_rule({A: 3, LOOSE: 2}, {A: 2}, reserved=2)
    assert (rule.unclaimed, rule.spare, rule.reserved_in_decks) == (3, 1, 0)
    assert (rule.lendable, rule.lendable_in_deck) == (3, 2)
    # The rule never moves a copy: where the copies are is the same with or without a reservation.
    assert rule.own == {A: 2} and rule.beyond == {A: 1, LOOSE: 2}


def test_reserved_copies_beyond_the_spare_ones_come_out_of_the_decks_own_copies():
    rule = spare_rule({A: 3, LOOSE: 2}, {A: 2}, reserved=4)
    assert (rule.spare, rule.reserved_in_decks, rule.lendable, rule.lendable_in_deck) == (0, 1, 1, 1)


def test_every_copy_reserved_leaves_nothing_spare_or_lendable():
    rule = spare_rule({A: 3, LOOSE: 2}, {A: 2}, reserved=5)
    assert (rule.spare, rule.reserved_in_decks, rule.lendable, rule.lendable_in_deck) == (0, 2, 0, 0)


@pytest.mark.parametrize('reserved', range(0, 7))
def test_the_figures_add_up_whatever_is_reserved(reserved):
    rule = spare_rule({A: 3, B: 1, LOOSE: 2}, {A: 2, B: 4}, reserved=reserved)
    assert rule.claimed + rule.unclaimed == rule.total
    assert rule.spare + rule.lendable_in_deck == rule.lendable
    assert min(rule.total, rule.reserved) + rule.lendable == rule.total
    assert rule.spare >= 0 and rule.reserved_in_decks >= 0 and rule.lendable_in_deck >= 0
    assert rule.lendable_in_deck <= rule.claimed


def test_the_stub_reserves_nothing():
    # #252 replaces the stub with the read of open Loan lines and this test with its own.
    with connect() as conn:
        assert counts.reserved_counts(conn, 'nobody', [A, B]) == {}


def test_reserved_copies_leave_the_spare_copies_on_every_deck_route(store, monkeypatch):
    owner, charizard, gardevoir, edition = iono_world(store)
    # Unreserved, Charizard ex takes the loose spare and needs 2; Gardevoir ex needs 2 (test_deck_counting).
    assert (need(owner, charizard), need(owner, gardevoir)) == ("2", "2")
    asked = reserving(monkeypatch, {UUID(edition): 1})
    # The loose copy is reserved, so it is no longer spare: Charizard ex needs 3. Its own copy stays its own.
    assert (need(owner, charizard), need(owner, gardevoir)) == ("3", "2")
    [older] = section(want_list(owner), charizard)["lines"]
    assert (older["held"], older["spare"], older["need"]) == ("1", "0", "3")
    assert asked and all(UUID(edition) in editions for editions in asked)


def test_the_competition_warning_counts_only_unreserved_spare_copies(store, monkeypatch):
    owner, charizard, gardevoir, edition = iono_world(store)
    [warning] = detail(owner, gardevoir)["competition"]
    assert (warning["edition_id"], warning["spare"], warning["counted_elsewhere"]) == (edition, "1", "3")
    reserving(monkeypatch, {UUID(edition): 1})
    [warning] = detail(owner, gardevoir)["competition"]
    assert (warning["spare"], warning["counted_elsewhere"]) == ("0", "3")


def test_a_reserved_copy_is_not_offered_as_a_swap(store, monkeypatch):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    charizard = deck(owner, "Charizard ex", 0)
    line(owner, charizard, ids["PAL 185"], 4)
    hold(owner, unsorted, ids["PAL 254"], 1)
    [entry] = section(want_list(owner), charizard)["lines"]
    assert entry["swap"]["edition_id"] == ids["PAL 254"]
    reserving(monkeypatch, {UUID(ids["PAL 254"]): 1})
    [entry] = section(want_list(owner), charizard)["lines"]
    assert entry["swap"] is None


def test_replace_and_import_count_only_unreserved_spare_copies(store, monkeypatch):
    owner, charizard, gardevoir, edition = iono_world(store)
    [unsorted] = [location["id"] for location in call("GET", "/api/location-tree", owner).json()["locations"]
                  if location["name"] == "Unsorted"]
    key = UUID(edition)

    def elsewhere():
        with connect() as conn:
            found = copy_allocation.available_to(conn, owner, [key], 'one_at_a_time')
        return [(str(location), copies) for location, copies in found.editions[key].elsewhere]

    # One Deck at a time, a new Deck can count the loose copy and the copy Charizard ex holds for its line.
    assert elsewhere() == [(unsorted, 1), (charizard, 1)]
    reserving(monkeypatch, {key: 1})
    # The loose copy is reserved; the Deck's own copy still counts until handover.
    assert elsewhere() == [(charizard, 1)]
