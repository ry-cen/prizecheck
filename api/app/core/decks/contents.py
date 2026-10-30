from uuid import UUID
from pydantic import BaseModel
from app.inventory_core import quantity as parse_quantity
from app.db import connect
from app.location_tree import owner_and_rows, error
from app.borrowed_copies import physical, borrowed_at


class DeckEditionQuantity(BaseModel):
    edition_id: UUID
    quantity: str


class DeckContents(BaseModel):
    editions: list[DeckEditionQuantity]
    owner_revision: int
    catalog_revision: int


def change_quantity(raw: str) -> int:
    """A batch change's new line total: 0 removes the line; anything else is an ordinary quantity (``parse_quantity``)."""
    if raw and raw.isascii() and raw.isdecimal() and len(raw) <= 19 and int(raw) == 0:
        return 0
    return parse_quantity(raw)


def capture_deck_contents(deck_id: UUID, user_id: str, timeout_ms: int | None = None) -> DeckContents:
    """Detach a complete inventory capture before any pricing/export source work.

    Inventory writers serialize on the owner row, so the revision and every
    Edition quantity belong to the same committed inventory state. Catalog
    activation is fenced separately for the captured catalog revision.
    ``timeout_ms`` bounds every statement and lock wait (the budgeted Deck cost
    route passes what is left of its three seconds).
    """
    with connect() as conn, conn.transaction():
        if timeout_ms is not None:
            conn.execute(f'SET LOCAL statement_timeout = {max(1, int(timeout_ms))}')
            conn.execute(f'SET LOCAL lock_timeout = {max(1, int(timeout_ms))}')
        revision, rows = owner_and_rows(conn, user_id)
        deck = rows.get(deck_id)
        if not deck or deck['kind'] != 'deck':
            error(404, 'DECK_NOT_FOUND')
        catalog_revision = conn.execute(
            'SELECT revision FROM catalog_state WHERE singleton FOR SHARE'
        ).fetchone()['revision']
        holdings = {row['edition_id']: row['quantity'] for row in conn.execute(
            'SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s', (user_id, deck_id))}
        # The Deck's physical contents: its Holdings and its Borrowed Copies (#254), in Edition order.
        contents = DeckContents(
            editions=[DeckEditionQuantity(edition_id=edition, quantity=str(quantity))
                      for edition, quantity in physical(holdings, borrowed_at(conn, user_id, deck_id)).items()],
            owner_revision=revision, catalog_revision=catalog_revision)
    # Both transaction locks and the connection are released before callers can wait.
    return contents
