"""Which Card Edition a Deck List line names when a card is added by its Printing alone (ticket 06).

The pick is pure: the cheapest stored quote among the Printing's Editions, catalog order breaking ties, else the first
Edition in catalog order. The price reads and the catalog SQL belong to the game.
"""
from decimal import Decimal
from typing import Literal
from uuid import UUID

ChosenBy = Literal['cheapest_price', 'catalog_order']


def choose_edition(editions: list[UUID], views: dict, *, parse_amount) -> tuple[UUID, ChosenBy]:
    """The cheapest stored quote among ``editions`` (catalog order breaks ties), else the first in catalog order.

    ``views`` maps Edition id to ``prices.QuoteView``; an Edition without a view, or whose view is not a quote, is
    unpriced. ``parse_amount`` is the strict amount grammar (``quote_contract.parse_amount``), passed in so core imports
    no root module. Pure."""
    cheapest: tuple[Decimal, UUID] | None = None
    for edition_id in editions:
        view = views.get(edition_id)
        if view is None or view.status != 'quote':
            continue
        amount = parse_amount(view.amount)
        if amount is None:
            continue
        if cheapest is None or amount < cheapest[0]:
            cheapest = (amount, edition_id)
    if cheapest is not None:
        return cheapest[1], 'cheapest_price'
    return editions[0], 'catalog_order'
