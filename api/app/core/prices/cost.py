"""The cost fold shared by every price route: Estimated Deck Cost and Pricing Coverage figures over opaque keys.

``summarize`` folds ``{key: positive int quantity}`` and ``{key: QuoteView}`` into the status, counts, exact amount and
display amount that the private Deck route, the Want List route, the Trade value route and the Published Deck route all
return, so their figures and labels match. The route modules (Pokemon) own the price reads and call it.

Arithmetic is exact: quantities are Python integers (base-10 strings on the wire) and quote amounts are integer
micro-dollars, so neither a bigint quantity nor a long sum can lose a digit. The only rounding is the final display.

Contract: docs/prices.md ("Deck cost").
"""
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.settings import WantListCounting

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
