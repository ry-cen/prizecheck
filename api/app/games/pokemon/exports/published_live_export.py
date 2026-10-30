"""Pokémon TCG Live export of one Published Deck snapshot version (ticket 13).

Anonymous, unbudgeted and PostgreSQL-free. The only inputs are the token and the version in the path (``public_deck``).
Every row and quantity comes from the active frozen snapshot. A row's Printing is proven by its frozen Printing
reference resolving to a public Printing record (``public_catalog.live_states``); Live support is that Printing's
current reviewed state. Marketplace state is never read, so a quarantined, unverified or unknown-finish Edition never
blocks a valid Live derivation. Rows without a resolvable Printing (legacy snapshots included) block the complete
export while the snapshot stays readable. Formatting, grouping, blocking and the inline/download split are the private
export's own code. The snapshot is revalidated (token, version, digest) before any answer.

Contract: docs/public-projections.md ("Published Deck exports").
"""
from typing import Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import deck_live_export
from app.games.pokemon.publications import public_deck
from .live_export import LiveExport, LiveInputRow, format_live
from ..catalog.public_catalog import live_states
from app.public_projection import ProjectionUnavailable
from app.public_records import public_record_store

router = APIRouter(tags=['published-exports'])
UNPROVEN = 'unproven_reference'


class PublishedLiveBlockerView(BaseModel):
    name: str
    set_name: str
    collector_number: str
    descriptor: dict[str, Any]
    quantity: str
    reason: str


class PublishedLiveExportView(BaseModel):
    version: int
    digest: str
    status: Literal['ok', 'blocked', 'empty']
    text: str | None
    inline: bool
    byte_length: int
    total_copies: str
    blockers: list[PublishedLiveBlockerView]


def _printings(active, deadline) -> dict:
    refs = [row.printing_ref for row in active.rows if row.printing_ref is not None]
    if not refs:
        return {}
    try:
        return live_states(public_record_store(), refs, deadline)
    except (ProjectionUnavailable, ValueError):
        raise public_deck.error(503, 'PUBLIC_CATALOG_UNAVAILABLE') from None


def _rows(active, printings) -> list[LiveInputRow]:
    rows = []
    for index, row in enumerate(active.rows):
        live = printings.get(row.printing_ref) if row.printing_ref is not None else None
        if live is None or live.state == 'unknown':
            state, reason, identity = 'unproven', UNPROVEN, None
        else:
            state, reason, identity = live.state, live.reason, live.identity
        rows.append(LiveInputRow(str(index), row.name, row.set_name, row.collector_number, row.variant, row.quantity,
                                 state, reason, identity))
    return rows


def published_live(token: str, version: int) -> tuple[public_deck.ActiveSnapshot, LiveExport]:
    deadline = public_deck.export_deadline()
    active = public_deck.read_for_export(token, version, deadline=deadline)
    export = format_live(_rows(active, _printings(active, deadline)))
    public_deck.revalidate_for_export(active, deadline=deadline)
    return active, export


@router.get('/api/public/decks/{token}/versions/{version}/exports/live', response_model=PublishedLiveExportView)
def published_live_export(request: Request, token: str, version: str):
    # Synchronous on purpose: the HTTP record-store adapter refuses to run on an event loop.
    active, export = published_live(token, public_deck.public_path(request, token, version))
    view = PublishedLiveExportView(
        version=active.version, digest=active.digest, **deck_live_export.export_fields(export),
        blockers=[PublishedLiveBlockerView(name=b.display_name, set_name=b.set_label, collector_number=b.collector_number,
                                           descriptor=b.descriptor, quantity=str(b.quantity), reason=b.reason)
                  for b in export.blockers])
    return JSONResponse(view.model_dump(mode='json'), headers=dict(public_deck.PUBLIC_HEADERS))


@router.get('/api/public/decks/{token}/versions/{version}/exports/live.txt')
def published_live_export_text(request: Request, token: str, version: str):
    # Every refusal and the revalidation happen before streaming starts: once a byte is sent the status is committed.
    _, export = published_live(token, public_deck.public_path(request, token, version))
    if export.status == 'empty':
        raise public_deck.error(422, 'DECK_EMPTY')
    if export.status == 'blocked':
        raise public_deck.error(409, 'LIVE_EXPORT_BLOCKED')
    return deck_live_export.text_download(export, public_deck.PUBLIC_HEADERS)
