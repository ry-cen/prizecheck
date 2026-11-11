"""Row-only allocation of owned copies to Deck List lines; no readers or I/O."""
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal
from uuid import UUID

# **Every Deck built at once** (the default) gives each Spare Copy to one Deck only, oldest Deck first; **One Deck at a
# time** counts every copy outside a Deck for that Deck. Migration 049 checks the same two names.
WantListCounting = Literal['all_at_once', 'one_at_a_time']


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



def oldest_first(created: dict[UUID, datetime]) -> tuple[UUID, ...]:
    """The one place Decks are ordered: oldest first, the Deck id breaking ties (Python orders UUIDs as PostgreSQL
    does). Deck ids are random, so the id alone says nothing about age."""
    return tuple(sorted(created, key=lambda deck: (created[deck], deck)))



def _hand_out(shorts: Iterable[tuple[UUID, int]], spare_copies: int) -> dict[UUID, int]:
    """Every Deck built at once: ``spare_copies`` Spare Copies go to the Decks in ``shorts`` ((Deck id, copies short),
    oldest first), each taking what it is short of while any are left. Returns each Deck's share."""
    handed: dict[UUID, int] = {}
    left = spare_copies
    for deck, short in shorts:
        handed[deck] = min(short, left)
        left -= handed[deck]
    return handed



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

