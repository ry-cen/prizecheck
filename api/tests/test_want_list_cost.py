"""The Want List's cost (decklist import #210): ``GET /api/want-list/cost`` through signed, budgeted HTTP against
PostgreSQL and a real record store.

It prices what ``GET /api/want-list`` shows for the same scope: the combined total, each section and its lines, and each
combined row, each with Pricing Coverage. It is a price access under ADR 0006 with one capture, one quote read, one
admission and at most one wait inside one gateway budget. Unpriced copies are never $0, and a row that couldn't be read
in time makes only the figures containing it incomplete. Every assertion is on the route's answer or on what the record
store holds afterwards.

Every test starts a new owner, so no setting leaks between tests; Deck creation times are set explicitly.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import os
import time
from uuid import uuid4

import psycopg
import pytest

from app.main import connect  # noqa: F401
from app import prices
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import EMPTY, cost as deck_cost, store  # noqa: F401  (a fixture)
from test_deck_counting import counting, deck, hold, iono_world, line, new_owner
from test_holdings import call
from test_prices import ago, client, headers_for, seed, world
from test_want_list import want_list

PATH = "/api/want-list/cost"
PAIRED = ("want_list_counting", "settings_revision", "owner_revision", "deck_lists_digest", "deck_id")


def cost(owner, scope=None, **options):
    """The budget signs the path, never the query: ``?deck=`` rides on the URL only."""
    return client.get(PATH + (f"?deck={scope}" if scope else ""),
                      headers=headers_for(b"", method="GET", path=PATH, user=owner, **options))


def body_of(response):
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def summary(figure):
    return (figure["status"], figure["amount"], figure["display_amount"], figure["priced_copies"], figure["total_copies"])


def section(body, deck_id):
    return next(entry for entry in body["sections"] if entry["deck_id"] == deck_id)


def agrees_with_the_want_list(priced, shown):
    """The cost answers exactly the page it was asked for: the same setting, revisions, digest and scope, the same
    sections in the same order, and per section and combined row the same Editions and needs."""
    assert {key: priced[key] for key in PAIRED} == {key: shown[key] for key in PAIRED}
    assert [(entry["deck_id"], entry["deck_list_revision"]) for entry in priced["sections"]] == [
        (entry["deck_id"], entry["deck_list_revision"]) for entry in shown["sections"]]
    for entry in shown["sections"]:
        assert sorted((line["edition_id"], line["need"]) for line in section(priced, entry["deck_id"])["lines"]) == \
            sorted((line["edition_id"], line["need"]) for line in entry["lines"])
        assert section(priced, entry["deck_id"])["cost"]["total_copies"] == entry["to_get"]
    assert sorted((row["edition_id"], row["need"]) for row in priced["combined"]) == \
        sorted((row["edition_id"], row["need"]) for row in shown["combined"])
    assert priced["total"]["total_copies"] == shown["to_get"]


# ------------------------------------------------------------------ the worked example


def test_the_iono_example_prices_each_section_its_lines_and_the_total_under_both_settings(store):
    owner, charizard, gardevoir, edition = iono_world(store)   # Iono at $0.25
    priced = body_of(cost(owner))
    agrees_with_the_want_list(priced, want_list(owner))
    # Every Deck built at once: Charizard ex needs 2, Gardevoir ex 2, and the total is their sum.
    assert summary(priced["total"]) == ("priced", "1", "$1.00", "4", "4")
    assert [summary(section(priced, d)["cost"]) for d in (charizard, gardevoir)] == [
        ("priced", "0.5", "$0.50", "2", "2")] * 2
    [older] = section(priced, charizard)["lines"]
    assert (older["edition_id"], older["need"], older["price_each"]) == (edition, "2", "$0.25")
    assert summary(older["cost"]) == ("priced", "0.5", "$0.50", "2", "2")
    assert [(row["edition_id"], row["need"], summary(row["cost"])) for row in priced["combined"]] == [
        (edition, "4", ("priced", "1", "$1.00", "4", "4"))]

    # One Deck at a time: Gardevoir ex needs nothing (a real $0.00) and the total is the largest need, Charizard ex's 2.
    counting(owner, "one_at_a_time")
    priced = body_of(cost(owner))
    agrees_with_the_want_list(priced, want_list(owner))
    assert priced["want_list_counting"] == "one_at_a_time"
    assert summary(priced["total"]) == ("priced", "0.5", "$0.50", "2", "2")
    assert section(priced, gardevoir)["cost"] == EMPTY and section(priced, gardevoir)["lines"] == []
    assert summary(section(priced, charizard)["cost"]) == ("priced", "0.5", "$0.50", "2", "2")


def test_each_section_costs_what_its_decks_cost_to_complete_says(store):
    owner, charizard, gardevoir, _ = iono_world(store)
    for setting in ("all_at_once", "one_at_a_time"):
        counting(owner, setting)
        priced = body_of(cost(owner))
        for deck_id in (charizard, gardevoir):
            # One number everywhere: the section is the builder's cost to complete and each Decks index row's figure.
            assert section(priced, deck_id)["cost"] == body_of(deck_cost(deck_id, user=owner))["cost_to_complete"]


def test_the_scoped_cost_is_that_decks_section_and_its_needs(store):
    owner, charizard, gardevoir, edition = iono_world(store)
    for setting in ("all_at_once", "one_at_a_time"):
        counting(owner, setting)
        whole = body_of(cost(owner))
        for deck_id in (charizard, gardevoir):
            scoped = body_of(cost(owner, deck_id))
            agrees_with_the_want_list(scoped, want_list(owner, deck_id))
            assert scoped["deck_id"] == deck_id
            assert scoped["sections"] == [section(whole, deck_id)]
            assert scoped["total"] == section(whole, deck_id)["cost"]
            assert [(row["edition_id"], row["need"]) for row in scoped["combined"]] == [
                (item["edition_id"], item["need"]) for item in section(whole, deck_id)["lines"]]


# ------------------------------------------------------------------ unpriced, empty and incomplete


def test_unpriced_copies_are_reported_and_never_counted_as_zero(store):
    found = world()
    normal, plain = found["normal"], found["unspecified"]     # an Unspecified Variant is never priced
    seed(store, normal, "0.25")
    owner, _ = new_owner()
    mixed, bare = deck(owner, "Mixed", 0), deck(owner, "Bare", 1)
    line(owner, mixed, str(normal["id"]), 2)
    line(owner, mixed, str(plain["id"]), 3)
    line(owner, bare, str(plain["id"]), 1)
    priced = body_of(cost(owner))
    agrees_with_the_want_list(priced, want_list(owner))
    # Mixed: 2 priced copies make $0.50 of 5; the 3 unpriced are in the count, not the amount.
    assert summary(section(priced, mixed)["cost"]) == ("priced", "0.5", "$0.50", "2", "5")
    unpriced = next(item for item in section(priced, mixed)["lines"] if item["edition_id"] == str(plain["id"]))
    assert (unpriced["price_each"], summary(unpriced["cost"])) == (None, ("no_quotes", None, None, "0", "3"))
    # Bare needs only the unpriced card: no price at all, never $0.00.
    assert summary(section(priced, bare)["cost"]) == ("no_quotes", None, None, "0", "1")
    assert summary(priced["total"]) == ("priced", "0.5", "$0.50", "2", "6")
    row = next(item for item in priced["combined"] if item["edition_id"] == str(plain["id"]))
    assert (row["need"], summary(row["cost"])) == ("4", ("no_quotes", None, None, "0", "4"))


def test_nothing_to_get_is_zero_dollars_and_reads_no_price(store, monkeypatch):
    owner, _ = new_owner()
    edition = str(world()["normal"]["id"])
    built = deck(owner, "Built", 0)
    hold(owner, built, edition, 2)          # moving copies in lists them: the Deck needs nothing
    monkeypatch.setattr(prices, "_read_rows", lambda *a, **k: pytest.fail("a complete Want List read a price"))
    priced = body_of(cost(owner))
    assert priced["total"] == EMPTY and section(priced, built)["cost"] == EMPTY
    assert priced["combined"] == [] and section(priced, built)["lines"] == []
    # A collector with no Decks at all is the same empty answer.
    stranger, _ = new_owner()
    empty = body_of(cost(stranger))
    assert (empty["total"], empty["sections"], empty["combined"]) == (EMPTY, [], [])


def test_with_price_reads_off_every_figure_is_no_quotes_and_nothing_is_queried(store, monkeypatch):
    found = world()
    normal = found["normal"]
    seed(store, normal, "0.25")
    owner, _ = new_owner()
    wanted = deck(owner, "Wanted", 0)
    line(owner, wanted, str(normal["id"]), 2)
    monkeypatch.setenv("PRICE_READS", "off")
    monkeypatch.setattr(prices, "_read_rows", lambda *a, **k: pytest.fail("a price query ran"))
    priced = body_of(cost(owner))
    assert summary(priced["total"]) == ("no_quotes", None, None, "0", "2")
    assert summary(section(priced, wanted)["cost"]) == ("no_quotes", None, None, "0", "2")
    assert priced["total"]["fallback_copies"] == "0"


def test_a_failed_row_makes_only_the_figures_containing_it_incomplete(store, monkeypatch):
    found = world()
    normal, reverse = found["normal"], found["reverse-holofoil"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43")
    real_quotes = prices.private_edition_quotes
    calls = []

    def failing_reverse(ids, *args, **kwargs):
        calls.append(list(ids))
        views = real_quotes(ids, *args, **kwargs)
        views[reverse["id"]] = prices._failed([reverse["id"]], "validation_unavailable")[reverse["id"]]
        return views
    monkeypatch.setattr(prices, "private_edition_quotes", failing_reverse)
    owner, _ = new_owner()
    only_normal, both = deck(owner, "Only normal", 0), deck(owner, "Both", 1)
    line(owner, only_normal, str(normal["id"]), 2)
    line(owner, both, str(normal["id"]), 1)
    line(owner, both, str(reverse["id"]), 1)
    priced = body_of(cost(owner))
    # One quote read for every needed Edition, each once.
    assert len(calls) == 1 and sorted(calls[0]) == sorted([normal["id"], reverse["id"]])
    assert summary(section(priced, only_normal)["cost"]) == ("priced", "0.5", "$0.50", "2", "2")
    failed = section(priced, both)["cost"]
    assert (failed["status"], failed["reason"], failed["total_copies"], failed["priced_copies"], failed["amount"]) == (
        "incomplete", "validation_unavailable", "2", None, None)
    lines = {item["edition_id"]: item for item in section(priced, both)["lines"]}
    assert summary(lines[str(normal["id"])]["cost"]) == ("priced", "0.25", "$0.25", "1", "1")
    assert lines[str(reverse["id"])]["cost"]["status"] == "incomplete" and lines[str(reverse["id"])]["price_each"] is None
    assert (priced["total"]["status"], priced["total"]["reason"], priced["total"]["total_copies"]) == (
        "incomplete", "validation_unavailable", "4")
    rows = {item["edition_id"]: item for item in priced["combined"]}
    assert summary(rows[str(normal["id"])]["cost"]) == ("priced", "0.75", "$0.75", "3", "3")
    assert rows[str(reverse["id"])]["cost"]["status"] == "incomplete"


def test_an_exhausted_budget_answers_incomplete_without_a_capture_or_a_price_read(store, monkeypatch):
    owner, charizard, _, _ = iono_world(store)
    monkeypatch.setattr(prices, "_read_rows", lambda *a, **k: pytest.fail("an exhausted budget read a price"))
    for scope in (None, charizard):
        priced = body_of(cost(owner, scope, ms=0))
        assert priced["total"] == {**EMPTY, **{key: None for key in EMPTY if key not in ("status", "currency")},
                                   "status": "incomplete", "reason": "deadline"}
        assert (priced["sections"], priced["combined"], priced["deck_id"]) == ([], [], scope)
        assert {key: priced[key] for key in PAIRED if key != "deck_id"} == dict.fromkeys(PAIRED[:-1])


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
@pytest.mark.slow(reason='wall-clock: waits out a real ~1 s lock timeout')
def test_a_held_inventory_lock_answers_inside_the_budget_without_a_count(store):
    owner, _, _, _ = iono_world(store)
    writer = psycopg.connect(os.environ["DATABASE_URL"])
    try:
        writer.execute("SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE", (owner,))
        started = time.monotonic()
        priced = body_of(cost(owner, ms=1500))
        elapsed = time.monotonic() - started
    finally:
        writer.rollback()
        writer.close()
    assert elapsed < 1.5, elapsed
    # Either the lock wait or the request clock ends first; both are honest and neither reports a count.
    assert priced["total"]["status"] == "incomplete" and priced["total"]["reason"] in ("inventory_unavailable", "deadline")
    assert priced["total"]["total_copies"] is None and priced["owner_revision"] is None
    assert (priced["sections"], priced["combined"]) == ([], [])


# ------------------------------------------------------------------ one access, one admission, one budget


def test_one_access_reads_every_needed_edition_once(store, monkeypatch):
    found = world()
    normal, reverse, plain = found["normal"], found["reverse-holofoil"], found["unspecified"]
    for edition in (normal, reverse):
        seed(store, edition, "0.25", checked=ago(timedelta(hours=30)), updated=ago(timedelta(hours=30)))
    reads = []
    real_quotes = prices.private_edition_quotes
    monkeypatch.setattr(prices, "private_edition_quotes",
                        lambda ids, *a, **k: reads.append(sorted(ids)) or real_quotes(ids, *a, **k))
    owner, _ = new_owner()
    first, second, built = deck(owner, "First", 0), deck(owner, "Second", 1), deck(owner, "Built", 2)
    line(owner, first, str(normal["id"]), 2)
    line(owner, second, str(normal["id"]), 1)
    line(owner, second, str(reverse["id"]), 3)
    hold(owner, built, str(plain["id"]), 1)     # listed and held: nothing to buy, so never priced
    priced = body_of(cost(owner))
    # Two Decks need normal and one needs reverse: one read, each Edition once.
    assert reads == [sorted([normal["id"], reverse["id"]])]
    assert summary(priced["total"]) == ("priced", "1.5", "$1.50", "6", "6")
    assert priced["total"]["fallback_copies"] == "0"


# ------------------------------------------------------------------ pairing, privacy and the budget


def test_every_answer_names_the_state_it_was_captured_at(store):
    owner, charizard, gardevoir, edition = iono_world(store)
    first = body_of(cost(owner))
    # A Deck List edit moves neither the inventory nor the settings revision, only the digest.
    line(owner, gardevoir, edition, 3)
    edited = body_of(cost(owner))
    agrees_with_the_want_list(edited, want_list(owner))
    assert (edited["owner_revision"], edited["settings_revision"]) == (first["owner_revision"], first["settings_revision"])
    assert edited["deck_lists_digest"] != first["deck_lists_digest"]
    assert section(edited, gardevoir)["deck_list_revision"] == section(first, gardevoir)["deck_list_revision"] + 1
    # So does the scoped answer for an older Deck: the digest covers every Deck, whatever the scope.
    assert body_of(cost(owner, charizard))["deck_lists_digest"] == edited["deck_lists_digest"]


def test_every_answer_belongs_to_the_setting_it_names(store):
    owner, _, gardevoir, _ = iono_world(store)
    expected = {"all_at_once": ("4", "2"), "one_at_a_time": ("2", "0")}

    def flip():
        for value in ["one_at_a_time", "all_at_once"] * 5:
            counting(owner, value)

    def answers():
        seen = []
        for _ in range(10):
            priced = body_of(cost(owner))
            seen.append((priced["want_list_counting"], (priced["total"]["total_copies"],
                                                         section(priced, gardevoir)["cost"]["total_copies"])))
        return seen

    # The setting, the Holdings and the Deck Lists are captured under one owner lock, so a concurrent change never yields
    # figures from one setting labelled with the other.
    with ThreadPoolExecutor(max_workers=3) as pool:
        flips = pool.submit(flip)
        reads = [pool.submit(answers) for _ in range(2)]
        flips.result()
        seen = [answer for future in reads for answer in future.result()]
    assert seen and all(figures == expected[setting] for setting, figures in seen), seen


def test_the_route_is_private_signed_and_budgeted(store, monkeypatch):
    owner, charizard, _, _ = iono_world(store)
    stranger, _ = new_owner()
    unsorted = next(entry["id"] for entry in call("GET", "/api/location-tree", owner).json()["locations"]
                    if entry["name"] == "Unsorted")
    for scope, user in ((charizard, stranger), (str(uuid4()), owner), (unsorted, owner)):
        response = cost(user, scope)
        assert (response.status_code, response.json()["detail"]["code"]) == (404, "DECK_NOT_FOUND")
    assert cost(owner, "not-a-uuid").status_code == 422
    monkeypatch.setattr(prices, "private_edition_quotes", lambda *a, **k: pytest.fail("a price read ran"))
    assert cost(owner, budget=False).status_code == 401
    assert cost(owner, forge="0" * 64).status_code == 401
    assert cost(owner, caller=f"user:{stranger}").status_code == 401
    assert client.get(PATH).status_code == 401
    # The budget is bound to its path: one signed for a Deck's cost doesn't open this route.
    other = f"/api/decks/{charizard}/cost"
    assert client.get(PATH, headers=headers_for(b"", method="GET", path=other, user=owner)).status_code == 401


def test_no_request_field_forces_a_refresh(store):
    owner, _, _, _ = iono_world(store)          # Iono's quote was checked moments ago
    headers = {**headers_for(b"", method="GET", path=PATH, user=owner), "cache-control": "no-cache", "pragma": "no-cache"}
    response = client.get(PATH + "?force=1&refresh=1&max_age=0", headers=headers)
    assert body_of(response)["total"]["priced_copies"] == "4"
