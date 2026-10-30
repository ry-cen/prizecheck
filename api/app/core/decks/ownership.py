"""Deck List ownership states: read from current Holdings on every Deck detail read, never stored.

Each Deck List line splits its quantity into copies *in this Deck*, *elsewhere* in the Collection, *lent* to a Friend
from this Deck and *not owned*. All counts match the line's exact Card Edition. *In this Deck* counts the Deck's
physical copies: its Holdings and the Borrowed Copies in it (social network #254), the Deck's own copies first.
Copies the Deck holds beyond its Deck List are *surplus*. Nothing is reserved: *elsewhere* counts every copy outside
the Deck, including copies another Deck's list needs and copies other short Decks also count. ``competition`` flags every such double count: it warns whenever the copies the short Decks
count as elsewhere exceed the spare copies.

Each surplus row carries the Deck's Holding version and the card's display data (app redesign #180): the deck builder
draws the surplus group from the Deck read alone, including cards cut from the list entirely, and puts the copies away
with an ordinary Move, which needs the version.
"""
from dataclasses import dataclass
from uuid import UUID
from pydantic import BaseModel
from app.borrowed_copies import borrowed_at
from app.copy_allocation import held_for_line, spare_rule
from app.social import counts


class ElsewhereLocation(BaseModel):
    location_id: UUID
    name: str
    kind: str
    # Every copy of the Edition held in this Location, not only the copies the line still needs.
    quantity: str


class LineOwnership(BaseModel):
    edition_id: UUID
    quantity: str
    # The Deck's physical copies for the line: its own, then Borrowed Copies (#254).
    in_deck: str
    elsewhere: str
    # Copies lent to a Friend from this Deck (#253): still owned, so never ``not_owned``. ``in_deck + elsewhere + lent
    # + not_owned == quantity``.
    lent: str
    not_owned: str
    # The owner's other Locations holding the Edition; empty unless ``elsewhere`` is positive.
    locations: list[ElsewhereLocation]


class SurplusHoldingBase(BaseModel):
    edition_id: UUID
    # Copies held in the Deck beyond its Deck List line (all of them when the Edition has no line).
    quantity: str
    # The Deck's Holding version: send it as ``expected_version`` in the Move that puts the copies away.
    version: int


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
    surplus: list[SurplusHoldingBase]
    competition: list[CompetitionWarning]


def held_in(conn, user_id: str, deck_id: UUID) -> dict[UUID, int]:
    """The Deck's Holdings: quantity by Edition."""
    return {row['edition_id']: row['quantity'] for row in conn.execute(
        'SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s', (user_id, deck_id))}


# The one Deck ``beyond_list`` asks the Spare Copy rule about; any key would do.
_DECK = UUID(int=0)


def beyond_list(holdings: dict[UUID, int], listed: dict[UUID, int]) -> list[tuple[UUID, int]]:
    """The Deck's surplus: (Edition, copies held beyond its Deck List line), in Edition order; every copy of an Edition
    with no line. The deck builder's Surplus group and Replace's preview (``import_replace``) both use this rule, the
    Spare Copy rule's ``beyond`` for the one Deck."""
    found = []
    for edition, quantity in sorted(holdings.items()):
        rule = spare_rule({_DECK: quantity}, {_DECK: listed[edition]} if edition in listed else {})
        extra = rule.beyond.get(_DECK, 0)
        if extra:
            found.append((edition, extra))
    return found


def surplus_holdings(beyond: list[tuple[UUID, int]], versions: dict[UUID, int],
                     *, display: dict[UUID, dict], holding) -> list:
    """``beyond_list``'s rows with the Deck's Holding versions and their display data (``read_line_display``)."""
    return [holding(edition_id=edition, quantity=str(quantity), version=versions[edition], **display[edition])
            for edition, quantity in beyond]


def read_ownership(conn, user_id: str, deck_id: UUID) -> DeckOwnership:
    """Read one Deck's ownership states.

    The caller holds the owner row lock (``owner_and_rows``), as every Holding and Deck List writer does, so all
    statements see the same Holdings and Deck Lists. Reads are bounded by this Deck's lines and Holdings, the owner's
    Holdings of the Editions it is short of, the owner's Deck List lines naming those Editions, and the catalog display
    data of the Deck's surplus Editions.

    The Deck's lines and Holdings are two primary-key range reads paired here, never a join: without fresh statistics
    for a large Deck the planner estimated one row per side and joined them by filter, quadratic in the Deck's size
    (96 ms per join at 1,000 lines; Deck Lists 19).
    """
    held = conn.execute('SELECT edition_id,quantity,version FROM holding WHERE owner_id=%s AND location_id=%s',
                        (user_id, deck_id)).fetchall()
    holdings = {row['edition_id']: row['quantity'] for row in held}
    versions = {row['edition_id']: row['version'] for row in held}
    # Borrowed Copies fill the Deck's lines after its own copies, and are never its Surplus (#254).
    borrowed = borrowed_at(conn, user_id, deck_id)
    lines = [{**row, 'held': holdings.get(row['edition_id'], 0), 'borrowed': borrowed.get(row['edition_id'], 0)}
             for row in conn.execute(
        'SELECT edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND deck_id=%s ORDER BY edition_id',
        (user_id, deck_id))]
    listed = {row['edition_id']: row['quantity'] for row in lines}
    surplus = beyond_list(holdings, listed)
    short = [row['edition_id'] for row in lines if row['quantity'] > row['held'] + row['borrowed']]
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
    reserved = counts.reserved_counts(conn, user_id, list(elsewhere)) if elsewhere else {}
    lent_from = counts.lent_picks(conn, user_id, short) if short else {}
    owned, competition = [], []
    for row in lines:
        edition, quantity = row['edition_id'], row['quantity']
        in_deck = held_for_line(quantity, row['held'] + row['borrowed'])
        need = quantity - in_deck
        places = elsewhere.get(edition, [])
        outside = sum(place['quantity'] for place in places)
        fetchable = min(need, outside)
        lent = min(need - fetchable, lent_from.get(edition, {}).get(deck_id, 0))
        owned.append(LineOwnership(
            edition_id=edition, quantity=str(quantity), in_deck=str(in_deck), elsewhere=str(fetchable),
            lent=str(lent), not_owned=str(need - fetchable - lent),
            locations=[ElsewhereLocation(location_id=place['location_id'], name=place['name'], kind=place['kind'],
                                         quantity=str(place['quantity'])) for place in places]))
        if not places:
            continue
        # Each other Deck listing the Edition keeps the copies it holds for its line (never spare) and counts
        # min(its shortfall, copies outside it) as elsewhere, exactly as its own detail does. The counts are free of
        # double counting only if spare copies can serve all of them at once.
        held_at = {place['location_id']: place['quantity'] for place in places}
        total = row['held'] + outside
        lines_naming = {deck_id: quantity, **{other['deck_id']: other['quantity'] for other in others.get(edition, [])}}
        rule = spare_rule({**held_at, deck_id: row['held']}, lines_naming, reserved.get(edition, 0))
        counted, decks = fetchable, []
        for other in others.get(edition, []):
            held = held_at.get(other['deck_id'], 0)
            covered = rule.own[other['deck_id']]
            counting = min(other['quantity'] - covered, total - held)
            counted += counting
            decks.append(CompetingDeck(deck_id=other['deck_id'], name=other['name'], in_deck=str(covered),
                                       elsewhere=str(counting)))
        spare = rule.spare
        if counted > spare:
            competition.append(CompetitionWarning(edition_id=edition, spare=str(spare),
                                                  counted_elsewhere=str(counted), decks=decks))
    return DeckOwnership(lines=owned, surplus=[SurplusHoldingBase(edition_id=edition,
        quantity=str(quantity), version=versions[edition]) for edition, quantity in surplus], competition=competition)
