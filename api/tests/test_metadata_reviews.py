"""Collector metadata reports and maintainer decisions over signed HTTP against PostgreSQL."""
import hashlib
import hmac
import json
import os
import time
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.main import app, connect
from app import metadata_reviews, price_binding, public_catalog, rule_rollout
from app.price_binding import rebind_best_effort
from app.catalog_targets import LIVE, MATCHING, MATCHING_RULES, activate_rule, code_digest, edition_targets, fingerprint, printing_live
from test_catalog import reset_catalog
from test_catalog_metadata import Records, furret
from test_catalog_reconciliation import run
from test_catalog_targets import card, isolated_rules, metadata  # noqa: F401 (isolated_rules is an autouse fixture)

client = TestClient(app)
OWNER, REPORTER, OTHER = "meta-owner", "meta-reporter", "meta-other"
ADMIN = "/api/admin/catalog-metadata"
REPORTS = "/api/catalog/metadata-reports"


def request(method, path, user, body=None, **params):
    raw = json.dumps(body, separators=(",", ":")).encode() if body is not None else b""
    stamp = str(int(time.time()))
    message = f"{method}\n{path}\n{hashlib.sha256(raw).hexdigest()}\n{user}\n{stamp}".encode()
    headers = {"x-internal-user": user, "x-internal-time": stamp, "content-type": "application/json",
               "x-internal-signature": hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), message, hashlib.sha256).hexdigest()}
    return client.request(method, path, content=raw if body is not None else None, headers=headers, params=params)


@pytest.fixture(autouse=True)
def published(monkeypatch):
    """Record post-commit publication; delivery itself is the outbox's concern, not this module's."""
    calls = []
    monkeypatch.setattr(public_catalog, "publish_catalog_best_effort", lambda *a, **k: calls.append((a, k)) or True)
    return calls


@pytest.fixture(autouse=True)
def spawned(monkeypatch):
    """Never start a real detached drain from a route test; record that one was asked for."""
    calls = []
    monkeypatch.setattr(public_catalog, "spawn_background_drain", lambda: calls.append(True) or True)
    return calls


@pytest.fixture(autouse=True)
def price_store(monkeypatch, tmp_path):
    """The `price:` store the post-commit publish writes to; every thread the routes spawn is joined before the next test."""
    from app import price_binding, public_prices
    from app.public_records import FilePublicRecords
    records = FilePublicRecords(tmp_path / "price-store")
    records.initialize(deadline=time.monotonic() + 10)
    monkeypatch.setattr(public_prices, "public_record_store", lambda: records)
    yield records
    price_binding.join_spawned_rebinds()


def seed_users():
    reset_catalog()
    with connect() as conn:
        for user in (OWNER, REPORTER, OTHER):
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user,))
        conn.execute("DELETE FROM owner_binding")
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (OWNER,))


@pytest.fixture
def world():
    seed_users()
    run(Records(card(1)))
    printing, editions = metadata()
    return {"printing": str(printing["printing_id"]), "normal": str(editions["normal"]["id"]),
            "reverse": str(editions["reverse"]["id"])}


def snapshot():
    """Everything a report must leave alone."""
    with connect() as conn:
        return {
            "clock": conn.execute("SELECT revision FROM catalog_public_clock").fetchone()["revision"],
            "outbox": conn.execute("SELECT count(*) AS n FROM catalog_public_outbox").fetchone()["n"],
            "state": conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"],
            "editions": conn.execute("""SELECT edition_id,mapping_state,mapping_revision,public_revision,product_id,quote_variant
              FROM catalog_edition_metadata ORDER BY edition_id""").fetchall(),
            "printings": conn.execute("SELECT printing_id,live_state,public_revision,live_identity FROM catalog_printing_metadata ORDER BY printing_id").fetchall(),
        }


def market_report(world, **changes):
    body = {"target": "marketplace", "issue": "incorrect", "printing_id": world["printing"], "edition_id": world["normal"],
            "proposed": {"product_id": 4321, "quote_variant": "normal"}, "evidence_url": "https://example.org/evidence",
            "note": "The product looks wrong"}
    return request("POST", REPORTS, REPORTER, {**body, **changes})


# ------------------------------------------------------------------ AC1: reports are unapproved input


def test_a_report_is_stored_for_review_and_changes_no_state_revision_or_outbox(world):
    before = snapshot()
    response = market_report(world)
    assert response.status_code == 201, response.text
    view = response.json()
    assert (view["status"], view["target"], view["proposed"]) == ("pending", "marketplace", {"product_id": 4321, "quote_variant": "normal"})
    assert "reporter_id" not in view and "reviewer_id" not in view
    live = request("POST", REPORTS, REPORTER, {"target": "live", "issue": "missing", "printing_id": world["printing"],
                                               "proposed": {"category": "Pokemon", "name": "Furret", "set_code": "DAA", "collector_number": "136"}})
    assert live.status_code == 201, live.text
    assert snapshot() == before  # not even the revision clock moved


def test_report_proposals_are_allowlisted_and_must_name_a_real_edition_of_the_printing(world):
    base = {"target": "marketplace", "issue": "incorrect", "printing_id": world["printing"], "edition_id": world["normal"]}
    for proposed in ({"price": 1}, {"product_id": 0}, {"product_id": 2**31}, {"quote_variant": "Bad Variant"}, {"live_identity": {}}):
        assert request("POST", REPORTS, REPORTER, {**base, "proposed": proposed}).status_code == 422, proposed
    for proposed in ({"product_id": 5}, {"set_code": "bad code!"}, {"category": "Mystery"}):
        body = {"target": "live", "issue": "incorrect", "printing_id": world["printing"], "proposed": proposed}
        assert request("POST", REPORTS, REPORTER, body).status_code == 422, proposed
    assert request("POST", REPORTS, REPORTER, {**base, "edition_id": None}).status_code == 422  # marketplace names an Edition
    missing = request("POST", REPORTS, REPORTER, {**base, "printing_id": str(uuid4())})
    assert (missing.status_code, missing.json()["detail"]["code"]) == (404, "PRINTING_NOT_FOUND")
    mismatch = request("POST", REPORTS, REPORTER, {**base, "edition_id": str(uuid4())})
    assert (mismatch.status_code, mismatch.json()["detail"]["code"]) == (422, "EDITION_PRINTING_MISMATCH")


def test_reports_are_reporter_scoped_and_the_reporter_can_answer_a_request_for_information(world):
    mine = market_report(world).json()["id"]
    assert [row["id"] for row in request("GET", REPORTS, REPORTER).json()] == [mine]
    assert request("GET", REPORTS, OTHER).json() == []
    assert request("GET", f"{REPORTS}/{mine}", REPORTER).status_code == 200
    assert request("GET", f"{REPORTS}/{mine}", OTHER).status_code == 404
    assert request("PATCH", f"{REPORTS}/{mine}", OTHER, {"note": "mine now"}).status_code == 404
    assert request("PATCH", f"{REPORTS}/{mine}", REPORTER, {"note": "not asked yet"}).status_code == 404  # only after needs_info
    asked = request("POST", f"{ADMIN}/reports/{mine}/decision", OWNER, {"decision": "needs_info", "reason": "Send a link"})
    assert (asked.status_code, asked.json()["status"]) == (200, "needs_info"), asked.text
    answered = request("PATCH", f"{REPORTS}/{mine}", REPORTER, {"note": "Link attached", "evidence_url": "https://example.org/more"})
    assert (answered.status_code, answered.json()["status"], answered.json()["note"]) == (200, "pending", "Link attached")


def test_the_twenty_sixth_open_report_is_refused(world):
    for _ in range(25):
        assert market_report(world).status_code == 201
    limited = market_report(world)
    assert (limited.status_code, limited.json()["detail"]["code"]) == (429, "REPORT_LIMIT")
    assert market_report(world).status_code == 429
    other = request("POST", REPORTS, OTHER, {"target": "marketplace", "issue": "missing", "printing_id": world["printing"], "edition_id": world["normal"]})
    assert other.status_code == 201  # the cap is per reporter


def test_report_decisions_need_the_owner_and_never_touch_catalog_state(world):
    mine = market_report(world).json()["id"]
    before = snapshot()
    assert request("POST", f"{ADMIN}/reports/{mine}/decision", REPORTER, {"decision": "reject", "reason": "x"}).status_code == 403
    for path in ("/queue", f"/printings/{world['printing']}/history"):
        assert request("GET", ADMIN + path, REPORTER).status_code == 403
    rejected = request("POST", f"{ADMIN}/reports/{mine}/decision", OWNER, {"decision": "reject", "reason": "Not the same card"})
    assert (rejected.status_code, rejected.json()["status"], rejected.json()["review_reason"]) == (200, "rejected", "Not the same card")
    assert request("POST", f"{ADMIN}/reports/{mine}/decision", OWNER, {"decision": "reject", "reason": "again"}).status_code == 409
    assert request("POST", f"{ADMIN}/reports/{uuid4()}/decision", OWNER, {"decision": "reject", "reason": "x"}).status_code == 404
    assert snapshot() == before
    assert request("GET", f"{REPORTS}/{mine}", REPORTER).json()["status"] == "rejected"


# ------------------------------------------------------------------ maintainer queue and evidence


def activate_as_owner(kind, version):
    with connect() as conn, conn.transaction():
        return activate_rule(conn, kind, version, OWNER, "https://example.org/rule", "Reviewed against the target")


def changed_card(number=1, product=999):
    record = card(number)
    record["variants_detailed"][0]["pricing"]["tcgplayer"]["normal"]["productId"] = product
    return record


@pytest.fixture
def quarantined(world):
    """card(1) verified under the matching rule, then its normal Edition's source product changes."""
    activate_as_owner(MATCHING, 1)
    run(Records(changed_card()))
    return world


def evidence(kind, target_id, user=OWNER):
    response = request("GET", f"{ADMIN}/{kind}/{target_id}", user)
    assert response.status_code == 200, response.text
    return response.json()


def queue(user=OWNER, **params):
    response = request("GET", f"{ADMIN}/queue", user, **params)
    assert response.status_code == 200, response.text
    return response.json()


def test_queue_lists_only_targets_needing_attention_with_a_digest_and_no_reporter_identity(quarantined):
    assert [(item["kind"], item["edition_id"], item["state"], item["reason"]) for item in queue()["items"]] == [
        ("edition", quarantined["normal"], "quarantined", "candidate_changed")]
    report = market_report(quarantined, edition_id=quarantined["reverse"]).json()["id"]
    live_report = request("POST", REPORTS, REPORTER, {"target": "live", "issue": "missing", "printing_id": quarantined["printing"]})
    assert live_report.status_code == 201
    items = queue()["items"]
    assert {(item["kind"], item["target"]) for item in items} == {("edition", "marketplace"), ("printing", "live")}
    reverse = next(item for item in items if item["edition_id"] == quarantined["reverse"])
    assert (reverse["state"], reverse["report_ids"]) == ("verified", [report])
    flat = json.dumps(items)
    assert REPORTER not in flat and "reporter" not in flat
    for item in items:
        assert len(item["evidence_digest"]) == 64 and item["basis_revision"] > 0
    assert request("GET", f"{ADMIN}/queue", REPORTER).status_code == 403


def test_queue_pages_by_keyset_cursor(quarantined, monkeypatch):
    monkeypatch.setattr(metadata_reviews, "QUEUE_PAGE", 1)
    market_report(quarantined, edition_id=quarantined["reverse"])
    request("POST", REPORTS, REPORTER, {"target": "live", "issue": "missing", "printing_id": quarantined["printing"]})
    seen, cursor = [], None
    for _ in range(5):
        page = queue(**({"cursor": cursor} if cursor else {}))
        seen += [(item["kind"], item["edition_id"] or item["printing_id"]) for item in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)) == 3
    assert request("GET", f"{ADMIN}/queue", OWNER, cursor="garbage").status_code == 422


def test_evidence_changes_when_the_source_candidate_or_open_reports_change(quarantined):
    first = evidence("editions", quarantined["normal"])
    assert evidence("editions", quarantined["normal"])["evidence_digest"] == first["evidence_digest"]
    market_report(quarantined)
    second = evidence("editions", quarantined["normal"])
    assert second["evidence_digest"] != first["evidence_digest"] and len(second["report_ids"]) == 1
    run(Records(changed_card(product=777)))  # a newer source value arrives
    third = evidence("editions", quarantined["normal"])
    assert third["evidence_digest"] != second["evidence_digest"]
    assert third["source_fingerprint"] == fingerprint(third["source_candidate"])
    assert request("GET", f"{ADMIN}/editions/{uuid4()}", OWNER).status_code == 404
    assert request("GET", f"{ADMIN}/printings/{uuid4()}/history", OWNER).status_code == 404


# ------------------------------------------------------------------ marketplace decisions


def target_of(item):
    return f"{item['kind']}:{item['edition_id'] or item['printing_id']}"


def decide(item, decision, reviewed_value=None, *, user=OWNER, **over):
    body = {"target": item["target"], "printing_id": item["printing_id"], "edition_id": item["edition_id"], "decision": decision,
            "basis_revision": item["basis_revision"], "evidence_digest": item["evidence_digest"],
            "evidence_url": "https://example.org/evidence", "reason": "Checked the physical card", "report_ids": [],
            **({"reviewed_value": reviewed_value} if reviewed_value is not None else {})}
    return request("POST", f"{ADMIN}/decisions", user, {**body, **over})


def edition_row(edition_id):
    with connect() as conn:
        return conn.execute("SELECT * FROM catalog_edition_metadata WHERE edition_id=%s", (edition_id,)).fetchone()


def test_correction_verifies_a_quarantined_edition_with_provenance_and_without_catalog_side_effects(quarantined, published):
    item = evidence("editions", quarantined["normal"])
    before = snapshot()
    before_row = edition_row(quarantined["normal"])
    response = decide(item, "correct", {"product_id": 999, "quote_variant": "normal"})  # the source block now says 999
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["state"], body["reason"], body["decision"]) == ("verified", None, "correct")
    after = edition_row(quarantined["normal"])
    assert (after["mapping_state"], after["product_id"], after["quote_variant"], after["mapping_basis"], after["auto_closed"]) == (
        "verified", 999, "normal", "maintainer", True)
    assert after["mapping_revision"] == before_row["mapping_revision"] + 1 and after["public_revision"] > before_row["public_revision"]
    assert str(after["mapping_decision_id"]) == body["decision_id"] and after["accepted_fingerprint"] == item["source_fingerprint"]
    after_snapshot = snapshot()
    assert after_snapshot["state"] == before["state"]  # the catalog revision never moves for metadata
    assert after_snapshot["clock"] == before["clock"] + 1
    with connect() as conn:
        decision = conn.execute("SELECT * FROM catalog_metadata_decision").fetchone()
        rejections = conn.execute("SELECT * FROM catalog_metadata_rejection").fetchall()
        outbox = conn.execute("SELECT target_kind,target_id,revision FROM catalog_public_outbox WHERE revision=%s", (after["public_revision"],)).fetchall()
        targets = edition_targets(conn, [after["edition_id"]])[after["edition_id"]]
    assert (decision["reviewer_id"], decision["decision"], decision["basis_revision"], decision["source_fingerprint"]) == (
        OWNER, "correct", item["basis_revision"], item["source_fingerprint"])
    assert decision["checks"] == {"printing": "passed", "product": "passed", "variant": "passed"}
    assert decision["clock_revision"] == after["public_revision"] and decision["reviewed_value"] == {"product_id": 999, "quote_variant": "normal"}
    assert [(r["source_fingerprint"], r["decision_id"]) for r in rejections] == [(item["source_fingerprint"], decision["id"])]
    assert [(o["target_kind"], str(o["target_id"])) for o in outbox] == [("edition", quarantined["normal"])]
    assert targets.product_id == 999 and targets.quote_lookup["variant"] == "normal"
    assert len(published) == 1
    # The rejected source value repeats: no new quarantine, no new revision.
    settled = edition_row(quarantined["normal"])
    run(Records(changed_card()))
    again = edition_row(quarantined["normal"])
    assert (again["mapping_state"], again["public_revision"]) == ("verified", settled["public_revision"])


def test_verify_source_accepts_the_exact_source_product_and_records_checks(world):
    item = evidence("editions", world["normal"])
    assert (item["state"], item["reason"]) == ("unverified", "no_matching_rule")
    response = decide(item, "verify_source")
    assert response.status_code == 200, response.text
    row = edition_row(world["normal"])
    assert (row["mapping_state"], row["product_id"], row["quote_variant"], row["mapping_basis"]) == ("verified", 1001, "normal", "maintainer")
    with connect() as conn:
        decision = conn.execute("SELECT * FROM catalog_metadata_decision").fetchone()
        assert conn.execute("SELECT count(*) AS n FROM catalog_metadata_rejection").fetchone()["n"] == 0  # accepting rejects nothing
    assert decision["reviewed_value"] == {"product_id": 1001, "quote_variant": "normal"}
    assert decision["checks"] == {"printing": "passed", "product": "passed", "variant": "passed"}


def test_a_product_without_an_established_variant_verifies_unpriced(world):
    record = card(1)
    record["variants_detailed"][0]["pricing"]["tcgplayer"] = {"unit": "USD", "holofoil": {"productId": 55}}
    run(Records(record))
    item = evidence("editions", world["normal"])
    assert decide(item, "verify_source").json()["state"] == "verified"  # the product is established, the variant is not
    row = edition_row(world["normal"])
    assert (row["product_id"], row["quote_variant"]) == (55, None)
    with connect() as conn:
        assert conn.execute("SELECT checks FROM catalog_metadata_decision").fetchone()["checks"]["variant"] == "not_established"
    pending = evidence("editions", world["reverse"])
    assert decide(pending, "correct", {"product_id": 7001, "quote_variant": None}).json()["state"] == "verified"
    assert edition_row(world["reverse"])["quote_variant"] is None


def test_invalid_decisions_are_422_and_change_nothing(world):
    item = evidence("editions", world["normal"])
    cases = [("correct", None, "INVALID_PRODUCT"), ("correct", {"product_id": 0, "quote_variant": None}, "INVALID_PRODUCT"),
             ("correct", {"product_id": 5, "quote_variant": "Bad Variant"}, "INVALID_PRODUCT"),
             ("correct", {"product_id": 2**31, "quote_variant": None}, "INVALID_PRODUCT"),
             ("unsupported", None, "INVALID_DECISION")]
    for decision, value, code in cases:
        response = decide(item, decision, value)
        assert (response.status_code, response.json()["detail"]["code"]) == (422, code), (decision, value)
    value = {"product_id": 5, "quote_variant": None}
    assert decide(item, "correct", value, edition_id=None).status_code == 422
    assert decide(item, "correct", value, reason=" ").status_code == 422
    assert edition_row(world["normal"])["mapping_state"] == "unverified"
    assert decide(item, "correct", value).status_code == 200  # the same evidence still decides


def test_an_unspecified_variant_can_never_be_verified():
    seed_users()
    legacy = furret()
    del legacy["variants_detailed"]
    legacy["variants"] = {}
    run(Records(legacy))
    with connect() as conn:
        unspecified = str(conn.execute("""SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          WHERE p.source_id='meta-1' AND e.descriptor->>'label'='Unspecified Variant'""").fetchone()["id"])
    item = evidence("editions", unspecified)
    for decision, value in (("verify_source", None), ("correct", {"product_id": 5, "quote_variant": None})):
        response = decide(item, decision, value)
        assert (response.status_code, response.json()["detail"]["code"]) == (422, "UNSPECIFIED_VARIANT")
    assert edition_row(unspecified)["mapping_state"] == "unverified"
    assert decide(item, "unmap").status_code == 200  # recording that it stays unmapped is allowed
    assert edition_row(unspecified)["mapping_reason"] == "unspecified_variant"


def test_a_product_or_price_slot_held_elsewhere_is_a_mapping_conflict(world):
    activate_as_owner(MATCHING, 1)
    run(Records(card(1), card(2)))
    with connect() as conn:
        second = str(conn.execute("""SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          WHERE p.source_id='meta-2' AND e.descriptor->>'type'='normal'""").fetchone()["id"])
    # Another Printing already holds product 1001.
    response = decide(evidence("editions", second), "correct", {"product_id": 1001, "quote_variant": "normal"})
    assert (response.status_code, response.json()["detail"]["code"]) == (409, "MAPPING_CONFLICT")
    assert edition_row(second)["product_id"] == 1002
    # Even in a price slot nobody holds, a product belongs to one Printing (the database index alone would not catch this).
    shared = decide(evidence("editions", second), "correct", {"product_id": 1001, "quote_variant": "holofoil"})
    assert (shared.status_code, shared.json()["detail"]["code"]) == (409, "MAPPING_CONFLICT")
    assert decide(evidence("editions", second), "correct", {"product_id": 1001, "quote_variant": None}).json()["detail"]["code"] == "MAPPING_CONFLICT"
    # A sibling may share the product, but the sibling's variant key is not in this Edition's own source block,
    # so the correction is published unpriced rather than borrowing the sibling's price slot.
    clash = decide(evidence("editions", world["normal"]), "correct", {"product_id": 1001, "quote_variant": "reverse-holofoil"})
    assert clash.status_code == 200, clash.text
    assert (edition_row(world["normal"])["product_id"], edition_row(world["normal"])["quote_variant"]) == (1001, None)


def test_unmap_and_reject_source_clear_the_mapping_and_the_rejected_value_stays_rejected(quarantined):
    item = evidence("editions", quarantined["normal"])
    before = edition_row(quarantined["normal"])
    response = decide(item, "reject_source")
    assert response.status_code == 200, response.text
    row = edition_row(quarantined["normal"])
    assert (row["mapping_state"], row["mapping_reason"], row["product_id"], row["mapping_basis"]) == ("unverified", "reviewed_unmapped", None, None)
    assert row["mapping_revision"] == before["mapping_revision"] + 1 and row["auto_closed"]
    run(Records(changed_card()))  # the same rejected value again: nothing happens
    assert edition_row(quarantined["normal"])["public_revision"] == row["public_revision"]
    verified = evidence("editions", quarantined["reverse"])
    assert decide(verified, "unmap").status_code == 200
    assert edition_row(quarantined["reverse"])["mapping_state"] == "unverified"
    history = request("GET", f"{ADMIN}/editions/{quarantined['normal']}/history", OWNER).json()
    assert [(h["decision"], h["reviewer_id"]) for h in history] == [("reject_source", OWNER)]
    assert history[0]["source_fingerprint"] == item["source_fingerprint"]


def test_decision_history_is_append_only(quarantined):
    decide(evidence("editions", quarantined["normal"]), "reject_source")
    with connect() as conn:
        with pytest.raises(psycopg.errors.RaiseException):
            conn.execute("UPDATE catalog_metadata_decision SET reason='rewritten'")
    with connect() as conn:
        with pytest.raises(psycopg.errors.RaiseException):
            conn.execute("DELETE FROM catalog_metadata_decision")


# ------------------------------------------------------------------ evidence binding, codes and locking


def test_stale_evidence_is_a_conflict_that_changes_nothing(quarantined):
    shown = evidence("editions", quarantined["normal"])
    run(Records(changed_card(product=777)))  # a newer source value arrives while the maintainer reads
    stale = decide(shown, "reject_source")
    assert (stale.status_code, stale.json()["detail"]["code"]) == (409, "METADATA_EVIDENCE_CHANGED")
    assert edition_row(quarantined["normal"])["mapping_state"] == "quarantined"
    fresh = evidence("editions", quarantined["normal"])
    assert decide(fresh, "reject_source").status_code == 200  # with fresh evidence
    replay = decide(fresh, "reject_source")
    assert replay.status_code == 409  # the first decision moved the basis


def test_a_wrong_basis_revision_or_a_new_report_makes_evidence_stale(quarantined):
    shown = evidence("editions", quarantined["normal"])
    assert decide(shown, "reject_source", basis_revision=shown["basis_revision"] - 1).status_code == 409
    market_report(quarantined)  # an open report is part of the evidence the maintainer must have seen
    assert decide(shown, "reject_source").status_code == 409
    assert edition_row(quarantined["normal"])["mapping_state"] == "quarantined"


def test_candidate_only_changes_are_caught_by_the_digest_even_when_the_public_revision_does_not_move(world):
    shown = evidence("printings", world["printing"])
    with connect() as conn:
        conn.execute("UPDATE catalog_printing_metadata SET export_candidate=%s WHERE printing_id=%s",
                     (json.dumps({"name": "Furret", "category": "Pokemon", "localId": "136", "set": {"id": "other"}}), world["printing"]))
    changed = evidence("printings", world["printing"])
    assert changed["basis_revision"] == shown["basis_revision"] and changed["evidence_digest"] != shown["evidence_digest"]
    response = decide(shown, "unsupported")
    assert (response.status_code, response.json()["detail"]["code"]) == (409, "METADATA_EVIDENCE_CHANGED")


def test_a_decision_takes_effect_on_the_owners_request_and_ignores_a_stale_code(world):
    item = evidence("editions", world["normal"])
    assert edition_row(world["normal"])["mapping_reason"] == "no_matching_rule"
    # A code left in the body by an older web bundle is neither required nor checked.
    assert decide(item, "unmap", code="000000").status_code == 200
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_metadata_decision").fetchone()["n"] == 1
    assert decide(item, "unmap").status_code == 409  # the first decision moved the basis


def test_only_the_owner_decides_and_a_collector_gets_nothing_from_the_admin_surface(world):
    item = evidence("editions", world["normal"])
    assert decide(item, "unmap", user=REPORTER).status_code == 403
    assert request("GET", f"{ADMIN}/editions/{world['normal']}", REPORTER).status_code == 403
    assert request("GET", "/api/admin/catalog-rules", REPORTER).status_code == 403
    assert edition_row(world["normal"])["mapping_reason"] == "no_matching_rule"


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_busy_catalog_clock_is_a_409_rather_than_a_hang(world, monkeypatch):
    item = evidence("editions", world["normal"])
    monkeypatch.setattr(metadata_reviews, "LOCK_TIMEOUT", "300ms")
    holder = connect()
    try:
        holder.execute("UPDATE catalog_public_clock SET revision=revision")  # an import promotion holds the clock
        started = time.monotonic()
        response = decide(item, "unmap")
        assert (response.status_code, response.json()["detail"]["code"]) == (409, "CATALOG_BUSY")
        assert time.monotonic() - started < 3
    finally:
        holder.rollback()
        holder.close()
    assert decide(item, "unmap").status_code == 200


def test_a_decision_closes_only_linked_open_reports_of_the_same_target(quarantined):
    mine = market_report(quarantined).json()["id"]
    other_edition = market_report(quarantined, edition_id=quarantined["reverse"]).json()["id"]
    request("POST", f"{ADMIN}/reports/{other_edition}/decision", OWNER, {"decision": "reject", "reason": "dup"})
    shown = evidence("editions", quarantined["normal"])
    assert shown["report_ids"] == [mine]
    wrong = decide(shown, "reject_source", report_ids=[other_edition])
    assert (wrong.status_code, wrong.json()["detail"]["code"]) == (422, "INVALID_REPORT")
    assert decide(shown, "reject_source", report_ids=[str(uuid4())]).status_code == 422
    assert request("GET", f"{REPORTS}/{mine}", REPORTER).json()["status"] == "pending"
    response = decide(shown, "correct", {"product_id": 4321, "quote_variant": "normal"}, report_ids=[mine])
    assert response.status_code == 200, response.text
    assert response.json()["closed_report_ids"] == [mine]
    closed = request("GET", f"{REPORTS}/{mine}", REPORTER).json()
    assert (closed["status"], closed["review_reason"]) == ("approved", "Checked the physical card")
    with connect() as conn:
        row = conn.execute("SELECT status,reviewer_id,decision_id FROM catalog_metadata_report WHERE id=%s", (mine,)).fetchone()
        decision = conn.execute("SELECT id FROM catalog_metadata_decision").fetchone()["id"]
    assert (row["status"], row["reviewer_id"], row["decision_id"]) == ("approved", OWNER, decision)


def test_a_rejecting_decision_rejects_its_linked_report(quarantined):
    mine = market_report(quarantined).json()["id"]
    assert decide(evidence("editions", quarantined["normal"]), "unmap", report_ids=[mine]).status_code == 200
    assert request("GET", f"{REPORTS}/{mine}", REPORTER).json()["status"] == "rejected"


def test_decisions_touch_no_quote_result_or_work_data_and_call_no_source(quarantined, published, monkeypatch):
    import socket
    monkeypatch.setattr(socket.socket, "connect", lambda *a, **k: pytest.fail("a decision must not open a network connection"))
    with connect() as conn:
        runs = conn.execute("SELECT count(*) AS n FROM catalog_run").fetchone()["n"]
        quotes = conn.execute("SELECT quote_candidate FROM catalog_edition_metadata ORDER BY edition_id").fetchall()
    before = snapshot()
    assert decide(evidence("editions", quarantined["normal"]), "correct", {"product_id": 4321, "quote_variant": "normal"}).status_code == 200
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_run").fetchone()["n"] == runs
        assert conn.execute("SELECT quote_candidate FROM catalog_edition_metadata ORDER BY edition_id").fetchall() == quotes
        kinds = {row["target_kind"] for row in conn.execute("SELECT target_kind FROM catalog_public_outbox")}
    assert kinds <= {"printing", "edition"}
    assert snapshot()["state"] == before["state"] and len(published) == 1
    assert not any(hasattr(metadata_reviews, name) for name in ("public_records", "quote_states", "read_all"))


# ------------------------------------------------------------------ Live decisions (API side of AC4)

LIVE_INPUTS = {"category": "Pokemon", "name": "Furret", "set_code": "DAB", "collector_number": "1"}


def printing_row(printing_id):
    with connect() as conn:
        return conn.execute("SELECT * FROM catalog_printing_metadata WHERE printing_id=%s", (printing_id,)).fetchone()


def test_a_live_correction_needs_an_active_rule_and_complete_reviewed_inputs(world):
    item = evidence("printings", world["printing"])
    refused = decide(item, "correct", LIVE_INPUTS)
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "NO_ACTIVE_RULE")
    activate_as_owner(LIVE, 1)
    before = printing_row(world["printing"])
    item = evidence("printings", world["printing"])
    for bad in ({**LIVE_INPUTS, "set_code": None}, {k: v for k, v in LIVE_INPUTS.items() if k != "set_code"},
                {**LIVE_INPUTS, "category": "Mystery"}, {**LIVE_INPUTS, "tcg_online": "DAB"}, None):
        response = decide(item, "correct", bad)
        assert (response.status_code, response.json()["detail"]["code"]) == (422, "INVALID_LIVE_INPUT"), bad
    assert printing_row(world["printing"])["public_revision"] == before["public_revision"]
    editions_before = {key: edition_row(world[key])["mapping_revision"] for key in ("normal", "reverse")}
    response = decide(item, "correct", LIVE_INPUTS)
    assert response.status_code == 200, response.text
    assert (response.json()["state"], response.json()["mapping_revision"]) == ("eligible", None)
    row = printing_row(world["printing"])
    assert (row["live_state"], row["live_basis"], row["live_identity"]) == (
        "eligible", "maintainer", {"category": "Pokemon", "name": "Furret", "set_code": "DAB", "number": "1"})
    assert row["live_inputs"] == LIVE_INPUTS and row["live_decision_id"] and row["live_activation_id"]
    # Live and marketplace revisions move independently.
    assert {key: edition_row(world[key])["mapping_revision"] for key in ("normal", "reverse")} == editions_before
    with connect() as conn:
        live = printing_live(conn, [row["printing_id"]])[row["printing_id"]]
        decision = conn.execute("SELECT * FROM catalog_metadata_decision").fetchone()
    assert live.state == "eligible" and live.identity["set_code"] == "DAB"
    assert (decision["target"], decision["edition_id"], decision["reviewed_value"]) == ("live", None, LIVE_INPUTS)


def test_live_verify_source_uses_only_a_rule_covered_source_and_unsupported_stays_closed(world):
    activate_as_owner(LIVE, 1)  # the shipped table is empty: the source set is not covered
    item = evidence("printings", world["printing"])
    uncovered = decide(item, "verify_source")
    assert (uncovered.status_code, uncovered.json()["detail"]["code"]) == (422, "INVALID_LIVE_INPUT")
    unsupported = decide(item, "unsupported")
    assert unsupported.status_code == 200, unsupported.text
    row = printing_row(world["printing"])
    assert (row["live_state"], row["live_reason"], row["live_auto_closed"]) == ("unsupported", "reviewed_unsupported", True)
    run(Records(card(1, regulationMark="E")))  # any later source value leaves a reviewed decision alone
    after = printing_row(world["printing"])
    assert (after["live_state"], after["live_reason"], after["live_auto_closed"]) == ("unsupported", "reviewed_unsupported", True)
    # The new regulation mark is a public format fact (Deck Lists 18), so only the Printing's revision moves.
    assert after["public_revision"] > row["public_revision"]


def test_live_verify_source_accepts_a_rule_derived_identity_as_a_maintainer_decision(world):
    activate_as_owner(LIVE, 99)
    row = printing_row(world["printing"])
    assert (row["live_state"], row["live_basis"]) == ("eligible", "rule")
    suspended_by = card(1, category="Trainer")
    run(Records(suspended_by))
    assert printing_row(world["printing"])["live_state"] == "suspended"
    assert [(i["kind"], i["state"], i["reason"]) for i in queue()["items"]] == [("printing", "suspended", "source_changed")]
    item = evidence("printings", world["printing"])
    response = decide(item, "verify_source")
    assert response.status_code == 200, response.text
    row = printing_row(world["printing"])
    assert (row["live_state"], row["live_basis"], row["live_identity"]["set_code"]) == ("eligible", "maintainer", "DAA")
    assert row["live_decision_id"] is not None and row["live_accepted_fingerprint"] == item["source_fingerprint"]
    assert queue()["items"] == []


def test_a_live_correction_that_collides_with_another_printing_is_refused_whole(world):
    activate_as_owner(LIVE, 99)
    run(Records(card(1), card(2)))
    first = printing_row(world["printing"])
    assert first["live_state"] == "eligible"
    with connect() as conn:
        second = str(conn.execute("SELECT id FROM catalog_printing WHERE source_id='meta-2'").fetchone()["id"])
    item = evidence("printings", second)
    clash = decide(item, "correct", {**LIVE_INPUTS, "set_code": "DAA", "collector_number": "1"})
    assert (clash.status_code, clash.json()["detail"]["code"]) == (409, "LIVE_CONFLICT")
    assert printing_row(world["printing"])["live_state"] == "eligible"  # the peer was not suspended: the transaction rolled back
    assert printing_row(second)["live_decision_id"] is None
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_metadata_decision").fetchone()["n"] == 0


def recorded_rule(decision_id):
    with connect() as conn:
        return conn.execute("""SELECT a.kind,a.version,d.rule_activation_id FROM catalog_metadata_decision d
          LEFT JOIN catalog_rule_activation a ON a.id=d.rule_activation_id WHERE d.id=%s""", (decision_id,)).fetchone()


def active_activation_id(kind):
    with connect() as conn:
        return conn.execute("SELECT activation_id FROM catalog_rule_state WHERE kind=%s", (kind,)).fetchone()["activation_id"]


def test_a_live_decision_records_the_active_live_rule_activation_and_history_shows_its_version(world):
    activate_as_owner(LIVE, 1)
    response = decide(evidence("printings", world["printing"]), "correct", LIVE_INPUTS)
    assert response.status_code == 200, response.text
    recorded = recorded_rule(response.json()["decision_id"])
    assert (recorded["kind"], recorded["version"]) == ("live_derivation", 1)
    assert recorded["rule_activation_id"] == active_activation_id(LIVE)
    row = request("GET", f"{ADMIN}/printings/{world['printing']}/history", OWNER).json()[0]
    assert (row["rule_kind"], row["rule_version"]) == ("live_derivation", 1)
    assert "rule_activation_id" not in row


def test_a_marketplace_decision_records_the_matching_activation_only_when_one_is_active(quarantined):
    item = next(i for i in queue()["items"] if i["edition_id"] == quarantined["normal"])
    with_rule = decide(item, "correct", {"product_id": 1234, "quote_variant": "normal"})
    assert with_rule.status_code == 200, with_rule.text
    recorded = recorded_rule(with_rule.json()["decision_id"])
    assert (recorded["kind"], recorded["version"]) == ("marketplace_matching", 1)
    assert recorded["rule_activation_id"] == active_activation_id(MATCHING)
    history = request("GET", f"{ADMIN}/editions/{quarantined['normal']}/history", OWNER).json()
    assert (history[0]["rule_kind"], history[0]["rule_version"]) == ("marketplace_matching", 1)
    with connect() as conn:
        conn.execute("UPDATE catalog_rule_state SET activation_id=NULL WHERE kind=%s", (MATCHING,))
    item = evidence("editions", quarantined["reverse"])
    without = decide(item, "correct", {"product_id": 4321, "quote_variant": "reverse-holo"})
    assert without.status_code == 200, without.text
    assert recorded_rule(without.json()["decision_id"])["rule_activation_id"] is None
    history = request("GET", f"{ADMIN}/editions/{quarantined['reverse']}/history", OWNER).json()
    assert (history[0]["rule_kind"], history[0]["rule_version"]) == (None, None)


# ------------------------------------------------------------------ rule activation


def test_rules_list_reviewed_versions_with_digests_and_the_active_activation(world):
    listed = request("GET", "/api/admin/catalog-rules", OWNER).json()
    by_kind = {row["kind"]: row for row in listed}
    assert set(by_kind) == {"live_derivation", "marketplace_matching"}
    assert by_kind["marketplace_matching"]["versions"][0]["version"] == 1 and by_kind["marketplace_matching"]["active"] is None
    assert {v["version"] for v in by_kind["live_derivation"]["versions"]} >= {1, 99}
    activate_as_owner(MATCHING, 1)
    rule = next(r for r in request("GET", "/api/admin/catalog-rules", OWNER).json() if r["kind"] == "marketplace_matching")
    active = rule["active"]
    assert (active["version"], active["digest_current"], active["reason"]) == (1, True, "Reviewed against the target")
    assert active["source"] == "owner" and active["release_commit"] is None
    assert rule["rollout"] is None and rule["problem"] is None
    assert [v["code_digest"] for v in active_versions(1)] == [code_digest_of(MATCHING, 1)]


def active_versions(version):
    rows = next(r for r in request("GET", "/api/admin/catalog-rules", OWNER).json() if r["kind"] == "marketplace_matching")["versions"]
    return [v for v in rows if v["version"] == version]


def code_digest_of(kind, version):
    from app.catalog_targets import code_digest
    return code_digest(kind, version)


# ------------------------------------------------------------------ no refresh route, no personal overrides


def test_openapi_has_no_refresh_or_force_route_and_no_report_or_decision_path_is_public():
    paths = app.openapi()["paths"]
    mine = [path for path in paths if path.startswith(("/api/admin/catalog-metadata", "/api/admin/catalog-rules", "/api/catalog/metadata-reports"))]
    assert len(mine) >= 8
    assert not [p for p in mine if p.endswith("/activate")]
    assert not [path for path in paths if any(word in path.lower() for word in ("refresh", "force", "retry"))]
    assert not [p for p in mine for method in paths[p] if method.lower() not in {"get", "post", "patch"}]
    reads = {(p, m) for p in mine for m in paths[p]}
    assert ("/api/admin/catalog-metadata/decisions", "post") in reads


def test_deck_and_holding_mutations_ignore_product_live_and_price_fields(world):
    with connect() as conn:
        leaf = conn.execute("INSERT INTO location(owner_id,name,kind,id) VALUES (%s,%s,'storage_leaf',%s) RETURNING id",
                            (REPORTER, f"Box {uuid4()}", uuid4())).fetchone()["id"]
    before = snapshot()
    overrides = {"product_id": 99, "quote_variant": "normal", "live_identity": {"set_code": "ZZZ"}, "live_state": "eligible",
                 "mapping_state": "verified", "price": "1.00", "market_price": 1, "mapping_revision": 9}
    added = request("POST", "/api/holdings", REPORTER, {"location_id": str(leaf), "edition_id": world["normal"], "quantity": "2",
                                                       "idempotency_key": str(uuid4()), **overrides})
    assert added.status_code == 200, added.text
    deck = request("POST", "/api/decks", REPORTER, {"name": f"Overrides {uuid4()}", "idempotency_key": str(uuid4()), **overrides})
    assert deck.status_code == 201, deck.text
    after = snapshot()
    assert after == before
    assert not any(key in json.dumps(added.json()) for key in ("product_id", "price"))


# ------------------------------------------------------------------ a refused decision costs the catalog nothing


def clock_revision():
    with connect() as conn:
        return conn.execute("SELECT revision FROM catalog_public_clock").fetchone()["revision"]


def test_a_refused_decision_never_takes_the_catalog_clock(world):
    item = evidence("editions", world["normal"])
    before = clock_revision()
    assert decide(item, "unmap", user=REPORTER).status_code == 403
    assert clock_revision() == before  # no bare clock bump, and no stamp on the target
    assert decide(item, "unmap").status_code == 200


# ------------------------------------------------------------------ a corrected price lookup must belong to the reviewed product


def test_a_correction_is_priced_only_when_the_source_variant_block_holds_the_reviewed_product(quarantined):
    item = evidence("editions", quarantined["normal"])
    # The source block for "normal" now holds product 999. Reviewing product 4321 must not publish a lookup
    # that would show product 999's prices next to product 4321.
    assert decide(item, "correct", {"product_id": 4321, "quote_variant": "normal"}).status_code == 200
    row = edition_row(quarantined["normal"])
    assert (row["mapping_state"], row["product_id"], row["quote_variant"]) == ("verified", 4321, None)
    with connect() as conn:
        decision = conn.execute("SELECT reviewed_value,checks FROM catalog_metadata_decision").fetchone()
        targets = edition_targets(conn, [row["edition_id"]])[row["edition_id"]]
    assert decision["reviewed_value"] == {"product_id": 4321, "quote_variant": None}
    assert decision["checks"] == {"printing": "passed", "product": "passed", "variant": "not_established"}
    assert targets.product_id == 4321 and targets.quote_lookup is None
    # A variant key the source block does not have is unpriced as well.
    other = evidence("editions", quarantined["reverse"])
    assert decide(other, "correct", {"product_id": 1001, "quote_variant": "holofoil"}).status_code == 200
    assert edition_row(quarantined["reverse"])["quote_variant"] is None


def test_a_correction_without_a_source_candidate_is_published_unpriced(world):
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET mapping_candidate='{}'::jsonb WHERE edition_id=%s", (world["normal"],))
    item = evidence("editions", world["normal"])
    assert decide(item, "correct", {"product_id": 5005, "quote_variant": "normal"}).status_code == 200
    assert edition_row(world["normal"])["quote_variant"] is None


def test_enrichment_after_a_maintainer_decision_neither_closes_nor_re_stamps_the_edition(quarantined):
    item = evidence("editions", quarantined["normal"])
    assert decide(item, "verify_source").status_code == 200
    settled = edition_row(quarantined["normal"])
    assert settled["accepted_projection"] is not None
    enriched = changed_card()
    enriched["variants_detailed"][0]["pricing"]["cardmarket"] = {"productId": 31337, "avg": 2.0}
    run(Records(enriched))
    after = edition_row(quarantined["normal"])
    assert (after["mapping_state"], after["mapping_revision"], after["public_revision"]) == (
        "verified", settled["mapping_revision"], settled["public_revision"])
    assert after["accepted_fingerprint"] != settled["accepted_fingerprint"]  # follows the new source state silently
    assert queue()["items"] == []


def test_the_maintainer_sees_report_contents_without_the_reporters_identity_and_the_digest_binds_them(quarantined):
    first = evidence("editions", quarantined["normal"])
    created = market_report(quarantined, note="Product 4321 is on the card sleeve", evidence_url="https://example.org/sleeve").json()
    shown = evidence("editions", quarantined["normal"])
    [summary] = shown["reports"]
    assert (summary["id"], summary["target"], summary["issue"], summary["status"]) == (created["id"], "marketplace", "incorrect", "pending")
    assert summary["proposed"] == {"product_id": 4321, "quote_variant": "normal"}
    assert summary["evidence_url"] == "https://example.org/sleeve" and summary["note"] == "Product 4321 is on the card sleeve"
    assert summary["created_at"] and shown["report_ids"] == [created["id"]]
    assert REPORTER not in json.dumps(shown) and "reporter" not in json.dumps(shown)
    assert next(item for item in queue()["items"] if item["edition_id"] == quarantined["normal"])["reports"] == shown["reports"]
    # Asking for information and the reporter's reply are visible and change the evidence the decision binds to.
    asked = request("POST", f"{ADMIN}/reports/{created['id']}/decision", OWNER, {"decision": "needs_info", "reason": "Which sleeve?"})
    assert asked.status_code == 200
    waiting = evidence("editions", quarantined["normal"])
    assert waiting["reports"][0]["status"] == "needs_info" and waiting["evidence_digest"] != shown["evidence_digest"]
    reply = request("PATCH", f"{REPORTS}/{created['id']}", REPORTER, {"note": "The Furret sleeve from the 2020 box", "evidence_url": "https://example.org/box"})
    assert reply.status_code == 200
    answered = evidence("editions", quarantined["normal"])
    assert answered["reports"][0]["note"] == "The Furret sleeve from the 2020 box" and answered["reports"][0]["evidence_url"] == "https://example.org/box"
    assert answered["evidence_digest"] not in (waiting["evidence_digest"], shown["evidence_digest"], first["evidence_digest"])
    stale = decide(waiting, "unmap")
    assert (stale.status_code, stale.json()["detail"]["code"]) == (409, "METADATA_EVIDENCE_CHANGED")


# ------------------------------------------------------------------ card-number matches (#347)

from app.catalog_targets import rematch_promos  # noqa: E402
from test_catalog_targets import listing, promo, tcgplayer_products  # noqa: E402,F401


@pytest.fixture
def number_matches(tcgplayer_products):
    """Two dpp Editions verified by card number and one svp Edition verified by its TCGdex id, under rule v4."""
    seed_users()
    listing(900, "Turtwig", "DP01", 1421)
    listing(901, "Chimchar - DP02", "DP02", 1421)
    run(Records(promo("dpp-1", "DP01", "dpp", "Turtwig"), promo("dpp-2", "DP02", "dpp", "Chimchar"),
                promo("svp-1", "1", "svp", "Pikachu", [{"type": "holo", "size": "standard", "thirdParty": {"tcgplayer": 477184}}]),
                promo("dpp-3", "DP03", "dpp", "Piplup")))  # dpp-3 has no TCGCSV product: stays unverified
    activate_as_owner(MATCHING, 4)


def matches(user=OWNER, **params):
    response = request("GET", f"{ADMIN}/queue", user, matched="card_number", **params)
    assert response.status_code == 200, response.text
    return response.json()


def source_edition(source_id):
    return metadata(source_id)[1]


def test_card_number_filter_lists_the_number_matched_editions_only_with_their_product_and_rule(number_matches):
    items = matches()["items"]
    assert sorted((item["name"], item["set_id"], item["collector_number"], item["matched_product"]["product_id"],
                   item["matched_product"]["name"], item["matched_product"]["group_id"], item["rule_version"], item["state"])
                  for item in items) == [("Chimchar", "dpp", "DP02", 901, "Chimchar - DP02", 1421, 4, "verified"),
                                         ("Turtwig", "dpp", "DP01", 900, "Turtwig", 1421, 4, "verified")]
    assert matches()["next_cursor"] is None
    plain = queue()["items"]  # the ordinary queue is unchanged and carries no match
    assert all(item["matched_product"] is None for item in plain)


def test_card_number_filter_pages_and_is_owner_only(number_matches, monkeypatch):
    monkeypatch.setattr(metadata_reviews, "QUEUE_PAGE", 1)
    first = matches()
    second = matches(cursor=first["next_cursor"])
    assert len(first["items"]) == len(second["items"]) == 1 and second["next_cursor"] is None
    assert first["items"][0]["edition_id"] != second["items"][0]["edition_id"]
    assert request("GET", f"{ADMIN}/queue", REPORTER, matched="card_number").status_code == 403
    assert request("GET", f"{ADMIN}/queue", OWNER, matched="other").status_code == 422


def test_rejecting_a_card_number_match_unverifies_it_and_neither_rebind_activation_nor_rematch_verifies_it_again(number_matches, price_store):
    with connect() as conn:
        conn.execute("""INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,seen_at,source_updated_at)
          VALUES (900,'Holofoil',3,now(),now())""")
    rebind_best_effort()  # setup only: the activation above verified the Edition; this binds and publishes it
    turtwig = next(item for item in matches()["items"] if item["name"] == "Turtwig")
    assert bindings_of(900) == 1 and price_records(price_store) == {turtwig["edition_id"]: "3"}
    response = decide(turtwig, "reject_source")
    assert response.status_code == 200, response.text
    assert (response.json()["state"], response.json()["reason"]) == ("unverified", "reviewed_unmapped")
    assert [item["name"] for item in matches()["items"]] == ["Chimchar"]
    price_binding.join_spawned_rebinds()  # the decision's own post-commit rebind and publish, with nothing run by hand
    assert bindings_of(900) == 0 and price_records(price_store) == {}
    with connect() as conn:
        assert rematch_promos(conn) == 0
    activate_as_owner(MATCHING, 3)
    activate_as_owner(MATCHING, 4)
    with connect() as conn:
        assert rematch_promos(conn) == 0
    row = edition_row(turtwig["edition_id"])
    assert (row["mapping_state"], row["mapping_reason"], row["product_id"]) == ("unverified", "reviewed_unmapped", None)
    assert [item["name"] for item in matches()["items"]] == ["Chimchar"]


def test_the_owner_status_counts_card_number_matches_and_collector_status_does_not(number_matches):
    status = request("GET", "/api/admin/catalog-runs", OWNER)
    assert status.status_code == 200 and status.json()["matched_by_number"] == 2
    assert request("GET", "/api/admin/catalog-runs", REPORTER).status_code == 403
    assert "matched_by_number" not in request("GET", "/api/catalog/status", REPORTER).text


# ------------------------------------------------------------------ the post-commit rebind and publish (#348, #351)


def price_records(store):
    """{edition id: stored amount} for every `price:` record in the store."""
    from app.public_records import price_key
    with connect() as conn:
        refs = {r["public_ref"]: str(r["id"]) for r in conn.execute("SELECT id, public_ref FROM catalog_edition")}
        registered = [r["edition_ref"] for r in conn.execute("SELECT edition_ref FROM public_price_ref")]
    keys = {ref: price_key(ref) for ref in set(refs) | set(registered)}
    records = store.read_all(list(keys.values()), deadline=time.monotonic() + 10).records if keys else {}
    return {refs[ref]: records[key].value["amount"] for ref, key in keys.items() if ref in refs and records[key].value}


def bindings_of(product_id):
    with connect() as conn:
        return conn.execute("SELECT count(*) AS n FROM edition_price_binding WHERE product_id=%s", (product_id,)).fetchone()["n"]


def stock_prices(*rows):
    with connect() as conn:
        conn.execute("TRUNCATE tcgplayer_price")
        for product_id, sub_type, market in rows:
            conn.execute("""INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,seen_at,source_updated_at)
              VALUES (%s,%s,%s,now(),now())""", (product_id, sub_type, market))


def all_bindings():
    with connect() as conn:
        return {str(r["edition_id"]): (r["sub_type_name"], r["reason"]) for r in conn.execute("SELECT * FROM edition_price_binding")}


def test_verifying_a_second_edition_onto_a_bound_product_leaves_neither_bound_nor_published(world, price_store):
    with connect() as conn:  # a holo Edition of the same Printing; with one "Normal" row it takes the same product subtype
        holo = str(conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          VALUES (%s,'holo-extra','{"type":"holo"}') RETURNING id""", (world["printing"],)).fetchone()["id"])
    stock_prices((1001, "Normal", 2))
    first = decide(evidence("editions", world["normal"]), "verify_source")
    assert first.status_code == 200, first.text
    price_binding.join_spawned_rebinds()
    assert all_bindings() == {world["normal"]: ("Normal", None)}
    assert price_records(price_store) == {world["normal"]: "2"}
    second = decide(evidence("editions", holo), "correct", {"product_id": 1001, "quote_variant": None})
    assert second.status_code == 200, second.text
    price_binding.join_spawned_rebinds()
    assert all_bindings() == {world["normal"]: (None, "shared_price"), holo: (None, "shared_price")}
    assert price_records(price_store) == {}


def test_a_decision_returns_before_a_busy_price_lock_frees(world, price_store):
    stock_prices((1001, "Normal", 2))
    with connect() as holder:
        holder.execute("SELECT pg_advisory_lock(%s)", (price_binding.PRICE_LOCK,))
        try:
            response = decide(evidence("editions", world["normal"]), "verify_source")
            assert response.status_code == 200, response.text  # the route did not wait for the rebind
            assert all_bindings() == {}
        finally:
            holder.execute("SELECT pg_advisory_unlock(%s)", (price_binding.PRICE_LOCK,))
    price_binding.join_spawned_rebinds()
    assert all_bindings() == {world["normal"]: ("Normal", None)}


def test_applying_the_newest_matching_rule_binds_and_publishes_the_newly_verified_editions(world, price_store, monkeypatch):
    for version in [v for v in MATCHING_RULES if v > 1]:
        monkeypatch.delitem(MATCHING_RULES, version)  # version 1 is the newest this test's release knows
    monkeypatch.setenv("RELEASE_COMMIT", uuid4().hex + "0" * 8)
    stock_prices((1001, "Normal", 2), (1001, "Reverse Holofoil", 5))
    assert all_bindings() == {}
    assert rule_rollout.apply_newest_rules()[MATCHING] == "applied"  # deliver runs synchronously: no join needed
    assert all_bindings() == {world["normal"]: ("Normal", None), world["reverse"]: ("Reverse Holofoil", None)}
    assert price_records(price_store) == {world["normal"]: "2", world["reverse"]: "5"}


# ------------------------------------------------------------------ rules are read-only (ADR 0021)


def rule_view(kind):
    return next(r for r in request("GET", "/api/admin/catalog-rules", OWNER).json() if r["kind"] == kind)


def insert_activation(kind, version, digest, **columns):
    """Insert an activation row directly and make it current; returns its id."""
    with connect() as conn, conn.transaction():
        revision = conn.execute("SELECT catalog_begin_correction() AS r").fetchone()["r"]
        names = ",".join(columns)
        marks = ",".join(["%s"] * len(columns))
        activation = conn.execute(f"""INSERT INTO catalog_rule_activation(kind,version,code_digest,reviewer_id,evidence_url,reason,
          clock_revision{',' + names if names else ''}) VALUES (%s,%s,%s,%s,'https://example.org/c','Test row',%s{',' + marks if marks else ''})
          RETURNING id""", (kind, version, digest, OWNER, revision, *columns.values())).fetchone()["id"]
        conn.execute("UPDATE catalog_rule_state SET activation_id=%s WHERE kind=%s", (activation, kind))
    return activation


def test_the_activation_route_is_gone(world):
    body = {"version": 1, "evidence_url": "https://example.org/rule", "reason": "x"}
    for kind in ("live_derivation", "marketplace_matching"):
        assert request("POST", f"/api/admin/catalog-rules/{kind}/activate", OWNER, body).status_code in (404, 405)
    assert rule_view("marketplace_matching")["active"] is None


def test_the_rules_view_shows_the_deploy_and_its_rollout(world):
    commit = uuid4().hex + "0" * 8
    version = max(MATCHING_RULES)
    activation = insert_activation(MATCHING, version, code_digest(MATCHING, version), source="deploy", release_commit=commit)
    with connect() as conn:
        conn.execute("INSERT INTO catalog_rule_rollout(activation_id,phase,total,done,changed) VALUES (%s,'editions',5,2,1)", (activation,))
    try:
        rule = rule_view(MATCHING)
    finally:
        with connect() as conn:
            conn.execute("UPDATE catalog_rule_state SET activation_id=NULL")
            conn.execute("DELETE FROM catalog_rule_rollout")
    assert (rule["active"]["source"], rule["active"]["release_commit"], rule["active"]["version"]) == ("deploy", commit, version)
    assert (rule["rollout"]["phase"], rule["rollout"]["total"], rule["rollout"]["done"], rule["rollout"]["changed"]) == ("editions", 5, 2, 1)
    assert rule["rollout"]["finished_at"] is None and rule["rollout"]["error"] is None and rule["problem"] is None


def test_the_rules_view_reports_a_digest_mismatch_and_a_newer_version(world):
    version = max(MATCHING_RULES)
    insert_activation(MATCHING, version, "0" * 64)
    rule = rule_view(MATCHING)
    assert (rule["problem"], rule["active"]["digest_current"]) == ("digest_mismatch", False)
    insert_activation(MATCHING, version + 1, "1" * 64)
    rule = rule_view(MATCHING)
    assert (rule["problem"], rule["active"]["version"]) == ("newer_than_code", version + 1)
