"""Estimated Deck Cost and Pricing Coverage for one complete private Deck (ticket 09).

One access is one consistent capture of every Holding in the Deck (``decks.capture_deck_contents``, committed and
unlocked before any store I/O), then one ``prices.private_edition_quotes`` call over every distinct Edition in it. That
call reads every cache row (in 128-key store batches), calls ``price_refresh.evaluate_and_admit`` exactly once for the
whole Deck, waits at most once, and validates once, all inside the one gateway budget of this request. The Deck is
never split into 64-Edition requests and never priced per Edition.

Arithmetic is exact: quantities are Python integers (base-10 strings on the wire) and quote amounts are integer
micro-dollars, so neither a bigint quantity nor a long sum can lose a digit. The only rounding is the final display.

Coverage is numeric only after every row was evaluated. A row whose cache could not be read or validated in time
(``deadline``, ``store_unavailable``, ``validation_unavailable``) makes the whole answer ``incomplete``: no subtotal and
no coverage, only the copy total. Refresh labels (``busy``, ``timeout``, ...) never make it incomplete: those rows keep
their labelled cached view and are counted like any other.

Contract: docs/prices.md ("Deck cost").
"""
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import prices
from .decks import capture_deck_contents
from .main import verified_user
from .price_budget import Budget, trusted_budget

router = APIRouter(prefix='/api/decks', tags=['decks'])

CostStatus = Literal['priced', 'empty', 'no_quotes', 'incomplete']
IncompleteReason = Literal['deadline', 'store_unavailable', 'validation_unavailable', 'inventory_unavailable']
_INCOMPLETE = ('deadline', 'store_unavailable', 'validation_unavailable')
_FALLBACK = ('timeout', 'busy', 'backoff', 'failed')
_MICRO = 10**6


class DeckCost(BaseModel):
    deck_id: UUID
    status: CostStatus
    reason: IncompleteReason | None = None
    owner_revision: int | None = None        # The inventory revision the cost belongs to; None when nothing was captured.
    total_copies: str | None = None          # Every copy in the Deck (base-10 integer); None only when the capture failed.
    priced_copies: str | None = None         # The coverage numerator; None unless every row was evaluated.
    stale_copies: str | None = None          # Priced copies whose provider quote is over 48 hours old.
    unknown_age_copies: str | None = None    # Priced copies whose provider quote time is unknown.
    fallback_copies: str | None = None       # Copies whose refresh did not finish: shown from the labelled cache.
    amount: str | None = None                # Exact decimal subtotal of the priced copies.
    display_amount: str | None = None        # The only rounded form.
    currency: Literal['USD'] = 'USD'


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


def _summary(deck_id, contents, views) -> DeckCost:
    quantities = {row.edition_id: int(row.quantity) for row in contents.editions}
    total = sum(quantities.values())
    base = {'deck_id': deck_id, 'owner_revision': contents.owner_revision, 'total_copies': str(total)}
    failed = [view.reason for view in views.values() if view.status == 'failed' and view.reason in _INCOMPLETE]
    if failed:
        reason = 'deadline' if 'deadline' in failed else failed[0]
        return DeckCost(status='incomplete', reason=reason, **base)
    priced = stale = unknown = fallback = micros = 0
    for edition_id, quantity in quantities.items():
        view = views[edition_id]
        if view.refresh in _FALLBACK:
            fallback += quantity
        if view.status != 'quote':
            continue
        priced += quantity
        micros += _micros(view.amount) * quantity
        if view.age == 'unknown':
            unknown += quantity
        elif view.stale:
            stale += quantity
    counts = {'priced_copies': str(priced), 'stale_copies': str(stale), 'unknown_age_copies': str(unknown),
              'fallback_copies': str(fallback)}
    if priced == 0:
        return DeckCost(status='no_quotes', **base, **counts)
    return DeckCost(status='priced', amount=_exact(micros), display_amount=_display(micros), **base, **counts)


def private_deck_cost(deck_id: UUID, user_id: str, budget: Budget, releases: list) -> DeckCost:
    """The cost of every copy in one private Deck, inside ``budget``. Raises the capture's 404 for a foreign Deck."""
    if budget.wait_remaining() <= 0:
        return DeckCost(deck_id=deck_id, status='incomplete', reason='deadline')
    try:
        contents = prices._bounded(lambda: capture_deck_contents(deck_id, user_id, budget.pg_timeout_ms()),
                                   budget.wait_remaining())
    except prices._Late:
        return DeckCost(deck_id=deck_id, status='incomplete', reason='deadline')
    except (psycopg.Error, OSError):
        return DeckCost(deck_id=deck_id, status='incomplete', reason='inventory_unavailable')
    # The capture committed: no inventory lock or connection is held from here on.
    if not contents.editions:
        return DeckCost(deck_id=deck_id, status='empty', owner_revision=contents.owner_revision, total_copies='0',
                        priced_copies='0', stale_copies='0', unknown_age_copies='0', fallback_copies='0',
                        amount='0', display_amount=_display(0))
    views = prices.private_edition_quotes([row.edition_id for row in contents.editions], budget, releases)
    return _summary(deck_id, contents, views)


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
