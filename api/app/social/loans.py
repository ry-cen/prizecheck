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

**Write-off** (#257): once the lender confirmed the handover, they write off some of the copies out, which is final;
the borrower then chooses to keep or remove the written-off copies they hold. The count awaiting that choice is the
borrower's own, read through ``borrowed_copies.awaiting_choice`` for the borrower's Loans only.

**Return-by date** (#256): the lender keeps, changes or clears the requested date on accepting (``loan_inventory``),
then changes or clears it while the Loan is open, but never brings it earlier once either side confirmed the handover;
the borrower asks for more time (``extension_to``) and the lender approves or declines it. These steps lock only the
Loan row. Overdue (from the day after the date, once a handover was confirmed) and the 14-day nudge (a Borrow Request
nobody answered, or an accepted Loan nobody confirmed a handover for, story 89) are worked out on read, and each is a
notice the reader sees once (``loan_notice_seen``): 'overdue', 'nudge_answer' and 'nudge_handover', so seeing a
request's nudge never hides the accepted Loan's.

**Lend Offers** (#258): the lender sends one from the Collection, which reserves its copies (``app.loan_inventory``);
the borrower accepts all or part of it there, or declines it here, and the lender withdraws it here. Declining or
withdrawing releases the copies, so it moves the lender's revision: a decline locks both owners, a withdraw the
lender. An offer nobody answered for 14 days nudges both sides once, as a Borrow Request does.

**Needs you** (``waiting_step``) is the one definition the Loans tab, its badge and the inbox's bell (#259) read: what
the Loan waits on the reader for, or nothing. From #259 it includes the lender's out-of-date picks, read through
``loan_picks.stale_pick_loans``. ``section`` places a Loan on the Loans tab: needs you, out now, pending or history.

**Updates** (#259): a step that answers or ends a request or offer, cancels a Loan or changes its return-by date stores
an update for the other side (``record_update``), with the name of the collector who took it and never a reason.

**Ending a friendship** (#260): Remove Friend and Block cancel the pair's Borrow Requests, Lend Offers and accepted
Loans nobody has confirmed a handover for (``end_loans_between``), inside the Friend command that already locked both
owners. A Loan either side confirmed a handover for counts as handed over and stays open. Edit and resend sends a new
request to the lender, so it is offered only while the lender is still the borrower's Friend.
"""
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Literal
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from psycopg import sql
from pydantic import BaseModel, Field

from ..borrowed_copies import awaiting_choice
from ..loan_picks import stale_pick_loans
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
# Days an unanswered Borrow Request or an accepted Loan waits before both sides are nudged once (#256).
NUDGE_DAYS = 14

Action = Literal['accept', 'decline', 'confirm_handover', 'start_return', 'confirm_return', 'choose_written_off',
                 'withdraw', 'take_back', 'cancel', 'write_off', 'change_return_by', 'ask_for_more_time',
                 'approve_extension', 'decline_extension', 'edit_and_resend']
# 'nudge_answer': a Borrow Request or Lend Offer nobody answered; 'nudge_handover': an accepted Loan nobody confirmed a
# handover for. Two kinds, so seeing the first never hides the second once the Loan is accepted (migration 126).
Notice = Literal['overdue', 'nudge_answer', 'nudge_handover']
Section = Literal['needs_you', 'out_now', 'pending', 'history']
# What a Loan waits on the reader for (#259): an answer to a request or offer, out-of-date picks to replace (lender), the
# keep-or-remove choice after a Write-off (borrower), a return to confirm, a handover to confirm (the lender's
# hand_over, the borrower's receive), a return the reader started to finish once the other side's account is gone,
# copies to return then, more time to answer (lender).
Waiting = Literal['answer', 'fix_picks', 'choose', 'confirm_return', 'finish_return', 'hand_over', 'receive', 'return',
                  'more_time']
# The event updates a step stores for the other side (#259, migration 130).
UpdateKind = Literal['accepted', 'partly_accepted', 'declined', 'cancelled', 'return_by_changed']


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
    # The borrower's written-off copies awaiting their keep-or-remove choice (#257); "0" for the lender.
    awaiting_choice: str = '0'
    # The later date the borrower asked for and the lender hasn't answered (#256), or None.
    extension_to: date | None = None
    # The day after the return-by date once that day has come and a handover was confirmed (#256), else None.
    overdue_since: date | None = None
    # Time-based notices the reader hasn't seen yet (#256): 'overdue', 'nudge_answer' for a request or offer nobody
    # answered and 'nudge_handover' for a handover still to happen.
    notices: list[Notice] = []
    # What the Loan waits on the reader for (#259), None when ``needs_you`` is false.
    waiting: Waiting | None = None


class LoansView(BaseModel):
    """The Loans tab: every open Loan and the newest closed ones, newest first; ``needs_you`` counts the Loans that
    need the reader (the tab's badge, #259)."""
    loans: list[LoanView]
    needs_you: int


class LoanStep(BaseModel):
    revision: int = Field(ge=1)
    idempotency_key: UUID


class ChangeReturnBy(LoanStep):
    """The lender's new return-by date (#256), or None to clear it."""
    return_by: date | None


class AskForMoreTime(LoanStep):
    """The later return-by date the borrower asks for (#256)."""
    return_by: date


class SeenNotices(BaseModel):
    """Notices the reader was shown (#256); those not showing now are ignored."""
    kinds: list[Notice] = Field(min_length=1, max_length=3)


def role_of(user_id: str, row) -> str:
    return 'lender' if row['lender_id'] == user_id else 'borrower'


def confirmed(user_id: str, row) -> tuple[bool, bool]:
    """(the reader confirmed the handover, the other side did)."""
    lender, borrower = row['lender_handover_at'] is not None, row['borrower_handover_at'] is not None
    return (lender, borrower) if role_of(user_id, row) == 'lender' else (borrower, lender)


@dataclass(frozen=True)
class LoanFacts:
    """What a Loan's steps depend on beyond its row (#255). ``pending``: the return waiting for a confirmation, as
    {'id', 'started_by' ('lender' or 'borrower'), 'lender_confirmed', 'borrower_confirmed', 'created_at', 'lines':
    {Edition id: copies}}, or None. ``returned``: copies back in complete returns, by Edition. ``out``: copies still out from each
    side, by role: the lender's lent picks, and the borrower's promised copies less those written off and those the
    borrower confirmed returning (0 before the borrower confirmed the handover). ``any_return``: a return was ever
    started. ``write_off_cap``: the lender's copies out less those a return the borrower confirmed and the lender hasn't
    gives back (#257). ``awaiting``: the reader's written-off copies awaiting their choice, as borrower (#257).
    ``overdue_since`` and ``notices``: as ``LoanView``'s (#256). ``showing``: the time-based notices that apply now,
    seen or not (#259's inbox). ``stale_picks``: the reader is the lender and a reserved pick is out of date (#259)."""
    other_exists: bool = True
    written_off: bool = False
    pending: dict | None = None
    returned: dict = field(default_factory=dict)
    out: dict = field(default_factory=dict)
    any_return: bool = False
    write_off_cap: int = 0
    awaiting: int = 0
    overdue_since: date | None = None
    notices: tuple = ()
    showing: tuple = ()
    stale_picks: bool = False


def loan_facts(conn, user_id: str, rows) -> dict[UUID, LoanFacts]:
    """``LoanFacts`` for these Loan rows as the reader sees them, in eight reads whatever the number of Loans. Reads no
    inventory but the reader's own Holdings, as lender, through ``stale_pick_loans`` (#259)."""
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
        r.completed_at, r.created_at, l.edition_id, l.quantity
      FROM loan_return r JOIN loan_return_line l ON l.return_id = r.id
      WHERE r.loan_id = ANY(%s) ORDER BY r.created_at, r.id""", (ids,)):
        found = returns.setdefault(line['loan_id'], {}).setdefault(line['id'], {
            'id': line['id'], 'started_by': line['started_by'],
            'lender_confirmed': line['lender_confirmed_at'] is not None,
            'borrower_confirmed': line['borrower_confirmed_at'] is not None,
            'complete': line['completed_at'] is not None, 'created_at': line['created_at'], 'lines': {}})
        found['lines'][line['edition_id']] = int(line['quantity'])
    lent = {row['loan_id']: int(row['copies']) for row in conn.execute(
        """SELECT loan_id, sum(quantity)::bigint AS copies FROM loan_pick WHERE loan_id = ANY(%s) AND state = 'lent'
        GROUP BY loan_id""", (ids,))}
    awaiting = awaiting_choice(conn, user_id, [row['id'] for row in rows if row['borrower_id'] == user_id])
    stale = stale_pick_loans(conn, user_id, [row['id'] for row in rows if row['lender_id'] == user_id
                                             and row['state'] == 'accepted' and row['lender_handover_at'] is None])
    clock = conn.execute(f"SELECT current_date AS today, now() - interval '{NUDGE_DAYS} days' AS stale").fetchone()
    seen: dict[UUID, set] = {}
    for notice in conn.execute('SELECT loan_id, kind FROM loan_notice_seen WHERE loan_id = ANY(%s) AND user_id=%s',
                               (ids, user_id)):
        seen.setdefault(notice['loan_id'], set()).add(notice['kind'])
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
        coming = sum(pending['lines'].values()) if pending and not pending['lender_confirmed'] else 0
        promised = sum(int(line['promised']) - int(line['written_off']) for line in lines.get(row['id'], []))
        handed = row['lender_handover_at'] is not None or row['borrower_handover_at'] is not None
        overdue = (row['state'] in ('accepted', 'handed_over') and handed and row['return_by'] is not None
                   and clock['today'] > row['return_by'])
        nudge_handover = (row['state'] == 'accepted' and not handed and row['accepted_at'] is not None
                          and row['accepted_at'] <= clock['stale'])
        nudge_answer = row['state'] in ('requested', 'offered') and row['created_at'] <= clock['stale']
        showing = [kind for kind, on in (('overdue', overdue), ('nudge_answer', nudge_answer),
                                         ('nudge_handover', nudge_handover)) if on]
        facts[row['id']] = LoanFacts(
            other_exists=others[row['id']] in alive,
            written_off=any(line['written_off'] > 0 for line in lines.get(row['id'], [])),
            pending=pending, returned=returned,
            out={'lender': lent.get(row['id'], 0),
                 'borrower': promised - given_back if row['borrower_handover_at'] is not None else 0},
            any_return=bool(mine), write_off_cap=lent.get(row['id'], 0) - coming,
            awaiting=awaiting.get(row['id'], 0),
            overdue_since=row['return_by'] + timedelta(days=1) if overdue else None,
            notices=tuple(kind for kind in showing if kind not in seen.get(row['id'], set())),
            showing=tuple(showing), stale_picks=row['id'] in stale)
    return facts


def waiting_step(user_id: str, row, facts: LoanFacts | None = None) -> str | None:
    """What the Loan waits on the reader for (``Waiting``), or None: a Borrow Request to answer (lender) or a Lend Offer
    (borrower, #258), out-of-date picks to replace before the handover (lender, #259), written-off copies to keep or
    remove (borrower, #257), a return the other side confirmed and the reader hasn't, a return the reader started that
    the other side, whose account is gone, can never confirm, a handover the other side confirmed and the reader hasn't
    (#253), copies still out from the reader's side once the other side's account is gone (#255), or more time the
    borrower asked for (lender, #256). The first that applies, in the order the Loan screen offers them."""
    role, state = role_of(user_id, row), row['state']
    if state == 'requested':
        return 'answer' if role == 'lender' else None
    if state == 'offered':
        return 'answer' if role == 'borrower' else None
    if state not in ('accepted', 'handed_over'):
        return None
    pending = facts.pending if facts is not None else None
    if facts is not None:
        if facts.stale_picks and role == 'lender' and state == 'accepted' and row['lender_handover_at'] is None:
            return 'fix_picks'
        if facts.awaiting > 0:
            return 'choose'
        if pending is not None and pending['started_by'] != role and not pending[f'{role}_confirmed']:
            return 'confirm_return'
        if pending is not None and pending['started_by'] == role and not facts.other_exists:
            return 'finish_return'
    if state == 'accepted':
        mine, theirs = confirmed(user_id, row)
        if theirs and not mine:
            return 'hand_over' if role == 'lender' else 'receive'
    if facts is not None and not facts.other_exists and facts.out.get(role, 0) > 0 and pending is None:
        return 'return'
    if role == 'lender' and row['extension_to'] is not None:
        return 'more_time'
    return None


def needs_you(user_id: str, row, facts: LoanFacts | None = None) -> bool:
    """Whether the Loan waits on the reader (``waiting_step``)."""
    return waiting_step(user_id, row, facts) is not None


def section(user_id: str, row, facts: LoanFacts | None = None) -> str:
    if row['state'] == 'closed':
        return 'history'
    if needs_you(user_id, row, facts):
        return 'needs_you'
    if row['state'] == 'handed_over' or row['lender_handover_at'] is not None or row['borrower_handover_at'] is not None:
        return 'out_now'
    return 'pending'


def allowed(user_id: str, row, other_exists: bool = True, written_off: bool = False,
            facts: LoanFacts | None = None, *, friends: bool = True) -> list[str]:
    """The steps the reader may take now, in the order the Loan screen offers them. Each side confirms the handover
    for its own inventory (#253) and may take its confirmation back until the other side confirms, unless anything on
    the Loan was written off (#257) or returned (#255). ``written_off``: some copy on the Loan was. With ``facts``
    (#255): a side that confirmed the handover starts a return of copies still out from its side once the other side
    confirmed too, or is gone, and no return is pending; the other side confirms a pending return, and the side that
    started it finishes it alone once the other side is gone. The lender changes the return-by date while the Loan is
    open, except once a handover was confirmed with no date set: every date would then be earlier. ``friends``: the
    other side is the reader's Friend now; Edit and resend, a new request to the lender, needs it (owner's decision,
    2026-10-16). It is no step, so ``run_step`` leaves it at its default."""
    role, state = role_of(user_id, row), row['state']
    mine, theirs = confirmed(user_id, row) if state == 'accepted' else (False, False)
    found = []
    if (state, role) in (('requested', 'lender'), ('offered', 'borrower')):
        found += ['accept', 'decline']
    if state == 'accepted' and not mine:
        found.append('confirm_handover')
    if facts is not None and state in ('accepted', 'handed_over'):
        handed, received = confirmed(user_id, row)
        pending = facts.pending
        if (pending is None and facts.out.get(role, 0) > 0 and handed and (received or not other_exists)):
            found.append('start_return')
        if pending is not None and ((pending['started_by'] != role and not pending[f'{role}_confirmed'])
                                    or (pending['started_by'] == role and not other_exists)):
            found.append('confirm_return')
        if role == 'borrower' and facts.awaiting > 0:
            found.append('choose_written_off')
    if (state, role) in (('requested', 'borrower'), ('offered', 'lender')):
        found.append('withdraw')
    if state == 'accepted' and mine and not theirs and not written_off and not (facts and facts.any_return):
        found.append('take_back')
    if state == 'accepted' and row['lender_handover_at'] is None and row['borrower_handover_at'] is None:
        found.append('cancel')
    if (facts is not None and role == 'lender' and state in ('accepted', 'handed_over')
            and row['lender_handover_at'] is not None and facts.write_off_cap > 0):
        found.append('write_off')
    # The return-by date (#256): the lender's to change; the borrower asks for more time, one request at a time.
    if state in ('accepted', 'handed_over'):
        if role == 'lender':
            confirmed_any = row['lender_handover_at'] is not None or row['borrower_handover_at'] is not None
            if not (confirmed_any and row['return_by'] is None):
                found.append('change_return_by')
            if row['extension_to'] is not None:
                found += ['approve_extension', 'decline_extension']
        elif row['return_by'] is not None and row['extension_to'] is None:
            found.append('ask_for_more_time')
    if (role == 'borrower' and row['kind'] == 'borrow_request' and other_exists and friends
            and (state == 'requested' or (state == 'closed'
                                          and row['closed_reason'] in ('declined', 'withdrawn', 'cancelled')))):
        found.append('edit_and_resend')
    return found


LOANS = """SELECT o.* FROM loan o WHERE (o.lender_id = %(me)s OR o.borrower_id = %(me)s)"""


def loan_views(conn, user_id: str, rows, facts: dict[UUID, LoanFacts] | None = None) -> list[LoanView]:
    """The reader's views of these Loan rows, in their order: one read of their lines, one of card facts and one of the
    other sides' profiles, whatever the number of Loans. ``facts``: ``loan_facts`` for these rows when the caller read
    them already (#259's inbox)."""
    rows = list(rows)
    if not rows:
        return []
    lines: dict[UUID, list] = {}
    for line in conn.execute('SELECT loan_id, edition_id, requested, promised, written_off FROM loan_line '
                             'WHERE loan_id = ANY(%s) ORDER BY loan_id, position', ([row['id'] for row in rows],)):
        lines.setdefault(line['loan_id'], []).append(line)
    cards = card_facts(conn, [line['edition_id'] for found in lines.values() for line in found])
    facts = facts if facts is not None else loan_facts(conn, user_id, rows)
    others = {row['borrower_id'] if row['lender_id'] == user_id else row['lender_id'] for row in rows} - {None}
    handles = {profile['user_id']: profile['handle'] for profile in conn.execute(
        'SELECT user_id, handle FROM collector_profile WHERE user_id = ANY(%s)', (sorted(others),))} if others else {}
    # Edit and resend needs the lender to be the reader's Friend still: read once, and only when a Loan could offer it.
    # Imported here because app.social.friends imports this module (``end_loans_between``).
    from .friends import friend_ids
    friends = friend_ids(conn, user_id) if any(
        row['borrower_id'] == user_id and row['kind'] == 'borrow_request' for row in rows) else set()
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
            waiting=waiting_step(user_id, row, known),
            actions=allowed(user_id, row, other_id in handles,
                            any(line['written_off'] > 0 for line in lines.get(row['id'], [])), known,
                            friends=other_id in friends),
            revision=row['revision'], pending_return=pending, awaiting_choice=str(known.awaiting),
            extension_to=row['extension_to'] if row['state'] in ('accepted', 'handed_over') else None,
            overdue_since=known.overdue_since, notices=list(known.notices)))
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
    revision advanced. ``run_step`` calls it, and ``end_loans_between`` once for each Loan it cancels; nothing else
    writes the row of an existing Loan."""
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


def today(conn) -> date:
    return conn.execute('SELECT current_date AS today').fetchone()['today']


def handed(row) -> bool:
    """Either side confirmed the handover: the date can't be brought earlier any more (#256)."""
    return row['lender_handover_at'] is not None or row['borrower_handover_at'] is not None


def return_by_columns(conn, row, new: date | None) -> dict:
    """The Loan columns for the lender's new return-by date (``new``, None to clear it): 422 INVALID_RETURN_BY for a
    day before today, and 409 RETURN_BY_EARLIER for a date earlier than the current one (or any date once it was
    cleared) after a handover confirmation. The lender's answer also answers any request for more time."""
    if new is not None and new < today(conn):
        error(422, 'INVALID_RETURN_BY')
    if new is not None and handed(row) and (row['return_by'] is None or new < row['return_by']):
        error(409, 'RETURN_BY_EARLIER')
    return {'return_by': new, 'extension_to': None}


def record_update(conn, row, actor_id: str, kind: str) -> None:
    """Stores an event update (``UpdateKind``, #259) for the side of the Loan that isn't ``actor_id``, named for the
    actor as the Loan names them. Nothing when that side's account is gone. It never says why: a Loan cancelled by an
    unfriend or a Block (#260) reads like any other cancel. ``row`` is the Loan as the step read it."""
    lender = row['lender_id'] == actor_id
    recipient = row['borrower_id'] if lender else row['lender_id']
    if recipient is None:
        return
    conn.execute('INSERT INTO inbox_update(id, recipient_id, kind, loan_id, other_name) VALUES (%s, %s, %s, %s, %s)',
                 (uuid4(), recipient, kind, row['id'], row['lender_name'] if lender else row['borrower_name']))


def close(conn, row, user_id: str, reason: str) -> dict:
    """Ends the Loan: its picks go, and the columns ``run_step`` writes are returned."""
    conn.execute('DELETE FROM loan_pick WHERE loan_id=%s', (row['id'],))
    return {'state': 'closed', 'closed_reason': reason, 'closed_by': user_id, 'closed_at': NOW}


def release(conn, row, user_id: str, reason: str) -> dict:
    """Ends a Borrow Request or Lend Offer nobody accepted: a Lend Offer's copies stop being reserved, which moves the
    lender's revision (#258); a Borrow Request reserved nothing."""
    if row['kind'] == 'lend_offer':
        advance_revision(conn, row['lender_id'])
    return close(conn, row, user_id, reason)


def end_loans_between(conn, user_id: str, other_id: str) -> None:
    """Ending a friendship with open Loans (#260), from Remove Friend and Block (``friends.friendship_ended``) by
    ``user_id``, with both owners already locked in ascending ``user_id``. Each Borrow Request, Lend Offer and accepted
    Loan between the two, either way round, that nobody has confirmed a handover for is cancelled by ``user_id``: its
    row locked (in id order) and written once, its picks gone, and the other side told it was cancelled
    (``record_update``), as for any cancel and never why. A Loan either side confirmed a handover for counts as handed
    over and stays open. A Lend Offer's or an accepted Loan's copies stop being reserved, so each such lender's
    revision moves, once."""
    rows = conn.execute("""SELECT * FROM loan
      WHERE ((lender_id = %(a)s AND borrower_id = %(b)s) OR (lender_id = %(b)s AND borrower_id = %(a)s))
        AND state IN ('requested', 'offered', 'accepted')
        AND lender_handover_at IS NULL AND borrower_handover_at IS NULL
      ORDER BY id FOR NO KEY UPDATE""", {'a': user_id, 'b': other_id}).fetchall()
    lenders = set()
    for row in rows:
        if row['state'] in ('offered', 'accepted'):
            lenders.add(row['lender_id'])
        record_update(conn, row, user_id, 'cancelled')
        write_loan(conn, row['id'], close(conn, row, user_id, 'cancelled'))
    for lender in sorted(lenders):
        advance_revision(conn, lender)


@router.post('/{loan_id}/decline', response_model=LoanView)
def decline(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """The lender says no to a Borrow Request, locking only themself, or the borrower to a Lend Offer, which releases
    its copies and locks both (#258). The other side gets a 'declined' update (#259)."""
    def apply(conn, row):
        record_update(conn, row, user_id, 'declined')
        return release(conn, row, user_id, 'declined')

    return run_step(user_id, loan_id, step, 'decline', apply,
                    lambda role, row: [row['lender_id']] if row['kind'] == 'borrow_request'
                    else [row['lender_id'], row['borrower_id']])


@router.post('/{loan_id}/withdraw', response_model=LoanView)
def withdraw(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """The borrower takes back a Borrow Request before it is answered, locking only the Loan row; or the lender a Lend
    Offer, which releases its copies under the lender's lock (#258). The other side gets a 'cancelled' update (#259),
    which the inbox reads as 'withdrawn' from the Loan's ``closed_reason``.
    """
    def apply(conn, row):
        record_update(conn, row, user_id, 'cancelled')
        return release(conn, row, user_id, 'withdrawn')

    return run_step(user_id, loan_id, step, 'withdraw', apply,
                    lambda role, row: [row['lender_id']] if row['kind'] == 'lend_offer' else [])


@router.post('/{loan_id}/cancel', response_model=LoanView)
def cancel(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """Either side cancels an accepted Loan nobody has confirmed a handover for: its copies stop being reserved, so the
    lender's revision moves. The lender locks only themself; the borrower locks both. The other side gets a 'cancelled'
    update (#259)."""
    def apply(conn, row):
        advance_revision(conn, row['lender_id'])
        record_update(conn, row, user_id, 'cancelled')
        return close(conn, row, user_id, 'cancelled')

    return run_step(user_id, loan_id, step, 'cancel', apply,
                    lambda role, row: [row['lender_id']] if role == 'lender' else [row['lender_id'], row['borrower_id']])


@router.post('/{loan_id}/return-by', response_model=LoanView)
def change_return_by(loan_id: UUID, step: ChangeReturnBy, user_id: str = Depends(verified_user)):
    """The lender changes or clears the return-by date of an open Loan (#256). Only the Loan row is locked. A date that
    changed gives the borrower a 'return_by_changed' update (#259)."""
    def apply(conn, row):
        columns = return_by_columns(conn, row, step.return_by)
        if step.return_by != row['return_by']:
            record_update(conn, row, user_id, 'return_by_changed')
        return columns

    return run_step(user_id, loan_id, step, 'change_return_by', apply, lambda role, row: [],
                    {'return_by': step.return_by.isoformat() if step.return_by else None})


@router.post('/{loan_id}/extension', response_model=LoanView)
def ask_for_more_time(loan_id: UUID, step: AskForMoreTime, user_id: str = Depends(verified_user)):
    """The borrower asks for a later return-by date (#256): 422 EXTENSION_NOT_LATER unless it is after the current
    one, and INVALID_RETURN_BY for a day before today. Only the Loan row is locked."""
    def apply(conn, row):
        if step.return_by < today(conn):
            error(422, 'INVALID_RETURN_BY')
        if step.return_by <= row['return_by']:
            error(422, 'EXTENSION_NOT_LATER')
        return {'extension_to': step.return_by, 'extension_asked_at': NOW}

    return run_step(user_id, loan_id, step, 'ask_for_more_time', apply, lambda role, row: [],
                    {'return_by': step.return_by.isoformat()})


@router.post('/{loan_id}/extension/approve', response_model=LoanView)
def approve_extension(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """The lender approves the borrower's request for more time with one tap (#256); 422 INVALID_RETURN_BY when the
    date asked for has passed. The borrower gets a 'return_by_changed' update (#259)."""
    def apply(conn, row):
        if row['extension_to'] < today(conn):
            error(422, 'INVALID_RETURN_BY')
        record_update(conn, row, user_id, 'return_by_changed')
        return {'return_by': row['extension_to'], 'extension_to': None}

    return run_step(user_id, loan_id, step, 'approve_extension', apply, lambda role, row: [])


@router.post('/{loan_id}/extension/decline', response_model=LoanView)
def decline_extension(loan_id: UUID, step: LoanStep, user_id: str = Depends(verified_user)):
    """The lender says no to the borrower's request for more time (#256); the date stays."""
    return run_step(user_id, loan_id, step, 'decline_extension', lambda conn, row: {'extension_to': None},
                    lambda role, row: [])


@router.post('/{loan_id}/notices/seen', response_model=LoanView)
def see_notices(loan_id: UUID, seen: SeenNotices, user_id: str = Depends(verified_user)):
    """Records that the reader was shown these notices (#256), so each shows once per side. A notice not showing now
    is ignored, so it can still show later. No step: no revision, no key; recording twice changes nothing."""
    with connect() as conn, conn.transaction():
        showing = loan_view(conn, user_id, loan_id).notices
        for kind in sorted(set(seen.kinds) & set(showing)):
            conn.execute('INSERT INTO loan_notice_seen(loan_id, user_id, kind) VALUES (%s, %s, %s) '
                         'ON CONFLICT DO NOTHING', (loan_id, user_id, kind))
        return loan_view(conn, user_id, loan_id)
