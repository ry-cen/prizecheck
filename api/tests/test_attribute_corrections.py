"""Reviewed card attribute corrections (Deck Lists 11, issue #92) over signed HTTP against PostgreSQL.

Collector reports are unapproved input; only the owner's approval-coded decision creates, replaces or removes a
Printing's correction. Effects are observed through the owner's evidence route, Deck detail checks (the Basic Energy
exemption reads effective attributes) and the effective attributes every reader uses.
"""
import hashlib
import hmac
import os
from uuid import UUID, uuid4

from app.card_attributes import RULES, CardAttributeRules, CardAttributes, advance_attribute_revision, \
    attribute_revision, read_card_attributes
from app.main import connect
from test_card_attributes import ENERGY_BW, EX_SV, RARE_CANDY_SM, REVERSAL_MISLABELLED, TRAINER_KIT_ENERGY, \
    edition_of, printing_ids
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run, seed_manual
from test_deck_lists import add_line, detail
from test_holdings import call

OWNER, REPORTER, OTHER = "attr-owner", "attr-reporter", "attr-other"
REPORTS = "/api/catalog/attribute-reports"
ADMIN = "/api/admin/card-attributes"
ACTION = "correct_attributes"
CARDS = (ENERGY_BW, TRAINER_KIT_ENERGY, REVERSAL_MISLABELLED, EX_SV, RARE_CANDY_SM)
FULL_MANUAL = {"regulation_mark": "H", "card_kind": "pokemon", "basic_energy": False, "types": ["Lightning"],
               "rule_box": False, "ace_spec": False, "radiant": False, "prism_star": False}


def seed(*records):
    reset_catalog()
    run(Records(*(records or CARDS)))
    with connect() as conn:
        conn.execute("DELETE FROM catalog_approval_code")
        for user in (OWNER, REPORTER, OTHER):
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user,))
        conn.execute("DELETE FROM owner_binding")
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (OWNER,))
    return {source_id: str(printing_id) for source_id, printing_id in printing_ids(*(r["id"] for r in records or CARDS)).items()}


def grant(printing, code="123456", action=ACTION, user=OWNER):
    target = f"printing:{printing}"
    digest = hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), f"{user}:{target}:{action}:{code}".encode(),
                      hashlib.sha256).hexdigest()
    with connect() as conn:
        conn.execute("""INSERT INTO catalog_approval_code(owner_id,metadata_target,action,code_hash,expires_at)
          VALUES (%s,%s,%s,%s,now()+interval '5 minutes')""", (user, target, action, digest))


def evidence(printing):
    response = call("GET", f"{ADMIN}/{printing}", OWNER)
    assert response.status_code == 200, response.text
    return response.json()


def decide(printing, decision="correct", correction=None, *, code="123456", digest=None, report_ids=(), user=OWNER):
    body = {"printing_id": printing, "decision": decision, "evidence_digest": digest or evidence(printing)["evidence_digest"],
            "evidence_url": "https://example.org/scan", "reason": "Checked the printed card", "report_ids": list(report_ids),
            "code": code}
    if correction is not None:
        body["correction"] = correction
    return call("POST", f"{ADMIN}/decisions", user, body)


def report(printing, proposed, user=REPORTER):
    return call("POST", REPORTS, user, {"printing_id": printing, "proposed": proposed,
                                         "evidence_url": "https://example.org/photo", "note": "The card says otherwise"})


def error(response):
    return response.json()["detail"]["code"]


def revision():
    with connect() as conn:
        return attribute_revision(conn)


def clock():
    with connect() as conn:
        return conn.execute("SELECT revision FROM catalog_public_clock").fetchone()["revision"]


def effective(printing):
    with connect() as conn:
        return read_card_attributes(conn, [printing])[UUID(printing)]


def deck_with(*editions):
    """A Deck whose Deck List holds five copies of each Edition; returns a function reading its basic check statuses."""
    owner = f"attr-deck-{uuid4()}"
    created = call("POST", "/api/decks", owner, {"name": "Attribute deck", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    list_revision = 1
    for edition in editions:
        response = add_line(owner, deck, str(edition), "5", list_revision)
        assert response.status_code == 200, response.text
        list_revision = response.json()["deck_list"]["revision"]
    return lambda: {row["name"]: row["status"] for row in detail(owner, deck)["deck_list_checks"]["identities"]}


# ------------------------------------------------------------------ reports are unapproved input


def test_a_report_is_stored_for_review_and_changes_no_attribute_or_revision():
    ids = seed()
    printing = ids["tk-hs-g-10"]
    before = (revision(), clock(), effective(printing))
    response = report(printing, {"basic_energy": True, "card_kind": "energy"})
    assert response.status_code == 201, response.text
    view = response.json()
    assert (view["status"], view["proposed"]) == ("pending", {"card_kind": "energy", "basic_energy": True})
    assert "reporter_id" not in view and "reviewer_id" not in view
    assert (revision(), clock(), effective(printing)) == before
    shown = evidence(printing)
    assert shown["report_ids"] == [view["id"]] and shown["effective"]["basic_energy"] is None
    queue = call("GET", f"{ADMIN}/queue", OWNER).json()
    assert [item["printing_id"] for item in queue["items"]] == [printing] and queue["next_cursor"] is None


def test_report_proposals_are_allowlisted_and_name_a_real_printing():
    ids = seed()
    printing = ids["tk-hs-g-10"]
    for proposed in ({}, {"price": 1}, {"regulation_mark": "h"}, {"card_kind": "item"}, {"types": ["Fire", "Fire"]},
                     {"types": ["Fairy Energy"]}, {"basic_energy": "yes"}, {"rule_box": None}):
        assert report(printing, proposed).status_code == 422, proposed
    missing = report(str(uuid4()), {"basic_energy": True})
    assert (missing.status_code, error(missing)) == (404, "PRINTING_NOT_FOUND")


def test_reports_are_reporter_scoped_and_owner_can_ask_for_information_or_reject_without_a_code():
    ids = seed()
    printing = ids["tk-hs-g-10"]
    mine = report(printing, {"basic_energy": True}).json()["id"]
    assert [row["id"] for row in call("GET", REPORTS, REPORTER).json()] == [mine]
    assert call("GET", REPORTS, OTHER).json() == []
    assert call("GET", f"{REPORTS}/{mine}", OTHER).status_code == 404
    assert call("POST", f"{ADMIN}/reports/{mine}/decision", OTHER, {"decision": "reject", "reason": "no"}).status_code == 403
    before = revision()
    asked = call("POST", f"{ADMIN}/reports/{mine}/decision", OWNER, {"decision": "needs_info", "reason": "Send a photo"})
    assert (asked.status_code, asked.json()["status"]) == (200, "needs_info"), asked.text
    answered = call("PATCH", f"{REPORTS}/{mine}", REPORTER, {"note": "Photo attached"})
    assert (answered.status_code, answered.json()["status"]) == (200, "pending")
    rejected = call("POST", f"{ADMIN}/reports/{mine}/decision", OWNER, {"decision": "reject", "reason": "It is unknown"})
    assert (rejected.status_code, rejected.json()["status"]) == (200, "rejected")
    again = call("POST", f"{ADMIN}/reports/{mine}/decision", OWNER, {"decision": "reject", "reason": "Again"})
    assert (again.status_code, error(again)) == (409, "ALREADY_REVIEWED")
    assert revision() == before and effective(printing).basic_energy is None
    assert call("GET", f"{REPORTS}/{mine}", REPORTER).json()["status"] == "rejected"


# ------------------------------------------------------------------ approval-coded decisions


def test_a_correction_needs_a_fresh_code_issued_for_this_printing_and_action():
    ids = seed()
    printing = ids["tk-hs-g-10"]
    correction = {"basic_energy": True}
    before = revision()
    assert error(decide(printing, correction=correction, code=None)) == "FRESH_CODE_REQUIRED"
    grant(printing, action="resolve_metadata")  # a Live metadata code for the same Printing
    assert decide(printing, correction=correction).status_code == 403
    grant(ids["bw1-105"])  # a code for another Printing
    assert decide(printing, correction=correction).status_code == 403
    grant(printing, user=OTHER)
    assert decide(printing, correction=correction, user=OTHER).status_code == 403  # not the owner
    grant(printing)
    clock_before = clock()
    wrong = decide(printing, correction=correction, code="654321")
    assert (wrong.status_code, error(wrong)) == (403, "INVALID_APPROVAL_CODE")
    with connect() as conn:
        assert conn.execute("""SELECT attempts FROM catalog_approval_code WHERE owner_id=%s AND action=%s
          ORDER BY created_at DESC LIMIT 1""", (OWNER, ACTION)).fetchone()["attempts"] == 1
    assert (revision(), clock()) == (before, clock_before) and effective(printing).basic_energy is None
    approved = decide(printing, correction=correction)
    assert approved.status_code == 200, approved.text
    spent = decide(printing, correction=correction)
    assert (spent.status_code, error(spent)) == (403, "INVALID_APPROVAL_CODE")  # a code is spent once


def test_an_approved_correction_overrides_derived_values_closes_reports_and_advances_the_revision_once():
    ids = seed()
    statuses = deck_with(*(edition_of(source_id) for source_id in ("bw1-105", "tk-hs-g-10", "sv04-266", "sv01-032")))
    assert statuses() == {"Grass Energy": "basic_energy_exempt", "Water Energy": "unresolved",
                          "Reversal Energy": "over_limit", "Arcanine ex": "over_limit"}
    unknown, known = ids["tk-hs-g-10"], ids["bw1-105"]
    sent = report(unknown, {"basic_energy": True}).json()["id"]
    before = revision()
    grant(unknown)
    response = decide(unknown, correction={"basic_energy": True}, report_ids=[sent])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["attribute_revision"] == before + 1 == revision()
    assert body["closed_report_ids"] == [sent] and body["effective"]["basic_energy"] is True
    assert body["correction"] == {**dict.fromkeys(FULL_MANUAL), "basic_energy": True}
    assert call("GET", f"{REPORTS}/{sent}", REPORTER).json()["status"] == "approved"
    # A definite derived value is overridden too: Grass Energy bw1-105 derives as Basic Energy.
    assert evidence(known)["derived"]["basic_energy"] is True
    grant(known)
    assert decide(known, correction={"basic_energy": False}).status_code == 200
    assert revision() == before + 2
    assert statuses() == {"Grass Energy": "over_limit", "Water Energy": "basic_energy_exempt",
                          "Reversal Energy": "over_limit", "Arcanine ex": "over_limit"}
    shown = evidence(known)
    assert (shown["derived"]["basic_energy"], shown["correction"]["basic_energy"], shown["effective"]["basic_energy"]) == (
        True, False, False)
    assert shown["effective"]["card_kind"] == "energy"  # uncorrected attributes still follow derivation
    history = call("GET", f"{ADMIN}/{known}/history", OWNER).json()
    assert [(row["decision"], row["correction"], row["previous_correction"], row["reviewer_id"]) for row in history] == [
        ("correct", {"basic_energy": False}, None, OWNER)]
    assert history[0]["derived"]["basic_energy"] is True and history[0]["evidence_url"] == "https://example.org/scan"


def test_a_correction_survives_re_derivation_until_it_is_removed(monkeypatch):
    ids = seed()
    printing = ids["bw1-105"]
    statuses = deck_with(edition_of("bw1-105"))
    grant(printing)
    assert decide(printing, correction={"basic_energy": False}).status_code == 200
    # A new rules version makes the next import rewrite every derived row; the correction still wins.
    monkeypatch.setattr(CardAttributeRules, "VERSION", RULES.VERSION + 1)
    run(Records(*CARDS))
    shown = evidence(printing)
    assert (shown["rules_version"], shown["derived"]["basic_energy"]) == (RULES.VERSION, True)
    assert effective(printing).basic_energy is False and statuses() == {"Grass Energy": "over_limit"}
    before = revision()
    grant(printing)
    removed = decide(printing, decision="remove")
    assert removed.status_code == 200, removed.text
    assert removed.json()["correction"] is None and removed.json()["effective"]["basic_energy"] is True
    assert revision() == before + 1 and statuses() == {"Grass Energy": "basic_energy_exempt"}
    grant(printing)
    nothing = decide(printing, decision="remove")
    assert (nothing.status_code, error(nothing)) == (422, "NO_CORRECTION")
    history = call("GET", f"{ADMIN}/{printing}/history", OWNER).json()
    assert [(row["decision"], row["correction"], row["previous_correction"]) for row in history] == [
        ("remove", {}, {"basic_energy": False}), ("correct", {"basic_energy": False}, None)]


def test_a_decision_states_the_whole_correction():
    ids = seed()
    printing = ids["sm1-129"]
    grant(printing)
    assert decide(printing, correction={"ace_spec": True, "regulation_mark": "D"}).status_code == 200
    grant(printing)
    replaced = decide(printing, correction={"regulation_mark": "E"})
    assert replaced.status_code == 200, replaced.text
    found = effective(printing)
    assert (found.regulation_mark, found.ace_spec) == ("E", False)  # ACE SPEC is derived again


def test_manual_printings_get_attributes_only_through_reviewed_corrections():
    seed(EX_SV)
    manual, edition = seed_manual()
    manual = str(manual)
    statuses = deck_with(edition)
    assert statuses() == {"Manual Pikachu": "unresolved"}  # Basic Energy status unknown
    shown = evidence(manual)
    assert (shown["source"], shown["derived"], shown["source_fields"], shown["correction"]) == ("manual", None, None, None)
    assert set(shown["effective"].values()) == {None}
    assert manual in [item["printing_id"] for item in call("GET", f"{ADMIN}/queue", OWNER).json()["items"]]
    before = revision()
    grant(manual)
    response = decide(manual, correction=FULL_MANUAL)
    assert response.status_code == 200, response.text
    assert response.json()["effective"] == FULL_MANUAL and revision() == before + 1
    expected = CardAttributes("H", "pokemon", False, ("Lightning",), False, False, False, False)
    assert effective(manual) == expected
    run(Records(EX_SV))  # an import derives nothing for a manual Printing and leaves its correction alone
    assert effective(manual) == expected
    assert manual not in [item["printing_id"] for item in call("GET", f"{ADMIN}/queue", OWNER).json()["items"]]
    assert statuses() == {"Manual Pikachu": "over_limit"}


def test_a_decision_binds_to_the_evidence_shown_and_rejects_impossible_attributes():
    ids = seed()
    printing = ids["tk-hs-g-10"]
    shown = evidence(printing)["evidence_digest"]
    report(printing, {"basic_energy": True})  # new evidence arrives after the owner looked
    grant(printing)
    stale = decide(printing, correction={"basic_energy": True}, digest=shown)
    assert (stale.status_code, error(stale)) == (409, "ATTRIBUTE_EVIDENCE_CHANGED")
    for correction, code in (({}, "EMPTY_CORRECTION"), ({"types": ["Water"]}, "INCONSISTENT_ATTRIBUTES"),
                             ({"basic_energy": True, "ace_spec": True}, "INCONSISTENT_ATTRIBUTES")):
        response = decide(printing, correction=correction)
        assert (response.status_code, error(response)) == (422, code), correction
    removal = decide(printing, decision="remove", correction={"basic_energy": True})
    assert (removal.status_code, error(removal)) == (422, "CORRECTION_NOT_ALLOWED")
    other = report(ids["bw1-105"], {"basic_energy": False}).json()["id"]
    response = decide(printing, correction={"basic_energy": True}, report_ids=[other])
    assert (response.status_code, error(response)) == (422, "INVALID_REPORT")
    # None of the refusals spent the code.
    assert decide(printing, correction={"basic_energy": True}).status_code == 200


def test_the_attribute_revision_advances_once_per_transaction():
    with connect() as conn:
        with conn.transaction():
            first = advance_attribute_revision(conn)
            assert advance_attribute_revision(conn) == first
        with conn.transaction():
            assert advance_attribute_revision(conn) == first + 1


def test_the_twenty_sixth_open_report_is_refused_and_long_evidence_links_are_422():
    ids = seed()
    printing = ids["tk-hs-g-10"]
    for _ in range(25):
        assert report(printing, {"basic_energy": True}).status_code == 201
    limited = report(printing, {"basic_energy": True})
    assert (limited.status_code, error(limited)) == (429, "REPORT_LIMIT")
    assert report(printing, {"basic_energy": True}, user=OTHER).status_code == 201  # the cap is per reporter
    long_url = "https://example.org/" + "a" * 2029  # 2049 characters: over the report table's 2048 limit
    body = {"printing_id": printing, "proposed": {"basic_energy": True}, "evidence_url": long_url}
    assert call("POST", REPORTS, OTHER, body).status_code == 422
    assert call("POST", REPORTS, OTHER, {**body, "evidence_url": long_url[:-1]}).status_code == 201


def test_owner_routes_refuse_everyone_else():
    ids = seed()
    printing = ids["tk-hs-g-10"]
    for path in (f"{ADMIN}/{printing}", f"{ADMIN}/{printing}/history", f"{ADMIN}/queue"):
        assert call("GET", path, REPORTER).status_code == 403, path
        assert call("GET", path, OWNER).status_code == 200, path


def test_an_attribute_code_cannot_be_spent_on_a_metadata_decision():
    ids = seed()
    printing = ids["tk-hs-g-10"]
    shown = call("GET", f"/api/admin/catalog-metadata/printings/{printing}", OWNER)
    assert shown.status_code == 200, shown.text
    item = shown.json()
    grant(printing)  # a correct_attributes code
    body = {"target": "live", "printing_id": printing, "decision": "unsupported", "basis_revision": item["basis_revision"],
            "evidence_digest": item["evidence_digest"], "evidence_url": "https://example.org/evidence",
            "reason": "Checked the physical card", "report_ids": [], "code": "123456"}
    refused = call("POST", "/api/admin/catalog-metadata/decisions", OWNER, body)
    assert (refused.status_code, error(refused)) == (403, "INVALID_APPROVAL_CODE")
    assert decide(printing, correction={"basic_energy": True}).status_code == 200  # the code is still unspent


def scans(query, params):
    """Every scan of the derived and correction tables in the query's plan as (relation, node type, keyed), where keyed
    means the scan looks rows up by an index condition. Seq scans are priced out, as row counts would at catalog scale;
    a UNION ALL form of the view failed it by reading the whole derived table (6 ms against 0.14 ms at 25k Printings)."""
    with connect() as conn, conn.transaction():
        conn.execute("SET LOCAL enable_seqscan=off")
        plan = conn.execute("EXPLAIN (FORMAT JSON) " + query, params).fetchone()["QUERY PLAN"][0]["Plan"]
    found = []

    def walk(node):
        if node.get("Relation Name") in ("catalog_derived_attribute", "catalog_attribute_correction"):
            children = node.get("Plans", [])
            keyed = "Index Cond" in node or any("Index Cond" in child for child in children)
            found.append((node["Relation Name"], node["Node Type"], keyed))
        for child in node.get("Plans", []):
            walk(child)
    walk(plan)
    return found


def test_both_reader_forms_look_attributes_up_by_primary_key():
    ids = seed()
    manual, edition = seed_manual()
    grant(str(manual))
    assert decide(str(manual), correction=FULL_MANUAL).status_code == 200
    editions = [edition_of(source_id) for source_id in ("bw1-105", "tk-hs-g-10")] + [str(edition)]
    # The join form of Deck checks and Deck List publication.
    joined = scans("""SELECT a.basic_energy FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
      LEFT JOIN catalog_card_attribute a ON a.printing_id=p.id WHERE e.id=ANY(%s::uuid[])""", (editions,))
    # The printing_id = ANY form of read_card_attributes.
    listed = scans("SELECT * FROM catalog_card_attribute WHERE printing_id=ANY(%s::uuid[])", (list(ids.values()),))
    # The derived table holds a row per TCGdex Printing, so every scan of it must be a keyed lookup. The correction
    # table is bounded by owner decisions; while it is tiny the planner may read its whole index, never seq-scan it.
    for found in (joined, listed):
        assert {relation for relation, _, _ in found} == {"catalog_derived_attribute", "catalog_attribute_correction"}
        assert all(keyed for relation, _, keyed in found if relation == "catalog_derived_attribute"), found
        assert all("Seq" not in kind for _, kind, _ in found), found
