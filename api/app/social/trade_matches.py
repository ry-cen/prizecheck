"""A Friend's Trade List (Trading #269), discovery among Friends and Ask to trade (Trading #276; spec "Matching reads
and the choke point").

``GET /api/social/trade-lists/{handle}`` answers the cards one Friend offers to trade now, each with how many copies,
from ``friend_copies.friend_trade_copies`` and nothing else: Card Edition facts and a count, never a Location or a
Deck, by name or by id, hidden or not. The Friend is found by Handle among the viewer's Friends only, with the
statement a Friend's Collection uses, so an unknown Handle, a collector who isn't a Friend, a pending Friend Request
either way, a Block either way and the viewer's own Handle all get the same 404 FRIEND_NOT_FOUND.

- ``q`` keeps the cards whose name contains it, comparing letters and digits only, as a Friend's Collection does.
- Cards come in card order (name, set, collector number), and pages hold ``PAGE_IDENTITIES`` Card Identities each,
  with every listed Edition of those Identities, so one card's Editions are never split over two pages.

**Discovery** (``GET /api/social/trade-matches``) answers one row per Friend who matches: the cards the viewer would
get (the Friend's Trade List copies that one of the viewer's wants accepts) and the cards they would give (the viewer's
Trade List copies that one of the Friend's wants accepts). It reads, in order:

1. the viewer's Want List need per Card Edition over every Deck, hidden ones included, combined by their counting
   setting (``want_list.capture_want_list``, in its own transaction under the viewer's own owner lock, as the Want
   List's Friend matches read it);
2. in one read-only repeatable-read snapshot of the viewer's own rows, their Trade Wants (``trade_wants.own_wants``),
   their widened Will accept choices (``trade_wants.own_rules``) and their Trade List
   (``trade_list.own_trade_copies``);
3. on a separate connection, in one read-only repeatable-read transaction that takes no lock, the viewer's Friends
   (``friends.friend_ids``), their profiles, their Trade List copies of every Edition one of the viewer's wants accepts
   (``friend_copies.friend_trade_copies``) and their wants of every Edition sharing a Card Identity with a card on the
   viewer's Trade List, the widest Will accept (``friend_copies.friend_wants``);

and pairs them in memory. A want's Will accept rule (``card_accepts.accepts``) widens only its Want List part; a Trade
Wants line always matches its exact Edition. A card's ``need`` is what the side that would receive it wants of it in
total: ``want_list_need``, the sum of the Want List parts of that side's wants that accept it, plus that side's Trade
Wants line for the card itself. ``origin`` says which parts are above zero. ``accepts_as``, on the cards the viewer would
get only, is the narrowest way one of the viewer's wants takes the card: ``exact`` when the card is itself one of their
wants, else ``any_finish`` when it is another finish of a wanted card's own Card Printing, else ``same_name``. The
collector's own spare copies of an accepted card reduce no need until a Deck line is switched to it (the Want List's
Swap hint). Rows come two-way first, then Friends who have what the viewer wants, then Friends who want what the viewer
has, then by Display Name and Handle (case ignored), each with at most ``CARDS_PER_SIDE`` cards per side in card order
and the count of the rest. Friends who don't match are left out. ``GET /api/social/trade-matches/{collector_id}``
answers one Friend's row with every card; anyone who isn't a Friend answers 404 FRIEND_NOT_FOUND, as an unknown id
does. Nothing in discovery carries a price or a value.

**Ask to trade** (``GET /api/social/trade-card-matches?printing_id=``) answers, for the catalog card popup, each
Friend's Trade List copies of each Edition of one Card Printing: counts and card facts only.

**Trader reads** (Trading #299; spec "The reach rule" and "Identity"): ``GET /api/social/traders/{trader_id}`` answers
one collector's header (their Display Name, whether they are a Friend, the distance band, their completed Trades, the
status and the pair's conversation), ``.../trade-list`` their Trade List and ``.../matches`` their match row with every
card, for any collector in reach: a Friend, a pair with a conversation, or a nearby collector while both are in open
discovery. An unknown trader id, the viewer's own and a collector out of reach all get the same 404
COLLECTOR_NOT_FOUND, through one call, so the bodies are byte-identical. Nothing here answers a user id or a Handle to a
non-Friend, and the band shows only while both are in open discovery.

**Near you and card search** (Trading #300; spec "Find trades", resolution "discover over a party set").
``GET /api/social/trade-matches/near`` answers the matching collectors near the viewer who are not Friends. The viewer's
status and radius come from ``discovery.search_setting``; when the status is not ``on`` the answer has no rows and no
Want List is read. Otherwise ``discover`` runs over ``nearby_parties``: inside its one read-only snapshot, the candidates
(``discovery.nearby``: at most ``NEAR_CANDIDATES``, by band and then a per-viewer hash, so the cut never ranks by
distance and is the same on every read) and their Trade List copies and wants through the choke point (``among='reach'``)
are read together. A Friend is never a candidate, nor anyone blocked either way. Rows are two-way first, then collectors
who have what the viewer wants, then who want what the viewer has, then by band, Display Name (case ignored) and trader
id, at most ``NEAR_ROWS``, with ``CARDS_PER_SIDE`` cards a side and the counts of the rest. The radius picks the bands
(5 mi: band 1 ... 50 mi: bands 1 to 4); nobody beyond 50 mi appears. ``GET /api/social/trade-card-search?printing_id=&scope=``
answers who has one card for trade, as ``CardHolder`` lists: ``friends`` (answered whatever the status; a suspended viewer
has no copies through the choke point, so gets none) and ``near`` (only while the status is ``on``; up to
``CARD_SEARCH_CANDIDATES`` candidates at the viewer's radius, so both nearby lists agree). Scope ``printing`` is the
Editions of the picked Card Printing, ``name`` every Edition of every Printing sharing its Card Identity, and ``set`` the
``name`` Editions narrowed to the picked Printing's set (not every card in the set). An unknown Printing answers empty
lists. Each list has at most ``HOLDERS_PER_LIST`` holders (Friends by Display Name; nearby by band then Display Name) with
``CARDS_PER_HOLDER`` cards each in card order and ``more_cards``. Promised and borrowed copies never appear (the choke
point). Neither route answers a user id, a Handle, a zip, a coordinate or a distance, only the band.

Every answer here is Edition facts, counts, Friends' names and their Open to cash offers setting: never a Location or a
Deck, by name or by id.
"""
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from ..card_accepts import accepts
from ..location_tree import error
from ..db import connect
from ..identity import verified_user
from ..trade_list import own_trade_copies
from app.core.trading.trade_wants import own_rules, own_wants
from ..want_list import capture_want_list
from ..core.catalog.card_facts import card_facts
from . import name_rules
from .conversations import pair_row, standings
from .discovery import BANDS, Band, DiscoveryStatus, Radius, nearby, reach_one, search_setting, trader_user
from .friend_copies import friend_trade_copies, friend_wants
from .friend_reads import FRIEND_BY_HANDLE, PAGE_IDENTITIES, search_key
from .friends import add_friend_state, friend_ids
from .trades import completed_trades

router = APIRouter(prefix='/api/social', tags=['social'])

# How many cards a discovery row carries per side; the per-Friend read carries every card.
CARDS_PER_SIDE = 20
# Near you looks at this many nearby candidates, shows this many rows and, per the band, never ranks by distance.
NEAR_CANDIDATES = 500
NEAR_ROWS = 100
# Card search looks at this many nearby candidates, and shows this many holders per list and cards per holder.
CARD_SEARCH_CANDIDATES = 1_000
HOLDERS_PER_LIST = 50
CARDS_PER_HOLDER = 20
# The nearest band sorts first.
BAND_ORDER: dict[Band, int] = {band: n for n, band in BANDS.items()}
# How wide a card search reads: one Printing, every Printing of its Card Identity, or those within the picked set.
Scope = Literal['name', 'set', 'printing']


class FriendTradeCard(BaseModel):
    """One Card Edition on a Friend's Trade List. ``copies``: how many they offer now."""
    edition_id: UUID
    name: str
    set_code: str           # The printed set code ("PAL"), or the TCGdex set ID when the set has none (set_codes).
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    copies: str


class FriendTradeList(BaseModel):
    """One page of a Friend's Trade List. ``collector_id`` addresses the Friend in commands and is never shown.
    ``trader_id`` is the Friend's address on the trader routes and in the builder; never shown.
    ``completed_trades``: the Friend's completed Trades (Trading #298), always a number for a Friend."""
    collector_id: str
    trader_id: UUID
    handle: str
    display_name: str
    completed_trades: int | None
    cards: list[FriendTradeCard]
    next_page: int | None   # The next page's number, or null on the last page.


def trade_card(facts, copies: int) -> FriendTradeCard:
    """One Card Edition (its ``card_facts``) with ``copies`` offered now."""
    return FriendTradeCard(edition_id=facts.edition_id, name=facts.name, set_code=facts.set_code,
                           set_name=facts.set_name, collector_number=facts.collector_number,
                           descriptor=facts.descriptor, image_url=facts.image_url, copies=str(copies))


def trade_list_page(conn, viewer: str, owner: str, q: str, page: int,
                    among: Literal['friends', 'reach']) -> tuple[list[FriendTradeCard], int | None]:
    """One page of ``owner``'s Trade List as ``viewer`` may read it (through the choke point, under ``among``), and the
    next page's number or None on the last page. Runs on the caller's connection."""
    copies = friend_trade_copies(conn, viewer, [owner], among=among)
    cards = card_facts(conn, [copy.edition_id for copy in copies])
    key = search_key(conn, q) if q.strip() else ''
    # A query of only punctuation has no letters or digits to match: it finds no card, not every card.
    no_match = bool(q.strip()) and key == ''
    shown = [] if no_match else sorted(
        (copy for copy in copies if key in cards[copy.edition_id].search_key),
        key=lambda copy: cards[copy.edition_id].order())
    identities = list(dict.fromkeys(cards[copy.edition_id].identity_id for copy in shown))
    on_page = set(identities[page * PAGE_IDENTITIES:(page + 1) * PAGE_IDENTITIES])

    return ([trade_card(cards[copy.edition_id], copy.listable) for copy in shown
             if cards[copy.edition_id].identity_id in on_page],
            page + 1 if len(identities) > (page + 1) * PAGE_IDENTITIES else None)


@router.get('/trade-lists/{handle}', response_model=FriendTradeList)
def friend_trade_list(handle: str, q: str = Query('', max_length=100), page: int = Query(0, ge=0, le=100_000),
                      user_id: str = Depends(verified_user)):
    """One page of a Friend's Trade List: the cards they offer to trade now. 404 FRIEND_NOT_FOUND unless ``handle``
    is one of the viewer's Friends. A suspended Friend reads as no Friend here (404 FRIEND_NOT_FOUND); their Collection
    stays readable."""
    handle = handle.strip()
    if not name_rules.HANDLE.fullmatch(handle):
        error(404, 'FRIEND_NOT_FOUND')
    with connect() as conn:
        friend = conn.execute(FRIEND_BY_HANDLE, {'viewer': user_id, 'key': handle.lower()}).fetchone()
        if friend is None:
            error(404, 'FRIEND_NOT_FOUND')
        profile = conn.execute('SELECT trader_id, suspended_at IS NOT NULL AS suspended FROM collector_profile '
                               'WHERE user_id = %s', (friend['collector_id'],)).fetchone()
        if profile['suspended']:
            error(404, 'FRIEND_NOT_FOUND')
        trader_id = profile['trader_id']
        cards, next_page = trade_list_page(conn, user_id, friend['collector_id'], q, page, 'friends')
        done = completed_trades(conn, [friend['collector_id']]).get(friend['collector_id'], 0)
    return FriendTradeList(
        collector_id=friend['collector_id'], trader_id=trader_id, handle=friend['handle'],
        display_name=friend['display_name'], completed_trades=done, cards=cards, next_page=next_page)


MatchKind = Literal['two_way', 'has_what_you_want', 'wants_what_you_have']
Origin = Literal['want_list', 'trade_wants', 'both']
AcceptsAs = Literal['exact', 'any_finish', 'same_name']
KIND_ORDER = {'two_way': 0, 'has_what_you_want': 1, 'wants_what_you_have': 2}


class TradeMatchCard(BaseModel):
    """One card on one side of a discovery row. ``copies``: how many the giving side offers now. ``need``: how many the
    receiving side wants in total; ``want_list_need``: the part their Want List needs ("6 wanted (2 for Decks)").
    ``origin``: which parts are above zero. ``accepts_as``: on the cards the viewer would get only, the narrowest way one
    of the viewer's wants takes this card; null on the cards they would give."""
    edition_id: UUID
    name: str
    set_code: str           # The printed set code ("PAL"), or the TCGdex set ID when the set has none (set_codes).
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    copies: str
    need: str
    want_list_need: str
    origin: Origin
    accepts_as: AcceptsAs | None


class TradeMatchRow(BaseModel):
    """One Friend's discovery row. ``collector_id`` addresses the Friend in commands and is never shown, and
    ``trader_id`` is the Friend's address on the trader routes and in the builder; never shown. ``match`` is
    null only on the per-Friend read, when nothing matches now. ``more_you_get`` and ``more_you_give``: the cards past
    the ones carried, on each side (always 0 on the per-Friend read). ``completed_trades``: the Friend's completed Trades
    (Trading #298), always a number for a Friend."""
    collector_id: str
    trader_id: UUID
    handle: str
    display_name: str
    completed_trades: int | None
    open_to_cash_offers: bool
    match: MatchKind | None
    you_get: list[TradeMatchCard]
    you_give: list[TradeMatchCard]
    more_you_get: int
    more_you_give: int


class TraderView(BaseModel):
    """One collector in reach, by trader id (Trading #299). Never carries a user id or a Handle. ``band`` is null unless
    both are in open discovery, and when they are unavailable; ``completed_trades`` is null only when ``status`` is
    'unavailable' (it is the real count for 'open' and 'you_blocked'); ``open_to_cash_offers`` is false unless
    ``status`` is 'open'. ``add_friend`` (Trading #304) is the Friend code's
    ``add_friend_state``: null unless the two have a Trade both confirmed, are not Friends and are in reach, and null
    while the viewer's own pending request was sent by Handle (a Trade cannot withdraw it), and null
    whenever ``status`` is not 'open'."""
    trader_id: UUID
    display_name: str
    friend: bool
    band: Band | None
    completed_trades: int | None
    open_to_cash_offers: bool
    status: Literal['open', 'unavailable', 'you_blocked']
    conversation_id: UUID | None
    add_friend: Literal['offer', 'sent', 'received'] | None


class TraderTradeList(BaseModel):
    """One page of the Trade List of a collector in reach. Never carries a user id or a Handle. ``band`` is null unless
    both are in open discovery."""
    trader_id: UUID
    display_name: str
    band: Band | None
    completed_trades: int | None
    cards: list[FriendTradeCard]
    next_page: int | None   # The next page's number, or null on the last page.


class TraderMatchRow(BaseModel):
    """The discovery row of one collector in reach, with every card (Trading #299). Never carries a user id or a Handle.
    ``match`` is null when nothing matches now; ``band`` is null unless both are in open discovery. The proposal builder
    reads it for Friends and strangers alike."""
    trader_id: UUID
    display_name: str
    band: Band | None
    completed_trades: int | None
    open_to_cash_offers: bool
    match: MatchKind | None
    you_get: list[TradeMatchCard]
    you_give: list[TradeMatchCard]
    more_you_get: int
    more_you_give: int


class TradeMatches(BaseModel):
    """Discovery: one row per Friend who matches, in the order the module docstring gives. ``has_friends`` is false
    when the viewer has no Friends, so the page can say that matching needs Friends."""
    has_friends: bool
    rows: list[TradeMatchRow]


class TradeCardOffer(BaseModel):
    """One Friend's Trade List copies of one Edition of the Card Printing asked about (Ask to trade). ``collector_id``
    addresses the Friend in commands and is never shown."""
    collector_id: str
    handle: str
    display_name: str
    edition_id: UUID
    name: str
    set_code: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    copies: str


class TradeCardMatches(BaseModel):
    """Ask to trade: every Friend's Trade List copies of the Printing's Editions, by Friend (Display Name, then Handle,
    case ignored) then in card order. Friends with none are absent."""
    has_friends: bool
    offers: list[TradeCardOffer]


class NearbyMatchRow(BaseModel):
    """One nearby collector's discovery row (Trading #300). Never carries a user id or a Handle, and the band is the
    only sign of distance. ``more_you_get`` and ``more_you_give``: the cards past the ones carried, on each side."""
    trader_id: UUID
    display_name: str
    band: Band
    completed_trades: int
    open_to_cash_offers: bool
    match: MatchKind
    you_get: list[TradeMatchCard]
    you_give: list[TradeMatchCard]
    more_you_get: int
    more_you_give: int


class NearbyMatches(BaseModel):
    """Near you: ``status`` is the viewer's own discovery status and ``radius_mi`` their own search radius; ``rows`` is
    empty unless ``status`` is ``on``. Never carries a user id or a Handle."""
    status: DiscoveryStatus
    radius_mi: Radius
    rows: list[NearbyMatchRow]


class CardHolder(BaseModel):
    """A collector with one card for trade (card search). Never carries a user id or a Handle. ``band`` is null for a
    Friend. ``cards``: up to ``CARDS_PER_HOLDER`` of their matching Editions, ``more_cards`` the rest."""
    trader_id: UUID
    display_name: str
    friend: bool
    band: Band | None
    completed_trades: int
    open_to_cash_offers: bool
    cards: list[FriendTradeCard]
    more_cards: int


class TradeCardSearch(BaseModel):
    """Card search: the viewer's Friends who have the card, then collectors near them. ``status`` is the viewer's own
    discovery status; ``near`` is empty unless it is ``on``. Never carries a user id or a Handle."""
    status: DiscoveryStatus
    friends: list[CardHolder]
    near: list[CardHolder]


# The viewer's Friends' names and Open to cash offers setting. The ids come from friends.friend_ids.
# A suspended Friend has no row, so is neither on the per-Friend route nor in Ask to trade.
FRIEND_PROFILES = """SELECT user_id AS collector_id, trader_id, handle, display_name, open_to_cash_offers
  FROM collector_profile WHERE user_id = ANY(%s) AND suspended_at IS NULL"""
# Every Edition of one Card Printing.
PRINTING_EDITIONS = 'SELECT id FROM catalog_edition WHERE printing_id = %s'
# The Editions a card search reads from the picked Printing (%(printing)s), by scope; ``set`` is the Printing's Card
# Identity within its set, not the whole set.
SEARCH_EDITIONS = {
    'printing': 'SELECT e.id FROM catalog_edition e WHERE e.printing_id = %(printing)s',
    'name': """SELECT e.id FROM catalog_printing picked
      JOIN catalog_printing p ON p.identity_id = picked.identity_id
      JOIN catalog_edition e ON e.printing_id = p.id
      WHERE picked.id = %(printing)s""",
    'set': """SELECT e.id FROM catalog_printing picked
      JOIN catalog_printing_display mine ON mine.printing_id = picked.id
      JOIN catalog_printing p ON p.identity_id = picked.identity_id
      JOIN catalog_printing_display pd ON pd.printing_id = p.id AND pd.set_id = mine.set_id
      JOIN catalog_edition e ON e.printing_id = p.id
      WHERE picked.id = %(printing)s""",
}
READ_ONLY = 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'


@dataclass(frozen=True)
class Want:
    """What one side wants of one Card Edition: its Want List part, widened by ``rule``, and its exact Trade Wants
    line."""
    want_list_need: int
    trade_wants_quantity: int
    rule: str


@dataclass(frozen=True)
class Matched:
    """One card a side would receive: the giving side's copies, and the receiving side's need and its Want List part."""
    edition_id: UUID
    copies: int
    need: int
    want_list_need: int


def viewer_needs(user_id: str) -> dict[UUID, int]:
    """The viewer's Want List need per Card Edition over every Deck, hidden ones included, combined as the Want List's
    total combines it: the sum of the lines' needs under Every Deck built at once, the largest under One Deck at a time.
    One capture under the viewer's own owner lock."""
    capture = capture_want_list(user_id)
    lines: dict[UUID, list[int]] = {}
    for (_, edition), line in capture.allocation.lines.items():
        if line.need > 0:
            lines.setdefault(edition, []).append(line.need)
    pick = sum if capture.counting == 'all_at_once' else max
    return {edition: pick(needs) for edition, needs in lines.items()}


def widen(conn, wants: dict[UUID, Want]) -> dict[UUID, set[UUID]]:
    """Every Edition each want's Want List part accepts under its rule, through ``accepts``, which takes one rule per
    Edition: one read per widened rule, for every want at once. A want with no Want List part accepts only itself, through
    its Trade Wants line, which never widens."""
    found: dict[UUID, set[UUID]] = {edition: {edition} for edition in wants}
    for rule in ('printing', 'identity'):
        widened = {edition: rule for edition, want in wants.items() if want.rule == rule and want.want_list_need > 0}
        for edition, editions in accepts(conn, widened).items():
            found[edition] |= editions
    return found


def reaching(wants: dict[UUID, Want], accepted: dict[UUID, set[UUID]]) -> dict[UUID, list[UUID]]:
    """For each accepted Edition, the wants whose Want List part accepts it."""
    found: dict[UUID, list[UUID]] = {}
    for wanted, editions in accepted.items():
        if wants[wanted].want_list_need > 0:
            for edition in editions:
                found.setdefault(edition, []).append(wanted)
    return found


def pair(wants: dict[UUID, Want], reached: dict[UUID, list[UUID]], offered: dict[UUID, int]) -> list[Matched]:
    """The cards among ``offered`` (copies by Edition) that the receiving side's ``wants`` take: the Want List parts of
    the wants that accept a card, plus the Trade Wants line for the card itself."""
    found = []
    for edition, copies in offered.items():
        want_list_need = sum(wants[wanted].want_list_need for wanted in reached.get(edition, ()))
        trade = wants[edition].trade_wants_quantity if edition in wants else 0
        if want_list_need + trade > 0:
            found.append(Matched(edition_id=edition, copies=copies, need=want_list_need + trade,
                                 want_list_need=want_list_need))
    return found


def accepts_as(edition: UUID, wants: dict[UUID, Want], reached: dict[UUID, list[UUID]],
               printing_of: dict[UUID, UUID]) -> AcceptsAs:
    """The narrowest way one of the viewer's wants takes a card: ``exact`` when it is itself one of their wants, else
    ``any_finish`` when it is another finish of the Card Printing of a want that accepts it, else ``same_name``."""
    if edition in wants:
        return 'exact'
    if any(printing_of.get(wanted) == printing_of.get(edition) for wanted in reached.get(edition, ())):
        return 'any_finish'
    return 'same_name'


def match_card(card, matched: Matched, accepted_as: AcceptsAs | None) -> TradeMatchCard:
    trade = matched.need - matched.want_list_need
    origin = 'both' if matched.want_list_need and trade else 'want_list' if matched.want_list_need else 'trade_wants'
    return TradeMatchCard(edition_id=card.edition_id, name=card.name, set_code=card.set_code, set_name=card.set_name,
                          collector_number=card.collector_number, descriptor=card.descriptor,
                          image_url=card.image_url, copies=str(matched.copies), need=str(matched.need),
                          want_list_need=str(matched.want_list_need), origin=origin, accepts_as=accepted_as)


@dataclass(frozen=True)
class PartyMatch:
    """One other collector's match as ``discover`` finds it: the profile row, the completed-Trade count, the distance
    band (always None among Friends), the kind, and the cards on each side with the counts of the rest."""
    party_id: str
    profile: dict
    completed_trades: int
    band: Band | None
    match: MatchKind | None
    you_get: list[TradeMatchCard]
    you_give: list[TradeMatchCard]
    more_you_get: int
    more_you_give: int


# Who discover matches with: called once inside its read-only snapshot, it answers each party's user id and band.
Parties = Callable[[Any], dict[str, Band | None]]


def friend_parties(user_id: str, only: str | None = None) -> Parties:
    """The viewer's Friends (or ``only``, when that one is a Friend), with no band."""
    def parties(conn):
        found = friend_ids(conn, user_id)
        return dict.fromkeys(sorted(found & {only} if only is not None else found))
    return parties


def trader_parties(user_id: str, other: str) -> Parties:
    """``other`` alone, with their band, when the reach rule holds."""
    def parties(conn):
        found = reach_one(conn, user_id, other)
        return {other: found.band} if found else {}
    return parties


def nearby_parties(user_id: str, radius: Radius, limit: int) -> Parties:
    """The nearby candidates (never Friends) within ``radius``, at most ``limit``, with their bands."""
    return lambda conn: dict(nearby(conn, user_id, radius, limit))


def discover(user_id: str, parties: Parties, among: Literal['friends', 'reach'] = 'friends',
             whole: bool = False) -> tuple[bool, list[PartyMatch]]:
    """Whether the viewer has anyone to match with, and every matching party. ``parties`` names who is matched, read
    inside the second snapshot; ``among`` is the choke point's rule for their copies and wants. ``whole=True`` keeps each
    party whatever it matches and carries every card. See the module docstring."""
    deck_needs = viewer_needs(user_id)
    with connect() as conn, conn.transaction():
        conn.execute(READ_ONLY)
        trade_wants = own_wants(conn, user_id)
        rules = own_rules(conn, user_id)
        listable = own_trade_copies(conn, user_id)
        mine = {edition: Want(want_list_need=deck_needs.get(edition, 0),
                              trade_wants_quantity=trade_wants.get(edition, 0), rule=rules.get(edition, 'edition'))
                for edition in set(deck_needs) | set(trade_wants)}
        accepted = widen(conn, mine)
        # A Friend's want can take a card of the viewer's only when the two share a Card Identity: the widest rule.
        candidates = set().union(*accepts(conn, {edition: 'identity' for edition in listable}).values())
    my_reach = reaching(mine, accepted)
    with connect() as conn, conn.transaction():
        conn.execute(READ_ONLY)
        bands = parties(conn)
        if not bands:
            return False, []
        scope = list(bands)
        profiles = {row['collector_id']: row for row in conn.execute(FRIEND_PROFILES, (scope,))}
        counts = completed_trades(conn, scope)
        wanted = set().union(*accepted.values())
        offered: dict[str, dict[UUID, int]] = {}
        for copy in friend_trade_copies(conn, user_id, scope, wanted, among=among) if wanted else ():
            offered.setdefault(copy.friend_id, {})[copy.edition_id] = copy.listable
        theirs: dict[str, dict[UUID, Want]] = {}
        for want in friend_wants(conn, user_id, scope, candidates, among=among) if candidates else ():
            theirs.setdefault(want.friend_id, {})[want.edition_id] = Want(
                want_list_need=want.want_list_need, trade_wants_quantity=want.trade_wants_quantity, rule=want.rule)
        # Every Friend's widened wants expanded at once, one read per rule, never one per Friend.
        expanded: dict[str, dict[UUID, set[UUID]]] = {}
        for rule in ('printing', 'identity'):
            expanded[rule] = accepts(conn, {edition: rule for found in theirs.values()
                                            for edition, want in found.items()
                                            if want.rule == rule and want.want_list_need > 0})
        matched: dict[str, tuple[list[Matched], list[Matched]]] = {}
        for friend in scope:
            found = theirs.get(friend, {})
            their_reach = reaching(found, {
                edition: expanded[want.rule].get(edition, {edition}) if want.rule in expanded else {edition}
                for edition, want in found.items()})
            gets = pair(mine, my_reach, offered.get(friend, {}))
            gives = pair(found, their_reach, listable) if found else []
            if gets or gives or whole:
                matched[friend] = (gets, gives)
        shown = {item.edition_id for gets, gives in matched.values() for item in gets + gives}
        # The wanted cards' Printings too, to say which cards are another finish of one of them.
        cards = card_facts(conn, shown | {edition for edition in mine if mine[edition].rule != 'edition'})
    printing_of = {edition: card.printing_id for edition, card in cards.items()}
    limit = None if whole else CARDS_PER_SIDE
    rows = []
    for friend, (gets, gives) in matched.items():
        profile = profiles.get(friend)
        if profile is None:
            continue
        gets.sort(key=lambda item: cards[item.edition_id].order())
        gives.sort(key=lambda item: cards[item.edition_id].order())
        kind = ('two_way' if gets and gives else 'has_what_you_want' if gets
                else 'wants_what_you_have' if gives else None)
        rows.append(PartyMatch(
            party_id=friend, profile=profile, completed_trades=counts.get(friend, 0), band=bands.get(friend),
            match=kind,
            you_get=[match_card(cards[item.edition_id], item,
                                accepts_as(item.edition_id, mine, my_reach, printing_of)) for item in gets[:limit]],
            you_give=[match_card(cards[item.edition_id], item, None) for item in gives[:limit]],
            more_you_get=len(gets) - len(gets[:limit]), more_you_give=len(gives) - len(gives[:limit])))
    return True, rows


def friend_row(row: PartyMatch) -> TradeMatchRow:
    profile = row.profile
    return TradeMatchRow(
        collector_id=row.party_id, trader_id=profile['trader_id'], handle=profile['handle'],
        display_name=profile['display_name'], completed_trades=row.completed_trades,
        open_to_cash_offers=bool(profile['open_to_cash_offers']), match=row.match, you_get=row.you_get,
        you_give=row.you_give, more_you_get=row.more_you_get, more_you_give=row.more_you_give)


@router.get('/trade-matches', response_model=TradeMatches)
def trade_matches(user_id: str = Depends(verified_user)):
    """Discovery: one row per Friend who has cards the viewer wants or wants cards the viewer has, with at most
    ``CARDS_PER_SIDE`` cards per side. No prices or values."""
    has_friends, found = discover(user_id, friend_parties(user_id))
    rows = [friend_row(row) for row in found]
    rows.sort(key=lambda row: (KIND_ORDER.get(row.match or '', 3), row.display_name.casefold(), row.handle.casefold(),
                               row.collector_id))
    return TradeMatches(has_friends=has_friends, rows=rows)


def nearby_row(row: PartyMatch) -> NearbyMatchRow:
    return NearbyMatchRow(
        trader_id=row.profile['trader_id'], display_name=row.profile['display_name'], band=row.band,
        completed_trades=row.completed_trades, open_to_cash_offers=bool(row.profile['open_to_cash_offers']),
        match=row.match, you_get=row.you_get, you_give=row.you_give, more_you_get=row.more_you_get,
        more_you_give=row.more_you_give)


@router.get('/trade-matches/near', response_model=NearbyMatches)
def nearby_matches(user_id: str = Depends(verified_user)):
    """Near you: the matching collectors near the viewer who are not Friends, within the radius stored in their
    discovery setting. The candidates (at most ``NEAR_CANDIDATES``) are read inside ``discover``'s snapshot; rows are
    sorted by kind, band, Display Name and trader id and cut to ``NEAR_ROWS``. Rows are empty, and no Want List is read,
    unless the status is ``on``. A Friend never appears. Declared before the per-Friend route so ``near`` is no id."""
    with connect() as conn:
        setting = search_setting(conn, user_id)
    if setting.status != 'on':
        return NearbyMatches(status=setting.status, radius_mi=setting.radius_mi, rows=[])
    _, found = discover(user_id, nearby_parties(user_id, setting.radius_mi, NEAR_CANDIDATES), among='reach')
    rows = [nearby_row(row) for row in found]
    rows.sort(key=lambda row: (KIND_ORDER[row.match], BAND_ORDER[row.band], row.display_name.casefold(),
                               str(row.trader_id)))
    return NearbyMatches(status=setting.status, radius_mi=setting.radius_mi, rows=rows[:NEAR_ROWS])


@router.get('/trade-matches/{collector_id}', response_model=TradeMatchRow)
def friend_trade_match(collector_id: str, user_id: str = Depends(verified_user)):
    """One Friend's discovery row with every card on both sides, and a null ``match`` when nothing matches now. 404
    FRIEND_NOT_FOUND unless ``collector_id`` is one of the viewer's Friends."""
    # Resolve the Friend before anything costs: a refusal pays for no Want List read.
    with connect() as conn:
        known = collector_id in friend_ids(conn, user_id)
    if not known:
        error(404, 'FRIEND_NOT_FOUND')
    _, rows = discover(user_id, friend_parties(user_id, collector_id), whole=True)
    if not rows:
        error(404, 'FRIEND_NOT_FOUND')
    return friend_row(rows[0])


def trader_other(conn, user_id: str, trader_id: UUID) -> str:
    """The account behind ``trader_id``, or 404 COLLECTOR_NOT_FOUND for an unknown trader id and the viewer's own. Every
    refusal on the trader routes goes through this one answer, so the bodies are byte-identical."""
    other = trader_user(conn, trader_id)
    if other is None or other == user_id:
        error(404, 'COLLECTOR_NOT_FOUND')
    return other


@router.get('/traders/{trader_id}', response_model=TraderView)
def trader_view(trader_id: UUID, user_id: str = Depends(verified_user)):
    """One collector's header by trader id: a pair with a conversation, or anyone the reach rule holds for. 404
    COLLECTOR_NOT_FOUND for an unknown trader id, the viewer's own, and a collector out of reach. Writes nothing."""
    with connect() as conn, conn.transaction():
        other = trader_other(conn, user_id, trader_id)
        row = pair_row(conn, user_id, other)
        if row is None and reach_one(conn, user_id, other) is None:
            error(404, 'COLLECTOR_NOT_FOUND')
        profile = conn.execute('SELECT display_name, open_to_cash_offers FROM collector_profile WHERE user_id = %s',
                               (other,)).fetchone()
        standing = standings(conn, user_id, {0: (other, profile['display_name'])})[0]
        add_friend = (add_friend_state(conn, user_id, other)
                      if standing.status == 'open' and not standing.party.friend else None)
    return TraderView(
        trader_id=trader_id, display_name=standing.party.display_name, friend=standing.party.friend,
        band=standing.party.band, completed_trades=standing.party.completed_trades,
        open_to_cash_offers=standing.status == 'open' and bool(profile['open_to_cash_offers']),
        status=standing.status, conversation_id=row['id'] if row else None, add_friend=add_friend)


@router.get('/traders/{trader_id}/trade-list', response_model=TraderTradeList)
def trader_trade_list(trader_id: UUID, q: str = Query('', max_length=100), page: int = Query(0, ge=0, le=100_000),
                      user_id: str = Depends(verified_user)):
    """One page of the Trade List of a collector in reach: the cards they offer to trade now. 404 COLLECTOR_NOT_FOUND
    unless the reach rule holds."""
    with connect() as conn:
        other = trader_other(conn, user_id, trader_id)
        found = reach_one(conn, user_id, other)
        if found is None:
            error(404, 'COLLECTOR_NOT_FOUND')
        cards, next_page = trade_list_page(conn, user_id, other, q, page, 'reach')
        name = conn.execute('SELECT display_name FROM collector_profile WHERE user_id = %s',
                            (other,)).fetchone()['display_name']
        done = completed_trades(conn, [other]).get(other, 0)
    return TraderTradeList(trader_id=trader_id, display_name=name, band=found.band, completed_trades=done,
                           cards=cards, next_page=next_page)


@router.get('/traders/{trader_id}/matches', response_model=TraderMatchRow)
def trader_match(trader_id: UUID, user_id: str = Depends(verified_user)):
    """The discovery row of a collector in reach, with every card on both sides and a null ``match`` when nothing
    matches now. 404 COLLECTOR_NOT_FOUND unless the reach rule holds."""
    # Resolve before anything costs: a refusal pays for no Want List read.
    with connect() as conn:
        other = trader_other(conn, user_id, trader_id)
        if reach_one(conn, user_id, other) is None:
            error(404, 'COLLECTOR_NOT_FOUND')
    _, rows = discover(user_id, trader_parties(user_id, other), among='reach', whole=True)
    if not rows:
        error(404, 'COLLECTOR_NOT_FOUND')
    row = rows[0]
    return TraderMatchRow(
        trader_id=trader_id, display_name=row.profile['display_name'], band=row.band,
        completed_trades=row.completed_trades, open_to_cash_offers=bool(row.profile['open_to_cash_offers']),
        match=row.match, you_get=row.you_get, you_give=row.you_give, more_you_get=row.more_you_get,
        more_you_give=row.more_you_give)


@router.get('/trade-card-matches', response_model=TradeCardMatches)
def trade_card_matches(printing_id: UUID, user_id: str = Depends(verified_user)):
    """Ask to trade (the card popup): each Friend's Trade List copies of each Edition of the Card Printing. An unknown
    Printing has none."""
    with connect() as conn, conn.transaction():
        conn.execute(READ_ONLY)
        friends = friend_ids(conn, user_id)
        if not friends:
            return TradeCardMatches(has_friends=False, offers=[])
        editions = [row['id'] for row in conn.execute(PRINTING_EDITIONS, (printing_id,))]
        copies = friend_trade_copies(conn, user_id, sorted(friends), editions) if editions else []
        profiles = {row['collector_id']: row for row in conn.execute(
            FRIEND_PROFILES, (sorted({copy.friend_id for copy in copies}),))} if copies else {}
        cards = card_facts(conn, [copy.edition_id for copy in copies])
    found = [copy for copy in copies if copy.friend_id in profiles]
    found.sort(key=lambda copy: (profiles[copy.friend_id]['display_name'].casefold(),
                                 profiles[copy.friend_id]['handle'].casefold(), copy.friend_id,
                                 cards[copy.edition_id].order()))
    return TradeCardMatches(has_friends=True, offers=[TradeCardOffer(
        collector_id=copy.friend_id, handle=profiles[copy.friend_id]['handle'],
        display_name=profiles[copy.friend_id]['display_name'], edition_id=copy.edition_id,
        name=cards[copy.edition_id].name, set_code=cards[copy.edition_id].set_code,
        set_name=cards[copy.edition_id].set_name, collector_number=cards[copy.edition_id].collector_number,
        descriptor=cards[copy.edition_id].descriptor, image_url=cards[copy.edition_id].image_url,
        copies=str(copy.listable)) for copy in found])


def holder_list(copies, profiles, counts, cards, bands, friend: bool) -> list[CardHolder]:
    """The holders of ``copies`` as ``CardHolder``s, skipping any without a profile row. Friends sort by Display Name
    and trader id; nearby holders by band first. At most ``HOLDERS_PER_LIST``, each with ``CARDS_PER_HOLDER`` cards."""
    held: dict[str, list] = {}
    for copy in copies:
        if copy.friend_id in profiles:
            held.setdefault(copy.friend_id, []).append(copy)
    holders = []
    for holder, mine in held.items():
        profile = profiles[holder]
        mine.sort(key=lambda copy: cards[copy.edition_id].order())
        shown = mine[:CARDS_PER_HOLDER]
        holders.append(CardHolder(
            trader_id=profile['trader_id'], display_name=profile['display_name'], friend=friend,
            band=None if friend else bands[holder], completed_trades=counts.get(holder, 0),
            open_to_cash_offers=bool(profile['open_to_cash_offers']),
            cards=[trade_card(cards[copy.edition_id], copy.listable) for copy in shown],
            more_cards=len(mine) - len(shown)))
    holders.sort(key=lambda holder: ((0 if friend else BAND_ORDER[holder.band]), holder.display_name.casefold(),
                                     str(holder.trader_id)))
    return holders[:HOLDERS_PER_LIST]


@router.get('/trade-card-search', response_model=TradeCardSearch)
def trade_card_search(printing_id: UUID, scope: Scope = 'name', user_id: str = Depends(verified_user)):
    """Who has one card for trade: ``friends`` (answered whatever the status) and ``near`` (only while the status is
    ``on``; the candidates are the viewer's radius, up to ``CARD_SEARCH_CANDIDATES``). ``scope`` is ``printing`` (that
    Printing's Editions), ``name`` (every Printing of its Card Identity) or ``set`` (the ``name`` Editions within the
    picked Printing's set, not every card in the set). An unknown Printing answers empty lists. A suspended viewer has no
    copies through the choke point, so gets no Friends. Promised and borrowed copies never appear. No Handle or user id."""
    with connect() as conn, conn.transaction():
        conn.execute(READ_ONLY)
        setting = search_setting(conn, user_id)
        editions = [row['id'] for row in conn.execute(SEARCH_EDITIONS[scope], {'printing': printing_id})]
        if not editions:
            return TradeCardSearch(status=setting.status, friends=[], near=[])
        friends = sorted(friend_ids(conn, user_id))
        bands = nearby(conn, user_id, setting.radius_mi, CARD_SEARCH_CANDIDATES) if setting.status == 'on' else {}
        mine = friend_trade_copies(conn, user_id, friends, editions) if friends else []
        theirs = friend_trade_copies(conn, user_id, list(bands), editions, among='reach') if bands else []
        holders = sorted({copy.friend_id for copy in mine + theirs})
        profiles = {row['collector_id']: row for row in conn.execute(FRIEND_PROFILES, (holders,))} if holders else {}
        counts = completed_trades(conn, holders) if holders else {}
        cards = card_facts(conn, [copy.edition_id for copy in mine + theirs])
    return TradeCardSearch(status=setting.status, friends=holder_list(mine, profiles, counts, cards, {}, True),
                           near=holder_list(theirs, profiles, counts, cards, bands, False))
