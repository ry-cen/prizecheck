from uuid import UUID
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from app.card_accepts import WillAcceptRule
from app.games.pokemon.decks.line_display import read_line_display
from app.core.catalog.card_facts import number_order
from app.want_list import DISPLAY_FIELDS
from app.social.owners import ensure_owner, lock_owners
from app.location_tree import error
from app.db import connect
from app.identity import verified_user
from app.core.trading.trade_wants import AVAILABLE, MAX_TRADE_WANTS, own_wants, want_quantity

router = APIRouter(prefix='/api/trade-wants', tags=['trade-wants'])


class TradeWantLine(BaseModel):
    """One Trade Wants line: an exact Card Edition and the copies wanted, with the display data a Want List line
    carries."""
    edition_id: UUID
    name: str
    set_id: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    quantity: str           # "1" to "9999"


class WillAcceptChoice(BaseModel):
    """A widened Will accept choice; an Edition with none is this exact card."""
    edition_id: UUID
    rule: WillAcceptRule    # 'printing' or 'identity'; 'edition' is never stored.


class TradeWants(BaseModel):
    lines: list[TradeWantLine]          # Card order: name, set, collector number, then the Edition id.
    will_accept: list[WillAcceptChoice]  # Every widened choice, by Edition id.


class SetTradeWant(BaseModel):
    quantity: str           # "0" removes the line; "1" to "9999" sets it.


class SetWillAccept(BaseModel):
    rule: WillAcceptRule    # 'edition' removes the choice.


def read_trade_wants(conn, user_id: str) -> TradeWants:
    wanted = own_wants(conn, user_id)
    display = read_line_display(conn, wanted)

    def card_order(edition: UUID):
        fields = display[edition]
        return fields['name'].casefold(), fields['set_name'], number_order(fields['collector_number']), edition

    choices = conn.execute('SELECT edition_id, rule FROM trade_accept WHERE owner_id = %s ORDER BY edition_id',
                           (user_id,)).fetchall()
    return TradeWants(
        lines=[TradeWantLine(edition_id=edition, **{key: display[edition][key] for key in DISPLAY_FIELDS},
                             quantity=str(wanted[edition])) for edition in sorted(wanted, key=card_order)],
        will_accept=[WillAcceptChoice(edition_id=row['edition_id'], rule=row['rule']) for row in choices])


@router.get('', response_model=TradeWants)
def get_trade_wants(user_id: str = Depends(verified_user)):
    """The collector's own Trade Wants and Will accept choices. One snapshot, no lock, no write."""
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        return read_trade_wants(conn, user_id)


@router.put('/{edition_id}', response_model=TradeWants)
def set_trade_want(edition_id: UUID, command: SetTradeWant, user_id: str = Depends(verified_user)):
    """Sets one Trade Wants line to ``quantity`` copies, or removes it with "0" (removing a line that isn't there
    changes nothing). Refused, with nothing changed: 422 INVALID_QUANTITY (not a whole number from 0 to 9999), then for
    a new line 422 EDITION_UNAVAILABLE (an Edition that doesn't exist or may not start a line now) and 422
    TOO_MANY_LINES (the collector already has 500 lines). An existing line can always be changed or removed."""
    copies = want_quantity(command.quantity)
    with connect() as conn, conn.transaction():
        ensure_owner(conn, user_id)
        lock_owners(conn, user_id)
        if copies == 0:
            conn.execute('DELETE FROM trade_want WHERE owner_id = %s AND edition_id = %s', (user_id, edition_id))
        elif conn.execute('UPDATE trade_want SET quantity = %s WHERE owner_id = %s AND edition_id = %s',
                          (copies, user_id, edition_id)).rowcount == 0:
            if conn.execute(AVAILABLE, (edition_id,)).fetchone() is None:
                error(422, 'EDITION_UNAVAILABLE')
            if conn.execute('SELECT count(*) AS n FROM trade_want WHERE owner_id = %s',
                            (user_id,)).fetchone()['n'] >= MAX_TRADE_WANTS:
                error(422, 'TOO_MANY_LINES')
            conn.execute('INSERT INTO trade_want(owner_id, edition_id, quantity) VALUES (%s, %s, %s)',
                         (user_id, edition_id, copies))
        return read_trade_wants(conn, user_id)


@router.put('/will-accept/{edition_id}', response_model=TradeWants)
def set_will_accept(edition_id: UUID, command: SetWillAccept, user_id: str = Depends(verified_user)):
    """Sets the collector's Will accept choice for one Card Edition, wherever it appears on their Want List, whether or
    not it is there now; 'edition' (this exact card) removes the choice. A widened choice for an Edition the catalog
    doesn't have is 422 EDITION_UNAVAILABLE. Nothing else changes: no revision moves, and no Want List figure."""
    with connect() as conn, conn.transaction():
        ensure_owner(conn, user_id)
        lock_owners(conn, user_id)
        if command.rule == 'edition':
            conn.execute('DELETE FROM trade_accept WHERE owner_id = %s AND edition_id = %s', (user_id, edition_id))
        else:
            if conn.execute('SELECT 1 FROM catalog_edition WHERE id = %s', (edition_id,)).fetchone() is None:
                error(422, 'EDITION_UNAVAILABLE')
            conn.execute("""INSERT INTO trade_accept(owner_id, edition_id, rule) VALUES (%s, %s, %s)
              ON CONFLICT (owner_id, edition_id) DO UPDATE SET rule = excluded.rule""",
                         (user_id, edition_id, command.rule))
        return read_trade_wants(conn, user_id)
