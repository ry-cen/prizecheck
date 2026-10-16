"""What Loans take out of a collector's own figures, per Card Edition (spec "Module boundary"). Inventory code calls
these and never imports Loan logic.

``reserved_counts`` (one owner, under that owner's lock) and ``reserved_by_owner`` (several owners at once, for the
Friend reads of ``friend_copies``, #250) read the copies open Loans promise and the lender hasn't handed over: the lines
of accepted Borrow Requests and sent Lend Offers, through migration 106's ``reserved_copies``, the same definition the
deferred invariant checks. ``reserved_picks`` says where the lender plans to take those copies from (the Loan Pick
List), so the copy allocation leaves the picked copies out of what it offers; ``deck_loan_picks`` names the borrowers a
Deck's picked copies are reserved for. ``move_picks`` is the one Loan write inventory code makes: when Deck deletion or
leaf conversion moves a Location's Holdings, the picks that name it move with them. ``lent_counts`` and
``borrowed_in`` join these in #253 and #254.

Nothing here reads another collector's inventory, and nothing names a Location to anyone but its owner.
"""
from collections.abc import Iterable
from uuid import UUID

# The Loans whose promised copies are still reserved (migration 105's loan_reserving index).
RESERVING = "o.state IN ('offered','accepted') AND o.lender_handover_at IS NULL"


def reserved_counts(conn, owner_id: str, edition_ids: Iterable[UUID]) -> dict[UUID, int]:
    """Copies of each Edition the owner has promised to open Loans and not yet handed over (sent Lend Offers and
    accepted Borrow Requests). Editions with none are absent, so read it with ``.get(edition, 0)``. The caller holds the
    owner row lock. Call it as ``counts.reserved_counts(...)`` through the module, never a from-import, so one patch of
    the module attribute reaches every caller."""
    editions = sorted(set(edition_ids))
    if not editions:
        return {}
    return {row['edition_id']: int(row['reserved']) for row in conn.execute(
        'SELECT edition_id, reserved FROM reserved_copies(%s::text[], %s::uuid[])', ([owner_id], editions))}


def reserved_by_owner(conn, owner_ids: Iterable[str], edition_ids: Iterable[UUID] | None = None
                      ) -> dict[tuple[str, UUID], int]:
    """``reserved_counts`` for several owners at once: copies reserved, by (owner id, Edition id), for the given Editions
    or, with None, every Edition. Pairs with none are absent. One read for any number of owners, never one per owner
    (``friend_copies`` asks for all of a viewer's Friends at once). Takes no lock: a Friend read never waits on a
    Friend's writes. Call it through the module (``counts.reserved_by_owner``), as ``reserved_counts``."""
    owners = sorted(set(owner_ids))
    if not owners:
        return {}
    editions = None if edition_ids is None else sorted(set(edition_ids))
    if editions == []:
        return {}
    return {(row['owner_id'], row['edition_id']): int(row['reserved']) for row in conn.execute(
        'SELECT owner_id, edition_id, reserved FROM reserved_copies(%s::text[], %s::uuid[])', (owners, editions))}


def reserved_picks(conn, owner_id: str, edition_ids: Iterable[UUID]) -> dict[UUID, dict[UUID | None, int]]:
    """Where the owner plans to take each Edition's reserved copies from: Edition id -> {source Location id: copies},
    summed over the picks of every reserving Loan. A pick whose source was deleted is under None (its copies went to
    Unsorted). The picks of one Edition sum to its ``reserved_counts``; a pick may be out of date, so callers treat
    these as where to look first, never as a count. The caller holds the owner row lock. Call it through the module."""
    editions = sorted(set(edition_ids))
    if not editions:
        return {}
    found: dict[UUID, dict[UUID | None, int]] = {}
    for row in conn.execute(f"""SELECT p.edition_id, p.source_location_id, sum(p.quantity)::bigint AS copies
      FROM loan_pick p JOIN loan o ON o.id = p.loan_id
      WHERE p.owner_id = %s AND o.lender_id = %s AND p.edition_id = ANY(%s) AND p.state = 'reserved' AND {RESERVING}
      GROUP BY p.edition_id, p.source_location_id""", (owner_id, owner_id, editions)):
        found.setdefault(row['edition_id'], {})[row['source_location_id']] = int(row['copies'])
    return found


def deck_loan_picks(conn, owner_id: str, deck_id: UUID) -> list[dict]:
    """The owner's picks that take copies from one Deck, for its lines' "reserved for Sam" (and, from #253, "lent to
    Sam"): rows of ``edition_id``, ``state`` ('reserved'), ``borrower_name`` and ``copies``, one per Loan and Edition,
    oldest accepted Loan first. The caller holds the owner row lock."""
    return conn.execute(f"""SELECT p.edition_id, p.state, o.borrower_name, sum(p.quantity)::bigint AS copies
      FROM loan_pick p JOIN loan o ON o.id = p.loan_id
      WHERE p.owner_id = %s AND o.lender_id = %s AND p.source_location_id = %s AND p.state = 'reserved' AND {RESERVING}
      GROUP BY p.edition_id, p.state, o.id, o.borrower_name, o.accepted_at
      ORDER BY o.accepted_at, o.id, p.edition_id""", (owner_id, owner_id, deck_id)).fetchall()


def move_picks(conn, owner_id: str, source_id: UUID, target_id: UUID) -> None:
    """Points the owner's picks that name ``source_id`` at ``target_id``, in the transaction that moves every Holding of
    the source there (Deck deletion to Unsorted, leaf conversion to the new child), so a pick follows its copies. The
    caller holds the owner row lock."""
    conn.execute('UPDATE loan_pick SET source_location_id = %s WHERE owner_id = %s AND source_location_id = %s',
                 (target_id, owner_id, source_id))
