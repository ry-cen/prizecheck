"""Estimated Deck Cost and Pricing Coverage for one Published Deck snapshot version (ticket 12).

Anonymous and PostgreSQL-free. The only inputs are the token and the version in the path (``public_deck``). Rows,
references and quantities come from the active frozen snapshot; eligibility and price from the shared public records
(``public_catalog.marketplace_states``: the catalog and quarantine records and the Edition's ``price:`` record, read at one
generation). There is no admission and no wait: a row without a valid ``price:`` record is unpriced (``no_price``). The
route does the private route's arithmetic (``core.prices.cost.summarize``). Before any figure is returned the snapshot is
re-read (token, version, digest); otherwise the answer is 404 (revoked), 409 (republished or rewritten) or a withheld
``incomplete``. A quarantine delivered through the outbox unprices a row even while its ``price:`` record remains.
With ``PRICE_READS=off`` no ``price:`` record is read and every row is unpriced.

Each answer that passed the final validation also lists every frozen Edition's own price (app redesign #183):
``editions`` holds one ``{edition_ref, amount}`` per distinct public Edition reference, in snapshot order, with the
exact per-copy amount of a priced row and null otherwise. It comes from the same views as the totals, so it adds no
store read, and it carries no price age. Legacy rows have no reference and no entry.

Contract: docs/prices.md ("Published Deck cost").
"""
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app import public_deck

from app.games.pokemon.prices import prices
from app.core.prices.cost import CostStatus, IncompleteReason, summarize
from app.price_budget import FINAL_MARGIN_MS, Budget, trusted_budget
from app.games.pokemon.catalog.public_catalog import marketplace_states
from app.public_projection import ProjectionUnavailable
from app.public_records import public_record_store
from app.core.prices.quote_contract import parse_amount

router = APIRouter(tags=['prices'])
ANON = re.compile(r'anon:[0-9a-f]{32}')
_FINAL_MARGIN = FINAL_MARGIN_MS / 1000


class PublishedEditionPrice(BaseModel):
    """One frozen Edition's price: the exact per-copy amount of its quote, or null when it has none. No age."""
    model_config = ConfigDict(extra='forbid')
    edition_ref: str = Field(pattern=r'^[0-9a-f]{48}$')
    amount: str | None = None


class PublishedDeckCost(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int                              # the snapshot version this answer belongs to
    digest: str | None = None                 # sha256 of the frozen snapshot content; None when it was not confirmed
    status: CostStatus
    reason: IncompleteReason | None = None
    total_copies: str | None = None
    priced_copies: str | None = None
    amount: str | None = None
    display_amount: str | None = None
    currency: Literal['USD'] = 'USD'
    # App redesign #183: each frozen Edition's per-copy price, for the Published Deck page's tiles and lines. Empty on a
    # withheld or incomplete answer, like every other figure.
    editions: list[PublishedEditionPrice] = []


def _label(state, printing_ref):
    """Why a frozen row has no price, or None when it has one. Fails closed for unproven references."""
    if state.state == 'unknown' or not public_deck.printing_matches(printing_ref, state.printing_ref):
        return prices._unavailable('not_found')
    if state.state == 'quarantined':
        return prices._unavailable('quarantined')
    if state.state != 'verified':
        return prices._unavailable('unspecified_variant' if state.reason == 'unspecified_variant' else 'unverified')
    if state.price is None:
        return prices._unavailable('no_price')
    return None


def _view(state, printing_ref) -> prices.QuoteView:
    """A frozen row's price view: the label that explains why it has none, else the ``price:`` record's amount. No age."""
    label = _label(state, printing_ref)
    if label is not None:
        return label
    amount = parse_amount(state.price['amount'])
    return prices.QuoteView(status='quote', amount=state.price['amount'], display_amount=prices.format_usd(amount))


def public_quotes(frozen: dict, budget: Budget, store=None) -> dict:
    """QuoteView per public Edition reference in ``frozen`` ({edition_ref: frozen printing_ref or None}), from the
    ``price:`` records alone: no admission, no wait. Eligibility and price are read together at one generation, inside the
    reserve the budget keeps for the final validation."""
    refs = list(frozen)
    if not refs:
        return {}
    if budget.wait_remaining() <= 0:
        return prices._failed(refs, 'deadline')
    try:
        store = store or public_record_store()
        states = marketplace_states(store, refs, budget.hard - _FINAL_MARGIN)
    except (ProjectionUnavailable, ValueError):
        return prices._failed(refs, 'deadline' if budget.expired() else 'store_unavailable')
    return {ref: _view(states[ref], frozen[ref]) for ref in refs}


def _withheld(version: int, reason: str) -> PublishedDeckCost:
    """Nothing unvalidated: no digest, no total, no coverage."""
    return PublishedDeckCost(version=version, status='incomplete', reason=reason)


def published_deck_cost(token: str, version: int, budget: Budget, store=None) -> PublishedDeckCost:
    if budget.wait_remaining() <= 0:
        return _withheld(version, 'deadline')
    try:
        active = public_deck.read_active(token, version, deadline=budget.wait_until)
    except public_deck.SnapshotLate:
        return _withheld(version, 'deadline')
    except public_deck.SnapshotGone:
        raise public_deck.error(404, 'PUBLISHED_DECK_NOT_FOUND') from None
    except public_deck.SnapshotChanged:
        raise public_deck.error(409, 'PUBLISHED_DECK_CHANGED') from None
    except ProjectionUnavailable:
        raise public_deck.error(503, 'PUBLIC_PROJECTION_UNAVAILABLE') from None
    quantities, frozen = {}, {}
    for index, row in enumerate(active.rows):
        key = row.edition_ref if row.edition_ref is not None else f'legacy:{index}'
        quantities[key] = quantities.get(key, 0) + row.quantity
        if row.edition_ref is not None:
            frozen[key] = row.printing_ref if frozen.get(key, row.printing_ref) == row.printing_ref else None
    views = {key: prices._unavailable('not_found') for key in quantities if key not in frozen}  # legacy: unproven
    views.update(public_quotes(frozen, budget, store))
    try:
        public_deck.revalidate(active, deadline=budget.hard - _FINAL_MARGIN)
    except public_deck.SnapshotLate:
        return _withheld(version, 'deadline' if budget.expired() else 'validation_unavailable')
    except public_deck.SnapshotGone:
        raise public_deck.error(404, 'PUBLISHED_DECK_NOT_FOUND') from None
    except public_deck.SnapshotChanged:
        raise public_deck.error(409, 'PUBLISHED_DECK_CHANGED') from None
    except ProjectionUnavailable:
        return _withheld(version, 'validation_unavailable')
    if budget.expired():
        return _withheld(version, 'deadline')
    figures = summarize(quantities, views)
    editions = [] if figures['status'] == 'incomplete' else [
        PublishedEditionPrice(edition_ref=ref, amount=view.amount if view.status == 'quote' else None)
        for ref, view in ((ref, views[ref]) for ref in frozen)]
    # No price age is shown or sent (app redesign spec): the shared fold's age counts and its count of copies shown
    # from the labelled cache (which hints at staleness, owner decision 2026-10-14) stay private.
    public = {key: value for key, value in figures.items()
              if key not in ('stale_copies', 'unknown_age_copies', 'fallback_copies')}
    return PublishedDeckCost(version=active.version, digest=active.digest, editions=editions, **public)


@router.get('/api/public/decks/{token}/versions/{version}/cost', response_model=PublishedDeckCost)
def published_cost(request: Request, token: str, version: str, budget: Budget = Depends(trusted_budget)):
    # A synchronous route on purpose: the HTTP record-store adapter refuses to run on an event loop.
    if not ANON.fullmatch(budget.caller):
        raise HTTPException(401, 'Authentication required')
    number = public_deck.public_path(request, token, version)
    cost = published_deck_cost(token, number, budget)
    return JSONResponse(cost.model_dump(mode='json'), headers=dict(public_deck.PUBLIC_HEADERS))
