"""Shared Trade/Loan threads. Lock owners, Loan rounds, Trade rounds, then threads.

``touch_threads`` is the only thread UPDATE writer. Call it once, last, after
round writes and events. It accepts bare ids (the closure contract) or ThreadTouch
values for messages. Helpers never commit; their caller owns the transaction.
"""
from datetime import date, datetime
from typing import Literal, TYPE_CHECKING
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_serializer
from psycopg.types.json import Jsonb

if TYPE_CHECKING:
    from .trades import TradeView
    from .loans import LoanView

Kind = Literal['trade', 'loan']
Slot = Literal['low', 'high']


class ThreadParty(BaseModel):
    """Only the public trader address; never an account id or Handle."""
    trader_id: UUID | None
    display_name: str
    friend: bool = False
    available: bool = False


class Message(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: UUID
    from_: Literal['you', 'them'] = Field(alias='from')
    body: str
    at: datetime


class _EventLine(BaseModel):
    model_config = ConfigDict(extra='forbid')
    giver: Slot
    edition_id: UUID
    from_qty: int = Field(ge=0)
    to_qty: int = Field(ge=0)


class _Quantity(BaseModel):
    model_config = ConfigDict(extra='forbid')
    edition_id: UUID
    quantity: int = Field(ge=0)


class _Cash(BaseModel):
    model_config = ConfigDict(extra='forbid')
    cents: int | None = None
    payer: Slot | None = None


class _CashChange(BaseModel):
    model_config = ConfigDict(extra='forbid', populate_by_name=True)
    from_: _Cash = Field(alias='from')
    to: _Cash


class _DateChange(BaseModel):
    model_config = ConfigDict(extra='forbid', populate_by_name=True)
    from_: date | None = Field(alias='from')
    to: date | None


class _EventData(BaseModel):
    model_config = ConfigDict(extra='forbid')
    lines: list[_EventLine] | None = None
    cash: _CashChange | None = None
    return_by: _DateChange | None = None
    not_lent: list[_Quantity] | None = None
    returned: list[_Quantity] | None = None


def event_data(data: dict) -> dict:
    return _EventData.model_validate(data).model_dump(mode='json', by_alias=True, exclude_unset=True)


class EventEdition(BaseModel):
    """Public Printing and Variant facts needed to name an event's Edition."""
    model_config = ConfigDict(extra='forbid')
    edition_id: UUID
    name: str
    set_code: str
    collector_number: str
    descriptor: dict


class EventView(BaseModel):
    id: UUID
    actor: Slot | None
    kind: str
    round_id: UUID
    return_id: UUID | None = None
    data: _EventData = Field(default_factory=_EventData)
    editions: list[EventEdition] = Field(default_factory=list)
    at: datetime

    @field_serializer('data')
    def safe_data(self, value):
        return value.model_dump(mode='json', by_alias=True, exclude_unset=True)


class TimelineItem(BaseModel):
    kind: Literal['message', 'event']
    at: datetime
    cursor: str
    message: Message | None = None
    event: EventView | None = None


class SummaryCard(BaseModel):
    edition_id: UUID
    name: str
    image_url: str | None
    copies: str
    side: Literal['you_give', 'you_get']


class SummaryCash(BaseModel):
    cents: str
    payer: Literal['you', 'them']


class OfferSummary(BaseModel):
    # Counts include every line; previews contain at most three Editions.
    cards: list[SummaryCard] = Field(max_length=3)
    you_give: str
    you_get: str
    cash: SummaryCash | None = None


class ThreadItem(BaseModel):
    id: UUID
    kind: Kind
    other: ThreadParty
    you_are: Slot
    summary: OfferSummary
    section: Literal['needs_you', 'open', 'out_now', 'pending', 'done']
    state: str
    waiting: str | None = None
    unread: int = 0
    needs_you: bool = False
    last_activity_at: datetime
    latest: TimelineItem | None = None


class TradeDetail(BaseModel):
    id: UUID
    live_offer: 'TradeView'
    can_message: bool
    can_report: bool


class LoanDetail(BaseModel):
    id: UUID
    other: ThreadParty
    live_terms: 'LoanView'
    can_message: bool
    can_report: bool


class PulseCount(BaseModel):
    needs_you: int = 0
    waiting: int = 0
    unread: int = 0


class Pulse(BaseModel):
    trades: PulseCount
    loans: PulseCount
    watermark: str


class ThreadTouch(BaseModel):
    id: UUID
    # None means an event/activity update. Messages also advance their sender slot.
    from_low: bool | None = None
    activity: bool = True


def touch_threads(conn, updates: list[UUID | ThreadTouch]) -> dict[UUID, datetime]:
    """Deduplicate, lock ascending FOR NO KEY UPDATE, and write each thread once.

    Bare UUIDs mean activity changed. ``activity=False`` moves only the pulse
    watermark (Block/Unblock/Suspension). Return the locked monotonic activity
    timestamps, usable as message times. Never take an owner or round lock later.
    """
    merged = {}
    for update in updates:
        item = ThreadTouch(id=update) if isinstance(update, UUID) else update
        previous = merged.get(item.id)
        if previous is not None and previous.from_low is not None and item.from_low is not None \
                and previous.from_low != item.from_low:
            raise ValueError('one transaction cannot send from both slots')
        merged[item.id] = ThreadTouch(id=item.id, activity=item.activity or bool(previous and previous.activity),
                                     from_low=item.from_low if item.from_low is not None else
                                     previous.from_low if previous else None)
    times = {}
    for tid, item in sorted(merged.items()):
        conn.execute('SELECT id FROM thread WHERE id=%s FOR NO KEY UPDATE', (tid,))
        row = conn.execute("""WITH tick AS MATERIALIZED (
          SELECT greatest(last_activity_at + interval '1 microsecond',clock_timestamp()) AS at
          FROM thread WHERE id=%(id)s)
          UPDATE thread SET
          changed_at=greatest(changed_at + interval '1 microsecond', clock_timestamp()),
          last_activity_at=CASE WHEN %(activity)s THEN tick.at ELSE last_activity_at END,
          last_from_low_at=CASE WHEN %(low)s::boolean IS TRUE THEN tick.at ELSE last_from_low_at END,
          last_from_high_at=CASE WHEN %(low)s::boolean IS FALSE THEN tick.at ELSE last_from_high_at END
          FROM tick WHERE id=%(id)s RETURNING last_activity_at""",
                           {'id': tid, 'activity': item.activity, 'low': item.from_low}).fetchone()
        if row:
            times[tid] = row['last_activity_at']
    return times


def write_event(conn, thread_id: UUID, kind: str, round_id: UUID, *, actor: Slot | None = None,
                data: dict | None = None, return_id: UUID | None = None) -> UUID:
    """Insert a slot-based log before touch_threads; no thread lock, no commit.

    data contains Edition quantities, cash and dates only. Picks, Locations,
    Decks, Handles and account ids must never be passed by step writers.
    """
    event_id = uuid4()
    conn.execute("""INSERT INTO thread_event(id,thread_id,actor,kind,round_id,return_id,data,created_at)
      VALUES (%s,%s,%s,%s,%s,%s,%s,clock_timestamp())""",
                 (event_id, thread_id, actor, kind, round_id, return_id, Jsonb(event_data(data or {}))))
    return event_id


import base64
import hashlib
import re
import unicodedata

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query
from ..db import connect
from ..core.catalog.card_facts import card_facts
from ..identity import verified_user
from ..location_tree import error
from .owners import lock_owners
from .discovery import reach, reach_one, require_not_suspended, count_new_contact, new_contact_lock

PAGE = 50
MESSAGE_LENGTH = 1000
MESSAGES_PER_HOUR = 120
CURSOR_LENGTH = 200
BIDI = frozenset(chr(code) for code in (*range(0x202A, 0x202F), *range(0x2066, 0x206A)))
CURSOR_TEXT = re.compile(r'[A-Za-z0-9_-]*')

def normalize_text(text: str, limit: int = MESSAGE_LENGTH, *, empty_ok: bool = False) -> str:
    """A message body as stored, rule by rule in this order: CRLF and CR become LF; Unicode NFC; each control character
    (category Cc) but LF and TAB, and each bidirectional formatting character, is dropped; trimmed. Empty is 422
    EMPTY_MESSAGE and more than ``limit`` code points is 422 MESSAGE_TOO_LONG. Plain text: no link detection. With
    ``empty_ok`` an empty result is returned as ``''`` (the Report note, Trading #303)."""
    text = unicodedata.normalize('NFC', text.replace('\r\n', '\n').replace('\r', '\n'))
    text = ''.join(char for char in text
                   if char not in BIDI and (char in '\n\t' or unicodedata.category(char) != 'Cc')).strip()
    if not text:
        if empty_ok:
            return ''
        error(422, 'EMPTY_MESSAGE')
    if len(text) > limit:
        error(422, 'MESSAGE_TOO_LONG')
    return text

def encode_cursor(at: datetime, kind: str, item_id: UUID) -> str:
    return base64.urlsafe_b64encode(f'{at.isoformat()}|{kind}|{item_id}'.encode()).rstrip(b'=').decode()

def decode_cursor(value: str, kinds: tuple[str, ...]) -> tuple[datetime, str, UUID]:
    """The (time, kind, id) a cursor names, or 422 INVALID_CURSOR: over ``CURSOR_LENGTH`` characters, outside the
    URL-safe alphabet, not three parts, a time without a zone or not ISO, a kind not in ``kinds`` or a bad id."""
    try:
        if len(value) > CURSOR_LENGTH or not CURSOR_TEXT.fullmatch(value):
            raise ValueError
        text = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True).decode('ascii')
        stamp, kind, item = text.split('|')
        at = datetime.fromisoformat(stamp)
        if at.tzinfo is None or kind not in kinds:
            raise ValueError
        return at, kind, UUID(item)
    except ValueError:
        error(422, 'INVALID_CURSOR')

def count_message(conn, user_id: str) -> None:
    """Counts one message against the hourly limit: rows older than an hour pruned, and 429 MESSAGE_RATE_LIMITED with
    ``retry_after_minutes`` at the limit. The caller holds the sender's message lock and has answered a replay. A
    refused message rolls back with its count."""
    conn.execute("""DELETE FROM handle_lookup_event
      WHERE user_id=%s AND kind='message' AND created_at < now() - interval '1 hour'""", (user_id,))
    recent = conn.execute("""SELECT count(*) AS sent, min(created_at) AS oldest FROM handle_lookup_event
      WHERE user_id=%s AND kind='message'""", (user_id,)).fetchone()
    if recent['sent'] >= MESSAGES_PER_HOUR:
        wait = conn.execute("SELECT ceil(extract(epoch FROM %s + interval '1 hour' - now()) / 60) AS wait",
                            (recent['oldest'],)).fetchone()['wait']
        raise HTTPException(429, {'code': 'MESSAGE_RATE_LIMITED', 'retry_after_minutes': max(1, int(wait))})
    conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,'message')", (user_id,))


class SendMessage(BaseModel):
    body: str = Field(max_length=4000)
    idempotency_key: UUID


class ReadResult(BaseModel):
    read: bool


class ReadThrough(BaseModel):
    through: str = Field(max_length=4000)


class Timeline(BaseModel):
    # Lets the log renderer name slot-based events without exposing account ids.
    you_are: Slot
    items: list[TimelineItem]
    next_before: str | None = None


def member_thread(conn, user_id: str, thread_id: UUID, kind: Kind):
    row = conn.execute('SELECT t.*, m.read_at FROM thread t JOIN thread_member m ON m.thread_id=t.id '
                       'WHERE t.id=%s AND t.kind=%s AND m.member_id=%s', (thread_id, kind, user_id)).fetchone()
    if row is None:
        error(404, 'TRADE_NOT_FOUND' if kind == 'trade' else 'LOAN_NOT_FOUND')
    return row


def public_thread_party(profile, retained_name: str, *, available: bool, friend: bool) -> ThreadParty:
    """One public projection for list and detail, including unavailable/deleted parties."""
    return ThreadParty(trader_id=profile['trader_id'] if profile else None,
                       display_name=profile['display_name'] if profile else retained_name,
                       friend=available and friend, available=available)


def thread_party(conn, user_id: str, row) -> ThreadParty:
    from .friends import friend_ids
    other = row['user_high'] if row['user_low'] == user_id else row['user_low']
    profile = conn.execute('SELECT trader_id, display_name FROM collector_profile WHERE user_id=%s',
                           (other,)).fetchone() if other else None
    name = row.get('other_name', 'This collector is no longer available')
    available = other is not None and reach_one(conn, user_id, other) is not None
    return public_thread_party(profile, name, available=available, friend=other in friend_ids(conn, user_id))


def event_edition_ids(data) -> set[UUID]:
    value = _EventData.model_validate(data or {})
    return {line.edition_id for lines in (value.lines, value.not_lent, value.returned) for line in (lines or [])}


def event_editions(data, facts) -> list[EventEdition]:
    return [EventEdition(edition_id=card.edition_id, name=card.name, set_code=card.set_code,
                         collector_number=card.collector_number, descriptor=card.descriptor)
            for edition in sorted(event_edition_ids(data)) if (card := facts.get(edition)) is not None]


def timeline_item(row, low: bool, edition_facts=None) -> TimelineItem:
    at = row['created_at']
    kind = row['item_kind']
    return TimelineItem(kind=kind, at=at, cursor=encode_cursor(at, kind, row['id']),
                        message=Message(id=row['id'], from_='you' if row['from_low'] == low else 'them',
                                        body=row['body'], at=at) if kind == 'message' else None,
                        event=EventView(id=row['id'], actor=row['actor'], kind=row['kind'], round_id=row['round_id'],
                                        return_id=row['return_id'], data=row['data'],
                                        editions=event_editions(row['data'], edition_facts or {}), at=at)
                        if kind == 'event' else None)


TIMELINE = """SELECT id, thread_id, created_at, 'message'::text AS item_kind, from_low, body,
  NULL::text AS actor, NULL::text AS kind, NULL::uuid AS round_id, NULL::uuid AS return_id, NULL::jsonb AS data
  FROM thread_message WHERE thread_id=%(thread)s
  UNION ALL SELECT id, thread_id, created_at, 'event', NULL, NULL, actor, kind, round_id, return_id, data
  FROM thread_event WHERE thread_id=%(thread)s"""


def timeline_rows(conn, thread_id: UUID, before: str | None = None, limit: int = PAGE + 1):
    params = {'thread': thread_id, 'limit': limit}
    where = ''
    if before:
        at, kind, item = decode_cursor(before, ('message', 'event'))
        params |= {'at': at, 'kind': kind, 'id': item}
        where = ' WHERE (created_at,item_kind,id) < (%(at)s,%(kind)s,%(id)s)'
    return conn.execute('SELECT * FROM (' + TIMELINE + ') items' + where +
                        ' ORDER BY created_at DESC,item_kind DESC,id DESC LIMIT %(limit)s', params).fetchall()


# This predicate is shared by the list selector and the pulse aggregates.
NEEDS_YOU = '(waiting IS NOT NULL OR unread > 0)'
MARK_ROWS = 'SELECT *,' + NEEDS_YOU + ' AS needs_you FROM marked'
MARKS = """WITH live AS (
  SELECT * FROM jsonb_to_recordset(%(live)s) AS x(id uuid,state text,waiting text,out_now boolean)
), marked AS (
  SELECT t.id,t.kind,t.user_low,t.user_high,t.last_activity_at,
    coalesce(live.state,'closed') AS live_state,coalesce(live.out_now,false) AS out_now,live.waiting,
    CASE WHEN (CASE WHEN t.user_low IS NOT DISTINCT FROM %(me)s THEN t.last_from_high_at
               ELSE t.last_from_low_at END) > coalesce(m.read_at,'-infinity')
      THEN (SELECT count(*) FROM thread_message msg WHERE msg.thread_id=t.id
        AND msg.from_low IS DISTINCT FROM (t.user_low IS NOT DISTINCT FROM %(me)s)
        AND msg.created_at > coalesce(m.read_at,'-infinity')) ELSE 0 END AS unread
  FROM thread_member m JOIN thread t ON t.id=m.thread_id LEFT JOIN live ON live.id=t.id
  WHERE m.member_id=%(me)s AND t.kind=%(kind)s)
"""


def mark_query(conn, user_id: str, kind: Kind):
    """Waiting facts for live rounds only; read closed history needs no round/line reads.

    Retain the step modules' waiting definitions, including stale picks and
    pending returns. The SQL consumes only their small mark results, never card
    facts, names, summaries or timeline presentations.
    """
    if kind == 'trade':
        from .trades import trade_facts, waiting_trade_step
        table, facts_of, waiting_of = 'trade', trade_facts, waiting_trade_step
    else:
        from .loans import loan_facts, waiting_step
        table, facts_of, waiting_of = 'loan', loan_facts, waiting_step
    rows = conn.execute(f'SELECT r.* FROM {table} r JOIN thread_member m ON m.thread_id=r.thread_id '
                        "WHERE m.member_id=%s AND r.state <> 'closed'", (user_id,)).fetchall()
    facts = facts_of(conn, user_id, rows) if rows else {}
    live = [{'id': str(r['thread_id']), 'state': r['state'], 'waiting': waiting_of(user_id, r, facts[r['id']]),
             'out_now': kind == 'loan' and (r['state'] == 'handed_over' or r['lender_handover_at'] is not None
                                           or r['borrower_handover_at'] is not None)} for r in rows]
    return MARKS, {'me': user_id, 'kind': kind, 'live': Jsonb(live)}, live


def needs_you_rows(conn, user_id: str, kind: Kind, *, all_marks: bool = False) -> list[dict]:
    """The single lightweight mark read for pulse and Needs you lists; never presentation.

    Pulse asks for all marks so waiting and unread counts, including overlaps,
    come from the same predicates as the lists.
    """
    sql, params, _ = mark_query(conn, user_id, kind)
    return conn.execute(sql + MARK_ROWS + ('' if all_marks else ' WHERE ' + NEEDS_YOU) +
                        ' ORDER BY last_activity_at DESC,id DESC', params).fetchall()


def select_marks(conn, user_id: str, kind: Kind, group: str, with_trader: UUID | None, cursor):
    if group == 'needs_you':
        rows = needs_you_rows(conn, user_id, kind)
        if with_trader is not None:
            other = conn.execute('SELECT user_id FROM collector_profile WHERE trader_id=%s', (with_trader,)).fetchone()
            rows = [r for r in rows if other is not None and other['user_id'] ==
                    (r['user_high'] if r['user_low'] == user_id else r['user_low'])]
        return rows
    sql, params, _ = mark_query(conn, user_id, kind)
    where = ['NOT ' + NEEDS_YOU]
    if group == 'done':
        where.append("live_state='closed'")
    else:
        where.append("live_state <> 'closed'")
    if group == 'out_now':
        where.append('out_now')
    elif group == 'pending':
        where.append('NOT out_now')
    if with_trader is not None:
        where.append('EXISTS (SELECT 1 FROM collector_profile p WHERE p.trader_id=%(with)s AND '
                     'p.user_id=CASE WHEN user_low=%(me)s THEN user_high ELSE user_low END)')
        params['with'] = with_trader
    if cursor:
        where.append('(last_activity_at,id) < (%(at)s,%(id)s)')
        params |= {'at': cursor[0], 'id': cursor[2]}
    limit = ' LIMIT %(limit)s'
    params['limit'] = PAGE
    return conn.execute(sql + MARK_ROWS + ' WHERE ' + ' AND '.join(where) +
                        ' ORDER BY last_activity_at DESC,id DESC' + limit, params).fetchall()


def thread_items(conn, user_id: str, kind: Kind, marks: list[dict] | None = None) -> list[ThreadItem]:
    """Render only selected marks; filtering and paging precede presentation reads.

    Waiting and unread were calculated together by the shared mark query. No
    card, profile, summary or timeline read is needed for excluded list rows.
    """
    if marks is None:
        sql, params, _ = mark_query(conn, user_id, kind)
        marks = conn.execute(sql + MARK_ROWS + ' ORDER BY last_activity_at DESC,id DESC', params).fetchall()
    if not marks:
        return []
    ids = [row['id'] for row in marks]
    marks_by_id = {row['id']: row for row in marks}
    table, first, second = ('trade', 'proposer', 'recipient') if kind == 'trade' else ('loan', 'lender', 'borrower')
    rows = conn.execute('SELECT t.*,m.read_at FROM thread t JOIN thread_member m ON m.thread_id=t.id '
                        'WHERE m.member_id=%s AND t.id=ANY(%s) ORDER BY t.last_activity_at DESC,t.id DESC',
                        (user_id, ids)).fetchall()
    rounds = conn.execute(f'SELECT DISTINCT ON (r.thread_id) r.* FROM {table} r WHERE r.thread_id=ANY(%s) '
                          "ORDER BY r.thread_id,(r.state <> 'closed') DESC,r.created_at DESC,r.id DESC", (ids,)).fetchall()
    by_thread = {r['thread_id']: r for r in rounds}
    others = {row['user_high'] if row['user_low'] == user_id else row['user_low'] for row in rows} - {None}
    profiles = {p['user_id']: p for p in conn.execute(
        'SELECT user_id,trader_id,display_name FROM collector_profile WHERE user_id=ANY(%s)', (sorted(others),))}
    reachable = reach(conn, user_id, sorted(others))
    from .friends import friend_ids
    friends = friend_ids(conn, user_id) if others else set()
    # Each branch uses its (thread_id, created_at DESC, id DESC) index.
    message_sql, event_sql = TIMELINE.split('UNION ALL')
    newest = '(' + message_sql + ' ORDER BY created_at DESC,id DESC LIMIT 1) UNION ALL (' + event_sql + \
             ' ORDER BY created_at DESC,id DESC LIMIT 1)'
    newest = newest.replace('%(thread)s', 't.id')
    latest_by_thread = {r['thread_id']: r for r in conn.execute(
        'SELECT item.* FROM thread t CROSS JOIN LATERAL (SELECT * FROM (' + newest + ') newest '
        'ORDER BY created_at DESC,item_kind DESC,id DESC LIMIT 1) item WHERE t.id=ANY(%s)', (ids,))}
    round_ids = [r['id'] for r in rounds]
    if kind == 'trade':
        summary_lines = conn.execute('SELECT trade_id AS round_id,side,edition_id,quantity FROM trade_line '
                                     'WHERE trade_id=ANY(%s) ORDER BY trade_id,side,position', (round_ids,)).fetchall()
    else:
        summary_lines = conn.execute("""SELECT l.loan_id AS round_id,'lender' AS side,l.edition_id,
          CASE WHEN r.accepted_at IS NULL THEN l.requested ELSE l.promised END AS quantity
          FROM loan_line l JOIN loan r ON r.id=l.loan_id WHERE l.loan_id=ANY(%s)
          ORDER BY l.loan_id,l.position""", (round_ids,)).fetchall()
    event_ids = {edition for latest in latest_by_thread.values() if latest['item_kind'] == 'event'
                 for edition in event_edition_ids(latest['data'])}
    cards = card_facts(conn, [line['edition_id'] for line in summary_lines] + list(event_ids))
    lines_by_round = {}
    for line in summary_lines:
        lines_by_round.setdefault(line['round_id'], []).append(line)
    result = []
    for row in rows:
        live = by_thread.get(row['id'])
        if live is None:
            continue
        other_role = second if live[first + '_id'] == user_id else first
        row['other_name'] = live[other_role + '_name']
        waiting = marks_by_id[row['id']]['waiting']
        unread = marks_by_id[row['id']]['unread']
        latest = latest_by_thread.get(row['id'])
        other_id = row['user_high'] if row['user_low'] == user_id else row['user_low']
        profile = profiles.get(other_id)
        party = public_thread_party(profile, row['other_name'], available=other_id in reachable,
                                    friend=other_id in friends)
        state = live['state']
        if kind == 'trade':
            state = {'proposed': 'offered', 'accepted': 'agreed'}.get(state, state)
            if state == 'agreed' and (live['proposer_swap_at'] or live['recipient_swap_at']):
                state = 'confirming'
            if state == 'closed' and live['closed_reason'] == 'swapped':
                state = 'done'
        counts = {'you_give': 0, 'you_get': 0}
        previews = []
        reader_role = first if live[first + '_id'] == user_id else second
        for line in lines_by_round.get(live['id'], []):
            side = 'you_give' if line['side'] == reader_role else 'you_get'
            counts[side] += int(line['quantity'])
            if len(previews) < 3:
                card = cards[line['edition_id']]
                previews.append(SummaryCard(edition_id=card.edition_id, name=card.name, image_url=card.image_url,
                                            copies=str(line['quantity']), side=side))
        cash = None
        if kind == 'trade' and live['cash_cents']:
            cash = SummaryCash(cents=str(live['cash_cents']),
                               payer='you' if live['cash_payer'] == reader_role else 'them')
        section = 'done' if state in ('closed', 'done') else 'open'
        if kind == 'loan' and section != 'done':
            section = 'out_now' if live['state'] == 'handed_over' or live['lender_handover_at'] is not None \
                or live['borrower_handover_at'] is not None else 'pending'
        if marks_by_id[row['id']]['needs_you']:
            section = 'needs_you'
        result.append(ThreadItem(id=row['id'], kind=kind, other=party, state=state,
                                 you_are='low' if row['user_low'] == user_id else 'high', section=section,
                                 summary=OfferSummary(cards=previews, you_give=str(counts['you_give']),
                                                      you_get=str(counts['you_get']), cash=cash),
                                 waiting=waiting, unread=unread, needs_you=marks_by_id[row['id']]['needs_you'],
                                 last_activity_at=row['last_activity_at'],
                                 latest=timeline_item(latest, row['user_low'] == user_id, cards) if latest else None))
    return result


router = APIRouter(prefix='/api/threads', tags=['threads'])
trade_router = APIRouter(prefix='/api/trades', tags=['threads'])
loan_router = APIRouter(prefix='/api/loans', tags=['threads'])


@router.get('/pulse', response_model=Pulse)
def read_pulse(user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        counted, waiting_marks = {}, []
        for kind in ('trade', 'loan'):
            marks = needs_you_rows(conn, user_id, kind, all_marks=True)
            counted[kind] = PulseCount(needs_you=sum(r['needs_you'] for r in marks),
                                       waiting=sum(r['waiting'] is not None for r in marks),
                                       unread=sum(r['unread'] > 0 for r in marks))
            waiting_marks.extend((str(r['id']), r['waiting']) for r in marks)
        stamps = conn.execute("""SELECT count(*) AS n,sum(extract(epoch FROM t.changed_at)) AS changed,
          sum(extract(epoch FROM m.read_at)) AS read,count(m.read_at) AS read_n
          FROM thread_member m JOIN thread t ON t.id=m.thread_id WHERE m.member_id=%s""", (user_id,)).fetchone()
        news = conn.execute('SELECT id,read_at,dismissed_at FROM inbox_update WHERE recipient_id=%s ORDER BY id',
                            (user_id,)).fetchall()
        # Waiting can change after an inventory move without any thread write.
        people = conn.execute("""SELECT p.user_id,p.suspended_at FROM collector_profile p WHERE p.user_id=%s
          OR p.user_id IN (SELECT user_low FROM thread_member m JOIN thread t ON t.id=m.thread_id
            WHERE m.member_id=%s UNION SELECT user_high FROM thread_member m JOIN thread t ON t.id=m.thread_id
            WHERE m.member_id=%s) ORDER BY p.user_id""", (user_id, user_id, user_id)).fetchall()
        blocks = conn.execute('SELECT blocker_id,blocked_id FROM block WHERE blocker_id=%s OR blocked_id=%s '
                              'ORDER BY blocker_id,blocked_id', (user_id, user_id)).fetchall()
        parts = (stamps, news, people, blocks, sorted(waiting_marks))
        watermark = hashlib.sha256(repr(parts).encode()).hexdigest()[:32]
    return Pulse(trades=counted['trade'], loans=counted['loan'], watermark=watermark)


def list_items(kind: Kind, group: str, with_trader: UUID | None, before: str | None, user_id: str):
    allowed = ('needs_you', 'open', 'done') if kind == 'trade' else ('needs_you', 'open', 'out_now', 'pending', 'done')
    if group not in allowed:
        error(422, 'INVALID_GROUP')
    cursor = decode_cursor(before, ('thread',)) if before else None
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        marks = select_marks(conn, user_id, kind, group, with_trader, cursor)
        return thread_items(conn, user_id, kind, marks)


def get_timeline(kind: Kind, thread_id: UUID, before: str | None, user_id: str):
    with connect() as conn, conn.transaction():
        row = member_thread(conn, user_id, thread_id, kind)
        found = timeline_rows(conn, thread_id, before)
        page = found[:PAGE]
        ids = {edition for item in page if item['item_kind'] == 'event' for edition in event_edition_ids(item['data'])}
        facts = card_facts(conn, ids)
        items = [timeline_item(item, row['user_low'] == user_id, facts) for item in page]
    return Timeline(you_are='low' if row['user_low'] == user_id else 'high', items=items, next_before=items[-1].cursor if len(found) > PAGE else None)


def send_message(kind: Kind, thread_id: UUID, command: SendMessage, user_id: str):
    body = normalize_text(command.body)
    try:
        with connect() as conn, conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.message:' || %s))", (user_id,))
            row = member_thread(conn, user_id, thread_id, kind)
            low = row['user_low'] == user_id
            other = row['user_high'] if low else row['user_low']
            lock_owners(conn, user_id, *([other] if other else []))
            stored = conn.execute('SELECT * FROM thread_message WHERE thread_id=%s AND from_low=%s AND client_key=%s',
                                  (thread_id, low, command.idempotency_key)).fetchone()
            if stored is None:
                require_not_suspended(conn, user_id)
                if other is None or reach_one(conn, user_id, other) is None:
                    error(409, 'COLLECTOR_UNAVAILABLE')
                count_message(conn, user_id)
                at = touch_threads(conn, [ThreadTouch(id=thread_id, from_low=low)])[thread_id]
                stored = conn.execute('INSERT INTO thread_message(id,thread_id,from_low,client_key,body,created_at) '
                                      'VALUES (%s,%s,%s,%s,%s,%s) RETURNING *',
                                      (uuid4(), thread_id, low, command.idempotency_key, body, at)).fetchone()
            return Message(id=stored['id'], from_='you', body=stored['body'], at=stored['created_at'])
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


def read_through(kind: Kind, thread_id: UUID, command: ReadThrough, user_id: str):
    at, item_kind, item_id = decode_cursor(command.through, ('message', 'event'))
    with connect() as conn, conn.transaction():
        member_thread(conn, user_id, thread_id, kind)
        table = 'thread_message' if item_kind == 'message' else 'thread_event'
        named = conn.execute(f'SELECT created_at FROM {table} WHERE id=%s AND thread_id=%s',
                             (item_id, thread_id)).fetchone()
        if named is None or named['created_at'] != at:
            error(422, 'INVALID_CURSOR')
        conn.execute("UPDATE thread_member SET read_at=greatest(coalesce(read_at,'-infinity'),%s) "
                     'WHERE thread_id=%s AND member_id=%s', (named['created_at'], thread_id, user_id))
    return {'read': True}


# Static list/pulse routes are registered before the step modules' dynamic routes.
def register_routes(target: APIRouter, kind: Kind):
    @target.get('', response_model=list[ThreadItem])
    def listing(group: str = 'open', with_trader: UUID | None = Query(None, alias='with'),
                before: str | None = Query(None, max_length=4000), user_id: str = Depends(verified_user)):
        return list_items(kind, group, with_trader, before, user_id)

    @target.get('/{thread_id}/timeline', response_model=Timeline)
    def timeline(thread_id: UUID, before: str | None = Query(None, max_length=4000),
                 user_id: str = Depends(verified_user)):
        return get_timeline(kind, thread_id, before, user_id)

    @target.post('/{thread_id}/messages', response_model=Message, status_code=201)
    def message(thread_id: UUID, command: SendMessage, user_id: str = Depends(verified_user)):
        return send_message(kind, thread_id, command, user_id)

    @target.post('/{thread_id}/read', response_model=ReadResult)
    def read(thread_id: UUID, command: ReadThrough, user_id: str = Depends(verified_user)):
        return read_through(kind, thread_id, command, user_id)


register_routes(trade_router, 'trade')
register_routes(loan_router, 'loan')
