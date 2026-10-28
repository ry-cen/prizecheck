"""What a deployed host still needs from its operator: `python -m app.host_readiness`.

The host script's readiness report (`prizecheck-deploy.sh readiness`, also the end of `setup`) runs this in the current API
image once a release is deployed. It reads and prints; it writes nothing and always exits 0, because these steps come after
the first deploy and must never fail `setup`. It prints one line per item, `ok`, `missing` or `warning`, and under each
unfinished item the next step:

  owner bound, catalog rules applied (a deploy applies them, ADR 0021), active catalog generation, last price import, scanner index,
  last catalog check, signup mode.

A database that cannot be read, or that answers too slowly (15 s a statement, 5 s on a lock), prints one `warning` line and
nothing else. The session is read-only.

Environment set by the host script: READINESS_SIGNUP_MODE (SIGNUP_MODE from the env file, read on the host: the database
does not hold it), READINESS_SCRIPT (how the operator runs the host script), READINESS_GUIDE (the deployment guide).
"""
import importlib.util
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg

from .catalog_targets import LIVE, MATCHING, load_active
from .db import connect

# A price import or catalog check that has recorded no outcome after this long did not finish (a crash or a kill).
UNFINISHED_AFTER = timedelta(hours=6)
JOB = Path(__file__).resolve().parents[2] / "scripts" / "scanner_index_job.py"
RULE_KINDS = ((LIVE, "live derivation"), (MATCHING, "marketplace matching"))


def age(moment, now):
    """A short age such as '5 minutes ago' for a timestamp."""
    seconds = max(0, int((now - moment).total_seconds()))
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if seconds >= size:
            count = seconds // size
            return f"{count} {unit}{'s' if count != 1 else ''} ago"
    return "just now"


def pinned_model_id():
    """The model id scripts/scanner_index_job.py indexes with, from the same lock file (None when it cannot be read)."""
    try:
        spec = importlib.util.spec_from_file_location("scanner_index_job", JOB)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.load_model().id
    except Exception:  # an unreadable job or lock file must not fail the report
        return None


class Report:
    def __init__(self, out):
        self.out = out

    def line(self, status, text, *next_steps):
        self.out.write(f"{status:<8} {text}\n")
        for step in next_steps:
            self.out.write(f"         next: {step}\n")

    def ok(self, text):
        self.line("ok", text)

    def missing(self, text, *next_steps):
        self.line("missing", text, *next_steps)

    def warning(self, text, *next_steps):
        self.line("warning", text, *next_steps)


def owner(conn, report, script):
    if conn.execute("SELECT 1 FROM owner_binding").fetchone():
        report.ok("The owner is bound")
        return True
    report.missing(
        "No owner is bound",
        "sign in once with the OWNER_EMAIL account, then find the account id: "
        f"{script} compose exec db psql -U prizecheck -d prizecheck -c 'select id, email from \"user\";'",
        f"bind it: {script} tool /app/scripts/bind_owner.py 'ID'",
    )
    return False


def rules(conn, report, guide, script, bound):
    inactive = []
    for kind, label in RULE_KINDS:
        active = load_active(conn, kind)
        if active is None:
            inactive.append(label)
        else:
            report.ok(f"The {label} rule is applied (version {active.version})")
    if inactive:
        names = " and ".join(inactive)
        resume = f"{script} tool /app/scripts/rule_rollout.py resume"
        report.missing(
            f"The {names} rule{'s are' if len(inactive) > 1 else ' is'} not applied",
            "a deploy applies the newest rules once the owner is bound (ADR 0021); apply or finish them now with: "
            f"{resume}" + ("" if bound else " (bind the owner first)"),
            f"Owner controls (Rules) shows a rollout's progress or error; see 'Apply the catalog rules' in {guide}",
            "until both rules are applied the daily check records a failed check and starts no pull",
        )


def generation(conn, report):
    row = conn.execute("SELECT active_generation, last_success FROM catalog_state").fetchone()
    if row is None or row["active_generation"] is None:
        report.missing(
            "No catalog generation is active: the catalog has not been pulled",
            "once both rules are applied, start the full English pull in Owner controls "
            "(the daily refresh also starts it)",
        )
        return None
    report.ok("A catalog generation is active")
    return row["active_generation"]


def prices(conn, report, now, script):
    row = conn.execute(
        "SELECT outcome, started_at, finished_at FROM price_import ORDER BY started_at DESC LIMIT 1").fetchone()
    if row is None:
        report.missing(
            "No price import has run",
            f"after the catalog pull and the rules: {script} tool /app/scripts/price_import_job.py --rematch",
        )
    elif row["outcome"] in ("imported", "unchanged"):
        report.ok(f"The last price import {row['outcome']} {age(row['finished_at'] or row['started_at'], now)}")
    elif row["outcome"] is None:
        if now - row["started_at"] > UNFINISHED_AFTER:
            report.warning(
                f"The last price import started {age(row['started_at'], now)} and did not finish",
                f"run it again: {script} tool /app/scripts/price_import_job.py",
            )
        else:
            report.ok(f"A price import started {age(row['started_at'], now)} and has not finished")
    else:
        report.warning(
            f"The last price import {row['outcome']} {age(row['finished_at'] or row['started_at'], now)}",
            f"run it again: {script} tool /app/scripts/price_import_job.py (the owner panel shows the reason)",
        )


def scanner(conn, report, generation_id, script):
    if generation_id is None:
        report.warning("The scanner index waits for the catalog", "it can be built after the catalog pull")
        return
    model_id = pinned_model_id()
    if model_id is None:
        report.warning("The scanner index could not be checked: the pinned model id is unreadable",
                       f"check the index with: {script} compose run --rm scanner-index")
        return
    row = conn.execute(
        """SELECT count(*) AS total,
                  count(*) FILTER (WHERE NOT EXISTS (
                    SELECT 1 FROM scanner_fingerprint f
                    WHERE f.printing_id = gp.printing_id AND f.image_url = gp.image_url AND f.model_id = %s)) AS missing
           FROM catalog_generation_printing gp
           WHERE gp.generation_id = %s AND NOT gp.tombstoned AND gp.image_url IS NOT NULL AND gp.image_url <> ''""",
        (model_id, generation_id)).fetchone()
    if row["total"] == 0:
        report.warning("The active catalog has no printings with art to index")
    elif row["missing"] == 0:
        report.ok(f"The scanner index covers all {row['total']} printings")
    else:
        report.missing(
            f"{row['missing']} of {row['total']} printings have no scanner fingerprint",
            f"build the index: {script} compose run --rm scanner-index (the daily refresh also runs it)",
        )


def check(conn, report, now, script):
    row = conn.execute(
        "SELECT outcome, started_at, finished_at, error_code FROM catalog_check ORDER BY started_at DESC LIMIT 1").fetchone()
    if row is None:
        report.warning(
            "No catalog check has run yet",
            f"the daily timer runs it, or run it now: {script} catalog-refresh",
        )
    elif row["outcome"] == "failed":
        detail = f" ({row['error_code']})" if row["error_code"] else ""
        report.warning(
            f"The last catalog check failed{detail}, {age(row['started_at'], now)}",
            f"fix the cause (rules not applied and a TCGdex error are the usual ones), then: {script} catalog-refresh",
        )
    elif row["outcome"] is None:
        if now - row["started_at"] > UNFINISHED_AFTER:
            report.warning(
                f"The last catalog check started {age(row['started_at'], now)} and did not finish",
                f"run it again: {script} catalog-refresh",
            )
        else:
            report.ok(f"A catalog check started {age(row['started_at'], now)} and has not finished")
    else:
        report.ok(f"The last catalog check ended {row['outcome'].replace('_', ' ')}, {age(row['started_at'], now)}")


def signup(report, mode, guide):
    if mode == "owner-only" and guide.endswith("deployment-oracle.md"):
        report.ok(f"Signup mode: owner-only (to open it, follow 'Opening signup' in {guide})")
    elif mode:
        report.ok(f"Signup mode: {mode}")
    else:
        report.warning("Signup mode: unknown (the host script did not pass SIGNUP_MODE)")


def main(out=None, environ=None) -> int:
    out = out or sys.stdout
    env = os.environ if environ is None else environ
    script = env.get("READINESS_SCRIPT") or "prizecheck-deploy.sh"
    guide = env.get("READINESS_GUIDE") or "the deployment guide"
    report = Report(out)
    now = datetime.now(timezone.utc)
    try:
        with connect(connect_timeout=10, options="-c statement_timeout=15000 -c lock_timeout=5000") as conn:
            conn.read_only = True
            bound = owner(conn, report, script)
            rules(conn, report, guide, script, bound)
            generation_id = generation(conn, report)
            prices(conn, report, now, script)
            scanner(conn, report, generation_id, script)
            check(conn, report, now, script)
    except psycopg.Error as error:
        # Only the error's class: a message can carry the connection string.
        report.warning(f"Could not read the database ({type(error).__name__}); the app's state is unknown",
                       f"{script} status")
        return 0
    signup(report, env.get("READINESS_SIGNUP_MODE", ""), guide)
    return 0


if __name__ == "__main__":
    sys.exit(main())
