"""Cached exact-Edition prices.

Read-only by construction: this module reads PostgreSQL (reviewed Edition state, the authority) and the
public record store (quotes written by later tickets), and nothing else. It never fetches a source, never
writes to either store, and never reads ``catalog_edition_metadata.quote_candidate``. A key is read only
under the PostgreSQL ``mapping_revision`` and only when the Edition has a published ``quote_lookup``; the
store's own quarantine record is ignored because PostgreSQL is authoritative.

Contract for the later writer (ticket 08) and for tickets 09/12: docs/prices.md.
"""
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, localcontext
import os
import threading
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from psycopg.rows import dict_row

from .catalog_targets import edition_targets, is_unspecified
from .main import verified_user
from .price_budget import MAX_BODY_BYTES, Budget, trusted_budget
from .public_projection import ProjectionUnavailable
from .public_records import QuoteState, public_record_store, quote_states
from .quote_contract import parse_amount  # noqa: F401  (moved; re-exported so `prices.parse_amount` keeps working)

router = APIRouter(prefix='/api/prices', tags=['prices'])

STALE_AFTER = timedelta(hours=48)
FUTURE_TOLERANCE = timedelta(minutes=5)
MAX_EDITIONS = 64

Status = Literal['quote', 'unavailable', 'failed', 'pending']
Reason = Literal['not_found', 'unverified', 'quarantined', 'unspecified_variant', 'no_quote_variant', 'not_cached',
                 'confirmed_absent', 'lookup_mismatch', 'invalid_quote', 'store_unavailable', 'deadline',
                 'validation_unavailable']

_CENT = Decimal('0.01')


def _now() -> datetime:
    """Module clock for provider-age arithmetic; tests patch this."""
    return datetime.now(timezone.utc)


class QuoteView(BaseModel):
    status: Status
    reason: Reason | None = None
    amount: str | None = None            # Exact decimal text from the record; never a float.
    display_amount: str | None = None    # The only rounded form ("$0.44" or "<$0.01").
    currency: Literal['USD'] = 'USD'
    provider_updated_at: str | None = None
    checked_at: str | None = None
    age: Literal['known', 'unknown'] = 'unknown'
    stale: bool | None = None            # True only when the quote is strictly more than 48 h old.


def format_usd(amount: Decimal) -> str:
    """Display rounding, and the only place it happens: half-up to cents; positive sub-cent amounts show '<$0.01'."""
    with localcontext() as context:
        context.prec = 40
        if 0 < amount < _CENT:
            return '<$0.01'
        return f'${amount.quantize(_CENT, rounding=ROUND_HALF_UP):,.2f}'


def _timestamp(value, now: datetime) -> datetime | None:
    """A timezone-aware ISO time that is not (materially) in the future, else None."""
    if type(value) is not str or not 0 < len(value) <= 40:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is None or moment.utcoffset() is None:
        return None
    moment = moment.astimezone(timezone.utc)
    return None if moment > now + FUTURE_TOLERANCE else moment


def _text(moment: datetime) -> str:
    return moment.isoformat().replace('+00:00', 'Z')


def _unavailable(reason: Reason, status: Status = 'unavailable') -> QuoteView:
    return QuoteView(status=status, reason=reason)


def validate_quote(lookup: dict, state: QuoteState, now: datetime) -> QuoteView:
    """What a store state means for an Edition whose PostgreSQL ``quote_lookup`` is ``lookup``. Pure."""
    result = state.result if isinstance(state.result, dict) else {}
    checked = _timestamp(result.get('checked_at'), now)
    checked_text = _text(checked) if checked else None
    if state.status == 'unknown':
        return _unavailable('not_cached')
    if state.status == 'absent':
        return QuoteView(status='unavailable', reason='confirmed_absent', checked_at=checked_text)
    if state.status == 'pending':
        return QuoteView(status='pending')
    if state.status == 'invalid':  # a malformed result/quote row: this row only
        return _unavailable('invalid_quote', 'failed')
    payload = state.quote
    if state.status != 'quote' or not isinstance(payload, dict):
        return _unavailable('invalid_quote', 'failed')
    if payload.get('card') != lookup.get('card') or payload.get('variant') != lookup.get('variant'):
        return _unavailable('lookup_mismatch', 'failed')
    amount = parse_amount(payload.get('amount'))
    # A zero is never shown: a missing price must not be indistinguishable from a free card.
    if amount is None or payload.get('currency') != 'USD' or payload.get('source') != 'tcgdex':
        return _unavailable('invalid_quote', 'failed')
    provider = _timestamp(payload.get('provider_updated_at'), now)
    age = 'known' if provider else 'unknown'
    stale = (now - provider) > STALE_AFTER if provider else None
    return QuoteView(status='quote', amount=payload['amount'], display_amount=format_usd(amount),
                     provider_updated_at=_text(provider) if provider else None, checked_at=checked_text,
                     age=age, stale=stale)


# --- Reading ---------------------------------------------------------------------------------------------------
class _Late(Exception):
    """Work did not finish inside the budget; its thread is abandoned and ends on its own PostgreSQL timeouts."""


def _bounded(call, timeout: float):
    """Run blocking PostgreSQL work so the caller's own clock, not libpq's two-second connect floor, bounds the wait."""
    box = {}

    def work():
        try:
            box['value'] = call()
        except BaseException as exc:  # noqa: BLE001 - re-raised in the caller
            box['error'] = exc

    thread = threading.Thread(target=work, name='price-postgres', daemon=True)
    thread.start()
    thread.join(max(0.0, timeout))
    if thread.is_alive():
        raise _Late()
    if 'error' in box:
        raise box['error']
    return box['value']


def _read_targets(ids: list[UUID], timeout_ms: int) -> dict:
    """Reviewed state per Edition from one REPEATABLE READ snapshot. It commits before returning, so no connection or
    lock is held while the record store is read."""
    with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row, connect_timeout=2) as conn:
        conn.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        with conn.transaction():
            conn.execute(f'SET LOCAL statement_timeout = {int(timeout_ms)}')
            conn.execute(f'SET LOCAL lock_timeout = {int(timeout_ms)}')
            editions = {row['id']: row for row in conn.execute(
                'SELECT id,public_ref,descriptor FROM catalog_edition WHERE id=ANY(%s)', (ids,))}
            targets = edition_targets(conn, list(editions))
    return {edition_id: (row['public_ref'], row['descriptor'], targets.get(edition_id)) for edition_id, row in editions.items()}


def _label(found) -> QuoteView | None:
    """Why an Edition has no store lookup, or None when it has one."""
    if found is None:
        return _unavailable('not_found')
    _, descriptor, target = found
    if is_unspecified(descriptor):
        return _unavailable('unspecified_variant')
    if target is None:
        return _unavailable('unverified')
    if target.state == 'quarantined':
        return _unavailable('quarantined')
    if target.state != 'verified':
        return _unavailable('unspecified_variant' if target.reason == 'unspecified_variant' else 'unverified')
    return None if target.quote_lookup else _unavailable('no_quote_variant')


def _signature(found):
    target = found[2]
    return (found[0], target.state, target.mapping_revision, target.quote_lookup)


def _failed(ids, reason: Reason) -> dict[UUID, QuoteView]:
    return {edition_id: _unavailable(reason, 'failed') for edition_id in ids}


def private_edition_quotes(edition_ids, budget: Budget) -> dict[UUID, QuoteView]:
    """Price view per Edition id, in request order, within ``budget``. Never writes and never fetches a source."""
    ids = list(dict.fromkeys(edition_ids))
    if budget.wait_remaining() <= 0:
        return _failed(ids, 'deadline')
    try:
        found = _bounded(lambda: _read_targets(ids, budget.pg_timeout_ms()), budget.wait_remaining())
    except _Late:
        return _failed(ids, 'deadline')
    except (psycopg.Error, OSError, KeyError):
        return _failed(ids, 'deadline' if budget.wait_remaining() <= 0 else 'validation_unavailable')
    views = {edition_id: _label(found.get(edition_id)) for edition_id in ids}
    lookable = [edition_id for edition_id in ids if views[edition_id] is None]
    if lookable:
        views.update(_priced(lookable, found, budget))
    if budget.expired():
        return _failed(ids, 'deadline')
    return {edition_id: views[edition_id] for edition_id in ids}


def _priced(lookable: list[UUID], found: dict, budget: Budget) -> dict[UUID, QuoteView]:
    pairs = [(found[edition_id][0], found[edition_id][2].mapping_revision) for edition_id in lookable]
    try:
        states = quote_states(public_record_store(), pairs, deadline=budget.wait_until)
    except (ProjectionUnavailable, ValueError):
        return _failed(lookable, 'deadline' if budget.wait_remaining() <= 0 else 'store_unavailable')
    if budget.wait_remaining() <= 0:
        return _failed(lookable, 'deadline')
    # Final validation inside the reserve: PostgreSQL must still say what it said when the keys were chosen.
    try:
        fresh = _bounded(lambda: _read_targets(lookable, budget.pg_timeout_ms(final=True)), budget.remaining())
    except (_Late, psycopg.Error, OSError, KeyError):
        return _failed(lookable, 'deadline' if budget.expired() else 'validation_unavailable')
    now = _now()
    result = {}
    for edition_id, pair in zip(lookable, pairs):
        current = fresh.get(edition_id)
        label = _label(current)
        if label is not None:
            result[edition_id] = label
        elif _signature(current) != _signature(found[edition_id]):
            result[edition_id] = _unavailable('not_cached')
        else:
            result[edition_id] = validate_quote(current[2].quote_lookup, states[pair], now)
    return result


# --- HTTP ------------------------------------------------------------------------------------------------------
class PriceRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    edition_ids: list[UUID] = Field(min_length=1, max_length=MAX_EDITIONS)


class PriceRow(QuoteView):
    edition_id: UUID


class PricesResponse(BaseModel):
    prices: list[PriceRow]
    withheld: bool


async def bounded_body(request: Request) -> bytes:
    """413 by byte length, ahead of JSON and schema validation."""
    declared = request.headers.get('content-length')
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(413, {'code': 'PAYLOAD_TOO_LARGE'})
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(413, {'code': 'PAYLOAD_TOO_LARGE'})
    return body


@router.post('/editions', response_model=PricesResponse)
def edition_prices(body: bytes = Depends(bounded_body), user_id: str = Depends(verified_user),
                   budget: Budget = Depends(trusted_budget)):
    # A synchronous route on purpose: the HTTP record-store adapter refuses to run on an event loop.
    if budget.caller != f'user:{user_id}':
        raise HTTPException(401, 'Authentication required')
    try:
        command = PriceRequest.model_validate_json(body)
    except ValidationError:
        raise HTTPException(422, {'code': 'INVALID_REQUEST'}) from None
    quotes = private_edition_quotes(command.edition_ids, budget)
    rows = [PriceRow(edition_id=edition_id, **view.model_dump()) for edition_id, view in quotes.items()]
    withheld = any(view.reason in ('deadline', 'validation_unavailable') for view in quotes.values())
    return JSONResponse(PricesResponse(prices=rows, withheld=withheld).model_dump(mode='json'), headers={'cache-control': 'no-store'})
