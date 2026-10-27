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
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, ValidationError

from .api_errors import api_error
from .db import connect
from .identity import verified_user
from .construction_checks import DISCLAIMER, IdentityCount, evaluate_checks
from .deck_format_checks import TargetFormat, held_format_checks
from .deck_list_display import CardKind, TrainerType
from .public_projection import public_projection_store, ProjectionUnavailable

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
    edition_ref: str | None = Field(default=None, pattern=r'^[0-9a-f]{48}$')
    printing_ref: str | None = Field(default=None, pattern=r'^[0-9a-f]{48}$')
    # The row's own Card Printing name, subtitle included ("Professor's Research (Professor Juniper)"). Snapshots
    # published before Deck Lists 09 have none; readers then use the Card Identity name of the row's group.
    printing_name: str | None = None
    # What the Published Deck page groups a row by, as the deck builder groups Deck List lines (app redesign #183):
    # the effective card kind, Trainer Type and evolves from (catalog_card_attribute) and a Pokémon's stored evolution
    # root and stage (migration 043), frozen with the snapshot. They are catalog facts about the row's Card Printing,
    # never ownership. Snapshots published before #183 have none, and every one is null where the catalog has no value.
    card_kind: CardKind | None = None
    trainer_type: TrainerType | None = None
    evolves_from: str | None = None
    evolution_root: str | None = None
    evolution_stage: int | None = None


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
    # The Deck List's Target Format, frozen with the snapshot (app redesign #178, ADR 0011). A snapshot published before
    # it has none and reads as Standard, the Target Format every Deck had then; its stored object is never rewritten.
    target_format: TargetFormat = 'standard'
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


def require_legal(conn, owner, deck_id) -> str:
    """The publish gate (ADR 0011): recompute the Deck List's result in its Target Format for today and refuse anything
    but ``legal`` with ``409 TARGET_FORMAT_NOT_LEGAL``, carrying the result. Returns the Target Format.

    The caller holds the inventory-owner row, so no Deck List command can change the list before the snapshot reads it
    in the same transaction. The catalog row (as the snapshot does) and the attribute-state row are share-locked here, so no catalog
    activation or attribute change lands between the check and the snapshot. The result is saved with the Deck like a command's; a refusal rolls it back with
    the rest of the transaction and writes nothing."""
    conn.execute('SELECT 1 FROM catalog_state WHERE singleton FOR SHARE')
    conn.execute('SELECT 1 FROM catalog_attribute_state WHERE singleton FOR SHARE')
    header = conn.execute('SELECT revision,target_format FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                          (owner, deck_id)).fetchone()
    if header is None:
        raise RuntimeError('Deck has no Deck List')  # Migration 029 gives every Deck a Deck List.
    checks = held_format_checks(conn, owner, deck_id, header['revision'], header['target_format'], reuse=False)
    if checks.results[0].status != 'legal':
        raise HTTPException(409, {'code': 'TARGET_FORMAT_NOT_LEGAL', 'target_format': header['target_format'],
                                  'format_checks': checks.model_dump(mode='json')})
    return header['target_format']


def snapshot(conn, owner, deck_id, title, version, target_format):
    """Freeze the Deck's Deck List lines (ADR 0009), never its Holdings: a line may name a card the owner does not own,
    and nothing about ownership or Locations is read. Rows group by Card Identity, which drives copy counts and checks;
    each row keeps its own Card Printing name and the display facts the Published Deck page groups it by (#183), read
    as the deck builder's display query reads them (``deck_list_display.DISPLAY_QUERY``)."""
    # The inventory-owner lock serializes this snapshot with Deck List commands (owner_and_rows) and with Holding
    # writes into the Deck, which may extend its Deck List.
    conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE', (owner,))
    conn.execute('SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE')
    # The Basic Energy class reads the effective card attributes (migration 030), as Deck detail checks do.
    rows = conn.execute("""SELECT ci.id,ci.display_name,l.quantity,e.descriptor,
      e.public_ref AS edition_ref,p.public_ref AS printing_ref,
      coalesce(pd.display_name,ci.display_name) AS printing_name,
      coalesce(pd.set_id,'') AS set_id,coalesce(pd.set_name,'') AS set_name,
      coalesce(pd.collector_number,'') AS collector_number,pd.image_url,
      CASE a.basic_energy WHEN true THEN 'supported' WHEN false THEN 'not_basic' ELSE 'unresolved' END AS basic_energy,
      a.card_kind,a.trainer_type,a.evolves_from,er.root_name AS evolution_root,er.stage AS evolution_stage
      FROM deck_list_line l JOIN catalog_edition e ON e.id=l.edition_id
      JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_identity ci ON ci.id=p.identity_id
      LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
      LEFT JOIN catalog_card_attribute a ON a.printing_id=p.id
      LEFT JOIN catalog_evolution_root er ON er.identity_key=ci.identity_key AND a.card_kind='pokemon'
      WHERE l.owner_id=%s AND l.deck_id=%s
      ORDER BY ci.display_name,ci.id,pd.set_id,pd.collector_number,e.descriptor_key""",
      (owner, deck_id)).fetchall()
    groups = {}
    for row in rows:
        group = groups.setdefault(row['id'], {'name': row['display_name'], 'amount': 0, 'editions': [], 'classes': []})
        group['amount'] += row['quantity']
        group['classes'].append(row['basic_energy'])
        group['editions'].append(PublicEdition(set_id=row['set_id'], set_name=row['set_name'], collector_number=row['collector_number'],
            variant=row['descriptor'], image_url=f"{row['image_url']}/low.webp" if row['image_url'] else None, quantity=str(row['quantity']),
            edition_ref=row['edition_ref'], printing_ref=row['printing_ref'], printing_name=row['printing_name'],
            card_kind=row['card_kind'], trainer_type=row['trainer_type'], evolves_from=row['evolves_from'],
            evolution_root=row['evolution_root'], evolution_stage=row['evolution_stage']))
    evaluated = evaluate_checks([IdentityCount(g['amount'],all(value=='supported' for value in g['classes']),
                                             'unresolved' in g['classes']) for g in groups.values()])
    identities, checks = [], []
    for group,status in zip(groups.values(),evaluated.identity_statuses):
        amount = group['amount']
        identities.append(PublicIdentity(name=group['name'],quantity=str(amount),editions=group['editions']))
        checks.append(PublicIdentityCheck(name=group['name'],quantity=str(amount),status=status))
    return PublicSnapshot(title=title,published_at=datetime.now(timezone.utc),version=version,target_format=target_format,total=str(evaluated.total),identities=identities,
        checks=PublicChecks(size_status=evaluated.size_status,shortage=str(evaluated.shortage),excess=str(evaluated.excess),identities=checks))


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


def mutate(deck_id, command, owner, action, token=None):
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
                        PublicSnapshot.model_validate(record['snapshot'])
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
                target_format = require_legal(conn, owner, deck_id) if action in ('publish', 'republish') else None
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
                    public = snapshot(conn, owner, deck_id, command.title, version, target_format)
                    projection = {'visibility': active['visibility'] if active else 'unlisted', 'snapshot': public.model_dump(mode='json')}
                    conn.execute('UPDATE deck_publication SET version=%s,title=%s WHERE token=%s', (version, command.title, target))
                result = PublicationResult(token=target, version=version, revoked=action == 'revoke').model_dump(mode='json')
                conn.execute('INSERT INTO publication_command(owner_id,request_key,request_digest,token,projection,result) VALUES (%s,%s,%s,%s,%s,%s)',
                             (owner, command.idempotency_key, digest, target, json.dumps(projection), json.dumps(result)))
            drain(conn, store)
            return result
    except (ProjectionUnavailable, psycopg.Error):
        api_error(503, 'PUBLICATION_UNAVAILABLE')


@router.get('/api/decks/{deck_id}/publication', response_model=PublicationStatus)
def publication_status(deck_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        owned_deck(conn, user_id, deck_id)
        row = conn.execute("""SELECT p.*,
          EXISTS(SELECT 1 FROM publication_command c WHERE c.token=p.token AND NOT c.projected) AS pending
          FROM deck_publication p WHERE p.deck_id=%s AND NOT p.revoked""", (deck_id,)).fetchone()
        return PublicationStatus(token=row['token'] if row else None, version=row['version'] if row else None,
            title=row['title'] if row else None, visibility=row['visibility'] if row else None, projection_pending=row['pending'] if row else False)


def refresh_after(background: BackgroundTasks, result: dict, user_id: str) -> dict:
    """After a publish or republish answered (the publish gate passed and the snapshot is committed and projected), start
    the background price refresh for the snapshot's Editions (app redesign #181). It runs after the response, outside every
    lock ``mutate`` takes, and never changes the answer (``publish_refresh``, imported here: it imports ``public_deck``,
    which imports this module)."""
    from . import publish_refresh
    background.add_task(publish_refresh.refresh_published_prices, result['token'], result['version'], f'user:{user_id}')
    return result


@router.post('/api/decks/{deck_id}/publication', response_model=PublicationResult)
def publish(deck_id: UUID, command: PublishCommand, background: BackgroundTasks, user_id: str = Depends(verified_user)):
    return refresh_after(background, mutate(deck_id, command, user_id, 'publish'), user_id)


@router.put('/api/decks/{deck_id}/publication', response_model=PublicationResult)
def republish(deck_id: UUID, command: PublishCommand, background: BackgroundTasks, user_id: str = Depends(verified_user)):
    return refresh_after(background, mutate(deck_id, command, user_id, 'republish'), user_id)


@router.delete('/api/decks/{deck_id}/publication', response_model=PublicationResult)
def revoke(deck_id: UUID, command: RevokeCommand, user_id: str = Depends(verified_user)):
    return mutate(deck_id, command, user_id, 'revoke')


@router.patch('/api/decks/{deck_id}/publication/visibility', response_model=PublicationResult)
def set_visibility(deck_id: UUID, command: VisibilityCommand, user_id: str = Depends(verified_user)):
    return mutate(deck_id, command, user_id, 'visibility')


@router.get('/api/publications', response_model=OwnedPublications)
def owned_publications(user_id: str = Depends(verified_user)):
    """The owner's active publications, including those whose Deck was deleted (``deck_id`` null)."""
    with connect() as conn:
        rows = conn.execute("""SELECT p.token,p.version,p.title,p.visibility,p.deck_id,
          EXISTS(SELECT 1 FROM publication_command c WHERE c.token=p.token AND NOT c.projected) AS projection_pending
          FROM deck_publication p WHERE p.owner_id=%s AND NOT p.revoked ORDER BY p.created_at,p.token""",
                            (user_id,)).fetchall()
        return OwnedPublications(publications=[OwnedPublication(**row) for row in rows])


@router.delete('/api/publications/{token}', response_model=PublicationResult)
def revoke_publication(token: str, command: RevokeCommand, user_id: str = Depends(verified_user)):
    return mutate(None, command, user_id, 'revoke', token=token)


@router.patch('/api/publications/{token}/visibility', response_model=PublicationResult)
def set_publication_visibility(token: str, command: VisibilityCommand, user_id: str = Depends(verified_user)):
    return mutate(None, command, user_id, 'visibility', token=token)


@router.get('/api/public/decks/{token}', response_model=PublicSnapshot)
def public_snapshot(token: str, response: Response):
    response.headers.update(PUBLIC_HEADERS)
    if not TOKEN.fullmatch(token):
        raise HTTPException(404, {'code': 'PUBLISHED_DECK_NOT_FOUND'}, headers=PUBLIC_HEADERS)
    try:
        record = public_projection_store().read().get(token)
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
