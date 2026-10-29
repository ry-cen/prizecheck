"""Private Deck TCGplayer Mass Entry export.

Reads one complete, atomically captured Deck List (``capture_deck_list``) and the current verified
product mappings from PostgreSQL. It reads no prices, quotes or Live data and writes nothing.

The ``scope`` (Deck Lists 08) chooses the copies: ``not_owned`` (the default, Buy missing) sends only
the copies each line still needs under the account's Want List counting setting (``copy_allocation``,
decklist import #208), the cards the collector would buy; copies the setting counts as owned are left
out because they would be moved in. ``deck_list`` sends every line at its full quantity.
"""
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..prices.catalog_targets import edition_targets
from app.deck_list_capture import capture_deck_list
from app.location_tree import error
from app.db import connect
from app.identity import verified_user
from .mass_entry_export import (MAX_LINK_QUANTITY, MAX_URL_BYTES, MassEntryExport, MassEntryInputRow,
                                format_mass_entry, iter_mass_entry_text, mass_entry_text)
from app.settings import WantListCounting

router = APIRouter(prefix='/api/decks', tags=['deck-exports'])
INLINE_LIMIT_BYTES = 256 * 1024
NO_STORE = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}
MassEntryScope = Literal['not_owned', 'deck_list']


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
    # Deck Lists 08. Always filled; the defaults only keep both optional in the generated client, whose panel type
    # (``MassEntryResult``) is shared with the Published Deck view that has neither.
    scope: MassEntryScope = 'not_owned'
    owner_revision: int
    deck_list_revision: int | None = None
    catalog_revision: int
    # Decklist import #208: the Want List counting setting the ``not_owned`` scope follows and the settings revision it
    # was read at. Always filled; optional for the same reason as ``scope``.
    want_list_counting: WantListCounting | None = None
    settings_revision: int | None = None


def input_rows(quantities: dict[UUID, int]) -> list[MassEntryInputRow]:
    """The formatter's rows for ``{edition_id: positive copies}``: each Edition's Printing, name and current verified
    product, read in one REPEATABLE READ snapshot. Shared with the Want List's export (decklist import #210)."""
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
    return rows


def captured_rows(deck_id: UUID, user_id: str, scope: MassEntryScope):
    """One consistent Deck List capture, then the current mappings; no lock is held across the two."""
    contents = capture_deck_list(deck_id, user_id)
    if scope == 'deck_list':
        quantities = {line.edition_id: line.quantity for line in contents.lines}
    else:
        quantities = {line.edition_id: line.need for line in contents.lines if line.need > 0}
    return contents, input_rows(quantities)


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
def tcgplayer_export(deck_id: UUID, scope: MassEntryScope = Query('not_owned'), user_id: str = Depends(verified_user)):
    contents, rows = captured_rows(deck_id, user_id, scope)
    export = formatted(rows)
    return MassEntryView(**view_fields(export), scope=scope, owner_revision=contents.owner_revision,
                         deck_list_revision=contents.deck_list_revision, catalog_revision=contents.catalog_revision,
                         want_list_counting=contents.want_list_counting, settings_revision=contents.settings_revision)


@router.get('/{deck_id}/exports/tcgplayer.txt')
def tcgplayer_download(deck_id: UUID, owner_revision: int = Query(ge=0), scope: MassEntryScope = Query('not_owned'),
                       deck_list_revision: int | None = Query(None, ge=1),
                       settings_revision: int | None = Query(None, ge=1), user_id: str = Depends(verified_user)):
    contents, rows = captured_rows(deck_id, user_id, scope)
    if contents.owner_revision != owner_revision:
        error(409, 'INVENTORY_CHANGED')
    if deck_list_revision is not None and contents.deck_list_revision != deck_list_revision:
        error(409, 'DECK_LIST_CHANGED')
    # The not-owned copies follow the counting setting, which moves neither revision above (decklist import #208).
    if scope == 'not_owned' and settings_revision is not None and contents.settings_revision != settings_revision:
        error(409, 'SETTINGS_CHANGED')
    export = format_mass_entry(rows)
    if export.status == 'empty':
        error(422, 'DECK_EMPTY' if scope == 'deck_list' else 'NOTHING_NOT_OWNED')
    return text_download(export)
