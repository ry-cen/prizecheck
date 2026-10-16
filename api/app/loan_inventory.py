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

**Borrowed Copies** (#254): ``GET /api/loans/borrowed`` lists the Borrowed Copies the collector holds, by Location, for
the Collection's Borrowed entry, and ``POST /api/loans/borrowed/move`` moves some of one Loan's copies of a card to
another of the borrower's Storage Leaves or Decks, under the borrower's own lock. It is its own route, never a general
Move: a Borrowed Copy keeps its Loan and never joins the borrower's Holdings. A Borrowed Copy arriving in a Deck adds or
raises its Deck List line as an owned copy would (migration 115).

**Returns** (#255): ``POST /api/loans/{id}/returns`` starts a return of some of the copies still out from the caller's
side (the lender's **Record a return**, the borrower's **Give cards back**) and is that side's confirmation;
``POST /api/loans/{id}/returns/confirm`` is the other side's (**Yes, they're back**, **Yes, I gave them back**). Each
moves only the caller's own inventory, under the caller's own lock, with no Undo record: the lender's copies leave the
Loan's lent picks, last pick first, and go back to each pick's source Location, or Unsorted when the source is gone or
holds no cards now; the borrower's Borrowed Copies leave, loose Locations first, then Decks, whose lines stay. A return
only one side confirmed is complete when the other side's account is gone. The step that leaves nothing out closes the
Loan: ``returned`` when nothing was written off, else ``written_off``.

**Write-off** (#257): ``POST /api/loans/{id}/write-off`` is the lender's, under their own lock, once they confirmed the
handover: it raises the lines' ``written_off`` and takes the copies off the Loan's lent picks, so they leave the
lender's Collection, and never touches the borrower's rows. The borrower then chooses for the written-off copies they
hold (``POST /api/loans/{id}/written-off``, under their own lock): **keep** turns them into owned copies where they sit,
with one Undo record per Location and no Deck List change (they were already there); **remove** takes them away. The
count awaiting the choice is derived (``borrowed_copies.awaiting_choice``); the borrower's side lists where the copies
are (``LoanSide.awaiting_choice``, loose Locations first), and the step names exactly those places.

**Lend Offers** (#258): ``POST /api/loans/offers`` sends a Friend copies the lender selected in their Collection, each
by its Location. Sending reserves them at once under the lender's lock: the Loan Pick List is the selected Holdings,
in the order selected, and each is at most the copies there no other Loan's pick still covers, so the same copies are
never offered or promised twice. ``POST /api/loans/{id}/accept-offer`` is the borrower's answer: a count per line (0
leaves a line out) and the Deck the cards go to. It locks both owners: the borrower's, so the Deck checked is the Deck
written (a Deck deletion waits for it, or it finds the Deck gone), and the lender's, as the copies not taken are
released, last pick first, which moves the lender's revision.

**Edition reassignment** (spec item 15): a collector's reassignment of copies of a deprecated Card Edition to its
replacement (``catalog_reconciliation.reassign``) carries their open Loans that name it onto the replacement
(``follow_replacement``): lines, picks, return lines and Borrowed Copies, merged with any the Loan already has for the
replacement. Before the lender confirms the handover only the lender's own reassignment moves a Loan, because the
promise is on the lender's copies; a Loan still reserving copies moves only when the lender's copies of the
replacement then cover everything promised in it, and those Loans move together or not at all. Once the lender handed
the copies over, either side's reassignment moves the Loan.
"""
import json
from datetime import date
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .deck_deletion import unsorted_leaf
from .deck_pick_list import suggest
from .holdings import MAX_QUANTITY
from .loan_picks import pick_shortfalls
from .location_tree import error, replay
from .main import connect, verified_user
from .moves import first_non_leaf, put_back, quantity, record_undo, take_out, undo_id_for
from .social import counts
from .social.friend_copies import friend_copies
from .social.friend_reads import card_facts
from .social.friends import friend_ids
from .social.loans import (NOW, LoanStep, LoanView, begin_command, advance_revision, close, record_update,
                           return_by_columns, run_step, store, today, write_loan)
from .social.owners import ensure_owner, lock_owners

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


class OfferedCopies(BaseModel):
    """Copies of one Holding the lender selected: its Location and Card Edition."""
    location_id: UUID
    edition_id: UUID
    quantity: str


class SendLendOffer(BaseModel):
    """A Lend Offer to a Friend (``borrower_id``, a ``collector_id`` the Friends list gave) of the copies the lender
    selected in their Collection (#258)."""
    borrower_id: str = Field(min_length=1, max_length=200)
    copies: list[OfferedCopies] = Field(min_length=1, max_length=200)
    return_by: date | None = None
    idempotency_key: UUID


class AcceptLendOffer(LoanStep):
    """The borrower's answer to a Lend Offer (#258): the copies taken per line ("0" leaves a line out; the rest is
    released) and one of their Decks for the cards (None for Unsorted)."""
    lines: list[PromisedLine] = Field(min_length=1, max_length=MAX_LOAN_LINES)
    deck_id: UUID | None = None


class AcceptBorrowRequest(LoanStep):
    lines: list[PromisedLine] = Field(min_length=1, max_length=MAX_LOAN_LINES)
    # The return-by date (#256): left out to keep the requested one, None to clear it, else the lender's date.
    return_by: date | None = None


class ReturnedLine(BaseModel):
    edition_id: UUID
    # Copies returned, "0" to leave the line out.
    quantity: str


class StartReturn(LoanStep):
    """A return of some of the copies out from the caller's side (#255)."""
    lines: list[ReturnedLine] = Field(min_length=1, max_length=MAX_LOAN_LINES)


class WriteOffLine(BaseModel):
    edition_id: UUID
    # Copies written off, "0" to leave the line out.
    quantity: str


class WriteOff(LoanStep):
    """The lender writes off some of the copies out (#257). Final: there is no Undo."""
    lines: list[WriteOffLine] = Field(min_length=1, max_length=MAX_LOAN_LINES)


class ChosenPlace(BaseModel):
    location_id: UUID
    edition_id: UUID
    copies: str


class WrittenOffChoice(LoanStep):
    """The borrower's choice for the written-off copies they hold (#257): ``keep`` them as their own or ``remove``
    them. ``places``: where those copies are, as ``LoanSide.awaiting_choice`` lists them."""
    choice: Literal['keep', 'remove']
    places: list[ChosenPlace] = Field(min_length=1, max_length=200)


class PromiseLimit(BaseModel):
    edition_id: UUID
    # Copies of the Edition the lender could promise now.
    available: str


class LoanPickPlace(BaseModel):
    """Where the lender takes copies of one Edition from: one of their own Locations (``name``), or Unsorted when the
    Location was deleted (``location_id`` None). ``short``: copies the Location no longer holds for this pick (the pick
    is out of date when above "0"). Once handed over, where the copies came from and go back to."""
    edition_id: UUID
    location_id: UUID | None
    name: str
    copies: str
    short: str


class LoanDeck(BaseModel):
    id: UUID
    name: str


class LoanSide(BaseModel):
    """One side's own view of a Loan. The borrower's: ``deck``, the Deck the cards go to (None for Unsorted). The
    lender's: ``can_promise`` while the request is unanswered, ``picks``, the Loan Pick List, once accepted, and
    ``suggested``, the Pick List **Use suggested picks** makes, when a pick is out of date (else empty). The
    borrower's ``awaiting_choice`` (#257): where the written-off copies awaiting their choice are."""
    loan_id: UUID
    deck: LoanDeck | None
    can_promise: list[PromiseLimit]
    picks: list[LoanPickPlace]
    suggested: list[LoanPickPlace]
    awaiting_choice: list[LoanPickPlace] = []


class LentCard(BaseModel):
    """Copies of one Card Edition out with one Friend on one Loan: the Lent out entry's row."""
    loan_id: UUID
    edition_id: UUID
    name: str
    set_code: str
    set_name: str
    collector_number: str
    image_url: str | None
    copies: str
    # The borrower's Display Name.
    borrower: str


class LentOut(BaseModel):
    """Every copy the collector lent and hasn't had back, by borrower and then card order; ``copies`` sums them."""
    cards: list[LentCard]
    copies: str


class BorrowedCard(BaseModel):
    """Borrowed Copies of one Card Edition from one Loan in one of the collector's own Locations: the Borrowed entry's
    row. ``lender``: the lender's Display Name."""
    loan_id: UUID
    edition_id: UUID
    name: str
    set_code: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    location_id: UUID
    location_name: str
    copies: str
    lender: str


class BorrowedCopies(BaseModel):
    """Every Borrowed Copy the collector holds, by Location name, then card; ``copies`` sums them."""
    cards: list[BorrowedCard]
    copies: str


class MoveBorrowed(BaseModel):
    """Moves ``quantity`` of one Loan's Borrowed Copies of a card from one of the collector's Locations to another."""
    loan_id: UUID
    edition_id: UUID
    from_location_id: UUID
    to_location_id: UUID
    quantity: str
    idempotency_key: UUID


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


def _places(conn, lender_id: str, editions) -> dict[UUID, list[dict]]:
    """The lender's Holdings of the Editions as places for ``deck_pick_list.suggest``: per Edition, each Location with
    its name, kind, copies, the copies a Deck holds there for its own line (``committed``) and the rest (``spare``)."""
    places: dict[UUID, list[dict]] = {}
    for row in conn.execute("""SELECT h.location_id, h.edition_id, h.quantity, l.name, l.kind, d.quantity AS listed
      FROM holding h JOIN location l ON l.owner_id = h.owner_id AND l.id = h.location_id
      LEFT JOIN deck_list_line d ON d.owner_id = h.owner_id AND d.deck_id = h.location_id AND d.edition_id = h.edition_id
      WHERE h.owner_id = %s AND h.edition_id = ANY(%s)""", (lender_id, sorted(set(editions)))):
        own = min(row['listed'] or 0, row['quantity']) if row['kind'] == 'deck' else 0
        places.setdefault(row['edition_id'], []).append({
            'location_id': row['location_id'], 'name': row['name'], 'kind': row['kind'],
            'available': int(row['quantity']), 'committed': int(own), 'spare': int(row['quantity'] - own)})
    return places


def _without(places: list[dict], taken: dict) -> list[dict]:
    """The places less the copies other picks take there ({Location id: copies}), out of the copies beyond a Deck's
    line first, as the Loan Pick List takes them."""
    free = []
    for place in places:
        gone = min(place['available'], taken.get(place['location_id'], 0))
        spare = max(0, place['spare'] - gone)
        free.append({**place, 'available': place['available'] - gone, 'spare': spare,
                     'committed': place['available'] - gone - spare})
    return free


def suggest_picks(conn, lender_id: str, promised: dict[UUID, int], covered: dict[UUID, dict]
                  ) -> dict[tuple[UUID, UUID], int]:
    """Where to take ``promised`` copies per Edition from: the copies no other pick covers (``covered``), in the Deck
    Pick List's order. Returns copies by (Edition id, Location id). The caller holds the lender's owner row lock and
    checked the copies are there (``can_promise``, or the invariant for picks already promised)."""
    editions = sorted(edition for edition, copies in promised.items() if copies > 0)
    places = _places(conn, lender_id, editions) if editions else {}
    found: dict[tuple[UUID, UUID], int] = {}
    for edition in editions:
        for place, copies in suggest(promised[edition], _without(places.get(edition, []), covered.get(edition, {}))):
            if copies > 0:
                found[(edition, place['location_id'])] = found.get((edition, place['location_id']), 0) + copies
    return found


def insert_picks(conn, lender_id: str, loan_id: UUID, picks: dict[tuple[UUID, UUID | None], int]) -> None:
    for (edition, location), copies in sorted(picks.items(), key=lambda item: (str(item[0][0]), str(item[0][1]))):
        conn.execute('INSERT INTO loan_pick(loan_id, owner_id, edition_id, source_location_id, quantity) '
                     'VALUES (%s, %s, %s, %s, %s)', (loan_id, lender_id, edition, location, copies))


def make_picks(conn, lender_id: str, loan_id: UUID, promised: dict[UUID, int]) -> None:
    """The Loan Pick List for newly promised copies: per Edition, places in the Deck Pick List's order, leaving the
    copies other Loans' picks still cover. The caller holds the lender's owner row lock and checked ``can_promise``, so
    the copies no other pick covers always cover the promise."""
    _, _, covered = pick_shortfalls(conn, lender_id, [edition for edition, copies in promised.items() if copies > 0])
    insert_picks(conn, lender_id, loan_id, suggest_picks(conn, lender_id, promised, covered))


def replacement_picks(conn, lender_id: str, loan_id: UUID) -> dict[tuple[UUID, UUID | None], int] | None:
    """The Loan's Pick List with every out-of-date pick replaced (``Use suggested picks``): the copies its picks still
    cover where they are, and the rest from the copies no pick covers. None when no pick is out of date."""
    editions = [row['edition_id'] for row in conn.execute(
        'SELECT edition_id FROM loan_line WHERE loan_id=%s AND promised > 0', (loan_id,))]
    picks, short, covered = pick_shortfalls(conn, lender_id, editions)
    mine = [pick for pick in picks if pick['loan_id'] == loan_id]
    if not any(short[pick['id']] for pick in mine):
        return None
    kept: dict[tuple[UUID, UUID | None], int] = {}
    missing: dict[UUID, int] = {}
    for pick in mine:
        key = (pick['edition_id'], pick['source_location_id'])
        if int(pick['quantity']) > short[pick['id']]:
            kept[key] = kept.get(key, 0) + int(pick['quantity']) - short[pick['id']]
        missing[pick['edition_id']] = missing.get(pick['edition_id'], 0) + short[pick['id']]
    for key, copies in suggest_picks(conn, lender_id, missing, covered).items():
        kept[key] = kept.get(key, 0) + copies
    return kept


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
        # 'accept' is also the borrower's answer to a Lend Offer, on its own route (#258).
        if row['state'] != 'requested':
            error(409, 'STEP_NOT_ALLOWED')
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
        # The Loan turns accepted in run_step's one write of its row; the picks never read this Loan's state.
        make_picks(conn, user_id, loan_id, promised)
        advance_revision(conn, user_id)
        # Keeping the requested date checks it as a new one: a date that has passed since the request is refused.
        dated = return_by_columns(conn, row, row['return_by'] if keeps_date else command.return_by)
        # The borrower hears whether all of it was lent (#259).
        record_update(conn, row, user_id,
                      'partly_accepted' if any(promised[edition] < asked[edition] for edition in asked) else 'accepted')
        return {'state': 'accepted', 'accepted_at': NOW, **dated}

    keeps_date = 'return_by' not in command.model_fields_set
    return run_step(user_id, loan_id, command, 'accept', apply, lambda role, row: [row['lender_id']],
                    {'lines': {str(edition): copies for edition, copies in sorted(promised.items(), key=str)},
                     'return_by': 'keep' if keeps_date else command.return_by and command.return_by.isoformat()})


@router.post('/offers', response_model=LoanView, status_code=201)
def send_lend_offer(command: SendLendOffer, user_id: str = Depends(verified_user)):
    """The lender offers a Friend copies from their Collection (**Lend to a Friend…**, #258), reserving them at once
    under the lender's own lock: 409 NOT_ENOUGH_COPIES (with ``edition_id`` and ``available``) when a Location has
    fewer free copies than selected, or the lender fewer copies of an Edition than all open Loans and this offer
    need. Each line is offered and promised in full until the borrower answers."""
    if command.borrower_id == user_id:
        error(409, 'OWN_ACCOUNT')
    places: dict[tuple[UUID, UUID], int] = {}
    for item in command.copies:
        key = (item.edition_id, item.location_id)
        places[key] = places.get(key, 0) + quantity(item.quantity)
    lines: dict[UUID, int] = {}
    for (edition, _), copies in places.items():
        lines[edition] = lines.get(edition, 0) + copies
    if len(lines) > MAX_LOAN_LINES:
        error(422, 'TOO_MANY_LINES')
    payload = {'action': 'loan_offer', **command.model_dump(mode='json', exclude={'idempotency_key'})}
    with connect() as conn, conn.transaction():
        digest, stored = begin_command(conn, user_id, command.idempotency_key, payload)
        if stored is not None:
            return stored
        if command.return_by is not None and command.return_by < today(conn):
            error(422, 'INVALID_RETURN_BY')
        # Only the lender's own rows are read and written; the borrower's are not locked.
        lock_owners(conn, user_id)
        if command.borrower_id not in friend_ids(conn, user_id):
            error(409, 'NOT_FRIENDS')
        editions = sorted(lines, key=str)
        available = can_promise(conn, user_id, editions)
        _, _, covered = pick_shortfalls(conn, user_id, editions)
        held = {(row['edition_id'], row['location_id']): int(row['quantity']) for row in conn.execute(
            'SELECT edition_id, location_id, quantity FROM holding WHERE owner_id=%s AND edition_id = ANY(%s)',
            (user_id, editions))}
        for (edition, location), copies in sorted(places.items(), key=lambda item: (str(item[0][0]), str(item[0][1]))):
            free = held.get((edition, location), 0) - covered.get(edition, {}).get(location, 0)
            if copies > free:
                refuse(409, 'NOT_ENOUGH_COPIES', edition_id=edition, available=max(0, free))
        for edition in editions:
            if lines[edition] > available[edition]:
                refuse(409, 'NOT_ENOUGH_COPIES', edition_id=edition, available=available[edition])
        names = {row['user_id']: row['display_name'] for row in conn.execute(
            'SELECT user_id, display_name FROM collector_profile WHERE user_id = ANY(%s)',
            ([user_id, command.borrower_id],))}
        loan_id = uuid4()
        conn.execute("""INSERT INTO loan(id, kind, state, lender_id, borrower_id, lender_name, borrower_name, return_by)
            VALUES (%s, 'lend_offer', 'offered', %s, %s, %s, %s, %s)""",
                     (loan_id, user_id, command.borrower_id, names[user_id], names[command.borrower_id],
                      command.return_by))
        for position, (edition, copies) in enumerate(lines.items()):
            conn.execute('INSERT INTO loan_line(loan_id, edition_id, position, requested, promised) '
                         'VALUES (%s, %s, %s, %s, %s)', (loan_id, edition, position, copies, copies))
        # The picks in the order selected, so a partial acceptance releases the last ones first.
        for (edition, location), copies in places.items():
            conn.execute('INSERT INTO loan_pick(loan_id, owner_id, edition_id, source_location_id, quantity) '
                         'VALUES (%s, %s, %s, %s, %s)', (loan_id, user_id, edition, location, copies))
        advance_revision(conn, user_id)
        return store(conn, user_id, command.idempotency_key, digest, loan_id)


@router.post('/{loan_id}/accept-offer', response_model=LoanView)
def accept_offer(loan_id: UUID, command: AcceptLendOffer, user_id: str = Depends(verified_user)):
    """The borrower accepts a Lend Offer in whole or in part (#258): each line at most what was offered (422
    MORE_THAN_OFFERED), at least one copy in all (422 NOTHING_PROMISED), and the cards for one of their own Decks (404
    DECK_NOT_FOUND) or Unsorted. The copies not taken stop being reserved, last pick first. Both owners are locked."""
    taken: dict[UUID, int] = {}
    for line in command.lines:
        if line.edition_id in taken:
            error(422, 'DUPLICATE_EDITION')
        taken[line.edition_id] = copies_count(line.promised)

    def apply(conn, row):
        if row['state'] != 'offered':
            error(409, 'STEP_NOT_ALLOWED')
        if row['lender_id'] not in friend_ids(conn, user_id):
            error(409, 'NOT_FRIENDS')
        offered = {line['edition_id']: int(line['promised']) for line in conn.execute(
            'SELECT edition_id, promised FROM loan_line WHERE loan_id=%s', (loan_id,))}
        if set(offered) != set(taken):
            error(422, 'LINES_DONT_MATCH')
        if any(taken[edition] > offered[edition] for edition in offered):
            error(422, 'MORE_THAN_OFFERED')
        if not any(taken.values()):
            error(422, 'NOTHING_PROMISED')
        if command.deck_id is not None and conn.execute(
                "SELECT 1 FROM location WHERE owner_id=%s AND id=%s AND kind='deck'",
                (user_id, command.deck_id)).fetchone() is None:
            error(404, 'DECK_NOT_FOUND')
        released = {edition: offered[edition] - taken[edition] for edition in offered
                    if offered[edition] > taken[edition]}
        if released:
            for edition in sorted(released, key=str):
                conn.execute('UPDATE loan_line SET promised=%s WHERE loan_id=%s AND edition_id=%s',
                             (taken[edition], loan_id, edition))
            cut_picks(conn, row['lender_id'], loan_id, released, 'reserved')
            advance_revision(conn, row['lender_id'])
        # The lender hears whether all of it was taken (#259).
        record_update(conn, row, user_id, 'partly_accepted' if released else 'accepted')
        return {'state': 'accepted', 'accepted_at': NOW, 'deck_id': command.deck_id}

    return run_step(user_id, loan_id, command, 'accept', apply,
                    lambda role, row: [row['lender_id'], row['borrower_id']],
                    {'lines': {str(edition): copies for edition, copies in sorted(taken.items(), key=str)},
                     'deck_id': str(command.deck_id) if command.deck_id else None})


@router.get('/lent-out', response_model=LentOut)
def lent_out(user_id: str = Depends(verified_user)):
    """The Lent out entry: every copy the collector handed over to an open Loan and hasn't had back or written off."""
    with connect() as conn, conn.transaction():
        # The lent picks: what is out once returns (#255) and Write-offs (#257) took theirs.
        rows = conn.execute(f"""SELECT o.id AS loan_id, o.borrower_name, p.edition_id, sum(p.quantity)::bigint AS copies
          FROM loan o JOIN loan_pick p ON p.loan_id = o.id
          WHERE o.lender_id = %s AND p.owner_id = %s AND p.state = 'lent' AND {counts.LENDING}
          GROUP BY o.id, o.borrower_name, p.edition_id""", (user_id, user_id)).fetchall()
        cards = card_facts(conn, [row['edition_id'] for row in rows])
    rows.sort(key=lambda row: (row['borrower_name'].casefold(), cards[row['edition_id']].order(), str(row['loan_id'])))
    return LentOut(cards=[LentCard(
        loan_id=row['loan_id'], edition_id=row['edition_id'], name=cards[row['edition_id']].name,
        set_code=cards[row['edition_id']].set_code, set_name=cards[row['edition_id']].set_name,
        collector_number=cards[row['edition_id']].collector_number, image_url=cards[row['edition_id']].image_url,
        copies=str(row['copies']), borrower=row['borrower_name']) for row in rows],
        copies=str(sum(int(row['copies']) for row in rows)))


def borrowed_copies(conn, user_id: str) -> BorrowedCopies:
    rows = conn.execute("""SELECT b.loan_id, b.edition_id, b.location_id, l.name AS location_name, o.lender_name,
        b.quantity
      FROM borrowed_holding b JOIN location l ON l.owner_id = b.borrower_id AND l.id = b.location_id
      JOIN loan o ON o.id = b.loan_id
      WHERE b.borrower_id = %s""", (user_id,)).fetchall()
    cards = card_facts(conn, [row['edition_id'] for row in rows])
    rows.sort(key=lambda row: (row['location_name'].casefold(), str(row['location_id']),
                               cards[row['edition_id']].order(), row['lender_name'].casefold(), str(row['loan_id'])))
    return BorrowedCopies(cards=[BorrowedCard(
        loan_id=row['loan_id'], edition_id=row['edition_id'], name=cards[row['edition_id']].name,
        set_code=cards[row['edition_id']].set_code, set_name=cards[row['edition_id']].set_name,
        collector_number=cards[row['edition_id']].collector_number, descriptor=cards[row['edition_id']].descriptor,
        image_url=cards[row['edition_id']].image_url, location_id=row['location_id'],
        location_name=row['location_name'], copies=str(row['quantity']), lender=row['lender_name']) for row in rows],
        copies=str(sum(int(row['quantity']) for row in rows)))


@router.get('/borrowed', response_model=BorrowedCopies)
def list_borrowed(user_id: str = Depends(verified_user)):
    """The Collection's Borrowed entry: every Borrowed Copy the collector holds, where it is and whose it is."""
    with connect() as conn, conn.transaction():
        return borrowed_copies(conn, user_id)


@router.post('/borrowed/move', response_model=BorrowedCopies)
def move_borrowed(command: MoveBorrowed, user_id: str = Depends(verified_user)):
    """Moves Borrowed Copies between the borrower's own Storage Leaves and Decks, under the borrower's lock, and
    advances their revision. No Undo record: Undo never touches a Borrowed Copy. Answers the Borrowed list as it now
    stands; the same key replays it. 404 LOCATION_NOT_FOUND for a destination that isn't one of the borrower's Storage
    Leaves or Decks, 409 NOT_ENOUGH_BORROWED when the source holds fewer of the Loan's copies."""
    copies = quantity(command.quantity)
    payload = {'action': 'move_borrowed', **command.model_dump(mode='json', exclude={'idempotency_key'})}
    with connect() as conn, conn.transaction():
        ensure_owner(conn, user_id)
        lock_owners(conn, user_id)
        digest, stored = replay(conn, user_id, command.idempotency_key, payload)
        if stored is not None:
            return stored
        if command.to_location_id == command.from_location_id:
            error(422, 'SAME_LOCATION')
        if first_non_leaf(conn, user_id, [command.to_location_id]) is not None:
            error(404, 'LOCATION_NOT_FOUND')
        held = conn.execute('SELECT quantity FROM borrowed_holding WHERE loan_id=%s AND borrower_id=%s '
                            'AND location_id=%s AND edition_id=%s',
                            (command.loan_id, user_id, command.from_location_id, command.edition_id)).fetchone()
        if held is None or held['quantity'] < copies:
            error(409, 'NOT_ENOUGH_BORROWED')
        key = (command.loan_id, user_id, command.from_location_id, command.edition_id)
        if held['quantity'] == copies:
            conn.execute('DELETE FROM borrowed_holding WHERE loan_id=%s AND borrower_id=%s AND location_id=%s '
                         'AND edition_id=%s', key)
        else:
            conn.execute('UPDATE borrowed_holding SET quantity=quantity-%s WHERE loan_id=%s AND borrower_id=%s '
                         'AND location_id=%s AND edition_id=%s', (copies, *key))
        # A Deck List line covers copies arriving in a Deck (migration 115's borrowed_holding trigger).
        conn.execute("""INSERT INTO borrowed_holding AS b (loan_id, borrower_id, location_id, edition_id, quantity)
          VALUES (%s, %s, %s, %s, %s)
          ON CONFLICT (loan_id, location_id, edition_id) DO UPDATE SET quantity = b.quantity + EXCLUDED.quantity""",
                     (command.loan_id, user_id, command.to_location_id, command.edition_id, copies))
        advance_revision(conn, user_id)
        answer = borrowed_copies(conn, user_id).model_dump(mode='json')
        conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                     (user_id, command.idempotency_key, digest, json.dumps(answer)))
        return answer


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
            awaiting = [LoanPickPlace(edition_id=edition, location_id=location, name=name, copies=str(copies), short='0')
                        for edition, location, name, copies in awaiting_places(conn, user_id, loan_id)]
            return LoanSide(loan_id=loan_id, deck=LoanDeck(**deck) if deck else None, can_promise=[], picks=[],
                            suggested=[], awaiting_choice=awaiting)
        limits = []
        editions = [line['edition_id'] for line in conn.execute(
            'SELECT edition_id FROM loan_line WHERE loan_id=%s ORDER BY position', (loan_id,))]
        if row['state'] == 'requested':
            available = can_promise(conn, user_id, editions)
            limits = [PromiseLimit(edition_id=edition, available=str(available[edition])) for edition in editions]
        names = {location['id']: location['name'] for location in conn.execute(
            'SELECT id, name FROM location WHERE owner_id=%s', (user_id,))}
        position = {edition: index for index, edition in enumerate(editions)}

        def places(found: dict, short: dict) -> list[LoanPickPlace]:
            ordered = sorted(found.items(), key=lambda item: (position.get(item[0][0], 0), -item[1],
                                                               names.get(item[0][1], 'Unsorted').casefold(),
                                                               str(item[0][1])))
            return [LoanPickPlace(edition_id=edition, location_id=location, name=names.get(location, 'Unsorted'),
                                  copies=str(copies), short=str(short.get((edition, location), 0)))
                    for (edition, location), copies in ordered]

        mine: dict = {}
        shortfall: dict = {}
        # A sent Lend Offer's picks (#258) can go out of date as an accepted Loan's can.
        if row['state'] in ('offered', 'accepted') and row['lender_handover_at'] is None:
            picks, short, _ = pick_shortfalls(conn, user_id, editions)
            for pick in picks:
                if pick['loan_id'] == loan_id:
                    key = (pick['edition_id'], pick['source_location_id'])
                    mine[key] = mine.get(key, 0) + int(pick['quantity'])
                    shortfall[key] = shortfall.get(key, 0) + short[pick['id']]
            replaced = replacement_picks(conn, user_id, loan_id)
        else:
            for pick in conn.execute('SELECT edition_id, source_location_id, quantity FROM loan_pick WHERE loan_id=%s '
                                     'AND owner_id=%s', (loan_id, user_id)):
                key = (pick['edition_id'], pick['source_location_id'])
                mine[key] = mine.get(key, 0) + int(pick['quantity'])
            replaced = None
        return LoanSide(loan_id=loan_id, deck=None, can_promise=limits, picks=places(mine, shortfall),
                        suggested=places(replaced, {}) if replaced else [])


def _locations(conn, user_id: str) -> dict:
    """The owner's Locations by id, as ``location_tree.owner_and_rows`` gives them, read under the owner lock
    ``run_step`` took. A Loan step never calls ``owner_and_rows``: its ``FOR UPDATE`` would block the foreign key checks
    the other side's Loan steps take on this owner's row (``social.owners.lock_owners``)."""
    return {row['id']: row for row in conn.execute(
        'SELECT id,name,kind,parent_id,version FROM location WHERE owner_id=%s', (user_id,))}


def _owner_revision(conn, user_id: str) -> int:
    return conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s', (user_id,)).fetchone()['revision']


def _confirmed(row, column: str, other: str) -> dict:
    """The Loan columns one side's handover confirmation sets: its own time, and ``handed_over`` when the other side
    already confirmed. ``row`` is the Loan as ``run_step`` read it under its lock."""
    return {column: NOW, **({'state': 'handed_over'} if row[other] is not None else {})}


@router.post('/{loan_id}/handover', response_model=LoanView)
def confirm_handover(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """One side confirms the handover for its own inventory, under its own lock. The lender's **Mark as handed over**
    takes the picked copies out of their Locations (refused with 409 PICKS_OUT_OF_DATE while a pick is out of date);
    the borrower's **Yes, I have them** puts the promised copies into the Loan's Deck, or Unsorted, as Borrowed Copies.
    Neither takes an Undo record."""
    def apply(conn, row):
        if row['lender_id'] == user_id:
            if replacement_picks(conn, user_id, loan_id) is not None:
                error(409, 'PICKS_OUT_OF_DATE')
            items = [(pick['source_location_id'], pick['edition_id'], int(pick['copies'])) for pick in conn.execute(
                """SELECT source_location_id, edition_id, sum(quantity)::bigint AS copies FROM loan_pick
                WHERE loan_id=%s AND owner_id=%s AND state='reserved' GROUP BY source_location_id, edition_id
                ORDER BY source_location_id, edition_id""", (loan_id, user_id))]
            take_out(conn, user_id, items, _owner_revision(conn, user_id))
            conn.execute("UPDATE loan_pick SET state='lent' WHERE loan_id=%s AND state='reserved'", (loan_id,))
            return _confirmed(row, 'lender_handover_at', 'borrower_handover_at')
        else:
            rows = _locations(conn, user_id)
            destination = row['deck_id'] if row['deck_id'] in rows else unsorted_leaf(conn, user_id, rows, None)
            conn.execute("""INSERT INTO borrowed_holding AS b (loan_id, borrower_id, location_id, edition_id, quantity)
              SELECT %s, %s, %s, edition_id, promised - written_off FROM loan_line
              WHERE loan_id=%s AND promised > written_off
              ON CONFLICT (loan_id, location_id, edition_id) DO UPDATE SET quantity = b.quantity + EXCLUDED.quantity""",
                         (loan_id, user_id, destination, loan_id))
            advance_revision(conn, user_id)
            return _confirmed(row, 'borrower_handover_at', 'lender_handover_at')

    return run_step(user_id, loan_id, step, 'confirm_handover', apply, lambda role, row: [user_id])


@router.post('/{loan_id}/take-back', response_model=LoanView)
def take_back(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """A side takes back its own handover confirmation while the other side hasn't confirmed, under its own lock, and
    only its own inventory write is reversed: the lender's copies go back to their picks' Locations (Unsorted when one
    is gone), the borrower's Borrowed Copies leave. The Loan is accepted again, with its copies reserved."""
    def apply(conn, row):
        if row['lender_id'] == user_id:
            rows = _locations(conn, user_id)
            lent = conn.execute("""SELECT id, source_location_id, edition_id, quantity FROM loan_pick
              WHERE loan_id=%s AND owner_id=%s AND state='lent' ORDER BY id""", (loan_id, user_id)).fetchall()
            sources = sorted({pick['source_location_id'] for pick in lent if pick['source_location_id']}, key=str)
            gone = set()
            for source in sources:
                if first_non_leaf(conn, user_id, [source]) is not None:
                    gone.add(source)
            unsorted = None
            items: dict[tuple, int] = {}
            for pick in lent:
                source = pick['source_location_id']
                if source is None or source in gone:
                    unsorted = unsorted or unsorted_leaf(conn, user_id, rows, None)
                    conn.execute('UPDATE loan_pick SET source_location_id=%s WHERE id=%s', (unsorted, pick['id']))
                    source = unsorted
                items[(source, pick['edition_id'])] = items.get((source, pick['edition_id']), 0) + int(pick['quantity'])
            put_back(conn, user_id, [(source, edition, copies) for (source, edition), copies in
                                     sorted(items.items(), key=lambda item: (str(item[0][0]), str(item[0][1])))],
                     _owner_revision(conn, user_id))
            conn.execute("UPDATE loan_pick SET state='reserved' WHERE loan_id=%s AND state='lent'", (loan_id,))
            return {'lender_handover_at': None}
        else:
            conn.execute('DELETE FROM borrowed_holding WHERE loan_id=%s AND borrower_id=%s', (loan_id, user_id))
            advance_revision(conn, user_id)
            return {'borrower_handover_at': None}

    return run_step(user_id, loan_id, step, 'take_back', apply, lambda role, row: [user_id])


@router.post('/{loan_id}/picks/use-suggested', response_model=LoanView)
def use_suggested_picks(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """The lender replaces every out-of-date pick with the suggested one (``LoanSide.suggested``), under their lock.
    409 PICKS_UP_TO_DATE when no pick is out of date."""
    def apply(conn, row):
        if row['lender_id'] != user_id:
            error(409, 'STEP_NOT_ALLOWED')
        replaced = replacement_picks(conn, user_id, loan_id)
        if replaced is None:
            error(409, 'PICKS_UP_TO_DATE')
        conn.execute("DELETE FROM loan_pick WHERE loan_id=%s AND state='reserved'", (loan_id,))
        insert_picks(conn, user_id, loan_id, replaced)
        advance_revision(conn, user_id)
        return None

    # Allowed while the lender may still confirm the handover; its own name keeps its digest apart from the handover's.
    return run_step(user_id, loan_id, step, 'confirm_handover', apply, lambda role, row: [user_id],
                    {'command': 'use_suggested_picks'})


def lent_by_edition(conn, loan_id: UUID) -> dict[UUID, int]:
    """The lender's copies out on a Loan, by Edition: its lent picks."""
    return {row['edition_id']: int(row['copies']) for row in conn.execute(
        """SELECT edition_id, sum(quantity)::bigint AS copies FROM loan_pick WHERE loan_id=%s AND state='lent'
        GROUP BY edition_id""", (loan_id,))}


def borrowed_out(conn, loan_id: UUID) -> dict[UUID, int]:
    """The borrower's copies out on a Loan, by Edition: promised, less those written off (#257) and those the borrower
    confirmed returning (#255). Copies written off and still held wait for the borrower's keep-or-remove choice."""
    return {row['edition_id']: int(row['copies']) for row in conn.execute(
        """SELECT l.edition_id, l.promised - l.written_off - coalesce((SELECT sum(rl.quantity) FROM loan_return_line rl
            JOIN loan_return r ON r.id = rl.return_id
            WHERE r.loan_id = l.loan_id AND rl.edition_id = l.edition_id AND r.borrower_confirmed_at IS NOT NULL), 0)
            AS copies
          FROM loan_line l WHERE l.loan_id = %s""", (loan_id,))}


def return_lent(conn, user_id: str, loan_id: UUID, lines: dict[UUID, int]) -> None:
    """The lender's side of a return: each Edition's copies leave the Loan's lent picks, last pick first, and go back to
    the pick's source Location, or Unsorted when the source is gone or holds no cards now, with no Undo record (as a
    take-back puts them back). 409 MORE_THAN_OUT when the picks hold fewer."""
    rows = _locations(conn, user_id)
    unsorted = None
    items: dict[tuple, int] = {}
    for edition, copies in sorted(lines.items(), key=lambda item: str(item[0])):
        left = copies
        for pick in conn.execute("""SELECT id, source_location_id, quantity FROM loan_pick
          WHERE loan_id=%s AND owner_id=%s AND edition_id=%s AND state='lent' ORDER BY id DESC""",
                                 (loan_id, user_id, edition)).fetchall():
            if left == 0:
                break
            taken = min(left, int(pick['quantity']))
            left -= taken
            source = pick['source_location_id']
            if source is None or first_non_leaf(conn, user_id, [source]) is not None:
                unsorted = unsorted or unsorted_leaf(conn, user_id, rows, None)
                source = unsorted
            if taken == pick['quantity']:
                conn.execute('DELETE FROM loan_pick WHERE id=%s', (pick['id'],))
            else:
                conn.execute('UPDATE loan_pick SET quantity=quantity-%s WHERE id=%s', (taken, pick['id']))
            items[(source, edition)] = items.get((source, edition), 0) + taken
        if left:
            refuse(409, 'MORE_THAN_OUT', edition_id=edition, out=copies - left)
    put_back(conn, user_id, [(source, edition, copies) for (source, edition), copies in
                             sorted(items.items(), key=lambda item: (str(item[0][0]), str(item[0][1])))],
             _owner_revision(conn, user_id))


def give_back(conn, user_id: str, loan_id: UUID, lines: dict[UUID, int]) -> None:
    """The borrower's side of a return: each Edition's Borrowed Copies of the Loan leave, from loose Locations first,
    largest first, then Decks, whose lines stay (spec story 115). 409 MORE_THAN_OUT when fewer are held."""
    for edition, copies in sorted(lines.items(), key=lambda item: str(item[0])):
        left = copies
        for place in conn.execute("""SELECT b.location_id, b.quantity FROM borrowed_holding b
          JOIN location l ON l.owner_id = b.borrower_id AND l.id = b.location_id
          WHERE b.loan_id=%s AND b.borrower_id=%s AND b.edition_id=%s
          ORDER BY (l.kind = 'deck'), b.quantity DESC, b.location_id""", (loan_id, user_id, edition)).fetchall():
            if left == 0:
                break
            taken = min(left, int(place['quantity']))
            left -= taken
            if taken == place['quantity']:
                conn.execute('DELETE FROM borrowed_holding WHERE loan_id=%s AND location_id=%s AND edition_id=%s',
                             (loan_id, place['location_id'], edition))
            else:
                conn.execute("""UPDATE borrowed_holding SET quantity=quantity-%s
                  WHERE loan_id=%s AND location_id=%s AND edition_id=%s""",
                             (taken, loan_id, place['location_id'], edition))
        if left:
            refuse(409, 'MORE_THAN_OUT', edition_id=edition, out=copies - left)
    advance_revision(conn, user_id)


def close_if_settled(conn, row, user_id: str) -> dict | None:
    """Closes the Loan once nothing is out (spec "Closing"): no return pending, the lender's side settled (no lent
    copies left, or the lender is gone) and the borrower's (no Borrowed Copies of the Loan left, never confirmed the
    handover, or gone). ``returned`` when nothing was written off, else ``written_off``. Returns ``close``'s columns for
    the step to return, so closing is part of the step's one write of the Loan row, or None when the Loan stays open.
    Decided from ``row``, read under the Loan row lock. The borrower's copies are read by Loan, as a count, under the
    Loan row lock every step that changes them holds."""
    loan_id = row['id']
    if conn.execute('SELECT 1 FROM loan_return WHERE loan_id=%s AND completed_at IS NULL', (loan_id,)).fetchone():
        return None
    sides = [side for side in (row['lender_id'], row['borrower_id']) if side is not None]
    alive = {profile['user_id'] for profile in conn.execute(
        'SELECT user_id FROM collector_profile WHERE user_id = ANY(%s)', (sides,))}
    if row['lender_id'] in alive and (row['lender_handover_at'] is None or conn.execute(
            "SELECT 1 FROM loan_pick WHERE loan_id=%s AND state='lent' LIMIT 1", (loan_id,)).fetchone()):
        return None
    if row['borrower_id'] in alive and row['borrower_handover_at'] is not None and conn.execute(
            'SELECT 1 FROM borrowed_holding WHERE loan_id=%s LIMIT 1', (loan_id,)).fetchone():
        return None
    written_off = conn.execute('SELECT 1 FROM loan_line WHERE loan_id=%s AND written_off > 0 LIMIT 1',
                               (loan_id,)).fetchone()
    return close(conn, row, user_id, 'written_off' if written_off else 'returned')


def _other_gone(conn, user_id: str, row) -> bool:
    other = row['borrower_id'] if row['lender_id'] == user_id else row['lender_id']
    return other is None or conn.execute('SELECT 1 FROM collector_profile WHERE user_id=%s',
                                         (other,)).fetchone() is None


@router.post('/{loan_id}/returns', response_model=LoanView)
def start_return(loan_id: UUID, command: StartReturn, user_id: str = Depends(verified_user)):
    """Either side starts a return of copies out from its side, which is its confirmation: its own inventory moves now
    (``return_lent`` or ``give_back``). Each line is at most the copies out from the caller's side (409 MORE_THAN_OUT);
    a line of 0 is left out (422 NOTHING_RETURNED when all are). Complete at once when the other side's account is
    gone."""
    lines: dict[UUID, int] = {}
    for line in command.lines:
        if line.edition_id in lines:
            error(422, 'DUPLICATE_EDITION')
        lines[line.edition_id] = copies_count(line.quantity)
    lines = {edition: copies for edition, copies in lines.items() if copies}
    if not lines:
        error(422, 'NOTHING_RETURNED')

    def apply(conn, row):
        lender = row['lender_id'] == user_id
        out = lent_by_edition(conn, loan_id) if lender else borrowed_out(conn, loan_id)
        on_loan = {line['edition_id'] for line in conn.execute('SELECT edition_id FROM loan_line WHERE loan_id=%s',
                                                                 (loan_id,))}
        if set(lines) - on_loan:
            error(422, 'NOT_ON_LOAN')
        for edition, copies in sorted(lines.items(), key=lambda item: str(item[0])):
            if copies > out.get(edition, 0):
                refuse(409, 'MORE_THAN_OUT', edition_id=edition, out=out.get(edition, 0))
        side = 'lender' if lender else 'borrower'
        return_id = uuid4()
        conn.execute(f"""INSERT INTO loan_return(id, loan_id, started_by, {side}_confirmed_at, completed_at)
          VALUES (%s, %s, %s, now(), CASE WHEN %s THEN now() END)""",
                     (return_id, loan_id, side, _other_gone(conn, user_id, row)))
        for edition, copies in sorted(lines.items(), key=lambda item: str(item[0])):
            conn.execute('INSERT INTO loan_return_line(return_id, loan_id, edition_id, quantity) VALUES (%s,%s,%s,%s)',
                         (return_id, loan_id, edition, copies))
        (return_lent if lender else give_back)(conn, user_id, loan_id, lines)
        return close_if_settled(conn, row, user_id)

    return run_step(user_id, loan_id, command, 'start_return', apply, lambda role, row: [user_id],
                    {'lines': {str(edition): copies for edition, copies in sorted(lines.items(), key=str)}})


@router.post('/{loan_id}/returns/confirm', response_model=LoanView)
def confirm_return(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """The other side confirms the pending return for its own inventory, which completes it. Once the other side's
    account is gone, the side that started the return finishes it alone: its own inventory already moved when it
    started, so finishing moves nothing and only completes the return, and the Loan closes once nothing is out."""
    def apply(conn, row):
        lender = row['lender_id'] == user_id
        side = 'lender' if lender else 'borrower'
        pending = conn.execute('SELECT id, started_by FROM loan_return WHERE loan_id=%s AND completed_at IS NULL',
                               (loan_id,)).fetchone()
        if pending['started_by'] == side:
            conn.execute('UPDATE loan_return SET completed_at=now() WHERE id=%s', (pending['id'],))
            return close_if_settled(conn, row, user_id)
        lines = {line['edition_id']: int(line['quantity']) for line in conn.execute(
            'SELECT edition_id, quantity FROM loan_return_line WHERE return_id=%s', (pending['id'],))}
        (return_lent if lender else give_back)(conn, user_id, loan_id, lines)
        conn.execute(f'UPDATE loan_return SET {side}_confirmed_at=now(), completed_at=now() WHERE id=%s',
                     (pending['id'],))
        return close_if_settled(conn, row, user_id)

    return run_step(user_id, loan_id, step, 'confirm_return', apply, lambda role, row: [user_id])


def cut_picks(conn, user_id: str, loan_id: UUID, lines: dict[UUID, int], state: str = 'lent') -> None:
    """Takes each Edition's copies off the Loan's picks in ``state``, last pick first, putting them nowhere: lent
    copies a Write-off takes, or reserved copies a partly accepted Lend Offer releases (#258)."""
    for edition, copies in sorted(lines.items(), key=lambda item: str(item[0])):
        left = copies
        for pick in conn.execute("""SELECT id, quantity FROM loan_pick
          WHERE loan_id=%s AND owner_id=%s AND edition_id=%s AND state=%s ORDER BY id DESC""",
                                 (loan_id, user_id, edition, state)).fetchall():
            if left == 0:
                break
            taken = min(left, int(pick['quantity']))
            left -= taken
            if taken == pick['quantity']:
                conn.execute('DELETE FROM loan_pick WHERE id=%s', (pick['id'],))
            else:
                conn.execute('UPDATE loan_pick SET quantity=quantity-%s WHERE id=%s', (taken, pick['id']))


@router.post('/{loan_id}/write-off', response_model=LoanView)
def write_off(loan_id: UUID, command: WriteOff, user_id: str = Depends(verified_user)):
    """The lender writes off copies out on the Loan (**Write off…**), under their own lock, once they confirmed the
    handover. Each line is at most the copies out, less those a return the borrower confirmed gives back (409
    MORE_THAN_OUT); a line of 0 is left out (422 NOTHING_WRITTEN_OFF when all are). Final: no Undo, and no take-back
    of the handover after it. The copies leave the lender's Collection; the borrower's rows are untouched."""
    lines: dict[UUID, int] = {}
    for line in command.lines:
        if line.edition_id in lines:
            error(422, 'DUPLICATE_EDITION')
        lines[line.edition_id] = copies_count(line.quantity)
    lines = {edition: copies for edition, copies in lines.items() if copies}
    if not lines:
        error(422, 'NOTHING_WRITTEN_OFF')

    def apply(conn, row):
        on_loan = {line['edition_id'] for line in conn.execute('SELECT edition_id FROM loan_line WHERE loan_id=%s',
                                                                 (loan_id,))}
        if set(lines) - on_loan:
            error(422, 'NOT_ON_LOAN')
        out = lent_by_edition(conn, loan_id)
        # A return the borrower confirmed and the lender hasn't brings those copies back: they can't be written off.
        for line in conn.execute("""SELECT l.edition_id, l.quantity FROM loan_return r
          JOIN loan_return_line l ON l.return_id = r.id
          WHERE r.loan_id=%s AND r.completed_at IS NULL AND r.lender_confirmed_at IS NULL""", (loan_id,)):
            out[line['edition_id']] = out.get(line['edition_id'], 0) - int(line['quantity'])
        for edition, copies in sorted(lines.items(), key=lambda item: str(item[0])):
            if copies > out.get(edition, 0):
                refuse(409, 'MORE_THAN_OUT', edition_id=edition, out=max(0, out.get(edition, 0)))
        cut_picks(conn, user_id, loan_id, lines)
        for edition, copies in lines.items():
            conn.execute('UPDATE loan_line SET written_off = written_off + %s WHERE loan_id=%s AND edition_id=%s',
                         (copies, loan_id, edition))
        advance_revision(conn, user_id)
        return close_if_settled(conn, row, user_id)

    return run_step(user_id, loan_id, command, 'write_off', apply, lambda role, row: [user_id],
                    {'lines': {str(edition): copies for edition, copies in sorted(lines.items(), key=str)}})


def awaiting_places(conn, user_id: str, loan_id: UUID) -> list[tuple[UUID, UUID, str, int]]:
    """Where the borrower's written-off copies awaiting their choice are, as (Edition id, Location id, Location name,
    copies): each Edition's count taken from its Borrowed Copies of the Loan in ``give_back``'s order, loose Locations
    first, largest first, then Decks, so the copies a Deck holds stay borrowed in it longest."""
    out = borrowed_out(conn, loan_id)
    held: dict[UUID, list] = {}
    for place in conn.execute("""SELECT b.edition_id, b.location_id, l.name, b.quantity FROM borrowed_holding b
      JOIN location l ON l.owner_id = b.borrower_id AND l.id = b.location_id
      WHERE b.loan_id=%s AND b.borrower_id=%s
      ORDER BY b.edition_id, (l.kind = 'deck'), b.quantity DESC, b.location_id""", (loan_id, user_id)):
        held.setdefault(place['edition_id'], []).append(place)
    position = {line['edition_id']: line['position'] for line in conn.execute(
        'SELECT edition_id, position FROM loan_line WHERE loan_id=%s', (loan_id,))}
    found = []
    for edition in sorted(held, key=lambda edition: position.get(edition, 0)):
        left = sum(int(place['quantity']) for place in held[edition]) - out.get(edition, 0)
        for place in held[edition]:
            if left <= 0:
                break
            taken = min(left, int(place['quantity']))
            left -= taken
            found.append((edition, place['location_id'], place['name'], taken))
    return found


@router.post('/{loan_id}/written-off', response_model=LoanView)
def choose_written_off(loan_id: UUID, command: WrittenOffChoice, user_id: str = Depends(verified_user)):
    """The borrower's choice for the written-off copies they hold (**I still have it** or **It's gone**), under their
    own lock. ``places`` must be exactly ``LoanSide.awaiting_choice`` (409 CHOICE_CHANGED otherwise). Keep turns the
    copies into owned Holdings where they sit, with one Undo record per Location, as copies added there; they were
    already there, so no Deck List line changes. Remove takes them away, with no Undo."""
    places: dict[tuple[UUID, UUID], int] = {}
    for place in command.places:
        key = (place.location_id, place.edition_id)
        if key in places:
            error(422, 'DUPLICATE_PLACE')
        places[key] = quantity(place.copies)

    def apply(conn, row):
        expected = {(location, edition): copies for edition, location, _, copies in
                    awaiting_places(conn, user_id, loan_id)}
        if places != expected:
            error(409, 'CHOICE_CHANGED')
        for (location, edition), copies in sorted(places.items(), key=lambda item: (str(item[0][0]), str(item[0][1]))):
            conn.execute('DELETE FROM borrowed_holding WHERE loan_id=%s AND location_id=%s AND edition_id=%s '
                         'AND quantity=%s', (loan_id, location, edition, copies))
            conn.execute("""UPDATE borrowed_holding SET quantity=quantity-%s
              WHERE loan_id=%s AND location_id=%s AND edition_id=%s AND quantity>%s""",
                         (copies, loan_id, location, edition, copies))
        if command.choice == 'keep':
            new_revision = _owner_revision(conn, user_id) + 1
            # Already in these Locations as Borrowed Copies: no Deck List line grows (migration 047's switch).
            conn.execute("SELECT set_config('tcg.undo_returns_surplus','on',true)")
            by_location: dict[UUID, list] = {}
            for (location, edition), copies in places.items():
                by_location.setdefault(location, []).append((edition, copies))
            for location in sorted(by_location, key=str):
                items = sorted(by_location[location], key=lambda item: str(item[0]))
                for edition, copies in items:
                    held = conn.execute('SELECT quantity FROM holding WHERE owner_id=%s AND location_id=%s '
                                        'AND edition_id=%s', (user_id, location, edition)).fetchone()
                    if held and held['quantity'] > MAX_QUANTITY - copies:
                        error(409, 'QUANTITY_OVERFLOW')
                    conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
                      VALUES (%s,%s,%s,%s,%s) ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE
                      SET quantity=holding.quantity+EXCLUDED.quantity, version=EXCLUDED.version""",
                                 (user_id, location, edition, copies, new_revision))
                record_undo(conn, user_id,
                            undo_id_for(user_id, uuid5(NAMESPACE_URL, f'{command.idempotency_key}:{location}')),
                            'add', location, [],
                            json.dumps([{'edition_id': str(edition), 'quantity': str(copies)}
                                        for edition, copies in items]))
            # The switch covers only the inserts above; nothing later in the step adds copies without growing a line.
            conn.execute("SELECT set_config('tcg.undo_returns_surplus','off',true)")
            conn.execute('UPDATE inventory_owner SET revision=%s WHERE user_id=%s', (new_revision, user_id))
        else:
            advance_revision(conn, user_id)
        return close_if_settled(conn, row, user_id)

    return run_step(user_id, loan_id, command, 'choose_written_off', apply, lambda role, row: [user_id],
                    {'choice': command.choice,
                     'places': sorted([str(location), str(edition), copies]
                                      for (location, edition), copies in places.items())})


# The reassigner's open Loans, either side, with a line for the Edition: read with ``%(me)s`` and ``%(edition)s``.
_NAMING = """FROM loan o WHERE (o.lender_id = %(me)s OR o.borrower_id = %(me)s) AND o.state <> 'closed'
  AND EXISTS (SELECT 1 FROM loan_line l WHERE l.loan_id = o.id AND l.edition_id = %(edition)s)"""


def replacement_parties(conn, user_id: str, edition: UUID) -> set[str]:
    """The other collectors on the reassigner's open Loans that name ``edition``. An unlocked read, so the reassignment
    can lock every owner in ascending ``user_id`` before it reads those Loans again (``follow_replacement``)."""
    return {row['other'] for row in conn.execute(
        'SELECT CASE WHEN o.lender_id = %(me)s THEN o.borrower_id ELSE o.lender_id END AS other ' + _NAMING,
        {'me': user_id, 'edition': edition})} - {None}


def follow_replacement(conn, user_id: str, edition: UUID, replacement: UUID, copies: int, locked: set[str]) -> None:
    """Carries the reassigner's open Loans that name ``edition`` onto ``replacement``, as their ``copies`` of it become
    the replacement (spec item 15). The caller holds every owner in ``locked`` (the reassigner and each other side
    ``replacement_parties`` found), taken in ascending ``user_id``; a Loan whose other side isn't among them (one made
    since) stays as it is. The Loan rows are locked in id order.

    Which Loans move: once the lender confirmed the handover, every one, whichever side reassigns. Before that, only
    the lender's own reassignment moves a Loan: a request (nothing reserved) always; Lend Offers and accepted Loans,
    which reserve the lender's copies, together, and only when the lender's copies of the replacement after this
    reassignment cover everything then promised in it (otherwise none of them move, and the caller's promise check on
    ``edition`` applies as before). Reassigning the lender's last copies of ``edition`` always passes that check.

    Each Loan moved is written once (``write_loan``: its revision moves, so an open screen of either side reloads), and
    each other side's inventory revision moves once. Nothing about either side's Locations or Decks reaches the
    other."""
    rows = conn.execute('SELECT o.* ' + _NAMING + ' ORDER BY o.id FOR NO KEY UPDATE OF o',
                        {'me': user_id, 'edition': edition}).fetchall()
    rows = [row for row in rows
            if all(side is None or side in locked for side in (row['lender_id'], row['borrower_id']))]
    moving = [row for row in rows if row['lender_handover_at'] is not None
              or (row['lender_id'] == user_id and row['state'] == 'requested')]
    reserving = [row for row in rows if row['lender_handover_at'] is None and row['lender_id'] == user_id
                 and row['state'] in ('offered', 'accepted')]
    if reserving:
        promised = conn.execute('SELECT coalesce(sum(promised), 0) AS copies FROM loan_line '
                                'WHERE loan_id = ANY(%s) AND edition_id = %s',
                                ([row['id'] for row in reserving], edition)).fetchone()['copies']
        held = conn.execute('SELECT coalesce(sum(quantity), 0) AS copies FROM holding '
                            'WHERE owner_id=%s AND edition_id=%s', (user_id, replacement)).fetchone()['copies']
        if held + copies >= counts.reserved_counts(conn, user_id, [replacement]).get(replacement, 0) + promised:
            moving += reserving
    others: set[str] = set()
    for row in sorted(moving, key=lambda found: str(found['id'])):
        _move_lines(conn, row['id'], edition, replacement)
        write_loan(conn, row['id'], {})
        others |= {side for side in (row['lender_id'], row['borrower_id']) if side not in (None, user_id)}
    for other in sorted(others):
        advance_revision(conn, other)


def _move_lines(conn, loan_id: UUID, edition: UUID, replacement: UUID) -> None:
    """Points one Loan's line for ``edition`` at ``replacement``, merging with a line it already has for it: the line's
    counts, then its picks, its return lines and its Borrowed Copies (each merged on its own key), then the old line,
    which nothing names any more. Borrowed Copies arriving in a Deck as the replacement raise its line for the
    replacement, as owned copies reassigned there do; the old Edition's line stays."""
    args = {'loan': loan_id, 'old': edition, 'new': replacement}
    conn.execute("""INSERT INTO loan_line(loan_id, edition_id, position, requested, promised, written_off)
      SELECT loan_id, %(new)s, position, requested, promised, written_off FROM loan_line
      WHERE loan_id = %(loan)s AND edition_id = %(old)s
      ON CONFLICT (loan_id, edition_id) DO UPDATE SET position = least(loan_line.position, EXCLUDED.position),
        requested = loan_line.requested + EXCLUDED.requested, promised = loan_line.promised + EXCLUDED.promised,
        written_off = loan_line.written_off + EXCLUDED.written_off""", args)
    conn.execute('UPDATE loan_pick SET edition_id = %(new)s WHERE loan_id = %(loan)s AND edition_id = %(old)s', args)
    conn.execute("""INSERT INTO loan_return_line(return_id, loan_id, edition_id, quantity)
      SELECT return_id, loan_id, %(new)s, quantity FROM loan_return_line
      WHERE loan_id = %(loan)s AND edition_id = %(old)s
      ON CONFLICT (return_id, edition_id) DO UPDATE SET quantity = loan_return_line.quantity + EXCLUDED.quantity""",
                 args)
    conn.execute('DELETE FROM loan_return_line WHERE loan_id = %(loan)s AND edition_id = %(old)s', args)
    conn.execute("""INSERT INTO borrowed_holding(loan_id, borrower_id, location_id, edition_id, quantity)
      SELECT loan_id, borrower_id, location_id, %(new)s, quantity FROM borrowed_holding
      WHERE loan_id = %(loan)s AND edition_id = %(old)s
      ON CONFLICT (loan_id, location_id, edition_id)
      DO UPDATE SET quantity = borrowed_holding.quantity + EXCLUDED.quantity""", args)
    conn.execute('DELETE FROM borrowed_holding WHERE loan_id = %(loan)s AND edition_id = %(old)s', args)
    conn.execute('DELETE FROM loan_line WHERE loan_id = %(loan)s AND edition_id = %(old)s', args)
