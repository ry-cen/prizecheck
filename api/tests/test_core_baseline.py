"""The core baseline proof (S10, IM-13 option A), on disposable databases.

``migrations/core/000_baseline.sql`` is a curated cut of the schema that Pokémon's migrations 001 to 162 leave. This file is
its drift check:

* the Pokémon history is built through the cutoff (the first slice of scripts/migrate.py's tracks) in one database, and the
  baseline plus the zip seed on an empty one;
* the definitions of every core-owned object (tables, columns, types, defaults, constraints, indexes, sequences, views,
  functions, triggers) are read from pg_catalog by api/tests/schema_snapshot.py and compared, with the sixteen foreign keys
  from core into the catalog as an explicit list of what the baseline leaves out;
* the rows of every core table are compared by digest;
* a stub game track (api/tests/fixtures/stub_game_track) proves a new game's install order: core baseline, core tail, game
  track, which creates minimal catalog_* relations and adds the sixteen foreign keys back.

Ownership of each object is api/tests/core_baseline_ownership.py. An object it cannot place, or a name in it that no longer
exists, fails here. No pg_dump: the host's pg_dump 17 cannot read PostgreSQL 16 and introspection runs anywhere the tests do.
"""
import importlib.util
import os
import re
import shutil
import sys
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

import core_baseline_ownership as owners
import schema_snapshot

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "migrations"
STUB = Path(__file__).resolve().parent / "fixtures" / "stub_game_track"
sys.path.insert(0, str(ROOT / "scripts"))
import migration_tracks  # noqa: E402
from migration_tracks import Track  # noqa: E402


def load_entry():
    """scripts/migrate.py, imported without its habit of switching bytecode writing off for the rest of this process."""
    flag = sys.dont_write_bytecode
    spec = importlib.util.spec_from_file_location("pokemon_migrate_entry", ROOT / "scripts/migrate.py")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = flag
    return module


ENTRY = load_entry()
THROUGH_CUTOFF, CORE_TRACK, _ = ENTRY.TRACKS


@pytest.fixture(scope="module")
def admin():
    url = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not url:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    return url


@pytest.fixture(scope="module")
def databases(admin):
    made = []

    def make():
        name = "tcg_baseline_" + uuid4().hex
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        made.append(name)
        return make_conninfo(admin, dbname=name)

    yield make
    with psycopg.connect(admin, autocommit=True) as conn:
        for name in made:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture(scope="module")
def history(databases):
    """The schema Pokémon's root migrations through the cutoff leave: what the baseline must reproduce for core."""
    url = databases()
    with psycopg.connect(url) as conn:
        migration_tracks.apply(conn, MIGRATIONS, (THROUGH_CUTOFF,), lambda line: None)
    return url


@pytest.fixture(scope="module")
def baseline(databases):
    """The core track on an empty database: the baseline and the seed, run."""
    url = databases()
    with psycopg.connect(url) as conn:
        migration_tracks.apply(conn, MIGRATIONS, (Track("core"),), lambda line: None)
    return url


def snapshot(url):
    """``(definitions, extensions)``: every object's definition except the runner's own ledger table and the extensions."""
    with psycopg.connect(url) as conn:
        snap = schema_snapshot.snapshot(conn)
    extensions = {key for key in snap if key.startswith("extension:")}
    return {key: value for key, value in snap.items() if key not in extensions and owners.owner_of(key, value) != "ledger"}, extensions


def owned(snap, owner):
    return {key: value for key, value in snap.items() if owners.owner_of(key, value) == owner}


def omitted_keys():
    return {f"constraint:{table}.{name}" for table, name, _ in owners.OMITTED_FOREIGN_KEYS}


def test_the_ownership_lists_name_only_things_the_history_creates(history):
    snap, _ = snapshot(history)
    relations = {key.split(":", 1)[1] for key in snap if key.startswith(("table:", "view:"))}
    functions = {key.split(":", 1)[1].split("(")[0] for key in snap if key.startswith("function:")}
    assert owners.AUTH_RELATIONS | owners.POKEMON_EXTRA_RELATIONS <= relations
    assert owners.POKEMON_FUNCTIONS | owners.AUTH_FUNCTIONS <= functions
    # Every object has one owner, and the three owners are the whole schema (snapshot leaves the runner's ledger table out).
    counts = {owner: len(owned(snap, owner)) for owner in ("core", "pokemon", "auth")}
    assert sum(counts.values()) == len(snap)
    assert all(counts[owner] > 0 for owner in ("core", "pokemon", "auth"))


def test_the_baseline_installs_on_an_empty_database_and_leaves_no_pokemon_relation(baseline):
    snap, _ = snapshot(baseline)
    assert not owned(snap, "pokemon")
    assert not owned(snap, "auth")
    with psycopg.connect(baseline) as conn:
        relations = schema_snapshot.relation_names(conn)
        assert [name for name in relations if name.startswith("catalog_")] == []
        references = [(table, name, target) for table, name, target in schema_snapshot.foreign_keys(conn)
                      if target.startswith("catalog_") or owners.relation_owner(target) != "core"]
        assert references == []
        names = {row[0] for row in conn.execute("SELECT name FROM schema_migration")}
    assert names == {"core/000_baseline.sql", "core/001_zip_centroids.sql"}
    assert len(relations) > 60


def test_every_core_object_in_the_baseline_is_defined_as_the_pokemon_history_defines_it(history, baseline):
    history_snap, history_extensions = snapshot(history)
    baseline_snap, baseline_extensions = snapshot(baseline)
    expected = {key: value for key, value in owned(history_snap, "core").items() if key not in omitted_keys()}
    assert baseline_extensions == history_extensions
    assert sorted(set(expected) - set(baseline_snap)) == [], "core objects the baseline lacks"
    assert sorted(set(baseline_snap) - set(expected)) == [], "objects the baseline adds"
    assert [key for key in expected if expected[key] != baseline_snap[key]] == []
    # Not vacuous: every kind of object the proof names is compared.
    kinds = {key.split(":", 1)[0] for key in expected}
    assert kinds == {"table", "column", "constraint", "index", "sequence", "view", "function", "trigger"}


def test_the_foreign_keys_the_baseline_omits_are_exactly_the_core_to_catalog_ones(history, baseline):
    with psycopg.connect(history) as conn:
        found = [(table, name, target) for table, name, target in schema_snapshot.foreign_keys(conn)
                 if owners.relation_owner(table) == "core" and owners.relation_owner(target) != "core"]
    assert sorted(found) == sorted(owners.OMITTED_FOREIGN_KEYS)
    assert len(found) == 16 and {target for _, _, target in found} == {"catalog_edition", "catalog_printing"}
    baseline_snap, _ = snapshot(baseline)
    assert not omitted_keys() & set(baseline_snap)


def test_the_seed_rows_of_every_core_table_match_by_digest(history, baseline):
    history_snap, _ = snapshot(history)
    tables = sorted(key.split(":", 1)[1] for key in owned(history_snap, "core") if key.startswith("table:"))
    with psycopg.connect(history) as left, psycopg.connect(baseline) as right:
        digests = {table: (schema_snapshot.rows_digest(left, table), schema_snapshot.rows_digest(right, table)) for table in tables}
    assert [table for table, (a, b) in digests.items() if a != b] == []
    # The seed is two tables: the zip centroids (migration 146) and the single operations_state row (019).
    counts = {table: a[0] for table, (a, _) in digests.items() if a[0]}
    assert counts == {"operations_state": 1, "zip_centroid": 41471}


def test_the_seed_file_is_the_insert_statements_of_migration_146_byte_for_byte():
    original = (MIGRATIONS / "146_zip_centroids.sql").read_bytes()
    seed = (MIGRATIONS / "core/001_zip_centroids.sql").read_bytes()
    statements = original[original.index(b"INSERT INTO zip_centroid"):]
    assert seed.endswith(statements)
    assert b"CREATE" not in seed[: -len(statements)]


def test_the_baseline_never_uses_a_catalog_relation_or_an_auth_one():
    text = (MIGRATIONS / "core/000_baseline.sql").read_text()
    code = "\n".join(line for line in text.splitlines() if not line.startswith("--"))
    # The one catalog_ name is a column of collection_import: the catalog revision an import saw, not a relation.
    assert set(re.findall(r"\bcatalog_\w+", code)) == {"catalog_revision"}
    auth = "|".join(re.escape(name) for name in sorted(owners.AUTH_RELATIONS))
    assert re.findall(rf'(?i)\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+"?(?:{auth})"?(?![\w"])', code) == []


def test_the_recorded_precondition_reads_every_table_view_and_function_the_baseline_creates(baseline):
    text = (MIGRATIONS / "core/000_baseline.sql").read_text()
    created = migration_tracks.CREATES.findall(text)
    with psycopg.connect(baseline) as conn:
        relations = set(schema_snapshot.relation_names(conn))
        functions = {row[0] for row in conn.execute("SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace")}
        assert migration_tracks.missing_objects(conn, text) == []
        assert migration_tracks.missing_objects(conn, (MIGRATIONS / "core/001_zip_centroids.sql").read_text()) == []
    assert {name for kind, name in created if kind != "FUNCTION"} == relations - {"schema_migration"}
    assert {name for kind, name in created if kind == "FUNCTION"} == functions


def test_a_new_game_installs_core_baseline_then_core_tail_then_its_own_track(databases, history, tmp_path):
    tree = tmp_path / "migrations"
    shutil.copytree(MIGRATIONS / "core", tree / "core")
    shutil.copy2(STUB / "core/002_core_tail.sql", tree / "core/002_core_tail.sql")
    shutil.copytree(STUB / "stub_game", tree / "stub_game")
    url = databases()
    with psycopg.connect(url) as conn:
        applied = migration_tracks.apply(conn, tree, (Track("core"), Track("stub_game")), lambda line: None)
    assert applied == ["core/000_baseline.sql", "core/001_zip_centroids.sql", "core/002_core_tail.sql",
                       "stub_game/001_catalog.sql", "stub_game/002_core_references.sql"]
    stub_snap, _ = snapshot(url)
    history_snap, _ = snapshot(history)
    tail = {key for key in stub_snap if "core_tail_marker" in key}
    assert tail
    # Core is the Pokémon history's core, sixteen foreign keys included, plus the tail.
    assert {key: value for key, value in owned(stub_snap, "core").items() if key not in tail} == owned(history_snap, "core")
    # The game owns only what its track made, and no Pokémon function, view or auth table came with core.
    assert {key for key in owned(stub_snap, "pokemon") if key.startswith("table:")} == {"table:catalog_edition", "table:catalog_printing"}
    assert not owned(stub_snap, "auth")
    assert not [key for key in owned(stub_snap, "pokemon") if key.startswith(("function:", "view:", "trigger:"))]


def test_the_order_matters_a_game_track_before_core_fails(databases, tmp_path):
    tree = tmp_path / "migrations"
    shutil.copytree(MIGRATIONS / "core", tree / "core")
    shutil.copytree(STUB / "stub_game", tree / "stub_game")
    with psycopg.connect(databases()) as conn, pytest.raises(psycopg.errors.UndefinedTable):
        migration_tracks.apply(conn, tree, (Track("stub_game"), Track("core")), lambda line: None)


def test_every_root_migration_is_classified_and_its_classification_is_true(databases):
    """FILE_OWNERS is what the split-map's section 4 lacked for 160 to 162: recomputed here by applying each root file in turn
    and seeing which owners' objects, or rows, it changed."""
    files = [path for path in sorted(MIGRATIONS.glob("*.sql")) if path.name <= ENTRY.CUTOFF]
    assert [path.name for path in files] == sorted(owners.FILE_OWNERS)
    url = databases()
    computed = {}
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(migration_tracks.LEDGER)
        before = schema_snapshot.snapshot(conn)
        before_rows = table_counts(conn)
        for path in files:
            conn.execute(path.read_text())
            after = schema_snapshot.snapshot(conn)
            after_rows = table_counts(conn)
            touched = set()
            for key in set(before) | set(after):
                if before.get(key) != after.get(key) and not key.startswith("extension:"):
                    touched.add(owners.owner_of(key, after.get(key) or before[key]))
            touched |= {owners.relation_owner(table) for table in set(before_rows) | set(after_rows) if before_rows.get(table) != after_rows.get(table)}
            touched.discard("ledger")
            computed[path.name] = ("core" if not touched else touched.pop() if len(touched) == 1 else "mixed:" + "+".join(sorted(touched, key=("core", "pokemon", "auth").index)))
            before, before_rows = after, after_rows
    assert {name: label for name, label in computed.items() if label != owners.FILE_OWNERS[name]} == {}


def table_counts(conn):
    tables = [row[0] for row in conn.execute(
        "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'schema_migration'")]
    return {table: conn.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in tables}
