"""Collector metadata reports and maintainer decisions over signed HTTP against PostgreSQL."""
import hashlib
import hmac
import json
import os
import threading
import time
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.main import app, connect
from app import metadata_reviews, public_catalog
from app.catalog_targets import LIVE, MATCHING, activate_rule, edition_targets, fingerprint, printing_live
from test_catalog import reset_catalog
from test_catalog_metadata import Records, furret
from test_catalog_reconciliation import run
from test_catalog_targets import activate, card, isolated_rules, metadata  # noqa: F401 (fixture re-export)

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


def code_for(target, action, code="123456", user=OWNER):
    digest = hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), f"{user}:{target}:{action}:{code}".encode(), hashlib.sha256).hexdigest()
    with connect() as conn:
        conn.execute("""INSERT INTO catalog_approval_code(owner_id,metadata_target,action,code_hash,expires_at)
          VALUES (%s,%s,%s,%s,now()+interval '5 minutes')""", (user, target, action, digest))


@pytest.fixture(autouse=True)
def published(monkeypatch):
    """Record post-commit publication; delivery itself is the outbox's concern, not this module's."""
    calls = []
    monkeypatch.setattr(public_catalog, "publish_catalog_best_effort", lambda *a, **k: calls.append((a, k)) or True)
    return calls


def seed_users():
    reset_catalog()
    with connect() as conn:
        conn.execute("DELETE FROM catalog_approval_code")
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


def decide(item, decision, reviewed_value=None, *, issue=True, user=OWNER, **over):
    if issue:
        code_for(target_of(item), "resolve_metadata")
    body = {"target": item["target"], "printing_id": item["printing_id"], "edition_id": item["edition_id"], "decision": decision,
            "basis_revision": item["basis_revision"], "evidence_digest": item["evidence_digest"],
            "evidence_url": "https://example.org/evidence", "reason": "Checked the physical card", "report_ids": [],
            "code": "123456", **({"reviewed_value": reviewed_value} if reviewed_value is not None else {})}
    return request("POST", f"{ADMIN}/decisions", user, {**body, **over})


def edition_row(edition_id):
    with connect() as conn:
        return conn.execute("SELECT * FROM catalog_edition_metadata WHERE edition_id=%s", (edition_id,)).fetchone()


def code_row(target):
    with connect() as conn:
        return conn.execute("SELECT * FROM catalog_approval_code WHERE metadata_target=%s ORDER BY created_at DESC", (target,)).fetchone()


def test_correction_verifies_a_quarantined_edition_with_provenance_and_without_catalog_side_effects(quarantined, published):
    item = evidence("editions", quarantined["normal"])
    before = snapshot()
    before_row = edition_row(quarantined["normal"])
    response = decide(item, "correct", {"product_id": 4321, "quote_variant": "normal"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["state"], body["reason"], body["decision"]) == ("verified", None, "correct")
    after = edition_row(quarantined["normal"])
    assert (after["mapping_state"], after["product_id"], after["quote_variant"], after["mapping_basis"], after["auto_closed"]) == (
        "verified", 4321, "normal", "maintainer", True)
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
    assert decision["clock_revision"] == after["public_revision"] and decision["reviewed_value"] == {"product_id": 4321, "quote_variant": "normal"}
    assert [(r["source_fingerprint"], r["decision_id"]) for r in rejections] == [(item["source_fingerprint"], decision["id"])]
    assert [(o["target_kind"], str(o["target_id"])) for o in outbox] == [("edition", quarantined["normal"])]
    assert targets.product_id == 4321 and targets.price_lookup["variant"] == "normal"
    assert len(published) == 1
    assert code_row(target_of(item))["consumed_at"] is not None
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


def test_invalid_decisions_are_422_and_leave_the_code_unspent(world):
    item = evidence("editions", world["normal"])
    code_for(target_of(item), "resolve_metadata")
    cases = [("correct", None, "INVALID_PRODUCT"), ("correct", {"product_id": 0, "quote_variant": None}, "INVALID_PRODUCT"),
             ("correct", {"product_id": 5, "quote_variant": "Bad Variant"}, "INVALID_PRODUCT"),
             ("correct", {"product_id": 2**31, "quote_variant": None}, "INVALID_PRODUCT"),
             ("unsupported", None, "INVALID_DECISION")]
    for decision, value, code in cases:
        response = decide(item, decision, value, issue=False)
        assert (response.status_code, response.json()["detail"]["code"]) == (422, code), (decision, value)
    value = {"product_id": 5, "quote_variant": None}
    assert decide(item, "correct", value, issue=False, edition_id=None).status_code == 422
    assert decide(item, "correct", value, issue=False, reason=" ").status_code == 422
    assert code_row(target_of(item))["consumed_at"] is None and edition_row(world["normal"])["mapping_state"] == "unverified"
    assert decide(item, "correct", value, issue=False).status_code == 200  # the same code still works


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
    # A sibling Edition may share the product but not the exact (product, variant) slot.
    clash = decide(evidence("editions", world["normal"]), "correct", {"product_id": 1001, "quote_variant": "reverse-holofoil"})
    assert (clash.status_code, clash.json()["detail"]["code"]) == (409, "MAPPING_CONFLICT")
    assert decide(evidence("editions", world["normal"]), "correct", {"product_id": 1001, "quote_variant": None}).status_code == 200


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


def test_stale_evidence_is_a_conflict_that_keeps_the_code_usable(quarantined):
    shown = evidence("editions", quarantined["normal"])
    code_for(target_of(shown), "resolve_metadata")
    run(Records(changed_card(product=777)))  # a newer source value arrives while the maintainer reads
    stale = decide(shown, "reject_source", issue=False)
    assert (stale.status_code, stale.json()["detail"]["code"]) == (409, "METADATA_EVIDENCE_CHANGED")
    assert code_row(target_of(shown))["consumed_at"] is None
    assert edition_row(quarantined["normal"])["mapping_state"] == "quarantined"
    fresh = evidence("editions", quarantined["normal"])
    assert decide(fresh, "reject_source", issue=False).status_code == 200  # the same code, now with fresh evidence
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


def test_codes_are_exact_target_action_and_single_use(world):
    item = evidence("editions", world["normal"])
    target = target_of(item)
    missing = decide(item, "unmap", issue=False, code=None)
    assert (missing.status_code, missing.json()["detail"]["code"]) == (422, "FRESH_CODE_REQUIRED")
    none_issued = decide(item, "unmap", issue=False)
    assert (none_issued.status_code, none_issued.json()["detail"]["code"]) == (403, "INVALID_APPROVAL_CODE")
    # A code for a report, another target form, another Edition, or another action cannot be spent here.
    with connect() as conn:
        pending = conn.execute("""INSERT INTO missing_card_report(reporter_id,kind,printing_id) VALUES (%s,'edition',%s) RETURNING id""",
                               (REPORTER, world["printing"])).fetchone()["id"]
        digest = hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), f"{OWNER}:{pending}:resolve_metadata:123456".encode(), hashlib.sha256).hexdigest()
        conn.execute("""INSERT INTO catalog_approval_code(owner_id,report_id,action,code_hash,expires_at)
          VALUES (%s,%s,'resolve_metadata',%s,now()+interval '5 minutes')""", (OWNER, pending, digest))
    code_for(f"printing:{world['printing']}", "resolve_metadata")
    code_for(f"edition:{world['reverse']}", "resolve_metadata")
    code_for(target, "activate_rule")
    assert decide(item, "unmap", issue=False).status_code == 403
    # Three wrong guesses exhaust the real code.
    code_for(target, "resolve_metadata")
    for _ in range(3):
        assert decide(item, "unmap", issue=False, code="000000").status_code == 403
    assert code_row(target)["attempts"] == 3
    assert decide(item, "unmap", issue=False).status_code == 403
    assert edition_row(world["normal"])["mapping_state"] == "unverified" and edition_row(world["normal"])["mapping_reason"] == "no_matching_rule"
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_metadata_decision").fetchone()["n"] == 0
    # A fresh code works once, then is spent.
    fresh = evidence("editions", world["normal"])
    assert decide(fresh, "unmap").status_code == 200
    again = evidence("editions", world["normal"])
    assert decide(again, "unmap", issue=False).status_code == 403


def test_an_expired_code_is_refused(world):
    item = evidence("editions", world["normal"])
    code_for(target_of(item), "resolve_metadata")
    with connect() as conn:
        conn.execute("UPDATE catalog_approval_code SET expires_at=now()-interval '1 second' WHERE metadata_target=%s", (target_of(item),))
    assert decide(item, "unmap", issue=False).status_code == 403


def test_only_the_owner_decides_and_a_collector_gets_nothing_from_the_admin_surface(world):
    item = evidence("editions", world["normal"])
    code_for(target_of(item), "resolve_metadata", user=REPORTER)
    assert decide(item, "unmap", user=REPORTER).status_code == 403
    assert request("GET", f"{ADMIN}/editions/{world['normal']}", REPORTER).status_code == 403
    assert request("GET", "/api/admin/catalog-rules", REPORTER).status_code == 403
    assert request("POST", "/api/admin/catalog-rules/live_derivation/activate", REPORTER,
                   {"version": 1, "evidence_url": "https://example.org/r", "reason": "x", "code": "123456"}).status_code == 403
    assert edition_row(world["normal"])["mapping_reason"] == "no_matching_rule"


def test_a_busy_catalog_clock_is_a_409_rather_than_a_hang(world, monkeypatch):
    item = evidence("editions", world["normal"])
    code_for(target_of(item), "resolve_metadata")
    monkeypatch.setattr(metadata_reviews, "LOCK_TIMEOUT", "300ms")
    holder = connect()
    try:
        holder.execute("UPDATE catalog_public_clock SET revision=revision")  # an import promotion holds the clock
        started = time.monotonic()
        response = decide(item, "unmap", issue=False)
        assert (response.status_code, response.json()["detail"]["code"]) == (409, "CATALOG_BUSY")
        assert time.monotonic() - started < 3
    finally:
        holder.rollback()
        holder.close()
    assert code_row(target_of(item))["consumed_at"] is None
    assert decide(item, "unmap", issue=False).status_code == 200


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
