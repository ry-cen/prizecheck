"""Intentional Deck publication; anonymous reads consume only public objects."""
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError

from app.db import connect
from app.core.art.public import public_address
from app.core.art.store import warm_deck
from app.games.pokemon.art import route as art_route
from app.identity import verified_user
from app.public_projection import public_projection_store, ProjectionUnavailable
from app.core.publications.publish import (
    TOKEN, PUBLIC_HEADERS, PublishCommand, RevokeCommand, VisibilityCommand,
    PublicationStatus, PublicationResult, OwnedPublication, OwnedPublications, owned_deck, mutate,
)
from app.games.pokemon.art.urls import large_direct_url
from app.games.pokemon.formats.construction_checks import IdentityCount, evaluate_checks
from app.games.pokemon.formats.deck_format_checks import held_format_checks
from app.games.pokemon.publications.models import (
    PublicEdition, PublicIdentity, PublicIdentityCheck, PublicChecks, PublicSnapshot,
)

router = APIRouter(tags=['publication'])

# Fields a public read adds that a snapshot never stores.
READ_ONLY = {'identities': {'__all__': {'editions': {'__all__': {'large_image_url'}}}}}


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
      coalesce(pd.collector_number,'') AS collector_number,art.low_image_url AS image_url,
      CASE a.basic_energy WHEN true THEN 'supported' WHEN false THEN 'not_basic' ELSE 'unresolved' END AS basic_energy,
      a.card_kind,a.trainer_type,a.evolves_from,er.root_name AS evolution_root,er.stage AS evolution_stage
      FROM deck_list_line l JOIN catalog_edition e ON e.id=l.edition_id
      JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_identity ci ON ci.id=p.identity_id
      LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
      LEFT JOIN catalog_printing_art art ON art.printing_id=p.id
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
            variant=row['descriptor'], image_url=row['image_url'], quantity=str(row['quantity']),
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


def frozen_snapshot(conn, owner, deck_id, title, version, target_format) -> dict:
    result = snapshot(conn, owner, deck_id, title, version, target_format).model_dump(mode='json', exclude=READ_ONLY)
    warm_deck(conn, owner, deck_id, sizes=('small', 'large'), allowed_host=art_route.ALLOWED_HOST,
              linked_art=art_route.LINKED_ART, fetcher=art_route.fetcher, key_prefix=art_route.KEY_PREFIX,
              upgrade=art_route.upgrade())
    return result


def _mutate(deck_id, command, owner, action, token=None):
    return mutate(deck_id, command, owner, action, token,
                  legal=require_legal, snapshot=frozen_snapshot, snapshot_model=PublicSnapshot)


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
    return _mutate(deck_id, command, user_id, 'publish')


@router.put('/api/decks/{deck_id}/publication', response_model=PublicationResult)
def republish(deck_id: UUID, command: PublishCommand, user_id: str = Depends(verified_user)):
    return _mutate(deck_id, command, user_id, 'republish')


@router.delete('/api/decks/{deck_id}/publication', response_model=PublicationResult)
def revoke(deck_id: UUID, command: RevokeCommand, user_id: str = Depends(verified_user)):
    return _mutate(deck_id, command, user_id, 'revoke')


@router.patch('/api/decks/{deck_id}/publication/visibility', response_model=PublicationResult)
def set_visibility(deck_id: UUID, command: VisibilityCommand, user_id: str = Depends(verified_user)):
    return _mutate(deck_id, command, user_id, 'visibility')


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
    return _mutate(None, command, user_id, 'revoke', token=token)


@router.patch('/api/publications/{token}/visibility', response_model=PublicationResult)
def set_publication_visibility(token: str, command: VisibilityCommand, user_id: str = Depends(verified_user)):
    return _mutate(None, command, user_id, 'visibility', token=token)


@router.get('/api/public/decks/{token}', response_model=PublicSnapshot)
def public_snapshot(token: str, response: Response):
    response.headers.update(PUBLIC_HEADERS)
    if not TOKEN.fullmatch(token):
        raise HTTPException(404, {'code': 'PUBLISHED_DECK_NOT_FOUND'}, headers=PUBLIC_HEADERS)
    try:
        record = public_projection_store().read_record(token)
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
    for identity in public.identities:
        for edition in identity.editions:
            direct = edition.image_url
            edition.image_url = public_address(edition.printing_ref, 'small', excluded_prefixes=art_route.excluded_prefixes()) or direct
            edition.large_image_url = public_address(edition.printing_ref, 'large', excluded_prefixes=art_route.excluded_prefixes()) or large_direct_url(direct)
    if record['visibility'] == 'listed':
        response.headers['X-Robots-Tag'] = 'index, follow'
    return public
