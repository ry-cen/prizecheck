"""The one shared allocation of owned copies to Deck List lines (decklist import #208; spec "Allocation and Edition
choice" and "The Want List").

``allocate`` answers, for every Deck List line naming one of the given Card Editions, how many copies the line counts
as owned under the account's Want List counting setting, and so how many it still needs from outside the Collection.
``deck_lines`` applies it to one Deck. Every figure that follows the setting reads it: the Deck detail's ``to_get``, the
cost to complete (and through it each Decks index row) and Buy missing (the Mass Entry ``not_owned`` scope). Gather
does not: the Pick List and the Deck detail's ownership split stay ``deck_ownership.read_ownership``.

Counting is per Card Edition: a Deck List line names one Edition and a Holding holds one, so no copy is shared between
Editions. For one Edition:

- a Deck's **own** copies are the copies it holds, up to its line's quantity;
- the **Spare Copies** are every other copy: loose copies outside every Deck, plus every Deck's copies beyond its own
  line (all of a Deck's copies when it has no line for the Edition);
- **Every Deck built at once** (``all_at_once``): each Deck counts its own copies, then the Spare Copies go to the Decks
  still short, oldest first (``location.created_at``, the Deck id breaking ties), each Spare Copy counted once. Copies
  another Deck holds for its own line never count for a different Deck.
- **One Deck at a time** (``one_at_a_time``): each Deck counts its own copies, then every copy outside it: Spare Copies
  first, then the copies other Decks hold for their own lines. A line's need is then exactly
  ``read_ownership``'s ``not_owned``, the deck builder's figure before #208.

The caller holds the owner row lock (``location_tree.owner_and_rows``), which every Holding, Deck List and settings
writer takes, and passes the setting it read under that lock (``settings.read_settings``), so the setting, the Holdings
and the Deck Lists belong to one committed state. Nothing here is stored or cached: the setting moves neither the
inventory revision nor any Deck List revision, so a figure that depends on it is never reused on those revisions alone.

The reads are three range reads paired in memory, never a join (see ``deck_ownership.read_ownership``): the owner's
Holdings of the given Editions (``holding_owner_edition_location``), the owner's Deck List lines naming them, and the
creation times of the Decks those lines belong to. The work grows with the given Editions' Holdings and the owner's Deck
List lines, never with the rest of the Collection.

Later tickets extend this module additively, keeping ``allocate``'s signature and these counts: the Want List (#209)
passes every Edition its Decks list and reads ``lines`` in ``order``; the Swap hint (#211) and the import's owned copies
(#214) add the copies of an Edition available to one Deck, or to a new Deck counted as the newest, from the same
per-Edition counts. Where the counted copies are (which Location's spare copies a Deck counts) is still to be decided;
``allocate`` already reads the per-Location Holdings it would need.
"""
from collections.abc import Iterable
from dataclasses import dataclass
from uuid import UUID

from .settings import WantListCounting


@dataclass(frozen=True)
class LineCount:
    """One Deck List line's copies under the counting setting: ``held + spare + other_decks + need == quantity``."""
    deck_id: UUID
    edition_id: UUID
    quantity: int     # The line's intended copies.
    held: int         # The Deck's own copies: the lesser of the line and the Deck's Holding of the Edition.
    spare: int        # Spare Copies counted for the line.
    other_decks: int  # Copies other Decks hold for their own lines, counted for this one (One Deck at a time only).

    @property
    def need(self) -> int:
        """Copies the line still needs from outside the Collection."""
        return self.quantity - self.held - self.spare - self.other_decks


@dataclass(frozen=True)
class Allocation:
    counting: WantListCounting
    # Every Deck List line naming one of the given Editions, by (Deck id, Edition id).
    lines: dict[tuple[UUID, UUID], LineCount]
    # The Decks those lines belong to, oldest first: the order Spare Copies go in under Every Deck built at once.
    order: tuple[UUID, ...]

    def line(self, deck_id: UUID, edition_id: UUID) -> LineCount:
        return self.lines[(deck_id, edition_id)]


def allocate(conn, user_id: str, editions: Iterable[UUID], counting: WantListCounting) -> Allocation:
    """Count every Deck List line of the owner that names one of ``editions``. The caller holds the owner row lock."""
    wanted = sorted(set(editions))
    if not wanted:
        return Allocation(counting=counting, lines={}, order=())
    total: dict[UUID, int] = {}
    held: dict[tuple[UUID, UUID], int] = {}
    for row in conn.execute('SELECT location_id,edition_id,quantity FROM holding WHERE owner_id=%s AND edition_id=ANY(%s)',
                            (user_id, wanted)):
        total[row['edition_id']] = total.get(row['edition_id'], 0) + row['quantity']
        held[(row['location_id'], row['edition_id'])] = row['quantity']
    listed = conn.execute('SELECT deck_id,edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND edition_id=ANY(%s)',
                          (user_id, wanted)).fetchall()
    decks = sorted({row['deck_id'] for row in listed})
    created = {row['id']: row['created_at'] for row in conn.execute(
        'SELECT id,created_at FROM location WHERE owner_id=%s AND id=ANY(%s)', (user_id, decks))} if decks else {}
    # The one place Decks are ordered: oldest first, the Deck id breaking ties (Python orders UUIDs as PostgreSQL does).
    order = tuple(sorted(created, key=lambda deck: (created[deck], deck)))
    rank = {deck: index for index, deck in enumerate(order)}
    by_edition: dict[UUID, list[dict]] = {}
    for row in listed:
        by_edition.setdefault(row['edition_id'], []).append(row)
    lines: dict[tuple[UUID, UUID], LineCount] = {}
    for edition, rows in by_edition.items():
        rows.sort(key=lambda row: rank[row['deck_id']])
        own = {row['deck_id']: min(row['quantity'], held.get((row['deck_id'], edition), 0)) for row in rows}
        claimed = sum(own.values())
        spare_copies = total.get(edition, 0) - claimed
        left = spare_copies
        for row in rows:
            deck, quantity = row['deck_id'], row['quantity']
            short = quantity - own[deck]
            if counting == 'all_at_once':
                spare, others = min(short, left), 0
                left -= spare
            else:
                # A short Deck holds nothing beyond its line, so every Spare Copy is outside it, and so are the copies
                # the other Decks hold for their own lines.
                spare = min(short, spare_copies)
                others = min(short - spare, claimed - own[deck])
            lines[(deck, edition)] = LineCount(deck_id=deck, edition_id=edition, quantity=quantity, held=own[deck],
                                               spare=spare, other_decks=others)
    return Allocation(counting=counting, lines=lines, order=order)


def deck_lines(conn, user_id: str, deck_id: UUID, counting: WantListCounting) -> dict[UUID, LineCount]:
    """Every Deck List line of one Deck, by Edition in Edition order. Only the lines the Deck is short of are allocated:
    a line the Deck's own copies cover needs nothing whatever the setting. The caller holds the owner row lock."""
    held = {row['edition_id']: row['quantity'] for row in conn.execute(
        'SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s', (user_id, deck_id))}
    rows = conn.execute('SELECT edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND deck_id=%s '
                        'ORDER BY edition_id', (user_id, deck_id)).fetchall()
    short = [row['edition_id'] for row in rows if row['quantity'] > held.get(row['edition_id'], 0)]
    allocation = allocate(conn, user_id, short, counting)
    return {row['edition_id']: allocation.lines.get(
        (deck_id, row['edition_id']),
        LineCount(deck_id=deck_id, edition_id=row['edition_id'], quantity=row['quantity'], held=row['quantity'],
                  spare=0, other_decks=0)) for row in rows}
