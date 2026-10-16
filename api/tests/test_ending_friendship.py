"""Ending a friendship with open Loans (social network #260), through signed HTTP against PostgreSQL.

Remove Friend and Block, from either side, cancel the pair's Borrow Requests, Lend Offers and accepted Loans nobody has
confirmed a handover for, either way round, and release what they reserved: each such lender's revision moves once.
The other side is told only that the Loan was cancelled and by whom, as for any cancel. A Loan either side confirmed a
handover for counts as handed over and stays open, and its steps still work. An unfriend racing a handover, or a
cancel from the other side, waits for it and never deadlocks. Edit and resend, a new request to the lender, is offered
only while the two are Friends (owner's decision, 2026-10-16).
"""
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import hold
from test_blocks import unblock
from test_friend_copies import befriend, block, ok, place
from test_handover import _asleep, _sleeping, accepted_loan, borrowed, code, handover, take_back
from test_holdings import call
from test_inbox import inbox, updates
from test_lend_offers import offer
from test_loans import accept, pair, revision_of, sent, step, view
from test_returns import confirm_return, start_return
from want_list_swap_fixtures import seed_swap_catalog

CANCELLED = ('requested', 'accepted', 'offered', 'reverse')


def remove(user, other, key=None):
    return call('POST', f'/api/social/friends/{other}/remove', user, {'idempotency_key': str(key or uuid4())})


def shape(user, loan):
    found = view(user, loan)
    return found['state'], found['closed_reason'], found['closed_by']


def picks_left(loan):
    with connect() as conn:
        return conn.execute('SELECT count(*) AS n FROM loan_pick WHERE loan_id=%s', (loan['id'],)).fetchone()['n']


def cancels(user):
    return sorted((loan_id, name) for kind, loan_id, name, _ in updates(user) if kind == 'cancelled')


def loans_between():
    """Ash K. and Misty W., Friends, Ash's id first. Misty holds 8 Iono in Binder, Ash 2 in Box. Between them: a Borrow
    Request Ash sent, a Loan Misty accepted, a Lend Offer Misty sent, a Loan Ash accepted lending Misty one, a Loan only
    Misty confirmed handing over, and a Loan both confirmed."""
    iono = seed_swap_catalog()['PAL 185']
    ash, misty = pair(ordered=True)
    binder, box = place(misty, 'Binder'), place(ash, 'Box')
    hold(misty, binder, iono, 8)
    hold(ash, box, iono, 2)

    def accepted():
        return ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))

    loans = {'requested': sent(ash, misty, [(iono, 1)]), 'accepted': accepted(),
             'offered': ok(offer(misty, ash, [(binder, iono, 1)]), 201),
             'reverse': ok(accept(ash, view(ash, sent(misty, ash, [(iono, 1)])), [(iono, 1)])),
             'half': accepted(), 'out': accepted()}
    ok(handover(misty, loans['half']))
    ok(handover(misty, loans['out']))
    ok(handover(ash, loans['out']))
    return iono, ash, misty, loans


def test_removing_a_friend_cancels_every_loan_nobody_handed_over_either_way_and_keeps_the_rest(store):
    iono, ash, misty, loans = loans_between()
    before = {owner: revision_of(owner) for owner in (ash, misty)}
    key = uuid4()
    assert ok(remove(ash, misty, key))['relation'] == 'none'
    for name in CANCELLED:
        assert shape(ash, loans[name]) == ('closed', 'cancelled', 'you'), name
        assert shape(misty, loans[name]) == ('closed', 'cancelled', 'them'), name
        assert picks_left(loans[name]) == 0, name
    # Misty lent on the accepted Loan and the offer, Ash on the reverse one: each revision moved once.
    assert revision_of(misty) == before[misty] + 1 and revision_of(ash) == before[ash] + 1
    # A Loan either side confirmed a handover for stays open.
    half = view(misty, loans['half'])
    assert (half['state'], half['you_confirmed_handover'], half['they_confirmed_handover']) == ('accepted', True, False)
    assert view(ash, loans['out'])['state'] == 'handed_over'
    # Misty is told each was cancelled by Ash and never why; Ash, who ended it, is told nothing.
    assert cancels(misty) == sorted((loans[name]['id'], 'Ash K.') for name in CANCELLED)
    assert cancels(ash) == []
    # The same command replayed changes nothing more.
    assert ok(remove(ash, misty, key))['relation'] == 'none'
    assert revision_of(misty) == before[misty] + 1 and len(cancels(misty)) == len(CANCELLED)
    # The open Loans' steps still work: Ash confirms the half-confirmed one, and returns the handed-over one.
    ok(handover(ash, loans['half']))
    assert view(misty, loans['half'])['state'] == 'handed_over'
    ok(start_return(ash, loans['out'], [(iono, 1)]))
    ok(confirm_return(misty, loans['out']))
    assert shape(misty, loans['out'])[:2] == ('closed', 'returned')


def test_a_block_by_either_side_cancels_them_too_and_the_blocked_collector_reads_a_plain_cancel(store):
    iono, ash, misty, loans = loans_between()
    block(misty, ash)
    for name in CANCELLED:
        assert shape(ash, loans[name]) == ('closed', 'cancelled', 'them'), name
    assert cancels(ash) == sorted((loans[name]['id'], 'Misty W.') for name in CANCELLED)
    told = next(update for update in inbox(ash)['updates']
                if update['loan_id'] == loans['accepted']['id'])
    assert set(told) == {'id', 'kind', 'loan_id', 'loan_kind', 'loan_state', 'role', 'other_name', 'read', 'at',
                         'return_by'}
    # Misty confirmed the half-confirmed Loan: she may still take that back after the Block, and then it is a Loan
    # nobody confirmed a handover for, which either side may cancel.
    assert view(ash, loans['half'])['state'] == 'accepted'
    ok(take_back(misty, loans['half']))
    ok(step(ash, view(ash, loans['half']), 'cancel'))
    assert shape(misty, loans['half']) == ('closed', 'cancelled', 'them')
    assert view(misty, loans['out'])['state'] == 'handed_over'
    # The borrower's Block cancels the lender's Loans just the same.
    iono, ash, misty, loans = loans_between()
    block(ash, misty)
    for name in CANCELLED:
        assert shape(misty, loans[name]) == ('closed', 'cancelled', 'them'), name
    assert view(misty, loans['half'])['state'] == 'accepted'


def test_an_unfriend_racing_the_lenders_handover_waits_and_leaves_that_loan_open(store):
    # Ash's id sorts first, so his unfriend holds his own row while it waits on Misty's, which her handover holds.
    iono, ash, misty, binder, loan = accepted_loan(held=4, asked=2, ordered=True)
    pending = sent(ash, misty, [(iono, 1)])
    drop = _sleeping('loan_pick', 'UPDATE', f"NEW.owner_id = '{misty}' AND NEW.state = 'lent'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            handed = executor.submit(handover, misty, loan)
            _asleep(watch, 1, [handed])
            removed = executor.submit(remove, ash, misty)
            handed, removed = handed.result(), removed.result()
    finally:
        drop()
    assert handed.status_code == 200, handed.text
    assert ok(removed)['relation'] == 'none'
    found = view(ash, loan)
    assert (found['state'], found['they_confirmed_handover']) == ('accepted', True)
    assert shape(ash, pending) == ('closed', 'cancelled', 'you')
    # Ash can still confirm his side.
    ok(handover(ash, loan))
    assert view(misty, loan)['state'] == 'handed_over'


def test_a_handover_racing_an_unfriend_waits_and_then_finds_the_loan_cancelled(store):
    # Misty's unfriend locks Ash's row first and holds it while it writes the Loan row; Ash's handover waits on it.
    iono, ash, misty, binder, loan = accepted_loan(held=2, asked=2, ordered=True)
    before = revision_of(misty)
    body = {'revision': view(ash, loan)['revision'], 'idempotency_key': str(uuid4())}
    drop = _sleeping('loan', 'UPDATE', f"NEW.closed_by = '{misty}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            removed = executor.submit(remove, misty, ash)
            _asleep(watch, 1, [removed])
            handed = executor.submit(call, 'POST', f"/api/loans/{loan['id']}/handover", ash, body)
            removed, handed = removed.result(), handed.result()
    finally:
        drop()
    assert ok(removed)['relation'] == 'none'
    assert code(handed) == (409, 'LOAN_CHANGED')
    assert shape(ash, loan) == ('closed', 'cancelled', 'them')
    assert borrowed(loan) == {} and picks_left(loan) == 0 and revision_of(misty) == before + 1


def test_an_unfriend_and_a_cancel_from_the_other_side_lock_both_owners_in_order_and_never_deadlock(store):
    # Ash, the borrower, cancels one Loan (locking both owners, his row first) while Misty removes him (locking both,
    # the same order): the unfriend waits, then cancels what is left, and each command moves Misty's revision once.
    iono, ash, misty, binder, first = accepted_loan(held=4, asked=2, ordered=True)
    second = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    before = revision_of(misty)
    body = {'revision': view(ash, first)['revision'], 'idempotency_key': str(uuid4())}
    drop = _sleeping('loan', 'UPDATE', f"NEW.closed_by = '{ash}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            cancelled = executor.submit(call, 'POST', f"/api/social/loans/{first['id']}/cancel", ash, body)
            _asleep(watch, 1, [cancelled])
            removed = executor.submit(remove, misty, ash)
            cancelled, removed = cancelled.result(), removed.result()
    finally:
        drop()
    assert cancelled.status_code == 200, cancelled.text
    assert ok(removed)['relation'] == 'none'
    assert shape(misty, first) == ('closed', 'cancelled', 'them')
    assert shape(misty, second) == ('closed', 'cancelled', 'you')
    assert revision_of(misty) == before + 2


def test_edit_and_resend_is_offered_only_while_the_lender_is_still_a_friend(store):
    iono, ash, misty, loans = loans_between()
    declined = sent(ash, misty, [(iono, 1)])
    ok(step(misty, view(misty, declined), 'decline'))
    assert view(ash, declined)['actions'] == ['edit_and_resend']
    # Ash removes Misty: the requests he sent, cancelled or declined, no longer offer it, on the Loan and the Loans tab.
    ok(remove(ash, misty))
    for name in ('requested', 'accepted'):
        assert shape(ash, loans[name]) == ('closed', 'cancelled', 'you') and view(ash, loans[name])['actions'] == []
    assert view(ash, declined)['actions'] == []
    tab = {loan['id']: loan['actions'] for loan in ok(call('GET', '/api/social/loans', ash))['loans']}
    assert tab[declined['id']] == [] and tab[loans['requested']['id']] == []
    # Friends again, it is offered again.
    befriend(ash, misty)
    assert view(ash, declined)['actions'] == ['edit_and_resend']
    assert view(ash, loans['requested'])['actions'] == ['edit_and_resend']
    # Misty's Block hides it, and lifting the Block doesn't bring it back: they aren't Friends.
    block(misty, ash)
    assert view(ash, declined)['actions'] == []
    assert ok(unblock(misty, ash))['relation'] == 'none'
    assert view(ash, declined)['actions'] == []
