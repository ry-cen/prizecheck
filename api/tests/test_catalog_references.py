"""Opaque public Printing/Edition references assigned by trusted database work."""
import os
import re
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from app.main import connect
from test_catalog import reset_catalog
from test_catalog_metadata import Records, furret, repriced
from test_catalog_reconciliation import run, seed_manual

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = re.compile(r"^[0-9a-f]{48}$")


def references():
    with connect() as conn:
        printings = conn.execute("SELECT id,public_ref FROM catalog_printing ORDER BY id").fetchall()
        editions = conn.execute("SELECT id,printing_id,public_ref FROM catalog_edition ORDER BY id").fetchall()
    return printings, editions


def assert_opaque(rows):
    refs = [row["public_ref"] for row in rows]
    assert all(REFERENCE.fullmatch(ref) for ref in refs)
    assert len(set(refs)) == len(refs)
    for row in rows:
        assert row["id"].hex not in row["public_ref"]


def test_imported_and_manual_rows_get_unique_opaque_references_that_survive_reimport():
    reset_catalog()
    twin = {**furret(), "id": "meta-2", "localId": "137"}
    run(Records(furret(), twin))
    manual_printing, manual_edition = seed_manual()
    printings, editions = references()
    assert {row["id"] for row in printings} >= {manual_printing}
    assert {row["id"] for row in editions} >= {manual_edition}
    assert_opaque(printings)
    assert_opaque(editions)
    # Identical descriptors on different Printings never share a reference.
    assert len({row["public_ref"] for row in printings} | {row["public_ref"] for row in editions}) == len(printings) + len(editions)
    changed = repriced()
    changed["set"]["tcgOnline"] = "DAA"
    changed["regulationMark"] = "D"
    run(Records(changed, twin))
    assert references() == (printings, editions)


def test_references_and_edition_printing_correspondence_are_immutable_and_unique():
    reset_catalog(); run(Records(furret()))
    printings, editions = references()
    with connect() as conn:
        with pytest.raises(psycopg.errors.RaiseException, match="immutable"):
            conn.execute("UPDATE catalog_printing SET public_ref=%s WHERE id=%s", ("0" * 48, printings[0]["id"]))
    with connect() as conn:
        with pytest.raises(psycopg.errors.RaiseException, match="immutable"):
            conn.execute("UPDATE catalog_edition SET public_ref=%s WHERE id=%s", ("0" * 48, editions[0]["id"]))
    with connect() as conn:
        other = conn.execute("""INSERT INTO catalog_printing(source,identity_id)
          SELECT 'manual',identity_id FROM catalog_printing LIMIT 1 RETURNING id""").fetchone()["id"]
        conn.commit()
        with pytest.raises(psycopg.errors.RaiseException, match="immutable"):
            conn.execute("UPDATE catalog_edition SET printing_id=%s WHERE id=%s", (other, editions[0]["id"]))
    with connect() as conn:
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor,public_ref)
              VALUES (%s,'duplicate','{}',%s)""", (editions[0]["printing_id"], editions[1]["public_ref"]))
    after_printings, after_editions = references()
    assert after_editions == editions
    assert [row for row in after_printings if row["id"] != other] == printings
    new_ref = next(row["public_ref"] for row in after_printings if row["id"] == other)
    assert new_ref not in {row["public_ref"] for row in printings + editions}


def migrate(url, before=None):
    """Apply repository migrations like scripts/migrate.py, optionally stopping before one file."""
    with psycopg.connect(url) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        for path in sorted((ROOT / "migrations").glob("*.sql")):
            if before and path.name >= before:
                break
            if conn.execute("SELECT 1 FROM schema_migration WHERE name=%s", (path.name,)).fetchone():
                continue
            with conn.transaction():
                conn.execute(path.read_text())
                conn.execute("INSERT INTO schema_migration(name) VALUES (%s)", (path.name,))


def migrated_state(conn):
    editions = conn.execute("""SELECT mapping_state,mapping_reason,count(*)::int AS n FROM catalog_edition_metadata
      GROUP BY 1,2 ORDER BY 3 DESC""").fetchall()
    printings = conn.execute("""SELECT live_state,live_reason,count(*)::int AS n FROM catalog_printing_metadata
      GROUP BY 1,2""").fetchall()
    revisions = conn.execute("""WITH stamps AS (SELECT public_revision FROM catalog_edition_metadata
        UNION ALL SELECT public_revision FROM catalog_printing_metadata)
      SELECT (SELECT count(DISTINCT public_revision) FROM stamps)::int AS distinct,
        (SELECT max(public_revision) FROM stamps) AS stamp,
        (SELECT count(*) FROM catalog_public_outbox)::int AS outbox,
        (SELECT count(*) FROM catalog_public_outbox WHERE delivered_at IS NULL)::int AS pending,
        (SELECT count(*) FROM catalog_public_outbox WHERE priority=0)::int AS urgent,
        (SELECT count(*) FROM stamps WHERE public_revision=0)::int AS unstamped""").fetchone()
    clock = conn.execute("SELECT revision FROM catalog_public_clock").fetchone()["revision"]
    return {"editions": editions, "printings": printings, "revisions": revisions, "clock": clock}


def test_migrating_a_populated_catalog_assigns_distinct_references_without_changing_other_columns():
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    name = "tcg_reference_migration_" + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before="021_edition_metadata.sql")
        with psycopg.connect(url) as conn:
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES ('collector')")
            leaf = conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,'collector','Binder','storage_leaf') RETURNING id",
                                (uuid4(),)).fetchone()[0]
            for index in range(40):
                identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,'Card') RETURNING id",
                                        (f"card-{index}",)).fetchone()[0]
                source = ("tcgdex", f"src-{index}") if index % 4 else ("manual", None)
                printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES (%s,%s,%s) RETURNING id",
                                        (*source, identity)).fetchone()[0]
                for finish in ("normal", "reverse"):
                    unspecified = finish == "reverse" and index % 10 == 0
                    descriptor = '{"kind":"unspecified","label":"Unspecified Variant"}' if unspecified else f'{{"finish":"{finish}"}}'
                    edition = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
                      VALUES (%s,%s,%s) RETURNING id""", (printing, finish, descriptor)).fetchone()[0]
                    conn.execute("INSERT INTO holding VALUES ('collector',%s,%s,%s,1)", (leaf, edition, index + 1))
        tables = ("catalog_identity", "catalog_printing", "catalog_edition", "holding")

        def snapshot():
            with psycopg.connect(url, row_factory=dict_row) as conn:
                return {table: conn.execute(sql.SQL("SELECT * FROM {} ORDER BY 1,2").format(sql.Identifier(table))).fetchall()
                        for table in tables}

        before = snapshot()
        migrate(url, before="022_mapping_evidence.sql")
        with psycopg.connect(url) as conn:
            # Metadata written by the unreleased 021 importer embedded evidence in the candidate.
            conn.execute("""INSERT INTO catalog_edition_metadata(edition_id,mapping_candidate,mapping_quarantined)
              SELECT id,'{"candidate":{"variantId":"v"},"correspondence":"source_candidate",
                "physical_evidence":{"set":{"cardCount":{"total":201}}},"variant_evidence":{"type":"normal"}}'
              ,descriptor_key='reverse' FROM catalog_edition""")
        migrate(url, before="023_metadata_review.sql")
        through_022 = snapshot()
        subprocess.run([sys.executable, str(ROOT / "scripts/migrate.py")], env={**os.environ, "DATABASE_URL": url},
                       check=True, capture_output=True)
        after = snapshot()
        # Migration 023 rewrites no ID, descriptor, public reference or correspondence.
        assert after == through_022
        for table in tables:
            assert [{key: value for key, value in row.items() if key != "public_ref"} for row in after[table]] == before[table]
        with psycopg.connect(url, row_factory=dict_row) as conn:
            moved = conn.execute("SELECT DISTINCT mapping_candidate,mapping_evidence,mapping_revision FROM catalog_edition_metadata").fetchall()
        assert moved == [{"mapping_candidate": {"candidate": {"variantId": "v"}, "correspondence": "source_candidate"},
                          "mapping_evidence": {"physical_evidence": {"set": {"cardCount": {"total": 201}}},
                                               "variant_evidence": {"type": "normal"}},
                          "mapping_revision": 1}]
        with psycopg.connect(url, row_factory=dict_row) as conn:
            self_check = migrated_state(conn)
        assert self_check["editions"] == [{"mapping_state": "unverified", "mapping_reason": "no_matching_rule", "n": 76},
                                          {"mapping_state": "unverified", "mapping_reason": "unspecified_variant", "n": 4}]
        assert self_check["printings"] == [{"live_state": "unsupported", "live_reason": "no_active_rule", "n": 40}]
        # One revision stamps the whole backfill, every target is enqueued once, and nothing else moved.
        assert self_check["revisions"] == {"distinct": 1, "stamp": self_check["clock"], "outbox": 120, "pending": 120,
                                           "urgent": 0, "unstamped": 0}
        refs = [row["public_ref"] for table in ("catalog_printing", "catalog_edition") for row in after[table]]
        assert len(refs) == 120 and len(set(refs)) == 120 and all(REFERENCE.fullmatch(ref) for ref in refs)
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
