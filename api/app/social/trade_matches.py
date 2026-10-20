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

Every answer here is Edition facts, counts, Friends' names and their Open to cash offers setting: never a Location or a
Deck, by name or by id.
"""
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from ..card_accepts import accepts
from ..location_tree import error
from ..main import connect, verified_user
from ..trade_list import own_trade_copies
from ..trade_wants import own_rules, own_wants
from ..want_list import capture_want_list
from . import name_rules
from .friend_copies import friend_trade_copies, friend_wants
from .friend_reads import FRIEND_BY_HANDLE, PAGE_IDENTITIES, card_facts, search_key
from .friends import friend_ids

router = APIRouter(prefix='/api/social', tags=['social'])

# How many cards a discovery row carries per side; the per-Friend read carries every card.
CARDS_PER_SIDE = 20


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
    """One page of a Friend's Trade List. ``collector_id`` addresses the Friend in commands and is never shown."""
    collector_id: str
    handle: str
    display_name: str
    cards: list[FriendTradeCard]
    next_page: int | None   # The next page's number, or null on the last page.


@router.get('/trade-lists/{handle}', response_model=FriendTradeList)
def friend_trade_list(handle: str, q: str = Query('', max_length=100), page: int = Query(0, ge=0, le=100_000),
                      user_id: str = Depends(verified_user)):
    """One page of a Friend's Trade List: the cards they offer to trade now. 404 FRIEND_NOT_FOUND unless ``handle``
    is one of the viewer's Friends."""
    handle = handle.strip()
    if not name_rules.HANDLE.fullmatch(handle):
        error(404, 'FRIEND_NOT_FOUND')
    with connect() as conn:
        friend = conn.execute(FRIEND_BY_HANDLE, {'viewer': user_id, 'key': handle.lower()}).fetchone()
        if friend is None:
            error(404, 'FRIEND_NOT_FOUND')
        copies = friend_trade_copies(conn, user_id, [friend['collector_id']])
        cards = card_facts(conn, [copy.edition_id for copy in copies])
        key = search_key(conn, q) if q.strip() else ''
    # A query of only punctuation has no letters or digits to match: it finds no card, not every card.
    no_match = bool(q.strip()) and key == ''
    shown = [] if no_match else sorted(
        (copy for copy in copies if key in cards[copy.edition_id].search_key),
        key=lambda copy: cards[copy.edition_id].order())
    identities = list(dict.fromkeys(cards[copy.edition_id].identity_id for copy in shown))
    on_page = set(identities[page * PAGE_IDENTITIES:(page + 1) * PAGE_IDENTITIES])

    def card(copy) -> FriendTradeCard:
        facts = cards[copy.edition_id]
        return FriendTradeCard(edition_id=facts.edition_id, name=facts.name, set_code=facts.set_code,
                               set_name=facts.set_name, collector_number=facts.collector_number,
                               descriptor=facts.descriptor, image_url=facts.image_url, copies=str(copy.listable))

    return FriendTradeList(
        collector_id=friend['collector_id'], handle=friend['handle'], display_name=friend['display_name'],
        cards=[card(copy) for copy in shown if cards[copy.edition_id].identity_id in on_page],
        next_page=page + 1 if len(identities) > (page + 1) * PAGE_IDENTITIES else None)


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
    """One Friend's discovery row. ``collector_id`` addresses the Friend in commands and is never shown. ``match`` is
    null only on the per-Friend read, when nothing matches now. ``more_you_get`` and ``more_you_give``: the cards past
    the ones carried, on each side (always 0 on the per-Friend read)."""
    collector_id: str
    handle: str
    display_name: str
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


# The viewer's Friends' names and Open to cash offers setting. The ids come from friends.friend_ids.
FRIEND_PROFILES = """SELECT user_id AS collector_id, handle, display_name, open_to_cash_offers
  FROM collector_profile WHERE user_id = ANY(%s)"""
# Every Edition of one Card Printing.
PRINTING_EDITIONS = 'SELECT id FROM catalog_edition WHERE printing_id = %s'
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


def discover(user_id: str, only: str | None = None) -> tuple[bool, list[TradeMatchRow]]:
    """Whether the viewer has Friends, and every matching Friend's row; with ``only``, that one Friend's row whatever it
    matches, with every card. See the module docstring."""
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
        friends = friend_ids(conn, user_id)
        if only is not None:
            friends &= {only}
        if not friends:
            return False, []
        scope = sorted(friends)
        profiles = {row['collector_id']: row for row in conn.execute(FRIEND_PROFILES, (scope,))}
        wanted = set().union(*accepted.values())
        offered: dict[str, dict[UUID, int]] = {}
        for copy in friend_trade_copies(conn, user_id, scope, wanted) if wanted else ():
            offered.setdefault(copy.friend_id, {})[copy.edition_id] = copy.listable
        theirs: dict[str, dict[UUID, Want]] = {}
        for want in friend_wants(conn, user_id, scope, candidates) if candidates else ():
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
            if gets or gives or only is not None:
                matched[friend] = (gets, gives)
        shown = {item.edition_id for gets, gives in matched.values() for item in gets + gives}
        # The wanted cards' Printings too, to say which cards are another finish of one of them.
        cards = card_facts(conn, shown | {edition for edition in mine if mine[edition].rule != 'edition'})
    printing_of = {edition: card.printing_id for edition, card in cards.items()}
    limit = None if only is not None else CARDS_PER_SIDE
    rows = []
    for friend, (gets, gives) in matched.items():
        profile = profiles.get(friend)
        if profile is None:
            continue
        gets.sort(key=lambda item: cards[item.edition_id].order())
        gives.sort(key=lambda item: cards[item.edition_id].order())
        kind = ('two_way' if gets and gives else 'has_what_you_want' if gets
                else 'wants_what_you_have' if gives else None)
        rows.append(TradeMatchRow(
            collector_id=friend, handle=profile['handle'], display_name=profile['display_name'],
            open_to_cash_offers=bool(profile['open_to_cash_offers']), match=kind,
            you_get=[match_card(cards[item.edition_id], item,
                                accepts_as(item.edition_id, mine, my_reach, printing_of)) for item in gets[:limit]],
            you_give=[match_card(cards[item.edition_id], item, None) for item in gives[:limit]],
            more_you_get=len(gets) - len(gets[:limit]), more_you_give=len(gives) - len(gives[:limit])))
    rows.sort(key=lambda row: (KIND_ORDER.get(row.match or '', 3), row.display_name.casefold(), row.handle.casefold(),
                               row.collector_id))
    return True, rows


@router.get('/trade-matches', response_model=TradeMatches)
def trade_matches(user_id: str = Depends(verified_user)):
    """Discovery: one row per Friend who has cards the viewer wants or wants cards the viewer has, with at most
    ``CARDS_PER_SIDE`` cards per side. No prices or values."""
    has_friends, rows = discover(user_id)
    return TradeMatches(has_friends=has_friends, rows=rows)


@router.get('/trade-matches/{collector_id}', response_model=TradeMatchRow)
def friend_trade_match(collector_id: str, user_id: str = Depends(verified_user)):
    """One Friend's discovery row with every card on both sides, and a null ``match`` when nothing matches now. 404
    FRIEND_NOT_FOUND unless ``collector_id`` is one of the viewer's Friends."""
    # Resolve the Friend before anything costs: a refusal pays for no Want List read.
    with connect() as conn:
        known = collector_id in friend_ids(conn, user_id)
    if not known:
        error(404, 'FRIEND_NOT_FOUND')
    _, rows = discover(user_id, collector_id)
    if not rows:
        error(404, 'FRIEND_NOT_FOUND')
    return rows[0]


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
