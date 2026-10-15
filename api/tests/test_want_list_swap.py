"""Swap from the Want List (decklist import #211): the Swap hint on ``GET /api/want-list`` and the Deck List changes
batch that Swap sends, through signed HTTP against PostgreSQL.

A line that still needs copies carries a hint when another Edition in its effective Reprint Group has copies the
counting setting makes available to the Deck:

- **Every Deck built at once:** the Spare Copies of that Edition left after older Decks' own lines have counted theirs;
- **One Deck at a time:** every copy of that Edition this Deck's own line for it doesn't already count.

The hint names one Edition (the most copies available, then the card order the page reads in) and ``count``, the
copies Swap moves: the lesser of the line's need and the copies available. Hints on one page never offer the same copy
twice: under Every Deck built at once each copy is offered to one line, oldest Deck first; under One Deck at a time each
Deck counts on its own, but within one Deck each copy is offered to one line. Basic Energy and every other card in no
Reprint Group get no hint. Swap is one existing batch (``POST /api/decks/{id}/deck-list/changes``) at the section's
``deck_list_revision`` and its Undo is the inverse batch, so a Swap lowers the Deck's need by exactly ``count``.

Every test seeds the Swap catalog (``want_list_swap_fixtures``) and starts a new owner.
"""
from uuid import uuid4

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import counting, deck, detail, hold, line, new_owner
from test_holdings import call
from test_want_list import CountingConnection, check_shape, section, want_list
from want_list_swap_fixtures import seed_swap_catalog


def swap_of(body, deck_id, edition):
    """The hint on one line of a Deck's section, or None; the line must be there."""
    return next(item for item in section(body, deck_id)["lines"] if item["edition_id"] == edition)["swap"]


def hint(edition, count, listed="0", code="PAL", number="254"):
    """A hint as the route answers it, for an Edition with no variant other than Normal."""
    return {"edition_id": edition, "set_code": code, "collector_number": number,
            "descriptor": {"finish": "normal"}, "count": count, "listed": listed}


def deck_list(owner, deck_id):
    """The Deck List as {Edition id: quantity}, with its revision."""
    body = detail(owner, deck_id)["deck_list"]
    return body["revision"], {entry["edition_id"]: entry["quantity"] for entry in body["lines"]}


def batch(owner, deck_id, revision, changes):
    return call("POST", f"/api/decks/{deck_id}/deck-list/changes", owner,
                {"revision": revision, "idempotency_key": str(uuid4()),
                 "changes": [{"edition_id": edition, "quantity": str(quantity)} for edition, quantity in changes]})


def swap(owner, body, deck_id, edition):
    """Send the Swap the page sends for one hinted line: the line lowered by ``count`` and the hinted Edition raised by
    it, at the section's revision. Returns (response, the inverse batch's changes)."""
    found = section(body, deck_id)
    entry = next(item for item in found["lines"] if item["edition_id"] == edition)
    offer = entry["swap"]
    count, quantity, listed = int(offer["count"]), int(entry["quantity"]), int(offer["listed"])
    response = batch(owner, deck_id, found["deck_list_revision"],
                     [(edition, quantity - count), (offer["edition_id"], listed + count)])
    return response, [(edition, quantity), (offer["edition_id"], listed)]


def test_the_spec_example_swap_moves_only_the_spare_copy_and_undo_puts_the_line_back(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    charizard = deck(owner, "Charizard ex", 0)
    line(owner, charizard, ids["PAL 185"], 4)
    hold(owner, unsorted, ids["PAL 254"], 1)
    body = want_list(owner)
    check_shape(body)
    # "↻ You own a playable version (PAL 254) × 1" on 4 of 4 Iono PAL 185.
    assert swap_of(body, charizard, ids["PAL 185"]) == hint(ids["PAL 254"], "1")
    assert section(body, charizard)["to_get"] == "4"

    response, inverse = swap(owner, body, charizard, ids["PAL 185"])
    assert response.status_code == 200, response.text
    # 4 Iono PAL 185 with one spare PAL 254 becomes 3 PAL 185 and 1 PAL 254, in one revision.
    revision, lines = deck_list(owner, charizard)
    assert revision == section(body, charizard)["deck_list_revision"] + 1 == response.json()["deck_list"]["revision"]
    assert lines == {ids["PAL 185"]: "3", ids["PAL 254"]: "1"}
    after = want_list(owner)
    check_shape(after)
    # Every count follows: the PAL 254 line counts the spare and needs nothing, so only PAL 185 is left, without a hint.
    [left] = section(after, charizard)["lines"]
    assert (left["edition_id"], left["need"], left["swap"]) == (ids["PAL 185"], "3", None)
    assert section(after, charizard)["to_get"] == detail(owner, charizard)["to_get"] == "3"

    # Undo is the inverse batch at the revision the Swap answered: the PAL 254 line goes and PAL 185 is 4 again.
    undone = batch(owner, charizard, revision, inverse)
    assert undone.status_code == 200, undone.text
    assert deck_list(owner, charizard)[1] == {ids["PAL 185"]: "4"}
    again = want_list(owner)
    assert swap_of(again, charizard, ids["PAL 185"]) == hint(ids["PAL 254"], "1")


def test_swap_raises_a_line_the_deck_already_has_and_moves_only_as_many_as_it_still_needs(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    charizard = deck(owner, "Charizard ex", 0)
    line(owner, charizard, ids["PAL 185"], 2)
    hold(owner, charizard, ids["PAL 254"], 1)   # moving a copy in lists it (migration 031): PAL 254 × 1, held
    hold(owner, unsorted, ids["PAL 254"], 5)
    body = want_list(owner)
    # The line needs 2, so 2 of the 5 spare copies are offered, and the PAL 254 line it raises already lists 1.
    assert swap_of(body, charizard, ids["PAL 185"]) == hint(ids["PAL 254"], "2", listed="1")
    response, _ = swap(owner, body, charizard, ids["PAL 185"])
    assert response.status_code == 200, response.text
    # A line lowered to 0 leaves the Deck List.
    assert deck_list(owner, charizard)[1] == {ids["PAL 254"]: "3"}
    assert detail(owner, charizard)["to_get"] == "0"


def test_every_deck_built_at_once_offers_only_spares_left_after_older_decks_own_lines(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    keeper = deck(owner, "Keeper", 0)        # oldest
    wanting = deck(owner, "Wanting", 1)
    line(owner, keeper, ids["PAL 254"], 2)
    hold(owner, keeper, ids["PAL 254"], 1)   # held for its own line: never offered to another Deck
    line(owner, wanting, ids["PAL 185"], 3)
    hold(owner, unsorted, ids["PAL 254"], 1)
    body = want_list(owner)
    check_shape(body)
    # Keeper, the older Deck, counts the loose copy for its own PAL 254 line, so nothing is left for Wanting.
    assert swap_of(body, wanting, ids["PAL 185"]) is None
    hold(owner, unsorted, ids["PAL 254"], 2)
    body = want_list(owner)
    # Two more loose copies: Keeper takes none of them (it is complete), and Wanting is offered both.
    assert section(body, keeper)["lines"] == []
    assert swap_of(body, wanting, ids["PAL 185"]) == hint(ids["PAL 254"], "2")
    # A newer Deck's own line doesn't come first: Wanting is offered the spares even though a newer Deck lists them.
    newest = deck(owner, "Newest", 2)
    line(owner, newest, ids["PAL 254"], 2)
    body = want_list(owner)
    assert swap_of(body, wanting, ids["PAL 185"]) == hint(ids["PAL 254"], "2")
    # After the Swap, Wanting counts them and the newer Deck needs them instead: older Decks are unchanged.
    before = {d: detail(owner, d)["to_get"] for d in (keeper, wanting, newest)}
    response, _ = swap(owner, body, wanting, ids["PAL 185"])
    assert response.status_code == 200, response.text
    assert detail(owner, keeper)["to_get"] == before[keeper]
    assert int(detail(owner, wanting)["to_get"]) == int(before[wanting]) - 2


def test_one_deck_at_a_time_offers_any_copy_outside_this_decks_own_line(store):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    keeper = deck(owner, "Keeper", 0)
    wanting = deck(owner, "Wanting", 1)
    hold(owner, keeper, ids["PAL 254"], 2)   # listed and held: Keeper's own copies
    line(owner, wanting, ids["PAL 185"], 4)
    # Every Deck built at once: copies another Deck holds for its own line are never offered.
    body = want_list(owner)
    assert swap_of(body, wanting, ids["PAL 185"]) is None
    # One Deck at a time: every copy outside Wanting counts, the ones sleeved in Keeper too.
    counting(owner, "one_at_a_time")
    body = want_list(owner)
    check_shape(body)
    assert swap_of(body, wanting, ids["PAL 185"]) == hint(ids["PAL 254"], "2")
    response, _ = swap(owner, body, wanting, ids["PAL 185"])
    assert response.status_code == 200, response.text
    assert detail(owner, wanting)["to_get"] == "2"
    # Wanting's own PAL 254 line now counts both copies, so none is offered again.
    after = want_list(owner)
    assert swap_of(after, wanting, ids["PAL 185"]) is None


def test_hints_on_one_page_never_offer_the_same_copy_twice(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    older = deck(owner, "Older", 0)
    newer = deck(owner, "Newer", 1)
    for deck_id in (older, newer):
        line(owner, deck_id, ids["PAL 185"], 2)
    line(owner, older, ids["PAF 80"], 2)
    hold(owner, unsorted, ids["PAL 254"], 1)
    body = want_list(owner)
    check_shape(body)
    # Every Deck built at once: one spare copy, one offer. The older Deck's first line in reading order (Paldea Evolved
    # before Paldean Fates) gets it; its PAF 80 line and the newer Deck get none.
    assert swap_of(body, older, ids["PAL 185"]) == hint(ids["PAL 254"], "1")
    assert swap_of(body, older, ids["PAF 80"]) is None
    assert swap_of(body, newer, ids["PAL 185"]) is None
    # One Deck at a time: each Deck counts every copy on its own, so both Decks are offered it, but within one Deck
    # only one line is.
    counting(owner, "one_at_a_time")
    body = want_list(owner)
    assert swap_of(body, older, ids["PAL 185"]) == hint(ids["PAL 254"], "1")
    assert swap_of(body, older, ids["PAF 80"]) is None
    assert swap_of(body, newer, ids["PAL 185"]) == hint(ids["PAL 254"], "1")


def test_the_hint_names_the_edition_with_the_most_copies_available(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, "Wanting", 0)
    line(owner, wanting, ids["PAL 185"], 4)
    hold(owner, unsorted, ids["PAL 254"], 1)
    hold(owner, unsorted, ids["PAF 80"], 2)
    body = want_list(owner)
    assert swap_of(body, wanting, ids["PAL 185"]) == hint(ids["PAF 80"], "2", code="PAF", number="080")


def test_another_edition_of_the_same_printing_is_offered_when_the_printing_is_in_a_group(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, "Wanting", 0)
    line(owner, wanting, ids["SVI 166"], 2)
    hold(owner, unsorted, ids["SVI 166 Reverse Holo"], 1)
    body = want_list(owner)
    assert swap_of(body, wanting, ids["SVI 166"]) == {
        "edition_id": ids["SVI 166 Reverse Holo"], "set_code": "SVI", "collector_number": "166",
        "descriptor": {"finish": "reverse"}, "count": "1", "listed": "0"}


def test_basic_energy_and_cards_in_no_reprint_group_get_no_hint(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, "Wanting", 0)
    line(owner, wanting, ids["SVE 13"], 4)
    line(owner, wanting, ids["PAL 172"], 2)
    hold(owner, unsorted, ids["SVE 5"], 4)
    hold(owner, unsorted, ids["PAL 172 Reverse Holo"], 2)
    for setting in ("all_at_once", "one_at_a_time"):
        counting(owner, setting)
        body = want_list(owner)
        check_shape(body)
        # Another Basic Psychic Energy, and the other Edition of a Printing in no group, are not offered.
        assert {item["edition_id"]: item["swap"] for item in section(body, wanting)["lines"]} == {
            ids["PAL 172"]: None, ids["SVE 13"]: None}


def test_the_scoped_read_carries_the_same_hints_as_all_decks(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    older = deck(owner, "Older", 0)
    newer = deck(owner, "Newer", 1)
    line(owner, older, ids["PAF 80"], 2)     # an Edition the newer Deck doesn't list, in the same group
    line(owner, newer, ids["PAL 185"], 3)
    hold(owner, unsorted, ids["PAL 254"], 3)
    for setting in ("all_at_once", "one_at_a_time"):
        counting(owner, setting)
        whole = want_list(owner)
        for deck_id in (older, newer):
            assert want_list(owner, deck_id)["sections"] == [section(whole, deck_id)]
    counting(owner, "all_at_once")
    whole = want_list(owner)
    # The older Deck's PAF 80 line is offered 2 of the 3 spares first, so the newer Deck is offered the last one, in the
    # scoped read too.
    assert swap_of(whole, older, ids["PAF 80"]) == hint(ids["PAL 254"], "2")
    assert swap_of(want_list(owner, newer), newer, ids["PAL 185"]) == hint(ids["PAL 254"], "1")


def test_a_swap_or_undo_after_the_list_changed_is_refused_as_stale(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    charizard = deck(owner, "Charizard ex", 0)
    line(owner, charizard, ids["PAL 185"], 4)
    hold(owner, unsorted, ids["PAL 254"], 1)
    body = want_list(owner)
    # The list changes after the page read it: the Swap at the section's revision is refused and nothing moves.
    line(owner, charizard, ids["PAL 185"], 3)
    response, _ = swap(owner, body, charizard, ids["PAL 185"])
    assert (response.status_code, response.json()["detail"]["code"]) == (409, "STALE_DECK_LIST")
    assert deck_list(owner, charizard)[1] == {ids["PAL 185"]: "3"}
    # Read again, Swap, then an edit in between: the Undo is refused too.
    body = want_list(owner)
    response, inverse = swap(owner, body, charizard, ids["PAL 185"])
    assert response.status_code == 200, response.text
    revision = response.json()["deck_list"]["revision"]
    line(owner, charizard, ids["PAF 80"], 1)
    undone = batch(owner, charizard, revision, inverse)
    assert (undone.status_code, undone.json()["detail"]["code"]) == (409, "STALE_DECK_LIST")
    assert deck_list(owner, charizard)[1] == {ids["PAL 185"]: "2", ids["PAL 254"]: "1", ids["PAF 80"]: "1"}


def test_the_hint_reads_only_the_groups_of_lines_that_need_copies(store, monkeypatch):
    from app import want_list as want_list_module
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, "Wanting", 0)
    line(owner, wanting, ids["PAL 185"], 2)
    hold(owner, unsorted, ids["PAL 254"], 1)
    real = want_list_module.connect

    def rows_read():
        seen = []
        monkeypatch.setattr(want_list_module, "connect", lambda: CountingConnection(real(), seen))
        body = want_list(owner)
        monkeypatch.setattr(want_list_module, "connect", real)
        return body, sum(seen)

    before, read_before = rows_read()
    # Copies of Editions in a group no needed line belongs to, and of Basic Energy: nothing more is read or shown.
    for key in ("SVI 166", "SVI 166 Reverse Holo", "SVE 5", "SVE 13"):
        hold(owner, unsorted, ids[key], 3)
    after, read_after = rows_read()
    assert read_after == read_before
    assert {**after, "owner_revision": None} == {**before, "owner_revision": None}
