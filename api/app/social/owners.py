"""Owner rows for steps that touch two collectors (spec "Locks and revisions").

The global lock order is ``inventory_owner`` rows in ascending ``user_id``, then the ``loan`` row (#252). Ascending
means byte order, what Python's ``sorted()`` gives for account ids and what ``COLLATE "C"`` gives in PostgreSQL;
``friendship.user_low`` uses the same order. Every route that touches two owners calls ``lock_owners`` before it reads
anything about the pair: Friend Requests and Remove Friend (#247), Block and Unblock (#248), and the Loan steps from
#252, which import it from here.
"""
from uuid import uuid4


def ensure_owner(conn, user_id: str) -> None:
    """Makes the collector's ``inventory_owner`` row (and with it their profile and Unsorted) when this is their first
    request, as ``location_tree.owner_and_rows`` does, without locking a row that already exists."""
    created = conn.execute('INSERT INTO inventory_owner (user_id) VALUES (%s) ON CONFLICT DO NOTHING RETURNING user_id',
                           (user_id,)).fetchone()
    if created:
        conn.execute("INSERT INTO location(id,owner_id,parent_id,name,kind) VALUES (%s,%s,NULL,'Unsorted','storage_leaf')",
                     (uuid4(), user_id))


def lock_owners(conn, *user_ids: str) -> None:
    """Locks the owners' ``inventory_owner`` rows one at a time in ascending ``user_id``, so two steps over the same
    pair, started from either side, never wait on each other in a cycle. An id with no row locks nothing."""
    for user_id in sorted(set(user_ids)):
        conn.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE', (user_id,))
