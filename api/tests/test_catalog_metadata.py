"""Mutable marketplace/quote/export metadata beside immutable physical Edition identity."""
import copy
import json
from uuid import uuid4

from app.catalog import fingerprint
from app.main import connect
from test_catalog import Source, reset_catalog
from test_catalog_reconciliation import review_code, run
from test_holdings import call


def furret(**changes):
    """A TCGdex-shaped record with variant-level lookup and quote data."""
    record = {
        "id": "meta-1", "name": "Furret", "localId": "136", "category": "Pokemon", "rarity": "Uncommon",
        "set": {"id": "swsh3", "name": "Darkness Ablaze", "cardCount": {"official": 189, "total": 201}},
        "variants": {"normal": True, "reverse": True, "holo": False},
        "variants_detailed": [
            {"type": "normal", "size": "standard", "variantId": "n-1",
             "pricing": {"tcgplayer": {"unit": "USD", "updated": "2026-10-07T22:55:02Z",
                                       "normal": {"productId": 219333, "marketPrice": 0.25}}}},
            {"type": "reverse", "size": "standard", "variantId": "r-1",
             "pricing": {"tcgplayer": {"unit": "USD", "updated": "2026-10-07T22:55:02Z",
                                       "reverse-holofoil": {"productId": 219333, "marketPrice": 0.43}}}},
        ],
        "card_pricing": {"tcgplayer": {"unit": "USD", "updated": "2026-10-07T22:55:02Z",
                                       "normal": {"productId": 219333, "marketPrice": 0.25}}},
    }
    for path, value in changes.items():
        target = record
        *parents, leaf = path.split("__")
        for key in parents:
            target = target[int(key)] if isinstance(target, list) else target[key]
        if isinstance(target, list):
            target[int(leaf)] = value
        else:
            target[leaf] = value
    return record


class Records(Source):
    def __init__(self, *records):
        super().__init__(ids=tuple(record["id"] for record in records))
        self.records = {record["id"]: copy.deepcopy(record) for record in records}

    def fetch(self, source_id):
        return copy.deepcopy(self.records[source_id])


def editions(source_id="meta-1"):
    with connect() as conn:
        return conn.execute("""SELECT e.id,e.descriptor,e.public_ref,m.mapping_candidate,m.mapping_revision,
          m.mapping_quarantined,m.quote_candidate,m.xmin::text AS metadata_xmin,e.xmin::text AS edition_xmin
          FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          LEFT JOIN catalog_edition_metadata m ON m.edition_id=e.id
          WHERE p.source_id=%s ORDER BY e.descriptor_key""", (source_id,)).fetchall()


def reviews():
    with connect() as conn:
        return conn.execute("SELECT * FROM catalog_review ORDER BY created_at,id").fetchall()


def by_type(rows):
    return {row["descriptor"].get("type") or row["descriptor"].get("finish") or row["descriptor"]["kind"]: row
            for row in rows}


def test_set_growth_changes_no_mapping_revision_or_quarantine():
    reset_catalog(); run(Records(furret()))
    before = by_type(editions())
    run(Records(furret(set={"id": "swsh3", "name": "Darkness Ablaze", "cardCount": {"official": 189, "total": 205}})))
    after = by_type(editions())
    assert after.keys() == before.keys() == {"normal", "reverse"}
    for kind, row in after.items():
        assert row["id"] == before[kind]["id"]
        assert row["mapping_revision"] == before[kind]["mapping_revision"]
        assert not row["mapping_quarantined"]
        assert "physical_evidence" not in row["mapping_candidate"]
    assert reviews() == []


def test_lookup_candidate_change_advances_mapping_revision_and_quarantines():
    reset_catalog(); run(Records(furret()))
    before = by_type(editions())
    changed = furret()
    changed["variants_detailed"][0]["pricing"]["tcgplayer"]["normal"]["productId"] = 999
    run(Records(changed))
    after = by_type(editions())
    assert after["normal"]["mapping_revision"] == before["normal"]["mapping_revision"] + 1
    assert after["normal"]["mapping_quarantined"]
    assert after["reverse"]["mapping_revision"] == before["reverse"]["mapping_revision"]
    assert not after["reverse"]["mapping_quarantined"]


def test_exact_variant_match_is_the_only_edition_quote_candidate():
    reset_catalog(); run(Records(furret()))
    rows = by_type(editions())
    assert rows["normal"]["mapping_candidate"]["correspondence"] == "source_candidate"
    assert rows["normal"]["quote_candidate"]["tcgplayer"]["normal"]["marketPrice"] == 0.25
    assert rows["reverse"]["quote_candidate"]["tcgplayer"]["reverse-holofoil"]["marketPrice"] == 0.43


def test_record_level_marketplace_data_is_never_an_edition_quote():
    reset_catalog()
    legacy = furret()
    del legacy["variants_detailed"]
    legacy["thirdParty"] = {"tcgplayer": 219333}
    unknown_finish = {**copy.deepcopy(legacy), "id": "meta-2", "localId": "137", "variants": {}}
    run(Records(legacy, unknown_finish))
    rows = by_type(editions())
    assert rows.keys() == {"normal", "reverse"}
    for row in rows.values():
        assert row["mapping_candidate"]["correspondence"] == "printing_level"
        assert row["mapping_candidate"]["candidate"]["thirdParty"] == {"tcgplayer": 219333}
        assert "marketPrice" not in json.dumps(row["mapping_candidate"])
        assert row["quote_candidate"] == {}
    [unspecified] = editions("meta-2")
    assert unspecified["descriptor"]["kind"] == "unspecified"
    assert unspecified["mapping_candidate"]["correspondence"] == "unresolved"
    assert unspecified["quote_candidate"] == {}


def printing_rows(source_id="meta-1"):
    with connect() as conn:
        return conn.execute("""SELECT p.id,p.public_ref,p.xmin::text AS printing_xmin,m.xmin::text AS metadata_xmin,
          m.source_record,m.export_candidate,m.live_revision,m.live_quarantined
          FROM catalog_printing p JOIN catalog_printing_metadata m ON m.printing_id=p.id WHERE p.source_id=%s""",
                            (source_id,)).fetchone()


def repriced(normal=0.31, reverse=0.47, card=0.31):
    record = furret()
    record["variants_detailed"][0]["pricing"]["tcgplayer"]["normal"]["marketPrice"] = normal
    record["variants_detailed"][0]["pricing"]["tcgplayer"]["updated"] = "2026-10-08T22:55:02Z"
    record["variants_detailed"][1]["pricing"]["tcgplayer"]["reverse-holofoil"]["marketPrice"] = reverse
    record["card_pricing"]["tcgplayer"]["normal"]["marketPrice"] = card
    record["card_pricing"]["tcgplayer"]["updated"] = "2026-10-08T22:55:02Z"
    return record


def test_quote_only_changes_update_quotes_without_identity_or_review_churn():
    reset_catalog(); run(Records(furret()))
    before, printing = by_type(editions()), printing_rows()
    run(Records(repriced()))
    after = by_type(editions())
    assert reviews() == []
    assert after.keys() == before.keys()
    for kind, row in after.items():
        assert (row["id"], row["descriptor"], row["public_ref"], row["edition_xmin"]) == (
            before[kind]["id"], before[kind]["descriptor"], before[kind]["public_ref"], before[kind]["edition_xmin"])
        assert row["mapping_revision"] == before[kind]["mapping_revision"] and not row["mapping_quarantined"]
    assert after["normal"]["quote_candidate"]["tcgplayer"]["normal"]["marketPrice"] == 0.31
    assert after["reverse"]["quote_candidate"]["tcgplayer"]["reverse-holofoil"]["marketPrice"] == 0.47
    assert printing_rows() == printing
    # card_pricing is a printing-level quote: nothing Edition- or printing-scoped is rewritten.
    current = by_type(editions())
    run(Records(repriced(card=9.99)))
    assert printing_rows() == printing
    assert by_type(editions()) == current
    assert reviews() == []
    assert "card_pricing" not in printing["source_record"]


def test_identical_reimport_rewrites_no_catalog_identity_or_metadata_rows():
    reset_catalog(); run(Records(furret()))
    before, printing = editions(), printing_rows()
    run(Records(furret()))
    assert editions() == before and printing_rows() == printing


def test_set_growth_changes_no_live_export_revision():
    reset_catalog(); run(Records(furret()))
    printing = printing_rows()
    run(Records(furret(set={"id": "swsh3", "name": "Darkness Ablaze", "cardCount": {"official": 189, "total": 205}})))
    after = printing_rows()
    assert after["live_revision"] == printing["live_revision"] and not after["live_quarantined"]
    assert after["export_candidate"]["set"] == {"id": "swsh3", "name": "Darkness Ablaze"}


def test_physical_contradiction_beside_quote_change_still_reaches_review():
    reset_catalog(); run(Records(furret()))
    before = by_type(editions())
    changed = repriced()
    changed["variants_detailed"][1]["type"] = "holo"
    changed["variants_detailed"][1]["unclassifiedFacet"] = "galaxy"
    run(Records(changed))
    [review] = reviews()
    assert review["kind"] == "variant_ambiguity" and review["status"] == "pending"
    assert review["candidate"]["metadata"]["unknown_fields"]["variants"] == [{}, {"unclassifiedFacet": "galaxy"}]
    after = by_type(editions())
    assert after.keys() == before.keys()
    assert {row["id"] for row in after.values()} == {row["id"] for row in before.values()}
    assert all(row["mapping_candidate"]["correspondence"] == "unresolved" and row["quote_candidate"] == {}
               for row in after.values())


def test_variant_third_party_change_is_reviewed_until_the_preflight_gate():
    # ADR 0007: product IDs remain inside existing variant descriptors. Ignoring them
    # would be a compatibility key, which waits for the target-datastore preflight.
    reset_catalog()
    record = furret()
    record["variants_detailed"][0]["thirdParty"] = {"tcgplayer": 219333}
    run(Records(record))
    before = by_type(editions())
    record["variants_detailed"][0]["thirdParty"] = {"tcgplayer": 555}
    run(Records(record))
    assert [row["kind"] for row in reviews()] == ["variant_ambiguity"]
    after = by_type(editions())
    assert {row["id"] for row in after.values()} == {row["id"] for row in before.values()}


def renamed(**quotes):
    record = repriced(**quotes) if quotes else furret()
    record["name"] = "Furret Delta"
    return record


def owner():
    user = f"owner-{uuid4()}"
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (user,))
        conn.execute("DELETE FROM owner_binding")
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (user,))
    return user


def test_pending_review_evidence_is_not_rewritten_by_quote_only_changes():
    reset_catalog(); run(Records(furret())); run(Records(renamed()))
    [pending] = reviews()
    assert pending["kind"] == "name_change" and pending["candidate"]["name"] == "Furret Delta"
    run(Records(renamed(normal=0.99, reverse=1.99, card=0.99)))
    assert reviews() == [pending]


def test_decided_review_provenance_survives_reimport_of_the_same_discrepancy():
    reset_catalog(); run(Records(furret())); run(Records(renamed()))
    user = owner()
    [pending] = call("GET", "/api/admin/catalog-reviews", user).json()
    review_code(user, pending["id"], "resolve_catalog")
    decided = call("POST", f"/api/admin/catalog-reviews/{pending['id']}/decision", user, {
        "decision": "keep_existing", "reason": "Physical card is Furret", "evidence_url": "https://example.org/furret",
        "code": "123456", "evidence_digest": pending["evidence_digest"]})
    assert decided.status_code == 200, decided.text
    [retained] = reviews()
    run(Records(renamed(normal=0.99, reverse=1.99, card=0.99)))
    assert reviews() == [retained]
    assert retained["status"] == "retained" and retained["reviewer_id"] == user
    assert call("GET", "/api/admin/catalog-reviews", user).json() == []


def make_legacy(review_candidate, record):
    """Model a review and generation fingerprint written by the historical raw-payload importer."""
    with connect() as conn:
        legacy = fingerprint(record)
        conn.execute("UPDATE catalog_review SET source_fingerprint=%s,candidate=%s", (legacy, json.dumps(review_candidate)))
        conn.execute("""UPDATE catalog_generation_printing SET source_fingerprint=%s
          WHERE generation_id=(SELECT active_generation FROM catalog_state) AND source_id=%s""", (legacy, record["id"]))
    return legacy


def test_pre_candidate_legacy_reviews_are_reused_across_identical_and_quote_only_imports():
    reset_catalog(); run(Records(furret())); run(Records(renamed()))
    legacy = make_legacy({}, renamed())
    run(Records(renamed()))
    assert [(row["source_fingerprint"], row["kind"]) for row in reviews()] == [(legacy, "name_change")]
    run(Records(renamed(normal=0.77, reverse=0.88, card=0.77)))
    assert [(row["source_fingerprint"], row["kind"]) for row in reviews()] == [(legacy, "name_change")]


def test_legacy_candidate_reuse_ignores_image_and_ambiguity_flags():
    reset_catalog(); run(Records(furret())); run(Records(renamed()))
    [review] = reviews()
    candidate = {key: value for key, value in review["candidate"].items() if key != "metadata"}
    candidate.update(image_url="https://example.org/older-scan", ambiguous=True)
    make_legacy(candidate, {"id": "meta-1", "historical": "raw payload"})
    run(Records(renamed(normal=0.66, reverse=0.67, card=0.66)))
    assert len(reviews()) == 1
