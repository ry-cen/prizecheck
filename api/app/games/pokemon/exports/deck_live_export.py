"""Private Deck -> Pokemon TCG Live export.

The export is the whole Deck List (Deck Lists 08): every line at its full quantity, whether the
collector owns the copies, stores them elsewhere or does not own them; Holdings beyond the list
are left out. The lines come from ``capture_deck_list`` (one consistent inventory and Deck List
revision, independent of Holding pagination). Support is read only from reviewed Live
eligibility (``printing_live``): a maintainer decision or an activated rule. Marketplace
state, prices and quotes are never consulted, and no Live identifier is stored.
"""
from typing import Any, Iterator, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..prices.catalog_targets import printing_live
from app.deck_list_capture import capture_deck_list
from .live_export import LiveExport, LiveInputRow, format_live, iter_live_text
from app.location_tree import error
from app.db import connect
from app.identity import verified_user

router = APIRouter(prefix='/api/decks', tags=['deck-live-export'])

# Larger exports are not placed in the JSON response; the client offers the .txt download.
INLINE_LIMIT_BYTES = 256 * 1024


class LiveBlockerView(BaseModel):
    edition_id: UUID
    name: str
    set_name: str
    collector_number: str
    descriptor: dict[str, Any]
    quantity: str
    reason: str


class LiveExportView(BaseModel):
    status: Literal['ok', 'blocked', 'empty']
    text: str | None
    inline: bool
    byte_length: int
    total_copies: str
    blockers: list[LiveBlockerView]
    owner_revision: int
    # A Deck List edit does not move ``owner_revision``; the download can be pinned to this revision too.
    deck_list_revision: int
    catalog_revision: int


def live_rows(editions) -> list[LiveInputRow]:
    """One row per item (``edition_id``, ``quantity``); a Printing without Live metadata or display data blocks rather than raises."""
    ids = [item.edition_id for item in editions]
    with connect() as conn, conn.transaction():
        found = {row['id']: row for row in conn.execute(
            """SELECT e.id,e.printing_id,e.descriptor,d.display_name,d.set_name,d.collector_number
               FROM catalog_edition e LEFT JOIN catalog_printing_display d ON d.printing_id=e.printing_id
               WHERE e.id=ANY(%s)""", (ids,))}
        targets = printing_live(conn, {row['printing_id'] for row in found.values()})
    rows = []
    for item in editions:
        edition = found.get(item.edition_id)
        if edition is None:
            rows.append(LiveInputRow(str(item.edition_id), 'Unknown card', '', '', {}, int(item.quantity),
                                     'unsupported', 'unsupported', None))
            continue
        target = targets.get(edition['printing_id'])
        rows.append(LiveInputRow(
            str(item.edition_id), edition['display_name'] or 'Unknown card', edition['set_name'] or '',
            edition['collector_number'] or '', edition['descriptor'], int(item.quantity),
            target.state if target else 'unsupported', target.reason if target else 'unsupported',
            target.identity if target else None))
    return rows


def capture_export(deck_id: UUID, user_id: str):
    captured = capture_deck_list(deck_id, user_id)
    return captured, format_live(live_rows(captured.lines))


def measured(export: LiveExport) -> tuple[int, str | None]:
    """UTF-8 byte length of the complete text, keeping the text only while it fits inline."""
    size, parts = 0, []
    if export.status != 'ok':
        return 0, None
    for piece in iter_live_text(export):
        size += len(piece.encode())
        if parts is not None:
            if size > INLINE_LIMIT_BYTES:
                parts = None
            else:
                parts.append(piece)
    return size, ''.join(parts) if parts is not None else None


def export_fields(export: LiveExport) -> dict:
    """The fields the private and the Published Deck views share: one inline/download decision for both."""
    size, text = measured(export)
    return {'status': export.status, 'text': text, 'inline': text is not None, 'byte_length': size,
            'total_copies': str(export.total_copies)}


@router.get('/{deck_id}/exports/live', response_model=LiveExportView)
def live_export(deck_id: UUID, user_id: str = Depends(verified_user)):
    contents, export = capture_export(deck_id, user_id)
    return LiveExportView(
        **export_fields(export),
        blockers=[LiveBlockerView(edition_id=UUID(b.key), name=b.display_name, set_name=b.set_label,
                                  collector_number=b.collector_number, descriptor=b.descriptor,
                                  quantity=str(b.quantity), reason=b.reason) for b in export.blockers],
        owner_revision=contents.owner_revision, deck_list_revision=contents.deck_list_revision,
        catalog_revision=contents.catalog_revision)


def attachment(export: LiveExport) -> Iterator[bytes]:
    for piece in iter_live_text(export):
        yield piece.encode()


def text_download(export: LiveExport, headers=None) -> StreamingResponse:
    """The complete text as a streamed attachment; ``headers`` adds to the defaults (public routes add PUBLIC_HEADERS)."""
    return StreamingResponse(attachment(export), media_type='text/plain; charset=utf-8', headers={
        'Content-Disposition': 'attachment; filename="deck-live-export.txt"', 'Cache-Control': 'no-store',
        **(headers or {})})


@router.get('/{deck_id}/exports/live.txt')
def live_export_text(deck_id: UUID, owner_revision: int, deck_list_revision: int | None = Query(None, ge=1),
                     user_id: str = Depends(verified_user)):
    # Every refusal happens before streaming starts: once the first byte is sent the status is committed.
    contents, export = capture_export(deck_id, user_id)
    if contents.owner_revision != owner_revision:
        error(409, 'INVENTORY_CHANGED')
    if deck_list_revision is not None and contents.deck_list_revision != deck_list_revision:
        error(409, 'DECK_LIST_CHANGED')
    if export.status == 'empty':
        error(422, 'DECK_EMPTY')
    if export.status == 'blocked':
        error(409, 'LIVE_EXPORT_BLOCKED')
    return text_download(export)
