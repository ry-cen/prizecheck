"""Conversations and messages (Trading #298, spec "Conversations and messages", resolution "Plumbing" and
"API contract").

**One conversation per pair of collectors** (migration 147): a row in ``conversation`` with a ``conversation_member``
row for each side (the read and archive markers) and the pair's plain-text ``message`` rows. The pair's Trade rounds
are shown in it as cards (``trade.conversation_id``, ``TradeView.conversation_id``). Opening follows the reach rule
(Trading #299, ``discovery.reach_one``): a member of a conversation always reads it, and a message opens the pair's
conversation when none exists and the other collector is in reach (a Friend, or nearby in open discovery); a pair that
already has one keeps using it after Remove Friend. The band shown is the reach rule's, while both are in open
discovery. ``open_conversation`` counts each conversation it creates (kind 'new_conversation', 10 per rolling 24
hours), unless the other is a Friend or the pair has traded before. It checks in ``pg_locks`` that the caller holds
``prizecheck.new_conversation:<user>``, which every step that may create a conversation takes before its owner locks.
Only this module (and the future reports module) names the ``message`` and ``conversation_member`` tables
(``test_social_contract``).

**Routes.** ``GET /api/social/conversations`` (the list, ``archived`` and ``before``), ``GET .../pulse``, ``GET
.../with/{trader_id}`` and ``GET .../{id}`` (a conversation and its newest page of items), ``POST .../{id}/messages``,
``.../read``, ``.../archive`` and ``.../unarchive``, and ``POST /api/social/traders/{trader_id}/messages``, which
sends to the pair's conversation and opens it when there is none. No route deletes a conversation or a message.

**Locks** (spec "Locks"): advisory locks, then the ``inventory_owner`` rows ascending (``owners.lock_owners``), then
``loan``, then ``trade``, then ``conversation``. A message takes ``prizecheck.message:<user>`` (it serialises the
replay check and the hourly count), on the trader route also ``prizecheck.new_conversation:<user>``, then the sender's
owner row (both owners on the trader route, because it may create the row). A message on the conversation route never
touches ``trade``. The trader route, under both owner locks, attaches the pair's unattached Trades
(``open_conversation``) before it locks the conversation row, so the order stays owners, ``trade``, ``conversation``.
A message locks the conversation row ``FOR NO KEY UPDATE`` and writes it **once** (``write_message``), as
``owners.lock_owners`` explains for ``loan``: a second write of a row the transaction already wrote re-checks its
foreign keys late and can close a cycle with the commands that lock owners. The one allowed second write is a
conversation the same transaction just created. A deadlock the database ends anyway answers 503
INVENTORY_TEMPORARILY_UNAVAILABLE, which the client retries with the same key. ``open_conversation`` is the only place
that attaches a pair's earlier Trades, under both owner locks; the BEFORE INSERT trigger on ``trade`` never does.

**Limits.** 120 messages an hour per account under kind 'message' (``count_message``), 429 MESSAGE_RATE_LIMITED with
``retry_after_minutes``. 10 new conversations per rolling 24 hours per account under kind 'new_conversation'
(``count_new_conversation``), 429 TOO_MANY_NEW_CONVERSATIONS with ``retry_after_minutes``. A message is 1 to
``MESSAGE_LENGTH`` code points after ``normalize_text``.

**Refusals**, after the body is normalised (422 EMPTY_MESSAGE, MESSAGE_TOO_LONG), in this order, on both send routes:
404 CONVERSATION_NOT_FOUND (conversation route: unknown or not a member) or 409 COLLECTOR_UNAVAILABLE (trader route:
unknown or own trader id); a replay answers 201 with the stored message (the key is ``(conversation, side, client
key)``); 403 ACCOUNT_SUSPENDED (the sender is suspended); 409 COLLECTOR_UNAVAILABLE (the conversation is not open, or
there is none and the other is not in reach); 429 MESSAGE_RATE_LIMITED; on the trader route, when the message opens
the pair's conversation, 429 TOO_MANY_NEW_CONVERSATIONS.

**Cursors** are unpadded URL-safe base64 of ``<iso time>|<kind>|<id>``: kind 'message' or 'trade' for the timeline
and ``read``, 'conversation' for the list. A malformed one is 422 INVALID_CURSOR. ``read`` takes its boundary from the
stored time of the item the cursor names, never from the cursor's own time.

**Pulse** (``GET .../pulse``): the unread count and a watermark, from two statements over the caller's member rows and
their inbox updates. The watermark is a hash of counts and sums, so a change committed late still moves it; it is
opaque and compared for equality only. It moves on a message, a Trade step, an inbox update, a Block or Unblock
between the pair (``pair_changed``), a suspension of either member or its lift (``account_changed``), and the caller's
own read, archive and unarchive, and not on a rename. It writes nothing.
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
from ..main import connect, verified_user
from .discovery import Band, reach, reach_one, require_not_suspended
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


@router.get('', response_model=ConversationsView)
def list_conversations(archived: bool = False, before: str | None = Query(None, max_length=4000),
                       user_id: str = Depends(verified_user)):
    """The reader's conversations, newest activity first, 50 a page. ``archived=true`` lists the archived ones; an
    archived conversation is visible again once its last activity is newer than the archive time. Writes nothing."""
    cursor = decode_cursor(before, ('conversation',)) if before else None
    with connect() as conn, conn.transaction():
        found, more = summaries(conn, user_id, archived=archived, before=cursor, only=None)
        profile = conn.execute('SELECT suspended_at IS NOT NULL AS suspended FROM collector_profile WHERE user_id = %s',
                               (user_id,)).fetchone()
    return ConversationsView(conversations=found, next_before=more, suspended=bool(profile and profile['suspended']))


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


@router.get('/pulse', response_model=ConversationPulse)
def read_pulse(user_id: str = Depends(verified_user)):
    """How many visible conversations are unread, and the watermark of everything the shell shows: counts and sums
    over the reader's conversations and inbox updates (``Decimal`` sums are hashed as text). It moves on a message, a
    Trade step, an inbox update, a Block or Unblock between the pair (``pair_changed``), a suspension of either member
    or its lift (``account_changed``), and the reader's own read, archive and unarchive, and not on a rename. Writes
    nothing and makes no owner row."""
    with connect() as conn, conn.transaction():
        talk = conn.execute(PULSE_CONVERSATIONS, (user_id,)).fetchone()
        news = conn.execute(PULSE_UPDATES, (user_id,)).fetchone()
    parts = (talk['conversations'], talk['changed'], talk['read'], talk['archived'], talk['archived_n'],
             news['updates'], news['created'], news['seen'], news['dismissed'], news['dismissed_n'])
    watermark = hashlib.sha256(':'.join(str(part) for part in parts).encode()).hexdigest()[:32]
    return ConversationPulse(unread_conversations=talk['unread'], watermark=watermark)


def trader_profile(conn, trader_id: UUID):
    return conn.execute('SELECT user_id, display_name FROM collector_profile WHERE trader_id = %s',
                        (trader_id,)).fetchone()


def pair_row(conn, user_id: str, other_id: str):
    low, high = sorted((user_id, other_id))
    return conn.execute('SELECT * FROM conversation WHERE user_low = %s AND user_high = %s', (low, high)).fetchone()


PAIR_CHANGED = """UPDATE conversation SET changed_at = greatest(changed_at + interval '1 microsecond', clock_timestamp())
  WHERE user_low = %s AND user_high = %s"""


def pair_changed(conn, user_id: str, other_id: str) -> None:
    """Moves the pair's conversation watermark with no new activity. A Block and an Unblock call it
    (``friends.place_block``, ``friends._lift_block``). The caller holds both owners; the row is taken last (owners,
    ``loan``, ``trade``, ``conversation``). A pair with no conversation updates nothing."""
    conn.execute(PAIR_CHANGED, tuple(sorted((user_id, other_id))))


ACCOUNT_CONVERSATIONS = """SELECT id FROM conversation
  WHERE (user_low = %(a)s OR user_high = %(a)s) AND NOT (id = ANY(%(skip)s::uuid[]))
  ORDER BY id FOR NO KEY UPDATE"""
ACCOUNT_CHANGED = """UPDATE conversation
  SET changed_at = greatest(changed_at + interval '1 microsecond', clock_timestamp())
  WHERE id = ANY(%(ids)s::uuid[])"""


def account_changed(conn, user_id: str, skip: list[UUID]) -> None:
    """Moves the watermark of every conversation the account is a member of, except ``skip``, the rows this transaction
    already wrote. Suspension and its lift call it, so a Block can't be told from a suspension on the pulse. The caller
    holds the account's owner row. It is the transaction's first write of each row, so no foreign-key re-check
    key-shares the other members' rows, and the rows are taken in id order (the SELECT locks them, the UPDATE writes
    rows already held). Invariant: every conversation row this transaction already wrote must be in ``skip`` or have
    both its owners locked; any later change to the suspension path that writes a conversation row must keep that
    true."""
    ids = [row['id'] for row in conn.execute(ACCOUNT_CONVERSATIONS, {'a': user_id, 'skip': list(skip)})]
    if ids:
        conn.execute(ACCOUNT_CHANGED, {'ids': ids})


@router.get('/with/{trader_id}', response_model=ConversationView)
def read_with_trader(trader_id: UUID, before: str | None = Query(None, max_length=4000),
                     user_id: str = Depends(verified_user)):
    """The reader's conversation with the collector who has this trader id. A pair with a conversation answers it. A
    collector in reach with none answers an empty one (``id`` null, no items) for the composer. Anyone else, an unknown
    trader id and the reader's own are 404 CONVERSATION_NOT_FOUND. Writes nothing."""
    if before:
        decode_cursor(before, ('message', 'trade'))
    with connect() as conn, conn.transaction():
        other = trader_profile(conn, trader_id)
        if other is None or other['user_id'] == user_id:
            error(404, 'CONVERSATION_NOT_FOUND')
        row = pair_row(conn, user_id, other['user_id'])
        if row is not None:
            return conversation_view(conn, user_id, row, before)
        if reach_one(conn, user_id, other['user_id']) is None:
            error(404, 'CONVERSATION_NOT_FOUND')
        standing = standings(conn, user_id, {0: (other['user_id'], other['display_name'])})[0]
        return ConversationView(
            id=None, other=standing.party, status=standing.status, can_message=standing.can_message,
            can_propose=standing.can_propose, can_report=standing.can_report, items=[], next_before=None)


@router.get('/{conversation_id}', response_model=ConversationView)
def read_conversation(conversation_id: UUID, before: str | None = Query(None, max_length=4000),
                      user_id: str = Depends(verified_user)):
    """One conversation and a page of its items, newest first. 404 CONVERSATION_NOT_FOUND for an unknown id and for a
    reader who is not a member. Writes nothing."""
    if before:
        decode_cursor(before, ('message', 'trade'))
    with connect() as conn, conn.transaction():
        return conversation_view(conn, user_id, member_conversation(conn, user_id, conversation_id), before)


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


@router.post('/{conversation_id}/messages', response_model=Message, status_code=201)
def send_message(conversation_id: UUID, command: SendMessage, user_id: str = Depends(verified_user)):
    """Sends a message to a conversation the reader is a member of. Refusals and order: see the module docstring. A
    replay by ``idempotency_key`` answers the stored message and is not counted."""
    body = normalize_text(command.body)
    try:
        with connect() as conn, conn.transaction():
            ensure_owner(conn, user_id)
            message_locks(conn, user_id, both=False)
            row = member_conversation(conn, user_id, conversation_id)
            lock_owners(conn, user_id)
            low, other_id, other_name = sides_of(row, user_id)
            stored = stored_message(conn, conversation_id, low, command.idempotency_key)
            if stored is not None:
                return message_of(stored, low)
            standing = standings(conn, user_id, {0: (other_id, other_name)})[0]
            refuse_send(conn, user_id, standing, True)
            return message_of(write_message(conn, conversation_id, low, command.idempotency_key, body), low)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


def refuse_send(conn, user_id: str, standing: Standing, allowed: bool) -> None:
    """The refusals after a replay, in order: the sender is suspended (403 ACCOUNT_SUSPENDED); the conversation is not
    open or ``allowed`` is false (409 COLLECTOR_UNAVAILABLE); the hourly limit (429 MESSAGE_RATE_LIMITED)."""
    require_not_suspended(conn, user_id)
    if standing.status != 'open' or not allowed:
        error(409, 'COLLECTOR_UNAVAILABLE')
    count_message(conn, user_id)


@traders_router.post('/{trader_id}/messages', response_model=Message, status_code=201)
def send_trader_message(trader_id: UUID, command: SendMessage, user_id: str = Depends(verified_user)):
    """Sends a message to the collector who has this trader id, in the pair's conversation, which it opens when there
    is none (the other must then be in reach). An unknown trader id, the reader's own, a conversation that is
    not open, and a collector outside reach with no conversation are all 409 COLLECTOR_UNAVAILABLE. After the hourly
    limit (429 MESSAGE_RATE_LIMITED), a message that opens the conversation with a collector who is not a Friend is
    counted: 429 TOO_MANY_NEW_CONVERSATIONS at 10 in 24 hours. Locks both owners."""
    body = normalize_text(command.body)
    try:
        with connect() as conn, conn.transaction():
            ensure_owner(conn, user_id)
            message_locks(conn, user_id, both=True)
            other = trader_profile(conn, trader_id)
            if other is None or other['user_id'] == user_id:
                error(409, 'COLLECTOR_UNAVAILABLE')
            other_id = other['user_id']
            lock_owners(conn, user_id, other_id)
            row = pair_row(conn, user_id, other_id)
            low = sorted((user_id, other_id))[0] == user_id
            if row is not None:
                stored = stored_message(conn, row['id'], low, command.idempotency_key)
                if stored is not None:
                    return message_of(stored, low)
            standing = standings(conn, user_id, {0: (other_id, other['display_name'])})[0]
            found = reach_one(conn, user_id, other_id)
            refuse_send(conn, user_id, standing, row is not None or found is not None)
            # Under both owner locks, also for an existing conversation: it attaches Trades the pair has left out.
            conversation = open_conversation(conn, user_id, other_id, found.how if found else 'conversation')
            return message_of(write_message(conn, conversation, low, command.idempotency_key, body), low)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


@router.post('/{conversation_id}/read', response_model=ConversationSummary)
def read_through(conversation_id: UUID, command: ReadThrough, user_id: str = Depends(verified_user)):
    """Moves the reader's read marker to the time of the item the cursor names, never back. 422 INVALID_CURSOR for a
    malformed cursor, one naming no item of this conversation, or one whose time is not that item's. Writes only the
    reader's own member row."""
    at, kind, item = decode_cursor(command.through, ('message', 'trade'))
    with connect() as conn, conn.transaction():
        member_conversation(conn, user_id, conversation_id)
        table = 'message' if kind == 'message' else 'trade'
        named = conn.execute(f'SELECT created_at FROM {table} WHERE id = %s AND conversation_id = %s',
                             (item, conversation_id)).fetchone()
        if named is None or named['created_at'] != at:
            error(422, 'INVALID_CURSOR')
        conn.execute("""UPDATE conversation_member SET read_at = greatest(coalesce(read_at, '-infinity'), %s)
          WHERE conversation_id = %s AND member_id = %s""", (named['created_at'], conversation_id, user_id))
        return summaries(conn, user_id, archived=None, before=None, only=conversation_id)[0][0]


def mark_archived(conversation_id: UUID, user_id: str, archive: bool) -> ConversationSummary:
    with connect() as conn, conn.transaction():
        member_conversation(conn, user_id, conversation_id)
        conn.execute(f"""UPDATE conversation_member SET archived_at = {'clock_timestamp()' if archive else 'NULL'}
          WHERE conversation_id = %s AND member_id = %s""", (conversation_id, user_id))
        return summaries(conn, user_id, archived=None, before=None, only=conversation_id)[0][0]


@router.post('/{conversation_id}/archive', response_model=ConversationSummary)
def archive_conversation(conversation_id: UUID, user_id: str = Depends(verified_user)):
    """Hides the conversation from the reader's list until it has newer activity. Nobody deletes a conversation."""
    return mark_archived(conversation_id, user_id, True)


@router.post('/{conversation_id}/unarchive', response_model=ConversationSummary)
def unarchive_conversation(conversation_id: UUID, user_id: str = Depends(verified_user)):
    """Shows an archived conversation in the reader's list again."""
    return mark_archived(conversation_id, user_id, False)
