"""The Trade Pick List (Trading #270, spec "Reservations and the Trade Pick List"): where a Trade side's giver takes
each promised copy from, made when that side's copies start to reserve, and which picks a Move or a Removal left out of
date (Trading #272).

A side's copies come only from the giver's own For trade Locations (``trade_list.for_trade_places``, hidden or not,
never a Deck), largest Holding first, then by Location name (case ignored), then id: the Deck Pick List's order for
loose storage (``deck_pick_list.suggest``). Copies other reserving Loan and Trade picks still cover there
(``loan_picks.pick_shortfalls``) are left for them, so the same copy is never picked twice. The caller holds the giver's
owner row lock and checked each Edition's listable copies (``trade_list.own_trade_copies``), which never exceed the For
trade copies no other pick covers, so the picks always cover the promise.

**Stale picks are computed, not stored**, as for Loans: a pick is out of date when its source no longer holds its
copies after the older picks there (``pick_shortfalls``), for instance after a Move. ``stale_pick_trades`` says which
of a collector's Trades have one; ``replacement_trade_picks`` is **Use suggested picks**: the copies a side's picks
still cover stay where they are, and the rest come from the giver's For trade copies no pick covers first, then from
any of their Locations in the Deck Pick List's order (``copy_picks.suggest_picks``, the Loan Pick List's), so a
Move never strands a Trade.

This is the giver's own read and write, outside ``/api/social``.
"""
from uuid import UUID

from .copy_picks import suggest_picks
from .deck_pick_list import suggest
from .loan_picks import pick_shortfalls
from .trade_list import for_trade_places


def _for_trade_suggestion(conn, owner_id: str, promised: dict[UUID, int], covered: dict[UUID, dict]
                          ) -> dict[tuple[UUID, UUID], int]:
    """Where the giver's For trade copies no other pick covers (``covered``) take ``promised`` copies from, per Edition,
    in the Deck Pick List's order: as many as there are, which may be fewer than promised. Returns copies by (Edition
    id, Location id)."""
    editions = sorted(edition for edition, copies in promised.items() if copies > 0)
    if not editions:
        return {}
    places = for_trade_places(conn, owner_id, editions)
    found: dict[tuple[UUID, UUID], int] = {}
    for edition in editions:
        taken = covered.get(edition, {})
        free = []
        for place in places.get(edition, []):
            left = place['held'] - min(place['held'], taken.get(place['location_id'], 0))
            free.append({'location_id': place['location_id'], 'name': place['name'], 'kind': place['kind'],
                         'available': left, 'committed': 0, 'spare': left})
        for place, copies in suggest(promised[edition], free):
            if copies > 0:
                found[(edition, place['location_id'])] = copies
    return found


def suggest_trade_picks(conn, owner_id: str, promised: dict[UUID, int]) -> dict[tuple[UUID, UUID], int]:
    """Where to take ``promised`` copies per Edition from: the giver's For trade copies no other pick covers, in the
    Deck Pick List's order. Returns copies by (Edition id, Location id). Raises RuntimeError when they fall short, which
    the listable check before it rules out."""
    editions = sorted(edition for edition, copies in promised.items() if copies > 0)
    if not editions:
        return {}
    _, _, covered = pick_shortfalls(conn, owner_id, editions)
    found = _for_trade_suggestion(conn, owner_id, promised, covered)
    for edition in editions:
        if sum(copies for (picked, _), copies in found.items() if picked == edition) != promised[edition]:
            raise RuntimeError('the For trade copies no other pick covers fall short of a checked promise')
    return found


def insert_trade_picks(conn, owner_id: str, trade_id: UUID, side: str, picks: dict[tuple[UUID, UUID], int]) -> None:
    """Inserts one side's picks (``side``: 'proposer' or 'recipient', the giver's side of the Trade), in Edition then
    Location order."""
    for (edition, location), copies in sorted(picks.items(), key=lambda item: (str(item[0][0]), str(item[0][1]))):
        conn.execute("""INSERT INTO trade_pick(trade_id, side, owner_id, edition_id, source_location_id, quantity)
          VALUES (%s, %s, %s, %s, %s, %s)""", (trade_id, side, owner_id, edition, location, copies))


def make_trade_picks(conn, owner_id: str, trade_id: UUID, side: str, promised: dict[UUID, int]) -> None:
    """The Trade Pick List for one side's newly promised copies (``side``: 'proposer' or 'recipient', the giver's side
    of the Trade), inserted in Edition then Location order."""
    insert_trade_picks(conn, owner_id, trade_id, side, suggest_trade_picks(conn, owner_id, promised))


def trade_pick_shortfalls(conn, owner_id: str, trade_ids: set[UUID]
                          ) -> tuple[list[dict], dict[int, int], dict[UUID, dict]]:
    """The owner's reserving picks of these Trades as ``loan_picks.pick_shortfalls`` reads them (keys ``id``,
    ``trade_id``, ``edition_id``, ``source_location_id`` and ``quantity``, oldest accepted first), with every pick's
    shortfall: (the picks of these Trades, copies short by pick id, copies every reserving pick still covers by Edition
    and Location). A side that no longer reserves has no picks here. Takes no lock."""
    editions = [row['edition_id'] for row in conn.execute(
        'SELECT DISTINCT edition_id FROM trade_pick WHERE trade_id = ANY(%s) AND owner_id = %s',
        (sorted(trade_ids, key=str), owner_id))]
    if not editions:
        return [], {}, {}
    picks, short, covered = pick_shortfalls(conn, owner_id, editions)
    return [pick for pick in picks if pick['trade_id'] in trade_ids], short, covered


def stale_pick_trades(conn, owner_id: str, trade_ids) -> set[UUID]:
    """Which of these Trades have a reserving pick of the owner's out of date: one read of their picks and one
    ``pick_shortfalls`` over all their Editions, whatever the number of Trades. Only a side that still reserves has
    reserving picks, so a side that confirmed its swap, or a closed Trade, is never stale. The caller holds the owner's
    lock (a step), or reads without one."""
    wanted = set(trade_ids)
    if not wanted:
        return set()
    picks, short, _ = trade_pick_shortfalls(conn, owner_id, wanted)
    return {pick['trade_id'] for pick in picks if short[pick['id']] > 0}


def replacement_trade_picks(conn, owner_id: str, trade_id: UUID) -> dict[tuple[UUID, UUID], int] | None:
    """The owner's picks of one Trade with every out-of-date pick replaced (**Use suggested picks**): the copies its
    picks still cover where they are, and the rest from the owner's For trade copies no pick covers, then from any of
    their Locations in the Deck Pick List's order. Returns copies by (Edition id, Location id), or None when no pick is
    out of date. The caller holds the owner's lock."""
    mine, short, covered = trade_pick_shortfalls(conn, owner_id, {trade_id})
    if not any(short[pick['id']] for pick in mine):
        return None
    kept: dict[tuple[UUID, UUID], int] = {}
    missing: dict[UUID, int] = {}
    for pick in mine:
        if int(pick['quantity']) > short[pick['id']]:
            key = (pick['edition_id'], pick['source_location_id'])
            kept[key] = kept.get(key, 0) + int(pick['quantity']) - short[pick['id']]
        missing[pick['edition_id']] = missing.get(pick['edition_id'], 0) + short[pick['id']]
    first = _for_trade_suggestion(conn, owner_id, missing, covered)
    rest = dict(missing)
    taken = {edition: dict(places) for edition, places in covered.items()}
    for (edition, location), copies in first.items():
        kept[(edition, location)] = kept.get((edition, location), 0) + copies
        rest[edition] -= copies
        taken.setdefault(edition, {})[location] = taken.get(edition, {}).get(location, 0) + copies
    for key, copies in suggest_picks(conn, owner_id, rest, taken).items():
        kept[key] = kept.get(key, 0) + copies
    return kept
