"""The Want List's cost (decklist import #210; spec "The Want List", ``GET /api/want-list/cost``).

``GET /api/want-list/cost`` (optional ``deck=<id>``) prices what ``GET /api/want-list`` shows for the same scope: the
combined total, each Deck's section and each of their lines, and each combined row, every figure with Pricing Coverage.
It is a separate request so the page draws before prices arrive.

It is a price access under the access-triggered refresh rule (ADR 0006), budgeted like Deck cost (``deck_cost``): one
capture (``want_list.capture_want_list`` under ``prices._bounded``, committed and unlocked before any store I/O), then one
``prices.private_edition_quotes`` call over every distinct Edition the scope still needs. That call reads every cache
row, admits refresh once (``price_refresh.evaluate_and_admit``), waits at most once and validates once, inside the one
gateway budget of this request. Editions the Collection already covers are not read: only what is bought is priced.

Every figure is ``deck_cost.summarize`` over its own copies, so the arithmetic, the statuses and the labels are Deck
cost's: an unpriced copy is never $0, and a row that could not be read in time makes only the figures containing it
``incomplete``. The answer names the setting, the revisions and the Deck Lists digest it was captured at, exactly as the
Want List does, so the page shows a cost only for the answer it drew. Nothing is stored.

Contract: docs/prices.md ("Want List cost").
"""
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import prices
from .deck_cost import DeckCostFigures, summarize
from .identity import verified_user
from .price_budget import Budget, trusted_budget
from .settings import WantListCounting
from .want_list import capture_want_list, combined

router = APIRouter(prefix='/api/want-list', tags=['want-list'])


class WantListLineCost(BaseModel):
    """One section line: its ``need`` copies at the Edition's price."""
    edition_id: UUID
    need: str
    price_each: str | None          # The per-copy display price of a priced Edition ("$0.25", "<$0.01"); else null.
    cost: DeckCostFigures


class WantListSectionCost(BaseModel):
    deck_id: UUID
    deck_list_revision: int
    cost: DeckCostFigures            # Every copy the Deck still needs; ``empty`` ($0.00) when it needs nothing.
    lines: list[WantListLineCost]    # One per line that still needs copies.


class WantListRowCost(BaseModel):
    """One combined-total row: the card's need across the shown Decks (the sum, or the largest need)."""
    edition_id: UUID
    need: str
    cost: DeckCostFigures


class WantListCost(BaseModel):
    deck_id: UUID | None             # The scope asked for, or null for All Decks.
    # What the figures were captured at, as ``GET /api/want-list`` names them; all null when nothing was captured.
    want_list_counting: WantListCounting | None
    settings_revision: int | None
    owner_revision: int | None
    deck_lists_digest: str | None
    total: DeckCostFigures           # The combined total (the scoped Deck's needs when scoped).
    sections: list[WantListSectionCost]
    combined: list[WantListRowCost]


def _uncaptured(scope: UUID | None, reason: str) -> WantListCost:
    """Nothing was captured: the total is incomplete with no copy count and no coverage, and nothing else is answered."""
    return WantListCost(deck_id=scope, want_list_counting=None, settings_revision=None, owner_revision=None,
                        deck_lists_digest=None, total=DeckCostFigures(status='incomplete', reason=reason), sections=[],
                        combined=[])


def want_list_cost(user_id: str, scope: UUID | None, budget: Budget, releases: list) -> WantListCost:
    """The cost of the Want List in ``scope`` inside ``budget``. Raises the capture's 404 for a scope that isn't one of
    the owner's Decks."""
    if budget.wait_remaining() <= 0:
        return _uncaptured(scope, 'deadline')
    try:
        capture = prices._bounded(lambda: capture_want_list(user_id, scope, budget.pg_timeout_ms()),
                                  budget.wait_remaining())
    except prices._Late:
        return _uncaptured(scope, 'deadline')
    except (psycopg.Error, OSError):
        return _uncaptured(scope, 'inventory_unavailable')
    # The capture committed: no inventory lock or connection is held from here on.
    needs = {deck.id: capture.needs(deck.id) for deck in capture.shown()}
    total = combined(capture, needs)
    # One read, one admission and at most one wait for every Edition still needed; none when nothing is.
    editions = [edition for edition, _, _ in total]
    views = prices.private_edition_quotes(editions, budget, releases) if editions else {}

    def figure(quantities: dict) -> DeckCostFigures:
        return DeckCostFigures(**summarize(quantities, {key: views[key] for key in quantities}))

    def each(edition: UUID) -> str | None:
        view = views[edition]
        return view.display_amount if view.status == 'quote' else None

    sections = [WantListSectionCost(
        deck_id=deck.id, deck_list_revision=deck.deck_list_revision,
        cost=figure({line.edition_id: line.need for line in needs[deck.id]}),
        lines=[WantListLineCost(edition_id=line.edition_id, need=str(line.need), price_each=each(line.edition_id),
                                cost=figure({line.edition_id: line.need})) for line in needs[deck.id]])
        for deck in capture.shown()]
    rows = [WantListRowCost(edition_id=edition, need=str(need), cost=figure({edition: need}))
            for edition, need, _ in total]
    return WantListCost(deck_id=capture.scope, want_list_counting=capture.counting,
                        settings_revision=capture.settings_revision, owner_revision=capture.owner_revision,
                        deck_lists_digest=capture.deck_lists_digest,
                        total=figure({edition: need for edition, need, _ in total}), sections=sections, combined=rows)


@router.get('/cost', response_model=WantListCost)
def want_list_cost_route(deck: UUID | None = None, user_id: str = Depends(verified_user),
                         budget: Budget = Depends(trusted_budget)):
    # A synchronous route on purpose: the HTTP record-store adapter refuses to run on an event loop. The budget signs the
    # path, not the query; ``deck`` is the caller's own scope, and a Deck that isn't theirs is 404 once the capture runs.
    if budget.caller != f'user:{user_id}':
        raise HTTPException(401, 'Authentication required')
    releases: list = []
    try:
        cost = want_list_cost(user_id, deck, budget, releases)
    except BaseException:
        prices._release_all(releases)
        raise
    return JSONResponse(cost.model_dump(mode='json'), headers={'cache-control': 'no-store'},
                        background=BackgroundTask(prices._release_all, releases))
