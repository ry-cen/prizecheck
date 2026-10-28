"""Collector reads of the promoted English catalog."""
import base64
import hashlib
import hmac
import json
import os
import unicodedata
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .db import connect
from .identity import verified_user

router = APIRouter()


class EditionView(BaseModel):
    id: UUID
    descriptor: dict
    active: bool
    source: str
    evidence_url: str | None = None


class PrintingView(BaseModel):
    id: UUID
    source: str
    source_id: str | None
    set_id: str
    set_name: str
    collector_number: str
    name: str
    identity_id: UUID
    identity_name: str
    basic_energy: str
    tombstoned: bool
    low_image_url: str | None
    high_image_url: str | None
    editions: list[EditionView]
    evidence_url: str | None = None
    source_references: list[str] = []


class SearchResponse(BaseModel):
    available: bool
    revision: int
    last_success: datetime | None
    printings: list[PrintingView]
    next_cursor: str | None


class DetailResponse(BaseModel):
    revision: int
    last_success: datetime
    printing: PrintingView


def _filter(name: str | None, set_id: str | None, number: str | None) -> tuple[str, str, str]:
    name = " ".join(unicodedata.normalize("NFC", name or "").split()).casefold()
    set_id = unicodedata.normalize("NFC", set_id or "").strip().casefold()
    number = unicodedata.normalize("NFC", number or "").strip().casefold()
    if bool(name) == bool(set_id and number) or (set_id and not number) or (number and not set_id):
        raise HTTPException(422, {"code": "INVALID_SEARCH", "message": "Enter a name prefix or both set and collector number."})
    if len(name) > 120 or len(set_id) > 80 or len(number) > 80:
        raise HTTPException(422, {"code": "INVALID_SEARCH", "message": "Search is too long."})
    return name, set_id, number


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _secret() -> bytes:
    return os.environ["INTERNAL_AUTH_SECRET"].encode()


def _encode_cursor(filters: tuple[str, str, str], revision: int, row: dict) -> str:
    payload = json.dumps({"v": 1, "f": filters, "r": revision,
                          "k": [row["search_name"], row["set_id"], row["collector_number"], str(row["id"])]},
                         ensure_ascii=False, separators=(",", ":")).encode()
    mac = hmac.new(_secret(), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + mac).decode().rstrip("=")


def _decode_cursor(cursor: str, filters: tuple[str, str, str], revision: int) -> tuple:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        payload, mac = raw[:-32], raw[-32:]
        if not hmac.compare_digest(mac, hmac.new(_secret(), payload, hashlib.sha256).digest()):
            raise ValueError
        data = json.loads(payload)
        if data["v"] != 1 or not isinstance(data["r"], int) or not isinstance(data["k"], list) or len(data["k"]) != 4:
            raise ValueError
        if data["r"] != revision:
            raise HTTPException(409, {"code": "CATALOG_CHANGED", "message": "Catalog changed. Start from page one."})
        if data["f"] != list(filters) or any(not isinstance(value, str) for value in data["k"]):
            raise ValueError
        return (*data["k"][:3], UUID(data["k"][3]))
    except HTTPException:
        raise
    except (ValueError, KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(422, {"code": "INVALID_CURSOR", "message": "Invalid search cursor."}) from None


def _state(conn):
    return conn.execute("SELECT active_generation, revision, last_success FROM catalog_state WHERE singleton").fetchone()


def _views(conn, generation: UUID, rows: list[dict]) -> list[PrintingView]:
    if not rows:
        return []
    ids = [row["id"] for row in rows]
    edition_rows = conn.execute("""SELECT ge.printing_id, e.id, e.descriptor, ge.active, co.evidence_url,
      CASE WHEN co.id IS NULL THEN 'tcgdex' ELSE 'manual' END AS source
      FROM catalog_generation_edition ge JOIN catalog_edition e ON e.id=ge.edition_id
      LEFT JOIN catalog_override co ON co.edition_id=e.id
      WHERE ge.generation_id=%s AND ge.printing_id=ANY(%s) ORDER BY e.descriptor_key,e.id""", (generation, ids)).fetchall()
    editions: dict[UUID, list[EditionView]] = {value: [] for value in ids}
    for edition in edition_rows:
        editions[edition["printing_id"]].append(EditionView(id=edition["id"], descriptor=edition["descriptor"], active=edition["active"], source=edition["source"], evidence_url=edition["evidence_url"]))
    evidence_rows = conn.execute("""SELECT printing_id,evidence_url FROM catalog_override
      WHERE action='approve_printing' AND printing_id=ANY(%s)""", (ids,)).fetchall()
    evidence = {row["printing_id"]: row["evidence_url"] for row in evidence_rows}
    references: dict[UUID,list[str]] = {value: [] for value in ids}
    for ref in conn.execute('SELECT printing_id,source_id FROM catalog_source_reference WHERE printing_id=ANY(%s) ORDER BY source_id',(ids,)).fetchall():
        references[ref['printing_id']].append(ref['source_id'])
    return [PrintingView(id=row["id"], source=row["source"], source_id=row["public_source_id"],
                         set_id=row["set_id"], set_name=row["set_name"], collector_number=row["collector_number"],
                         name=row["display_name"], identity_id=row["identity_id"], identity_name=row["identity_name"],
                         basic_energy=row["basic_energy"], tombstoned=row["tombstoned"],
                         low_image_url=row["low_image_url"],
                         high_image_url=row["high_image_url"],
                         editions=editions[row["id"]], evidence_url=evidence.get(row["id"]),source_references=references[row["id"]]) for row in rows]


@router.get("/api/catalog/search", response_model=SearchResponse)
def search_catalog(name: str | None = None, set_id: str | None = None, number: str | None = None,
                   cursor: str | None = Query(default=None, max_length=1024), user_id: str = Depends(verified_user)):
    filters = _filter(name, set_id, number)
    with connect() as conn, conn.transaction():
        state = _state(conn)
        if not state["active_generation"]:
            return SearchResponse(available=False, revision=state["revision"], last_success=state["last_success"],
                                  printings=[], next_cursor=None)
        key = _decode_cursor(cursor, filters, state["revision"]) if cursor else None
        condition = "gp.search_name LIKE %s ESCAPE '\\'"
        values: list = [state["active_generation"]]
        if filters[0]:
            values.append(_escape_like(filters[0]) + "%")
        else:
            condition = "lower(gp.set_id)=%s AND lower(gp.collector_number)=%s"
            values.extend(filters[1:])
        if key:
            condition += " AND (gp.search_name,gp.set_id,gp.collector_number,gp.printing_id) > (%s,%s,%s,%s)"
            values.extend(key)
        rows = conn.execute(f"""SELECT gp.*, p.source, p.source_id AS public_source_id, p.identity_id, ci.display_name AS identity_name, p.id,
            art.small_art_url AS low_image_url, art.large_art_url AS high_image_url
          FROM catalog_generation_printing gp JOIN catalog_printing p ON p.id=gp.printing_id
          JOIN catalog_identity ci ON ci.id=p.identity_id
          LEFT JOIN catalog_printing_art art ON art.printing_id=p.id
          WHERE gp.generation_id=%s AND NOT gp.tombstoned AND {condition}
          ORDER BY gp.search_name,gp.set_id,gp.collector_number,gp.printing_id LIMIT 31""", (*values,)).fetchall()
        page = rows[:30]
        return SearchResponse(available=True, revision=state["revision"], last_success=state["last_success"],
                              printings=_views(conn, state["active_generation"], page),
                              next_cursor=_encode_cursor(filters, state["revision"], page[-1]) if len(rows) > 30 else None)


@router.get("/api/catalog/printings/{printing_id}", response_model=DetailResponse)
def printing_detail(printing_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        state = _state(conn)
        if not state["active_generation"]:
            raise HTTPException(404, "Printing not found")
        row = conn.execute("""SELECT gp.*, p.source, p.source_id AS public_source_id, p.identity_id, ci.display_name AS identity_name, p.id,
            art.small_art_url AS low_image_url, art.large_art_url AS high_image_url
          FROM catalog_generation_printing gp JOIN catalog_printing p ON p.id=gp.printing_id
          JOIN catalog_identity ci ON ci.id=p.identity_id
          LEFT JOIN catalog_printing_art art ON art.printing_id=p.id
          WHERE gp.generation_id=%s AND gp.printing_id=%s AND NOT gp.tombstoned""",
                           (state["active_generation"], printing_id)).fetchone()
        if not row:
            raise HTTPException(404, "Printing not found")
        return DetailResponse(revision=state["revision"], last_success=state["last_success"],
                              printing=_views(conn, state["active_generation"], [row])[0])
