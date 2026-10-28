"""Card scanner reads (#310; plumbing D4, D5, D7, D8): the manifest, the number table, the fingerprint file and the
batch route that resolves a candidate Printing to display data and a starting Card Edition.

All routes are signed-in and none is public. The number table is built here on request, deterministically, and the last
build is kept in memory; the fingerprint file is catalog data that scripts/scanner_index_job.py stores in
``scanner_index``. Both are answered as attachments with no Content-Encoding, so the gateway streams them unchanged
(auth/src/server.ts) and nothing inflates them on the way: the device decompresses the number table itself.
"""
import gzip
import hashlib
import json
import threading
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import set_codes
from .catalog_search import EditionView, PrintingView, _state, _views
from .collection_import_finish import NORMAL, choose, facets, fits
from .db import connect
from .identity import verified_user

router = APIRouter(prefix="/api/scanner")

CARDS_FORMAT = 1
DIM = 384
OCTET_STREAM = "application/octet-stream"


class ScannerManifestCards(BaseModel):
    key: str
    url: str
    bytes: int


class ScannerManifestFingerprints(BaseModel):
    sha256: str
    url: str
    bytes: int
    count: int
    dim: int


class ScannerManifest(BaseModel):
    format: Literal[1]
    model: str
    catalog_revision: int
    cards: ScannerManifestCards
    fingerprints: ScannerManifestFingerprints | None


class ScannerPrinting(PrintingView):
    default_edition_id: UUID | None


class ScannerPrintingsRequest(BaseModel):
    printing_ids: list[UUID] = Field(min_length=1, max_length=100)


class ScannerPrintingsResponse(BaseModel):
    catalog_revision: int
    printings: list[ScannerPrinting]
    missing: list[UUID]


def default_edition(editions: list[EditionView]) -> UUID | None:
    """The tray's starting Edition for a Printing; None when it has no active Edition; never from the photo.

    `editions` come in descriptor_key order (catalog_search._views). Inactive Editions are never chosen. In order: the
    only active Edition; an active Unspecified Variant; an active Normal (a subtype of none preferred); otherwise the
    first active Edition.
    """
    active = [edition for edition in editions if edition.active]
    if not active:
        return None
    if len(active) == 1:
        return active[0].id
    for edition in active:
        found = facets(edition.descriptor)
        if found is not None and found.special == "unspecified":
            return edition.id
    chosen = choose(NORMAL, [{"descriptor": edition.descriptor, "id": edition.id} for edition in active])
    if chosen:
        return chosen["id"]
    # Several Normals fit: the first with no subtype, else the first that fits.
    fitting = [(edition, found) for edition in active
               if (found := facets(edition.descriptor)) is not None and fits(NORMAL, found)]
    if fitting:
        return next((edition for edition, found in fitting if found.subtype is None), fitting[0][0]).id
    return active[0].id


# ---------------------------------------------------------------- the number table

_cards_lock = threading.Lock()
_cards_cache: tuple[str, bytes] | None = None


def cards_key(state) -> str:
    """First 16 hex of the sha256 over the table's inputs (D5). Set counts are left out on purpose."""
    inputs = {"f": CARDS_FORMAT, "rev": state["revision"], "gen": str(state["active_generation"]),
              "codes": set_codes.DIGEST}
    return hashlib.sha256(json.dumps(inputs, separators=(",", ":"), sort_keys=True).encode()).hexdigest()[:16]


def build_cards(conn, state, key: str) -> bytes:
    """The number table's gzip bytes, the same for the same rows: sets by id, printings in printing id order."""
    generation = state["active_generation"]
    set_rows = conn.execute("""SELECT s.set_id, c.official, c.total, r.release_date
      FROM (SELECT DISTINCT set_id FROM catalog_generation_printing WHERE generation_id=%s AND NOT tombstoned) s
      LEFT JOIN catalog_generation_set_count c ON c.generation_id=%s AND c.set_id=s.set_id
      LEFT JOIN catalog_generation_set r ON r.generation_id=%s AND r.set_id=s.set_id""",
                            (generation, generation, generation)).fetchall()
    set_rows.sort(key=lambda row: row["set_id"])
    index = {row["set_id"]: position for position, row in enumerate(set_rows)}
    sets = [{"id": row["set_id"], "code": set_codes.CODES.get(row["set_id"]), "official": row["official"],
             "total": row["total"], "released": row["release_date"].isoformat() if row["release_date"] else None}
            for row in set_rows]
    printings = conn.execute("""SELECT printing_id, set_id, collector_number, display_name, image_url
      FROM catalog_generation_printing WHERE generation_id=%s AND NOT tombstoned ORDER BY printing_id""",
                             (generation,)).fetchall()
    table = {"format": CARDS_FORMAT, "key": key, "catalog_revision": state["revision"], "sets": sets,
             "printings": {"id": [str(row["printing_id"]) for row in printings],
                           "set": [index[row["set_id"]] for row in printings],
                           "number": [row["collector_number"] for row in printings],
                           "name": [row["display_name"] for row in printings],
                           "image": [row["image_url"] for row in printings]}}
    raw = json.dumps(table, ensure_ascii=False, separators=(",", ":")).encode()
    return gzip.compress(raw, compresslevel=6, mtime=0)


def current_cards(conn, state) -> tuple[str, bytes]:
    """(key, gzip bytes) for the state's key, from memory when the last build has it."""
    global _cards_cache
    key = cards_key(state)
    with _cards_lock:
        if _cards_cache is None or _cards_cache[0] != key:
            _cards_cache = (key, build_cards(conn, state, key))
        return _cards_cache


def _snapshot(conn):
    """Start a transaction that sees one catalog state: the first statement of a transaction picks its snapshot."""
    conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")


def _attachment(content: bytes, filename: str) -> Response:
    return Response(content=content, media_type=OCTET_STREAM,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ---------------------------------------------------------------- routes


@router.get("/manifest", response_model=ScannerManifest)
def manifest(model: str = Query(min_length=1, max_length=64), user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        _snapshot(conn)
        state = _state(conn)
        if not state["active_generation"]:
            raise HTTPException(404, {"code": "CATALOG_UNAVAILABLE", "message": "The catalog is not available."})
        key, cards = current_cards(conn, state)
        # The newest artifact of this model only; another model's is never offered.
        artifact = conn.execute("""SELECT sha256, count, length(bytes) AS size FROM scanner_index
          WHERE model_id=%s ORDER BY created_at DESC, sha256 LIMIT 1""", (model,)).fetchone()
        fingerprints = ScannerManifestFingerprints(
            sha256=artifact["sha256"], url=f'/api/scanner/fingerprints/{artifact["sha256"]}', bytes=artifact["size"],
            count=artifact["count"], dim=DIM) if artifact else None
        return ScannerManifest(format=1, model=model, catalog_revision=state["revision"],
                               cards=ScannerManifestCards(key=key, url=f"/api/scanner/cards/{key}", bytes=len(cards)),
                               fingerprints=fingerprints)


@router.get("/cards/{key}", response_class=Response, responses={200: {"content": {OCTET_STREAM: {}}}})
def cards(key: str = Path(max_length=64), user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        _snapshot(conn)
        state = _state(conn)
        if not state["active_generation"] or cards_key(state) != key:
            raise HTTPException(404, {"code": "CARDS_NOT_CURRENT", "message": "The card table has changed."})
        return _attachment(current_cards(conn, state)[1], "cards.json.gz")


@router.get("/fingerprints/{sha256}", response_class=Response, responses={200: {"content": {OCTET_STREAM: {}}}})
def fingerprints(sha256: str = Path(pattern="^[0-9a-f]{64}$"), user_id: str = Depends(verified_user)):
    with connect() as conn:
        row = conn.execute("SELECT bytes FROM scanner_index WHERE sha256=%s", (sha256,)).fetchone()
    if not row:
        raise HTTPException(404, {"code": "FINGERPRINTS_NOT_FOUND", "message": "The fingerprint file is gone."})
    return _attachment(bytes(row["bytes"]), "fingerprints.bin")


@router.post("/printings", response_model=ScannerPrintingsResponse)
def printings(body: ScannerPrintingsRequest, user_id: str = Depends(verified_user)):
    ids = list(dict.fromkeys(body.printing_ids))
    with connect() as conn, conn.transaction():
        _snapshot(conn)
        state = _state(conn)
        views: dict[UUID, PrintingView] = {}
        if state["active_generation"]:
            rows = conn.execute("""SELECT gp.*, p.source, p.source_id AS public_source_id, p.identity_id,
              ci.display_name AS identity_name, p.id,
              -- The scanner page's COEP blocks the TCGplayer CDN, so it stays on TCGdex art (never catalog_printing_art).
              CASE WHEN gp.image_url IS NOT NULL THEN gp.image_url || '/low.webp' END AS low_image_url,
              CASE WHEN gp.image_url IS NOT NULL THEN gp.image_url || '/high.webp' END AS high_image_url
              FROM catalog_generation_printing gp JOIN catalog_printing p ON p.id=gp.printing_id
              JOIN catalog_identity ci ON ci.id=p.identity_id
              WHERE gp.generation_id=%s AND NOT gp.tombstoned AND gp.printing_id=ANY(%s)""",
                                (state["active_generation"], ids)).fetchall()
            views = {view.id: view for view in _views(conn, state["active_generation"], rows)}
        return ScannerPrintingsResponse(
            catalog_revision=state["revision"],
            printings=[ScannerPrinting(**views[value].model_dump(), default_edition_id=default_edition(views[value].editions))
                       for value in ids if value in views],
            missing=[value for value in ids if value not in views])
