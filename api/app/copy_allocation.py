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

**The Spare Copy rule** is ``spare_rule``, the one place it is written (social network #245, spec "The Spare Copy rule
moves into one function"). ``allocate``, ``available_to``, ``deck_ownership`` (Surplus and the competition warning),
``swap_hints`` and ``deck_pick_list`` all read it, and every "copies in the Deck" figure (the Deck detail, its Deck List
lines and the Decks index) reads its ``held_for_line``. It takes the copies reserved for open Loans
(``social.counts.reserved_counts``), which come out of the Spare Copies first and then out of copies a Deck holds for
its own line; those stay in the Deck and keep counting for it until handover. Nothing is reserved until Loans land, so
every figure is what it was.

The Want List (#209, ``want_list``) passes every Edition the owner's Decks list and reads each line with where its
counted copies are: ``spare`` is a count only ("1 spare"), and under One Deck at a time ``from_decks`` names the other
Decks whose own copies the line counts ("1 in Gardevoir ex"). ``Allocation.owned`` is every copy of an Edition, for
"Your 4 are counted for other Decks". Its sections come in ``deck_order``, the order Spare Copies go in.

``available_to`` (the import's owned copies, #214; Replace's step 1, #215; the Swap hint, #211) answers which copies of
each given Edition the counting setting makes available to one Deck, or to a new Deck counted as the newest, and where
they are. It runs ``allocate`` and hands Spare Copies out with the same rule (``_hand_out``):

- **Every Deck built at once:** the asking Deck's own copies, then the Spare Copies left after the Decks older than it
  have counted theirs. A new Deck is the newest, so it gets the Spare Copies no Deck counts. For Replace, the asking
  Deck's copies (all of them, not only those its current line covers) come out of the pool before the walk, and its
  current lines take no part in it: the new list replaces them.
- **One Deck at a time:** the asking Deck's own copies, then every copy outside it: Spare Copies first, then the copies
  other Decks hold for their own lines, oldest Deck first.

Which Spare Copies are the available ones is a choice the counts don't make; ``available_to`` makes it once: the asking
Deck uses loose copies first (Locations that aren't Decks, by name, then id), then other Decks' copies beyond their own
lines (by Deck name, then id). The older Decks' counted Spare Copies are the rest. The Want List shows a Spare Copy as a
count only, so it never contradicts these places.
"""
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID

from .settings import WantListCounting
from .social import counts


@dataclass(frozen=True)
class EditionCopies:
    """One owner's copies of one Card Edition under the Spare Copy rule (``spare_rule``)."""
    total: int                # Every copy the owner holds, wherever it is.
    # Deck id -> copies that Deck holds for its own Deck List line: the lesser of the line and the Deck's Holding.
    own: dict[UUID, int]
    # Location id -> copies held there beyond that Location's own line: every copy in a Location that isn't a Deck or
    # is a Deck without a line for the Edition. Locations with none are absent.
    beyond: dict[UUID, int]
    reserved: int = 0         # Copies promised to open Loans and not yet handed over (``counts.reserved_counts``).

    @property
    def claimed(self) -> int:
        """Copies the Decks hold for their own lines."""
        return sum(self.own.values())

    @property
    def unclaimed(self) -> int:
        """Copies no Deck holds for its own line (the sum of ``beyond``), reserved or not."""
        return self.total - self.claimed

    @property
    def spare(self) -> int:
        """The Spare Copies: the unclaimed copies less the reserved ones, which come out of these first."""
        return max(0, self.unclaimed - self.reserved)

    @property
    def reserved_in_decks(self) -> int:
        """Reserved copies the unclaimed ones can't cover, so a Deck's own copies are promised. They stay in the Deck
        and count for it until handover; the Deck can say "reserved for …"."""
        return max(0, self.reserved - self.unclaimed)

    @property
    def lendable(self) -> int:
        """Copies a Friend could borrow now: every copy less the reserved ones (spec "Terms used in this spec")."""
        return max(0, self.total - self.reserved)

    @property
    def lendable_in_deck(self) -> int:
        """The lendable copies that a Deck holds for its own line: the lendable copies less the Spare Copies."""
        return self.lendable - self.spare


def held_for_line(quantity: int, held: int) -> int:
    """The copies a Deck holds for its own Deck List line: the lesser of the line's quantity and the Deck's Holding of
    the Edition. The rest of that Holding is beyond the line (the Deck's Surplus). Part of the Spare Copy rule."""
    return min(quantity, held)


def spare_rule(held: Mapping[UUID, int], lines: Mapping[UUID, int], reserved: int = 0) -> EditionCopies:
    """The Spare Copy rule for one owner and one Card Edition. ``held``: the owner's Holdings of the Edition, copies by
    Location id. ``lines``: the Deck List lines naming it, quantity by Deck id. ``reserved``: the Edition's
    ``counts.reserved_counts``. Pure; the one place the rule is written."""
    own = {deck: held_for_line(quantity, held.get(deck, 0)) for deck, quantity in lines.items()}
    beyond = {location: copies - own.get(location, 0) for location, copies in held.items()
              if copies > own.get(location, 0)}
    return EditionCopies(total=sum(held.values()), own=own, beyond=beyond, reserved=reserved)


@dataclass(frozen=True)
class LineCount:
    """One Deck List line's copies under the counting setting: ``held + spare + other_decks + need == quantity``."""
    deck_id: UUID
    edition_id: UUID
    quantity: int     # The line's intended copies.
    held: int         # The Deck's own copies: the lesser of the line and the Deck's Holding of the Edition.
    spare: int        # Spare Copies counted for the line.
    other_decks: int  # Copies other Decks hold for their own lines, counted for this one (One Deck at a time only).
    # Where ``other_decks`` come from: (Deck id, copies) for each other Deck whose own line's copies this line counts,
    # oldest Deck first, summing to ``other_decks``. Empty under Every Deck built at once.
    from_decks: tuple[tuple[UUID, int], ...] = ()

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
    # Every copy the owner holds of each given Edition, wherever it is; an Edition with no copies is absent.
    owned: dict[UUID, int] = field(default_factory=dict)
    # The same copies by Location: Edition id -> {Location id: copies}. ``available_to`` reads where copies are.
    places: dict[UUID, dict[UUID, int]] = field(default_factory=dict)
    # The Spare Copy rule for every given Edition the owner holds or a Deck List names (``spare_rule``).
    copies: dict[UUID, EditionCopies] = field(default_factory=dict)

    def line(self, deck_id: UUID, edition_id: UUID) -> LineCount:
        return self.lines[(deck_id, edition_id)]


def oldest_first(created: dict[UUID, datetime]) -> tuple[UUID, ...]:
    """The one place Decks are ordered: oldest first, the Deck id breaking ties (Python orders UUIDs as PostgreSQL
    does). Deck ids are random, so the id alone says nothing about age."""
    return tuple(sorted(created, key=lambda deck: (created[deck], deck)))


def deck_order(conn, user_id: str) -> tuple[UUID, ...]:
    """Every Deck of the owner, oldest first, those with an empty Deck List included. The caller holds the owner row
    lock."""
    return oldest_first({row['id']: row['created_at'] for row in conn.execute(
        "SELECT id,created_at FROM location WHERE owner_id=%s AND kind='deck'", (user_id,))})


def _hand_out(shorts: Iterable[tuple[UUID, int]], spare_copies: int) -> dict[UUID, int]:
    """Every Deck built at once: ``spare_copies`` Spare Copies go to the Decks in ``shorts`` ((Deck id, copies short),
    oldest first), each taking what it is short of while any are left. Returns each Deck's share."""
    handed: dict[UUID, int] = {}
    left = spare_copies
    for deck, short in shorts:
        handed[deck] = min(short, left)
        left -= handed[deck]
    return handed


def allocate(conn, user_id: str, editions: Iterable[UUID], counting: WantListCounting) -> Allocation:
    """Count every Deck List line of the owner that names one of ``editions``. The caller holds the owner row lock."""
    wanted = sorted(set(editions))
    if not wanted:
        return Allocation(counting=counting, lines={}, order=())
    total: dict[UUID, int] = {}
    held: dict[tuple[UUID, UUID], int] = {}
    places: dict[UUID, dict[UUID, int]] = {}
    for row in conn.execute('SELECT location_id,edition_id,quantity FROM holding WHERE owner_id=%s AND edition_id=ANY(%s)',
                            (user_id, wanted)):
        total[row['edition_id']] = total.get(row['edition_id'], 0) + row['quantity']
        held[(row['location_id'], row['edition_id'])] = row['quantity']
        places.setdefault(row['edition_id'], {})[row['location_id']] = row['quantity']
    listed = conn.execute('SELECT deck_id,edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND edition_id=ANY(%s)',
                          (user_id, wanted)).fetchall()
    decks = sorted({row['deck_id'] for row in listed})
    created = {row['id']: row['created_at'] for row in conn.execute(
        'SELECT id,created_at FROM location WHERE owner_id=%s AND id=ANY(%s)', (user_id, decks))} if decks else {}
    order = oldest_first(created)
    rank = {deck: index for index, deck in enumerate(order)}
    by_edition: dict[UUID, list[dict]] = {}
    for row in listed:
        by_edition.setdefault(row['edition_id'], []).append(row)
    reserved = counts.reserved_counts(conn, user_id, wanted)
    copies = {edition: spare_rule(places.get(edition, {}),
                                  {row['deck_id']: row['quantity'] for row in by_edition.get(edition, [])},
                                  reserved.get(edition, 0))
              for edition in sorted(set(places) | set(by_edition))}
    lines: dict[tuple[UUID, UUID], LineCount] = {}
    for edition, rows in by_edition.items():
        rows.sort(key=lambda row: rank[row['deck_id']])
        own, claimed, spare_copies = copies[edition].own, copies[edition].claimed, copies[edition].spare
        handed = _hand_out(((row['deck_id'], row['quantity'] - own[row['deck_id']]) for row in rows), spare_copies)
        for row in rows:
            deck, quantity = row['deck_id'], row['quantity']
            short = quantity - own[deck]
            from_decks: list[tuple[UUID, int]] = []
            if counting == 'all_at_once':
                spare, others = handed[deck], 0
            else:
                # A short Deck holds nothing beyond its line, so every Spare Copy is outside it, and so are the copies
                # the other Decks hold for their own lines, taken from the oldest Deck first.
                spare = min(short, spare_copies)
                others = min(short - spare, claimed - own[deck])
                wanted_from_others = others
                for other in rows:
                    if wanted_from_others == 0:
                        break
                    taken = min(wanted_from_others, own[other['deck_id']]) if other['deck_id'] != deck else 0
                    if taken:
                        from_decks.append((other['deck_id'], taken))
                        wanted_from_others -= taken
            lines[(deck, edition)] = LineCount(deck_id=deck, edition_id=edition, quantity=quantity, held=own[deck],
                                               spare=spare, other_decks=others, from_decks=tuple(from_decks))
    return Allocation(counting=counting, lines=lines, order=order, owned=total, places=places, copies=copies)


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


@dataclass(frozen=True)
class Kept:
    """Copies of an Edition another Deck keeps, so the asking Deck can't use them (Every Deck built at once only)."""
    deck_id: UUID
    copies: int
    counted: bool   # False: the Deck holds them for its own line. True: Spare Copies that older Deck counts.


@dataclass(frozen=True)
class Available:
    """The copies of one Edition the counting setting makes available to the asking Deck."""
    edition_id: UUID
    in_deck: int    # Copies the asking Deck holds (Replace); 0 for a new Deck.
    # Copies available outside the asking Deck: (Location id, copies), in the order they are used (the module's
    # docstring). Under One Deck at a time other Decks' own copies come last, oldest Deck first.
    elsewhere: tuple[tuple[UUID, int], ...]
    kept: tuple[Kept, ...]   # Copies other Decks keep, oldest Deck first; empty under One Deck at a time.


@dataclass(frozen=True)
class Place:
    name: str
    deck: bool      # The Location is a Deck.


@dataclass(frozen=True)
class Availability:
    counting: WantListCounting
    # Every given Edition the owner holds a copy of; an Edition with none is absent.
    editions: dict[UUID, Available]
    # The name of every Location in ``elsewhere`` and every Deck in ``kept``.
    places: dict[UUID, Place]
    # Every Deck that lists one of the given Editions, oldest first (``Allocation.order``).
    order: tuple[UUID, ...]


def available_to(conn, user_id: str, editions: Iterable[UUID], counting: WantListCounting,
                 deck_id: UUID | None = None) -> Availability:
    """The copies of each of ``editions`` available to the Deck ``deck_id`` (Replace), or to a new Deck counted as the
    newest when it is None, under ``counting``; see the module docstring. The caller holds the owner row lock, read
    ``counting`` under it, and checked that ``deck_id`` is one of the owner's Decks. Its reads are ``allocate``'s and one
    range read of the Locations it names, so the work grows with the given Editions' Holdings and the Deck List lines
    naming them."""
    allocation = allocate(conn, user_id, editions, counting)
    ids = {location for found in allocation.places.values() for location in found} | set(allocation.order)
    if deck_id is not None:
        ids.add(deck_id)
    rows = {row['id']: row for row in conn.execute(
        'SELECT id,name,kind,created_at FROM location WHERE owner_id=%s AND id=ANY(%s)',
        (user_id, sorted(ids)))} if ids else {}

    def age(deck: UUID):
        return rows[deck]['created_at'], deck

    def loose_first(place: tuple[UUID, int]):
        row = rows[place[0]]
        return row['kind'] == 'deck', row['name'].casefold(), place[0]

    found: dict[UUID, Available] = {}
    for edition, held in allocation.places.items():
        # Other Decks' lines naming the Edition, oldest first; the asking Deck's own lines are being replaced.
        others = [allocation.lines[(deck, edition)] for deck in allocation.order
                  if deck != deck_id and (deck, edition) in allocation.lines]
        # The rule without the asking Deck: its copies come out of the pool, and its lines are being replaced.
        rule = spare_rule({location: copies for location, copies in held.items() if location != deck_id},
                          {line.deck_id: line.quantity for line in others}, allocation.copies[edition].reserved)
        spare = sorted(rule.beyond.items(), key=loose_first)
        spare_copies = rule.spare
        if counting == 'all_at_once':
            older = [line for line in others if deck_id is None or age(line.deck_id) < age(deck_id)]
            handed = _hand_out(((line.deck_id, line.quantity - line.held) for line in older), spare_copies)
            elsewhere = _first(spare, spare_copies - sum(handed.values()))
            kept: list[Kept] = []
            for line in others:
                if line.held:
                    kept.append(Kept(line.deck_id, line.held, False))
                if handed.get(line.deck_id):
                    kept.append(Kept(line.deck_id, handed[line.deck_id], True))
        else:
            elsewhere = _first(spare, spare_copies) + tuple((line.deck_id, line.held) for line in others if line.held)
            kept = []
        found[edition] = Available(edition_id=edition, in_deck=held.get(deck_id, 0) if deck_id is not None else 0,
                                   elsewhere=elsewhere, kept=tuple(kept))
    return Availability(counting=counting, editions=found,
                        places={location: Place(row['name'], row['kind'] == 'deck') for location, row in rows.items()},
                        order=allocation.order)


def _first(places: list[tuple[UUID, int]], copies: int) -> tuple[tuple[UUID, int], ...]:
    """The first ``copies`` copies of ``places``, in order."""
    taken: list[tuple[UUID, int]] = []
    for location, available in places:
        if copies <= 0:
            break
        taken.append((location, min(available, copies)))
        copies -= taken[-1][1]
    return tuple(taken)
