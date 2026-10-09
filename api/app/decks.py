"""Physical Decks and deliberately limited construction checks."""
import base64
import hashlib
import hmac
import json
import os
from uuid import UUID, uuid4
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from .main import connect, verified_user
from .location_tree import (TreeNode, LocationCommandResult, cleaned_name, owner_and_rows,
                            replay, check_name, store_result, error, node_model)

router = APIRouter(prefix='/api/decks', tags=['decks'])
from .construction_checks import DISCLAIMER, IdentityCount, evaluate_checks


class CreateDeck(BaseModel):
    name: str
    idempotency_key: UUID


class DeckIndex(BaseModel):
    decks: list[TreeNode]
    owner_revision: int
    next_cursor: str | None


class IdentityCheck(BaseModel):
    identity_id: UUID
    name: str
    quantity: str
    status: str


class DeckChecks(BaseModel):
    total: str
    shortage: str
    excess: str
    size_status: str
    identities: list[IdentityCheck]
    disclaimer: str = DISCLAIMER


class DeckEditionQuantity(BaseModel):
    edition_id: UUID
    quantity: str


class DeckContents(BaseModel):
    editions: list[DeckEditionQuantity]
    owner_revision: int
    catalog_revision: int


class DeckDetail(BaseModel):
    deck: TreeNode
    checks: DeckChecks
    owner_revision: int
    catalog_revision: int


@router.post('', response_model=LocationCommandResult, status_code=201)
def create_deck(command: CreateDeck, user_id: str = Depends(verified_user)):
    name = cleaned_name(command.name)
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key,
                                 {'action': 'create_deck', **command.model_dump(mode='json')})
        if previous:
            return previous
        check_name(name, None, rows)
        row = conn.execute("""INSERT INTO location(id,owner_id,name,kind)
          VALUES (%s,%s,%s,'deck') RETURNING id,name,kind,parent_id,version""",
          (uuid4(), user_id, name)).fetchone()
        rows[row['id']] = row
        return store_result(conn, user_id, command.idempotency_key, digest, row, rows)


def deck_cursor_encode(user_id, revision, row):
    payload = json.dumps({'v': 1, 'u': user_id, 'r': revision,
                          'k': [row['sort_name'], str(row['id'])]}, separators=(',', ':')).encode()
    mac = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + mac).decode().rstrip('=')


def deck_cursor_decode(token, user_id, revision):
    try:
        if len(token) > 2048:
            raise ValueError()
        raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
        payload, mac = raw[:-32], raw[-32:]
        expected = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, expected):
            raise ValueError()
        data = json.loads(payload)
        if data['v'] != 1 or data['u'] != user_id or not isinstance(data['r'], int):
            raise ValueError()
        if data['r'] != revision:
            error(409, 'INVENTORY_CHANGED')
        if len(data['k']) != 2 or not isinstance(data['k'][0], str):
            raise ValueError()
        return data['k'][0], UUID(data['k'][1])
    except (ValueError, KeyError, TypeError):
        error(400, 'INVALID_CURSOR')


@router.get('', response_model=DeckIndex)
def deck_index(cursor: str | None = None, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        created = conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING RETURNING user_id', (user_id,)).fetchone()
        revision = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE', (user_id,)).fetchone()['revision']
        if created:
            conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Unsorted','storage_leaf')", (uuid4(),user_id))
        key = deck_cursor_decode(cursor, user_id, revision) if cursor else None
        after = 'AND (lower(name),id) > (%s,%s)' if key else ''
        page = conn.execute(f"""SELECT id,name,kind,parent_id,version,lower(name) AS sort_name
          FROM location WHERE owner_id=%s AND kind='deck' {after}
          ORDER BY lower(name),id LIMIT 31""", (user_id, *key) if key else (user_id,)).fetchall()
        # Read ancestors for only the bounded page, preserving nested Deck depth.
        depths = {row['id']: row['depth'] for row in conn.execute("""WITH RECURSIVE ancestors AS (
          SELECT id AS deck_id,id,parent_id,1 AS depth FROM location WHERE owner_id=%s AND id=ANY(%s)
          UNION ALL SELECT a.deck_id,l.id,l.parent_id,a.depth+1 FROM location l JOIN ancestors a ON l.id=a.parent_id
          WHERE l.owner_id=%s AND a.depth<12)
          SELECT deck_id AS id,max(depth) AS depth FROM ancestors GROUP BY deck_id""",
          (user_id, [row['id'] for row in page[:30]],user_id)).fetchall()}
        return DeckIndex(decks=[TreeNode(**row,depth=depths[row['id']]) for row in page[:30]], owner_revision=revision,
                         next_cursor=deck_cursor_encode(user_id, revision, page[29]) if len(page)>30 else None)


@router.get('/{deck_id}', response_model=DeckDetail)
def deck_detail(deck_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        revision, rows = owner_and_rows(conn, user_id)
        deck = rows.get(deck_id)
        if not deck or deck['kind'] != 'deck':
            error(404, 'DECK_NOT_FOUND')
        state = conn.execute('SELECT active_generation,revision FROM catalog_state WHERE singleton FOR SHARE').fetchone()
        groups = conn.execute("""SELECT ci.id,ci.display_name,sum(h.quantity) AS quantity,
          bool_and(coalesce(gp.basic_energy,'unresolved')='supported') AS exempt,
          bool_or(coalesce(gp.basic_energy,'unresolved')='unresolved') AS unresolved
          FROM holding h JOIN catalog_edition e ON e.id=h.edition_id
          JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_identity ci ON ci.id=p.identity_id
          LEFT JOIN catalog_generation_printing gp ON gp.printing_id=p.id AND gp.generation_id=%s
          WHERE h.owner_id=%s AND h.location_id=%s GROUP BY ci.id,ci.display_name
          ORDER BY ci.display_name,ci.id""", (state['active_generation'], user_id, deck_id)).fetchall()
        evaluated = evaluate_checks([IdentityCount(int(g['quantity']),g['exempt'],g['unresolved']) for g in groups])
        identities = [IdentityCheck(identity_id=g['id'],name=g['display_name'],quantity=str(g['quantity']),status=status)
                      for g,status in zip(groups,evaluated.identity_statuses)]
        return DeckDetail(deck=node_model(deck, rows), owner_revision=revision, catalog_revision=state['revision'],
             checks=DeckChecks(total=str(evaluated.total),shortage=str(evaluated.shortage),excess=str(evaluated.excess),
                               size_status=evaluated.size_status,identities=identities))


def capture_deck_contents(deck_id: UUID, user_id: str) -> DeckContents:
    """Detach a complete inventory capture before any pricing/export source work.

    Inventory writers serialize on the owner row, so the revision and every
    Edition quantity belong to the same committed inventory state. Catalog
    activation is fenced separately for the captured catalog revision.
    """
    with connect() as conn, conn.transaction():
        revision, rows = owner_and_rows(conn, user_id)
        deck = rows.get(deck_id)
        if not deck or deck['kind'] != 'deck':
            error(404, 'DECK_NOT_FOUND')
        catalog_revision = conn.execute(
            'SELECT revision FROM catalog_state WHERE singleton FOR SHARE'
        ).fetchone()['revision']
        holdings = conn.execute("""SELECT edition_id,quantity FROM holding
          WHERE owner_id=%s AND location_id=%s ORDER BY edition_id""",
          (user_id, deck_id)).fetchall()
        contents = DeckContents(
            editions=[DeckEditionQuantity(edition_id=row['edition_id'], quantity=str(row['quantity']))
                      for row in holdings],
            owner_revision=revision, catalog_revision=catalog_revision)
    # Both transaction locks and the connection are released before callers can wait.
    return contents


@router.get('/{deck_id}/contents', response_model=DeckContents)
def deck_contents(deck_id: UUID, user_id: str = Depends(verified_user)):
    return capture_deck_contents(deck_id, user_id)
