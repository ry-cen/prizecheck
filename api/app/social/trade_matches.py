"""A Friend's Trade List (Trading #269, spec "Matching reads and the choke point"). Discovery and Ask to trade join this
module in a later ticket.

``GET /api/social/trade-lists/{handle}`` answers the cards one Friend offers to trade now, each with how many copies,
from ``friend_copies.friend_trade_copies`` and nothing else: Card Edition facts and a count, never a Location or a
Deck, by name or by id, hidden or not. The Friend is found by Handle among the viewer's Friends only, with the
statement a Friend's Collection uses, so an unknown Handle, a collector who isn't a Friend, a pending Friend Request
either way, a Block either way and the viewer's own Handle all get the same 404 FRIEND_NOT_FOUND.

- ``q`` keeps the cards whose name contains it, comparing letters and digits only, as a Friend's Collection does.
- Cards come in card order (name, set, collector number), and pages hold ``PAGE_IDENTITIES`` Card Identities each,
  with every listed Edition of those Identities, so one card's Editions are never split over two pages.
"""
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from ..location_tree import error
from ..main import connect, verified_user
from . import name_rules
from .friend_copies import friend_trade_copies
from .friend_reads import FRIEND_BY_HANDLE, PAGE_IDENTITIES, card_facts, search_key

router = APIRouter(prefix='/api/social', tags=['social'])


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
