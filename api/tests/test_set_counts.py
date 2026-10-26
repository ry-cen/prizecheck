"""Per-set card counts (#309): migration 150, the import's fill and scripts/backfill_set_counts.py."""
import gzip
import importlib.util
import json
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

from app.catalog import claim_run, execute_run
from app.main import connect
from app.set_counts import set_counts
from test_card_attributes import card
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_references import migrate
from test_trade_migrations import run_again, scratch  # noqa: F401

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('backfill_set_counts', ROOT / 'scripts' / 'backfill_set_counts.py')
backfill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backfill)


def record(set_id, number, count=None, **extra):
    """A card record; count is the set.cardCount value (omitted when None)."""
    set_data = {"id": set_id, "name": set_id.upper()}
    if count is not None:
        set_data["cardCount"] = count
    return card(id=f"{set_id}-{number}", name=f"Card {number}", localId=str(number), category="Pokemon", set=set_data, **extra)


def pair(official, total):
    return {"official": official, "total": total}


def stored():
    with connect() as conn:
        return {row["set_id"]: (row["official"], row["total"]) for row in conn.execute(
            "SELECT set_id,official,total FROM catalog_generation_set_count").fetchall()}


def test_the_pair_most_records_carry_wins():
    records = [record("a", 1, pair(100, 120)), record("a", 2, pair(100, 120)), record("a", 3, pair(90, 95))]
    assert set_counts(records) == {"a": (100, 120)}


def test_a_tie_goes_to_the_larger_official():
    records = [record("a", 1, pair(90, 95)), record("a", 2, pair(100, 120)), record("b", 1, pair(100, 100)),
               record("b", 2, pair(100, 110))]
    assert set_counts(records) == {"a": (100, 120), "b": (100, 110)}


def test_no_integer_pair_means_no_row():
    records = [record("none", 1), record("none", 2, {"official": "10", "total": 12}),
               record("none", 3, {"official": True, "total": 3}), record("none", 4, {"official": 5}),
               record("none", 5, {"official": -1, "total": 3}), record("none", 6, "7"), record("none", 7, pair(2**31, 1)),
               record("some", 1), record("some", 2, pair(0, 0))]
    assert set_counts(records) == {"some": (0, 0)}


def test_import_fills_the_table_inside_the_promotion_transaction():
    reset_catalog()
    cards = (record("a", 1, pair(100, 120)), record("a", 2, pair(100, 120)), record("a", 3, pair(90, 95)),
             record("b", 1), record("c", 1, pair(5, 5)))
    run(Records(*cards))
    assert stored() == {"a": (100, 120), "c": (5, 5)}
    # A promotion that fails after the fill leaves no rows of that run behind.
    with connect() as conn:
        run_id = conn.execute("INSERT INTO catalog_run DEFAULT VALUES RETURNING id").fetchone()["id"]
        conn.commit()
        claim_run(conn, run_id)
        with pytest.raises(RuntimeError):
            execute_run(conn, run_id, Records(*cards, record("z", 1, pair(9, 9))),
                        before_promotion=lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        assert conn.execute("SELECT count(*) AS n FROM catalog_generation_set_count WHERE generation_id=%s",
                            (run_id,)).fetchone()["n"] == 0
    assert stored() == {"a": (100, 120), "c": (5, 5)}


def seeded_generation(*records, raw=None):
    """Replace the catalog with one active generation holding records (no set counts)."""
    reset_catalog()
    payload = raw if raw is not None else gzip.compress(json.dumps(list(records)).encode(), mtime=0)
    with connect() as conn:
        generation = conn.execute("""INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256)
          VALUES (gen_random_uuid(),%s,%s,repeat('0',64)) RETURNING id""", (len(records), payload)).fetchone()["id"]
        conn.execute("UPDATE catalog_state SET active_generation=%s", (generation,))
    return generation


def test_backfill_fills_the_active_generation_and_a_rerun_changes_nothing(capsys):
    generation = seeded_generation(record("a", 1, pair(100, 120)), record("a", 2, pair(100, 120)),
                                   record("a", 3, pair(90, 95)), record("b", 1), record("c", 1, pair(5, 7)))
    revisions = "SELECT (SELECT revision FROM catalog_state) AS c,(SELECT revision FROM catalog_attribute_state) AS a"
    with connect() as conn:
        before = conn.execute(revisions).fetchone()
    assert backfill.main() == 0
    assert "2 added" in capsys.readouterr().out
    with connect() as conn:
        assert conn.execute(revisions).fetchone() == before
    assert stored() == {"a": (100, 120), "c": (5, 7)}
    with connect() as conn:  # a row someone else corrected stays: ON CONFLICT DO NOTHING
        conn.execute("UPDATE catalog_generation_set_count SET total=999 WHERE set_id='c'")
    assert backfill.main() == 0
    assert "0 added" in capsys.readouterr().out
    assert stored() == {"a": (100, 120), "c": (5, 999)}
    with connect() as conn:
        assert conn.execute("SELECT DISTINCT generation_id FROM catalog_generation_set_count").fetchall() == [{"generation_id": generation}]


def test_backfill_stops_when_the_stored_records_carry_no_card_count(capsys):
    seeded_generation(record("a", 1), record("a", 2))
    assert backfill.main() == 2
    assert "no set.cardCount" in capsys.readouterr().err
    assert stored() == {}
    seeded_generation(raw=gzip.compress(b"not json"))
    assert backfill.main() == 2
    seeded_generation(raw=b"\x1f\x8b\x08\x00corrupt")
    assert backfill.main() == 2
    assert stored() == {}


def test_backfill_stops_without_an_active_generation(capsys):
    reset_catalog()
    assert backfill.main() == 2
    assert "No active catalog generation" in capsys.readouterr().err


def test_migration_150_adds_the_tables_and_runs_again(scratch):  # noqa: F811
    migrate(scratch)
    run_again(scratch, "150_scanner_catalog_data.sql")
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        generation = conn.execute("""INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256)
          VALUES (gen_random_uuid(),0,'',repeat('0',64)) RETURNING id""").fetchone()["id"]
        conn.execute("INSERT INTO catalog_generation_set_count VALUES (%s,'sv08',252,252)", (generation,))
        for bad in (("", 1, 1), ("x" * 81, 1, 1), ("sv09", -1, 1), ("sv09", 1, -1)):
            try:
                with conn.transaction():
                    conn.execute("INSERT INTO catalog_generation_set_count VALUES (%s,%s,%s,%s)", (generation, *bad))
            except psycopg.errors.CheckViolation:
                continue
            raise AssertionError(f"accepted {bad}")
        assert conn.execute("SELECT count(*) AS n FROM scanner_index").fetchone()["n"] == 0
        for sha in ("A" * 64, "a" * 63):
            try:
                with conn.transaction():
                    conn.execute("""INSERT INTO scanner_index(sha256,model_id,catalog_revision,inputs_digest,count,inputs_count,bytes)
                      VALUES (%s,'m',1,'d',0,0,'')""", (sha,))
            except psycopg.errors.CheckViolation:
                continue
            raise AssertionError(f"accepted {sha}")
        conn.execute("DELETE FROM catalog_generation WHERE id=%s", (generation,))
        assert conn.execute("SELECT count(*) AS n FROM catalog_generation_set_count").fetchone()["n"] == 0
        assert conn.execute("""SELECT count(*) AS n FROM pg_indexes WHERE indexname='scanner_index_model_created'""").fetchone()["n"] == 1
