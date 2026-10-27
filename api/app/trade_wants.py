"""A collector's own Trade Wants and Will accept choices (Trading #275; spec "Schema changes", resolution "Data model"
points 2 and 3), under ``/api/trade-wants``.

- **Trade Wants** (``trade_want``, migration 143) are a short hand-edited list of exact Card Editions the collector wants
  in trades, usually cards no Deck names, with a quantity each (1 to 9999, at most ``MAX_TRADE_WANTS`` lines). A line
  never widens: it is always matched as this exact card, and ``trade_accept`` is never read for it. It adds to a Deck's
  need for the same Edition in trading only (discovery, Trading #276, and Confirm swap): the Want List's own counts,
  totals, exports and pins never read it.
- **Will accept** (``trade_accept``) is one choice per Card Edition, wherever it appears on the Want List: this exact
  card (no row, the default), any finish (``printing``) or any card with the same name (``identity``),
  expanded by ``card_accepts.accepts``. Rows outlive the card leaving the Want List and apply again when it returns;
  nothing cleans them up. It changes the Swap hint's suggestions (``swap_hints``), and from Trading #276 matching and
  from #279 the Deck switches Confirm swap offers, never a Want List figure.

Both setters are idempotent by value, so they take no idempotency key, and both answer the whole ``TradeWants``. They
take the shared owner lock (``social.owners.lock_owners``), so the line cap is counted one setter at a time and a setter
waits for a Confirm swap of the same collector, which lowers Trade Wants (``lower_trade_wants``) under the same lock.
Both tables cascade with the owner row, so an account's choices go with it.

These are own reads and writes outside the social area: the contract guard lets no social module but the choke point
(``social.friend_copies``) read either table.
"""
from collections.abc import Iterable, Mapping
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .card_accepts import WillAcceptRule
from .deck_list_display import read_line_display
from .location_tree import error
from .db import connect
from .identity import verified_user
from .social.owners import ensure_owner, lock_owners
from .want_list import DISPLAY_FIELDS, number_order

router = APIRouter(prefix='/api/trade-wants', tags=['trade-wants'])

# Lines one collector's Trade Wants may hold (resolution "Data model" point 2).
MAX_TRADE_WANTS = 500
# Copies one Trade Wants line may name (migration 143's CHECK).
MAX_TRADE_WANT_COPIES = 9999

# Whether an Edition may start a new line: active in the active catalog generation, of a Printing that isn't withdrawn
# (holdings.add_holding's and decks' rule, 422 EDITION_UNAVAILABLE).
AVAILABLE = """SELECT 1 FROM catalog_state s
  JOIN catalog_generation_edition ge ON ge.generation_id=s.active_generation AND ge.edition_id=%s AND ge.active
  JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
  WHERE s.singleton AND NOT gp.tombstoned"""


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


def want_quantity(raw: str) -> int:
    """A Trade Wants quantity: a whole number from 0 to ``MAX_TRADE_WANT_COPIES`` in ASCII digits, else 422
    INVALID_QUANTITY."""
    if not raw or not raw.isascii() or not raw.isdecimal() or len(raw) > 19 or int(raw) > MAX_TRADE_WANT_COPIES:
        error(422, 'INVALID_QUANTITY')
    return int(raw)


def own_wants(conn, user_id: str) -> dict[UUID, int]:
    """The collector's Trade Wants, copies by Card Edition, for the social matches module (Trading #276). Always exact:
    no Will accept choice applies to them."""
    return {row['edition_id']: int(row['quantity']) for row in conn.execute(
        'SELECT edition_id, quantity FROM trade_want WHERE owner_id = %s', (user_id,))}


def own_rules(conn, user_id: str) -> dict[UUID, WillAcceptRule]:
    """The collector's widened Will accept choices, rule by Card Edition, for the social matches module (Trading #276).
    An Edition with no row is absent: it accepts this exact card. They widen only what the Want List needs, never a
    Trade Wants line."""
    return {row['edition_id']: row['rule'] for row in conn.execute(
        'SELECT edition_id, rule FROM trade_accept WHERE owner_id = %s', (user_id,))}


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


def lower_trade_wants(conn, user_id: str, received: Iterable[tuple[UUID, int]], needs: Mapping[UUID, int]) -> None:
    """Confirm swap's last inventory-side step (spec "Confirm swap" step 5): for each received Card Edition, the copies
    left after the Decks' needs for that exact Edition (``needs``, read before any write, ``want_list.edition_needs``)
    lower its Trade Wants line, which goes when they cover it and is never set to 0. Copies of one Edition never lower
    another Edition's line, whatever Will accept says. The caller holds the confirmer's shared owner lock."""
    for edition, copies in received:
        left = max(0, copies - needs.get(edition, 0))
        if left == 0:
            continue
        conn.execute('DELETE FROM trade_want WHERE owner_id = %s AND edition_id = %s AND quantity <= %s',
                     (user_id, edition, left))
        conn.execute('UPDATE trade_want SET quantity = quantity - %s WHERE owner_id = %s AND edition_id = %s',
                     (left, user_id, edition))


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
