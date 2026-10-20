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

**A Friend's Trade List** (``friend_trade_copies``, ``TRADE_READ``) is one statement too (two when asked about every
Friend: ``TRADE_FRIENDS`` names them first): the same Friends only, joined to migration 142's one listable rule, which
the collector's own Trade List (``app.trade_list``) also calls, so the two can never disagree. For trade membership
comes from that rule with no hidden filter: a hidden For trade Location's cards are listed, and its name and id never
leave the statement. Promised copies are left out by the rule, Decks are never For trade, lent copies are in no Holding
and Borrowed Copies are never read. Only positive counts come back. It takes no lock and sets no isolation level, so a
Trade step can call it on its own connection, under its own locks.

**A Friend's wants** (``friend_wants``, Trading #276) answer, per Friend and Card Edition, what discovery may show of
what they want: the Want List part (``want_list_need``), their Trade Wants line for that exact Edition and their Will
accept choice, which widens the Want List part only. The Want List part is counted as their own Want List counts it:
the batched ``WANTS_*`` statements read, for every Friend at once, the inputs ``copy_allocation.allocate_rows`` needs
(their Holdings, Deck List lines, Decks' creation times, reserved copies and their picks, lent copies and where they
came from, and the Borrowed Copies in their Decks), and their counting setting. Each Friend's rows are counted in
memory over every Deck, hidden ones included, so an older hidden Deck still takes Spare Copies in the usual order; only
then are the lines of Decks inside their Hidden Locations dropped, and the rest combined per Edition by sum (Every Deck
built at once) or largest (One Deck at a time). So a Deck outside their Hidden Locations needs exactly what their own
Want List says. The read is restricted to the Editions asked about, and Friends whose Deck Lists name none of them are
skipped before anything is allocated. It answers counts and a rule only, never a Deck or a Location, and reads Borrowed
Copies only to count the Friend's own Deck lines. It takes no lock and sets no isolation level: discovery
(``social.trade_matches``) calls it inside one read-only repeatable-read transaction, so every statement reads one
snapshot and never waits on a Friend's writes.
"""
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from .. import copy_allocation
from ..copy_allocation import AllocationRows, allocate_rows
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


# The viewer's Friends among %(friends)s (NULL: every Friend), for a Trade List read asked about every Friend.
TRADE_FRIENDS = """SELECT f.friend_id FROM friends_of(ARRAY[%(viewer)s]::text[]) f
  WHERE %(friends)s::text[] IS NULL OR f.friend_id = ANY(%(friends)s::text[])"""
# The Trade List statement, for the collectors in %(friends)s (never NULL) that are the viewer's Friends; %(editions)s is
# NULL for every Edition. The listable rule is given the ids as a value, never a sub-select, so PostgreSQL plans it for
# the collectors and Editions it is asked about (trading #276: with a sub-select it can't, and 200 Friends took ten
# times as long); the join keeps only Friends.
TRADE_READ = """WITH friend AS (
    SELECT f.friend_id FROM friends_of(ARRAY[%(viewer)s]::text[]) f WHERE f.friend_id = ANY(%(friends)s::text[])
  )
  SELECT t.owner_id AS friend_id, t.edition_id, t.listable
  FROM trade_listable(%(friends)s::text[], %(editions)s::uuid[]) t
  JOIN friend ON friend.friend_id = t.owner_id
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
    if friends is None:
        friends = sorted(row['friend_id'] for row in conn.execute(
            TRADE_FRIENDS, {'viewer': viewer_id, 'friends': None}))
        if not friends:
            return []
    return [TradeCopies(friend_id=row['friend_id'], edition_id=row['edition_id'], listable=int(row['listable']))
            for row in conn.execute(TRADE_READ, {'viewer': viewer_id, 'friends': friends, 'editions': editions})]


@dataclass(frozen=True)
class FriendWant:
    """What one Friend wants of one Card Edition (Trading #276): ``want_list_need``, what their Want List still needs of
    it over the Decks outside their Hidden Locations, combined by their counting setting; ``trade_wants_quantity``, their
    Trade Wants line for this exact Edition; ``rule``, their Will accept choice for it (``'edition'``, ``'printing'`` or
    ``'identity'``), which widens the Want List part only. At least one of the two parts is above zero."""
    friend_id: str
    edition_id: UUID
    want_list_need: int
    trade_wants_quantity: int
    rule: str


# The Friends among %(friends)s (NULL: every Friend) whose Deck Lists name one of %(editions)s (NULL: every Edition),
# and whether their Trade Wants do. Only the Friends with either go further.
WANTS_FRIENDS = """WITH friend AS (
    SELECT f.friend_id FROM friends_of(ARRAY[%(viewer)s]::text[]) f
    WHERE %(friends)s::text[] IS NULL OR f.friend_id = ANY(%(friends)s::text[])
  )
  SELECT friend.friend_id,
    EXISTS (SELECT 1 FROM deck_list_line l WHERE l.owner_id = friend.friend_id
      AND (%(editions)s::uuid[] IS NULL OR l.edition_id = ANY(%(editions)s::uuid[]))) AS lists,
    EXISTS (SELECT 1 FROM trade_want w WHERE w.owner_id = friend.friend_id
      AND (%(editions)s::uuid[] IS NULL OR w.edition_id = ANY(%(editions)s::uuid[]))) AS wants
  FROM friend"""
# What ``copy_allocation.read_allocation_rows`` reads for one owner, here for every listed Friend at once.
EDITIONS = '(%(editions)s::uuid[] IS NULL OR {column} = ANY(%(editions)s::uuid[]))'
WANTS_LINES = f"""SELECT owner_id, deck_id, edition_id, quantity FROM deck_list_line
  WHERE owner_id = ANY(%(owners)s::text[]) AND {EDITIONS.format(column='edition_id')}"""
# Only the Holdings of Editions a Deck List line of their owner names take part in the count.
WANTS_HOLDINGS = f"""WITH named AS (
    SELECT DISTINCT owner_id, edition_id FROM deck_list_line
    WHERE owner_id = ANY(%(owners)s::text[]) AND {EDITIONS.format(column='edition_id')}
  )
  SELECT h.owner_id, h.location_id, h.edition_id, h.quantity
  FROM named JOIN holding h ON h.owner_id = named.owner_id AND h.edition_id = named.edition_id"""
WANTS_DECKS = """SELECT owner_id, id, created_at FROM location
  WHERE owner_id = ANY(%(owners)s::text[]) AND id = ANY(%(decks)s::uuid[])"""
WANTS_COUNTING = 'SELECT user_id, want_list_counting FROM inventory_owner WHERE user_id = ANY(%(owners)s::text[])'
WANTS_PICKED = """SELECT owner_id, edition_id, source_location_id, sum(quantity)::bigint AS copies
  FROM reserving_picks(%(owners)s::text[], %(editions)s::uuid[])
  GROUP BY owner_id, edition_id, source_location_id"""
WANTS_LENT = f"""SELECT p.owner_id, p.edition_id, p.source_location_id, sum(p.quantity)::bigint AS copies
  FROM loan o JOIN loan_pick p ON p.loan_id = o.id
  WHERE p.owner_id = ANY(%(owners)s::text[]) AND o.lender_id = p.owner_id AND p.state = 'lent' AND {counts.LENDING}
    AND {EDITIONS.format(column='p.edition_id')}
  GROUP BY p.owner_id, p.edition_id, p.source_location_id"""
WANTS_BORROWED = f"""SELECT borrower_id AS owner_id, location_id, edition_id, sum(quantity)::bigint AS copies
  FROM borrowed_holding
  WHERE borrower_id = ANY(%(owners)s::text[]) AND location_id = ANY(%(decks)s::uuid[])
    AND {EDITIONS.format(column='edition_id')}
  GROUP BY borrower_id, location_id, edition_id"""
WANTS_HIDDEN = 'SELECT x.owner_id, x.location_id FROM hidden_locations(%(owners)s::text[]) x'
WANTS_TRADE = f"""SELECT owner_id, edition_id, quantity FROM trade_want
  WHERE owner_id = ANY(%(owners)s::text[]) AND {EDITIONS.format(column='edition_id')}"""
WANTS_RULES = f"""SELECT owner_id, edition_id, rule FROM trade_accept
  WHERE owner_id = ANY(%(owners)s::text[]) AND {EDITIONS.format(column='edition_id')}"""


def friend_wants(conn, viewer_id: str, friend_ids: Iterable[str] | None = None,
                 edition_ids: Iterable[UUID] | None = None) -> list[FriendWant]:
    """What the viewer's Friends among ``friend_ids`` (None: every Friend) want of ``edition_ids`` (None: every
    Edition), by Friend id then Edition id; see the module docstring. Anyone who isn't the viewer's Friend is absent, as
    is every Edition a Friend wants none of. A fixed number of statements for any number of Friends, and no lock: the
    caller runs it in one read-only repeatable-read transaction."""
    friends = None if friend_ids is None else sorted(set(friend_ids))
    editions = None if edition_ids is None else sorted(set(edition_ids))
    if friends == [] or editions == []:
        return []
    rows = conn.execute(WANTS_FRIENDS, {'viewer': viewer_id, 'friends': friends, 'editions': editions}).fetchall()
    listing = sorted(row['friend_id'] for row in rows if row['lists'])
    wanting = sorted(row['friend_id'] for row in rows if row['wants'])
    needs = _want_list_needs(conn, listing, editions) if listing else {}
    trade = {}
    if wanting:
        trade = {(row['owner_id'], row['edition_id']): int(row['quantity']) for row in conn.execute(
            WANTS_TRADE, {'owners': wanting, 'editions': editions})}
    rules = {}
    if listing:
        rules = {(row['owner_id'], row['edition_id']): row['rule'] for row in conn.execute(
            WANTS_RULES, {'owners': listing, 'editions': editions})}
    return [FriendWant(friend_id=key[0], edition_id=key[1], want_list_need=needs.get(key, 0),
                       trade_wants_quantity=trade.get(key, 0), rule=rules.get(key, 'edition'))
            for key in sorted(set(needs) | set(trade))]


def _want_list_needs(conn, owners: list[str], editions: list[UUID] | None) -> dict[tuple[str, UUID], int]:
    """Each listed Friend's Want List need per Edition over their Decks outside their Hidden Locations: one
    ``AllocationRows`` per Friend from the batched statements, counted by ``allocate_rows`` over every Deck, then the
    hidden Decks' lines dropped, then combined by the Friend's counting setting. Pairs with no need are absent."""
    lines: dict[str, list[tuple[UUID, UUID, int]]] = {}
    for row in conn.execute(WANTS_LINES, {'owners': owners, 'editions': editions}):
        lines.setdefault(row['owner_id'], []).append((row['deck_id'], row['edition_id'], int(row['quantity'])))
    if not lines:
        return {}
    owners = sorted(lines)
    decks = sorted({deck for found in lines.values() for deck, _, _ in found})
    # From here on, only the Editions those lines name: allocation counts nothing else.
    args = {'owners': owners, 'editions': sorted({edition for found in lines.values() for _, edition, _ in found})}
    holdings: dict[str, list[tuple[UUID, UUID, int]]] = {}
    for row in conn.execute(WANTS_HOLDINGS, args):
        holdings.setdefault(row['owner_id'], []).append((row['location_id'], row['edition_id'], int(row['quantity'])))
    created: dict[str, dict[UUID, datetime]] = {}
    for row in conn.execute(WANTS_DECKS, {'owners': owners, 'decks': decks}):
        created.setdefault(row['owner_id'], {})[row['id']] = row['created_at']
    counting = {row['user_id']: row['want_list_counting'] for row in conn.execute(WANTS_COUNTING, args)}
    reserved: dict[str, dict[UUID, int]] = {}
    for (owner, edition), copies in counts.reserved_by_owner(conn, owners, args['editions']).items():
        reserved.setdefault(owner, {})[edition] = copies
    picked: dict[str, dict[UUID, dict[UUID | None, int]]] = {}
    for row in conn.execute(WANTS_PICKED, args):
        # Picks of an Edition with nothing reserved place nothing, as the single-owner reader leaves them unread.
        if row['edition_id'] in reserved.get(row['owner_id'], {}):
            picked.setdefault(row['owner_id'], {}).setdefault(row['edition_id'], {})[row['source_location_id']] = \
                int(row['copies'])
    lent_at: dict[str, dict[UUID, dict[UUID | None, int]]] = {}
    for row in conn.execute(WANTS_LENT, args):
        lent_at.setdefault(row['owner_id'], {}).setdefault(row['edition_id'], {})[row['source_location_id']] = \
            int(row['copies'])
    borrowed: dict[str, dict[tuple[UUID, UUID], int]] = {}
    for row in conn.execute(WANTS_BORROWED, {**args, 'decks': decks}):
        borrowed.setdefault(row['owner_id'], {})[(row['location_id'], row['edition_id'])] = int(row['copies'])
    hidden: dict[str, set[UUID]] = {}
    for row in conn.execute(WANTS_HIDDEN, args):
        hidden.setdefault(row['owner_id'], set()).add(row['location_id'])
    found: dict[tuple[str, UUID], int] = {}
    for owner in owners:
        mine = lines.get(owner, [])
        if not mine:
            continue
        lent = {edition: sum(places.values()) for edition, places in lent_at.get(owner, {}).items()}
        rows = AllocationRows(holdings=tuple(holdings.get(owner, ())), lines=tuple(mine),
                              deck_created=created.get(owner, {}), reserved=reserved.get(owner, {}),
                              picked=picked.get(owner, {}), lent=lent, lent_at=lent_at.get(owner, {}),
                              borrowed=borrowed.get(owner, {}))
        setting = counting.get(owner, 'all_at_once')
        allocation = allocate_rows(rows, {edition for _, edition, _ in mine}, setting)
        shown: dict[UUID, list[int]] = {}
        for (deck, edition), line in allocation.lines.items():
            # Every Deck took part in the count; only the Decks outside Hidden Locations are shown.
            if line.need > 0 and deck not in hidden.get(owner, set()):
                shown.setdefault(edition, []).append(line.need)
        pick = sum if setting == 'all_at_once' else max
        for edition, needs in shown.items():
            found[(owner, edition)] = pick(needs)
    return found
