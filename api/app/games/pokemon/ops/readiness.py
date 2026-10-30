"""The Pokémon items of the host readiness report (`python -m app.host_readiness`): catalog rules applied (a deploy applies
them, ADR 0021), active catalog generation, last price import, scanner index and last catalog check, in that order.
The report's frame and the owner line are ``app.core.ops.readiness`` and ``app.host_readiness``.
"""
import importlib.util
from pathlib import Path

from app.core.ops.readiness import UNFINISHED_AFTER, age
from app.games.pokemon.prices.catalog_targets import LIVE, MATCHING, load_active

JOB = Path(__file__).resolve().parents[5] / "scripts" / "scanner_index_job.py"
RULE_KINDS = ((LIVE, "live derivation"), (MATCHING, "marketplace matching"))


def pinned_model_id():
    """The model id scripts/scanner_index_job.py indexes with, from the same lock file (None when it cannot be read)."""
    try:
        spec = importlib.util.spec_from_file_location("scanner_index_job", JOB)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.load_model().id
    except Exception:  # an unreadable job or lock file must not fail the report
        return None


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


def items(conn, report, *, now, script, guide, bound):
    rules(conn, report, guide, script, bound)
    generation_id = generation(conn, report)
    prices(conn, report, now, script)
    scanner(conn, report, generation_id, script)
    check(conn, report, now, script)
