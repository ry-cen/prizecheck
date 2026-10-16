"""The inbox (social network #259), through signed HTTP against PostgreSQL.

What waits on a collector is worked out from Loan, return and Write-off state on every read: one line per Loan, with
the step it waits for, and the Loans tab's badge counts the same Loans. Steps store an update for the other side (a
request or offer accepted, partly accepted or declined, a Loan cancelled, the return-by date changed) naming who took
it and never why. Overdue and the 14-day nudge are worked out on read and listed until cleared. The inbox marks what it
showed read, Clear dismisses it, and updates read more than 90 days ago are deleted lazily.
"""
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_friend_copies import collector, node, ok, place
from test_handover import handover, use_suggested
from test_holdings import call
from test_lend_offers import offer, offering, take
from test_loan_promises import holding
from test_loans import accept, sent, step, view
from test_moves import commit, selected, stage, start
from test_return_by import answer, ask, backdate, change, day, requested, seen
from test_returns import confirm_return, leave, lent_loan, start_return
from test_write_off import choose, write_off


def inbox(user):
    return ok(call('GET', '/api/social/inbox', user))


def waiting(user):
    """The inbox's waiting lines as (Loan id, step). The Loans tab's badge always counts the same Loans."""
    lines = [(loan['id'], loan['waiting']) for loan in inbox(user)['waiting']]
    assert ok(call('GET', '/api/social/loans', user))['needs_you'] == len(lines)
    return lines


def updates(user):
    return [(update['kind'], update['loan_id'], update['other_name'], update['read'])
            for update in inbox(user)['updates']]


def ids(user):
    return [update['id'] for update in inbox(user)['updates']]


def mark(user, action, names):
    return ok(call('POST', f'/api/social/inbox/{action}', user, {'ids': names}))


def test_waiting_on_you_follows_the_loan_through_its_steps_one_line_per_loan(store):
    iono, ash, misty, loan, more = requested(day(10), held=4)
    assert waiting(misty) == [(loan['id'], 'answer')] and waiting(ash) == []
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    assert waiting(misty) == [] and waiting(ash) == []
    # Misty moves her copies out of the Binder: her pick is out of date, which waits on her until she fixes it.
    binder, box = node(misty, 'Binder')['id'], place(misty, 'Box')
    manifest = start(misty, binder)
    stage(misty, manifest, [selected(iono, 4, holding(misty, binder, iono)['version'])])
    assert commit(misty, manifest, box).status_code == 200
    assert waiting(misty) == [(loan['id'], 'fix_picks')] and view(misty, loan)['section'] == 'needs_you'
    assert waiting(ash) == []
    ok(use_suggested(misty, loan))
    assert waiting(misty) == []
    # Each side's handover waits on the other.
    ok(handover(misty, loan))
    assert waiting(ash) == [(loan['id'], 'receive')] and waiting(misty) == []
    second = more(day(10))
    ok(accept(misty, view(misty, second), [(iono, 1)]))
    ok(handover(ash, second))
    assert waiting(misty) == [(second['id'], 'hand_over')]
    ok(handover(misty, second))
    ok(handover(ash, loan))
    assert waiting(misty) == [] and waiting(ash) == []
    # A return one side started, and more time the borrower asked for.
    ok(start_return(ash, loan, [(iono, 1)]))
    assert waiting(misty) == [(loan['id'], 'confirm_return')] and waiting(ash) == []
    ok(confirm_return(misty, loan))
    ok(ask(ash, second, day(20)))
    assert waiting(misty) == [(second['id'], 'more_time')]
    ok(answer(misty, second, 'approve'))
    assert waiting(misty) == [] and waiting(ash) == []


def test_a_write_off_choice_a_gone_collector_and_an_offer_wait_on_the_right_side(store):
    iono, ash, misty, binders, loan, _ = lent_loan({'Binder': 3}, 3)
    ok(write_off(misty, loan, [(iono, 1)]))
    assert waiting(ash) == [(loan['id'], 'choose')] and waiting(misty) == []
    ok(choose(ash, loan, 'remove'))
    assert waiting(ash) == []
    # Ash gives one back, and Misty deletes her account before confirming it: the return waits on Ash to finish, then
    # his copy still out waits on him.
    ok(start_return(ash, loan, [(iono, 1)]))
    assert waiting(ash) == [] and waiting(misty) == [(loan['id'], 'confirm_return')]
    leave(misty)
    assert waiting(ash) == [(loan['id'], 'finish_return')]
    ok(confirm_return(ash, loan))
    assert waiting(ash) == [(loan['id'], 'return')]
    # A Lend Offer waits on the borrower.
    ids_, iono, ash, misty, binders = offering()
    offered = ok(offer(misty, ash, [(binders['Binder A'], iono, 2)]), 201)
    assert waiting(ash) == [(offered['id'], 'answer')] and waiting(misty) == []


def test_steps_store_an_update_for_the_other_side_naming_who_took_it_and_never_why(store):
    iono, ash, misty, loan, more = requested(held=6)
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    part = sent(ash, misty, [(iono, 2)])
    ok(accept(misty, view(misty, part), [(iono, 1)]))
    ok(step(misty, view(misty, more()), 'decline'))
    ok(step(ash, more(), 'withdraw'))
    ok(step(misty, view(misty, part), 'cancel'))
    ok(change(misty, loan, day(10)))
    ok(change(misty, loan, day(10)))  # the same date changes nothing, and says nothing
    ok(ask(ash, loan, day(20)))
    ok(answer(misty, loan, 'approve'))
    told = updates(ash)
    assert [(kind, name, read) for kind, _, name, read in told] == [
        ('return_by_changed', 'Misty W.', False), ('return_by_changed', 'Misty W.', False),
        ('cancelled', 'Misty W.', False), ('declined', 'Misty W.', False), ('partly_accepted', 'Misty W.', False),
        ('accepted', 'Misty W.', False)]
    assert [loan_id for _, loan_id, _, _ in told][-2:] == [part['id'], loan['id']]
    assert [(kind, name) for kind, _, name, _ in updates(misty)] == [('cancelled', 'Ash K.')]
    # A Lend Offer's answers go to the lender.
    ids_, iono, ash, misty, binders = offering()
    taken = ok(offer(misty, ash, [(binders['Binder A'], iono, 2)]), 201)
    ok(take(ash, taken, [(iono, 1)]))
    ok(step(ash, view(ash, ok(offer(misty, ash, [(binders['Binder B'], iono, 1)]), 201)), 'decline'))
    assert [(kind, name) for kind, _, name, _ in updates(misty)] == [
        ('declined', 'Ash K.'), ('partly_accepted', 'Ash K.')]
    assert updates(ash) == []
    first = inbox(misty)['updates'][0]
    assert (first['loan_kind'], first['loan_state'], first['role']) == ('lend_offer', 'closed', 'lender')


def test_the_inbox_marks_what_it_showed_read_clear_dismisses_it_and_old_read_updates_go(store):
    iono, ash, misty, loan, more = requested(held=6)
    for _ in range(3):
        ok(step(misty, view(misty, more()), 'decline'))
    before = inbox(ash)['updates']
    shown = [update['id'] for update in before]
    assert len(shown) == 3 and not any(update['read'] for update in before)
    assert mark(ash, 'read', shown)['updates'] == [{**update, 'read': True} for update in before]
    # An update that arrives after the drawer showed the others is neither marked nor cleared with them.
    ok(step(misty, view(misty, more()), 'decline'))
    cleared = mark(ash, 'clear', shown)
    assert [(update['kind'], update['read']) for update in cleared['updates']] == [('declined', False)]
    # Nobody else's ids, and nothing that isn't an update, are touched.
    (stranger, _) = collector()
    mark(stranger, 'clear', ids(ash) + ['nonsense', f'overdue:{uuid4()}'])
    assert len(ids(ash)) == 1
    # Read updates go 90 days after they were read, when the collector next marks or clears updates.
    with connect() as conn:
        rows = conn.execute('SELECT id FROM inbox_update WHERE recipient_id=%s ORDER BY created_at', (ash,)).fetchall()
        assert len(rows) == 4
        conn.execute("UPDATE inbox_update SET read_at = now() - interval '91 days' WHERE id=%s", (rows[0]['id'],))
        conn.execute("UPDATE inbox_update SET read_at = now() - interval '89 days' WHERE id=%s", (rows[1]['id'],))
        conn.execute("UPDATE inbox_update SET read_at = NULL, created_at = now() - interval '200 days' WHERE id=%s",
                     (rows[2]['id'],))
    mark(ash, 'read', [str(rows[3]['id'])])
    with connect() as conn:
        left = {row['id'] for row in conn.execute('SELECT id FROM inbox_update WHERE recipient_id=%s', (ash,))}
    assert left == {rows[1]['id'], rows[2]['id'], rows[3]['id']}


def test_overdue_and_the_nudge_are_listed_until_cleared_and_the_loan_screen_marks_them_read(store):
    iono, ash, misty, loan, more = requested(day(10), held=4)
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    ok(handover(misty, loan))
    backdate(loan, return_by=day(-1))
    assert [(kind, read) for kind, _, _, read in updates(misty)] == [('overdue', False)]
    assert [(kind, name) for kind, _, name, _ in updates(ash)] == [('overdue', 'Misty W.'), ('accepted', 'Misty W.')]
    assert inbox(ash)['updates'][0]['return_by'] == day(-1)
    # Misty opens the Loan: the notice is read, and stays listed until she clears it.
    assert seen(misty, loan, ['overdue'])['notices'] == []
    assert [(kind, read) for kind, _, _, read in updates(misty)] == [('overdue', True)]
    # Ash's inbox showing it counts as seen on the Loan screen too.
    mark(ash, 'read', ids(ash))
    assert view(ash, loan)['notices'] == []
    mark(misty, 'clear', ids(misty))
    assert updates(misty) == [] and [kind for kind, _, _, _ in updates(ash)] == ['overdue', 'accepted']
    # A notice not showing yet can't be cleared ahead of time.
    second = more()
    ok(accept(misty, view(misty, second), [(iono, 1)]))
    mark(misty, 'clear', [f'nudge_handover:{second["id"]}'])
    with connect() as conn:
        conn.execute("UPDATE loan SET accepted_at = now() - interval '14 days' WHERE id=%s", (second['id'],))
    assert [(kind, loan_id) for kind, loan_id, _, _ in updates(misty)] == [('nudge_handover', second['id'])]
    mark(misty, 'clear', ids(misty))
    assert updates(misty) == []


def test_a_step_storing_an_update_never_waits_on_the_other_collectors_owner_row(store):
    # Ash's owner row is held FOR UPDATE, as his own inventory commands hold it. Misty's steps that tell him something
    # still run: the update names him with no key check on his row.
    iono, ash, misty, loan, more = requested(day(10), held=4)
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    second = view(misty, more())
    with psycopg.connect(os.environ['DATABASE_URL']) as holder, ThreadPoolExecutor(max_workers=1) as executor:
        holder.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE', (ash,))
        assert executor.submit(change, misty, loan, day(12)).result(timeout=20).status_code == 200
        assert executor.submit(step, misty, second, 'decline').result(timeout=20).status_code == 200
        assert executor.submit(step, misty, view(misty, loan), 'cancel').result(timeout=20).status_code == 200
        holder.rollback()
    assert [kind for kind, _, _, _ in updates(ash)] == ['cancelled', 'declined', 'return_by_changed', 'accepted']
