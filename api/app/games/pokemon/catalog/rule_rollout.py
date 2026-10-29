"""Deploying a release applies its newest catalog rules (ADR 0021, tcgcsv-prices design section 4.15).

Each rule kind has a newest registered version. When a release starts with a valid ``RELEASE_COMMIT`` and a bound owner,
``apply_newest_rules`` records a ``deploy`` activation for any kind whose newest version is not the active one, then
re-evaluates the affected targets in a resumable rollout of short transactions:

    live rule      live -> deliver -> done
    matching rule  editions -> quote_variants -> deliver -> done

The ``editions`` phase first gives each batch's unverified Editions the candidate keys the active rule reads and only the
catalog import used to write (``card_tcgplayer``, rebuilt from the stored source record), so a release's new input does not
wait for the next catalog pull. This is enrichment: it never moves a mapping revision.

One runner at a time holds a session advisory lock on a dedicated autocommit connection that does no other work. Every
transaction first checks that the rule state still points at its activation and that the rollout row is in the phase and
cursor the runner expects, so a stale runner (or one that lost its lock connection) writes nothing. ``restore`` brings the
older release's activations back on a rollback without re-evaluating anything.

Lock order everywhere: ``catalog_begin_correction()`` (the clock row), then the ``catalog_rule_state`` row, then the
rollout row, then target rows. ``catalog_begin_correction()`` is only called once a transaction is going to write.
"""
import logging
import os
import re
import time
from threading import Thread

import psycopg

from . import public_catalog

from ..prices import card_art

from ..prices import price_binding

from ..prices import public_prices
from ..prices.catalog_targets import (LIVE, LIVE_CANDIDATES, MATCHING, QUOTE_VARIANT_EDITIONS, REGISTRIES, UNVERIFIED_EDITIONS,
                              TargetContext, add_card_tcgplayer, code_digest, load_active, record_activation, reevaluate_live, refresh_editions)
from app.db import connect

log = logging.getLogger(__name__)

ROLLOUT_LOCK = 914720
MAX_ATTEMPTS = 5
BACKOFF_SECONDS = (1, 2, 4, 8)
LOCK_TIMEOUT = "5s"
RESTORE_LOCK_TIMEOUT = "120s"
RESTORE_TRANSACTION_TIMEOUT = "60s"
REPOSITORY = "https://github.com/ry-cen/prizecheck/commit/"
COMMIT = re.compile(r"[0-9a-f]{40}")
BATCH_FILTERS = {"editions": UNVERIFIED_EDITIONS, "quote_variants": QUOTE_VARIANT_EDITIONS}
NEXT_PHASE = {"editions": "quote_variants", "quote_variants": "deliver"}

STARTUP_ATTEMPTS = 5
STARTUP_RETRY_SECONDS = 60

_startup_thread = None


def batch_size() -> int:
    return max(1, int(os.environ.get("RULE_ROLLOUT_BATCH", "200")))


def release_commit() -> str | None:
    value = os.environ.get("RELEASE_COMMIT", "")
    return value if COMMIT.fullmatch(value) else None


# Test seams: no-ops in production.
def _after_lock():
    pass


def _in_batch(phase):
    pass


def _after_batch(phase, done):
    pass


class _Stop(Exception):
    """Ends the work on one kind without retrying and without writing."""


class _Superseded(_Stop):
    """The rule state or the rollout row is no longer what this runner expects (a rollback, or another runner)."""


class _Changed(_Stop):
    """Between the unlocked decision and the locked re-read, the decision changed."""

    def __init__(self, decision):
        super().__init__(decision)
        self.decision = decision


class _Exhausted(Exception):
    def __init__(self, cause):
        super().__init__(str(cause))
        self.cause = cause


def _describe(exc) -> str:
    lines = str(exc).splitlines()
    return f"{type(exc).__name__}: {(lines[0] if lines else '')[:300]}"


def _set_lock_timeout(conn, value=None):
    conn.execute(f"SET LOCAL lock_timeout = '{value or LOCK_TIMEOUT}'")


def _advance(conn, activation, phase, cursor, sets, params=()):
    """Compare-and-set a rollout row: it changes only while it is still in the phase and cursor the caller expects."""
    updated = conn.execute(f"""UPDATE catalog_rule_rollout SET {sets}, updated_at=now()
      WHERE activation_id=%s AND phase=%s AND cursor IS NOT DISTINCT FROM %s""", (*params, activation, phase, cursor)).rowcount
    if updated != 1:
        raise _Superseded()


def _guard_current(conn, activation):
    if conn.execute("SELECT 1 FROM catalog_rule_state WHERE activation_id=%s", (activation,)).fetchone() is None:
        raise _Superseded()


def _guard_batch(conn, activation, phase, cursor):
    """D7: the state still points at this activation and the rollout row is where this runner left it (row locked)."""
    _guard_current(conn, activation)
    row = conn.execute("SELECT phase,cursor FROM catalog_rule_rollout WHERE activation_id=%s FOR UPDATE", (activation,)).fetchone()
    if row is None or row["phase"] != phase or row["cursor"] != cursor:
        raise _Superseded()


class _Runner:
    def __init__(self, connect_fn):
        self.connect_fn = connect_fn
        self.conn = connect_fn(autocommit=True)

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass

    def _reopen(self):
        self.close()
        try:
            self.conn = self.connect_fn(autocommit=True)
        except Exception as exc:  # The next try fails on the closed connection and is counted.
            log.warning("Catalog rule rollout could not reconnect (%s)", type(exc).__name__)

    def _attempt(self, work):
        """Run ``work`` up to MAX_ATTEMPTS times with backoff; a lost connection is replaced (never the lock connection)."""
        last = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                return work()
            except _Stop:
                raise
            except Exception as exc:
                last = exc
                log.warning("Catalog rule rollout step failed (%s), attempt %d of %d", type(exc).__name__, attempt + 1, MAX_ATTEMPTS)
                if isinstance(exc, psycopg.OperationalError):
                    self._reopen()
                if attempt < MAX_ATTEMPTS - 1:
                    time.sleep(BACKOFF_SECONDS[min(attempt, len(BACKOFF_SECONDS) - 1)])
        raise _Exhausted(last)

    # ------------------------------------------------------------ apply

    def _decide(self, kind):
        """What this release does for a kind: one of the outcomes, or ``apply`` with the bound owner."""
        row = self.conn.execute("""SELECT a.version,a.code_digest FROM catalog_rule_state s
          JOIN catalog_rule_activation a ON a.id=s.activation_id WHERE s.kind=%s""", (kind,)).fetchone()
        newest = max(REGISTRIES[kind])
        if row and row["version"] is not None and row["version"] not in REGISTRIES[kind]:
            log.warning("Active %s version %d is newer than this release knows; nothing is applied", kind, row["version"])
            return "newer_than_code", None
        if row and row["version"] == newest:
            if row["code_digest"] != code_digest(kind, newest):
                log.error("Rule %s version %d differs from the digest recorded when it was applied; nothing is applied", kind, newest)
                return "digest_mismatch", None
            return "current", None
        if release_commit() is None:
            return "no_release", None
        owner = self.conn.execute("SELECT user_id FROM owner_binding WHERE singleton").fetchone()
        if owner is None:
            return "no_owner", None
        return "apply", owner["user_id"]

    def apply(self, kind):
        decision, _ = self._decide(kind)
        if decision != "apply":
            return decision
        try:
            return self._attempt(lambda: self._apply_transaction(kind))
        except _Changed as changed:
            return changed.decision

    def _apply_transaction(self, kind):
        conn = self.conn
        with conn.transaction():
            _set_lock_timeout(conn)
            conn.execute("SELECT catalog_begin_correction()")
            conn.execute("SELECT 1 FROM catalog_rule_state WHERE kind=%s FOR UPDATE", (kind,))
            decision, owner = self._decide(kind)
            if decision != "apply":
                raise _Changed(decision)  # Rolls back, clock bump included.
            commit = release_commit()
            activation = record_activation(conn, kind, max(REGISTRIES[kind]), owner, REPOSITORY + commit,
                                           f"Applied by deploying {commit[:7]}", source="deploy", release_commit=commit)
            conn.execute("INSERT INTO catalog_rule_rollout(activation_id,phase) VALUES (%s,%s)",
                         (activation, "live" if kind == LIVE else "editions"))
        return "applied"

    # ------------------------------------------------------------ rollout

    def _set_phase(self, activation, phase, cursor, sets, params=()):
        """One guarded transition in its own transaction."""
        with self.conn.transaction():
            _set_lock_timeout(self.conn)
            _guard_current(self.conn, activation)
            _advance(self.conn, activation, phase, cursor, sets, params)

    def _record_failure(self, activation, phase, cursor, exc):
        with self.conn.transaction():
            _set_lock_timeout(self.conn)
            _guard_current(self.conn, activation)
            _advance(self.conn, activation, phase, cursor, "phase='failed', failed_phase=%s, error=%s",
                     (phase, _describe(exc)[:1000]))

    def continue_rollout(self, kind):
        row = self.conn.execute("""SELECT r.* FROM catalog_rule_state s JOIN catalog_rule_rollout r ON r.activation_id=s.activation_id
          WHERE s.kind=%s""", (kind,)).fetchone()
        if row is None or row["phase"] == "done":
            return
        activation = row["activation_id"]
        active = load_active(self.conn, kind)
        if active is None or active.activation_id != activation:
            return  # D12: only under a compatible rule (registered version, matching digest).
        phase, cursor, done = row["phase"], row["cursor"], row["done"]
        try:
            if phase == "failed":
                failed_phase = row["failed_phase"]
                self._attempt(lambda: self._set_phase(activation, "failed", cursor,
                                                      "phase=failed_phase, failed_phase=NULL, error=NULL"))
                phase = failed_phase
            while phase != "done":
                try:
                    if phase == "live":
                        phase, cursor, done = self._attempt(lambda: self._live(kind, activation, cursor))
                    elif phase in BATCH_FILTERS:
                        phase, cursor, done = self._attempt(lambda: self._batch(kind, activation, phase, cursor, done))
                    else:
                        self._attempt(lambda: self._deliver(activation, cursor))
                        phase = "done"
                except _Exhausted as exhausted:
                    log.error("Catalog rule rollout failed in %s (%s)", phase, type(exhausted.cause).__name__)
                    try:
                        self._record_failure(activation, phase, cursor, exhausted.cause)
                    except _Superseded:
                        raise
                    except Exception as exc:  # The row stays as it was; the next run tries this kind again.
                        log.warning("Catalog rule rollout failure not recorded (%s)", type(exc).__name__)
                    return
        except _Superseded:
            return
        except _Exhausted:  # The failed-state reset itself kept failing; the row is still failed and the next run retries.
            return

    def _live(self, kind, activation, cursor):
        conn = self.conn
        with conn.transaction():
            _set_lock_timeout(conn)
            conn.execute("SELECT catalog_begin_correction()")
            _guard_batch(conn, activation, "live", cursor)
            total = conn.execute(f"SELECT count(*) AS n FROM catalog_printing_metadata WHERE {LIVE_CANDIDATES}").fetchone()["n"]
            changed = reevaluate_live(conn, TargetContext(conn))
            _advance(conn, activation, "live", cursor, "phase='deliver', cursor=NULL, total=%s, done=%s, changed=changed+%s",
                     (total, total, changed))
            _in_batch("live")
        _after_batch("live", total)
        return "deliver", None, total

    def _batch(self, kind, activation, phase, cursor, done):
        conn = self.conn
        size = batch_size()
        filter_ = BATCH_FILTERS[phase]
        with conn.transaction():
            _set_lock_timeout(conn)
            conn.execute("SELECT catalog_begin_correction()")
            _guard_batch(conn, activation, phase, cursor)
            total = None
            if cursor is None and done == 0:
                total = conn.execute(f"SELECT count(*) AS n FROM catalog_edition_metadata WHERE {filter_}").fetchone()["n"]
            ids = [r["edition_id"] for r in conn.execute(f"""SELECT edition_id FROM catalog_edition_metadata
              WHERE {filter_} AND (%(c)s::uuid IS NULL OR edition_id > %(c)s) ORDER BY edition_id LIMIT %(n)s""",
                                                           {"c": cursor, "n": size})]
            context = TargetContext(conn)
            if phase == "editions" and context.matching is not None and hasattr(context.matching.rule, "card_product"):
                add_card_tcgplayer(conn, ids)  # candidates stored before the import kept this key gain it, then are evaluated
            changed = refresh_editions(conn, context, ids, complete=(phase == "quote_variants"))
            _in_batch(phase)
            if len(ids) < size:
                _advance(conn, activation, phase, cursor, "phase=%s, cursor=NULL, done=0, total=NULL, changed=changed+%s",
                         (NEXT_PHASE[phase], changed))
                result = (NEXT_PHASE[phase], None, 0)
            else:
                _advance(conn, activation, phase, cursor, "cursor=%s, done=done+%s, total=COALESCE(%s, total), changed=changed+%s",
                         (ids[-1], len(ids), total, changed))
                result = (phase, ids[-1], done + len(ids))
        _after_batch(phase, done + len(ids))
        return result

    def _deliver(self, activation, cursor):
        conn = self.conn
        price_binding.rebind(conn)  # Must succeed: bindings follow the new mappings.
        try:
            public_prices.publish(conn)
        except Exception as exc:  # The next price import publishes.
            log.warning("Public prices not published after the rule rollout (%s)", type(exc).__name__)
        card_art.refresh_fallbacks(conn)  # Must succeed.
        if not public_catalog.publish_catalog_best_effort(conn):
            public_catalog.spawn_background_drain()
        self._set_phase(activation, "deliver", cursor, "phase='done', finished_at=now(), error=NULL")


def apply_newest_rules(connect_fn=connect) -> dict:
    """Apply each kind's newest version, then continue its rollout. {"status": "busy"} when another runner holds the lock."""
    lock = connect_fn(autocommit=True)
    try:
        if not lock.execute("SELECT pg_try_advisory_lock(%s) AS ok", (ROLLOUT_LOCK,)).fetchone()["ok"]:
            return {"status": "busy"}
        _after_lock()
        runner = _Runner(connect_fn)
        try:
            outcome = {}
            for kind in (LIVE, MATCHING):  # Live first.
                try:
                    outcome[kind] = runner.apply(kind)
                    if outcome[kind] not in ("digest_mismatch", "newer_than_code"):
                        runner.continue_rollout(kind)
                except _Exhausted as exhausted:
                    log.error("Catalog rule %s not applied (%s)", kind, type(exhausted.cause).__name__)
                    outcome[kind] = "failed"
            return outcome
        finally:
            runner.close()
    finally:
        lock.close()  # Ending the session releases the lock, even after a BaseException.


def resume(connect_fn=connect) -> dict | None:
    """Finish or apply this release's catalog rules. Never raises an Exception: a failure is logged and retried later."""
    try:
        return apply_newest_rules(connect_fn)
    except Exception as exc:
        log.warning("Catalog rule rollout stopped (%s)", type(exc).__name__)
        return None


# ---------------------------------------------------------------- rollback


def _bad_commit(value) -> bool:
    return not isinstance(value, str) or COMMIT.fullmatch(value) is None


def _restore_target(conn, kind, to_commit, current_commit):
    columns = "id,version,code_digest,reviewer_id"
    row = conn.execute(f"""SELECT {columns} FROM catalog_rule_activation WHERE kind=%s AND source IN ('deploy','rollback')
      AND release_commit=%s ORDER BY clock_revision DESC, activated_at DESC LIMIT 1""", (kind, to_commit)).fetchone()
    if row:
        return row
    first = conn.execute("""SELECT clock_revision FROM catalog_rule_activation WHERE kind=%s AND source='deploy' AND release_commit=%s
      ORDER BY clock_revision, activated_at LIMIT 1""", (kind, current_commit)).fetchone()
    if first is None:
        return None  # The current release changed nothing for this kind.
    row = conn.execute(f"""SELECT {columns} FROM catalog_rule_activation WHERE kind=%s AND clock_revision < %s
      ORDER BY clock_revision DESC, activated_at DESC LIMIT 1""", (kind, first["clock_revision"])).fetchone()
    if row is None:
        log.warning("No activation of %s before release %s to restore", kind, current_commit[:7])
    return row


def _plan(conn, to_commit, current_commit):
    plan = {}
    for kind in (LIVE, MATCHING):
        active = conn.execute("""SELECT a.version,a.code_digest FROM catalog_rule_state s
          JOIN catalog_rule_activation a ON a.id=s.activation_id WHERE s.kind=%s""", (kind,)).fetchone()
        target = _restore_target(conn, kind, to_commit, current_commit)
        if target is not None and target["version"] is not None and target["version"] not in REGISTRIES[kind]:
            # A forward rollback: this release does not know the version. The newer release applies its own at start.
            log.warning("Version %d of %s is newer than this release knows; leaving the active rule", target["version"], kind)
            plan[kind] = None
        elif target is None or target["version"] is None or (
                active and (active["version"], active["code_digest"]) == (target["version"], target["code_digest"])):
            plan[kind] = None
        else:
            plan[kind] = target
    return plan


def restore(connect_fn, to_commit: str, current_commit: str) -> dict[str, str]:
    """Make the activations the release ``to_commit`` knows current again. Re-evaluates nothing and creates no rollout.

    Holds the rollout lock (blocking, up to RESTORE_LOCK_TIMEOUT) so a runner mid-rollout finishes first; a timeout
    raises and the rollback is refused.
    """
    if _bad_commit(to_commit) or _bad_commit(current_commit):
        raise ValueError("Releases are named by their 40-character commit")
    lock = connect_fn(autocommit=True)
    try:
        lock.execute(f"SET lock_timeout = '{RESTORE_LOCK_TIMEOUT}'")
        lock.execute("SELECT pg_advisory_lock(%s)", (ROLLOUT_LOCK,))
        lock.execute("SET lock_timeout = DEFAULT")
        with connect_fn(autocommit=True) as conn:
            result = {kind: "unchanged" for kind in (LIVE, MATCHING)}
            if not any(_plan(conn, to_commit, current_commit).values()):
                return result
            with conn.transaction():
                _set_lock_timeout(conn, RESTORE_TRANSACTION_TIMEOUT)
                conn.execute("SELECT catalog_begin_correction()")
                conn.execute("SELECT 1 FROM catalog_rule_state WHERE kind IN (%s,%s) ORDER BY kind FOR UPDATE", (LIVE, MATCHING))
                owner = conn.execute("SELECT user_id FROM owner_binding WHERE singleton").fetchone()
                for kind, target in _plan(conn, to_commit, current_commit).items():
                    if target is None:
                        continue
                    record_activation(conn, kind, target["version"], owner["user_id"] if owner else target["reviewer_id"],
                                      REPOSITORY + to_commit, f"Restored by rolling back to {to_commit[:7]}", source="rollback",
                                      release_commit=to_commit, digest=target["code_digest"])
                    result[kind] = f"restored v{target['version']}"
            return result
    finally:
        lock.close()


# ---------------------------------------------------------------- startup


def _startup():
    """Another runner (a job, or an old API during a deploy) may hold the lock; try again a few times, never in a request."""
    for attempt in range(STARTUP_ATTEMPTS):
        result = resume()
        if not (isinstance(result, dict) and result.get("status") == "busy"):
            return
        if attempt < STARTUP_ATTEMPTS - 1:
            time.sleep(STARTUP_RETRY_SECONDS)


def start_on_startup() -> None:
    """Apply or finish the release's rules in a background thread, so startup and health checks never wait for it."""
    global _startup_thread
    _startup_thread = Thread(target=_startup, daemon=True, name="rule-rollout")
    _startup_thread.start()


def join_startup(timeout=60.0):
    if _startup_thread is not None:
        _startup_thread.join(timeout)
