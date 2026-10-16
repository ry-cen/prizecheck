"""Handles, Display Names and the Invite Link (social network #246, spec "Handles, Invite Links and lookup").

Every collector has a profile (migration 100): a Handle, unique ignoring case, and a Display Name. Both are made when
the account is (a generated ``collector_`` Handle and the placeholder Display Name ``Collector``) and changed here, in
Settings › Privacy. The Display Name can change at any time. A Handle can change once every 30 days, at most 10
attempts an hour that reach the availability check, and the Handle given up is held for 30 days so nobody else can
take it; a change of case only is always free. Names follow ``name_rules``.

The Invite Link is ``/invite/<token>``: 32 URL-safe characters (192 random bits), made the first time the profile is
read, replaced by Make a new link. Its signed-out page reads one record of the public records store,
``invite:<sha256 of the token>``, holding the Display Name only, so it never wakes PostgreSQL and the store never holds
the token. Migration 100's triggers queue every change of that record in ``invite_projection_outbox`` in the same
transaction as the change; ``drain_invites`` applies the queue after the command commits. A command that changed the
record answers 503 PROFILE_UNAVAILABLE when the store can't be written; its retry with the same idempotency key
replays the stored answer and drains again. Reads drain too, best effort, and never fail because of the store.

Commands are owner commands: authenticated, under the owner row lock (``owner_and_rows``), idempotent through
``location_command``. They never move the inventory revision.
"""
import hashlib
import json
import secrets
import time
from datetime import datetime
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..location_tree import error, owner_and_rows, replay
from ..main import connect, verified_user
from ..public_projection import ProjectionUnavailable
from ..public_records import MAX_BATCH, invite_key, public_record_store
from ..publications import PUBLIC_HEADERS, TOKEN
from . import name_rules

router = APIRouter(prefix='/api/profile', tags=['profile'])
public_router = APIRouter(tags=['public invites'])

HANDLE_TRIES_PER_HOUR = 10
DRAIN_SECONDS = 3.0
READ_SECONDS = 2.0
DRAIN_TRIES = 3


class CollectorProfile(BaseModel):
    handle: str
    display_name: str
    # When the Handle can change again; None when it can change now.
    handle_change_available_at: datetime | None
    # The Invite Link's token: the page is /invite/<token>.
    invite_token: str


class SetDisplayName(BaseModel):
    display_name: str = Field(max_length=400)
    idempotency_key: UUID


class SetHandle(BaseModel):
    handle: str = Field(max_length=400)
    idempotency_key: UUID


class NewInviteLink(BaseModel):
    idempotency_key: UUID


class PublicInvite(BaseModel):
    """The signed-out Invite Link page: the Display Name and nothing else."""
    model_config = ConfigDict(extra='forbid')
    display_name: str = Field(min_length=1, max_length=name_rules.DISPLAY_NAME_LENGTH)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _new_token() -> str:
    return secrets.token_urlsafe(24)  # 24 bytes, 32 characters, the Published Deck token's alphabet and length


def read_profile(conn, user_id: str) -> CollectorProfile:
    """The collector's profile, making the Invite Link on the first read. Call it after ``owner_and_rows``."""
    row = conn.execute("""SELECT handle,display_name,
        CASE WHEN handle_changed_at > now() - interval '30 days' THEN handle_changed_at + interval '30 days' END AS available_at
      FROM collector_profile WHERE user_id=%s""", (user_id,)).fetchone()
    if row is None:  # an owner row restored without its profile: make it now
        conn.execute('SELECT create_collector_profile(%s)', (user_id,))
        return read_profile(conn, user_id)
    link = conn.execute('SELECT token FROM invite_link WHERE user_id=%s', (user_id,)).fetchone()
    if link is None:
        token = _new_token()
        conn.execute('INSERT INTO invite_link(user_id,token,token_hash) VALUES (%s,%s,%s)',
                     (user_id, token, token_hash(token)))
    else:
        token = link['token']
    return CollectorProfile(handle=row['handle'], display_name=row['display_name'],
                            handle_change_available_at=row['available_at'], invite_token=token)


def drain_invites() -> bool:
    """Apply every queued invite record write to the public records store, oldest first, the last write of each record
    winning. True when the queue is empty afterwards. One drain runs at a time (a transaction-scoped advisory lock);
    rows are deleted only after their records are written."""
    try:
        store = public_record_store()
        with connect() as conn, conn.transaction():
            # A drain that can't take the lock within its budget gives up (LockNotAvailable is a psycopg.Error).
            conn.execute("SELECT set_config('lock_timeout', %s, true)", (f'{int(DRAIN_SECONDS * 1000)}ms',))
            conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.invite_projection'))")
            deadline = time.monotonic() + DRAIN_SECONDS
            while True:
                rows = conn.execute('SELECT id,token_hash,display_name FROM invite_projection_outbox ORDER BY id LIMIT %s',
                                    (MAX_BATCH * 4,)).fetchall()
                if not rows:
                    return True
                latest: dict[str, str | None] = {}
                for row in rows:
                    latest[row['token_hash']] = row['display_name']
                hashes = sorted(latest)
                try:
                    for start in range(0, len(hashes), MAX_BATCH):
                        chunk = hashes[start:start + MAX_BATCH]
                        keys = {invite_key(value): value for value in chunk}
                        changes = {key: None if latest[value] is None else {'display_name': latest[value]}
                                   for key, value in keys.items()}
                        for _ in range(DRAIN_TRIES):
                            found = store.read_records(list(keys), deadline=deadline).records
                            if store.compare_and_swap({key: found[key].version for key in keys}, changes,
                                                      deadline=deadline) is True:
                                break
                        else:
                            return False
                except (ProjectionUnavailable, ValueError, OSError):
                    # Leave this batch queued; the DELETEs of the batches already applied commit with the return.
                    return False
                conn.execute('DELETE FROM invite_projection_outbox WHERE id=ANY(%s)', ([row['id'] for row in rows],))
    except (ProjectionUnavailable, ValueError, OSError, psycopg.Error):
        return False


def _queued(conn, user_id: str) -> bool:
    """Whether this command queued an invite record write (the triggers ran in this transaction)."""
    return conn.execute("""SELECT EXISTS (SELECT 1 FROM invite_projection_outbox o JOIN invite_link l
        ON o.token_hash=l.token_hash WHERE l.user_id=%s)""", (user_id,)).fetchone()['exists']


def _store(conn, user_id, key, digest, profile: CollectorProfile, queued: bool) -> dict:
    response = {'profile': profile.model_dump(mode='json'), 'queued': queued}
    conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                 (user_id, key, digest, json.dumps(response)))
    return response


def _answer(stored: dict) -> dict:
    """A command's stored answer, after draining: 503 when its own record write is still queued."""
    if not drain_invites() and stored['queued']:
        error(503, 'PROFILE_UNAVAILABLE')
    return stored['profile']


def _refused(refusal: name_rules.NameRefused):
    raise HTTPException(422, {'code': refusal.code})


@router.get('', response_model=CollectorProfile)
def get_profile(user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        owner_and_rows(conn, user_id)
        profile = read_profile(conn, user_id)
    drain_invites()
    return profile


@router.put('/display-name', response_model=CollectorProfile)
def set_display_name(command: SetDisplayName, user_id: str = Depends(verified_user)):
    """Change the Display Name. Idempotent; the current name is accepted and changes nothing."""
    payload = {'action': 'set_display_name', 'display_name': command.display_name}
    with connect() as conn, conn.transaction():
        owner_and_rows(conn, user_id)
        digest, stored = replay(conn, user_id, command.idempotency_key, payload)
        if stored is None:
            try:
                name = name_rules.clean_display_name(command.display_name)
            except name_rules.NameRefused as refusal:
                _refused(refusal)
            read_profile(conn, user_id)  # the link exists first, so the trigger rewrites its record
            conn.execute('UPDATE collector_profile SET display_name=%s WHERE user_id=%s', (name, user_id))
            stored = _store(conn, user_id, command.idempotency_key, digest, read_profile(conn, user_id),
                            _queued(conn, user_id))
    return _answer(stored)


@router.post('/invite-link', response_model=CollectorProfile)
def new_invite_link(command: NewInviteLink, user_id: str = Depends(verified_user)):
    """Make a new Invite Link: the old link stops working once this answers. Idempotent."""
    payload = {'action': 'new_invite_link'}
    with connect() as conn, conn.transaction():
        owner_and_rows(conn, user_id)
        digest, stored = replay(conn, user_id, command.idempotency_key, payload)
        if stored is None:
            read_profile(conn, user_id)
            token = _new_token()
            conn.execute('UPDATE invite_link SET token=%s,token_hash=%s,created_at=now() WHERE user_id=%s',
                         (token, token_hash(token), user_id))
            stored = _store(conn, user_id, command.idempotency_key, digest, read_profile(conn, user_id), True)
    return _answer(stored)


@router.put('/handle', response_model=CollectorProfile)
def set_handle(command: SetHandle, user_id: str = Depends(verified_user)):
    """Change the Handle. In order: the format (422 INVALID_HANDLE), reserved names and the filter (422
    HANDLE_NOT_ALLOWED), the current Handle (no change) or the same one in another case (always allowed), the 30-day
    limit (409 HANDLE_CHANGE_TOO_SOON with ``available_at``), the hourly attempt limit (429 TOO_MANY_HANDLE_TRIES with
    ``retry_after_minutes``), then whether another collector has it or held it within 30 days (409 HANDLE_TAKEN). An
    attempt that reaches the last check is counted even when it is refused. Idempotent."""
    payload = {'action': 'set_handle', 'handle': command.handle}
    taken = False
    with connect() as conn, conn.transaction():
        owner_and_rows(conn, user_id)
        digest, stored = replay(conn, user_id, command.idempotency_key, payload)
        if stored is None:
            try:
                handle = name_rules.clean_handle(command.handle)
            except name_rules.NameRefused as refusal:
                _refused(refusal)
            current = conn.execute("""SELECT handle,handle_key,
                CASE WHEN handle_changed_at > now() - interval '30 days' THEN handle_changed_at + interval '30 days' END
                  AS available_at
              FROM collector_profile WHERE user_id=%s""", (user_id,)).fetchone()
            key = handle.lower()
            if key == current['handle_key']:
                conn.execute('UPDATE collector_profile SET handle=%s WHERE user_id=%s AND handle<>%s',
                             (handle, user_id, handle))
            else:
                if current['available_at'] is not None:
                    raise HTTPException(409, {'code': 'HANDLE_CHANGE_TOO_SOON',
                                              'available_at': current['available_at'].isoformat()})
                conn.execute("""DELETE FROM handle_lookup_event
                  WHERE user_id=%s AND kind='handle_change' AND created_at < now() - interval '1 hour'""", (user_id,))
                tries = conn.execute("""SELECT count(*) AS tries, min(created_at) AS oldest FROM handle_lookup_event
                  WHERE user_id=%s AND kind='handle_change'""", (user_id,)).fetchone()
                if tries['tries'] >= HANDLE_TRIES_PER_HOUR:
                    wait = conn.execute("SELECT ceil(extract(epoch FROM %s + interval '1 hour' - now()) / 60) AS wait",
                                        (tries['oldest'],)).fetchone()['wait']
                    raise HTTPException(429, {'code': 'TOO_MANY_HANDLE_TRIES', 'retry_after_minutes': max(1, int(wait))})
                conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,'handle_change')", (user_id,))
                # Both Handle keys, in key order, after the owner lock: two collectors swapping Handles can't deadlock.
                for name in sorted({key, current['handle_key']}):
                    conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.handle:' || %s))", (name,))
                taken = conn.execute("""SELECT EXISTS (SELECT 1 FROM collector_profile WHERE handle_key=%s AND user_id<>%s)
                    OR EXISTS (SELECT 1 FROM released_handle WHERE handle_key=%s AND released_at > now() - interval '30 days')
                    AS taken""", (key, user_id, key)).fetchone()['taken']
                if not taken:
                    try:
                        with conn.transaction():
                            conn.execute("""INSERT INTO released_handle(handle_key,released_at) VALUES (%s,now())
                              ON CONFLICT (handle_key) DO UPDATE SET released_at=excluded.released_at""",
                                         (current['handle_key'],))
                            conn.execute("DELETE FROM released_handle WHERE released_at < now() - interval '30 days'")
                            conn.execute("""UPDATE collector_profile SET handle=%s,handle_key=%s,handle_changed_at=now()
                              WHERE user_id=%s""", (handle, key, user_id))
                    except psycopg.errors.UniqueViolation:
                        taken = True
            if not taken:
                stored = _store(conn, user_id, command.idempotency_key, digest, read_profile(conn, user_id), False)
    if taken:  # after the commit, so the attempt stays counted
        error(409, 'HANDLE_TAKEN')
    return _answer(stored)


@public_router.get('/api/public/invites/{token}', response_model=PublicInvite)
def public_invite(token: str, request: Request, response: Response):
    """The signed-out Invite Link page's one read: the public records store only, never PostgreSQL. An unknown,
    replaced or malformed token is 404 INVITE_NOT_FOUND; any query string is 422 INVALID_REQUEST."""
    response.headers.update(PUBLIC_HEADERS)
    if request.url.query:
        raise HTTPException(422, {'code': 'INVALID_REQUEST'}, headers=PUBLIC_HEADERS)
    if not TOKEN.fullmatch(token):
        raise HTTPException(404, {'code': 'INVITE_NOT_FOUND'}, headers=PUBLIC_HEADERS)
    key = invite_key(token_hash(token))
    try:
        value = public_record_store().read_records([key], deadline=time.monotonic() + READ_SECONDS).records[key].value
    except (ProjectionUnavailable, ValueError, OSError):
        raise HTTPException(503, {'code': 'PUBLIC_PROJECTION_UNAVAILABLE'}, headers=PUBLIC_HEADERS) from None
    if value is None:
        raise HTTPException(404, {'code': 'INVITE_NOT_FOUND'}, headers=PUBLIC_HEADERS)
    try:
        return PublicInvite.model_validate(value)
    except ValidationError:
        raise HTTPException(503, {'code': 'PUBLIC_PROJECTION_UNAVAILABLE'}, headers=PUBLIC_HEADERS) from None
