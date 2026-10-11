"""Private Deck TCGplayer Mass Entry export.

Reads one complete, atomically captured Deck composition and the current verified product mappings
from PostgreSQL. It reads no prices, quotes or Live data and writes nothing.
"""
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .catalog_targets import edition_targets
from .decks import capture_deck_contents
from .location_tree import error
from .main import connect, verified_user
from .mass_entry_export import (MAX_LINK_QUANTITY, MAX_URL_BYTES, MassEntryExport, MassEntryInputRow,
                                format_mass_entry, iter_mass_entry_text, mass_entry_text)

router = APIRouter(prefix='/api/decks', tags=['deck-exports'])
INLINE_LIMIT_BYTES = 256 * 1024
NO_STORE = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}


class MassEntryLineView(BaseModel):
    quantity: str
    text: str
    less_specific: bool


class MassEntryView(BaseModel):
    status: Literal['link', 'text', 'empty']
    url: str | None
    fallback_reason: Literal['missing_mapping', 'encoded_length', 'quantity_unsupported'] | None
    text: str | None
    inline: bool
    byte_length: int
    lines: list[MassEntryLineView]
    line_count: int
    less_specific_count: int
    total_copies: str
    owner_revision: int
    catalog_revision: int


def captured_rows(deck_id: UUID, user_id: str):
    """One consistent Deck capture, then the current mappings; no lock is held across the two."""
    contents = capture_deck_contents(deck_id, user_id)
    quantities = {item.edition_id: int(item.quantity) for item in contents.editions}
    rows = []
    if quantities:
        ids = list(quantities)
        with connect() as conn:
            conn.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
            with conn.transaction():
                names = {row['edition_id']: row for row in conn.execute("""SELECT e.id AS edition_id,p.id AS printing_id,
                  coalesce(d.display_name,ci.display_name) AS name FROM catalog_edition e
                  JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_identity ci ON ci.id=p.identity_id
                  LEFT JOIN catalog_printing_display d ON d.printing_id=p.id WHERE e.id=ANY(%s)""", (ids,))}
                targets = edition_targets(conn, ids)
        for edition_id in ids:
            named = names[edition_id]
            target = targets.get(edition_id)
            rows.append(MassEntryInputRow(
                key=str(edition_id), printing_key=str(named['printing_id']), display_name=named['name'],
                quantity=quantities[edition_id], product_id=target.product_id if target else None,
                specificity=None))  # No verified TCGplayer set/number crosswalk exists; rows stay name-only.
    return contents, rows


def text_bytes(export: MassEntryExport) -> int:
    return sum(len(chunk.encode()) for chunk in iter_mass_entry_text(export))


def formatted(rows) -> MassEntryExport:
    """The JSON views' one formatter call, with this module's link limits (read at call time, so tests can patch them)."""
    return format_mass_entry(rows, max_url_bytes=MAX_URL_BYTES, max_link_quantity=MAX_LINK_QUANTITY)


def view_fields(export: MassEntryExport) -> dict:
    """The fields the private and the Published Deck views share: one inline/text/lines decision for both."""
    size = text_bytes(export)
    inline = size <= INLINE_LIMIT_BYTES
    return {'status': export.status, 'url': export.url, 'fallback_reason': export.fallback_reason,
            'text': mass_entry_text(export) if inline and export.status == 'text' else None,
            'inline': inline, 'byte_length': size,
            'lines': [MassEntryLineView(quantity=str(line.quantity), text=line.text, less_specific=line.less_specific)
                      for line in export.lines] if inline else [],
            'line_count': len(export.lines), 'less_specific_count': sum(line.less_specific for line in export.lines),
            'total_copies': str(export.total_copies)}


def text_download(export: MassEntryExport, headers=None) -> StreamingResponse:
    return StreamingResponse((chunk.encode() for chunk in iter_mass_entry_text(export)),
                             media_type='text/plain; charset=utf-8',
                             headers={**NO_STORE, 'Content-Disposition': 'attachment; filename="tcgplayer-mass-entry.txt"',
                                      **(headers or {})})


@router.get('/{deck_id}/exports/tcgplayer', response_model=MassEntryView)
def tcgplayer_export(deck_id: UUID, user_id: str = Depends(verified_user)):
    contents, rows = captured_rows(deck_id, user_id)
    export = formatted(rows)
    return MassEntryView(**view_fields(export), owner_revision=contents.owner_revision,
                         catalog_revision=contents.catalog_revision)


@router.get('/{deck_id}/exports/tcgplayer.txt')
def tcgplayer_download(deck_id: UUID, owner_revision: int = Query(ge=0), user_id: str = Depends(verified_user)):
    contents, rows = captured_rows(deck_id, user_id)
    if contents.owner_revision != owner_revision:
        error(409, 'INVENTORY_CHANGED')
    export = format_mass_entry(rows)
    if export.status == 'empty':
        error(422, 'DECK_EMPTY')
    return text_download(export)
