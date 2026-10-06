"""Physical Decks and deliberately limited construction checks."""
from uuid import UUID, uuid4
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from .main import connect, verified_user
from .location_tree import (TreeNode, LocationCommandResult, cleaned_name, owner_and_rows,
                            replay, check_name, store_result, error, node_model)

router = APIRouter(prefix='/api/decks', tags=['decks'])
DISCLAIMER = 'Standard eligibility, rotation, bans, and special card rules are not evaluated.'


class CreateDeck(BaseModel):
    name: str
    idempotency_key: UUID


class DeckIndex(BaseModel):
    decks: list[TreeNode]
    owner_revision: int


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


@router.get('', response_model=DeckIndex)
def deck_index(user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        revision, rows = owner_and_rows(conn, user_id)
        return DeckIndex(decks=[node_model(row, rows) for row in sorted(rows.values(), key=lambda r: (r['name'].casefold(), str(r['id'])))
                                if row['kind'] == 'deck'], owner_revision=revision)


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
        total = sum(int(group['quantity']) for group in groups)
        identities = [IdentityCheck(identity_id=g['id'], name=g['display_name'], quantity=str(g['quantity']),
                      status='basic_energy_exempt' if g['exempt'] else 'unresolved' if g['unresolved']
                      else 'over_limit' if g['quantity'] > 4 else 'within_limit') for g in groups]
        return DeckDetail(deck=node_model(deck, rows), owner_revision=revision, catalog_revision=state['revision'],
             checks=DeckChecks(total=str(total), shortage=str(max(0, 60-total)), excess=str(max(0, total-60)),
                               size_status='complete' if total == 60 else 'shortage' if total < 60 else 'excess', identities=identities))
