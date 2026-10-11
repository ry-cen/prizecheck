"""Card Identity ignores a trailing parenthetical subtitle (Deck Lists 01, issue #82)."""
import json
import os
import time
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

import app.catalog as catalog_module
from app.card_identity import card_identity_key
from app.catalog import claim_run, execute_run
from app.main import connect
from app.public_catalog import rebuild
from app.public_projection import FilePublicProjection, public_record_store
from app.public_records import catalog_printing_key

from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_references import ROOT, migrate
from test_catalog_search import search
from test_holdings import add, call

MIGRATION = "024_card_identity_subtitles.sql"
# The migration after 024 (None while there is none): table checks are scoped to 024 alone, so a later
# migration that adds columns (for example ticket 03's 025) cannot break them.
AFTER_MIGRATION = next((path.name for path in sorted((ROOT / "migrations").glob("*.sql")) if path.name > MIGRATION), None)


def trainer(source_id, name, set_id, number):
    return {"id": source_id, "name": name, "localId": number, "category": "Trainer",
            "set": {"id": set_id, "name": f"Fixture {set_id}"},
            "variants": {"normal": True, "holo": False, "reverse": False}}


JUNIPER = trainer("swsh4.5-60", "Professor's Research (Professor Juniper)", "swsh4.5", "60")
MAGNOLIA = trainer("swsh1-178", "Professor's Research (Professor Magnolia)", "swsh1", "178")
MAGNOLIA_PROMO = trainer("swsh3.5-62", "Professor's Research (Professor Magnolia)", "swsh3.5", "62")
PLAIN = trainer("sv01-189", "Professor's Research", "sv01", "189")
GIOVANNI = trainer("swsh2-154", "Boss's Orders (Giovanni)", "swsh2", "154")
JUNIPER_PROMO = trainer("fixture-juniper-2", "Professor's Research (Professor Juniper)", "fixture", "2")
PIKACHU = {**trainer("base1-58", "Pikachu", "base1", "58"), "category": "Pokemon"}
LETTER = trainer("fixture-letter-1", "Professor's Letter", "fixture-letters", "1")
LETTER_CURLY = trainer("fixture-letter-2", "Professor\u2019s Letter", "fixture-letters", "2")
LEGACY_RECORDS = (JUNIPER, MAGNOLIA, MAGNOLIA_PROMO, PLAIN, GIOVANNI, PIKACHU, LETTER, LETTER_CURLY)
UNCHANGED_TABLES = ("catalog_edition", "holding", "catalog_printing_display", "catalog_generation_printing",
                    "catalog_override", "missing_card_report", "catalog_review", "deck_publication", "publication_command")


def printings(name):
    response = search(name=name)
    assert response.status_code == 200, response.text
    return {row["source_id"]: row for row in response.json()["printings"]}


def put_in_deck(owner, deck, edition, quantity):
    """Stock the Deck with Holdings; Deck detail `checks` counts Holdings (ticket 03 adds `deck_list_checks` separately)."""
    response = add(owner, deck, edition, quantity)
    assert response.status_code == 200, response.text


@pytest.fixture
def projection(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    with FilePublicProjection().writer(initialize=True):
        pass
    public_record_store().initialize(deadline=time.monotonic() + 5)


def import_into(conn, *records):
    run_id = conn.execute("INSERT INTO catalog_run DEFAULT VALUES RETURNING id").fetchone()["id"]
    conn.commit()
    assert claim_run(conn, run_id) == run_id
    execute_run(conn, run_id, Records(*records))


def table_rows(conn, table):
    return conn.execute(sql.SQL("SELECT * FROM {} t ORDER BY t::text").format(sql.Identifier(table))).fetchall()


def printing_rows(conn):
    return conn.execute("SELECT id,source,source_id,language,created_at,public_ref FROM catalog_printing ORDER BY id").fetchall()


def identities(conn):
    return {row["id"]: row for row in conn.execute("SELECT id,identity_key,display_name,xmin::text AS xmin FROM catalog_identity")}


def identity_by_printing(conn):
    return {row["id"]: row["identity_id"] for row in conn.execute("SELECT id,identity_id FROM catalog_printing")}


def published_name(conn, printing_id):
    ref = conn.execute("SELECT public_ref FROM catalog_printing WHERE id=%s", (printing_id,)).fetchone()["public_ref"]
    conn.commit()
    key = catalog_printing_key(ref)
    return public_record_store().read_records([key], deadline=time.monotonic() + 5).records[key].value["name"]


def seed_legacy_extras(conn):
    """Create the rows the pre-024 application made besides imports; returns short name -> Printing id."""
    ids = {}
    for short, record in (("juniper", JUNIPER), ("magnolia", MAGNOLIA), ("magnolia_promo", MAGNOLIA_PROMO),
                          ("plain", PLAIN), ("giovanni", GIOVANNI), ("pikachu", PIKACHU),
                          ("letter", LETTER), ("letter_curly", LETTER_CURLY)):
        ids[short] = conn.execute("SELECT id FROM catalog_printing WHERE source_id=%s", (record["id"],)).fetchone()["id"]
    conn.execute("INSERT INTO inventory_owner(user_id) VALUES ('legacy-owner')")
    deck = uuid4()
    conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,'legacy-owner','Legacy Deck','deck')", (deck,))

    # A manual Printing approved before this change.
    oak_name = "Professor's Research (Professor Oak)"
    oak_identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id",
                                (oak_name, oak_name)).fetchone()["id"]
    ids["oak"] = conn.execute("INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',%s) RETURNING id",
                              (oak_identity,)).fetchone()["id"]
    oak_edition = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor,descriptor_key)
      VALUES (%s,%s,%s) RETURNING id""", (ids["oak"], '{"finish": "normal"}', '{"finish": "normal"}')).fetchone()["id"]
    generation = conn.execute("SELECT active_generation FROM catalog_state").fetchone()["active_generation"]
    conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,collector_number,
      display_name,search_name,source_fingerprint,basic_energy)
      VALUES (%s,%s,%s,'cel25','Celebrations','24',%s,%s,'manual','unresolved')""",
                 (generation, ids["oak"], f"manual:{ids['oak']}", oak_name, oak_name.casefold()))
    conn.execute("INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s)",
                 (generation, oak_edition, ids["oak"]))
    report = conn.execute("""INSERT INTO missing_card_report(reporter_id,kind,status,set_id,set_name,collector_number,
      english_name,evidence_url,approved_printing_id,approved_edition_id)
      VALUES ('legacy-owner','printing','approved','cel25','Celebrations','24',%s,'https://example.org/oak',%s,%s)
      RETURNING id""", (oak_name, ids["oak"], oak_edition)).fetchone()["id"]
    conn.execute("""INSERT INTO catalog_override(report_id,printing_id,edition_id,revision,reviewer_id,evidence_url,reason,action)
      VALUES (%s,%s,%s,1000,'legacy-owner','https://example.org/oak','Verified against the physical card','approve_printing')""",
                 (report, ids["oak"], oak_edition))

    # A Printing with no display row, spelled with a curly apostrophe.
    lysandre_name = "Boss\u2019s Orders (Lysandre)"
    lysandre_identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id",
                                     (lysandre_name, lysandre_name)).fetchone()["id"]
    ids["lysandre"] = conn.execute("""INSERT INTO catalog_printing(source,source_id,identity_id)
      VALUES ('tcgdex','legacy-no-display',%s) RETURNING id""", (lysandre_identity,)).fetchone()["id"]
    conn.execute("INSERT INTO catalog_edition(printing_id,descriptor,descriptor_key) VALUES (%s,%s,%s)",
                 (ids["lysandre"], '{"finish": "normal"}', '{"finish": "normal"}'))

    for short, quantity in (("juniper", 3), ("magnolia", 2), ("oak", 1)):
        edition = conn.execute("SELECT id FROM catalog_edition WHERE printing_id=%s", (ids[short],)).fetchone()["id"]
        conn.execute("INSERT INTO holding VALUES ('legacy-owner',%s,%s,%s,1)", (deck, edition, quantity))

    # A Published Deck frozen with subtitled names.
    conn.execute("INSERT INTO deck_publication(token,owner_id,deck_id,title) VALUES ('legacy-token','legacy-owner',%s,'Legacy deck')",
                 (deck,))
    frozen = {"snapshot": {"identities": [{"name": "Professor's Research (Professor Juniper)", "quantity": "3"},
                                          {"name": "Professor's Research (Professor Magnolia)", "quantity": "2"}]}}
    conn.execute("""INSERT INTO publication_command(owner_id,request_key,request_digest,token,projection,result)
      VALUES ('legacy-owner',%s,'legacy-digest','legacy-token',%s,'{}')""", (uuid4(), json.dumps(frozen)))
    return ids


@pytest.mark.parametrize("name,expected", [
    ("Professor's Research (Professor Juniper)", "Professor's Research"),
    ("Boss's Orders (Giovanni)", "Boss's Orders"),
    ("Professor's Research", "Professor's Research"),
    ("Pikachu", "Pikachu"),
    ("Foo (Bar) (Baz)", "Foo (Bar)"),
    ("Foo (Bar (Baz))", "Foo (Bar (Baz))"),
    ("(Promo)", "(Promo)"),
    ("Foo(Bar)", "Foo(Bar)"),
    ("Foo (Bar) ex", "Foo (Bar) ex"),
    ("Foo ()", "Foo ()"),
    ("Unown [A]", "Unown [A]"),
    ("Pok\u00e9Dex (HANDY909)", "Pok\u00e9Dex"),
    ("Thought Wave Machine (Rocket's Secret Machine)", "Thought Wave Machine"),
    ("Professor\u2019s Letter", "Professor's Letter"),
    ("Farfetch\u2019d", "Farfetch'd"),
    ("Trainers\u2019 Mail", "Trainers' Mail"),
    ("N\u2018s Resolve", "N's Resolve"),
    ("N\u02bcs Resolve", "N's Resolve"),
    ("Boss\u2019s Orders (Lysandre)", "Boss's Orders"),
    ("Rotom Dex\u2014Pok\u00e9 Finder Mode", "Rotom Dex\u2014Pok\u00e9 Finder Mode"),
    ("(Rocket\u2019s)", "(Rocket's)"),
])
def test_card_identity_key_strips_one_trailing_parenthetical_like_migration_024(name, expected):
    assert card_identity_key(name) == expected
    with connect() as conn:
        assert conn.execute("SELECT catalog_card_identity_key(%s) AS key", (name,)).fetchone()["key"] == expected


def test_import_counts_subtitled_reprints_as_one_card_identity():
    reset_catalog()
    run(Records(JUNIPER, MAGNOLIA, PLAIN, GIOVANNI, PIKACHU))
    found = printings("Professor's Research")
    assert set(found) == {"swsh4.5-60", "swsh1-178", "sv01-189"}
    assert len({row["identity_id"] for row in found.values()}) == 1
    assert {row["identity_name"] for row in found.values()} == {"Professor's Research"}
    assert found["swsh4.5-60"]["name"] == "Professor's Research (Professor Juniper)"
    assert found["swsh1-178"]["name"] == "Professor's Research (Professor Magnolia)"
    [boss] = printings("Boss's Orders").values()
    assert boss["identity_name"] == "Boss's Orders"
    assert boss["name"] == "Boss's Orders (Giovanni)"
    [pikachu] = printings("Pikachu").values()
    assert pikachu["identity_name"] == "Pikachu"
    research_id = found["sv01-189"]["identity_id"]
    assert len({research_id, boss["identity_id"], pikachu["identity_id"]}) == 3


def test_reimport_keeps_card_identities_and_adds_subtitled_printings_to_them():
    reset_catalog()
    run(Records(JUNIPER))
    [first] = printings("Professor's Research").values()
    assert first["identity_name"] == "Professor's Research"
    run(Records(JUNIPER))
    [again] = printings("Professor's Research").values()
    assert (again["id"], again["identity_id"], again["identity_name"], again["name"]) == (
        first["id"], first["identity_id"], first["identity_name"], first["name"])
    run(Records(JUNIPER, MAGNOLIA, PLAIN))
    found = printings("Professor's Research")
    assert len(found) == 3
    assert {row["identity_id"] for row in found.values()} == {first["identity_id"]}


def test_deck_detail_counts_three_juniper_and_two_magnolia_over_the_four_copy_limit():
    reset_catalog()
    run(Records(JUNIPER, MAGNOLIA, PLAIN))
    found = printings("Professor's Research")
    juniper = found["swsh4.5-60"]["editions"][0]["id"]
    magnolia = found["swsh1-178"]["editions"][0]["id"]
    owner = f"identity-{uuid4()}"
    created = call("POST", "/api/decks", owner, {"name": "Professor deck", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    put_in_deck(owner, deck, juniper, "3")
    put_in_deck(owner, deck, magnolia, "1")
    identity = {"identity_id": found["swsh4.5-60"]["identity_id"], "name": "Professor's Research"}
    checks = call("GET", f"/api/decks/{deck}", owner).json()["checks"]
    assert checks["identities"] == [{**identity, "quantity": "4", "status": "within_limit"}]
    put_in_deck(owner, deck, magnolia, "1")
    checks = call("GET", f"/api/decks/{deck}", owner).json()["checks"]
    assert checks["total"] == "5"
    assert checks["identities"] == [{**identity, "quantity": "5", "status": "over_limit"}]


def test_import_folds_typographic_apostrophes_into_one_card_identity():
    reset_catalog()
    run(Records(LETTER_CURLY))
    # Search by the prefix "Professor": the catalog's prefix search does not fold apostrophes.
    [first] = printings("Professor").values()
    assert first["identity_name"] == "Professor's Letter"
    assert first["name"] == "Professor\u2019s Letter"
    run(Records(LETTER_CURLY, LETTER))
    found = printings("Professor")
    assert set(found) == {"fixture-letter-1", "fixture-letter-2"}
    assert {row["identity_id"] for row in found.values()} == {first["identity_id"]}
    assert {row["identity_name"] for row in found.values()} == {"Professor's Letter"}
    assert found["fixture-letter-1"]["name"] == "Professor's Letter"
    assert found["fixture-letter-2"]["name"] == "Professor\u2019s Letter"


def test_migration_merges_subtitled_identities_and_keeps_every_reference(projection, monkeypatch):
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL is required for disposable migration databases")
    name = "tcg_identity_migration_" + uuid4().hex
    url = make_conninfo(admin, dbname=name)
    with psycopg.connect(admin, autocommit=True) as control:
        control.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    try:
        migrate(url, before=MIGRATION)
        with psycopg.connect(url, row_factory=dict_row) as conn:
            with monkeypatch.context() as legacy:
                # Before migration 024 the Card Identity key was the exact English name (no folding, no stripping).
                legacy.setattr(catalog_module, "card_identity_key", lambda value: value)
                # Card attributes arrive with migration 026, after the schema this legacy import runs on.
                legacy.setattr(catalog_module, "refresh_card_attributes", lambda conn: 0)
                # So do Reprint Groups, with migration 031.
                legacy.setattr(catalog_module, "refresh_reprint_groups", lambda conn, generation_id=None: 0)
                # So do Card Identity merges, with migration 033.
                legacy.setattr(catalog_module, "IDENTITY_UPSERT",
                               catalog_module.IDENTITY_UPSERT.replace("coalesce(merged_into,id)", "id"))
                import_into(conn, *LEGACY_RECORDS)
            ids = seed_legacy_extras(conn)
            conn.commit()
            # Today's rebuild also publishes format facts (Deck Lists 18), which read the effective card attributes of
            # migration 026 and the Reprint Groups of migration 031. This session gets empty stand-ins, so the legacy
            # store holds format records whose identity predates 024; the final rebuild must rewrite them without
            # calling them conflicts.
            conn.execute("""CREATE TEMP VIEW catalog_card_attribute AS SELECT NULL::uuid AS printing_id,
              NULL::text AS regulation_mark,NULL::text AS card_kind,NULL::boolean AS basic_energy,NULL::text[] AS types,
              NULL::boolean AS rule_box,NULL::boolean AS ace_spec,NULL::boolean AS radiant,NULL::boolean AS prism_star,
              NULL::boolean AS basic_pokemon WHERE false""")
            conn.execute("""CREATE TEMP VIEW catalog_reprint_group_member AS SELECT NULL::uuid AS printing_id,
              NULL::uuid AS group_id WHERE false""")
            conn.commit()
            rebuild(conn)
            owner_before = identity_by_printing(conn)
            legacy_identities = identities(conn)
            # Juniper, Magnolia, Professor's Research, Giovanni, Pikachu, Professor's Letter, Professor\u2019s Letter, Oak, Lysandre
            assert len(legacy_identities) == 9
            before = {t: table_rows(conn, t) for t in UNCHANGED_TABLES}
            printings_before = printing_rows(conn)
            revision = conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"]
            conn.commit()

        migrate(url, before=AFTER_MIGRATION)

        with psycopg.connect(url, row_factory=dict_row) as conn:
            owners = identity_by_printing(conn)
            survivor = owner_before[ids["plain"]]
            assert {owners[ids[k]] for k in ("juniper", "magnolia", "magnolia_promo", "plain", "oak")} == {survivor}
            assert owners[ids["lysandre"]] == owners[ids["giovanni"]] == owner_before[ids["giovanni"]]
            assert owners[ids["letter_curly"]] == owners[ids["letter"]] == owner_before[ids["letter"]]
            assert owners[ids["pikachu"]] == owner_before[ids["pikachu"]]
            current = identities(conn)
            assert set(current) == {survivor, owner_before[ids["giovanni"]], owner_before[ids["pikachu"]],
                                    owner_before[ids["letter"]]}
            assert {(r["identity_key"], r["display_name"]) for r in current.values()} == {
                ("Professor's Research", "Professor's Research"), ("Boss's Orders", "Boss's Orders"),
                ("Pikachu", "Pikachu"), ("Professor's Letter", "Professor's Letter")}
            assert current[owner_before[ids["letter"]]] == legacy_identities[owner_before[ids["letter"]]]
            assert current[owner_before[ids["pikachu"]]] == legacy_identities[owner_before[ids["pikachu"]]]
            assert {t: table_rows(conn, t) for t in UNCHANGED_TABLES} == before
            assert printing_rows(conn) == printings_before
            assert conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"] == revision + 1
            conn.commit()

        migrate(url)

        with psycopg.connect(url, row_factory=dict_row) as conn:
            result = rebuild(conn)
            assert result.conflicts == 0
            assert conn.execute("SELECT count(*) AS n FROM catalog_printing_metadata WHERE live_state='suspended'").fetchone()["n"] == 0
            assert published_name(conn, ids["juniper"]) == "Professor's Research (Professor Juniper)"
            assert published_name(conn, ids["oak"]) == "Professor's Research (Professor Oak)"
            assert published_name(conn, ids["letter_curly"]) == "Professor\u2019s Letter"
            # No display row, so it falls back to the folded identity name and was re-stamped.
            assert published_name(conn, ids["lysandre"]) == "Boss's Orders"

            settled = identities(conn)
            conn.commit()
            import_into(conn, *LEGACY_RECORDS)
            assert identities(conn) == settled
            assert identity_by_printing(conn) == owners
            conn.commit()
            import_into(conn, *LEGACY_RECORDS, JUNIPER_PROMO)
            promo = conn.execute("SELECT id FROM catalog_printing WHERE source_id=%s", (JUNIPER_PROMO["id"],)).fetchone()["id"]
            assert identity_by_printing(conn)[promo] == survivor
            assert set(identities(conn)) == set(settled)
            assert conn.execute("SELECT count(*) AS n FROM catalog_review").fetchone()["n"] == 0
            conn.commit()
    finally:
        with psycopg.connect(admin, autocommit=True) as control:
            control.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
