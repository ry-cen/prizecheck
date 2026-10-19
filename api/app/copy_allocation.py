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

``allocate`` is two steps (trading #265): ``read_allocation_rows`` makes those reads and the Loan and Borrowed Copy
reads below for one owner, into an ``AllocationRows``, and ``allocate_rows`` counts from the rows alone, with no I/O.
Nothing in this module reads several owners at once.

**The Spare Copy rule** is ``spare_rule``, the one place it is written (social network #245, spec "The Spare Copy rule
moves into one function"). ``allocate``, ``available_to``, ``deck_ownership`` (Surplus and the competition warning),
``swap_hints`` and ``deck_pick_list`` all read it, and every "copies in the Deck" figure (the Deck detail, its Deck List
lines and the Decks index) reads its ``held_for_line``. It takes the copies reserved for open Loans
(``social.counts.reserved_counts``), which come out of the Spare Copies first and then out of copies a Deck holds for
its own line; those stay in the Deck and keep counting for it until handover. Which copies are the reserved ones is
the Loan Pick List's choice (``social.counts.reserved_picks``): the rule places the reserved count at the picked
Locations first (``reserved_beyond`` and ``reserved_own``), so the copies offered elsewhere are never the ones a lender
is about to hand over. The counts never depend on the picks, which may be out of date; only the places do.

**Borrowed Copies** (social network #254, ``borrowed_copies``) are a Friend's copies in one of the owner's Decks. They
are never in ``holding``, so the Spare Copy rule never sees them: they are never spare and never offered. A line counts
the Borrowed Copies in its own Deck after the Deck's own copies (``LineCount.borrowed``), and no other Deck counts them.

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
lines (by Deck name, then id), each less the copies reserved there (``reserved_beyond``). The older Decks' counted Spare
Copies are the rest. Under One Deck at a time another Deck's own copies are offered less those reserved
(``reserved_own``). The Want List shows a Spare Copy as a count only, so it never contradicts these places.
"""
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID

from .borrowed_copies import borrowed_in
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
    # Location id -> reserved copies the Loan Pick List takes from there (``counts.reserved_picks``); None for a pick
    # whose source was deleted. Where to place the reserved count first, never a count itself.
    picked: Mapping[UUID | None, int] = field(default_factory=dict)

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

    @property
    def reserved_beyond(self) -> dict[UUID, int]:
        """Location id -> reserved copies placed among the copies there beyond its own line, summing to the reserved
        copies the unclaimed ones cover (``reserved - reserved_in_decks``): at the picked Locations first, then the
        largest of the rest first (the Loan Pick List's order), the id breaking ties. ``beyond`` less these are the
        Spare Copies' places."""
        return _place(min(self.reserved, self.unclaimed), self.beyond,
                      {location: copies for location, copies in self.picked.items() if location is not None})

    @property
    def reserved_own(self) -> dict[UUID, int]:
        """Deck id -> the Deck's own copies placed as reserved, summing to ``reserved_in_decks``: at the Decks whose picks
        reach past their copies beyond the line first, then the Decks holding the most for their lines. They stay in
        the Deck and count for it until handover; no other Deck can count them."""
        beyond = self.reserved_beyond
        reaching = {deck: max(0, self.picked.get(deck, 0) - beyond.get(deck, 0)) for deck in self.own}
        return _place(self.reserved_in_decks, self.own, reaching)


def _place(count: int, room: Mapping[UUID, int], first: Mapping[UUID, int]) -> dict[UUID, int]:
    """``count`` copies placed over ``room`` (copies by place): up to ``first`` at each place first, then the places
    with the most room left first, the id breaking ties. Places given none are absent. ``count`` never exceeds the
    room's sum."""
    placed: dict[UUID, int] = {}
    left = count
    for place in sorted(room, key=lambda place: (-min(first.get(place, 0), room[place]), str(place))):
        take = min(left, first.get(place, 0), room[place])
        if take > 0:
            placed[place] = take
            left -= take
    for place in sorted(room, key=lambda place: (-(room[place] - placed.get(place, 0)), str(place))):
        take = min(left, room[place] - placed.get(place, 0))
        if take > 0:
            placed[place] = placed.get(place, 0) + take
            left -= take
    return placed


def held_for_line(quantity: int, held: int) -> int:
    """The copies a Deck holds for its own Deck List line: the lesser of the line's quantity and the Deck's Holding of
    the Edition. The rest of that Holding is beyond the line (the Deck's Surplus). Part of the Spare Copy rule."""
    return min(quantity, held)


def spare_rule(held: Mapping[UUID, int], lines: Mapping[UUID, int], reserved: int = 0,
               picked: Mapping[UUID | None, int] | None = None) -> EditionCopies:
    """The Spare Copy rule for one owner and one Card Edition. ``held``: the owner's Holdings of the Edition, copies by
    Location id. ``lines``: the Deck List lines naming it, quantity by Deck id. ``reserved``: the Edition's
    ``counts.reserved_counts``. ``picked``: its ``counts.reserved_picks``, where the reserved copies are placed first.
    Pure; the one place the rule is written."""
    own = {deck: held_for_line(quantity, held.get(deck, 0)) for deck, quantity in lines.items()}
    beyond = {location: copies - own.get(location, 0) for location, copies in held.items()
              if copies > own.get(location, 0)}
    return EditionCopies(total=sum(held.values()), own=own, beyond=beyond, reserved=reserved, picked=dict(picked or {}))


@dataclass(frozen=True)
class LineCount:
    """One Deck List line's copies under the counting setting: ``held + borrowed + spare + other_decks + lent + need ==
    quantity``."""
    deck_id: UUID
    edition_id: UUID
    quantity: int     # The line's intended copies.
    held: int         # The Deck's own copies: the lesser of the line and the Deck's Holding of the Edition.
    spare: int        # Spare Copies counted for the line.
    other_decks: int  # Copies other Decks hold for their own lines, counted for this one (One Deck at a time only).
    # Where ``other_decks`` come from: (Deck id, copies) for each other Deck whose own line's copies this line counts,
    # oldest Deck first, summing to ``other_decks``. Empty under Every Deck built at once.
    from_decks: tuple[tuple[UUID, int], ...] = ()
    # Copies the collector lent to Friends, counted for the line (#253): they are the collector's and come back, so a
    # lent line is never on the Want List. The Deck's own lent copies first, then other lent copies as Spare Copies go.
    lent: int = 0
    # Borrowed Copies in this Deck counted for the line (#254), after the Deck's own copies: a Friend's copies fill the
    # line of the Deck they are in, and no other. They are never Spare Copies.
    borrowed: int = 0

    @property
    def need(self) -> int:
        """Copies the line still needs from outside the Collection."""
        return self.quantity - self.held - self.borrowed - self.spare - self.other_decks - self.lent


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


@dataclass(frozen=True)
class AllocationRows:
    """The inputs one owner's allocation reads, so that ``allocate_rows`` does no I/O (trading #265). The one reader is
    ``read_allocation_rows``, for a single owner. ``allocate_rows`` ignores the rows of any Edition it isn't asked
    about, and of any Deck with no line naming one, and never changes them."""
    # (Location id, Edition id, copies): each of the owner's Holdings of the Editions, in the order they were read.
    holdings: tuple[tuple[UUID, UUID, int], ...] = ()
    # (Deck id, Edition id, quantity): each of the owner's Deck List lines naming them, in the order they were read.
    lines: tuple[tuple[UUID, UUID, int], ...] = ()
    # Deck id -> ``location.created_at``, for every Deck those lines belong to (``oldest_first`` orders them).
    deck_created: Mapping[UUID, datetime] = field(default_factory=dict)
    # Edition id -> copies promised to open Loans and not yet handed over (``counts.reserved_counts``).
    reserved: Mapping[UUID, int] = field(default_factory=dict)
    # Edition id -> {source Location id or None: copies}: where the reserved copies are picked
    # (``counts.reserved_picks``).
    picked: Mapping[UUID, Mapping[UUID | None, int]] = field(default_factory=dict)
    # Edition id -> copies handed over to open Loans and not had back (``counts.lent_counts``).
    lent: Mapping[UUID, int] = field(default_factory=dict)
    # Edition id -> {source Location id or None: copies}: where the lent copies came from (``counts.lent_picks``).
    lent_at: Mapping[UUID, Mapping[UUID | None, int]] = field(default_factory=dict)
    # (Deck id, Edition id) -> Borrowed Copies in that Deck (``borrowed_copies.borrowed_in``).
    borrowed: Mapping[tuple[UUID, UUID], int] = field(default_factory=dict)


def read_allocation_rows(conn, user_id: str, editions: Iterable[UUID]) -> AllocationRows:
    """Everything ``allocate_rows`` reads for the owner's Deck List lines naming one of ``editions``: today's reads of
    ``allocate``, moved unchanged. The caller holds the owner row lock. With no Editions it reads nothing."""
    wanted = sorted(set(editions))
    if not wanted:
        return AllocationRows()
    holdings = tuple((row['location_id'], row['edition_id'], row['quantity']) for row in conn.execute(
        'SELECT location_id,edition_id,quantity FROM holding WHERE owner_id=%s AND edition_id=ANY(%s)',
        (user_id, wanted)))
    lines = tuple((row['deck_id'], row['edition_id'], row['quantity']) for row in conn.execute(
        'SELECT deck_id,edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND edition_id=ANY(%s)',
        (user_id, wanted)).fetchall())
    decks = sorted({deck for deck, _, _ in lines})
    created = {row['id']: row['created_at'] for row in conn.execute(
        'SELECT id,created_at FROM location WHERE owner_id=%s AND id=ANY(%s)', (user_id, decks))} if decks else {}
    reserved = counts.reserved_counts(conn, user_id, wanted)
    picked = counts.reserved_picks(conn, user_id, list(reserved)) if reserved else {}
    lent = counts.lent_counts(conn, user_id, wanted)
    lent_at = counts.lent_picks(conn, user_id, list(lent)) if lent else {}
    # Borrowed Copies count for the Deck they are in only, after its own copies (#254).
    borrowed = borrowed_in(conn, user_id, decks, wanted)
    return AllocationRows(holdings=holdings, lines=lines, deck_created=created, reserved=reserved, picked=picked,
                          lent=lent, lent_at=lent_at, borrowed=borrowed)


def allocate_rows(rows: AllocationRows, editions: Iterable[UUID], counting: WantListCounting) -> Allocation:
    """Count every Deck List line in ``rows`` that names one of ``editions``, under ``counting``. Pure: no I/O, and
    ``rows`` is never changed. Rows of other Editions, and Decks with no line naming one of ``editions``, take no
    part."""
    wanted = set(editions)
    if not wanted:
        return Allocation(counting=counting, lines={}, order=())
    total: dict[UUID, int] = {}
    places: dict[UUID, dict[UUID, int]] = {}
    for location, edition, quantity in rows.holdings:
        if edition in wanted:
            total[edition] = total.get(edition, 0) + quantity
            places.setdefault(edition, {})[location] = quantity
    listed = [{'deck_id': deck, 'edition_id': edition, 'quantity': quantity}
              for deck, edition, quantity in rows.lines if edition in wanted]
    decks = sorted({row['deck_id'] for row in listed})
    order = oldest_first({deck: rows.deck_created[deck] for deck in decks})
    rank = {deck: index for index, deck in enumerate(order)}
    by_edition: dict[UUID, list[dict]] = {}
    for row in listed:
        by_edition.setdefault(row['edition_id'], []).append(row)
    copies = {edition: spare_rule(places.get(edition, {}),
                                  {row['deck_id']: row['quantity'] for row in by_edition.get(edition, [])},
                                  rows.reserved.get(edition, 0), rows.picked.get(edition))
              for edition in sorted(set(places) | set(by_edition))}
    lent_total, lent_at, borrowed = rows.lent, rows.lent_at, rows.borrowed
    lines: dict[tuple[UUID, UUID], LineCount] = {}
    for edition, deck_rows in by_edition.items():
        deck_rows.sort(key=lambda row: rank[row['deck_id']])
        own, spare_copies = copies[edition].own, copies[edition].spare
        # Another Deck's own copies that are reserved stay counted by that Deck only (One Deck at a time).
        promised = copies[edition].reserved_own
        free_own = {deck: held - promised.get(deck, 0) for deck, held in own.items()}
        own_borrowed = {row['deck_id']: min(row['quantity'] - own[row['deck_id']],
                                            borrowed.get((row['deck_id'], edition), 0)) for row in deck_rows}
        # Copies a Deck lent from its own line count for that Deck first; the other lent copies are a pool.
        own_lent = {row['deck_id']: min(row['quantity'] - own[row['deck_id']] - own_borrowed[row['deck_id']],
                                        lent_at.get(edition, {}).get(row['deck_id'], 0)) for row in deck_rows}
        pool = max(0, lent_total.get(edition, 0) - sum(own_lent.values()))
        filled = {row['deck_id']: own[row['deck_id']] + own_borrowed[row['deck_id']] + own_lent[row['deck_id']]
                  for row in deck_rows}
        handed = _hand_out(((row['deck_id'], row['quantity'] - filled[row['deck_id']]) for row in deck_rows),
                           spare_copies)
        counted: list[tuple[dict, int, int, tuple]] = []
        for row in deck_rows:
            deck, quantity = row['deck_id'], row['quantity']
            short = quantity - filled[deck]
            from_decks: list[tuple[UUID, int]] = []
            if counting == 'all_at_once':
                spare, others = handed[deck], 0
            else:
                # A short Deck holds nothing beyond its line, so every Spare Copy is outside it, and so are the copies
                # the other Decks hold for their own lines, taken from the oldest Deck first.
                spare = min(short, spare_copies)
                others = min(short - spare, sum(free_own.values()) - free_own[deck])
                wanted_from_others = others
                for other in deck_rows:
                    if wanted_from_others == 0:
                        break
                    taken = min(wanted_from_others, free_own[other['deck_id']]) if other['deck_id'] != deck else 0
                    if taken:
                        from_decks.append((other['deck_id'], taken))
                        wanted_from_others -= taken
            counted.append((row, spare, others, tuple(from_decks)))
        # The pool of other lent copies: oldest Deck first under Every Deck built at once, every Deck under One Deck at
        # a time, as Spare Copies go.
        rests = [(row['deck_id'], row['quantity'] - filled[row['deck_id']] - spare - others)
                 for row, spare, others, _ in counted]
        extra = (_hand_out(rests, pool) if counting == 'all_at_once'
                 else {deck: min(rest, pool) for deck, rest in rests})
        for row, spare, others, from_decks in counted:
            deck = row['deck_id']
            lines[(deck, edition)] = LineCount(deck_id=deck, edition_id=edition, quantity=row['quantity'],
                                               held=own[deck], spare=spare, other_decks=others, from_decks=from_decks,
                                               lent=own_lent[deck] + extra[deck], borrowed=own_borrowed[deck])
    return Allocation(counting=counting, lines=lines, order=order, owned=total, places=places, copies=copies)


def allocate(conn, user_id: str, editions: Iterable[UUID], counting: WantListCounting) -> Allocation:
    """Count every Deck List line of the owner that names one of ``editions``: ``allocate_rows`` over
    ``read_allocation_rows``. The caller holds the owner row lock."""
    wanted = sorted(set(editions))
    return allocate_rows(read_allocation_rows(conn, user_id, wanted), wanted, counting)


def deck_lines(conn, user_id: str, deck_id: UUID, counting: WantListCounting) -> dict[UUID, LineCount]:
    """Every Deck List line of one Deck, by Edition in Edition order. Only the lines the Deck is short of are allocated:
    a line the Deck's own copies and Borrowed Copies cover needs nothing whatever the setting. The caller holds the
    owner row lock."""
    held = {row['edition_id']: row['quantity'] for row in conn.execute(
        'SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s', (user_id, deck_id))}
    borrowed = {edition: copies for (_, edition), copies in borrowed_in(conn, user_id, [deck_id]).items()}
    rows = conn.execute('SELECT edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND deck_id=%s '
                        'ORDER BY edition_id', (user_id, deck_id)).fetchall()
    short = [row['edition_id'] for row in rows
             if row['quantity'] > held.get(row['edition_id'], 0) + borrowed.get(row['edition_id'], 0)]
    allocation = allocate(conn, user_id, short, counting)

    def covered(row) -> LineCount:
        own = min(row['quantity'], held.get(row['edition_id'], 0))
        return LineCount(deck_id=deck_id, edition_id=row['edition_id'], quantity=row['quantity'], held=own,
                         spare=0, other_decks=0, borrowed=row['quantity'] - own)

    return {row['edition_id']: allocation.lines.get((deck_id, row['edition_id'])) or covered(row) for row in rows}


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
        # The rule without the asking Deck: its copies come out of the pool, and its lines are being replaced. Copies
        # reserved from the asking Deck's own Holding go with it: those the rule places there, never the raw picks,
        # which may name copies that have since moved out of it.
        whole = allocation.copies[edition]
        picked = {location: copies for location, copies in whole.picked.items() if location != deck_id}
        placed_here = (whole.reserved_beyond.get(deck_id, 0) + whole.reserved_own.get(deck_id, 0)
                       if deck_id is not None else 0)
        rule = spare_rule({location: copies for location, copies in held.items() if location != deck_id},
                          {line.deck_id: line.quantity for line in others}, whole.reserved - placed_here, picked)
        promised = rule.reserved_beyond
        spare = sorted(((location, copies - promised.get(location, 0)) for location, copies in rule.beyond.items()
                        if copies > promised.get(location, 0)), key=loose_first)
        spare_copies = rule.spare
        if counting == 'all_at_once':
            older = [line for line in others if deck_id is None or age(line.deck_id) < age(deck_id)]
            # An older Deck's Borrowed Copies fill its line, so it takes no Spare Copy for them (#254).
            handed = _hand_out(((line.deck_id, line.quantity - line.held - line.borrowed) for line in older),
                               spare_copies)
            elsewhere = _first(spare, spare_copies - sum(handed.values()))
            kept: list[Kept] = []
            for line in others:
                if line.held:
                    kept.append(Kept(line.deck_id, line.held, False))
                if handed.get(line.deck_id):
                    kept.append(Kept(line.deck_id, handed[line.deck_id], True))
        else:
            own_promised = rule.reserved_own
            elsewhere = _first(spare, spare_copies) + tuple(
                (line.deck_id, line.held - own_promised.get(line.deck_id, 0)) for line in others
                if line.held > own_promised.get(line.deck_id, 0))
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
