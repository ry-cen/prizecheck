"""Collector reports and maintainer-reviewed corrections of one Card Printing's card attributes.

Reports are unapproved input: they write one report row and nothing else. Only the owner (the catalog maintainer)
changes a Printing's attributes, through a decision that consumes a fresh approval code issued for that Printing and
the ``correct_attributes`` action, binds to the evidence the maintainer was shown, takes the commit-ordered public
clock (as every catalog correction does, so it serializes with imports) and advances the attribute revision once.

A correction is per attribute and replaces derivation for exactly the attributes it sets, until a later decision
replaces or removes it; re-derivation on import never touches it. A decision states the Printing's whole correction:
``correct`` replaces the stored correction with the given values and ``remove`` deletes it. A correction sets known
values only; there is no "corrected to unknown". Manually approved Printings have no derived attributes, so a
correction is their only source. Effective attributes are public format facts (Deck Lists 18): writing or removing a
correction re-stamps the Printing at the decision's public revision and enqueues it (migration 036's trigger), and the
decision delivers it after its commit and reports ``public_delivery``, like a metadata decision.
"""
import hashlib
import hmac
import json
from dataclasses import asdict
from datetime import datetime
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, HttpUrl, field_validator

from .card_attributes import ATTRIBUTE_COLUMNS, SOURCE_FIELDS, CardAttributes, advance_attribute_revision, \
    attribute_revision
from .holdings import fail
from .main import connect, require_owner, verified_user
from .metadata_reviews import consume_metadata_code, delivery_status
from .public_catalog import publish_catalog_best_effort

router = APIRouter()

ACTION = "correct_attributes"
LOCK_TIMEOUT = "5s"
OPEN_REPORT_LIMIT = 25
QUEUE_PAGE = 100
OPEN = ("pending", "needs_info")
POKEMON_TYPES = ("Grass", "Fire", "Water", "Lightning", "Psychic", "Fighting", "Darkness", "Metal", "Fairy", "Dragon",
                 "Colorless")
PokemonType = Literal["Grass", "Fire", "Water", "Lightning", "Psychic", "Fighting", "Darkness", "Metal", "Fairy",
                      "Dragon", "Colorless"]


class AttributeValues(BaseModel):
    """Card attributes. In a report or correction, null means "not stated"; in effective attributes, unknown."""
    model_config = {"extra": "forbid", "strict": True}
    regulation_mark: str | None = Field(default=None, pattern=r"^[A-Z]$")
    card_kind: Literal["pokemon", "trainer", "energy"] | None = None
    basic_energy: bool | None = None
    # Pokémon types in printed order; an empty list for a Trainer or Energy card.
    types: list[PokemonType] | None = Field(default=None, max_length=11)
    rule_box: bool | None = None
    ace_spec: bool | None = None
    radiant: bool | None = None
    prism_star: bool | None = None
    basic_pokemon: bool | None = None

    @field_validator("types")
    @classmethod
    def distinct_types(cls, value):
        if value is not None and len(set(value)) != len(value):
            raise ValueError("types must not repeat")
        return value

    def stated(self) -> dict:
        """Only the attributes this value sets, in column order."""
        return {key: value for key, value in self.model_dump().items() if value is not None}


def _values(attributes: CardAttributes | None) -> AttributeValues | None:
    if attributes is None:
        return None
    values = asdict(attributes)
    if values["types"] is not None:
        values["types"] = list(values["types"])
    return AttributeValues(**values)


def _from_row(row) -> CardAttributes | None:
    if row is None:
        return None
    values = {column: row[column] for column in ATTRIBUTE_COLUMNS}
    if values["types"] is not None:
        values["types"] = tuple(values["types"])
    return CardAttributes(**values)


def _from_stated(stated: dict) -> CardAttributes:
    values = {column: stated.get(column) for column in ATTRIBUTE_COLUMNS}
    if values["types"] is not None:
        values["types"] = tuple(values["types"])
    return CardAttributes(**values)


def effective(derived: CardAttributes | None, correction: CardAttributes | None) -> CardAttributes:
    """What ``catalog_card_attribute`` returns: each corrected attribute over the derived one."""
    base = asdict(derived) if derived else {}
    over = asdict(correction) if correction else {}
    return CardAttributes(**{column: over.get(column) if over.get(column) is not None else base.get(column)
                             for column in ATTRIBUTE_COLUMNS})


def consistent(attributes: CardAttributes) -> bool:
    """Combinations no real card has. Unknown values never conflict."""
    kind = attributes.card_kind
    if attributes.types and kind in ("trainer", "energy"):
        return False
    if attributes.basic_energy is True and (kind not in (None, "energy") or attributes.ace_spec is True):
        return False
    if attributes.radiant is True and kind not in (None, "pokemon"):
        return False
    if attributes.ace_spec is True and kind == "pokemon":
        return False
    if attributes.basic_pokemon is True and (kind not in (None, "pokemon") or attributes.basic_energy is True
                                             or attributes.ace_spec is True):
        return False
    return True


# ---------------------------------------------------------------- reports


class AttributeReportInput(BaseModel):
    printing_id: UUID
    proposed: AttributeValues
    evidence_url: HttpUrl | None = Field(default=None, max_length=2048)  # the report table's CHECK
    note: str = Field(default="", max_length=2000)


class AttributeReportView(BaseModel):
    id: UUID
    printing_id: UUID
    proposed: dict
    evidence_url: str | None
    note: str
    status: str
    review_reason: str | None
    created_at: datetime
    updated_at: datetime


class AttributeReportUpdate(BaseModel):
    note: str = Field(min_length=1, max_length=2000)
    evidence_url: HttpUrl | None = Field(default=None, max_length=2048)  # the report table's CHECK


class AttributeReportDecision(BaseModel):
    decision: Literal["needs_info", "reject"]
    reason: str = Field(min_length=1, max_length=2000)


def _report_view(row) -> AttributeReportView:
    return AttributeReportView(**{key: row[key] for key in AttributeReportView.model_fields})


@router.post("/api/catalog/attribute-reports", response_model=AttributeReportView, status_code=201)
def submit_report(payload: AttributeReportInput, user_id: str = Depends(verified_user)):
    proposed = payload.proposed.stated()
    if not proposed:
        fail(422, "EMPTY_PROPOSAL")
    with connect() as conn, conn.transaction():
        # Serialize one reporter's submissions so the open-report cap cannot be raced past.
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user_id,))
        conn.execute("SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE", (user_id,))
        if not conn.execute("SELECT 1 FROM catalog_printing WHERE id=%s", (payload.printing_id,)).fetchone():
            fail(404, "PRINTING_NOT_FOUND")
        open_count = conn.execute("SELECT count(*) AS n FROM catalog_attribute_report WHERE reporter_id=%s AND status=ANY(%s)",
                                  (user_id, list(OPEN))).fetchone()["n"]
        if open_count >= OPEN_REPORT_LIMIT:
            fail(429, "REPORT_LIMIT")
        row = conn.execute("""INSERT INTO catalog_attribute_report(reporter_id,printing_id,proposed,evidence_url,note)
          VALUES (%s,%s,%s,%s,%s) RETURNING *""",
                           (user_id, payload.printing_id, json.dumps(proposed),
                            str(payload.evidence_url) if payload.evidence_url else None, payload.note.strip())).fetchone()
        return _report_view(row)


@router.get("/api/catalog/attribute-reports", response_model=list[AttributeReportView])
def my_reports(user_id: str = Depends(verified_user)):
    with connect() as conn:
        return [_report_view(row) for row in conn.execute("""SELECT * FROM catalog_attribute_report WHERE reporter_id=%s
          ORDER BY created_at DESC,id DESC LIMIT 100""", (user_id,)).fetchall()]


@router.get("/api/catalog/attribute-reports/{report_id}", response_model=AttributeReportView)
def my_report(report_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        row = conn.execute("SELECT * FROM catalog_attribute_report WHERE id=%s AND reporter_id=%s",
                           (report_id, user_id)).fetchone()
        if not row:
            fail(404, "REPORT_NOT_FOUND")
        return _report_view(row)


@router.patch("/api/catalog/attribute-reports/{report_id}", response_model=AttributeReportView)
def answer_report(report_id: UUID, payload: AttributeReportUpdate, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        row = conn.execute("""UPDATE catalog_attribute_report SET note=%s,evidence_url=COALESCE(%s,evidence_url),status='pending',
          updated_at=now() WHERE id=%s AND reporter_id=%s AND status='needs_info' RETURNING *""",
                           (payload.note.strip(), str(payload.evidence_url) if payload.evidence_url else None, report_id,
                            user_id)).fetchone()
        if not row:
            fail(404, "REPORT_NOT_FOUND")
        return _report_view(row)


@router.post("/api/admin/card-attributes/reports/{report_id}/decision", response_model=AttributeReportView)
def decide_report(report_id: UUID, payload: AttributeReportDecision, user_id: str = Depends(verified_user)):
    """Ask for more information or reject. Neither changes any attribute, so no code is needed."""
    with connect() as conn, conn.transaction():
        require_owner(conn, user_id)
        report = conn.execute("SELECT * FROM catalog_attribute_report WHERE id=%s FOR UPDATE", (report_id,)).fetchone()
        if not report:
            fail(404, "REPORT_NOT_FOUND")
        if report["status"] not in OPEN:
            fail(409, "ALREADY_REVIEWED")
        reason = " ".join(payload.reason.split())
        if not reason:
            fail(422, "REASON_REQUIRED")
        if payload.decision == "reject":
            row = conn.execute("""UPDATE catalog_attribute_report SET status='rejected',review_reason=%s,reviewer_id=%s,
              reviewed_at=now(),updated_at=now() WHERE id=%s RETURNING *""", (reason, user_id, report_id)).fetchone()
        else:  # The CHECK reserves reviewer columns for closed reports.
            row = conn.execute("""UPDATE catalog_attribute_report SET status='needs_info',review_reason=%s,updated_at=now()
              WHERE id=%s RETURNING *""", (reason, report_id)).fetchone()
        return _report_view(row)


# ---------------------------------------------------------------- evidence, queue and history


class AttributeEvidence(BaseModel):
    printing_id: UUID
    source: str
    source_id: str | None
    set_id: str | None
    collector_number: str | None
    name: str | None
    # The source fields the derivation rules read; null for a Printing without a source record.
    source_fields: dict | None
    derived: AttributeValues | None
    rules_version: int | None
    correction: AttributeValues | None
    correction_decision_id: UUID | None
    effective: AttributeValues
    reports: list[AttributeReportView]
    report_ids: list[UUID]
    attribute_revision: int
    evidence_digest: str


class AttributeQueuePage(BaseModel):
    items: list[AttributeEvidence]
    next_cursor: UUID | None


class AttributeDecisionRow(BaseModel):
    id: UUID
    printing_id: UUID
    decision: str
    correction: dict
    previous_correction: dict | None
    derived: dict | None
    rules_version: int | None
    evidence_url: str
    reason: str
    reviewer_id: str
    reviewed_at: datetime
    clock_revision: int
    attribute_revision: int


def load_evidence(conn, printing_id: UUID, lock: bool = False):
    """Everything the maintainer is shown for one Printing, from PostgreSQL.

    ``lock`` (the decision path) holds the derived row FOR SHARE and the open reports FOR UPDATE until commit. Lock order
    in a decision: public clock, derived row, reports, approval code, attribute revision. Re-derivation writes derived
    rows and then the attribute revision and never waits for a lock a decision takes later, so the orders don't invert.
    """
    row = conn.execute("""SELECT p.id,p.source,p.source_id,d.set_id,d.collector_number,d.display_name,
        CASE WHEN p.source = 'tcgdex' AND jsonb_typeof(m.source_record) = 'object' THEN
          (SELECT coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb) FROM jsonb_each(m.source_record) f
           WHERE f.key = ANY(%s)) END AS source_fields
      FROM catalog_printing p LEFT JOIN catalog_printing_display d ON d.printing_id=p.id
      LEFT JOIN catalog_printing_metadata m ON m.printing_id=p.id WHERE p.id=%s""",
                       (list(SOURCE_FIELDS), printing_id)).fetchone()
    if not row:
        return None
    # Under ``lock`` the derived row is held FOR SHARE until commit: a concurrent re-derivation of this Printing either
    # commits first (and the digest no longer matches) or waits, so a decision never records a stale derived snapshot.
    derived_row = conn.execute(f"SELECT * FROM catalog_derived_attribute WHERE printing_id=%s{' FOR SHARE' if lock else ''}",
                               (printing_id,)).fetchone()
    correction_row = conn.execute("SELECT * FROM catalog_attribute_correction WHERE printing_id=%s",
                                  (printing_id,)).fetchone()
    reports = [_report_view(r) for r in conn.execute(
        f"""SELECT * FROM catalog_attribute_report WHERE printing_id=%s AND status=ANY(%s)
          ORDER BY created_at,id{' FOR UPDATE' if lock else ''}""", (printing_id, list(OPEN))).fetchall()]
    derived, correction = _from_row(derived_row), _from_row(correction_row)
    source_fields = row["source_fields"]
    shown = {"printing_id": str(printing_id), "source": row["source"], "source_id": row["source_id"],
             "source_fields": source_fields,
             "derived": asdict(derived) if derived else None,
             "rules_version": derived_row["rules_version"] if derived_row else None,
             "correction": asdict(correction) if correction else None,
             "correction_decision_id": str(correction_row["decision_id"]) if correction_row else None,
             "reports": [r.model_dump(mode="json") for r in reports]}
    digest = hashlib.sha256(json.dumps(shown, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {"printing_id": row["id"], "source": row["source"], "source_id": row["source_id"], "set_id": row["set_id"],
            "collector_number": row["collector_number"], "name": row["display_name"], "source_fields": source_fields,
            "derived": derived, "derived_values": _values(derived),
            "rules_version": derived_row["rules_version"] if derived_row else None,
            "correction": correction, "correction_values": _values(correction),
            "correction_decision_id": correction_row["decision_id"] if correction_row else None,
            "effective": effective(derived, correction), "reports": reports, "report_ids": [r.id for r in reports],
            "evidence_digest": digest}


def evidence_view(conn, loaded) -> AttributeEvidence:
    return AttributeEvidence(
        printing_id=loaded["printing_id"], source=loaded["source"], source_id=loaded["source_id"],
        set_id=loaded["set_id"], collector_number=loaded["collector_number"], name=loaded["name"],
        source_fields=loaded["source_fields"], derived=loaded["derived_values"], rules_version=loaded["rules_version"],
        correction=loaded["correction_values"], correction_decision_id=loaded["correction_decision_id"],
        effective=_values(loaded["effective"]), reports=loaded["reports"], report_ids=loaded["report_ids"],
        attribute_revision=attribute_revision(conn), evidence_digest=loaded["evidence_digest"])


@router.get("/api/admin/card-attributes/queue", response_model=AttributeQueuePage)
def review_queue(cursor: UUID | None = None, user_id: str = Depends(verified_user)):
    """Printings with open reports, and manual Printings that have no correction yet, by Printing ID."""
    with connect() as conn:
        require_owner(conn, user_id)
        rows = conn.execute("""WITH attention AS (
            SELECT printing_id AS id FROM catalog_attribute_report WHERE status=ANY(%s)
            UNION SELECT p.id FROM catalog_printing p WHERE p.source='manual'
              AND NOT EXISTS (SELECT 1 FROM catalog_attribute_correction c WHERE c.printing_id=p.id)
              AND NOT EXISTS (SELECT 1 FROM catalog_printing_replacement r WHERE r.printing_id=p.id))
          SELECT id FROM attention WHERE id>%s ORDER BY id LIMIT %s""",
                            (list(OPEN), cursor or UUID(int=0), QUEUE_PAGE + 1)).fetchall()
        page = rows[:QUEUE_PAGE]
        items = [evidence_view(conn, load_evidence(conn, row["id"])) for row in page]
        return AttributeQueuePage(items=items, next_cursor=page[-1]["id"] if len(rows) > QUEUE_PAGE else None)


@router.get("/api/admin/card-attributes/{printing_id}", response_model=AttributeEvidence)
def printing_evidence(printing_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        loaded = load_evidence(conn, printing_id)
        if not loaded:
            fail(404, "PRINTING_NOT_FOUND")
        return evidence_view(conn, loaded)


@router.get("/api/admin/card-attributes/{printing_id}/history", response_model=list[AttributeDecisionRow])
def printing_history(printing_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        if not conn.execute("SELECT 1 FROM catalog_printing WHERE id=%s", (printing_id,)).fetchone():
            fail(404, "PRINTING_NOT_FOUND")
        return [AttributeDecisionRow(**{key: row[key] for key in AttributeDecisionRow.model_fields}) for row in conn.execute(
            """SELECT * FROM catalog_attribute_decision WHERE printing_id=%s
              ORDER BY reviewed_at DESC,attribute_revision DESC,id""", (printing_id,)).fetchall()]


# ---------------------------------------------------------------- decisions


class AttributeDecisionInput(BaseModel):
    printing_id: UUID
    decision: Literal["correct", "remove"]
    # The Printing's whole correction after a ``correct`` decision; omitted for ``remove``.
    correction: AttributeValues | None = None
    # The decision binds to the exact evidence the maintainer was shown.
    evidence_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    evidence_url: HttpUrl
    reason: str = Field(min_length=1, max_length=2000)
    report_ids: list[UUID] = Field(default_factory=list, max_length=50)
    code: str | None = Field(default=None, pattern=r"^\d{6}$")


class AttributeDecisionResult(BaseModel):
    decision_id: UUID
    printing_id: UUID
    decision: str
    correction: AttributeValues | None
    effective: AttributeValues
    attribute_revision: int
    closed_report_ids: list[UUID]
    # Whether the Printing's public format facts reached the shared records store; "pending" ones are delivered by
    # the next drain or scripts/backfill_public_catalog.py.
    public_delivery: Literal["delivered", "pending"]


def _closable_reports(conn, command: AttributeDecisionInput):
    ids = list(dict.fromkeys(command.report_ids))
    if not ids:
        return []
    rows = conn.execute("SELECT * FROM catalog_attribute_report WHERE id=ANY(%s) ORDER BY id FOR UPDATE", (ids,)).fetchall()
    if len(rows) != len(ids) or any(row["status"] not in OPEN or row["printing_id"] != command.printing_id for row in rows):
        fail(422, "INVALID_REPORT")
    return ids


@router.post("/api/admin/card-attributes/decisions", response_model=AttributeDecisionResult)
def decide(command: AttributeDecisionInput, user_id: str = Depends(verified_user)):
    reason = " ".join(command.reason.split())
    if not reason:
        fail(422, "REASON_REQUIRED")
    if command.decision == "correct":
        stated = command.correction.stated() if command.correction else {}
        if not stated:
            fail(422, "EMPTY_CORRECTION")
    else:
        if command.correction is not None:
            fail(422, "CORRECTION_NOT_ALLOWED")
        stated = {}
    target = f"printing:{command.printing_id}"
    bad_code = False
    # A wrong code is decided before the clock is taken, so it commits only its attempt count.
    with connect() as conn, conn.transaction():
        require_owner(conn, user_id)
        known = consume_metadata_code(conn, user_id, target, ACTION, command.code, spend=False)
    if not known:
        fail(403, "INVALID_APPROVAL_CODE")
    try:
        with connect() as conn, conn.transaction():
            require_owner(conn, user_id)
            conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
            # Lock order, as in a catalog import: the commit-ordered public clock first, the attribute revision last.
            clock = conn.execute("SELECT catalog_begin_correction() AS revision").fetchone()["revision"]
            loaded = load_evidence(conn, command.printing_id, lock=True)
            if not loaded:
                fail(404, "PRINTING_NOT_FOUND")
            if not hmac.compare_digest(command.evidence_digest, loaded["evidence_digest"]):
                fail(409, "ATTRIBUTE_EVIDENCE_CHANGED")
            if command.decision == "remove" and loaded["correction"] is None:
                fail(422, "NO_CORRECTION")
            correction = _from_stated(stated) if stated else None
            result = effective(loaded["derived"], correction)
            if not consistent(result):
                fail(422, "INCONSISTENT_ATTRIBUTES")
            closing = _closable_reports(conn, command)
            if not consume_metadata_code(conn, user_id, target, ACTION, command.code):
                bad_code = True
            else:
                revision = advance_attribute_revision(conn)
                previous = loaded["correction_values"].stated() if loaded["correction"] else None
                derived = loaded["derived_values"].model_dump() if loaded["derived"] else None
                decision_id = conn.execute("""INSERT INTO catalog_attribute_decision(printing_id,decision,correction,
                  previous_correction,derived,rules_version,evidence_digest,evidence_url,reason,reviewer_id,clock_revision,
                  attribute_revision) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                                           (command.printing_id, command.decision, json.dumps(stated),
                                            json.dumps(previous) if previous is not None else None,
                                            json.dumps(derived) if derived is not None else None, loaded["rules_version"],
                                            loaded["evidence_digest"], str(command.evidence_url), reason, user_id, clock,
                                            revision)).fetchone()["id"]
                if correction is None:
                    conn.execute("DELETE FROM catalog_attribute_correction WHERE printing_id=%s", (command.printing_id,))
                else:
                    columns = ", ".join(ATTRIBUTE_COLUMNS)
                    updates = ", ".join(f"{column} = EXCLUDED.{column}" for column in ATTRIBUTE_COLUMNS)
                    conn.execute(f"""INSERT INTO catalog_attribute_correction (printing_id, {columns}, decision_id)
                      VALUES (%s, {", ".join(["%s"] * len(ATTRIBUTE_COLUMNS))}, %s)
                      ON CONFLICT (printing_id) DO UPDATE SET {updates}, decision_id = EXCLUDED.decision_id,
                      updated_at = now()""",
                                 (command.printing_id, *(stated.get(column) for column in ATTRIBUTE_COLUMNS), decision_id))
                if closing:
                    conn.execute("""UPDATE catalog_attribute_report SET status='approved',review_reason=%s,reviewer_id=%s,
                      reviewed_at=now(),decision_id=%s,updated_at=now() WHERE id=ANY(%s)""",
                                 (reason, user_id, decision_id, closing))
    except psycopg.errors.LockNotAvailable:
        fail(409, "CATALOG_BUSY")
    if bad_code:
        fail(403, "INVALID_APPROVAL_CODE")
    # Committed. The Printing's public records are a derived copy: delivery is best effort and recoverable.
    publish_catalog_best_effort(printing_ids=[command.printing_id])
    return AttributeDecisionResult(decision_id=decision_id, printing_id=command.printing_id, decision=command.decision,
                                   correction=_values(correction), effective=_values(result),
                                   attribute_revision=revision, closed_report_ids=closing,
                                   public_delivery=delivery_status(target_kind="printing",
                                                                   target_id=command.printing_id))
