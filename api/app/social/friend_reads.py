"""Friends' cards (social network #250 and #251, spec "Friend-facing reads: one choke point").

**A Friend's Collection** (``GET /api/social/collections/{handle}``) is a gallery of the Card Editions one Friend could
lend now, each with its spare and in-a-Deck copies, from ``friend_copies`` and nothing else. The Friend is found by
Handle among the viewer's Friends only: an unknown Handle, a collector who isn't a Friend and one with a Block either
way all get the same 404 ``FRIEND_NOT_FOUND`` from the same statements, so the route can't be used to look collectors
up. It answers no Location or Deck, by name or by id; ``test_social_contract`` holds every ``/api/social`` response to
that.

- ``show=wanted`` (the default, **On my Want List**) keeps the cards that match a card the viewer's Want List still
  needs, over every Deck, under the viewer's ``printings`` choice (``reach``); ``show=all`` keeps every card and marks
  the matching ones ``wanted``.
- ``q`` keeps the cards whose name contains it, comparing letters and digits only, as Catalog's name search does
  (``catalog_search_words``, migration 048).
- Cards come in card order (name, set, collector number), and pages hold ``PAGE_IDENTITIES`` Card Identities each,
  with every matching Edition of those Identities, so one card's Editions are never split over two pages.

**Friends' cards for the Want List** (``GET /api/social/want-list-matches``, #251) answers, for each card the viewer's
Want List still needs (every Deck, or the one in ``deck``, under the account's counting setting), the Friends' copies
that match it. It is its own read, never part of ``GET /api/want-list``: it carries no need and no Deck, and the page
takes both from the Want List's combined total. **Friends who have this** (``GET /api/social/card-matches``, #251)
answers the Friends' copies of one Card Printing for the card popup. Both read every Friend's copies with one
``friend_copies`` call, and list spare copies before copies in a Deck.

**Matching** (``reach``) follows the viewer's choice of printings, the one Decklist Import calls Exact printings and Use
cards I own: ``exact`` reaches every Edition of the wanted card's own Card Printing (any finish); ``reprint_group`` also
reaches every Edition of the other Card Printings in its effective Reprint Group (``catalog_reprint_group_member``),
whose copies are marked ``other_printing``. A Printing in no Reprint Group, every Basic Energy among them, reaches only
itself: Decklist Import's Basic Energy grouping doesn't apply, as for the Want List's Swap hint.

The viewer's Want List is read with ``want_list.capture_want_list`` in its own transaction, under the viewer's owner
lock; the Friend read runs afterwards on its own connection, under no lock.
"""
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from .. import set_codes
from ..location_tree import error
from ..main import connect, verified_user
from ..want_list import capture_want_list, number_order
from . import name_rules
from .friend_copies import friend_copies

router = APIRouter(prefix='/api/social', tags=['social'])

# How many Card Identities one page of a Friend's Collection holds.
PAGE_IDENTITIES = 30

# Which other Card Editions count for a wanted one: its own Printing's (any finish), or also the other Printings of its
# Reprint Group. Decklist Import's Exact printings and Use cards I own.
Printings = Literal['exact', 'reprint_group']


class FriendCard(BaseModel):
    """One Card Edition a Friend could lend now. ``spare`` and ``in_deck`` are copies: loose or beyond a Deck's own
    line, and held by a Deck for its own line. ``wanted``: it matches a card the viewer's Want List still needs."""
    edition_id: UUID
    name: str
    set_code: str           # The printed set code ("PAL"), or the TCGdex set ID when the set has none (set_codes).
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    spare: str
    in_deck: str
    wanted: bool


class FriendCollection(BaseModel):
    """One page of a Friend's Collection. ``collector_id`` addresses the Friend in commands and is never shown."""
    collector_id: str
    handle: str
    display_name: str
    show: Literal['wanted', 'all']
    cards: list[FriendCard]
    next_page: int | None   # The next page's number, or null on the last page.


# A Friend by Handle (case ignored), only when the viewer has an accepted friendship with them and no Block stands
# either way. Anyone else is absent.
FRIEND_BY_HANDLE = """SELECT p.user_id AS collector_id, p.handle, p.display_name
  FROM friends_of(ARRAY[%(viewer)s]::text[]) f JOIN collector_profile p ON p.user_id = f.friend_id
  WHERE p.handle_key = %(key)s"""

# What a card shows, its Printing and Card Identity, and its name as Catalog's name search compares it.
CARD_FACTS = """SELECT e.id AS edition_id, e.printing_id, p.identity_id,
  coalesce(pd.display_name, ci.display_name) AS name, coalesce(pd.set_id, '') AS set_id,
  coalesce(pd.set_name, '') AS set_name, coalesce(pd.collector_number, '') AS collector_number, e.descriptor,
  pd.image_url, replace(catalog_search_words(coalesce(pd.display_name, ci.display_name)), ' ', '') AS search_key
  FROM catalog_edition e
  JOIN catalog_printing p ON p.id = e.printing_id
  JOIN catalog_identity ci ON ci.id = p.identity_id
  LEFT JOIN catalog_printing_display pd ON pd.printing_id = p.id
  WHERE e.id = ANY(%s)"""

# Every Edition each wanted Edition reaches (see the module docstring), and whether it is of another Printing.
REACH = """WITH wanted AS (
    SELECT e.id AS wanted_id, e.printing_id FROM catalog_edition e WHERE e.id = ANY(%(editions)s::uuid[])
  ), reached AS (
    SELECT w.wanted_id, w.printing_id, false AS other_printing FROM wanted w
    UNION
    SELECT w.wanted_id, g.printing_id, true FROM wanted w
      JOIN catalog_reprint_group_member mine ON mine.printing_id = w.printing_id
      JOIN catalog_reprint_group_member g ON g.group_id = mine.group_id AND g.printing_id <> w.printing_id
      WHERE %(group)s
  )
  SELECT r.wanted_id, e.id AS edition_id, r.other_printing
  FROM reached r JOIN catalog_edition e ON e.printing_id = r.printing_id"""


@dataclass(frozen=True)
class Card:
    """Catalog facts about one Card Edition (``CARD_FACTS``)."""
    edition_id: UUID
    printing_id: UUID
    identity_id: UUID
    name: str
    set_code: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    search_key: str

    def order(self):
        """Card order, as the Want List reads: name, set, collector number, then the Edition id."""
        return self.name.casefold(), self.set_name, number_order(self.collector_number), self.edition_id


def card_facts(conn, edition_ids) -> dict[UUID, Card]:
    ids = sorted(set(edition_ids))
    if not ids:
        return {}
    return {row['edition_id']: Card(
        edition_id=row['edition_id'], printing_id=row['printing_id'], identity_id=row['identity_id'], name=row['name'],
        set_code=set_codes.code_for(row['set_id']), set_name=row['set_name'],
        collector_number=row['collector_number'], descriptor=row['descriptor'],
        image_url=f"{row['image_url']}/low.webp" if row['image_url'] else None, search_key=row['search_key'] or '')
        for row in conn.execute(CARD_FACTS, (ids,))}


def reach(conn, wanted_ids, printings: Printings) -> dict[UUID, dict[UUID, bool]]:
    """For each wanted Edition, every Edition that counts for it under ``printings``, with True for an Edition of
    another Card Printing. A wanted Edition always reaches itself."""
    wanted = sorted(set(wanted_ids))
    if not wanted:
        return {}
    found: dict[UUID, dict[UUID, bool]] = {}
    for row in conn.execute(REACH, {'editions': wanted, 'group': printings == 'reprint_group'}):
        found.setdefault(row['wanted_id'], {})[row['edition_id']] = row['other_printing']
    return found


def wanted_editions(user_id: str, deck_id: UUID | None = None) -> list[UUID]:
    """The Card Editions the viewer's Want List still needs, over every Deck or the one in scope: exactly the cards of
    its combined total, under the account's counting setting. Raises 404 DECK_NOT_FOUND for a Deck that isn't theirs."""
    capture = capture_want_list(user_id, deck_id)
    return sorted({line.edition_id for shown in capture.shown() for line in capture.needs(shown.id)})


def search_key(conn, q: str) -> str:
    """q's letters and digits as Catalog's name search compares them; empty when it has none."""
    return conn.execute("SELECT replace(catalog_search_words(%s), ' ', '') AS key", (q,)).fetchone()['key'] or ''


@router.get('/collections/{handle}', response_model=FriendCollection)
def friend_collection(handle: str, show: Literal['wanted', 'all'] = 'wanted', q: str = Query('', max_length=100),
                      printings: Printings = 'reprint_group', page: int = Query(0, ge=0, le=100_000),
                      user_id: str = Depends(verified_user)):
    """One page of a Friend's Collection: the cards they could lend now. 404 FRIEND_NOT_FOUND unless ``handle`` is one
    of the viewer's Friends."""
    handle = handle.strip()
    if not name_rules.HANDLE.fullmatch(handle):
        error(404, 'FRIEND_NOT_FOUND')
    # Resolve the Handle before anything costs: a refusal pays for no Want List read.
    with connect() as conn:
        friend = conn.execute(FRIEND_BY_HANDLE, {'viewer': user_id, 'key': handle.lower()}).fetchone()
    if friend is None:
        error(404, 'FRIEND_NOT_FOUND')
    wanted = wanted_editions(user_id)
    with connect() as conn:
        copies = friend_copies(conn, user_id, [friend['collector_id']])
        cards = card_facts(conn, [copy.edition_id for copy in copies])
        reached = {edition for editions in reach(conn, wanted, printings).values() for edition in editions}
        key = search_key(conn, q) if q.strip() else ''
    # A query of only punctuation has no letters or digits to match: it finds no card, not every card.
    no_match = bool(q.strip()) and key == ''
    shown = [] if no_match else sorted(
        (copy for copy in copies
         if (show == 'all' or copy.edition_id in reached) and key in cards[copy.edition_id].search_key),
        key=lambda copy: cards[copy.edition_id].order())
    identities = list(dict.fromkeys(cards[copy.edition_id].identity_id for copy in shown))
    on_page = set(identities[page * PAGE_IDENTITIES:(page + 1) * PAGE_IDENTITIES])

    def card(copy) -> FriendCard:
        facts = cards[copy.edition_id]
        return FriendCard(edition_id=facts.edition_id, name=facts.name, set_code=facts.set_code,
                          set_name=facts.set_name, collector_number=facts.collector_number,
                          descriptor=facts.descriptor, image_url=facts.image_url, spare=str(copy.spare),
                          in_deck=str(copy.in_deck), wanted=copy.edition_id in reached)

    return FriendCollection(
        collector_id=friend['collector_id'], handle=friend['handle'], display_name=friend['display_name'], show=show,
        cards=[card(copy) for copy in shown if cards[copy.edition_id].identity_id in on_page],
        next_page=page + 1 if len(identities) > (page + 1) * PAGE_IDENTITIES else None)


class FriendCopy(BaseModel):
    """One Friend's copies of one Card Edition that matches what the viewer asked about. ``other_printing``: the
    Edition is of another Card Printing of the wanted card's Reprint Group, so its set and number are worth showing.
    ``collector_id`` addresses the Friend in commands (Ask to borrow, #252) and is never shown."""
    collector_id: str
    handle: str
    display_name: str
    edition_id: UUID
    name: str
    set_code: str
    collector_number: str
    descriptor: dict
    other_printing: bool
    spare: str
    in_deck: str


class WantedCard(BaseModel):
    """The Friends' copies that match one card of the Want List's combined total (``edition_id`` is that card)."""
    edition_id: UUID
    copies: list[FriendCopy]


class WantListMatches(BaseModel):
    """Friends' cards for the Want List in scope: only the cards with at least one Friend's copy, in Edition id order.
    ``has_friends`` is false when the viewer has no Friends, so the page can leave Get from Friends out."""
    has_friends: bool
    cards: list[WantedCard]


class CardMatches(BaseModel):
    """Friends' copies of one Card Printing (the card popup), under the viewer's ``printings`` choice."""
    has_friends: bool
    copies: list[FriendCopy]


# The viewer's Friends with their Handles and Display Names.
FRIEND_PROFILES = """SELECT p.user_id AS collector_id, p.handle, p.display_name
  FROM friends_of(ARRAY[%s]::text[]) f JOIN collector_profile p ON p.user_id = f.friend_id"""


def matches(conn, user_id: str, reached: dict[UUID, dict[UUID, bool]]) -> tuple[bool, dict[UUID, list[FriendCopy]]]:
    """Whether the viewer has Friends, and for each wanted Edition the Friends' copies of the Editions it reaches: one
    ``friend_copies`` read for every Friend and Edition. Copies come spare first (a copy with spare copies before one
    whose copies are all in a Deck), then the wanted card's own Printing first, then by Friend (Display Name, Handle),
    then in card order."""
    friends = {row['collector_id']: row for row in conn.execute(FRIEND_PROFILES, (user_id,))}
    editions = {edition for reaches in reached.values() for edition in reaches}
    if not friends or not editions:
        return bool(friends), {}
    found = [copy for copy in friend_copies(conn, user_id, None, sorted(editions)) if copy.friend_id in friends]
    cards = card_facts(conn, [copy.edition_id for copy in found])
    by_edition: dict[UUID, list] = {}
    for copy in found:
        by_edition.setdefault(copy.edition_id, []).append(copy)
    answer: dict[UUID, list[FriendCopy]] = {}
    for wanted, reaches in reached.items():
        rows = [(copy, reaches[edition]) for edition in reaches for copy in by_edition.get(edition, [])]
        rows.sort(key=lambda item: (item[0].spare == 0, item[1], friends[item[0].friend_id]['display_name'].casefold(),
                                    friends[item[0].friend_id]['handle'].casefold(), cards[item[0].edition_id].order()))
        if rows:
            answer[wanted] = [friend_copy(friends[copy.friend_id], cards[copy.edition_id], copy, other)
                              for copy, other in rows]
    return True, answer


def friend_copy(friend, card: Card, copy, other: bool) -> FriendCopy:
    return FriendCopy(collector_id=friend['collector_id'], handle=friend['handle'],
                      display_name=friend['display_name'], edition_id=card.edition_id, name=card.name,
                      set_code=card.set_code, collector_number=card.collector_number, descriptor=card.descriptor,
                      other_printing=other, spare=str(copy.spare), in_deck=str(copy.in_deck))


@router.get('/want-list-matches', response_model=WantListMatches)
def want_list_matches(deck: UUID | None = None, printings: Printings = 'reprint_group',
                      user_id: str = Depends(verified_user)):
    """Friends' cards for the Want List (#251): for each card the Want List still needs, over every Deck or the one in
    ``deck`` and under the account's counting setting, the Friends' copies it reaches under ``printings``. Its own
    read, apart from the Want List's: a Friend's change never moves the Want List's revisions. 404 DECK_NOT_FOUND for a
    Deck that isn't the viewer's."""
    wanted = wanted_editions(user_id, deck)
    with connect() as conn:
        has_friends, found = matches(conn, user_id, reach(conn, wanted, printings))
    return WantListMatches(has_friends=has_friends, cards=[WantedCard(edition_id=edition, copies=found[edition])
                                                           for edition in sorted(found)])


@router.get('/card-matches', response_model=CardMatches)
def card_matches(printing_id: UUID, printings: Printings = 'reprint_group', user_id: str = Depends(verified_user)):
    """Friends who have this card (#251, the card popup): the Friends' copies of every Edition of the Card Printing,
    and under ``reprint_group`` of the other Printings of its Reprint Group too. An unknown Printing has none."""
    with connect() as conn:
        own = [row['id'] for row in conn.execute('SELECT id FROM catalog_edition WHERE printing_id=%s', (printing_id,))]
        reached: dict[UUID, bool] = {}
        for reaches in reach(conn, own, printings).values():
            for edition, other in reaches.items():
                reached[edition] = reached.get(edition, True) and other
        has_friends, found = matches(conn, user_id, {printing_id: reached} if reached else {})
    return CardMatches(has_friends=has_friends, copies=found.get(printing_id, []))
