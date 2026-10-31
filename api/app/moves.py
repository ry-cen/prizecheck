"""Short-lived selections and atomic, owner-scoped Holding Moves across one or more sources, and Inventory Undo.

Every inventory command that can be undone writes its one Inventory Undo record through ``record_undo``: a Move or
Removal here, a Pick List confirmation (``deck_pick_list.py``) and a batch add (``holdings.py``). An owner keeps their
newest ``UNDO_LIMIT`` records, and only the newest can be undone.
"""
import hashlib
import json
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .api_errors import api_error
from .db import connect
from .identity import verified_user
from .idempotency import expire
# Moved to inventory_core; other modules and branches still import these names from here.
from .inventory_core import (MAX_QUANTITY, REPLAY, UNDO_LIMIT, check_promises, first_non_leaf, is_deck, leaf, lock_owner,
                             quantity, record_undo, undo_id_for)

router = APIRouter(prefix="/api/moves", tags=["moves"])
fail = api_error  # other modules import moves.fail
MAX_BATCH = 500


class StartMove(BaseModel):
    source_id: UUID | None = None


class MoveManifest(BaseModel):
    id: UUID
    source_id: UUID | None
    expires_at: str
    item_count: int


class MoveItem(BaseModel):
    edition_id: UUID
    quantity: str
    expected_version: int = Field(ge=1)
    source_id: UUID | None = None


class StageItems(BaseModel):
    items: list[MoveItem] = Field(min_length=1, max_length=MAX_BATCH)


class CommitMove(BaseModel):
    destination_id: UUID | None = None
    idempotency_key: UUID
    # The deck builder's Put away (#180): a Move out of one Deck whose Undo returns the copies to that Deck as surplus,
    # leaving its Deck List alone (migration 047). Not part of the command digest, so earlier keys still replay.
    put_away: bool = False
    undo: bool = True


class MoveResult(BaseModel):
    edition_count: int
    copy_count: str
    owner_revision: int
    source_count: int
    already_at_destination_count: str
    # The Undo record a Move or Removal created (absent for Undo itself). A replay names the same record,
    # which may since have been undone, dismissed, superseded or expired.
    undo_id: UUID | None = None


def manifest(conn, user_id: str, manifest_id: UUID):
    row = conn.execute("SELECT id,source_id,expires_at FROM move_manifest WHERE owner_id=%s AND id=%s",
                       (user_id, manifest_id)).fetchone()
    if row is None:
        api_error(404, "MOVE_MANIFEST_NOT_FOUND")
    if conn.execute("SELECT %s <= now() AS expired", (row["expires_at"],)).fetchone()["expired"]:
        conn.execute("DELETE FROM move_manifest WHERE owner_id=%s", (user_id,))
        api_error(410, "MOVE_MANIFEST_EXPIRED")
    return row


def view(conn, row, user_id):
    count = conn.execute("SELECT count(*) AS n FROM move_manifest_entry WHERE owner_id=%s", (user_id,)).fetchone()["n"]
    return MoveManifest(id=row["id"], source_id=row["source_id"], expires_at=row["expires_at"].isoformat(), item_count=count)


def replayed(previous, undo_id=None) -> MoveResult:
    if previous["edition_count"] is None:
        api_error(409, "REPLAY_OUTCOME_UNAVAILABLE")
    return MoveResult(edition_count=previous["edition_count"], copy_count=str(previous["copy_count"]),
                      owner_revision=previous["result_revision"], source_count=previous["source_count"],
                      already_at_destination_count=str(previous["already_at_destination_count"]), undo_id=undo_id)


@router.post("/manifests", response_model=MoveManifest, status_code=201)
def start_move(command: StartMove, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        lock_owner(conn, user_id)
        if command.source_id is not None and not leaf(conn, user_id, command.source_id):
            api_error(404, "LOCATION_NOT_FOUND", source_id=command.source_id)
        # Starting a fresh selection supersedes this owner's previous staging work.
        conn.execute("DELETE FROM move_manifest WHERE owner_id=%s", (user_id,))
        row = conn.execute("""INSERT INTO move_manifest(owner_id,id,source_id)
          VALUES (%s,%s,%s) RETURNING id,source_id,expires_at""",
                           (user_id, uuid4(), command.source_id)).fetchone()
        return view(conn, row, user_id)


@router.put("/manifests/{manifest_id}/items", response_model=MoveManifest)
def stage_items(manifest_id: UUID, command: StageItems, user_id: str = Depends(verified_user)):
    given = [(item.source_id, item.edition_id) for item in command.items]
    if len(given) != len(set(given)):
        api_error(422, "DUPLICATE_MOVE_ITEM")
    parsed = [(item.source_id, item.edition_id, quantity(item.quantity), item.expected_version) for item in command.items]
    with connect() as conn, conn.transaction():
        lock_owner(conn, user_id)
        row = manifest(conn, user_id, manifest_id)
        staged = []
        for source_id, edition_id, amount, version in parsed:
            if source_id is None:
                source_id = row["source_id"]
            if source_id is None:
                api_error(422, "SOURCE_REQUIRED", edition_id=edition_id)
            staged.append((source_id, edition_id, amount, version))
        if len({(source_id, edition_id) for source_id, edition_id, _, _ in staged}) != len(staged):
            api_error(422, "DUPLICATE_MOVE_ITEM")
        missing = first_non_leaf(conn, user_id, sorted({source_id for source_id, _, _, _ in staged}))
        if missing is not None:
            api_error(404, "LOCATION_NOT_FOUND", source_id=missing)
        values = json.dumps([{"source_id": str(source_id), "edition_id": str(edition_id), "quantity": amount,
                              "expected_version": version} for source_id, edition_id, amount, version in staged])
        mismatch = conn.execute("""SELECT staged.source_id,staged.edition_id FROM jsonb_to_recordset(%s::jsonb)
          AS staged(source_id uuid,edition_id uuid,quantity bigint,expected_version bigint)
          JOIN move_manifest_entry existing ON existing.owner_id=%s
            AND existing.source_id=staged.source_id AND existing.edition_id=staged.edition_id
          WHERE existing.quantity<>staged.quantity OR existing.expected_version<>staged.expected_version
          ORDER BY staged.source_id,staged.edition_id LIMIT 1""", (values, user_id)).fetchone()
        if mismatch:
            api_error(409, "DUPLICATE_MOVE_ITEM", source_id=mismatch["source_id"], edition_id=mismatch["edition_id"])
        conn.execute("""INSERT INTO move_manifest_entry(owner_id,source_id,edition_id,quantity,expected_version)
          SELECT %s,source_id,edition_id,quantity,expected_version FROM jsonb_to_recordset(%s::jsonb)
          AS staged(source_id uuid,edition_id uuid,quantity bigint,expected_version bigint)
          ON CONFLICT (owner_id,source_id,edition_id) DO NOTHING""", (user_id, values))
        return view(conn, row, user_id)


@router.delete("/manifests/{manifest_id}", status_code=204)
def cancel_move(manifest_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        lock_owner(conn, user_id)
        result = conn.execute("DELETE FROM move_manifest WHERE owner_id=%s AND id=%s", (user_id, manifest_id))
        if result.rowcount == 0:
            api_error(404, "MOVE_MANIFEST_NOT_FOUND")


@router.post("/manifests/{manifest_id}/commit", response_model=MoveResult)
def commit_move(manifest_id: UUID, command: CommitMove, user_id: str = Depends(verified_user)):
    if command.destination_id is None:
        api_error(422, "DESTINATION_REQUIRED")
    if not command.undo and command.put_away:
        api_error(422, "PUT_AWAY_NEEDS_UNDO")
    return apply_selection(manifest_id, command, user_id)


@router.post("/manifests/{manifest_id}/remove", response_model=MoveResult)
def remove_inventory(manifest_id: UUID, command: CommitMove, user_id: str = Depends(verified_user)):
    if command.destination_id is not None:
        api_error(422, "REMOVAL_HAS_NO_DESTINATION")
    if not command.undo:
        api_error(422, "REMOVAL_NEEDS_UNDO")
    return apply_selection(manifest_id, command, user_id)


def first_flagged(conn, condition: str):
    """The lowest (source, Card Edition) in move_work matching a fixed, code-supplied condition."""
    return conn.execute(f"SELECT source_id,edition_id FROM move_work WHERE {condition} "
                        "ORDER BY source_id,edition_id LIMIT 1").fetchone()


def apply_selection(manifest_id, command, user_id):
    destination = command.destination_id
    # The digest is unchanged from the single-source contract so earlier keys still replay.
    payload = {"action": "move" if destination else "remove", "manifest_id": str(manifest_id), "destination_id": str(destination)}
    # Omitting the default preserves every existing request fingerprint.
    if not command.undo:
        payload["undo"] = False
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    try:
        with connect() as conn, conn.transaction():
            revision = lock_owner(conn, user_id)
            expire(conn, user_id)
            previous = conn.execute(REPLAY, (user_id, command.idempotency_key)).fetchone()
            if previous:
                if previous["command_digest"] != digest:
                    api_error(409, "IDEMPOTENCY_KEY_REUSED")
                return replayed(previous, undo_id_for(user_id, command.idempotency_key) if command.undo else None)
            manifest(conn, user_id, manifest_id)
            if destination is not None and not leaf(conn, user_id, destination):
                api_error(404, "LOCATION_NOT_FOUND", destination_id=destination)
            # Materialize the staged set in the transaction. Validation and every side
            # of the transfer use this one snapshot under the owner lock.
            conn.execute("""CREATE TEMP TABLE selected_work ON COMMIT DROP AS
              SELECT source_id,edition_id,quantity,expected_version FROM move_manifest_entry WHERE owner_id=%s""",
                         (user_id,))
            conn.execute("CREATE UNIQUE INDEX ON selected_work(source_id,edition_id)")
            conn.execute("ANALYZE selected_work")
            scope = conn.execute("""SELECT count(*) AS items,
                count(*) FILTER (WHERE source_id=%s) AS excluded,
                coalesce(sum(quantity) FILTER (WHERE source_id=%s),0) AS already
              FROM selected_work""", (destination, destination)).fetchone()
            if scope["items"] == 0:
                api_error(422, "EMPTY_MOVE_SELECTION")
            if scope["excluded"] == scope["items"]:
                api_error(409, "SAME_LOCATION")
            if scope["excluded"]:
                # Copies already at the destination stay put and are not counted as moved.
                conn.execute("DELETE FROM selected_work WHERE source_id=%s", (destination,))
            sources = [row["source_id"] for row in
                       conn.execute("SELECT DISTINCT source_id FROM selected_work ORDER BY source_id").fetchall()]
            gone = first_non_leaf(conn, user_id, sources)
            if gone is not None:
                edition = conn.execute("SELECT edition_id FROM selected_work WHERE source_id=%s ORDER BY edition_id LIMIT 1",
                                       (gone,)).fetchone()["edition_id"]
                api_error(404, "LOCATION_NOT_FOUND", source_id=gone, edition_id=edition)
            # A Put away takes copies out of one Deck to another Location; its Undo returns them to that Deck alone.
            if command.put_away and (destination is None or len(sources) != 1 or not is_deck(conn, user_id, sources[0])):
                api_error(422, "PUT_AWAY_NEEDS_ONE_DECK")
            involved = sources + ([destination] if destination is not None else [])
            conn.execute("""CREATE TEMP TABLE current_work ON COMMIT DROP AS
              SELECT location_id,edition_id,quantity,version FROM holding
              WHERE owner_id=%s AND location_id=ANY(%s::uuid[])""", (user_id, involved))
            conn.execute("CREATE UNIQUE INDEX ON current_work(location_id,edition_id)")
            conn.execute("ANALYZE current_work")
            conn.execute("""CREATE TEMP TABLE move_work ON COMMIT DROP AS
              SELECT w.source_id,w.edition_id,w.quantity,w.expected_version,
                h.quantity AS source_quantity,h.version AS source_version
              FROM selected_work w
              LEFT JOIN current_work h ON h.location_id=w.source_id AND h.edition_id=w.edition_id""")
            conn.execute("CREATE UNIQUE INDEX ON move_work(source_id,edition_id)")
            conn.execute("ANALYZE move_work")
            summary = conn.execute("""SELECT count(DISTINCT edition_id) AS editions,count(DISTINCT source_id) AS sources,
                coalesce(sum(quantity),0) AS copies,
                count(*) FILTER (WHERE source_version IS NULL OR source_version<>expected_version) AS stale,
                count(*) FILTER (WHERE source_quantity<quantity) AS insufficient
              FROM move_work""").fetchone()
            if summary["stale"]:
                row = first_flagged(conn, "source_version IS NULL OR source_version<>expected_version")
                api_error(409, "STALE_HOLDING", source_id=row["source_id"], edition_id=row["edition_id"])
            if summary["insufficient"]:
                row = first_flagged(conn, "source_quantity<quantity")
                api_error(409, "INSUFFICIENT_QUANTITY", source_id=row["source_id"], edition_id=row["edition_id"])
            if destination is not None:
                # One destination row per Card Edition: copies of one Edition from several
                # sources arrive together, and overflow is checked against their sum.
                conn.execute("""CREATE TEMP TABLE arrival_work ON COMMIT DROP AS
                  SELECT m.edition_id,sum(m.quantity) AS quantity,
                    (array_agg(m.source_id ORDER BY m.source_id))[1] AS first_source_id,
                    max(d.quantity) AS destination_quantity
                  FROM move_work m LEFT JOIN current_work d ON d.location_id=%s AND d.edition_id=m.edition_id
                  GROUP BY m.edition_id""", (destination,))
                over = conn.execute("""SELECT first_source_id,edition_id FROM arrival_work
                  WHERE coalesce(destination_quantity,0)+quantity>%s
                  ORDER BY first_source_id,edition_id LIMIT 1""", (MAX_QUANTITY,)).fetchone()
                if over:
                    api_error(409, "QUANTITY_OVERFLOW", source_id=over["first_source_id"], edition_id=over["edition_id"])
            if destination is None:
                check_promises(conn, user_id, {row["edition_id"]: row["copies"] for row in conn.execute(
                    "SELECT edition_id,sum(quantity) AS copies FROM move_work GROUP BY edition_id")})
            new_revision = revision + 1
            conn.execute("""DELETE FROM holding h USING move_work w
              WHERE h.owner_id=%s AND h.location_id=w.source_id AND h.edition_id=w.edition_id
              AND h.quantity=w.quantity""", (user_id,))
            conn.execute("""UPDATE holding h SET quantity=h.quantity-w.quantity,version=%s
              FROM move_work w WHERE h.owner_id=%s AND h.location_id=w.source_id AND h.edition_id=w.edition_id
              AND h.quantity>w.quantity""", (new_revision, user_id))
            if destination is not None:
                # Migration 031's holding trigger extends a destination Deck's Deck List to cover these copies.
                conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
                  SELECT %s,%s,edition_id,quantity::bigint,%s FROM arrival_work WHERE true
                  ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE
                    SET quantity=holding.quantity+EXCLUDED.quantity,version=EXCLUDED.version""",
                             (user_id, destination, new_revision))
            undo_id = undo_id_for(user_id, command.idempotency_key) if command.undo else None
            result = MoveResult(edition_count=summary["editions"], copy_count=str(summary["copies"]),
                                owner_revision=new_revision, source_count=summary["sources"],
                                already_at_destination_count=str(scope["already"]), undo_id=undo_id)
            conn.execute("UPDATE inventory_owner SET revision=%s WHERE user_id=%s", (new_revision, user_id))
            conn.execute("""INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision)
              VALUES (%s,%s,%s,%s)""", (user_id, command.idempotency_key, digest, new_revision))
            conn.execute("""INSERT INTO move_response(owner_id,request_key,edition_count,copy_count,
                source_count,already_at_destination_count) VALUES (%s,%s,%s,%s,%s,%s)""",
                         (user_id, command.idempotency_key, summary["editions"], summary["copies"],
                          summary["sources"], scope["already"]))
            if command.undo:
                items = conn.execute("""SELECT jsonb_agg(jsonb_build_object(
                    'source_id',source_id,'edition_id',edition_id,'quantity',quantity::text))::text AS items
                  FROM move_work""").fetchone()["items"]
                record_undo(conn, user_id, undo_id, payload["action"], destination, sources, items,
                            returns_as_surplus=command.put_away)
            conn.execute("DELETE FROM move_manifest WHERE owner_id=%s", (user_id,))
            return result
    except psycopg.Error:
        api_error(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")


class UndoCommand(BaseModel):
    idempotency_key: UUID


@router.get('/undo')
def list_undo(user_id: str = Depends(verified_user)):
    with connect() as conn:
        return conn.execute("""SELECT id,action,source_id,destination_id,source_count,expires_at
          FROM inventory_undo WHERE owner_id=%s AND expires_at>clock_timestamp()
          ORDER BY created_at DESC,id DESC LIMIT 5""", (user_id,)).fetchall()


@router.delete('/undo/{undo_id}', status_code=204)
def dismiss_undo(undo_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        lock_owner(conn, user_id)
        if not conn.execute('DELETE FROM inventory_undo WHERE owner_id=%s AND id=%s', (user_id, undo_id)).rowcount:
            api_error(404, 'UNDO_NOT_FOUND')


@router.post('/undo/{undo_id}', response_model=MoveResult)
def undo_inventory(undo_id: UUID, command: UndoCommand, user_id: str = Depends(verified_user)):
    digest = hashlib.sha256(f'undo:{undo_id}'.encode()).hexdigest()
    try:
        with connect() as conn, conn.transaction():
            revision = lock_owner(conn, user_id)
            previous = conn.execute(REPLAY + ' AND mr.expires_at>now()', (user_id, command.idempotency_key)).fetchone()
            if previous:
                if previous['command_digest'] != digest:
                    api_error(409, 'IDEMPOTENCY_KEY_REUSED')
                return replayed(previous)
            entry = conn.execute('''SELECT action,destination_id,returns_as_surplus,expires_at<=clock_timestamp() AS expired
              FROM inventory_undo WHERE owner_id=%s AND id=%s''', (user_id, undo_id)).fetchone()
            if not entry:
                api_error(404, 'UNDO_NOT_FOUND')
            if entry['expired']:
                api_error(410, 'UNDO_EXPIRED')
            newest = conn.execute('SELECT id FROM inventory_undo WHERE owner_id=%s AND expires_at>clock_timestamp() ORDER BY created_at DESC,id DESC LIMIT 1', (user_id,)).fetchone()
            if newest['id'] != undo_id:
                api_error(409, 'UNDO_NOT_NEWEST')
            destination = entry['destination_id']
            if entry['action'] == 'add':
                return undo_add(conn, user_id, undo_id, destination, revision, command.idempotency_key, digest)
            # Items written before multi-source carry no source_id; their source is the record's.
            conn.execute('''CREATE TEMP TABLE undo_work ON COMMIT DROP AS
              SELECT coalesce(p.source_id,u.source_id) AS source_id,p.edition_id,p.quantity
              FROM inventory_undo u
              CROSS JOIN LATERAL jsonb_to_recordset(u.payload) AS p(source_id uuid,edition_id uuid,quantity bigint)
              WHERE u.owner_id=%s AND u.id=%s''', (user_id, undo_id))
            conn.execute('CREATE UNIQUE INDEX ON undo_work(source_id,edition_id)')
            conn.execute('ANALYZE undo_work')
            sources = [row['source_id'] for row in conn.execute('SELECT DISTINCT source_id FROM undo_work').fetchall()]
            if not sources or None in sources:
                api_error(409, 'UNDO_INCOMPATIBLE')
            sources.sort()
            gone = first_non_leaf(conn, user_id, sources)
            if gone is not None:
                api_error(409, 'UNDO_INCOMPATIBLE', source_id=gone)
            if destination is not None and not leaf(conn, user_id, destination):
                api_error(409, 'UNDO_INCOMPATIBLE', destination_id=destination)
            overflow = conn.execute('''SELECT w.source_id,w.edition_id FROM undo_work w
              LEFT JOIN holding h ON h.owner_id=%s AND h.location_id=w.source_id AND h.edition_id=w.edition_id
              WHERE coalesce(h.quantity,0)>%s-w.quantity ORDER BY w.source_id,w.edition_id LIMIT 1''',
                                    (user_id, MAX_QUANTITY)).fetchone()
            if overflow:
                api_error(409, 'UNDO_INCOMPATIBLE', source_id=overflow['source_id'], edition_id=overflow['edition_id'])
            if destination is not None:
                # One destination row per Card Edition: the destination must still hold
                # every copy that arrived from all sources together.
                conn.execute('''CREATE TEMP TABLE departure_work ON COMMIT DROP AS
                  SELECT edition_id,sum(quantity) AS quantity,
                    (array_agg(source_id ORDER BY source_id))[1] AS first_source_id
                  FROM undo_work GROUP BY edition_id''')
                short = conn.execute('''SELECT d.first_source_id,d.edition_id FROM departure_work d
                  LEFT JOIN holding h ON h.owner_id=%s AND h.location_id=%s AND h.edition_id=d.edition_id
                  WHERE coalesce(h.quantity,0)<d.quantity ORDER BY d.first_source_id,d.edition_id LIMIT 1''',
                                     (user_id, destination)).fetchone()
                if short:
                    api_error(409, 'UNDO_INCOMPATIBLE', source_id=short['first_source_id'], edition_id=short['edition_id'])
            summary = conn.execute('SELECT count(DISTINCT edition_id) AS editions,sum(quantity) AS copies FROM undo_work').fetchone()
            new_revision = revision + 1
            if destination is not None:
                conn.execute('''DELETE FROM holding h USING departure_work d WHERE h.owner_id=%s AND h.location_id=%s
                  AND h.edition_id=d.edition_id AND h.quantity=d.quantity''', (user_id, destination))
                conn.execute('''UPDATE holding h SET quantity=h.quantity-d.quantity::bigint,version=%s FROM departure_work d
                  WHERE h.owner_id=%s AND h.location_id=%s AND h.edition_id=d.edition_id AND h.quantity>d.quantity''',
                             (new_revision, user_id, destination))
            # Copies returned to a source Deck are covered by migration 031's holding trigger, except a Put away's
            # (migration 047): its copies return as surplus, so the trigger is switched off for this one statement (its
            # insert and its update firings) and on again before anything else writes a Holding. A Deck that loses
            # copies here keeps its Deck List lines.
            if entry['returns_as_surplus']:
                conn.execute("SELECT set_config('tcg.undo_returns_surplus','on',true)")
            conn.execute('''INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
              SELECT %s,source_id,edition_id,quantity,%s FROM undo_work WHERE true
              ON CONFLICT(owner_id,location_id,edition_id) DO UPDATE SET quantity=holding.quantity+excluded.quantity,version=excluded.version''',
                         (user_id, new_revision))
            if entry['returns_as_surplus']:
                conn.execute("SELECT set_config('tcg.undo_returns_surplus','off',true)")
            conn.execute('UPDATE inventory_owner SET revision=%s WHERE user_id=%s', (new_revision, user_id))
            expire(conn, user_id)
            conn.execute('INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision) VALUES (%s,%s,%s,%s)',
                         (user_id, command.idempotency_key, digest, new_revision))
            conn.execute('''INSERT INTO move_response(owner_id,request_key,edition_count,copy_count,source_count,
                already_at_destination_count) VALUES (%s,%s,%s,%s,%s,0)''',
                         (user_id, command.idempotency_key, summary['editions'], summary['copies'], len(sources)))
            conn.execute('DELETE FROM inventory_undo WHERE owner_id=%s AND (id=%s OR expires_at<=clock_timestamp())', (user_id, undo_id))
            return MoveResult(edition_count=summary['editions'], copy_count=str(summary['copies']), owner_revision=new_revision,
                              source_count=len(sources), already_at_destination_count='0')
    except psycopg.Error:
        api_error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


def undo_add(conn, user_id: str, undo_id: UUID, location_id: UUID, revision: int, key: UUID, digest: str) -> MoveResult:
    """Undoes a batch add (migration 046) in the caller's transaction, after its owner lock, replay, expiry and
    newest-record checks: takes exactly the copies the add put in its Location out again, and puts them nowhere else.
    When the Location is no longer a Storage Leaf or Deck, or no longer holds every one of those copies (some were
    moved, removed or corrected away since), nothing changes and the answer is UNDO_INCOMPATIBLE, naming the Location
    and, for a short Holding, the lowest such Card Edition."""
    if not leaf(conn, user_id, location_id):
        api_error(409, 'UNDO_INCOMPATIBLE', destination_id=location_id)
    conn.execute('''CREATE TEMP TABLE added_work ON COMMIT DROP AS
      SELECT p.edition_id,sum(p.quantity) AS quantity
      FROM inventory_undo u
      CROSS JOIN LATERAL jsonb_to_recordset(u.payload) AS p(edition_id uuid,quantity bigint)
      WHERE u.owner_id=%s AND u.id=%s GROUP BY p.edition_id''', (user_id, undo_id))
    summary = conn.execute('SELECT count(*) AS editions,coalesce(sum(quantity),0) AS copies FROM added_work').fetchone()
    if not summary['editions']:
        api_error(409, 'UNDO_INCOMPATIBLE', destination_id=location_id)
    short = conn.execute('''SELECT a.edition_id FROM added_work a
      LEFT JOIN holding h ON h.owner_id=%s AND h.location_id=%s AND h.edition_id=a.edition_id
      WHERE coalesce(h.quantity,0)<a.quantity ORDER BY a.edition_id LIMIT 1''', (user_id, location_id)).fetchone()
    if short:
        api_error(409, 'UNDO_INCOMPATIBLE', destination_id=location_id, edition_id=short['edition_id'])
    check_promises(conn, user_id, {row['edition_id']: row['quantity'] for row in conn.execute(
        'SELECT edition_id,quantity FROM added_work')})
    new_revision = revision + 1
    conn.execute('''DELETE FROM holding h USING added_work a WHERE h.owner_id=%s AND h.location_id=%s
      AND h.edition_id=a.edition_id AND h.quantity=a.quantity''', (user_id, location_id))
    # A Deck that loses copies here keeps its Deck List lines, as after any Move out of it.
    conn.execute('''UPDATE holding h SET quantity=h.quantity-a.quantity::bigint,version=%s FROM added_work a
      WHERE h.owner_id=%s AND h.location_id=%s AND h.edition_id=a.edition_id AND h.quantity>a.quantity''',
                 (new_revision, user_id, location_id))
    conn.execute('UPDATE inventory_owner SET revision=%s WHERE user_id=%s', (new_revision, user_id))
    expire(conn, user_id)
    conn.execute('INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision) VALUES (%s,%s,%s,%s)',
                 (user_id, key, digest, new_revision))
    conn.execute('''INSERT INTO move_response(owner_id,request_key,edition_count,copy_count,source_count,
        already_at_destination_count) VALUES (%s,%s,%s,%s,0,0)''', (user_id, key, summary['editions'], summary['copies']))
    conn.execute('DELETE FROM inventory_undo WHERE owner_id=%s AND (id=%s OR expires_at<=clock_timestamp())',
                 (user_id, undo_id))
    return MoveResult(edition_count=summary['editions'], copy_count=str(summary['copies']), owner_revision=new_revision,
                      source_count=0, already_at_destination_count='0')
