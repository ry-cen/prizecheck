"""Deploying a release applies its newest catalog rules: the lock, the batched rollout, resuming, rollback (ADR 0021)."""
import importlib.util
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.games.pokemon.prices import card_art

from app.games.pokemon.catalog import public_catalog

from app.games.pokemon.catalog import rule_rollout
from app.games.pokemon.prices.catalog_targets import LIVE, LIVE_RULES, MATCHING, MATCHING_RULES, LiveRulesV1, activate_rule, load_active
from app.main import app, connect
from test_catalog import reset_catalog
from test_catalog_metadata import Records, furret, owner
from test_catalog_reconciliation import run
from test_catalog_targets import (InjectedLive, activate, card, strip_card_field, states, tcgplayer_products,  # noqa: F401
                                  xy11_116)
from test_metadata_reviews import price_store, published, spawned  # noqa: F401 (autouse fixtures)

ROOT = Path(__file__).resolve().parents[2]
KINDS = (LIVE, MATCHING)


class Killed(BaseException):
    """Stands in for a process kill: nothing in the rollout may catch it."""


def new_commit():
    return uuid4().hex + "0" * 8


def reset_rules():
    with connect() as conn:
        conn.execute("UPDATE catalog_rule_state SET activation_id=NULL")
        conn.execute("DELETE FROM catalog_rule_rollout")


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.delenv("RELEASE_COMMIT", raising=False)
    monkeypatch.delenv("RULE_ROLLOUT_BATCH", raising=False)
    monkeypatch.setattr(rule_rollout, "BACKOFF_SECONDS", (0, 0, 0, 0))
    monkeypatch.setitem(LIVE_RULES, 99, InjectedLive)
    reset_rules()
    yield
    reset_rules()


def seed(count):
    """A catalog of ``count`` cards with no rule active. Seeds without a release commit, so the promotion applies nothing."""
    reset_rules()
    saved = os.environ.pop("RELEASE_COMMIT", None)
    try:
        reset_catalog()
        owner()
        run(Records(*[card(number) for number in range(1, count + 1)]))
    finally:
        if saved is not None:
            os.environ["RELEASE_COMMIT"] = saved


def deploy_rows(commit, kind=None):
    with connect() as conn:
        return conn.execute("""SELECT kind,version,release_commit,reason,source FROM catalog_rule_activation
          WHERE source='deploy' AND release_commit=%s AND (%s::text IS NULL OR kind=%s) ORDER BY kind""", (commit, kind, kind)).fetchall()


def mapping():
    with connect() as conn:
        return {(row["source_id"], row["descriptor_key"]): (row["mapping_state"], row["mapping_reason"], row["product_id"],
                                                             row["quote_variant"], row["mapping_basis"])
                for row in conn.execute("""SELECT p.source_id,e.descriptor_key,m.mapping_state,m.mapping_reason,m.product_id,
                  m.quote_variant,m.mapping_basis FROM catalog_edition_metadata m JOIN catalog_edition e ON e.id=m.edition_id
                  JOIN catalog_printing p ON p.id=e.printing_id""")}


def rollout(kind):
    with connect() as conn:
        return conn.execute("""SELECT r.* FROM catalog_rule_state s JOIN catalog_rule_rollout r ON r.activation_id=s.activation_id
          WHERE s.kind=%s""", (kind,)).fetchone()


def current_activation(kind):
    with connect() as conn:
        return conn.execute("""SELECT a.* FROM catalog_rule_state s JOIN catalog_rule_activation a ON a.id=s.activation_id
          WHERE s.kind=%s""", (kind,)).fetchone()


def newer_rules(monkeypatch):
    """Register a newer version of each kind, as a later release would ship."""
    newest = max(MATCHING_RULES)
    monkeypatch.setitem(LIVE_RULES, 100, type("NewerLive", (InjectedLive,), {}))
    monkeypatch.setitem(MATCHING_RULES, newest + 1, type("NewerMatching", (MATCHING_RULES[newest],), {}))
    return newest + 1


def script():
    spec = importlib.util.spec_from_file_location("rule_rollout_script", ROOT / "scripts" / "rule_rollout.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ------------------------------------------------------------------ apply once, under a lock


def test_starting_the_api_applies_each_newest_rule_once_and_completes_the_rollout(monkeypatch):
    seed(3)
    commit = new_commit()
    monkeypatch.setenv("RELEASE_COMMIT", commit)
    with TestClient(app):
        rule_rollout.join_startup()
    rows = deploy_rows(commit)
    assert {row["kind"]: row["version"] for row in rows} == {LIVE: max(LIVE_RULES), MATCHING: max(MATCHING_RULES)}
    assert {row["reason"] for row in rows} == {f"Applied by deploying {commit[:7]}"}
    for kind in KINDS:
        assert (rollout(kind)["phase"], rollout(kind)["finished_at"] is not None) == ("done", True)
    assert {value[0] for value in mapping().values()} == {"verified"}
    with TestClient(app):
        rule_rollout.join_startup()
    assert deploy_rows(commit) == rows  # starting again records nothing


def test_startup_never_holds_up_health(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(rule_rollout, "resume", lambda *args: (entered.set(), release.wait(10)))
    with TestClient(app) as client:
        assert entered.wait(5)
        assert client.get("/api/health").status_code == 200
        release.set()
        rule_rollout.join_startup()


@pytest.mark.serial(reason="asserts an upper bound on elapsed time")
def test_a_second_runner_returns_busy_and_one_activation_is_recorded(monkeypatch):
    seed(2)
    commit = new_commit()
    monkeypatch.setenv("RELEASE_COMMIT", commit)
    locked, release = threading.Event(), threading.Event()
    monkeypatch.setattr(rule_rollout, "_after_lock", lambda: (locked.set(), release.wait(10)))
    first = {}
    thread = threading.Thread(target=lambda: first.update(outcome=rule_rollout.apply_newest_rules()))
    thread.start()
    try:
        assert locked.wait(5)
        with connect() as conn:
            holder = conn.execute("""SELECT a.state FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory'
              AND l.classid=0 AND l.objid=%s AND l.objsubid=1 AND l.granted""", (rule_rollout.ROLLOUT_LOCK,)).fetchone()
        assert holder["state"] == "idle"  # autocommit: a session lock with no transaction open
        started = time.monotonic()
        assert rule_rollout.apply_newest_rules() == {"status": "busy"}
        assert time.monotonic() - started < 1
    finally:
        release.set()
        thread.join(30)
    assert len(deploy_rows(commit, LIVE)) == len(deploy_rows(commit, MATCHING)) == 1


@pytest.mark.slow(reason="process: two rule_rollout.py resume processes")
def test_two_resume_processes_started_together_record_one_activation_per_kind():
    seed(3)
    commit = new_commit()
    env = {**os.environ, "RELEASE_COMMIT": commit}
    processes = [subprocess.Popen([sys.executable, "scripts/rule_rollout.py", "resume"], cwd=ROOT, env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(2)]
    assert [process.wait(120) for process in processes] == [0, 0]
    assert len(deploy_rows(commit, LIVE)) == len(deploy_rows(commit, MATCHING)) == 1


# ------------------------------------------------------------------ resuming


def test_a_killed_rollout_resumes_from_its_cursor_and_ends_like_an_uninterrupted_one(monkeypatch):
    monkeypatch.setenv("RULE_ROLLOUT_BATCH", "2")
    seed(5)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    rule_rollout.apply_newest_rules()
    uninterrupted = mapping()
    assert len(uninterrupted) == 10 and {value[0] for value in uninterrupted.values()} == {"verified"}

    seed(5)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())

    def kill(phase, done):
        if phase == "editions" and done == 4:
            raise Killed

    monkeypatch.setattr(rule_rollout, "_after_batch", kill)
    with pytest.raises(Killed):
        rule_rollout.apply_newest_rules()
    row = rollout(MATCHING)
    assert (row["phase"], row["done"]) == ("editions", 4) and row["cursor"] is not None
    monkeypatch.setattr(rule_rollout, "_after_batch", lambda phase, done: None)
    rule_rollout.resume()
    assert rollout(MATCHING)["phase"] == "done"
    assert mapping() == uninterrupted


def test_a_crash_inside_deliver_reruns_deliver(monkeypatch):
    seed(2)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    rebinds, fallbacks = [], []
    real_rebind, real_fallbacks = rule_rollout.price_binding.rebind, card_art.refresh_fallbacks
    monkeypatch.setattr(rule_rollout.price_binding, "rebind", lambda conn: rebinds.append(1) or real_rebind(conn))

    def crash_once(conn):
        fallbacks.append(1)
        if len(fallbacks) == 1:
            raise Killed
        return real_fallbacks(conn)

    monkeypatch.setattr(card_art, "refresh_fallbacks", crash_once)
    with pytest.raises(Killed):
        rule_rollout.apply_newest_rules()
    assert rollout(LIVE)["phase"] == "deliver" and rollout(LIVE)["finished_at"] is None  # the live rollout was delivering
    assert len(rebinds) == 1
    rule_rollout.resume()
    assert [rollout(kind)["phase"] for kind in KINDS] == ["done", "done"]
    assert len(rebinds) == 3  # the live rollout's deliver ran again, then the matching rollout's


def test_a_batch_that_keeps_failing_marks_failed_and_resume_retries_from_the_cursor(monkeypatch):
    monkeypatch.setenv("RULE_ROLLOUT_BATCH", "2")
    seed(3)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    real, calls = rule_rollout.refresh_editions, []

    def failing(*args, **kwargs):
        calls.append(1)
        if len(calls) > 1:
            raise psycopg.errors.LockNotAvailable("could not obtain lock")
        return real(*args, **kwargs)

    monkeypatch.setattr(rule_rollout, "refresh_editions", failing)
    rule_rollout.apply_newest_rules()
    row = rollout(MATCHING)
    assert (row["phase"], row["failed_phase"], row["done"]) == ("failed", "editions", 2)
    assert row["error"].startswith("LockNotAvailable") and row["cursor"] is not None
    assert len(calls) == 1 + rule_rollout.MAX_ATTEMPTS
    monkeypatch.setattr(rule_rollout, "refresh_editions", real)
    rule_rollout.resume()
    row = rollout(MATCHING)
    assert (row["phase"], row["failed_phase"], row["error"]) == ("done", None, None)
    assert {value[0] for value in mapping().values()} == {"verified"}


def test_a_promotion_during_a_rollout_uses_the_new_rule(monkeypatch):
    monkeypatch.setenv("RULE_ROLLOUT_BATCH", "2")
    seed(4)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    paused, release = threading.Event(), threading.Event()

    def pause_once(phase, done):
        if phase == "editions" and not paused.is_set():
            paused.set()
            release.wait(30)

    monkeypatch.setattr(rule_rollout, "_after_batch", pause_once)
    thread = threading.Thread(target=rule_rollout.apply_newest_rules)
    thread.start()
    try:
        assert paused.wait(30)
        run(Records(*[card(number) for number in range(1, 5)], card(5)))  # its own resume returns busy
        deploy = current_activation(MATCHING)["id"]
        with connect() as conn:
            fresh = conn.execute("""SELECT m.mapping_state,m.matching_activation_id FROM catalog_edition_metadata m
              JOIN catalog_edition e ON e.id=m.edition_id JOIN catalog_printing p ON p.id=e.printing_id
              WHERE p.source_id='meta-5'""").fetchall()
        assert fresh and {(row["mapping_state"], row["matching_activation_id"]) for row in fresh} == {("verified", deploy)}
    finally:
        release.set()
        thread.join(60)
    assert rollout(MATCHING)["phase"] == "done"


# ------------------------------------------------------------------ short transactions


@pytest.mark.slow(reason="sleep: 0.5 s inside each batch")
@pytest.mark.serial(reason="asserts an elapsed-time bound")
def test_a_collection_write_made_during_a_batch_is_not_held_up_by_the_rollout(monkeypatch):
    monkeypatch.setenv("RULE_ROLLOUT_BATCH", "2")
    seed(4)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    batches, second_batch = [], threading.Event()

    def slow_batch(phase):
        if phase == "editions":
            batches.append(1)
            if len(batches) >= 2:
                second_batch.set()  # a batch's transaction is open from here for 0.5 s
            time.sleep(0.5)

    monkeypatch.setattr(rule_rollout, "_in_batch", slow_batch)
    thread = threading.Thread(target=rule_rollout.apply_newest_rules)
    thread.start()
    try:
        assert second_batch.wait(60), "the rollout never reached its second batch"
        with connect() as conn:
            user = conn.execute("SELECT user_id FROM owner_binding WHERE singleton").fetchone()["user_id"]
        started = time.monotonic()
        with connect() as conn, conn.transaction():
            conn.execute("SET LOCAL lock_timeout='3s'")
            conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE", (user,))
            conn.execute("UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s", (user,))
        assert time.monotonic() - started < 1.25
    finally:
        thread.join(60)


def test_a_live_collision_is_decided_in_one_transaction_and_neither_claimant_qualifies(monkeypatch):
    monkeypatch.setitem(LIVE_RULES, 98, type("Older", (LiveRulesV1,), {"SET_CODES": {"swsh3": "DAA"}}))
    reset_catalog()
    reviewer = owner()
    with connect() as conn, conn.transaction():
        activate_rule(conn, LIVE, 98, reviewer, "https://example.org/rule", "Reviewed against the target")
    twin = furret(id="meta-2", set={"id": "swsh3b", "name": "Other Set"})
    run(Records(furret(), twin, *[card(number) for number in range(10, 14)]))

    def live_state(source_id):
        with connect() as conn:
            row = conn.execute("""SELECT m.live_state,m.live_reason FROM catalog_printing_metadata m JOIN catalog_printing p ON p.id=m.printing_id
              WHERE p.source_id=%s""", (source_id,)).fetchone()
        return row["live_state"], row["live_reason"]

    assert live_state("meta-1")[0] == "eligible" and live_state("meta-2")[0] != "eligible"
    with connect() as conn:
        conn.execute("DROP TABLE IF EXISTS rule_rollout_audit")
        conn.execute("CREATE TABLE rule_rollout_audit(printing_id uuid, live_state text)")
        conn.execute("""CREATE OR REPLACE FUNCTION rule_rollout_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN INSERT INTO rule_rollout_audit VALUES (NEW.printing_id, NEW.live_state); RETURN NEW; END $$""")
        conn.execute("""CREATE TRIGGER rule_rollout_audit_trigger AFTER UPDATE ON catalog_printing_metadata
          FOR EACH ROW EXECUTE FUNCTION rule_rollout_audit_fn()""")
    try:
        monkeypatch.setenv("RULE_ROLLOUT_BATCH", "2")
        monkeypatch.setenv("RELEASE_COMMIT", new_commit())
        calls = []
        monkeypatch.setattr(rule_rollout, "_after_batch", lambda phase, done: calls.append((phase, done)))
        rule_rollout.apply_newest_rules()
        with connect() as conn:
            audit = {}
            for row in conn.execute("""SELECT p.source_id,a.live_state FROM rule_rollout_audit a JOIN catalog_printing p ON p.id=a.printing_id"""):
                audit.setdefault(row["source_id"], []).append(row["live_state"])
    finally:
        with connect() as conn:
            conn.execute("DROP TRIGGER IF EXISTS rule_rollout_audit_trigger ON catalog_printing_metadata")
            conn.execute("DROP FUNCTION IF EXISTS rule_rollout_audit_fn()")
            conn.execute("DROP TABLE IF EXISTS rule_rollout_audit")
    live_calls = [call for call in calls if call[0] == "live"]
    assert len(live_calls) == 1 and live_calls[0][1] == rollout(LIVE)["total"]
    assert live_state("meta-1") == ("suspended", "conflicting_input")
    assert live_state("meta-2") == ("unsupported", "conflicting_input")
    assert "eligible" not in audit.get("meta-2", [])
    assert audit["meta-1"] == ["suspended"]


# ------------------------------------------------------------------ never applied, never undone


def insert_activation(kind, version, digest, reviewer):
    with connect() as conn, conn.transaction():
        revision = conn.execute("SELECT catalog_begin_correction() AS r").fetchone()["r"]
        activation = conn.execute("""INSERT INTO catalog_rule_activation(kind,version,code_digest,reviewer_id,evidence_url,reason,clock_revision)
          VALUES (%s,%s,%s,%s,'https://example.org/c','Test row',%s) RETURNING id""", (kind, version, digest, reviewer, revision)).fetchone()["id"]
        conn.execute("UPDATE catalog_rule_state SET activation_id=%s WHERE kind=%s", (activation, kind))


def bound_owner():
    with connect() as conn:
        return conn.execute("SELECT user_id FROM owner_binding WHERE singleton").fetchone()["user_id"]


def test_a_changed_digest_for_the_same_version_is_never_applied(monkeypatch):
    seed(3)
    insert_activation(MATCHING, max(MATCHING_RULES), "0" * 64, bound_owner())
    before, commit = mapping(), new_commit()
    monkeypatch.setenv("RELEASE_COMMIT", commit)
    assert rule_rollout.apply_newest_rules()[MATCHING] == "digest_mismatch"
    assert deploy_rows(commit, MATCHING) == [] and mapping() == before


def test_an_active_version_newer_than_the_code_records_nothing_and_keeps_verified_editions(monkeypatch):
    seed(3)
    newest = max(MATCHING_RULES)
    monkeypatch.setitem(MATCHING_RULES, newest + 1, type("Newer", (MATCHING_RULES[newest],), {}))
    first, second = new_commit(), new_commit()
    monkeypatch.setenv("RELEASE_COMMIT", first)
    assert rule_rollout.apply_newest_rules()[MATCHING] == "applied"
    verified = mapping()
    assert {value[0] for value in verified.values()} == {"verified"}
    del MATCHING_RULES[newest + 1]
    monkeypatch.setenv("RELEASE_COMMIT", second)
    assert rule_rollout.apply_newest_rules()[MATCHING] == "newer_than_code"
    assert deploy_rows(second, MATCHING) == [] and mapping() == verified


def test_without_a_bound_owner_nothing_is_recorded_until_the_next_resume(monkeypatch):
    seed(3)
    commit = new_commit()
    monkeypatch.setenv("RELEASE_COMMIT", commit)
    with connect() as conn:
        conn.execute("DELETE FROM owner_binding")
    assert rule_rollout.apply_newest_rules() == {LIVE: "no_owner", MATCHING: "no_owner"}
    assert deploy_rows(commit) == []
    owner()
    rule_rollout.resume()
    assert len(deploy_rows(commit)) == 2 and [rollout(kind)["phase"] for kind in KINDS] == ["done", "done"]


def test_without_a_release_commit_nothing_is_recorded():
    seed(3)
    assert rule_rollout.apply_newest_rules() == {LIVE: "no_release", MATCHING: "no_release"}
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_rule_state WHERE activation_id IS NOT NULL").fetchone()["n"] == 0


def test_a_stale_runner_never_overwrites_progress(monkeypatch):
    seed(3)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    rule_rollout.apply_newest_rules()
    finished = rollout(MATCHING)
    runner = rule_rollout._Runner(connect)
    try:
        with pytest.raises(rule_rollout._Superseded):
            runner._record_failure(finished["activation_id"], "editions", None, RuntimeError("late"))
        with pytest.raises(rule_rollout._Superseded):
            runner._set_phase(finished["activation_id"], "editions", None, "phase='deliver'")
    finally:
        runner.close()
    assert rollout(MATCHING) == finished and finished["finished_at"] is not None


def test_an_unfinished_rollout_is_left_alone_under_an_incompatible_rule(monkeypatch):
    monkeypatch.setenv("RULE_ROLLOUT_BATCH", "2")
    seed(3)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())

    def kill(phase, done):
        if phase == "editions":
            raise Killed

    monkeypatch.setattr(rule_rollout, "_after_batch", kill)
    with pytest.raises(Killed):
        rule_rollout.apply_newest_rules()
    unfinished = rollout(MATCHING)
    assert unfinished["phase"] == "editions"
    monkeypatch.setattr(rule_rollout, "_after_batch", lambda phase, done: None)
    monkeypatch.setattr(rule_rollout, "code_digest", lambda kind, version: "0" * 64)
    assert rule_rollout.resume()[MATCHING] == "digest_mismatch"
    assert rollout(MATCHING) == unfinished


def test_a_stale_runner_is_superseded_after_a_restore_and_writes_nothing(monkeypatch):
    seed(3)
    older, current = new_commit(), new_commit()
    monkeypatch.setenv("RELEASE_COMMIT", older)
    rule_rollout.apply_newest_rules()
    newer_rules(monkeypatch)
    monkeypatch.setenv("RELEASE_COMMIT", current)

    def kill(phase, done):
        if phase == "editions":
            raise Killed

    monkeypatch.setattr(rule_rollout, "_after_batch", kill)
    with pytest.raises(Killed):
        rule_rollout.apply_newest_rules()
    stale = rollout(MATCHING)
    assert stale["phase"] == "quote_variants"
    assert rule_rollout.restore(connect, older, current)[MATCHING].startswith("restored")
    runner = rule_rollout._Runner(connect)
    try:
        with pytest.raises(rule_rollout._Superseded):
            runner._batch(MATCHING, stale["activation_id"], "quote_variants", None, 0)
        with pytest.raises(rule_rollout._Superseded):
            runner._record_failure(stale["activation_id"], "quote_variants", None, RuntimeError("late"))
    finally:
        runner.close()
    with connect() as conn:
        assert conn.execute("SELECT phase FROM catalog_rule_rollout WHERE activation_id=%s", (stale["activation_id"],)).fetchone()["phase"] == "quote_variants"


def test_startup_retries_while_another_runner_holds_the_lock(monkeypatch):
    results = iter([{"status": "busy"}, {"status": "busy"}, {LIVE: "current", MATCHING: "current"}])
    calls = []
    monkeypatch.setattr(rule_rollout, "resume", lambda: calls.append(1) or next(results))
    monkeypatch.setattr(rule_rollout, "STARTUP_RETRY_SECONDS", 0.01)
    rule_rollout.start_on_startup()
    rule_rollout.join_startup(10)
    assert len(calls) == 3
    always_busy = []
    monkeypatch.setattr(rule_rollout, "resume", lambda: always_busy.append(1) or {"status": "busy"})
    rule_rollout.start_on_startup()
    rule_rollout.join_startup(10)
    assert len(always_busy) == rule_rollout.STARTUP_ATTEMPTS


def test_restore_leaves_a_version_this_release_does_not_know_and_the_newer_release_applies_its_own(monkeypatch):
    seed(3)
    older, newer = new_commit(), new_commit()
    version = newer_rules(monkeypatch)
    monkeypatch.setenv("RELEASE_COMMIT", newer)
    rule_rollout.apply_newest_rules()  # the newer release's rows: live 100, matching `version`
    before = {kind: current_activation(kind)["id"] for kind in KINDS}
    del LIVE_RULES[100]
    del MATCHING_RULES[version]
    # A forward rollback: the older release's tool is asked to restore the newer release's rules.
    assert rule_rollout.restore(connect, newer, older) == {LIVE: "unchanged", MATCHING: "unchanged"}
    assert {kind: current_activation(kind)["id"] for kind in KINDS} == before


def test_the_script_reports_an_unreachable_database_only_for_connection_failures(monkeypatch, capsys):
    module = script()
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())

    def refuse(**options):
        raise psycopg.OperationalError("connection refused")

    monkeypatch.setattr(module, "connect", refuse)
    assert module.main(["resume"]) == 1
    assert "unreachable" in capsys.readouterr().err

    def cancel(*args, **kwargs):
        raise psycopg.errors.QueryCanceled("canceling statement due to statement timeout")

    monkeypatch.setattr(module, "connect", connect)
    monkeypatch.setattr(module.rule_rollout, "restore", cancel)
    assert module.main(["restore", "--to", new_commit()]) == 2
    error = capsys.readouterr().err
    assert "QueryCanceled" in error and "unreachable" not in error


def test_deliver_hands_an_undelivered_backlog_to_a_detached_drain(monkeypatch, spawned):
    seed(2)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    monkeypatch.setattr(public_catalog, "publish_catalog_best_effort", lambda *args, **kwargs: False)
    rule_rollout.apply_newest_rules()
    assert spawned == [True, True]  # one drain per kind's deliver
    assert [rollout(kind)["phase"] for kind in KINDS] == ["done", "done"]


# ------------------------------------------------------------------ rollback


def test_restore_brings_back_the_older_release_rules_without_re_evaluating(monkeypatch):
    seed(3)
    older, current = new_commit(), new_commit()
    monkeypatch.setenv("RELEASE_COMMIT", older)
    rule_rollout.apply_newest_rules()
    older_rows = {row["kind"]: row for row in deploy_rows(older)}
    with connect() as conn:
        digests = {row["kind"]: row["code_digest"] for row in conn.execute(
            "SELECT kind,code_digest FROM catalog_rule_activation WHERE source='deploy' AND release_commit=%s", (older,))}
    newer_rules(monkeypatch)
    monkeypatch.setenv("RELEASE_COMMIT", current)
    rule_rollout.apply_newest_rules()
    assert len(deploy_rows(current)) == 2
    with connect() as conn:
        snapshot = (conn.execute("SELECT printing_id,live_state,live_reason,updated_at FROM catalog_printing_metadata ORDER BY printing_id").fetchall(),
                    conn.execute("SELECT edition_id,mapping_state,mapping_reason,quote_variant,updated_at FROM catalog_edition_metadata ORDER BY edition_id").fetchall())
    assert script().main(["restore", "--to", older]) == 0
    for kind in KINDS:
        row = current_activation(kind)
        assert (row["source"], row["release_commit"], row["version"], row["code_digest"]) == (
            "rollback", older, older_rows[kind]["version"], digests[kind])
        assert rollout(kind) is None
    with connect() as conn:
        assert snapshot == (conn.execute("SELECT printing_id,live_state,live_reason,updated_at FROM catalog_printing_metadata ORDER BY printing_id").fetchall(),
                            conn.execute("SELECT edition_id,mapping_state,mapping_reason,quote_variant,updated_at FROM catalog_edition_metadata ORDER BY edition_id").fetchall())
    # The older registry (the newer versions gone) evaluates a live Printing under the restored rules.
    del LIVE_RULES[100]
    del MATCHING_RULES[max(MATCHING_RULES)]
    run(Records(*[card(number) for number in range(1, 4)], card(7)))
    with connect() as conn:
        added = conn.execute("""SELECT m.live_reason FROM catalog_printing_metadata m JOIN catalog_printing p ON p.id=m.printing_id
          WHERE p.source_id='meta-7'""").fetchone()
        assert added["live_reason"] != "no_active_rule"
        assert load_active(conn, LIVE) is not None and load_active(conn, MATCHING) is not None


def test_restore_reaches_the_owner_activation_of_a_release_that_recorded_nothing(monkeypatch):
    seed(3)
    reviewer = bound_owner()
    with connect() as conn, conn.transaction():
        activate_rule(conn, LIVE, 99, reviewer, "https://example.org/rule", "Reviewed against the target")
        activate_rule(conn, MATCHING, 1, reviewer, "https://example.org/rule", "Reviewed against the target")
        owner_rows = {row["kind"]: row for row in conn.execute("SELECT kind,version,code_digest FROM catalog_rule_activation WHERE source='owner'")}
    newer_rules(monkeypatch)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    rule_rollout.apply_newest_rules()
    results = rule_rollout.restore(connect, new_commit(), os.environ["RELEASE_COMMIT"])
    assert results == {LIVE: "restored v99", MATCHING: "restored v1"}
    for kind in KINDS:
        row = current_activation(kind)
        assert (row["source"], row["version"], row["code_digest"]) == ("rollback", owner_rows[kind]["version"], owner_rows[kind]["code_digest"])


def test_restore_changes_nothing_when_the_current_release_applied_nothing(monkeypatch):
    seed(3)
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    rule_rollout.apply_newest_rules()
    before = {kind: current_activation(kind)["id"] for kind in KINDS}
    current = new_commit()
    monkeypatch.setenv("RELEASE_COMMIT", current)
    assert rule_rollout.apply_newest_rules() == {LIVE: "current", MATCHING: "current"}  # this release records nothing
    assert rule_rollout.restore(connect, new_commit(), current) == {LIVE: "unchanged", MATCHING: "unchanged"}
    assert {kind: current_activation(kind)["id"] for kind in KINDS} == before


def test_restore_refuses_a_bad_commit(monkeypatch):
    module = script()
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    assert module.main(["restore", "--to", "nope"]) == 2
    monkeypatch.delenv("RELEASE_COMMIT")
    assert module.main(["restore", "--to", new_commit()]) == 2
    assert module.main(["restore"]) == 2
    assert module.main([]) == 2


def test_restore_waits_for_a_running_rollout(monkeypatch):
    seed(3)
    older, current = new_commit(), new_commit()
    monkeypatch.setenv("RELEASE_COMMIT", older)
    rule_rollout.apply_newest_rules()
    newer_rules(monkeypatch)
    monkeypatch.setenv("RELEASE_COMMIT", current)
    monkeypatch.setattr(rule_rollout, "RESTORE_LOCK_TIMEOUT", "5s")
    held, release = threading.Event(), threading.Event()
    monkeypatch.setattr(rule_rollout, "_after_lock", lambda: (held.set(), release.wait(30)))
    runner = threading.Thread(target=rule_rollout.apply_newest_rules)
    runner.start()
    result = {}
    restorer = threading.Thread(target=lambda: result.update(done=rule_rollout.restore(connect, older, current)))
    try:
        assert held.wait(10)
        restorer.start()
        restorer.join(0.5)
        assert restorer.is_alive()  # blocked behind the runner's lock
    finally:
        release.set()
        runner.join(60)
        restorer.join(60)
    assert all(value.startswith("restored v") for value in result["done"].values()) and len(result["done"]) == 2
    for kind in KINDS:
        assert current_activation(kind)["source"] == "rollback"


def test_restore_times_out_while_a_runner_holds_the_lock(monkeypatch):
    monkeypatch.setattr(rule_rollout, "RESTORE_LOCK_TIMEOUT", "300ms")
    with connect(autocommit=True) as holder:
        holder.execute("SELECT pg_advisory_lock(%s)", (rule_rollout.ROLLOUT_LOCK,))
        try:
            with pytest.raises(psycopg.errors.LockNotAvailable):
                rule_rollout.restore(connect, new_commit(), new_commit())
        finally:
            holder.execute("SELECT pg_advisory_unlock(%s)", (rule_rollout.ROLLOUT_LOCK,))


def test_price_import_job_resumes_the_rollout_first():
    text = (ROOT / "scripts" / "price_import_job.py").read_text()
    entry = text[text.index("if __name__ == '__main__':"):]
    assert entry.index("resume()") < entry.index("sys.exit(main())")


# ------------------------------------------------------------------ candidates stored before the import kept a key (#395)


def stored_candidate(source_id):
    with connect() as conn:
        return conn.execute("""SELECT m.mapping_candidate,m.mapping_revision,m.accepted_fingerprint FROM catalog_edition_metadata m
          JOIN catalog_edition e ON e.id=m.edition_id JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=%s""",
                            (source_id,)).fetchone()


def deploy(monkeypatch):
    monkeypatch.setenv("RELEASE_COMMIT", new_commit())
    with TestClient(app):
        rule_rollout.join_startup()


def test_a_rollout_gives_a_pre_v5_candidate_its_card_level_id_and_verifies_it_without_a_pull(monkeypatch, tcgplayer_products):
    reset_rules()
    reset_catalog()
    owner()
    run(Records(xy11_116()))
    strip_card_field("xy11-116")  # the candidate the pre-v5 importer stored
    before = stored_candidate("xy11-116")
    assert "card_tcgplayer" not in before["mapping_candidate"]
    assert states("xy11-116") == [("unverified", "no_matching_rule", None, None)]
    deploy(monkeypatch)
    assert states("xy11-116") == [("verified", None, 121240, "normal")]
    after = stored_candidate("xy11-116")
    assert after["mapping_candidate"] == {**before["mapping_candidate"], "card_tcgplayer": 121240}
    assert after["mapping_revision"] == before["mapping_revision"] + 1  # the verification, not the key, moved it


def test_the_candidate_refresh_is_enrichment_idempotent_and_leaves_other_candidates_alone(monkeypatch, tcgplayer_products):
    from app.games.pokemon.prices.catalog_targets import add_card_tcgplayer
    reset_rules()
    reset_catalog()
    owner()
    named = xy11_116("named-1", "1", 500)
    named["variants_detailed"] = [{"type": "normal", "size": "standard", "thirdParty": {"tcgplayer": 77}}]  # its own lookup names an id
    run(Records(xy11_116("plain-2", "2", 501), named, xy11_116("none-3", "3", 502)))
    with connect() as conn:
        conn.execute("""UPDATE catalog_printing_metadata SET source_record=source_record-'thirdParty' WHERE printing_id IN
          (SELECT id FROM catalog_printing WHERE source_id='none-3')""")
    for source in ("plain-2", "named-1", "none-3"):
        strip_card_field(source)
    before = {source: stored_candidate(source) for source in ("plain-2", "named-1", "none-3")}
    with connect() as conn:
        ids = [row["id"] for row in conn.execute("SELECT id FROM catalog_edition")]
        assert add_card_tcgplayer(conn, ids) == 1
        assert add_card_tcgplayer(conn, ids) == 0  # a rerun changes nothing
    after = {source: stored_candidate(source) for source in before}
    assert after["plain-2"]["mapping_candidate"]["card_tcgplayer"] == 501
    for source in ("named-1", "none-3"):
        assert after[source] == before[source]
    assert {source: value["mapping_revision"] for source, value in after.items()} == \
        {source: value["mapping_revision"] for source, value in before.items()}
    assert states("plain-2") == [("unverified", "no_matching_rule", None, None)]


def test_a_rollout_does_not_quarantine_a_verified_edition_that_lacks_the_key(monkeypatch, tcgplayer_products):
    reset_rules()
    reset_catalog()
    run(Records(xy11_116()))
    activate(MATCHING, 5)  # verified under v5 from a fresh candidate
    strip_card_field("xy11-116")
    before = stored_candidate("xy11-116")
    deploy(monkeypatch)  # applies the newest rule; a verified Edition is not in the editions phase
    assert states("xy11-116") == [("verified", None, 121240, "normal")]
    assert stored_candidate("xy11-116")["mapping_revision"] == before["mapping_revision"]
    run(Records(xy11_116()))  # the next pull writes the key back as enrichment
    assert states("xy11-116") == [("verified", None, 121240, "normal")]
    assert stored_candidate("xy11-116")["mapping_revision"] == before["mapping_revision"]
