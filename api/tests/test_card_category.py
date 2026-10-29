"""Category and elemental type stored on each Card Printing (migration 027), from imports and by backfill."""
import json
import os
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from app.games.pokemon.catalog.catalog import execute_run
from app.main import connect
from test_catalog import claim_current, reset_catalog
from test_catalog_references import migrate
from test_catalog_search import SearchSource

# source id -> (category, types); a missing value is left out of the record, as TCGdex does.
CARDS = {
    "card-1": ("Pokemon", ["Fire"]),
    "card-2": ("Trainer", None),
    "card-3": ("Energy", ["Lightning"]),
    "card-4": ("Pokemon", ["Water", "Grass", "Water"]),
    "card-5": ("Mystery", ["Fire", "Plasma", 7, {"nested": "Water"}]),
    "card-6": (None, "Fire"),
}


class AttributeSource(SearchSource):
    def __init__(self, cards):
        super().__init__({source_id: f"Attribute {source_id}" for source_id in cards})
        self.cards = cards

    def fetch(self, source_id):
        record = super().fetch(source_id)
        category, types = self.cards[source_id]
        record.pop("category", None)
        if category is not None:
            record["category"] = category
        if types is not None:
            record["types"] = types
        return record


def import_cards(cards):
    with connect() as conn:
        conn.execute("INSERT INTO catalog_run DEFAULT VALUES")
        execute_run(conn, claim_current(conn), AttributeSource(cards))


def stored():
    with connect() as conn:
        rows = conn.execute("""SELECT p.source_id,m.category,m.elemental_types FROM catalog_printing p
          JOIN catalog_printing_metadata m ON m.printing_id=p.id ORDER BY p.source_id""").fetchall()
    return {row["source_id"]: (row["category"], row["elemental_types"]) for row in rows}


def test_import_stores_category_and_elemental_types_for_each_printing():
    reset_catalog()
    import_cards(CARDS)
    assert stored() == {
        "card-1": ("Pokemon", ["Fire"]),
        "card-2": ("Trainer", []),
        "card-3": ("Energy", ["Lightning"]),
        "card-4": ("Pokemon", ["Grass", "Water"]),  # sorted, once each
        "card-5": (None, ["Fire"]),  # unknown category and unknown or malformed types are dropped
        "card-6": (None, []),  # no category; types that aren't a list
    }
    # A later import that changes the source record updates the stored values.
    import_cards({**CARDS, "card-1": ("Pokemon", ["Water"]), "card-2": ("Energy", ["Psychic"])})
    after = stored()
    assert after["card-1"] == ("Pokemon", ["Water"]) and after["card-2"] == ("Energy", ["Psychic"])
    assert after["card-3"] == ("Energy", ["Lightning"])


def test_migration_027_backfills_category_and_elemental_types_without_republishing():
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    name = "tcg_card_attributes_" + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before="027_card_attributes.sql")
        records = {"fire": {"category": "Pokemon", "types": ["Fire"]}, "trainer": {"category": "Trainer"},
                   "energy": {"category": "Energy", "types": ["Lightning"]},
                   "dual": {"category": "Pokemon", "types": ["Water", "Grass"]}, "manual": None}
        printings = {}
        with psycopg.connect(url) as conn:
            for key, record in records.items():
                identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id",
                                        (key, key)).fetchone()[0]
                source = ("manual", None) if record is None else ("tcgdex", key)
                printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES (%s,%s,%s) RETURNING id",
                                        (*source, identity)).fetchone()[0]
                printings[printing] = key
                if record is not None:
                    # What an import since migration 021 retained for this Printing.
                    conn.execute("UPDATE catalog_printing_metadata SET source_record=%s WHERE printing_id=%s",
                                 (json.dumps({"id": key, "name": key, **record}), printing))
        published = "SELECT printing_id,public_revision,updated_at FROM catalog_printing_metadata ORDER BY printing_id"
        with psycopg.connect(url, row_factory=dict_row) as conn:
            before = conn.execute(published).fetchall()
            outbox = conn.execute("SELECT count(*) AS n FROM catalog_public_outbox").fetchone()["n"]
        migrate(url)
        with psycopg.connect(url, row_factory=dict_row) as conn:
            rows = conn.execute("SELECT printing_id,category,elemental_types FROM catalog_printing_metadata").fetchall()
            assert {printings[row["printing_id"]]: (row["category"], row["elemental_types"]) for row in rows} == {
                "fire": ("Pokemon", ["Fire"]), "trainer": ("Trainer", []), "energy": ("Energy", ["Lightning"]),
                "dual": ("Pokemon", ["Grass", "Water"]), "manual": (None, [])}
            # The backfill republishes nothing: no revision stamp, no outbox entry, no metadata timestamp.
            assert conn.execute(published).fetchall() == before
            assert conn.execute("SELECT count(*) AS n FROM catalog_public_outbox").fetchone()["n"] == outbox
            # After the migration, any write of the source record keeps the values current.
            fire = next(printing for printing, key in printings.items() if key == "fire")
            conn.execute("UPDATE catalog_printing_metadata SET source_record=%s WHERE printing_id=%s",
                         (json.dumps({"category": "Trainer"}), fire))
            assert conn.execute("SELECT category,elemental_types FROM catalog_printing_metadata WHERE printing_id=%s",
                                (fire,)).fetchone() == {"category": "Trainer", "elemental_types": []}
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
