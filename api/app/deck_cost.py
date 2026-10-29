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

The fold (`summarize`) is shared with the Published Deck route (`published_cost`).

Contract: docs/prices.md ("Deck cost").
"""
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from app.games.pokemon.prices import prices
from .deck_list_capture import capture_deck_list
from .identity import verified_user
from .price_budget import Budget, trusted_budget
from .settings import WantListCounting

router = APIRouter(prefix='/api/decks', tags=['decks'])

CostStatus = Literal['priced', 'empty', 'no_quotes', 'incomplete']
IncompleteReason = Literal['deadline', 'store_unavailable', 'validation_unavailable', 'inventory_unavailable']
_INCOMPLETE = ('deadline', 'store_unavailable', 'validation_unavailable')
_FALLBACK = ('timeout', 'busy', 'backoff', 'failed')
_MICRO = 10**6


class DeckCostFigures(BaseModel):
    """One cost figure over a set of copies, with the same statuses, counts and labels as the top-level fields."""
    status: CostStatus
    reason: IncompleteReason | None = None
    total_copies: str | None = None
    priced_copies: str | None = None
    stale_copies: str | None = None
    unknown_age_copies: str | None = None
    fallback_copies: str | None = None
    amount: str | None = None
    display_amount: str | None = None
    currency: Literal['USD'] = 'USD'


class DeckCost(BaseModel):
    deck_id: UUID
    status: CostStatus
    reason: IncompleteReason | None = None
    owner_revision: int | None = None        # The inventory revision the cost belongs to; None when nothing was captured.
    total_copies: str | None = None          # Every copy in the Deck (base-10 integer); None only when the capture failed.
    priced_copies: str | None = None         # The coverage numerator; None unless every row was evaluated.
    stale_copies: str | None = None          # Priced copies whose provider quote is over 48 hours old.
    unknown_age_copies: str | None = None    # Priced copies whose provider quote time is unknown.
    fallback_copies: str | None = None       # Priced copies whose refresh did not finish: shown from the labelled cache.
    amount: str | None = None                # Exact decimal subtotal of the priced copies.
    display_amount: str | None = None        # The only rounded form.
    currency: Literal['USD'] = 'USD'
    # Deck Lists 08. The fields above stay the cost of the Deck's Holdings for today's client; the planned UI overhaul
    # moves to these and retires them.
    deck_list_revision: int | None = None    # The Deck List revision the figures belong to; None when nothing was captured.
    deck_list_cost: DeckCostFigures          # Every Deck List line at its full quantity.
    cost_to_complete: DeckCostFigures        # Only the copies still needed; ``empty`` ($0.00) when nothing needs buying.
    # Decklist import #208: the Want List counting setting ``cost_to_complete`` follows and the settings revision it was
    # read at (the setting moves neither revision above); None when nothing was captured.
    want_list_counting: WantListCounting | None = None
    settings_revision: int | None = None


def _micros(amount: str) -> int:
    """An amount already validated by ``quote_contract.parse_amount`` (``^(0|[1-9]\\d{0,11})(\\.\\d{1,6})?$``)."""
    whole, _, fraction = amount.partition('.')
    return int(whole) * _MICRO + int(fraction.ljust(6, '0'))


def _exact(micros: int) -> str:
    whole, fraction = divmod(micros, _MICRO)
    return f'{whole}.{fraction:06d}'.rstrip('0').rstrip('.')


def _display(micros: int) -> str:
    """Half-up to cents, once; a positive sub-cent subtotal is '<$0.01' (the same rule as ``prices.format_usd``)."""
    if 0 < micros < _MICRO // 100:
        return '<$0.01'
    cents = (micros + _MICRO // 200) // (_MICRO // 100)
    return f'${cents // 100:,}.{cents % 100:02d}'


def summarize(quantities: dict, views: dict) -> dict:
    """Estimated Deck Cost and Pricing Coverage fields for ``{key: positive int quantity}`` and ``{key: QuoteView}``.

    Shared by the private Deck route (ticket 09) and the Published Deck route (ticket 12); keys are opaque (Edition ids or
    public references). An empty mapping is the empty Deck. Coverage is numeric only when no row failed with deadline,
    store_unavailable or validation_unavailable."""
    if not quantities:
        return {'status': 'empty', 'total_copies': '0', 'priced_copies': '0', 'stale_copies': '0',
                'unknown_age_copies': '0', 'fallback_copies': '0', 'amount': '0', 'display_amount': _display(0)}
    total = sum(quantities.values())
    base = {'total_copies': str(total)}
    failed = [view.reason for view in views.values() if view.status == 'failed' and view.reason in _INCOMPLETE]
    if failed:
        return {'status': 'incomplete', 'reason': 'deadline' if 'deadline' in failed else failed[0], **base}
    priced = stale = unknown = fallback = micros = 0
    for key, quantity in quantities.items():
        view = views[key]
        if view.status != 'quote':
            continue
        priced += quantity
        if view.refresh in _FALLBACK:
            fallback += quantity
        micros += _micros(view.amount) * quantity
        if view.age == 'unknown':
            unknown += quantity
        elif view.stale:
            stale += quantity
    counts = {'priced_copies': str(priced), 'stale_copies': str(stale), 'unknown_age_copies': str(unknown),
              'fallback_copies': str(fallback)}
    if priced == 0:
        return {'status': 'no_quotes', **base, **counts}
    return {'status': 'priced', 'amount': _exact(micros), 'display_amount': _display(micros), **base, **counts}


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
