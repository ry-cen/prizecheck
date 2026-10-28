"""The host readiness report (app.host_readiness, run by `prizecheck-deploy.sh readiness`) against a disposable PostgreSQL
database: an empty database lists every unfinished step with its command, a fully set-up one lists none, and an unreachable
database prints one warning. The report only reads, and always exits 0."""
import io
from uuid import uuid4

import pytest

from app import host_readiness
from app.catalog_targets import LIVE, MATCHING, activate_rule
from app.db import connect

SCRIPT = "bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh"
GUIDE = "docs/deployment-oracle.md"
ENVIRONMENT = {"READINESS_SIGNUP_MODE": "owner-only", "READINESS_SCRIPT": SCRIPT, "READINESS_GUIDE": GUIDE}
BASE = "https://assets.tcgdex.net/en/fx"


def clear():
    with connect() as conn:
        conn.execute("TRUNCATE catalog_review,catalog_generation_edition,catalog_generation_printing,catalog_edition,"
                     "catalog_printing,catalog_identity,catalog_generation,catalog_run,catalog_check,price_import,"
                     "scanner_fingerprint,scanner_fingerprint_failure,scanner_index CASCADE")
        conn.execute("INSERT INTO catalog_state(singleton,active_generation,revision,last_success) VALUES (true,NULL,0,NULL) "
                     "ON CONFLICT(singleton) DO UPDATE SET active_generation=NULL,revision=0,last_success=NULL")
        conn.execute("UPDATE catalog_rule_state SET activation_id=NULL")
        conn.execute("DELETE FROM owner_binding")


@pytest.fixture(autouse=True)
def empty_host():
    clear()
    yield
    clear()


def report(**environment):
    out = io.StringIO()
    code = host_readiness.main(out, {**ENVIRONMENT, **environment})
    return code, out.getvalue()


def prepare_ready_host():
    """An owner, both rules, a generation with two printings that both have fingerprints, an import and a check."""
    owner = f"owner-{uuid4()}"
    generation, ids = uuid4(), [uuid4(), uuid4()]
    with connect() as conn, conn.transaction():
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (owner,))
        for kind in (LIVE, MATCHING):
            activate_rule(conn, kind, 1, owner, "https://example.org/rule", "Reviewed against the target")
        conn.execute("INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,0,'\\x00','x')", (generation,))
        conn.execute("UPDATE catalog_state SET active_generation=%s,revision=1,last_success=now()", (generation,))
        for n, pid in enumerate(ids):
            identity = uuid4()
            conn.execute("INSERT INTO catalog_identity(id,identity_key,display_name) VALUES (%s,%s,%s)",
                         (identity, f"identity-{pid}", f"Card {n}"))
            conn.execute("INSERT INTO catalog_printing(id,source,source_id,identity_id) VALUES (%s,'tcgdex',%s,%s)",
                         (pid, f"fx-{pid}", identity))
            conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,
                 collector_number,display_name,search_name,image_url,source_fingerprint,basic_energy)
                 VALUES (%s,%s,%s,'fx','Fixture',%s,%s,%s,%s,'f','not_basic')""",
                         (generation, pid, f"fx-{pid}", str(n), f"Card {n}", f"card {n}", f"{BASE}/{n}"))
            conn.execute("INSERT INTO scanner_fingerprint(printing_id,model_id,image_url,scale,vector) VALUES (%s,'m',%s,1,%s)",
                         (pid, f"{BASE}/{n}", b"\x00" * 384))
        conn.execute("INSERT INTO price_import(started_at,finished_at,outcome) VALUES (now()-interval '3 hours 5 minutes',now()-interval '3 hours 5 minutes','imported')")
        conn.execute("INSERT INTO catalog_check(started_at,finished_at,outcome) VALUES (now()-interval '2 hours 5 minutes',now()-interval '2 hours 5 minutes','no_change')")
    return owner, ids


def test_an_empty_host_lists_every_unfinished_step_with_its_command():
    code, text = report()
    assert code == 0
    assert "missing  No owner is bound" in text
    assert f"bind it: {SCRIPT} tool /app/scripts/bind_owner.py 'ID'" in text
    assert "missing  The live derivation and marketplace matching rules are not applied" in text
    assert f"{SCRIPT} tool /app/scripts/rule_rollout.py resume" in text
    assert "ADR 0021" in text
    assert f"'Apply the catalog rules' in {GUIDE}" in text
    assert "(bind the owner first)" in text
    assert "missing  No catalog generation is active" in text
    assert "start the full English pull in Owner controls" in text
    assert "missing  No price import has run" in text
    assert f"{SCRIPT} tool /app/scripts/price_import_job.py --rematch" in text
    assert "warning  The scanner index waits for the catalog" in text
    assert "warning  No catalog check has run yet" in text
    assert f"{SCRIPT} catalog-refresh" in text
    assert "ok       Signup mode: owner-only" in text
    # Every unfinished item is followed by a next step.
    lines = text.splitlines()
    for number, line in enumerate(lines):
        if line.startswith(("missing", "warning")) and "Signup" not in line:
            assert lines[number + 1].startswith("         next: "), line


def test_a_fully_set_up_host_lists_nothing_unfinished():
    prepare_ready_host()
    code, text = report(READINESS_SIGNUP_MODE="public")
    assert code == 0
    assert "missing" not in text and "warning" not in text, text
    assert "next:" not in text
    assert "ok       The owner is bound" in text
    assert "The live derivation rule is applied (version 1)" in text
    assert "The marketplace matching rule is applied (version 1)" in text
    assert "ok       A catalog generation is active" in text
    assert "The last price import imported 3 hours ago" in text
    assert "The scanner index covers all 2 printings" in text
    assert "The last catalog check ended no change, 2 hours ago" in text
    assert "ok       Signup mode: public" in text


def test_one_unapplied_rule_is_named_with_the_resume_command():
    owner, _ = prepare_ready_host()
    with connect() as conn:
        conn.execute("UPDATE catalog_rule_state SET activation_id=NULL WHERE kind=%s", (LIVE,))
    code, text = report(READINESS_GUIDE="docs/deployment-unraid.md")
    assert code == 0
    assert "The marketplace matching rule is applied (version 1)" in text
    assert "missing  The live derivation rule is not applied" in text
    assert f"{SCRIPT} tool /app/scripts/rule_rollout.py resume" in text
    assert "'Apply the catalog rules' in docs/deployment-unraid.md" in text
    assert "(bind the owner first)" not in text


def test_missing_fingerprints_and_a_failed_import_and_check_are_reported_with_commands():
    _, ids = prepare_ready_host()
    with connect() as conn:
        conn.execute("DELETE FROM scanner_fingerprint WHERE printing_id=%s", (ids[0],))
        conn.execute("UPDATE price_import SET outcome='failed'")
        conn.execute("UPDATE catalog_check SET outcome='failed', error_code='CATALOG_RULES_INACTIVE'")
    code, text = report()
    assert code == 0
    assert "missing  1 of 2 printings have no scanner fingerprint" in text
    assert f"{SCRIPT} compose run --rm scanner-index" in text
    assert "warning  The last price import failed 3 hours ago" in text
    assert "warning  The last catalog check failed (CATALOG_RULES_INACTIVE), 2 hours ago" in text


def test_the_report_only_reads():
    prepare_ready_host()
    tables = ("owner_binding", "catalog_rule_state", "catalog_state", "price_import", "catalog_check", "scanner_fingerprint")
    with connect() as conn:
        before = {table: conn.execute(f"SELECT count(*) AS n, md5(string_agg(t::text, '' ORDER BY t::text)) AS d FROM {table} t").fetchone()
                  for table in tables}
    report()
    with connect() as conn:
        after = {table: conn.execute(f"SELECT count(*) AS n, md5(string_agg(t::text, '' ORDER BY t::text)) AS d FROM {table} t").fetchone()
                 for table in tables}
    assert before == after


def test_an_unreachable_database_prints_one_warning_line_and_exits_zero(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://nobody:hunter2-secret@127.0.0.1:1/none")
    code, text = report()
    assert code == 0
    assert text.splitlines()[0].startswith("warning  Could not read the database (OperationalError)")
    assert len([line for line in text.splitlines() if line.startswith("warning")]) == 1
    assert "hunter2-secret" not in text and "127.0.0.1" not in text
    assert "Signup mode" not in text
