"""Estimated Deck Cost and Pricing Coverage for one complete private Deck (ticket 09), with the Deck List cost and the
cost to complete it (Deck Lists 08).

One access is one consistent capture of the Deck's Holdings and Deck List (``deck_list_capture.capture_deck_list``,
committed and unlocked before any store I/O), then one ``prices.private_edition_quotes`` call over every distinct
Edition the Deck holds or lists. That call reads every cache row (in 128-key store batches), calls
``price_refresh.evaluate_and_admit`` exactly once for the whole Deck, waits at most once, and validates once, all inside
the one gateway budget of this request. The Deck is never split into 64-Edition requests and never priced per Edition.

Three figures share those views. The top-level fields are the Estimated Deck Cost of the Deck's Holdings, unchanged
for today's client. ``deck_list_cost`` covers every Deck List line and ``cost_to_complete`` only the copies each line
still needs under the account's Want List counting setting (``copy_allocation``, decklist import #208): copies the
setting counts as owned cost nothing there, since they would be moved in rather than bought. Each figure is folded from
its own rows only, so a failed row makes incomplete only the figures that contain it.

Arithmetic is exact: quantities are Python integers (base-10 strings on the wire) and quote amounts are integer
micro-dollars, so neither a bigint quantity nor a long sum can lose a digit. The only rounding is the final display.

Coverage is numeric only after every row was evaluated. A row whose cache could not be read or validated in time
(``deadline``, ``store_unavailable``, ``validation_unavailable``) makes the whole answer ``incomplete``: no subtotal and
no coverage, only the copy total. Refresh labels (``busy``, ``timeout``, ...) never make it incomplete: those rows keep
their labelled cached view and are counted like any other.

The fold (`summarize`, in `app.core.prices.cost`) is shared with the Want List, Trade value and Published Deck routes.

Contract: docs/prices.md ("Deck cost").
"""
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from starlette.background import BackgroundTask

from app.core.prices.cost import DeckCost, DeckCostFigures, summarize
from app.deck_list_capture import capture_deck_list
from app.identity import verified_user
from app.games.pokemon.prices import prices
from app.price_budget import Budget, trusted_budget

router = APIRouter(prefix='/api/decks', tags=['decks'])


def _uncaptured(deck_id: UUID, reason: str) -> DeckCost:
    """Nothing was captured: every figure is incomplete for the same reason, with no total and no coverage."""
    figures = DeckCostFigures(status='incomplete', reason=reason)
    return DeckCost(deck_id=deck_id, status='incomplete', reason=reason, deck_list_cost=figures,
                    cost_to_complete=figures)


def private_deck_cost(deck_id: UUID, user_id: str, budget: Budget, releases: list) -> DeckCost:
    """The cost of one private Deck's Holdings, its Deck List and its not-owned copies, inside ``budget``.
    Raises the capture's 404 for a foreign Deck."""
    if budget.wait_remaining() <= 0:
        return _uncaptured(deck_id, 'deadline')
    try:
        captured = prices._bounded(lambda: capture_deck_list(deck_id, user_id, budget.pg_timeout_ms()),
                                   budget.wait_remaining())
    except prices._Late:
        return _uncaptured(deck_id, 'deadline')
    except (psycopg.Error, OSError):
        return _uncaptured(deck_id, 'inventory_unavailable')
    # The capture committed: no inventory lock or connection is held from here on.
    held = captured.holdings
    listed = {line.edition_id: line.quantity for line in captured.lines}
    missing = {line.edition_id: line.need for line in captured.lines if line.need > 0}
    editions = list(dict.fromkeys([*held, *listed]))
    # One read, one admission and at most one wait for every Edition the Deck holds or lists; none for an empty Deck.
    views = prices.private_edition_quotes(editions, budget, releases) if editions else {}

    def figures(quantities: dict) -> dict:
        return summarize(quantities, {key: views[key] for key in quantities})

    return DeckCost(deck_id=deck_id, owner_revision=captured.owner_revision,
                    deck_list_revision=captured.deck_list_revision, want_list_counting=captured.want_list_counting,
                    settings_revision=captured.settings_revision, **figures(held),
                    deck_list_cost=DeckCostFigures(**figures(listed)),
                    cost_to_complete=DeckCostFigures(**figures(missing)))


@router.get('/{deck_id}/cost', response_model=DeckCost)
def deck_cost(deck_id: UUID, user_id: str = Depends(verified_user), budget: Budget = Depends(trusted_budget)):
    # A synchronous route on purpose: the HTTP record-store adapter refuses to run on an event loop.
    if budget.caller != f'user:{user_id}':
        raise HTTPException(401, 'Authentication required')
    releases: list = []
    try:
        cost = private_deck_cost(deck_id, user_id, budget, releases)
    except BaseException:
        prices._release_all(releases)
        raise
    return JSONResponse(cost.model_dump(mode='json'), headers={'cache-control': 'no-store'},
                        background=BackgroundTask(prices._release_all, releases))
