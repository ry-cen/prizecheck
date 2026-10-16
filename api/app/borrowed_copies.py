"""Borrowed Copies in a borrower's own Locations, for the reads that mean "the physical Deck" (social network #254, spec
"Borrower-side data: a separate table" and "Inventory touch-points").

A Borrowed Copy is a ``borrowed_holding`` row: a Friend's copy the borrower confirmed receiving, in one of the
borrower's Locations, never in ``holding``. It fills its Deck's lines for that Deck alone, counts in the Deck's checks,
contents, capture and Estimated Deck Cost, and reads "from Ash K." on the Deck's lines. It is never a Spare Copy or
Surplus, never offered by Use cards I own, Swap hints or Replace's preview, never removed or undone, and never counted in
the Collection or shown to Friends: those reads keep reading ``holding`` only.

This module is outside ``app.social`` on purpose: the social area's guard (``test_social_contract``) lets only the
Friend choke point read an inventory table there, and these are the borrower's own reads, never a Friend's. Nothing here
locks: every caller holds the borrower's owner row lock already.
"""
from collections.abc import Iterable
from uuid import UUID


def borrowed_in(conn, owner_id: str, location_ids: Iterable[UUID], edition_ids: Iterable[UUID] | None = None
                ) -> dict[tuple[UUID, UUID], int]:
    """The Borrowed Copies the owner holds in these Locations, of these Editions (every Edition with None), summed over
    their Loans: {(Location id, Edition id): copies}. Pairs with none are absent."""
    locations = sorted(set(location_ids))
    editions = None if edition_ids is None else sorted(set(edition_ids))
    if not locations or editions == []:
        return {}
    return {(row['location_id'], row['edition_id']): int(row['copies']) for row in conn.execute(
        """SELECT location_id, edition_id, sum(quantity)::bigint AS copies FROM borrowed_holding
        WHERE borrower_id = %s AND location_id = ANY(%s) AND (%s::uuid[] IS NULL OR edition_id = ANY(%s::uuid[]))
        GROUP BY location_id, edition_id""", (owner_id, locations, editions, editions))}


def borrowed_at(conn, owner_id: str, location_id: UUID) -> dict[UUID, int]:
    """The Borrowed Copies in one Location by Edition."""
    return {edition: copies for (_, edition), copies in borrowed_in(conn, owner_id, [location_id]).items()}


def physical(held: dict[UUID, int], borrowed: dict[UUID, int]) -> dict[UUID, int]:
    """A Deck's physical copies by Edition: its Holdings and its Borrowed Copies together."""
    return {edition: held.get(edition, 0) + borrowed.get(edition, 0) for edition in sorted({*held, *borrowed})}


def awaiting_choice(conn, borrower_id: str, loan_ids: Iterable[UUID]) -> dict[UUID, int]:
    """Written-off copies the borrower still holds and hasn't chosen to keep or remove (#257, spec "Write-off"), by
    Loan: the Loan's Borrowed Copies less the copies still out (promised, less written off, less those the borrower
    confirmed returning). Derived, never stored. Loans with none are absent. A count per Loan for its borrower, never a
    Location; the social area reads it for the borrower's own Loans only."""
    loans = sorted(set(loan_ids))
    if not loans:
        return {}
    return {row['loan_id']: int(row['copies']) for row in conn.execute(
        """SELECT b.loan_id, sum(b.quantity)
            - (SELECT sum(l.promised - l.written_off) FROM loan_line l WHERE l.loan_id = b.loan_id)
            + coalesce((SELECT sum(rl.quantity) FROM loan_return_line rl JOIN loan_return r ON r.id = rl.return_id
                WHERE r.loan_id = b.loan_id AND r.borrower_confirmed_at IS NOT NULL), 0) AS copies
          FROM borrowed_holding b WHERE b.borrower_id = %s AND b.loan_id = ANY(%s)
          GROUP BY b.loan_id""", (borrower_id, loans)) if row['copies'] > 0}


def lenders_in(conn, owner_id: str, location_id: UUID) -> list[dict]:
    """Whose Borrowed Copies a Location holds, for a Deck line's "1 from Ash K.": rows of ``edition_id``,
    ``lender_name`` (the name kept on the Loan) and ``copies``, one per Edition and lender, by Edition then oldest Loan
    first."""
    return conn.execute("""SELECT b.edition_id, o.lender_name, sum(b.quantity)::bigint AS copies
      FROM borrowed_holding b JOIN loan o ON o.id = b.loan_id
      WHERE b.borrower_id = %s AND b.location_id = %s
      GROUP BY b.edition_id, o.lender_name, o.id, o.accepted_at
      ORDER BY b.edition_id, o.accepted_at, o.id""", (owner_id, location_id)).fetchall()
