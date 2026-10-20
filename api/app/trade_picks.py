"""The Trade Pick List (Trading #270, spec "Reservations and the Trade Pick List"): where a Trade side's giver takes each
promised copy from, made when that side's copies start to reserve.

A side's copies come only from the giver's own For trade Locations (``trade_list.for_trade_places``, hidden or not,
never a Deck), largest Holding first, then by Location name (case ignored), then id: the Deck Pick List's order for
loose storage (``deck_pick_list.suggest``). Copies other reserving Loan and Trade picks still cover there
(``loan_picks.pick_shortfalls``) are left for them, so the same copy is never picked twice. The caller holds the giver's
owner row lock and checked each Edition's listable copies (``trade_list.own_trade_copies``), which never exceed the For
trade copies no other pick covers, so the picks always cover the promise.

This is the giver's own read and write, outside ``/api/social``. Stale Trade picks and Use suggested picks are Trading
#272's.
"""
from uuid import UUID

from .deck_pick_list import suggest
from .loan_picks import pick_shortfalls
from .trade_list import for_trade_places


def suggest_trade_picks(conn, owner_id: str, promised: dict[UUID, int]) -> dict[tuple[UUID, UUID], int]:
    """Where to take ``promised`` copies per Edition from: the giver's For trade copies no other pick covers, in the
    Deck Pick List's order. Returns copies by (Edition id, Location id). Raises RuntimeError when they fall short, which
    the listable check before it rules out."""
    editions = sorted(edition for edition, copies in promised.items() if copies > 0)
    if not editions:
        return {}
    _, _, covered = pick_shortfalls(conn, owner_id, editions)
    places = for_trade_places(conn, owner_id, editions)
    found: dict[tuple[UUID, UUID], int] = {}
    for edition in editions:
        taken = covered.get(edition, {})
        free = []
        for place in places.get(edition, []):
            left = place['held'] - min(place['held'], taken.get(place['location_id'], 0))
            free.append({'location_id': place['location_id'], 'name': place['name'], 'kind': place['kind'],
                         'available': left, 'committed': 0, 'spare': left})
        picked = 0
        for place, copies in suggest(promised[edition], free):
            if copies > 0:
                found[(edition, place['location_id'])] = copies
                picked += copies
        if picked != promised[edition]:
            raise RuntimeError('the For trade copies no other pick covers fall short of a checked promise')
    return found


def make_trade_picks(conn, owner_id: str, trade_id: UUID, side: str, promised: dict[UUID, int]) -> None:
    """The Trade Pick List for one side's newly promised copies (``side``: 'proposer' or 'recipient', the giver's side
    of the Trade), inserted in Edition then Location order."""
    picks = suggest_trade_picks(conn, owner_id, promised)
    for (edition, location), copies in sorted(picks.items(), key=lambda item: (str(item[0][0]), str(item[0][1]))):
        conn.execute("""INSERT INTO trade_pick(trade_id, side, owner_id, edition_id, source_location_id, quantity)
          VALUES (%s, %s, %s, %s, %s, %s)""", (trade_id, side, owner_id, edition, location, copies))
