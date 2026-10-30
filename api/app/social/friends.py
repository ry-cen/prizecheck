"""Friends and Friend Requests (social network #247, spec "Friends and finding collectors").

A collector finds another by typing their exact Handle (``POST /api/social/lookup``, case ignored) or by opening their
Invite Link signed in (``GET /api/social/invites/{token}``), and sends a Friend Request to the collector the answer
names. Friendship is one ``friendship`` row per pair (migration 102): 'pending' until the recipient accepts, then
'accepted', which is mutual. Declining, withdrawing and Remove Friend delete the row.

Lookups are limited to ``LOOKUPS_PER_HOUR`` per account, counted in ``handle_lookup_event`` (kind 'lookup'); a
collector's rows older than an hour are pruned when they look up again. Lookups are the only searches that count:
Invite Link reads don't (spec item 18). A lookup is counted whatever it finds, and a miss is answered after the count
commits, so misses can't be used to scan for Handles.

Friend commands are limited too, to ``COMMANDS_PER_HOUR`` per account, counted under kind 'friend_command' (a command
replayed by its idempotency key isn't counted again). The count is taken before any owner is locked, so a collector
over the limit never locks another's row, and it commits with a miss's 404 as lookups do. Over the limit is 429
TOO_MANY_CHANGES with ``retry_after_minutes``. A collector whose Friend Request was declined can't send that collector
another for ``DECLINE_COOL_OFF_DAYS`` days (409 TRY_LATER; the collector sees "You can send another request later.");
the decline is kept in ``friend_request_declined`` until then, until the decliner sends the sender a request, or until
the decliner Unblocks the sender (only a Block actually lifted clears it; the sender's own Unblock of the decliner, or
an Unblock with no Block, leaves it). While the decliner's Block stands, the sender's send is 404, as for an unknown id.

Commands address the other collector by ``collector_id``, the account id a lookup, an Invite Link read or the Friends
list gave; screens never show it. Every command locks both owners in ascending ``user_id`` (``owners.lock_owners``)
before it reads the pair and is idempotent through ``location_command``; only Loans and Trades it cancels move a
revision. ``friendship_ended`` runs inside Remove Friend and Block, after both locks and before the row goes: Ending a
friendship with open Loans (#260) cancels the pair's Loans nobody has confirmed a handover for there, which moves each
of those lenders' revisions, and then (Trading #274) the pair's Trade Proposals and Trades nobody has confirmed the
swap for, which moves the revision of each side whose copies they reserved. A suspended collector's Friend Request is
403 ACCOUNT_SUSPENDED (Trading #303).

Blocks (#248, migration 103): a Block deletes the pair's friendship row. While it stands, the blocked collector's
lookup of the blocker's Handle, their read of the blocker's Invite Link and their Friend Request to the blocker each
find nobody, through the same statement and the same answer as for a collector who doesn't exist, so a Block can't be
told from an unknown Handle. The blocker sees the collector they blocked, with Unblock. Unblocking is in Settings ›
Privacy (``GET /api/social/blocks``) and on a lookup. When both have blocked each other, each finds nobody.

Block for strangers (Trading #302): every Block row has a ``block_id``, a ``via`` (``collector`` from the user-id
route, ``trader`` from the trader routes and Report) and a ``handle_shown`` (whether the blocker already knew the
Handle: Friends before the Block, or, on the user-id route, also a request they received, or one they sent that was
not made from a Trade). A trader Block shows the Handle only for former Friends, since a request is tied to a Handle only the other kind of route may know.
The Blocked list shows the Handle only when it was shown and the trader id only for a trader Block. The trader unblock
route lifts only a trader Block; the user-id one lifts a user-id Block and a trader Block of a former Friend (the
blocker already sees that Handle), and otherwise both answer as if no Block stood, so neither ties a user id to a
trader id. The ``block_id`` route lifts either kind. A Block or Unblock moves the pair's
conversation watermark.
"""
import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..location_tree import error, replay
from ..db import connect
from ..identity import verified_user
from ..core.publications.publish import TOKEN
from . import name_rules
from .conversations import pair_changed
from .discovery import reach_one, require_not_suspended, trader_user
from .loans import end_loans_between
from .owners import ensure_owner, lock_owners
from .profile import token_hash
from .trades import TRADES, end_trades_between

router = APIRouter(prefix='/api/social', tags=['social'])

LOOKUPS_PER_HOUR = 30
COMMANDS_PER_HOUR = 120
DECLINE_COOL_OFF_DAYS = 7

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


class InviteCollector(BaseModel):
    """Whose Invite Link it is: the Display Name only (the link page never shows a Handle), and how the two stand."""
    collector_id: str
    display_name: str
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


class BlockedCollector(BaseModel):
    """One Block in Settings › Privacy: ``block_id`` addresses Unblock. ``handle`` is set only when the blocker already
    knew it (``block.handle_shown``), ``trader_id`` only for a Block made by trader id. No user id."""
    block_id: UUID
    display_name: str
    handle: str | None
    trader_id: UUID | None


class BlockedList(BaseModel):
    """Settings › Privacy: the signed-in collector's Blocks, by name; no user id."""
    blocked: list[BlockedCollector]


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
    row is deleted, in the same transaction: the pair's Loans nobody has confirmed a handover for are cancelled
    (``loans.end_loans_between``, #260), then their Trade Proposals and Trades nobody has confirmed the swap for
    (``trades.end_trades_between``, Trading #274). Loans first, then Trades: the lock order is owners, then ``loan``
    rows, then ``trade`` rows."""
    end_loans_between(conn, user_id, other_id)
    end_trades_between(conn, user_id, other_id)


@router.get('/friends', response_model=FriendsView)
def friends(user_id: str = Depends(verified_user)):
    with connect() as conn:
        rows = conn.execute("""SELECT p.user_id AS collector_id, p.handle, p.handle_key, p.display_name, f.state,
            f.requested_by, f.created_at, f.via_trade
          FROM friendship f
          JOIN collector_profile p ON p.user_id = CASE WHEN f.user_low = %(viewer)s THEN f.user_high ELSE f.user_low END
          WHERE f.user_low = %(viewer)s OR f.user_high = %(viewer)s""", {'viewer': user_id}).fetchall()

    def person(row):
        return Collector(collector_id=row['collector_id'], handle=row['handle'], display_name=row['display_name'])

    def oldest(row):
        return row['created_at'], row['handle_key']

    pending = [row for row in rows if row['state'] == 'pending']
    # An Add-as-Friend request (via_trade, trading #304) is followed on its Trade, never in the sender's list: listing it would show its recipient's Handle and user id before they accept.
    return FriendsView(
        received=[person(row) for row in sorted((r for r in pending if r['requested_by'] != user_id), key=oldest)],
        friends=[person(row) for row in sorted((r for r in rows if r['state'] == 'accepted'),
                                               key=lambda r: (r['display_name'].casefold(), r['handle_key']))],
        sent=[person(row) for row in sorted((r for r in pending if r['requested_by'] == user_id and not r['via_trade']), key=oldest)])


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


@router.get('/invites/{token}', response_model=InviteCollector)
def invite(token: str, user_id: str = Depends(verified_user)):
    """The Invite Link page signed in: who the link belongs to and how the two stand. An unknown or replaced link is 404
    INVITE_NOT_FOUND. Not counted as a lookup."""
    if not TOKEN.fullmatch(token):
        error(404, 'INVITE_NOT_FOUND')
    with connect() as conn:
        row = find_collector(conn, user_id, 'invite', token_hash(token))
    if row is None:
        error(404, 'INVITE_NOT_FOUND')
    return InviteCollector(collector_id=row['collector_id'], display_name=row['display_name'],
                           relation=relation(user_id, row))


class Refusal:
    """What ``apply`` returns for a command it refuses with this status and code: the command stays counted, the
    answer goes out after the commit (as a missing collector's does), and nothing else changes."""

    def __init__(self, status: int, code: str):
        self.status, self.code = status, code


def _count_command(conn, user_id: str) -> None:
    """Counts one Friend command against the hourly limit, before any owner is locked: rows older than an hour
    pruned, and 429 TOO_MANY_CHANGES at the limit. The caller holds the collector's command lock and has already
    answered a replay of a recorded key, which isn't counted."""
    conn.execute("""DELETE FROM handle_lookup_event
      WHERE user_id=%s AND kind='friend_command' AND created_at < now() - interval '1 hour'""", (user_id,))
    recent = conn.execute("""SELECT count(*) AS commands, min(created_at) AS oldest FROM handle_lookup_event
      WHERE user_id=%s AND kind='friend_command'""", (user_id,)).fetchone()
    if recent['commands'] >= COMMANDS_PER_HOUR:
        wait = conn.execute("SELECT ceil(extract(epoch FROM %s + interval '1 hour' - now()) / 60) AS wait",
                            (recent['oldest'],)).fetchone()['wait']
        raise HTTPException(429, {'code': 'TOO_MANY_CHANGES', 'retry_after_minutes': max(1, int(wait))})
    conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,'friend_command')", (user_id,))


def command_payload(action: str, other: str, extra: dict | None = None) -> dict:
    """The replay payload of a Friend command: its action and collector, plus the command's own fields."""
    return {'action': action, 'collector_id': other, **(extra or {})}


def _command(user_id: str, other: str, key: UUID, action: str, apply, *,
             blocked_you_ok: bool = False, extra: dict | None = None, answer=None) -> dict:
    """Runs one Friend command: replayed by its idempotency key, else counted against the hourly limit, both owners
    locked, the other collector checked, then ``apply(conn, row)`` with the pair's row from ``find_collector``, which
    returns the new relation (or a ``Refusal``). A collector who blocked the caller is 404 COLLECTOR_NOT_FOUND, as an
    unknown one is, unless ``blocked_you_ok``: then they count as a collector the caller has no friendship with, so the
    answer is the one an unfriend would give. ``extra`` joins the replay payload; ``answer(outcome)`` builds the stored
    answer (default ``FriendCommandResult(relation=outcome)``)."""
    if other == user_id:
        error(409, 'OWN_ACCOUNT')
    payload = command_payload(action, other, extra)
    missing, refusal = False, None
    with connect() as conn, conn.transaction():
        ensure_owner(conn, user_id)
        # One collector's commands one at a time. A replay is answered from the caller's own record, before anything
        # is counted or any owner locked; a new command is counted, then both owners are locked.
        conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.friend_command:' || %s))", (user_id,))
        digest, stored = replay(conn, user_id, key, payload)
        if stored is None:
            _count_command(conn, user_id)
            lock_owners(conn, user_id, other)
            row = find_collector(conn, user_id, 'collector', other)
            if row is None and blocked_you_ok and conn.execute(
                    'SELECT 1 FROM collector_profile WHERE user_id=%s', (other,)).fetchone():
                row = {'collector_id': other, 'state': None, 'requested_by': None, 'blocked': False}
            if row is None:
                missing = True  # answered after the commit, so the command stays counted
            elif isinstance(outcome := apply(conn, row), Refusal):
                refusal = outcome
            else:
                result = answer(outcome) if answer is not None else FriendCommandResult(relation=outcome)
                stored = result.model_dump(mode='json')
                conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) '
                             'VALUES (%s,%s,%s,%s)', (user_id, key, digest, json.dumps(stored)))
    if missing:
        error(404, 'COLLECTOR_NOT_FOUND')
    if refusal:
        error(refusal.status, refusal.code)
    return stored


def _pair(a: str, b: str) -> tuple[str, str]:
    low, high = sorted((a, b))
    return low, high


@router.post('/friend-requests', response_model=FriendCommandResult)
def send_friend_request(command: SendFriendRequest, user_id: str = Depends(verified_user)):
    """Send a Friend Request. Within a week of the other collector declining one, it is 409 TRY_LATER. When the two
    are already Friends, a request is pending either way or the caller blocked the other collector, nothing changes and
    the answer says so. A collector who blocked the caller is 404 COLLECTOR_NOT_FOUND, as an unknown one is. A suspended
    sender is 403 ACCOUNT_SUSPENDED (after both owner locks, not counted)."""
    other = command.collector_id

    def apply(conn, row):
        require_not_suspended(conn, user_id)
        current = relation(user_id, row)
        if current == 'none':
            if conn.execute("""SELECT 1 FROM friend_request_declined WHERE sender_id=%s AND recipient_id=%s
                  AND declined_at > now() - make_interval(days => %s)""",
                            (user_id, other, DECLINE_COOL_OFF_DAYS)).fetchone():
                return Refusal(409, 'TRY_LATER')
            # Their earlier decline of the other collector's request, and this collector's own expired one, are over.
            conn.execute("""DELETE FROM friend_request_declined
              WHERE (sender_id=%s AND recipient_id=%s) OR (sender_id=%s AND recipient_id=%s)""",
                         (other, user_id, user_id, other))
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


def _delete_pending(user_id: str, collector_id: str, key: UUID, action: str, expected: str,
                    declining: bool = False) -> FriendCommandResult:
    def apply(conn, row):
        if relation(user_id, row) != expected:
            return relation(user_id, row)
        if declining:  # the sender can't ask this collector again for a week
            conn.execute("""INSERT INTO friend_request_declined(sender_id,recipient_id) VALUES (%s,%s)
              ON CONFLICT (sender_id,recipient_id) DO UPDATE SET declined_at=now()""", (collector_id, user_id))
        conn.execute("DELETE FROM friendship WHERE user_low=%s AND user_high=%s AND state='pending'",
                     _pair(user_id, collector_id))
        return 'none'
    return _command(user_id, collector_id, key, action, apply, blocked_you_ok=True)


@router.post('/friend-requests/{collector_id}/decline', response_model=FriendCommandResult)
def decline_friend_request(collector_id: str, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Decline a Friend Request from this collector: it is deleted, and the sender isn't told. The sender can't send
    another for a week."""
    return _delete_pending(user_id, collector_id, command.idempotency_key, 'decline_friend_request', 'request_received',
                           declining=True)


@router.post('/friend-requests/{collector_id}/withdraw', response_model=FriendCommandResult)
def withdraw_friend_request(collector_id: str, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Withdraw a Friend Request sent to this collector: it is deleted."""
    return _delete_pending(user_id, collector_id, command.idempotency_key, 'withdraw_friend_request', 'request_sent')


# Add as Friend (trading #304). These routes address the other collector only through a Trade both sides confirmed, by
# the Trade's id: the other's user id is read on the server and never leaves it. The requester follows the request
# through TraderView.add_friend (``add_friend_state``), not GET /friends. The checks made before the Friend command are
# repeated under its owner locks, so a Block that lands in between wins.
SWAPPED_PAIR = """SELECT EXISTS (
    SELECT 1 FROM trade WHERE proposer_id = %(me)s AND recipient_id = %(other)s
      AND proposer_swap_at IS NOT NULL AND recipient_swap_at IS NOT NULL
    UNION ALL
    SELECT 1 FROM trade WHERE proposer_id = %(other)s AND recipient_id = %(me)s
      AND proposer_swap_at IS NOT NULL AND recipient_swap_at IS NOT NULL) AS swapped"""


def add_friend_state(conn, viewer: str, other: str | None) -> Literal['offer', 'sent', 'received'] | None:
    """What the viewer can do about Add as Friend with this collector. Reads only; takes no lock. In order: None
    unless ``other`` is a collector in the viewer's reach (a Block either way, a suspension and a deletion all end
    it); None unless the two have a Trade both confirmed; then by the friendship row: none is 'offer', accepted is
    None, pending is 'sent' when the viewer sent it through a Trade (a Withdraw deletes only those), None when the viewer
    sent it by Handle (the control would do nothing), and 'received' when the other sent it (Accept works for both)."""
    if other is None or other == viewer or reach_one(conn, viewer, other) is None:
        return None
    if not conn.execute(SWAPPED_PAIR, {'me': viewer, 'other': other}).fetchone()['swapped']:
        return None
    row = conn.execute('SELECT state, requested_by, via_trade FROM friendship WHERE user_low=%s AND user_high=%s',
                       _pair(viewer, other)).fetchone()
    if row is None:
        return 'offer'
    if row['state'] == 'accepted':
        return None
    if row['requested_by'] != viewer:
        return 'received'
    return 'sent' if row['via_trade'] else None


def _other_in_reach(conn, user_id: str, other: str | None, *, adding: bool) -> bool:
    """Whether ``other`` is in the caller's reach. A suspended caller has none (trade_reach gives a suspended viewer no
    rows), yet may still withdraw, so for a withdraw the other side alone is judged: a collector who exists, is not
    suspended and has no Block either way with the caller."""
    if other is None:
        return False
    if reach_one(conn, user_id, other) is not None:
        return True
    if adding:
        return False
    return conn.execute("""SELECT EXISTS (SELECT 1 FROM collector_profile me WHERE me.user_id = %(me)s
          AND me.suspended_at IS NOT NULL)
        AND EXISTS (SELECT 1 FROM collector_profile o WHERE o.user_id = %(other)s AND o.suspended_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM block b WHERE (b.blocker_id = %(me)s AND b.blocked_id = %(other)s)
          OR (b.blocker_id = %(other)s AND b.blocked_id = %(me)s)) AS reachable""",
                        {'me': user_id, 'other': other}).fetchone()['reachable']


def _trade_partner(user_id: str, trade_id: UUID, *, adding: bool) -> str:
    """The other side of this Trade, for the caller. The checks before the Friend command, in order: 403
    ACCOUNT_SUSPENDED for a suspended caller (adding only: a suspended requester can still withdraw); 404
    TRADE_NOT_FOUND for an unknown Trade or one the caller is not a side of; 409 TRADE_NOT_SWAPPED unless both sides
    confirmed the swap; 409 COLLECTOR_UNAVAILABLE unless the other is in reach (a deleted account included). Adding and
    withdrawing run the same checks, so a withdraw cannot link a Handle request to a stranger. Takes no lock; none of
    these refusals is counted."""
    with connect() as conn:
        if adding:
            require_not_suspended(conn, user_id)
        row = conn.execute(TRADES + ' AND t.id = %(id)s', {'me': user_id, 'id': trade_id}).fetchone()
        if row is None:
            error(404, 'TRADE_NOT_FOUND')
        other = row['recipient_id'] if row['proposer_id'] == user_id else row['proposer_id']
        if row['proposer_swap_at'] is None or row['recipient_swap_at'] is None:
            error(409, 'TRADE_NOT_SWAPPED')
        if not _other_in_reach(conn, user_id, other, adding=adding):
            error(409, 'COLLECTOR_UNAVAILABLE')
    return other


@router.post('/trades/{trade_id}/add-friend', response_model=FriendCommandResult)
def add_friend_from_trade(trade_id: UUID, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Offer to become Friends with the other side of a Trade both sides confirmed. Refused in order: 403
    ACCOUNT_SUSPENDED, 404 TRADE_NOT_FOUND, 409 TRADE_NOT_SWAPPED, 409 COLLECTOR_UNAVAILABLE (a deleted, blocked or
    suspended other, all the same body). Then under both owner locks: the other's pending request is accepted
    ('friends'); with no friendship a pending request is sent ('request_sent', 409 TRY_LATER within the decline
    cool-off); in any other state nothing changes and the relation is answered."""
    other = _trade_partner(user_id, trade_id, adding=True)

    def apply(conn, row):
        if reach_one(conn, user_id, other) is None:
            return Refusal(409, 'COLLECTOR_UNAVAILABLE')
        current = relation(user_id, row)
        if current == 'request_received':
            conn.execute("UPDATE friendship SET state='accepted' WHERE user_low=%s AND user_high=%s AND state='pending'",
                         _pair(user_id, other))
            return 'friends'
        if current == 'none':
            if conn.execute("""SELECT 1 FROM friend_request_declined WHERE sender_id=%s AND recipient_id=%s
                  AND declined_at > now() - make_interval(days => %s)""",
                            (user_id, other, DECLINE_COOL_OFF_DAYS)).fetchone():
                return Refusal(409, 'TRY_LATER')
            conn.execute("""DELETE FROM friend_request_declined
              WHERE (sender_id=%s AND recipient_id=%s) OR (sender_id=%s AND recipient_id=%s)""",
                         (other, user_id, user_id, other))
            low, high = _pair(user_id, other)
            conn.execute("""INSERT INTO friendship(user_low,user_high,state,requested_by,via_trade)
              VALUES (%s,%s,'pending',%s,true)""", (low, high, user_id))
            return 'request_sent'
        return current
    return _command(user_id, other, command.idempotency_key, 'add_friend', apply, blocked_you_ok=True)


@router.post('/trades/{trade_id}/add-friend/withdraw', response_model=FriendCommandResult)
def withdraw_add_friend(trade_id: UUID, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Withdraw the Add as Friend request the caller sent to the other side of this Trade. Refused like adding, except
    for suspension: 404 TRADE_NOT_FOUND, 409 TRADE_NOT_SWAPPED, 409 COLLECTOR_UNAVAILABLE. Under the owner locks only
    the caller's own pending request that came from a Trade (via_trade) is deleted; a Handle request or any other
    state is left as it is, and the current relation is answered."""
    other = _trade_partner(user_id, trade_id, adding=False)

    def apply(conn, row):
        if not _other_in_reach(conn, user_id, other, adding=False):
            return Refusal(409, 'COLLECTOR_UNAVAILABLE')
        current = relation(user_id, row)
        if current != 'request_sent':
            return current
        if not conn.execute('SELECT via_trade FROM friendship WHERE user_low=%s AND user_high=%s',
                            _pair(user_id, other)).fetchone()['via_trade']:
            return current
        conn.execute("DELETE FROM friendship WHERE user_low=%s AND user_high=%s AND state='pending'",
                     _pair(user_id, other))
        return 'none'
    return _command(user_id, other, command.idempotency_key, 'withdraw_add_friend', apply, blocked_you_ok=True)


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
        rows = conn.execute("""SELECT b.id AS block_id, b.via, b.handle_shown, p.handle, p.display_name, p.trader_id
          FROM block b JOIN collector_profile p ON p.user_id = b.blocked_id WHERE b.blocker_id = %s""",
                            (user_id,)).fetchall()
    rows.sort(key=lambda r: (r['display_name'].casefold(), str(r['block_id'])))
    return BlockedList(blocked=[BlockedCollector(
        block_id=r['block_id'], display_name=r['display_name'], handle=r['handle'] if r['handle_shown'] else None,
        trader_id=r['trader_id'] if r['via'] == 'trader' else None) for r in rows])


@router.post('/blocks', response_model=FriendCommandResult)
def block(command: BlockCollector, user_id: str = Depends(verified_user)):
    """Block a collector: any friendship or Friend Request between the two ends, and the blocked collector isn't told.
    Allowed whether or not they blocked the caller."""
    other = command.collector_id

    def apply(conn, row):
        place_block(conn, user_id, other, 'collector')
        return 'blocked'
    return _command(user_id, other, command.idempotency_key, 'block', apply, blocked_you_ok=True)


@router.post('/blocks/{collector_id}/unblock', response_model=FriendCommandResult)
def unblock(collector_id: str, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Unblock a collector the caller blocked. Nothing else comes back: they are not Friends again. It lifts a Block
    made by user id and a trader Block of a former Friend (their Handle is already on the Blocked row); asked about
    any other trader Block it changes nothing and answers as if there were none."""
    def apply(conn, row):
        _lift_block(conn, user_id, collector_id, via='collector', former_friend=True)
        return _unblock_answer(conn, user_id, collector_id)
    return _command(user_id, collector_id, command.idempotency_key, 'unblock', apply, blocked_you_ok=True)


def _handle_known(conn, blocker: str, other: str, via: str) -> bool:
    """Whether the blocker already knew the other's Handle and the Blocked list may show it: Friends always. Otherwise,
    on the user-id route, a request they received or a request they sent that was not made from a Trade; on a trader
    route never, since a request says nothing the blocker may tie to this trader id. Read before the Block deletes
    the friendship, with both owners locked."""
    row = conn.execute('SELECT state, requested_by, via_trade FROM friendship WHERE user_low=%s AND user_high=%s',
                       _pair(blocker, other)).fetchone()
    if row is None:
        return False
    if row['state'] == 'accepted':
        return True
    if via == 'trader':
        return False
    if row['requested_by'] != blocker:
        return True
    return not row['via_trade']


def place_block(conn, user_id: str, other: str, via: Literal['collector', 'trader']) -> None:
    """The one Block apply for every path (the user-id route, the trader routes and Report), run with both owners
    locked: Stage 1's effects first, then the row. A repeat leaves the first Block standing (its id, kind and
    ``handle_shown`` unchanged) and moves nothing."""
    shown = _handle_known(conn, user_id, other, via)
    friendship_ended(conn, user_id, other)
    conn.execute('DELETE FROM friendship WHERE user_low=%s AND user_high=%s', _pair(user_id, other))
    placed = conn.execute(
        'INSERT INTO block(blocker_id,blocked_id,via,handle_shown) VALUES (%s,%s,%s,%s) '
        'ON CONFLICT (blocker_id, blocked_id) DO NOTHING RETURNING id', (user_id, other, via, shown)).fetchone()
    if placed:
        pair_changed(conn, user_id, other)


def _lift_block(conn, user_id: str, other: str, *, via: str | None = None, block_id: UUID | None = None,
                former_friend: bool = False) -> bool:
    """Lifts the caller's Block of ``other``, of kind ``via`` or with id ``block_id`` (exactly one is given). With
    ``former_friend`` a trader Block whose Handle was shown (they were Friends) is lifted too. A lift
    ends the wait the caller set as decliner and moves the pair's watermark. Returns whether a row was deleted."""
    if block_id is None:
        lifted = conn.execute("DELETE FROM block WHERE blocker_id=%s AND blocked_id=%s "
                              "AND (via=%s OR (%s AND via='trader' AND handle_shown)) RETURNING 1",
                              (user_id, other, via, former_friend)).fetchone()
    else:
        lifted = conn.execute('DELETE FROM block WHERE blocker_id=%s AND blocked_id=%s AND id=%s RETURNING 1',
                              (user_id, other, block_id)).fetchone()
    if lifted:  # the decliner lifting a Block ends the wait they set; nothing else does
        conn.execute('DELETE FROM friend_request_declined WHERE sender_id=%s AND recipient_id=%s', (other, user_id))
        pair_changed(conn, user_id, other)
    return lifted is not None


def _unblock_answer(conn, user_id: str, other: str) -> str:
    """How the pair stands after an Unblock route lifted (or failed to lift) its own kind. A Block of the other kind
    that still stands answers as if there were none, so no route confirms that a user id and a trader id are the
    same collector."""
    after = find_collector(conn, user_id, 'collector', other)
    return 'none' if after is None else relation(user_id, {**after, 'blocked': False})


def _trader_answer(conn, user_id: str, other: str) -> str:
    """``_unblock_answer`` for the trader route: a pending Friend Request is answered as none, since it is tied to a
    Handle the caller knows and would let them test Near you rows."""
    answer = _unblock_answer(conn, user_id, other)
    return 'none' if answer in ('request_sent', 'request_received') else answer


def _trader(trader_id: UUID) -> str:
    with connect() as conn:
        other = trader_user(conn, trader_id)
    if other is None:
        error(404, 'COLLECTOR_NOT_FOUND')
    return other


@router.post('/traders/{trader_id}/block', response_model=FriendCommandResult)
def block_trader(trader_id: UUID, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Block the collector with this trader id, whatever the reach. An unknown trader id is 404 COLLECTOR_NOT_FOUND,
    the caller's own is 409 OWN_ACCOUNT. The blocked collector isn't told."""
    other = _trader(trader_id)

    def apply(conn, row):
        place_block(conn, user_id, other, 'trader')
        return 'blocked'
    return _command(user_id, other, command.idempotency_key, 'block_trader', apply, blocked_you_ok=True)


@router.post('/traders/{trader_id}/unblock', response_model=FriendCommandResult)
def unblock_trader(trader_id: UUID, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Unblock the collector with this trader id. It lifts only a Block made by trader id; asked about one made by
    user id it changes nothing and answers as if there were none. A pending Friend Request is answered as none."""
    other = _trader(trader_id)

    def apply(conn, row):
        _lift_block(conn, user_id, other, via='trader')
        return _trader_answer(conn, user_id, other)
    return _command(user_id, other, command.idempotency_key, 'unblock_trader', apply, blocked_you_ok=True)


def _unblock_by_id(user_id: str, block_id: UUID, key: UUID) -> FriendCommandResult:
    """``_command``'s skeleton with the replay before the resolve: the Block row is gone after a success, and a retry
    must replay rather than 404."""
    payload = {'action': 'unblock_block', 'block_id': str(block_id)}
    missing = False
    with connect() as conn, conn.transaction():
        ensure_owner(conn, user_id)
        conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.friend_command:' || %s))", (user_id,))
        digest, stored = replay(conn, user_id, key, payload)
        if stored is None:
            _count_command(conn, user_id)
            found = conn.execute('SELECT blocked_id FROM block WHERE id=%s AND blocker_id=%s',
                                 (block_id, user_id)).fetchone()
            if found is not None:
                lock_owners(conn, user_id, found['blocked_id'])
            if found is None or not _lift_block(conn, user_id, found['blocked_id'], block_id=block_id):
                missing = True  # answered after the commit, so the command stays counted
            else:
                stored = FriendCommandResult(
                    relation=_unblock_answer(conn, user_id, found['blocked_id'])).model_dump(mode='json')
                conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) '
                             'VALUES (%s,%s,%s,%s)', (user_id, key, digest, json.dumps(stored)))
    if missing:
        error(404, 'BLOCK_NOT_FOUND')
    return stored


@router.post('/blocked/{block_id}/unblock', response_model=FriendCommandResult)
def unblock_by_id(block_id: UUID, command: FriendCommand, user_id: str = Depends(verified_user)):
    """Unblock from Settings › Privacy: lifts any Block the caller placed, of either kind. An unknown id, or someone
    else's, is 404 BLOCK_NOT_FOUND. A retry with the same key replays."""
    return _unblock_by_id(user_id, block_id, command.idempotency_key)
