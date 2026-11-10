"""The Pokémon migration entry (scripts/migrate.py) over the track runner (scripts/migration_tracks.py), on disposable
databases. Fixture trees stand in for the repository: the real scripts, synthetic migration files, one scratch database
each. The DB-free half is tests/tooling/test_migration_tracks.py."""
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


def test_a_core_only_pending_file_is_applied_and_recorded_under_its_path_qualified_name(scratch):
    root, url = scratch
    write(root, {"001_a.sql": "CREATE TABLE seen (n serial, name text);"})
    assert migrate(root, url) == ["001_a.sql"]
    # The Pokémon database is already deployed; the only pending file is core's.
    write(root, {"core/001_x.sql": "INSERT INTO seen (name) VALUES ('core/001_x');"})
    assert migrate(root, url) == ["core/001_x.sql"]
    assert ledger(url) == {"001_a.sql", "core/001_x.sql"}
    assert migrate(root, url) == []


def test_pending_core_files_apply_before_pending_game_files(scratch):
    root, url = scratch
    write(root, {
        "core/001_x.sql": "CREATE TABLE seen (n serial, name text); INSERT INTO seen (name) VALUES ('core/001_x');",
        "core/002_y.sql": "INSERT INTO seen (name) VALUES ('core/002_y');",
        "001_a.sql": "INSERT INTO seen (name) VALUES ('001_a');",
        "002_b.sql": "INSERT INTO seen (name) VALUES ('002_b');",
    })
    assert migrate(root, url) == ["core/001_x.sql", "core/002_y.sql", "001_a.sql", "002_b.sql"]
    with psycopg.connect(url) as conn:
        assert [row[0] for row in conn.execute("SELECT name FROM seen ORDER BY n")] == ["core/001_x", "core/002_y", "001_a", "002_b"]


def test_a_failing_file_commits_nothing_from_the_run(scratch):
    root, url = scratch
    write(root, {"core/001_x.sql": "CREATE TABLE kept (n int);", "001_a.sql": "SELECT * FROM missing_table;"})
    run = subprocess.run([sys.executable, str(root / "scripts/migrate.py")], cwd=root, env={**os.environ, "DATABASE_URL": url},
                         capture_output=True, text=True)
    assert run.returncode != 0
    with psycopg.connect(url) as conn:
        assert conn.execute("SELECT to_regclass('schema_migration')").fetchone()[0] is None
        assert conn.execute("SELECT to_regclass('kept')").fetchone()[0] is None


def test_on_todays_tree_the_ledger_holds_exactly_the_root_files_under_their_unqualified_names():
    """The test database was built by scripts/migrate.py: same files, same names as before tracks, none path-qualified."""
    with connect() as conn:
        names = {row["name"] for row in conn.execute("SELECT name FROM schema_migration")}
    assert names == {path.name for path in (ROOT / "migrations").glob("*.sql")}
    assert not any("/" in name for name in names)


def test_a_nested_migration_file_stops_the_run_before_anything_is_applied_or_recorded(scratch):
    root, url = scratch
    write(root, {"core/001_x.sql": "CREATE TABLE kept (n int);", "001_a.sql": "CREATE TABLE kept_too (n int);",
                 "core/x/001_a.sql": "CREATE TABLE never (n int);"})
    run = subprocess.run([sys.executable, str(root / "scripts/migrate.py")], cwd=root, env={**os.environ, "DATABASE_URL": url},
                         capture_output=True, text=True)
    assert run.returncode != 0
    assert "migrations/core/x/001_a.sql" in run.stderr
    with psycopg.connect(url) as conn:
        assert conn.execute("SELECT to_regclass('schema_migration'), to_regclass('kept'), to_regclass('kept_too'), to_regclass('never')").fetchone() == (None, None, None, None)
    # Moved to its track directory, the same file runs.
    (root / "migrations/core/x/001_a.sql").rename(root / "migrations/core/002_a.sql")
    assert migrate(root, url) == ["core/001_x.sql", "core/002_a.sql", "001_a.sql"]
