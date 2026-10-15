"""Collection Import (#226 to #234; spec "Collection import from other trackers", ADR 0014): a collector's file
becomes an import draft on the server, which they review and then save into one Storage Leaf in one step.

- POST /api/collection-imports?location_id=<Storage Leaf> takes the file's bytes as the request body (no multipart): a
  CSV, TSV or TXT export from any supported tracker or with name-like columns, or a zip holding one such file, told
  apart by its bytes, not its content type. A paste (#234) is the JSON body ``{"text": …}`` with the content type
  application/json, read by collection_import_reader.read_paste (a malformed body is 422 INVALID_PASTE); it then
  goes the file's way. It reads the file (collection_import_reader), matches every row
  (collection_import_matcher, whose filters first leave out the rows PrizeCheck can't hold: watchlist rows, sealed
  product, other games and non-English cards, #231) and stores the draft with the detected source (for matching only),
  each row's group, each left-out row's reason and each row's candidate Printings (Pick one, or a Basic Energy's other
  Printings), replacing the collector's open draft without asking (the web asks first, #233): one open draft per
  collector. A collector starts at most MAX_STARTS_PER_DAY drafts in any 24 hours (429 IMPORT_RATE_LIMITED, counted in
  collection_import_start, migration 051). A draft is not inventory, so starting one doesn't advance the owner revision.
- **Expiry (#233).** An open draft expires 24 hours after its last change (start, a change); a saved draft keeps no
  rows, only its save result, as the receipt that answers a repeated save, for 24 hours after the save. Every route
  reads a draft only before its expires_at (OPEN_DRAFT, and save's receipt), so an expired draft answers 404 at once.
  Its rows are deleted by the sweep (sweep_expired) that the start and current routes run, a few drafts of any
  collector at a time, and by the collector's own next start. Private backups never hold a draft (scripts/recovery.py
  TRANSIENT).
- GET /api/collection-imports/current is the open draft's summary: its counts; the left-out rows' count per reason
  with a few of each, as the file wrote them; the file's groups (portfolios, folders, lists) with their rows and
  whether each is included (#232); and how many of the cards to add are of Card Editions the Collection already holds.
- GET /api/collection-imports/<id>/rows pages through its rows, 100 at a time, by filter: needs (Needs you), finish
  (Finish unknown), name (Matched by name), all (every row not skipped) or skipped. Each row lists its card's active
  Editions, for the finish picker, its candidate cards, for Pick one and Change, its group, and the copies of its Card
  Edition already in the Collection, in every Location and Deck (#232).
- POST /api/collection-imports/<id>/changes applies the collector's changes at the draft's revision, in order and in one
  transaction, and answers the new summary (and revision) with what each change couldn't apply to. A change picks
  rows by number or by filter, and either picks their card (a Printing, whose Edition the row's finish then chooses,
  or one Edition), sets their finish (a Variant Descriptor; only where the row's card has exactly one active Edition
  that fits it, collection_import_finish), skips them or restores them. A skipped row is neither ready nor needs the
  collector, so the save leaves it out. Two changes name no rows (#232): `group` with `include` leaves a group of the
  file out, or brings it back, and `location_id` moves the landing Storage Leaf. A row in a group left out is in no
  count, filter, download or save, and no change reaches it; bringing the group back brings each row back as it was.
  Groups are never Locations: every included row lands in the one Storage Leaf.
- GET /api/collection-imports/<id>/skipped.csv and .../left-out.csv download the skipped rows and the left-out rows
  (#231) in the file's own columns: its header, then each row's cells as the file held them, as CSV (a tab-separated
  file comes back comma-separated). A pasted list's rows (source PASTE, #234) come back as the lines as they were
  pasted, as plain text.
- POST /api/collection-imports/<id>/save adds every ready row's copies to the landing Storage Leaf, one Holding
  increment per Card Edition, in one transaction and one owner revision, then deletes the draft's rows. It records no
  Inventory Undo. A repeated key, or a second save of a saved draft, answers the stored result without writing. When
  the landing Location is no longer the collector's Storage Leaf, or a ready row's Card Edition is no longer active,
  it refuses 409 REVIEW_CHANGED; for the Editions, it first returns those rows to Needs you (#233,
  return_to_needs_you) and advances the draft revision, so the review reloads onto them.

Another collector's draft id answers 404 IMPORT_NOT_FOUND on every route, as an unknown one does.

JSON responses carry no raw source text, prices, marketplace IDs or the detected source: the UI must not show them.
Every descriptor in a response keeps its physical keys only (collection_import_finish.public_descriptor), so TCGdex's
marketplace lookup IDs stay out. The one response that names trackers is IMPORT_UNREADABLE's message, the list of
trackers whose files are read. Nothing here reads or refreshes prices or starts a catalog pull. The gateway caps request
bodies (auth/src/server.ts IMPORT_ROUTES): 5 MiB for the start route, forwarded as raw bytes, 64 KiB for changes and 16
KiB for the rest; it streams the skipped and left-out rows' attachments as it streams Deck exports. This API enforces
MAX_IMPORT_BYTES and MAX_IMPORT_ROWS itself too.
"""
import csv
import hashlib
import io
import json
from typing import Annotated, Literal
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from . import collection_import_finish as finishes
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
# A paste's refusals (#234) say "list", not "file".
PASTE_MESSAGES = {
    "IMPORT_TOO_LARGE": "This list is larger than 5 MB. Split it into two lists and import each one.",
    "IMPORT_TOO_MANY_ROWS": "This list has more than 10,000 rows. Split it into two lists and import each one.",
    "IMPORT_UNREADABLE": "PrizeCheck can't read this list. Paste it as plain text.",
}
# A start refusal's message, by code. IMPORT_UNREADABLE lists the trackers whose exports are read (the web shows its own
# copy and opens its export steps instead).
REFUSAL_MESSAGES = {
    **SPLIT_MESSAGES,
    "IMPORT_UNREADABLE": "PrizeCheck can't read this file. It reads CSV exports from the TCGplayer app, Collectr, "
                         "PriceCharting, TCG Collector, Dragon Shield and Sorted, and CSV files with columns for each "
                         "card's set and its number or name.",
    "IMPORT_BAD_ZIP": "PrizeCheck can't read this zip file. It must hold one CSV, TSV or TXT file, with no password.",
}
# A collector starts at most this many import drafts in any 24 hours (#233); the 21st start is refused 429.
MAX_STARTS_PER_DAY = 20
RATE_LIMITED_MESSAGE = "You can start 20 imports a day. Try again tomorrow."
# This collector's import starts in the last 24 hours (collection_import_start, migration 051).
STARTS_TODAY = """SELECT count(*) AS n FROM collection_import_start
  WHERE owner_id=%s AND started_at>now()-interval '24 hours'"""
# A draft the collector can still review: open and not expired (#233). For alias ci.
OPEN_DRAFT = "ci.status='open' AND ci.expires_at>now()"
# Each sweep deletes at most this many expired drafts (with their rows), any collector's, oldest first.
SWEEP_LIMIT = 20
READY_ROW = matcher.READY_ROW.format(r="r")
NEEDS_YOU_ROW = matcher.NEEDS_YOU_ROW.format(r="r")
FINISH_UNKNOWN_ROW = matcher.FINISH_UNKNOWN_ROW.format(r="r")
SKIPPED_ROW = matcher.SKIPPED_ROW.format(r="r")
LEFT_OUT_ROW = matcher.LEFT_OUT_ROW.format(r="r")
INCLUDED_ROW = matcher.INCLUDED_ROW.format(r="r")
BY_NAME_ROW = matcher.BY_NAME_ROW.format(r="r")
# Each row's candidate cards in the active generation, for one page: (printing id, name, set name, number).
CANDIDATE_CARDS = """SELECT gp.printing_id,gp.display_name,gp.set_name,gp.collector_number
  FROM catalog_generation_printing gp
  WHERE gp.generation_id=%s AND gp.printing_id=ANY(%s::uuid[]) AND NOT gp.tombstoned
    AND EXISTS (SELECT 1 FROM catalog_generation_edition ge
      WHERE ge.generation_id=gp.generation_id AND ge.printing_id=gp.printing_id AND ge.active)"""
RowFilter = Literal["needs", "finish", "name", "all", "skipped"]
# collection_import_matcher.LEFT_OUT_REASONS.
LeftOutReason = Literal["watchlist", "other_game", "not_english", "sealed"]
# How many left-out rows of each reason the summary shows, for View.
LEFT_OUT_EXAMPLES = 3
# The left-out rows' examples: the first LEFT_OUT_EXAMPLES of each reason in file order, with each reason's count.
LEFT_OUT = f"""SELECT reason,n,parsed FROM (
    SELECT r.left_out_reason AS reason,r.parsed,count(*) OVER (PARTITION BY r.left_out_reason) AS n,
      row_number() OVER (PARTITION BY r.left_out_reason ORDER BY r.row_number) AS k
    FROM collection_import_row r WHERE r.import_id=%s AND {LEFT_OUT_ROW}) found
  WHERE k<=%s ORDER BY reason,k"""
# The file's groups in file order (#232): the rows of each that weren't left out, and whether it is included. A group
# whose rows were all left out is not listed.
GROUPS = """SELECT r.group_name AS name,count(*) FILTER (WHERE r.left_out_reason IS NULL) AS n,
    NOT (ci.excluded_groups @> jsonb_build_array(r.group_name)) AS included
  FROM collection_import_row r JOIN collection_import ci ON ci.id=r.import_id
  WHERE r.import_id=%s AND r.group_name IS NOT NULL
  GROUP BY r.group_name,ci.excluded_groups HAVING count(*) FILTER (WHERE r.left_out_reason IS NULL)>0
  ORDER BY min(r.row_number)"""
# The copies of each of these Card Editions in the collector's Collection, every Location and Deck (as catalog search
# counts a card's owned copies, catalog_browse).
HELD = """SELECT edition_id,sum(quantity) AS held FROM holding WHERE owner_id=%s AND edition_id=ANY(%s::uuid[])
  GROUP BY edition_id"""
# One changes request holds at most MAX_CHANGES changes, and a change names at most MAX_CHANGE_ROWS rows by number: the
# gateway's 64 KiB body limit for this route binds first. It fits every row of a 10,000-row file named one by one
# (about 49 KB). Select all sends its filter instead.
MAX_CHANGES = 100
MAX_CHANGE_ROWS = 1000


class CollectionImportCounts(BaseModel):
    # Every row in the file, left-out rows and rows in groups left out included.
    rows: int
    needs_you: int
    ready: int
    # Ready rows on the card's Unspecified Variant (part of `ready`).
    finish_unknown: int
    # Ready rows whose card came from their name within their set, whatever their finish (part of `ready`).
    by_name: int
    # Neither ready nor needing the collector. needs_you + ready is the All filter's count.
    skipped: int


class CollectionImportSource(BaseModel):
    """What the collector's file said, from the columns PrizeCheck reads; "" for a blank cell."""
    quantity: str
    name: str
    set_name: str
    number: str
    finish: str


class CollectionImportLeftOut(BaseModel):
    """The rows the filters left out for one reason (#231): never listed, counted or saved."""
    reason: LeftOutReason
    rows: int
    # The first LEFT_OUT_EXAMPLES of them, in file order, as the file wrote them.
    examples: list[CollectionImportSource]


class CollectionImportGroup(BaseModel):
    """One of the file's groups (#232): a portfolio, folder or list, never a Location."""
    name: str
    # Its rows that weren't left out (#231), whether or not it is included.
    rows: int
    # False once the collector leaves it out: its rows are then in no count, filter, download or save.
    included: bool


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
    # The left-out rows (#231), one entry per reason that has any, in LEFT_OUT_REASONS order. counts.rows includes
    # them; no other count does. Rows in a group left out (#232) aren't counted.
    left_out: list[CollectionImportLeftOut]
    # The file's groups in file order (#232); [] for a file without groups. Rows with no group are always included.
    groups: list[CollectionImportGroup]
    # Of cards_to_add, the copies whose Card Edition the Collection already holds (#232): importing adds to them.
    already_held: str
    # The draft is a pasted list read line by line (#234): its rows are lines, and its downloads are text.
    lines: bool


class CollectionImportCard(BaseModel):
    printing_id: UUID
    name: str
    set_name: str
    collector_number: str


class CollectionImportEdition(BaseModel):
    edition_id: UUID
    # The Variant Descriptor's physical keys (collection_import_finish.public_descriptor). Send it back as a change's
    # `finish` to choose this Edition.
    descriptor: dict


class CollectionImportRow(BaseModel):
    row_number: int
    status: Literal["matched", "finish_unknown", "by_name", "ambiguous", "not_found", "unreadable"]
    needs_you: bool
    # None when the row's quantity can't be read.
    quantity: str | None
    source: CollectionImportSource
    skipped: bool
    # The matched Printing, when there is exactly one.
    card: CollectionImportCard | None
    edition: CollectionImportEdition | None
    # The card's active Editions in catalog order, for the finish picker; [] without a card.
    editions: list[CollectionImportEdition]
    # The cards the row could be, for Pick one (an ambiguous row without a card) and Change (a Basic Energy's other
    # Printings, the matched one first); [] for most rows. Only cards still in the catalog are listed.
    candidates: list[CollectionImportCard]
    # The collector chose this row's card (a pick), so Change can choose another.
    picked: bool
    # The row's card came from its name within its set, whatever its finish; a pick clears it.
    by_name: bool
    # The row's portfolio, folder or list in the file (#232), or None.
    group: str | None
    # The copies of the row's Card Edition already in the Collection, every Location and Deck (#232); "0" without one.
    held: str


class CollectionImportRowsPage(BaseModel):
    rows: list[CollectionImportRow]
    # Pass as `cursor` for the next page; None on the last page.
    next_cursor: str | None
    draft_revision: int


class SaveCollectionImport(BaseModel):
    draft_revision: int = Field(ge=1)
    idempotency_key: UUID


class CollectionImportPick(BaseModel):
    """The card a row is: exactly one of a Printing (the row's finish then chooses its Edition, as matching does) or one
    of its active Editions."""
    model_config = ConfigDict(extra="forbid")
    printing_id: UUID | None = None
    edition_id: UUID | None = None


class CollectionImportChange(BaseModel):
    """One change, with exactly one action. `pick`, `finish`, `skip` and `restore` apply to rows: by `rows` (row
    numbers) or `filter` (the rows route's filter, as it stands when this change applies), exactly one of them.
    `group` with `include` (#232) leaves one of the file's groups out (false) or brings it back (true), and
    `location_id` (#232) moves the landing Storage Leaf; neither names rows. Unknown fields are refused, so an older
    API never ignores a newer change."""
    model_config = ConfigDict(extra="forbid")
    rows: list[Annotated[int, Field(ge=1, le=reader.MAX_IMPORT_ROWS)]] | None = Field(
        default=None, min_length=1, max_length=MAX_CHANGE_ROWS)
    filter: RowFilter | None = None
    pick: CollectionImportPick | None = None
    # A Variant Descriptor: one of the row's `editions[].descriptor`, or a finish such as {"type": "reverse"}. It
    # applies to a row whose card has exactly one active Edition that fits it.
    finish: dict | None = None
    skip: bool = False
    restore: bool = False
    # One of the summary's groups' names, with `include`.
    group: str | None = Field(default=None, min_length=1)
    include: bool | None = None
    # The collector's Storage Leaf to land in instead.
    location_id: UUID | None = None


class ChangeCollectionImport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft_revision: int = Field(ge=1)
    changes: list[CollectionImportChange] = Field(max_length=MAX_CHANGES)


class CollectionImportChangeResult(BaseModel):
    # How many of the change's rows it applied to; for a group, the group's rows that weren't left out when its
    # inclusion changed, else 0; for a Location, 0.
    applied: int
    # The row numbers it couldn't apply to, in file order: for a pick, skipped rows and rows whose quantity can't be
    # read; for a finish, rows without a card, skipped rows and rows whose card has no Edition that fits; for skip and
    # restore, rows already so. Left-out rows (#231) and rows in a group left out (#232) are never applied to. Always []
    # for a group or a Location.
    not_applied: list[int]


class CollectionImportChanges(BaseModel):
    # The draft after every change, at its new draft_revision.
    summary: CollectionImportSummary
    # One result per change, in order.
    results: list[CollectionImportChangeResult]


class PasteCollectionImport(BaseModel):
    """A paste's start body (#234)."""
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str


class CollectionImportSaveResult(BaseModel):
    import_id: UUID
    location_id: UUID
    edition_count: int
    copy_count: str
    owner_revision: int


def is_paste(request: Request) -> bool:
    """The start body is a paste's JSON (#234), by its content type; anything else is a file's bytes."""
    return request.headers.get("content-type", "").split(";")[0].strip().lower() == "application/json"


async def import_body(request: Request) -> bytes:
    """The upload's bytes; IMPORT_TOO_LARGE by length before anything else reads them."""
    messages = PASTE_MESSAGES if is_paste(request) else SPLIT_MESSAGES
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > reader.MAX_IMPORT_BYTES:
        refuse(422, "IMPORT_TOO_LARGE", message=messages["IMPORT_TOO_LARGE"])
    body = await request.body()
    if len(body) > reader.MAX_IMPORT_BYTES:
        refuse(422, "IMPORT_TOO_LARGE", message=messages["IMPORT_TOO_LARGE"])
    return body


def read_source(request: Request, body: bytes) -> reader.SourceFile:
    """The start body's source rows: a paste's text (#234) or a file's bytes. Refuses 422 with the reader's code and,
    for a paste, INVALID_PASTE when the body isn't {"text": <string>}."""
    paste = is_paste(request)
    try:
        if not paste:
            return reader.read(body)
        try:
            text = PasteCollectionImport.model_validate_json(body).text
        except ValueError:
            refuse(422, "INVALID_PASTE")
        return reader.read_paste(text)
    except reader.ImportRefused as refused:
        messages = {**REFUSAL_MESSAGES, **PASTE_MESSAGES} if paste else REFUSAL_MESSAGES
        refuse(422, refused.code, message=messages.get(refused.code))


def sweep_expired(conn) -> int:
    """Deletes up to SWEEP_LIMIT expired drafts, any collector's, oldest first, with their rows (the foreign key
    cascades); how many it deleted. Drafts another request holds are skipped, never waited for. There is no scheduler,
    so the start and current routes run it (#233)."""
    return len(conn.execute("""DELETE FROM collection_import WHERE id IN (
        SELECT id FROM collection_import WHERE expires_at<=now() ORDER BY expires_at,id LIMIT %s FOR UPDATE SKIP LOCKED)
      RETURNING id""", (SWEEP_LIMIT,)).fetchall())


def rate_limited(conn, user_id: str) -> None:
    """IMPORT_RATE_LIMITED (429) once this collector has started MAX_STARTS_PER_DAY drafts in the last 24 hours."""
    if conn.execute(STARTS_TODAY, (user_id,)).fetchone()["n"] >= MAX_STARTS_PER_DAY:
        refuse(429, "IMPORT_RATE_LIMITED", message=RATE_LIMITED_MESSAGE)


def storage_leaf(conn, user_id: str, location_id: UUID):
    """This collector's Storage Leaf (not a Deck, no children), or None."""
    return conn.execute("""SELECT l.id,l.name FROM location l WHERE l.owner_id=%s AND l.id=%s AND l.kind='storage_leaf'
      AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id=l.id)""", (user_id, location_id)).fetchone()


def source_of(parsed: dict) -> CollectionImportSource:
    """What the row said; its set is the set name, else the set code (a pasted line's "PAL", #234)."""
    fields = {field: parsed.get(field, "") for field in ("quantity", "name", "number", "finish")}
    return CollectionImportSource(**fields, set_name=parsed.get("set_name") or parsed.get("set_code", ""))


def left_out(conn, import_id: UUID) -> list[CollectionImportLeftOut]:
    found: dict[str, CollectionImportLeftOut] = {}
    for row in conn.execute(LEFT_OUT, (import_id, LEFT_OUT_EXAMPLES)):
        entry = found.setdefault(row["reason"], CollectionImportLeftOut(reason=row["reason"], rows=row["n"],
                                                                         examples=[]))
        entry.examples.append(source_of(row["parsed"]))
    return [found[reason] for reason in matcher.LEFT_OUT_REASONS if reason in found]


def summary(conn, user_id: str, import_id: UUID) -> CollectionImportSummary:
    row = conn.execute(f"""WITH held AS (SELECT DISTINCT h.edition_id FROM holding h WHERE h.owner_id=%s)
      SELECT ci.id,ci.draft_revision,ci.location_id,ci.expires_at,ci.source,l.name AS location_name,
        count(r.row_number) AS rows,
        count(r.row_number) FILTER (WHERE {NEEDS_YOU_ROW}) AS needs_you,
        count(r.row_number) FILTER (WHERE {READY_ROW}) AS ready,
        count(r.row_number) FILTER (WHERE {FINISH_UNKNOWN_ROW}) AS finish_unknown,
        count(r.row_number) FILTER (WHERE {BY_NAME_ROW}) AS by_name,
        count(r.row_number) FILTER (WHERE {SKIPPED_ROW}) AS skipped,
        coalesce(sum(r.quantity) FILTER (WHERE {READY_ROW}),0) AS cards,
        coalesce(sum(r.quantity) FILTER (WHERE {READY_ROW} AND held.edition_id IS NOT NULL),0) AS already_held
      FROM collection_import ci
      LEFT JOIN location l ON l.owner_id=ci.owner_id AND l.id=ci.location_id
      LEFT JOIN collection_import_row r ON r.import_id=ci.id
      LEFT JOIN held ON held.edition_id=r.edition_id
      WHERE ci.owner_id=%s AND ci.id=%s AND {OPEN_DRAFT}
      GROUP BY ci.id,l.name""", (user_id, user_id, import_id)).fetchone()
    if row is None:
        refuse(404, "IMPORT_NOT_FOUND")
    return CollectionImportSummary(
        id=row["id"], draft_revision=row["draft_revision"], location_id=row["location_id"],
        location_name=row["location_name"],
        counts=CollectionImportCounts(rows=row["rows"], needs_you=row["needs_you"], ready=row["ready"],
                                      finish_unknown=row["finish_unknown"], by_name=row["by_name"],
                                      skipped=row["skipped"]),
        cards_to_add=str(int(row["cards"])), expires_at=row["expires_at"].isoformat(),
        left_out=left_out(conn, import_id),
        groups=[CollectionImportGroup(name=group["name"], rows=group["n"], included=group["included"])
                for group in conn.execute(GROUPS, (import_id,))],
        already_held=str(int(row["already_held"])), lines=row["source"] == reader.PASTE)


@router.post("", response_model=CollectionImportSummary, status_code=201)
def start_import(request: Request, location_id: UUID = Query(), body: bytes = Depends(import_body),
                 user_id: str = Depends(verified_user)):
    """Reads and matches the file (or the paste, #234) and stores it as the collector's open import draft, replacing any
    other. Refuses IMPORT_RATE_LIMITED (429) before reading when this collector has started MAX_STARTS_PER_DAY drafts
    in the last 24 hours, and again when it stores the draft, so two starts at once can't both pass the limit. A
    refused start isn't counted."""
    try:
        with connect() as conn:
            sweep_expired(conn)
        with connect() as conn:
            if not storage_leaf(conn, user_id, location_id):
                refuse(422, "NOT_STORAGE_LEAF")
            rate_limited(conn, user_id)
        source = read_source(request, body)
        with connect() as conn:
            catalog = conn.execute("SELECT active_generation,revision FROM catalog_state WHERE singleton").fetchone()
            if catalog is None or catalog["active_generation"] is None:
                refuse(503, "CATALOG_UNAVAILABLE")
            matches = matcher.match(conn, catalog["active_generation"], source.rows, source.source, source.columns)
        import_id = uuid4()
        with connect() as conn, conn.transaction():
            lock_owner(conn, user_id)
            if not storage_leaf(conn, user_id, location_id):
                refuse(422, "NOT_STORAGE_LEAF")
            rate_limited(conn, user_id)
            conn.execute("""DELETE FROM collection_import_start
              WHERE owner_id=%s AND started_at<=now()-interval '24 hours'""", (user_id,))
            conn.execute("INSERT INTO collection_import_start(id,owner_id) VALUES (%s,%s)", (uuid4(), user_id))
            # A saved draft keeps no rows, only its save result, for 24 hours of replays.
            conn.execute("DELETE FROM collection_import WHERE owner_id=%s AND (status='open' OR expires_at<=now())",
                         (user_id,))
            conn.execute("""INSERT INTO collection_import(id,owner_id,location_id,source,source_header,catalog_revision)
              VALUES (%s,%s,%s,%s,%s::jsonb,%s)""",
                         (import_id, user_id, location_id, source.source, json.dumps(source.header),
                          catalog["revision"]))
            with conn.cursor().copy("""COPY collection_import_row
                (import_id,row_number,group_name,raw_text,parsed,quantity,status,printing_id,edition_id,candidates,
                 left_out_reason)
                FROM STDIN""") as copy:
                for row, found in zip(source.rows, matches):
                    parsed = {**row.fields, matcher.BY_NAME_KEY: "1"} if found.by_name else row.fields
                    copy.write_row((import_id, row.row_number, row.group, row.raw_text, json.dumps(parsed),
                                    found.quantity, found.status, found.printing_id, found.edition_id,
                                    json.dumps([str(printing) for printing in found.candidates]), found.left_out))
            return summary(conn, user_id, import_id)
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")


@router.get("/current", response_model=CollectionImportSummary)
def current_import(user_id: str = Depends(verified_user)):
    """The collector's open draft's summary; IMPORT_NOT_FOUND when there is none, or it expired."""
    try:
        with connect() as conn:
            sweep_expired(conn)
        with connect() as conn:
            row = conn.execute(f"SELECT ci.id FROM collection_import ci WHERE ci.owner_id=%s AND {OPEN_DRAFT}",
                               (user_id,)).fetchone()
            if row is None:
                refuse(404, "IMPORT_NOT_FOUND")
            return summary(conn, user_id, row["id"])
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")


@router.get("/{import_id}/rows", response_model=CollectionImportRowsPage)
def import_rows(import_id: UUID, filter_: RowFilter = Query(default="all", alias="filter"),
                cursor: str | None = Query(default=None), user_id: str = Depends(verified_user)):
    """The draft's rows in file order after `cursor` (a row number), PAGE_SIZE at a time, with each card's active
    Editions."""
    if cursor is not None and not (cursor.isascii() and cursor.isdecimal() and len(cursor) <= 12):
        refuse(400, "INVALID_CURSOR")
    after = int(cursor) if cursor else 0
    where = matcher.FILTER_ROWS[filter_].format(r="r")
    try:
        with connect() as conn:
            draft = conn.execute(f"SELECT ci.draft_revision FROM collection_import ci WHERE ci.owner_id=%s "
                                 f"AND ci.id=%s AND {OPEN_DRAFT}", (user_id, import_id)).fetchone()
            if draft is None:
                refuse(404, "IMPORT_NOT_FOUND")
            generation = conn.execute("SELECT active_generation FROM catalog_state WHERE singleton").fetchone()
            found = conn.execute(f"""SELECT r.row_number,r.status,r.quantity,r.parsed,r.printing_id,r.edition_id,
                r.skipped,r.left_out_reason,r.candidates,r.fix,r.group_name,gp.display_name,gp.set_name,
                gp.collector_number,e.descriptor
              FROM (SELECT * FROM collection_import_row r WHERE r.import_id=%s AND r.row_number>%s AND {where}
                    ORDER BY r.row_number LIMIT %s) r
              LEFT JOIN catalog_generation_printing gp ON gp.generation_id=%s AND gp.printing_id=r.printing_id
              LEFT JOIN catalog_edition e ON e.id=r.edition_id
              ORDER BY r.row_number""",
                                 (import_id, after, PAGE_SIZE + 1,
                                  generation["active_generation"] if generation else None)).fetchall()
            page = found[:PAGE_SIZE]
            active = generation["active_generation"] if generation else None
            editions = matcher.editions_of(conn, active,
                                           (row["printing_id"] for row in page if row["display_name"] is not None))
            wanted = sorted({printing for row in page for printing in row["candidates"]})
            cards = {} if not wanted or active is None else {
                str(card["printing_id"]): CollectionImportCard(
                    printing_id=card["printing_id"], name=card["display_name"], set_name=card["set_name"],
                    collector_number=card["collector_number"])
                for card in conn.execute(CANDIDATE_CARDS, (active, wanted))}
            owned = sorted({str(row["edition_id"]) for row in page if row["edition_id"] is not None})
            held = {} if not owned else {
                found_held["edition_id"]: found_held["held"] for found_held in conn.execute(HELD, (user_id, owned))}
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")
    rows = []
    for row in page:
        parsed = row["parsed"]
        rows.append(CollectionImportRow(
            row_number=row["row_number"], status=row["status"],
            needs_you=(row["status"] in matcher.NEEDS_YOU and not row["skipped"] and row["left_out_reason"] is None),
            skipped=row["skipped"],
            quantity=None if row["quantity"] is None else str(row["quantity"]),
            source=source_of(parsed),
            card=None if row["printing_id"] is None or row["display_name"] is None else CollectionImportCard(
                printing_id=row["printing_id"], name=row["display_name"], set_name=row["set_name"],
                collector_number=row["collector_number"]),
            edition=None if row["edition_id"] is None or row["descriptor"] is None else CollectionImportEdition(
                edition_id=row["edition_id"], descriptor=finishes.public_descriptor(row["descriptor"])),
            editions=[] if row["display_name"] is None else [
                CollectionImportEdition(edition_id=choice["edition_id"],
                                        descriptor=finishes.public_descriptor(choice["descriptor"]))
                for choice in editions.get(row["printing_id"], [])],
            candidates=[cards[printing] for printing in row["candidates"] if printing in cards],
            picked=bool(row["fix"] and "pick" in row["fix"]),
            by_name=parsed.get(matcher.BY_NAME_KEY) == "1",
            group=row["group_name"],
            held=str(int(held.get(row["edition_id"], 0)))))
    next_cursor = str(page[-1]["row_number"]) if len(found) > PAGE_SIZE else None
    return CollectionImportRowsPage(rows=rows, next_cursor=next_cursor, draft_revision=draft["draft_revision"])


def _action(change: CollectionImportChange) -> str:
    """The change's one action; INVALID_CHANGE without exactly one action, for a row action without exactly one of
    rows and filter, for a group or Location change with either, and for `include` without `group` or `group`
    without `include`."""
    actions = [name for name, given in (("pick", change.pick is not None), ("finish", change.finish is not None),
                                        ("skip", change.skip), ("restore", change.restore),
                                        ("group", change.group is not None),
                                        ("location", change.location_id is not None)) if given]
    if len(actions) != 1 or (actions[0] == "group") != (change.include is not None):
        refuse(422, "INVALID_CHANGE")
    if actions[0] in ("group", "location"):
        if change.rows is not None or change.filter is not None:
            refuse(422, "INVALID_CHANGE")
        return actions[0]
    if (change.rows is None) == (change.filter is None):
        refuse(422, "INVALID_CHANGE")
    if change.pick is not None and (change.pick.printing_id is None) == (change.pick.edition_id is None):
        refuse(422, "INVALID_CHANGE")
    return actions[0]


def _targets(conn, import_id: UUID, change: CollectionImportChange) -> list:
    """The change's rows as they stand now, in file order; ROW_NOT_FOUND for a row number the draft doesn't have."""
    columns = (f"r.row_number,r.status,r.quantity,r.parsed,r.printing_id,r.skipped,r.left_out_reason,"
               f"{INCLUDED_ROW} AS included")
    if change.filter is not None:
        return conn.execute(f"""SELECT {columns} FROM collection_import_row r WHERE r.import_id=%s
          AND {matcher.FILTER_ROWS[change.filter].format(r="r")} ORDER BY r.row_number""", (import_id,)).fetchall()
    wanted = sorted(set(change.rows))
    found = conn.execute(f"""SELECT {columns} FROM collection_import_row r WHERE r.import_id=%s
      AND r.row_number=ANY(%s::int[]) ORDER BY r.row_number""", (import_id, wanted)).fetchall()
    if len(found) != len(wanted):
        refuse(422, "ROW_NOT_FOUND")
    return found


def _set_finish(conn, import_id: UUID, generation, targets: list, descriptor: dict,
                wanted: finishes.Finish) -> CollectionImportChangeResult:
    """Each target's Edition, where its card has exactly one active Edition that fits `wanted`. The Unspecified Variant
    makes the row finish_unknown, a row matched by name (parsed's BY_NAME_KEY) is by_name, and anything else is
    matched."""
    eligible = [row for row in targets if row["printing_id"] is not None and not row["skipped"]
                and row["left_out_reason"] is None and row["included"]]
    editions = matcher.editions_of(conn, generation, (row["printing_id"] for row in eligible))
    numbers, chosen_ids, statuses = [], [], []
    for row in eligible:
        chosen = finishes.choose(wanted, editions.get(row["printing_id"], []))
        if chosen is None:
            continue
        numbers.append(row["row_number"])
        chosen_ids.append(chosen["edition_id"])
        statuses.append("finish_unknown" if finishes.facets(chosen["descriptor"]).special == "unspecified"
                        else "by_name" if row["parsed"].get(matcher.BY_NAME_KEY) == "1" else "matched")
    if numbers:
        conn.execute("""UPDATE collection_import_row r SET edition_id=u.edition_id,status=u.status,
            fix=coalesce(r.fix,'{}'::jsonb)||jsonb_build_object('finish',%s::jsonb)
          FROM unnest(%s::int[],%s::uuid[],%s::text[]) AS u(row_number,edition_id,status)
          WHERE r.import_id=%s AND r.row_number=u.row_number""",
                     (json.dumps(finishes.public_descriptor(descriptor)), numbers, chosen_ids, statuses, import_id))
    done = set(numbers)
    return CollectionImportChangeResult(applied=len(numbers),
                                        not_applied=[row["row_number"] for row in targets
                                                     if row["row_number"] not in done])


# An active Edition of the generation and its Printing, for a pick by Edition.
PICKED_EDITION = """SELECT ge.printing_id,e.id AS edition_id,e.descriptor
  FROM catalog_generation_edition ge JOIN catalog_edition e ON e.id=ge.edition_id
  JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
    AND NOT gp.tombstoned
  WHERE ge.generation_id=%s AND ge.active AND ge.edition_id=%s"""


def _pick(conn, import_id: UUID, generation, source: str, targets: list,
          pick: CollectionImportPick) -> CollectionImportChangeResult:
    """Each target's card: the picked Edition, or the picked Printing with the Edition its row's finish chooses
    (collection_import_matcher.edition_for), so a card whose finish the row doesn't tell leaves the row ambiguous with
    its card, for its finish to be picked. A picked Unspecified Variant is finish_unknown; anything else is matched. The
    pick ends Matched by name (BY_NAME_KEY is cleared from parsed), even for the row's own card. INVALID_PICK for a
    card the catalog no longer has."""
    if pick.edition_id is not None:
        picked = conn.execute(PICKED_EDITION, (generation, pick.edition_id)).fetchone()
        if picked is None:
            refuse(422, "INVALID_PICK")
        printing, choices = picked["printing_id"], [picked]
    else:
        printing = pick.printing_id
        choices = matcher.editions_of(conn, generation, [printing]).get(printing, [])
        if not choices:
            refuse(422, "INVALID_PICK")
    eligible = [row for row in targets if row["quantity"] is not None and not row["skipped"]
                and row["left_out_reason"] is None and row["included"]]
    numbers, edition_ids, statuses = [], [], []
    for row in eligible:
        if pick.edition_id is not None:
            edition = choices[0]["edition_id"]
            status = "finish_unknown" if matcher.is_unspecified(choices[0]["descriptor"]) else "matched"
        else:
            status, edition = matcher.edition_for(source, row["parsed"], choices)
        numbers.append(row["row_number"])
        edition_ids.append(edition)
        statuses.append(status)
    if numbers:
        fix = json.dumps({"printing_id": str(printing), **({"edition_id": str(pick.edition_id)}
                                                           if pick.edition_id is not None else {})})
        conn.execute("""UPDATE collection_import_row r SET printing_id=%s,edition_id=u.edition_id,status=u.status,
            fix=(coalesce(r.fix,'{}'::jsonb)-'finish')||jsonb_build_object('pick',%s::jsonb),
            parsed=r.parsed-%s::text
          FROM unnest(%s::int[],%s::uuid[],%s::text[]) AS u(row_number,edition_id,status)
          WHERE r.import_id=%s AND r.row_number=u.row_number""",
                     (printing, fix, matcher.BY_NAME_KEY, numbers, edition_ids, statuses, import_id))
    done = set(numbers)
    return CollectionImportChangeResult(applied=len(numbers),
                                        not_applied=[row["row_number"] for row in targets
                                                     if row["row_number"] not in done])


def _set_skipped(conn, import_id: UUID, targets: list, skipped: bool) -> CollectionImportChangeResult:
    eligible = [row["row_number"] for row in targets if row["left_out_reason"] is None and row["included"]]
    changed: set[int] = set()
    if eligible:
        # Only rows whose flag differs count as changed; the rest are reported in not_applied.
        changed = {row["row_number"] for row in conn.execute(
            """UPDATE collection_import_row SET skipped=%s WHERE import_id=%s AND row_number=ANY(%s::int[])
               AND skipped IS DISTINCT FROM %s RETURNING row_number""",
            (skipped, import_id, eligible, skipped)).fetchall()}
    return CollectionImportChangeResult(applied=len(changed),
                                        not_applied=[row["row_number"] for row in targets
                                                     if row["row_number"] not in changed])


def _set_group(conn, import_id: UUID, group: str, include: bool) -> CollectionImportChangeResult:
    """Leaves the file's group out of the import (include false) or brings it back, keeping each of its rows as it
    was. GROUP_NOT_FOUND for a name no row of the draft has."""
    rows = conn.execute("""SELECT count(*) AS n,count(*) FILTER (WHERE left_out_reason IS NULL) AS kept
      FROM collection_import_row WHERE import_id=%s AND group_name=%s""", (import_id, group)).fetchone()
    if not rows["n"]:
        refuse(422, "GROUP_NOT_FOUND")
    changed = conn.execute("""UPDATE collection_import SET excluded_groups=CASE WHEN %s THEN excluded_groups-%s::text
        ELSE excluded_groups||jsonb_build_array(%s::text) END
      WHERE id=%s AND (excluded_groups @> jsonb_build_array(%s::text))=%s RETURNING id""",
                           (include, group, group, import_id, group, include)).fetchone()
    return CollectionImportChangeResult(applied=rows["kept"] if changed else 0, not_applied=[])


def _set_location(conn, user_id: str, import_id: UUID, location_id: UUID) -> CollectionImportChangeResult:
    """Moves the landing Location: NOT_STORAGE_LEAF, as the start route, unless it is this collector's Storage Leaf
    (no Deck, no children)."""
    if not storage_leaf(conn, user_id, location_id):
        refuse(422, "NOT_STORAGE_LEAF")
    conn.execute("UPDATE collection_import SET location_id=%s WHERE id=%s", (location_id, import_id))
    return CollectionImportChangeResult(applied=0, not_applied=[])


@router.post("/{import_id}/changes", response_model=CollectionImportChanges)
def change_import(import_id: UUID, command: ChangeCollectionImport, user_id: str = Depends(verified_user)):
    """Applies the changes in order, each to its rows as the earlier ones left them, in one transaction: all or none.
    The draft revision advances once, even when nothing differs, and the draft's expiry moves to 24 hours from now.
    Refuses NO_CHANGES, INVALID_CHANGE, INVALID_FINISH (a descriptor with no physical facet), INVALID_PICK (a card the
    catalog doesn't have, or no longer has), ROW_NOT_FOUND, GROUP_NOT_FOUND, NOT_STORAGE_LEAF (a Location that isn't
    this collector's Storage Leaf), IMPORT_NOT_FOUND and STALE_DRAFT. A change touches no
    Holding and not the owner revision; a repeated request after a lost response gets STALE_DRAFT, and the review
    reloads."""
    if not command.changes:
        refuse(422, "NO_CHANGES")
    plans = []
    for change in command.changes:
        action = _action(change)
        wanted = None
        if action == "finish":
            wanted = finishes.wanted_from_descriptor(change.finish)
            if wanted is None:
                refuse(422, "INVALID_FINISH")
        plans.append((change, action, wanted))
    try:
        with connect() as conn, conn.transaction():
            # As save: the owner, then the draft.
            lock_owner(conn, user_id)
            draft = conn.execute(f"""SELECT ci.draft_revision,ci.source FROM collection_import ci
              WHERE ci.owner_id=%s AND ci.id=%s AND {OPEN_DRAFT} FOR UPDATE""", (user_id, import_id)).fetchone()
            if draft is None:
                refuse(404, "IMPORT_NOT_FOUND")
            if command.draft_revision != draft["draft_revision"]:
                refuse(409, "STALE_DRAFT")
            generation = None
            if any(action in ("pick", "finish") for _, action, _ in plans):
                catalog = conn.execute("SELECT active_generation FROM catalog_state WHERE singleton").fetchone()
                if catalog is None or catalog["active_generation"] is None:
                    refuse(503, "CATALOG_UNAVAILABLE")
                generation = catalog["active_generation"]
            results = []
            for change, action, wanted in plans:
                if action == "group":
                    results.append(_set_group(conn, import_id, change.group, change.include))
                    continue
                if action == "location":
                    results.append(_set_location(conn, user_id, import_id, change.location_id))
                    continue
                targets = _targets(conn, import_id, change)
                if action == "pick":
                    results.append(_pick(conn, import_id, generation, draft["source"], targets, change.pick))
                elif action == "finish":
                    results.append(_set_finish(conn, import_id, generation, targets, change.finish, wanted))
                else:
                    results.append(_set_skipped(conn, import_id, targets, action == "skip"))
            conn.execute("""UPDATE collection_import SET draft_revision=draft_revision+1,changed_at=now(),
                expires_at=now()+interval '24 hours' WHERE id=%s""", (import_id,))
            return CollectionImportChanges(summary=summary(conn, user_id, import_id), results=results)
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")


def rows_csv(user_id: str, import_id: UUID, where: str, filename: str) -> Response:
    """The draft's rows that `where` (a row predicate for alias r) holds, in file order, under the file's header, as a
    CSV attachment (UTF-8 with a BOM, so a spreadsheet reads accents, and CRLF lines): each row's cells as the file held
    them, columns PrizeCheck doesn't read included. Just the header when there are none. A pasted list's (#234) are its
    lines as pasted, one per line, as a .txt attachment (UTF-8, no BOM, LF lines), with no header. Owner-only and never
    cached. IMPORT_NOT_FOUND for a draft that isn't this collector's open one."""
    try:
        with connect() as conn:
            draft = conn.execute(f"""SELECT ci.source,ci.source_header FROM collection_import ci
              WHERE ci.owner_id=%s AND ci.id=%s AND {OPEN_DRAFT}""", (user_id, import_id)).fetchone()
            if draft is None:
                refuse(404, "IMPORT_NOT_FOUND")
            lines = [row["raw_text"] for row in conn.execute(
                f"""SELECT r.raw_text FROM collection_import_row r WHERE r.import_id=%s AND {where}
                    ORDER BY r.row_number""", (import_id,))]
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")
    headers = {"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"}
    if draft["source"] == reader.PASTE:
        headers["Content-Disposition"] = f'attachment; filename="{filename.removesuffix(".csv")}.txt"'
        return Response(content="".join(f"{line}\n" for line in lines).encode("utf-8"),
                        media_type="text/plain; charset=utf-8", headers=headers)
    header = io.StringIO()
    csv.writer(header, lineterminator="").writerow(draft["source_header"])
    body = "\ufeff" + "".join(f"{line}\r\n" for line in (header.getvalue(), *lines))
    return Response(content=body.encode("utf-8"), media_type="text/csv; charset=utf-8", headers=headers)


@router.get("/{import_id}/skipped.csv")
def skipped_rows(import_id: UUID, user_id: str = Depends(verified_user)):
    """The draft's skipped rows in the file's own columns (rows_csv)."""
    return rows_csv(user_id, import_id, SKIPPED_ROW, "skipped-rows.csv")


@router.get("/{import_id}/left-out.csv")
def left_out_rows(import_id: UUID, user_id: str = Depends(verified_user)):
    """The rows the filters left out (#231), whatever their reason, in the file's own columns (rows_csv)."""
    return rows_csv(user_id, import_id, LEFT_OUT_ROW, "left-out-rows.csv")


# The Card Editions of the save's work (edition_id, quantity) that are no longer active in the generation, or whose
# Printing was withdrawn.
UNAVAILABLE = """SELECT w.edition_id FROM jsonb_to_recordset(%s::jsonb) AS w(edition_id uuid,quantity bigint)
  WHERE NOT EXISTS (SELECT 1 FROM catalog_generation_edition ge
    JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
    WHERE ge.generation_id=%s AND ge.edition_id=w.edition_id AND ge.active AND NOT gp.tombstoned)
  ORDER BY w.edition_id"""


def return_to_needs_you(conn, import_id: UUID, generation, editions: list) -> int:
    """The ready rows on these Card Editions, which are no longer active, return to Needs you (#233): a row whose
    Printing still has active Editions keeps its card and waits for its finish to be picked (ambiguous, as matching
    leaves a card whose finish it can't tell); any other row is Not found, with no card, and is no longer Matched by
    name. The finish the collector chose for it is cleared. How many rows changed."""
    rows = conn.execute(f"""SELECT r.row_number,r.printing_id FROM collection_import_row r
      WHERE r.import_id=%s AND {READY_ROW} AND r.edition_id=ANY(%s::uuid[])""", (import_id, editions)).fetchall()
    still = matcher.editions_of(conn, generation, (row["printing_id"] for row in rows))
    keep = [row["row_number"] for row in rows if still.get(row["printing_id"])]
    lost = [row["row_number"] for row in rows if not still.get(row["printing_id"])]
    if keep:
        conn.execute("""UPDATE collection_import_row SET status='ambiguous',edition_id=NULL,fix=fix-'finish'
          WHERE import_id=%s AND row_number=ANY(%s::int[])""", (import_id, keep))
    if lost:
        conn.execute("""UPDATE collection_import_row SET status='not_found',printing_id=NULL,edition_id=NULL,fix=NULL,
            parsed=parsed-%s::text
          WHERE import_id=%s AND row_number=ANY(%s::int[])""", (matcher.BY_NAME_KEY, import_id, lost))
    return len(rows)


@router.post("/{import_id}/save", response_model=CollectionImportSaveResult)
def save_import(import_id: UUID, command: SaveCollectionImport, user_id: str = Depends(verified_user)):
    """Adds the draft's ready rows to its Storage Leaf in one transaction, all or nothing. Refuses ROWS_NEED_YOU while
    any row needs the collector, STALE_DRAFT for another draft revision, and REVIEW_CHANGED (409) when the Storage Leaf
    is no longer this collector's, or a ready row's Card Edition is no longer active: those rows first return to Needs
    you and the draft revision advances, in a transaction of their own, so the review reloads onto them. A repeated key
    or a second save answers the stored result while the receipt lasts (24 hours after the save); an expired draft or
    receipt is IMPORT_NOT_FOUND, or REPLAY_OUTCOME_UNAVAILABLE for a key already recorded."""
    fingerprint = {"action": "collection_import_save", "import_id": str(import_id)}
    request_digest = hashlib.sha256(json.dumps(fingerprint, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    try:
        with connect() as conn:
            with conn.transaction():
                revision = lock_owner(conn, user_id)
                conn.execute("DELETE FROM mutation_request WHERE owner_id=%s AND expires_at<=now()", (user_id,))
                previous = conn.execute("""SELECT command_digest FROM mutation_request
                  WHERE owner_id=%s AND request_key=%s""", (user_id, command.idempotency_key)).fetchone()
                if previous and previous["command_digest"] != request_digest:
                    refuse(409, "IDEMPOTENCY_KEY_REUSED")
                draft = conn.execute("""SELECT id,status,location_id,draft_revision,save_result FROM collection_import
                  WHERE owner_id=%s AND id=%s AND expires_at>now() FOR UPDATE""", (user_id, import_id)).fetchone()
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
                catalog = conn.execute("""SELECT active_generation,revision FROM catalog_state WHERE singleton
                  FOR SHARE""").fetchone()
                unavailable = [row["edition_id"] for row in conn.execute(
                    UNAVAILABLE, (work, catalog["active_generation"])).fetchall()]
                if unavailable:
                    return_to_needs_you(conn, import_id, catalog["active_generation"], unavailable)
                    conn.execute("""UPDATE collection_import SET draft_revision=draft_revision+1,catalog_revision=%s,
                        changed_at=now(),expires_at=now()+interval '24 hours' WHERE id=%s""",
                                 (catalog["revision"], import_id))
                else:
                    over = conn.execute("""SELECT w.edition_id FROM jsonb_to_recordset(%s::jsonb)
                        AS w(edition_id uuid,quantity bigint)
                      JOIN holding h ON h.owner_id=%s AND h.location_id=%s AND h.edition_id=w.edition_id
                      WHERE h.quantity>%s-w.quantity ORDER BY w.edition_id LIMIT 1""",
                                        (work, user_id, location_id, matcher.MAX_QUANTITY)).fetchone()
                    if over:
                        refuse(422, "QUANTITY_OVERFLOW", edition_id=over["edition_id"])
                    new_revision = revision + 1
                    conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
                      SELECT %s,%s,edition_id,quantity,%s FROM jsonb_to_recordset(%s::jsonb)
                        AS w(edition_id uuid,quantity bigint)
                      WHERE true
                      ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE
                        SET quantity=holding.quantity+EXCLUDED.quantity,version=EXCLUDED.version""",
                                 (user_id, location_id, new_revision, work))
                    conn.execute("UPDATE inventory_owner SET revision=%s WHERE user_id=%s", (new_revision, user_id))
                    conn.execute("""INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision)
                      VALUES (%s,%s,%s,%s)""", (user_id, command.idempotency_key, request_digest, new_revision))
                    result = CollectionImportSaveResult(import_id=import_id, location_id=location_id,
                                                        edition_count=len(items), copy_count=str(copies),
                                                        owner_revision=new_revision)
                    conn.execute("""UPDATE collection_import SET status='saved',saved_at=now(),changed_at=now(),
                        expires_at=now()+interval '24 hours',save_key=%s,save_result=%s::jsonb WHERE id=%s""",
                                 (command.idempotency_key, result.model_dump_json(), import_id))
                    # The raw rows hold the collector's whole file; a saved draft keeps only its result.
                    conn.execute("DELETE FROM collection_import_row WHERE import_id=%s", (import_id,))
                    return result
            # Outside the transaction, which committed the rows' return to Needs you: nothing was added.
            refuse(409, "REVIEW_CHANGED")
    except psycopg.Error:
        refuse(503, "INVENTORY_TEMPORARILY_UNAVAILABLE")
