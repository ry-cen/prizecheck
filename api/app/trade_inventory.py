"""The Trade steps that read or reserve a collector's own inventory (Trading #270, resolution "Module boundary" and "API
contract").

The shared Trade facts and the steps that change no inventory of the reader's are ``social.trades`` under
``/api/social/trades``; the contract guard keeps that area from reading any inventory table. What needs one
collector's own Locations and Holdings is here, under ``/api/trades``, and never answers one side's Locations to the
other:

- **Send a Trade Proposal** (``POST /api/trades``). The sender names a Friend, the Card Editions they give
  (``you_give``) and the ones they ask for (``you_get``); either side may be empty, so a gift either way is a
  proposal too, but not both. Each line the sender gives is capped at their own listable copies
  (``trade_list.own_trade_copies``), and each line they ask for at the Friend's (``friend_copies.friend_trade_copies``),
  both through migration 142's one listable rule on this step's own connection. Sending reserves the copies the sender
  gives at once (``trade_picks.make_trade_picks``), so they leave both Trade Lists, stop counting as Spare Copies and
  stop being lendable until the proposal closes. Nothing of the Friend's is reserved or locked.

- **Accept a Trade Proposal** (``POST /api/trades/{id}/accept``, Trading #271). The recipient takes it whole: the
  body names only the revision they read and an idempotency key. Under the recipient's lock it checks the friendship
  (as the Loan accept does), caps each line they give at their own listable copies, reserves those copies at once
  (``make_trade_picks``) and turns the proposal into a Trade. The proposer's copies were reserved by the send and stay
  so. A recipient who gives nothing (a gift to them) accepts with no cap and no pick.

**Locks**: the stepping collector's own owner row only (``owners.lock_owners``), so a send or an accept and a Loan step
over the same copies run one after the other and the second sees the first's reservation; migration 142's deferred
triggers are the backstop. Each step moves its collector's revision when they give cards. The command lock, replay and
hourly count are ``social.trades``' (``begin_trade_command``); an accept runs through ``social.trades.run_trade_step``,
which locks the Trade row after the owner and writes it once.

Later tickets add each side's own view of a Trade with its picks (#272).
"""
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .loan_inventory import refuse
from .location_tree import error
from .main import connect, verified_user
from .moves import quantity
from .social.friend_copies import friend_trade_copies
from .social.friends import friend_ids
from .social.loans import NOW, advance_revision
from .social.owners import lock_owners
from .social.trades import (TradeStep, TradeView, begin_trade_command, record_trade_update, run_trade_step,
                            store_trade)
from .trade_list import own_trade_copies
from .trade_picks import make_trade_picks

router = APIRouter(prefix='/api/trades', tags=['trades'])

# Card Editions one side of a Trade may list.
MAX_TRADE_LINES = 50
# Copies one Trade line may name.
MAX_TRADE_COPIES = 9999


class TradeLineRequest(BaseModel):
    edition_id: UUID
    quantity: str           # "1" to "9999"


class SendTradeProposal(BaseModel):
    recipient_id: str = Field(min_length=1, max_length=200)
    you_give: list[TradeLineRequest] = []
    you_get: list[TradeLineRequest] = []
    idempotency_key: UUID


def trade_quantity(raw: str) -> int:
    """A Trade line's copies: a whole number from 1 to ``MAX_TRADE_COPIES``, else 422 INVALID_QUANTITY."""
    value = quantity(raw)
    if value > MAX_TRADE_COPIES:
        error(422, 'INVALID_QUANTITY')
    return value


@router.post('', response_model=TradeView, status_code=201)
def send_trade_proposal(command: SendTradeProposal, user_id: str = Depends(verified_user)):
    """Sends a Friend a Trade Proposal and reserves the copies the sender gives. Refused before anything is read, in
    this order: 409 OWN_ACCOUNT, 422 INVALID_QUANTITY, 422 DUPLICATE_EDITION (one Edition twice on one side), 422
    SAME_CARD_BOTH_SIDES, 422 TOO_MANY_LINES, 422 TRADE_HAS_NO_CARDS. Then, under the sender's lock: 409 NOT_FRIENDS,
    and 409 NOT_TRADEABLE (``edition_id``, ``available`` and ``side``, 'you_give' or 'you_get') for the first line, the
    sender's lines first, that asks for more copies than are on that side's Trade List now."""
    if command.recipient_id == user_id:
        error(409, 'OWN_ACCOUNT')
    give = [(line.edition_id, trade_quantity(line.quantity)) for line in command.you_give]
    get = [(line.edition_id, trade_quantity(line.quantity)) for line in command.you_get]
    for lines in (give, get):
        if len({edition for edition, _ in lines}) != len(lines):
            error(422, 'DUPLICATE_EDITION')
    if {edition for edition, _ in give} & {edition for edition, _ in get}:
        error(422, 'SAME_CARD_BOTH_SIDES')
    if len(give) > MAX_TRADE_LINES or len(get) > MAX_TRADE_LINES:
        error(422, 'TOO_MANY_LINES')
    if not give and not get:
        error(422, 'TRADE_HAS_NO_CARDS')
    payload = {'action': 'trade_send', **command.model_dump(mode='json', exclude={'idempotency_key'})}
    try:
        with connect() as conn, conn.transaction():
            digest, stored = begin_trade_command(conn, user_id, command.idempotency_key, payload)
            if stored is not None:
                return stored
            # Only the sender's own rows are reserved; the Friend's are read, never locked.
            lock_owners(conn, user_id)
            if command.recipient_id not in friend_ids(conn, user_id):
                error(409, 'NOT_FRIENDS')
            mine = own_trade_copies(conn, user_id, [edition for edition, _ in give])
            for edition, copies in give:
                if copies > mine.get(edition, 0):
                    refuse(409, 'NOT_TRADEABLE', edition_id=edition, available=mine.get(edition, 0), side='you_give')
            theirs = {item.edition_id: item.listable for item in friend_trade_copies(
                conn, user_id, [command.recipient_id], [edition for edition, _ in get])}
            for edition, copies in get:
                if copies > theirs.get(edition, 0):
                    refuse(409, 'NOT_TRADEABLE', edition_id=edition, available=theirs.get(edition, 0), side='you_get')
            names = {row['user_id']: row['display_name'] for row in conn.execute(
                'SELECT user_id, display_name FROM collector_profile WHERE user_id = ANY(%s)',
                ([user_id, command.recipient_id],))}
            trade_id = uuid4()
            conn.execute("""INSERT INTO trade(id, state, proposer_id, recipient_id, proposer_name, recipient_name)
                VALUES (%s, 'proposed', %s, %s, %s, %s)""",
                         (trade_id, user_id, command.recipient_id, names[user_id], names[command.recipient_id]))
            for side, lines in (('proposer', give), ('recipient', get)):
                for position, (edition, copies) in enumerate(lines):
                    conn.execute('INSERT INTO trade_line(trade_id, side, edition_id, position, quantity) '
                                 'VALUES (%s, %s, %s, %s, %s)', (trade_id, side, edition, position, copies))
            if give:
                make_trade_picks(conn, user_id, trade_id, 'proposer', dict(give))
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
