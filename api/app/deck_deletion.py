"""Delete a Deck (Deck Lists 10, ADR 0009).

Deleting a Deck never deletes cards. In one transaction every Holding in the Deck moves to the collector's root Unsorted
Storage Leaf, merging into the Holdings Unsorted already has, and then the Deck and its Deck List are deleted. The
Deck's publications lose their link to it (migration 032) and stay live. Other Locations still delete only when empty,
through the Location tree route, which keeps refusing Decks.

The command is idempotent and confirmed like a Location delete, by the Deck's name and version. It advances the inventory
revision once, and the copies it moves take that revision as their Holding version, as a Move's do.

It records no undo entry. Undo returns copies to the Location they came from, and that Deck, with its Deck List, no longer
exists; Location deletes are not undoable either. Earlier Move undo entries that name the Deck answer UNDO_INCOMPATIBLE,
as they do for any deleted Location.
"""
import json
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .location_tree import cleaned_name, error, owner_and_rows, replay
from .db import connect
from .identity import verified_user
from .inventory_core import MAX_QUANTITY
from .social import counts

router = APIRouter(prefix='/api/decks', tags=['decks'])


class DeleteDeck(BaseModel):
    name: str
    version: int = Field(ge=1)
    idempotency_key: UUID


class DeleteDeckResult(BaseModel):
    deleted_id: UUID
    # The root Unsorted Storage Leaf that received the Deck's Holdings; null when the Deck held no cards.
    unsorted_id: UUID | None
    edition_count: int
    copy_count: str
    owner_revision: int


def unsorted_leaf(conn, user_id: str, rows, deck_id: UUID) -> UUID:
    """The collector's root Unsorted Storage Leaf, created when the collector has none.

    An empty root Unsorted can be deleted, renamed or given children, so it may be missing or be an Organizational
    Location, and a Deck created meanwhile may have taken the name. Root names are unique without regard to case or
    surrounding spaces, so at most one root can match. The Deck being deleted gives the name up first (it is deleted in
    this same transaction); any other Location holding the name that cannot hold cards refuses the deletion.
    """
    named = [row for row in rows.values() if row['parent_id'] is None and row['name'].strip().lower() == 'unsorted']
    if named and named[0]['id'] == deck_id:
        conn.execute('UPDATE location SET name=%s WHERE owner_id=%s AND id=%s', (str(deck_id), user_id, deck_id))
    elif named:
        if named[0]['kind'] != 'storage_leaf':
            error(409, 'UNSORTED_UNAVAILABLE')
        return named[0]['id']
    return conn.execute("""INSERT INTO location(id,owner_id,parent_id,name,kind)
      VALUES (%s,%s,NULL,'Unsorted','storage_leaf') RETURNING id""", (uuid4(), user_id)).fetchone()['id']


@router.delete('/{deck_id}', response_model=DeleteDeckResult)
def delete_deck(deck_id: UUID, command: DeleteDeck, user_id: str = Depends(verified_user)):
    name = cleaned_name(command.name)
    try:
        with connect() as conn, conn.transaction():
            # The owner lock (owner_and_rows) comes first and serializes this with every inventory and Deck List command
            # and with every publication command, which take it first too (publications.mutate).
            revision, rows = owner_and_rows(conn, user_id)
            # Replay comes first: after the first success the Deck no longer exists.
            digest, previous = replay(conn, user_id, command.idempotency_key,
                                      {'action': 'delete_deck', 'deck_id': str(deck_id), **command.model_dump(mode='json')})
            if previous:
                return previous
            deck = rows.get(deck_id)
            if deck is None or deck['kind'] != 'deck':
                error(404, 'DECK_NOT_FOUND')
            if deck['version'] != command.version:
                error(409, 'STALE_LOCATION')
            if deck['name'] != name:
                error(409, 'LOCATION_NAME_CONFIRMATION_MISMATCH')
            new_revision = revision + 1
            held = conn.execute("""SELECT count(*) AS editions,coalesce(sum(quantity),0) AS copies
              FROM holding WHERE owner_id=%s AND location_id=%s""", (user_id, deck_id)).fetchone()
            unsorted_id = None
            borrowed = conn.execute('SELECT 1 FROM borrowed_holding WHERE borrower_id=%s AND location_id=%s LIMIT 1',
                                    (user_id, deck_id)).fetchone()
            if borrowed:
                # Borrowed Copies go to Unsorted too, still borrowed (social network #253).
                unsorted_id = unsorted_leaf(conn, user_id, rows, deck_id)
                conn.execute('''INSERT INTO borrowed_holding AS u (loan_id,borrower_id,location_id,edition_id,quantity)
                  SELECT d.loan_id,d.borrower_id,%s,d.edition_id,d.quantity FROM borrowed_holding d
                  WHERE d.borrower_id=%s AND d.location_id=%s
                  ON CONFLICT (loan_id,location_id,edition_id) DO UPDATE SET quantity=u.quantity+EXCLUDED.quantity''',
                             (unsorted_id, user_id, deck_id))
                conn.execute('DELETE FROM borrowed_holding WHERE borrower_id=%s AND location_id=%s', (user_id, deck_id))
            if held['editions']:
                unsorted_id = unsorted_id or unsorted_leaf(conn, user_id, rows, deck_id)
                if conn.execute("""SELECT 1 FROM holding d JOIN holding u
                    ON u.owner_id=d.owner_id AND u.location_id=%s AND u.edition_id=d.edition_id
                  WHERE d.owner_id=%s AND d.location_id=%s AND u.quantity>%s-d.quantity LIMIT 1""",
                                (unsorted_id, user_id, deck_id, MAX_QUANTITY)).fetchone():
                    error(409, 'QUANTITY_OVERFLOW')
                # Unsorted is not a Deck, so migration 031's holding triggers leave every Deck List alone here.
                conn.execute("""INSERT INTO holding AS u (owner_id,location_id,edition_id,quantity,version)
                  SELECT d.owner_id,%s,d.edition_id,d.quantity,%s FROM holding d WHERE d.owner_id=%s AND d.location_id=%s
                  ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE
                    SET quantity=u.quantity+EXCLUDED.quantity,version=EXCLUDED.version""",
                             (unsorted_id, new_revision, user_id, deck_id))
                conn.execute('DELETE FROM holding WHERE owner_id=%s AND location_id=%s', (user_id, deck_id))
                # Loan picks follow the copies they take, so a promise still names where its copies are.
                counts.move_picks(conn, user_id, deck_id, unsorted_id)
            # The Deck List and its lines and any Move selection staged from the Deck cascade; publications are unlinked.
            conn.execute('DELETE FROM location WHERE owner_id=%s AND id=%s', (user_id, deck_id))
            parent_id = deck['parent_id']
            if parent_id is not None:
                # Decks are created at the root; a nested one leaves its parent as delete_location does.
                last_child = not any(row['parent_id'] == parent_id and row['id'] != deck_id for row in rows.values())
                conn.execute('UPDATE location SET kind=%s,version=version+1 WHERE owner_id=%s AND id=%s',
                             ('storage_leaf' if last_child else 'organization', user_id, parent_id))
            conn.execute('UPDATE inventory_owner SET revision=%s WHERE user_id=%s', (new_revision, user_id))
            result = DeleteDeckResult(deleted_id=deck_id, unsorted_id=unsorted_id, edition_count=held['editions'],
                                      copy_count=str(held['copies']), owner_revision=new_revision).model_dump(mode='json')
            conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                         (user_id, command.idempotency_key, digest, json.dumps(result)))
            return result
    except psycopg.Error:
        # A lock wait the database ends (such as a deadlock with an older runtime's publication command during a
        # release) leaves nothing changed; the same request can be retried.
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')
