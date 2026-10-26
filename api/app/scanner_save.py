"""Scanner save (#311; plumbing D11, D12): ``POST /api/scanner/save`` adds a confirmed Scan Tray to the Collection in
one step, one Holding increment per Card Edition into one Storage Leaf.

It is import-shaped but separate: it needs no server draft, never creates or replaces a Collection Import draft, and
starts no catalog pull or price work. It follows batch add's transaction (``holdings.add_holdings``) and differs in
four places: the destination must be a Storage Leaf with no children (a Deck is refused), every unavailable Edition is
named at once, the receipt lives 30 days, and there is no Inventory Undo record. It touches only ``holding``,
``inventory_owner``, ``mutation_request`` and ``move_response``.
"""
import hashlib
import json
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .collection_import import storage_leaf
from .holdings import MAX_BATCH_EDITIONS, MAX_QUANTITY
from .main import connect, verified_user
from .moves import REPLAY, lock_owner
from .moves import fail as refuse

router = APIRouter(prefix="/api/scanner")
MAX_SCAN_SAVE_EDITIONS = MAX_BATCH_EDITIONS


class ScanSaveItem(BaseModel):
    edition_id: UUID
    quantity: str = Field(pattern=r"^[1-9][0-9]{0,3}$")


class ScanSave(BaseModel):
    location_id: UUID
    idempotency_key: UUID
    items: list[ScanSaveItem] = Field(min_length=1, max_length=MAX_SCAN_SAVE_EDITIONS)


class ScanSaveResult(BaseModel):
    location_id: UUID
    edition_count: int
    copy_count: str
    owner_revision: int


@router.post("/save", response_model=ScanSaveResult)
def save(command: ScanSave, user_id: str = Depends(verified_user)):
    """Adds every item's copies to one Storage Leaf, all or nothing, under the owner lock: one owner revision. The same
    key and items (in any order) replay the result; other items or another route under that key answer
    IDEMPOTENCY_KEY_REUSED. A destination that is gone or not a childless Storage Leaf answers DESTINATION_CHANGED
    before any Edition is looked at; EDITIONS_CHANGED lists every Edition that is no longer active."""
    if len({item.edition_id for item in command.items}) != len(command.items):
        refuse(422, "DUPLICATE_ADD_ITEM")
    items = sorted(((item.edition_id, int(item.quantity)) for item in command.items), key=lambda item: str(item[0]))
    fingerprint = {"action": "scan_save", "location_id": str(command.location_id),
                   "items": [[str(edition), str(amount)] for edition, amount in items]}
    request_digest = hashlib.sha256(json.dumps(fingerprint, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    work = json.dumps([{"edition_id": str(edition), "quantity": amount} for edition, amount in items])
    copies = sum(amount for _, amount in items)
    try:
        with connect() as conn, conn.transaction():
            revision = lock_owner(conn, user_id)
            conn.execute("DELETE FROM mutation_request WHERE owner_id=%s AND expires_at<=now()", (user_id,))
            previous = conn.execute(REPLAY, (user_id, command.idempotency_key)).fetchone()
            if previous:
                if previous["command_digest"] != request_digest:
                    refuse(409, "IDEMPOTENCY_KEY_REUSED")
                if previous["edition_count"] is None:
                    refuse(409, "REPLAY_OUTCOME_UNAVAILABLE")
                return ScanSaveResult(location_id=command.location_id, edition_count=previous["edition_count"],
                                      copy_count=str(previous["copy_count"]), owner_revision=previous["result_revision"])
            if not storage_leaf(conn, user_id, command.location_id):
                refuse(409, "DESTINATION_CHANGED", location_id=command.location_id)
            # Hold the promoted generation stable until this save commits.
            catalog = conn.execute("SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE").fetchone()
            # An Edition the catalog never had has no Printing to name: its printing_id is null.
            unavailable = conn.execute("""SELECT w.edition_id, ce.printing_id FROM jsonb_to_recordset(%s::jsonb)
                AS w(edition_id uuid,quantity bigint)
              LEFT JOIN catalog_edition ce ON ce.id=w.edition_id
              WHERE NOT EXISTS (SELECT 1 FROM catalog_generation_edition ge
                JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
                WHERE ge.generation_id=%s AND ge.edition_id=w.edition_id AND ge.active AND NOT gp.tombstoned)
              ORDER BY w.edition_id""", (work, catalog["active_generation"])).fetchall()
            if unavailable:
                raise HTTPException(409, {"code": "EDITIONS_CHANGED", "editions": [
                    {"edition_id": str(row["edition_id"]),
                     "printing_id": None if row["printing_id"] is None else str(row["printing_id"])}
                    for row in unavailable]})
            over = conn.execute("""SELECT w.edition_id FROM jsonb_to_recordset(%s::jsonb)
                AS w(edition_id uuid,quantity bigint)
              JOIN holding h ON h.owner_id=%s AND h.location_id=%s AND h.edition_id=w.edition_id
              WHERE h.quantity>%s-w.quantity ORDER BY w.edition_id LIMIT 1""",
                                (work, user_id, command.location_id, MAX_QUANTITY)).fetchone()
            if over:
                refuse(422, "QUANTITY_OVERFLOW", edition_id=over["edition_id"])
            new_revision = revision + 1
            conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
              SELECT %s,%s,edition_id,quantity,%s FROM jsonb_to_recordset(%s::jsonb) AS w(edition_id uuid,quantity bigint)
              WHERE true
              ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE
                SET quantity=holding.quantity+EXCLUDED.quantity,version=EXCLUDED.version""",
                         (user_id, command.location_id, new_revision, work))
            conn.execute("UPDATE inventory_owner SET revision=%s WHERE user_id=%s", (new_revision, user_id))
            # The receipt outlives the 24-hour default: the tray may retry a pending save for up to 29 days.
            conn.execute("""INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision,expires_at)
              VALUES (%s,%s,%s,%s,now()+interval '30 days')""",
                         (user_id, command.idempotency_key, request_digest, new_revision))
            conn.execute("""INSERT INTO move_response(owner_id,request_key,edition_count,copy_count,source_count,
                already_at_destination_count) VALUES (%s,%s,%s,%s,0,0)""",
                         (user_id, command.idempotency_key, len(items), copies))
            return ScanSaveResult(location_id=command.location_id, edition_count=len(items), copy_count=str(copies),
                                  owner_revision=new_revision)
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")
