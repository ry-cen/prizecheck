"""Collection Import (#226; spec "Collection import from other trackers", ADR 0014): a collector's file becomes an
import draft on the server, which they review and then save into one Storage Leaf in one step.

- POST /api/collection-imports?location_id=<Storage Leaf> takes the file's bytes as the request body (no multipart).
  It reads the file (collection_import_reader), matches every row (collection_import_matcher) and stores the draft,
  replacing the collector's open draft: one open draft per collector. A saved draft stays, without rows, as the
  receipt that answers a repeated save for 24 hours; starting an import also deletes this collector's expired ones.
  A draft is not inventory, so starting one doesn't advance the owner revision.
- GET /api/collection-imports/current is the open draft's summary.
- GET /api/collection-imports/<id>/rows pages through its rows, 100 at a time, all of them or those that need the
  collector.
- POST /api/collection-imports/<id>/save adds every ready row's copies to the landing Storage Leaf, one Holding
  increment per Card Edition, in one transaction and one owner revision, then deletes the draft's rows. It records no
  Inventory Undo. A repeated key, or a second save of a saved draft, answers the stored result without writing.

Responses carry no raw source text, prices, marketplace IDs or source names: the UI must not show them. Nothing here
reads or refreshes prices or starts a catalog pull. The gateway still caps request bodies (deferred follow-up); this
API enforces MAX_IMPORT_BYTES and MAX_IMPORT_ROWS itself.
"""
import hashlib
import json
from typing import Literal
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from . import collection_import_matcher as matcher
from . import collection_import_reader as reader
from .main import connect, verified_user
from .moves import lock_owner
from .moves import fail as refuse

router = APIRouter(prefix="/api/collection-imports", tags=["collection-imports"])
PAGE_SIZE = 100
SPLIT_MESSAGES = {
    "IMPORT_TOO_LARGE": "This file is larger than 5 MB. Split it into two files and import each one.",
    "IMPORT_TOO_MANY_ROWS": "This file has more than 10,000 rows. Split it into two files and import each one.",
}
READY_ROW = matcher.READY_ROW.format(r="r")
NEEDS_YOU_ROW = matcher.NEEDS_YOU_ROW.format(r="r")


class CollectionImportCounts(BaseModel):
    rows: int
    needs_you: int
    ready: int


class CollectionImportSummary(BaseModel):
    id: UUID
    draft_revision: int
    location_id: UUID
    # The landing Location's own name, or None when it is gone.
    location_name: str | None
    counts: CollectionImportCounts
    # The copies the ready rows add, as text so no JSON reader rounds it.
    cards_to_add: str
    expires_at: str


class CollectionImportSource(BaseModel):
    """What the collector's file said, from the columns PrizeCheck reads; "" for a blank cell."""
    quantity: str
    name: str
    set_name: str
    number: str
    finish: str


class CollectionImportCard(BaseModel):
    printing_id: UUID
    name: str
    set_name: str
    collector_number: str


class CollectionImportEdition(BaseModel):
    edition_id: UUID
    descriptor: dict


class CollectionImportRow(BaseModel):
    row_number: int
    status: Literal["matched", "finish_unknown", "by_name", "ambiguous", "not_found", "unreadable"]
    needs_you: bool
    # None when the row's quantity can't be read.
    quantity: str | None
    source: CollectionImportSource
    # The matched Printing, when there is exactly one.
    card: CollectionImportCard | None
    edition: CollectionImportEdition | None


class CollectionImportRowsPage(BaseModel):
    rows: list[CollectionImportRow]
    # Pass as `cursor` for the next page; None on the last page.
    next_cursor: str | None
    draft_revision: int


class SaveCollectionImport(BaseModel):
    draft_revision: int = Field(ge=1)
    idempotency_key: UUID


class CollectionImportSaveResult(BaseModel):
    import_id: UUID
    location_id: UUID
    edition_count: int
    copy_count: str
    owner_revision: int


async def import_body(request: Request) -> bytes:
    """The upload's bytes; IMPORT_TOO_LARGE by length before anything else reads them."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > reader.MAX_IMPORT_BYTES:
        refuse(422, "IMPORT_TOO_LARGE", message=SPLIT_MESSAGES["IMPORT_TOO_LARGE"])
    body = await request.body()
    if len(body) > reader.MAX_IMPORT_BYTES:
        refuse(422, "IMPORT_TOO_LARGE", message=SPLIT_MESSAGES["IMPORT_TOO_LARGE"])
    return body


def storage_leaf(conn, user_id: str, location_id: UUID):
    """This collector's Storage Leaf (not a Deck, no children), or None."""
    return conn.execute("""SELECT l.id,l.name FROM location l WHERE l.owner_id=%s AND l.id=%s AND l.kind='storage_leaf'
      AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id=l.id)""", (user_id, location_id)).fetchone()


def summary(conn, user_id: str, import_id: UUID) -> CollectionImportSummary:
    row = conn.execute(f"""SELECT ci.id,ci.draft_revision,ci.location_id,ci.expires_at,l.name AS location_name,
        count(r.row_number) AS rows,
        count(r.row_number) FILTER (WHERE {NEEDS_YOU_ROW}) AS needs_you,
        count(r.row_number) FILTER (WHERE {READY_ROW}) AS ready,
        coalesce(sum(r.quantity) FILTER (WHERE {READY_ROW}),0) AS cards
      FROM collection_import ci
      LEFT JOIN location l ON l.owner_id=ci.owner_id AND l.id=ci.location_id
      LEFT JOIN collection_import_row r ON r.import_id=ci.id
      WHERE ci.owner_id=%s AND ci.id=%s AND ci.status='open'
      GROUP BY ci.id,l.name""", (user_id, import_id)).fetchone()
    if row is None:
        refuse(404, "IMPORT_NOT_FOUND")
    return CollectionImportSummary(
        id=row["id"], draft_revision=row["draft_revision"], location_id=row["location_id"],
        location_name=row["location_name"],
        counts=CollectionImportCounts(rows=row["rows"], needs_you=row["needs_you"], ready=row["ready"]),
        cards_to_add=str(int(row["cards"])), expires_at=row["expires_at"].isoformat())


@router.post("", response_model=CollectionImportSummary, status_code=201)
def start_import(location_id: UUID = Query(), body: bytes = Depends(import_body),
                 user_id: str = Depends(verified_user)):
    """Reads and matches the file and stores it as the collector's open import draft, replacing any other."""
    try:
        with connect() as conn:
            if not storage_leaf(conn, user_id, location_id):
                refuse(422, "NOT_STORAGE_LEAF")
        try:
            source = reader.read(body)
        except reader.ImportRefused as refused:
            refuse(422, refused.code, message=SPLIT_MESSAGES.get(refused.code))
        with connect() as conn:
            catalog = conn.execute("SELECT active_generation,revision FROM catalog_state WHERE singleton").fetchone()
            if catalog is None or catalog["active_generation"] is None:
                refuse(503, "CATALOG_UNAVAILABLE")
            matches = matcher.match(conn, catalog["active_generation"], source.rows)
        import_id = uuid4()
        with connect() as conn, conn.transaction():
            lock_owner(conn, user_id)
            if not storage_leaf(conn, user_id, location_id):
                refuse(422, "NOT_STORAGE_LEAF")
            # A saved draft keeps no rows, only its save result, for 24 hours of replays.
            conn.execute("DELETE FROM collection_import WHERE owner_id=%s AND (status='open' OR expires_at<=now())",
                         (user_id,))
            conn.execute("""INSERT INTO collection_import(id,owner_id,location_id,source,source_header,catalog_revision)
              VALUES (%s,%s,%s,%s,%s::jsonb,%s)""",
                         (import_id, user_id, location_id, source.source, json.dumps(source.header),
                          catalog["revision"]))
            with conn.cursor().copy("""COPY collection_import_row
                (import_id,row_number,raw_text,parsed,quantity,status,printing_id,edition_id) FROM STDIN""") as copy:
                for row, found in zip(source.rows, matches):
                    copy.write_row((import_id, row.row_number, row.raw_text, json.dumps(row.fields), found.quantity,
                                    found.status, found.printing_id, found.edition_id))
            return summary(conn, user_id, import_id)
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")


@router.get("/current", response_model=CollectionImportSummary)
def current_import(user_id: str = Depends(verified_user)):
    try:
        with connect() as conn:
            row = conn.execute("SELECT id FROM collection_import WHERE owner_id=%s AND status='open'",
                               (user_id,)).fetchone()
            if row is None:
                refuse(404, "IMPORT_NOT_FOUND")
            return summary(conn, user_id, row["id"])
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")


@router.get("/{import_id}/rows", response_model=CollectionImportRowsPage)
def import_rows(import_id: UUID, filter_: Literal["needs", "all"] = Query(default="all", alias="filter"),
                cursor: str | None = Query(default=None), user_id: str = Depends(verified_user)):
    """The draft's rows in file order after `cursor` (a row number), PAGE_SIZE at a time."""
    if cursor is not None and not (cursor.isascii() and cursor.isdecimal() and len(cursor) <= 12):
        refuse(400, "INVALID_CURSOR")
    after = int(cursor) if cursor else 0
    needs = f" AND {NEEDS_YOU_ROW}" if filter_ == "needs" else ""
    try:
        with connect() as conn:
            draft = conn.execute("SELECT draft_revision FROM collection_import WHERE owner_id=%s AND id=%s "
                                 "AND status='open'", (user_id, import_id)).fetchone()
            if draft is None:
                refuse(404, "IMPORT_NOT_FOUND")
            generation = conn.execute("SELECT active_generation FROM catalog_state WHERE singleton").fetchone()
            found = conn.execute(f"""SELECT r.row_number,r.status,r.quantity,r.parsed,r.printing_id,r.edition_id,
                r.skipped,r.left_out_reason,gp.display_name,gp.set_name,gp.collector_number,e.descriptor
              FROM (SELECT * FROM collection_import_row r WHERE r.import_id=%s AND r.row_number>%s{needs}
                    ORDER BY r.row_number LIMIT %s) r
              LEFT JOIN catalog_generation_printing gp ON gp.generation_id=%s AND gp.printing_id=r.printing_id
              LEFT JOIN catalog_edition e ON e.id=r.edition_id
              ORDER BY r.row_number""",
                                 (import_id, after, PAGE_SIZE + 1,
                                  generation["active_generation"] if generation else None)).fetchall()
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")
    page = found[:PAGE_SIZE]
    rows = []
    for row in page:
        parsed = row["parsed"]
        rows.append(CollectionImportRow(
            row_number=row["row_number"], status=row["status"],
            needs_you=(row["status"] in matcher.NEEDS_YOU and not row["skipped"] and row["left_out_reason"] is None),
            quantity=None if row["quantity"] is None else str(row["quantity"]),
            source=CollectionImportSource(**{field: parsed.get(field, "") for field in
                                             ("quantity", "name", "set_name", "number", "finish")}),
            card=None if row["printing_id"] is None or row["display_name"] is None else CollectionImportCard(
                printing_id=row["printing_id"], name=row["display_name"], set_name=row["set_name"],
                collector_number=row["collector_number"]),
            edition=None if row["edition_id"] is None or row["descriptor"] is None else CollectionImportEdition(
                edition_id=row["edition_id"], descriptor=row["descriptor"])))
    next_cursor = str(page[-1]["row_number"]) if len(found) > PAGE_SIZE else None
    return CollectionImportRowsPage(rows=rows, next_cursor=next_cursor, draft_revision=draft["draft_revision"])


@router.post("/{import_id}/save", response_model=CollectionImportSaveResult)
def save_import(import_id: UUID, command: SaveCollectionImport, user_id: str = Depends(verified_user)):
    """Adds the draft's ready rows to its Storage Leaf in one transaction, all or nothing. Refuses ROWS_NEED_YOU while
    any row needs the collector, STALE_DRAFT for another draft revision, and REVIEW_CHANGED when the Storage Leaf or a
    matched Card Edition is no longer there. A repeated key or a second save answers the stored result."""
    fingerprint = {"action": "collection_import_save", "import_id": str(import_id)}
    request_digest = hashlib.sha256(json.dumps(fingerprint, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    try:
        with connect() as conn, conn.transaction():
            revision = lock_owner(conn, user_id)
            conn.execute("DELETE FROM mutation_request WHERE owner_id=%s AND expires_at<=now()", (user_id,))
            previous = conn.execute("SELECT command_digest FROM mutation_request WHERE owner_id=%s AND request_key=%s",
                                    (user_id, command.idempotency_key)).fetchone()
            if previous and previous["command_digest"] != request_digest:
                refuse(409, "IDEMPOTENCY_KEY_REUSED")
            draft = conn.execute("""SELECT id,status,location_id,draft_revision,save_result FROM collection_import
              WHERE owner_id=%s AND id=%s FOR UPDATE""", (user_id, import_id)).fetchone()
            if draft is None:
                refuse(409 if previous else 404, "REPLAY_OUTCOME_UNAVAILABLE" if previous else "IMPORT_NOT_FOUND")
            if draft["status"] == "saved":
                return CollectionImportSaveResult(**draft["save_result"])
            if command.draft_revision != draft["draft_revision"]:
                refuse(409, "STALE_DRAFT")
            waiting = conn.execute(f"SELECT count(*) AS n FROM collection_import_row r WHERE r.import_id=%s "
                                   f"AND {NEEDS_YOU_ROW}", (import_id,)).fetchone()["n"]
            if waiting:
                refuse(422, "ROWS_NEED_YOU", count=waiting)
            location_id = draft["location_id"]
            if not storage_leaf(conn, user_id, location_id):
                refuse(409, "REVIEW_CHANGED")
            items = conn.execute(f"""SELECT r.edition_id,sum(r.quantity) AS quantity FROM collection_import_row r
              WHERE r.import_id=%s AND {READY_ROW} GROUP BY r.edition_id ORDER BY r.edition_id""",
                                 (import_id,)).fetchall()
            if not items:
                refuse(422, "NOTHING_TO_ADD")
            for item in items:
                if item["quantity"] > matcher.MAX_QUANTITY:
                    refuse(422, "QUANTITY_OVERFLOW", edition_id=item["edition_id"])
            work = json.dumps([{"edition_id": str(item["edition_id"]), "quantity": int(item["quantity"])}
                               for item in items])
            copies = sum(int(item["quantity"]) for item in items)
            # Hold the promoted generation stable until this save commits (as holdings.add_holdings).
            catalog = conn.execute("SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE").fetchone()
            unavailable = conn.execute("""SELECT w.edition_id FROM jsonb_to_recordset(%s::jsonb)
                AS w(edition_id uuid,quantity bigint)
              WHERE NOT EXISTS (SELECT 1 FROM catalog_generation_edition ge
                JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
                WHERE ge.generation_id=%s AND ge.edition_id=w.edition_id AND ge.active AND NOT gp.tombstoned)
              ORDER BY w.edition_id LIMIT 1""", (work, catalog["active_generation"])).fetchone()
            if unavailable:
                refuse(409, "REVIEW_CHANGED")
            over = conn.execute("""SELECT w.edition_id FROM jsonb_to_recordset(%s::jsonb)
                AS w(edition_id uuid,quantity bigint)
              JOIN holding h ON h.owner_id=%s AND h.location_id=%s AND h.edition_id=w.edition_id
              WHERE h.quantity>%s-w.quantity ORDER BY w.edition_id LIMIT 1""",
                                (work, user_id, location_id, matcher.MAX_QUANTITY)).fetchone()
            if over:
                refuse(422, "QUANTITY_OVERFLOW", edition_id=over["edition_id"])
            new_revision = revision + 1
            conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
              SELECT %s,%s,edition_id,quantity,%s FROM jsonb_to_recordset(%s::jsonb) AS w(edition_id uuid,quantity bigint)
              WHERE true
              ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE
                SET quantity=holding.quantity+EXCLUDED.quantity,version=EXCLUDED.version""",
                         (user_id, location_id, new_revision, work))
            conn.execute("UPDATE inventory_owner SET revision=%s WHERE user_id=%s", (new_revision, user_id))
            conn.execute("""INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision)
              VALUES (%s,%s,%s,%s)""", (user_id, command.idempotency_key, request_digest, new_revision))
            result = CollectionImportSaveResult(import_id=import_id, location_id=location_id, edition_count=len(items),
                                                copy_count=str(copies), owner_revision=new_revision)
            conn.execute("""UPDATE collection_import SET status='saved',saved_at=now(),changed_at=now(),
                expires_at=now()+interval '24 hours',save_key=%s,save_result=%s::jsonb WHERE id=%s""",
                         (command.idempotency_key, result.model_dump_json(), import_id))
            # The raw rows hold the collector's whole file; a saved draft keeps only its result.
            conn.execute("DELETE FROM collection_import_row WHERE import_id=%s", (import_id,))
            return result
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")
