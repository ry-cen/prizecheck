"""Characterize Loan predicates and return identity without changing the state model."""
from datetime import date
from uuid import uuid4

import pytest

from app.social import loans
from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import launches, store  # noqa: F401
from test_friend_copies import ok
from test_handover import borrowed, code
from test_holdings import call
from test_loan_promises import holding
from test_loans import view
from test_returns import lent_loan, owner_revision, start_return


def loan_row(state, stamps=(None, None), **changes):
    return {'state': state, 'kind': 'borrow_request', 'lender_id': 'lender', 'borrower_id': 'borrower',
            'lender_handover_at': stamps[0], 'borrower_handover_at': stamps[1],
            'return_by': None, 'extension_to': None, **changes}


# Expected lists are deliberately literal, including their screen order. Timestamps are lender first.
@pytest.mark.parametrize('state, role, stamps, actions, waiting, section', [
    ('requested', 'lender', (None, None), ['accept', 'decline'], 'answer', 'needs_you'),
    ('requested', 'borrower', (None, None), ['withdraw', 'edit_and_resend'], None, 'pending'),
    ('offered', 'lender', (None, None), ['withdraw'], None, 'pending'),
    ('offered', 'borrower', (None, None), ['accept', 'decline'], 'answer', 'needs_you'),
    ('accepted', 'lender', (None, None), ['confirm_handover', 'cancel', 'change_return_by'], None, 'pending'),
    ('accepted', 'borrower', (None, None), ['confirm_handover', 'cancel'], None, 'pending'),
    ('accepted', 'lender', ('now', None), ['take_back'], None, 'out_now'),
    ('accepted', 'borrower', ('now', None), ['confirm_handover'], 'confirm_handover', 'needs_you'),
    ('accepted', 'lender', (None, 'now'), ['confirm_handover'], 'hand_over', 'needs_you'),
    ('accepted', 'borrower', (None, 'now'), ['take_back'], None, 'out_now'),
    ('handed_over', 'lender', ('now', 'now'), [], None, 'out_now'),
    ('handed_over', 'borrower', ('now', 'now'), [], None, 'out_now'),
    ('closed', 'lender', (None, None), [], None, 'history'),
    ('closed', 'borrower', (None, None), [], None, 'history'),
    ('closed', 'lender', ('now', 'now'), [], None, 'history'),
    ('closed', 'borrower', ('now', 'now'), [], None, 'history'),
])
@pytest.mark.parametrize('facts', [None, loans.LoanFacts()], ids=['no-facts', 'empty-facts'])
def test_predicates_follow_state_handover_and_role(state, role, stamps, actions, waiting, section, facts):
    row = loan_row(state, stamps)
    assert loans.allowed(role, row, facts=facts) == actions
    assert loans.waiting_step(role, row, facts) == waiting
    assert loans.section(role, row, facts) == section



@pytest.mark.parametrize('role, expected', [
    ('lender', ['start_return', 'write_off']),
    ('borrower', ['start_return', 'choose_written_off']),
])
def test_omitting_facts_does_not_infer_inventory_actions(role, expected):
    row = loan_row('handed_over', ('now', 'now'))
    facts = loans.LoanFacts(out={role: 2}, write_off_cap=2, awaiting=1 if role == 'borrower' else 0)
    assert loans.allowed(role, row, facts=facts) == expected
    assert loans.allowed(role, row, facts=None) == []
    assert loans.waiting_step(role, row, None) is None
    assert loans.section(role, row, None) == 'out_now'


def pending(starter, lender=False, borrower=False):
    return {'started_by': starter, 'lender_confirmed': lender, 'borrower_confirmed': borrower}


@pytest.mark.parametrize('state, role, stamps, facts, actions, waiting, section', [
    ('accepted', 'lender', (None, None), loans.LoanFacts(stale_picks=True),
     ['confirm_handover', 'cancel', 'change_return_by'], 'fix_picks', 'needs_you'),
    ('accepted', 'borrower', (None, None), loans.LoanFacts(stale_picks=True),
     ['confirm_handover', 'cancel'], None, 'pending'),
    ('accepted', 'lender', ('now', None), loans.LoanFacts(any_return=True), [], None, 'out_now'),
    ('accepted', 'lender', ('now', None), loans.LoanFacts(written_off=True), [], None, 'out_now'),
    ('accepted', 'borrower', (None, 'now'), loans.LoanFacts(any_return=True), [], None, 'out_now'),
    ('handed_over', 'lender', ('now', 'now'), loans.LoanFacts(out={'lender': 2}, write_off_cap=2),
     ['start_return', 'write_off'], None, 'out_now'),
    ('handed_over', 'borrower', ('now', 'now'), loans.LoanFacts(out={'borrower': 2}),
     ['start_return'], None, 'out_now'),
    ('handed_over', 'borrower', ('now', 'now'), loans.LoanFacts(awaiting=2),
     ['choose_written_off'], 'choose_written_off', 'needs_you'),
    ('handed_over', 'lender', ('now', 'now'), loans.LoanFacts(pending=pending('borrower', borrower=True)),
     ['confirm_return'], 'confirm_return', 'needs_you'),
    ('handed_over', 'borrower', ('now', 'now'), loans.LoanFacts(pending=pending('lender', lender=True)),
     ['confirm_return'], 'confirm_return', 'needs_you'),
    ('handed_over', 'borrower', ('now', 'now'), loans.LoanFacts(pending=pending('borrower', borrower=True)),
     [], None, 'out_now'),
    ('handed_over', 'lender', ('now', 'now'), loans.LoanFacts(pending=pending('lender', lender=True)),
     [], None, 'out_now'),
    ('handed_over', 'lender', ('now', 'now'), loans.LoanFacts(other_exists=False, pending=pending('lender', lender=True)),
     ['confirm_return'], 'confirm_return', 'needs_you'),
    ('accepted', 'borrower', (None, 'now'), loans.LoanFacts(other_exists=False, out={'borrower': 2}),
     ['start_return', 'take_back'], 'confirm_return', 'needs_you'),
    ('accepted', 'lender', ('now', None), loans.LoanFacts(other_exists=False, out={'lender': 2}, write_off_cap=2),
     ['start_return', 'take_back', 'write_off'], 'confirm_return', 'needs_you'),
    # A closed Loan offers no choice even if written-off copies still await one.
    ('closed', 'borrower', ('now', 'now'), loans.LoanFacts(awaiting=2), [], None, 'history'),
    # The written-off choice precedes a pending return.
    ('handed_over', 'borrower', ('now', 'now'),
     loans.LoanFacts(awaiting=1, pending=pending('lender', lender=True)),
     ['confirm_return', 'choose_written_off'], 'choose_written_off', 'needs_you'),
])
def test_facts_add_actions_and_choose_the_first_waiting_step(state, role, stamps, facts, actions, waiting, section):
    row = loan_row(state, stamps)
    assert loans.allowed(role, row, facts.other_exists, facts.written_off, facts) == actions
    assert loans.waiting_step(role, row, facts) == waiting
    assert loans.section(role, row, facts) == section


@pytest.mark.parametrize('role, stamps, changes, actions, waiting', [
    ('lender', (None, None), {}, ['confirm_handover', 'cancel', 'change_return_by'], None),
    ('borrower', (None, None), {}, ['confirm_handover', 'cancel', 'ask_for_more_time'], None),
    ('lender', ('now', None), {}, ['take_back', 'change_return_by'], None),
    ('borrower', ('now', 'now'), {}, ['ask_for_more_time'], None),
    ('lender', ('now', 'now'), {'extension_to': date(2030, 2, 1)},
     ['change_return_by', 'approve_extension', 'decline_extension'], 'answer_more_time'),
    ('borrower', ('now', 'now'), {'extension_to': date(2030, 2, 1)}, [], None),
])
def test_return_date_actions_without_facts(role, stamps, changes, actions, waiting):
    state = 'handed_over' if stamps == ('now', 'now') else 'accepted'
    row = loan_row(state, stamps, return_by=date(2030, 1, 1), **changes)
    assert loans.allowed(role, row, facts=None) == actions
    assert loans.waiting_step(role, row, None) == waiting
    assert loans.section(role, row, None) == ('needs_you' if waiting else 'out_now' if any(stamps) else 'pending')


@pytest.mark.parametrize('other_exists, friends', [(False, True), (True, False), (False, False)])
def test_edit_and_resend_needs_a_living_friend(other_exists, friends):
    assert loans.allowed('borrower', loan_row('requested'), other_exists, friends=friends) == ['withdraw']


@pytest.mark.parametrize('starter_role', ['lender', 'borrower'])
def test_confirm_return_ignores_stale_revision_but_requires_the_current_return_id(store, starter_role):
    edition, borrower, lender, binders, loan, _ = lent_loan({'Binder': 3}, 3)
    starter, confirmer = (lender, borrower) if starter_role == 'lender' else (borrower, lender)
    stale_revision = view(confirmer, loan)['revision']
    first = ok(start_return(starter, loan, [(edition, 1)]))
    first_id = first['pending_return']['return_id']

    def confirm(return_id):
        return call('POST', f"/api/loans/{loan['thread_id']}/returns/confirm", confirmer, {
            'loan_id': loan['loan_id'], 'return_id': return_id, 'revision': stale_revision,
            'idempotency_key': str(uuid4())})

    assert first['revision'] > stale_revision
    completed = ok(confirm(first_id))
    assert completed['pending_return'] is None
    assert completed['revision'] == first['revision'] + 1
    assert completed['lines'][0]['returned'] == '1'
    assert holding(lender, binders['Binder'], edition)['quantity'] == '1'
    assert sum(borrowed(loan).values()) == 2

    second = ok(start_return(starter, loan, [(edition, 1)]))
    second_id = second['pending_return']['return_id']
    assert second_id != first_id
    before = (view(confirmer, loan), owner_revision(lender), owner_revision(borrower),
              holding(lender, binders['Binder'], edition), borrowed(loan))
    # Fresh command keys ensure these exercise return identity, rather than receipt replay.
    for invalid in (first_id, str(uuid4())):
        assert code(confirm(invalid)) == (409, 'RETURN_CHANGED')
        assert (view(confirmer, loan), owner_revision(lender), owner_revision(borrower),
                holding(lender, binders['Binder'], edition), borrowed(loan)) == before
    completed = ok(confirm(second_id))
    assert completed['pending_return'] is None
    assert completed['revision'] == second['revision'] + 1
    assert completed['lines'][0]['returned'] == '2'
    assert holding(lender, binders['Binder'], edition)['quantity'] == '2'
    assert sum(borrowed(loan).values()) == 1
