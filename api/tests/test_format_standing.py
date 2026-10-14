"""Stored Format Standing (app redesign #172, spec "Stored Format Standing") against PostgreSQL.

Every Card Printing's standing in every Format is stored with a key per Format. Writers are driven the way their callers
drive them: catalog imports through the importer, attribute and Reprint Group decisions over signed HTTP, a rules deploy
through the API's startup, and the rule-date job through its script. No route serves standings yet (the Catalog browse
route, #173, will), so stored rows and the reader are observed through ``app.format_standing``, and each stored standing
is compared with what a Deck's format check returns over HTTP for a Deck List holding that card.

Every test fixes the day standings are computed for (``format_standing.today``), because rule dates in the rules files
would otherwise change the expected statuses over time.
"""
import dataclasses
import hashlib
import os
import runpy
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from threading import Event
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from app.main import app, connect
from app import format_evaluator as evaluator
from app import format_standing
from app.card_attributes import attribute_revision
from test_attribute_corrections import decide as decide_attributes, grant as grant_attributes, seed as seed_owner
from test_card_attributes import ACE_SPEC_BW, BULBASAUR_ME, ENERGY_SEARCH, ENERGY_SV, EX_BW, SWITCH_ME, edition_of
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_references import migrate
from test_deck_format_checks import DELTA_POKEMON, deck_with, every_format
from test_expanded_format_checks import NET_REPRINT, SCOOP_UP_NET
from test_reprint_groups import CANDY_ME, CANDY_SV

ROOT = Path(__file__).resolve().parents[2]
AS_OF = date(2026, 10, 11)      # the rules files' date
# Legal everywhere (me01-001); legal in Standard only through its Reprint Group (sv01-191, mark G rotated, with me01-125);
# banned in Expanded (swsh2-165) and banned there as its identical reprint (fixture-sv01-905); unknown, in a set the
# rules don't record (fixture-me06-3); a Rule Box card and an ACE SPEC, which Gym Leader Challenge excludes.
CARDS = (BULBASAUR_ME, CANDY_ME, CANDY_SV, SCOOP_UP_NET, NET_REPRINT, DELTA_POKEMON, EX_BW, ACE_SPEC_BW, SWITCH_ME,
         ENERGY_SV)


@pytest.fixture(autouse=True)
def fixed_day(monkeypatch):
    monkeypatch.setattr(format_standing, "today", lambda: AS_OF)


def seed(*records):
    reset_catalog()
    run(Records(*(records or CARDS)))


def keys():
    """The stored key rows by Format."""
    with connect() as conn:
        return {row["format"]: row for row in conn.execute("SELECT * FROM catalog_format_standing_key").fetchall()}


def standings(*source_ids):
    """(status, findings) by source ID and Format, read through each Printing's first Card Edition."""
    editions = {source_id: edition_of(source_id) for source_id in source_ids}
    with connect() as conn:
        found = format_standing.read_standings(conn, editions.values())
    return {source_id: {name: (standing.status, list(standing.findings))
                        for name, standing in found.get(UUID(edition), {}).items()}
            for source_id, edition in editions.items()}


def current():
    with connect() as conn:
        return format_standing.current_keys(conn)


def evaluator_says(source_id, as_of=AS_OF.isoformat()):
    """What a Deck's format check says about one copy of the card, by Format: the status and issues of the card-level
    issues on its line. The Basic Pokémon rule is deck-level even when it reports an unknown line, so it is left out."""
    owner, deck = deck_with([(source_id, 1)])
    edition = edition_of(source_id)
    found = {}
    for result in every_format(owner, deck, as_of):
        issues = [{"code": issue["code"], "reason": issue["reason"], "effect": issue["effect"]}
                  for issue in result["issues"] if issue["kind"] == "card" and edition in issue["lines"]
                  and issue["reason"] != "Basic Pokémon status unknown"]
        status = ("not_legal" if any(issue["effect"] == "not_legal" for issue in issues)
                  else "unknown" if issues else "legal")
        found[result["format"]] = (status, issues)
    return found


def eventually(predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("the condition did not hold before the deadline")


def waiting_on(name):
    """Sessions waiting for the advisory lock of one Format."""
    with connect() as conn:
        return conn.execute("""SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND classid=%s
          AND objid=%s AND objsubid=2 AND NOT granted
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())""", (format_standing.LOCK,
                                                           evaluator.FORMATS.index(name))).fetchone()["n"]


def make_stale():
    with connect() as conn:
        conn.execute("SELECT catalog_advance_attribute_revision()")


# ------------------------------------------------------------------ what is stored


def test_stored_standings_match_the_evaluator_for_a_legal_a_banned_a_reprint_and_an_unknown_card():
    seed()
    ids = [record["id"] for record in CARDS]
    stored = standings(*ids)
    status = {source_id: {name: found[0] for name, found in by_format.items()} for source_id, by_format in stored.items()}
    assert status["me01-001"] == {"standard": "legal", "expanded": "legal", "glc": "legal"}
    assert status["sv01-191"]["standard"] == "legal"                   # through me01-125 in its Reprint Group
    assert (status["swsh2-165"]["expanded"], status["fixture-sv01-905"]["expanded"]) == ("not_legal", "not_legal")
    assert stored["swsh2-165"]["expanded"][1] == [{"code": "banned", "reason": "banned in Expanded",
                                                   "effect": "not_legal"}]
    assert stored["fixture-sv01-905"]["expanded"][1] == [
        {"code": "banned", "reason": "banned in Expanded as an identical reprint of Scoop Up Net (swsh2 165)",
         "effect": "not_legal"}]
    assert stored["fixture-me06-3"]["standard"] == (
        "unknown", [{"code": "set_date_not_recorded", "reason": "set legality date not recorded for me06",
                     "effect": "unknown"}])
    assert (status["bw6-124"]["glc"], status["bw7-137"]["glc"]) == ("not_legal", "not_legal")
    # Every stored standing, status and issues, is what a Deck's format check says about the card on the same day.
    for source_id in ids:
        assert stored[source_id] == evaluator_says(source_id), source_id
    # While the keys are current, every Card Printing has one row per Format.
    assert current() is not None
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_format_standing").fetchone()["n"] == \
            len(evaluator.FORMATS) * conn.execute("SELECT count(*) AS n FROM catalog_printing").fetchone()["n"]


def test_a_reader_snapshot_sees_current_keys_and_a_token_that_follows_them():
    seed()
    with connect() as conn, conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        before = format_standing.current_keys(conn)
        assert set(before) == set(evaluator.FORMATS)
    token = format_standing.standing_token(before)
    make_stale()
    with connect() as conn, conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        assert format_standing.current_keys(conn) is None
    state = format_standing.ensure_current()
    assert state.rebuilt == evaluator.FORMATS
    assert format_standing.standing_token(state.keys) != token
    assert current() == state.keys
    # A current Format costs a read and rebuilds nothing; the token stays.
    again = format_standing.ensure_current()
    assert again.rebuilt == () and format_standing.standing_token(again.keys) == format_standing.standing_token(state.keys)
    with pytest.raises(ValueError):
        format_standing.ensure_current(("modified",))


# ------------------------------------------------------------------ eager rebuilds


def test_an_import_rebuilds_every_format_and_a_new_printing_gets_its_standings():
    seed(*CARDS[:-1])
    first = keys()
    assert set(first) == set(evaluator.FORMATS) and current() is not None
    run(Records(*CARDS))                                    # adds Basic Grass Energy
    second = keys()
    assert current() is not None
    with connect() as conn:
        catalog = conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"]
    for name in evaluator.FORMATS:
        assert (second[name]["catalog_revision"], second[name]["builds"]) == (catalog, first[name]["builds"] + 1)
    assert {name: found[0] for name, found in standings("sv02-278")["sv02-278"].items()} == {
        "standard": "legal", "expanded": "legal", "glc": "legal"}


def test_an_attribute_decision_rebuilds_the_standings_it_changes():
    found = seed_owner(*CARDS)
    printing = found["me01-130"]
    assert standings("me01-130")["me01-130"]["standard"] == ("legal", [])
    before = keys()
    grant_attributes(printing)
    response = decide_attributes(printing, correction={"regulation_mark": "G"})
    assert response.status_code == 200, response.text
    # Rebuilt by the decision itself: no reader has asked yet.
    after = keys()
    for name in evaluator.FORMATS:
        assert after[name]["attribute_revision"] == response.json()["attribute_revision"]
        assert after[name]["builds"] == before[name]["builds"] + 1
    stored = standings("me01-130")["me01-130"]
    assert stored["standard"] == ("not_legal", [{"code": "not_in_card_pool",
                                                 "reason": "regulation mark G rotated out of Standard on 2026-04-10",
                                                 "effect": "not_legal"}])
    assert stored == evaluator_says("me01-130")
    assert current() is not None


def test_a_reprint_group_decision_rebuilds_the_standings_it_changes():
    from test_reprint_group_reviews import (CANDIES, decide as decide_groups, evidence, grant as grant_groups, groups,
                                            identity_of, seed as seed_groups)
    ids = seed_groups(*CANDIES)
    assert standings("sv01-191")["sv01-191"]["standard"] == ("legal", [])
    identity = identity_of(ids["sv01-191"])
    grant_groups(identity)
    response = decide_groups(identity, "split", group=groups(evidence(identity))[ids["me01-125"]],
                             printings=[ids["sv01-191"]])
    assert response.status_code == 200, response.text
    assert keys()["standard"]["attribute_revision"] == response.json()["attribute_revision"]
    assert standings("sv01-191")["sv01-191"]["standard"][0] == "not_legal"
    assert standings("sv01-191")["sv01-191"] == evaluator_says("sv01-191")


def test_a_rules_deploy_rebuilds_only_the_format_whose_rules_changed(monkeypatch):
    seed()
    before = keys()
    original = evaluator.format_rules
    rules = original("standard")
    # The deployed Standard rules ban Bulbasaur me01-001: a new file, so a new SHA-256.
    deployed = dataclasses.replace(rules, sha256=hashlib.sha256(b"a rules deploy").hexdigest(), bans={
        **rules.bans, ("me01", "001"): evaluator.BanRule("me01", "001", "Bulbasaur", rules.covers_from, None)})
    monkeypatch.setattr(evaluator, "format_rules", lambda name: deployed if name == "standard" else original(name))
    # The API's startup rebuilds in the background.
    with TestClient(app):
        eventually(lambda: keys()["standard"]["rules_sha256"] == deployed.sha256)
    after = keys()
    assert after["standard"]["builds"] == before["standard"]["builds"] + 1
    for name in ("expanded", "glc"):
        assert after[name] == before[name]                  # not rebuilt
    assert standings("me01-001")["me01-001"]["standard"] == (
        "not_legal", [{"code": "banned", "reason": "banned in Standard", "effect": "not_legal"}])
    assert standings("me01-001")["me01-001"] == evaluator_says("me01-001")


# ------------------------------------------------------------------ the reader fallback


def test_a_stale_key_makes_one_reader_rebuild_while_concurrent_readers_wait(monkeypatch):
    seed()
    before = keys()
    make_stale()
    entered, release, calls = Event(), Event(), []
    evaluate = format_standing._evaluate

    def blocking(conn, wanted, on):
        calls.append(tuple(wanted))
        entered.set()
        assert release.wait(30)
        return evaluate(conn, wanted, on)

    monkeypatch.setattr(format_standing, "_evaluate", blocking)
    with ThreadPoolExecutor(4) as pool:
        first = pool.submit(format_standing.ensure_current, ("standard",))
        assert entered.wait(30)
        others = [pool.submit(format_standing.ensure_current, ("standard",)) for _ in range(3)]
        eventually(lambda: waiting_on("standard") == 3)
        assert not any(future.done() for future in (first, *others))
        release.set()
        results = [future.result(timeout=60) for future in (first, *others)]
    assert calls == [("standard",)]
    assert [result.rebuilt for result in results] == [("standard",), (), (), ()]
    assert all(result.keys == results[0].keys for result in results)
    after = keys()
    with connect() as conn:
        assert after["standard"]["attribute_revision"] == attribute_revision(conn)
    assert after["standard"]["builds"] == before["standard"]["builds"] + 1
    assert after["expanded"] == before["expanded"]          # asked for Standard only
    assert standings("sv01-191")["sv01-191"]["standard"] == ("legal", [])


def test_a_reader_gives_up_after_the_lock_wait_and_changes_nothing(monkeypatch):
    seed()
    make_stale()
    before = keys()
    monkeypatch.setattr(format_standing, "LOCK_WAIT", "200ms")
    with connect() as holder:
        holder.execute("SELECT pg_advisory_xact_lock(%s::int,%s::int)", (format_standing.LOCK, 0))
        with pytest.raises(format_standing.StandingBusy):
            format_standing.ensure_current(("standard",))
        assert format_standing.rebuild_stale_best_effort(("standard",)) is None
        holder.rollback()
    assert keys() == before
    assert format_standing.ensure_current(("standard",)).rebuilt == ("standard",)


def test_a_rule_date_crossing_is_picked_up_by_the_scheduled_job_and_by_readers(monkeypatch, capsys):
    monkeypatch.setattr(format_standing, "today", lambda: date(2026, 4, 9))
    seed(BULBASAUR_ME, ENERGY_SEARCH, ENERGY_SV)
    assert standings("sv01-172")["sv01-172"]["standard"] == ("legal", [])   # mark G until the 2026 rotation
    assert keys()["standard"]["next_rule_date"] == date(2026, 4, 10)
    monkeypatch.setattr(format_standing, "today", lambda: date(2026, 4, 10))
    job = runpy.run_path(str(ROOT / "scripts" / "format_standing_job.py"))
    assert job["main"]() == 0
    assert "standard" in capsys.readouterr().out
    assert standings("sv01-172")["sv01-172"]["standard"] == (
        "not_legal", [{"code": "not_in_card_pool", "reason": "regulation mark G rotated out of Standard on 2026-04-10",
                       "effect": "not_legal"}])
    assert keys()["standard"]["next_rule_date"] == evaluator.next_rule_date(evaluator.format_rules("standard"),
                                                                           date(2026, 4, 10))
    assert standings("sv01-172")["sv01-172"] == evaluator_says("sv01-172", "2026-04-10")
    # The job and readers then find every Format current.
    assert job["main"]() == 0
    assert "nothing" in capsys.readouterr().out
    assert format_standing.ensure_current().rebuilt == ()


# ------------------------------------------------------------------ migration


def test_migration_042_creates_empty_tables_changes_no_data_and_runs_again():
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    name = "tcg_format_standing_" + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before="042_format_standing.sql")
        with psycopg.connect(url, row_factory=dict_row) as conn:
            identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES ('k','K') RETURNING id"
                                    ).fetchone()["id"]
            printing = conn.execute("""INSERT INTO catalog_printing(source,source_id,identity_id)
              VALUES ('tcgdex','fixture-1',%s) RETURNING id""", (identity,)).fetchone()["id"]
            revisions = conn.execute("""SELECT (SELECT revision FROM catalog_attribute_state) AS attribute,
              (SELECT revision FROM catalog_state) AS catalog""").fetchone()
        migrate(url)
        with psycopg.connect(url, row_factory=dict_row) as conn:
            assert conn.execute("""SELECT (SELECT revision FROM catalog_attribute_state) AS attribute,
              (SELECT revision FROM catalog_state) AS catalog""").fetchone() == revisions
            for table in ("catalog_format_standing", "catalog_format_standing_key"):
                assert conn.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(sql.Identifier(table))
                                    ).fetchone()["n"] == 0
            conn.execute("""INSERT INTO catalog_format_standing(printing_id,format,standing,findings)
              VALUES (%s,'standard','unknown','[]')""", (printing,))
            conn.execute("""INSERT INTO catalog_format_standing_key(format,rules_sha256,code_sha256,attribute_revision,
              catalog_revision,active_generation,next_rule_date,built_on,built_at,printings,builds)
              VALUES ('standard',%s,%s,1,0,NULL,NULL,'2026-10-11',now(),1,1)""", ("a" * 64, "b" * 64))
            for bad in ("UPDATE catalog_format_standing SET standing='banned'",
                        "UPDATE catalog_format_standing SET findings='{}'",
                        "UPDATE catalog_format_standing_key SET rules_sha256='x'"):
                with pytest.raises(psycopg.errors.CheckViolation):
                    with conn.transaction():
                        conn.execute(bad)
            # Running the migration again changes nothing.
            with conn.transaction():
                conn.execute((ROOT / "migrations" / "042_format_standing.sql").read_text())
            assert conn.execute("SELECT count(*) AS n FROM catalog_format_standing").fetchone()["n"] == 1
            assert conn.execute("SELECT count(*) AS n FROM catalog_format_standing_key").fetchone()["n"] == 1
            # A deleted Card Printing takes its standings with it.
            conn.execute("DELETE FROM catalog_printing WHERE id=%s", (printing,))
            assert conn.execute("SELECT count(*) AS n FROM catalog_format_standing").fetchone()["n"] == 0
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
