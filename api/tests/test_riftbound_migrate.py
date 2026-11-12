"""Riftbound's real migration entry on disposable databases, using the core baseline proof's helpers.

This does not prove the default multi-game test topology (IM-14 remains undecided): the shared disposable server is used
only to test migrations. It does not prove separate-role permissions, cross-game isolation or hosting readiness, nor the
16 catalog foreign keys omitted by the baseline. Riftbound's schema is incomplete until its catalog track exists.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import psycopg
import pytest

import core_baseline_ownership as owners
import schema_snapshot
from test_core_baseline import admin, baseline, databases, owned, snapshot  # noqa: F401

ROOT = Path(__file__).resolve().parents[2]
STUB = Path(__file__).parent / "fixtures/stub_game_track"


def migrate(root, url):
    run = subprocess.run([sys.executable, str(root / "scripts/migrate_riftbound.py")], cwd=root,
                         env={**os.environ, "RIFTBOUND_DATABASE_URL": url, "DATABASE_URL": "must-not-be-read"},
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr
    return run.stdout.splitlines()


def ledger(url):
    with psycopg.connect(url) as conn:
        return conn.execute("SELECT name, applied_at FROM schema_migration ORDER BY name").fetchall()


def data(url):
    with psycopg.connect(url) as conn:
        return {table: schema_snapshot.rows_digest(conn, table) for table in schema_snapshot.relation_names(conn)
                if table != "schema_migration"}


@pytest.fixture(scope="module")
def fresh(databases):
    url = databases()
    lines = migrate(ROOT, url)
    return url, lines


def test_fresh_entry_runs_exactly_core_and_the_empty_riftbound_track(fresh, baseline):
    url, lines = fresh
    names = [f"core/{path.name}" for path in sorted((ROOT / "migrations/core").glob("*.sql"))]
    assert names[:2] == ["core/000_baseline.sql", "core/001_zip_centroids.sql"]
    assert lines == [f"Applied {name}" for name in names]
    assert [row[0] for row in ledger(url)] == sorted(names)
    assert list((ROOT / "migrations/riftbound").glob("*.sql")) == []
    actual, extensions = snapshot(url)
    expected, expected_extensions = snapshot(baseline)
    assert actual == expected
    assert extensions == expected_extensions
    assert not owned(actual, "pokemon")
    assert not owned(actual, "auth")
    with psycopg.connect(url) as conn:
        assert all(owners.relation_owner(name) in ("core", "ledger") for name in schema_snapshot.relation_names(conn))
        assert not {f"constraint:{table}.{name}" for table, name, _ in owners.OMITTED_FOREIGN_KEYS} & actual.keys()
    assert data(url) == data(baseline)


def test_rerunning_the_entry_changes_neither_schema_data_nor_ledger(fresh):
    url, _ = fresh
    before = snapshot(url), data(url), ledger(url)
    assert migrate(ROOT, url) == []
    assert (snapshot(url), data(url), ledger(url)) == before


def test_temporary_riftbound_file_runs_after_core_baseline_seed_and_tail(databases, tmp_path):
    shutil.copytree(ROOT / "scripts", tmp_path / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    tree = tmp_path / "migrations"
    shutil.copytree(ROOT / "migrations/core", tree / "core")
    shutil.copy2(STUB / "core/002_core_tail.sql", tree / "core/002_core_tail.sql")
    (tree / "riftbound").mkdir()
    # Only a temporary ordering probe, not a proposed catalog schema. It cannot run before the core tail creates its table.
    (tree / "riftbound/001_probe.sql").write_text("INSERT INTO core_tail_marker VALUES (1);")
    (tree / "001_pokemon_probe.sql").write_text("SELECT 1 / 0;")
    url = databases()
    names = ["core/000_baseline.sql", "core/001_zip_centroids.sql", "core/002_core_tail.sql", "riftbound/001_probe.sql"]
    assert migrate(tmp_path, url) == [f"Applied {name}" for name in names]
    assert [row[0] for row in ledger(url)] == sorted(names)
    with psycopg.connect(url) as conn:
        assert conn.execute("SELECT id FROM core_tail_marker").fetchall() == [(1,)]
    before = ledger(url)
    assert migrate(tmp_path, url) == []
    assert ledger(url) == before
