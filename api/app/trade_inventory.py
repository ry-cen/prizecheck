"""The Trade steps that read or reserve a collector's own inventory (Trading #270, resolution "Module boundary" and "API
contract").

The shared Trade facts and the steps that change no inventory of the reader's are ``social.trades`` under
``/api/social/trades``; the contract guard keeps that area from reading any inventory table. What needs one
collector's own Locations and Holdings is here, under ``/api/trades``, and never answers one side's Locations to the
other:

- **Send a Trade Proposal** (``POST /api/trades``). The sender names the recipient (a Friend by user id, or any
  collector in reach by trader id, Trading #299), the Card Editions they give (``you_give``) and the ones they ask for
  (``you_get``); either side may be empty, so a gift either way is a proposal too, but not both. Cash is an amount and
  a payer together (Trading #277); the app records it and never handles money. Each line the sender gives is capped at
  their own listable copies (``trade_list.own_trade_copies``), and each line they ask for at the recipient's
  (``friend_copies.friend_trade_copies``), both through migration 142's one listable rule on this step's own
  connection. Sending reserves the copies the sender gives at once (``trade_picks.make_trade_picks``), so they leave
  both Trade Lists, stop counting as Spare Copies and stop being lendable until the proposal closes. Nothing of the
  recipient's is reserved. The send opens the pair's conversation, which attaches their earlier Trades.

- **Accept a Trade Proposal** (``POST /api/trades/{id}/accept``, Trading #271). The recipient takes it whole: the body
  names only the revision they read and an idempotency key. Under the recipient's lock it checks the proposer is still
  in their reach (``discovery.reach_one``), caps each line they give at their own listable copies, reserves those
  copies at once (``make_trade_picks``) and turns the proposal into a Trade. The proposer's copies were reserved by the
  send and stay so. A recipient who gives nothing (a gift to them) accepts with no cap and no pick.

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
  as swapped and tells the side that confirmed first. The swap itself is not undoable, and cash changes nothing (the
  app never handles money). The copies they get fill their Decks' needs for each exact Edition first, read before
  anything is written (``want_list.edition_needs``), and only the rest lower their Trade Wants line for it
  (``trade_wants.lower_trade_wants``, Trading #275). The Deck switches the collector left ticked (Trading #279) apply
  in the same transaction as Deck List changes, and the answer (``ConfirmedSwap``) names each switched Deck's new
  revision and the Deck List changes batch that undoes its switch, stored with the replay.

**Locks**: the stepping collector's own owner row only (``owners.lock_owners``), except that a Counter locks both
sides (the sender, whose copies it releases, and the counterer, whose copies it reserves) in ascending order, and a send
locks both too (after the advisory locks ``trade_command`` and ``new_conversation``), because it may create the pair's
conversation and attaches their earlier Trades. An accept never creates one: a proposal always has its pair's. So a
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
from collections.abc import Iterable, Mapping
from typing import Literal
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .deck_deletion import unsorted_leaf
from .decks import advance_deck_list, write_deck_list
from .loan_inventory import refuse
from .location_tree import error
from .main import connect, verified_user
from .moves import add_in, is_deck, leaf, quantity, take_out
from .social.conversations import new_conversation_lock, open_conversation
from .social.discovery import reach_one, require_not_suspended, trader_user
from .social.friend_reads import card_facts
from .social.friend_copies import friend_trade_copies
from .social.loans import NOW, advance_revision
from .social.owners import lock_owners
from .social.trades import (TRADES, TradeStep, TradeView, allowed, begin_trade_command, close_trade, other_side,
                            record_trade_update, role_of, run_trade_step, side_gives, store_trade, write_trade)
from .trade_list import own_trade_copies
from .trade_picks import (insert_trade_picks, make_trade_picks, replacement_trade_picks, stale_pick_trades,
                          trade_pick_shortfalls)
from .trade_wants import lower_trade_wants
from .want_list import DeckSwitch, deck_switch_candidates, edition_needs

router = APIRouter(prefix='/api/trades', tags=['trades'])

# Card Editions one side of a Trade may list.
MAX_TRADE_LINES = 50
# Copies one Trade line may name.
MAX_TRADE_COPIES = 9999
# Deck switches one Confirm swap may choose (Trading #279).
MAX_DECK_SWITCHES = 50


class TradeLineRequest(BaseModel):
    edition_id: UUID
    quantity: str           # "1" to "9999"


class TradeCashRequest(BaseModel):
    cents: str                       # whole US cents "1".."99999999", else 422 INVALID_CASH
    payer: Literal['you', 'them']    # relative to the collector sending this proposal


class SendTradeProposal(BaseModel):
    """A Trade Proposal. Exactly one of ``recipient_id`` (a Friend's user id, as before) and ``recipient_trader_id``
    (any collector in reach) names the recipient; neither or both is 422 RECIPIENT_REQUIRED."""
    recipient_id: str | None = Field(default=None, min_length=1, max_length=200)
    recipient_trader_id: UUID | None = None
    you_give: list[TradeLineRequest] = []
    you_get: list[TradeLineRequest] = []
    cash: TradeCashRequest | None = None
    idempotency_key: UUID


class DeckSwitchRequest(BaseModel):
    deck_id: UUID
    from_edition_id: UUID
    to_edition_id: UUID
    count: str              # "1".."9999"


class ConfirmSwap(TradeStep):
    """Confirm swap. ``destination_id``: one of the confirmer's own Storage Leaves or Decks for the cards they get, or
    None for Unsorted; ignored when they get none. ``deck_switches``: the switches the collector left ticked, each as
    the side read offered it, with at most its count."""
    destination_id: UUID | None = None
    deck_switches: list[DeckSwitchRequest] = []


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


class SwitchCard(BaseModel):
    edition_id: UUID
    name: str
    set_code: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None


class DeckSwitchOffer(BaseModel):
    deck_id: UUID
    deck_name: str
    from_edition_id: UUID
    to_edition_id: UUID
    count: str
    from_card: SwitchCard
    to_card: SwitchCard


class OwnTradeSide(BaseModel):
    """The reader's own side of a Trade. ``picks``: their Trade Pick List while their copies are promised (empty when
    they give nothing, once they confirmed the swap, and once the Trade closed). ``suggested``: the Pick List **Use
    suggested picks** makes, when a pick is out of date, else empty. ``deck_switches``: the Deck switches Confirm swap
    offers for the cards they get (Trading #279); non-empty only while the Trade is accepted, they haven't confirmed
    the swap and they get cards."""
    trade_id: UUID
    picks: list[TradePickPlace]
    suggested: list[TradePickPlace]
    deck_switches: list[DeckSwitchOffer]


class SwitchedLine(BaseModel):
    edition_id: UUID
    quantity: str


class SwitchedDeck(BaseModel):
    """A Deck one Confirm swap switched: the Deck List revision the switch produced, and the totals the Deck List
    changes batch sets to undo it (``STALE_DECK_LIST`` once the list moves)."""
    deck_id: UUID
    revision: int
    undo: list[SwitchedLine]


class ConfirmedSwap(TradeView):
    """The confirmer's own answer to Confirm swap: the Trade as they read it, plus the Decks their chosen switches
    changed. Only ever answered to the confirmer under ``/api/trades``; ``TradeView`` itself never names a Deck."""
    switched_decks: list[SwitchedDeck] = []


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


def check_trade_caps(conn, user_id: str, other_id: str, give, get) -> None:
    """409 NOT_TRADEABLE (``edition_id``, ``available``, ``side``) for the first line that asks for more copies than are
    on that side's Trade List now: the caller's own lines first ('you_give'), then the other side's ('you_get'), read
    through the reach rule (``among='reach'``). Read on the caller's connection, after whatever the step released."""
    mine = own_trade_copies(conn, user_id, [edition for edition, _ in give])
    for edition, copies in give:
        if copies > mine.get(edition, 0):
            refuse(409, 'NOT_TRADEABLE', edition_id=edition, available=mine.get(edition, 0), side='you_give')
    theirs = {item.edition_id: item.listable for item in friend_trade_copies(
        conn, user_id, [other_id], [edition for edition, _ in get], among='reach')}
    for edition, copies in get:
        if copies > theirs.get(edition, 0):
            refuse(409, 'NOT_TRADEABLE', edition_id=edition, available=theirs.get(edition, 0), side='you_get')


def insert_proposal(conn, proposer_id: str, recipient_id: str, names: dict, give, get, cash,
                    countered_from: UUID | None = None, conversation_id: UUID | None = None) -> UUID:
    """Inserts a ``proposed`` Trade with its lines in the given order and, when the proposer gives cards, their picks.
    ``names``: ``collector_profile`` rows by user id. ``countered_from``: the proposal a Counter answers.
    ``conversation_id``: the pair's conversation; when None the BEFORE INSERT trigger gives the pair's. Returns the
    new id; the caller advances revisions and stores the view."""
    trade_id = uuid4()
    conn.execute("""INSERT INTO trade(id, state, proposer_id, recipient_id, proposer_name, recipient_name,
                          cash_cents, cash_payer, countered_from, conversation_id)
        VALUES (%s, 'proposed', %s, %s, %s, %s, %s, %s, %s, %s)""",
                 (trade_id, proposer_id, recipient_id, names[proposer_id]['display_name'],
                  names[recipient_id]['display_name'], cash[0] if cash else 0,
                  ('proposer' if cash[1] == 'you' else 'recipient') if cash else None, countered_from, conversation_id))
    for side, lines in (('proposer', give), ('recipient', get)):
        for position, (edition, copies) in enumerate(lines):
            conn.execute('INSERT INTO trade_line(trade_id, side, edition_id, position, quantity) '
                         'VALUES (%s, %s, %s, %s, %s)', (trade_id, side, edition, position, copies))
    if give:
        make_trade_picks(conn, proposer_id, trade_id, 'proposer', dict(give))
    return trade_id


@router.post('', response_model=TradeView, status_code=201)
def send_trade_proposal(command: SendTradeProposal, user_id: str = Depends(verified_user)):
    """Sends a Trade Proposal to a Friend (by ``recipient_id``) or to any collector in reach (by
    ``recipient_trader_id``) and reserves the copies the sender gives. Refused before anything is read, in this order:
    422 RECIPIENT_REQUIRED (neither or both recipient fields), 409 OWN_ACCOUNT (the user id is the sender's), 422
    INVALID_QUANTITY, 422 DUPLICATE_EDITION (one Edition twice on one side), 422 SAME_CARD_BOTH_SIDES, 422
    TOO_MANY_LINES, 422 TRADE_HAS_NO_CARDS, 422 INVALID_CASH. Then, after the command begins (a replay answers here):
    403 ACCOUNT_SUSPENDED (the sender), 409 COLLECTOR_UNAVAILABLE (an unknown trader id, the sender's own, or a
    recipient outside reach; by user id the recipient must be a Friend), checked once before the locks and again under
    them, 429 TOO_MANY_NEW_CONVERSATIONS (``retry_after_minutes``) when the send opens a conversation with a collector
    who is not a Friend and the sender has started 10 in the last 24 hours, 409 CASH_ONLY_NOT_OPEN
    (``side``: the sender's side that gives no cards and pays, when the recipient isn't Open to cash offers), and 409
    NOT_TRADEABLE (``edition_id``, ``available`` and ``side``, 'you_give' or 'you_get') for the first line, the
    sender's lines first, that asks for more copies than are on that side's Trade List now. Locks both owners and
    opens the pair's conversation (attaching their earlier Trades), so the Trade carries it."""
    if (command.recipient_id is None) == (command.recipient_trader_id is None):
        error(422, 'RECIPIENT_REQUIRED')
    if command.recipient_id == user_id:
        error(409, 'OWN_ACCOUNT')
    give, get, cash = proposal_shape(command.you_give, command.you_get, command.cash)
    payload = {'action': 'trade_send', **command.model_dump(mode='json', exclude={'idempotency_key'})}
    if command.recipient_trader_id is None:
        payload.pop('recipient_trader_id')      # a send by user id keeps the digest it had, so replays survive the deploy
    if command.recipient_id is None:
        payload.pop('recipient_id')
    if command.cash is None:
        payload.pop('cash')     # a cash-free send keeps the digest it had before cash, so replays survive the deploy
    try:
        with connect() as conn, conn.transaction():
            digest, stored = begin_trade_command(conn, user_id, command.idempotency_key, payload)
            if stored is not None:
                return stored
            require_not_suspended(conn, user_id)
            if command.recipient_trader_id is not None:
                recipient = trader_user(conn, command.recipient_trader_id)
                if recipient is None or recipient == user_id:
                    error(409, 'COLLECTOR_UNAVAILABLE')
            else:
                recipient = command.recipient_id
                early = reach_one(conn, user_id, recipient)
                if early is None or early.how != 'friend':
                    error(409, 'COLLECTOR_UNAVAILABLE')
            # Both owners are locked (a conversation may be created for the pair), after the advisory locks.
            new_conversation_lock(conn, user_id)
            lock_owners(conn, user_id, recipient)
            found = reach_one(conn, user_id, recipient)
            if found is None or (command.recipient_id is not None and found.how != 'friend'):
                error(409, 'COLLECTOR_UNAVAILABLE')
            conversation = open_conversation(conn, user_id, recipient, found.how)
            profiles = {row['user_id']: row for row in conn.execute(
                'SELECT user_id, display_name, open_to_cash_offers FROM collector_profile WHERE user_id = ANY(%s)',
                ([user_id, recipient],))}
            cash_side = cash_only_side(give, get, cash)
            if cash_side and not (profiles.get(recipient) or {}).get('open_to_cash_offers'):
                refuse(409, 'CASH_ONLY_NOT_OPEN', side=cash_side)
            check_trade_caps(conn, user_id, recipient, give, get)
            trade_id = insert_proposal(conn, user_id, recipient, profiles, give, get, cash, conversation_id=conversation)
            if give:
                advance_revision(conn, user_id)
            return store_trade(conn, user_id, command.idempotency_key, digest, trade_id)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


@router.post('/{trade_id}/accept', response_model=TradeView)
def accept_trade(trade_id: UUID, step: TradeStep, user_id: str = Depends(verified_user)):
    """The recipient accepts a Trade Proposal whole, and it becomes a Trade. After ``run_trade_step``'s checks (404
    TRADE_NOT_FOUND, 409 TRADE_CHANGED, 409 STEP_NOT_ALLOWED), under the recipient's own lock: 403 ACCOUNT_SUSPENDED
    (the recipient), 409 COLLECTOR_UNAVAILABLE once the proposer isn't in their reach (a deleted proposer included),
    then 409 NOT_TRADEABLE (``edition_id``, ``available``, ``side`` 'you_give') for the first line they give, in the
    order listed, that asks for more copies than are on their Trade List now. Nothing changes on a refusal. The
    proposer gets an 'accepted' update."""
    def apply(conn, row):
        require_not_suspended(conn, user_id)
        if reach_one(conn, user_id, row['proposer_id']) is None:
            error(409, 'COLLECTOR_UNAVAILABLE')
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
    STEP_NOT_ALLOWED unless 'counter' is allowed; 403 ACCOUNT_SUSPENDED (the counterer); 409 COLLECTOR_UNAVAILABLE (the
    sender isn't in the counterer's reach); 409 CASH_ONLY_NOT_OPEN (``side``) for a Counter with
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
            require_not_suspended(conn, user_id)
            other = old['proposer_id']
            if reach_one(conn, user_id, other) is None:
                error(409, 'COLLECTOR_UNAVAILABLE')
            profiles = {row['user_id']: row for row in conn.execute(
                'SELECT user_id, display_name, open_to_cash_offers FROM collector_profile WHERE user_id = ANY(%s)',
                ([user_id, other],))}
            cash_side = cash_only_side(give, get, cash)
            if (cash_side and not (profiles.get(other) or {}).get('open_to_cash_offers')
                    and not had_cash_only_side(conn, old)):
                refuse(409, 'CASH_ONLY_NOT_OPEN', side=cash_side)
            released = side_gives(conn, trade_id, 'proposer')
            write_trade(conn, trade_id, close_trade(conn, old, user_id, 'countered'))
            check_trade_caps(conn, user_id, other, give, get)     # after the close: the sender's copies are free again
            new_id = insert_proposal(conn, user_id, other, profiles, give, get, cash, countered_from=trade_id)
            if released:
                advance_revision(conn, other)
            if give:
                advance_revision(conn, user_id)
            return store_trade(conn, user_id, command.idempotency_key, digest, new_id)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


@router.get('/{trade_id}/side', response_model=OwnTradeSide)
def trade_side(trade_id: UUID, destination_id: UUID | None = None, user_id: str = Depends(verified_user)):
    """The reader's own Trade Pick List with their own Location names, which picks are out of date and what Use
    suggested picks would make. One snapshot, no lock, no write. 404 TRADE_NOT_FOUND for anyone who isn't one of the
    Trade's two sides, as for a Trade that doesn't exist. ``deck_switches`` (Trading #279) are what Confirm swap would
    offer now, only while the Trade is accepted, the reader hasn't confirmed and they get cards; ``destination_id``: the
    Deck the cards would arrive in, offering that Deck only (anything else reads as no Deck destination)."""
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        row = conn.execute(
            'SELECT id, proposer_id, state, proposer_swap_at, recipient_swap_at FROM trade '
            'WHERE id = %s AND (proposer_id = %s OR recipient_id = %s)',
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
        other = other_side(side)
        received = [(line['edition_id'], int(line['quantity'])) for line in conn.execute(
            'SELECT edition_id, quantity FROM trade_line WHERE trade_id = %s AND side = %s ORDER BY position',
            (trade_id, other))]
        offers: list[DeckSwitch] = []
        if row['state'] == 'accepted' and row[f'{side}_swap_at'] is None and received:
            deck = destination_id if destination_id is not None and is_deck(conn, user_id, destination_id) else None
            offers = deck_switch_candidates(conn, user_id, received, deck_destination=deck)
        facts = card_facts(conn, [edition for offer in offers
                                  for edition in (offer.from_edition_id, offer.to_edition_id)])

    def places(found: dict, missing: dict) -> list[TradePickPlace]:
        ordered = sorted(found.items(), key=lambda item: (position.get(item[0][0], len(position)), -item[1],
                                                           names.get(item[0][1], 'Unsorted').casefold(),
                                                           str(item[0][1])))
        return [TradePickPlace(edition_id=edition, location_id=location, name=names.get(location, 'Unsorted'),
                               copies=str(copies), short=str(missing.get((edition, location), 0)))
                for (edition, location), copies in ordered]

    def card(edition: UUID) -> SwitchCard:
        found = facts[edition]
        return SwitchCard(edition_id=edition, name=found.name, set_code=found.set_code, set_name=found.set_name,
                          collector_number=found.collector_number, descriptor=found.descriptor,
                          image_url=found.image_url)

    return OwnTradeSide(trade_id=trade_id, picks=places(mine, shortfall),
                        suggested=places(replaced, {}) if replaced else [],
                        deck_switches=[DeckSwitchOffer(deck_id=offer.deck_id, deck_name=names[offer.deck_id],
                                                       from_edition_id=offer.from_edition_id,
                                                       to_edition_id=offer.to_edition_id, count=str(offer.count),
                                                       from_card=card(offer.from_edition_id),
                                                       to_card=card(offer.to_edition_id)) for offer in offers])


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


def requested_switches(command: ConfirmSwap) -> list[tuple[UUID, UUID, UUID, int]]:
    """The Deck switches a Confirm swap asks for, as ``(deck, from, to, copies)`` in request order. The shape checks, in
    order, before any read: 422 INVALID_QUANTITY, 422 DUPLICATE_EDITION (one Deck, from and to twice), 422
    TOO_MANY_LINES (Trading #279)."""
    items = [(item.deck_id, item.from_edition_id, item.to_edition_id, trade_quantity(item.count))
             for item in command.deck_switches]
    if len({item[:3] for item in items}) != len(items):
        error(422, 'DUPLICATE_EDITION')
    if len(items) > MAX_DECK_SWITCHES:
        error(422, 'TOO_MANY_LINES')
    return items


def _line_totals(conn, user_id: str, switches: Iterable[DeckSwitch]) -> dict[tuple[UUID, UUID], int]:
    """The Deck List line totals ``(deck, edition)`` the switches name, one plain read; a line that isn't listed is
    absent (0)."""
    switches = list(switches)
    if not switches:
        return {}
    wanted = {(s.deck_id, edition) for s in switches for edition in (s.from_edition_id, s.to_edition_id)}
    return {(row['deck_id'], row['edition_id']): int(row['quantity']) for row in conn.execute(
        """SELECT deck_id, edition_id, quantity FROM deck_list_line
        WHERE owner_id = %s AND deck_id = ANY(%s) AND edition_id = ANY(%s)""",
        (user_id, list({deck for deck, _ in wanted}), list({edition for _, edition in wanted})))
        if (row['deck_id'], row['edition_id']) in wanted}


def _chosen_switches(conn, user_id: str, received, destination: UUID | None, requested) -> list[DeckSwitch]:
    """The requested Deck switches, each matched against what is offered now by ``(deck, from, to)`` with at most its
    count, else 409 DECK_SWITCH_CHANGED. Nothing is read when none is requested."""
    if not requested:
        return []
    deck_destination = destination if destination is not None and is_deck(conn, user_id, destination) else None
    offered = {(s.deck_id, s.from_edition_id, s.to_edition_id): s.count for s in deck_switch_candidates(
        conn, user_id, received, deck_destination=deck_destination)}
    for deck, from_edition, to_edition, count in requested:
        key = (deck, from_edition, to_edition)
        if key not in offered or count > offered[key]:
            error(409, 'DECK_SWITCH_CHANGED')
    return [DeckSwitch(*item) for item in requested]


def _switch_decks(conn, user_id: str, chosen: list[DeckSwitch],
                  before: Mapping[tuple[UUID, UUID], int]) -> list[SwitchedDeck]:
    """Applies the chosen Deck switches after the received copies arrived (Trading #279), one Deck List write and one
    revision advance for each Deck they change. The received card's line rises to at least its total before the swap
    plus the copies switched; copies that arrived in this Deck already raised it, so they are not counted twice. The
    undo puts each changed line back to its total just before the switch, after the arrival."""
    current = _line_totals(conn, user_id, chosen)
    switched: list[SwitchedDeck] = []
    for deck in dict.fromkeys(item.deck_id for item in chosen):
        lowered: dict[UUID, int] = {}
        raised: dict[UUID, int] = {}
        for item in chosen:
            if item.deck_id == deck:
                lowered[item.from_edition_id] = lowered.get(item.from_edition_id, 0) + item.count
                raised[item.to_edition_id] = raised.get(item.to_edition_id, 0) + item.count
        targets: dict[UUID, int] = {}
        for edition in lowered.keys() | raised.keys():
            now = current.get((deck, edition), 0)
            if raised.get(edition):
                now = max(now, before.get((deck, edition), 0) + raised[edition])
            targets[edition] = now - lowered.get(edition, 0)
        if any(target < 0 for target in targets.values()):
            raise RuntimeError('Deck switch below zero')
        changed = {edition: target for edition, target in targets.items() if target != current.get((deck, edition), 0)}
        if not changed:
            continue
        write_deck_list(conn, user_id, deck, changed)
        result = advance_deck_list(conn, user_id, deck)
        switched.append(SwitchedDeck(deck_id=deck, revision=result['deck_list'].revision, undo=[
            SwitchedLine(edition_id=edition, quantity=str(current.get((deck, edition), 0)))
            for edition in sorted(changed, key=str)]))
    return switched


@router.post('/{trade_id}/confirm-swap', response_model=ConfirmedSwap)
def confirm_swap(trade_id: UUID, command: ConfirmSwap, user_id: str = Depends(verified_user)):
    """One side confirms the in-person swap for their own inventory, under their own lock only. After
    ``run_trade_step``'s checks (404 TRADE_NOT_FOUND, 409 TRADE_CHANGED, 409 STEP_NOT_ALLOWED, so a side confirms once),
    and before any write: 409 PICKS_OUT_OF_DATE while a pick of theirs is out of date; for a side that gets cards, 404
    LOCATION_NOT_FOUND or 409 UNSORTED_UNAVAILABLE for where they go; then 409 DECK_SWITCH_CHANGED when a Deck switch
    they chose is not offered now (``want_list.deck_switch_candidates``, with at most the offered copies). Their
    ``deck_switches`` are shape-checked before the transaction: 422 INVALID_QUANTITY, 422 DUPLICATE_EDITION, 422
    TOO_MANY_LINES. Then the copies they give leave, the copies they get arrive, their revision moves once, the Deck
    switches apply as Deck List changes (each switched Deck's Deck List revision advances once for the switch; the
    answer's ``switched_decks`` names it and the batch that undoes it), the copies they get beyond their Decks' needs lower their
    Trade Wants, and their swap time is set; when the other side already confirmed, the Trade closes as swapped and the
    other side gets a 'swapped' update. Nothing changes on a refusal, and nothing undoes the swap.
    """
    requested = requested_switches(command)
    switched: list[SwitchedDeck] = []

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
        chosen = _chosen_switches(conn, user_id, received, destination, requested)
        before = _line_totals(conn, user_id, chosen)
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
            switched.extend(_switch_decks(conn, user_id, chosen, before))     # after the arrival, before Trade Wants
            lower_trade_wants(conn, user_id, received, needs)
        changes = {f'{side}_swap_at': NOW}
        if row[f'{other}_swap_at'] is not None:
            record_trade_update(conn, row, user_id, 'swapped')
            changes.update(close_trade(conn, row, user_id, 'swapped'))
        return changes

    extra = {'destination_id': None if command.destination_id is None else str(command.destination_id)}
    if requested:
        extra['deck_switches'] = sorted([str(deck), str(from_edition), str(to_edition), str(count)]
                                        for deck, from_edition, to_edition, count in requested)
    return run_trade_step(user_id, trade_id, command, 'confirm_swap', apply, lambda role, row: [user_id], extra,
                          lambda: {'switched_decks': [item.model_dump(mode='json') for item in switched]})
