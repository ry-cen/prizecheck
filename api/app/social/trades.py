"""Trade Proposals and Trades as both sides read them (Trading #270, spec "Trade Proposals and the state model",
resolution "Module boundary" and "API contract").

Both sides read the same Trade facts here (``GET /api/social/trades`` and ``GET /api/social/trades/{id}``): the cards
each side gives, each side's swap confirmation and the other collector's Display Name, Handle and whether they are Open
to cash offers, never a pick, a Location or a Deck of either side. The steps that change no inventory of the reader's
own are here too: the proposer's withdraw (Trading #270), the recipient's decline and either side's cancel (#271).
Sending a Trade Proposal reads and reserves the sender's own inventory, so it is inventory code in
``app.trade_inventory`` under ``/api/trades``; it answers ``trade_view`` too, so every step answers the same Trade. So
are Confirm swap, which moves the confirmer's own cards, and Use suggested picks, which re-picks their own copies
(Trading #272).

**Steps** name the Trade ``revision`` they read (409 TRADE_CHANGED when it moved on) and an idempotency key (replayed
from ``location_command``, as Loan commands are). ``allowed`` is the one rule for which steps a collector may take now:
the view's ``actions`` list them and a step not in it is 409 STEP_NOT_ALLOWED. A collector who isn't one of the Trade's
two sides gets 404 TRADE_NOT_FOUND, as for a Trade that doesn't exist. Every step on an existing Trade runs through
``run_trade_step``, which writes the ``trade`` row exactly once: the step's own columns and the revision in one UPDATE.

**Locks** follow the spec's table ("Locks and revisions"): owner rows in ascending ``user_id`` (``owners.lock_owners``),
then any ``loan`` row, then the ``trade`` row. Withdraw locks the proposer, whose copies it releases; decline and cancel
lock both sides. A step advances a side's inventory revision when it releases copies that side gives: withdraw and
decline the proposer's, cancel each side's. A side that gives nothing has nothing released, so its revision stays.

**Limit.** Trade steps count against ``COMMANDS_PER_HOUR`` per account under kind 'trade_command'
(``count_trade_command``), apart from the Friend and Loan commands' counts, under a command lock of their own
(``begin_trade_command``). A replay isn't counted again; a refused step rolls back with its count.

**Updates** (``record_trade_update``): a withdraw stores a 'cancelled' update for the recipient, which the inbox reads
as withdrawn from the Trade's ``closed_reason``; a decline stores a 'declined' update for the proposer; a cancel stores
a 'cancelled' update for the other side, never saying why. The recipient's accept (Trading #271) reserves their own
copies, so it is inventory code in ``app.trade_inventory`` and stores an 'accepted' update for the proposer there.
A confirmed swap stores a 'swapped' update for the side that confirmed first, once the second side confirms
(Trading #272, in ``app.trade_inventory``).

**Waiting on you** (``waiting_trade_step``, Trading #273) is the one definition the Trades list, its tab badge and the
inbox's bell read, worked out on every read and never stored: a proposal to answer, an accepted Trade whose picks a
Move or a Removal left out of date (``TradeFacts.stale_picks``, from ``trade_picks.stale_pick_trades`` over the
reader's own Holdings), or a swap the other side confirmed. ``trade_waiting_since`` says since when. The inbox
(``social.inbox``) lists the waiting Trades and the stored Trade updates.

**Ending a friendship** (``end_trades_between``, Trading #274): Remove Friend and Block, by either side, cancel every
Trade Proposal and Trade between the two that nobody has confirmed the swap for, inside the Friend command that
already locked both owners, after the pair's Loans (``loans.end_loans_between``): owner rows, then ``loan`` rows, then
``trade`` rows. Each is closed as 'cancelled' by the collector who ended the friendship, its picks gone, and the other
side gets the 'cancelled' update a plain cancel stores, which never says why, so an unfriend and a Block read the same.
A Trade one side has confirmed stays open: the remaining side may still Confirm swap alone, and since no step checks
the friendship once a Trade is accepted, nothing they see changes.

**Cash and Open to cash offers** (Trading #277): ``TradeView.cash`` is the amount and payer relative to the reader. The
Open to cash offers setting is changed through ``/api/social/trade-settings`` (``settings_router`` below). A Counter
(#278) is inventory code in ``app.trade_inventory``; it stores no update, because the reply is the other side's waiting
answer.
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
from ..trade_picks import stale_pick_trades
from .friend_reads import card_facts
from .loans import NOW, advance_revision
from .owners import ensure_owner, lock_owners

router = APIRouter(prefix='/api/social/trades', tags=['social'])
settings_router = APIRouter(prefix='/api/social/trade-settings', tags=['social'])

COMMANDS_PER_HOUR = 120

# Closed Trades the Trades list shows, newest first.
HISTORY = 50

TradeAction = Literal['accept', 'decline', 'counter', 'confirm_swap', 'use_suggested_picks', 'withdraw', 'cancel']
ACTION_ORDER = ('accept', 'decline', 'counter', 'confirm_swap', 'use_suggested_picks', 'withdraw', 'cancel')


class TradeParty(BaseModel):
    """The other side of the Trade: ``collector_id`` and ``handle`` are None once that account is deleted; the name is
    kept. ``open_to_cash_offers``: their own setting, changed through
    ``/api/social/trade-settings`` (this module's ``settings_router``, Trading #277)."""
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


class TradeSettings(BaseModel):
    """The collector's own trading settings. ``open_to_cash_offers``: Friends may send them a Trade Proposal in which
    one side gives only cash (Trading #277); off by default."""
    open_to_cash_offers: bool


class SetTradeSettings(BaseModel):
    open_to_cash_offers: bool


@dataclass(frozen=True)
class TradeFacts:
    """What a Trade's view and steps depend on beyond its row. ``stale_picks``: the Trade is accepted, the reader hasn't
    confirmed the swap, and a pick of the reader's own is out of date (Trading #273)."""
    stale_picks: bool = False


def trade_facts(conn, user_id: str, rows) -> dict[UUID, TradeFacts]:
    """The facts of these Trade rows for the reader, by Trade id, in one ``trade_picks.stale_pick_trades`` read whatever
    the number of Trades. Only accepted Trades the reader hasn't confirmed are asked about, the only ones whose stale
    picks wait on them (``waiting_trade_step``); a proposer's stale pick on a waiting proposal shows on the Trade screen
    only. Reads no inventory but the reader's own Holdings and picks, and takes no lock."""
    rows = list(rows)
    stale = stale_pick_trades(conn, user_id, [row['id'] for row in rows
                                              if row['state'] == 'accepted' and not confirmed(user_id, row)[0]])
    return {row['id']: TradeFacts(stale_picks=row['id'] in stale) for row in rows}


def role_of(user_id: str, row) -> str:
    return 'proposer' if row['proposer_id'] == user_id else 'recipient'


def other_side(role: str) -> str:
    return 'recipient' if role == 'proposer' else 'proposer'


def confirmed(user_id: str, row) -> tuple[bool, bool]:
    """(the reader confirmed the swap, the other side did)."""
    role = role_of(user_id, row)
    return row[f'{role}_swap_at'] is not None, row[f'{other_side(role)}_swap_at'] is not None


def waiting_trade_step(user_id: str, row, facts: TradeFacts | None = None) -> str | None:
    """What the Trade waits on the reader for, or None, the first that applies: 'answer' when they received a proposal
    nobody has answered (a Counter is the same step); 'fix_picks' once accepted, when the reader hasn't confirmed
    the swap and a pick of theirs is out of date (``facts.stale_picks``; without facts, never); 'confirm_swap' once
    accepted, when the other side confirmed the swap and the reader has not. An accepted Trade nobody has confirmed,
    with the reader's picks up to date, waits on neither side. One Trade is one step, whatever else it needs."""
    mine, theirs = confirmed(user_id, row)
    if row['state'] == 'proposed':
        return 'answer' if role_of(user_id, row) == 'recipient' else None
    if row['state'] == 'accepted' and not mine:
        if facts is not None and facts.stale_picks:
            return 'fix_picks'
        if theirs:
            return 'confirm_swap'
    return None


def trade_waiting_since(user_id: str, row, step: str) -> datetime:
    """When the Trade began to wait on the reader for ``step`` (``waiting_trade_step``), from times the row holds: a
    proposal to answer, its ``created_at``; a swap the other side confirmed, that confirmation. Out-of-date picks have
    no moment of their own (a Move or a Removal made them so, and nothing records when) and use ``accepted_at``, as the
    Loans' do (``inbox.waiting_since``)."""
    if step == 'answer':
        return row['created_at']
    if step == 'confirm_swap':
        return row[f'{other_side(role_of(user_id, row))}_swap_at']
    return row['accepted_at'] or row['created_at']


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
    reader's side has at least one card. A proposal nobody has answered: the recipient accepts or declines it, the
    proposer withdraws it and, when they give cards, may use suggested picks. An accepted Trade the reader hasn't
    confirmed: they confirm the swap and, when they give cards, may use suggested picks; while the other side hasn't
    confirmed either, either side cancels it. Once the reader has confirmed, and on a closed row, nothing. Use suggested
    picks is listed while the reader's side gives cards and still reserves them; the step answers PICKS_UP_TO_DATE when
    no pick is out of date. The recipient of a proposal may also counter it (#278), in every round."""
    mine, theirs = confirmed(user_id, row)
    found = []
    if row['state'] == 'proposed':
        if role_of(user_id, row) == 'recipient':
            found += ['accept', 'decline', 'counter']
        else:
            found += ['withdraw', *(['use_suggested_picks'] if gives else [])]
    elif row['state'] == 'accepted' and not mine:
        found += ['confirm_swap', *(['use_suggested_picks'] if gives else []), *([] if theirs else ['cancel'])]
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
                             'WHERE trade_id = ANY(%s) ORDER BY trade_id, side, position',
                             ([row['id'] for row in rows],)):
        lines.setdefault((line['trade_id'], line['side']), []).append(line)
    cards = card_facts(conn, [line['edition_id'] for found in lines.values() for line in found])
    facts = facts if facts is not None else trade_facts(conn, user_id, rows)
    others = {row['recipient_id'] if role_of(user_id, row) == 'proposer' else row['proposer_id']
              for row in rows} - {None}
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
            if action not in allowed(user_id, row, side_gives(conn, trade_id, role_of(user_id, row))):
                error(409, 'STEP_NOT_ALLOWED')
            write_trade(conn, trade_id, apply(conn, row) or {})
            return store_trade(conn, user_id, step.idempotency_key, digest, trade_id)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


def side_gives(conn, trade_id: UUID, side: str) -> bool:
    """Whether that side of the Trade ('proposer' or 'recipient') gives at least one card."""
    return conn.execute('SELECT 1 FROM trade_line WHERE trade_id=%s AND side=%s LIMIT 1',
                        (trade_id, side)).fetchone() is not None


def write_trade(conn, trade_id: UUID, changes: Mapping[str, object]) -> None:
    """The step's one write of its Trade row: ``changes`` (column -> value, ``NOW`` for the transaction's time) and the
    revision advanced. ``run_trade_step`` calls it, ``end_trades_between`` once for each Trade it cancels, and
    ``trade_inventory.counter_trade`` once for the proposal it closes; nothing else writes the row of an existing
    Trade."""
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


def end_trades_between(conn, user_id: str, other_id: str) -> None:
    """Ending a friendship with open Trades (Trading #274), from Remove Friend and Block (``friends.friendship_ended``)
    by ``user_id``, after ``loans.end_loans_between``, with both owners already locked in ascending ``user_id``. Each
    Trade Proposal and accepted Trade between the two, either way round, that nobody has confirmed the swap for is
    cancelled by ``user_id``: its row locked (in id order, after any ``loan`` row) and written once, its picks gone,
    and the other side told it was cancelled (``record_trade_update``), as for any cancel and never why. A Trade either
    side confirmed stays open for the other side to finish. The copies a cancelled Trade's sides gave stop being
    reserved, so the revision of each side that gave cards in one moves, once: a proposal's proposer, and both sides
    of an accepted Trade (a recipient reserves nothing before accepting)."""
    rows = conn.execute("""SELECT * FROM trade
      WHERE ((proposer_id = %(a)s AND recipient_id = %(b)s) OR (proposer_id = %(b)s AND recipient_id = %(a)s))
        AND state IN ('proposed', 'accepted')
        AND proposer_swap_at IS NULL AND recipient_swap_at IS NULL
      ORDER BY id FOR NO KEY UPDATE""", {'a': user_id, 'b': other_id}).fetchall()
    released = set()
    for row in rows:
        for side_name in ('proposer', 'recipient') if row['state'] == 'accepted' else ('proposer',):
            if side_gives(conn, row['id'], side_name):
                released.add(row[f'{side_name}_id'])
        record_trade_update(conn, row, user_id, 'cancelled')
        write_trade(conn, row['id'], close_trade(conn, row, user_id, 'cancelled'))
    for owner in sorted(released):
        advance_revision(conn, owner)


@router.post('/{trade_id}/withdraw', response_model=TradeView)
def withdraw(trade_id: UUID, step: TradeStep, user_id: str = Depends(verified_user)):
    """The proposer takes back a Trade Proposal nobody has answered. It releases the copies they give, under the
    proposer's own lock, which moves their revision when they gave cards; the recipient gets a 'cancelled' update."""
    def apply(conn, row):
        record_trade_update(conn, row, user_id, 'cancelled')
        if side_gives(conn, row['id'], 'proposer'):
            advance_revision(conn, row['proposer_id'])
        return close_trade(conn, row, user_id, 'withdrawn')

    # Only the proposer may withdraw, so only the caller's own owner row is ever locked; a recipient's try locks none.
    return run_trade_step(user_id, trade_id, step, 'withdraw', apply,
                          lambda role, row: [row['proposer_id']] if role == 'proposer' else [])


@router.post('/{trade_id}/decline', response_model=TradeView)
def decline(trade_id: UUID, step: TradeStep, user_id: str = Depends(verified_user)):
    """The recipient turns down a Trade Proposal, whole. It releases the copies the proposer gives, under both sides'
    locks, which moves the proposer's revision when they gave cards; the proposer gets a 'declined' update. No
    friendship check: unfriending and Blocking close the pair's open Trades first, under the same locks (#274)."""
    def apply(conn, row):
        record_trade_update(conn, row, user_id, 'declined')
        if side_gives(conn, row['id'], 'proposer'):
            advance_revision(conn, row['proposer_id'])
        return close_trade(conn, row, user_id, 'declined')

    # Only the recipient may decline; a proposer's try locks nothing before it is refused.
    return run_trade_step(user_id, trade_id, step, 'decline', apply,
                          lambda role, row: [row['proposer_id'], row['recipient_id']] if role == 'recipient' else [])


@router.post('/{trade_id}/cancel', response_model=TradeView)
def cancel(trade_id: UUID, step: TradeStep, user_id: str = Depends(verified_user)):
    """Either side calls off an accepted Trade nobody has confirmed. It releases both sides' copies in one transaction,
    under both sides' locks, and moves the revision of each side that gives cards; the other side gets a 'cancelled'
    update that never says why. A proposal (withdraw or decline it) and a Trade either side confirmed are 409
    STEP_NOT_ALLOWED."""
    def apply(conn, row):
        record_trade_update(conn, row, user_id, 'cancelled')
        for side_name in ('proposer', 'recipient'):
            if side_gives(conn, row['id'], side_name):
                advance_revision(conn, row[f'{side_name}_id'])
        return close_trade(conn, row, user_id, 'cancelled')

    return run_trade_step(user_id, trade_id, step, 'cancel', apply,
                          lambda role, row: [row['proposer_id'], row['recipient_id']])


def read_trade_settings(conn, user_id: str) -> TradeSettings:
    """The collector's own trading settings; off for a collector with no profile row yet."""
    row = conn.execute('SELECT open_to_cash_offers FROM collector_profile WHERE user_id=%s', (user_id,)).fetchone()
    return TradeSettings(open_to_cash_offers=bool(row and row['open_to_cash_offers']))


@settings_router.get('', response_model=TradeSettings)
def get_trade_settings(user_id: str = Depends(verified_user)):
    """The caller's own trading settings. Writes nothing and makes no owner row."""
    with connect() as conn, conn.transaction():
        return read_trade_settings(conn, user_id)


@settings_router.put('', response_model=TradeSettings)
def set_trade_settings(command: SetTradeSettings, user_id: str = Depends(verified_user)):
    """Turns Open to cash offers on or off for the caller only (Trading #277). Idempotent by value: no key, no revision,
    the last write wins. Moves no inventory revision and counts against no limit."""
    with connect() as conn, conn.transaction():
        ensure_owner(conn, user_id)
        update = 'UPDATE collector_profile SET open_to_cash_offers=%s WHERE user_id=%s'
        if conn.execute(update, (command.open_to_cash_offers, user_id)).rowcount == 0:
            conn.execute('SELECT create_collector_profile(%s)', (user_id,))
            conn.execute(update, (command.open_to_cash_offers, user_id))
        return read_trade_settings(conn, user_id)
