from uuid import UUID
from pydantic import BaseModel
from app.borrowed_copies import lenders_in
from app.social import counts


class LoanLabel(BaseModel):
    """Copies of a line's Card Edition in this Deck that one borrower's Loans take: the borrower's Display Name."""
    name: str
    copies: str


class DeckLoanLine(BaseModel):
    """What Loans take of one Card Edition in this Deck (social network #252 and #253, spec "Lender-side data"):
    ``reserved``, copies the Loan Pick List takes from here and still in the Deck ("2 reserved for Kim"), and ``lent``,
    copies handed over from here and out with a Friend ("3 lent to Sam"), each oldest Loan first. Reserved copies stay
    in the Deck and count for it until handover; lent copies are missing from it but never on the Want List.
    ``borrowed`` (#254): the Borrowed Copies in this Deck, by lender ("1 from Ash K."); they fill the Deck's lines."""
    edition_id: UUID
    reserved: list[LoanLabel]
    lent: list[LoanLabel]
    borrowed: list[LoanLabel] = []


def read_deck_loans(conn, user_id: str, deck_id: UUID, held: dict) -> list[DeckLoanLine]:
    """Each Card Edition of the Deck that Loans take copies of, in Edition order; a borrower named once per Edition and
    state. ``held``: the Deck's Holdings by Edition (``held_in``). A reserved pick is read up to the copies still here,
    oldest Loan first, so an out-of-date pick never names more copies than the Deck holds. The caller holds the owner
    row lock."""
    found: dict[UUID, dict[str, dict[str, int]]] = {}
    for row in lenders_in(conn, user_id, deck_id):
        names = found.setdefault(row['edition_id'], {'reserved': {}, 'lent': {}, 'borrowed': {}})['borrowed']
        names[row['lender_name']] = names.get(row['lender_name'], 0) + int(row['copies'])
    left = dict(held)
    for row in counts.deck_loan_picks(conn, user_id, deck_id):
        edition, state = row['edition_id'], row['state']
        copies = min(left.get(edition, 0), int(row['copies'])) if state == 'reserved' else int(row['copies'])
        if copies > 0:
            names = found.setdefault(edition, {'reserved': {}, 'lent': {}, 'borrowed': {}})[state]
            names[row['borrower_name']] = names.get(row['borrower_name'], 0) + copies
            if state == 'reserved':
                left[edition] -= copies
    return [DeckLoanLine(edition_id=edition, **{
        state: [LoanLabel(name=name, copies=str(copies)) for name, copies in found[edition][state].items()]
        for state in ('reserved', 'lent', 'borrowed')}) for edition in sorted(found)]
