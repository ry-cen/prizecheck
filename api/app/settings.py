"""Account settings (decklist import #207, spec "Settings"): the Want List counting setting, stored on the account so
phone and desktop agree.

The setting lives on the owner row (migration 049) with its own revision, ``settings_revision``. Changing it is an
owner command like a Deck List command: authenticated, idempotent through ``location_command`` and revision-checked
(STALE_SETTINGS). It never moves the inventory revision (``inventory_owner.revision``): a setting is not an inventory
change, so it must not invalidate Decks index cursors, Deck contents captures or Collection's stale check, nor fire the
inventory Undo cleanup trigger (migration 012), which runs only on UPDATE OF revision.

The Deck routes follow the setting from #208 (``copy_allocation``): the Deck detail's ``to_get``, the cost to complete
and Buy missing read it under the owner row lock in the same transaction as the figures, and name it with this
revision, because the inventory and Deck List revisions don't move when it changes.
"""
import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .main import connect, verified_user
from .location_tree import error, owner_and_rows, replay

router = APIRouter(prefix='/api/settings', tags=['settings'])

# **Every Deck built at once** (the default) gives each Spare Copy to one Deck only, oldest Deck first; **One Deck at a
# time** counts every copy outside a Deck for that Deck. Migration 049 checks the same two names.
WantListCounting = Literal['all_at_once', 'one_at_a_time']


class AccountSettings(BaseModel):
    want_list_counting: WantListCounting
    # Advances on every settings command; a command names the revision it read.
    revision: int


class SetWantListCounting(BaseModel):
    want_list_counting: WantListCounting
    revision: int = Field(ge=1)
    idempotency_key: UUID


def read_settings(conn, user_id: str) -> AccountSettings:
    """The account's settings. Call it after ``owner_and_rows``, which creates the owner row and holds its lock."""
    row = conn.execute('SELECT want_list_counting,settings_revision FROM inventory_owner WHERE user_id=%s',
                       (user_id,)).fetchone()
    return AccountSettings(want_list_counting=row['want_list_counting'], revision=row['settings_revision'])


@router.get('', response_model=AccountSettings)
def get_settings(user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        # owner_and_rows onboards a first-time caller (owner row and Unsorted) and takes the owner row lock.
        owner_and_rows(conn, user_id)
        return read_settings(conn, user_id)


@router.put('/want-list-counting', response_model=AccountSettings)
def set_want_list_counting(command: SetWantListCounting, user_id: str = Depends(verified_user)):
    """Change the Want List counting setting. Revision-checked and idempotent; choosing the current value is accepted and
    advances the revision too, as choosing a Deck's current Target Format does."""
    payload = {'action': 'set_want_list_counting', 'want_list_counting': command.want_list_counting,
               'revision': command.revision}
    with connect() as conn, conn.transaction():
        owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, payload)
        if previous:
            return previous
        if read_settings(conn, user_id).revision != command.revision:
            error(409, 'STALE_SETTINGS')
        row = conn.execute("""UPDATE inventory_owner SET want_list_counting=%s,settings_revision=settings_revision+1
          WHERE user_id=%s RETURNING want_list_counting,settings_revision""",
                           (command.want_list_counting, user_id)).fetchone()
        response = AccountSettings(want_list_counting=row['want_list_counting'],
                                   revision=row['settings_revision']).model_dump(mode='json')
        conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                     (user_id, command.idempotency_key, digest, json.dumps(response)))
        return response
