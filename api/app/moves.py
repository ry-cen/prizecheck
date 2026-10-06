"""Short-lived selections and atomic, owner-scoped Holding Moves."""
import hashlib
import json
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .main import connect, verified_user

router = APIRouter(prefix="/api/moves", tags=["moves"])
MAX_QUANTITY = 2**63 - 1
MAX_BATCH = 500


class StartMove(BaseModel):
    source_id: UUID


class MoveManifest(BaseModel):
    id: UUID
    source_id: UUID
    expires_at: str
    item_count: int


class MoveItem(BaseModel):
    edition_id: UUID
    quantity: str
    expected_version: int = Field(ge=1)


class StageItems(BaseModel):
    items: list[MoveItem] = Field(min_length=1, max_length=MAX_BATCH)


class CommitMove(BaseModel):
    destination_id: UUID | None = None
    idempotency_key: UUID


class MoveResult(BaseModel):
    edition_count: int
    copy_count: str
    owner_revision: int


def fail(status: int, code: str):
    raise HTTPException(status, {"code": code})


def quantity(raw: str) -> int:
    if not raw or not raw.isascii() or not raw.isdecimal() or len(raw) > 19:
        fail(422, "INVALID_QUANTITY")
    value = int(raw)
    if value < 1 or value > MAX_QUANTITY:
        fail(422, "INVALID_QUANTITY")
    return value


def lock_owner(conn, user_id: str):
    conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user_id,))
    return conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE", (user_id,)).fetchone()["revision"]


def leaf(conn, user_id: str, location_id: UUID) -> bool:
    return bool(conn.execute("""SELECT 1 FROM location l WHERE l.owner_id=%s AND l.id=%s
      AND l.kind IN ('storage_leaf','deck')
      AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id=l.id)""",
                             (user_id, location_id)).fetchone())


def manifest(conn, user_id: str, manifest_id: UUID):
    row = conn.execute("SELECT id,source_id,expires_at FROM move_manifest WHERE owner_id=%s AND id=%s",
                       (user_id, manifest_id)).fetchone()
    if row is None:
        fail(404, "MOVE_MANIFEST_NOT_FOUND")
    if conn.execute("SELECT %s <= now() AS expired", (row["expires_at"],)).fetchone()["expired"]:
        conn.execute("DELETE FROM move_manifest WHERE owner_id=%s", (user_id,))
        fail(410, "MOVE_MANIFEST_EXPIRED")
    return row


def view(conn, row, user_id):
    count = conn.execute("SELECT count(*) AS n FROM move_manifest_item WHERE owner_id=%s", (user_id,)).fetchone()["n"]
    return MoveManifest(id=row["id"], source_id=row["source_id"], expires_at=row["expires_at"].isoformat(), item_count=count)


@router.post("/manifests", response_model=MoveManifest, status_code=201)
def start_move(command: StartMove, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        lock_owner(conn, user_id)
        if not leaf(conn, user_id, command.source_id):
            fail(404, "LOCATION_NOT_FOUND")
        # Starting a fresh selection supersedes this owner's previous staging work.
        conn.execute("DELETE FROM move_manifest WHERE owner_id=%s", (user_id,))
        row = conn.execute("""INSERT INTO move_manifest(owner_id,id,source_id)
          VALUES (%s,%s,%s) RETURNING id,source_id,expires_at""",
                           (user_id, uuid4(), command.source_id)).fetchone()
        return view(conn, row, user_id)


@router.put("/manifests/{manifest_id}/items", response_model=MoveManifest)
def stage_items(manifest_id: UUID, command: StageItems, user_id: str = Depends(verified_user)):
    ids = [item.edition_id for item in command.items]
    if len(ids) != len(set(ids)):
        fail(422, "DUPLICATE_MOVE_ITEM")
    parsed = [(item.edition_id, quantity(item.quantity), item.expected_version) for item in command.items]
    with connect() as conn, conn.transaction():
        lock_owner(conn, user_id)
        row = manifest(conn, user_id, manifest_id)
        values = json.dumps([{"edition_id": str(edition_id), "quantity": amount, "expected_version": version}
                             for edition_id, amount, version in parsed])
        mismatch = conn.execute("""SELECT 1 FROM jsonb_to_recordset(%s::jsonb)
          AS staged(edition_id uuid,quantity bigint,expected_version bigint)
          JOIN move_manifest_item existing ON existing.owner_id=%s AND existing.edition_id=staged.edition_id
          WHERE existing.quantity<>staged.quantity OR existing.expected_version<>staged.expected_version LIMIT 1""",
                                (values, user_id)).fetchone()
        if mismatch:
            fail(409, "DUPLICATE_MOVE_ITEM")
        conn.execute("""INSERT INTO move_manifest_item(owner_id,edition_id,quantity,expected_version)
          SELECT %s,edition_id,quantity,expected_version FROM jsonb_to_recordset(%s::jsonb)
          AS staged(edition_id uuid,quantity bigint,expected_version bigint)
          ON CONFLICT (owner_id,edition_id) DO NOTHING""", (user_id, values))
        return view(conn, row, user_id)


@router.delete("/manifests/{manifest_id}", status_code=204)
def cancel_move(manifest_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        lock_owner(conn, user_id)
        result = conn.execute("DELETE FROM move_manifest WHERE owner_id=%s AND id=%s", (user_id, manifest_id))
        if result.rowcount == 0:
            fail(404, "MOVE_MANIFEST_NOT_FOUND")


@router.post("/manifests/{manifest_id}/commit", response_model=MoveResult)
def commit_move(manifest_id: UUID, command: CommitMove, user_id: str = Depends(verified_user)):
    if command.destination_id is None:
        fail(422, "DESTINATION_REQUIRED")
    return apply_selection(manifest_id, command, user_id)


@router.post("/manifests/{manifest_id}/remove", response_model=MoveResult)
def remove_inventory(manifest_id: UUID, command: CommitMove, user_id: str = Depends(verified_user)):
    if command.destination_id is not None:
        fail(422, "REMOVAL_HAS_NO_DESTINATION")
    return apply_selection(manifest_id, command, user_id)


def apply_selection(manifest_id, command, user_id):
    payload = {"action": "move" if command.destination_id else "remove", "manifest_id": str(manifest_id), "destination_id": str(command.destination_id)}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    try:
        with connect() as conn, conn.transaction():
            revision = lock_owner(conn, user_id)
            conn.execute("DELETE FROM mutation_request WHERE owner_id=%s AND expires_at<=now()", (user_id,))
            previous = conn.execute("""SELECT mr.command_digest,mr.result_revision,r.edition_count,r.copy_count
              FROM mutation_request mr LEFT JOIN move_response r
                ON r.owner_id=mr.owner_id AND r.request_key=mr.request_key
              WHERE mr.owner_id=%s AND mr.request_key=%s""", (user_id, command.idempotency_key)).fetchone()
            if previous:
                if previous["command_digest"] != digest:
                    fail(409, "IDEMPOTENCY_KEY_REUSED")
                if previous["edition_count"] is None:
                    fail(409, "REPLAY_OUTCOME_UNAVAILABLE")
                return MoveResult(edition_count=previous["edition_count"], copy_count=str(previous["copy_count"]),
                                  owner_revision=previous["result_revision"])
            row = manifest(conn, user_id, manifest_id)
            source = row["source_id"]
            if source == command.destination_id:
                fail(409, "SAME_LOCATION")
            if not leaf(conn, user_id, source) or (command.destination_id is not None and not leaf(conn, user_id, command.destination_id)):
                fail(404, "LOCATION_NOT_FOUND")
            # Materialize the staged set in the transaction. Validation and both
            # sides of the transfer use this same snapshot under the owner lock.
            conn.execute("""CREATE TEMP TABLE selected_work ON COMMIT DROP AS
              SELECT * FROM move_manifest_item WHERE owner_id=%s""", (user_id,))
            conn.execute("CREATE UNIQUE INDEX ON selected_work(edition_id)")
            conn.execute("ANALYZE selected_work")
            conn.execute("""CREATE TEMP TABLE move_work ON COMMIT DROP AS
              SELECT mi.edition_id,mi.quantity,mi.expected_version,h.quantity AS source_quantity,
                h.version AS source_version,d.quantity AS destination_quantity
              FROM selected_work mi
              LEFT JOIN holding h ON h.owner_id=mi.owner_id AND h.location_id=%s AND h.edition_id=mi.edition_id
              LEFT JOIN holding d ON d.owner_id=mi.owner_id AND d.location_id=%s AND d.edition_id=mi.edition_id
              WHERE mi.owner_id=%s""", (source, command.destination_id, user_id))
            conn.execute("CREATE UNIQUE INDEX ON move_work(edition_id)")
            conn.execute("ANALYZE move_work")
            summary = conn.execute("""SELECT count(*) AS editions,coalesce(sum(quantity),0) AS copies,
              count(*) FILTER (WHERE source_version IS NULL OR source_version<>expected_version) AS stale,
              count(*) FILTER (WHERE source_quantity<quantity) AS insufficient,
              count(*) FILTER (WHERE destination_quantity>%s-quantity) AS overflow
              FROM move_work""", (MAX_QUANTITY,)).fetchone()
            if summary["editions"] == 0:
                fail(422, "EMPTY_MOVE_SELECTION")
            if summary["stale"]:
                fail(409, "STALE_HOLDING")
            if summary["insufficient"]:
                fail(409, "INSUFFICIENT_QUANTITY")
            if summary["overflow"]:
                fail(409, "QUANTITY_OVERFLOW")
            new_revision = revision + 1
            conn.execute("""DELETE FROM holding h USING move_work w
              WHERE h.owner_id=%s AND h.location_id=%s AND h.edition_id=w.edition_id
              AND h.quantity=w.quantity""", (user_id, source))
            conn.execute("""UPDATE holding h SET quantity=h.quantity-w.quantity,version=%s
              FROM move_work w WHERE h.owner_id=%s AND h.location_id=%s AND h.edition_id=w.edition_id
              AND h.quantity>w.quantity""",
                         (new_revision, user_id, source))
            if command.destination_id is not None:
                conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
              SELECT %s,%s,edition_id,quantity,%s FROM move_work WHERE true
              ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE
                SET quantity=holding.quantity+EXCLUDED.quantity,version=EXCLUDED.version""",
                         (user_id, command.destination_id, new_revision))
            conn.execute("UPDATE inventory_owner SET revision=%s WHERE user_id=%s", (new_revision, user_id))
            conn.execute("""INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision)
              VALUES (%s,%s,%s,%s)""", (user_id, command.idempotency_key, digest, new_revision))
            conn.execute("""INSERT INTO move_response(owner_id,request_key,edition_count,copy_count)
              VALUES (%s,%s,%s,%s)""", (user_id, command.idempotency_key, summary["editions"], summary["copies"]))
            conn.execute("DELETE FROM inventory_undo WHERE owner_id=%s AND expires_at<=clock_timestamp()", (user_id,))
            conn.execute("""INSERT INTO inventory_undo(id,owner_id,action,source_id,destination_id,payload)
              SELECT %s,%s,%s,%s,%s,jsonb_agg(jsonb_build_object('edition_id',edition_id,'quantity',quantity::text))
              FROM move_work""", (uuid4(),user_id,payload["action"],source,command.destination_id))
            conn.execute("""DELETE FROM inventory_undo WHERE owner_id=%s AND id NOT IN
              (SELECT id FROM inventory_undo WHERE owner_id=%s ORDER BY created_at DESC,id DESC LIMIT 5)""", (user_id,user_id))
            conn.execute("DELETE FROM move_manifest WHERE owner_id=%s", (user_id,))
            return MoveResult(edition_count=summary["editions"], copy_count=str(summary["copies"]),
                              owner_revision=new_revision)
    except psycopg.Error:
        fail(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")


class UndoCommand(BaseModel):
    idempotency_key: UUID


@router.get('/undo')
def list_undo(user_id: str = Depends(verified_user)):
    with connect() as conn:
        return conn.execute("""SELECT id,action,source_id,destination_id,expires_at
          FROM inventory_undo WHERE owner_id=%s AND expires_at>clock_timestamp()
          ORDER BY created_at DESC,id DESC LIMIT 5""", (user_id,)).fetchall()


@router.delete('/undo/{undo_id}', status_code=204)
def dismiss_undo(undo_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        lock_owner(conn,user_id)
        if not conn.execute('DELETE FROM inventory_undo WHERE owner_id=%s AND id=%s', (user_id,undo_id)).rowcount:
            fail(404,'UNDO_NOT_FOUND')


@router.post('/undo/{undo_id}', response_model=MoveResult)
def undo_inventory(undo_id: UUID, command: UndoCommand, user_id: str = Depends(verified_user)):
    digest = hashlib.sha256(f'undo:{undo_id}'.encode()).hexdigest()
    try:
        with connect() as conn, conn.transaction():
            revision = lock_owner(conn,user_id)
            previous = conn.execute('''SELECT mr.command_digest,mr.result_revision,r.edition_count,r.copy_count
              FROM mutation_request mr LEFT JOIN move_response r USING(owner_id,request_key)
              WHERE mr.owner_id=%s AND mr.request_key=%s AND mr.expires_at>now()''', (user_id,command.idempotency_key)).fetchone()
            if previous:
                if previous['command_digest'] != digest:
                    fail(409,'IDEMPOTENCY_KEY_REUSED')
                return MoveResult(edition_count=previous['edition_count'],copy_count=str(previous['copy_count']),owner_revision=previous['result_revision'])
            entry = conn.execute('SELECT *, expires_at<=clock_timestamp() AS expired FROM inventory_undo WHERE owner_id=%s AND id=%s', (user_id,undo_id)).fetchone()
            if not entry:
                fail(404,'UNDO_NOT_FOUND')
            if entry['expired']:
                fail(410,'UNDO_EXPIRED')
            newest = conn.execute('SELECT id FROM inventory_undo WHERE owner_id=%s AND expires_at>clock_timestamp() ORDER BY created_at DESC,id DESC LIMIT 1', (user_id,)).fetchone()
            if newest['id'] != undo_id:
                fail(409,'UNDO_NOT_NEWEST')
            if not leaf(conn,user_id,entry['source_id']) or (entry['destination_id'] and not leaf(conn,user_id,entry['destination_id'])):
                fail(409,'UNDO_INCOMPATIBLE')
            conn.execute('''CREATE TEMP TABLE undo_work ON COMMIT DROP AS
              SELECT p.edition_id,p.quantity,h.quantity AS current_quantity,d.quantity AS destination_quantity
              FROM jsonb_to_recordset(%s::jsonb) AS p(edition_id uuid,quantity bigint)
              LEFT JOIN holding h ON h.owner_id=%s AND h.location_id=%s AND h.edition_id=p.edition_id
              LEFT JOIN holding d ON d.owner_id=%s AND d.location_id=%s AND d.edition_id=p.edition_id''',
              (json.dumps(entry['payload']),user_id,entry['source_id'],user_id,entry['destination_id']))
            conn.execute('CREATE UNIQUE INDEX ON undo_work(edition_id)')
            conn.execute('ANALYZE undo_work')
            summary = conn.execute('SELECT count(*) AS editions,sum(quantity) AS copies FROM undo_work').fetchone()
            bad = conn.execute('SELECT 1 FROM undo_work WHERE coalesce(current_quantity,0)>%s-quantity OR (%s AND coalesce(destination_quantity,0)<quantity) LIMIT 1', (MAX_QUANTITY,entry['destination_id'] is not None)).fetchone()
            if bad:
                fail(409,'UNDO_INCOMPATIBLE')
            new_revision = revision+1
            if entry['destination_id']:
                conn.execute('''DELETE FROM holding h USING undo_work w WHERE h.owner_id=%s AND h.location_id=%s AND h.edition_id=w.edition_id AND h.quantity=w.quantity''', (user_id,entry['destination_id']))
                conn.execute('''UPDATE holding h SET quantity=h.quantity-w.quantity,version=%s FROM undo_work w WHERE h.owner_id=%s AND h.location_id=%s AND h.edition_id=w.edition_id''', (new_revision,user_id,entry['destination_id']))
            conn.execute('''INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
              SELECT %s,%s,edition_id,quantity,%s FROM undo_work WHERE true
              ON CONFLICT(owner_id,location_id,edition_id) DO UPDATE SET quantity=holding.quantity+excluded.quantity,version=excluded.version''', (user_id,entry['source_id'],new_revision))
            conn.execute('UPDATE inventory_owner SET revision=%s WHERE user_id=%s',(new_revision,user_id))
            conn.execute('DELETE FROM mutation_request WHERE owner_id=%s AND expires_at<=now()',(user_id,))
            conn.execute('INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision) VALUES (%s,%s,%s,%s)',(user_id,command.idempotency_key,digest,new_revision))
            conn.execute('INSERT INTO move_response(owner_id,request_key,edition_count,copy_count) VALUES (%s,%s,%s,%s)',(user_id,command.idempotency_key,summary['editions'],summary['copies']))
            conn.execute('DELETE FROM inventory_undo WHERE owner_id=%s AND (id=%s OR expires_at<=clock_timestamp())',(user_id,undo_id))
            return MoveResult(edition_count=summary['editions'],copy_count=str(summary['copies']),owner_revision=new_revision)
    except psycopg.Error:
        fail(503,'INVENTORY_TEMPORARILY_UNAVAILABLE')
