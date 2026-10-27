"""One consistent capture of a private Deck's Holdings and Deck List (Deck Lists 08).

Deck cost and both private Deck exports read this capture. Like ``decks.capture_deck_contents`` it takes the owner row
lock (``owner_and_rows``) that every Holding and Deck List writer takes, so the inventory revision, the Deck List
revision, the Deck's Holdings, its lines and each line's ownership states belong to one committed state. It commits
before the caller reads prices or catalog data, so no inventory lock or connection is held while they are read.

Each line's ``need`` follows the account's Want List counting setting (decklist import #208): the setting is read
in the same transaction, under the same lock, and ``copy_allocation.deck_lines`` counts the line's owned copies with
it. Under One Deck at a time the need is the Deck detail's ``not_owned`` (``deck_ownership.read_ownership``); under
Every Deck built at once (the default) copies another Deck holds for its own line, and Spare Copies an older Deck
counts, are needed too. The capture names the setting and the settings revision it used, because changing the setting
moves neither the inventory revision nor the Deck List revision.
"""
from dataclasses import dataclass
from uuid import UUID

from .borrowed_copies import borrowed_at, physical
from .copy_allocation import deck_lines
from .location_tree import error, owner_and_rows
from .db import connect
from .settings import WantListCounting, read_settings


@dataclass(frozen=True)
class CapturedLine:
    edition_id: UUID
    quantity: int     # The line's intended copies.
    need: int         # Copies still needed from outside the Collection, under the counting setting (copy_allocation).


@dataclass(frozen=True)
class DeckListCapture:
    holdings: dict[UUID, int]        # The Deck's physical copies by Edition (Holdings and Borrowed Copies), in order.
    lines: tuple[CapturedLine, ...]  # Every Deck List line, in Edition order.
    owner_revision: int
    deck_list_revision: int
    catalog_revision: int
    want_list_counting: WantListCounting  # The counting setting ``need`` follows.
    settings_revision: int                # The settings revision it was read at.


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
            # Migration 029 and its location trigger give every Deck a Deck List.
            raise RuntimeError('Deck has no Deck List')
        # The Deck's physical copies: its Holdings and its Borrowed Copies, which count toward its cost (#254).
        holdings = physical({row['edition_id']: int(row['quantity']) for row in conn.execute(
            'SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s', (user_id, deck_id))},
            borrowed_at(conn, user_id, deck_id))
        settings = read_settings(conn, user_id)
        counted = deck_lines(conn, user_id, deck_id, settings.want_list_counting)
        capture = DeckListCapture(
            holdings=holdings,
            lines=tuple(CapturedLine(line.edition_id, line.quantity, line.need) for line in counted.values()),
            owner_revision=revision, deck_list_revision=header['revision'], catalog_revision=catalog_revision,
            want_list_counting=settings.want_list_counting, settings_revision=settings.revision)
    # Both transaction locks and the connection are released before callers can wait.
    return capture
