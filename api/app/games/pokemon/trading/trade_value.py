"""Each side's estimated total for a Trade Proposal being built or reviewed (Trading #277, spec "Value cues").

``POST /api/trades/value`` is a budgeted price access under ADR 0006, like the Deck and Want List cost routes: the
gateway signs a three-second budget for it and the route reads prices through ``prices.private_edition_quotes`` without
writing to PostgreSQL. The distinct Editions of both sides go through one quote read, and each side is folded with
``core.prices.cost.summarize``, so its figures and labels match Deck cost. It is a POST so an unsent proposal can be valued.

Cash is not part of it and nothing suggests a cash amount. Nothing is stored. The answer names no price source, check
time, refresh state or reason. The body is bounded by the gateway's 16 KiB budgeted-body limit (about 9 KB at 100
lines).
"""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.background import BackgroundTask

from app.games.pokemon.prices import prices
from app.core.prices.cost import CostStatus, summarize
from app.location_tree import error
from app.identity import verified_user
from app.price_budget import Budget, trusted_budget
from app.trade_inventory import trade_quantity

router = APIRouter(prefix='/api/trades', tags=['trades'])

# Lines in all, both sides together, one request may value.
MAX_VALUE_LINES = 100


class TradeValueLine(BaseModel):
    model_config = ConfigDict(extra='forbid')
    side: Literal['you_give', 'you_get']
    edition_id: UUID
    quantity: str                    # "1".."9999", else 422 INVALID_QUANTITY


class TradeValueRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    lines: list[TradeValueLine]      # no max_length: counted in code (TOO_MANY_LINES)


class SideValue(BaseModel):
    """One side's estimated total. ``display_total``: the rounded total for 'priced' and 'empty' ("$0.00"), else None.
    ``priced_copies``: None only for 'incomplete'. Partial coverage is 'priced' with fewer priced copies."""
    status: CostStatus
    display_total: str | None
    priced_copies: str | None
    total_copies: str


class TradeValue(BaseModel):
    you_give: SideValue
    you_get: SideValue


@router.post('/value', response_model=TradeValue)
def trade_value(command: TradeValueRequest, user_id: str = Depends(verified_user),
                budget: Budget = Depends(trusted_budget)):
    # A synchronous route on purpose: the HTTP record-store adapter refuses to run on an event loop. A missing budget is
    # 401 before the body is validated; the body model keeps the request types in OpenAPI for the generated client.
    if budget.caller != f'user:{user_id}':
        raise HTTPException(401, 'Authentication required')
    quantities: dict[str, dict[UUID, int]] = {'you_give': {}, 'you_get': {}}
    counted = [(line, trade_quantity(line.quantity)) for line in command.lines]
    for line, copies in counted:
        if line.edition_id in quantities[line.side]:
            error(422, 'DUPLICATE_EDITION')
        quantities[line.side][line.edition_id] = copies
    if len(command.lines) > MAX_VALUE_LINES:
        error(422, 'TOO_MANY_LINES')
    editions = list(dict.fromkeys(line.edition_id for line in command.lines))
    releases: list = []
    try:
        views = prices.private_edition_quotes(editions, budget, releases) if editions else {}
        sides = {}
        for side, side_quantities in quantities.items():
            figures = summarize(side_quantities, {key: views[key] for key in side_quantities})
            sides[side] = SideValue(status=figures['status'], display_total=figures.get('display_amount'),
                                    priced_copies=figures.get('priced_copies'), total_copies=figures['total_copies'])
    except BaseException:
        prices._release_all(releases)
        raise
    return JSONResponse(TradeValue(**sides).model_dump(mode='json'), headers={'cache-control': 'no-store'},
                        background=BackgroundTask(prices._release_all, releases))
