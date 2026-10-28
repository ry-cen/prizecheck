"""The scheduled catalog change check (ADR 0018, #339): `python -m app.catalog_refresh`.

It reads TCGdex's card list (the importer's own enumeration, exclusions included), compares the ids with the active
generation's live Printings and records one `catalog_check` row. If the ids differ it starts a pull through the owner
dispatch, waits for that run to end and exits with a code the host script (`prizecheck-deploy.sh catalog-refresh`) reads.
It fetches no card and changes no catalog data itself; a changed existing card still reaches `catalog_review` through the
pull. The pull runs as a child of this process, so the process stays up until the child has exited.

`python -m app.catalog_refresh --record-index <check id> <exit code>` writes the scanner index job's exit status on a
check row (the host cannot write the row itself).

Exit codes of the check:
  0  no_change; a pull the check started and that succeeded; pull_running (a pull was already running); or paused
  1  the database could not be reached
  2  the check failed (TCGdex error or an invalid list, or a catalog rule is not active); the host still runs the scanner index and exits non-zero at the end
  4  a pull the check started failed or was interrupted (including a failed launch); the host skips the index
  any other code is a failure to the host, which runs the index only if a check id was printed
`--record-index` exits 0 once the row is written, 1 otherwise.

Stdout carries exactly one line, `catalog_check_id=<uuid>`, printed as soon as the check's row is committed; every log goes
to stderr, and no log carries a secret or a raw TCGdex payload.

Rules: when the live-derivation or the marketplace-matching rule is not active, the check records `failed` with error_code
CATALOG_RULES_INACTIVE and starts nothing: with no active catalog every id looks new, and the check would start a full pull
before the owner has activated the rules (docs/deployment-oracle.md, step 14).

Pause: when 3 or more pulls this check started have failed since the latest successful pull (whoever started that one), the
check records `paused` with the newest such failure's error and starts nothing. Any successful pull, owner- or check-started,
clears it; an owner-started failure never counts.
"""
import argparse
import logging
import re
import sys
from uuid import UUID

import psycopg
from fastapi import HTTPException

from .catalog import CatalogError, TCGdexSource
from .catalog_dispatch import RUNNER_LOCK, dispatch_import_detailed
from .catalog_targets import LIVE, MATCHING, load_active
from .db import connect

log = logging.getLogger("catalog_refresh")

EXIT_OK, EXIT_DATABASE, EXIT_CHECK_FAILED, EXIT_PULL_FAILED = 0, 1, 2, 4
PAUSE_AFTER = 3
# Bounded well below the importer's 12 attempts: 3 tries, a few seconds apart.
CHECK_ATTEMPTS, CHECK_MAX_BACKOFF = 3, 4
INTERRUPTED = "Catalog import interrupted; start a new pull"
RUNNER_LOCK_KEY = RUNNER_LOCK  # pg_locks shows the bigint key's low 32 bits as objid (classid 0 for this small key)
PULL_FAILED, PULL_INTERRUPTED = "CATALOG_PULL_FAILED", "CATALOG_PULL_INTERRUPTED"


def pull_error_code(error) -> str:
    """The check's own SCREAMING_SNAKE code for a failed pull. A genuine code already on the run (CATALOG_DISPATCH_FAILED)
    stays; the sentences the importer writes stay on catalog_run.error, which a later view can join for details."""
    if isinstance(error, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{2,}", error):
        return error
    return PULL_INTERRUPTED if error == INTERRUPTED else PULL_FAILED


def catalog_ids(conn, excluded=frozenset()) -> set[str]:
    """Source ids of the active generation's live Printings: not tombstoned, `source = 'tcgdex'`."""
    rows = conn.execute("""SELECT gp.source_id FROM catalog_state s
      JOIN catalog_generation_printing gp ON gp.generation_id = s.active_generation
      JOIN catalog_printing p ON p.id = gp.printing_id
      WHERE s.singleton AND NOT gp.tombstoned AND p.source = 'tcgdex'""").fetchall()
    return {row["source_id"] for row in rows} - set(excluded)


def pause_failures(conn) -> list[dict]:
    """The check-started pulls that failed (or were left unfinished with no live runner) after the latest successful pull,
    newest first. An owner-started run is never listed: only runs a check row names. An unfinished run counts only when no
    session holds the runner lock (an expired lease alone is not a failure)."""
    rows = conn.execute("""WITH s AS (SELECT coalesce(max(finished_at), '-infinity') AS at FROM catalog_run
        WHERE outcome = 'succeeded')
      SELECT r.id, r.error, r.outcome, coalesce(r.finished_at, r.started_at) AS ended
      FROM catalog_check c JOIN catalog_run r ON r.id = c.catalog_run_id, s
      WHERE c.catalog_run_id IS NOT NULL AND coalesce(r.finished_at, r.started_at) > s.at
        AND (r.outcome = 'failed' OR (r.outcome IS NULL
             AND coalesce(r.lease_until, r.started_at + interval '2 minutes') < clock_timestamp()
             AND NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (
                 SELECT oid FROM pg_database WHERE datname = current_database())
               AND classid = 0 AND objid = %s AND objsubid = 1)))
      ORDER BY ended DESC""", (RUNNER_LOCK_KEY,)).fetchall()
    conn.commit()
    return rows


def _finish(conn, check_id, outcome, new=None, removed=None, error=None, run_id=None):
    conn.rollback()
    conn.execute("""UPDATE catalog_check SET finished_at = now(), outcome = %s, new_count = %s, removed_count = %s,
      error_code = %s, catalog_run_id = coalesce(%s, catalog_run_id) WHERE id = %s""",
                 (outcome, new, removed, None if error is None else error[:200], run_id, check_id))
    conn.commit()
    log.info("check %s: %s", check_id, outcome)


def _fail_source(exc: Exception) -> str:
    return "TCGDEX_UNAVAILABLE" if isinstance(exc, CatalogError) and str(exc) == "TCGdex request failed" \
        else "TCGDEX_INVALID_LIST"


def _wait_for_pull(conn, run_id, child) -> tuple[str, str | None]:
    """Wait for the child (the row can say succeeded before publication has finished), then read the row fresh."""
    code = child.wait() if child is not None else None
    log.info("pull %s: importer process exited with status %s", run_id, code)
    def read():
        conn.rollback()
        row = conn.execute("SELECT outcome, error, lease_until < clock_timestamp() AS lease_expired FROM catalog_run WHERE id = %s",
                           (run_id,)).fetchone()
        conn.commit()
        return row

    def settled(row):
        if row and row["outcome"] == "succeeded":
            return "succeeded", None
        if row and row["outcome"] == "failed":
            return "failed", pull_error_code(row["error"])
        return None

    row = read()
    if settled(row):
        return settled(row)
    # The child is gone and the run is not finished: nothing is running it any more.
    if row and row["lease_expired"]:
        log.warning("pull %s: its lease had expired", run_id)
    marked = conn.execute("""UPDATE catalog_run SET phase = 'failed', outcome = 'failed', error = %s, finished_at = now(),
      lease_until = NULL WHERE id = %s AND outcome IS NULL RETURNING id""", (INTERRUPTED, run_id)).fetchone()
    conn.commit()
    if marked is None:
        # It finished between the read and the update; its real outcome is the answer.
        return settled(read()) or ("interrupted", PULL_INTERRUPTED)
    return "interrupted", PULL_INTERRUPTED


def run_check(conn, source=None, out=None) -> int:
    """One check. The caller closes `conn`; `source` is injectable for tests (enumerate() -> set of ids)."""
    out = out or sys.stdout
    check_id = conn.execute("INSERT INTO catalog_check DEFAULT VALUES RETURNING id").fetchone()["id"]
    conn.commit()
    print(f"catalog_check_id={check_id}", file=out, flush=True)
    counts = {"new": None, "removed": None}
    try:
        if any(load_active(conn, kind) is None for kind in (LIVE, MATCHING)):
            conn.commit()
            log.error("check %s: a catalog rule is not active; not starting a pull", check_id)
            _finish(conn, check_id, "failed", error="CATALOG_RULES_INACTIVE")
            return EXIT_CHECK_FAILED
        conn.commit()
        failures = pause_failures(conn)
        if len(failures) >= PAUSE_AFTER:
            log.warning("check %s: %d check-started pulls failed since the last success; not starting another",
                        check_id, len(failures))
            _finish(conn, check_id, "paused", error=PULL_INTERRUPTED if failures[0]["outcome"] is None
                    else pull_error_code(failures[0]["error"]))
            return EXIT_OK

        source = source or TCGdexSource(attempts=CHECK_ATTEMPTS, max_backoff=CHECK_MAX_BACKOFF)
        try:
            source_ids = set(source.enumerate())
            if not source_ids:
                raise CatalogError("Invalid English enumeration")
        except Exception as exc:  # CatalogError, or a body that was not JSON
            code = _fail_source(exc)
            log.error("check %s: the TCGdex list could not be used (%s)", check_id, code)
            _finish(conn, check_id, "failed", error=code)
            return EXIT_CHECK_FAILED
        excluded = getattr(source, "excluded_ids", frozenset())

        def compare() -> bool:
            current = catalog_ids(conn, excluded)
            counts["new"], counts["removed"] = len(source_ids - current), len(current - source_ids)
            return bool(counts["new"] or counts["removed"])

        different = compare()
        conn.commit()
        if not different:
            _finish(conn, check_id, "no_change", 0, 0)
            return EXIT_OK

        def reserved(c, run_id):
            # Durable before the launch, so a crash or a failed launch stays attributable to this check.
            state["run_id"] = run_id
            c.execute("""UPDATE catalog_check SET outcome = 'pull_started', catalog_run_id = %s, new_count = %s,
              removed_count = %s WHERE id = %s""", (run_id, counts["new"], counts["removed"], check_id))

        state = {"run_id": None}
        try:
            # The guard compares again inside the dispatch locks: an owner pull may have promoted meanwhile.
            dispatched = dispatch_import_detailed(conn, on_reserved=reserved, guard=lambda c: compare())
        except HTTPException:
            log.error("check %s: the pull could not be launched", check_id)
            if state["run_id"] is not None:
                _finish(conn, check_id, "pull_started", counts["new"], counts["removed"], "CATALOG_DISPATCH_FAILED",
                        state["run_id"])
            else:
                _finish(conn, check_id, "failed", counts["new"], counts["removed"], "CATALOG_DISPATCH_FAILED")
            return EXIT_PULL_FAILED
        if dispatched.declined:
            _finish(conn, check_id, "no_change", counts["new"], counts["removed"])
            return EXIT_OK
        if not dispatched.started:
            # Already running (an owner's, or an earlier one), or a promotion is committing (run_id None).
            _finish(conn, check_id, "pull_running", counts["new"], counts["removed"])
            return EXIT_OK

        log.info("check %s: %d new, %d removed; started pull %s", check_id, counts["new"], counts["removed"], dispatched.run_id)
        result, error = _wait_for_pull(conn, dispatched.run_id, dispatched.child)
        _finish(conn, check_id, "pull_started", counts["new"], counts["removed"], error, dispatched.run_id)
        return EXIT_OK if result == "succeeded" else EXIT_PULL_FAILED
    except psycopg.OperationalError:
        log.error("check %s: the database connection failed", check_id)
        return EXIT_DATABASE
    except Exception:
        # No raw exception text: it could carry a payload fragment.
        log.error("check %s: failed unexpectedly", check_id)
        try:
            _finish(conn, check_id, "failed", counts["new"], counts["removed"], "CATALOG_CHECK_ERROR")
        except Exception:
            pass
        return EXIT_CHECK_FAILED


def record_index(conn, check_id: UUID, code: int) -> int:
    row = conn.execute("UPDATE catalog_check SET index_exit_code = %s WHERE id = %s RETURNING id", (code, check_id)).fetchone()
    conn.commit()
    if row is None:
        log.error("no check %s to record the scanner index status on", check_id)
        return 1
    log.info("check %s: scanner index exit status %s", check_id, code)
    return 0


def main(argv=None) -> int:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(description="Check TCGdex for catalog changes and pull when ids differ.")
    parser.add_argument("--record-index", nargs=2, metavar=("CHECK_ID", "EXIT_CODE"),
                        help="record the scanner index job's exit status on a check row")
    args = parser.parse_args(argv)
    if args.record_index:
        try:
            check_id, code = UUID(args.record_index[0]), int(args.record_index[1])
            if not 0 <= code <= 255:
                raise ValueError
        except ValueError:
            parser.error("--record-index takes a check id (uuid) and an exit status from 0 to 255")
    try:
        with connect() as conn:
            if args.record_index:
                return record_index(conn, check_id, code)
            return run_check(conn)
    except psycopg.OperationalError:
        log.error("the database could not be reached")
        return EXIT_DATABASE


if __name__ == "__main__":
    raise SystemExit(main())
