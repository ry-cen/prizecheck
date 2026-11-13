"""Sequential round postconditions and exact participant inventory revision deltas.

L2 is scoped to open Loans: returned/written-off closures retain handover timestamps.
No retries, failure rollback or races belong in this lifecycle table.
"""
from uuid import uuid4

import psycopg
import pytest

from app.main import connect
from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import store  # noqa: F401
from test_deck_counting import hold
from test_friend_copies import ok, place
from test_handover import handover, take_back
from test_lend_offers import offer, take
from test_loans import accept, pair, sent, step, view
from test_return_by import answer, ask, change, day
from test_returns import confirm_return, start_return
from test_trade_swap import confirm
from test_trades import accept_trade, counter, proposed, read, trade_step, trading
from test_write_off import choose, write_off
from want_list_swap_fixtures import seed_swap_catalog


def loan_postcondition(round_id, state, stamps, reason=None):
    with connect() as conn:
        row = conn.execute('SELECT * FROM loan WHERE id=%s', (round_id,)).fetchone()
        written = conn.execute('SELECT coalesce(sum(written_off),0) AS n FROM loan_line WHERE loan_id=%s',
                               (round_id,)).fetchone()['n']
    actual = (row['lender_handover_at'] is not None, row['borrower_handover_at'] is not None)
    assert (row['state'], actual, row['closed_reason']) == (state, stamps, reason)
    assert (row['closed_at'] is not None) == (state == 'closed')
    if state != 'closed':
        assert (state == 'handed_over') == all(actual)
        if state in ('requested', 'offered'):
            assert actual == (False, False)
    elif reason in ('returned', 'written_off'):
        assert actual[0] or row['lender_id'] is None  # L8
        assert (reason == 'written_off') == (written > 0)  # L9, at settlement


def trade_postcondition(round_id, state, stamps, reason=None):
    with connect() as conn:
        row = conn.execute('SELECT * FROM trade WHERE id=%s', (round_id,)).fetchone()
    actual = (row['proposer_swap_at'] is not None, row['recipient_swap_at'] is not None)
    assert (row['state'], actual, row['closed_reason']) == (state, stamps, reason)
    assert (row['closed_at'] is not None) == (state == 'closed')
    assert (row['closed_reason'] == 'swapped') == all(actual)  # T3/T5, both participants exist here
    if state == 'proposed' or (state == 'closed' and reason != 'swapped'):
        assert actual == (False, False)
    if state == 'accepted':
        assert not all(actual)


class Lifecycle:
    """One command, two owner snapshots, one round postcondition. Owners have fixed table order."""
    def __init__(self, kind, owners):
        self.kind, self.owners = kind, owners

    def revisions(self):
        with connect() as conn:
            found = {row['user_id']: row['revision'] for row in conn.execute(
                'SELECT user_id,revision FROM inventory_owner WHERE user_id=ANY(%s)', (list(self.owners),))}
        return tuple(found[owner] for owner in self.owners)

    def run(self, label, command, deltas, state, stamps=(False, False), reason=None):
        before = self.revisions()
        result = command()
        result = result if isinstance(result, dict) else ok(result)
        assert tuple(after - prior for after, prior in zip(self.revisions(), before)) == deltas, label
        check = loan_postcondition if self.kind == 'loan' else trade_postcondition
        check(result['id'], state, stamps, reason)
        return result


def loan_collectors():
    edition = seed_swap_catalog()['PAL 185']
    borrower, lender = pair()
    binder = place(lender, 'Binder')
    hold(lender, binder, edition, 3)
    return edition, borrower, lender, binder, Lifecycle('loan', (lender, borrower))


def begin_loan(h, kind, edition, borrower, lender, binder):
    if kind == 'request':
        return h.run('send request', lambda: sent(borrower, lender, [(edition, 2)]), (0, 0), 'requested')
    return h.run('send offer', lambda: ok(offer(lender, borrower, [(binder, edition, 2)]), 201),
                 (1, 0), 'offered')


@pytest.mark.parametrize('kind', ['request', 'offer'])
@pytest.mark.parametrize('ending', ['decline', 'withdraw', 'cancel_lender', 'cancel_borrower'])
def test_loan_answers_and_cancellation_revision_table(store, kind, ending):
    edition, borrower, lender, binder, h = loan_collectors()
    loan = begin_loan(h, kind, edition, borrower, lender, binder)
    if ending.startswith('cancel'):
        if kind == 'request':
            loan = h.run('accept request', lambda: accept(lender, view(lender, loan), [(edition, 2)]),
                         (1, 0), 'accepted')
        else:
            # Taking the whole offer releases nothing and does NOT advance the lender revision.
            loan = h.run('accept whole offer', lambda: take(borrower, loan, [(edition, 2)]), (0, 0), 'accepted')
        actor = lender if ending == 'cancel_lender' else borrower
        action, reason, deltas = 'cancel', 'cancelled', (1, 0)
    else:
        action = ending
        actor = (lender if kind == 'request' else borrower) if ending == 'decline' else (
            borrower if kind == 'request' else lender)
        reason, deltas = ('declined' if ending == 'decline' else 'withdrawn'), ((1, 0) if kind == 'offer' else (0, 0))
    h.run(ending, lambda: step(actor, view(actor, loan), action), deltas, 'closed', reason=reason)


@pytest.mark.parametrize('taken, delta', [(1, (1, 0)), (2, (0, 0))])
def test_offer_accept_revision_depends_on_released_copies(store, taken, delta):
    edition, borrower, lender, binder, h = loan_collectors()
    loan = begin_loan(h, 'offer', edition, borrower, lender, binder)
    accepted = h.run('accept offer', lambda: take(borrower, loan, [(edition, taken)]), delta, 'accepted')
    assert accepted['lines'][0]['promised'] == str(taken)


@pytest.mark.parametrize('first_role', ['lender', 'borrower'])
def test_loan_terms_handover_takeback_and_return_revision_table(store, first_role):
    edition, borrower, lender, binder, h = loan_collectors()
    loan = begin_loan(h, 'request', edition, borrower, lender, binder)
    loan = h.run('accept', lambda: accept(lender, view(lender, loan), [(edition, 2)]), (1, 0), 'accepted')
    # Term changes touch only the round, including clearing and setting the return-by date.
    for label, command, expected_by, extension in [
        ('set date', lambda: change(lender, loan, day(10)), day(10), None),
        ('clear date', lambda: change(lender, loan, None), None, None),
        ('set date again', lambda: change(lender, loan, day(10)), day(10), None),
        ('ask extension', lambda: ask(borrower, loan, day(20)), day(10), day(20)),
        ('decline extension', lambda: answer(lender, loan, 'decline'), day(10), None),
        ('ask again', lambda: ask(borrower, loan, day(30)), day(10), day(30)),
        ('approve extension', lambda: answer(lender, loan, 'approve'), day(30), None),
    ]:
        changed = h.run(label, command, (0, 0), 'accepted')
        assert (changed['return_by'], changed['extension_to']) == (expected_by, extension)
    first, second = (lender, borrower) if first_role == 'lender' else (borrower, lender)
    first_delta = (1, 0) if first_role == 'lender' else (0, 1)
    second_delta = (0, 1) if first_role == 'lender' else (1, 0)
    stamps = (first_role == 'lender', first_role == 'borrower')
    for label, command, delta, state, times in [
        ('first handover', lambda: handover(first, loan), first_delta, 'accepted', stamps),
        ('take back', lambda: take_back(first, loan), first_delta, 'accepted', (False, False)),
        ('handover again', lambda: handover(first, loan), first_delta, 'accepted', stamps),
        ('second handover', lambda: handover(second, loan), second_delta, 'handed_over', (True, True)),
        ('partial return', lambda: start_return(first, loan, [(edition, 1)]), first_delta, 'handed_over', (True, True)),
        ('confirm partial return', lambda: confirm_return(second, loan), second_delta, 'handed_over', (True, True)),
        ('return rest', lambda: start_return(second, loan, [(edition, 1)]), second_delta, 'handed_over', (True, True)),
    ]:
        h.run(label, command, delta, state, times)
    h.run('confirm final return', lambda: confirm_return(first, loan), first_delta,
          'closed', (True, True), 'returned')


@pytest.mark.parametrize('settlement', ['before_receive', 'choose_keep', 'choose_remove', 'mixed_return'])
def test_writeoff_settlement_revision_table(store, settlement):
    edition, borrower, lender, binder, h = loan_collectors()
    loan = begin_loan(h, 'request', edition, borrower, lender, binder)
    loan = h.run('accept', lambda: accept(lender, view(lender, loan), [(edition, 2)]), (1, 0), 'accepted')
    h.run('lender handover', lambda: handover(lender, loan), (1, 0), 'accepted', (True, False))
    if settlement == 'before_receive':
        h.run('write off before receive', lambda: write_off(lender, loan, [(edition, 2)]),
              (1, 0), 'closed', (True, False), 'written_off')
        return
    h.run('borrower receive', lambda: handover(borrower, loan), (0, 1), 'handed_over', (True, True))
    copies = 1 if settlement == 'mixed_return' else 2
    h.run('write off', lambda: write_off(lender, loan, [(edition, copies)]), (1, 0), 'handed_over', (True, True))
    choice = 'remove' if settlement == 'choose_remove' else 'keep'
    h.run('choose written off', lambda: choose(borrower, loan, choice), (0, 1),
          'handed_over' if settlement == 'mixed_return' else 'closed', (True, True),
          None if settlement == 'mixed_return' else 'written_off')
    if settlement == 'mixed_return':
        h.run('return remainder', lambda: start_return(borrower, loan, [(edition, 1)]),
              (0, 1), 'handed_over', (True, True))
        h.run('confirm remainder', lambda: confirm_return(lender, loan), (1, 0),
              'closed', (True, True), 'written_off')


@pytest.mark.parametrize('shape', ['swap', 'give', 'get'])
@pytest.mark.parametrize('ending', ['decline', 'withdraw', 'cancel_proposer', 'cancel_recipient', 'swap_proposer_first', 'swap_recipient_first'])
def test_trade_lifecycle_revision_table(store, shape, ending):
    ids, recipient, proposer, _, _ = trading()
    h = Lifecycle('trade', (proposer, recipient))
    give = [(ids['PAL 185'], 1)] if shape != 'get' else []
    get = [(ids['SVI 166'], 1)] if shape != 'give' else []
    pd, rd = int(bool(give)), int(bool(get))
    trade = h.run('send', lambda: proposed(proposer, recipient, give, get), (pd, 0), 'proposed')
    if ending in ('decline', 'withdraw'):
        actor = recipient if ending == 'decline' else proposer
        h.run(ending, lambda: trade_step(actor, trade, ending), (pd, 0), 'closed',
              reason='declined' if ending == 'decline' else 'withdrawn')
        return
    trade = h.run('accept', lambda: accept_trade(recipient, trade), (0, rd), 'accepted')
    if ending.startswith('cancel'):
        actor = proposer if ending == 'cancel_proposer' else recipient
        h.run(ending, lambda: trade_step(actor, trade, 'cancel'), (pd, rd), 'closed', reason='cancelled')
        return
    first, second = (proposer, recipient) if ending == 'swap_proposer_first' else (recipient, proposer)
    stamps = (first == proposer, first == recipient)
    # Even a side giving no cards receives cards, so both confirmations advance their own owner revision.
    h.run('first swap', lambda: confirm(first, trade), (1, 0) if first == proposer else (0, 1), 'accepted', stamps)
    h.run('second swap', lambda: confirm(second, trade), (1, 0) if second == proposer else (0, 1),
          'closed', (True, True), 'swapped')


@pytest.mark.parametrize('accepted', [False, True], ids=['proposed', 'accepted'])
@pytest.mark.parametrize('actor_role', ['proposer', 'recipient'])
def test_change_offer_closes_old_round_and_reserves_new_round_once(store, accepted, actor_role):
    ids, recipient, proposer, _, _ = trading()
    h = Lifecycle('trade', (proposer, recipient))
    give, get = [(ids['PAL 185'], 1)], [(ids['SVI 166'], 1)]
    old = h.run('send', lambda: proposed(proposer, recipient, give, get), (1, 0), 'proposed')
    if accepted:
        old = h.run('accept', lambda: accept_trade(recipient, old), (0, 1), 'accepted')
    actor = proposer if actor_role == 'proposer' else recipient
    new_give, new_get = (give, get) if actor_role == 'proposer' else (get, give)
    # Old reserved sides plus the new proposer form a set: nobody advances twice for release + reserve.
    deltas = (1, 1) if accepted or actor_role == 'recipient' else (1, 0)
    new = h.run('change offer', lambda: counter(actor, ok(read(actor, old)), new_give, new_get),
                deltas, 'proposed')
    assert new['id'] != old['id'] and new['thread_id'] == old['thread_id']
    trade_postcondition(old['id'], 'closed', (False, False), 'countered')


def test_current_schema_refuses_a_second_live_loan_in_the_same_thread(store):
    edition, borrower, lender, binder, h = loan_collectors()
    loan = begin_loan(h, 'request', edition, borrower, lender, binder)
    with connect() as conn:
        with pytest.raises(psycopg.errors.UniqueViolation) as failure, conn.transaction():
            conn.execute("""INSERT INTO loan(id,kind,state,lender_id,borrower_id,lender_name,borrower_name,thread_id)
                SELECT %s,kind,state,lender_id,borrower_id,lender_name,borrower_name,thread_id
                FROM loan WHERE id=%s""", (uuid4(), loan['id']))
        assert failure.value.diag.constraint_name == 'loan_one_live'
        assert conn.execute("SELECT count(*) AS n FROM loan WHERE thread_id=%s AND state<>'closed'",
                            (loan['thread_id'],)).fetchone()['n'] == 1
