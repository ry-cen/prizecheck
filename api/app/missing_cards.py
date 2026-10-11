"""Private missing-card reports and owner-reviewed manual catalog entries."""
import hashlib
import hmac
import json
import os
import unicodedata
from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, HttpUrl

from .card_identity import card_identity_key
from .main import connect, require_owner, verified_user
from .public_catalog import publish_catalog_best_effort

router = APIRouter()


class ReportInput(BaseModel):
    kind: Literal["printing", "edition"]
    set_id: str | None = Field(default=None, max_length=80)
    set_name: str | None = Field(default=None, max_length=160)
    collector_number: str | None = Field(default=None, max_length=80)
    english_name: str | None = Field(default=None, max_length=160)
    printing_id: UUID | None = None
    descriptor: dict | None = None
    evidence_url: HttpUrl | None = None
    note: str = Field(default="", max_length=2000)


class ReportView(BaseModel):
    id: UUID
    kind: str
    status: str
    set_id: str | None
    set_name: str | None
    collector_number: str | None
    english_name: str | None
    printing_id: UUID | None
    descriptor: dict | None
    evidence_url: str | None
    note: str
    review_reason: str | None
    approved_printing_id: UUID | None
    approved_edition_id: UUID | None
    created_at: datetime
    updated_at: datetime


class ReportUpdate(BaseModel):
    note: str = Field(min_length=1, max_length=2000)
    evidence_url: HttpUrl | None = None


class DecisionInput(BaseModel):
    decision: Literal["needs_info", "reject", "approve"]
    reason: str = Field(min_length=1, max_length=2000)
    code: str | None = Field(default=None, pattern=r"^\d{6}$")
    set_id: str | None = Field(default=None, max_length=80)
    set_name: str | None = Field(default=None, max_length=160)
    collector_number: str | None = Field(default=None, max_length=80)
    english_name: str | None = Field(default=None, max_length=160)
    printing_id: UUID | None = None
    descriptor: dict | None = None
    evidence_url: HttpUrl | None = None


def _clean(value: str | None) -> str:
    return " ".join(unicodedata.normalize("NFC", value or "").split())


def _url(value: HttpUrl | None) -> str | None:
    return str(value) if value else None


def _view(row: dict) -> ReportView:
    return ReportView(**{key: row[key] for key in ReportView.model_fields})


def _report(conn, report_id: UUID, owner: bool, user_id: str):
    clause = "" if owner else " AND reporter_id=%s"
    values = (report_id,) if owner else (report_id, user_id)
    return conn.execute("SELECT * FROM missing_card_report WHERE id=%s" + clause + " FOR UPDATE", values).fetchone()


def _valid_descriptor(descriptor: dict | None) -> tuple[str, dict]:
    if descriptor is None:
        return json.dumps({"label": "Unspecified Variant"}, sort_keys=True), {"label": "Unspecified Variant"}
    if (not descriptor or any(not isinstance(key, str) or not key.strip() for key in descriptor)
            or any(isinstance(value, str) and not value.strip() for value in descriptor.values())
            or not any(isinstance(value, str) and value.strip() for value in descriptor.values())):
        raise HTTPException(422, {"code": "INVALID_DESCRIPTOR", "message": "Provide a physical Variant Descriptor."})
    if descriptor.get("label") == "Unspecified Variant":
        return json.dumps({"label": "Unspecified Variant"}, sort_keys=True), {"label": "Unspecified Variant"}
    if len(json.dumps(descriptor)) > 1000:
        raise HTTPException(422, {"code": "INVALID_DESCRIPTOR", "message": "Descriptor is too long."})
    return json.dumps(descriptor, sort_keys=True), descriptor


def _code_hash(owner_id: str, report_id: UUID, action: str, code: str) -> str:
    message = f"{owner_id}:{report_id}:{action}:{code}".encode()
    return hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), message, hashlib.sha256).hexdigest()


def _consume_code(conn, owner_id: str, report_id: UUID, action: str, code: str | None):
    if code is None:
        raise HTTPException(422, {"code": "FRESH_CODE_REQUIRED", "message": "Request a fresh approval code."})
    challenge = conn.execute("""SELECT * FROM catalog_approval_code
      WHERE owner_id=%s AND report_id=%s AND action=%s ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE""",
      (owner_id, report_id, action)).fetchone()
    if not challenge or challenge["consumed_at"] or challenge["expires_at"] <= datetime.now(challenge["expires_at"].tzinfo) or challenge["attempts"] >= 3:
        raise HTTPException(403, {"code": "INVALID_APPROVAL_CODE", "message": "Invalid or expired approval code."})
    if not hmac.compare_digest(challenge["code_hash"], _code_hash(owner_id, report_id, action, code)):
        # Preserve an invalid attempt despite the HTTP error by committing this transaction first.
        conn.execute("UPDATE catalog_approval_code SET attempts=attempts+1 WHERE id=%s", (challenge["id"],))
        return False
    conn.execute("UPDATE catalog_approval_code SET consumed_at=now() WHERE id=%s", (challenge["id"],))
    return True


@router.post("/api/missing-card-reports", response_model=ReportView, status_code=201)
def submit_report(payload: ReportInput, user_id: str = Depends(verified_user)):
    if payload.kind == "edition" and not payload.printing_id:
        raise HTTPException(422, {"code": "PRINTING_REQUIRED", "message": "Select the Printing first."})
    with connect() as conn, conn.transaction():
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user_id,))
        if payload.printing_id and not conn.execute("SELECT 1 FROM catalog_printing WHERE id=%s", (payload.printing_id,)).fetchone():
            raise HTTPException(404, "Printing not found")
        row = conn.execute("""INSERT INTO missing_card_report
          (reporter_id,kind,set_id,set_name,collector_number,english_name,printing_id,descriptor,evidence_url,note)
          VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
          (user_id, payload.kind, _clean(payload.set_id) or None, _clean(payload.set_name) or None,
           _clean(payload.collector_number) or None, _clean(payload.english_name) or None,
           payload.printing_id, json.dumps(payload.descriptor) if payload.descriptor else None,
           _url(payload.evidence_url), payload.note.strip())).fetchone()
        return _view(row)


@router.get("/api/missing-card-reports", response_model=list[ReportView])
def my_reports(user_id: str = Depends(verified_user)):
    with connect() as conn:
        return [_view(row) for row in conn.execute("""SELECT * FROM missing_card_report
          WHERE reporter_id=%s ORDER BY created_at DESC,id DESC LIMIT 100""", (user_id,)).fetchall()]


@router.get("/api/missing-card-reports/{report_id}", response_model=ReportView)
def my_report(report_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        row = conn.execute("SELECT * FROM missing_card_report WHERE id=%s AND reporter_id=%s", (report_id, user_id)).fetchone()
        if not row:
            raise HTTPException(404, "Report not found")
        return _view(row)


@router.patch("/api/missing-card-reports/{report_id}", response_model=ReportView)
def respond_to_review(report_id: UUID, payload: ReportUpdate, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        row = conn.execute("""UPDATE missing_card_report SET note=%s,evidence_url=COALESCE(%s,evidence_url),
          status='pending',updated_at=now() WHERE id=%s AND reporter_id=%s AND status='needs_info'
          RETURNING *""", (payload.note.strip(), _url(payload.evidence_url), report_id, user_id)).fetchone()
        if not row:
            raise HTTPException(404, "Report not found")
        return _view(row)


@router.get("/api/admin/missing-card-reports", response_model=list[ReportView])
def review_queue(user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        return [_view(row) for row in conn.execute("""SELECT * FROM missing_card_report
          ORDER BY CASE WHEN status IN ('pending','needs_info') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 200""").fetchall()]


@router.post("/api/admin/missing-card-reports", response_model=ReportView, status_code=201)
def owner_begin(payload: ReportInput, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        require_owner(conn, user_id)
        if payload.kind == "edition" and not payload.printing_id:
            raise HTTPException(422, {"code": "PRINTING_REQUIRED", "message": "Select the Printing first."})
        if payload.printing_id and not conn.execute("SELECT 1 FROM catalog_printing WHERE id=%s", (payload.printing_id,)).fetchone():
            raise HTTPException(404, "Printing not found")
        row = conn.execute("""INSERT INTO missing_card_report
          (reporter_id,kind,set_id,set_name,collector_number,english_name,printing_id,descriptor,evidence_url,note)
          VALUES (NULL,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
          (payload.kind, _clean(payload.set_id) or None, _clean(payload.set_name) or None,
           _clean(payload.collector_number) or None, _clean(payload.english_name) or None,
           payload.printing_id, json.dumps(payload.descriptor) if payload.descriptor else None,
           _url(payload.evidence_url), payload.note.strip())).fetchone()
        return _view(row)


@router.post("/api/admin/missing-card-reports/{report_id}/decision", response_model=ReportView)
def decide_report(report_id: UUID, payload: DecisionInput, user_id: str = Depends(verified_user)):
    bad_code = False
    with connect() as conn, conn.transaction():
        require_owner(conn, user_id)
        report = _report(conn, report_id, True, user_id)
        if not report:
            raise HTTPException(404, "Report not found")
        if report["status"] in ("approved", "rejected"):
            raise HTTPException(409, {"code": "ALREADY_REVIEWED", "message": "Report is already closed."})
        reason = _clean(payload.reason)
        if not reason:
            raise HTTPException(422, {"code": "REASON_REQUIRED", "message": "Give a review reason."})
        if payload.decision != "approve":
            status = "rejected" if payload.decision == "reject" else "needs_info"
            row = conn.execute("""UPDATE missing_card_report SET status=%s,review_reason=%s,reviewer_id=%s,
              reviewed_at=now(),updated_at=now() WHERE id=%s RETURNING *""", (status, reason, user_id, report_id)).fetchone()
            return _view(row)
        action = "approve_printing" if report["kind"] == "printing" else "approve_edition"
        # Resolve owner-reviewed values, never publish an unreviewed suggestion by default.
        evidence = _url(payload.evidence_url) or report["evidence_url"]
        if not evidence:
            raise HTTPException(422, {"code": "EVIDENCE_REQUIRED", "message": "Provide an evidence link."})
        state = conn.execute("SELECT active_generation FROM catalog_state WHERE singleton FOR UPDATE").fetchone()
        if not state["active_generation"]:
            raise HTTPException(409, {"code": "CATALOG_UNAVAILABLE", "message": "Complete the first catalog pull before approval."})
        generation = state["active_generation"]
        if report["kind"] == "printing":
            set_id = _clean(payload.set_id or report["set_id"])
            set_name = _clean(payload.set_name or report["set_name"])
            number = _clean(payload.collector_number or report["collector_number"])
            name = _clean(payload.english_name or report["english_name"])
            if not all((set_id, set_name, number, name)):
                raise HTTPException(422, {"code": "INCOMPLETE_PRINTING", "message": "Verify set, collector number, and exact English name."})
            duplicate = conn.execute("""SELECT 1 FROM catalog_generation_printing WHERE generation_id=%s
              AND lower(set_id)=lower(%s) AND lower(collector_number)=lower(%s) AND NOT tombstoned LIMIT 1""",
              (generation, set_id, number)).fetchone()
            if duplicate:
                raise HTTPException(409, {"code": "POSSIBLE_DUPLICATE", "message": "Set and number already exist; review the candidate."})
            ambiguous = conn.execute("""SELECT 1 FROM catalog_generation_printing WHERE generation_id=%s
              AND NOT tombstoned AND ((lower(set_id)=lower(%s) AND lower(set_name)<>lower(%s))
              OR (lower(set_name)=lower(%s) AND lower(set_id)<>lower(%s))) LIMIT 1""",
              (generation, set_id, set_name, set_name, set_id)).fetchone()
            if ambiguous:
                raise HTTPException(409, {"code": "AMBIGUOUS_SET", "message": "Set name or ID conflicts with the catalog; review it."})
            descriptor_key, descriptor = _valid_descriptor(None)
        else:
            printing_id = payload.printing_id or report["printing_id"]
            target = conn.execute("""SELECT gp.printing_id FROM catalog_generation_printing gp
              WHERE gp.generation_id=%s AND gp.printing_id=%s AND NOT gp.tombstoned""", (generation, printing_id)).fetchone()
            if not target:
                raise HTTPException(404, "Printing not found")
            descriptor_key, descriptor = _valid_descriptor(payload.descriptor or report["descriptor"])
            if descriptor == {"label": "Unspecified Variant"}:
                raise HTTPException(422, {"code": "DISTINCT_VARIANT_REQUIRED", "message": "Use the existing Unspecified Variant when the physical variant is uncertain."})
            if conn.execute("SELECT 1 FROM catalog_edition WHERE printing_id=%s AND descriptor_key=%s", (printing_id, descriptor_key)).fetchone():
                raise HTTPException(409, {"code": "POSSIBLE_DUPLICATE", "message": "Descriptor already exists; review the candidate."})
        if not _consume_code(conn, user_id, report_id, action, payload.code):
            bad_code = True
        else:
            # Take the commit-ordered public revision before any catalog or metadata row is written.
            conn.execute("SELECT catalog_begin_correction()")
            if report["kind"] == "printing":
                key = card_identity_key(name)  # Card Identity folds apostrophes and ignores a trailing subtitle.
                identity = conn.execute("""INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s)
                  ON CONFLICT(identity_key) DO UPDATE SET identity_key=EXCLUDED.identity_key RETURNING id""", (key, key)).fetchone()
                printing_id = conn.execute("""INSERT INTO catalog_printing(source,identity_id)
                  VALUES ('manual',%s) RETURNING id""", (identity["id"],)).fetchone()["id"]
                conn.execute("""INSERT INTO catalog_generation_printing
                  (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,image_url,source_fingerprint,basic_energy)
                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,NULL,%s,'unresolved')""",
                  (generation, printing_id, f"manual:{printing_id}", set_id, set_name, number, name,
                   name.casefold(), hashlib.sha256(f"{set_id}:{number}:{name}".encode()).hexdigest()))
            edition_id = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
              VALUES (%s,%s,%s) RETURNING id""", (printing_id, descriptor_key, json.dumps(descriptor))).fetchone()["id"]
            conn.execute("""INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id)
              VALUES (%s,%s,%s)""", (generation, edition_id, printing_id))
            revision = conn.execute("""UPDATE catalog_state SET revision=revision+1 WHERE singleton RETURNING revision""").fetchone()["revision"]
            conn.execute("""INSERT INTO catalog_override
              (report_id,printing_id,edition_id,revision,reviewer_id,evidence_url,reason,action)
              VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
              (report_id, printing_id, edition_id, revision, user_id, evidence, reason, action))
            row = conn.execute("""UPDATE missing_card_report SET status='approved',review_reason=%s,reviewer_id=%s,
              reviewed_at=now(),updated_at=now(),approved_printing_id=%s,approved_edition_id=%s,
              evidence_url=%s WHERE id=%s RETURNING *""",
              (reason, user_id, printing_id, edition_id, evidence, report_id)).fetchone()
    if bad_code:
        raise HTTPException(403, {"code": "INVALID_APPROVAL_CODE", "message": "Invalid or expired approval code."})
    # The approval is committed; publishing its public catalog records is best effort and recoverable.
    publish_catalog_best_effort(printing_ids=[printing_id])
    return _view(row)
