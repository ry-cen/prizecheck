"""The Trade steps that read or reserve a collector's own inventory (Trading #270, resolution "Module boundary" and "API
contract").

The shared Trade facts and the steps that change no inventory of the reader's are ``social.trades`` under
``/api/social/trades``; the contract guard keeps that area from reading any inventory table. What needs one
collector's own Locations and Holdings is here, under ``/api/trades``, and never answers one side's Locations to the
other:

- **Send a Trade Proposal** (``POST /api/trades``). The sender names a Friend, the Card Editions they give
  (``you_give``) and the ones they ask for (``you_get``); either side may be empty, so a gift either way is a
  proposal too, but not both. Cash is an amount and a payer together (Trading #277); the app records it and never
  handles money. Each line the sender gives is capped at their own listable copies
  (``trade_list.own_trade_copies``), and each line they ask for at the Friend's (``friend_copies.friend_trade_copies``),
  both through migration 142's one listable rule on this step's own connection. Sending reserves the copies the sender
  gives at once (``trade_picks.make_trade_picks``), so they leave both Trade Lists, stop counting as Spare Copies and
  stop being lendable until the proposal closes. Nothing of the Friend's is reserved or locked.

- **Accept a Trade Proposal** (``POST /api/trades/{id}/accept``, Trading #271). The recipient takes it whole: the
  body names only the revision they read and an idempotency key. Under the recipient's lock it checks the friendship
  (as the Loan accept does), caps each line they give at their own listable copies, reserves those copies at once
  (``make_trade_picks``) and turns the proposal into a Trade. The proposer's copies were reserved by the send and stay
  so. A recipient who gives nothing (a gift to them) accepts with no cap and no pick.

- **Counter a Trade Proposal** (``POST /api/trades/{id}/counter``, Trading #278). The recipient answers a waiting
  proposal with a reply of their own: the body names the revision they read, a key and the reply's lines and cash, as a
  send does. In one transaction the proposal closes as 'countered' (its sender's picks go with it) and the reply is
  inserted for the sender with ``countered_from`` set, reserving the cards the counterer gives; the caps are read after
  the close, so a Counter may ask for every copy the sender had listed. A refusal leaves the original waiting as it
  was, and no inbox update is stored, because the reply is the sender's waiting answer.

- **Each side's own view** (``GET /api/trades/{id}/side``, Trading #272): the reader's own Trade Pick List, with their
  own Location names, how many copies each pick's Location is short of (a Move or a Removal can leave a pick out of
  date) and, when one is, the picks **Use suggested picks** would make. Never the other side's, and never under
  ``/api/social``.

- **Use suggested picks** (``POST /api/trades/{id}/picks/use-suggested``, #272). The side that gives cards, while they
  still reserve (the proposer as soon as the proposal is sent), replaces every out-of-date pick with the suggestion
  (``trade_picks.replacement_trade_picks``): For trade copies first, then any of their Locations. Only that side's
  picks change; 409 PICKS_UP_TO_DATE when none is out of date.

- **Confirm swap** (``POST /api/trades/{id}/confirm-swap``, #272). After the in-person swap, each side confirms for
  their own inventory only. The copies they give leave their Collection through ``moves.take_out`` (Removal semantics,
  no Undo record, no Deck List line lowered) and their picks go in the same transaction, so their Holdings and their
  promises fall by the same count; refused with 409 PICKS_OUT_OF_DATE while a pick is out of date. The copies they get
  arrive as new Holdings through ``moves.add_in`` in the Storage Leaf or Deck they chose, or Unsorted (made when
  missing), read from the Trade's own lines only, so it works after the other account is gone; arriving in a Deck they
  raise its lines as an Add does. The confirmer's revision moves exactly once. The second confirmation closes the Trade
  as swapped and tells the side that confirmed first. Nothing is undoable, and cash changes nothing (the app never
  handles money). The copies they get fill their Decks' needs for each exact Edition first, read before anything is
  written (``want_list.edition_needs``), and only the rest lower their Trade Wants line for it
  (``trade_wants.lower_trade_wants``, Trading #275). Trading #279 adds the Deck switches.

**Locks**: the stepping collector's own owner row only (``owners.lock_owners``), except that a Counter locks both
sides (the sender, whose copies it releases, and the counterer, whose copies it reserves) in ascending order. So a
send, an accept, a Confirm swap or a Use suggested picks and a Loan step or inventory command over the same copies
run one after the other and the second sees the first's writes; migration 142's deferred triggers are the backstop. No
step takes the inventory lock (``moves.lock_owner``) or reads the Location tree with
``location_tree.owner_and_rows``: their ``FOR UPDATE`` would hold off the foreign key checks the other side's steps
take on this owner's row (``social.owners.lock_owners``). Each step moves its collector's revision when it changes what
they hold or promise. The command lock, replay and hourly count are ``social.trades``' (``begin_trade_command``);
every step on an existing Trade runs through ``social.trades.run_trade_step``, except the Counter, which also inserts a
row and runs the same checks in its own flow (``counter_trade``); both lock the Trade row after the owner and write it
once.
"""
import re
from typing import Literal
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .deck_deletion import unsorted_leaf
from .loan_inventory import refuse
from .location_tree import error
from .main import connect, verified_user
from .moves import add_in, leaf, quantity, take_out
from .social.friend_copies import friend_trade_copies
from .social.friends import friend_ids
from .social.loans import NOW, advance_revision
from .social.owners import lock_owners
from .social.trades import (TRADES, TradeStep, TradeView, allowed, begin_trade_command, close_trade, other_side,
                            record_trade_update, role_of, run_trade_step, side_gives, store_trade, write_trade)
from .trade_list import own_trade_copies
from .trade_picks import (insert_trade_picks, make_trade_picks, replacement_trade_picks, stale_pick_trades,
                          trade_pick_shortfalls)
from .trade_wants import lower_trade_wants
from .want_list import edition_needs

router = APIRouter(prefix='/api/trades', tags=['trades'])

# Card Editions one side of a Trade may list.
MAX_TRADE_LINES = 50
# Copies one Trade line may name.
MAX_TRADE_COPIES = 9999


class TradeLineRequest(BaseModel):
    edition_id: UUID
    quantity: str           # "1" to "9999"


class TradeCashRequest(BaseModel):
    cents: str                       # whole US cents "1".."99999999", else 422 INVALID_CASH
    payer: Literal['you', 'them']    # relative to the collector sending this proposal


class SendTradeProposal(BaseModel):
    recipient_id: str = Field(min_length=1, max_length=200)
    you_give: list[TradeLineRequest] = []
    you_get: list[TradeLineRequest] = []
    cash: TradeCashRequest | None = None
    idempotency_key: UUID


class ConfirmSwap(TradeStep):
    """Confirm swap. ``destination_id``: one of the confirmer's own Storage Leaves or Decks for the cards they get, or
    None for Unsorted; ignored when they get none. Trading #279 adds the Deck switches the collector left ticked."""
    destination_id: UUID | None = None


class CounterTrade(TradeStep):
    """A Counter (Trading #278): the countered proposal's revision and a key, then the reply's own lines and cash,
    from the counterer's side, as a send names them."""
    you_give: list[TradeLineRequest] = []
    you_get: list[TradeLineRequest] = []
    cash: TradeCashRequest | None = None


class TradePickPlace(BaseModel):
    """Where the reader takes copies of one Card Edition they give from: one of their own Locations (``name``), or
    Unsorted when the Location was deleted (``location_id`` None), as the Loan Pick List names it. ``short``: copies
    that Location no longer holds for this pick (the pick is out of date when above "0")."""
    edition_id: UUID
    location_id: UUID | None
    name: str
    copies: str
    short: str


class OwnTradeSide(BaseModel):
    """The reader's own side of a Trade. ``picks``: their Trade Pick List while their copies are promised (empty when
    they give nothing, once they confirmed the swap, and once the Trade closed). ``suggested``: the Pick List **Use
    suggested picks** makes, when a pick is out of date, else empty. Trading #279 adds the Deck switches Confirm swap
    offers."""
    trade_id: UUID
    picks: list[TradePickPlace]
    suggested: list[TradePickPlace]


def trade_quantity(raw: str) -> int:
    """A Trade line's copies: a whole number from 1 to ``MAX_TRADE_COPIES``, else 422 INVALID_QUANTITY."""
    value = quantity(raw)
    if value > MAX_TRADE_COPIES:
        error(422, 'INVALID_QUANTITY')
    return value


CASH_CENTS = re.compile(r'[1-9][0-9]{0,7}')   # 1..99,999,999: migration 141's CHECK and the spec's sanity bound


def trade_cash(cash: TradeCashRequest | None) -> tuple[int, str] | None:
    """(cents, payer 'you'|'them') or None for no cash; 422 INVALID_CASH for any other amount text (Trading #277)."""
    if cash is None:
        return None
    if not cash.cents.isascii() or not CASH_CENTS.fullmatch(cash.cents):
        error(422, 'INVALID_CASH')
    return int(cash.cents), cash.payer


def cash_only_side(give, get, cash: tuple[int, str] | None) -> str | None:
    """The sender-relative side that gives only cash (no cards, and pays), or None. A gift plus cash has none."""
    if cash is None:
        return None
    if cash[1] == 'you' and not give:
        return 'you_give'
    if cash[1] == 'them' and not get:
        return 'you_get'
    return None


def proposal_shape(you_give, you_get, cash_request):
    """The 422 shape rules a send and a Counter share, in order: INVALID_QUANTITY, DUPLICATE_EDITION (one Edition twice
    on one side), SAME_CARD_BOTH_SIDES, TOO_MANY_LINES, TRADE_HAS_NO_CARDS, INVALID_CASH. Returns ``(give, get, cash)``
    as ``(edition, copies)`` lists and ``trade_cash``'s pair; nothing is read or counted."""
    give = [(line.edition_id, trade_quantity(line.quantity)) for line in you_give]
    get = [(line.edition_id, trade_quantity(line.quantity)) for line in you_get]
    for lines in (give, get):
        if len({edition for edition, _ in lines}) != len(lines):
            error(422, 'DUPLICATE_EDITION')
    if {edition for edition, _ in give} & {edition for edition, _ in get}:
        error(422, 'SAME_CARD_BOTH_SIDES')
    if len(give) > MAX_TRADE_LINES or len(get) > MAX_TRADE_LINES:
        error(422, 'TOO_MANY_LINES')
    if not give and not get:
        error(422, 'TRADE_HAS_NO_CARDS')
    return give, get, trade_cash(cash_request)


def check_trade_caps(conn, user_id: str, friend_id: str, give, get) -> None:
    """409 NOT_TRADEABLE (``edition_id``, ``available``, ``side``) for the first line that asks for more copies than are
    on that side's Trade List now: the caller's own lines first ('you_give'), then the Friend's ('you_get'). Read on
    the caller's connection, after whatever the step released."""
    mine = own_trade_copies(conn, user_id, [edition for edition, _ in give])
    for edition, copies in give:
        if copies > mine.get(edition, 0):
            refuse(409, 'NOT_TRADEABLE', edition_id=edition, available=mine.get(edition, 0), side='you_give')
    theirs = {item.edition_id: item.listable for item in friend_trade_copies(
        conn, user_id, [friend_id], [edition for edition, _ in get])}
    for edition, copies in get:
        if copies > theirs.get(edition, 0):
            refuse(409, 'NOT_TRADEABLE', edition_id=edition, available=theirs.get(edition, 0), side='you_get')


def insert_proposal(conn, proposer_id: str, recipient_id: str, names: dict, give, get, cash,
                    countered_from: UUID | None = None) -> UUID:
    """Inserts a ``proposed`` Trade with its lines in the given order and, when the proposer gives cards, their picks.
    ``names``: ``collector_profile`` rows by user id. ``countered_from``: the proposal a Counter answers. Returns the
    new id; the caller advances revisions and stores the view."""
    trade_id = uuid4()
    conn.execute("""INSERT INTO trade(id, state, proposer_id, recipient_id, proposer_name, recipient_name,
                          cash_cents, cash_payer, countered_from)
        VALUES (%s, 'proposed', %s, %s, %s, %s, %s, %s, %s)""",
                 (trade_id, proposer_id, recipient_id, names[proposer_id]['display_name'],
                  names[recipient_id]['display_name'], cash[0] if cash else 0,
                  ('proposer' if cash[1] == 'you' else 'recipient') if cash else None, countered_from))
    for side, lines in (('proposer', give), ('recipient', get)):
        for position, (edition, copies) in enumerate(lines):
            conn.execute('INSERT INTO trade_line(trade_id, side, edition_id, position, quantity) '
                         'VALUES (%s, %s, %s, %s, %s)', (trade_id, side, edition, position, copies))
    if give:
        make_trade_picks(conn, proposer_id, trade_id, 'proposer', dict(give))
    return trade_id


@router.post('', response_model=TradeView, status_code=201)
def send_trade_proposal(command: SendTradeProposal, user_id: str = Depends(verified_user)):
    """Sends a Friend a Trade Proposal and reserves the copies the sender gives. Refused before anything is read, in
    this order: 409 OWN_ACCOUNT, 422 INVALID_QUANTITY, 422 DUPLICATE_EDITION (one Edition twice on one side), 422
    SAME_CARD_BOTH_SIDES, 422 TOO_MANY_LINES, 422 TRADE_HAS_NO_CARDS, 422 INVALID_CASH. Then, under the sender's lock:
    409 NOT_FRIENDS, 409 CASH_ONLY_NOT_OPEN (``side``: the sender's side that gives no cards and pays, when the
    recipient isn't Open to cash offers), and 409 NOT_TRADEABLE (``edition_id``, ``available`` and ``side``, 'you_give'
    or 'you_get') for the first line, the sender's lines first, that asks for more copies than are on that side's Trade
    List now."""
    if command.recipient_id == user_id:
        error(409, 'OWN_ACCOUNT')
    give, get, cash = proposal_shape(command.you_give, command.you_get, command.cash)
    payload = {'action': 'trade_send', **command.model_dump(mode='json', exclude={'idempotency_key'})}
    if command.cash is None:
        payload.pop('cash')     # a cash-free send keeps the digest it had before cash, so replays survive the deploy
    try:
        with connect() as conn, conn.transaction():
            digest, stored = begin_trade_command(conn, user_id, command.idempotency_key, payload)
            if stored is not None:
                return stored
            # Only the sender's own rows are reserved; the Friend's are read, never locked.
            lock_owners(conn, user_id)
            if command.recipient_id not in friend_ids(conn, user_id):
                error(409, 'NOT_FRIENDS')
            profiles = {row['user_id']: row for row in conn.execute(
                'SELECT user_id, display_name, open_to_cash_offers FROM collector_profile WHERE user_id = ANY(%s)',
                ([user_id, command.recipient_id],))}
            cash_side = cash_only_side(give, get, cash)
            if cash_side and not (profiles.get(command.recipient_id) or {}).get('open_to_cash_offers'):
                refuse(409, 'CASH_ONLY_NOT_OPEN', side=cash_side)
            check_trade_caps(conn, user_id, command.recipient_id, give, get)
            trade_id = insert_proposal(conn, user_id, command.recipient_id, profiles, give, get, cash)
            if give:
                advance_revision(conn, user_id)
            return store_trade(conn, user_id, command.idempotency_key, digest, trade_id)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


@router.post('/{trade_id}/accept', response_model=TradeView)
def accept_trade(trade_id: UUID, step: TradeStep, user_id: str = Depends(verified_user)):
    """The recipient accepts a Trade Proposal whole, and it becomes a Trade. After ``run_trade_step``'s checks (404
    TRADE_NOT_FOUND, 409 TRADE_CHANGED, 409 STEP_NOT_ALLOWED), under the recipient's own lock: 409 NOT_FRIENDS once the
    proposer isn't their Friend, then 409 NOT_TRADEABLE (``edition_id``, ``available``, ``side`` 'you_give') for the
    first line they give, in the order listed, that asks for more copies than are on their Trade List now. Nothing
    changes on a refusal. The proposer gets an 'accepted' update."""
    def apply(conn, row):
        if row['proposer_id'] not in friend_ids(conn, user_id):
            error(409, 'NOT_FRIENDS')
        give = [(line['edition_id'], int(line['quantity'])) for line in conn.execute(
            "SELECT edition_id, quantity FROM trade_line WHERE trade_id=%s AND side='recipient' ORDER BY position",
            (row['id'],))]
        if give:
            # This Trade's recipient side doesn't reserve until the row turns accepted, so it never counts against
            # itself here.
            mine = own_trade_copies(conn, user_id, [edition for edition, _ in give])
            for edition, copies in give:
                if copies > mine.get(edition, 0):
                    refuse(409, 'NOT_TRADEABLE', edition_id=edition, available=mine.get(edition, 0), side='you_give')
            make_trade_picks(conn, user_id, row['id'], 'recipient', dict(give))
            advance_revision(conn, user_id)
        record_trade_update(conn, row, user_id, 'accepted')
        return {'state': 'accepted', 'accepted_at': NOW}

    # Only the recipient may accept, so only the caller's own owner row is ever locked; a proposer's try locks none.
    return run_trade_step(user_id, trade_id, step, 'accept', apply,
                          lambda role, row: [row['recipient_id']] if role == 'recipient' else [])


def had_cash_only_side(conn, row) -> bool:
    """Whether the countered proposal had a cash-only side: its cash payer's side gave no cards and paid the cash (a
    gift plus cash, or cash beside cards on both sides, has none). Trading #278's exemption from CASH_ONLY_NOT_OPEN."""
    return row['cash_payer'] is not None and not side_gives(conn, row['id'], row['cash_payer'])


@router.post('/{trade_id}/counter', response_model=TradeView)
def counter_trade(trade_id: UUID, command: CounterTrade, user_id: str = Depends(verified_user)):
    """The recipient counters a waiting Trade Proposal (Trading #278): it closes as 'countered', which frees the copies
    its sender gave, and the sender is sent the reply as a new proposal (``countered_from`` the old one), reserving the
    copies the counterer gives. Answers the new Trade as the counterer reads it. One transaction, own flow rather than
    ``run_trade_step``. Refused before anything is read or counted, in a send's order (without OWN_ACCOUNT): 422
    INVALID_QUANTITY, DUPLICATE_EDITION, SAME_CARD_BOTH_SIDES, TOO_MANY_LINES, TRADE_HAS_NO_CARDS, INVALID_CASH. Then,
    after the command begins (a replay answers the stored view): 404 TRADE_NOT_FOUND for anyone but its two sides; both
    owners are locked (ascending) when the caller is the recipient, then the row; 409 TRADE_CHANGED; 409
    STEP_NOT_ALLOWED unless 'counter' is allowed; 409 NOT_FRIENDS; 409 CASH_ONLY_NOT_OPEN (``side``) for a Counter with
    a cash-only side to a sender who isn't Open to cash offers, unless the countered proposal had a cash-only side
    itself. The old row closes and its picks go in that close; only then are the caps read (409 NOT_TRADEABLE, the
    counterer's lines first), so a Counter may ask for every copy the sender had listed. A refusal rolls everything
    back and leaves the original waiting with its picks. Nothing is stored for the inbox: the new proposal is the
    sender's waiting answer. A side's revision moves only when its cards are released (the sender, if they gave cards)
    or reserved (the counterer, if the Counter gives cards)."""
    give, get, cash = proposal_shape(command.you_give, command.you_get, command.cash)
    payload = {'action': 'trade_counter', 'trade_id': str(trade_id),
               **command.model_dump(mode='json', exclude={'idempotency_key'})}
    try:
        with connect() as conn, conn.transaction():
            digest, stored = begin_trade_command(conn, user_id, command.idempotency_key, payload)
            if stored is not None:
                return stored
            sides = conn.execute(TRADES + ' AND t.id = %(id)s', {'me': user_id, 'id': trade_id}).fetchone()
            if sides is None:
                error(404, 'TRADE_NOT_FOUND')
            if role_of(user_id, sides) == 'recipient':     # a proposer's try locks nothing before it is refused
                lock_owners(conn, *[o for o in (sides['proposer_id'], sides['recipient_id']) if o is not None])
            old = conn.execute('SELECT * FROM trade WHERE id = %s FOR NO KEY UPDATE', (trade_id,)).fetchone()
            if old['revision'] != command.revision:
                error(409, 'TRADE_CHANGED')
            if 'counter' not in allowed(user_id, old, side_gives(conn, trade_id, role_of(user_id, old))):
                error(409, 'STEP_NOT_ALLOWED')
            friend = old['proposer_id']
            if friend not in friend_ids(conn, user_id):
                error(409, 'NOT_FRIENDS')
            profiles = {row['user_id']: row for row in conn.execute(
                'SELECT user_id, display_name, open_to_cash_offers FROM collector_profile WHERE user_id = ANY(%s)',
                ([user_id, friend],))}
            cash_side = cash_only_side(give, get, cash)
            if (cash_side and not (profiles.get(friend) or {}).get('open_to_cash_offers')
                    and not had_cash_only_side(conn, old)):
                refuse(409, 'CASH_ONLY_NOT_OPEN', side=cash_side)
            released = side_gives(conn, trade_id, 'proposer')
            write_trade(conn, trade_id, close_trade(conn, old, user_id, 'countered'))
            check_trade_caps(conn, user_id, friend, give, get)     # after the close: the sender's copies are free again
            new_id = insert_proposal(conn, user_id, friend, profiles, give, get, cash, countered_from=trade_id)
            if released:
                advance_revision(conn, friend)
            if give:
                advance_revision(conn, user_id)
            return store_trade(conn, user_id, command.idempotency_key, digest, new_id)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


@router.get('/{trade_id}/side', response_model=OwnTradeSide)
def trade_side(trade_id: UUID, user_id: str = Depends(verified_user)):
    """The reader's own Trade Pick List with their own Location names, which picks are out of date and what Use
    suggested picks would make. One snapshot, no lock, no write. 404 TRADE_NOT_FOUND for anyone who isn't one of the
    Trade's two sides, as for a Trade that doesn't exist."""
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        row = conn.execute(
            'SELECT id, proposer_id FROM trade WHERE id = %s AND (proposer_id = %s OR recipient_id = %s)',
            (trade_id, user_id, user_id)).fetchone()
        if row is None:
            error(404, 'TRADE_NOT_FOUND')
        side = 'proposer' if row['proposer_id'] == user_id else 'recipient'
        position = {line['edition_id']: index for index, line in enumerate(conn.execute(
            'SELECT edition_id FROM trade_line WHERE trade_id = %s AND side = %s ORDER BY position', (trade_id, side)))}
        picks, short, _ = trade_pick_shortfalls(conn, user_id, {trade_id})
        mine: dict[tuple[UUID, UUID | None], int] = {}
        shortfall: dict[tuple[UUID, UUID | None], int] = {}
        for pick in picks:
            key = (pick['edition_id'], pick['source_location_id'])
            mine[key] = mine.get(key, 0) + int(pick['quantity'])
            shortfall[key] = shortfall.get(key, 0) + short[pick['id']]
        replaced = replacement_trade_picks(conn, user_id, trade_id) if any(shortfall.values()) else None
        names = {location['id']: location['name'] for location in conn.execute(
            'SELECT id, name FROM location WHERE owner_id = %s', (user_id,))}

    def places(found: dict, missing: dict) -> list[TradePickPlace]:
        ordered = sorted(found.items(), key=lambda item: (position.get(item[0][0], len(position)), -item[1],
                                                           names.get(item[0][1], 'Unsorted').casefold(),
                                                           str(item[0][1])))
        return [TradePickPlace(edition_id=edition, location_id=location, name=names.get(location, 'Unsorted'),
                               copies=str(copies), short=str(missing.get((edition, location), 0)))
                for (edition, location), copies in ordered]

    return OwnTradeSide(trade_id=trade_id, picks=places(mine, shortfall),
                        suggested=places(replaced, {}) if replaced else [])


@router.post('/{trade_id}/picks/use-suggested', response_model=TradeView)
def use_suggested_trade_picks(trade_id: UUID, step: TradeStep, user_id: str = Depends(verified_user)):
    """The side that gives cards replaces every out-of-date pick of theirs with the suggested one
    (``OwnTradeSide.suggested``), under their own lock; only their picks change and only their revision moves. After
    ``run_trade_step``'s checks (404 TRADE_NOT_FOUND, 409 TRADE_CHANGED, 409 STEP_NOT_ALLOWED for a side that gives
    nothing or no longer reserves), 409 PICKS_UP_TO_DATE when no pick is out of date."""
    def apply(conn, row):
        side = role_of(user_id, row)
        replaced = replacement_trade_picks(conn, user_id, row['id'])
        if replaced is None:
            error(409, 'PICKS_UP_TO_DATE')
        conn.execute('DELETE FROM trade_pick WHERE trade_id = %s AND side = %s', (row['id'], side))
        insert_trade_picks(conn, user_id, row['id'], side, replaced)
        advance_revision(conn, user_id)
        return None

    return run_trade_step(user_id, trade_id, step, 'use_suggested_picks', apply, lambda role, row: [user_id])


def _destination(conn, user_id: str, destination_id: UUID | None) -> UUID:
    """Where the confirmer's received cards go: the Storage Leaf or Deck they chose, else 404 LOCATION_NOT_FOUND; or,
    with none chosen, their root Unsorted, made when missing (409 UNSORTED_UNAVAILABLE when the root named Unsorted
    can't hold cards). Plain selects under the owner lock the step took, never ``location_tree.owner_and_rows``."""
    if destination_id is not None:
        if not leaf(conn, user_id, destination_id):
            error(404, 'LOCATION_NOT_FOUND')
        return destination_id
    rows = {row['id']: row for row in conn.execute(
        'SELECT id, name, kind, parent_id, version FROM location WHERE owner_id = %s', (user_id,))}
    return unsorted_leaf(conn, user_id, rows, None)


@router.post('/{trade_id}/confirm-swap', response_model=TradeView)
def confirm_swap(trade_id: UUID, command: ConfirmSwap, user_id: str = Depends(verified_user)):
    """One side confirms the in-person swap for their own inventory, under their own lock only. After
    ``run_trade_step``'s checks (404 TRADE_NOT_FOUND, 409 TRADE_CHANGED, 409 STEP_NOT_ALLOWED, so a side confirms once),
    and before any write: 409 PICKS_OUT_OF_DATE while a pick of theirs is out of date; for a side that gets cards, 404
    LOCATION_NOT_FOUND or 409 UNSORTED_UNAVAILABLE for where they go. Then the copies they give leave, the copies they
    get arrive, their revision moves once, the copies they get beyond their Decks' needs lower their Trade Wants, and
    their swap time is set; when the other side already confirmed, the Trade closes as swapped and the other side gets
    a 'swapped' update. Nothing changes on a refusal, and nothing undoes it.
    """
    def apply(conn, row):
        side = role_of(user_id, row)
        other = other_side(side)
        # Read under the confirmer's own lock, with no FOR UPDATE, before anything is written.
        revision = conn.execute('SELECT revision FROM inventory_owner WHERE user_id = %s',
                                (user_id,)).fetchone()['revision']
        gives = side_gives(conn, row['id'], side)
        if gives and row['id'] in stale_pick_trades(conn, user_id, [row['id']]):
            error(409, 'PICKS_OUT_OF_DATE')
        # The other side's cards, from the Trade's own lines: their account may be gone.
        received = [(line['edition_id'], int(line['quantity'])) for line in conn.execute(
            'SELECT edition_id, quantity FROM trade_line WHERE trade_id = %s AND side = %s ORDER BY position',
            (row['id'], other))]
        # Their Decks' needs for the cards they get, before anything is written: the received copies fill those first,
        # and only the rest lower their Trade Wants (#275). Plain reads under the lock this step took.
        needs = edition_needs(conn, user_id, [edition for edition, _ in received]) if received else {}
        destination = _destination(conn, user_id, command.destination_id) if received else None
        new_revision = revision + 1
        if gives:
            items = [(pick['source_location_id'], pick['edition_id'], int(pick['copies'])) for pick in conn.execute(
                """SELECT source_location_id, edition_id, sum(quantity)::bigint AS copies FROM trade_pick
                WHERE trade_id = %s AND side = %s GROUP BY source_location_id, edition_id
                ORDER BY source_location_id, edition_id""", (row['id'], side))]
            # A Holding short of its picked copies can't happen while the picks are current: HoldingShort is a bug,
            # and the whole step rolls back.
            new_revision = take_out(conn, user_id, items, revision)
            conn.execute('DELETE FROM trade_pick WHERE trade_id = %s AND side = %s', (row['id'], side))
        if received:
            add_in(conn, user_id, destination, received, new_revision)
            # Trading #279 applies the chosen Deck switches here, after the received copies and before Trade Wants.
            lower_trade_wants(conn, user_id, received, needs)
        changes = {f'{side}_swap_at': NOW}
        if row[f'{other}_swap_at'] is not None:
            record_trade_update(conn, row, user_id, 'swapped')
            changes.update(close_trade(conn, row, user_id, 'swapped'))
        return changes

    return run_trade_step(user_id, trade_id, command, 'confirm_swap', apply, lambda role, row: [user_id],
                          {'destination_id': None if command.destination_id is None else str(command.destination_id)})
