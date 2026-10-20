"""Friend-facing reads: the one choke point (social network #250, ADR 0014, spec "Friend-facing reads: one choke point";
ADR 0015, Trading #269).

This module is the only code in the API that reads another collector's inventory. ``friend_copies`` answers, per Friend
and Card Edition, how many copies that Friend could lend now: ``spare`` and ``in_deck``. Every Friend-facing lending
figure (a Friend's Collection, the Want List's Friend matches, the card popup's "Friends who have this") comes from it.
``friend_trade_copies`` answers how many copies a Friend lists on their Trade List now (Trading #269), the cards a
Friend's Trade List shows. Neither ever answers a Location or a Deck, by name or by id.

One statement reads, for every Friend asked about at once:

- only Friends: an accepted friendship with no Block either way (``friends_of``, migration 103);
- their Holdings of the Editions asked about, leaving out every hidden Location and everything inside it
  (``hidden_locations``, migration 101), so hiding a Location, adding one inside a hidden one or moving one in or out
  shows at once;
- and, beside each Holding, the quantity of that Location's own Deck List line for the Edition, when the Location is a
  Deck that lists it.

Location ids never leave the statement: each Holding is keyed by its row number when it is paired with its line. The
copies reserved for open Loans (``counts.reserved_by_owner``) are then taken off, and the shared Spare Copy rule
(``copy_allocation.spare_rule``) splits what is left: reserved copies come out of the Spare Copies first, then out of
copies a Deck holds for its own line. Lent copies are not in ``holding`` and Borrowed Copies are in their own table, so
neither is ever read. A Friend's Holdings in hidden Locations count for nothing here, reserved copies included: a
Friend may see fewer copies than they could lend, never more.

The read is batched across Friends and Editions: one index range of ``holding`` per Friend, paired in memory, never a
query or an allocation per Friend. It takes no lock: a Friend read never waits on a Friend's writes, and one statement
reads one snapshot of their Holdings and Deck Lists. Callers run it outside any transaction that holds the viewer's
owner lock.

**A Friend's Trade List** (``friend_trade_copies``, ``TRADE_READ``) is one statement too: the same Friends only, joined
to migration 142's one listable rule, which the collector's own Trade List (``app.trade_list``) also calls, so the two
can never disagree. For trade membership comes from that rule with no hidden filter: a hidden For trade Location's
cards are listed, and its name and id never leave the statement. Promised copies are left out by the rule, Decks are
never For trade, lent copies are in no Holding and Borrowed Copies are never read. Only positive counts come back. It
takes no lock and sets no isolation level, so a Trade step can call it on its own connection, under its own locks.
"""
from collections.abc import Iterable
from dataclasses import dataclass
from uuid import UUID

from .. import copy_allocation
from . import counts


@dataclass(frozen=True)
class FriendCopies:
    """A Friend's copies of one Card Edition that they could lend now: ``spare`` copies (loose, or beyond a Deck's own
    line) and ``in_deck`` copies (held by a Deck for its own line). At least one of the two is above zero."""
    friend_id: str
    edition_id: UUID
    spare: int
    in_deck: int


# The one statement. %(friends)s and %(editions)s are NULL for every Friend and every Edition.
READ = """WITH friend AS (
    SELECT f.friend_id FROM friends_of(ARRAY[%(viewer)s]::text[]) f
    WHERE %(friends)s::text[] IS NULL OR f.friend_id = ANY(%(friends)s::text[])
  ), hidden AS MATERIALIZED (
    SELECT x.owner_id, x.location_id FROM hidden_locations(ARRAY(SELECT friend_id FROM friend)) x
  )
  SELECT h.owner_id AS friend_id, h.edition_id, h.quantity AS held, l.quantity AS listed
  FROM friend
  JOIN holding h ON h.owner_id = friend.friend_id
  LEFT JOIN hidden ON hidden.owner_id = h.owner_id AND hidden.location_id = h.location_id
  LEFT JOIN deck_list_line l ON l.owner_id = h.owner_id AND l.deck_id = h.location_id AND l.edition_id = h.edition_id
  WHERE hidden.location_id IS NULL
    AND (%(editions)s::uuid[] IS NULL OR h.edition_id = ANY(%(editions)s::uuid[]))"""


def friend_copies(conn, viewer_id: str, friend_ids: Iterable[str] | None = None,
                  edition_ids: Iterable[UUID] | None = None) -> list[FriendCopies]:
    """What the viewer's Friends among ``friend_ids`` (None: every Friend) could lend now of ``edition_ids`` (None:
    every Edition), by Friend id then Edition id. Anyone who isn't the viewer's Friend is simply absent, as is every
    Edition a Friend could lend none of."""
    friends = None if friend_ids is None else sorted(set(friend_ids))
    editions = None if edition_ids is None else sorted(set(edition_ids))
    if friends == [] or editions == []:
        return []
    held: dict[tuple[str, UUID], dict[int, int]] = {}
    lines: dict[tuple[str, UUID], dict[int, int]] = {}
    rows = conn.execute(READ, {'viewer': viewer_id, 'friends': friends, 'editions': editions}).fetchall()
    for number, row in enumerate(rows):
        key = (row['friend_id'], row['edition_id'])
        # The row number stands for the Holding's Location, which this read never answers.
        held.setdefault(key, {})[number] = row['held']
        if row['listed'] is not None:
            lines.setdefault(key, {})[number] = row['listed']
    if not held:
        return []
    reserved = counts.reserved_by_owner(conn, {friend for friend, _ in held}, {edition for _, edition in held})
    found = []
    for key in sorted(held):
        rule = copy_allocation.spare_rule(held[key], lines.get(key, {}), reserved.get(key, 0))
        if rule.lendable:
            found.append(FriendCopies(friend_id=key[0], edition_id=key[1], spare=rule.spare,
                                      in_deck=rule.lendable_in_deck))
    return found


@dataclass(frozen=True)
class TradeCopies:
    """A Friend's copies of one Card Edition on their Trade List now: ``listable``, always above zero."""
    friend_id: str
    edition_id: UUID
    listable: int


# The Trade List statement. %(friends)s and %(editions)s are NULL for every Friend and every Edition.
TRADE_READ = """WITH friend AS (
    SELECT f.friend_id FROM friends_of(ARRAY[%(viewer)s]::text[]) f
    WHERE %(friends)s::text[] IS NULL OR f.friend_id = ANY(%(friends)s::text[])
  )
  SELECT t.owner_id AS friend_id, t.edition_id, t.listable
  FROM trade_listable(ARRAY(SELECT friend_id FROM friend), %(editions)s::uuid[]) t
  ORDER BY t.owner_id, t.edition_id"""


def friend_trade_copies(conn, viewer_id: str, friend_ids: Iterable[str] | None = None,
                        edition_ids: Iterable[UUID] | None = None) -> list[TradeCopies]:
    """What the viewer's Friends among ``friend_ids`` (None: every Friend) list on their Trade Lists now, of
    ``edition_ids`` (None: every Edition), by Friend id then Edition id. Anyone who isn't the viewer's Friend is absent,
    as is every Edition a Friend lists none of. Runs on the caller's connection and transaction."""
    friends = None if friend_ids is None else sorted(set(friend_ids))
    editions = None if edition_ids is None else sorted(set(edition_ids))
    if friends == [] or editions == []:
        return []
    return [TradeCopies(friend_id=row['friend_id'], edition_id=row['edition_id'], listable=int(row['listable']))
            for row in conn.execute(TRADE_READ, {'viewer': viewer_id, 'friends': friends, 'editions': editions})]
