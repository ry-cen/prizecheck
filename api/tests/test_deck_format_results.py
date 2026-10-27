"""Live and saved format results (Deck Lists 17, issue #98) through signed HTTP against PostgreSQL.

Every Deck List command returns the Deck's format results, and results are saved and reused until something they depend
on changes. Reuse is observed through each result's ``computed_at``: a reused result keeps the time it was computed, a
recomputed one gets a new time. Commands check as of today, so these tests fix today through the route's clock
(``deck_format_checks.today``) rather than depend on the real date. The cards and the Standard rules are the ones in
test_deck_format_checks.py.
"""
import re
from datetime import date
from uuid import uuid4

import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app import deck_format_checks, format_evaluator
from test_attribute_corrections import decide, seed
from test_card_attributes import edition_of
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_deck_format_checks import CARDS, format_checks, issues, lines
from test_deck_lists import add_line, change_line, remove_line
from test_holdings import add, call


@pytest.fixture(autouse=True)
def today(monkeypatch):
    """Today is 2026-10-11 unless a test moves it: ``today(date(...))``."""
    current = [date(2026, 10, 11)]
    monkeypatch.setattr(deck_format_checks, "today", lambda: current[0])

    def move(day):
        current[0] = day
    return move


def build(cards):
    """A fresh owner's Deck whose Deck List holds ``cards``, (TCGdex ID, quantity) pairs, added one command each.
    Returns the owner, the Deck and the last command's response body."""
    owner = f"saved-{uuid4()}"
    created = call("POST", "/api/decks", owner, {"name": "Saved results", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck, body = created.json()["location"]["id"], None
    for revision, (source_id, quantity) in enumerate(cards, start=1):
        response = add_line(owner, deck, edition_of(source_id), str(quantity), revision)
        assert response.status_code == 200, response.text
        body = response.json()
    return owner, deck, body


def standard(checks):
    """The Standard result of a format checks body: a GET response or a command's ``format_checks``."""
    [result] = [result for result in checks["results"] if result["format"] == "standard"]
    return result


def codes(result):
    return {issue["code"] for issue in result["issues"]}


def test_cutting_a_line_returns_updated_results_and_an_unchanged_read_reuses_them():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck, added = build([("me01-001", 1), ("fixture-sv01-901", 3), ("fixture-sv01-902", 2), ("sv02-278", 55)])
    before = added["format_checks"]
    assert before["deck_id"] == deck and before["deck_list_revision"] == added["deck_list"]["revision"] == 5
    assert (standard(before)["status"], codes(standard(before))) == ("not_legal", {"copy_limit", "deck_size"})
    cut = change_line(owner, deck, edition_of("fixture-sv01-902"), "1", 5)
    assert cut.status_code == 200, cut.text
    after = cut.json()["format_checks"]
    assert after["deck_list_revision"] == cut.json()["deck_list"]["revision"] == 6
    result = standard(after)
    assert (result["status"], result["issues"], result["evaluated_on"], result["notes"]) == (
        "legal", [], "2026-10-11", [])
    assert result["computed_at"] != standard(before)["computed_at"]
    assert after["disclaimer"].startswith("Advisory format checks")
    # An unchanged read reuses the saved result: the same answer, computed at the same time.
    assert format_checks(owner, deck) == after
    assert format_checks(owner, deck, "?format=standard") == {**after, "results": [standard(after)]}
    assert format_checks(owner, deck, "?as_of=2026-10-11") == after
    # Removing a line returns updated results too.
    removed = remove_line(owner, deck, edition_of("fixture-sv01-902"), 6)
    assert removed.status_code == 200, removed.text
    assert codes(standard(removed.json()["format_checks"])) == {"deck_size"}
    assert format_checks(owner, deck) == removed.json()["format_checks"]


def test_a_replayed_command_returns_the_results_it_computed_then():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck, _ = build([("me01-001", 1), ("me01-125", 4)])
    key = uuid4()
    first = add_line(owner, deck, edition_of("sv02-278"), "55", 3, key)
    assert first.status_code == 200, first.text
    assert standard(first.json()["format_checks"])["status"] == "legal"
    assert change_line(owner, deck, edition_of("sv02-278"), "50", 4).status_code == 200
    assert standard(format_checks(owner, deck))["status"] == "not_legal"
    replayed = add_line(owner, deck, edition_of("sv02-278"), "55", 3, key)
    assert replayed.status_code == 200 and replayed.json() == first.json()


def test_a_move_into_the_deck_makes_the_next_read_recompute():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck, added = build([("me01-001", 1), ("me01-125", 4), ("sv02-278", 55)])
    saved = added["format_checks"]
    assert format_checks(owner, deck) == saved
    # Copies the Deck List does not cover extend it (migration 031) without a Deck List command.
    response = add(owner, deck, edition_of("me01-130"), "4")
    assert response.status_code == 200, response.text
    body = format_checks(owner, deck)
    assert body["deck_list_revision"] == saved["deck_list_revision"] + 1
    assert standard(body)["computed_at"] != standard(saved)["computed_at"]
    assert codes(standard(body)) == {"deck_size"}
    assert format_checks(owner, deck) == body


def test_a_rules_deploy_makes_the_next_read_recompute(monkeypatch):
    reset_catalog()
    run(Records(*CARDS))
    owner, deck, added = build([("me01-001", 1), ("me01-125", 4), ("sv02-278", 55)])
    before = standard(added["format_checks"])
    current = format_evaluator.format_rules("standard")
    assert before["rules_version"] == current.version
    # The next revision of the same rules file, as a deploy would bring it.
    source = (format_evaluator.RULES_DIR / "standard.toml").read_text()
    revised = re.sub(r"^revision = \d+$", f"revision = {current.revision + 1}", source, count=1, flags=re.M)
    deployed = format_evaluator.load_rules(revised.encode())
    real = format_evaluator.format_rules
    monkeypatch.setattr(format_evaluator, "format_rules", lambda name: deployed if name == "standard" else real(name))
    result = standard(format_checks(owner, deck))
    assert result["rules_version"] == f"{current.revision + 1} ({current.published.isoformat()})"
    assert result["computed_at"] != before["computed_at"] and result["status"] == "legal"
    assert standard(format_checks(owner, deck)) == result


def test_a_reviewed_attribute_correction_makes_the_next_read_recompute():
    printings = seed(*CARDS)
    owner, deck, added = build([("me01-001", 1), ("me01-125", 4), ("fixture-me05-901", 4), ("sv02-278", 51)])
    before = added["format_checks"]
    assert codes(standard(before)) == {"regulation_mark_not_in_rules"}
    assert format_checks(owner, deck) == before
    future = printings["fixture-me05-901"]
    response = decide(future, correction={"regulation_mark": "I"})
    assert response.status_code == 200, response.text
    body = format_checks(owner, deck)
    assert body["attribute_revision"] == before["attribute_revision"] + 1
    assert standard(body)["status"] == "legal"
    assert standard(body)["computed_at"] != standard(before)["computed_at"]
    assert format_checks(owner, deck) == body


def test_a_catalog_import_makes_the_next_read_recompute():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck, added = build([("me01-001", 1), ("me01-125", 4), ("sv02-278", 55)])
    before = added["format_checks"]
    # An unchanged import still activates a new catalog generation, which could have moved a Printing's set.
    run(Records(*CARDS))
    body = format_checks(owner, deck)
    assert body["catalog_revision"] == before["catalog_revision"] + 1
    assert body["attribute_revision"] == before["attribute_revision"]
    assert standard(body)["status"] == "legal"
    assert standard(body)["computed_at"] != standard(before)["computed_at"]


def test_a_saved_result_is_reused_until_the_next_rule_date(today):
    reset_catalog()
    run(Records(*CARDS))
    today(date(2026, 4, 8))
    owner, deck, added = build([("me01-001", 1), ("sv01-172", 4), ("me01-125", 4), ("sv02-278", 51)])
    saved = standard(added["format_checks"])
    assert (saved["status"], saved["evaluated_on"]) == ("legal", "2026-04-08")
    # G rotates on 2026-04-10, the next rule date: the day before reuses the saved result, for its own date.
    today(date(2026, 4, 9))
    reused = standard(format_checks(owner, deck))
    assert (reused["status"], reused["evaluated_on"], reused["computed_at"]) == (
        "legal", "2026-04-09", saved["computed_at"])
    # On the rotation date the result is recomputed.
    today(date(2026, 4, 10))
    rotated = standard(format_checks(owner, deck))
    assert rotated["computed_at"] != saved["computed_at"]
    assert issues(rotated) == {("not_in_card_pool", "regulation mark G rotated out of Standard on 2026-04-10", "card",
                                "not_legal", lines("sv01-172"))}
    # A later date before the next rule date (2026-06-05) reuses it, with the notes of its own date.
    ahead = standard(format_checks(owner, deck, "?as_of=2026-05-01"))
    assert (ahead["computed_at"], ahead["evaluated_on"], ahead["issues"]) == (
        rotated["computed_at"], "2026-05-01", rotated["issues"])
    assert len(ahead["notes"]) == 1 and ahead["notes"][0].startswith("2026-05-01 is in the future")


def test_a_read_never_waits_for_a_deck_list_writer():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck, _ = build([("me01-001", 1), ("me01-125", 4), ("sv02-278", 55)])
    # Hold the Deck's saved result rows as a Deck List command does while it saves. The table is named only to take
    # that lock.
    with connect() as writer, writer.transaction():
        writer.execute("SELECT 1 FROM deck_format_result WHERE owner_id=%s AND deck_id=%s FOR UPDATE", (owner, deck))
        # A date in another window has no saved result, so the read recomputes, cannot save, and still answers.
        first = standard(format_checks(owner, deck, "?as_of=2026-04-09"))
        assert first["status"] == "legal"
    # Nothing was saved, so the next read recomputes, saves, and the one after reuses.
    second = standard(format_checks(owner, deck, "?as_of=2026-04-09"))
    assert second["computed_at"] != first["computed_at"]
    assert standard(format_checks(owner, deck, "?as_of=2026-04-09")) == second
