"""The inbox (social network #259, spec "Inbox derivation"): the bell's drawer.

**Waiting on you** is worked out on every read from Loan, return and Write-off state through ``loans.waiting_step``, the
definition the Loans tab and its badge read, so the bell, the drawer and the tab always agree; nothing about it is
stored. It lists one Loan per line. Friend Requests are answered in the Friends drawer, whose own badge counts them.

**Updates** come in two kinds. Event updates are the rows a Loan step stored for the reader (``loans.record_update``,
migration 130). Time-based ones (a Loan overdue, the 14-day nudge) are worked out on read from the Loan, as the Loan
screen's notices are (#256), and listed while they apply: ``loan_notice_seen`` marks one read (the Loan screen or this
inbox showed it) and dismissed (Clear), so a cleared one never comes back. The inbox marks what it shows read
(``POST /api/social/inbox/read``) and Clear dismisses it (``POST /api/social/inbox/clear``); each names the updates it
saw, so an update that arrived after the drawer opened is neither marked nor cleared. Event updates read more than
``PRUNE_DAYS`` days ago are deleted when the collector next marks or clears updates.

Each waiting line says how long it has waited (``since``), when the Loan reached the step that waits on the reader
(owner's decision, 2026-10-16): see ``waiting_since``. Each update says when it happened (``at``), which the drawer shows as "3 hours ago" or a date (owner's decision,
2026-10-16). A withdraw is stored as a 'cancelled' update, as any cancel; the inbox reads it as 'withdrawn' from the
Loan's ``closed_reason``, which only a withdraw sets, so the drawer says "withdrew their request" (or offer).

Every route reads only the reader's own Loans and updates, takes no lock, writes no Loan row and moves no revision.
"""
from datetime import date, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..main import connect, verified_user
from .loans import LOANS, NUDGE_DAYS, LoanView, loan_facts, loan_views, role_of

router = APIRouter(prefix='/api/social/inbox', tags=['social'])

# Days after it was read that an event update is deleted.
PRUNE_DAYS = 90
# The newest event updates the drawer lists.
UPDATES = 50

UpdateKind = Literal['accepted', 'partly_accepted', 'declined', 'cancelled', 'withdrawn', 'return_by_changed',
                     'overdue', 'nudge_answer', 'nudge_handover']
# The time-based kinds, as the Loan screen's notices (``loans.Notice``, migration 126).
NOTICES = ('overdue', 'nudge_answer', 'nudge_handover')


class InboxUpdate(BaseModel):
    """One update under **Earlier**. ``id`` names it to the read and clear routes. ``other_name``: the collector who took
    the step, or for a time-based update the other side. ``loan_kind``, ``loan_state`` and ``role`` (the reader's side)
    let the screen word it; ``read``: the reader was shown it. ``kind`` 'withdrawn': a 'cancelled' update on a Loan
    its other side withdrew. ``at``: when it happened, the step's time for an event update; for a time-based one, when
    it began to apply: the start of the day after the return-by date (overdue), or ``NUDGE_DAYS`` after the request or
    offer was sent (nudge_answer) or accepted (nudge_handover)."""
    id: str
    kind: UpdateKind
    loan_id: UUID
    loan_kind: Literal['borrow_request', 'lend_offer']
    loan_state: Literal['requested', 'offered', 'accepted', 'handed_over', 'closed']
    role: Literal['lender', 'borrower']
    other_name: str
    read: bool
    at: datetime
    # The return-by date of an overdue Loan.
    return_by: date | None = None


class InboxWaiting(LoanView):
    """A Loan waiting on the reader. ``since``: when it began to wait on them, the time of the step it waits for (see
    ``waiting_since``); the drawer shows it as "3 hours ago" or a date."""
    since: datetime


class InboxView(BaseModel):
    """The bell's drawer: the Loans waiting on the reader (each with its ``waiting`` step and ``since``), newest first,
    then the updates not cleared, time-based ones first, then event updates newest first."""
    waiting: list[InboxWaiting]
    updates: list[InboxUpdate]


class InboxIds(BaseModel):
    """The updates the drawer showed, by ``InboxUpdate.id``."""
    ids: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(min_length=1, max_length=200)


def notice_id(kind: str, loan_id) -> str:
    return f'{kind}:{loan_id}'


def waiting_since(user_id: str, row, facts, step: str) -> datetime:
    """When the Loan began to wait on the reader for ``step`` (``loans.Waiting``), from times the Loan already holds:
    a Borrow Request or Lend Offer to answer, its ``created_at``; a handover the other side confirmed (hand_over,
    receive), that confirmation; a return to confirm or finish, the return's start; written-off copies to keep or
    remove, the newest Write-off (``written_off_at``); more time asked for, when it was asked (``extension_asked_at``).
    Three have no moment of their own and use the nearest one the Loan holds: out-of-date picks (fix_picks) and a
    Loan that predates ``written_off_at`` or ``extension_asked_at`` use ``accepted_at``, and copies still out once the
    other side's account is gone (return) the reader's own handover confirmation, since nothing records when the
    account went. Overdue isn't a waiting step; it is an update, whose time is ``at``."""
    if step == 'answer':
        return row['created_at']
    if step in ('confirm_return', 'finish_return'):
        return facts.pending['created_at']
    if step in ('hand_over', 'receive'):
        return row['borrower_handover_at' if step == 'hand_over' else 'lender_handover_at']
    if step == 'return':
        return row[f'{role_of(user_id, row)}_handover_at'] or row['accepted_at']
    named = {'choose': 'written_off_at', 'more_time': 'extension_asked_at'}.get(step)
    return (row[named] if named else None) or row['accepted_at'] or row['created_at']


def inbox_view(conn, user_id: str) -> InboxView:
    rows = conn.execute(LOANS + " AND o.state <> 'closed' ORDER BY o.created_at DESC, o.id",
                        {'me': user_id}).fetchall()
    facts = loan_facts(conn, user_id, rows)
    views = loan_views(conn, user_id, rows, facts)
    marks = {(mark['loan_id'], mark['kind']): mark['dismissed_at'] is not None for mark in conn.execute(
        'SELECT loan_id, kind, dismissed_at FROM loan_notice_seen WHERE user_id=%s AND loan_id = ANY(%s)',
        (user_id, [row['id'] for row in rows]))} if rows else {}
    # The start of each overdue Loan's first overdue day, by the database's clock, which decided it is overdue.
    days = sorted({row['return_by'] + timedelta(days=1) for row in rows if 'overdue' in facts[row['id']].showing})
    starts = {found['day']: found['at'] for found in conn.execute(
        'SELECT day, day::timestamptz AS at FROM unnest(%s::date[]) AS day', (days,))} if days else {}

    def began(kind: str, row) -> datetime:
        if kind == 'overdue':
            return starts[row['return_by'] + timedelta(days=1)]
        return row['created_at' if kind == 'nudge_answer' else 'accepted_at'] + timedelta(days=NUDGE_DAYS)

    updates = []
    for row, view in zip(rows, views):
        for kind in facts[row['id']].showing:
            if marks.get((row['id'], kind)):
                continue
            updates.append(InboxUpdate(
                id=notice_id(kind, row['id']), kind=kind, loan_id=row['id'], loan_kind=row['kind'],
                loan_state=row['state'], role=view.role, other_name=view.other.display_name,
                read=(row['id'], kind) in marks, at=began(kind, row),
                return_by=row['return_by'] if kind == 'overdue' else None))
    for event in conn.execute("""SELECT u.id, u.kind, u.loan_id, u.other_name, u.read_at, u.created_at,
        o.kind AS loan_kind, o.state AS loan_state, o.closed_reason, o.lender_id, o.borrower_id
      FROM inbox_update u JOIN loan o ON o.id = u.loan_id
      WHERE u.recipient_id = %s AND u.dismissed_at IS NULL
      ORDER BY u.created_at DESC, u.id LIMIT %s""", (user_id, UPDATES)):
        withdrawn = event['kind'] == 'cancelled' and event['closed_reason'] == 'withdrawn'
        updates.append(InboxUpdate(
            id=str(event['id']), kind='withdrawn' if withdrawn else event['kind'], loan_id=event['loan_id'],
            loan_kind=event['loan_kind'], loan_state=event['loan_state'], role=role_of(user_id, event),
            other_name=event['other_name'], read=event['read_at'] is not None, at=event['created_at']))
    # Time-based notices and stored events interleave in time order, newest first.
    updates.sort(key=lambda update: update.at, reverse=True)
    waiting = [InboxWaiting(**dict(view), since=waiting_since(user_id, row, facts[row['id']], view.waiting))
               for row, view in zip(rows, views) if view.waiting is not None]
    return InboxView(waiting=waiting, updates=updates)


def _split(ids: list[str]) -> tuple[list[UUID], dict[UUID, set[str]]]:
    """The event update ids and the time-based notices ({Loan id: kinds}) among ``ids``; anything else is ignored."""
    events: list[UUID] = []
    notices: dict[UUID, set[str]] = {}
    for item in ids:
        kind, _, rest = item.partition(':')
        try:
            if rest and kind in NOTICES:
                notices.setdefault(UUID(rest), set()).add(kind)
            elif not rest:
                events.append(UUID(item))
        except ValueError:
            continue
    return events, notices


def _showing(conn, user_id: str, notices: dict[UUID, set[str]]) -> list[tuple[UUID, str]]:
    """The named time-based notices that apply now on the reader's own Loans: a notice not showing now is left alone,
    so it can still show later (as ``loans.see_notices`` does)."""
    if not notices:
        return []
    rows = conn.execute(LOANS + ' AND o.id = ANY(%(ids)s)', {'me': user_id, 'ids': list(notices)}).fetchall()
    facts = loan_facts(conn, user_id, rows)
    return sorted(((row['id'], kind) for row in rows for kind in facts[row['id']].showing
                   if kind in notices[row['id']]), key=lambda item: (str(item[0]), item[1]))


def _prune(conn, user_id: str) -> None:
    conn.execute(f"DELETE FROM inbox_update WHERE recipient_id=%s AND read_at < now() - interval '{PRUNE_DAYS} days'",
                 (user_id,))


@router.get('', response_model=InboxView)
def read_inbox(user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        return inbox_view(conn, user_id)


@router.post('/read', response_model=InboxView)
def mark_read(body: InboxIds, user_id: str = Depends(verified_user)):
    """Marks the updates the drawer showed read. Marking twice changes nothing."""
    events, notices = _split(body.ids)
    with connect() as conn, conn.transaction():
        if events:
            conn.execute('UPDATE inbox_update SET read_at=now() '
                         'WHERE recipient_id=%s AND id = ANY(%s) AND read_at IS NULL', (user_id, events))
        for loan_id, kind in _showing(conn, user_id, notices):
            conn.execute('INSERT INTO loan_notice_seen(loan_id, user_id, kind) VALUES (%s, %s, %s) '
                         'ON CONFLICT DO NOTHING', (loan_id, user_id, kind))
        _prune(conn, user_id)
        return inbox_view(conn, user_id)


@router.post('/clear', response_model=InboxView)
def clear(body: InboxIds, user_id: str = Depends(verified_user)):
    """**Clear**: dismisses the updates the drawer showed, which also marks them read. A cleared time-based update
    doesn't show again."""
    events, notices = _split(body.ids)
    with connect() as conn, conn.transaction():
        if events:
            conn.execute("""UPDATE inbox_update SET dismissed_at=now(), read_at=coalesce(read_at, now())
              WHERE recipient_id=%s AND id = ANY(%s) AND dismissed_at IS NULL""", (user_id, events))
        for loan_id, kind in _showing(conn, user_id, notices):
            conn.execute("""INSERT INTO loan_notice_seen(loan_id, user_id, kind, dismissed_at) VALUES (%s, %s, %s, now())
              ON CONFLICT (loan_id, user_id, kind)
              DO UPDATE SET dismissed_at = coalesce(loan_notice_seen.dismissed_at, now())""", (loan_id, user_id, kind))
        _prune(conn, user_id)
        return inbox_view(conn, user_id)
