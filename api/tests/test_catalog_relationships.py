"""Inventory, override, correction and public relationships across quote and target-metadata imports.

Every collector/owner action goes through the signed HTTP seam the gateway uses.
Catalog imports are fixture work against the real promotion transaction.
"""
import json
from uuid import uuid4

import pytest

from app.main import connect
from test_catalog import reset_catalog
from test_catalog_metadata import Records, furret, repriced
from test_catalog_reconciliation import review_code, run, shown
from test_decks import create
from test_holdings import add, call, client
from test_missing_cards import OWNER, REPORTER, approve, issue_code, report
from test_moves import commit, leaf, selected, stage, start


@pytest.fixture(autouse=True)
def public_objects(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    from app.public_projection import FilePublicProjection
    with FilePublicProjection().writer(initialize=True):
        pass


def twin():
    return {**furret(), "id": "meta-2", "localId": "137"}


def product_split():
    # Two existing Editions whose stored descriptors differ only by product ID.
    record = {**furret(), "id": "meta-3", "localId": "138"}
    record["variants_detailed"] = [{"type": "normal", "thirdParty": {"tcgplayer": 1}},
                                   {"type": "normal", "thirdParty": {"tcgplayer": 2}}]
    return record


def edition(source_id, **descriptor):
    with connect() as conn:
        return str(conn.execute("""SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          WHERE p.source_id=%s AND e.descriptor @> %s::jsonb""", (source_id, json.dumps(descriptor))).fetchone()["id"])


def relationships(collector):
    with connect() as conn:
        return {
            "printings": conn.execute("SELECT id,source,source_id,identity_id,public_ref FROM catalog_printing ORDER BY id").fetchall(),
            "editions": conn.execute("SELECT id,printing_id,descriptor_key,descriptor,public_ref FROM catalog_edition ORDER BY id").fetchall(),
            "holdings": conn.execute("SELECT * FROM holding WHERE owner_id=%s ORDER BY location_id,edition_id", (collector,)).fetchall(),
            "overrides": conn.execute("SELECT * FROM catalog_override ORDER BY id").fetchall(),
            "replacements": conn.execute("SELECT * FROM catalog_edition_replacement ORDER BY edition_id").fetchall(),
            "active": conn.execute("""SELECT ge.edition_id,ge.active FROM catalog_generation_edition ge
              JOIN catalog_state cs ON cs.active_generation=ge.generation_id ORDER BY ge.edition_id""").fetchall(),
            "decided": conn.execute("SELECT id,status,candidate,reviewer_id FROM catalog_review WHERE status<>'pending' ORDER BY id").fetchall(),
        }


def test_quote_and_target_metadata_imports_preserve_every_existing_relationship():
    reset_catalog()
    run(Records(furret(), twin(), product_split()))
    collector = f"collector-{uuid4()}"
    with connect() as conn:
        for user in (OWNER, REPORTER, collector):
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user,))
        conn.execute("DELETE FROM owner_binding")
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (OWNER,))
    binder, spare = leaf(collector, "Binder"), leaf(collector, "Spare")
    deck = create(collector, "Furret deck").json()["location"]["id"]
    normal, reverse = edition("meta-1", type="normal"), edition("meta-1", type="reverse")
    twin_normal, twin_reverse = edition("meta-2", type="normal"), edition("meta-2", type="reverse")
    split_one, split_two = edition("meta-3", thirdParty={"tcgplayer": 1}), edition("meta-3", thirdParty={"tcgplayer": 2})

    # Catalog Overrides: a reviewed manual Edition and a reviewed manual Printing.
    with connect() as conn:
        furret_printing = conn.execute("SELECT id FROM catalog_printing WHERE source_id='meta-1'").fetchone()["id"]
    edition_report = report({"kind": "edition", "printing_id": str(furret_printing), "descriptor": {"finish": "cosmos foil"},
                             "evidence_url": "https://example.org/cosmos"}).json()["id"]
    issue_code(edition_report, "approve_edition")
    cosmos = approve(edition_report).json()["approved_edition_id"]
    printing_report = report({"kind": "printing", "set_id": "promo", "set_name": "Promo", "collector_number": "SV01",
                              "english_name": "Furret", "evidence_url": "https://example.org/promo"}).json()["id"]
    issue_code(printing_report)
    approved = approve(printing_report).json()
    with connect() as conn:
        manual = str(conn.execute("SELECT id FROM catalog_edition WHERE printing_id=%s", (approved["approved_printing_id"],)).fetchone()["id"])

    for location, item, quantity in ((binder, normal, "5"), (binder, cosmos, "2"), (binder, manual, "1"),
                                     (binder, twin_normal, "4"), (binder, split_one, "2"), (binder, split_two, "7"),
                                     (deck, reverse, "3"), (spare, twin_reverse, "6")):
        assert add(collector, location, item, quantity).status_code == 200

    # Replacement/deprecation decided through the owner endpoint; Holdings stay put.
    with connect() as conn:
        twin_printing = conn.execute("SELECT id FROM catalog_printing WHERE source_id='meta-2'").fetchone()["id"]
        review = conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail)
          VALUES (%s,'meta-2','variant_ambiguity','finish-correction','Finish correction') RETURNING id""", (twin_printing,)).fetchone()["id"]
    review_code(OWNER, review, "resolve_catalog")
    decided = call("POST", f"/api/admin/catalog-reviews/{review}/decision", OWNER, {
        "decision": "deprecate_edition", "reason": "Physical finish corrected", "evidence_url": "https://example.org/finish",
        "code": "123456", "edition_id": twin_normal, "replacement_edition_id": twin_reverse,
        "evidence_digest": shown(OWNER, review)})
    assert decided.status_code == 200, decided.text

    # A pending Move, an Undo entry and a Published Deck all reference current Editions.
    spare_row = call("GET", f"/api/holdings/{spare}", collector).json()["holdings"][0]
    removal = start(collector, spare)
    stage(collector, removal, [selected(twin_reverse, 1, spare_row["version"])])
    assert call("POST", f"/api/moves/manifests/{removal}/remove", collector, {"idempotency_key": str(uuid4())}).status_code == 200
    binder_rows = {row["edition_id"]: row for row in call("GET", f"/api/holdings/{binder}", collector).json()["holdings"]}
    pending = start(collector, binder)
    assert stage(collector, pending, [selected(normal, 2, binder_rows[normal]["version"])]).status_code == 200
    publication = call("POST", f"/api/decks/{deck}/publication", collector, {"title": "Furret", "idempotency_key": str(uuid4())})
    assert publication.status_code == 200, publication.text
    public_path = f"/api/public/decks/{publication.json()['token']}"
    published = client.get(public_path).json()
    [published_edition] = published["identities"][0]["editions"]
    with connect() as conn:
        refs = conn.execute("""SELECT e.public_ref AS edition_ref,p.public_ref AS printing_ref FROM catalog_edition e
          JOIN catalog_printing p ON p.id=e.printing_id WHERE e.id=%s""", (reverse,)).fetchone()
    assert {key: published_edition[key] for key in refs} == refs

    before = relationships(collector)
    target_metadata = repriced(normal=1.25, reverse=2.5, card=1.25)
    target_metadata["set"]["tcgOnline"] = "DAA"
    target_metadata["regulationMark"] = "D"
    target_metadata["thirdParty"] = {"tcgplayer": 219333}
    target_metadata["variants_detailed"][0]["variantId"] = "n-2"
    for records in ((repriced(), twin(), product_split()), (target_metadata, twin(), product_split())):
        run(Records(*records))
        assert relationships(collector) == before
        assert client.get(public_path).json() == published
    with connect() as conn:
        mapping = conn.execute("SELECT mapping_revision,mapping_state FROM catalog_edition_metadata WHERE edition_id=%s",
                               (normal,)).fetchone()
    assert mapping == {"mapping_revision": 2, "mapping_state": "unverified"}

    # Ambiguous correspondence: the source now describes one product-free variant.
    collapsed = product_split()
    collapsed["variants_detailed"] = [{"type": "normal"}]
    run(Records(target_metadata, twin(), collapsed))
    after = relationships(collector)
    assert {key: value for key, value in after.items() if key != "active"} == {
        key: value for key, value in before.items() if key != "active"}
    active = {str(row["edition_id"]): row["active"] for row in after["active"]}
    assert active[split_one] and active[split_two] and not active[twin_normal]
    quantities = {str(row["edition_id"]): row["quantity"] for row in after["holdings"] if str(row["location_id"]) == binder}
    assert (quantities[split_one], quantities[split_two]) == (2, 7)
    with connect() as conn:
        assert conn.execute("""SELECT count(*) AS n FROM catalog_review WHERE source_id='meta-3'
          AND kind='variant_ambiguity' AND status='pending'""").fetchone()["n"] == 1
        assert {row["mapping_candidate"]["correspondence"] for row in conn.execute(
            "SELECT mapping_candidate FROM catalog_edition_metadata WHERE edition_id IN (%s,%s)", (split_one, split_two))} == {"unresolved"}

    # Pending inventory work still applies to the unchanged Editions.
    [undo] = call("GET", "/api/moves/undo", collector).json()
    assert call("POST", f"/api/moves/undo/{undo['id']}", collector, {"idempotency_key": str(uuid4())}).status_code == 200
    committed = commit(collector, pending, spare)
    assert committed.status_code == 200, committed.text
    spare_after = {row["edition_id"]: row["quantity"] for row in call("GET", f"/api/holdings/{spare}", collector).json()["holdings"]}
    assert spare_after == {twin_reverse: "6", normal: "2"}
    assert client.get(public_path).json() == published
