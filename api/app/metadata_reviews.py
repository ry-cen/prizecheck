"""Collector reports and maintainer decisions for reviewed Live and Marketplace targets.

Reports are unapproved input: they write one report row and nothing else. Only the owner
(the catalog maintainer) changes target state, through a decision that consumes a fresh
approval code, binds to the evidence the maintainer was shown, takes its revision from the
commit-ordered public clock and never touches the catalog revision, quote data or a source.
"""
import base64
import hashlib
import hmac
import json
import re
from datetime import datetime
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, HttpUrl

from . import public_catalog
from .catalog_targets import (LIVE, MATCHING, REGISTRIES, MatchingRulesV1, TargetContext, activate_rule,
                              code_digest, fingerprint, is_unspecified, refresh_editions, refresh_printing, verified_elsewhere)
from .holdings import fail
from .main import connect, require_owner, verified_user
from .missing_cards import _code_hash

router = APIRouter()

LOCK_TIMEOUT = "5s"
OPEN_REPORT_LIMIT = 25
QUEUE_PAGE = 100
OPEN = ("pending", "needs_info")
LIVE_PROPOSAL_KEYS = ("category", "name", "set_code", "collector_number")


# ---------------------------------------------------------------- reports


class MetadataLiveProposal(BaseModel):
    model_config = {"extra": "forbid"}
    category: Literal["Pokemon", "Trainer", "Energy"] | None = None
    name: str | None = Field(default=None, min_length=1, max_length=160)
    set_code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{1,10}$")
    collector_number: str | None = Field(default=None, min_length=1, max_length=20)


class MetadataMarketplaceProposal(BaseModel):
    model_config = {"extra": "forbid"}
    product_id: int | None = Field(default=None, ge=1, le=2**31 - 1)
    quote_variant: str | None = Field(default=None, pattern=r"^[a-z0-9-]{1,40}$")


class MetadataReportInput(BaseModel):
    target: Literal["live", "marketplace"]
    issue: Literal["missing", "incorrect"]
    printing_id: UUID
    edition_id: UUID | None = None
    proposed: dict = Field(default_factory=dict)
    evidence_url: HttpUrl | None = None
    note: str = Field(default="", max_length=2000)

    def allowlisted(self) -> dict:
        model = MetadataLiveProposal if self.target == "live" else MetadataMarketplaceProposal
        try:
            return model.model_validate(self.proposed).model_dump(exclude_none=True)
        except ValueError as error:
            raise HTTPException(422, {"code": "INVALID_PROPOSAL", "message": str(error)[:200]}) from None


class MetadataReportView(BaseModel):
    id: UUID
    target: str
    issue: str
    printing_id: UUID
    edition_id: UUID | None
    proposed: dict
    evidence_url: str | None
    note: str
    status: str
    review_reason: str | None
    observed_revision: int | None
    created_at: datetime
    updated_at: datetime


class MetadataReportUpdate(BaseModel):
    note: str = Field(min_length=1, max_length=2000)
    evidence_url: HttpUrl | None = None


class MetadataReportDecision(BaseModel):
    decision: Literal["needs_info", "reject"]
    reason: str = Field(min_length=1, max_length=2000)


def _view(row) -> MetadataReportView:
    return MetadataReportView(**{key: row[key] for key in MetadataReportView.model_fields})


def _own(conn, report_id: UUID, user_id: str):
    return conn.execute("SELECT * FROM catalog_metadata_report WHERE id=%s AND reporter_id=%s", (report_id, user_id)).fetchone()


@router.post("/api/catalog/metadata-reports", response_model=MetadataReportView, status_code=201)
def submit_report(payload: MetadataReportInput, user_id: str = Depends(verified_user)):
    proposed = payload.allowlisted()
    if payload.target == "marketplace" and payload.edition_id is None:
        fail(422, "EDITION_REQUIRED")
    with connect() as conn, conn.transaction():
        # Serialize one reporter's submissions so the open-report cap cannot be raced past.
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user_id,))
        conn.execute("SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE", (user_id,))
        if not conn.execute("SELECT 1 FROM catalog_printing WHERE id=%s", (payload.printing_id,)).fetchone():
            fail(404, "PRINTING_NOT_FOUND")
        if payload.edition_id and not conn.execute("SELECT 1 FROM catalog_edition WHERE id=%s AND printing_id=%s",
                                                   (payload.edition_id, payload.printing_id)).fetchone():
            fail(422, "EDITION_PRINTING_MISMATCH")
        open_count = conn.execute("SELECT count(*) AS n FROM catalog_metadata_report WHERE reporter_id=%s AND status=ANY(%s)",
                                  (user_id, list(OPEN))).fetchone()["n"]
        if open_count >= OPEN_REPORT_LIMIT:
            fail(429, "REPORT_LIMIT")
        observed = (conn.execute("SELECT public_revision FROM catalog_edition_metadata WHERE edition_id=%s", (payload.edition_id,)).fetchone()
                    if payload.target == "marketplace" else
                    conn.execute("SELECT public_revision FROM catalog_printing_metadata WHERE printing_id=%s", (payload.printing_id,)).fetchone())
        row = conn.execute("""INSERT INTO catalog_metadata_report
          (reporter_id,target,issue,printing_id,edition_id,proposed,evidence_url,note,observed_revision)
          VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                           (user_id, payload.target, payload.issue, payload.printing_id, payload.edition_id, json.dumps(proposed),
                            str(payload.evidence_url) if payload.evidence_url else None, payload.note.strip(),
                            observed["public_revision"] if observed else None)).fetchone()
        return _view(row)


@router.get("/api/catalog/metadata-reports", response_model=list[MetadataReportView])
def my_reports(user_id: str = Depends(verified_user)):
    with connect() as conn:
        return [_view(row) for row in conn.execute("""SELECT * FROM catalog_metadata_report WHERE reporter_id=%s
          ORDER BY created_at DESC,id DESC LIMIT 100""", (user_id,)).fetchall()]


@router.get("/api/catalog/metadata-reports/{report_id}", response_model=MetadataReportView)
def my_report(report_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        row = _own(conn, report_id, user_id)
        if not row:
            fail(404, "REPORT_NOT_FOUND")
        return _view(row)


@router.patch("/api/catalog/metadata-reports/{report_id}", response_model=MetadataReportView)
def answer_report(report_id: UUID, payload: MetadataReportUpdate, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        row = conn.execute("""UPDATE catalog_metadata_report SET note=%s,evidence_url=COALESCE(%s,evidence_url),status='pending',updated_at=now()
          WHERE id=%s AND reporter_id=%s AND status='needs_info' RETURNING *""",
                           (payload.note.strip(), str(payload.evidence_url) if payload.evidence_url else None, report_id, user_id)).fetchone()
        if not row:
            fail(404, "REPORT_NOT_FOUND")
        return _view(row)


@router.post("/api/admin/catalog-metadata/reports/{report_id}/decision", response_model=MetadataReportView)
def decide_report(report_id: UUID, payload: MetadataReportDecision, user_id: str = Depends(verified_user)):
    """Ask for more information or reject. Neither changes any target state, so no code is needed."""
    with connect() as conn, conn.transaction():
        require_owner(conn, user_id)
        report = conn.execute("SELECT * FROM catalog_metadata_report WHERE id=%s FOR UPDATE", (report_id,)).fetchone()
        if not report:
            fail(404, "REPORT_NOT_FOUND")
        if report["status"] not in OPEN:
            fail(409, "ALREADY_REVIEWED")
        reason = " ".join(payload.reason.split())
        if not reason:
            fail(422, "REASON_REQUIRED")
        if payload.decision == "reject":
            row = conn.execute("""UPDATE catalog_metadata_report SET status='rejected',review_reason=%s,reviewer_id=%s,reviewed_at=now(),
              updated_at=now() WHERE id=%s RETURNING *""", (reason, user_id, report_id)).fetchone()
        else:  # The reporter-visible CHECK reserves reviewer columns for closed reports.
            row = conn.execute("""UPDATE catalog_metadata_report SET status='needs_info',review_reason=%s,updated_at=now()
              WHERE id=%s RETURNING *""", (reason, report_id)).fetchone()
        return _view(row)


# ---------------------------------------------------------------- evidence, queue and history


class MetadataQueueItem(BaseModel):
    kind: Literal["edition", "printing"]
    target: Literal["marketplace", "live"]
    printing_id: UUID
    edition_id: UUID | None
    descriptor: dict | None
    set_id: str | None
    collector_number: str | None
    name: str | None
    state: str
    reason: str | None
    basis_revision: int
    mapping_revision: int | None
    source_candidate: dict
    source_fingerprint: str | None
    reviewed_value: dict | None
    report_ids: list[UUID]
    rejected_fingerprints: list[str]
    evidence_digest: str


class MetadataQueuePage(BaseModel):
    items: list[MetadataQueueItem]
    next_cursor: str | None


class MetadataDecisionRow(BaseModel):
    id: UUID
    target: str
    printing_id: UUID
    edition_id: UUID | None
    decision: str
    reviewed_value: dict
    source_value: dict | None
    source_fingerprint: str | None
    checks: dict
    basis_revision: int
    evidence_url: str
    reason: str
    reviewer_id: str
    reviewed_at: datetime
    clock_revision: int
    # The rule activation that validated the decision; null when no rule applied.
    rule_kind: Literal["live_derivation", "marketplace_matching"] | None = None
    rule_version: int | None = None


TARGET_KINDS = {"editions": "edition", "printings": "printing"}


def load_target(conn, kind: str, target_id: UUID, lock: bool = False):
    """Everything a maintainer is shown for one target, from PostgreSQL. ``lock`` takes the metadata row FOR UPDATE."""
    suffix = " FOR UPDATE OF m" if lock else ""
    if kind == "edition":
        row = conn.execute(f"""SELECT e.id AS edition_id,e.printing_id,e.descriptor,m.mapping_state AS state,m.mapping_reason AS reason,
          m.public_revision,m.mapping_revision,m.mapping_candidate AS candidate,m.product_id,m.quote_variant,m.auto_closed,
          d.set_id,d.collector_number,d.display_name AS name
          FROM catalog_edition e JOIN catalog_edition_metadata m ON m.edition_id=e.id
          LEFT JOIN catalog_printing_display d ON d.printing_id=e.printing_id WHERE e.id=%s{suffix}""", (target_id,)).fetchone()
        if not row:
            return None
        reviewed = ({"product_id": row["product_id"], "quote_variant": row["quote_variant"]}
                    if row["state"] == "verified" else None)
        reports = conn.execute("""SELECT id FROM catalog_metadata_report WHERE target='marketplace' AND edition_id=%s AND status=ANY(%s)
          ORDER BY created_at,id""", (target_id, list(OPEN))).fetchall()
        rejected = conn.execute("""SELECT source_fingerprint FROM catalog_metadata_rejection WHERE target='marketplace' AND edition_id=%s
          ORDER BY source_fingerprint""", (target_id,)).fetchall()
        target = "marketplace"
    else:
        row = conn.execute(f"""SELECT NULL::uuid AS edition_id,m.printing_id,NULL::jsonb AS descriptor,m.live_state AS state,m.live_reason AS reason,
          m.public_revision,NULL::integer AS mapping_revision,m.export_candidate AS candidate,m.live_identity,m.live_inputs,
          d.set_id,d.collector_number,d.display_name AS name
          FROM catalog_printing_metadata m LEFT JOIN catalog_printing_display d ON d.printing_id=m.printing_id
          WHERE m.printing_id=%s{suffix}""", (target_id,)).fetchone()
        if not row:
            return None
        reviewed = row["live_identity"] if row["state"] == "eligible" else row["live_inputs"]
        reports = conn.execute("""SELECT id FROM catalog_metadata_report WHERE target='live' AND printing_id=%s AND status=ANY(%s)
          ORDER BY created_at,id""", (target_id, list(OPEN))).fetchall()
        rejected = conn.execute("""SELECT source_fingerprint FROM catalog_metadata_rejection WHERE target='live' AND printing_id=%s
          ORDER BY source_fingerprint""", (target_id,)).fetchall()
        target = "live"
    candidate = row["candidate"] or {}
    source_fingerprint = fingerprint(candidate) if candidate else None
    report_ids = [r["id"] for r in reports]
    digest = hashlib.sha256(json.dumps({
        "target": target, "printing_id": str(row["printing_id"]), "edition_id": str(row["edition_id"]) if row["edition_id"] else None,
        "state": row["state"], "reason": row["reason"], "basis_revision": row["public_revision"],
        "mapping_revision": row["mapping_revision"], "candidate": source_fingerprint, "reviewed": reviewed,
        "reports": [str(r) for r in report_ids]}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {"kind": kind, "target": target, "printing_id": row["printing_id"], "edition_id": row["edition_id"],
            "descriptor": row["descriptor"], "set_id": row["set_id"], "collector_number": row["collector_number"],
            "name": row["name"], "state": row["state"], "reason": row["reason"], "basis_revision": row["public_revision"],
            "mapping_revision": row["mapping_revision"], "source_candidate": candidate, "source_fingerprint": source_fingerprint,
            "reviewed_value": reviewed, "report_ids": report_ids, "rejected_fingerprints": [r["source_fingerprint"] for r in rejected],
            "evidence_digest": digest, "row": row}


def item_view(loaded) -> MetadataQueueItem:
    return MetadataQueueItem(**{key: loaded[key] for key in MetadataQueueItem.model_fields})


def _cursor(value: str):
    try:
        kind, raw = base64.urlsafe_b64decode(value.encode()).decode().split(":", 1)
        if kind not in ("edition", "printing"):
            raise ValueError
        return kind, UUID(raw)
    except (ValueError, UnicodeError):
        fail(422, "INVALID_CURSOR")


@router.get("/api/admin/catalog-metadata/queue", response_model=MetadataQueuePage)
def review_queue(cursor: str | None = None, user_id: str = Depends(verified_user)):
    after = _cursor(cursor) if cursor else ("", UUID(int=0))
    with connect() as conn:
        require_owner(conn, user_id)
        rows = conn.execute("""WITH attention AS (
            SELECT 'edition'::text AS kind,edition_id AS id FROM catalog_edition_metadata
              WHERE mapping_state='quarantined' OR mapping_reason='recovery_conflict'
            UNION SELECT 'edition',edition_id FROM catalog_metadata_report WHERE target='marketplace' AND status=ANY(%s)
            UNION SELECT 'printing',printing_id FROM catalog_printing_metadata WHERE live_state='suspended' OR live_reason='recovery_conflict'
            UNION SELECT 'printing',printing_id FROM catalog_metadata_report WHERE target='live' AND status=ANY(%s))
          SELECT kind,id FROM attention WHERE kind>%s OR (kind=%s AND id>%s) ORDER BY kind,id LIMIT %s""",
                            (list(OPEN), list(OPEN), after[0], after[0], after[1], QUEUE_PAGE + 1)).fetchall()
        page = rows[:QUEUE_PAGE]
        items = [item_view(load_target(conn, row["kind"], row["id"])) for row in page]
        more = len(rows) > QUEUE_PAGE and page
        next_cursor = base64.urlsafe_b64encode(f"{page[-1]['kind']}:{page[-1]['id']}".encode()).decode() if more else None
        return MetadataQueuePage(items=items, next_cursor=next_cursor)


def _existing(conn, kind: str, target_id: UUID):
    loaded = load_target(conn, TARGET_KINDS[kind], target_id)
    if not loaded:
        fail(404, "TARGET_NOT_FOUND")
    return loaded


@router.get("/api/admin/catalog-metadata/{kind}/{target_id}", response_model=MetadataQueueItem)
def target_evidence(kind: Literal["editions", "printings"], target_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        return item_view(_existing(conn, kind, target_id))


@router.get("/api/admin/catalog-metadata/{kind}/{target_id}/history", response_model=list[MetadataDecisionRow])
def target_history(kind: Literal["editions", "printings"], target_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        loaded = _existing(conn, kind, target_id)
        clause = "d.edition_id=%s" if loaded["kind"] == "edition" else "d.printing_id=%s AND d.target='live'"
        return [MetadataDecisionRow(**{key: row[key] for key in MetadataDecisionRow.model_fields}) for row in conn.execute(
            f"""SELECT d.*,a.kind AS rule_kind,a.version AS rule_version FROM catalog_metadata_decision d
              LEFT JOIN catalog_rule_activation a ON a.id=d.rule_activation_id WHERE {clause}
              ORDER BY d.reviewed_at DESC,d.clock_revision DESC,d.id""", (target_id,)).fetchall()]


# ---------------------------------------------------------------- approval codes and delivery


def consume_metadata_code(conn, owner_id: str, target: str, action: str, code: str | None, *, spend: bool = True) -> bool:
    """Spend the newest unexpired code issued for exactly this target form and action.

    The lookup never falls back to report or review codes, and the target string is part of
    the keyed hash, so a code for one target form cannot be replayed on another. ``spend=False``
    only verifies (a wrong guess is still counted): the routes verify before taking the catalog
    clock, so a bad code never commits a bare clock bump, and spend inside the correction.
    """
    if code is None:
        fail(422, "FRESH_CODE_REQUIRED")
    challenge = conn.execute("""SELECT * FROM catalog_approval_code WHERE owner_id=%s AND metadata_target=%s AND action=%s
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE""", (owner_id, target, action)).fetchone()
    if (not challenge or challenge["consumed_at"] or challenge["attempts"] >= 3
            or challenge["expires_at"] <= datetime.now(challenge["expires_at"].tzinfo)):
        fail(403, "INVALID_APPROVAL_CODE")
    if not hmac.compare_digest(challenge["code_hash"], _code_hash(owner_id, target, action, code)):
        conn.execute("UPDATE catalog_approval_code SET attempts=attempts+1 WHERE id=%s", (challenge["id"],))
        return False
    if spend:
        conn.execute("UPDATE catalog_approval_code SET consumed_at=now() WHERE id=%s", (challenge["id"],))
    return True


def delivery_status(*, target_kind=None, target_id=None, revision=None) -> str:
    """'pending' while a dirty-target row for this change is still undelivered, read from PostgreSQL."""
    with connect() as conn:
        if revision is not None:
            pending = conn.execute("SELECT 1 FROM catalog_public_outbox WHERE revision=%s AND delivered_at IS NULL LIMIT 1", (revision,)).fetchone()
        else:
            pending = conn.execute("""SELECT 1 FROM catalog_public_outbox WHERE target_kind=%s AND target_id=%s AND delivered_at IS NULL
              LIMIT 1""", (target_kind, target_id)).fetchone()
    return "pending" if pending else "delivered"


# ---------------------------------------------------------------- decisions


class MetadataDecisionInput(BaseModel):
    target: Literal["live", "marketplace"]
    printing_id: UUID
    edition_id: UUID | None = None
    decision: Literal["verify_source", "correct", "reject_source", "unmap", "unsupported"]
    reviewed_value: dict | None = None
    # The decision binds to the exact evidence and public revision the maintainer was shown.
    basis_revision: int = Field(ge=0)
    evidence_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    evidence_url: HttpUrl
    reason: str = Field(min_length=1, max_length=2000)
    report_ids: list[UUID] = Field(default_factory=list, max_length=50)
    code: str | None = Field(default=None, pattern=r"^\d{6}$")


class MetadataDecisionResult(BaseModel):
    decision_id: UUID
    target: str
    decision: str
    state: str
    reason: str | None
    mapping_revision: int | None
    public_revision: int
    closed_report_ids: list[UUID]
    public_delivery: Literal["delivered", "pending"]


def _product_value(value) -> dict:
    """A maintainer-reviewed marketplace value: exactly {product_id, quote_variant|null}."""
    if (not isinstance(value, dict) or set(value) - {"product_id", "quote_variant"} or "product_id" not in value):
        fail(422, "INVALID_PRODUCT")
    product, variant = value["product_id"], value.get("quote_variant")
    if isinstance(product, bool) or not isinstance(product, int) or not 1 <= product <= 2**31 - 1:
        fail(422, "INVALID_PRODUCT")
    if variant is not None and (not isinstance(variant, str) or not QUOTE_VARIANT.fullmatch(variant)):
        fail(422, "INVALID_PRODUCT")
    return {"product_id": product, "quote_variant": variant}


QUOTE_VARIANT = re.compile(r"^[a-z0-9-]{1,40}$")


def _source_facts(conn, loaded):
    row = conn.execute("""SELECT p.source,p.source_id,pm.source_record FROM catalog_printing p
      LEFT JOIN catalog_printing_metadata pm ON pm.printing_id=p.id WHERE p.id=%s""", (loaded["printing_id"],)).fetchone()
    candidate = loaded["source_candidate"]
    display = ({"set_id": loaded["set_id"], "collector_number": loaded["collector_number"], "display_name": loaded["name"]}
               if loaded["set_id"] is not None else None)
    return {"fingerprint": loaded["source_fingerprint"], "correspondence": candidate.get("correspondence"),
            "lookup": candidate.get("candidate") or {}, "descriptor": loaded["descriptor"], "source": row["source"],
            "source_id": row["source_id"], "source_record": row["source_record"] or {}, "display": display}


def _variant_block_holds(loaded, reviewed) -> bool:
    """True when this Edition's own source variant block for the quote variant key holds the reviewed product."""
    candidate = loaded["source_candidate"]
    if not isinstance(candidate, dict) or candidate.get("correspondence") != "source_candidate":
        return False
    pricing = (candidate.get("candidate") or {}).get("pricing")
    block = pricing.get("tcgplayer") if isinstance(pricing, dict) else None
    entry = block.get(reviewed["quote_variant"]) if isinstance(block, dict) and reviewed["quote_variant"] not in MatchingRulesV1.BLOCK_METADATA else None
    product = entry.get("productId") if isinstance(entry, dict) else None
    return type(product) is int and product == reviewed["product_id"]


def plan_marketplace(conn, command: MetadataDecisionInput, loaded) -> dict:
    """Validate a marketplace decision and return the effect to apply. Raises before anything is written."""
    decision = command.decision
    if decision == "unsupported":
        fail(422, "INVALID_DECISION")
    if decision in ("verify_source", "correct") and is_unspecified(loaded["descriptor"]):
        fail(422, "UNSPECIFIED_VARIANT")
    if decision in ("reject_source", "unmap"):
        reason = "unspecified_variant" if is_unspecified(loaded["descriptor"]) else "reviewed_unmapped"
        return {"state": "unverified", "reason": reason, "product_id": None, "quote_variant": None, "checks": {},
                "reviewed": {"product_id": None, "quote_variant": None}}
    if decision == "correct":
        reviewed = _product_value(command.reviewed_value)
        if reviewed["quote_variant"] is not None and not _variant_block_holds(loaded, reviewed):
            # The price lookup names the source card and variant key only, so it may be published only while
            # that variant's source block really belongs to the reviewed product. Otherwise the product stands unpriced.
            reviewed = {**reviewed, "quote_variant": None}
    else:
        if not loaded["source_candidate"]:
            fail(422, "INVALID_PRODUCT")
        found = MatchingRulesV1.evaluate(_source_facts(conn, loaded), lambda product, variant: False)
        if not isinstance(found, tuple):
            fail(422, "INVALID_PRODUCT")
        reviewed = {"product_id": found[0], "quote_variant": found[1]}
    if verified_elsewhere(conn, loaded["printing_id"], loaded["edition_id"])(reviewed["product_id"], reviewed["quote_variant"]):
        fail(409, "MAPPING_CONFLICT")
    return {"state": "verified", "reason": None, **reviewed, "reviewed": reviewed,
            "checks": {"printing": "passed", "product": "passed", "variant": "passed" if reviewed["quote_variant"] else "not_established"}}


def plan_live(conn, command: MetadataDecisionInput, loaded, context: TargetContext) -> dict:
    decision = command.decision
    if decision in ("reject_source", "unmap", "unsupported"):
        return {"state": "unsupported", "reviewed": {}, "checks": {}, "inputs": None}
    if context.live is None:
        fail(409, "NO_ACTIVE_RULE")
    if decision == "correct":
        inputs = command.reviewed_value
        if not isinstance(inputs, dict) or set(inputs) - set(LIVE_PROPOSAL_KEYS):
            fail(422, "INVALID_LIVE_INPUT")
        derived = context.live.rule.derive_reviewed(inputs)
    else:
        export = loaded["source_candidate"]
        display = ({"set_id": loaded["set_id"], "collector_number": loaded["collector_number"], "display_name": loaded["name"]}
                   if loaded["set_id"] is not None else None)
        derived = context.live.rule.derive_source(export, display)
    if not isinstance(derived, dict):
        fail(422, "INVALID_LIVE_INPUT")
    inputs = {"category": derived["category"], "name": derived["name"], "set_code": derived["set_code"],
              "collector_number": derived["number"]}
    return {"state": "eligible", "reviewed": inputs, "checks": {}, "inputs": inputs}


def _closable_reports(conn, command: MetadataDecisionInput):
    ids = list(dict.fromkeys(command.report_ids))
    if not ids:
        return []
    rows = conn.execute("SELECT * FROM catalog_metadata_report WHERE id=ANY(%s) ORDER BY id FOR UPDATE", (ids,)).fetchall()
    if len(rows) != len(ids) or any(
            row["status"] not in OPEN or row["target"] != command.target or row["printing_id"] != command.printing_id
            or (command.target == "marketplace" and row["edition_id"] != command.edition_id) for row in rows):
        fail(422, "INVALID_REPORT")
    return ids


@router.post("/api/admin/catalog-metadata/decisions", response_model=MetadataDecisionResult)
def decide(command: MetadataDecisionInput, user_id: str = Depends(verified_user)):
    reason = " ".join(command.reason.split())
    if not reason:
        fail(422, "REASON_REQUIRED")
    if command.target == "marketplace" and command.edition_id is None:
        fail(422, "EDITION_REQUIRED")
    if command.target == "live" and command.edition_id is not None:
        fail(422, "EDITION_NOT_ALLOWED")
    kind = "edition" if command.target == "marketplace" else "printing"
    target_id = command.edition_id or command.printing_id
    bad_code = False
    # A wrong code is decided before the clock is taken, so it commits only its attempt count.
    with connect() as conn, conn.transaction():
        require_owner(conn, user_id)
        known = consume_metadata_code(conn, user_id, f"{kind}:{target_id}", "resolve_metadata", command.code, spend=False)
    if not known:
        fail(403, "INVALID_APPROVAL_CODE")
    try:
        with connect() as conn, conn.transaction():
            require_owner(conn, user_id)
            conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
            # Lock order: the commit-ordered clock, then the metadata row.
            conn.execute("SELECT catalog_begin_correction()")
            loaded = load_target(conn, kind, target_id, lock=True)
            if not loaded:
                fail(404, "TARGET_NOT_FOUND")
            if loaded["printing_id"] != command.printing_id:
                fail(422, "EDITION_PRINTING_MISMATCH")
            if (command.basis_revision != loaded["basis_revision"]
                    or not hmac.compare_digest(command.evidence_digest, loaded["evidence_digest"])):
                fail(409, "METADATA_EVIDENCE_CHANGED")
            context = TargetContext(conn)
            plan = plan_marketplace(conn, command, loaded) if kind == "edition" else plan_live(conn, command, loaded, context)
            closing = _closable_reports(conn, command)
            validating = context.matching if kind == "edition" else context.live
            if not consume_metadata_code(conn, user_id, f"{kind}:{target_id}", "resolve_metadata", command.code):
                bad_code = True
            else:
                revision = conn.execute("SELECT catalog_begin_correction() AS revision").fetchone()["revision"]
                source_fingerprint = loaded["source_fingerprint"]
                decision_id = conn.execute("""INSERT INTO catalog_metadata_decision(target,printing_id,edition_id,decision,reviewed_value,
                  source_value,source_fingerprint,checks,basis_revision,evidence_url,reason,reviewer_id,clock_revision,rule_activation_id)
                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                                           (command.target, command.printing_id, command.edition_id, command.decision,
                                            json.dumps(plan["reviewed"]), json.dumps(loaded["source_candidate"]) if source_fingerprint else None,
                                            source_fingerprint, json.dumps(plan["checks"]), command.basis_revision,
                                            str(command.evidence_url), reason, user_id, revision,
                                            validating.activation_id if validating else None)).fetchone()["id"]
                if source_fingerprint and command.decision != "verify_source":
                    conn.execute("""INSERT INTO catalog_metadata_rejection(target,printing_id,edition_id,source_fingerprint,decision_id)
                      VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                                 (command.target, command.printing_id, command.edition_id, source_fingerprint, decision_id))
                if kind == "edition":
                    candidate = loaded["source_candidate"]
                    projection = (fingerprint(MatchingRulesV1.projection(candidate.get("correspondence"), candidate.get("candidate") or {}))
                                  if source_fingerprint else None)
                    apply_marketplace(conn, context, target_id, plan, decision_id, source_fingerprint, projection)
                else:
                    apply_live(conn, context, target_id, plan, decision_id)
                if closing:
                    conn.execute("""UPDATE catalog_metadata_report SET status=%s,review_reason=%s,reviewer_id=%s,reviewed_at=now(),
                      decision_id=%s,updated_at=now() WHERE id=ANY(%s)""",
                                 ("approved" if command.decision in ("verify_source", "correct") else "rejected", reason, user_id,
                                  decision_id, closing))
                final = load_target(conn, kind, target_id)
    except psycopg.errors.LockNotAvailable:
        fail(409, "CATALOG_BUSY")
    except psycopg.errors.UniqueViolation:
        fail(409, "MAPPING_CONFLICT")
    if bad_code:
        fail(403, "INVALID_APPROVAL_CODE")
    # The decision is committed; delivery to the public store is best effort and recoverable from the outbox.
    public_catalog.publish_catalog_best_effort(printing_ids=[command.printing_id])
    return MetadataDecisionResult(decision_id=decision_id, target=command.target, decision=command.decision, state=final["state"],
                          reason=final["reason"], mapping_revision=final["mapping_revision"], public_revision=final["basis_revision"],
                          closed_report_ids=closing,
                          public_delivery=delivery_status(target_kind=kind, target_id=target_id))


def apply_marketplace(conn, context, edition_id, plan, decision_id, source_fingerprint, source_projection=None):
    verified = plan["state"] == "verified"
    try:
        with conn.transaction():  # a savepoint, so a lost price-slot race is a clean 409 rather than an aborted transaction
            conn.execute("""UPDATE catalog_edition_metadata SET mapping_state=%s,mapping_reason=%s,product_id=%s,quote_variant=%s,
              mapping_basis=%s,mapping_decision_id=%s,matching_activation_id=NULL,accepted_fingerprint=%s,accepted_projection=%s,
              auto_closed=true,mapping_revision=mapping_revision+1,updated_at=now() WHERE edition_id=%s""",
                         (plan["state"], plan["reason"], plan["product_id"], plan["quote_variant"], "maintainer" if verified else None,
                          decision_id, source_fingerprint if verified else None, source_projection if verified else None, edition_id))
    except psycopg.errors.UniqueViolation:
        fail(409, "MAPPING_CONFLICT")
    refresh_editions(conn, context, [edition_id])


def apply_live(conn, context, printing_id, plan, decision_id):
    if plan["state"] == "unsupported":
        conn.execute("""UPDATE catalog_printing_metadata SET live_state='unsupported',live_reason='reviewed_unsupported',live_basis=NULL,
          live_inputs=NULL,live_identity=NULL,live_claim=NULL,live_decision_id=%s,live_activation_id=NULL,live_accepted_fingerprint=NULL,
          live_accepted_projection=NULL,live_auto_closed=true,updated_at=now() WHERE printing_id=%s""", (decision_id, printing_id))
        return
    conn.execute("UPDATE catalog_printing_metadata SET live_inputs=%s,live_decision_id=%s,updated_at=now() WHERE printing_id=%s",
                 (json.dumps(plan["inputs"]), decision_id, printing_id))
    refresh_printing(conn, context, printing_id, reviewed=True)
    state = conn.execute("SELECT live_state,live_reason FROM catalog_printing_metadata WHERE printing_id=%s", (printing_id,)).fetchone()
    if state["live_state"] != "eligible":
        fail(409, "LIVE_CONFLICT")


# ---------------------------------------------------------------- rule activation


class RuleVersionView(BaseModel):
    version: int
    code_digest: str


class ActiveRuleView(BaseModel):
    activation_id: UUID
    version: int | None
    activated_at: datetime
    evidence_url: str
    reason: str
    # False when the code changed after approval; the rule is then inactive until re-approved.
    digest_current: bool


class MetadataRuleView(BaseModel):
    kind: Literal["live_derivation", "marketplace_matching"]
    versions: list[RuleVersionView]
    active: ActiveRuleView | None


class MetadataRuleActivation(BaseModel):
    version: int | None = Field(default=None, ge=1, le=999_999)
    evidence_url: HttpUrl
    reason: str = Field(min_length=1, max_length=2000)
    code: str | None = Field(default=None, pattern=r"^\d{6}$")


class MetadataRuleResult(BaseModel):
    kind: str
    version: int | None
    printings: int
    editions: int
    public_revision: int
    public_delivery: Literal["delivered", "pending"]


@router.get("/api/admin/catalog-rules", response_model=list[MetadataRuleView])
def rules(user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        views = []
        for kind in (LIVE, MATCHING):
            row = conn.execute("""SELECT a.id,a.version,a.code_digest,a.activated_at,a.evidence_url,a.reason FROM catalog_rule_state s
              JOIN catalog_rule_activation a ON a.id=s.activation_id WHERE s.kind=%s""", (kind,)).fetchone()
            active = None
            if row:
                current = row["version"] is not None and row["version"] in REGISTRIES[kind] and code_digest(kind, row["version"]) == row["code_digest"]
                active = ActiveRuleView(activation_id=row["id"], version=row["version"], activated_at=row["activated_at"],
                                        evidence_url=row["evidence_url"], reason=row["reason"], digest_current=current or row["version"] is None)
            views.append(MetadataRuleView(kind=kind, active=active, versions=[
                RuleVersionView(version=version, code_digest=code_digest(kind, version)) for version in sorted(REGISTRIES[kind])]))
        return views


@router.post("/api/admin/catalog-rules/{kind}/activate", response_model=MetadataRuleResult)
def activate(kind: Literal["live_derivation", "marketplace_matching"], command: MetadataRuleActivation,
             user_id: str = Depends(verified_user)):
    reason = " ".join(command.reason.split())
    if not reason:
        fail(422, "REASON_REQUIRED")
    bad_code = False
    target = f"rule:{kind}:{command.version or 0}"  # Deactivation names version 0, which a real version never equals.
    with connect() as conn, conn.transaction():
        require_owner(conn, user_id)
        if command.version is not None and command.version not in REGISTRIES[kind]:
            fail(422, "UNKNOWN_RULE_VERSION")
        known = consume_metadata_code(conn, user_id, target, "activate_rule", command.code, spend=False)
    if not known:
        fail(403, "INVALID_APPROVAL_CODE")  # before the clock: a wrong code commits only its attempt count
    try:
        with connect() as conn, conn.transaction():
            require_owner(conn, user_id)
            conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
            revision = conn.execute("SELECT catalog_begin_correction() AS revision").fetchone()["revision"]
            conn.execute("SELECT 1 FROM catalog_rule_state WHERE kind=%s FOR UPDATE", (kind,))
            if not consume_metadata_code(conn, user_id, target, "activate_rule", command.code):
                bad_code = True
            else:
                changed = activate_rule(conn, kind, command.version, user_id, str(command.evidence_url), reason)
    except psycopg.errors.LockNotAvailable:
        fail(409, "CATALOG_BUSY")
    if bad_code:
        fail(403, "INVALID_APPROVAL_CODE")
    public_catalog.publish_catalog_best_effort()
    return MetadataRuleResult(kind=kind, version=command.version, printings=changed["printings"], editions=changed["editions"],
                              public_revision=revision, public_delivery=delivery_status(revision=revision))
