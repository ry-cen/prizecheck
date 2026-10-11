"""One consistent capture of a private Deck's Holdings and Deck List (Deck Lists 08).

Deck cost and both private Deck exports read this capture. Like ``decks.capture_deck_contents`` it takes the owner row
lock (``owner_and_rows``) that every Holding and Deck List writer takes, so the inventory revision, the Deck List
revision, the Deck's Holdings, its lines and each line's ownership states belong to one committed state. It commits
before the caller reads prices or catalog data, so no inventory lock or connection is held while they are read.

``not_owned`` is the Deck detail's figure (``deck_ownership.read_ownership``): copies elsewhere in the Collection,
including copies another Deck holds, are never counted as needing purchase.
"""
from dataclasses import dataclass
from uuid import UUID

from .deck_ownership import read_ownership
from .location_tree import error, owner_and_rows
from .main import connect


@dataclass(frozen=True)
class CapturedLine:
    edition_id: UUID
    quantity: int     # The line's intended copies.
    not_owned: int    # Copies neither in this Deck nor elsewhere in the Collection.


@dataclass(frozen=True)
class DeckListCapture:
    holdings: dict[UUID, int]        # The Deck's own Holdings by Edition, in Edition order.
    lines: tuple[CapturedLine, ...]  # Every Deck List line, in Edition order.
    owner_revision: int
    deck_list_revision: int
    catalog_revision: int


def capture_deck_list(deck_id: UUID, user_id: str, timeout_ms: int | None = None) -> DeckListCapture:
    """Raises 404 ``DECK_NOT_FOUND`` for a missing, foreign or non-Deck Location. ``timeout_ms`` bounds every statement
    and lock wait (the budgeted Deck cost route passes what is left of its three seconds)."""
    with connect() as conn, conn.transaction():
        if timeout_ms is not None:
            conn.execute(f'SET LOCAL statement_timeout = {max(1, int(timeout_ms))}')
            conn.execute(f'SET LOCAL lock_timeout = {max(1, int(timeout_ms))}')
        revision, rows = owner_and_rows(conn, user_id)
        deck = rows.get(deck_id)
        if not deck or deck['kind'] != 'deck':
            error(404, 'DECK_NOT_FOUND')
        catalog_revision = conn.execute(
            'SELECT revision FROM catalog_state WHERE singleton FOR SHARE').fetchone()['revision']
        header = conn.execute('SELECT revision FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                              (user_id, deck_id)).fetchone()
        if header is None:
            # Migration 025 and its location trigger give every Deck a Deck List.
            raise RuntimeError('Deck has no Deck List')
        holdings = {row['edition_id']: int(row['quantity']) for row in conn.execute(
            """SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s
               ORDER BY edition_id""", (user_id, deck_id))}
        ownership = read_ownership(conn, user_id, deck_id)
        capture = DeckListCapture(
            holdings=holdings,
            lines=tuple(CapturedLine(line.edition_id, int(line.quantity), int(line.not_owned))
                        for line in ownership.lines),
            owner_revision=revision, deck_list_revision=header['revision'], catalog_revision=catalog_revision)
    # Both transaction locks and the connection are released before callers can wait.
    return capture
