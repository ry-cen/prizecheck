"""Where a giver's copies come from, for the picks Loans and Trades reserve (Loans #252, Trading #270).

Neutral ground for both: the Loan Pick List (``loan_inventory``) and the Trade Pick List (``trade_picks``) take copies
in the Deck Pick List's order (``deck_pick_list.suggest``), so ``suggest_picks`` lives here and imports neither.
"""
from uuid import UUID

from .deck_pick_list import suggest


def _places(conn, lender_id: str, editions) -> dict[UUID, list[dict]]:
    """The lender's Holdings of the Editions as places for ``deck_pick_list.suggest``: per Edition, each Location with
    its name, kind, copies, the copies a Deck holds there for its own line (``committed``) and the rest (``spare``)."""
    places: dict[UUID, list[dict]] = {}
    for row in conn.execute("""SELECT h.location_id, h.edition_id, h.quantity, l.name, l.kind, d.quantity AS listed
      FROM holding h JOIN location l ON l.owner_id = h.owner_id AND l.id = h.location_id
      LEFT JOIN deck_list_line d ON d.owner_id = h.owner_id AND d.deck_id = h.location_id AND d.edition_id = h.edition_id
      WHERE h.owner_id = %s AND h.edition_id = ANY(%s)""", (lender_id, sorted(set(editions)))):
        own = min(row['listed'] or 0, row['quantity']) if row['kind'] == 'deck' else 0
        places.setdefault(row['edition_id'], []).append({
            'location_id': row['location_id'], 'name': row['name'], 'kind': row['kind'],
            'available': int(row['quantity']), 'committed': int(own), 'spare': int(row['quantity'] - own)})
    return places


def _without(places: list[dict], taken: dict) -> list[dict]:
    """The places less the copies other picks take there ({Location id: copies}), out of the copies beyond a Deck's
    line first, as the Loan Pick List takes them."""
    free = []
    for place in places:
        gone = min(place['available'], taken.get(place['location_id'], 0))
        spare = max(0, place['spare'] - gone)
        free.append({**place, 'available': place['available'] - gone, 'spare': spare,
                     'committed': place['available'] - gone - spare})
    return free


def suggest_picks(conn, lender_id: str, promised: dict[UUID, int], covered: dict[UUID, dict]
                  ) -> dict[tuple[UUID, UUID], int]:
    """Where to take ``promised`` copies per Edition from: the copies no other pick covers (``covered``), in the Deck
    Pick List's order. Returns copies by (Edition id, Location id). The caller holds the lender's owner row lock and
    checked the copies are there (``can_promise``, or the invariant for picks already promised)."""
    editions = sorted(edition for edition, copies in promised.items() if copies > 0)
    places = _places(conn, lender_id, editions) if editions else {}
    found: dict[tuple[UUID, UUID], int] = {}
    for edition in editions:
        for place, copies in suggest(promised[edition], _without(places.get(edition, []), covered.get(edition, {}))):
            if copies > 0:
                found[(edition, place['location_id'])] = found.get((edition, place['location_id']), 0) + copies
    return found
