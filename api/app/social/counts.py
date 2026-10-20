"""What Loans and Trades take out of a collector's own figures, per Card Edition (spec "Module boundary"; trading spec
"The shared promise invariant"). Inventory code calls these and never imports Loan or Trade logic.

``reserved_counts`` (one owner, under that owner's lock) and ``reserved_by_owner`` (several owners at once, for the
Friend reads of ``friend_copies``, #250) read the copies open Loans and Trades promise and the collector hasn't handed
over or swapped yet: the lines of accepted Borrow Requests and sent Lend Offers, and a Trade side's lines while that
side reserves (trading #268), through ``reserved_copies``, the same definition the deferred invariant checks
(migrations 106 and 142). ``trade_reserved_counts`` is the Trade part alone, so a refusal can say a Trade promises the
copies. ``reserved_picks`` and ``reserving_pick_rows`` say where the collector plans to take those copies from (the
Loan and Trade Pick Lists, migration 142's ``reserving_picks``), so the copy allocation leaves the picked copies out of
what it offers and a Loan never picks copies a Trade covers, or the other way round; ``deck_loan_picks`` names the
borrowers a Deck's picked copies are reserved or lent to, and stays Loan-only. ``move_picks`` is the one pick write
inventory code makes: when Deck deletion or leaf conversion moves a Location's Holdings, the Loan and Trade picks that
name it move with them.

``lent_counts`` (#253) reads the copies the lender handed over and hasn't had back or written off: they are in no
Holding, still the lender's, and ``lent_picks`` says which Locations they came from. Both read the lent picks, which a
lender's return (#255) and Write-off (#257) cut, so the two always agree.

Nothing here reads another collector's inventory, and nothing names a Location to anyone but its owner.
"""
from collections.abc import Iterable
from uuid import UUID

# The Loans whose promised copies are still reserved (migration 105's loan_reserving index).
RESERVING = "o.state IN ('offered','accepted') AND o.lender_handover_at IS NULL"
# The Loans whose promised copies the lender handed over and that haven't closed. Their lent picks are what is out.
LENDING = "o.lender_handover_at IS NOT NULL AND o.state <> 'closed'"


def reserved_counts(conn, owner_id: str, edition_ids: Iterable[UUID]) -> dict[UUID, int]:
    """Copies of each Edition the owner has promised to open Loans and not yet handed over (sent Lend Offers and
    accepted Borrow Requests), plus the copies their open Trades promise and they haven't swapped yet (trading #268).
    Editions with none are absent, so read it with ``.get(edition, 0)``. The caller holds the owner row lock. Call it as
    ``counts.reserved_counts(...)`` through the module, never a from-import, so one patch of the module attribute
    reaches every caller."""
    editions = sorted(set(edition_ids))
    if not editions:
        return {}
    return {row['edition_id']: int(row['reserved']) for row in conn.execute(
        'SELECT edition_id, reserved FROM reserved_copies(%s::text[], %s::uuid[])', ([owner_id], editions))}


def trade_reserved_counts(conn, owner_id: str, edition_ids: Iterable[UUID]) -> dict[UUID, int]:
    """The part of ``reserved_counts`` that open Trades promise (trading #268): copies of each Edition the owner gives in
    a Trade Proposal or Trade whose side still reserves, through migration 142's ``trade_reserved_copies``. Editions with
    none are absent. ``moves.check_promises`` reads it to say a Trade promises a refused copy. Call it through the
    module."""
    editions = sorted(set(edition_ids))
    if not editions:
        return {}
    return {row['edition_id']: int(row['reserved']) for row in conn.execute(
        'SELECT edition_id, reserved FROM trade_reserved_copies(%s::text[], %s::uuid[])', ([owner_id], editions))}


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
    summed over the picks of every reserving Loan and Trade side (``reserving_picks``, migration 142). A pick whose
    source was deleted is under None (its copies went to Unsorted). The picks of one Edition sum to its
    ``reserved_counts``; a pick may be out of date, so callers treat these as where to look first, never as a count. The
    caller holds the owner row lock, or reads one snapshot without it (the Trade List, ``app.trade_list``). Call it
    through the module."""
    editions = sorted(set(edition_ids))
    if not editions:
        return {}
    found: dict[UUID, dict[UUID | None, int]] = {}
    for row in conn.execute("""SELECT edition_id, source_location_id, sum(quantity)::bigint AS copies
      FROM reserving_picks(ARRAY[%s]::text[], %s::uuid[])
      GROUP BY edition_id, source_location_id""", (owner_id, editions)):
        found.setdefault(row['edition_id'], {})[row['source_location_id']] = int(row['copies'])
    return found


def reserving_pick_rows(conn, owner_id: str, edition_ids: Iterable[UUID]) -> list[dict]:
    """The owner's reserving Loan and Trade picks of these Editions, one row per pick, oldest accepted first and
    unaccepted last, with keys ``id``, ``kind`` ('loan' or 'trade'), ``loan_id`` (None for a Trade pick), ``trade_id``
    (None for a Loan pick), ``edition_id``, ``source_location_id`` and ``quantity``. With no Trade picks the rows and
    their order are exactly the Loan picks ``loan_picks.pick_shortfalls`` read before trading (#268). The caller holds
    the owner row lock, or reads without one. Call it through the module."""
    editions = sorted(set(edition_ids))
    if not editions:
        return []
    return conn.execute("""SELECT pick_id AS id, kind, loan_id, trade_id, edition_id, source_location_id, quantity
      FROM reserving_picks(ARRAY[%s]::text[], %s::uuid[])
      ORDER BY sort_accepted_at NULLS LAST, sort_created_at, kind, coalesce(loan_id, trade_id), pick_id""",
                        (owner_id, editions)).fetchall()


def deck_loan_picks(conn, owner_id: str, deck_id: UUID) -> list[dict]:
    """The owner's picks that take copies from one Deck, for its lines' "reserved for Sam" and "lent to Sam": rows of
    ``edition_id``, ``state`` ('reserved' or 'lent'), ``borrower_name`` and ``copies``, one per Loan, Edition and
    state, oldest accepted Loan first. The caller holds the owner row lock."""
    return conn.execute(f"""SELECT p.edition_id, p.state, o.borrower_name, sum(p.quantity)::bigint AS copies
      FROM loan_pick p JOIN loan o ON o.id = p.loan_id
      WHERE p.owner_id = %s AND o.lender_id = %s AND p.source_location_id = %s
        AND ((p.state = 'reserved' AND {RESERVING}) OR (p.state = 'lent' AND {LENDING}))
      GROUP BY p.edition_id, p.state, o.id, o.borrower_name, o.accepted_at
      ORDER BY o.accepted_at, o.id, p.edition_id""", (owner_id, owner_id, deck_id)).fetchall()


def lent_counts(conn, owner_id: str, edition_ids: Iterable[UUID] | None) -> dict[UUID, int]:
    """Copies of each Edition the owner has handed over to open Loans and not had back (#255) or written off (#257), or
    of every Edition with None: the lent picks. They are in no Holding and still the owner's. Editions with none are
    absent. Call it through the module."""
    editions = None if edition_ids is None else sorted(set(edition_ids))
    if editions == []:
        return {}
    return {row['edition_id']: int(row['lent']) for row in conn.execute(f"""SELECT p.edition_id,
        sum(p.quantity)::bigint AS lent
      FROM loan o JOIN loan_pick p ON p.loan_id = o.id
      WHERE o.lender_id = %s AND p.owner_id = %s AND p.state = 'lent' AND {LENDING}
        AND (%s::uuid[] IS NULL OR p.edition_id = ANY(%s::uuid[]))
      GROUP BY p.edition_id""", (owner_id, owner_id, editions, editions))}


def lent_picks(conn, owner_id: str, edition_ids: Iterable[UUID]) -> dict[UUID, dict[UUID | None, int]]:
    """Where the owner's lent copies came from: Edition id -> {source Location id: copies}, as ``reserved_picks``
    answers for reserved ones. A Deck's own lent copies count for that Deck on the Want List (``allocate``). Call it
    through the module."""
    editions = sorted(set(edition_ids))
    if not editions:
        return {}
    found: dict[UUID, dict[UUID | None, int]] = {}
    for row in conn.execute(f"""SELECT p.edition_id, p.source_location_id, sum(p.quantity)::bigint AS copies
      FROM loan_pick p JOIN loan o ON o.id = p.loan_id
      WHERE p.owner_id = %s AND o.lender_id = %s AND p.edition_id = ANY(%s) AND p.state = 'lent' AND {LENDING}
      GROUP BY p.edition_id, p.source_location_id""", (owner_id, owner_id, editions)):
        found.setdefault(row['edition_id'], {})[row['source_location_id']] = int(row['copies'])
    return found


def move_picks(conn, owner_id: str, source_id: UUID, target_id: UUID) -> None:
    """Points the owner's Loan and Trade picks that name ``source_id`` at ``target_id``, in the transaction that moves
    every Holding of the source there (Deck deletion to Unsorted, leaf conversion to the new child), so a pick follows
    its copies. The caller holds the owner row lock."""
    conn.execute('UPDATE loan_pick SET source_location_id = %s WHERE owner_id = %s AND source_location_id = %s',
                 (target_id, owner_id, source_id))
    conn.execute('UPDATE trade_pick SET source_location_id = %s WHERE owner_id = %s AND source_location_id = %s',
                 (target_id, owner_id, source_id))
