"""Add a card to a Deck List by its Card Printing alone (ticket 06).

The command picks one Card Edition of the Printing, once, and stores an ordinary Deck List line naming it:

- the Edition with the lowest stored price, read from the price cache as it is now (``prices.stored_edition_quotes``);
- otherwise, when no Edition has a stored price, the first Edition in catalog order (``descriptor_key, id``, the order the
  catalog search shows). A Printing whose only Edition is the Unspecified Variant gets that Edition this way.

Equal prices go to the Edition earlier in catalog order. The response says which rule chose (``chosen_by``); the line
does not record it, and a later price change never touches the line. The stored idempotent response keeps the rule so a
retry replays the same answer.

Adding a card is not a price access (ADR 0006): the read never admits a refresh, waits for a runner or writes anything to
the record store. No connection or lock is held while the store is read.
"""
from decimal import Decimal
import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from . import prices
from .decks import DeckListCommandResult, check_revision, line_exists, read_deck_list, require_deck
from .holdings import parse_quantity
from .location_tree import error, owner_and_rows, replay
from .main import connect, verified_user
from .quote_contract import parse_amount

router = APIRouter(prefix='/api/decks', tags=['decks'])

ChosenBy = Literal['cheapest_price', 'catalog_order']

# Editions a new line may name: active in the active catalog generation, of a Printing that is not tombstoned, in the
# catalog order the search route shows (catalog_search._views).
AVAILABLE_EDITIONS = """SELECT ge.edition_id FROM catalog_state s
  JOIN catalog_generation_edition ge ON ge.generation_id=s.active_generation
  JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
  JOIN catalog_edition e ON e.id=ge.edition_id
  WHERE s.singleton AND ge.printing_id=%s AND ge.active AND NOT gp.tombstoned
  ORDER BY e.descriptor_key,e.id"""


class AddDeckListPrinting(BaseModel):
    printing_id: UUID
    quantity: str
    revision: int = Field(ge=1)
    idempotency_key: UUID


class DeckListPrintingResult(DeckListCommandResult):
    edition_id: UUID      # The Edition the new line names.
    chosen_by: ChosenBy   # Which rule chose it; reported here only, never stored on the line.


def choose_edition(editions: list[UUID], views: dict) -> tuple[UUID, ChosenBy]:
    """The cheapest stored quote among ``editions`` (catalog order breaks ties), else the first in catalog order.

    ``views`` maps Edition id to ``prices.QuoteView``; an Edition without a view, or whose view is not a quote, is
    unpriced. Pure."""
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


def available_editions(conn, printing_id: UUID) -> list[UUID]:
    return [row['edition_id'] for row in conn.execute(AVAILABLE_EDITIONS, (printing_id,)).fetchall()]


@router.post('/{deck_id}/deck-list/printings', response_model=DeckListPrintingResult)
def add_deck_list_printing(deck_id: UUID, command: AddDeckListPrinting, user_id: str = Depends(verified_user)):
    # A synchronous route on purpose: the HTTP record-store adapter refuses to run on an event loop.
    quantity = parse_quantity(command.quantity)
    # The chosen Edition is not part of the request: it depends on prices, and a retry must replay, not re-choose.
    payload = {'action': 'add_deck_list_printing', 'deck_id': str(deck_id), 'printing_id': str(command.printing_id),
               'quantity': str(quantity), 'revision': command.revision}
    # 1. Without the owner lock: a retry replays at once, and the Printing's Editions are read for the price lookup.
    with connect() as conn, conn.transaction():
        _, previous = replay(conn, user_id, command.idempotency_key, payload)
        if previous:
            return previous
        candidates = available_editions(conn, command.printing_id)
    # 2. Stored quotes only, with no connection or lock held. None means the cache could not be read in time.
    views = prices.stored_edition_quotes(candidates) if candidates else {}
    # 3. The write, checked like every other Deck List command.
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, payload)
        if previous:
            return previous
        require_deck(rows, deck_id)
        check_revision(conn, user_id, deck_id, command.revision)
        # Re-read under the lock: an Edition withdrawn since step 1 is never chosen; one added since is unpriced.
        conn.execute('SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE')
        editions = available_editions(conn, command.printing_id)
        if not editions:
            error(422, 'PRINTING_UNAVAILABLE')
        if views is None:
            error(503, 'PRICES_UNAVAILABLE')
        edition_id, chosen_by = choose_edition(editions, views)
        if line_exists(conn, user_id, deck_id, edition_id):
            error(409, 'DECK_LIST_LINE_EXISTS')
        conn.execute('INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity) VALUES (%s,%s,%s,%s)',
                     (user_id, deck_id, edition_id, quantity))
        return store_printing_result(conn, user_id, deck_id, command.idempotency_key, digest, edition_id, chosen_by)


def store_printing_result(conn, user_id: str, deck_id: UUID, key: UUID, digest: str, edition_id: UUID,
                          chosen_by: ChosenBy) -> dict:
    """``decks.store_deck_list_result`` plus the chosen Edition and rule. Keep the two in step: a field added to every
    Deck List command response there belongs here too."""
    conn.execute('UPDATE deck_list SET revision=revision+1 WHERE owner_id=%s AND deck_id=%s', (user_id, deck_id))
    result = DeckListPrintingResult(deck_id=deck_id, deck_list=read_deck_list(conn, user_id, deck_id),
                                    edition_id=edition_id, chosen_by=chosen_by).model_dump(mode='json')
    conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                 (user_id, key, digest, json.dumps(result)))
    return result
