"""Retained pair/header helpers for discovery and closure callers.

Conversation HTTP routes are removed at the thread cutover. The old archive is
read only. Common message text and cursor rules live in threads.py; pair and
account watermark helpers delegate their thread writes to touch_threads.
"""
import base64
import hashlib
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from ..location_tree import error
from ..db import connect
from ..identity import verified_user
from .discovery import Band, reach, reach_one, require_not_suspended
from .threads import normalize_text, encode_cursor, decode_cursor, count_message, touch_threads, ThreadTouch
from .owners import ensure_owner, lock_owners
from .trades import (TRADES, TradeView, completed_trades, trade_facts, trade_views, waiting_trade_step)

router = APIRouter(prefix='/api/social/conversations', tags=['social'])
traders_router = APIRouter(prefix='/api/social/traders', tags=['social'])

MESSAGES_PER_HOUR = 120
NEW_CONVERSATIONS_PER_DAY = 10
PAGE = 50
MESSAGE_LENGTH = 1000
PREVIEW = 140
CURSOR_LENGTH = 200

Status = Literal['open', 'you_blocked', 'unavailable']

# Bidirectional formatting characters: U+202A to U+202E and U+2066 to U+2069.
BIDI = frozenset(chr(code) for code in (*range(0x202A, 0x202F), *range(0x2066, 0x206A)))
CURSOR_TEXT = re.compile(r'[A-Za-z0-9_-]*')


class ConversationParty(BaseModel):
    """The other collector as the reader sees them in a conversation. ``trader_id`` is their address for messages
    (None once their account is deleted); ``handle`` is set for Friends only; ``band`` is the distance band (None
    unless both are in open discovery, and None when they are unavailable); ``completed_trades`` is None when they
    are unavailable. Never their collector id."""
    trader_id: UUID | None
    display_name: str
    friend: bool
    handle: str | None
    band: Band | None
    completed_trades: int | None


class Message(BaseModel):
    """One message. ``from`` is 'you' for the reader's own and 'them' for the other collector's."""
    model_config = ConfigDict(populate_by_name=True)
    id: UUID
    from_: Literal['you', 'them'] = Field(alias='from')
    body: str
    at: datetime


class TimelineItem(BaseModel):
    """One item of a conversation: a message or a Trade round's card (the Trade as it stands now). ``cursor`` names the
    item for ``before`` and for ``read``."""
    kind: Literal['message', 'trade']
    at: datetime
    cursor: str
    message: Message | None
    trade: TradeView | None


class ConversationView(BaseModel):
    """A conversation and its newest page of items (newest first), or an empty one (``id`` None) for a Friend the
    reader has not written to. ``status``: 'open', 'you_blocked' (the reader blocked the other) or 'unavailable' (the
    other blocked the reader, is suspended or is deleted; the three read alike). ``can_message`` and ``can_propose``:
    the conversation is open and the reader is not suspended. ``can_report``: the other collector still exists.
    ``next_before`` is the cursor of the next, older page."""
    id: UUID | None
    other: ConversationParty
    status: Status
    can_message: bool
    can_propose: bool
    can_report: bool
    items: list[TimelineItem]
    next_before: str | None


class LastMessage(BaseModel):
    """The newest message of a conversation: its sender, the first ``PREVIEW`` code points and its time."""
    model_config = ConfigDict(populate_by_name=True)
    from_: Literal['you', 'them'] = Field(alias='from')
    preview: str
    at: datetime


class ConversationSummary(BaseModel):
    """One row of the conversation list. ``open_trades``: Trades not closed. ``waiting_on_you``: those that wait on the
    reader. ``unread``: the other side wrote since the reader last read. ``archived``: hidden until newer activity."""
    id: UUID
    other: ConversationParty
    status: Status
    last_message: LastMessage | None
    open_trades: int
    waiting_on_you: int
    unread: bool
    archived: bool
    last_activity_at: datetime


class ConversationsView(BaseModel):
    """One page of the list, newest activity first. ``next_before``: the cursor of the next page. ``suspended``: the
    reader is suspended (the Trades tab says so)."""
    conversations: list[ConversationSummary]
    next_before: str | None
    suspended: bool


class ConversationPulse(BaseModel):
    """What the web polls: how many visible conversations are unread, and an opaque watermark that changes when
    anything the shell shows may have changed."""
    unread_conversations: int
    watermark: str


class SendMessage(BaseModel):
    body: str = Field(max_length=4000)
    idempotency_key: UUID


class ReadThrough(BaseModel):
    through: str = Field(max_length=4000)


@dataclass(frozen=True)
class Standing:
    """What the reader may do with one other collector: the party, the status and the three flags."""
    party: ConversationParty
    status: str
    can_message: bool
    can_propose: bool
    can_report: bool








def standings(conn, user_id: str, others: dict) -> dict:
    """The reader's ``Standing`` for each other collector, by the caller's key. ``others`` maps a key to (the other's
    account id or None, the name stored for them). Five reads whatever the number: profiles (the others and the
    reader), Blocks either way, the reader's Friends, the reach rule's bands and the others' completed Trades.
    Precedence: no account or no profile is 'unavailable'; the reader blocked them is 'you_blocked'; they blocked the
    reader or are suspended is 'unavailable'; otherwise 'open'. An unavailable collector shows as no Friend, with no
    Handle, band or count; their ``trader_id`` stays unless the account is deleted."""
    from .friends import friend_ids
    ids = sorted({other for other, _ in others.values() if other is not None})
    profiles = {row['user_id']: row for row in conn.execute(
        'SELECT user_id, trader_id, handle, suspended_at IS NOT NULL AS suspended FROM collector_profile '
        'WHERE user_id = ANY(%s)', (sorted({*ids, user_id}),))}
    blocked_by_me, blocked_me = set(), set()
    if ids:
        for row in conn.execute("""SELECT blocker_id, blocked_id FROM block
          WHERE (blocker_id = %(me)s AND blocked_id = ANY(%(ids)s)) OR (blocked_id = %(me)s AND blocker_id = ANY(%(ids)s))""",
                                {'me': user_id, 'ids': ids}):
            (blocked_by_me if row['blocker_id'] == user_id else blocked_me).add(
                row['blocked_id'] if row['blocker_id'] == user_id else row['blocker_id'])
    friends = friend_ids(conn, user_id) if ids else set()
    reachable = reach(conn, user_id, ids)
    viewer = profiles.get(user_id)
    suspended = bool(viewer and viewer['suspended'])

    def status_of(other_id: str | None) -> str:
        if other_id is None or other_id not in profiles:
            return 'unavailable'
        if other_id in blocked_by_me:
            return 'you_blocked'
        if other_id in blocked_me or profiles[other_id]['suspended']:
            return 'unavailable'
        return 'open'

    counted = [other for other, _ in others.values() if other in profiles and status_of(other) != 'unavailable']
    counts = completed_trades(conn, counted)
    found = {}
    for key, (other_id, name) in others.items():
        status = status_of(other_id)
        profile = profiles.get(other_id) if other_id is not None else None
        usable = status != 'unavailable'
        friend = usable and other_id in friends
        found[key] = Standing(
            party=ConversationParty(
                trader_id=profile['trader_id'] if profile else None, display_name=name, friend=friend,
                handle=profile['handle'] if friend else None,
                band=reachable[other_id].band if usable and other_id in reachable else None,
                completed_trades=counts.get(other_id, 0) if usable else None),
            status=status, can_message=status == 'open' and not suspended,
            can_propose=status == 'open' and not suspended, can_report=profile is not None)
    return found




def traded_before(conn, one: str, two: str) -> bool:
    """The pair has a Trade both sides confirmed (both swap times set, whoever proposed it): 'traded with before'. One
    confirmation does not count."""
    return conn.execute("""SELECT EXISTS (SELECT 1 FROM trade WHERE proposer_swap_at IS NOT NULL
      AND recipient_swap_at IS NOT NULL
      AND ((proposer_id = %(a)s AND recipient_id = %(b)s) OR (proposer_id = %(b)s AND recipient_id = %(a)s))) AS found""",
                        {'a': one, 'b': two}).fetchone()['found']


def count_new_conversation(conn, user_id: str) -> None:
    """Counts one new conversation against the daily limit: rows older than 24 hours pruned, and 429
    TOO_MANY_NEW_CONVERSATIONS with ``retry_after_minutes`` at the limit. The caller holds the caller's
    ``new_conversation`` lock (``open_conversation`` checks it). A refused step rolls back with its count."""
    conn.execute("""DELETE FROM handle_lookup_event
      WHERE user_id=%s AND kind='new_conversation' AND created_at < now() - interval '24 hours'""", (user_id,))
    recent = conn.execute("""SELECT count(*) AS started, min(created_at) AS oldest FROM handle_lookup_event
      WHERE user_id=%s AND kind='new_conversation'""", (user_id,)).fetchone()
    if recent['started'] >= NEW_CONVERSATIONS_PER_DAY:
        wait = conn.execute("SELECT ceil(extract(epoch FROM %s + interval '24 hours' - now()) / 60) AS wait",
                            (recent['oldest'],)).fetchone()['wait']
        raise HTTPException(429, {'code': 'TOO_MANY_NEW_CONVERSATIONS', 'retry_after_minutes': max(1, int(wait))})
    conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,'new_conversation')", (user_id,))


def open_conversation(conn, user_id: str, other_id: str, how: str) -> UUID:
    """Finds or creates the pair's conversation with both member rows (``pair_conversation``, migration 147), attaches
    the pair's earlier Trades that have none, and returns its id. The caller holds the ``message`` lock (trader route),
    always the ``new_conversation`` advisory lock, then both owner locks: attaching Trades is safe only under them.
    It raises ``RuntimeError`` when ``new_conversation`` is not held, and never takes it. ``how`` is the reach branch
    that allowed contact ('friend', 'conversation' or 'near'). When it creates the row it counts one new conversation
    (429 TOO_MANY_NEW_CONVERSATIONS at the limit), unless ``how`` is 'friend' or the pair has a Trade both confirmed.
    "Creates" is read before ``pair_conversation``, which is exact under both owner locks: every inserter of the
    pair's row holds one of them first, and no conversation row is ever deleted."""
    if not new_conversation_lock_held(conn, user_id):
        raise RuntimeError("open_conversation needs the caller's new_conversation lock")
    if pair_row(conn, user_id, other_id) is None and how != 'friend' and not traded_before(conn, user_id, other_id):
        count_new_conversation(conn, user_id)
    names = {row['user_id']: row['display_name'] for row in conn.execute(
        'SELECT user_id, display_name FROM collector_profile WHERE user_id = ANY(%s)', ([user_id, other_id],))}
    pair = conn.execute('SELECT pair_conversation(%s, %s, %s, %s) AS id',
                        (user_id, other_id, names[user_id], names[other_id])).fetchone()['id']
    conn.execute("""UPDATE trade SET conversation_id = %(c)s WHERE conversation_id IS NULL
      AND ((proposer_id = %(a)s AND recipient_id = %(b)s) OR (proposer_id = %(b)s AND recipient_id = %(a)s))""",
                 {'c': pair, 'a': user_id, 'b': other_id})
    return pair


TOUCH = """UPDATE conversation SET last_from_{side}_at = t.at, last_activity_at = greatest(last_activity_at, t.at),
       changed_at = greatest(changed_at + interval '1 microsecond', t.at)
  FROM (SELECT greatest(clock_timestamp(),
                coalesce(greatest(last_from_low_at, last_from_high_at), '-infinity') + interval '1 microsecond') AS at
        FROM conversation WHERE id = %(id)s) t
  WHERE conversation.id = %(id)s RETURNING t.at"""
TOUCH_LOW = TOUCH.format(side='low')
TOUCH_HIGH = TOUCH.format(side='high')


def write_message(conn, conversation_id: UUID, from_low: bool, key: UUID, body: str):
    """Stores one message and moves its conversation, writing the conversation row once. The row is locked first, so
    the message's time is read after every earlier message of the conversation and is later than all of them: times
    are monotonic and a read marker never skips a message."""
    conn.execute('SELECT 1 FROM conversation WHERE id = %s FOR NO KEY UPDATE', (conversation_id,))
    at = conn.execute(TOUCH_LOW if from_low else TOUCH_HIGH, {'id': conversation_id}).fetchone()['at']
    return conn.execute('INSERT INTO message (id, conversation_id, from_low, client_key, body, created_at) '
                        'VALUES (%s, %s, %s, %s, %s, %s) RETURNING *',
                        (uuid4(), conversation_id, from_low, key, body, at)).fetchone()


def message_of(row, viewer_is_low: bool, at: datetime | None = None) -> Message:
    """The reader's view of a message row; ``at`` when the row names its time otherwise than ``created_at``."""
    return Message(id=row['id'], from_='you' if row['from_low'] == viewer_is_low else 'them', body=row['body'],
                   at=at or row['created_at'])


def stored_message(conn, conversation_id: UUID, from_low: bool, key: UUID):
    return conn.execute('SELECT * FROM message WHERE conversation_id = %s AND from_low = %s AND client_key = %s',
                        (conversation_id, from_low, key)).fetchone()


def member_conversation(conn, user_id: str, conversation_id: UUID):
    """The conversation row with the reader's markers, or 404 CONVERSATION_NOT_FOUND for an unknown id or a reader who
    is not a member."""
    row = conn.execute("""SELECT c.*, m.read_at, m.archived_at FROM conversation c
      JOIN conversation_member m ON m.conversation_id = c.id AND m.member_id = %s WHERE c.id = %s""",
                       (user_id, conversation_id)).fetchone()
    if row is None:
        error(404, 'CONVERSATION_NOT_FOUND')
    return row


def sides_of(row, user_id: str) -> tuple[bool, str | None, str]:
    """(the reader is the low side, the other's account id or None, the name stored for the other)."""
    low = row['user_low'] == user_id
    return low, row['user_high'] if low else row['user_low'], row['high_name'] if low else row['low_name']


TIMELINE = """SELECT * FROM (
  SELECT 'message'::text AS kind, m.created_at AS at, m.id, m.from_low, m.body
    FROM message m WHERE m.conversation_id = %(c)s
  UNION ALL
  SELECT 'trade'::text, t.created_at, t.id, NULL::boolean, NULL::text
    FROM trade t WHERE t.conversation_id = %(c)s) item"""
AFTER = """ WHERE item.at < %(at)s OR (item.at = %(at)s AND (item.kind > %(kind)s
  OR (item.kind = %(kind)s AND item.id < %(id)s)))"""
NEWEST_FIRST = ' ORDER BY item.at DESC, item.kind, item.id DESC LIMIT %(limit)s'


def conversation_view(conn, user_id: str, row, before: str | None) -> ConversationView:
    """The reader's view of an existing conversation: one page of messages and Trade cards, a cursor for the next."""
    cursor = decode_cursor(before, ('message', 'trade')) if before else None
    low, other_id, other_name = sides_of(row, user_id)
    standing = standings(conn, user_id, {0: (other_id, other_name)})[0]
    params = {'c': row['id'], 'limit': PAGE + 1}
    if cursor:
        params |= {'at': cursor[0], 'kind': cursor[1], 'id': cursor[2]}
    found = conn.execute(TIMELINE + (AFTER if cursor else '') + NEWEST_FIRST, params).fetchall()
    page = found[:PAGE]
    trade_ids = [item['id'] for item in page if item['kind'] == 'trade']
    views = {}
    if trade_ids:
        rows = conn.execute(TRADES + ' AND t.id = ANY(%(ids)s)', {'me': user_id, 'ids': trade_ids}).fetchall()
        views = {view.id: view for view in trade_views(conn, user_id, rows)}
    items = [TimelineItem(kind=item['kind'], at=item['at'], cursor=encode_cursor(item['at'], item['kind'], item['id']),
                          message=message_of(item, low, item['at']) if item['kind'] == 'message' else None,
                          trade=views.get(item['id']) if item['kind'] == 'trade' else None)
             for item in page if item['kind'] == 'message' or item['id'] in views]
    return ConversationView(
        id=row['id'], other=standing.party, status=standing.status, can_message=standing.can_message,
        can_propose=standing.can_propose, can_report=standing.can_report, items=items,
        next_before=encode_cursor(page[-1]['at'], page[-1]['kind'], page[-1]['id']) if len(found) > PAGE else None)


def summaries(conn, user_id: str, *, archived: bool | None, before: tuple | None,
              only: UUID | None) -> tuple[list[ConversationSummary], str | None]:
    """The reader's conversations, newest activity first, ``PAGE`` of them. ``archived`` picks the visible ones (False)
    or the archived ones (True); None with ``only`` reads that one whatever its state. ``before``: a decoded list
    cursor. Unread: the other side wrote after the reader's read marker. Archived: the marker is not older than the
    last activity."""
    where = ['m.member_id = %(me)s']
    params = {'me': user_id, 'limit': PAGE + 1}
    if archived is False:
        where.append('(m.archived_at IS NULL OR c.last_activity_at > m.archived_at)')
    elif archived is True:
        where.append('(m.archived_at IS NOT NULL AND c.last_activity_at <= m.archived_at)')
    if only is not None:
        where.append('c.id = %(only)s')
        params['only'] = only
    if before is not None:
        where.append('(c.last_activity_at, c.id) < (%(at)s, %(id)s)')
        params |= {'at': before[0], 'id': before[2]}
    rows = conn.execute(f"""SELECT c.id, c.user_low, c.user_high, c.low_name, c.high_name, c.last_activity_at,
        c.last_from_low_at, c.last_from_high_at, m.read_at, m.archived_at,
        lm.from_low AS last_from_low, lm.body AS last_body, lm.created_at AS last_at
      FROM conversation_member m JOIN conversation c ON c.id = m.conversation_id
      LEFT JOIN LATERAL (SELECT from_low, body, created_at FROM message WHERE conversation_id = c.id
                         ORDER BY created_at DESC, id DESC LIMIT 1) lm ON true
      WHERE {' AND '.join(where)} ORDER BY c.last_activity_at DESC, c.id DESC LIMIT %(limit)s""", params).fetchall()
    page = rows[:PAGE]
    if not page:
        return [], None
    ids = [row['id'] for row in page]
    open_rows = conn.execute(TRADES + " AND t.conversation_id = ANY(%(ids)s) AND t.state <> 'closed'",
                             {'me': user_id, 'ids': ids}).fetchall()
    facts = trade_facts(conn, user_id, open_rows)
    open_count: dict[UUID, int] = {}
    waiting_count: dict[UUID, int] = {}
    for trade in open_rows:
        open_count[trade['conversation_id']] = open_count.get(trade['conversation_id'], 0) + 1
        if waiting_trade_step(user_id, trade, facts[trade['id']]) is not None:
            waiting_count[trade['conversation_id']] = waiting_count.get(trade['conversation_id'], 0) + 1
    standing = standings(conn, user_id, {row['id']: sides_of(row, user_id)[1:] for row in page})
    found = []
    for row in page:
        low = sides_of(row, user_id)[0]
        theirs = row['last_from_high_at'] if low else row['last_from_low_at']
        last = None if row['last_at'] is None else LastMessage(
            from_='you' if row['last_from_low'] == low else 'them', preview=row['last_body'][:PREVIEW],
            at=row['last_at'])
        mine = standing[row['id']]
        found.append(ConversationSummary(
            id=row['id'], other=mine.party, status=mine.status, last_message=last,
            open_trades=open_count.get(row['id'], 0), waiting_on_you=waiting_count.get(row['id'], 0),
            unread=theirs is not None and (row['read_at'] is None or theirs > row['read_at']),
            archived=row['archived_at'] is not None and row['last_activity_at'] <= row['archived_at'],
            last_activity_at=row['last_activity_at']))
    more = encode_cursor(page[-1]['last_activity_at'], 'conversation', page[-1]['id']) if len(rows) > PAGE else None
    return found, more




PULSE_CONVERSATIONS = """SELECT count(*) AS conversations, coalesce(sum(extract(epoch FROM c.changed_at)), 0) AS changed,
       count(*) FILTER (WHERE (m.archived_at IS NULL OR c.last_activity_at > m.archived_at)
         AND (CASE WHEN c.user_low = m.member_id THEN c.last_from_high_at ELSE c.last_from_low_at END)
             > coalesce(m.read_at, '-infinity')) AS unread,
       coalesce(sum(extract(epoch FROM m.read_at)), 0) AS read,
       coalesce(sum(extract(epoch FROM m.archived_at)), 0) AS archived, count(m.archived_at) AS archived_n
  FROM conversation_member m JOIN conversation c ON c.id = m.conversation_id WHERE m.member_id = %s"""
PULSE_UPDATES = """SELECT count(*) AS updates, coalesce(sum(extract(epoch FROM created_at)), 0) AS created,
       coalesce(sum(extract(epoch FROM read_at)), 0) AS seen, coalesce(sum(extract(epoch FROM dismissed_at)), 0) AS dismissed,
       count(dismissed_at) AS dismissed_n FROM inbox_update WHERE recipient_id = %s"""




def trader_profile(conn, trader_id: UUID):
    return conn.execute('SELECT user_id, display_name FROM collector_profile WHERE trader_id = %s',
                        (trader_id,)).fetchone()


def pair_row(conn, user_id: str, other_id: str):
    low, high = sorted((user_id, other_id))
    return conn.execute('SELECT * FROM conversation WHERE user_low = %s AND user_high = %s', (low, high)).fetchone()


PAIR_CHANGED = """UPDATE conversation SET changed_at = greatest(changed_at + interval '1 microsecond', clock_timestamp())
  WHERE user_low = %s AND user_high = %s"""


def pair_changed(conn, user_id: str, other_id: str) -> None:
    rows = conn.execute('SELECT id FROM thread WHERE user_low=%s AND user_high=%s',
                        tuple(sorted((user_id, other_id)))).fetchall()
    touch_threads(conn, [ThreadTouch(id=row['id'], activity=False) for row in rows])


ACCOUNT_CONVERSATIONS = """SELECT id FROM conversation
  WHERE (user_low = %(a)s OR user_high = %(a)s) AND NOT (id = ANY(%(skip)s::uuid[]))
  ORDER BY id FOR NO KEY UPDATE"""
ACCOUNT_CHANGED = """UPDATE conversation
  SET changed_at = greatest(changed_at + interval '1 microsecond', clock_timestamp())
  WHERE id = ANY(%(ids)s::uuid[])"""


def account_changed(conn, user_id: str, skip: list[UUID]) -> None:
    rows = conn.execute("SELECT id FROM thread WHERE (user_low=%s OR user_high=%s) "
                        "AND NOT (id=ANY(%s::uuid[]))", (user_id, user_id, skip)).fetchall()
    touch_threads(conn, [ThreadTouch(id=row['id'], activity=False) for row in rows])






def new_conversation_lock(conn, user_id: str) -> None:
    """The advisory lock every step that may create a conversation takes for its caller (a message to a trader, a Trade
    Proposal), before any row lock; #301 counts new conversations under it."""
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.new_conversation:' || %s))", (user_id,))


def new_conversation_lock_held(conn, user_id: str) -> bool:
    """Whether this session holds the granted advisory lock on ``hashtext('prizecheck.new_conversation:' || user)``,
    read from ``pg_locks``. The key is a sign-extended int4, so ``classid`` is the high half and ``objid`` the low half,
    with ``objsubid`` 1. Takes no lock."""
    return conn.execute("""WITH k AS (SELECT hashtext('prizecheck.new_conversation:' || %s)::bigint AS key)
      SELECT EXISTS (SELECT 1 FROM pg_locks, k
        WHERE pg_locks.locktype = 'advisory' AND pg_locks.pid = pg_backend_pid() AND pg_locks.granted
          AND pg_locks.objsubid = 1 AND pg_locks.mode = 'ExclusiveLock'
          AND pg_locks.classid = ((k.key >> 32) & 4294967295)::oid
          AND pg_locks.objid = (k.key & 4294967295)::oid) AS held""", (user_id,)).fetchone()['held']


def message_locks(conn, user_id: str, both: bool) -> None:
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.message:' || %s))", (user_id,))
    if both:
        new_conversation_lock(conn, user_id)




def refuse_send(conn, user_id: str, standing: Standing, allowed: bool) -> None:
    """The refusals after a replay, in order: the sender is suspended (403 ACCOUNT_SUSPENDED); the conversation is not
    open or ``allowed`` is false (409 COLLECTOR_UNAVAILABLE); the hourly limit (429 MESSAGE_RATE_LIMITED)."""
    require_not_suspended(conn, user_id)
    if standing.status != 'open' or not allowed:
        error(409, 'COLLECTOR_UNAVAILABLE')
    count_message(conn, user_id)






def mark_archived(conversation_id: UUID, user_id: str, archive: bool) -> ConversationSummary:
    with connect() as conn, conn.transaction():
        member_conversation(conn, user_id, conversation_id)
        conn.execute(f"""UPDATE conversation_member SET archived_at = {'clock_timestamp()' if archive else 'NULL'}
          WHERE conversation_id = %s AND member_id = %s""", (conversation_id, user_id))
        return summaries(conn, user_id, archived=None, before=None, only=conversation_id)[0][0]
