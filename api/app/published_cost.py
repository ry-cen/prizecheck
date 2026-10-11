"""Estimated Deck Cost and Pricing Coverage for one Published Deck snapshot version (ticket 12).

Anonymous and PostgreSQL-free. The only inputs are the token and the version in the path (``public_deck``). Rows,
references and quantities come from the active frozen snapshot; eligibility from the shared public catalog records
(``public_catalog.marketplace_states``); quotes from the shared Edition + mapping-revision cache, the same records the
private route reads, never a per-Deck copy. One access is one ``price_refresh.evaluate_and_admit`` over every priced row,
at most one wait, a final validation inside the 0.5 s reserve, and the private route's arithmetic
(``deck_cost.summarize``). Before any figure is returned the snapshot is re-read (token, version, digest) and every
Edition's eligibility is re-read; otherwise the answer is 404 (revoked), 409 (republished or rewritten) or a withheld
``incomplete``.

Contract: docs/prices.md ("Published Deck cost").
"""
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import price_refresh, prices, public_deck
from .deck_cost import CostStatus, IncompleteReason, summarize
from .price_budget import FINAL_MARGIN_MS, Budget, trusted_budget
from .public_catalog import marketplace_states
from .public_projection import ProjectionUnavailable
from .public_records import public_record_store, quote_states

router = APIRouter(tags=['prices'])
ANON = re.compile(r'anon:[0-9a-f]{32}')
_FINAL_MARGIN = FINAL_MARGIN_MS / 1000


class PublishedDeckCost(BaseModel):
    version: int                              # the snapshot version this answer belongs to
    digest: str | None = None                 # sha256 of the frozen snapshot content; None when it was not confirmed
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


def _label(state, printing_ref):
    """Why a frozen row has no price lookup, or None when it has one. Fails closed for unproven references."""
    if state.state == 'unknown' or not public_deck.printing_matches(printing_ref, state.printing_ref):
        return prices._unavailable('not_found')
    if state.state == 'quarantined':
        return prices._unavailable('quarantined')
    if state.state != 'verified':
        return prices._unavailable('unspecified_variant' if state.reason == 'unspecified_variant' else 'unverified')
    if state.quote_lookup is None:
        return prices._unavailable('no_quote_variant')
    if state.quote is None:
        return prices._unavailable('not_cached')
    return None


def _signature(state):
    return (state.state, state.mapping_revision, state.product_id, state.quote_lookup, state.printing_ref)


def public_quotes(frozen: dict, budget: Budget, releases: list, store=None) -> dict:
    """QuoteView per public Edition reference in ``frozen`` ({edition_ref: frozen printing_ref or None})."""
    refs = list(frozen)
    if not refs:
        return {}
    if budget.wait_remaining() <= 0:
        return prices._failed(refs, 'deadline')
    try:
        store = store or public_record_store()
        first = marketplace_states(store, refs, budget.wait_until)
    except (ProjectionUnavailable, ValueError):
        return prices._failed(refs, 'deadline' if budget.wait_remaining() <= 0 else 'store_unavailable')
    if budget.wait_remaining() <= 0:
        return prices._failed(refs, 'deadline')
    lookable = [ref for ref in refs if _label(first[ref], frozen[ref]) is None]
    states = {ref: first[ref].quote for ref in lookable}
    outcomes = {}
    if lookable:
        rows = [price_refresh.Row(ref, ref, first[ref].mapping_revision, first[ref].quote_lookup, first[ref].product_id,
                                  states[ref]) for ref in lookable]
        admission = price_refresh.evaluate_and_admit(rows, budget.caller, budget, store)
        releases.append(admission.release)
        outcomes = admission.outcomes
        changed = admission.wait(budget)
        if changed:
            pairs = [(ref, first[ref].mapping_revision) for ref in lookable if ref in changed]
            try:
                fresh = quote_states(store, pairs, deadline=budget.wait_until)
                states.update({ref: fresh[(ref, revision)] for ref, revision in pairs})
            except (ProjectionUnavailable, ValueError):
                for ref in changed:
                    outcomes[ref].refresh = 'timeout'
    # Final eligibility inside the reserve: the public catalog must still say what it said when the keys were chosen.
    try:
        final = marketplace_states(store, refs, budget.hard - _FINAL_MARGIN)
    except (ProjectionUnavailable, ValueError):
        return prices._failed(refs, 'deadline' if budget.expired() else 'validation_unavailable')
    now = prices._now()
    views = {}
    for ref in refs:
        label = _label(final[ref], frozen[ref])
        if label is not None:
            views[ref] = label
        elif ref not in states or _signature(final[ref]) != _signature(first[ref]):
            views[ref] = prices._unavailable('not_cached')
        else:
            views[ref] = prices._with_refresh(prices.validate_quote(final[ref].quote_lookup, states[ref], now),
                                              outcomes.get(ref))
    return views


def _withheld(version: int, reason: str) -> PublishedDeckCost:
    """Nothing unvalidated: no digest, no total, no coverage."""
    return PublishedDeckCost(version=version, status='incomplete', reason=reason)


def published_deck_cost(token: str, version: int, budget: Budget, releases: list, store=None) -> PublishedDeckCost:
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
    views.update(public_quotes(frozen, budget, releases, store))
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
    return PublishedDeckCost(version=active.version, digest=active.digest, **summarize(quantities, views))


@router.get('/api/public/decks/{token}/versions/{version}/cost', response_model=PublishedDeckCost)
def published_cost(request: Request, token: str, version: str, budget: Budget = Depends(trusted_budget)):
    # A synchronous route on purpose: the HTTP record-store adapter refuses to run on an event loop.
    if not ANON.fullmatch(budget.caller):
        raise HTTPException(401, 'Authentication required')
    number = public_deck.public_path(request, token, version)
    releases: list = []
    try:
        cost = published_deck_cost(token, number, budget, releases)
    except BaseException:
        prices._release_all(releases)
        raise
    return JSONResponse(cost.model_dump(mode='json'), headers=dict(public_deck.PUBLIC_HEADERS),
                        background=BackgroundTask(prices._release_all, releases))
