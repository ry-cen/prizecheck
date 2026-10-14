"""The publish gate (app redesign #178, ADR 0011) through signed HTTP against PostgreSQL and the local projection.

Publishing and republishing recompute the Deck List's result in its Target Format for today, in the publication
command's transaction, and refuse anything but ``legal`` with ``409 TARGET_FORMAT_NOT_LEGAL``, carrying the result. A
refusal writes nothing. Snapshots store their Target Format; a snapshot published before it reads as Standard.

Nothing here is exempt from the gate (``publish_gate_fixture``): every publish goes through the route directly. Today is
fixed through the route's clock (``deck_format_checks.today``). The cards are those of test_deck_format_checks.py.
"""
from datetime import date
from uuid import uuid4

import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app import deck_format_checks
from test_card_attributes import edition_of
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_deck_format_checks import CARDS, deck_with
from test_deck_lists import change_line
from test_holdings import call, client
from test_published_cost import launches, rewrite_snapshot, store  # noqa: F401  (autouse: a projection and records store)
from test_publications import stored_decks
from test_target_format import LEGAL_IN_STANDARD, codes, set_target

current = [date(2026, 10, 11)]


@pytest.fixture(autouse=True)
def today(monkeypatch):
    current[0] = date(2026, 10, 11)
    monkeypatch.setattr(deck_format_checks, "today", lambda: current[0])


def publish(owner, deck, method="POST", key=None, title="Gate deck"):
    return call(method, f"/api/decks/{deck}/publication", owner, {"title": title, "idempotency_key": str(key or uuid4())})


def refusal(response):
    """The refused result: (Target Format, the one result)."""
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "TARGET_FORMAT_NOT_LEGAL"
    [result] = detail["format_checks"]["results"]
    assert result["format"] == detail["target_format"]
    assert detail["format_checks"]["disclaimer"].startswith("Advisory format checks")
    return detail["target_format"], result


def publication_rows(owner):
    with connect() as conn:
        return conn.execute("""SELECT (SELECT count(*) FROM deck_publication WHERE owner_id=%s) AS publications,
          (SELECT count(*) FROM publication_command WHERE owner_id=%s) AS commands""", (owner, owner)).fetchone()


def catalog():
    reset_catalog()
    run(Records(*CARDS))


def test_a_deck_that_is_not_legal_is_refused_with_its_result_and_nothing_is_written():
    catalog()
    owner, deck = deck_with([("me01-001", 1), ("me01-125", 4)])  # five cards: not a 60-card deck
    before, rows = stored_decks(), publication_rows(owner)
    target, result = refusal(publish(owner, deck))
    assert (target, result["status"], result["evaluated_on"]) == ("standard", "not_legal", "2026-10-11")
    assert "deck_size" in {issue["code"] for issue in result["issues"]}
    assert stored_decks() == before and publication_rows(owner) == rows
    assert call("GET", f"/api/decks/{deck}/publication", owner).json()["token"] is None


def test_an_unknown_result_is_refused_too():
    catalog()
    # me06 has no legal date in the Standard rules, so the result is unknown, never legal.
    owner, deck = deck_with([("me01-001", 1), ("fixture-me06-3", 4), ("sv02-278", 55)])
    target, result = refusal(publish(owner, deck))
    assert (target, result["status"]) == ("standard", "unknown")
    assert {issue["code"] for issue in result["issues"]} == {"set_date_not_recorded"}


def test_a_legal_deck_publishes_and_its_snapshot_stores_the_target_format():
    catalog()
    owner, deck = deck_with(LEGAL_IN_STANDARD)
    published = publish(owner, deck)
    assert published.status_code == 200, published.text
    token = published.json()["token"]
    snapshot = client.get(f"/api/public/decks/{token}").json()
    assert (snapshot["target_format"], snapshot["version"], snapshot["total"]) == ("standard", 1, "60")
    assert stored_decks()["decks"][token]["snapshot"]["target_format"] == "standard"
    # Expanded accepts the same list; republishing freezes the new Target Format.
    assert set_target(owner, deck, "expanded", 5).status_code == 200
    republished = publish(owner, deck, "PUT")
    assert republished.status_code == 200, republished.text
    assert (republished.json()["token"], republished.json()["version"]) == (token, 2)
    assert client.get(f"/api/public/decks/{token}").json()["target_format"] == "expanded"


def test_republishing_is_refused_while_the_target_format_result_is_not_legal():
    catalog()
    owner, deck = deck_with(LEGAL_IN_STANDARD)
    token = publish(owner, deck).json()["token"]
    assert set_target(owner, deck, "glc", 5).status_code == 200
    before = stored_decks()
    target, result = refusal(publish(owner, deck, "PUT"))
    assert (target, result["status"]) == ("glc", "not_legal")
    assert {code for code, _ in codes(result)} == {"copy_limit"}
    assert stored_decks() == before
    assert client.get(f"/api/public/decks/{token}").json()["version"] == 1
    # Back on Standard the list is legal again, and republishing works.
    assert set_target(owner, deck, "standard", 6).status_code == 200
    again = publish(owner, deck, "PUT")
    assert again.status_code == 200 and again.json()["version"] == 2


def test_the_gate_checks_today_not_the_result_saved_on_an_earlier_day():
    catalog()
    current[0] = date(2026, 4, 9)
    # Regulation mark G rotates out of Standard on 2026-04-10.
    owner, deck = deck_with([("me01-001", 1), ("sv01-172", 4), ("me01-125", 4), ("sv02-278", 51)])
    read = call("GET", f"/api/decks/{deck}", owner).json()
    assert read["format_checks"]["results"][0]["status"] == "legal"
    current[0] = date(2026, 4, 10)
    target, result = refusal(publish(owner, deck))
    assert (target, result["status"], result["evaluated_on"]) == ("standard", "not_legal", "2026-04-10")
    assert {issue["code"] for issue in result["issues"]} == {"not_in_card_pool"}


def test_a_stored_publish_replays_after_the_deck_stops_being_legal():
    catalog()
    owner, deck = deck_with(LEGAL_IN_STANDARD)
    key = uuid4()
    first = publish(owner, deck, key=key)
    assert first.status_code == 200, first.text
    assert change_line(owner, deck, edition_of("sv02-278"), "50", 5).status_code == 200
    assert publish(owner, deck, key=key).json() == first.json()
    refusal(publish(owner, deck, "PUT"))


def test_a_snapshot_published_before_target_format_reads_as_standard():
    catalog()
    owner, deck = deck_with(LEGAL_IN_STANDARD)
    assert set_target(owner, deck, "expanded", 5).status_code == 200
    token = publish(owner, deck).json()["token"]
    rewrite_snapshot(token, lambda snapshot: snapshot.pop("target_format"))
    assert "target_format" not in stored_decks()["decks"][token]["snapshot"]
    assert client.get(f"/api/public/decks/{token}").json()["target_format"] == "standard"
    # Enrichment still validates the stored object's digest.
    checks = client.get(f"/api/public/decks/{token}/versions/1/format-checks")
    assert checks.status_code == 200, checks.text
    assert "target_format" not in stored_decks()["decks"][token]["snapshot"]
