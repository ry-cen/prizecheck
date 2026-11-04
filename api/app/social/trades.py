"""Thread-addressed Trade reads and steps.

Commands replay before membership, owner locks, the live-round lock, eligibility
and strict revision checks. Inventory steps share this runner; offer replacement
has its own transaction because it closes one round and inserts another. Events
record participant slots, and touch_threads takes the thread lock last.
"""
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from psycopg import sql
from pydantic import BaseModel, Field, ValidationError

from ..location_tree import error, record_response
from ..db import connect
from ..identity import verified_user
from ..trade_picks import stale_pick_trades
from ..core.catalog.card_facts import card_facts
from .threads import TradeDetail, member_thread, thread_party, touch_threads, write_event
from .discovery import reach
from .owners import NOW, advance_revision, begin_owner_command, ensure_owner, lock_owners

router = APIRouter(prefix='/api/trades', tags=['social'])
settings_router = APIRouter(prefix='/api/social/trade-settings', tags=['social'])

# Closed Trades the Trades list shows, newest first.
HISTORY = 50

TradeAction = Literal['accept', 'decline', 'counter', 'confirm_swap', 'use_suggested_picks', 'withdraw', 'cancel', 'change_offer']
ACTION_ORDER = ('accept', 'decline', 'counter', 'confirm_swap', 'use_suggested_picks', 'withdraw', 'cancel', 'change_offer')


class TradeParty(BaseModel):
    """The other side of the Trade, as the reader may see them (Trading #299, spec "Identity").

    ``friend``: the other has a profile and is the reader's Friend now (an accepted friendship, no Block). Only then are
    ``collector_id`` and ``handle`` set; for anyone else they are None, so ``collector_id is None`` no longer means the
    account is deleted. ``trader_id``: the other's address on the trader routes and in the builder, None once that
    account is deleted; never shown. ``available``: the other is in the reader's reach now (a Friend, a shared
    conversation or nearby in open discovery, with no Block and no suspension on either side). The name is kept. Not
    available reads the same for a Block, a suspension and a deletion, apart from ``trader_id`` and the name.
    ``open_to_cash_offers``: their own setting (``/api/social/trade-settings``, Trading #277), False when not available.
    ``completed_trades``: how many Trades they have completed (``completed_trades``), None when not available.
    ``trader_id``, ``friend``, ``available`` and ``completed_trades`` have defaults so a stored replay from before they
    existed still validates."""
    collector_id: str | None
    handle: str | None
    trader_id: UUID | None = None
    display_name: str
    open_to_cash_offers: bool
    friend: bool = False
    available: bool = False
    completed_trades: int | None = None


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
    other side, in the order they were listed. Never a pick, a destination, a Location or a Deck. ``conversation_id``:
    the pair's conversation (Trading #298), None for a Trade of a pair that has none; it defaults to None so a stored
    replay from before it existed still validates."""
    id: UUID
    thread_id: UUID
    offer_id: UUID
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
    conversation_id: UUID | None = None


class ReplayedTradeSend(BaseModel):
    """A historical send was applied; these are explicitly the current accessible terms."""
    outcome: Literal['already_applied']
    view: Literal['current']
    label: Literal['Current Trade']
    trade: TradeView


class _LegacyInitialTradeSend(BaseModel):
    """Pre-thread TradeView at dev 59f7dc57, limited to the initial-send snapshot.

    Old party defaults validate historical receipts only; they are never returned.
    No round/thread identifiers are synthesized into this historical family.
    """
    model_config = {'extra': 'forbid'}
    id: UUID
    state: Literal['proposed']
    closed_reason: None
    closed_by: None
    role: Literal['proposer']
    other: TradeParty
    countered_from: None
    you_give: list[TradeCard]
    you_get: list[TradeCard]
    cash: TradeCash | None
    you_confirmed_swap: Literal[False]
    they_confirmed_swap: Literal[False]
    needs_you: bool
    waiting: Literal['answer', 'fix_picks', 'confirm_swap'] | None
    section: Literal['needs_you', 'to_swap', 'pending', 'history']
    actions: list[Literal['accept', 'decline', 'counter', 'confirm_swap', 'use_suggested_picks', 'withdraw', 'cancel']]
    revision: Literal[1]
    created_at: datetime
    conversation_id: UUID | None = None


def _applied_trade_unavailable():
    raise HTTPException(409, detail={'code': 'TRADE_SEND_ALREADY_APPLIED_UNAVAILABLE',
                                     'outcome': 'already_applied', 'view': 'unavailable'})


def replay_initial_trade_send(user_id: str, stored: object) -> dict | ReplayedTradeSend:
    """Called only after the owner/key/void/digest gate for an initial send.

    Current receipts retain their bytes and historical receipts stay untouched.
    Every matched receipt settles here, including one that cannot safely be read.
    Unexpected database failures propagate as unknown outcomes.
    """
    if not isinstance(stored, dict):
        _applied_trade_unavailable()
    current_fields = ('thread_id' in stored, 'offer_id' in stored)
    try:
        if all(current_fields):
            TradeView.model_validate(stored)
            return stored
        if any(current_fields):
            _applied_trade_unavailable()
        legacy = _LegacyInitialTradeSend.model_validate(stored)
    except ValidationError:
        _applied_trade_unavailable()

    with connect() as conn, conn.transaction():
        # Before the first SELECT: all mapping, membership, reach and view reads
        # belong to one snapshot. This transaction never calls a write helper.
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        thread = conn.execute("""SELECT t.*, original.proposer_id, original.recipient_id
          FROM thread_round_source s
          JOIN trade original ON original.id=s.round_id AND original.thread_id=s.thread_id
          JOIN thread t ON t.id=s.thread_id AND t.kind=s.kind
          JOIN thread_member m ON m.thread_id=t.id AND m.member_id=%(caller)s
          WHERE s.kind='trade' AND s.round_id=%(round)s AND original.proposer_id=%(caller)s""",
                              {'caller': user_id, 'round': legacy.id}).fetchone()
        if thread is None:
            _applied_trade_unavailable()
        pair = {thread['user_low'], thread['user_high']}
        if (None in pair or len(pair) != 2 or user_id not in pair
                or pair != {thread['proposer_id'], thread['recipient_id']}):
            _applied_trade_unavailable()
        other = thread['user_high'] if thread['user_low'] == user_id else thread['user_low']
        if (conn.execute('SELECT 1 FROM collector_profile WHERE user_id=%s', (other,)).fetchone() is None
                or conn.execute('SELECT 1 FROM thread_member WHERE thread_id=%s AND member_id=%s',
                                (thread['id'], other)).fetchone() is None
                or not thread_party(conn, user_id, thread).available):
            _applied_trade_unavailable()
        try:
            current = current_trade_view(conn, user_id, thread['id'])
        except HTTPException as cause:
            if cause.status_code == 404 and cause.detail == {'code': 'TRADE_NOT_FOUND'}:
                _applied_trade_unavailable()
            raise
        if not current.other.available:
            _applied_trade_unavailable()
        return ReplayedTradeSend(outcome='already_applied', view='current', label='Current Trade', trade=current)


class TradesView(BaseModel):
    """The Trades list: open Trades newest first, then the newest closed ones. ``needs_you``: how many wait on the
    reader."""
    trades: list[TradeView]
    needs_you: int


class TradeStep(BaseModel):
    offer_id: UUID
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
            found += ['change_offer', 'withdraw', *(['use_suggested_picks'] if gives else [])]
    elif row['state'] == 'accepted' and not mine:
        found += ['confirm_swap', *(['use_suggested_picks'] if gives else []), *([] if theirs else ['cancel', 'change_offer'])]
    return [action for action in ACTION_ORDER if action in found]


TRADES = """SELECT t.* FROM trade t WHERE (t.proposer_id = %(me)s OR t.recipient_id = %(me)s)"""


def completed_trades(conn, user_ids) -> dict[str, int]:
    """How many Trades each of these collectors has completed, by id, 0 for one with none. A Trade is completed when both
    sides confirmed the swap (both swap times set), whoever proposed it and Friend Trades included. A collector whose
    Trade partner deleted their account keeps the count, because their own id stays on the row. One statement over the
    two partial indexes ``trade_completed_proposer`` and ``trade_completed_recipient``; no counter column."""
    ids = sorted({user_id for user_id in user_ids if user_id is not None})
    if not ids:
        return {}
    found = {row['user_id']: row['n'] for row in conn.execute(
        """SELECT user_id, count(*) AS n FROM (
             SELECT proposer_id AS user_id FROM trade
               WHERE proposer_id = ANY(%(ids)s) AND proposer_swap_at IS NOT NULL AND recipient_swap_at IS NOT NULL
             UNION ALL
             SELECT recipient_id FROM trade
               WHERE recipient_id = ANY(%(ids)s) AND proposer_swap_at IS NOT NULL AND recipient_swap_at IS NOT NULL
           ) done GROUP BY user_id""", {'ids': ids})}
    return {user_id: found.get(user_id, 0) for user_id in ids}


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
    from .friends import friend_ids  # Imported here: friends.py imports this module.
    profiles = {profile['user_id']: profile for profile in conn.execute(
        'SELECT user_id, trader_id, handle, open_to_cash_offers FROM collector_profile WHERE user_id = ANY(%s)',
        (sorted(others),))} if others else {}
    reachable = reach(conn, user_id, others)
    friends = friend_ids(conn, user_id) if others else set()
    counts = completed_trades(conn, [other for other in others if other in reachable])

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
        is_friend = bool(profile and other_id in friends)
        available = other_id in reachable
        mine, theirs = confirmed(user_id, row)
        known = facts[row['id']]
        closed_by = None if row['closed_by'] is None else 'you' if row['closed_by'] == user_id else 'them'
        cash = None if row['cash_cents'] == 0 else TradeCash(
            cents=str(row['cash_cents']), payer='you' if row['cash_payer'] == role else 'them')
        views.append(TradeView(
            id=row['id'], thread_id=row['thread_id'], offer_id=row['id'], state=row['state'], closed_reason=row['closed_reason'], closed_by=closed_by, role=role,
            other=TradeParty(collector_id=other_id if is_friend else None, display_name=row[f'{other}_name'],
                             handle=profile['handle'] if is_friend else None,
                             trader_id=profile['trader_id'] if profile else None, friend=is_friend,
                             available=available,
                             open_to_cash_offers=bool(available and profile['open_to_cash_offers']),
                             completed_trades=counts.get(other_id, 0) if available else None),
            countered_from=row['countered_from'], you_give=side_cards(row['id'], role),
            you_get=side_cards(row['id'], other), cash=cash, you_confirmed_swap=mine, they_confirmed_swap=theirs,
            needs_you=needs_you(user_id, row, known), waiting=waiting_trade_step(user_id, row, known),
            section=section(user_id, row, known), actions=allowed(user_id, row, bool(lines.get((row['id'], role)))),
            revision=row['revision'], created_at=row['created_at'], conversation_id=row['conversation_id']))
    return views


def trade_view(conn, user_id: str, trade_id: UUID) -> TradeView:
    """One Trade as the reader sees it, or 404 TRADE_NOT_FOUND when they aren't one of its sides."""
    row = conn.execute(TRADES + ' AND t.id = %(id)s', {'me': user_id, 'id': trade_id}).fetchone()
    if row is None:
        error(404, 'TRADE_NOT_FOUND')
    return trade_views(conn, user_id, [row])[0]


class TradeResolution(BaseModel):
    thread_id: UUID


@router.get('/resolve/{identifier}', response_model=TradeResolution)
def resolve_trade(identifier: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        found = conn.execute("""SELECT t.id FROM thread t WHERE t.kind='trade'
          AND (t.user_low=%s OR t.user_high=%s) AND (t.id=%s OR t.id IN (
          SELECT thread_id FROM thread_round_source WHERE kind='trade' AND round_id=%s))
          ORDER BY (t.id=%s) DESC LIMIT 1""", (user_id, user_id, identifier, identifier, identifier)).fetchone()
        if found is None:
            error(404, 'TRADE_NOT_FOUND')
        return {'thread_id': found['id']}


def current_trade_view(conn, user_id: str, thread_id: UUID) -> TradeView:
    """The latest round, including a closed tip, with membership and pair checks."""
    thread = member_thread(conn, user_id, thread_id, 'trade')
    row = conn.execute('SELECT * FROM trade WHERE thread_id=%s ORDER BY created_at DESC, id DESC LIMIT 1',
                       (thread_id,)).fetchone()
    if (row is None or user_id not in {thread['user_low'], thread['user_high']}
            or {row['proposer_id'], row['recipient_id']} != {thread['user_low'], thread['user_high']}):
        error(404, 'TRADE_NOT_FOUND')
    return trade_views(conn, user_id, [row])[0]


@router.get('/{trade_id:uuid}', response_model=TradeDetail)
def read_trade(trade_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        thread = member_thread(conn, user_id, trade_id, 'trade')
        current = current_trade_view(conn, user_id, trade_id)
        other = thread['user_high'] if thread['user_low'] == user_id else thread['user_low']
        return TradeDetail(id=trade_id, live_offer=current,
                           can_message=thread_party(conn, user_id, thread).available, can_report=other is not None)


def trade_slot(conn, thread_id, user_id):
    thread = conn.execute('SELECT user_low FROM thread WHERE id=%s', (thread_id,)).fetchone()
    return 'low' if thread['user_low'] == user_id else 'high'


def offer_snapshot(conn, row):
    return {(trade_slot(conn, row['thread_id'], row[f"{line['side']}_id"]), line['edition_id']): int(line['quantity'])
            for line in conn.execute('SELECT side,edition_id,quantity FROM trade_line WHERE trade_id=%s', (row['id'],))}


def offer_diff(conn, old, new):
    before, after = offer_snapshot(conn, old), offer_snapshot(conn, new)
    def cash(row):
        return {'cents': row['cash_cents'] or None,
                'payer': trade_slot(conn, row['thread_id'], row[f"{row['cash_payer']}_id"]) if row['cash_payer'] else None}
    data = {'lines': [{'giver': side, 'edition_id': str(edition), 'from_qty': before.get((side, edition), 0),
                       'to_qty': after.get((side, edition), 0)}
                      for side, edition in sorted(before.keys() | after.keys(), key=str)
                      if before.get((side, edition), 0) != after.get((side, edition), 0)]}
    if cash(old) != cash(new):
        data['cash'] = {'from': cash(old), 'to': cash(new)}
    return data


def store_trade(conn, user_id: str, key: UUID, digest: str, trade_id: UUID,
                more: Mapping[str, object] | None = None) -> dict:
    """The Trade as the caller now sees it, recorded as the command's response. ``more``: JSON fields the calling step
    adds to its own answer, outside the Trade view; stored with it, so a replay answers them too."""
    stored = {**trade_view(conn, user_id, trade_id).model_dump(mode='json'), **(more or {})}
    record_response(conn, user_id, key, digest, stored)
    return stored


def run_trade_step(user_id: str, trade_id: UUID, step: TradeStep, action: str, apply, locks,
                   extra: dict | None = None, answer: Callable[[], Mapping[str, object]] | None = None) -> dict:
    """Runs one step on an existing Trade: ``begin_owner_command``, the owners ``locks(role, row)`` names locked in
    ascending order, then the Trade row, its revision and ``allowed`` checked, then ``apply(conn, row)``, then the Trade
    row written once (``write_trade``), and the caller's view stored and returned. ``extra``: the step's own fields,
    part of its digest. ``answer``: called after ``apply``, it names JSON fields the step adds to its own answer (stored
    with it through ``store_trade``'s ``more``).

    ``apply`` writes everything but the ``trade`` row and returns the Trade columns the step sets (column name to value,
    empty or None for none; ``NOW`` for the transaction's time). The Trade row is locked ``FOR NO KEY UPDATE``, like
    the owners, and written once, as ``loans.run_step`` says why. A deadlock the database ends anyway leaves nothing
    changed and answers 503 INVENTORY_TEMPORARILY_UNAVAILABLE, which the client retries with the same key."""
    payload = {'action': f'trade_{action}', 'thread_id': str(trade_id), 'offer_id': str(step.offer_id), 'revision': step.revision, **(extra or {})}
    try:
        with connect() as conn, conn.transaction():
            digest, stored = begin_owner_command(conn, user_id, step.idempotency_key, payload, 'trade')
            if stored is not None:
                return stored
            member_thread(conn, user_id, trade_id, 'trade')
            sides = conn.execute(TRADES + ' AND t.thread_id = %(id)s ORDER BY t.created_at DESC, t.id DESC LIMIT 1', {'me': user_id, 'id': trade_id}).fetchone()
            if sides is None:
                error(404, 'TRADE_NOT_FOUND')
            lock_owners(conn, *[owner for owner in locks(role_of(user_id, sides), sides) if owner is not None])
            row = conn.execute('SELECT * FROM trade WHERE id = %s FOR NO KEY UPDATE', (sides['id'],)).fetchone()
            if row['state'] == 'closed' or row['id'] != step.offer_id:
                error(409, 'OFFER_CHANGED')
            if action not in allowed(user_id, row, side_gives(conn, row['id'], role_of(user_id, row))):
                error(409, 'STEP_NOT_ALLOWED')
            if row['revision'] != step.revision:
                error(409, 'TRADE_CHANGED')
            write_trade(conn, row['id'], apply(conn, row) or {})
            kind = {'accept': 'accepted', 'decline': 'declined', 'withdraw': 'withdrawn',
                    'cancel': 'cancelled', 'confirm_swap': 'swap_confirmed',
                    'use_suggested_picks': 'picks_updated'}[action]
            write_event(conn, trade_id, kind, row['id'], actor=trade_slot(conn, trade_id, user_id))
            if action == 'confirm_swap':
                after = conn.execute('SELECT state FROM trade WHERE id=%s', (row['id'],)).fetchone()
                if after['state'] == 'closed':
                    write_event(conn, trade_id, 'swapped', row['id'])
            touch_threads(conn, [trade_id])
            return store_trade(conn, user_id, step.idempotency_key, digest, row['id'], answer() if answer else None)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


def side_gives(conn, trade_id: UUID, side: str) -> bool:
    """Whether that side of the Trade ('proposer' or 'recipient') gives at least one card."""
    return conn.execute('SELECT 1 FROM trade_line WHERE trade_id=%s AND side=%s LIMIT 1',
                        (trade_id, side)).fetchone() is not None


def write_trade(conn, trade_id: UUID, changes: Mapping[str, object]) -> None:
    """The step's one write of its Trade row: ``changes`` (column -> value, ``NOW`` for the transaction's time) and the
    revision advanced. ``run_trade_step`` calls it, ``end_trades_between`` once for each Trade it cancels, and
    ``trade_inventory.change_offer`` once for the proposal it closes; nothing else writes the row of an existing
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


def end_trades_between(conn, user_id: str, other_id: str | list[str], kind: str) -> list[UUID]:
    """Ending a friendship with open Trades (Trading #274), from Remove Friend and Block (``friends.friendship_ended``)
    by ``user_id``, after ``loans.end_loans_between``, with both owners already locked in ascending ``user_id``. Each
    Trade Proposal and accepted Trade between the two, either way round, that nobody has confirmed the swap for is
    cancelled by ``user_id``: its row locked (in id order, after any ``loan`` row) and written once, its picks gone,
    and the other side told it was cancelled (``record_trade_update``), as for any cancel and never why. A Trade either
    side confirmed stays open for the other side to finish. The copies a cancelled Trade's sides gave stop being
    reserved, so the revision of each side that gave cards in one moves, once: a proposal's proposer, and both sides
    of an accepted Trade (a recipient reserves nothing before accepting). Suspension supplies all counterparties in
    one call, so every Trade lock is acquired in id order across the account."""
    # A suspension supplies all partners at once, preserving global round-id lock order.
    others = [other_id] if isinstance(other_id, str) else other_id
    rows = conn.execute("""SELECT r.*, t.user_low AS thread_user_low FROM trade r JOIN thread t ON t.id=r.thread_id
      WHERE ((proposer_id = %(a)s AND recipient_id = ANY(%(b)s)) OR (proposer_id = ANY(%(b)s) AND recipient_id = %(a)s))
        AND state IN ('proposed', 'accepted')
        AND proposer_swap_at IS NULL AND recipient_swap_at IS NULL
      ORDER BY r.id FOR NO KEY UPDATE OF r""", {'a': user_id, 'b': others}).fetchall()
    if kind not in ('closed_blocked', 'closed_unfriended', 'closed_suspended'):
        raise ValueError('unknown Trade closure kind')
    # One grouped read, rather than one giving-side lookup per side of each round.
    gives = {r['trade_id']: r for r in conn.execute("""SELECT trade_id,
      bool_or(side='proposer') AS proposer, bool_or(side='recipient') AS recipient
      FROM trade_line WHERE trade_id=ANY(%s) GROUP BY trade_id""", ([row['id'] for row in rows],))} if rows else {}
    released = set()
    for row in rows:
        for side_name in ('proposer', 'recipient') if row['state'] == 'accepted' else ('proposer',):
            if gives.get(row['id'], {}).get(side_name, False):
                released.add(row[f'{side_name}_id'])
        record_trade_update(conn, row, user_id, 'cancelled')
        write_trade(conn, row['id'], close_trade(conn, row, user_id, 'cancelled'))
        write_event(conn, row['thread_id'], kind, row['id'], actor='low' if row['thread_user_low'] == user_id else 'high')
    for owner in sorted(released):
        advance_revision(conn, owner)
    return sorted({row['thread_id'] for row in rows}, key=str)


UNCONFIRMED_WITH = """SELECT CASE WHEN proposer_id = %(a)s THEN recipient_id ELSE proposer_id END AS other,
    conversation_id
  FROM trade WHERE (proposer_id = %(a)s OR recipient_id = %(a)s)
    AND proposer_id IS NOT NULL AND recipient_id IS NOT NULL
    AND state IN ('proposed', 'accepted') AND proposer_swap_at IS NULL AND recipient_swap_at IS NULL"""


def unconfirmed_partners(conn, user_id: str) -> tuple[list[str], list[UUID]]:
    """The collectors with whom ``user_id`` has a Trade nobody confirmed the swap for (``end_trades_between``'s rule,
    either way round), sorted, and those Trades' conversations. No lock; suspension reads it before and after its
    owner locks."""
    rows = conn.execute(UNCONFIRMED_WITH, {'a': user_id}).fetchall()
    return (sorted({row['other'] for row in rows}),
            sorted({row['conversation_id'] for row in rows if row['conversation_id'] is not None}, key=str))


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


TradeDetail.model_rebuild(_types_namespace={"TradeView": TradeView})
