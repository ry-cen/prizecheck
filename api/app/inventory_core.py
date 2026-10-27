"""Inventory mutation helpers with no routes, shared by the commands that change a Collection: Moves and Removals
(``moves.py``), batch add (``holdings.py``), Pick List confirmation, scanner save, Trade swaps, Loan handovers and
Deck deletion. They run in the caller's transaction and, but for ``lock_owner``, assume the caller holds the owner lock.
Every command that can be undone writes its one Inventory Undo record through ``record_undo``; an owner keeps their
newest ``UNDO_LIMIT`` records, and only the newest can be undone.
"""
from uuid import NAMESPACE_URL, UUID, uuid5

from .api_errors import api_error
from .social import counts

MAX_QUANTITY = 2**63 - 1
# Inventory Undo keeps this many records per owner, newest first (the five-record limit).
UNDO_LIMIT = 5


def quantity(raw: str) -> int:
    if not raw or not raw.isascii() or not raw.isdecimal() or len(raw) > 19:
        api_error(422, "INVALID_QUANTITY")
    value = int(raw)
    if value < 1 or value > MAX_QUANTITY:
        api_error(422, "INVALID_QUANTITY")
    return value


def undo_id_for(user_id: str, key: UUID) -> UUID:
    """The id of the Undo record a Move or Removal with this idempotency key creates. It is derived, not
    stored, so a replay reports it without a migration; the owner in the name keeps ids apart across owners."""
    return uuid5(NAMESPACE_URL, f"prizecheck:inventory-undo:{user_id}:{key}")


def record_undo(conn, user_id: str, undo_id: UUID, action: str, destination_id: UUID | None, sources: list,
                payload: str, returns_as_surplus: bool = False):
    """Writes one Inventory Undo record in the caller's transaction and keeps this owner's newest UNDO_LIMIT, after
    dropping expired ones.

    `payload` is the record's items as JSON text, with quantities as text so no JSON reader rounds them. A Move or
    Removal names each item's source, ``{source_id, edition_id, quantity}``, and `sources` lists the distinct
    sources: the record's source_id is set only for a single source, so readers from before migration 026 treat a
    multi-source record as incompatible. An add (migration 046) has no sources: its items are
    ``{edition_id, quantity}``, source_id is NULL, source_count 0, and `destination_id` is the Location the copies
    went to. `returns_as_surplus` marks a Put away (migration 047): undoing it returns the copies to their Deck
    without covering them on its Deck List."""
    conn.execute("DELETE FROM inventory_undo WHERE owner_id=%s AND expires_at<=clock_timestamp()", (user_id,))
    conn.execute("""INSERT INTO inventory_undo(id,owner_id,action,source_id,destination_id,source_count,payload,
        returns_as_surplus) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s)""",
                 (undo_id, user_id, action, sources[0] if len(sources) == 1 else None, destination_id, len(sources),
                  payload, returns_as_surplus))
    conn.execute("""DELETE FROM inventory_undo WHERE owner_id=%s AND id NOT IN
      (SELECT id FROM inventory_undo WHERE owner_id=%s ORDER BY created_at DESC,id DESC LIMIT %s)""",
                 (user_id, user_id, UNDO_LIMIT))


def check_promises(conn, user_id: str, losing: dict) -> None:
    """Refuses with 409 when taking ``losing`` copies ({Edition id: copies}) out of the owner's Collection would leave
    fewer copies of an Edition than open Loans and Trades promise (``counts.reserved_counts``; spec "Lender-side data",
    trading #268): PROMISED_TO_TRADE when an open Trade promises some of that Edition's copies
    (``counts.trade_reserved_counts``), otherwise PROMISED_TO_LOAN. The detail names the lowest such Edition and how
    many copies are promised, Loans and Trades together. Inventory Removal, the Undo of an add and Edition reassignment
    call it under the owner lock before they write; Moves don't, because where a copy is doesn't matter to a promise.
    The deferred triggers of migrations 106 and 142 are the backstop."""
    editions = sorted(edition for edition, copies in losing.items() if copies > 0)
    promised = counts.reserved_counts(conn, user_id, editions) if editions else {}
    if not promised:
        return
    held = {row['edition_id']: row['copies'] for row in conn.execute(
        'SELECT edition_id,sum(quantity) AS copies FROM holding WHERE owner_id=%s AND edition_id=ANY(%s) GROUP BY edition_id',
        (user_id, sorted(promised)))}
    for edition in sorted(promised):
        if held.get(edition, 0) - losing[edition] < promised[edition]:
            traded = counts.trade_reserved_counts(conn, user_id, [edition]).get(edition, 0)
            api_error(409, 'PROMISED_TO_TRADE' if traded > 0 else 'PROMISED_TO_LOAN', edition_id=edition,
                      promised=promised[edition])


class HoldingShort(RuntimeError):
    """``take_out`` found a Holding with fewer copies than its caller checked were there: a bug, never a refusal."""


def take_out(conn, user_id: str, items: list[tuple[UUID, UUID, int]], revision: int) -> int:
    """Takes copies out of the owner's Holdings, ``items`` as (Location id, Edition id, copies), with no destination and
    no Inventory Undo record: a lender's handover (social network #253), whose copies then sit in no Location. The
    writes are a Removal's. The caller holds the owner lock, read ``revision`` under it and checked every Holding holds
    its copies; ``items`` name each (Location, Edition) once. A Holding short of its copies raises ``HoldingShort``
    rather than leave it as it was, so the caller's transaction rolls back. Returns the owner's new revision, which the
    changed Holdings take as their version."""
    new_revision = revision + 1
    for location, edition, copies in items:
        changed = conn.execute('DELETE FROM holding WHERE owner_id=%s AND location_id=%s AND edition_id=%s '
                               'AND quantity=%s', (user_id, location, edition, copies)).rowcount
        if not changed:
            changed = conn.execute('UPDATE holding SET quantity=quantity-%s,version=%s '
                                   'WHERE owner_id=%s AND location_id=%s AND edition_id=%s AND quantity>%s',
                                   (copies, new_revision, user_id, location, edition, copies)).rowcount
        if changed != 1:
            raise HoldingShort(f'Holding ({location}, {edition}) holds fewer than {copies} copies')
    conn.execute('UPDATE inventory_owner SET revision=%s WHERE user_id=%s', (new_revision, user_id))
    return new_revision


def put_back(conn, user_id: str, items: list[tuple[UUID, UUID, int]], revision: int) -> int:
    """Puts copies back into the owner's Holdings, ``items`` as (Storage Leaf id, Edition id, copies), with no Inventory
    Undo record: taking back a lender's handover (#253), and from #255 a lender's return. Copies returning to a Deck come
    back as surplus, as a Put away's Undo does (migration 047): no Deck List line changes. The caller holds the owner
    lock, read ``revision`` under it and checked every Location is one of the owner's Storage Leaves. Returns the new
    revision."""
    new_revision = revision + 1
    conn.execute("SELECT set_config('tcg.undo_returns_surplus','on',true)")
    for location, edition, copies in items:
        conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,%s,%s) '
                     'ON CONFLICT(owner_id,location_id,edition_id) DO UPDATE '
                     'SET quantity=holding.quantity+excluded.quantity,version=excluded.version',
                     (user_id, location, edition, copies, new_revision))
    conn.execute("SELECT set_config('tcg.undo_returns_surplus','off',true)")
    conn.execute('UPDATE inventory_owner SET revision=%s WHERE user_id=%s', (new_revision, user_id))
    return new_revision


def add_in(conn, user_id: str, location_id: UUID, items: list[tuple[UUID, int]], new_revision: int) -> None:
    """Adds newly owned copies to one of the owner's Storage Leaves or Decks, ``items`` as (Edition id, copies), with no
    Inventory Undo record: the cards a Trade's Confirm swap brings in (Trading #272). It is ``put_back``'s Holding
    upsert without the surplus setting, so copies arriving in a Deck raise its Deck List lines as an Add does (migrations
    031 and 047). The caller holds the owner lock, checked ``location_id`` is one of the owner's Storage Leaves or Decks
    (``leaf``) and names each Edition once; ``new_revision`` is the revision the step moves to (``take_out``'s answer
    when the same step took copies out, else the revision it read plus one), which the changed Holdings take as their
    version, so the step advances the owner's revision exactly once."""
    for edition, copies in items:
        conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,%s,%s) '
                     'ON CONFLICT(owner_id,location_id,edition_id) DO UPDATE '
                     'SET quantity=holding.quantity+excluded.quantity,version=excluded.version',
                     (user_id, location_id, edition, copies, new_revision))
    conn.execute('UPDATE inventory_owner SET revision=%s WHERE user_id=%s', (new_revision, user_id))


def lock_owner(conn, user_id: str):
    conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user_id,))
    return conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE", (user_id,)).fetchone()["revision"]


def is_deck(conn, user_id: str, location_id: UUID) -> bool:
    return bool(conn.execute("SELECT 1 FROM location WHERE owner_id=%s AND id=%s AND kind='deck'",
                             (user_id, location_id)).fetchone())


def leaf(conn, user_id: str, location_id: UUID) -> bool:
    return bool(conn.execute("""SELECT 1 FROM location l WHERE l.owner_id=%s AND l.id=%s
      AND l.kind IN ('storage_leaf','deck')
      AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id=l.id)""",
                             (user_id, location_id)).fetchone())


def first_non_leaf(conn, user_id: str, location_ids: list) -> UUID | None:
    """The lowest of these IDs that is not one of this owner's Storage Leaves, or None."""
    row = conn.execute("""SELECT s.id FROM unnest(%s::uuid[]) AS s(id)
      WHERE NOT EXISTS (SELECT 1 FROM location l WHERE l.owner_id=%s AND l.id=s.id
        AND l.kind IN ('storage_leaf','deck')
        AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id=l.id))
      ORDER BY s.id LIMIT 1""", (location_ids, user_id)).fetchone()
    return row["id"] if row else None


REPLAY = """SELECT mr.command_digest,mr.result_revision,r.edition_count,r.copy_count,
    r.source_count,r.already_at_destination_count
  FROM mutation_request mr LEFT JOIN move_response r
    ON r.owner_id=mr.owner_id AND r.request_key=mr.request_key
  WHERE mr.owner_id=%s AND mr.request_key=%s"""
