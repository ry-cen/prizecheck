"""Which Card Editions each reviewed line becomes (Decklist Import, spec "Allocation and Edition choice").

Owned copies come first (ticket #214), from one pool shared by every pasted line in paste order, so no copy counts
twice. The pool is what ``copy_allocation.available_to`` makes available to the Deck being built under the Want List
counting setting. A line takes, in order:

1. this Deck's copies of the named Printing (Replace only: a new Deck holds none);
2. available copies of the named Printing elsewhere;
3. under **Use cards I own** only, this Deck's copies of the other Printings the line reaches: its Reprint Group, or for
   a Basic Energy every Basic Energy of its type (``import_owned.groups``);
4. available copies of those Printings elsewhere.

Within a step the Edition with the most copies left goes first, then catalog order: the Printing's place (the named
Printing, then the others newest first) and the Edition's (``descriptor_key, id``). That keeps the Deck List to as few
lines as it can.

The rest of the line gets add-by-Printing's rule (``deck_list_printing.choose_edition``): the cheapest stored quote among
the named Printing's active Editions, else the first in catalog order, which is how a Printing with only the Unspecified
Variant gets that Edition. ``PH`` changes nothing. An Edition the collector chose (an ``edition_id`` fix) is the rest's
Edition; owned copies still come first.

Pure: no database and no price read.
"""
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from .copy_allocation import Available
from .deck_list_printing import choose_edition

Source = Literal['in_deck', 'elsewhere', 'new']
ChosenBy = Literal['cheapest_price', 'catalog_order', 'collector']
OwnedCards = Literal['exact', 'owned']


@dataclass(frozen=True)
class Resolved:
    """A line the review resolved to a Card Printing (matched, picked, by name or Basic Energy by type)."""
    line: int
    quantity: int
    printing_id: UUID
    edition_id: UUID | None   # the collector's Edition for the rest, from an edition_id fix; None lets the rule choose


@dataclass(frozen=True)
class Part:
    edition_id: UUID
    quantity: int
    source: Source
    chosen_by: ChosenBy | None   # new copies only
    places: tuple[tuple[UUID, int], ...] = ()   # elsewhere: (Location id, copies) the copies come from


class Pool:
    """The owned copies no earlier line has used, by Edition: this Deck's, and those available elsewhere, Location by
    Location in the order ``available_to`` gives."""

    def __init__(self, available: dict[UUID, Available]):
        self._in_deck = {edition: found.in_deck for edition, found in available.items()}
        self._elsewhere = {edition: [list(place) for place in found.elsewhere] for edition, found in available.items()}

    def left(self, edition: UUID, source: Source) -> int:
        if source == 'in_deck':
            return self._in_deck.get(edition, 0)
        return sum(copies for _, copies in self._elsewhere.get(edition, ()))

    def take(self, edition: UUID, source: Source, copies: int) -> tuple[tuple[UUID, int], ...]:
        """Uses ``copies`` copies (no more than ``left``); answers where they came from (elsewhere only), one entry per
        Location in the order first used: under One Deck at a time a Deck can give its spare copies and its own."""
        if source == 'in_deck':
            self._in_deck[edition] -= copies
            return ()
        taken: dict[UUID, int] = {}
        for place in self._elsewhere[edition]:
            if copies == 0:
                break
            used = min(place[1], copies)
            if used:
                taken[place[0]] = taken.get(place[0], 0) + used
                place[1] -= used
                copies -= used
        return tuple(taken.items())


def new_copies(quantity: int, editions: list[UUID], views: dict, chosen: UUID | None = None) -> Part:
    """``quantity`` new copies: the collector's Edition, else add-by-Printing's rule over ``editions`` (catalog order)."""
    if chosen is not None:
        return Part(chosen, quantity, 'new', 'collector')
    edition_id, rule = choose_edition(editions, views)
    return Part(edition_id, quantity, 'new', rule)


def parts_for(lines: list[Resolved], editions: dict[UUID, list[UUID]], views: dict, owned: OwnedCards = 'owned',
              others: dict[UUID, tuple[UUID, ...]] | None = None,
              available: dict[UUID, Available] | None = None) -> dict[int, list[Part]]:
    """Each resolved line's parts, by line number, allocated in the order of ``lines`` (paste order).

    - ``editions`` maps each Printing to its active Editions in catalog order;
    - ``views`` maps Edition ids to stored quotes (``prices.stored_edition_quotes``);
    - ``owned`` is the owned-cards setting;
    - ``others`` maps a Printing to the other Printings Use cards I own reaches, newest first;
    - ``available`` is ``available_to``'s answer by Edition, the shared pool."""
    pool = Pool(available or {})
    reach = others or {}
    found: dict[int, list[Part]] = {}
    for line in lines:
        named = editions[line.printing_id]
        group = [edition for printing in reach.get(line.printing_id, ()) for edition in editions.get(printing, ())]
        rank = {edition: index for index, edition in enumerate([*named, *group])}
        steps: list[tuple[Source, list[UUID]]] = [('in_deck', named), ('elsewhere', named)]
        if owned == 'owned':
            steps += [('in_deck', group), ('elsewhere', group)]
        parts: list[Part] = []
        wanted = line.quantity
        for source, candidates in steps:
            for edition in sorted((edition for edition in candidates if pool.left(edition, source) > 0),
                                  key=lambda edition: (-pool.left(edition, source), rank[edition])):
                if wanted == 0:
                    break
                copies = min(wanted, pool.left(edition, source))
                parts.append(Part(edition, copies, source, None, pool.take(edition, source, copies)))
                wanted -= copies
        if wanted:
            parts.append(new_copies(wanted, named, views, line.edition_id))
        found[line.line] = parts
    return found


def merged(parts: list[Part]) -> list[tuple[UUID, int]]:
    """The Deck List saving writes: parts naming one Edition become one line (ADR 0009: one Card Edition per line),
    in the order each Edition first appears."""
    totals: dict[UUID, int] = {}
    for part in parts:
        totals[part.edition_id] = totals.get(part.edition_id, 0) + part.quantity
    return list(totals.items())
