"""The collector's own Trade List (Trading #269, spec "For trade Locations and the Trade List", resolution "Module
boundary").

``GET /api/trades/list`` answers every card on the collector's Trade List: per Card Edition, the copies they offer now
(its listable copies, from migration 142's one listable rule, which nothing here restates) and, for the collector's own
eyes only, which of their For trade Locations those copies sit in, so they know where to look when a Trade is agreed.
Each Location says whether it is hidden from Friends, by itself or by a Location above it: a hidden For trade
Location's cards are still on the Trade List. ``own_trade_copies`` is the same listable read for one collector, for
the Trade steps and discovery to import, and ``for_trade_places`` the collector's own Holdings in their For trade
Locations, for the Trade Pick List (trading #270).

Where the copies sit is shown, never counted. Per For trade Location, a card shows the copies held there less the
copies that reserving Loan and Trade picks take from there (``counts.reserved_picks``); those are then cut back, from
the last Location in tree order, until they add up to the listable copies. So the Locations of a card always add up to
its count, and a Location never shows a copy that is promised.

This is the collector's own read, outside ``/api/social``: it never reads another collector's inventory, so it may
name the collector's own Locations. It takes no lock and reads one snapshot, and writes nothing.
"""
from collections.abc import Iterable
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .db import connect
from .identity import verified_user
from .social import counts
from .social.friend_reads import card_facts
from .social.hidden_locations import hidden_by

router = APIRouter(prefix='/api/trades', tags=['trades'])

# The one listable rule (migration 142) for one collector; the Editions are NULL for every Edition.
OWN_LISTABLE = 'SELECT edition_id, listable FROM trade_listable(ARRAY[%s]::text[], %s::uuid[])'
# The collector's own Holdings in their For trade Locations (migration 140's rule, which never answers a Deck).
FOR_TRADE_HOLDINGS = """WITH ft AS (SELECT DISTINCT f.location_id FROM for_trade_locations(ARRAY[%s]::text[]) f)
  SELECT h.location_id, h.edition_id, h.quantity
  FROM holding h JOIN ft ON ft.location_id = h.location_id
  WHERE h.owner_id = %s"""
# The collector's own Locations: names, the tree and what they hid.
OWN_LOCATIONS = 'SELECT id, name, parent_id, hidden FROM location WHERE owner_id = %s'
# The collector's own Holdings of some Editions in their For trade Locations, with each Location's name and kind, for
# the Trade Pick List (trading #270, ``app.trade_picks``).
FOR_TRADE_PLACES = """WITH ft AS (SELECT DISTINCT f.location_id FROM for_trade_locations(ARRAY[%s]::text[]) f)
  SELECT h.location_id, h.edition_id, h.quantity, l.name, l.kind
  FROM holding h JOIN ft ON ft.location_id = h.location_id
  JOIN location l ON l.owner_id = h.owner_id AND l.id = h.location_id
  WHERE h.owner_id = %s AND h.edition_id = ANY(%s)"""


class TradeListPlace(BaseModel):
    """Copies of one card on offer from one of the collector's own For trade Locations (``TradeListLocation.id``)."""
    location_id: UUID
    copies: str


class TradeListLocation(BaseModel):
    """One of the collector's own Locations that holds cards on their Trade List. ``path``: the names from the top of
    the tree down to this one. ``hidden``: hidden from Friends, by itself or by a Location above it; its cards are on
    the Trade List all the same."""
    id: UUID
    name: str
    path: list[str]
    hidden: bool


class TradeListCard(BaseModel):
    """One Card Edition on the collector's Trade List. ``copies``: the copies they offer now. ``places``: where those
    copies sit, in tree order, adding up to ``copies``."""
    edition_id: UUID
    name: str
    set_code: str           # The printed set code ("PAL"), or the TCGdex set ID when the set has none (set_codes).
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    copies: str
    places: list[TradeListPlace]


class OwnTradeList(BaseModel):
    """The collector's own Trade List. ``locations``: every Location a card sits in, in tree order (siblings by name,
    case ignored); ``cards``: in card order (name, set, collector number). Both empty when nothing is offered."""
    locations: list[TradeListLocation]
    cards: list[TradeListCard]


def own_trade_copies(conn, user_id: str, edition_ids: Iterable[UUID] | None = None) -> dict[UUID, int]:
    """The collector's listable copies of each Edition among ``edition_ids`` (None: every Edition), through the one
    listable rule; Editions with none are absent. Runs on the caller's connection and transaction, so a Trade step can
    read it under its own locks: it sets no isolation level and takes no lock."""
    editions = None if edition_ids is None else sorted(set(edition_ids))
    if editions == []:
        return {}
    return {row['edition_id']: int(row['listable']) for row in conn.execute(OWN_LISTABLE, (user_id, editions))}


def for_trade_places(conn, user_id: str, edition_ids: Iterable[UUID]) -> dict[UUID, list[dict]]:
    """The collector's own Holdings of these Editions in their For trade Locations (migration 140's rule, which never
    answers a Deck), hidden or not: per Edition, each Location's ``location_id``, ``name``, ``kind`` and ``held``
    copies. Runs on the caller's connection and transaction: the Trade Pick List (``app.trade_picks``) reads it under
    the collector's owner lock. Takes no lock and writes nothing."""
    editions = sorted(set(edition_ids))
    if not editions:
        return {}
    found: dict[UUID, list[dict]] = {}
    for row in conn.execute(FOR_TRADE_PLACES, (user_id, user_id, editions)):
        found.setdefault(row['edition_id'], []).append({
            'location_id': row['location_id'], 'name': row['name'], 'kind': row['kind'], 'held': int(row['quantity'])})
    return found


def tree_order(parents: dict[UUID, UUID | None], names: dict[UUID, str]) -> list[UUID]:
    """Every Location, parents before their children and siblings by name (case ignored), then id. Pure."""
    children: dict[UUID | None, list[UUID]] = {}
    for location, parent in parents.items():
        children.setdefault(parent if parent in parents else None, []).append(location)
    for siblings in children.values():
        siblings.sort(key=lambda location: (names[location].casefold(), str(location)))
    order: list[UUID] = []
    seen: set[UUID] = set()
    stack = list(reversed(children.get(None, [])))
    while stack:
        location = stack.pop()
        if location in seen:
            continue
        seen.add(location)
        order.append(location)
        stack.extend(reversed(children.get(location, [])))
    return order


def path_of(location: UUID, parents: dict[UUID, UUID | None], names: dict[UUID, str]) -> list[str]:
    """The names from the top of the tree down to ``location``. Pure."""
    found: list[str] = []
    seen: set[UUID] = set()
    current: UUID | None = location
    while current is not None and current in parents and current not in seen:
        seen.add(current)
        found.append(names[current])
        current = parents[current]
    return list(reversed(found))


def places_of(listable: int, held: dict[UUID, int], picked: dict[UUID | None, int],
              position: dict[UUID, int]) -> list[tuple[UUID, int]]:
    """Where one Edition's ``listable`` copies sit: per For trade Location in tree order (``position``), the copies
    ``held`` there less those reserving picks take there (``picked``), cut back from the last Location until they add
    up to ``listable``. Locations left with none are dropped. Pure."""
    found = [[location, held[location] - min(picked.get(location, 0), held[location])]
             for location in sorted(held, key=lambda location: position[location])]
    excess = sum(copies for _, copies in found) - listable
    for item in reversed(found):
        if excess <= 0:
            break
        cut = min(item[1], excess)
        item[1] -= cut
        excess -= cut
    return [(location, copies) for location, copies in found if copies > 0]


@router.get('/list', response_model=OwnTradeList)
def trade_list(user_id: str = Depends(verified_user)):
    """The collector's own Trade List: every card they offer now, with its copies and the For trade Locations those
    copies sit in. One snapshot, no lock, no write."""
    with connect() as conn, conn.transaction():
        # One snapshot binds the listable copies to the Holdings, picks and Locations that say where they sit.
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        listable = own_trade_copies(conn, user_id)
        if not listable:
            return OwnTradeList(locations=[], cards=[])
        rows = conn.execute(OWN_LOCATIONS, (user_id,)).fetchall()
        held: dict[UUID, dict[UUID, int]] = {}
        for row in conn.execute(FOR_TRADE_HOLDINGS, (user_id, user_id)):
            if row['edition_id'] in listable:
                held.setdefault(row['edition_id'], {})[row['location_id']] = int(row['quantity'])
        picked = counts.reserved_picks(conn, user_id, listable)
        cards = card_facts(conn, listable)
    parents = {row['id']: row['parent_id'] for row in rows}
    names = {row['id']: row['name'] for row in rows}
    hid = {row['id'] for row in rows if row['hidden']}
    above = hidden_by(parents, hid)
    position = {location: index for index, location in enumerate(tree_order(parents, names))}
    places = {edition: places_of(copies, held.get(edition, {}), picked.get(edition, {}), position)
              for edition, copies in listable.items()}
    used = sorted({location for found in places.values() for location, _ in found}, key=lambda item: position[item])
    return OwnTradeList(
        locations=[TradeListLocation(id=location, name=names[location], path=path_of(location, parents, names),
                                     hidden=location in hid or above[location] is not None) for location in used],
        cards=[TradeListCard(edition_id=card.edition_id, name=card.name, set_code=card.set_code,
                             set_name=card.set_name, collector_number=card.collector_number,
                             descriptor=card.descriptor, image_url=card.image_url,
                             copies=str(listable[card.edition_id]),
                             places=[TradeListPlace(location_id=location, copies=str(copies))
                                     for location, copies in places[card.edition_id]])
               for card in sorted(cards.values(), key=lambda card: card.order())])
