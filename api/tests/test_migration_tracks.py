"""The Pokémon migration entry (scripts/migrate.py) over the track runner (scripts/migration_tracks.py), on disposable
databases. Fixture trees stand in for the repository: the real scripts, synthetic migration files, one scratch database
each; then the real tree, fresh and as a database that predates the core baseline (S10). The DB-free half is
tests/tooling/test_migration_tracks.py; the baseline's proof is test_core_baseline.py."""
import os
import shutil
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

from app.main import connect

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def scratch(tmp_path):
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    name = "tcg_tracks_" + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    shutil.copytree(ROOT / "scripts", tmp_path / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    tsv = tmp_path / "api/app/games/pokemon/catalog/set_codes.tsv"
    tsv.parent.mkdir(parents=True)
    shutil.copy2(ROOT / "api/app/games/pokemon/catalog/set_codes.tsv", tsv)
    url = make_conninfo(admin, dbname=name)
    try:
        yield tmp_path, url
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))


def write(root, files):
    for name, text in files.items():
        path = root / "migrations" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def migrate(root, url):
    run = subprocess.run([sys.executable, str(root / "scripts/migrate.py")], cwd=root, env={**os.environ, "DATABASE_URL": url},
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr
    return [line.removeprefix("Applied ") for line in run.stdout.splitlines() if line.startswith("Applied ")]


def ledger(url):
    with psycopg.connect(url) as conn:
        return {row[0] for row in conn.execute("SELECT name FROM schema_migration")}


# What the Pokémon entry needs of any tree: the two core files it records. In a fixture tree the root file builds the table
# the baseline "creates", so the precondition holds, and running the baseline would fail: it is recorded, not run.
STUBS = {
    "core/000_baseline.sql": "CREATE TABLE seen (n serial, name text);",
    "core/000_baseline.manifest": "table seen n name\n",
    "core/001_zip_centroids.sql": "INSERT INTO seen (name) VALUES ('seed');",
    "core/001_zip_centroids.manifest": "rows seen 1\n",
}
FIRST = {"001_a.sql": "CREATE TABLE seen (n serial, name text); INSERT INTO seen (name) VALUES ('001_a');"}


def seen(url):
    with psycopg.connect(url) as conn:
        return [row[0] for row in conn.execute("SELECT name FROM seen ORDER BY n")]


def test_a_core_only_pending_file_is_applied_and_recorded_under_its_path_qualified_name(scratch):
    root, url = scratch
    write(root, {**FIRST, **STUBS})
    assert migrate(root, url) == ["001_a.sql"]
    # The Pokémon database is already deployed; the only pending file is core's.
    write(root, {"core/002_x.sql": "INSERT INTO seen (name) VALUES ('core/002_x');"})
    assert migrate(root, url) == ["core/002_x.sql"]
    assert ledger(url) == {"001_a.sql", "core/000_baseline.sql", "core/001_zip_centroids.sql", "core/002_x.sql"}
    assert seen(url) == ["001_a", "core/002_x"]
    assert migrate(root, url) == []


def test_pending_core_files_apply_after_the_cutoff_baseline_and_before_the_root_files_after_it(scratch):
    root, url = scratch
    write(root, {**FIRST, **STUBS,
                 "core/002_y.sql": "INSERT INTO seen (name) VALUES ('core/002_y');",
                 "core/003_z.sql": "INSERT INTO seen (name) VALUES ('core/003_z');",
                 "163_b.sql": "INSERT INTO seen (name) VALUES ('163_b');",
                 "164_c.sql": "INSERT INTO seen (name) VALUES ('164_c');"})
    assert migrate(root, url) == ["001_a.sql", "core/002_y.sql", "core/003_z.sql", "163_b.sql", "164_c.sql"]
    # The baseline and the seed were recorded, not run: 'seed' was never inserted.
    assert seen(url) == ["001_a", "core/002_y", "core/003_z", "163_b", "164_c"]
    assert {"core/000_baseline.sql", "core/001_zip_centroids.sql"} <= ledger(url)


def test_a_failing_file_commits_nothing_from_the_run(scratch):
    root, url = scratch
    write(root, {**FIRST, **STUBS, "core/002_y.sql": "CREATE TABLE kept (n int);", "163_b.sql": "SELECT * FROM missing_table;"})
    run = subprocess.run([sys.executable, str(root / "scripts/migrate.py")], cwd=root, env={**os.environ, "DATABASE_URL": url},
                         capture_output=True, text=True)
    assert run.returncode != 0
    with psycopg.connect(url) as conn:
        assert conn.execute("SELECT to_regclass('schema_migration'), to_regclass('seen'), to_regclass('kept')").fetchone() == (None, None, None)


def test_a_recorded_core_file_is_refused_when_the_database_lacks_its_objects(scratch):
    root, url = scratch
    # The root file builds a different table than the baseline names, as a database that skipped a migration would.
    write(root, {"001_a.sql": "CREATE TABLE other (n int);", **STUBS})
    run = subprocess.run([sys.executable, str(root / "scripts/migrate.py")], cwd=root, env={**os.environ, "DATABASE_URL": url},
                         capture_output=True, text=True)
    assert run.returncode != 0
    assert "Refusing to record core/000_baseline.sql without running it; the database lacks table seen, column seen.n" in run.stderr
    with psycopg.connect(url) as conn:
        assert conn.execute("SELECT to_regclass('schema_migration'), to_regclass('other')").fetchone() == (None, None)


def test_on_todays_tree_the_ledger_holds_the_root_files_unqualified_and_the_two_recorded_core_names():
    """The test database was built by scripts/migrate.py: every root file under its old name, then the core baseline and seed
    recorded, with nothing path-qualified besides them."""
    with connect() as conn:
        names = {row["name"] for row in conn.execute("SELECT name FROM schema_migration")}
    assert names == {path.name for path in (ROOT / "migrations").glob("*.sql")} | {"core/000_baseline.sql", "core/001_zip_centroids.sql"}
    assert sorted(name for name in names if "/" in name) == ["core/000_baseline.sql", "core/001_zip_centroids.sql"]


def test_a_nested_migration_file_stops_the_run_before_anything_is_applied_or_recorded(scratch):
    root, url = scratch
    write(root, {**FIRST, **STUBS, "core/x/002_t.sql": "CREATE TABLE never (n int);"})
    run = subprocess.run([sys.executable, str(root / "scripts/migrate.py")], cwd=root, env={**os.environ, "DATABASE_URL": url},
                         capture_output=True, text=True)
    assert run.returncode != 0
    assert "migrations/core/x/002_t.sql" in run.stderr
    with psycopg.connect(url) as conn:
        assert conn.execute("SELECT to_regclass('schema_migration'), to_regclass('seen'), to_regclass('never')").fetchone() == (None, None, None)
    # Moved to its track directory, the same file runs.
    (root / "migrations/core/x/002_t.sql").rename(root / "migrations/core/002_t.sql")
    assert migrate(root, url) == ["001_a.sql", "core/002_t.sql"]


# --- the real tree --------------------------------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def real_root(tmp_path_factory):
    """This checkout's scripts and migrations in a scratch directory, for runs of scripts/migrate.py over the real tree."""
    root = tmp_path_factory.mktemp("pokemon-tree")
    shutil.copytree(ROOT / "scripts", root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(ROOT / "migrations", root / "migrations")
    tsv = root / "api/app/games/pokemon/catalog/set_codes.tsv"
    tsv.parent.mkdir(parents=True)
    shutil.copy2(ROOT / "api/app/games/pokemon/catalog/set_codes.tsv", tsv)
    return root


@pytest.fixture(scope="module")
def databases():
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    made = []

    def make(template=None):
        name = "tcg_tracks_" + uuid4().hex
        with psycopg.connect(admin, autocommit=True) as conn:
            if template:
                conn.execute(sql.SQL("CREATE DATABASE {} TEMPLATE {}").format(sql.Identifier(name), sql.Identifier(template)))
            else:
                conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        made.append(name)
        return make_conninfo(admin, dbname=name), name

    yield make
    with psycopg.connect(admin, autocommit=True) as conn:
        for name in made:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture(scope="module")
def fresh(databases, real_root):
    """A brand-new Pokémon database after one run of scripts/migrate.py over the real tree: the fresh path."""
    url, name = databases()
    first = run_migrate(real_root, url)
    assert first.returncode == 0, first.stdout + first.stderr
    return url, name, first.stdout


def run_migrate(root, url):
    return subprocess.run([sys.executable, str(root / "scripts/migrate.py")], cwd=root, env={**os.environ, "DATABASE_URL": url},
                          capture_output=True, text=True)


def expected_log(root, extra_after=()):
    """The Applied and Recorded lines of a fresh run, built from the files on each side of the cutoff: root files through 162,
    the two recorded core files, then root files after it (so a new 163 changes the tree and not this rule)."""
    names = sorted(path.name for path in (root / "migrations").glob("*.sql"))
    before = [name for name in names if name <= ENTRY_CUTOFF]
    after = [name for name in names if name > ENTRY_CUTOFF]
    return [*(f"Applied {name}" for name in before), "Recorded core/000_baseline.sql without running it",
            "Recorded core/001_zip_centroids.sql without running it", *(f"Applied {name}" for name in after)]


ENTRY_CUTOFF = "162_trade_loan_threads.sql"


def test_a_fresh_pokemon_database_runs_every_root_file_then_records_the_core_baseline_and_seed(fresh, real_root):
    url, _, output = fresh
    lines = [line for line in output.splitlines() if line.startswith(("Applied ", "Recorded "))]
    assert lines == expected_log(real_root)
    root_files = {path.name for path in (real_root / "migrations").glob("*.sql")}
    assert ledger(url) == {*root_files, "core/000_baseline.sql", "core/001_zip_centroids.sql"}
    with psycopg.connect(url) as conn:
        # The baseline would have failed on the existing tables; the seed is an upsert-free insert that would have failed
        # on the existing rows. The log above and the ledger are the evidence it was recorded and not run.
        assert conn.execute("SELECT count(*) FROM zip_centroid").fetchone()[0] == 41471
        assert conn.execute("SELECT count(*) FROM operations_state").fetchone()[0] == 1


def test_a_163_file_runs_after_the_recorded_baseline_on_a_fresh_database_without_changing_the_rule(databases, real_root, tmp_path):
    """A temporary 163 stands in for the next ordinary root migration: the fresh run's order must not move."""
    root = tmp_path / "tree"
    shutil.copytree(real_root, root)
    write(root, {"163_temporary_probe.sql": "CREATE TABLE temporary_probe (n int);"})
    url, _ = databases()
    run = run_migrate(root, url)
    assert run.returncode == 0, run.stdout + run.stderr
    lines = [line for line in run.stdout.splitlines() if line.startswith(("Applied ", "Recorded "))]
    assert lines == expected_log(root)
    assert lines[-3:] == ["Recorded core/000_baseline.sql without running it", "Recorded core/001_zip_centroids.sql without running it",
                          "Applied 163_temporary_probe.sql"]


def test_a_populated_pokemon_database_that_predates_the_baseline_gains_only_the_two_recorded_names(fresh, databases, real_root):
    _, name, _ = fresh
    url, copy = databases(template=name)
    with psycopg.connect(url) as conn:
        conn.execute("DELETE FROM schema_migration WHERE name LIKE 'core/%'")
        before = {row[0]: row[1] for row in conn.execute("SELECT name, applied_at FROM schema_migration")}
    run = run_migrate(real_root, url)
    assert run.returncode == 0, run.stdout + run.stderr
    assert [line for line in run.stdout.splitlines() if line.startswith(("Applied ", "Recorded "))] == [
        "Recorded core/000_baseline.sql without running it", "Recorded core/001_zip_centroids.sql without running it"]
    with psycopg.connect(url) as conn:
        after = {row[0]: row[1] for row in conn.execute("SELECT name, applied_at FROM schema_migration")}
    assert {name: at for name, at in after.items() if name in before} == before
    assert sorted(set(after) - set(before)) == ["core/000_baseline.sql", "core/001_zip_centroids.sql"]
    assert run_migrate(real_root, url).stdout.count("Applied ") == 0


DRIFT = (
    ("DROP VIEW open_discovery", "view open_discovery"),
    ("DROP FUNCTION trade_reach(text, text[])", "function trade_reach(viewer text, others text[])"),
    ("DROP TABLE zip_centroid CASCADE", "table zip_centroid"),
    ("DELETE FROM operations_state", "1 rows in operations_state (has 0)"),
    ("DROP TRIGGER holding_deck_list_insert ON holding", "trigger holding.holding_deck_list_insert"),
    ("ALTER TABLE holding DROP COLUMN quantity CASCADE", "column holding.quantity"),
    ("DROP INDEX holding_owner_edition_location", "index holding_owner_edition_location"),
    ("ALTER TABLE holding DROP CONSTRAINT holding_quantity_check", "constraint holding.holding_quantity_check"),
    ("ALTER TABLE holding DROP CONSTRAINT holding_owner_id_fkey", "constraint holding.holding_owner_id_fkey"),
    ("DELETE FROM zip_centroid WHERE zip > '90000'", "41471 rows in zip_centroid (has "),
    ("INSERT INTO zip_centroid (zip, lat, lon, source) VALUES ('00000', 0, 0, 'census')", "41471 rows in zip_centroid (has 41472)"),
)


@pytest.mark.parametrize("broken, wanted", DRIFT)
def test_a_populated_database_that_drifted_from_the_baseline_is_refused_and_records_nothing(fresh, databases, real_root, broken, wanted):
    """The ledger says 001 to 162 ran, but an object the baseline holds is gone or its seed is short (S10R-01)."""
    _, name, _ = fresh
    url, _ = databases(template=name)
    with psycopg.connect(url) as conn:
        conn.execute("DELETE FROM schema_migration WHERE name LIKE 'core/%'")
        conn.execute(broken)
    run = run_migrate(real_root, url)
    assert run.returncode != 0, broken
    assert wanted in run.stderr, run.stderr
    assert not [name for name in ledger(url) if name.startswith("core/")]


def test_extra_objects_on_a_populated_database_never_block_recording(fresh, databases, real_root):
    _, name, _ = fresh
    url, _ = databases(template=name)
    with psycopg.connect(url) as conn:
        conn.execute("DELETE FROM schema_migration WHERE name LIKE 'core/%'")
        conn.execute("CREATE TABLE production_only (n int); ALTER TABLE holding ADD COLUMN production_note text;"
                     " CREATE INDEX production_only_idx ON production_only (n); ALTER TABLE holding ADD CONSTRAINT production_only_check CHECK (true);"
                     " CREATE FUNCTION production_only_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';"
                     " CREATE TRIGGER production_only_trigger BEFORE INSERT ON production_only FOR EACH ROW EXECUTE FUNCTION cleanup_inventory_undo()")
    run = run_migrate(real_root, url)
    assert run.returncode == 0, run.stdout + run.stderr
    assert {"core/000_baseline.sql", "core/001_zip_centroids.sql"} <= ledger(url)


def test_a_pending_core_tail_and_a_later_root_file_apply_after_the_recorded_baseline_in_that_order(fresh, databases, real_root, tmp_path):
    _, name, _ = fresh
    url, _ = databases(template=name)
    root = tmp_path / "tree"
    shutil.copytree(real_root, root)
    write(root, {"core/002_tail.sql": "CREATE TABLE tail_marker (n serial, name text); INSERT INTO tail_marker (name) VALUES ('core/002_tail');",
                 "163_after.sql": "INSERT INTO tail_marker (name) VALUES ('163_after');"})
    assert migrate(root, url) == ["core/002_tail.sql", "163_after.sql"]
    with psycopg.connect(url) as conn:
        assert [row[0] for row in conn.execute("SELECT name FROM tail_marker ORDER BY n")] == ["core/002_tail", "163_after"]
