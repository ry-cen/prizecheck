"""Intentional Deck publication; anonymous reads consume only public objects."""
import hashlib
import json
import re
import secrets
from datetime import datetime, timezone
from contextlib import contextmanager
from uuid import UUID
from typing import Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, ValidationError

from .main import connect, verified_user
from .decks import DISCLAIMER
from .public_projection import FilePublicProjection, ProjectionUnavailable

router = APIRouter(tags=['publication'])
TOKEN = re.compile(r'[A-Za-z0-9_-]{32}')
PUBLIC_HEADERS = {'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow'}


class PublicModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class PublicEdition(PublicModel):
    set_id: str
    set_name: str
    collector_number: str
    variant: dict
    image_url: str | None
    quantity: str


class PublicIdentity(PublicModel):
    name: str
    quantity: str
    editions: list[PublicEdition]


class PublicIdentityCheck(PublicModel):
    name: str
    quantity: str
    status: str


class PublicChecks(PublicModel):
    size_status: str
    shortage: str
    excess: str
    identities: list[PublicIdentityCheck]
    disclaimer: str = DISCLAIMER


class PublicSnapshot(PublicModel):
    title: str
    published_at: datetime
    version: int
    total: str
    identities: list[PublicIdentity]
    checks: PublicChecks


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


def fail(status, code):
    raise HTTPException(status, {'code': code})


def owned_deck(conn, owner, deck_id):
    if not conn.execute("SELECT 1 FROM location WHERE id=%s AND owner_id=%s AND kind='deck'", (deck_id, owner)).fetchone():
        fail(404, 'DECK_NOT_FOUND')


def snapshot(conn, owner, deck_id, title, version):
    # Inventory-owner lock prevents Add/Move/Removal during this snapshot.
    conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE', (owner,))
    state = conn.execute('SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE').fetchone()
    rows = conn.execute("""SELECT ci.id,ci.display_name,h.quantity,e.descriptor,
      coalesce(gp.set_id,'') AS set_id,coalesce(gp.set_name,'') AS set_name,
      coalesce(gp.collector_number,'') AS collector_number,gp.image_url,
      coalesce(gp.basic_energy,'unresolved') AS basic_energy
      FROM holding h JOIN catalog_edition e ON e.id=h.edition_id
      JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_identity ci ON ci.id=p.identity_id
      LEFT JOIN catalog_generation_printing gp ON gp.printing_id=p.id AND gp.generation_id=%s
      WHERE h.owner_id=%s AND h.location_id=%s
      ORDER BY ci.display_name,ci.id,gp.set_id,gp.collector_number,e.descriptor_key""",
      (state['active_generation'], owner, deck_id)).fetchall()
    groups = {}
    for row in rows:
        group = groups.setdefault(row['id'], {'name': row['display_name'], 'amount': 0, 'editions': [], 'classes': []})
        group['amount'] += row['quantity']
        group['classes'].append(row['basic_energy'])
        group['editions'].append(PublicEdition(set_id=row['set_id'], set_name=row['set_name'], collector_number=row['collector_number'],
            variant=row['descriptor'], image_url=f"{row['image_url']}/low.webp" if row['image_url'] else None, quantity=str(row['quantity'])))
    total = sum(group['amount'] for group in groups.values())
    identities, checks = [], []
    for group in groups.values():
        amount = group['amount']
        status = ('basic_energy_exempt' if all(value == 'supported' for value in group['classes']) else
                  'unresolved' if 'unresolved' in group['classes'] else 'over_limit' if amount > 4 else 'within_limit')
        identities.append(PublicIdentity(name=group['name'], quantity=str(amount), editions=group['editions']))
        checks.append(PublicIdentityCheck(name=group['name'], quantity=str(amount), status=status))
    return PublicSnapshot(title=title, published_at=datetime.now(timezone.utc), version=version, total=str(total), identities=identities,
        checks=PublicChecks(size_status='complete' if total == 60 else 'shortage' if total < 60 else 'excess',
                            shortage=str(max(0,60-total)), excess=str(max(0,total-60)), identities=checks))


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
def authorized_writer(owner, deck_id):
    with connect() as conn:
        owned_deck(conn, owner, deck_id)
        conn.commit()
        with FilePublicProjection().writer() as store:
            yield store, conn


def mutate(deck_id, command, owner, action):
    payload = {'deck_id': str(deck_id), 'action': action, **command.model_dump(mode='json')}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    try:
        with authorized_writer(owner, deck_id) as (store, conn):
            # writer flock spans commits, and serializes outbox recovery + writes.
            drain(conn, store)
            with conn.transaction():
                owned_deck(conn, owner, deck_id)
                previous = conn.execute('SELECT request_digest,result FROM publication_command WHERE owner_id=%s AND request_key=%s', (owner, command.idempotency_key)).fetchone()
                if previous:
                    if previous['request_digest'] != digest:
                        fail(409, 'IDEMPOTENCY_KEY_REUSED')
                    return previous['result']
                active = conn.execute('SELECT * FROM deck_publication WHERE deck_id=%s AND NOT revoked FOR UPDATE', (deck_id,)).fetchone()
                if action == 'publish' and active:
                    fail(409, 'DECK_ALREADY_PUBLISHED')
                if action != 'publish' and not active:
                    fail(409, 'DECK_NOT_PUBLISHED')
                if action == 'publish':
                    token, version = secrets.token_urlsafe(24), 1
                    conn.execute('INSERT INTO deck_publication(token,owner_id,deck_id,title) VALUES (%s,%s,%s,%s)', (token, owner, deck_id, command.title))
                else:
                    token = active['token']
                    version = active['version'] + (1 if action == 'republish' else 0)
                if action == 'visibility':
                    record = store.read().get(token)
                    if not record:
                        raise ProjectionUnavailable()
                    projection = {'visibility': command.visibility, 'snapshot': PublicSnapshot.model_validate(record['snapshot']).model_dump(mode='json')}
                    conn.execute('UPDATE deck_publication SET visibility=%s WHERE token=%s', (command.visibility, token))
                elif action == 'revoke':
                    projection = None
                    conn.execute('UPDATE deck_publication SET revoked=true WHERE token=%s', (token,))
                else:
                    public = snapshot(conn, owner, deck_id, command.title, version)
                    projection = {'visibility': active['visibility'] if active else 'unlisted', 'snapshot': public.model_dump(mode='json')}
                    conn.execute('UPDATE deck_publication SET version=%s,title=%s WHERE token=%s', (version, command.title, token))
                result = PublicationResult(token=token, version=version, revoked=action == 'revoke').model_dump(mode='json')
                conn.execute('INSERT INTO publication_command(owner_id,request_key,request_digest,token,projection,result) VALUES (%s,%s,%s,%s,%s,%s)',
                             (owner, command.idempotency_key, digest, token, json.dumps(projection), json.dumps(result)))
            drain(conn, store)
            return result
    except (ProjectionUnavailable, psycopg.Error):
        fail(503, 'PUBLICATION_UNAVAILABLE')


@router.get('/api/decks/{deck_id}/publication', response_model=PublicationStatus)
def publication_status(deck_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        owned_deck(conn, user_id, deck_id)
        row = conn.execute("""SELECT p.*,
          EXISTS(SELECT 1 FROM publication_command c WHERE c.token=p.token AND NOT c.projected) AS pending
          FROM deck_publication p WHERE p.deck_id=%s AND NOT p.revoked""", (deck_id,)).fetchone()
        return PublicationStatus(token=row['token'] if row else None, version=row['version'] if row else None,
            title=row['title'] if row else None, visibility=row['visibility'] if row else None, projection_pending=row['pending'] if row else False)


@router.post('/api/decks/{deck_id}/publication', response_model=PublicationResult)
def publish(deck_id: UUID, command: PublishCommand, user_id: str = Depends(verified_user)):
    return mutate(deck_id, command, user_id, 'publish')


@router.put('/api/decks/{deck_id}/publication', response_model=PublicationResult)
def republish(deck_id: UUID, command: PublishCommand, user_id: str = Depends(verified_user)):
    return mutate(deck_id, command, user_id, 'republish')


@router.delete('/api/decks/{deck_id}/publication', response_model=PublicationResult)
def revoke(deck_id: UUID, command: RevokeCommand, user_id: str = Depends(verified_user)):
    return mutate(deck_id, command, user_id, 'revoke')


@router.patch('/api/decks/{deck_id}/publication/visibility', response_model=PublicationResult)
def set_visibility(deck_id: UUID, command: VisibilityCommand, user_id: str = Depends(verified_user)):
    return mutate(deck_id, command, user_id, 'visibility')


@router.get('/api/public/decks/{token}', response_model=PublicSnapshot)
def public_snapshot(token: str, response: Response):
    response.headers.update(PUBLIC_HEADERS)
    if not TOKEN.fullmatch(token):
        raise HTTPException(404, {'code': 'PUBLISHED_DECK_NOT_FOUND'}, headers=PUBLIC_HEADERS)
    try:
        record = FilePublicProjection().read().get(token)
    except ProjectionUnavailable:
        raise HTTPException(503, {'code': 'PUBLIC_PROJECTION_UNAVAILABLE'}, headers=PUBLIC_HEADERS) from None
    if record is None:
        raise HTTPException(404, {'code': 'PUBLISHED_DECK_NOT_FOUND'}, headers=PUBLIC_HEADERS)
    try:
        if record['visibility'] not in ('listed', 'unlisted'):
            raise ValueError()
        public = PublicSnapshot.model_validate(record['snapshot'])
    except (KeyError, TypeError, ValueError, ValidationError):
        raise HTTPException(503, {'code': 'PUBLIC_PROJECTION_UNAVAILABLE'}, headers=PUBLIC_HEADERS) from None
    if record['visibility'] == 'listed':
        response.headers['X-Robots-Tag'] = 'index, follow'
    return public
