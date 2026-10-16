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
sides gets 404 LOAN_NOT_FOUND, as for a Loan that doesn't exist. Every step on an existing Loan runs through
``run_step``, which writes the ``loan`` row exactly once: the step's own columns and the revision in one UPDATE.

**Locks** follow the spec's table ("Locks and revisions"): owner rows in ascending ``user_id`` (``owners.lock_owners``),
then the ``loan`` row. Decline locks the lender; withdraw only the Loan; cancel the canceller and, when the borrower
cancels, the lender as well. Cancelling an accepted Loan releases its reserved copies, so it advances the lender's
inventory revision.

**Limit.** Loan steps that reach the other collector count against ``COMMANDS_PER_HOUR`` per account under kind
'loan_command' (``count_loan_command``), apart from the Friend commands' count. A replay isn't counted again; the count
is taken before any other collector's row is locked; a refused step rolls back with its count.

**Handover** (#253): each side confirms for its own inventory, with ``app.loan_inventory``'s routes; the Loan is
``handed_over`` once both have. Until the other side confirms, a side may take its confirmation back, and while
neither has, either may cancel.

**Returns** (#255): either side starts a return of some or all of the copies out from its side, which is that side's
confirmation, and the other side confirms it; each confirmation moves only that side's own inventory, with
``app.loan_inventory``'s routes. A Loan has at most one pending return. A return only one side confirmed is complete
when the other side's account no longer exists. ``loan_facts`` reads what the steps depend on beyond the Loan row: the
pending return, the copies returned, the copies still out from each side and whether the other side exists.

**Needs you** (``needs_you``) is the one definition the Loans tab and, from #259, the inbox read. ``section`` places a
Loan on the Loans tab: needs you, out now, pending or history.
"""
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from psycopg import sql
from pydantic import BaseModel, Field

from ..location_tree import error, replay
from ..main import connect, verified_user
from .friend_reads import card_facts
from .owners import ensure_owner, lock_owners

router = APIRouter(prefix='/api/social/loans', tags=['social'])

COMMANDS_PER_HOUR = 120
# A Loan column value a step's ``apply`` returns for the transaction's time (``run_step``).
NOW = sql.SQL('now()')
# Closed Loans the Loans tab lists under History, newest first.
HISTORY = 50

Action = Literal['accept', 'decline', 'confirm_handover', 'start_return', 'confirm_return', 'withdraw', 'take_back',
                 'cancel', 'edit_and_resend']
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
    # Copies that came back in complete returns (#255).
    returned: str = '0'


class ReturnLine(BaseModel):
    edition_id: UUID
    copies: str


class PendingReturn(BaseModel):
    """The Loan's return one side has confirmed and the other hasn't (#255): who started it, its copies, and which
    sides confirmed it."""
    started_by: Literal['you', 'them']
    lines: list[ReturnLine]
    you_confirmed: bool
    they_confirmed: bool


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
    # The return waiting for a side's confirmation (#255), or None.
    pending_return: PendingReturn | None = None


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


@dataclass(frozen=True)
class LoanFacts:
    """What a Loan's steps depend on beyond its row (#255). ``pending``: the return waiting for a confirmation, as
    {'id', 'started_by' ('lender' or 'borrower'), 'lender_confirmed', 'borrower_confirmed', 'lines': {Edition id:
    copies}}, or None. ``returned``: copies back in complete returns, by Edition. ``out``: copies still out from each
    side, by role: the lender's lent picks, and the borrower's promised copies less those written off and those the
    borrower confirmed returning (0 before the borrower confirmed the handover). ``any_return``: a return was ever
    started."""
    other_exists: bool = True
    written_off: bool = False
    pending: dict | None = None
    returned: dict = field(default_factory=dict)
    out: dict = field(default_factory=dict)
    any_return: bool = False


def loan_facts(conn, user_id: str, rows) -> dict[UUID, LoanFacts]:
    """``LoanFacts`` for these Loan rows as the reader sees them, in four reads whatever the number of Loans. Reads no
    inventory: ``loan_pick`` is Loan state."""
    rows = list(rows)
    ids = [row['id'] for row in rows]
    if not ids:
        return {}
    others = {row['id']: row['borrower_id'] if row['lender_id'] == user_id else row['lender_id'] for row in rows}
    wanted = sorted({other for other in others.values() if other is not None})
    alive = {profile['user_id'] for profile in conn.execute(
        'SELECT user_id FROM collector_profile WHERE user_id = ANY(%s)', (wanted,))} if wanted else set()
    lines: dict[UUID, list] = {}
    for line in conn.execute('SELECT loan_id, edition_id, promised, written_off FROM loan_line WHERE loan_id = ANY(%s)',
                             (ids,)):
        lines.setdefault(line['loan_id'], []).append(line)
    returns: dict[UUID, dict] = {}
    for line in conn.execute("""SELECT r.id, r.loan_id, r.started_by, r.lender_confirmed_at, r.borrower_confirmed_at,
        r.completed_at, l.edition_id, l.quantity
      FROM loan_return r JOIN loan_return_line l ON l.return_id = r.id
      WHERE r.loan_id = ANY(%s) ORDER BY r.created_at, r.id""", (ids,)):
        found = returns.setdefault(line['loan_id'], {}).setdefault(line['id'], {
            'id': line['id'], 'started_by': line['started_by'],
            'lender_confirmed': line['lender_confirmed_at'] is not None,
            'borrower_confirmed': line['borrower_confirmed_at'] is not None,
            'complete': line['completed_at'] is not None, 'lines': {}})
        found['lines'][line['edition_id']] = int(line['quantity'])
    lent = {row['loan_id']: int(row['copies']) for row in conn.execute(
        """SELECT loan_id, sum(quantity)::bigint AS copies FROM loan_pick WHERE loan_id = ANY(%s) AND state = 'lent'
        GROUP BY loan_id""", (ids,))}
    facts = {}
    for row in rows:
        mine = list(returns.get(row['id'], {}).values())
        returned: dict[UUID, int] = {}
        given_back = 0
        for found in mine:
            if found['complete']:
                for edition, copies in found['lines'].items():
                    returned[edition] = returned.get(edition, 0) + copies
            if found['borrower_confirmed']:
                given_back += sum(found['lines'].values())
        pending = next((found for found in mine if not found['complete']), None)
        promised = sum(int(line['promised']) - int(line['written_off']) for line in lines.get(row['id'], []))
        facts[row['id']] = LoanFacts(
            other_exists=others[row['id']] in alive,
            written_off=any(line['written_off'] > 0 for line in lines.get(row['id'], [])),
            pending=pending, returned=returned,
            out={'lender': lent.get(row['id'], 0),
                 'borrower': promised - given_back if row['borrower_handover_at'] is not None else 0},
            any_return=bool(mine))
    return facts


def needs_you(user_id: str, row, facts: LoanFacts | None = None) -> bool:
    """Whether the Loan waits on the reader: a Borrow Request to answer (lender) or a Lend Offer to answer (borrower,
    #258), a handover the other side confirmed and the reader hasn't (#253), a return the other side confirmed and the
    reader hasn't, or copies still out from the reader's side once the other side's account is gone (#255). #259's
    inbox adds its own items."""
    role = role_of(user_id, row)
    if facts is not None and row['state'] in ('accepted', 'handed_over'):
        pending = facts.pending
        if pending is not None and pending['started_by'] != role and not pending[f'{role}_confirmed']:
            return True
        if not facts.other_exists and facts.out.get(role, 0) > 0 and pending is None:
            return True
    if row['state'] == 'requested':
        return role == 'lender'
    if row['state'] == 'offered':
        return role == 'borrower'
    if row['state'] == 'accepted':
        mine, theirs = confirmed(user_id, row)
        return theirs and not mine
    return False


def section(user_id: str, row, facts: LoanFacts | None = None) -> str:
    if row['state'] == 'closed':
        return 'history'
    if needs_you(user_id, row, facts):
        return 'needs_you'
    if row['state'] == 'handed_over' or row['lender_handover_at'] is not None or row['borrower_handover_at'] is not None:
        return 'out_now'
    return 'pending'


def allowed(user_id: str, row, other_exists: bool = True, written_off: bool = False,
            facts: LoanFacts | None = None) -> list[str]:
    """The steps the reader may take now, in the order the Loan screen offers them. Each side confirms the handover
    for its own inventory (#253) and may take its confirmation back until the other side confirms, unless anything on
    the Loan was written off (#257) or returned (#255). ``written_off``: some copy on the Loan was. With ``facts``
    (#255): a side that confirmed the handover starts a return of copies still out from its side once the other side
    confirmed too, or is gone, and no return is pending; the other side confirms a pending return."""
    role, state = role_of(user_id, row), row['state']
    mine, theirs = confirmed(user_id, row) if state == 'accepted' else (False, False)
    found = []
    if state == 'requested' and role == 'lender':
        found += ['accept', 'decline']
    if state == 'accepted' and not mine:
        found.append('confirm_handover')
    if facts is not None and state in ('accepted', 'handed_over'):
        handed, received = confirmed(user_id, row)
        pending = facts.pending
        if (pending is None and facts.out.get(role, 0) > 0 and handed and (received or not other_exists)):
            found.append('start_return')
        if pending is not None and pending['started_by'] != role and not pending[f'{role}_confirmed']:
            found.append('confirm_return')
    if state == 'requested' and role == 'borrower':
        found.append('withdraw')
    if state == 'accepted' and mine and not theirs and not written_off and not (facts and facts.any_return):
        found.append('take_back')
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
    facts = loan_facts(conn, user_id, rows)
    others = {row['borrower_id'] if row['lender_id'] == user_id else row['lender_id'] for row in rows} - {None}
    handles = {profile['user_id']: profile['handle'] for profile in conn.execute(
        'SELECT user_id, handle FROM collector_profile WHERE user_id = ANY(%s)', (sorted(others),))} if others else {}
    views = []
    for row in rows:
        role = role_of(user_id, row)
        other_id = row['borrower_id'] if role == 'lender' else row['lender_id']
        mine, theirs = confirmed(user_id, row)
        known = facts[row['id']]
        card_lines = []
        for line in lines.get(row['id'], []):
            card = cards[line['edition_id']]
            card_lines.append(LoanCard(
                edition_id=card.edition_id, name=card.name, set_code=card.set_code, set_name=card.set_name,
                collector_number=card.collector_number, descriptor=card.descriptor, image_url=card.image_url,
                requested=str(line['requested']), promised=str(line['promised']),
                written_off=str(line['written_off']), returned=str(known.returned.get(line['edition_id'], 0))))
        pending = known.pending
        if pending is not None:
            order = {line['edition_id']: index for index, line in enumerate(lines.get(row['id'], []))}
            pending = PendingReturn(
                started_by='you' if pending['started_by'] == role else 'them',
                lines=[ReturnLine(edition_id=edition, copies=str(copies)) for edition, copies in
                       sorted(pending['lines'].items(), key=lambda item: order.get(item[0], 0))],
                you_confirmed=pending[f'{role}_confirmed'],
                they_confirmed=pending['borrower_confirmed' if role == 'lender' else 'lender_confirmed'])
        closed_by = None if row['closed_by'] is None else 'you' if row['closed_by'] == user_id else 'them'
        views.append(LoanView(
            id=row['id'], kind=row['kind'], state=row['state'], closed_reason=row['closed_reason'],
            closed_by=closed_by, role=role,
            other=LoanParty(collector_id=other_id if other_id in handles else None,
                            display_name=row['borrower_name'] if role == 'lender' else row['lender_name'],
                            handle=handles.get(other_id)),
            return_by=row['return_by'], you_confirmed_handover=mine, they_confirmed_handover=theirs,
            lines=card_lines, needs_you=needs_you(user_id, row, known), section=section(user_id, row, known),
            actions=allowed(user_id, row, other_id in handles,
                            any(line['written_off'] > 0 for line in lines.get(row['id'], [])), known),
            revision=row['revision'], pending_return=pending))
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
    order, then the Loan row, its revision and ``allowed`` checked, then ``apply(conn, row)``, then the Loan row written
    once, and the caller's view stored and returned. ``extra``: the step's own fields, part of its digest.

    ``apply`` writes everything but the ``loan`` row and returns the Loan columns the step sets (a mapping of column
    name to value, empty or None for none; ``NOW`` for the transaction's time). ``run_step`` writes them and the
    revision in one ``UPDATE loan``, the step's only write of that row. A second write of the row in one transaction
    makes PostgreSQL check its foreign keys again, key-sharing both collectors' ``inventory_owner`` rows and the
    borrower's Deck; that waited on the other collector's own commands (a Deck deletion holds its owner row and
    cascades into this Loan row) and closed a cycle. The Loan row is locked ``FOR NO KEY UPDATE``, like the owners
    (``lock_owners`` says why). A deadlock the database ends anyway leaves nothing changed and answers 503
    INVENTORY_TEMPORARILY_UNAVAILABLE, which the client retries with the same key."""
    payload = {'action': f'loan_{action}', 'loan_id': str(loan_id), 'revision': step.revision, **(extra or {})}
    try:
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
            written_off = conn.execute('SELECT 1 FROM loan_line WHERE loan_id=%s AND written_off > 0 LIMIT 1',
                                       (loan_id,)).fetchone() is not None
            if action not in allowed(user_id, row, exists, written_off, loan_facts(conn, user_id, [row])[loan_id]):
                error(409, 'STEP_NOT_ALLOWED')
            write_loan(conn, loan_id, apply(conn, row) or {})
            return store(conn, user_id, step.idempotency_key, digest, loan_id)
    except psycopg.errors.DeadlockDetected:
        error(503, 'INVENTORY_TEMPORARILY_UNAVAILABLE')


def write_loan(conn, loan_id: UUID, changes: Mapping[str, object]) -> None:
    """The step's one write of its Loan row: ``changes`` (column -> value, ``NOW`` for the transaction's time) and the
    revision advanced. ``run_step`` calls it; nothing else in a step writes the row."""
    if 'revision' in changes or 'id' in changes:
        raise ValueError('run_step owns the Loan id and revision')
    assignments = [sql.SQL('revision = revision + 1')]
    params: list = []
    for column in sorted(changes):
        value = changes[column]
        if isinstance(value, sql.Composable):
            assignments.append(sql.SQL('{} = {}').format(sql.Identifier(column), value))
        else:
            assignments.append(sql.SQL('{} = %s').format(sql.Identifier(column)))
            params.append(value)
    conn.execute(sql.SQL('UPDATE loan SET {} WHERE id = %s').format(sql.SQL(', ').join(assignments)),
                 [*params, loan_id])


def close(conn, row, user_id: str, reason: str) -> dict:
    """Ends the Loan: its picks go, and the columns ``run_step`` writes are returned."""
    conn.execute('DELETE FROM loan_pick WHERE loan_id=%s', (row['id'],))
    return {'state': 'closed', 'closed_reason': reason, 'closed_by': user_id, 'closed_at': NOW}


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
        advance_revision(conn, row['lender_id'])
        return close(conn, row, user_id, 'cancelled')

    return run_step(user_id, loan_id, step, 'cancel', apply,
                    lambda role, row: [row['lender_id']] if role == 'lender' else [row['lender_id'], row['borrower_id']])
