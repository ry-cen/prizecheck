"""Exact-Edition prices, read from PostgreSQL only (ADR 0019).

One REPEATABLE READ query joins the reviewed Edition state, its price binding and the imported TCGCSV price row. Only the
market price is ever shown (``chosen_amount``). This module never writes PostgreSQL, never fetches a source and never
touches the record store. ``PRICE_READS=off`` (``price_reads.price_reads_enabled``) answers every row
unavailable/no_price without a query.
"""
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, localcontext
import os
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from psycopg.rows import dict_row

from app.bounded_work import Lane, Late
from .catalog_targets import is_unspecified
from app import quote_contract
from app.price_reads import price_reads_enabled
from app.identity import verified_user
from app.price_budget import MAX_BODY_BYTES, Budget, trusted_budget
from app.quote_contract import parse_amount  # noqa: F401  (moved; re-exported so `prices.parse_amount` keeps working)

router = APIRouter(prefix='/api/prices', tags=['prices'])

STALE_AFTER = timedelta(hours=48)
MAX_EDITIONS = 64

Status = Literal['quote', 'unavailable', 'failed', 'pending']
Reason = Literal['not_found', 'no_price', 'unverified', 'quarantined', 'unspecified_variant', 'no_quote_variant', 'not_cached',
                 'confirmed_absent', 'lookup_mismatch', 'invalid_quote', 'store_unavailable', 'deadline',
                 'validation_unavailable']
Refresh = Literal['background', 'refreshed', 'timeout', 'busy', 'backoff', 'failed']

_CENT = Decimal('0.01')


def _now() -> datetime:
    """Module clock for provider-age arithmetic; tests patch this."""
    return datetime.fromtimestamp(quote_contract.wall_ms() / 1000, timezone.utc)


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
    refresh: Refresh | None = None       # What the access did about refresh; never changes status/reason/amount.
    refresh_failed_at: str | None = None # When the last refresh attempt failed (refresh == 'failed'), if known.


def format_usd(amount: Decimal) -> str:
    """Display rounding, and the only place it happens: half-up to cents; positive sub-cent amounts show '<$0.01'."""
    with localcontext() as context:
        context.prec = 40
        if 0 < amount < _CENT:
            return '<$0.01'
        return f'${amount.quantize(_CENT, rounding=ROUND_HALF_UP):,.2f}'


def _text(moment: datetime) -> str:
    return moment.isoformat().replace('+00:00', 'Z')


def _unavailable(reason: Reason, status: Status = 'unavailable') -> QuoteView:
    return QuoteView(status=status, reason=reason)


# --- Reading ---------------------------------------------------------------------------------------------------
_Late = Late  # Kept for deck_cost, want_list_cost: the same class as bounded_work.Late.
POSTGRES_LANE = Lane('price-postgres', 16)  # under anyio's 40 threads and PostgreSQL's connection limit; caps stall growth


def _bounded(call, timeout: float):
    """Run blocking PostgreSQL work so the caller's own clock, not libpq's two-second connect floor, bounds the wait,
    slot wait included. At most 16 PostgreSQL reads run at once in a process; an abandoned one ends on its own
    PostgreSQL timeouts."""
    return POSTGRES_LANE.run(call, timeout)


PRICE_QUERY = """SELECT e.id, e.descriptor, m.mapping_state, m.mapping_reason, m.product_id,
       b.sub_type_name, b.reason AS bind_reason,
       p.market_price, p.low_price, p.mid_price, p.source_updated_at, p.seen_at
FROM catalog_edition e
LEFT JOIN catalog_edition_metadata m ON m.edition_id = e.id
LEFT JOIN edition_price_binding b ON b.edition_id = e.id AND b.product_id = m.product_id
                                  AND b.mapping_revision = m.mapping_revision AND m.mapping_state = 'verified'
LEFT JOIN tcgplayer_price p ON p.product_id = b.product_id AND p.sub_type_name = b.sub_type_name
WHERE e.id = ANY(%s)"""


def _read_rows(ids: list[UUID], timeout_ms: int) -> dict:
    """One REPEATABLE READ snapshot: reviewed state, binding and price per Edition. Nothing else is read."""
    with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row, connect_timeout=2) as conn:
        conn.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        with conn.transaction():
            conn.execute(f'SET LOCAL statement_timeout = {int(timeout_ms)}')
            conn.execute(f'SET LOCAL lock_timeout = {int(timeout_ms)}')
            return {row['id']: row for row in conn.execute(PRICE_QUERY, (ids,))}


def chosen_amount(row) -> Decimal | None:
    """The only place that picks the figure shown: the market price, or None when it is null or not above zero.
    There is no fallback to mid or low (owner answer 1)."""
    value = row.get('market_price')
    return value if isinstance(value, Decimal) and value.is_finite() and value > 0 else None


def _row_view(row, now: datetime) -> QuoteView:
    if row is None:
        return _unavailable('not_found')
    if is_unspecified(row['descriptor']):
        return _unavailable('unspecified_variant')
    state = row['mapping_state']
    if state == 'quarantined':
        return _unavailable('quarantined')
    if state != 'verified':
        return _unavailable('unspecified_variant' if row['mapping_reason'] == 'unspecified_variant' else 'unverified')
    amount = chosen_amount(row) if row['sub_type_name'] and not row['bind_reason'] else None
    if amount is None:
        return _unavailable('no_price')
    text = format(amount.normalize(), 'f')
    if parse_amount(text) is None:
        return _unavailable('no_price')
    provider = row['source_updated_at']
    return QuoteView(status='quote', amount=text, display_amount=format_usd(amount),
                     provider_updated_at=_text(provider.astimezone(timezone.utc)) if provider else None,
                     checked_at=_text(row['seen_at'].astimezone(timezone.utc)) if row['seen_at'] else None,
                     age='known' if provider else 'unknown',
                     stale=(now - provider) > STALE_AFTER if provider else None)


def _failed(ids, reason: Reason) -> dict[UUID, QuoteView]:
    return {edition_id: _unavailable(reason, 'failed') for edition_id in ids}


def private_edition_quotes(edition_ids, budget: Budget, releases: list | None = None) -> dict[UUID, QuoteView]:
    """Price view per Edition id, in request order, within ``budget``. Reads PostgreSQL only: it never writes, never
    fetches a source and never touches the record store. ``releases`` is accepted for the callers' signature and unused."""
    ids = list(dict.fromkeys(edition_ids))
    if not price_reads_enabled():
        return {edition_id: _unavailable('no_price') for edition_id in ids}
    if budget.wait_remaining() <= 0:
        return _failed(ids, 'deadline')
    try:
        found = _bounded(lambda: _read_rows(ids, budget.pg_timeout_ms()), budget.wait_remaining())
    except _Late:
        return _failed(ids, 'deadline')
    except (psycopg.Error, OSError, KeyError):
        return _failed(ids, 'deadline' if budget.wait_remaining() <= 0 else 'validation_unavailable')
    now = _now()
    views = {edition_id: _row_view(found.get(edition_id), now) for edition_id in ids}
    if budget.expired():
        return _failed(ids, 'deadline')
    return views


# --- Stored prices on write paths --------------------------------------------------------------------------------
STORED_READ_SECONDS = 1.0  # Whole wait for a stored-price read on a write path.


def stored_edition_quotes(edition_ids, wait_seconds: float = STORED_READ_SECONDS) -> dict[UUID, QuoteView] | None:
    """What PostgreSQL holds now for each Edition, for write paths that choose by price but display none. The same rows and
    labels as ``private_edition_quotes``. Returns None when PostgreSQL could not answer inside ``wait_seconds``: the caller
    cannot tell "unpriced" from "unread" then."""
    ids = list(dict.fromkeys(edition_ids))
    if not ids:
        return {}
    if not price_reads_enabled():
        return {edition_id: _unavailable('no_price') for edition_id in ids}
    try:
        found = _bounded(lambda: _read_rows(ids, max(1, int(wait_seconds * 1000))), wait_seconds)
    except (_Late, psycopg.Error, OSError, KeyError):
        return None
    now = _now()
    return {edition_id: _row_view(found.get(edition_id), now) for edition_id in ids}


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
    return JSONResponse(PricesResponse(prices=rows, withheld=withheld).model_dump(mode='json'),
                        headers={'cache-control': 'no-store'})



def _release_all(releases: list) -> None:
    """Run the callbacks a caller collected. Reads no longer take an interactive permit, so the list stays empty; the Deck,
    Want List and Trade routes still pass one until their signatures are tidied (P9)."""
    for release in releases:
        release()
