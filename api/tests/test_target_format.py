"""Target Format (app redesign #178, ADR 0011) through signed HTTP against PostgreSQL.

Every Deck List has one Target Format, Standard unless the collector chooses another. ``PUT
/api/decks/{id}/deck-list/target-format`` changes it as a Deck List command (revision-checked, idempotent, advancing the
revision), and the Deck read, every Deck List command response and the default format-checks read carry that Format's
result only. Commands and the Deck read check as of today, so today is fixed through the route's clock
(``deck_format_checks.today``). The cards and the real rules files are those of test_deck_format_checks.py: four Rare
Candy and four Switch are legal in Standard and Expanded but break Gym Leader Challenge's one-copy rule.
"""
import json
import os
from datetime import date
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app import deck_format_checks
from test_card_attributes import edition_of
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_references import migrate
from test_deck_format_checks import CARDS, deck_with, format_checks
from test_deck_lists import change_line
from test_holdings import call
from test_moves import leaf

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = '045_deck_list_target_format.sql'
# Legal in Standard and Expanded; four Rare Candy and four Switch break Gym Leader Challenge's one-copy rule.
LEGAL_IN_STANDARD = [("me01-001", 1), ("me01-125", 4), ("me01-130", 4), ("sv02-278", 51)]
GLC_COPY_LIMIT = {("copy_limit", "more than 1 copy of Rare Candy (4)"), ("copy_limit", "more than 1 copy of Switch (4)")}


@pytest.fixture(autouse=True)
def today(monkeypatch):
    monkeypatch.setattr(deck_format_checks, "today", lambda: date(2026, 10, 11))


def set_target(owner, deck, target_format, revision, key=None):
    return call("PUT", f"/api/decks/{deck}/deck-list/target-format", owner,
                {"target_format": target_format, "revision": revision, "idempotency_key": str(key or uuid4())})


def deck_read(owner, deck):
    response = call("GET", f"/api/decks/{deck}", owner)
    assert response.status_code == 200, response.text
    return response.json()


def codes(result):
    return {(issue["code"], issue["reason"]) for issue in result["issues"]}


def legal_deck():
    reset_catalog()
    run(Records(*CARDS))
    return deck_with(LEGAL_IN_STANDARD)


def test_a_new_deck_targets_standard_and_every_read_carries_only_its_result():
    owner, deck = legal_deck()
    body = deck_read(owner, deck)
    assert body["target_format"] == "standard"
    checks = body["format_checks"]
    assert checks["deck_id"] == deck and checks["deck_list_revision"] == body["deck_list"]["revision"] == 5
    assert [(result["format"], result["status"], result["issues"]) for result in checks["results"]] == [
        ("standard", "legal", [])]
    assert checks["disclaimer"].startswith("Advisory format checks")
    # The format-checks read defaults to the Target Format, and reuses the result the Deck read saved.
    assert format_checks(owner, deck) == checks
    # A Deck List command carries the Target Format and its result too.
    edited = change_line(owner, deck, edition_of("sv02-278"), "50", 5)
    assert edited.status_code == 200, edited.text
    assert edited.json()["target_format"] == "standard"
    assert [(result["format"], result["status"]) for result in edited.json()["format_checks"]["results"]] == [
        ("standard", "not_legal")]


def test_changing_the_target_format_advances_the_revision_and_answers_the_new_formats_result():
    owner, deck = legal_deck()
    changed = set_target(owner, deck, "glc", 5)
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert (body["deck_id"], body["target_format"], body["deck_list"]["revision"]) == (deck, "glc", 6)
    assert sorted(line["quantity"] for line in body["deck_list"]["lines"]) == ["1", "4", "4", "51"]
    [result] = body["format_checks"]["results"]
    assert (result["format"], result["status"], result["evaluated_on"]) == ("glc", "not_legal", "2026-10-11")
    assert codes(result) == GLC_COPY_LIMIT
    assert body["format_checks"]["deck_list_revision"] == 6
    # The Deck read and the default format-checks read follow the new Target Format, reusing the command's saved result.
    read = deck_read(owner, deck)
    assert (read["target_format"], read["deck_list"]["revision"]) == ("glc", 6)
    assert read["format_checks"] == body["format_checks"]
    assert format_checks(owner, deck) == body["format_checks"]
    # Another Format can still be read by name.
    [standard] = format_checks(owner, deck, "?format=standard")["results"]
    assert (standard["format"], standard["status"]) == ("standard", "legal")
    # Later Deck List commands answer the new Target Format.
    cut = change_line(owner, deck, edition_of("me01-125"), "1", 6)
    assert cut.status_code == 200, cut.text
    assert cut.json()["target_format"] == "glc"
    [after] = cut.json()["format_checks"]["results"]
    card_issues = {(issue["code"], issue["reason"]) for issue in after["issues"] if issue["kind"] == "card"}
    assert (after["format"], card_issues) == ("glc", {("copy_limit", "more than 1 copy of Switch (4)")})


def test_choosing_the_current_target_format_is_accepted_and_still_advances_the_revision():
    owner, deck = legal_deck()
    same = set_target(owner, deck, "standard", 5)
    assert same.status_code == 200, same.text
    assert (same.json()["target_format"], same.json()["deck_list"]["revision"]) == ("standard", 6)


def test_the_command_is_revision_checked():
    owner, deck = legal_deck()
    stale = set_target(owner, deck, "expanded", 4)
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "STALE_DECK_LIST"
    read = deck_read(owner, deck)
    assert (read["target_format"], read["deck_list"]["revision"]) == ("standard", 5)


def test_the_command_is_idempotent_and_a_replay_answers_as_computed_then():
    owner, deck = legal_deck()
    key = uuid4()
    first = set_target(owner, deck, "glc", 5, key)
    assert first.status_code == 200, first.text
    again = set_target(owner, deck, "glc", 5, key)
    assert again.status_code == 200 and again.json() == first.json()
    assert deck_read(owner, deck)["deck_list"]["revision"] == 6  # advanced once
    # A later change doesn't alter the replay.
    assert set_target(owner, deck, "expanded", 6).status_code == 200
    assert set_target(owner, deck, "glc", 5, key).json() == first.json()
    assert deck_read(owner, deck)["target_format"] == "expanded"
    # The same key with another request is refused.
    reused = set_target(owner, deck, "standard", 5, key)
    assert reused.status_code == 409 and reused.json()["detail"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_the_command_refuses_an_unknown_format_and_anything_but_the_owners_deck():
    owner, deck = legal_deck()
    for name in ("unlimited", "Standard", "", "x" * 100):
        response = set_target(owner, deck, name, 5)
        assert response.status_code == 422 and response.json()["detail"]["code"] == "UNKNOWN_FORMAT", name
    other = f"target-other-{uuid4()}"
    for user, target in ((other, deck), (owner, leaf(owner)), (owner, str(uuid4()))):
        response = set_target(user, target, "expanded", 5)
        assert response.status_code == 404 and response.json()["detail"]["code"] == "DECK_NOT_FOUND"
    missing = call("PUT", f"/api/decks/{deck}/deck-list/target-format", owner,
                   {"target_format": "expanded", "idempotency_key": str(uuid4())})
    assert missing.status_code == 422
    assert deck_read(owner, deck)["deck_list"]["revision"] == 5


def test_a_response_stored_before_target_format_replays_as_standard_with_only_its_result():
    owner, deck = legal_deck()
    key = uuid4()
    cut = change_line(owner, deck, edition_of("sv02-278"), "50", 5, key)
    assert cut.status_code == 200, cut.text
    stored = cut.json()
    [standard] = stored["format_checks"]["results"]
    # Rewrite the stored response as one saved before migration 045: no Target Format, a result for every Format.
    old = {key_: value for key_, value in stored.items() if key_ != "target_format"}
    old["format_checks"] = {**stored["format_checks"], "results": [
        {**standard, "format": name} for name in ("standard", "expanded", "glc")]}
    with connect() as conn:
        assert conn.execute("UPDATE location_command SET response=%s WHERE owner_id=%s AND request_key=%s",
                            (json.dumps(old), owner, key)).rowcount == 1
    replay = change_line(owner, deck, edition_of("sv02-278"), "50", 5, key)
    assert replay.status_code == 200, replay.text
    assert replay.json() == stored


def test_migration_045_makes_existing_deck_lists_standard_and_runs_again(monkeypatch):
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    name = "tcg_target_format_" + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before=MIGRATION)
        owner, deck = "collector-" + uuid4().hex, uuid4()
        with psycopg.connect(url) as conn:
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
            # The location trigger (migration 029) gives the Deck its Deck List.
            conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Built','deck')", (deck, owner))
            conn.execute("UPDATE deck_list SET revision=3 WHERE owner_id=%s AND deck_id=%s", (owner, deck))
        migrate(url)
        with psycopg.connect(url, row_factory=dict_row) as conn:
            assert conn.execute("SELECT revision,target_format FROM deck_list WHERE owner_id=%s AND deck_id=%s",
                                (owner, deck)).fetchone() == {"revision": 3, "target_format": "standard"}
            with pytest.raises(psycopg.errors.CheckViolation):
                with conn.transaction():
                    conn.execute("UPDATE deck_list SET target_format='unlimited' WHERE owner_id=%s", (owner,))
            conn.execute("UPDATE deck_list SET target_format='glc' WHERE owner_id=%s", (owner,))
            # Running the migration again changes nothing.
            with conn.transaction():
                conn.execute((ROOT / "migrations" / MIGRATION).read_text())
            assert conn.execute("SELECT revision,target_format FROM deck_list WHERE owner_id=%s",
                                (owner,)).fetchone() == {"revision": 3, "target_format": "glc"}
        monkeypatch.setenv("DATABASE_URL", url)
        assert deck_read(owner, str(deck))["target_format"] == "glc"
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
