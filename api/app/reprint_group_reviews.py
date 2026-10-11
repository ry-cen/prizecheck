"""Maintainer-reviewed Reprint Groups and Card Identity merges (Deck Lists 14).

Automatic Reprint Groups (``app.reprint_groups``) only join printings whose rules text is exactly equal. The maintainer
merges reworded or errata'd printings into one group (the handbook's Copycat CES 127 and TRR 83, or Rare Candy sm1-129
and me01-125), splits a wrong group, lets a manually approved Printing join a group (its only way into one), and merges
Card Identities that the subtitle rule misses. As for card attribute corrections (``app.attribute_corrections``), only
the owner changes these: each decision spends a fresh approval code issued for the Card Identity and this module's
action, binds to the evidence the maintainer was shown, takes the commit-ordered public clock (so it serializes with
catalog imports), advances the attribute revision once and is recorded append-only. There are no collector reports.

Every decision concerns one Card Identity, since Reprint Groups never span identities. Reviewed records name Printings
(migration 033), so they survive re-imports, re-derivation and renamed derived groups:

- ``merge`` puts every Printing of one group into another. Each member's derived group is linked to the target, so a
  reprint with either wording imported later joins the merged group too; members held by an assignment move with it.
- ``split`` moves the named Printings of one group into a new group of their own, by assignment.
- ``join`` puts the named Printings into a group by assignment. Manually approved Printings join groups only this way.
  A TCGdex Printing joins only while it derives a group of its own (it is held, not withdrawn, and has rules text).

An assignment applies only to a Printing that derives a group or to a manual Printing (migration 033). A withdrawn
TCGdex Printing leaves its reviewed group like any other, so private and published format checks never count it, and
rejoins it if a later import holds it again.
- ``restore`` removes the named Printings' links and assignments, returning them to derivation. A derived group stays
  in a reviewed group while any of its Printings is still linked, so undoing a merge restores every linked member of
  the merged-in group; removing the last link also returns the unnamed Printings that followed it. The result lists
  every Printing whose group changed, and a decision that would change no Printing's group is refused.

A Card Identity merge moves every Printing of one identity to another, which keeps its ID, key and name. Holdings,
Editions, Deck List lines and Published Deck snapshots reference Editions or Printings, never identities, so none of
them changes. The merged identity keeps its row with ``merged_into`` set, so later imports and manual approvals with
its key join the survivor. A database trigger gives a new Printing the surviving identity even when an older release
creates it. A merge is refused while the merged identity has reviewed group records: the maintainer restores them
first and reviews the merged groups again. A merge of an identity without Printings still advances both revisions. A
Printing with a pending name or reference review keeps its derived group, whose ID still names the merged identity,
until the review resolves and the next import or re-derivation regroups it.

Each decision reports ``affected_printing_ids``, the Printings whose effective group or Card Identity changed. Their
public format facts (Deck Lists 18) change with them: every such change is a row write on
``catalog_reprint_group_membership`` or an UPDATE of ``catalog_printing.identity_id``, whose triggers (migrations 032
and 033) re-stamp and enqueue the Printings concerned and the other members of their old and new groups at the
decision's public revision. The decision delivers them after its commit and reports ``public_delivery``, like an
attribute decision.
"""
import hashlib
import hmac
import json
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4, uuid5

import psycopg
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, HttpUrl

from .card_attributes import advance_attribute_revision, attribute_revision
from .holdings import fail
from .main import connect, require_owner, verified_user
from .metadata_reviews import consume_metadata_code, delivery_status
from .public_catalog import publish_catalog_best_effort
from .reprint_groups import GROUP_NAMESPACE, refresh_reprint_groups

router = APIRouter()

GROUP_ACTION = "review_reprint_groups"
IDENTITY_ACTION = "merge_card_identities"
LOCK_TIMEOUT = "5s"
QUEUE_PAGE = 100
MAX_PRINTINGS = 500
ADMIN = "/api/admin/card-identities"

# Every Printing of one Card Identity with its derived, reviewed and effective group.
PRINTINGS = """SELECT p.id AS printing_id, p.source, p.source_id, d.set_id, d.collector_number, d.display_name AS name,
    EXISTS (SELECT 1 FROM catalog_state s JOIN catalog_generation_printing gp
            ON gp.generation_id = s.active_generation AND gp.printing_id = p.id
            WHERE s.singleton AND NOT gp.tombstoned) AS in_catalog,
    dg.group_id AS derived_group_id, l.group_id AS linked_group_id, a.group_id AS assigned_group_id, m.group_id
  FROM catalog_printing p
  LEFT JOIN catalog_printing_display d ON d.printing_id = p.id
  LEFT JOIN catalog_derived_reprint_group dg ON dg.printing_id = p.id
  LEFT JOIN catalog_reprint_group_link l ON l.printing_id = p.id
  LEFT JOIN catalog_reprint_group_assignment a ON a.printing_id = p.id
  LEFT JOIN catalog_reprint_group_member m ON m.printing_id = p.id
  WHERE p.identity_id = %s
  ORDER BY d.set_id, d.collector_number, p.id"""


# ---------------------------------------------------------------- evidence, queue and history


class ReprintGroupPrinting(BaseModel):
    printing_id: UUID
    source: str
    source_id: str | None
    set_id: str | None
    collector_number: str | None
    name: str | None
    # Held by the active catalog generation and not withdrawn.
    in_catalog: bool
    derived_group_id: UUID | None
    # The reviewed group this Printing's derived group is linked to, if any.
    linked_group_id: UUID | None
    # The group this Printing is assigned to by review, if any.
    assigned_group_id: UUID | None
    # The effective group every reader sees; null for a Printing in no group.
    group_id: UUID | None


class ReprintGroupView(BaseModel):
    group_id: UUID
    printing_ids: list[UUID]


class CardIdentityEvidence(BaseModel):
    identity_id: UUID
    identity_key: str
    display_name: str
    merged_into: UUID | None
    printings: list[ReprintGroupPrinting]
    groups: list[ReprintGroupView]
    attribute_revision: int
    evidence_digest: str


class CardIdentityQueueItem(BaseModel):
    printing_id: UUID
    identity_id: UUID
    identity_name: str
    name: str | None
    set_id: str | None
    collector_number: str | None


class CardIdentityQueuePage(BaseModel):
    items: list[CardIdentityQueueItem]
    next_cursor: UUID | None


class CardIdentityDecisionRow(BaseModel):
    id: UUID
    identity_id: UUID
    decision: str
    group_id: UUID | None
    target_group_id: UUID | None
    into_identity_id: UUID | None
    printing_ids: list[UUID]
    affected_printing_ids: list[UUID]
    evidence_url: str
    reason: str
    reviewer_id: str
    reviewed_at: datetime
    clock_revision: int
    attribute_revision: int


def load_evidence(conn, identity_id: UUID):
    """Everything the maintainer is shown for one Card Identity, from PostgreSQL; None when it does not exist."""
    identity = conn.execute("SELECT id, identity_key, display_name, merged_into FROM catalog_identity WHERE id=%s",
                            (identity_id,)).fetchone()
    if not identity:
        return None
    printings = [ReprintGroupPrinting(**row) for row in conn.execute(PRINTINGS, (identity_id,)).fetchall()]
    shown = {"identity_id": str(identity["id"]), "identity_key": identity["identity_key"],
             "display_name": identity["display_name"],
             "merged_into": str(identity["merged_into"]) if identity["merged_into"] else None,
             "printings": [printing.model_dump(mode="json") for printing in printings]}
    digest = hashlib.sha256(json.dumps(shown, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    groups = {}
    for printing in printings:
        if printing.group_id is not None:
            groups.setdefault(printing.group_id, []).append(printing.printing_id)
    return {"identity": identity, "printings": printings, "groups": groups, "evidence_digest": digest}


def evidence_view(conn, loaded) -> CardIdentityEvidence:
    identity = loaded["identity"]
    return CardIdentityEvidence(
        identity_id=identity["id"], identity_key=identity["identity_key"], display_name=identity["display_name"],
        merged_into=identity["merged_into"], printings=loaded["printings"],
        groups=[ReprintGroupView(group_id=group, printing_ids=members)
                for group, members in sorted(loaded["groups"].items(), key=lambda item: str(item[0]))],
        attribute_revision=attribute_revision(conn), evidence_digest=loaded["evidence_digest"])


@router.get(f"{ADMIN}/queue", response_model=CardIdentityQueuePage)
def review_queue(cursor: UUID | None = None, user_id: str = Depends(verified_user)):
    """Manually approved Printings in no Reprint Group, by Printing ID, except replaced ones."""
    with connect() as conn:
        require_owner(conn, user_id)
        rows = conn.execute("""SELECT p.id AS printing_id, p.identity_id, ci.display_name AS identity_name,
            d.display_name AS name, d.set_id, d.collector_number
          FROM catalog_printing p JOIN catalog_identity ci ON ci.id = p.identity_id
          LEFT JOIN catalog_printing_display d ON d.printing_id = p.id
          WHERE p.source = 'manual' AND p.id > %s
            AND NOT EXISTS (SELECT 1 FROM catalog_reprint_group_member m WHERE m.printing_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM catalog_printing_replacement r WHERE r.printing_id = p.id)
          ORDER BY p.id LIMIT %s""", (cursor or UUID(int=0), QUEUE_PAGE + 1)).fetchall()
        page = rows[:QUEUE_PAGE]
        return CardIdentityQueuePage(items=[CardIdentityQueueItem(**row) for row in page],
                                     next_cursor=page[-1]["printing_id"] if len(rows) > QUEUE_PAGE else None)


@router.get(ADMIN, response_model=CardIdentityEvidence)
def printing_identity(printing_id: UUID = Query(), user_id: str = Depends(verified_user)):
    """The evidence of a Printing's Card Identity, for finding the identity of a Printing."""
    with connect() as conn:
        require_owner(conn, user_id)
        row = conn.execute("SELECT identity_id FROM catalog_printing WHERE id=%s", (printing_id,)).fetchone()
        if not row:
            fail(404, "PRINTING_NOT_FOUND")
        return evidence_view(conn, load_evidence(conn, row["identity_id"]))


@router.get(f"{ADMIN}/{{identity_id}}", response_model=CardIdentityEvidence)
def identity_evidence(identity_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        loaded = load_evidence(conn, identity_id)
        if not loaded:
            fail(404, "IDENTITY_NOT_FOUND")
        return evidence_view(conn, loaded)


@router.get(f"{ADMIN}/{{identity_id}}/history", response_model=list[CardIdentityDecisionRow])
def identity_history(identity_id: UUID, user_id: str = Depends(verified_user)):
    """Decisions about this identity's groups, and identity merges into or out of it, newest first."""
    with connect() as conn:
        require_owner(conn, user_id)
        if not conn.execute("SELECT 1 FROM catalog_identity WHERE id=%s", (identity_id,)).fetchone():
            fail(404, "IDENTITY_NOT_FOUND")
        return [CardIdentityDecisionRow(**{key: row[key] for key in CardIdentityDecisionRow.model_fields})
                for row in conn.execute("""SELECT * FROM catalog_card_identity_decision
                  WHERE identity_id=%s OR into_identity_id=%s
                  ORDER BY reviewed_at DESC, attribute_revision DESC, id""", (identity_id, identity_id)).fetchall()]


# ---------------------------------------------------------------- decisions


class ReprintGroupDecisionInput(BaseModel):
    identity_id: UUID
    decision: Literal["merge", "split", "join", "restore"]
    # merge: the group whose Printings move; split: the group to split.
    group_id: UUID | None = None
    # merge and join: the group the Printings move into.
    target_group_id: UUID | None = None
    # split: the Printings that leave; join: the Printings that join; restore: the Printings returned to derivation.
    printing_ids: list[UUID] = Field(default_factory=list, max_length=MAX_PRINTINGS)
    # The decision binds to the exact evidence the maintainer was shown.
    evidence_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    evidence_url: HttpUrl
    reason: str = Field(min_length=1, max_length=2000)
    code: str | None = Field(default=None, pattern=r"^\d{6}$")


class ReprintGroupDecisionResult(BaseModel):
    decision_id: UUID
    identity_id: UUID
    decision: str
    # The group the named Printings are in afterwards; null after ``restore``.
    group_id: UUID | None
    affected_printing_ids: list[UUID]
    attribute_revision: int
    # Whether the re-stamped public format facts reached the shared records store; "pending" ones are delivered by the
    # next drain or scripts/backfill_public_catalog.py.
    public_delivery: Literal["delivered", "pending"]


class CardIdentityMergeInput(BaseModel):
    # The identity merged away, and the surviving identity.
    identity_id: UUID
    into_identity_id: UUID
    evidence_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    into_evidence_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    evidence_url: HttpUrl
    reason: str = Field(min_length=1, max_length=2000)
    code: str | None = Field(default=None, pattern=r"^\d{6}$")


class CardIdentityMergeResult(BaseModel):
    decision_id: UUID
    identity_id: UUID
    into_identity_id: UUID
    moved_printing_ids: list[UUID]
    affected_printing_ids: list[UUID]
    attribute_revision: int
    public_delivery: Literal["delivered", "pending"]


# Which of group_id, target_group_id and printing_ids each group decision takes.
SHAPES = {"merge": (True, True, False), "split": (True, False, True), "join": (False, True, True),
          "restore": (False, False, True)}


def _reason(text: str) -> str:
    reason = " ".join(text.split())
    if not reason:
        fail(422, "REASON_REQUIRED")
    return reason


def _verify_code(user_id: str, target: str, action: str, code: str | None):
    """A wrong code is decided before the clock is taken, so it commits only its attempt count."""
    with connect() as conn, conn.transaction():
        require_owner(conn, user_id)
        known = consume_metadata_code(conn, user_id, target, action, code, spend=False)
    if not known:
        fail(403, "INVALID_APPROVAL_CODE")


def _membership(conn, identity_ids) -> dict:
    """(Card Identity, effective group) of every Printing of these identities, by Printing ID."""
    return {row["id"]: (row["identity_id"], row["group_id"]) for row in conn.execute(
        """SELECT p.id, p.identity_id, m.group_id FROM catalog_printing p
          LEFT JOIN catalog_reprint_group_member m ON m.printing_id = p.id
          WHERE p.identity_id = ANY(%s)""", (list(identity_ids),))}


def _changed(before: dict, after: dict) -> list[UUID]:
    changed = {printing for printing in before.keys() | after.keys() if before.get(printing) != after.get(printing)}
    return sorted(changed, key=str)


def _check_group_decision(command: ReprintGroupDecisionInput, printing_ids: list[UUID], loaded):
    """Refuse a decision the shown evidence does not support; nothing is written yet."""
    by_id = {printing.printing_id: printing for printing in loaded["printings"]}
    groups = loaded["groups"]
    if any(printing not in by_id for printing in printing_ids):
        fail(422, "PRINTING_NOT_IN_IDENTITY")
    for group in (command.group_id, command.target_group_id):
        if group is not None and group not in groups:
            fail(422, "GROUP_NOT_FOUND")
    if command.decision == "split":
        if any(by_id[printing].group_id != command.group_id for printing in printing_ids):
            fail(422, "PRINTING_NOT_IN_GROUP")
        if set(printing_ids) == set(groups[command.group_id]):
            fail(422, "SPLIT_WHOLE_GROUP")
    elif command.decision == "join":
        if any(by_id[printing].group_id == command.target_group_id for printing in printing_ids):
            fail(422, "ALREADY_IN_GROUP")
        # An assignment applies to a TCGdex Printing only while it derives a group (migration 033).
        if any(by_id[printing].source != "manual" and by_id[printing].derived_group_id is None
               for printing in printing_ids):
            fail(422, "PRINTING_NOT_GROUPABLE")
    elif command.decision == "restore":
        if any(by_id[printing].linked_group_id is None and by_id[printing].assigned_group_id is None
               for printing in printing_ids):
            fail(422, "NO_REVIEWED_GROUP")


def _apply_group_decision(conn, command: ReprintGroupDecisionInput, printing_ids: list[UUID], decision_id: UUID):
    """Write the reviewed records; the database triggers recompute effective membership. Returns the group the named
    Printings are in afterwards."""
    identity = command.identity_id
    if command.decision == "merge":
        source, target = command.group_id, command.target_group_id
        # Link every member of both groups that derives a group, so later reprints of either wording follow.
        conn.execute("""INSERT INTO catalog_reprint_group_link (printing_id, group_id, decision_id)
          SELECT m.printing_id, %s, %s FROM catalog_reprint_group_membership m
          JOIN catalog_printing p ON p.id = m.printing_id AND p.identity_id = %s
          JOIN catalog_derived_reprint_group d ON d.printing_id = m.printing_id
          WHERE m.group_id = ANY(%s)
            AND NOT EXISTS (SELECT 1 FROM catalog_reprint_group_assignment a WHERE a.printing_id = m.printing_id)
          ON CONFLICT (printing_id) DO UPDATE SET group_id = EXCLUDED.group_id, decision_id = EXCLUDED.decision_id,
            updated_at = now()""", (target, decision_id, identity, [source, target]))
        for table in ("catalog_reprint_group_link", "catalog_reprint_group_assignment"):
            conn.execute(f"""UPDATE {table} SET group_id = %s, decision_id = %s, updated_at = now()
              WHERE group_id = %s AND printing_id IN (SELECT id FROM catalog_printing WHERE identity_id = %s)""",
                         (target, decision_id, source, identity))
        return target
    if command.decision == "restore":
        for table in ("catalog_reprint_group_assignment", "catalog_reprint_group_link"):
            conn.execute(f"DELETE FROM {table} WHERE printing_id = ANY(%s)", (printing_ids,))
        return None
    group = uuid5(GROUP_NAMESPACE, f"split:{decision_id}") if command.decision == "split" else command.target_group_id
    conn.execute("""INSERT INTO catalog_reprint_group_assignment (printing_id, group_id, decision_id)
      SELECT printing_id, %s, %s FROM unnest(%s::uuid[]) AS named(printing_id)
      ON CONFLICT (printing_id) DO UPDATE SET group_id = EXCLUDED.group_id, decision_id = EXCLUDED.decision_id,
        updated_at = now()""", (group, decision_id, printing_ids))
    return group


@router.post("/api/admin/reprint-groups/decisions", response_model=ReprintGroupDecisionResult)
def decide_groups(command: ReprintGroupDecisionInput, user_id: str = Depends(verified_user)):
    reason = _reason(command.reason)
    printing_ids = list(dict.fromkeys(command.printing_ids))
    need_group, need_target, need_printings = SHAPES[command.decision]
    if ((command.group_id is not None) != need_group or (command.target_group_id is not None) != need_target
            or bool(printing_ids) != need_printings):
        fail(422, "INVALID_DECISION")
    if command.decision == "merge" and command.group_id == command.target_group_id:
        fail(422, "SAME_GROUP")
    target = f"card_identity:{command.identity_id}"
    _verify_code(user_id, target, GROUP_ACTION, command.code)
    bad_code = False
    try:
        with connect() as conn, conn.transaction():
            require_owner(conn, user_id)
            conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
            # Lock order, as in a catalog import: the commit-ordered public clock first, the attribute revision last.
            clock = conn.execute("SELECT catalog_begin_correction() AS revision").fetchone()["revision"]
            if not conn.execute("SELECT 1 FROM catalog_identity WHERE id=%s FOR UPDATE",
                                (command.identity_id,)).fetchone():
                fail(404, "IDENTITY_NOT_FOUND")
            loaded = load_evidence(conn, command.identity_id)
            if loaded["identity"]["merged_into"] is not None:
                fail(422, "IDENTITY_MERGED")
            if not hmac.compare_digest(command.evidence_digest, loaded["evidence_digest"]):
                fail(409, "IDENTITY_EVIDENCE_CHANGED")
            _check_group_decision(command, printing_ids, loaded)
            if not consume_metadata_code(conn, user_id, target, GROUP_ACTION, command.code):
                bad_code = True
            else:
                revision = advance_attribute_revision(conn)
                decision_id = uuid4()
                before = _membership(conn, [command.identity_id])
                group = _apply_group_decision(conn, command, printing_ids, decision_id)
                affected = _changed(before, _membership(conn, [command.identity_id]))
                if not affected:
                    fail(422, "NO_CHANGE")  # rolls back the records and the spent code
                conn.execute("""INSERT INTO catalog_card_identity_decision (id, identity_id, decision, group_id,
                  target_group_id, printing_ids, affected_printing_ids, evidence_digest, evidence_url, reason,
                  reviewer_id, clock_revision, attribute_revision)
                  VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                             (decision_id, command.identity_id, command.decision, command.group_id,
                              command.target_group_id, printing_ids, affected, loaded["evidence_digest"],
                              str(command.evidence_url), reason, user_id, clock, revision))
    except psycopg.errors.LockNotAvailable:
        fail(409, "CATALOG_BUSY")
    if bad_code:
        fail(403, "INVALID_APPROVAL_CODE")
    # Committed. Public records are a derived copy: delivery is best effort and recoverable.
    publish_catalog_best_effort(printing_ids=affected)
    return ReprintGroupDecisionResult(decision_id=decision_id, identity_id=command.identity_id,
                                      decision=command.decision, group_id=group, affected_printing_ids=affected,
                                      attribute_revision=revision, public_delivery=delivery_status(revision=clock))


@router.post(f"{ADMIN}/decisions", response_model=CardIdentityMergeResult)
def merge_identities(command: CardIdentityMergeInput, user_id: str = Depends(verified_user)):
    reason = _reason(command.reason)
    merged, survivor = command.identity_id, command.into_identity_id
    if merged == survivor:
        fail(422, "SAME_IDENTITY")
    target = f"card_identity:{merged}"
    _verify_code(user_id, target, IDENTITY_ACTION, command.code)
    bad_code = False
    try:
        with connect() as conn, conn.transaction():
            require_owner(conn, user_id)
            conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
            # Lock order, as in a catalog import: the catalog state row, the commit-ordered public clock, the
            # identities, and the attribute revision last.
            conn.execute("SELECT 1 FROM catalog_state WHERE singleton FOR UPDATE")
            clock = conn.execute("SELECT catalog_begin_correction() AS revision").fetchone()["revision"]
            if len(conn.execute("SELECT id FROM catalog_identity WHERE id = ANY(%s) ORDER BY id FOR UPDATE",
                                ([merged, survivor],)).fetchall()) != 2:
                fail(404, "IDENTITY_NOT_FOUND")
            loaded, into = load_evidence(conn, merged), load_evidence(conn, survivor)
            if loaded["identity"]["merged_into"] is not None or into["identity"]["merged_into"] is not None:
                fail(422, "IDENTITY_MERGED")
            if not (hmac.compare_digest(command.evidence_digest, loaded["evidence_digest"])
                    and hmac.compare_digest(command.into_evidence_digest, into["evidence_digest"])):
                fail(409, "IDENTITY_EVIDENCE_CHANGED")
            if any(printing.linked_group_id or printing.assigned_group_id for printing in loaded["printings"]):
                fail(422, "REPRINT_GROUP_OVERRIDES")
            if not consume_metadata_code(conn, user_id, target, IDENTITY_ACTION, command.code):
                bad_code = True
            else:
                revision = advance_attribute_revision(conn)
                decision_id = uuid4()
                before = _membership(conn, [merged, survivor])
                moved = [row["id"] for row in conn.execute(
                    "UPDATE catalog_printing SET identity_id=%s WHERE identity_id=%s RETURNING id", (survivor, merged))]
                conn.execute("UPDATE catalog_identity SET merged_into=%s, merge_decision_id=%s WHERE id=%s",
                             (survivor, decision_id, merged))
                # Identities merged into this one earlier now point at the survivor, so a key is one step from it.
                conn.execute("UPDATE catalog_identity SET merged_into=%s WHERE merged_into=%s", (survivor, merged))
                # Derived group IDs include the identity: re-derive the moved Printings' groups now.
                if moved:
                    refresh_reprint_groups(conn, printing_ids=moved)
                # Search cursors and catalog-revision-keyed reads must not span the change (as in migration 024).
                conn.execute("UPDATE catalog_state SET revision=revision+1 WHERE singleton")
                affected = _changed(before, _membership(conn, [survivor]))
                conn.execute("""INSERT INTO catalog_card_identity_decision (id, identity_id, decision,
                  into_identity_id, printing_ids, affected_printing_ids, evidence_digest, into_evidence_digest,
                  evidence_url, reason, reviewer_id, clock_revision, attribute_revision)
                  VALUES (%s, %s, 'merge_identity', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                             (decision_id, merged, survivor, moved, affected, loaded["evidence_digest"],
                              into["evidence_digest"], str(command.evidence_url), reason, user_id, clock, revision))
    except psycopg.errors.LockNotAvailable:
        fail(409, "CATALOG_BUSY")
    if bad_code:
        fail(403, "INVALID_APPROVAL_CODE")
    publish_catalog_best_effort(printing_ids=affected)
    return CardIdentityMergeResult(decision_id=decision_id, identity_id=merged, into_identity_id=survivor,
                                   moved_printing_ids=sorted(moved, key=str), affected_printing_ids=affected,
                                   attribute_revision=revision, public_delivery=delivery_status(revision=clock))
