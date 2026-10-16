"""Friends and Friend Requests (social network #247, spec "Friends and finding collectors").

A collector finds another by typing their exact Handle (``POST /api/social/lookup``, case ignored) or by opening their
Invite Link signed in (``GET /api/social/invites/{token}``), and sends a Friend Request to the collector the answer
names. Friendship is one ``friendship`` row per pair (migration 102): 'pending' until the recipient accepts, then
'accepted', which is mutual. Declining, withdrawing and Remove Friend delete the row.

Lookups are limited to ``LOOKUPS_PER_HOUR`` per account, counted in ``handle_lookup_event`` (kind 'lookup'); a
collector's rows older than an hour are pruned when they look up again. Only lookups count: Invite Link reads and
Friend Request commands don't (spec item 18). A lookup is counted whatever it finds, and a miss is answered after the
count commits, so misses can't be used to scan for Handles.

Commands address the other collector by ``collector_id``, the account id a lookup, an Invite Link read or the Friends
list gave; screens never show it. Every command locks both owners in ascending ``user_id`` (``owners.lock_owners``)
before it reads the pair, is idempotent through ``location_command``, and never moves the inventory revision.
``friendship_ended`` runs inside Remove Friend and Block, after both locks and before the row goes: Ending a
friendship with open Loans (#260) cancels the pair's Loans there.

Blocks (#248, migration 103): a Block deletes the pair's friendship row. While it stands, the blocked collector's
lookup of the blocker's Handle, their read of the blocker's Invite Link and their Friend Request to the blocker each
find nobody, through the same statement and the same answer as for a collector who doesn't exist, so a Block can't be
told from an unknown Handle. The blocker sees the collector they blocked, with Unblock. Unblocking is in Settings ›
Privacy (``GET /api/social/blocks``) and on a lookup. When both have blocked each other, each finds nobody.
"""
import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..location_tree import error, replay
from ..main import connect, verified_user
from ..publications import TOKEN
from . import name_rules
from .owners import ensure_owner, lock_owners
from .profile import token_hash

router = APIRouter(prefix='/api/social', tags=['social'])

LOOKUPS_PER_HOUR = 30

# How the signed-in collector stands with another: 'self' is their own account; 'request_sent' and 'request_received'
# are a pending Friend Request from them and to them; 'blocked' is a collector they blocked (#248).
Relation = Literal['self', 'none', 'friends', 'request_sent', 'request_received', 'blocked']


class Collector(BaseModel):
    """Another collector as Friends screens show them: the Display Name and Handle. ``collector_id`` addresses
    commands and is never shown."""
    collector_id: str
    handle: str
    display_name: str


class CollectorLookup(Collector):
    relation: Relation


class FriendsView(BaseModel):
    """The Friends drawer: Friend Requests received (oldest first), Friends (by name) and requests sent (oldest
    first)."""
    received: list[Collector]
    friends: list[Collector]
    sent: list[Collector]


class LookupHandle(BaseModel):
    handle: str = Field(max_length=400)


class SendFriendRequest(BaseModel):
    collector_id: str = Field(min_length=1, max_length=200)
    idempotency_key: UUID


class FriendCommand(BaseModel):
    idempotency_key: UUID


class BlockCollector(BaseModel):
    collector_id: str = Field(min_length=1, max_length=200)
    idempotency_key: UUID


class BlockedList(BaseModel):
    """Settings › Privacy: the collectors the signed-in collector blocked, by name."""
    blocked: list[Collector]


class FriendCommandResult(BaseModel):
    """How the two collectors stand after the command."""
    relation: Relation


# The one read of another collector's profile. Every lookup, Invite Link read and command target goes through it with
# a different key, and a collector it can't see is simply absent: the caller answers a miss the same way whatever the
# reason. A collector who blocked the viewer is one it can't see (#248).
_FIND = """SELECT p.user_id AS collector_id, p.handle, p.display_name, f.state, f.requested_by,
    EXISTS (SELECT 1 FROM block b WHERE b.blocker_id = %(viewer)s AND b.blocked_id = p.user_id) AS blocked
  FROM collector_profile p
  LEFT JOIN friendship f ON (f.user_low = p.user_id AND f.user_high = %(viewer)s)
                         OR (f.user_high = p.user_id AND f.user_low = %(viewer)s)
  WHERE {key}
    AND NOT EXISTS (SELECT 1 FROM block b WHERE b.blocker_id = p.user_id AND b.blocked_id = %(viewer)s)"""
_KEYS = {
    'handle': 'p.handle_key = %(value)s',
    'collector': 'p.user_id = %(value)s',
    'invite': 'p.user_id = (SELECT l.user_id FROM invite_link l WHERE l.token_hash = %(value)s)',
}


def find_collector(conn, viewer: str, by: str, value: str):
    """The collector with this Handle key, account id or Invite Link token hash, with their friendship to the viewer,
    in one statement; None when there is none the viewer may see."""
    return conn.execute(_FIND.format(key=_KEYS[by]), {'viewer': viewer, 'value': value}).fetchone()


def relation(viewer: str, row) -> str:
    if row['collector_id'] == viewer:
        return 'self'
    if row['blocked']:
        return 'blocked'
    if row['state'] == 'accepted':
        return 'friends'
    if row['state'] == 'pending':
        return 'request_sent' if row['requested_by'] == viewer else 'request_received'
    return 'none'


def _lookup_answer(viewer: str, row) -> CollectorLookup:
    return CollectorLookup(collector_id=row['collector_id'], handle=row['handle'], display_name=row['display_name'],
                           relation=relation(viewer, row))


def friend_ids(conn, viewer: str) -> set[str]:
    """The viewer's Friends: accepted friendships with no Block either way (``friends_of``, migration 103)."""
    return {row['friend_id'] for row in conn.execute('SELECT friend_id FROM friends_of(%s)', ([viewer],))}


def friendship_ended(conn, user_id: str, other_id: str) -> None:
    """Runs when a friendship ends (Remove Friend) and on every Block, with both owners locked, before the friendship
    row is deleted, in the same transaction. Ending a friendship with open Loans (#260) cancels the pair's Loans that
    nobody has confirmed a handover for here. Nothing to do until Loans exist."""


@router.get('/friends', response_model=FriendsView)
def friends(user_id: str = Depends(verified_user)):
    with connect() as conn:
        rows = conn.execute("""SELECT p.user_id AS collector_id, p.handle, p.handle_key, p.display_name, f.state,
            f.requested_by, f.created_at
          FROM friendship f
          JOIN collector_profile p ON p.user_id = CASE WHEN f.user_low = %(viewer)s THEN f.user_high ELSE f.user_low END
          WHERE f.user_low = %(viewer)s OR f.user_high = %(viewer)s""", {'viewer': user_id}).fetchall()

    def person(row):
        return Collector(collector_id=row['collector_id'], handle=row['handle'], display_name=row['display_name'])

    def oldest(row):
        return row['created_at'], row['handle_key']

    pending = [row for row in rows if row['state'] == 'pending']
    return FriendsView(
        received=[person(row) for row in sorted((r for r in pending if r['requested_by'] != user_id), key=oldest)],
        friends=[person(row) for row in sorted((r for r in rows if r['state'] == 'accepted'),
                                               key=lambda r: (r['display_name'].casefold(), r['handle_key']))],
        sent=[person(row) for row in sorted((r for r in pending if r['requested_by'] == user_id), key=oldest)])


@router.post('/lookup', response_model=CollectorLookup)
def lookup(body: LookupHandle, user_id: str = Depends(verified_user)):
    """Find a collector by their exact Handle, ignoring case. A Handle that can't exist is 422 INVALID_HANDLE and isn't
    counted. Past the hourly limit it is 429 TOO_MANY_LOOKUPS with ``retry_after_minutes``, and isn't counted. Otherwise
    the lookup is counted and answers the collector, or 404 COLLECTOR_NOT_FOUND, raised after the count commits."""
    handle = body.handle.strip()
    if not name_rules.HANDLE.fullmatch(handle):
        error(422, 'INVALID_HANDLE')
    with connect() as conn, conn.transaction():
        ensure_owner(conn, user_id)
        # One collector's lookups one at a time, so concurrent ones can't pass the limit together.
        conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.lookup:' || %s))", (user_id,))
        conn.execute("""DELETE FROM handle_lookup_event
          WHERE user_id=%s AND kind='lookup' AND created_at < now() - interval '1 hour'""", (user_id,))
        recent = conn.execute("""SELECT count(*) AS lookups, min(created_at) AS oldest FROM handle_lookup_event
          WHERE user_id=%s AND kind='lookup'""", (user_id,)).fetchone()
        if recent['lookups'] >= LOOKUPS_PER_HOUR:
            wait = conn.execute("SELECT ceil(extract(epoch FROM %s + interval '1 hour' - now()) / 60) AS wait",
                                (recent['oldest'],)).fetchone()['wait']
            raise HTTPException(429, {'code': 'TOO_MANY_LOOKUPS', 'retry_after_minutes': max(1, int(wait))})
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,'lookup')", (user_id,))
        row = find_collector(conn, user_id, 'handle', handle.lower())
    if row is None:  # after the commit, so the lookup stays counted
        error(404, 'COLLECTOR_NOT_FOUND')
    return _lookup_answer(user_id, row)


@router.get('/invites/{token}', response_model=CollectorLookup)
def invite(token: str, user_id: str = Depends(verified_user)):
    """The Invite Link page signed in: who the link belongs to and how the two stand. An unknown or replaced link is 404
    INVITE_NOT_FOUND. Not counted as a lookup."""
    if not TOKEN.fullmatch(token):
        error(404, 'INVITE_NOT_FOUND')
    with connect() as conn:
        row = find_collector(conn, user_id, 'invite', token_hash(token))
    if row is None:
        error(404, 'INVITE_NOT_FOUND')
    return _lookup_answer(user_id, row)


def _command(user_id: str, other: str, key: UUID, action: str, apply, *,
             blocked_you_ok: bool = False) -> FriendCommandResult:
    """Runs one Friend command: both owners locked, replayed by its idempotency key, the other collector checked, then
    ``apply(conn, row)`` with the pair's row from ``find_collector``, which returns the new relation. A collector who
    blocked the caller is 404 COLLECTOR_NOT_FOUND, as an unknown one is, unless ``blocked_you_ok``: then they count as
    a collector the caller has no friendship with, so the answer is the one an unfriend would give."""
    if other == user_id:
        error(409, 'OWN_ACCOUNT')
    payload = {'action': action, 'collector_id': other}
    with connect() as conn, conn.transaction():
        ensure_owner(conn, user_id)
        lock_owners(conn, user_id, other)
        digest, stored = replay(conn, user_id, key, payload)
        if stored is None:
            row = find_collector(conn, user_id, 'collector', other)
            if row is None and blocked_you_ok and conn.execute(
                    'SELECT 1 FROM collector_profile WHERE user_id=%s', (other,)).fetchone():
                row = {'collector_id': other, 'state': None, 'requested_by': None, 'blocked': False}
            if row is None:
                error(404, 'COLLECTOR_NOT_FOUND')
            stored = FriendCommandResult(relation=apply(conn, row)).model_dump(mode='json')
            conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                         (user_id, key, digest, json.dumps(stored)))
    return stored


def _pair(a: str, b: str) -> tuple[str, str]:
    low, high = sorted((a, b))
    return low, high


@router.post('/friend-requests', response_model=FriendCommandResult)
def send_friend_request(command: SendFriendRequest, user_id: str = Depends(verified_user)):
    """Send a Friend Request. When the two are already Friends, a request is pending either way or the caller blocked
    the other collector, nothing changes and the answer says so. A collector who blocked the caller is 404
    COLLECTOR_NOT_FOUND, as an unknown one is."""
    other = command.collector_id

    def apply(conn, row):
        current = relation(user_id, row)
        if current == 'none':
            low, high = _pair(user_id, other)
            conn.execute("INSERT INTO friendship(user_low,user_high,state,requested_by) VALUES (%s,%s,'pending',%s)",
                         (low, high, user_id))
            return 'request_sent'
        return current
    return _command(user_id, other, command.idempotency_key, 'send_friend_request', apply)


@router.post('/friend-requests/{collector_id}/accept', response_model=FriendCommandResult)
def accept_friend_request(collector_id: str, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Accept a Friend Request from this collector: the two become Friends. Without one, nothing changes."""
    def apply(conn, row):
        if relation(user_id, row) != 'request_received':
            return relation(user_id, row)
        conn.execute("UPDATE friendship SET state='accepted' WHERE user_low=%s AND user_high=%s",
                     _pair(user_id, collector_id))
        return 'friends'
    return _command(user_id, collector_id, command.idempotency_key, 'accept_friend_request', apply, blocked_you_ok=True)


def _delete_pending(user_id: str, collector_id: str, key: UUID, action: str, expected: str) -> FriendCommandResult:
    def apply(conn, row):
        if relation(user_id, row) != expected:
            return relation(user_id, row)
        conn.execute("DELETE FROM friendship WHERE user_low=%s AND user_high=%s AND state='pending'",
                     _pair(user_id, collector_id))
        return 'none'
    return _command(user_id, collector_id, key, action, apply, blocked_you_ok=True)


@router.post('/friend-requests/{collector_id}/decline', response_model=FriendCommandResult)
def decline_friend_request(collector_id: str, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Decline a Friend Request from this collector: it is deleted, and the sender isn't told."""
    return _delete_pending(user_id, collector_id, command.idempotency_key, 'decline_friend_request', 'request_received')


@router.post('/friend-requests/{collector_id}/withdraw', response_model=FriendCommandResult)
def withdraw_friend_request(collector_id: str, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Withdraw a Friend Request sent to this collector: it is deleted."""
    return _delete_pending(user_id, collector_id, command.idempotency_key, 'withdraw_friend_request', 'request_sent')


@router.post('/friends/{collector_id}/remove', response_model=FriendCommandResult)
def remove_friend(collector_id: str, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Remove Friend: the friendship ends for both. Without one, nothing changes."""
    def apply(conn, row):
        if relation(user_id, row) != 'friends':
            return relation(user_id, row)
        friendship_ended(conn, user_id, collector_id)
        conn.execute('DELETE FROM friendship WHERE user_low=%s AND user_high=%s', _pair(user_id, collector_id))
        return 'none'
    return _command(user_id, collector_id, command.idempotency_key, 'remove_friend', apply, blocked_you_ok=True)


@router.get('/blocks', response_model=BlockedList)
def blocks(user_id: str = Depends(verified_user)):
    with connect() as conn:
        rows = conn.execute("""SELECT p.user_id AS collector_id, p.handle, p.handle_key, p.display_name
          FROM block b JOIN collector_profile p ON p.user_id = b.blocked_id WHERE b.blocker_id=%s""",
                            (user_id,)).fetchall()
    rows.sort(key=lambda r: (r['display_name'].casefold(), r['handle_key']))
    return BlockedList(blocked=[Collector(collector_id=r['collector_id'], handle=r['handle'],
                                          display_name=r['display_name']) for r in rows])


@router.post('/blocks', response_model=FriendCommandResult)
def block(command: BlockCollector, user_id: str = Depends(verified_user)):
    """Block a collector: any friendship or Friend Request between the two ends, and the blocked collector isn't told.
    Allowed whether or not they blocked the caller."""
    other = command.collector_id

    def apply(conn, row):
        friendship_ended(conn, user_id, other)
        conn.execute('DELETE FROM friendship WHERE user_low=%s AND user_high=%s', _pair(user_id, other))
        conn.execute('INSERT INTO block(blocker_id,blocked_id) VALUES (%s,%s) ON CONFLICT DO NOTHING', (user_id, other))
        return 'blocked'
    return _command(user_id, other, command.idempotency_key, 'block', apply, blocked_you_ok=True)


@router.post('/blocks/{collector_id}/unblock', response_model=FriendCommandResult)
def unblock(collector_id: str, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Unblock a collector the caller blocked. Nothing else comes back: they are not Friends again."""
    def apply(conn, row):
        conn.execute('DELETE FROM block WHERE blocker_id=%s AND blocked_id=%s', (user_id, collector_id))
        after = find_collector(conn, user_id, 'collector', collector_id)
        return 'none' if after is None else relation(user_id, after)
    return _command(user_id, collector_id, command.idempotency_key, 'unblock', apply, blocked_you_ok=True)
