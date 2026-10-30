"""Game-free publication commands and durable projection writes."""
import hashlib
import json
import re
import secrets
from contextlib import contextmanager
from typing import Literal
from uuid import UUID

import psycopg
from pydantic import BaseModel, ConfigDict, Field, field_validator, ValidationError

from app.api_errors import api_error
from app.db import connect
from app.public_projection import public_projection_store, ProjectionUnavailable

TOKEN = re.compile(r'[A-Za-z0-9_-]{32}')
PUBLIC_HEADERS = {'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow'}


class PublicModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class PublishCommand(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    idempotency_key: UUID

    @field_validator('title')
    @classmethod
    def plain_title(cls, value):
        value = value.strip()
        if (not value or any(ord(c) < 32 for c in value) or '<' in value or '>' in value
                or re.search(r'https?://|www\.|\[[^\]]*\]\(', value, re.I)):
            raise ValueError('Use a plain-text title without markup or links')
        return value


class RevokeCommand(BaseModel):
    idempotency_key: UUID


class VisibilityCommand(BaseModel):
    visibility: Literal['listed', 'unlisted']
    idempotency_key: UUID


class PublicationStatus(BaseModel):
    token: str | None
    version: int | None
    title: str | None
    visibility: str | None
    projection_pending: bool = False


class PublicationResult(BaseModel):
    token: str
    version: int
    revoked: bool


class OwnedPublication(BaseModel):
    token: str
    version: int
    title: str
    visibility: str
    # The Deck it was published from; null once that Deck has been deleted (the publication stays live).
    deck_id: UUID | None
    projection_pending: bool


class OwnedPublications(BaseModel):
    publications: list[OwnedPublication]


def owned_deck(conn, owner, deck_id):
    if not conn.execute("SELECT 1 FROM location WHERE id=%s AND owner_id=%s AND kind='deck'", (deck_id, owner)).fetchone():
        api_error(404, 'DECK_NOT_FOUND')


def owned_publication(conn, owner, token):
    """A malformed token, an unknown one and another owner's are the same 404. Revoked publications stay found, so a
    command on one can replay or report PUBLICATION_REVOKED."""
    if not TOKEN.fullmatch(token) or not conn.execute('SELECT 1 FROM deck_publication WHERE token=%s AND owner_id=%s',
                                                      (token, owner)).fetchone():
        api_error(404, 'PUBLICATION_NOT_FOUND')


def drain(conn, store):
    # A failed object write is durably retried before any later command. A crash
    # after object replacement can safely repeat exactly the same replacement.
    pending = conn.execute('SELECT sequence,token,projection FROM publication_command WHERE NOT projected ORDER BY sequence').fetchall()
    conn.commit()
    for row in pending:
        store.apply(row['token'], row['projection'])
        conn.execute('UPDATE publication_command SET projected=true WHERE sequence=%s', (row['sequence'],))
        conn.commit()


@contextmanager
def authorized_writer(authorize):
    with connect() as conn:
        authorize(conn)
        conn.commit()
        # Session lock spans transaction commits and serializes durable outbox
        # replay for every adapter. CAS alone cannot prevent old PUT replay after DELETE.
        conn.execute('SELECT pg_advisory_lock(914705)')
        conn.commit()
        try:
            with public_projection_store().writer() as store:
                yield store, conn
        finally:
            conn.rollback()
            conn.execute('SELECT pg_advisory_unlock(914705)')
            conn.commit()


def mutate(deck_id, command, owner, action, token=None, *, legal, snapshot, snapshot_model):
    """One publication command, addressed by its Deck, or by its public ``token`` for revoke and visibility, which work
    whether or not the Deck still exists. Publishing and republishing need the Deck: a publication whose Deck was deleted
    has no Deck List left to snapshot.

    Lock order: the session advisory lock (authorized_writer), then the inventory-owner row, then the Deck's row and its
    publications. Deck deletion and every inventory command take the owner row first too, and every publication command
    inserts rows whose foreign keys key-share lock the owner row, so taking it any later could deadlock with a Deck
    deletion that is unlinking this Deck's publications."""
    # Deck-keyed digests stay exactly as before, so stored commands keep replaying.
    scope = {'deck_id': str(deck_id)} if token is None else {'token': token}
    payload = {**scope, 'action': action, **command.model_dump(mode='json')}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

    def authorize(conn, deck_id=deck_id, token=token):
        """Ownership of the Deck or the publication, unless this exact command already ran: a stored command replays its
        result whatever has happened to its Deck since, such as a lost response retried after the Deck was deleted."""
        previous = conn.execute('SELECT request_digest FROM publication_command WHERE owner_id=%s AND request_key=%s',
                                (owner, command.idempotency_key)).fetchone()
        if previous:
            if previous['request_digest'] != digest:
                api_error(409, 'IDEMPOTENCY_KEY_REUSED')
            return
        if token is None:
            owned_deck(conn, owner, deck_id)
        else:
            owned_publication(conn, owner, token)
    try:
        with authorized_writer(authorize) as (store, conn):
            # Session writer ownership spans commits and serialized outbox recovery.
            drain(conn, store)
            read_token, frozen = None, None
            if action == 'visibility':
                # Read and validate the public object before the transaction, so no row lock (the owner's included) is
                # held across store I/O. The advisory lock is held and the outbox drained, so no publication command
                # can change this token's object before the transaction re-checks the token.
                current = conn.execute(
                    'SELECT token FROM deck_publication WHERE deck_id=%s AND NOT revoked' if token is None
                    else 'SELECT token FROM deck_publication WHERE token=%s AND NOT revoked',
                    (deck_id if token is None else token,)).fetchone()
                conn.commit()
                if current:
                    read_token = current['token']
                    record = store.read().get(read_token)
                    # Validate only: visibility never reinterprets frozen contents, so legacy
                    # objects keep their exact stored bytes (no inferred or null references).
                    try:
                        snapshot_model.model_validate(record['snapshot'])
                        frozen = record['snapshot']
                    except (KeyError, TypeError, ValueError, ValidationError):
                        frozen = None
            with conn.transaction():
                conn.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE', (owner,))
                authorize(conn)
                previous = conn.execute('SELECT request_digest,result FROM publication_command WHERE owner_id=%s AND request_key=%s', (owner, command.idempotency_key)).fetchone()
                if previous:
                    if previous['request_digest'] != digest:
                        api_error(409, 'IDEMPOTENCY_KEY_REUSED')
                    return previous['result']
                if token is None:
                    active = conn.execute('SELECT * FROM deck_publication WHERE deck_id=%s AND NOT revoked FOR UPDATE', (deck_id,)).fetchone()
                else:
                    active = conn.execute('SELECT * FROM deck_publication WHERE token=%s AND NOT revoked FOR UPDATE', (token,)).fetchone()
                    if not active:
                        api_error(409, 'PUBLICATION_REVOKED')
                if action == 'publish' and active:
                    api_error(409, 'DECK_ALREADY_PUBLISHED')
                if action != 'publish' and not active:
                    api_error(409, 'DECK_NOT_PUBLISHED')
                # Publishing and republishing need a legal result in the Target Format (ADR 0011), checked before any
                # row is written. A replayed command answered above, so a stored publish replays whatever the Deck is now.
                target_format = legal(conn, owner, deck_id) if action in ('publish', 'republish') else None
                if action == 'publish':
                    target, version = secrets.token_urlsafe(24), 1
                    conn.execute('INSERT INTO deck_publication(token,owner_id,deck_id,title) VALUES (%s,%s,%s,%s)', (target, owner, deck_id, command.title))
                else:
                    target = active['token']
                    version = active['version'] + (1 if action == 'republish' else 0)
                if action == 'visibility':
                    # A missing or invalid object, or a token that changed since it was read, is retried, never guessed.
                    if frozen is None or target != read_token:
                        raise ProjectionUnavailable()
                    projection = {'visibility': command.visibility, 'snapshot': frozen}
                    conn.execute('UPDATE deck_publication SET visibility=%s WHERE token=%s', (command.visibility, target))
                elif action == 'revoke':
                    projection = None
                    conn.execute('UPDATE deck_publication SET revoked=true WHERE token=%s', (target,))
                else:
                    projection = {'visibility': active['visibility'] if active else 'unlisted', 'snapshot': snapshot(conn, owner, deck_id, command.title, version, target_format)}
                    conn.execute('UPDATE deck_publication SET version=%s,title=%s WHERE token=%s', (version, command.title, target))
                result = PublicationResult(token=target, version=version, revoked=action == 'revoke').model_dump(mode='json')
                conn.execute('INSERT INTO publication_command(owner_id,request_key,request_digest,token,projection,result) VALUES (%s,%s,%s,%s,%s,%s)',
                             (owner, command.idempotency_key, digest, target, json.dumps(projection), json.dumps(result)))
            drain(conn, store)
            return result
    except (ProjectionUnavailable, psycopg.Error):
        api_error(503, 'PUBLICATION_UNAVAILABLE')
