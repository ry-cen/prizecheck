"""Which Card Editions each reviewed line becomes (Decklist Import, spec "Allocation and Edition choice").

Ticket #212: every copy is a new copy. New copies get add-by-Printing's rule (``deck_list_printing.choose_edition``): the
cheapest stored quote among the Printing's active Editions, else the first Edition in catalog order, which is how a
Printing with only the Unspecified Variant gets that Edition. ``PH`` changes nothing. An Edition the collector chose
(an ``edition_id`` fix) overrides the rule.

Ticket #214 replaces ``parts_for`` with the owned-copies allocation (this Deck's copies, then the copies the counting
setting makes available, in paste order from one pool); what is left of each line still goes through ``new_copies``.
Pure: no database and no price read.
"""
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from .deck_list_printing import choose_edition

Source = Literal['in_deck', 'elsewhere', 'new']
ChosenBy = Literal['cheapest_price', 'catalog_order', 'collector']


@dataclass(frozen=True)
class Resolved:
    """A line the review resolved to a Card Printing (matched, picked, and later by name or Basic Energy by type)."""
    line: int
    quantity: int
    printing_id: UUID
    edition_id: UUID | None   # the collector's Edition, from an edition_id fix; None lets the rule choose


@dataclass(frozen=True)
class Part:
    edition_id: UUID
    quantity: int
    source: Source
    chosen_by: ChosenBy | None   # new copies only


def new_copies(quantity: int, editions: list[UUID], views: dict, chosen: UUID | None = None) -> Part:
    """``quantity`` new copies: the collector's Edition, else add-by-Printing's rule over ``editions`` (catalog order)."""
    if chosen is not None:
        return Part(chosen, quantity, 'new', 'collector')
    edition_id, rule = choose_edition(editions, views)
    return Part(edition_id, quantity, 'new', rule)


def parts_for(lines: list[Resolved], editions: dict[UUID, list[UUID]], views: dict) -> dict[int, list[Part]]:
    """Each resolved line's parts, by line number. ``editions`` maps each Printing to its active Editions in catalog
    order; ``views`` maps Edition ids to stored quotes (``prices.stored_edition_quotes``)."""
    return {line.line: [new_copies(line.quantity, editions[line.printing_id], views, line.edition_id)]
            for line in lines}


def merged(parts: list[Part]) -> list[tuple[UUID, int]]:
    """The Deck List saving writes: parts naming one Edition become one line (ADR 0009: one Card Edition per line),
    in the order each Edition first appears."""
    totals: dict[UUID, int] = {}
    for part in parts:
        totals[part.edition_id] = totals.get(part.edition_id, 0) + part.quantity
    return list(totals.items())
