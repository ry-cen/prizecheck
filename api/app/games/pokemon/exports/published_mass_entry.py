"""TCGplayer Mass Entry export of one Published Deck snapshot version (ticket 14).

Anonymous, unbudgeted and PostgreSQL-free. The only inputs are the token and the version in the path (``public_deck``).
Every row and quantity comes from the active frozen snapshot. A row carries a product only when its frozen Edition
reference resolves to a public Edition record that names the frozen Printing (``public_deck.same_printing``), is
verified with a product now (``public_catalog.marketplace_states``; a quarantine removes it at once) and has a known
finish. Otherwise the private export's complete text fallback applies, with frozen names, one line per proven Printing
and its own line for every unproven row. The snapshot is revalidated (token, version, digest) before any answer.

Contract: docs/public-projections.md ("Published Deck exports").
"""
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import deck_mass_entry
from app.games.pokemon.publications import public_deck
from ..prices.catalog_targets import is_unspecified
from .mass_entry_export import MassEntryExport, MassEntryInputRow
from ..catalog.public_catalog import marketplace_states
from app.public_projection import ProjectionUnavailable
from app.public_records import public_record_store

router = APIRouter(tags=['published-exports'])


class PublishedMassEntryView(BaseModel):
    version: int
    digest: str
    status: Literal['link', 'text', 'empty']
    url: str | None
    fallback_reason: Literal['missing_mapping', 'encoded_length', 'quantity_unsupported'] | None
    text: str | None
    inline: bool
    byte_length: int
    lines: list[deck_mass_entry.MassEntryLineView]
    line_count: int
    less_specific_count: int
    total_copies: str


def _editions(active, deadline) -> dict:
    refs = [row.edition_ref for row in active.rows if row.edition_ref is not None]
    if not refs:
        return {}
    try:
        return marketplace_states(public_record_store(), refs, deadline)
    except (ProjectionUnavailable, ValueError):
        raise public_deck.error(503, 'PUBLIC_CATALOG_UNAVAILABLE') from None


def _rows(active, editions) -> list[MassEntryInputRow]:
    rows = []
    for index, row in enumerate(active.rows):
        state = editions.get(row.edition_ref) if row.edition_ref is not None else None
        proven = state is not None and public_deck.same_printing(row, state.printing_ref)
        product = state.product_id if proven and state.product_eligible and not is_unspecified(row.variant) else None
        # No verified TCGplayer set/number crosswalk exists (as for private Decks): rows stay name-only, less specific.
        rows.append(MassEntryInputRow(key=str(index), printing_key=row.printing_ref if proven else f'unproven:{index}',
                                      display_name=row.name, quantity=row.quantity, product_id=product, specificity=None))
    return rows


def published_mass_entry(token: str, version: int) -> tuple[public_deck.ActiveSnapshot, MassEntryExport]:
    deadline = public_deck.export_deadline()
    active = public_deck.read_for_export(token, version, deadline=deadline)
    export = deck_mass_entry.formatted(_rows(active, _editions(active, deadline)))
    public_deck.revalidate_for_export(active, deadline=deadline)
    return active, export


@router.get('/api/public/decks/{token}/versions/{version}/exports/tcgplayer', response_model=PublishedMassEntryView)
def published_mass_entry_export(request: Request, token: str, version: str):
    # Synchronous on purpose: the HTTP record-store adapter refuses to run on an event loop.
    active, export = published_mass_entry(token, public_deck.public_path(request, token, version))
    view = PublishedMassEntryView(version=active.version, digest=active.digest, **deck_mass_entry.view_fields(export))
    return JSONResponse(view.model_dump(mode='json'), headers=dict(public_deck.PUBLIC_HEADERS))


@router.get('/api/public/decks/{token}/versions/{version}/exports/tcgplayer.txt')
def published_mass_entry_download(request: Request, token: str, version: str):
    # Every refusal and the revalidation happen before streaming starts.
    _, export = published_mass_entry(token, public_deck.public_path(request, token, version))
    if export.status == 'empty':
        raise public_deck.error(422, 'DECK_EMPTY')
    return deck_mass_entry.text_download(export, public_deck.PUBLIC_HEADERS)
