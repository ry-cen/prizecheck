"""Card type: one source (app redesign #170, spec "Card type: one source") over signed HTTP against PostgreSQL.

The effective card attributes are the only source of card type. They gain Trainer Type (reviewed) and evolves from
(derived, never reviewed); a catalog import derives both, and scripts/derive_card_attributes.py backfills a catalog
imported before them. Collection's category and type filters read the effective attributes, so a reviewed correction
moves a card between Collection's filters in the same decision that changes the Deck List format result.
"""
import os
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from app.catalog import rederive_card_attributes
from app.main import connect
from test_attribute_corrections import ADMIN, OWNER, decide, error, evidence, grant, report, revision, seed
from test_card_attributes import (BULBASAUR_ME, ENERGY_SV, RARE_CANDY_ME, STAGE_ONE, SUPPORTER, SWITCH_ME,
                                  TECHNICAL_MACHINE, TOOL, card, edition_of, printing_ids)
from test_catalog_reconciliation import run, seed_manual
from test_catalog_references import migrate
from test_catalog_metadata import Records
from test_deck_format_checks import deck_with, standard
from test_holdings import add, call
from test_moves import leaf

# TCGdex calls this Item a Basic Pokémon: its record has category Pokemon. The owner corrects it to an Item.
MISLABELLED_ITEM = card(id="fixture-me01-915", name="Fixture Mislabelled Item", localId="915", category="Pokemon",
                        set={"id": "me01", "name": "Mega Evolution"}, regulationMark="I", stage="Basic",
                        rarity="Common", types=["Colorless"], trainerType="Item")
CARDS = (SUPPORTER, TOOL, TECHNICAL_MACHINE, STAGE_ONE, RARE_CANDY_ME, SWITCH_ME, BULBASAUR_ME, ENERGY_SV,
         MISLABELLED_ITEM)
# A Standard-legal 60-card Deck List with no Basic Pokémon but the mislabelled Item (test_deck_format_checks's legal deck).
LEGAL_DECK = [("fixture-me01-915", 4), ("me01-125", 4), ("me01-130", 4), ("sv02-278", 48)]
AS_OF = "2026-10-11"


def collector_with(*source_ids):
    """A new collector holding one copy of each card in one Storage Leaf."""
    collector = f"type-collector-{uuid4()}"
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (collector,))
    binder = leaf(collector)
    for source_id in source_ids:
        response = add(collector, binder, edition_of(source_id), "1")
        assert response.status_code == 200, response.text
    return collector


def names(user, **params):
    query = "&".join(f"{key}={value}" for key, value in params.items())
    response = call("GET", "/api/collection/holdings" + (f"?{query}" if query else ""), user)
    assert response.status_code == 200, response.text
    return sorted(row["printing_name"] for row in response.json()["holdings"])


def rows(user):
    response = call("GET", "/api/collection/holdings", user)
    assert response.status_code == 200, response.text
    return {row["printing_name"]: row for row in response.json()["holdings"]}


def ids():
    return {source_id: str(printing) for source_id, printing in printing_ids(*(r["id"] for r in CARDS)).items()}


def published():
    with connect() as conn:
        return (conn.execute("SELECT count(*) AS n FROM catalog_public_outbox").fetchone()["n"],
                conn.execute("SELECT printing_id,public_revision FROM catalog_printing_metadata ORDER BY printing_id"
                             ).fetchall())


# ------------------------------------------------------------------ derivation and backfill


def test_an_import_derives_trainer_type_and_evolves_from_for_new_cards():
    found = seed(*CARDS)
    shown = {source_id: evidence(found[source_id]) for source_id in
             ("fixture-sv01-910", "fixture-sv01-912", "fixture-swsh8-913", "me01-125", "fixture-sv01-914", "me01-001")}
    assert {source_id: (view["derived"]["trainer_type"], view["effective"]["trainer_type"])
            for source_id, view in shown.items()} == {
        "fixture-sv01-910": ("supporter", "supporter"), "fixture-sv01-912": ("tool", "tool"),
        "fixture-swsh8-913": (None, None),  # "Technical Machine" is a value the rules don't name
        "me01-125": (None, None),           # no trainerType in the source
        "fixture-sv01-914": (None, None), "me01-001": (None, None)}
    assert (shown["fixture-sv01-914"]["derived_evolves_from"], shown["fixture-sv01-914"]["evolves_from"]) == (
        "Fixture Basic", "Fixture Basic")
    assert shown["me01-001"]["evolves_from"] is None and shown["fixture-sv01-910"]["evolves_from"] is None
    # Collection lists the effective Trainer Type with each Holding.
    collector = collector_with("fixture-sv01-910", "me01-125", "me01-001")
    listed = rows(collector)
    assert {name: (row["category"], row["trainer_type"], row["elemental_types"]) for name, row in listed.items()} == {
        "Fixture Supporter": ("Trainer", "supporter", []), "Rare Candy": ("Trainer", None, []),
        "Bulbasaur": ("Pokemon", None, ["Grass"])}


def test_the_derivation_backfills_a_catalog_imported_before_trainer_type_and_evolves_from():
    found = seed(*CARDS)
    with connect() as conn:
        # The state migration 041 leaves an existing catalog in: new columns empty, derived under rules version 2.
        conn.execute("UPDATE catalog_derived_attribute SET trainer_type=NULL,evolves_from=NULL,rules_version=2")
    assert evidence(found["fixture-sv01-910"])["effective"]["trainer_type"] is None
    assert evidence(found["fixture-sv01-914"])["evolves_from"] is None
    before, outbox = revision(), published()
    with connect() as conn:  # what scripts/derive_card_attributes.py runs
        assert rederive_card_attributes(conn) == 2  # the Printings whose attributes changed: Supporter and Tool
    assert revision() == before + 1
    assert evidence(found["fixture-sv01-910"])["effective"]["trainer_type"] == "supporter"
    assert evidence(found["fixture-sv01-912"])["effective"]["trainer_type"] == "tool"
    assert evidence(found["fixture-sv01-914"])["evolves_from"] == "Fixture Basic"
    # Neither is a public format fact: the backfill re-stamps and enqueues nothing.
    assert published() == outbox
    with connect() as conn:
        assert rederive_card_attributes(conn) == 0
    assert revision() == before + 1
    # Evolves from alone is written but advances nothing: no format check reads it.
    with connect() as conn:
        conn.execute("UPDATE catalog_derived_attribute SET evolves_from=NULL")
        assert rederive_card_attributes(conn) == 0
    assert revision() == before + 1 and evidence(found["fixture-sv01-914"])["evolves_from"] == "Fixture Basic"
    # The next catalog import fills them too.
    with connect() as conn:
        conn.execute("UPDATE catalog_derived_attribute SET trainer_type=NULL,evolves_from=NULL,rules_version=2")
    run(Records(*CARDS))
    assert evidence(found["fixture-sv01-910"])["effective"]["trainer_type"] == "supporter"
    assert evidence(found["fixture-sv01-914"])["evolves_from"] == "Fixture Basic"


# ------------------------------------------------------------------ Collection reads the effective attributes


def test_collection_filters_read_the_effective_attributes_and_an_unknown_trainer_type_matches_only_the_category():
    seed(*CARDS)
    collector = collector_with("fixture-sv01-910", "fixture-sv01-912", "me01-125", "me01-001", "sv02-278")
    assert names(collector, category="Trainer") == ["Fixture Supporter", "Fixture Tool", "Rare Candy"]
    assert names(collector, trainer_type="supporter") == ["Fixture Supporter"]
    assert names(collector, trainer_type="tool") == ["Fixture Tool"]
    # Rare Candy's source gives no Trainer Type: it matches the Trainer category ("any type") and no Trainer Type.
    for trainer_type in ("supporter", "item", "tool", "stadium"):
        assert "Rare Candy" not in names(collector, trainer_type=trainer_type), trainer_type
    assert names(collector, category="Pokemon") == ["Bulbasaur"]
    assert names(collector, category="Energy") == ["Basic Grass Energy"]
    # Elemental types are a Pokémon's types: a Basic Energy has none in the effective attributes.
    assert names(collector, elemental_type="Grass") == ["Bulbasaur"]
    assert names(collector, category="Trainer", trainer_type="supporter") == ["Fixture Supporter"]
    for bad in ("Supporter", "technical_machine", ""):
        response = call("GET", f"/api/collection/holdings?trainer_type={bad}", collector)
        assert response.status_code == 422, bad


def test_a_trainer_type_correction_moves_collection_filters_and_the_format_result_together():
    """One reviewed decision corrects a card TCGdex calls a Basic Pokémon to an Item. Collection's Pokémon filter drops
    it and its Item filter gains it, and the only Basic Pokémon of a legal Standard deck is gone, so the deck's format
    result changes in the same attribute revision."""
    found = seed(*CARDS)
    printing = found["fixture-me01-915"]
    collector = collector_with("fixture-me01-915", "me01-125")
    owner, deck = deck_with(LEGAL_DECK)
    result = standard(owner, deck, AS_OF)
    assert (result["status"], result["issues"]) == ("legal", [])
    assert names(collector, category="Pokemon") == ["Fixture Mislabelled Item"]
    assert names(collector, trainer_type="item") == []

    grant(printing)
    response = decide(printing, correction={"card_kind": "trainer", "trainer_type": "item", "types": [],
                                            "basic_pokemon": False})
    assert response.status_code == 200, response.text
    decided = response.json()
    assert (decided["effective"]["card_kind"], decided["effective"]["trainer_type"]) == ("trainer", "item")

    assert names(collector, category="Pokemon") == []
    assert names(collector, trainer_type="item") == ["Fixture Mislabelled Item"]
    assert names(collector, category="Trainer") == ["Fixture Mislabelled Item", "Rare Candy"]
    assert (rows(collector)["Fixture Mislabelled Item"]["category"],
            rows(collector)["Fixture Mislabelled Item"]["trainer_type"]) == ("Trainer", "item")
    checks = call("GET", f"/api/decks/{deck}/format-checks?format=standard&as_of={AS_OF}", owner).json()
    assert checks["attribute_revision"] == decided["attribute_revision"] == revision()
    assert checks["results"][0]["status"] == "not_legal"
    assert {issue["code"] for issue in checks["results"][0]["issues"]} == {"no_basic_pokemon"}


def test_a_trainer_type_only_correction_recomputes_the_saved_format_result_and_moves_the_trainer_type_filter():
    found = seed(*CARDS)
    printing = found["me01-130"]  # Switch: its source gives no Trainer Type
    collector = collector_with("me01-130")
    owner, deck = deck_with([("me01-001", 1), ("me01-125", 4), ("me01-130", 4), ("sv02-278", 51)])
    first = standard(owner, deck, AS_OF)
    assert first["status"] == "legal" and standard(owner, deck, AS_OF)["computed_at"] == first["computed_at"]
    assert names(collector, trainer_type="item") == [] and names(collector, category="Trainer") == ["Switch"]

    before = revision()
    grant(printing)
    response = decide(printing, correction={"trainer_type": "item"})
    assert response.status_code == 200, response.text
    assert response.json()["attribute_revision"] == before + 1

    assert names(collector, trainer_type="item") == ["Switch"]
    checks = call("GET", f"/api/decks/{deck}/format-checks?format=standard&as_of={AS_OF}", owner).json()
    assert checks["attribute_revision"] == before + 1
    again = checks["results"][0]
    # The saved result was computed under the old revision, so it is computed again; no format rule reads Trainer Type.
    assert again["status"] == "legal" and again["computed_at"] != first["computed_at"]
    assert evidence(printing)["correction"]["trainer_type"] == "item"


def test_trainer_type_belongs_to_trainers_only():
    found = seed(*CARDS)
    supporter, bulbasaur = found["fixture-sv01-910"], found["me01-001"]
    collector = collector_with("fixture-sv01-910")
    # Correcting a mis-derived Trainer to a Pokémon clears its derived Trainer Type: there is no "correct to unknown".
    grant(supporter)
    response = decide(supporter, correction={"card_kind": "pokemon", "types": ["Fire"], "basic_pokemon": True})
    assert response.status_code == 200, response.text
    assert response.json()["effective"]["trainer_type"] is None
    shown = evidence(supporter)
    assert (shown["derived"]["trainer_type"], shown["effective"]["trainer_type"]) == ("supporter", None)
    assert names(collector, trainer_type="supporter") == [] and names(collector, category="Pokemon") == [
        "Fixture Supporter"]
    assert rows(collector)["Fixture Supporter"]["trainer_type"] is None
    # A correction may not give a card that is not a Trainer a Trainer Type, nor one whose kind is unknown.
    grant(bulbasaur)
    refused = decide(bulbasaur, correction={"trainer_type": "item"})
    assert (refused.status_code, error(refused)) == (422, "INCONSISTENT_ATTRIBUTES")
    manual, _ = seed_manual()
    grant(str(manual))
    refused = decide(str(manual), correction={"trainer_type": "item"})
    assert (refused.status_code, error(refused)) == (422, "INCONSISTENT_ATTRIBUTES")
    accepted = decide(str(manual), correction={"card_kind": "trainer", "trainer_type": "item"})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["effective"]["trainer_type"] == "item"
    # Collectors may propose a Trainer Type, from the four values only; evolves from is never proposed.
    assert report(supporter, {"trainer_type": "stadium"}).status_code == 201
    for proposed in ({"trainer_type": "Stadium"}, {"trainer_type": "technical_machine"}, {"evolves_from": "Pikachu"}):
        assert report(supporter, proposed).status_code == 422, proposed
    corrected_evolves = call("POST", f"{ADMIN}/decisions", OWNER, {
        "printing_id": supporter, "decision": "correct", "correction": {"evolves_from": "Pikachu"},
        "evidence_digest": evidence(supporter)["evidence_digest"], "evidence_url": "https://example.org/scan",
        "reason": "Checked", "code": "123456"})
    assert corrected_evolves.status_code == 422


def test_the_queue_shows_when_each_printing_needed_review():
    found = seed(*CARDS)
    sent = report(found["me01-130"], {"trainer_type": "item"}).json()
    manual, _ = seed_manual()
    queue = {item["printing_id"]: item for item in call("GET", f"{ADMIN}/queue", OWNER).json()["items"]}
    assert queue[found["me01-130"]]["opened_at"] == sent["created_at"]
    with connect() as conn:
        created = conn.execute("SELECT created_at FROM catalog_printing WHERE id=%s", (manual,)).fetchone()["created_at"]
    assert datetime.fromisoformat(queue[str(manual)]["opened_at"]) == created


# ------------------------------------------------------------------ migration 041


def test_migration_041_keeps_existing_attributes_republishes_nothing_and_runs_again():
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    name = "tcg_card_type_" + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before="041_trainer_type_and_evolves_from.sql")
        with psycopg.connect(url, row_factory=dict_row) as conn:
            owner = "migration-owner"
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
            printings = {}
            for key, kind in (("trainer", "trainer"), ("pokemon", "pokemon")):
                identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id",
                                        (key, key)).fetchone()["id"]
                printings[key] = conn.execute("""INSERT INTO catalog_printing(source,source_id,identity_id)
                  VALUES ('tcgdex',%s,%s) RETURNING id""", (key, identity)).fetchone()["id"]
                conn.execute("""INSERT INTO catalog_derived_attribute(printing_id,rules_version,regulation_mark,card_kind,
                  basic_energy,types,rule_box,ace_spec,radiant,prism_star,basic_pokemon)
                  VALUES (%s,2,'G',%s,false,%s,false,false,false,false,%s)""",
                             (printings[key], kind, [] if kind == "trainer" else ["Fire"], kind == "pokemon"))
            decision = conn.execute("""INSERT INTO catalog_attribute_decision(printing_id,decision,correction,
              evidence_digest,evidence_url,reason,reviewer_id,clock_revision,attribute_revision)
              VALUES (%s,'correct','{"regulation_mark":"H"}',%s,'https://example.org/scan','Checked',%s,1,1) RETURNING id""",
                                    (printings["pokemon"], "0" * 64, owner)).fetchone()["id"]
            conn.execute("""INSERT INTO catalog_attribute_correction(printing_id,regulation_mark,decision_id)
              VALUES (%s,'H',%s)""", (printings["pokemon"], decision))
            view = "SELECT * FROM catalog_card_attribute ORDER BY printing_id"
            before = conn.execute(view).fetchall()
            stamps = conn.execute("SELECT printing_id,public_revision FROM catalog_printing_metadata ORDER BY 1").fetchall()
            outbox = conn.execute("SELECT count(*) AS n FROM catalog_public_outbox").fetchone()["n"]
            attribute_revision = conn.execute("SELECT revision FROM catalog_attribute_state").fetchone()["revision"]
        migrate(url)
        with psycopg.connect(url, row_factory=dict_row) as conn:
            after = conn.execute(view).fetchall()
            # Every existing column keeps its value; the new ones are unknown until the derivation runs.
            assert [{key: value for key, value in row.items() if key not in ("trainer_type", "evolves_from")}
                    for row in after] == before
            assert {(row["trainer_type"], row["evolves_from"]) for row in after} == {(None, None)}
            assert conn.execute("SELECT printing_id,public_revision FROM catalog_printing_metadata ORDER BY 1"
                                ).fetchall() == stamps
            assert conn.execute("SELECT count(*) AS n FROM catalog_public_outbox").fetchone()["n"] == outbox
            assert conn.execute("SELECT revision FROM catalog_attribute_state").fetchone()["revision"] == \
                attribute_revision + 1
            # Trainer Type shows only while the effective kind is Trainer; evolves from only for a Pokémon.
            conn.execute("UPDATE catalog_derived_attribute SET trainer_type='item',evolves_from='Fixture Basic'")
            shown = {row["printing_id"]: (row["trainer_type"], row["evolves_from"])
                     for row in conn.execute("SELECT * FROM catalog_card_attribute")}
            assert shown == {printings["trainer"]: ("item", None), printings["pokemon"]: (None, "Fixture Basic")}
            # A correction that sets only a Trainer Type counts as setting an attribute.
            conn.execute("UPDATE catalog_attribute_correction SET regulation_mark=NULL,trainer_type='tool'")
            with pytest.raises(psycopg.errors.CheckViolation):
                with conn.transaction():
                    conn.execute("UPDATE catalog_attribute_correction SET trainer_type=NULL")
            with pytest.raises(psycopg.errors.CheckViolation):
                with conn.transaction():
                    conn.execute("UPDATE catalog_derived_attribute SET trainer_type='Item'")
            # Running the migration again changes no data and fails nothing.
            sql_text = (Path(__file__).resolve().parents[2] / "migrations" / "041_trainer_type_and_evolves_from.sql"
                        ).read_text()
            data = conn.execute("SELECT * FROM catalog_derived_attribute ORDER BY printing_id").fetchall()
            checks = "SELECT conname FROM pg_constraint WHERE contype='c' AND conrelid IN " \
                     "('catalog_derived_attribute'::regclass,'catalog_attribute_correction'::regclass) ORDER BY 1"
            constraints = conn.execute(checks).fetchall()
            with conn.transaction():
                conn.execute(sql_text)
            assert conn.execute("SELECT * FROM catalog_derived_attribute ORDER BY printing_id").fetchall() == data
            assert conn.execute(checks).fetchall() == constraints
            assert any(row["conname"] == "catalog_attribute_correction_sets_an_attribute" for row in constraints)
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
