"""The Loan steps and reads that touch a collector's own inventory (social network #252, spec "Lender-side data: Loan
lines and picks" and "Loans, requests and the state model").

The shared Loan facts and the steps that change no inventory are ``social.loans`` under ``/api/social/loans``; the
contract guard keeps that area from reading any inventory table. What needs one collector's own Locations, Decks and
Holdings is here, under ``/api/loans``, and never answers one side's Locations or Decks to the other:

- **Send a Borrow Request** (``POST /api/loans``). The borrower names a Friend, Card Edition lines, optionally one of
  their own Decks (none means Unsorted) and a return-by date. Each line is capped at what the Friend could lend now,
  through the one Friend read, ``social.friend_copies``. Nothing is reserved. ``replaces`` withdraws the borrower's
  earlier request to the same Friend in the same transaction ("Edit and resend").
- **Accept** (``POST /api/loans/{id}/accept``). The lender promises a count per line, 0 leaving a line out, each at
  most what was asked and at most the copies they could promise now (``can_promise``: every copy they hold less the
  copies open Loans already reserve). Accepting reserves the promised copies and makes the Loan Pick List
  (``make_picks``). It locks only the lender, so two acceptances for the same copies run one after the other and the
  second sees the first's reservation; migration 106's deferred trigger is the backstop.
- **Each side's own view** (``GET /api/loans/{id}/side``): for the lender, how many copies each line could take while
  answering, and the Loan Pick List with their own Location names; for the borrower, the Deck the cards go to.

**The Loan Pick List** takes copies in the Deck Pick List's order (``deck_pick_list.suggest``): loose storage, largest
Holding first, then other Decks' copies beyond their own lines, then copies Decks hold for their own lines; copies
other Loans' picks take are left for them.
"""
from datetime import date
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .deck_pick_list import suggest
from .location_tree import error
from .main import connect, verified_user
from .moves import quantity
from .social import counts
from .social.friend_copies import friend_copies
from .social.friends import friend_ids
from .social.loans import (LoanStep, LoanView, begin_command, advance_revision, run_step, store)
from .social.owners import lock_owners

router = APIRouter(prefix='/api/loans', tags=['loans'])

MAX_LOAN_LINES = 50


class LoanLineRequest(BaseModel):
    edition_id: UUID
    quantity: str


class SendBorrowRequest(BaseModel):
    """A Borrow Request to a Friend (``lender_id``, a ``collector_id`` the Friends list or a Friend read gave)."""
    lender_id: str = Field(min_length=1, max_length=200)
    lines: list[LoanLineRequest] = Field(min_length=1, max_length=MAX_LOAN_LINES)
    # One of the borrower's own Decks, or None for Unsorted.
    deck_id: UUID | None = None
    return_by: date | None = None
    # A Borrow Request of the caller's to the same Friend, still unanswered, that this one replaces.
    replaces: UUID | None = None
    idempotency_key: UUID


class PromisedLine(BaseModel):
    edition_id: UUID
    # Copies promised, "0" to leave the line out.
    promised: str


class AcceptBorrowRequest(LoanStep):
    lines: list[PromisedLine] = Field(min_length=1, max_length=MAX_LOAN_LINES)


class PromiseLimit(BaseModel):
    edition_id: UUID
    # Copies of the Edition the lender could promise now.
    available: str


class LoanPickPlace(BaseModel):
    """Where the lender takes copies of one Edition from: one of their own Locations (``name``), or Unsorted when the
    Location was deleted (``location_id`` None)."""
    edition_id: UUID
    location_id: UUID | None
    name: str
    copies: str


class LoanDeck(BaseModel):
    id: UUID
    name: str


class LoanSide(BaseModel):
    """One side's own view of a Loan. The borrower's: ``deck``, the Deck the cards go to (None for Unsorted). The
    lender's: ``can_promise`` while the request is unanswered, and ``picks``, the Loan Pick List, once accepted."""
    loan_id: UUID
    deck: LoanDeck | None
    can_promise: list[PromiseLimit]
    picks: list[LoanPickPlace]


def copies_count(raw: str) -> int:
    """A promised count: "0" or a line quantity."""
    if raw == '0':
        return 0
    return quantity(raw)


def refuse(status: int, code: str, **detail):
    raise HTTPException(status, {'code': code, **{key: str(value) for key, value in detail.items()}})


def can_promise(conn, lender_id: str, edition_ids) -> dict[UUID, int]:
    """Copies of each Edition the lender could promise now: every copy they hold, wherever it is, less the copies open
    Loans reserve. The caller holds the lender's owner row lock."""
    editions = sorted(set(edition_ids))
    held = {row['edition_id']: int(row['copies']) for row in conn.execute(
        'SELECT edition_id, sum(quantity) AS copies FROM holding WHERE owner_id=%s AND edition_id=ANY(%s) '
        'GROUP BY edition_id', (lender_id, editions))} if editions else {}
    reserved = counts.reserved_counts(conn, lender_id, editions)
    return {edition: max(0, held.get(edition, 0) - reserved.get(edition, 0)) for edition in editions}


def make_picks(conn, lender_id: str, loan_id: UUID, promised: dict[UUID, int]) -> None:
    """The Loan Pick List for newly promised copies: per Edition, places in the Deck Pick List's order, leaving the
    copies other Loans' picks take. The caller holds the lender's owner row lock and checked ``can_promise``, so the
    copies no other pick takes always cover the promise."""
    editions = sorted(edition for edition, copies in promised.items() if copies > 0)
    if not editions:
        return
    places: dict[UUID, list[dict]] = {}
    for row in conn.execute("""SELECT h.location_id, h.edition_id, h.quantity, l.name, l.kind, d.quantity AS listed
      FROM holding h JOIN location l ON l.owner_id = h.owner_id AND l.id = h.location_id
      LEFT JOIN deck_list_line d ON d.owner_id = h.owner_id AND d.deck_id = h.location_id AND d.edition_id = h.edition_id
      WHERE h.owner_id = %s AND h.edition_id = ANY(%s)""", (lender_id, editions)):
        own = min(row['listed'] or 0, row['quantity']) if row['kind'] == 'deck' else 0
        places.setdefault(row['edition_id'], []).append({
            'location_id': row['location_id'], 'name': row['name'], 'kind': row['kind'],
            'available': int(row['quantity']), 'committed': int(own), 'spare': int(row['quantity'] - own)})
    taken_by_others = counts.reserved_picks(conn, lender_id, editions)
    for edition in editions:
        others = taken_by_others.get(edition, {})
        free = [{**place, 'available': place['available'] - min(place['available'], others.get(place['location_id'], 0))}
                for place in places.get(edition, [])]
        for place in free:
            reserved = place['spare'] + place['committed'] - place['available']
            place['spare'] = max(0, place['spare'] - reserved)
            place['committed'] = place['available'] - place['spare']
        for place, copies in suggest(promised[edition], free):
            if copies > 0:
                conn.execute('INSERT INTO loan_pick(loan_id, owner_id, edition_id, source_location_id, quantity) '
                             'VALUES (%s, %s, %s, %s, %s)', (loan_id, lender_id, edition, place['location_id'], copies))


@router.post('', response_model=LoanView, status_code=201)
def send_borrow_request(command: SendBorrowRequest, user_id: str = Depends(verified_user)):
    if command.lender_id == user_id:
        error(409, 'OWN_ACCOUNT')
    lines = [(line.edition_id, quantity(line.quantity)) for line in command.lines]
    if len({edition for edition, _ in lines}) != len(lines):
        error(422, 'DUPLICATE_EDITION')
    payload = {'action': 'loan_send', **command.model_dump(mode='json', exclude={'idempotency_key'})}
    with connect() as conn, conn.transaction():
        digest, stored = begin_command(conn, user_id, command.idempotency_key, payload)
        if stored is not None:
            return stored
        if command.return_by is not None and command.return_by < conn.execute(
                'SELECT current_date AS today').fetchone()['today']:
            error(422, 'INVALID_RETURN_BY')
        # The borrower's own Deck is read under their lock; nothing of the lender's is locked, as nothing is reserved.
        lock_owners(conn, user_id)
        if command.lender_id not in friend_ids(conn, user_id):
            error(409, 'NOT_FRIENDS')
        if command.deck_id is not None and conn.execute(
                "SELECT 1 FROM location WHERE owner_id=%s AND id=%s AND kind='deck'",
                (user_id, command.deck_id)).fetchone() is None:
            error(404, 'DECK_NOT_FOUND')
        lendable = {copy.edition_id: copy.spare + copy.in_deck for copy in friend_copies(
            conn, user_id, [command.lender_id], [edition for edition, _ in lines])}
        for edition, copies in lines:
            if copies > lendable.get(edition, 0):
                refuse(409, 'NOT_LENDABLE', edition_id=edition, available=lendable.get(edition, 0))
        if command.replaces is not None:
            earlier = conn.execute('SELECT id, state, lender_id FROM loan WHERE id=%s AND borrower_id=%s '
                                   'FOR NO KEY UPDATE',
                                   (command.replaces, user_id)).fetchone()
            if earlier is None or earlier['state'] != 'requested' or earlier['lender_id'] != command.lender_id:
                error(409, 'LOAN_CHANGED')
            conn.execute("""UPDATE loan SET state='closed', closed_reason='withdrawn', closed_by=%s, closed_at=now(),
              revision=revision+1 WHERE id=%s""", (user_id, command.replaces))
        names = {row['user_id']: row['display_name'] for row in conn.execute(
            'SELECT user_id, display_name FROM collector_profile WHERE user_id = ANY(%s)',
            ([user_id, command.lender_id],))}
        loan_id = uuid4()
        conn.execute("""INSERT INTO loan(id, kind, state, lender_id, borrower_id, lender_name, borrower_name, deck_id,
            return_by) VALUES (%s, 'borrow_request', 'requested', %s, %s, %s, %s, %s, %s)""",
                     (loan_id, command.lender_id, user_id, names[command.lender_id], names[user_id], command.deck_id,
                      command.return_by))
        for position, (edition, copies) in enumerate(lines):
            conn.execute('INSERT INTO loan_line(loan_id, edition_id, position, requested) VALUES (%s, %s, %s, %s)',
                         (loan_id, edition, position, copies))
        return store(conn, user_id, command.idempotency_key, digest, loan_id)


@router.post('/{loan_id}/accept', response_model=LoanView)
def accept(loan_id: UUID, command: AcceptBorrowRequest, user_id: str = Depends(verified_user)):
    promised = {}
    for line in command.lines:
        if line.edition_id in promised:
            error(422, 'DUPLICATE_EDITION')
        promised[line.edition_id] = copies_count(line.promised)

    def apply(conn, row):
        if row['borrower_id'] not in friend_ids(conn, user_id):
            error(409, 'NOT_FRIENDS')
        asked = {line['edition_id']: int(line['requested']) for line in conn.execute(
            'SELECT edition_id, requested FROM loan_line WHERE loan_id=%s', (loan_id,))}
        if set(asked) != set(promised):
            error(422, 'LINES_DONT_MATCH')
        if any(promised[edition] > asked[edition] for edition in asked):
            error(422, 'MORE_THAN_REQUESTED')
        if not any(promised.values()):
            error(422, 'NOTHING_PROMISED')
        available = can_promise(conn, user_id, list(asked))
        for edition in sorted(asked):
            if promised[edition] > available[edition]:
                refuse(409, 'NOT_ENOUGH_COPIES', edition_id=edition, available=available[edition])
        for edition, copies in promised.items():
            conn.execute('UPDATE loan_line SET promised=%s WHERE loan_id=%s AND edition_id=%s', (copies, loan_id, edition))
        conn.execute("UPDATE loan SET state='accepted', accepted_at=now() WHERE id=%s", (loan_id,))
        make_picks(conn, user_id, loan_id, promised)
        advance_revision(conn, user_id)

    return run_step(user_id, loan_id, command, 'accept', apply, lambda role, row: [row['lender_id']],
                    {'lines': {str(edition): copies for edition, copies in sorted(promised.items(), key=str)}})


@router.get('/{loan_id}/side', response_model=LoanSide)
def loan_side(loan_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        row = conn.execute('SELECT id, state, lender_id, borrower_id, deck_id, lender_handover_at FROM loan '
                           'WHERE id=%s AND (lender_id=%s OR borrower_id=%s)', (loan_id, user_id, user_id)).fetchone()
        if row is None:
            error(404, 'LOAN_NOT_FOUND')
        if row['borrower_id'] == user_id:
            deck = conn.execute("SELECT id, name FROM location WHERE owner_id=%s AND id=%s AND kind='deck'",
                                (user_id, row['deck_id'])).fetchone() if row['deck_id'] else None
            return LoanSide(loan_id=loan_id, deck=LoanDeck(**deck) if deck else None, can_promise=[], picks=[])
        limits = []
        if row['state'] == 'requested':
            editions = [line['edition_id'] for line in conn.execute(
                'SELECT edition_id FROM loan_line WHERE loan_id=%s ORDER BY position', (loan_id,))]
            available = can_promise(conn, user_id, editions)
            limits = [PromiseLimit(edition_id=edition, available=str(available[edition])) for edition in editions]
        picks = [LoanPickPlace(edition_id=pick['edition_id'], location_id=pick['location_id'],
                               name=pick['name'] or 'Unsorted', copies=str(pick['copies']))
                 for pick in conn.execute("""SELECT p.edition_id, p.source_location_id AS location_id, l.name,
                     sum(p.quantity)::bigint AS copies
                   FROM loan_pick p JOIN loan_line ll ON ll.loan_id = p.loan_id AND ll.edition_id = p.edition_id
                   LEFT JOIN location l ON l.owner_id = p.owner_id AND l.id = p.source_location_id
                   WHERE p.loan_id = %s AND p.owner_id = %s
                   GROUP BY p.edition_id, p.source_location_id, l.name, ll.position
                   ORDER BY ll.position, sum(p.quantity) DESC, lower(l.name), p.source_location_id""",
                                         (loan_id, user_id))]
        return LoanSide(loan_id=loan_id, deck=None, can_promise=limits, picks=picks)
