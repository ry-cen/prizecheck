"""Loans: Borrow Requests and the Loans they become (social network #252, spec "Loans, requests and the state model").

Both sides read the same Loan facts here (``GET /api/social/loans`` and ``GET /api/social/loans/{id}``): the cards, what
was asked and promised, each side's handover confirmation and the other collector's Display Name, never a Location or
a Deck of either side. The steps that change no inventory are here too: the lender's decline, the borrower's withdraw
and either side's cancel of an accepted Loan nobody has confirmed a handover for. The steps that read or write a
collector's own inventory (sending a request that names the borrower's Deck, accepting with the Loan Pick List, each
side's own view of the Loan; from #253 the handover) are inventory code in ``app.loan_inventory`` under ``/api/loans``.
They run through ``run_step`` and answer ``loan_view`` too, so every step answers the same Loan.

**Steps** name the Loan ``revision`` they read (409 LOAN_CHANGED when it moved on) and an idempotency key (replayed from
``location_command``, as Friend commands are). ``allowed`` is the one rule for which steps a collector may take now: the
view's ``actions`` list them and a step not in it is 409 STEP_NOT_ALLOWED. A collector who isn't one of the Loan's two
sides gets 404 LOAN_NOT_FOUND, as for a Loan that doesn't exist.

**Locks** follow the spec's table ("Locks and revisions"): owner rows in ascending ``user_id`` (``owners.lock_owners``),
then the ``loan`` row. Decline locks the lender; withdraw only the Loan; cancel the canceller and, when the borrower
cancels, the lender as well. Cancelling an accepted Loan releases its reserved copies, so it advances the lender's
inventory revision.

**Limit.** Loan steps that reach the other collector count against ``COMMANDS_PER_HOUR`` per account under kind
'loan_command' (``count_loan_command``), apart from the Friend commands' count. A replay isn't counted again; the count
is taken before any other collector's row is locked; a refused step rolls back with its count.

**Needs you** (``needs_you``) is the one definition the Loans tab and, from #259, the inbox read. ``section`` places a
Loan on the Loans tab: needs you, out now, pending or history.
"""
import json
from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..location_tree import error, replay
from ..main import connect, verified_user
from .friend_reads import card_facts
from .owners import ensure_owner, lock_owners

router = APIRouter(prefix='/api/social/loans', tags=['social'])

COMMANDS_PER_HOUR = 120
# Closed Loans the Loans tab lists under History, newest first.
HISTORY = 50

Action = Literal['accept', 'decline', 'withdraw', 'cancel', 'edit_and_resend']
Section = Literal['needs_you', 'out_now', 'pending', 'history']


class LoanParty(BaseModel):
    """The other side of a Loan. ``collector_id`` addresses a new request ("Edit and resend") and is never shown; it
    and ``handle`` are None once the collector deleted their account, and ``display_name`` is the name they had."""
    collector_id: str | None
    display_name: str
    handle: str | None


class LoanCard(BaseModel):
    """One line of a Loan: a Card Edition, the copies asked for and the copies promised ("0" before acceptance and for a
    line the lender left out), and those written off (#257)."""
    edition_id: UUID
    name: str
    set_code: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    requested: str
    promised: str
    written_off: str


class LoanView(BaseModel):
    """A Loan as one side reads it. ``role``: the reader is the lender or the borrower. ``closed_by``: who declined,
    withdrew or cancelled, 'you' or 'them'. ``actions``: the steps the reader may take now. ``revision``: send it back
    with a step."""
    id: UUID
    kind: Literal['borrow_request', 'lend_offer']
    state: Literal['requested', 'offered', 'accepted', 'handed_over', 'closed']
    closed_reason: Literal['declined', 'withdrawn', 'cancelled', 'returned', 'written_off'] | None
    closed_by: Literal['you', 'them'] | None
    role: Literal['lender', 'borrower']
    other: LoanParty
    return_by: date | None
    you_confirmed_handover: bool
    they_confirmed_handover: bool
    lines: list[LoanCard]
    needs_you: bool
    section: Section
    actions: list[Action]
    revision: int


class LoansView(BaseModel):
    """The Loans tab: every open Loan and the newest closed ones, newest first; ``needs_you`` counts the Loans that
    need the reader (the tab's badge, #259)."""
    loans: list[LoanView]
    needs_you: int


class LoanStep(BaseModel):
    revision: int = Field(ge=1)
    idempotency_key: UUID


def role_of(user_id: str, row) -> str:
    return 'lender' if row['lender_id'] == user_id else 'borrower'


def confirmed(user_id: str, row) -> tuple[bool, bool]:
    """(the reader confirmed the handover, the other side did)."""
    lender, borrower = row['lender_handover_at'] is not None, row['borrower_handover_at'] is not None
    return (lender, borrower) if role_of(user_id, row) == 'lender' else (borrower, lender)


def needs_you(user_id: str, row) -> bool:
    """Whether the Loan waits on the reader: a Borrow Request to answer (lender) or a Lend Offer to answer (borrower,
    #258), or a handover the other side confirmed and the reader hasn't (#253). #259's inbox adds its own items."""
    role = role_of(user_id, row)
    if row['state'] == 'requested':
        return role == 'lender'
    if row['state'] == 'offered':
        return role == 'borrower'
    if row['state'] == 'accepted':
        mine, theirs = confirmed(user_id, row)
        return theirs and not mine
    return False


def section(user_id: str, row) -> str:
    if row['state'] == 'closed':
        return 'history'
    if needs_you(user_id, row):
        return 'needs_you'
    if row['state'] == 'handed_over' or row['lender_handover_at'] is not None or row['borrower_handover_at'] is not None:
        return 'out_now'
    return 'pending'


def allowed(user_id: str, row, other_exists: bool = True) -> list[str]:
    """The steps the reader may take now, in the order the Loan screen offers them."""
    role, state = role_of(user_id, row), row['state']
    found = []
    if state == 'requested' and role == 'lender':
        found += ['accept', 'decline']
    if state == 'requested' and role == 'borrower':
        found.append('withdraw')
    if state == 'accepted' and row['lender_handover_at'] is None and row['borrower_handover_at'] is None:
        found.append('cancel')
    if (role == 'borrower' and row['kind'] == 'borrow_request' and other_exists
            and (state == 'requested' or (state == 'closed'
                                          and row['closed_reason'] in ('declined', 'withdrawn', 'cancelled')))):
        found.append('edit_and_resend')
    return found


LOANS = """SELECT o.* FROM loan o WHERE (o.lender_id = %(me)s OR o.borrower_id = %(me)s)"""


def loan_views(conn, user_id: str, rows) -> list[LoanView]:
    """The reader's views of these Loan rows, in their order: one read of their lines, one of card facts and one of the
    other sides' profiles, whatever the number of Loans."""
    rows = list(rows)
    if not rows:
        return []
    lines: dict[UUID, list] = {}
    for line in conn.execute('SELECT loan_id, edition_id, requested, promised, written_off FROM loan_line '
                             'WHERE loan_id = ANY(%s) ORDER BY loan_id, position', ([row['id'] for row in rows],)):
        lines.setdefault(line['loan_id'], []).append(line)
    cards = card_facts(conn, [line['edition_id'] for found in lines.values() for line in found])
    others = {row['borrower_id'] if row['lender_id'] == user_id else row['lender_id'] for row in rows} - {None}
    handles = {profile['user_id']: profile['handle'] for profile in conn.execute(
        'SELECT user_id, handle FROM collector_profile WHERE user_id = ANY(%s)', (sorted(others),))} if others else {}
    views = []
    for row in rows:
        role = role_of(user_id, row)
        other_id = row['borrower_id'] if role == 'lender' else row['lender_id']
        mine, theirs = confirmed(user_id, row)
        card_lines = []
        for line in lines.get(row['id'], []):
            card = cards[line['edition_id']]
            card_lines.append(LoanCard(
                edition_id=card.edition_id, name=card.name, set_code=card.set_code, set_name=card.set_name,
                collector_number=card.collector_number, descriptor=card.descriptor, image_url=card.image_url,
                requested=str(line['requested']), promised=str(line['promised']),
                written_off=str(line['written_off'])))
        closed_by = None if row['closed_by'] is None else 'you' if row['closed_by'] == user_id else 'them'
        views.append(LoanView(
            id=row['id'], kind=row['kind'], state=row['state'], closed_reason=row['closed_reason'],
            closed_by=closed_by, role=role,
            other=LoanParty(collector_id=other_id if other_id in handles else None,
                            display_name=row['borrower_name'] if role == 'lender' else row['lender_name'],
                            handle=handles.get(other_id)),
            return_by=row['return_by'], you_confirmed_handover=mine, they_confirmed_handover=theirs,
            lines=card_lines, needs_you=needs_you(user_id, row), section=section(user_id, row),
            actions=allowed(user_id, row, other_id in handles), revision=row['revision']))
    return views


def loan_view(conn, user_id: str, loan_id: UUID) -> LoanView:
    """One Loan as the reader sees it, or 404 LOAN_NOT_FOUND when they aren't one of its sides."""
    row = conn.execute(LOANS + ' AND o.id = %(id)s', {'me': user_id, 'id': loan_id}).fetchone()
    if row is None:
        error(404, 'LOAN_NOT_FOUND')
    return loan_views(conn, user_id, [row])[0]


@router.get('', response_model=LoansView)
def list_loans(user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        open_rows = conn.execute(LOANS + " AND o.state <> 'closed' ORDER BY o.created_at DESC, o.id",
                                 {'me': user_id}).fetchall()
        closed_rows = conn.execute(LOANS + " AND o.state = 'closed' ORDER BY o.closed_at DESC, o.id LIMIT %(limit)s",
                                   {'me': user_id, 'limit': HISTORY}).fetchall()
        views = loan_views(conn, user_id, open_rows + closed_rows)
    return LoansView(loans=views, needs_you=sum(view.needs_you for view in views))


@router.get('/{loan_id}', response_model=LoanView)
def read_loan(loan_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        return loan_view(conn, user_id, loan_id)


def count_loan_command(conn, user_id: str) -> None:
    """Counts one Loan step against the hourly limit: rows older than an hour pruned, and 429 TOO_MANY_CHANGES with
    ``retry_after_minutes`` at the limit. The caller holds the collector's command lock and has answered a replay."""
    conn.execute("""DELETE FROM handle_lookup_event
      WHERE user_id=%s AND kind='loan_command' AND created_at < now() - interval '1 hour'""", (user_id,))
    recent = conn.execute("""SELECT count(*) AS commands, min(created_at) AS oldest FROM handle_lookup_event
      WHERE user_id=%s AND kind='loan_command'""", (user_id,)).fetchone()
    if recent['commands'] >= COMMANDS_PER_HOUR:
        wait = conn.execute("SELECT ceil(extract(epoch FROM %s + interval '1 hour' - now()) / 60) AS wait",
                            (recent['oldest'],)).fetchone()['wait']
        raise HTTPException(429, {'code': 'TOO_MANY_CHANGES', 'retry_after_minutes': max(1, int(wait))})
    conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,'loan_command')", (user_id,))


def begin_command(conn, user_id: str, key: UUID, payload: dict):
    """The start every Loan command shares: the caller's owner row made if new, the caller's commands one at a time, a
    replay answered from the caller's record, else the command counted. Returns (digest, stored response or None)."""
    ensure_owner(conn, user_id)
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.loan_command:' || %s))", (user_id,))
    digest, stored = replay(conn, user_id, key, payload)
    if stored is None:
        count_loan_command(conn, user_id)
    return digest, stored


def store(conn, user_id: str, key: UUID, digest: str, loan_id: UUID) -> dict:
    """The Loan as the caller now sees it, recorded as the command's response."""
    stored = loan_view(conn, user_id, loan_id).model_dump(mode='json')
    conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                 (user_id, key, digest, json.dumps(stored)))
    return stored


def advance_revision(conn, owner_id: str | None) -> None:
    """Moves the owner's inventory revision on, for a step that changes what is reserved of their copies."""
    if owner_id is not None:
        conn.execute('UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s', (owner_id,))


def run_step(user_id: str, loan_id: UUID, step: LoanStep, action: str, apply, locks, extra: dict | None = None) -> dict:
    """Runs one step on an existing Loan: ``begin_command``, the owners ``locks(role, row)`` names locked in ascending
    order, then the Loan row, its revision and ``allowed`` checked, then ``apply(conn, row)``, the Loan's revision
    advanced, and the caller's view stored and returned. ``extra``: the step's own fields, part of its digest. The Loan
    row is locked ``FOR NO KEY UPDATE``, like the owners (``lock_owners`` says why): a Borrowed Holding's foreign key
    check on its Loan never waits on a step."""
    payload = {'action': f'loan_{action}', 'loan_id': str(loan_id), 'revision': step.revision, **(extra or {})}
    with connect() as conn, conn.transaction():
        digest, stored = begin_command(conn, user_id, step.idempotency_key, payload)
        if stored is not None:
            return stored
        sides = conn.execute(LOANS + ' AND o.id = %(id)s', {'me': user_id, 'id': loan_id}).fetchone()
        if sides is None:
            error(404, 'LOAN_NOT_FOUND')
        lock_owners(conn, *[owner for owner in locks(role_of(user_id, sides), sides) if owner is not None])
        row = conn.execute('SELECT * FROM loan WHERE id = %s FOR NO KEY UPDATE', (loan_id,)).fetchone()
        if row['revision'] != step.revision:
            error(409, 'LOAN_CHANGED')
        other = row['borrower_id'] if role_of(user_id, row) == 'lender' else row['lender_id']
        exists = other is not None and conn.execute('SELECT 1 FROM collector_profile WHERE user_id=%s',
                                                    (other,)).fetchone() is not None
        if action not in allowed(user_id, row, exists):
            error(409, 'STEP_NOT_ALLOWED')
        apply(conn, row)
        conn.execute('UPDATE loan SET revision = revision + 1 WHERE id = %s', (loan_id,))
        return store(conn, user_id, step.idempotency_key, digest, loan_id)


def close(conn, row, user_id: str, reason: str) -> None:
    conn.execute("""UPDATE loan SET state='closed', closed_reason=%s, closed_by=%s, closed_at=now() WHERE id=%s""",
                 (reason, user_id, row['id']))
    conn.execute('DELETE FROM loan_pick WHERE loan_id=%s', (row['id'],))


@router.post('/{loan_id}/decline', response_model=LoanView)
def decline(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """The lender says no to a Borrow Request. Nothing was reserved, so no revision moves."""
    return run_step(user_id, loan_id, step, 'decline', lambda conn, row: close(conn, row, user_id, 'declined'),
                    lambda role, row: [row['lender_id']])


@router.post('/{loan_id}/withdraw', response_model=LoanView)
def withdraw(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """The borrower takes back a Borrow Request before it is answered. Only the Loan row is locked."""
    return run_step(user_id, loan_id, step, 'withdraw', lambda conn, row: close(conn, row, user_id, 'withdrawn'),
                    lambda role, row: [])


@router.post('/{loan_id}/cancel', response_model=LoanView)
def cancel(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """Either side cancels an accepted Loan nobody has confirmed a handover for: its copies stop being reserved, so the
    lender's revision moves. The lender locks only themself; the borrower locks both."""
    def apply(conn, row):
        close(conn, row, user_id, 'cancelled')
        advance_revision(conn, row['lender_id'])

    return run_step(user_id, loan_id, step, 'cancel', apply,
                    lambda role, row: [row['lender_id']] if role == 'lender' else [row['lender_id'], row['borrower_id']])
