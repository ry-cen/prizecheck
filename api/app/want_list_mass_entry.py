"""Buy on TCGplayer from the Want List (decklist import #210; spec "The Want List", ``/exports/tcgplayer``).

``GET /api/want-list/exports/tcgplayer`` (optional ``deck=<id>``) is the TCGplayer Mass Entry export of exactly what
the Want List shows for the same scope, under the account's counting setting: the combined total with no ``deck``, or
that Deck's needs with one. It reuses the private Deck export's formatter and view (``deck_mass_entry.input_rows``,
``formatted``, ``view_fields`` and ``text_download``), so its link, text, coverage reasons and less-specific rows are the
Deck export's.

``.../tcgplayer.txt`` downloads the same text, pinned to the answer the page prepared: the inventory revision (409
``INVENTORY_CHANGED``), the Deck Lists digest (409 ``DECK_LIST_CHANGED``) and the settings revision (409
``SETTINGS_CHANGED``); none of the three moves another. Nothing to buy is 422 ``NOTHING_NOT_OWNED``.

It reads no prices, quotes or Live data and writes nothing: it is not a price access and carries no gateway budget.
"""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from .deck_mass_entry import MassEntryLineView, formatted, input_rows, text_download, view_fields
from .location_tree import error
from .identity import verified_user
from .mass_entry_export import format_mass_entry
from .settings import WantListCounting
from .want_list import WantListCapture, capture_want_list, combined

router = APIRouter(prefix='/api/want-list/exports', tags=['want-list'])


class WantListMassEntryView(BaseModel):
    # The Deck export's view fields (``deck_mass_entry.view_fields``).
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
    # The answer it belongs to, as ``GET /api/want-list`` names it.
    deck_id: UUID | None
    want_list_counting: WantListCounting
    settings_revision: int
    owner_revision: int
    deck_lists_digest: str


def needed_rows(user_id: str, deck_id: UUID | None):
    """One Want List capture, then the current mappings of what it still needs; no lock is held across the two."""
    capture = capture_want_list(user_id, deck_id)
    needs = {deck.id: capture.needs(deck.id) for deck in capture.shown()}
    return capture, input_rows({edition: need for edition, need, _ in combined(capture, needs)})


def _named(capture: WantListCapture) -> dict:
    return {'deck_id': capture.scope, 'want_list_counting': capture.counting,
            'settings_revision': capture.settings_revision, 'owner_revision': capture.owner_revision,
            'deck_lists_digest': capture.deck_lists_digest}


@router.get('/tcgplayer', response_model=WantListMassEntryView)
def want_list_tcgplayer_export(deck: UUID | None = None, user_id: str = Depends(verified_user)):
    capture, rows = needed_rows(user_id, deck)
    return WantListMassEntryView(**view_fields(formatted(rows)), **_named(capture))


@router.get('/tcgplayer.txt')
def want_list_tcgplayer_download(owner_revision: int = Query(ge=0), settings_revision: int = Query(ge=1),
                                 deck_lists: str = Query(pattern=r'^[0-9a-f]{32}$'), deck: UUID | None = None,
                                 user_id: str = Depends(verified_user)):
    capture, rows = needed_rows(user_id, deck)
    if capture.owner_revision != owner_revision:
        error(409, 'INVENTORY_CHANGED')
    if capture.deck_lists_digest != deck_lists:
        error(409, 'DECK_LIST_CHANGED')
    if capture.settings_revision != settings_revision:
        error(409, 'SETTINGS_CHANGED')
    export = format_mass_entry(rows)
    if export.status == 'empty':
        error(422, 'NOTHING_NOT_OWNED')
    return text_download(export)
