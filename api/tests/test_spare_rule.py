"""The Spare Copy rule in one place (social network #245): ``copy_allocation.spare_rule`` and the reserved copies it
takes from ``social.counts.reserved_counts``.

The pure tests pin the arithmetic: a Deck holds the lesser of its line and its Holding for its own line, every other
copy is beyond some line, and copies reserved for open Loans come out of the Spare Copies first and then out of the
copies Decks hold for their own lines, placed at the Loan Pick List's picks first. Some route tests patch
``reserved_counts`` and check that every caller reads the rule: the Deck figures on every route, the competition
warning, the Swap hint and the copies Replace and import can count. Others make real Loans (#252) and check that the
copies a Loan picked are the ones left out: Use cards I own, One Deck at a time's count of other Decks' copies, the Swap
hint and Gather's suggestion, even after the copies a pick names moved away.
"""
from uuid import UUID, uuid4

import pytest

from app.main import connect  # noqa: F401
from app import copy_allocation
from app.copy_allocation import held_for_line, spare_rule
from app.social import counts
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import counting, deck, detail, hold, iono_world, line, need, new_owner
from test_friend_copies import befriend, collector, ok
from test_holdings import call
from test_loan_promises import holding
from test_loans import accept, sent, view
from test_moves import commit, selected, stage, start
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


def test_nothing_is_reserved_without_an_open_loan():
    # The read of open Loan lines (#252); test_loan_promises covers what Loans reserve.
    with connect() as conn:
        assert counts.reserved_counts(conn, 'nobody', [A, B]) == {}
        assert counts.reserved_by_owner(conn, ['nobody'], None) == {} and counts.reserved_picks(conn, 'nobody', [A]) == {}


def test_reserved_copies_are_placed_at_the_picked_locations_first_then_the_largest_holdings():
    # No picks: the reserved count goes to the largest copies beyond a line first, as the Loan Pick List takes them.
    rule = spare_rule({A: 3, LOOSE: 2}, {A: 2}, reserved=2)
    assert (rule.reserved_beyond, rule.reserved_own) == ({LOOSE: 2}, {})
    # Picks first: one beyond the Deck's line and two loose; the fourth copy is one the Deck holds for its line.
    rule = spare_rule({A: 3, LOOSE: 2}, {A: 2}, reserved=4, picked={A: 3, LOOSE: 1})
    assert (rule.reserved_beyond, rule.reserved_own) == ({A: 1, LOOSE: 2}, {A: 1})
    # A pick in one Deck places that Deck's own copies, not another's.
    rule = spare_rule({A: 3, B: 2, LOOSE: 2}, {A: 2, B: 2}, reserved=5, picked={B: 2, LOOSE: 2, A: 1})
    assert (rule.reserved_beyond, rule.reserved_own) == ({LOOSE: 2, A: 1}, {B: 2})
    # A pick whose Location is gone (None) or out of date never places more than is there.
    rule = spare_rule({LOOSE: 1}, {}, reserved=1, picked={None: 1, A: 4})
    assert (rule.reserved_beyond, rule.reserved_own) == ({LOOSE: 1}, {})


@pytest.mark.parametrize('reserved', range(0, 8))
def test_the_placed_copies_add_up_to_the_counts_whatever_the_picks(reserved):
    for picked in ({}, {A: 3}, {B: 1, LOOSE: 2}, {None: 2, C: 1}):
        rule = spare_rule({A: 3, B: 1, LOOSE: 2}, {A: 2, B: 4}, reserved=min(reserved, 6), picked=picked)
        assert sum(rule.reserved_beyond.values()) == rule.reserved - rule.reserved_in_decks
        assert sum(rule.reserved_own.values()) == rule.reserved_in_decks
        assert sum(rule.beyond[place] - rule.reserved_beyond.get(place, 0) for place in rule.beyond) == rule.spare
        assert all(rule.reserved_own[deck] <= rule.own[deck] for deck in rule.reserved_own)


def promise(owner, edition, copies):
    """A Friend of the owner asks for ``copies`` of the Edition and the owner accepts: a real reservation."""
    borrower, _ = collector()
    befriend(borrower, owner)
    ok(accept(owner, view(owner, sent(borrower, owner, [(edition, copies)])), [(edition, copies)]))
    return borrower


def test_use_cards_i_own_never_offers_the_copies_a_loan_picked(store):
    owner, charizard, gardevoir, edition = iono_world(store)
    [unsorted] = [location["id"] for location in call("GET", "/api/location-tree", owner).json()["locations"]
                  if location["name"] == "Unsorted"]
    binder = call("POST", "/api/location-tree", owner, {"name": "Binder", "idempotency_key": str(uuid4())}).json()[
        "location"]["id"]
    hold(owner, binder, edition, 1)
    key = UUID(edition)

    def elsewhere():
        with connect() as conn:
            found = copy_allocation.available_to(conn, owner, [key], 'one_at_a_time')
        return [(str(location), copies) for location, copies in found.editions[key].elsewhere]

    assert elsewhere() == [(binder, 1), (unsorted, 1), (charizard, 1)]
    # The Loan Pick List takes Binder's copy (the first by name of two the same size); the offer leaves exactly it.
    promise(owner, edition, 1)
    assert elsewhere() == [(unsorted, 1), (charizard, 1)]


def test_one_deck_at_a_time_never_counts_another_decks_reserved_copies(store):
    owner, charizard, gardevoir, edition = iono_world(store)
    counting(owner, "one_at_a_time")
    # Unreserved: Charizard ex counts the loose copy and needs 2; Gardevoir ex counts it and Charizard ex's own copy.
    assert (need(owner, charizard), need(owner, gardevoir)) == ("2", "0")
    # Both copies promised: the loose one, then the one Charizard ex holds for its line, which it still counts.
    promise(owner, edition, 2)
    assert (need(owner, charizard), need(owner, gardevoir)) == ("3", "2")
    [line_count] = section(want_list(owner), gardevoir)["lines"]
    assert (line_count["held"], line_count["spare"], line_count["other_decks"], line_count["need"]) == ("0", "0", "0", "2")
    with connect() as conn:
        found = copy_allocation.available_to(conn, owner, [UUID(edition)], 'one_at_a_time')
    assert found.editions[UUID(edition)].elsewhere == ()


def test_a_reserved_copy_is_not_offered_as_a_swap_one_deck_at_a_time(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    charizard = deck(owner, "Charizard ex", 0)
    line(owner, charizard, ids["PAL 185"], 4)
    hold(owner, unsorted, ids["PAL 254"], 1)
    counting(owner, "one_at_a_time")
    [entry] = section(want_list(owner), charizard)["lines"]
    assert entry["swap"]["edition_id"] == ids["PAL 254"]
    promise(owner, ids["PAL 254"], 1)
    [entry] = section(want_list(owner), charizard)["lines"]
    assert entry["swap"] is None


def test_gather_takes_unreserved_copies_first_and_can_still_take_a_reserved_one(store):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    iono = ids["PAL 185"]
    first = call("POST", "/api/location-tree", owner, {"name": "Binder A", "idempotency_key": str(uuid4())}).json()
    second = call("POST", "/api/location-tree", owner, {"name": "Binder B", "idempotency_key": str(uuid4())}).json()
    a, b = first["location"]["id"], second["location"]["id"]
    hold(owner, a, iono, 1)
    hold(owner, b, iono, 1)
    gardevoir = deck(owner, "Gardevoir ex", 0)
    line(owner, gardevoir, iono, 1)

    def suggested():
        [row] = call("GET", f"/api/decks/{gardevoir}/pick-list", owner).json()["rows"]
        return {source["location_id"]: source["suggested"] for source in row["sources"]}

    assert suggested() == {a: "1", b: "0"}
    promise(owner, iono, 1)
    # Binder A's copy is the Loan's pick: Gather suggests Binder B's.
    assert suggested() == {a: "0", b: "1"}
    # Reserved copies stay where they are and can still be gathered before handover.
    line(owner, gardevoir, iono, 2)
    assert suggested() == {a: "1", b: "1"}


def move(owner, source, destination, edition, copies):
    manifest = start(owner, source)
    version = holding(owner, source, edition)['version']
    assert stage(owner, manifest, [selected(edition, copies, version)]).status_code == 200
    assert commit(owner, manifest, destination).status_code == 200


def binder(owner, name):
    return call("POST", "/api/location-tree", owner, {"name": name, "idempotency_key": str(uuid4())}).json()[
        "location"]["id"]


@pytest.mark.parametrize("setting", ["all_at_once", "one_at_a_time"])
def test_copies_promised_from_a_deck_and_moved_out_of_it_are_never_offered_to_it(store, setting):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    iono = ids["PAL 185"]
    gardevoir = deck(owner, "Gardevoir ex", 0)
    hold(owner, gardevoir, iono, 2)
    line(owner, gardevoir, iono, 0)   # moving copies in listed them (migration 031): the Deck holds them unlisted
    assert detail(owner, gardevoir)["deck_list"]["lines"] == []
    promise(owner, iono, 2)
    with connect() as conn:
        assert counts.reserved_picks(conn, owner, [UUID(iono)]) == {UUID(iono): {UUID(gardevoir): 2}}
    # Both promised copies move to a Binder: the picks still name the Deck, but the reserved copies are the Binder's.
    shelf = binder(owner, "Binder")
    move(owner, gardevoir, shelf, iono, 2)
    with connect() as conn:
        found = copy_allocation.available_to(conn, owner, [UUID(iono)], setting, deck_id=UUID(gardevoir))
    assert (found.editions[UUID(iono)].in_deck, found.editions[UUID(iono)].elsewhere) == (0, ())


def test_gather_leaves_the_copies_an_out_of_date_pick_still_reserves(store):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    iono = ids["PAL 185"]
    gardevoir = deck(owner, "Gardevoir ex", 0)
    line(owner, gardevoir, iono, 1)
    first = binder(owner, "Binder")
    hold(owner, first, iono, 2)
    promise(owner, iono, 2)
    # The picked copies move to a Shelf, and a Box gets the one copy no Loan promised.
    shelf, box = binder(owner, "Shelf"), binder(owner, "Box")
    move(owner, first, shelf, iono, 2)
    hold(owner, box, iono, 1)
    [row] = call("GET", f"/api/decks/{gardevoir}/pick-list", owner).json()["rows"]
    assert {source["location_id"]: source["suggested"] for source in row["sources"]} == {shelf: "0", box: "1"}


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
