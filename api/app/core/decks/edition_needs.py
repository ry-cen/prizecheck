"""Read combined Card Edition needs under the caller's shared owner lock."""
from uuid import UUID

from app.copy_allocation import allocate
from app.settings import read_settings

from .needs import allocation_needs


def edition_needs(conn, user_id: str, edition_ids=None) -> dict[UUID, int]:
    """Each given Card Edition's combined need over every Deck of the owner, hidden ones included, under the account's
    counting setting, as combined() counts it. None asks for every Edition the owner's Deck Lists name. An Edition no
    Deck needs is absent. Plain reads only: the caller holds the shared owner lock (social.owners.lock_owners), and
    nothing here takes FOR UPDATE."""
    if edition_ids is None:
        edition_ids = [row['edition_id'] for row in conn.execute(
            'SELECT DISTINCT edition_id FROM deck_list_line WHERE owner_id=%s', (user_id,))]
    wanted = sorted(set(edition_ids))
    if not wanted:
        return {}
    counting = read_settings(conn, user_id).want_list_counting
    return allocation_needs(allocate(conn, user_id, wanted, counting))
