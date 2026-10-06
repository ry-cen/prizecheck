from test_catalog import claim_current
import hashlib
import hmac
import json
import os
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import app, connect
from app.catalog import claim_run, execute_run
from app.catalog_search import _encode_cursor
from test_catalog import Source

client = TestClient(app)
OWNER = "review-owner"
REPORTER = "review-reporter"
OTHER = "review-other"


def request(method, path, user, body=None, **params):
    raw = json.dumps(body, separators=(",", ":")).encode() if body is not None else b""
    stamp = str(int(time.time()))
    message = f"{method}\n{path}\n{hashlib.sha256(raw).hexdigest()}\n{user}\n{stamp}".encode()
    headers = {"x-internal-user": user, "x-internal-time": stamp, "content-type": "application/json",
               "x-internal-signature": hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), message, hashlib.sha256).hexdigest()}
    return client.request(method, path, content=raw if body is not None else None, headers=headers, params=params)


@pytest.fixture(autouse=True)
def seeded_catalog():
    with connect() as conn:
        conn.execute("UPDATE catalog_state SET active_generation=NULL")
        conn.execute("TRUNCATE catalog_approval_code,catalog_override,missing_card_report,catalog_review,catalog_generation_edition,catalog_generation_printing,catalog_edition,catalog_printing,catalog_identity,catalog_generation,catalog_run CASCADE")
        conn.execute("INSERT INTO catalog_state(singleton,active_generation,revision,last_success) VALUES (true,NULL,0,NULL) ON CONFLICT(singleton) DO UPDATE SET active_generation=NULL,revision=0,last_success=NULL")
        conn.execute("DELETE FROM owner_binding")
        for user in (OWNER, REPORTER, OTHER):
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user,))
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (OWNER,))
        generation = uuid4()
        conn.execute("INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,1,%s,'test')", (generation, b"raw"))
        conn.execute("UPDATE catalog_state SET active_generation=%s,revision=1,last_success=now()", (generation,))
        identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES ('Pikachu','Pikachu') RETURNING id").fetchone()["id"]
        printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex','fixture-1',%s) RETURNING id", (identity,)).fetchone()["id"]
        conn.execute("""INSERT INTO catalog_generation_printing
          (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,source_fingerprint,basic_energy)
          VALUES (%s,%s,'fixture-1','base','Base Set','1','Pikachu','pikachu','hash','not_basic')""", (generation, printing))
        edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,%s,%s) RETURNING id",
                               (printing, json.dumps({"finish": "normal"}, sort_keys=True), json.dumps({"finish": "normal"}))).fetchone()["id"]
        conn.execute("INSERT INTO catalog_generation_edition(generation_id,printing_id,edition_id) VALUES (%s,%s,%s)", (generation, printing, edition))
    yield printing


def report(body, user=REPORTER):
    return request("POST", "/api/missing-card-reports", user, body)


def printing_report():
    response = report({"kind": "printing", "set_id": "jungle", "set_name": "Jungle", "collector_number": "99",
                       "english_name": "Pikachu", "evidence_url": "https://example.org/evidence", "note": "Card in hand"})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def issue_code(report_id, action="approve_printing", code="123456", expires=False):
    digest = hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), f"{OWNER}:{report_id}:{action}:{code}".encode(), hashlib.sha256).hexdigest()
    with connect() as conn:
        conn.execute("""INSERT INTO catalog_approval_code(owner_id,report_id,action,code_hash,expires_at)
          VALUES (%s,%s,%s,%s,now()+interval '5 minutes')""", (OWNER, report_id, action, digest))
        if expires:
            conn.execute("UPDATE catalog_approval_code SET expires_at=now()-interval '1 second' WHERE report_id=%s", (report_id,))


def approve(report_id, **fields):
    return request("POST", f"/api/admin/missing-card-reports/{report_id}/decision", OWNER,
                   {"decision": "approve", "reason": "Verified against physical card", "code": "123456", **fields})


def test_private_reports_and_owner_review(seeded_catalog):
    report_id = printing_report()
    assert [row["id"] for row in request("GET", "/api/missing-card-reports", REPORTER).json()] == [report_id]
    assert request("GET", "/api/missing-card-reports", OTHER).json() == []
    assert request("GET", f"/api/missing-card-reports/{report_id}", OTHER).status_code == 404
    assert request("GET", "/api/admin/missing-card-reports", REPORTER).status_code == 403
    assert len(request("GET", "/api/catalog/search", OTHER, name="Pikachu").json()["printings"]) == 1
    assert len(request("GET", "/api/admin/missing-card-reports", OWNER).json()) == 1
    decision = request("POST", f"/api/admin/missing-card-reports/{report_id}/decision", OWNER,
                       {"decision": "needs_info", "reason": "Need a clearer set symbol."})
    assert decision.status_code == 200 and decision.json()["status"] == "needs_info"
    assert request("GET", f"/api/missing-card-reports/{report_id}", REPORTER).json()["review_reason"] == "Need a clearer set symbol."
    assert request("PATCH", f"/api/missing-card-reports/{report_id}", OTHER, {"note": "forged"}).status_code == 404
    updated = request("PATCH", f"/api/missing-card-reports/{report_id}", REPORTER, {"note": "Photo now includes the set symbol."})
    assert updated.status_code == 200 and updated.json()["status"] == "pending"


def test_incomplete_duplicate_ambiguous_and_code_expiry(seeded_catalog):
    report_id = report({"kind": "printing", "english_name": "Pikachu"}).json()["id"]
    issue_code(report_id)
    assert approve(report_id).json()["detail"]["code"] == "EVIDENCE_REQUIRED"
    assert approve(report_id, evidence_url="https://example.org/evidence").json()["detail"]["code"] == "INCOMPLETE_PRINTING"
    assert approve(report_id, set_id="base", set_name="Base Set", collector_number="1", evidence_url="https://example.org/evidence").json()["detail"]["code"] == "POSSIBLE_DUPLICATE"
    assert approve(report_id, set_id="base", set_name="Different Set", collector_number="99", evidence_url="https://example.org/evidence").json()["detail"]["code"] == "AMBIGUOUS_SET"
    with connect() as conn:
        assert conn.execute("SELECT consumed_at FROM catalog_approval_code WHERE report_id=%s", (report_id,)).fetchone()["consumed_at"] is None
    report2 = printing_report()
    issue_code(report2, expires=True)
    assert approve(report2).json()["detail"]["code"] == "INVALID_APPROVAL_CODE"
    edition_id = report({"kind": "edition", "printing_id": str(seeded_catalog),
                         "evidence_url": "https://example.org/foil"}).json()["id"]
    issue_code(edition_id, "approve_edition")
    assert approve(edition_id).json()["detail"]["code"] == "DISTINCT_VARIANT_REQUIRED"
    blank = approve(edition_id, descriptor={"label": "   "})
    assert blank.status_code == 422 and blank.json()["detail"]["code"] == "INVALID_DESCRIPTOR"


def test_approval_search_cursor_replay_and_rollback(seeded_catalog):
    old = request("GET", "/api/catalog/search", REPORTER, name="Pikachu").json()["revision"]
    cursor = _encode_cursor(("pikachu", "", ""), old, {"search_name": "pikachu", "set_id": "base",
                                                      "collector_number": "1", "id": seeded_catalog})
    report_id = printing_report()
    issue_code(report_id)
    wrong = request("POST", f"/api/admin/missing-card-reports/{report_id}/decision", OWNER,
                    {"decision": "approve", "reason": "Verified", "code": "000000"})
    assert wrong.status_code == 403
    with connect() as conn:
        assert conn.execute("SELECT attempts FROM catalog_approval_code WHERE report_id=%s", (report_id,)).fetchone()["attempts"] == 1
    approved = approve(report_id)
    assert approved.status_code == 200, approved.text
    approved_id = approved.json()["approved_printing_id"]
    found = request("GET", "/api/catalog/search", OTHER, name="Pikachu").json()
    assert found["revision"] == old + 1
    changed = request("GET", "/api/catalog/search", OTHER, name="Pikachu", cursor=cursor)
    assert changed.status_code == 409 and changed.json()["detail"]["code"] == "CATALOG_CHANGED"
    assert any(row["id"] == approved_id and row["source"] == "manual" and row["source_id"] is None and
               row["evidence_url"] == "https://example.org/evidence" for row in found["printings"])
    assert approve(report_id).json()["detail"]["code"] == "ALREADY_REVIEWED"
    with connect() as conn:
        assert conn.execute("SELECT consumed_at FROM catalog_approval_code WHERE report_id=%s", (report_id,)).fetchone()["consumed_at"] is not None
        row = conn.execute("SELECT reviewer_id,reason,evidence_url,revision FROM catalog_override WHERE report_id=%s", (report_id,)).fetchone()
        assert row["reviewer_id"] == OWNER and row["revision"] == old + 1 and row["evidence_url"]
    pending = report({"kind": "printing", "set_id": "jungle", "set_name": "Jungle", "collector_number": "100",
                      "english_name": "Pikachu", "evidence_url": "https://example.org/second"}).json()["id"]
    issue_code(pending)
    with connect() as conn:
        conn.execute("""CREATE OR REPLACE FUNCTION reject_test_override() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test rollback'; END; $$""")
        conn.execute("CREATE TRIGGER reject_test_override BEFORE INSERT ON catalog_override FOR EACH ROW EXECUTE FUNCTION reject_test_override()")
    try:
        with pytest.raises(Exception):
            approve(pending)
        with connect() as conn:
            assert conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"] == old + 1
            assert conn.execute("SELECT consumed_at FROM catalog_approval_code WHERE report_id=%s", (pending,)).fetchone()["consumed_at"] is None
            assert conn.execute("SELECT status FROM missing_card_report WHERE id=%s", (pending,)).fetchone()["status"] == "pending"
    finally:
        with connect() as conn:
            conn.execute("DROP TRIGGER reject_test_override ON catalog_override")
            conn.execute("DROP FUNCTION reject_test_override()")


def test_next_pull_preserves_manual_printing_and_edition(seeded_catalog):
    report_id = printing_report()
    issue_code(report_id)
    manual_id = approve(report_id).json()["approved_printing_id"]
    edition_report = report({"kind": "edition", "printing_id": str(seeded_catalog),
                             "descriptor": {"finish": "cosmos foil"},
                             "evidence_url": "https://example.org/foil"}).json()["id"]
    issue_code(edition_report, "approve_edition")
    edition = approve(edition_report)
    assert edition.status_code == 200, edition.text
    edition_id = edition.json()["approved_edition_id"]
    detail = request("GET", f"/api/catalog/printings/{seeded_catalog}", REPORTER).json()["printing"]
    manual_variant = next(item for item in detail["editions"] if item["id"] == edition_id)
    assert detail["source"] == "tcgdex"
    assert manual_variant["source"] == "manual"
    assert manual_variant["evidence_url"] == "https://example.org/foil"
    with connect() as conn:
        conn.execute("INSERT INTO catalog_run DEFAULT VALUES")
        execute_run(conn, claim_current(conn), Source(ids=("fixture-1",)))
        generation = conn.execute("SELECT active_generation FROM catalog_state").fetchone()["active_generation"]
        manual = conn.execute("SELECT tombstoned FROM catalog_generation_printing WHERE generation_id=%s AND printing_id=%s", (generation, manual_id)).fetchone()
        manual_edition = conn.execute("SELECT active FROM catalog_generation_edition WHERE generation_id=%s AND edition_id=%s", (generation, edition_id)).fetchone()
    assert manual == {"tombstoned": False}
    assert manual_edition == {"active": True}
