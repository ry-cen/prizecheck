"""Return-by date and overdue (social network #256), through signed HTTP against PostgreSQL.

The lender keeps, changes or clears the requested date on accepting, and changes or clears it while the Loan is open,
but never brings it earlier once a handover was confirmed. The borrower asks for more time and the lender approves or
declines it. These steps lock only the Loan row. Overdue (from the day after the date) and the 14-day nudge are worked
out on read, with no scheduler, and each notice shows once per side. Dates in the past are set straight in the
database, because the API refuses them.
"""
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

import psycopg

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import hold
from test_friend_copies import ok, place
from test_handover import code, handover
from test_holdings import call
from test_loans import accept, pair, sent, step, view
from want_list_swap_fixtures import seed_swap_catalog

def today():
    with connect() as conn:
        return conn.execute('SELECT current_date AS today').fetchone()['today']


def day(offset):
    return (today() + timedelta(days=offset)).isoformat()


def change(user, loan, return_by):
    return call('POST', f"/api/social/loans/{loan['id']}/return-by", user, {
        'revision': view(user, loan)['revision'], 'idempotency_key': str(uuid4()), 'return_by': return_by})


def ask(user, loan, return_by):
    return call('POST', f"/api/social/loans/{loan['id']}/extension", user, {
        'revision': view(user, loan)['revision'], 'idempotency_key': str(uuid4()), 'return_by': return_by})


def answer(user, loan, verdict):
    return step(user, view(user, loan), f'extension/{verdict}')


def seen(user, loan, kinds):
    return ok(call('POST', f"/api/social/loans/{loan['id']}/notices/seen", user, {'kinds': kinds}))


def backdate(loan, **columns):
    with connect() as conn:
        for column, value in columns.items():
            conn.execute(f'UPDATE loan SET {column}=%s WHERE id=%s', (value, loan['id']))


def requested(return_by=None, held=4):
    """Misty W. holds ``held`` Iono PAL 185 and Ash K. asks her for one (by ``return_by``). Returns (Iono, Ash, Misty,
    the request, ``more``): ``more(return_by)`` sends Misty another request from Ash, as the catalog is seeded once."""
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, place(misty, 'Binder'), iono, held)

    def more(by=None):
        return sent(ash, misty, [(iono, 1)], **({'return_by': by} if by else {}))
    return iono, ash, misty, more(return_by), more


def accepting(lender, loan, iono, **extra):
    body = {'revision': view(lender, loan)['revision'], 'idempotency_key': str(uuid4()),
            'lines': [{'edition_id': iono, 'promised': '1'}], **extra}
    return call('POST', f"/api/loans/{loan['id']}/accept", lender, body)


def test_the_lender_keeps_changes_or_clears_the_requested_date_on_accepting(store):
    iono, ash, misty, loan, more = requested(day(30))
    assert code(accepting(misty, loan, iono, return_by=day(-1))) == (422, 'INVALID_RETURN_BY')
    kept = ok(accept(misty, view(misty, loan), [(iono, 1)]))
    assert kept['return_by'] == day(30)
    # Ash sees the final date before the handover, and can still cancel.
    assert view(ash, loan)['return_by'] == day(30) and 'cancel' in view(ash, loan)['actions']
    assert ok(accepting(misty, more(day(30)), iono, return_by=day(7)))['return_by'] == day(7)
    assert ok(accepting(misty, more(day(30)), iono, return_by=None))['return_by'] is None
    assert ok(accepting(misty, more(), iono, return_by=day(3)))['return_by'] == day(3)


def test_the_lender_extends_or_clears_the_date_but_never_brings_it_earlier_after_handover(store):
    iono, ash, misty, loan, more = requested(day(30))
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    assert 'change_return_by' in view(misty, loan)['actions']
    assert code(change(ash, loan, day(40))) == (409, 'STEP_NOT_ALLOWED')
    # Before any handover, any date from today on.
    assert ok(change(misty, loan, day(10)))['return_by'] == day(10)
    assert code(change(misty, loan, day(-1))) == (422, 'INVALID_RETURN_BY')
    ok(handover(misty, loan))
    assert code(change(misty, loan, day(9))) == (409, 'RETURN_BY_EARLIER')
    assert ok(change(misty, loan, day(10)))['return_by'] == day(10)
    assert ok(change(misty, loan, day(20)))['return_by'] == day(20)
    assert ok(change(misty, loan, None))['return_by'] is None
    # Once cleared after the handover, any date would bring it earlier: the change is no longer offered.
    assert 'change_return_by' not in view(misty, loan)['actions']
    assert code(change(misty, loan, day(60))) == (409, 'STEP_NOT_ALLOWED')
    ok(handover(ash, loan))
    assert 'ask_for_more_time' not in view(ash, loan)['actions']


def test_the_borrower_asks_for_more_time_and_the_lender_approves_or_declines(store):
    iono, ash, misty, loan, more = requested(day(10))
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    ok(handover(misty, loan))
    ok(handover(ash, loan))
    assert view(ash, loan)['actions'] == ['start_return', 'ask_for_more_time']
    assert code(ask(misty, loan, day(20))) == (409, 'STEP_NOT_ALLOWED')
    assert code(ask(ash, loan, day(10))) == (422, 'EXTENSION_NOT_LATER')
    asked = ok(ask(ash, loan, day(20)))
    assert (asked['extension_to'], asked['return_by'], asked['actions']) == (day(20), day(10), ['start_return'])
    told = view(misty, loan)
    assert (told['extension_to'], told['needs_you'], told['section']) == (day(20), True, 'needs_you')
    assert told['actions'] == ['start_return', 'write_off', 'change_return_by', 'approve_extension',
                               'decline_extension']
    approved = ok(answer(misty, loan, 'approve'))
    assert (approved['return_by'], approved['extension_to'], approved['needs_you']) == (day(20), None, False)
    ok(ask(ash, loan, day(25)))
    declined = ok(answer(misty, loan, 'decline'))
    assert (declined['return_by'], declined['extension_to']) == (day(20), None)
    # The lender's own new date answers a request too.
    ok(ask(ash, loan, day(40)))
    changed = ok(change(misty, loan, day(30)))
    assert (changed['return_by'], changed['extension_to'], changed['needs_you']) == (day(30), None, False)


def test_overdue_shows_from_the_day_after_the_date_and_its_notice_once_per_side(store):
    iono, ash, misty, loan, more = requested(day(10))
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    ok(handover(misty, loan))
    ok(handover(ash, loan))
    backdate(loan, return_by=today())
    assert (view(ash, loan)['overdue_since'], view(ash, loan)['notices']) == (None, [])
    backdate(loan, return_by=today() - timedelta(days=3))
    since = (today() - timedelta(days=2)).isoformat()
    for user in (ash, misty):
        assert (view(user, loan)['overdue_since'], view(user, loan)['notices']) == (since, ['overdue'])
    # Ash was shown it: it stays for Misty, and the date stays for both.
    assert seen(ash, loan, ['overdue', 'nudge_answer'])['notices'] == []
    assert view(ash, loan)['overdue_since'] == since and view(misty, loan)['notices'] == ['overdue']
    assert seen(ash, loan, ['overdue'])['notices'] == []
    # More time ends it.
    ok(ask(ash, loan, day(5)))
    assert ok(answer(misty, loan, 'approve'))['overdue_since'] is None


def test_an_accepted_loan_or_a_request_waiting_14_days_nudges_both_sides_once(store):
    iono, ash, misty, loan, more = requested()
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    with connect() as conn:
        conn.execute("UPDATE loan SET accepted_at = now() - interval '13 days' WHERE id=%s", (loan['id'],))
    assert view(misty, loan)['notices'] == []
    with connect() as conn:
        conn.execute("UPDATE loan SET accepted_at = now() - interval '14 days' WHERE id=%s", (loan['id'],))
    assert view(misty, loan)['notices'] == ['nudge_handover'] and view(ash, loan)['notices'] == ['nudge_handover']
    assert seen(misty, loan, ['nudge_handover'])['notices'] == []
    assert view(misty, loan)['notices'] == [] and view(ash, loan)['notices'] == ['nudge_handover']
    # A confirmed handover ends it. A Borrow Request nobody answered for 14 days nudges both sides too (story 89).
    ok(handover(misty, loan))
    assert view(ash, loan)['notices'] == []
    unanswered = more()
    with connect() as conn:
        conn.execute("UPDATE loan SET created_at = now() - interval '13 days' WHERE id=%s", (unanswered['id'],))
    assert view(misty, unanswered)['notices'] == []
    with connect() as conn:
        conn.execute("UPDATE loan SET created_at = now() - interval '14 days' WHERE id=%s", (unanswered['id'],))
    assert view(misty, unanswered)['notices'] == ['nudge_answer'] and view(ash, unanswered)['notices'] == ['nudge_answer']


def test_seeing_a_requests_nudge_never_hides_the_nudge_once_it_is_accepted(store):
    iono, ash, misty, loan, more = requested()
    with connect() as conn:
        conn.execute("UPDATE loan SET created_at = now() - interval '14 days' WHERE id=%s", (loan['id'],))
    assert seen(misty, loan, ['nudge_answer'])['notices'] == []
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    assert view(misty, loan)['notices'] == []
    with connect() as conn:
        conn.execute("UPDATE loan SET accepted_at = now() - interval '14 days' WHERE id=%s", (loan['id'],))
    assert view(misty, loan)['notices'] == ['nudge_handover']


def test_a_date_that_has_passed_is_never_kept_or_approved_and_a_cleared_date_stays_cleared_after_a_handover(store):
    # Accepting keeps the requested date only while it is today or later; approving more time likewise.
    iono, ash, misty, loan, more = requested(day(10))
    backdate(loan, return_by=today() - timedelta(days=1))
    assert code(accept(misty, view(misty, loan), [(iono, 1)])) == (422, 'INVALID_RETURN_BY')
    ok(accepting(misty, loan, iono, return_by=day(10)))
    ok(handover(misty, loan))
    ok(ask(ash, loan, day(20)))
    with connect() as conn:
        conn.execute("UPDATE loan SET extension_to = current_date - 1 WHERE id=%s", (loan['id'],))
    assert code(answer(misty, loan, 'approve')) == (422, 'INVALID_RETURN_BY')
    # Once handed over with the date cleared, any date would be earlier: the lender isn't offered the change.
    ok(change(misty, loan, None))
    assert 'change_return_by' not in view(misty, loan)['actions']
    assert code(change(misty, loan, day(30))) == (409, 'STEP_NOT_ALLOWED')


def test_date_steps_lock_only_the_loan_row(store):
    # Both owner rows are held FOR NO KEY UPDATE by another transaction, as another Loan step holds them: the date
    # steps of both sides still run.
    iono, ash, misty, loan, more = requested(day(10))
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    ok(handover(misty, loan))
    with psycopg.connect(os.environ['DATABASE_URL']) as holder, ThreadPoolExecutor(max_workers=1) as executor:
        holder.execute('SELECT 1 FROM inventory_owner WHERE user_id = ANY(%s) FOR NO KEY UPDATE', ([ash, misty],))
        assert executor.submit(change, misty, loan, day(12)).result(timeout=20).status_code == 200
        assert executor.submit(ask, ash, loan, day(20)).result(timeout=20).status_code == 200
        assert executor.submit(answer, misty, loan, 'approve').result(timeout=20).status_code == 200
        holder.rollback()
    assert view(ash, loan)['return_by'] == day(20)
