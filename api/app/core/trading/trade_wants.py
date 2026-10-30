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
from app.card_accepts import WillAcceptRule
from app.location_tree import error


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

