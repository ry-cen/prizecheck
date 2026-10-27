"""Reports and the owner review queue (Trading #303, spec "Reports and the owner review queue", resolution "Reports").

**Report** (``POST /api/social/reports``) Blocks the reported collector by trader id, keeps a snapshot the owner reviews
and never tells the reported collector. The checks run in this order: the body (422); an unknown or own trader id (404
COLLECTOR_NOT_FOUND); a stored answer for the key (D5: replayed before the allowance, under the reporter's command lock,
because the Report's own Block ends the reach a retry would otherwise need); the allowance (source ``trade``: the
``trade_id`` is a Trade between the two, else 404 TRADE_NOT_FOUND; any other source: reach or a shared conversation,
else 404 COLLECTOR_NOT_FOUND, byte-identical to an unknown id); then one Friend command (both owners locked, the
``friend_command`` count, replay by key). The command inserts the report, copies the snapshot and then places the
Block. The 201 body is the same whatever state the reported collector is in.

**Snapshot, not retention.** The copy is taken just before the Block, so the owner sees every Trade as the reporter saw
it; ``ended_by_report`` marks the Trades the Block then cancels. It holds the pair's messages and Trades as they stood,
references no user or message rows, and later messages or Trade steps are never added. This module names ``message`` in
SQL only to copy that snapshot.

**Owner routes** (``admin_router``, each behind ``require_owner``): the queue, one report's snapshot (never the live
conversation), a decision (dismiss, remove from open discovery, or suspend) and the restore of a removal or a
suspension. Every decision and restore writes one append-only ``moderation_event``. Nothing else penalises anyone.

**Locks.** A decision takes the advisory lock ``prizecheck.trade_report:<id>`` (it serialises decisions on one report),
then, for removal and suspension, ``discovery.lock_discovery`` for the account, then the owner rows in one ascending
call, then profile, ``trade`` and ``conversation`` rows; the event and the report update come last. A restore takes
``lock_discovery`` and then the collector's owner row. This module never writes the discovery tables: it calls the
``discovery`` helpers.

**Suspension** is one transaction. It reads the account's counterparties of unconfirmed Trades without locking, locks
the account and them in one ascending call, reads them again and starts over (at most 3 attempts, then 503
INVENTORY_TEMPORARILY_UNAVAILABLE) when a new one appeared. It then sets the flag, switches discovery off, cancels the
Trades nobody confirmed with the suspended account as the actor, and moves the watermark of the account's other
conversations. Loans and friendships stay. A deadlock in a decision or restore is 503 and is not retried.
"""
import json
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, model_validator

from ..location_tree import error, replay
from ..db import connect
from ..identity import require_owner, verified_user
from .conversations import account_changed, decode_cursor, encode_cursor, normalize_text, pair_row
from .discovery import (account_state, lock_discovery, reach_one, remove_from_discovery, restore_discovery, switch_off,
                        trader_user)
from .friend_reads import card_facts
from .friends import _command, command_payload, place_block
from .owners import lock_owners
from .trades import end_trades_between, unconfirmed_partners

router = APIRouter(prefix='/api/social/reports', tags=['social'])
admin_router = APIRouter(tags=['admin'])

SUSPENSION_ATTEMPTS = 3
PAGE = 50

Reason = Literal['scam_or_no_show', 'harassment', 'inappropriate_content', 'other']
Source = Literal['conversation', 'discovery', 'trade']
Status = Literal['open', 'dismissed', 'actioned']
Decision = Literal['dismiss', 'remove_from_discovery', 'suspend']
EventAction = Literal['dismiss', 'remove_from_discovery', 'suspend', 'restore_discovery', 'lift_suspension']


class ReportCollector(BaseModel):
    """Report the collector with this trader id (which also Blocks them). Source ``trade`` needs ``trade_id``; the
    other sources must not carry one. ``note`` is optional plain text."""
    trader_id: UUID
    reason: Reason
    note: str | None = Field(None, max_length=4000)
    source: Source
    trade_id: UUID | None = None
    idempotency_key: UUID

    @model_validator(mode='after')
    def trade_goes_with_its_source(self):
        if (self.source == 'trade') != (self.trade_id is not None):
            raise ValueError('trade_id goes with source trade, and with no other source')
        return self


class ReportResult(BaseModel):
    """The only thing a Report answers."""
    reported: bool


class ReportParty(BaseModel):
    """One side of a report (owner screens only; may carry user ids, Handles and times). ``user_id`` is null once the
    account is deleted; the name and Handle are kept."""
    user_id: str | None
    display_name: str
    handle: str


class TradeReportRow(BaseModel):
    """One report in the queue (owner screens only; may carry user ids, Handles and times). ``reported_count``: every
    report naming the reported collector, this one included (1 when the account is deleted)."""
    id: UUID
    created_at: datetime
    status: Status
    decision: Decision | None
    reason: Reason
    source: Source
    reporter: ReportParty
    reported: ReportParty
    reported_count: int


class TradeReportList(BaseModel):
    """One page of the queue, newest first (owner screens only). ``open_count``: every open report, whatever the
    filter."""
    reports: list[TradeReportRow]
    next_before: str | None
    open_count: int


class SnapshotMessage(BaseModel):
    """One message of the snapshot (owner screens only)."""
    message_id: UUID
    sender: Literal['reporter', 'reported']
    body: str
    at: datetime


class SnapshotCard(BaseModel):
    """One card one side gives, as the snapshot names it."""
    name: str
    set_code: str
    number: str
    quantity: int


class SnapshotTrade(BaseModel):
    """One Trade of the pair as the snapshot kept it (also the shape of ``trade_report_trade.facts``). Owner screens
    only. ``ended_by_report``: the Report's Block cancelled it."""
    trade_id: UUID
    state: Literal['proposed', 'accepted', 'closed']
    closed_reason: Literal['declined', 'withdrawn', 'countered', 'cancelled', 'swapped'] | None
    closed_by: Literal['reporter', 'reported'] | None
    proposed_by: Literal['reporter', 'reported']
    reporter_gives: list[SnapshotCard]
    reported_gives: list[SnapshotCard]
    cash_cents: int | None
    cash_paid_by: Literal['reporter', 'reported'] | None
    proposed_at: datetime
    accepted_at: datetime | None
    reporter_confirmed_at: datetime | None
    reported_confirmed_at: datetime | None
    closed_at: datetime | None
    countered_from: UUID | None
    ended_by_report: bool


class ModerationEventView(BaseModel):
    """One moderation event (owner screens only)."""
    id: UUID
    action: EventAction
    report_id: UUID | None
    owner_id: str
    note: str | None
    created_at: datetime


class ReportedAccount(BaseModel):
    """The reported collector's account now (owner screens only)."""
    exists: bool
    suspended: bool
    removed: bool


class TradeReportDetail(BaseModel):
    """One report with its snapshot, never the live conversation (owner screens only; may carry user ids, Handles and
    times)."""
    report: TradeReportRow
    note: str | None
    conversation_id: UUID | None
    trade_id: UUID | None
    decided_at: datetime | None
    decided_by: str | None
    messages: list[SnapshotMessage]
    trades: list[SnapshotTrade]
    account: ReportedAccount
    other_reports: list[TradeReportRow]
    events: list[ModerationEventView]


class ReportDecision(BaseModel):
    """The owner's decision on an open report (owner screens only)."""
    action: Decision
    note: str | None = Field(None, max_length=4000)


class ReportDecided(BaseModel):
    """What a decision left the report as."""
    status: Literal['dismissed', 'actioned']
    decision: Decision


class RestoreCollector(BaseModel):
    """Reverse a removal from open discovery or a suspension (owner screens only)."""
    what: Literal['discovery', 'suspension']
    note: str | None = Field(None, max_length=4000)


class CollectorRestored(BaseModel):
    """What was restored."""
    restored: Literal['discovery', 'suspension']


PAIR_TRADE = """SELECT 1 FROM trade WHERE id = %(id)s
  AND ((proposer_id = %(a)s AND recipient_id = %(b)s) OR (proposer_id = %(b)s AND recipient_id = %(a)s))"""
PROFILES = 'SELECT user_id, display_name, handle FROM collector_profile WHERE user_id = ANY(%s)'
COPY_MESSAGES = """INSERT INTO trade_report_message (report_id, message_id, from_reporter, body, at)
  SELECT %(r)s, m.id, m.from_low = %(low)s, m.body, m.created_at FROM message m WHERE m.conversation_id = %(c)s"""
PAIR_TRADES = """SELECT * FROM trade
  WHERE (proposer_id = %(a)s AND recipient_id = %(b)s) OR (proposer_id = %(b)s AND recipient_id = %(a)s)
  ORDER BY created_at, id"""
TRADE_LINES = """SELECT trade_id, side, edition_id, quantity FROM trade_line WHERE trade_id = ANY(%s)
  ORDER BY trade_id, side, position"""
UNKNOWN_CARD = {'name': 'Unknown card', 'set_code': '', 'number': ''}

REPORT_ROWS = """SELECT r.*, CASE WHEN r.reported_id IS NULL THEN 1
    ELSE (SELECT count(*) FROM trade_report o WHERE o.reported_id = r.reported_id) END AS reported_count
  FROM trade_report r"""


def _owner_note(raw: str | None) -> str | None:
    """The owner's note as stored: normalised like a message, a blank one is none, over 1,000 code points is 422
    MESSAGE_TOO_LONG."""
    return None if raw is None else (normalize_text(raw, empty_ok=True) or None)


def _row(record) -> TradeReportRow:
    return TradeReportRow(
        id=record['id'], created_at=record['created_at'], status=record['status'], decision=record['decision'],
        reason=record['reason'], source=record['source'],
        reporter=ReportParty(user_id=record['reporter_id'], display_name=record['reporter_name'],
                             handle=record['reporter_handle']),
        reported=ReportParty(user_id=record['reported_id'], display_name=record['reported_name'],
                             handle=record['reported_handle']),
        reported_count=int(record['reported_count']))


def _cards(lines, facts) -> list[SnapshotCard]:
    cards = []
    for line in lines:
        card = facts.get(line['edition_id'])
        named = ({'name': card.name, 'set_code': card.set_code, 'number': card.collector_number}
                 if card else UNKNOWN_CARD)
        cards.append(SnapshotCard(**named, quantity=int(line['quantity'])))
    return cards


def _snapshot_trades(conn, report_id: UUID, reporter: str, reported: str) -> None:
    """Copies every Trade of the pair, oriented to the reporter and the reported collector, as it stands now."""
    trades = conn.execute(PAIR_TRADES, {'a': reporter, 'b': reported}).fetchall()
    if not trades:
        return
    lines = conn.execute(TRADE_LINES, ([trade['id'] for trade in trades],)).fetchall()
    facts = card_facts(conn, [line['edition_id'] for line in lines])

    def side(user_id: str | None) -> str | None:
        return None if user_id is None else ('reporter' if user_id == reporter else 'reported')

    def gives(trade, giver: str):
        mine = 'proposer' if trade['proposer_id'] == giver else 'recipient'
        return _cards([line for line in lines if line['trade_id'] == trade['id'] and line['side'] == mine], facts)

    for trade in trades:
        proposed_by = side(trade['proposer_id'])
        confirmed = {side(trade['proposer_id']): trade['proposer_swap_at'],
                     side(trade['recipient_id']): trade['recipient_swap_at']}
        payer = {'proposer': side(trade['proposer_id']), 'recipient': side(trade['recipient_id'])}
        snapshot = SnapshotTrade(
            trade_id=trade['id'], state=trade['state'], closed_reason=trade['closed_reason'],
            closed_by=side(trade['closed_by']), proposed_by=proposed_by,
            reporter_gives=gives(trade, reporter), reported_gives=gives(trade, reported),
            cash_cents=trade['cash_cents'] or None, cash_paid_by=payer.get(trade['cash_payer']),
            proposed_at=trade['created_at'], accepted_at=trade['accepted_at'],
            reporter_confirmed_at=confirmed['reporter'], reported_confirmed_at=confirmed['reported'],
            closed_at=trade['closed_at'], countered_from=trade['countered_from'],
            ended_by_report=(trade['state'] in ('proposed', 'accepted') and trade['proposer_swap_at'] is None
                             and trade['recipient_swap_at'] is None))
        conn.execute('INSERT INTO trade_report_trade (report_id, trade_id, facts) VALUES (%s, %s, %s)',
                     (report_id, trade['id'], json.dumps(snapshot.model_dump(mode='json'))))


def _file_report(conn, report_id: UUID, reporter: str, reported: str, command: ReportCollector,
                 note: str | None) -> None:
    """Inserts the report row and copies the snapshot. Runs inside the Friend command, with both owners locked and
    before the Block, so the copy shows the pair as the reporter saw it."""
    people = {row['user_id']: row for row in conn.execute(PROFILES, ([reporter, reported],))}
    conversation = pair_row(conn, reporter, reported)
    mine, theirs = people[reporter], people[reported]
    conn.execute("""INSERT INTO trade_report (id, reporter_id, reported_id, reporter_name, reported_name,
        reporter_handle, reported_handle, reason, note, source, trade_id, conversation_id)
      VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                 (report_id, reporter, reported, mine['display_name'], theirs['display_name'], mine['handle'],
                  theirs['handle'], command.reason, note, command.source, command.trade_id,
                  conversation['id'] if conversation else None))
    if conversation:
        conn.execute(COPY_MESSAGES, {'r': report_id, 'low': conversation['user_low'] == reporter,
                                     'c': conversation['id']})
    _snapshot_trades(conn, report_id, reporter, reported)


@router.post('', response_model=ReportResult, status_code=201)
def report_collector(command: ReportCollector, user_id: str = Depends(verified_user)):
    """Report a collector by trader id; see the module docstring for the order of the checks. Answers 201
    ``{reported: true}`` whatever state the reported collector is in."""
    note = (normalize_text(command.note, empty_ok=True) or None) if command.note is not None else None
    extra = {'trader_id': str(command.trader_id), 'reason': command.reason, 'note': note, 'source': command.source,
             'trade_id': None if command.trade_id is None else str(command.trade_id)}
    with connect() as conn, conn.transaction():
        # The command lock first, so a duplicate sees the first request's stored answer or has not yet lost its reach.
        conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.friend_command:' || %s))", (user_id,))
        other = trader_user(conn, command.trader_id)
        if other is None or other == user_id:
            error(404, 'COLLECTOR_NOT_FOUND')
        _, stored = replay(conn, user_id, command.idempotency_key, command_payload('report', other, extra))
        if stored is not None:
            return stored
        if command.source == 'trade':
            if conn.execute(PAIR_TRADE, {'id': command.trade_id, 'a': user_id, 'b': other}).fetchone() is None:
                error(404, 'TRADE_NOT_FOUND')
        elif reach_one(conn, user_id, other) is None and pair_row(conn, user_id, other) is None:
            error(404, 'COLLECTOR_NOT_FOUND')

    def apply(conn, row):
        _file_report(conn, uuid4(), user_id, other, command, note)
        place_block(conn, user_id, other, 'trader')
        return 'reported'
    return _command(user_id, other, command.idempotency_key, 'report', apply, blocked_you_ok=True, extra=extra,
                    answer=lambda _: ReportResult(reported=True))


@admin_router.get('/api/admin/trade-reports', response_model=TradeReportList)
def list_trade_reports(status: Status = 'open', before: str | None = Query(None, max_length=4000),
                       user_id: str = Depends(verified_user)):
    """One page of reports with this status, newest first, 50 a page. ``before`` is the previous page's
    ``next_before``; a bad one is 422 INVALID_CURSOR."""
    with connect() as conn, conn.transaction():
        require_owner(conn, user_id)
        cursor = decode_cursor(before, ('report',)) if before else None
        where, args = 'WHERE r.status = %(status)s', {'status': status}
        if cursor:
            where += ' AND (r.created_at, r.id) < (%(at)s, %(id)s)'
            args |= {'at': cursor[0], 'id': cursor[2]}
        rows = conn.execute(f'{REPORT_ROWS} {where} ORDER BY r.created_at DESC, r.id DESC LIMIT {PAGE + 1}',
                            args).fetchall()
        opened = conn.execute("SELECT count(*) AS n FROM trade_report WHERE status = 'open'").fetchone()['n']
    page = rows[:PAGE]
    more = encode_cursor(page[-1]['created_at'], 'report', page[-1]['id']) if len(rows) > PAGE else None
    return TradeReportList(reports=[_row(row) for row in page], next_before=more, open_count=int(opened))


@admin_router.get('/api/admin/trade-reports/{report_id}', response_model=TradeReportDetail)
def read_trade_report(report_id: UUID, user_id: str = Depends(verified_user)):
    """One report with its snapshot, the reported collector's other reports and moderation events, and their account
    now. Reads only the report-owned rows."""
    with connect() as conn, conn.transaction():
        require_owner(conn, user_id)
        record = conn.execute(f'{REPORT_ROWS} WHERE r.id = %s', (report_id,)).fetchone()
        if record is None:
            error(404, 'REPORT_NOT_FOUND')
        reported = record['reported_id']
        others = [] if reported is None else conn.execute(
            f'{REPORT_ROWS} WHERE r.reported_id = %s AND r.id <> %s ORDER BY r.created_at DESC, r.id DESC LIMIT 50',
            (reported, report_id)).fetchall()
        messages = conn.execute("""SELECT message_id, from_reporter, body, at FROM trade_report_message
          WHERE report_id = %s ORDER BY at, message_id""", (report_id,)).fetchall()
        trades = conn.execute("""SELECT facts FROM trade_report_trade WHERE report_id = %s
          ORDER BY (facts->>'proposed_at')::timestamptz, trade_id""", (report_id,)).fetchall()
        events = conn.execute("""SELECT id, action, report_id, owner_id, note, created_at FROM moderation_event
          WHERE subject_id = %(s)s OR report_id = %(r)s ORDER BY created_at DESC, id DESC LIMIT 50""",
                              {'s': reported, 'r': report_id}).fetchall()
        state = None if reported is None else account_state(conn, reported)
    return TradeReportDetail(
        report=_row(record), note=record['note'], conversation_id=record['conversation_id'],
        trade_id=record['trade_id'], decided_at=record['decided_at'], decided_by=record['decided_by'],
        messages=[SnapshotMessage(message_id=row['message_id'], body=row['body'], at=row['at'],
                                  sender='reporter' if row['from_reporter'] else 'reported') for row in messages],
        trades=[SnapshotTrade.model_validate(row['facts']) for row in trades],
        account=(ReportedAccount(exists=False, suspended=False, removed=False) if state is None else
                 ReportedAccount(exists=True, suspended=state.suspended, removed=state.removed)),
        other_reports=[_row(row | {'reported_count': record['reported_count']}) for row in others],
        events=[ModerationEventView(**row) for row in events])


class _Retry(Exception):
    """A counterparty appeared between suspension's read and its locks: start the transaction again."""


def _open_report(conn, report_id: UUID):
    """The report row, after the report's advisory lock: 404 REPORT_NOT_FOUND, or 409 REPORT_DECIDED once decided."""
    report = conn.execute('SELECT * FROM trade_report WHERE id = %s', (report_id,)).fetchone()
    if report is None:
        error(404, 'REPORT_NOT_FOUND')
    if report['status'] != 'open':
        error(409, 'REPORT_DECIDED')
    return report


def _event(conn, *, subject_id: str | None, subject_name: str, report_id: UUID | None, action: str, owner_id: str,
           note: str | None) -> None:
    conn.execute("""INSERT INTO moderation_event (id, subject_id, subject_name, report_id, action, owner_id, note)
      VALUES (%s, %s, %s, %s, %s, %s, %s)""", (uuid4(), subject_id, subject_name, report_id, action, owner_id, note))


def _name_of(conn, user_id: str | None, fallback: str) -> str:
    row = None if user_id is None else conn.execute(
        'SELECT display_name FROM collector_profile WHERE user_id = %s', (user_id,)).fetchone()
    return row['display_name'] if row else fallback


def _decide_row(conn, report, owner_id: str, action: str, note: str | None) -> ReportDecided:
    """Writes the event, then marks the report decided. The last writes of a decision."""
    _event(conn, subject_id=report['reported_id'], subject_name=_name_of(conn, report['reported_id'],
                                                                         report['reported_name']),
           report_id=report['id'], action=action, owner_id=owner_id, note=note)
    status = 'dismissed' if action == 'dismiss' else 'actioned'
    conn.execute("""UPDATE trade_report SET status = %s, decision = %s, decided_at = now(), decided_by = %s
      WHERE id = %s""", (status, action, owner_id, report['id']))
    return ReportDecided(status=status, decision=action)


def _suspend(conn, account: str, partners: list[str], touched: list[UUID]) -> None:
    """Suspends the account under the locks of ``decide_trade_report``: the flag, discovery off, the unconfirmed
    Trades with each counterparty cancelled by the account, and (the first time only) the watermark of every other
    conversation of the account. Loans and friendships stay."""
    newly = conn.execute('UPDATE collector_profile SET suspended_at = now() '
                         'WHERE user_id = %s AND suspended_at IS NULL RETURNING 1', (account,)).fetchone()
    switch_off(conn, account)
    for other in partners:
        end_trades_between(conn, account, other)
    if newly:
        account_changed(conn, account, touched)


def _suspension(report_id: UUID, user_id: str, raw_note: str | None) -> ReportDecided:
    for _ in range(SUSPENSION_ATTEMPTS):
        try:
            with connect() as conn, conn.transaction():
                require_owner(conn, user_id)
                note = _owner_note(raw_note)
                conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.trade_report:' || %s))",
                             (str(report_id),))
                report = _open_report(conn, report_id)
                account = report['reported_id']
                if account is None:
                    error(409, 'REPORTED_ACCOUNT_GONE')
                lock_discovery(conn, account)
                seen, _ = unconfirmed_partners(conn, account)
                lock_owners(conn, account, *seen)
                if account_state(conn, account) is None:
                    error(409, 'REPORTED_ACCOUNT_GONE')
                partners, touched = unconfirmed_partners(conn, account)
                if set(partners) - set(seen):
                    raise _Retry
                _suspend(conn, account, partners, touched)
                return _decide_row(conn, report, user_id, 'suspend', note)
        except _Retry:
            continue
        except psycopg.errors.DeadlockDetected:
            error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')
    error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


def _removal_or_dismissal(report_id: UUID, user_id: str, action: str, raw_note: str | None) -> ReportDecided:
    try:
        with connect() as conn, conn.transaction():
            require_owner(conn, user_id)
            note = _owner_note(raw_note)
            conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.trade_report:' || %s))", (str(report_id),))
            report = _open_report(conn, report_id)
            if action == 'remove_from_discovery':
                account = report['reported_id']
                if account is None:
                    error(409, 'REPORTED_ACCOUNT_GONE')
                lock_discovery(conn, account)
                lock_owners(conn, account)
                if account_state(conn, account) is None:
                    error(409, 'REPORTED_ACCOUNT_GONE')
                remove_from_discovery(conn, account)
            return _decide_row(conn, report, user_id, action, note)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


@admin_router.post('/api/admin/trade-reports/{report_id}/decision', response_model=ReportDecided)
def decide_trade_report(report_id: UUID, command: ReportDecision, user_id: str = Depends(verified_user)):
    """The owner's decision on an open report: 404 REPORT_NOT_FOUND, 409 REPORT_DECIDED, and 409
    REPORTED_ACCOUNT_GONE for removal or suspension once the account is deleted. Repeats are idempotent: removing a
    removed collector keeps the first removal time, suspending a suspended one moves nothing; the report is decided
    either way."""
    if command.action == 'suspend':
        return _suspension(report_id, user_id, command.note)
    return _removal_or_dismissal(report_id, user_id, command.action, command.note)


@admin_router.post('/api/admin/collectors/{collector_id}/restore', response_model=CollectorRestored)
def restore_collector(collector_id: str, command: RestoreCollector, user_id: str = Depends(verified_user)):
    """Reverses a removal from open discovery (the collector switches discovery on again themselves) or a suspension
    (which never switches discovery on or lifts a removal). 404 COLLECTOR_NOT_FOUND, 409 NOTHING_TO_RESTORE."""
    try:
        with connect() as conn, conn.transaction():
            require_owner(conn, user_id)
            note = _owner_note(command.note)
            profile = conn.execute('SELECT display_name FROM collector_profile WHERE user_id = %s',
                                   (collector_id,)).fetchone()
            if profile is None:
                error(404, 'COLLECTOR_NOT_FOUND')
            lock_discovery(conn, collector_id)
            lock_owners(conn, collector_id)
            if command.what == 'discovery':
                if not restore_discovery(conn, collector_id):
                    error(409, 'NOTHING_TO_RESTORE')
                action = 'restore_discovery'
            else:
                lifted = conn.execute('UPDATE collector_profile SET suspended_at = NULL WHERE user_id = %s '
                                      'AND suspended_at IS NOT NULL RETURNING 1', (collector_id,)).fetchone()
                if lifted is None:
                    error(409, 'NOTHING_TO_RESTORE')
                account_changed(conn, collector_id, [])
                action = 'lift_suspension'
            _event(conn, subject_id=collector_id, subject_name=profile['display_name'], report_id=None, action=action,
                   owner_id=user_id, note=note)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')
    return CollectorRestored(restored=command.what)
