"""Owner rows for steps that touch two collectors (spec "Locks and revisions").

The global lock order is ``inventory_owner`` rows in ascending ``user_id``, then the ``loan`` row (#252). Ascending
means byte order, what Python's ``sorted()`` gives for account ids and what ``COLLATE "C"`` gives in PostgreSQL;
``friendship.user_low`` uses the same order. Every route that touches two owners calls ``lock_owners`` before it reads
anything about the pair: Friend Requests and Remove Friend (#247), Block and Unblock (#248), and the Loan steps from
#252, which import it from here. The owner's inventory revision (``advance_revision``) and the start every Loan and
Trade command shares (``begin_owner_command``) are owner facts too, so they live here.
"""
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg import sql

from ..location_tree import replay

COMMANDS_PER_HOUR = 120
# A column value a step's ``apply`` returns for the transaction's time (``loans.run_step``, ``trades.run_trade_step``).
NOW = sql.SQL('now()')


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
    pair, started from either side, never wait on each other in a cycle. An id with no row locks nothing.

    The mode is ``FOR NO KEY UPDATE``: it waits on, and holds off, every other owner lock and every write of the row,
    as ``FOR UPDATE`` would, but not the ``FOR KEY SHARE`` a foreign key check takes. Rows that name this owner are
    written by the other collector's commands too (a Borrow Request inserts a ``loan`` row naming its lender), and
    their key checks must never wait on a step here. A Loan step writes its ``loan`` row once (``loans.run_step``):
    a second write in one transaction makes PostgreSQL check both collectors' keys again, which key-shares the other
    collector's row after this step's own locks and closed cycles with that collector's two-owner steps and with
    their Deck deletion (#253). Keep this mode, and keep the one write."""
    for user_id in sorted(set(user_ids)):
        conn.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR NO KEY UPDATE', (user_id,))


def advance_revision(conn, owner_id: str | None) -> None:
    """Moves the owner's inventory revision on, for a step that changes what is reserved of their copies."""
    if owner_id is not None:
        conn.execute('UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s', (owner_id,))


def count_owner_command(conn, user_id: str, kind: str) -> None:
    """Counts one Loan or Trade step (``kind``: 'loan_command' or 'trade_command') against the hourly limit: rows older
    than an hour pruned, and 429 TOO_MANY_CHANGES with ``retry_after_minutes`` at the limit. The caller holds the
    collector's command lock and has answered a replay."""
    conn.execute("""DELETE FROM handle_lookup_event
      WHERE user_id=%s AND kind=%s AND created_at < now() - interval '1 hour'""", (user_id, kind))
    recent = conn.execute("""SELECT count(*) AS commands, min(created_at) AS oldest FROM handle_lookup_event
      WHERE user_id=%s AND kind=%s""", (user_id, kind)).fetchone()
    if recent['commands'] >= COMMANDS_PER_HOUR:
        wait = conn.execute("SELECT ceil(extract(epoch FROM %s + interval '1 hour' - now()) / 60) AS wait",
                            (recent['oldest'],)).fetchone()['wait']
        raise HTTPException(429, {'code': 'TOO_MANY_CHANGES', 'retry_after_minutes': max(1, int(wait))})
    conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,%s)", (user_id, kind))


def begin_owner_command(conn, user_id: str, key: UUID, payload: dict, kind: str):
    """The start every Loan and Trade command shares: the caller's owner row made if new, the caller's commands of
    this ``kind`` ('loan' or 'trade') one at a time under an advisory lock of their own, a replay answered from the
    caller's record, else the command counted (under 'loan_command' or 'trade_command', apart from the Friend
    commands' count). Returns (digest, stored response or None)."""
    ensure_owner(conn, user_id)
    conn.execute(f"SELECT pg_advisory_xact_lock(hashtext('prizecheck.{kind}_command:' || %s))", (user_id,))
    digest, stored = replay(conn, user_id, key, payload)
    if stored is None:
        count_owner_command(conn, user_id, f'{kind}_command')
    return digest, stored
