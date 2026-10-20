"""Trade Proposals and Trades as both sides read them (Trading #270, spec "Trade Proposals and the state model",
resolution "Module boundary" and "API contract").

Both sides read the same Trade facts here (``GET /api/social/trades`` and ``GET /api/social/trades/{id}``): the cards
each side gives, each side's swap confirmation and the other collector's Display Name, Handle and whether they are Open
to cash offers, never a pick, a Location or a Deck of either side. The steps that change no inventory of the reader's
own are here too; the one in this ticket is the proposer's withdraw. Sending a Trade Proposal reads and reserves the
sender's own inventory, so it is inventory code in ``app.trade_inventory`` under ``/api/trades``; it answers
``trade_view`` too, so every step answers the same Trade.

**Steps** name the Trade ``revision`` they read (409 TRADE_CHANGED when it moved on) and an idempotency key (replayed
from ``location_command``, as Loan commands are). ``allowed`` is the one rule for which steps a collector may take now:
the view's ``actions`` list them and a step not in it is 409 STEP_NOT_ALLOWED. A collector who isn't one of the Trade's
two sides gets 404 TRADE_NOT_FOUND, as for a Trade that doesn't exist. Every step on an existing Trade runs through
``run_trade_step``, which writes the ``trade`` row exactly once: the step's own columns and the revision in one UPDATE.

**Locks** follow the spec's table ("Locks and revisions"): owner rows in ascending ``user_id`` (``owners.lock_owners``),
then any ``loan`` row, then the ``trade`` row. Withdraw locks the proposer, whose copies it releases, and advances the
proposer's inventory revision when they gave cards.

**Limit.** Trade steps count against ``COMMANDS_PER_HOUR`` per account under kind 'trade_command'
(``count_trade_command``), apart from the Friend and Loan commands' counts, under a command lock of their own
(``begin_trade_command``). A replay isn't counted again; a refused step rolls back with its count.

**Updates**: a withdraw stores a 'cancelled' update for the recipient (``record_trade_update``), which the inbox reads
as withdrawn from the Trade's ``closed_reason``. The inbox lists Trade updates from Trading #273.

Later tickets add the recipient's accept and decline and either side's cancel (#271), Confirm swap and Use suggested
picks (#272), the inbox lines (#273), ending a friendship's Trades (#274), cash and the Open to cash offers setting
(#277) and Counter (#278).
"""
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from psycopg import sql
from pydantic import BaseModel, Field

from ..location_tree import error, replay
from ..main import connect, verified_user
from .friend_reads import card_facts
from .loans import NOW, advance_revision
from .owners import ensure_owner, lock_owners

router = APIRouter(prefix='/api/social/trades', tags=['social'])

COMMANDS_PER_HOUR = 120

# Closed Trades the Trades list shows, newest first.
HISTORY = 50

TradeAction = Literal['accept', 'decline', 'counter', 'confirm_swap', 'use_suggested_picks', 'withdraw', 'cancel']
ACTION_ORDER = ('accept', 'decline', 'counter', 'confirm_swap', 'use_suggested_picks', 'withdraw', 'cancel')


class TradeParty(BaseModel):
    """The other side of the Trade: ``collector_id`` and ``handle`` are None once that account is deleted; the name is
    kept. ``open_to_cash_offers``: their own setting (Trading #277 adds the route that changes it)."""
    collector_id: str | None
    display_name: str
    handle: str | None
    open_to_cash_offers: bool


class TradeCard(BaseModel):
    """One Card Edition one side gives, with how many copies."""
    edition_id: UUID
    name: str
    set_code: str           # The printed set code ("PAL"), or the TCGdex set ID when the set has none (set_codes).
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    copies: str


class TradeCash(BaseModel):
    """Cash recorded with the Trade, in US cents, and who pays it. The app never handles money (Trading #277)."""
    cents: str
    payer: Literal['you', 'them']


class TradeView(BaseModel):
    """One Trade Proposal or Trade as the reader sees it. ``you_give`` and ``you_get`` are the reader's side and the
    other side, in the order they were listed. Never a pick, a destination, a Location or a Deck."""
    id: UUID
    state: Literal['proposed', 'accepted', 'closed']
    closed_reason: Literal['declined', 'withdrawn', 'countered', 'cancelled', 'swapped'] | None
    closed_by: Literal['you', 'them'] | None
    role: Literal['proposer', 'recipient']
    other: TradeParty
    countered_from: UUID | None
    you_give: list[TradeCard]
    you_get: list[TradeCard]
    cash: TradeCash | None
    you_confirmed_swap: bool
    they_confirmed_swap: bool
    needs_you: bool
    waiting: Literal['answer', 'fix_picks', 'confirm_swap'] | None
    section: Literal['needs_you', 'to_swap', 'pending', 'history']
    actions: list[TradeAction]
    revision: int
    created_at: datetime


class TradesView(BaseModel):
    """The Trades list: open Trades newest first, then the newest closed ones. ``needs_you``: how many wait on the
    reader."""
    trades: list[TradeView]
    needs_you: int


class TradeStep(BaseModel):
    revision: int = Field(ge=1)
    idempotency_key: UUID


@dataclass(frozen=True)
class TradeFacts:
    """What a Trade's view and steps depend on beyond its row. ``stale_picks``: the reader's own reserved picks of this
    Trade are out of date; Trading #272 reads it (``trade_picks.stale_pick_trades``), until then it is always False."""
    stale_picks: bool = False


def trade_facts(conn, user_id: str, rows) -> dict[UUID, TradeFacts]:
    """The facts of these Trade rows for the reader, by Trade id: one read whatever the number of Trades."""
    return {row['id']: TradeFacts() for row in rows}


def role_of(user_id: str, row) -> str:
    return 'proposer' if row['proposer_id'] == user_id else 'recipient'


def other_side(role: str) -> str:
    return 'recipient' if role == 'proposer' else 'proposer'


def confirmed(user_id: str, row) -> tuple[bool, bool]:
    """(the reader confirmed the swap, the other side did)."""
    role = role_of(user_id, row)
    return row[f'{role}_swap_at'] is not None, row[f'{other_side(role)}_swap_at'] is not None


def waiting_trade_step(user_id: str, row, facts: TradeFacts | None = None) -> str | None:
    """What the Trade waits on the reader for, or None: 'answer' when they received a proposal nobody has answered;
    'confirm_swap' once accepted, when the other side confirmed the swap and the reader has not. An accepted Trade
    nobody has confirmed waits on neither side. Trading #272 adds 'fix_picks'."""
    mine, theirs = confirmed(user_id, row)
    if row['state'] == 'proposed':
        return 'answer' if role_of(user_id, row) == 'recipient' else None
    if row['state'] == 'accepted' and not mine and theirs:
        return 'confirm_swap'
    return None


def needs_you(user_id: str, row, facts: TradeFacts | None = None) -> bool:
    return waiting_trade_step(user_id, row, facts) is not None


def section(user_id: str, row, facts: TradeFacts | None = None) -> str:
    """Where the Trade sits on the Trades list: needs you, to swap, pending or history."""
    if needs_you(user_id, row, facts):
        return 'needs_you'
    if row['state'] == 'closed':
        return 'history'
    if row['state'] == 'accepted' and not confirmed(user_id, row)[0]:
        return 'to_swap'
    return 'pending'


def allowed(user_id: str, row, gives: bool) -> list[str]:
    """The steps the reader may take on this Trade now, in ``TradeAction`` order. Pure on the row. ``gives``: the
    reader's side has at least one card. This ticket's one step is the proposer's withdraw of a proposal nobody has
    answered; the recipient's answers (#271, #278), Confirm swap, Use suggested picks (#272) and cancel (#271) are
    added by their tickets."""
    found = []
    if row['state'] == 'proposed' and role_of(user_id, row) == 'proposer':
        found.append('withdraw')
    return [action for action in ACTION_ORDER if action in found]


TRADES = """SELECT t.* FROM trade t WHERE (t.proposer_id = %(me)s OR t.recipient_id = %(me)s)"""


def trade_views(conn, user_id: str, rows, facts: dict[UUID, TradeFacts] | None = None) -> list[TradeView]:
    """The reader's views of these Trade rows, in their order: one read of their lines, one of card facts and one of
    the other sides' profiles, whatever the number of Trades."""
    rows = list(rows)
    if not rows:
        return []
    lines: dict[tuple[UUID, str], list] = {}
    for line in conn.execute('SELECT trade_id, side, edition_id, quantity FROM trade_line '
                             'WHERE trade_id = ANY(%s) ORDER BY trade_id, side, position', ([row['id'] for row in rows],)):
        lines.setdefault((line['trade_id'], line['side']), []).append(line)
    cards = card_facts(conn, [line['edition_id'] for found in lines.values() for line in found])
    facts = facts if facts is not None else trade_facts(conn, user_id, rows)
    others = {row['recipient_id'] if role_of(user_id, row) == 'proposer' else row['proposer_id'] for row in rows} - {None}
    profiles = {profile['user_id']: profile for profile in conn.execute(
        'SELECT user_id, handle, open_to_cash_offers FROM collector_profile WHERE user_id = ANY(%s)',
        (sorted(others),))} if others else {}

    def side_cards(trade_id: UUID, side_name: str) -> list[TradeCard]:
        found = []
        for line in lines.get((trade_id, side_name), []):
            card = cards[line['edition_id']]
            found.append(TradeCard(
                edition_id=card.edition_id, name=card.name, set_code=card.set_code, set_name=card.set_name,
                collector_number=card.collector_number, descriptor=card.descriptor, image_url=card.image_url,
                copies=str(line['quantity'])))
        return found

    views = []
    for row in rows:
        role = role_of(user_id, row)
        other = other_side(role)
        other_id = row[f'{other}_id']
        profile = profiles.get(other_id)
        mine, theirs = confirmed(user_id, row)
        known = facts[row['id']]
        closed_by = None if row['closed_by'] is None else 'you' if row['closed_by'] == user_id else 'them'
        cash = None if row['cash_cents'] == 0 else TradeCash(
            cents=str(row['cash_cents']), payer='you' if row['cash_payer'] == role else 'them')
        views.append(TradeView(
            id=row['id'], state=row['state'], closed_reason=row['closed_reason'], closed_by=closed_by, role=role,
            other=TradeParty(collector_id=other_id if profile else None, display_name=row[f'{other}_name'],
                             handle=profile['handle'] if profile else None,
                             open_to_cash_offers=bool(profile and profile['open_to_cash_offers'])),
            countered_from=row['countered_from'], you_give=side_cards(row['id'], role),
            you_get=side_cards(row['id'], other), cash=cash, you_confirmed_swap=mine, they_confirmed_swap=theirs,
            needs_you=needs_you(user_id, row, known), waiting=waiting_trade_step(user_id, row, known),
            section=section(user_id, row, known), actions=allowed(user_id, row, bool(lines.get((row['id'], role)))),
            revision=row['revision'], created_at=row['created_at']))
    return views


def trade_view(conn, user_id: str, trade_id: UUID) -> TradeView:
    """One Trade as the reader sees it, or 404 TRADE_NOT_FOUND when they aren't one of its sides."""
    row = conn.execute(TRADES + ' AND t.id = %(id)s', {'me': user_id, 'id': trade_id}).fetchone()
    if row is None:
        error(404, 'TRADE_NOT_FOUND')
    return trade_views(conn, user_id, [row])[0]


@router.get('', response_model=TradesView)
def list_trades(user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        open_rows = conn.execute(TRADES + " AND t.state <> 'closed' ORDER BY t.created_at DESC, t.id",
                                 {'me': user_id}).fetchall()
        closed_rows = conn.execute(TRADES + " AND t.state = 'closed' ORDER BY t.closed_at DESC, t.id LIMIT %(limit)s",
                                   {'me': user_id, 'limit': HISTORY}).fetchall()
        views = trade_views(conn, user_id, open_rows + closed_rows)
    return TradesView(trades=views, needs_you=sum(view.needs_you for view in views))


@router.get('/{trade_id}', response_model=TradeView)
def read_trade(trade_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        return trade_view(conn, user_id, trade_id)


def count_trade_command(conn, user_id: str) -> None:
    """Counts one Trade step against the hourly limit: rows older than an hour pruned, and 429 TOO_MANY_CHANGES with
    ``retry_after_minutes`` at the limit. The caller holds the collector's Trade command lock and has answered a
    replay."""
    conn.execute("""DELETE FROM handle_lookup_event
      WHERE user_id=%s AND kind='trade_command' AND created_at < now() - interval '1 hour'""", (user_id,))
    recent = conn.execute("""SELECT count(*) AS commands, min(created_at) AS oldest FROM handle_lookup_event
      WHERE user_id=%s AND kind='trade_command'""", (user_id,)).fetchone()
    if recent['commands'] >= COMMANDS_PER_HOUR:
        wait = conn.execute("SELECT ceil(extract(epoch FROM %s + interval '1 hour' - now()) / 60) AS wait",
                            (recent['oldest'],)).fetchone()['wait']
        raise HTTPException(429, {'code': 'TOO_MANY_CHANGES', 'retry_after_minutes': max(1, int(wait))})
    conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,'trade_command')", (user_id,))


def begin_trade_command(conn, user_id: str, key: UUID, payload: dict):
    """The start every Trade command shares: the caller's owner row made if new, the caller's Trade commands one at a
    time, a replay answered from the caller's record, else the command counted. Returns (digest, stored response or
    None)."""
    ensure_owner(conn, user_id)
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.trade_command:' || %s))", (user_id,))
    digest, stored = replay(conn, user_id, key, payload)
    if stored is None:
        count_trade_command(conn, user_id)
    return digest, stored


def store_trade(conn, user_id: str, key: UUID, digest: str, trade_id: UUID) -> dict:
    """The Trade as the caller now sees it, recorded as the command's response."""
    stored = trade_view(conn, user_id, trade_id).model_dump(mode='json')
    conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                 (user_id, key, digest, json.dumps(stored)))
    return stored


def run_trade_step(user_id: str, trade_id: UUID, step: TradeStep, action: str, apply, locks,
                   extra: dict | None = None) -> dict:
    """Runs one step on an existing Trade: ``begin_trade_command``, the owners ``locks(role, row)`` names locked in
    ascending order, then the Trade row, its revision and ``allowed`` checked, then ``apply(conn, row)``, then the Trade
    row written once (``write_trade``), and the caller's view stored and returned. ``extra``: the step's own fields,
    part of its digest.

    ``apply`` writes everything but the ``trade`` row and returns the Trade columns the step sets (column name to value,
    empty or None for none; ``NOW`` for the transaction's time). The Trade row is locked ``FOR NO KEY UPDATE``, like
    the owners, and written once, as ``loans.run_step`` says why. A deadlock the database ends anyway leaves nothing
    changed and answers 503 INVENTORY_TEMPORARILY_UNAVAILABLE, which the client retries with the same key."""
    payload = {'action': f'trade_{action}', 'trade_id': str(trade_id), 'revision': step.revision, **(extra or {})}
    try:
        with connect() as conn, conn.transaction():
            digest, stored = begin_trade_command(conn, user_id, step.idempotency_key, payload)
            if stored is not None:
                return stored
            sides = conn.execute(TRADES + ' AND t.id = %(id)s', {'me': user_id, 'id': trade_id}).fetchone()
            if sides is None:
                error(404, 'TRADE_NOT_FOUND')
            lock_owners(conn, *[owner for owner in locks(role_of(user_id, sides), sides) if owner is not None])
            row = conn.execute('SELECT * FROM trade WHERE id = %s FOR NO KEY UPDATE', (trade_id,)).fetchone()
            if row['revision'] != step.revision:
                error(409, 'TRADE_CHANGED')
            gives = conn.execute('SELECT 1 FROM trade_line WHERE trade_id=%s AND side=%s LIMIT 1',
                                 (trade_id, role_of(user_id, row))).fetchone() is not None
            if action not in allowed(user_id, row, gives):
                error(409, 'STEP_NOT_ALLOWED')
            write_trade(conn, trade_id, apply(conn, row) or {})
            return store_trade(conn, user_id, step.idempotency_key, digest, trade_id)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


def write_trade(conn, trade_id: UUID, changes: Mapping[str, object]) -> None:
    """The step's one write of its Trade row: ``changes`` (column -> value, ``NOW`` for the transaction's time) and the
    revision advanced. ``run_trade_step`` calls it; nothing else writes the row of an existing Trade (Trading #274's
    ``end_trades_between`` will, once per Trade)."""
    if 'revision' in changes or 'id' in changes:
        raise ValueError('run_trade_step owns the Trade id and revision')
    assignments = [sql.SQL('revision = revision + 1')]
    params: list = []
    for column in sorted(changes):
        value = changes[column]
        if isinstance(value, sql.Composable):
            assignments.append(sql.SQL('{} = {}').format(sql.Identifier(column), value))
        else:
            assignments.append(sql.SQL('{} = %s').format(sql.Identifier(column)))
            params.append(value)
    conn.execute(sql.SQL('UPDATE trade SET {} WHERE id = %s').format(sql.SQL(', ').join(assignments)),
                 [*params, trade_id])


def record_trade_update(conn, row, actor_id: str, kind: str) -> None:
    """Stores an event update (``kind``, as the inbox's kinds) for the side of the Trade that isn't ``actor_id``, named
    for the actor as the Trade names them. Nothing when that side's account is gone. It never says why. ``row`` is the
    Trade as the step read it."""
    proposer = row['proposer_id'] == actor_id
    recipient = row['recipient_id'] if proposer else row['proposer_id']
    if recipient is None:
        return
    conn.execute('INSERT INTO inbox_update(id, recipient_id, kind, trade_id, other_name) VALUES (%s, %s, %s, %s, %s)',
                 (uuid4(), recipient, kind, row['id'], row['proposer_name'] if proposer else row['recipient_name']))


def close_trade(conn, row, user_id: str, reason: str) -> dict:
    """Ends the Trade: its picks go, so neither side's copies stay reserved, and the columns ``run_trade_step`` writes
    are returned."""
    conn.execute('DELETE FROM trade_pick WHERE trade_id=%s', (row['id'],))
    return {'state': 'closed', 'closed_reason': reason, 'closed_by': user_id, 'closed_at': NOW}


@router.post('/{trade_id}/withdraw', response_model=TradeView)
def withdraw(trade_id: UUID, step: TradeStep, user_id: str = Depends(verified_user)):
    """The proposer takes back a Trade Proposal nobody has answered. It releases the copies they give, under the
    proposer's own lock, which moves their revision when they gave cards; the recipient gets a 'cancelled' update."""
    def apply(conn, row):
        record_trade_update(conn, row, user_id, 'cancelled')
        if conn.execute("SELECT 1 FROM trade_line WHERE trade_id=%s AND side='proposer' LIMIT 1",
                        (row['id'],)).fetchone() is not None:
            advance_revision(conn, row['proposer_id'])
        return close_trade(conn, row, user_id, 'withdrawn')

    # Only the proposer may withdraw, so only the caller's own owner row is ever locked; a recipient's try locks none.
    return run_trade_step(user_id, trade_id, step, 'withdraw', apply,
                          lambda role, row: [row['proposer_id']] if role == 'proposer' else [])
