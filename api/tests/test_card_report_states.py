"""Characterize each Card Report's existing transitions and refusal behavior."""
import psycopg
import pytest

from app.main import connect
import test_attribute_corrections as attributes
import test_metadata_reviews as metadata
import test_missing_cards as missing


# Reuse the existing fixtures, with their autouse scope limited to the flow under test.
missing_catalog = pytest.fixture(name="missing_catalog")(missing.seeded_catalog.__wrapped__)
metadata_rules = pytest.fixture(name="metadata_rules")(metadata.isolated_rules.__wrapped__)
metadata_published = pytest.fixture(name="metadata_published")(metadata.published.__wrapped__)
metadata_spawned = pytest.fixture(name="metadata_spawned")(metadata.spawned.__wrapped__)
metadata_prices = pytest.fixture(name="metadata_prices")(metadata.price_store.__wrapped__)


@pytest.fixture
def metadata_world(metadata_rules, metadata_published, metadata_spawned, metadata_prices):
    return metadata.world.__wrapped__()


def missing_row(report_id):
    with connect() as conn:
        return conn.execute("SELECT * FROM missing_card_report WHERE id=%s", (report_id,)).fetchone()


def missing_decide(report_id, decision, reason="Checked the card"):
    return missing.request("POST", f"/api/admin/missing-card-reports/{report_id}/decision", missing.OWNER,
                           {"decision": decision, "reason": reason})


def test_missing_card_request_information_and_reply_preserve_reviewer_fields(missing_catalog):
    report_id = missing.printing_report()
    initial = missing_row(report_id)
    assert initial["status"] == "pending"
    assert initial["reviewer_id"] is None and initial["reviewed_at"] is None
    asked = missing_decide(report_id, "needs_info", "  Cafe\u0301  photo  ")
    assert (asked.status_code, asked.json()["status"], asked.json()["review_reason"]) == (200, "needs_info", "Café photo")
    reviewed = missing_row(report_id)
    assert reviewed["reviewer_id"] == missing.OWNER and reviewed["reviewed_at"] is not None
    answered = missing.request("PATCH", f"/api/missing-card-reports/{report_id}", missing.REPORTER,
                               {"note": "  Photo attached  "})
    assert (answered.status_code, answered.json()["status"], answered.json()["note"]) == (200, "pending", "Photo attached")
    replied = missing_row(report_id)
    for field in ("reviewer_id", "reviewed_at", "review_reason", "evidence_url"):
        assert replied[field] == reviewed[field]


def test_missing_card_request_information_can_be_repeated_while_open(missing_catalog):
    report_id = missing.printing_report()
    for _ in range(2):
        response = missing_decide(report_id, "needs_info")
        assert (response.status_code, response.json()["status"]) == (200, "needs_info")
        assert missing_row(report_id)["reviewer_id"] == missing.OWNER


@pytest.mark.parametrize("status", ("pending", "rejected", "approved"))
def test_missing_card_reply_outside_needs_info_is_a_plain_404_and_changes_nothing(missing_catalog, status):
    report_id = missing.printing_report()
    if status == "approved":
        assert missing.approve(report_id).status_code == 200
    elif status == "rejected":
        rejected = missing_decide(report_id, "reject")
        assert (rejected.status_code, rejected.json()["status"]) == (200, "rejected")
    before = missing_row(report_id)
    assert before["status"] == status
    reply = missing.request("PATCH", f"/api/missing-card-reports/{report_id}", missing.REPORTER, {"note": "Unsolicited reply"})
    assert (reply.status_code, reply.json()) == (404, {"detail": "Report not found"})
    assert missing_row(report_id) == before


@pytest.mark.parametrize("status", ("rejected", "approved"))
@pytest.mark.parametrize("decision", ("reject", "needs_info", "approve"))
def test_missing_card_closed_report_refuses_every_repeated_decision(missing_catalog, status, decision):
    report_id = missing.printing_report()
    closed = missing.approve(report_id) if status == "approved" else missing_decide(report_id, "reject")
    assert (closed.status_code, closed.json()["status"]) == (200, status)
    before = missing_row(report_id)
    with connect() as conn:
        revision = conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"]
    repeated = missing_decide(report_id, decision)
    assert (repeated.status_code, repeated.json()) == (409, {"detail": {
        "code": "ALREADY_REVIEWED", "message": "Report is already closed."}})
    assert missing_row(report_id) == before
    with connect() as conn:
        assert conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"] == revision
        assert conn.execute("SELECT count(*) AS n FROM catalog_override WHERE report_id=%s", (report_id,)).fetchone()["n"] == (
            1 if status == "approved" else 0)


@pytest.mark.parametrize("decision,reason,code", (("unknown", "Checked", None), ("reject", " \t ", "REASON_REQUIRED")))
def test_missing_card_invalid_decision_changes_nothing(missing_catalog, decision, reason, code):
    report_id = missing.printing_report()
    before = missing_row(report_id)
    refused = missing_decide(report_id, decision, reason)
    assert refused.status_code == 422
    if code:
        assert refused.json()["detail"]["code"] == code
    else:
        assert refused.json()["detail"][0]["loc"] == ["body", "decision"]
    assert missing_row(report_id) == before


@pytest.mark.parametrize("status", ("pending", "needs_info"))
def test_missing_card_failed_approval_rolls_back_to_the_prior_report(missing_catalog, status):
    report_id = missing.printing_report()
    if status == "needs_info":
        assert missing_decide(report_id, "needs_info").status_code == 200
    before = missing_row(report_id)
    assert before["status"] == status
    with connect() as conn:
        revision = conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"]
        counts = conn.execute("""SELECT (SELECT count(*) FROM catalog_printing) AS printings,
          (SELECT count(*) FROM catalog_edition) AS editions""").fetchone()
        # The existing missing-card tests force a failure after the catalog writes with this trigger.
        conn.execute("""CREATE FUNCTION reject_state_test_override() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'state test rollback'; END; $$""")
        conn.execute("""CREATE TRIGGER reject_state_test_override BEFORE INSERT ON catalog_override
          FOR EACH ROW EXECUTE FUNCTION reject_state_test_override()""")
    try:
        with pytest.raises(psycopg.errors.RaiseException, match="state test rollback"):
            missing.approve(report_id)
        assert missing_row(report_id) == before
        with connect() as conn:
            assert conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"] == revision
            assert conn.execute("""SELECT (SELECT count(*) FROM catalog_printing) AS printings,
              (SELECT count(*) FROM catalog_edition) AS editions""").fetchone() == counts
            assert conn.execute("SELECT count(*) AS n FROM catalog_override WHERE report_id=%s", (report_id,)).fetchone()["n"] == 0
    finally:
        with connect() as conn:
            conn.execute("DROP TRIGGER reject_state_test_override ON catalog_override")
            conn.execute("DROP FUNCTION reject_state_test_override()")


@pytest.mark.parametrize("status", ("pending", "rejected", "approved", "superseded"))
def test_metadata_report_replies_and_repeated_closed_decisions_change_nothing(metadata_world, status):
    report_id = metadata.market_report(metadata_world).json()["id"]
    if status == "rejected":
        response = metadata.request("POST", f"{metadata.ADMIN}/reports/{report_id}/decision", metadata.OWNER,
                                    {"decision": "reject", "reason": "Checked"})
        assert response.status_code == 200, response.text
    elif status == "approved":
        shown = metadata.evidence("editions", metadata_world["normal"])
        response = metadata.decide(shown, "correct", {"product_id": 4321, "quote_variant": "normal"}, report_ids=[report_id])
        assert response.status_code == 200, response.text
        metadata.price_binding.join_spawned_rebinds()
    elif status == "superseded":
        # Migration 023 permits this unused value; it remains closed to the Python routes.
        with connect() as conn:
            conn.execute("UPDATE catalog_metadata_report SET status='superseded' WHERE id=%s", (report_id,))
    with connect() as conn:
        before = conn.execute("SELECT * FROM catalog_metadata_report WHERE id=%s", (report_id,)).fetchone()
    assert before["status"] == status
    unchanged = metadata.snapshot()
    reply = metadata.request("PATCH", f"{metadata.REPORTS}/{report_id}", metadata.REPORTER, {"note": "Not requested"})
    assert (reply.status_code, reply.json()["detail"]["code"]) == (404, "REPORT_NOT_FOUND")
    if status != "pending":
        for decision in ("reject", "needs_info"):
            repeated = metadata.request("POST", f"{metadata.ADMIN}/reports/{report_id}/decision", metadata.OWNER,
                                        {"decision": decision, "reason": "Again"})
            assert (repeated.status_code, repeated.json()["detail"]["code"]) == (409, "ALREADY_REVIEWED")
    with connect() as conn:
        assert conn.execute("SELECT * FROM catalog_metadata_report WHERE id=%s", (report_id,)).fetchone() == before
    assert metadata.snapshot() == unchanged


@pytest.mark.parametrize("status", ("pending", "rejected", "approved"))
def test_attribute_report_replies_and_repeated_closed_decisions_change_nothing(status):
    printing = attributes.seed()["tk-hs-g-10"]
    report_id = attributes.report(printing, {"basic_energy": True}).json()["id"]
    if status == "rejected":
        response = attributes.call("POST", f"{attributes.ADMIN}/reports/{report_id}/decision", attributes.OWNER,
                                    {"decision": "reject", "reason": "Checked"})
        assert response.status_code == 200, response.text
    elif status == "approved":
        response = attributes.decide(printing, correction={"basic_energy": True}, report_ids=[report_id])
        assert response.status_code == 200, response.text
    with connect() as conn:
        before = conn.execute("SELECT * FROM catalog_attribute_report WHERE id=%s", (report_id,)).fetchone()
    assert before["status"] == status
    unchanged = (attributes.revision(), attributes.clock(), attributes.effective(printing))
    reply = attributes.call("PATCH", f"{attributes.REPORTS}/{report_id}", attributes.REPORTER, {"note": "Not requested"})
    assert (reply.status_code, reply.json()["detail"]["code"]) == (404, "REPORT_NOT_FOUND")
    if status != "pending":
        for decision in ("reject", "needs_info"):
            repeated = attributes.call("POST", f"{attributes.ADMIN}/reports/{report_id}/decision", attributes.OWNER,
                                        {"decision": decision, "reason": "Again"})
            assert (repeated.status_code, repeated.json()["detail"]["code"]) == (409, "ALREADY_REVIEWED")
    with connect() as conn:
        assert conn.execute("SELECT * FROM catalog_attribute_report WHERE id=%s", (report_id,)).fetchone() == before
    assert (attributes.revision(), attributes.clock(), attributes.effective(printing)) == unchanged
