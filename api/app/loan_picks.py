"""The lender's Loan Pick List against their own Holdings (social network #253, spec "Stale picks are computed, not
stored"): which reserved picks are out of date. The Loan steps (``app.loan_inventory``) check them before the lender's
handover and replace them with **Use suggested picks**; the Loans tab and the inbox (#259) read which of a lender's Loans
wait on them to do that (``stale_pick_loans``).

Reads the lender's own Holdings only, as a count per pick, never a Location for anyone else. Takes no lock: the steps
call it under the lender's owner lock, the reads without one.
"""
from uuid import UUID

from .social import counts


def pick_shortfalls(conn, lender_id: str, edition_ids) -> tuple[list[dict], dict[int, int], dict[UUID, dict]]:
    """Which reserved picks are out of date (spec "Stale picks are computed, not stored"): the collector's reserving
    Loan and Trade picks of these Editions (``counts.reserving_pick_rows``, trading #268), oldest accepted first and
    unaccepted last, each given the copies its source still holds after the older picks there. Returns (the picks, copies
    each pick's source is short of by pick id, and the copies the picks still cover by Edition and Location). A pick
    whose source was deleted is short of all its copies. A Trade pick's ``loan_id`` is None, so the Loan readers that
    filter on their own Loan never take it for theirs; pick ids are unique across both pick tables. With no Trades this
    is exactly the Loan picks in today's order. The caller holds the lender's owner row lock."""
    editions = sorted(set(edition_ids))
    picks = counts.reserving_pick_rows(conn, lender_id, editions)
    left = {(row['location_id'], row['edition_id']): int(row['quantity']) for row in conn.execute(
        'SELECT location_id, edition_id, quantity FROM holding WHERE owner_id=%s AND edition_id=ANY(%s)',
        (lender_id, editions))} if editions else {}
    short: dict[int, int] = {}
    covered: dict[UUID, dict] = {}
    for pick in picks:
        key = (pick['source_location_id'], pick['edition_id'])
        take = min(left.get(key, 0), int(pick['quantity'])) if pick['source_location_id'] else 0
        if take:
            left[key] -= take
            found = covered.setdefault(pick['edition_id'], {})
            found[pick['source_location_id']] = found.get(pick['source_location_id'], 0) + take
        short[pick['id']] = int(pick['quantity']) - take
    return picks, short, covered


def stale_pick_loans(conn, lender_id: str, loan_ids) -> set[UUID]:
    """Which of these Loans of the lender's have a reserved pick out of date (#259): one read of their lines and one
    ``pick_shortfalls`` over all their Editions, whatever the number of Loans. The other picks of the lender's open Loans
    count as ``pick_shortfalls`` counts them, oldest accepted Loan first."""
    wanted = set(loan_ids)
    if not wanted:
        return set()
    editions = [row['edition_id'] for row in conn.execute(
        'SELECT DISTINCT edition_id FROM loan_line WHERE loan_id = ANY(%s) AND promised > 0', (sorted(wanted, key=str),))]
    if not editions:
        return set()
    picks, short, _ = pick_shortfalls(conn, lender_id, editions)
    return {pick['loan_id'] for pick in picks if pick['loan_id'] in wanted and short[pick['id']] > 0}
