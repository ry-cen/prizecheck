"""Owner-only Borrowed Copy gallery and atomic batch Move (#473).

BORROWED_GALLERY_CAP is 2000 rows. Borrowed rows never enter owned Holdings or counts.
Every borrowed_holding writer locks the borrower's inventory_owner first; loan locks,
when needed, come next, never after borrowed_holding locks. This batch takes no loan lock.
"""
import json
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from .api_errors import api_error
from .collection import (CARD_JOINS, HOLDING_COLUMNS, HOLDING_PATHS, CardCategory,
                         ElementalType, HoldingSort, TrainerType, holding_keys, listing_conditions,
                         listing_snapshot, views)
from .db import connect
from .identity import verified_user
from .inventory_core import first_non_leaf, quantity
from .location_tree import record_response, replay
from .social.owners import advance_revision, ensure_owner, lock_owners

router = APIRouter(prefix='/api/collection/borrowed', tags=['collection'])
BORROWED_GALLERY_CAP = 2000


class BorrowedGalleryView(BaseModel):
    loan_id: UUID
    lender: str
    edition_id: UUID
    location_id: UUID
    location_name: str
    location_path: str
    quantity: str
    printing_id: UUID
    printing_name: str
    set_id: str
    set_name: str
    set_code: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    category: str | None
    elemental_types: list[str]
    trainer_type: str | None


class BorrowedGalleryPage(BaseModel):
    copies: list[BorrowedGalleryView]
    total: str
    owner_revision: int
    catalog_revision: int
    snapshot: str


@router.get('', response_model=BorrowedGalleryPage)
def borrowed_gallery(location_id: UUID | None = None, sort: HoldingSort = 'name-asc',
                     name: str = Query(default='', max_length=120), set_id: str = Query(default='', max_length=80),
                     category: CardCategory | None = None, trainer_type: TrainerType | None = None,
                     elemental_type: ElementalType | None = None, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        owner = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s', (user_id,)).fetchone()
        revision = owner['revision'] if owner else 1
        catalog = conn.execute('SELECT revision FROM catalog_state WHERE singleton').fetchone()['revision']
        attributes = conn.execute('SELECT revision FROM catalog_attribute_state WHERE singleton').fetchone()['revision']
        conditions, params = listing_conditions(name.strip().lower(), set_id.strip(), category, trainer_type, elemental_type)
        if location_id:
            leaf = conn.execute('SELECT kind FROM location WHERE owner_id=%s AND id=%s', (user_id, location_id)).fetchone()
            if not leaf:
                api_error(404, 'LOCATION_NOT_FOUND')
            if leaf['kind'] not in ('storage_leaf', 'deck'):
                api_error(409, 'NOT_STORAGE_LEAF')
            conditions += ' AND h.location_id=%s'
            params.append(location_id)
        columns = HOLDING_COLUMNS.replace('h.version', '0 AS version')
        order = ','.join(f"{key} {'DESC' if down else 'ASC'}" for key, down in holding_keys(sort))
        rows = conn.execute(f'''{HOLDING_PATHS} SELECT * FROM (
          SELECT {columns},h.loan_id,o.lender_name AS lender,lower(o.lender_name) AS lender_key
          FROM borrowed_holding h JOIN location l ON l.id=h.location_id AND l.owner_id=h.borrower_id
          JOIN loan o ON o.id=h.loan_id LEFT JOIN paths lp ON lp.id=h.location_id
          {CARD_JOINS} WHERE h.borrower_id=%s {conditions}) listed
          ORDER BY {order},lender_key,loan_id LIMIT %s''',
                            [user_id, user_id, user_id, *params, BORROWED_GALLERY_CAP + 1]).fetchall()
        if len(rows) > BORROWED_GALLERY_CAP:
            api_error(409, 'TOO_MANY_BORROWED')
        return BorrowedGalleryPage(copies=views(rows, BorrowedGalleryView), total=str(sum(row['quantity'] for row in rows)),
                                   owner_revision=revision, catalog_revision=catalog,
                                   snapshot=listing_snapshot(revision, catalog, attributes))


class BorrowedMoveItem(BaseModel):
    loan_id: UUID
    edition_id: UUID
    from_location_id: UUID
    quantity: str


class MoveBorrowedCopies(BaseModel):
    to_location_id: UUID
    items: list[BorrowedMoveItem] = Field(min_length=1, max_length=500)
    idempotency_key: UUID


class BorrowedMoveResult(BaseModel):
    copy_count: str
    owner_revision: int


@router.post('/moves', response_model=BorrowedMoveResult)
def move_borrowed_copies(command: MoveBorrowedCopies, user_id: str = Depends(verified_user)):
    items = command.items
    parsed = [quantity(item.quantity) for item in items]
    keys = [(item.loan_id, item.from_location_id, item.edition_id) for item in items]
    if len(set(keys)) != len(keys):
        api_error(422, 'DUPLICATE_MOVE_ITEM')
    if any(item.from_location_id == command.to_location_id for item in items):
        api_error(422, 'SAME_LOCATION')
    payload = {'action': 'move_borrowed_batch', **command.model_dump(mode='json', exclude={'idempotency_key'})}
    with connect() as conn, conn.transaction():
        ensure_owner(conn, user_id)
        lock_owners(conn, user_id)
        digest, stored = replay(conn, user_id, command.idempotency_key, payload)
        if stored is not None:
            return stored
        if first_non_leaf(conn, user_id, [command.to_location_id]) is not None:
            api_error(404, 'LOCATION_NOT_FOUND')
        sources = conn.execute('''SELECT b.loan_id,b.location_id,b.edition_id,b.quantity
          FROM jsonb_to_recordset(%s::jsonb) i(loan_id uuid,from_location_id uuid,edition_id uuid,quantity text)
          JOIN borrowed_holding b ON (b.loan_id,b.location_id,b.edition_id)=(i.loan_id,i.from_location_id,i.edition_id)
          AND b.borrower_id=%s ORDER BY b.loan_id,b.location_id,b.edition_id FOR UPDATE OF b''',
                               (json.dumps(payload['items']), user_id)).fetchall()
        held = {(row['loan_id'], row['location_id'], row['edition_id']): row['quantity'] for row in sources}
        for item, key, count in zip(items, keys, parsed):
            if held.get(key, 0) < count:
                api_error(409, 'NOT_ENOUGH_BORROWED', loan_id=item.loan_id, edition_id=item.edition_id,
                          from_location_id=item.from_location_id)
        for key, count in sorted(zip(keys, parsed)):
            loan, source, edition = key
            if held[key] == count:
                conn.execute('DELETE FROM borrowed_holding WHERE loan_id=%s AND location_id=%s AND edition_id=%s', key)
            else:
                conn.execute('UPDATE borrowed_holding SET quantity=quantity-%s '
                             'WHERE loan_id=%s AND location_id=%s AND edition_id=%s', (count, *key))
            conn.execute('''INSERT INTO borrowed_holding AS b(loan_id,borrower_id,location_id,edition_id,quantity)
              VALUES (%s,%s,%s,%s,%s) ON CONFLICT (loan_id,location_id,edition_id)
              DO UPDATE SET quantity=b.quantity+EXCLUDED.quantity''',
                         (loan, user_id, command.to_location_id, edition, count))
        advance_revision(conn, user_id)
        revision = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s', (user_id,)).fetchone()['revision']
        answer = BorrowedMoveResult(copy_count=str(sum(parsed)), owner_revision=revision).model_dump(mode='json')
        record_response(conn, user_id, command.idempotency_key, digest, answer)
        return answer
