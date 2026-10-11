"""Deck List ownership states: read from current Holdings on every Deck detail read, never stored.

Each Deck List line splits its quantity into copies *in this Deck*, *elsewhere* in the Collection and *not owned*. All
counts match the line's exact Card Edition. Copies the Deck holds beyond its Deck List are *surplus*. Nothing is
reserved: *elsewhere* counts every copy outside the Deck, including copies another Deck's list needs and copies other
short Decks also count. ``competition`` flags every such double count: it warns whenever the copies the short Decks
count as elsewhere exceed the spare copies.
"""
from dataclasses import dataclass
from uuid import UUID

from pydantic import BaseModel


class ElsewhereLocation(BaseModel):
    location_id: UUID
    name: str
    kind: str
    # Every copy of the Edition held in this Location, not only the copies the line still needs.
    quantity: str


class LineOwnership(BaseModel):
    edition_id: UUID
    quantity: str
    in_deck: str
    elsewhere: str
    not_owned: str
    # The owner's other Locations holding the Edition; empty unless ``elsewhere`` is positive.
    locations: list[ElsewhereLocation]


class SurplusHolding(BaseModel):
    edition_id: UUID
    quantity: str


class CompetingDeck(BaseModel):
    deck_id: UUID
    name: str
    # Copies this other Deck holds for its own line; they are never spare.
    in_deck: str
    # Copies this other Deck counts as elsewhere for its own line.
    elsewhere: str


class CompetitionWarning(BaseModel):
    edition_id: UUID
    # Copies of the Edition not covering any Deck's line: loose copies plus copies a Deck holds beyond its line or
    # without a line. May be 0.
    spare: str
    # Copies every Deck listing the Edition counts as elsewhere, this Deck included; always more than ``spare``.
    counted_elsewhere: str
    # Every other Deck whose Deck List names the Edition.
    decks: list[CompetingDeck]


@dataclass(frozen=True)
class DeckOwnership:
    lines: list[LineOwnership]
    surplus: list[SurplusHolding]
    competition: list[CompetitionWarning]


def held_in(conn, user_id: str, deck_id: UUID) -> dict[UUID, int]:
    """The Deck's Holdings: quantity by Edition."""
    return {row['edition_id']: row['quantity'] for row in conn.execute(
        'SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s', (user_id, deck_id))}


def read_ownership(conn, user_id: str, deck_id: UUID) -> DeckOwnership:
    """Read one Deck's ownership states.

    The caller holds the owner row lock (``owner_and_rows``), as every Holding and Deck List writer does, so all
    statements see the same Holdings and Deck Lists. Reads are bounded by this Deck's lines and Holdings, the owner's
    Holdings of the Editions it is short of, and the owner's Deck List lines naming those Editions.

    The Deck's lines and Holdings are two primary-key range reads paired here, never a join: without fresh statistics
    for a large Deck the planner estimated one row per side and joined them by filter, quadratic in the Deck's size
    (96 ms per join at 1,000 lines; Deck Lists 19).
    """
    holdings = held_in(conn, user_id, deck_id)
    lines = [{**row, 'held': holdings.get(row['edition_id'], 0)} for row in conn.execute(
        'SELECT edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND deck_id=%s ORDER BY edition_id',
        (user_id, deck_id))]
    listed = {row['edition_id']: row['quantity'] for row in lines}
    surplus = [{'edition_id': edition, 'quantity': quantity - listed.get(edition, 0)}
               for edition, quantity in sorted(holdings.items()) if quantity > listed.get(edition, 0)]
    short = [row['edition_id'] for row in lines if row['quantity'] > row['held']]
    elsewhere: dict[UUID, list[dict]] = {}
    if short:
        for row in conn.execute("""SELECT h.edition_id,h.location_id,h.quantity,l.name,l.kind
          FROM holding h JOIN location l ON l.owner_id=h.owner_id AND l.id=h.location_id
          WHERE h.owner_id=%s AND h.edition_id=ANY(%s) AND h.location_id<>%s
          ORDER BY h.edition_id,lower(l.name),l.id""", (user_id, short, deck_id)):
            elsewhere.setdefault(row['edition_id'], []).append(row)
    others: dict[UUID, list[dict]] = {}
    if elsewhere:
        for row in conn.execute("""SELECT l.edition_id,l.deck_id,l.quantity,d.name
          FROM deck_list_line l JOIN location d ON d.owner_id=l.owner_id AND d.id=l.deck_id
          WHERE l.owner_id=%s AND l.deck_id<>%s AND l.edition_id=ANY(%s)
          ORDER BY l.edition_id,lower(d.name),d.id""", (user_id, deck_id, list(elsewhere))):
            others.setdefault(row['edition_id'], []).append(row)
    owned, competition = [], []
    for row in lines:
        edition, quantity = row['edition_id'], row['quantity']
        in_deck = min(quantity, row['held'])
        need = quantity - in_deck
        places = elsewhere.get(edition, [])
        outside = sum(place['quantity'] for place in places)
        fetchable = min(need, outside)
        owned.append(LineOwnership(
            edition_id=edition, quantity=str(quantity), in_deck=str(in_deck), elsewhere=str(fetchable),
            not_owned=str(need - fetchable),
            locations=[ElsewhereLocation(location_id=place['location_id'], name=place['name'], kind=place['kind'],
                                         quantity=str(place['quantity'])) for place in places]))
        if not places:
            continue
        # Each other Deck listing the Edition keeps the copies it holds for its line (never spare) and counts
        # min(its shortfall, copies outside it) as elsewhere, exactly as its own detail does. The counts are free of
        # double counting only if spare copies can serve all of them at once.
        held_at = {place['location_id']: place['quantity'] for place in places}
        total = row['held'] + outside
        claimed, counted, decks = 0, fetchable, []
        for other in others.get(edition, []):
            held = held_at.get(other['deck_id'], 0)
            covered = min(other['quantity'], held)
            counts = min(other['quantity'] - covered, total - held)
            claimed += covered
            counted += counts
            decks.append(CompetingDeck(deck_id=other['deck_id'], name=other['name'], in_deck=str(covered),
                                       elsewhere=str(counts)))
        spare = outside - claimed
        if counted > spare:
            competition.append(CompetitionWarning(edition_id=edition, spare=str(spare),
                                                  counted_elsewhere=str(counted), decks=decks))
    return DeckOwnership(
        lines=owned,
        surplus=[SurplusHolding(edition_id=row['edition_id'], quantity=str(row['quantity'])) for row in surplus],
        competition=competition)
