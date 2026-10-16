"""Write-off (social network #257): the lender writes off copies that aren't coming back, and the borrower chooses to
keep or remove the ones they hold, through signed HTTP against PostgreSQL.

A Write-off is the lender's alone, once they confirmed the handover, and final: the copies leave the lender's
Collection, the borrower's rows stay, and nobody takes a handover back afterwards. The borrower's keep turns the copies
into owned copies where they sit, with an Undo record and no Deck List change; remove takes them away. A borrower who
confirms the handover after a Write-off receives only the rest. The Loan closes as written off once nothing is out.
"""
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_batch_add import undo, undo_records
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, detail, hold
from test_friend_copies import node, ok, place
from test_handover import _asleep, _sleeping, borrowed, code, handover, lent, take_back, whole_collection
from test_holdings import call
from test_loan_promises import holding
from test_loans import accept, pair, sent, side, view
from test_returns import confirm_return, lent_loan, owner_revision, start_return
from want_list_swap_fixtures import seed_swap_catalog


def write_off(user, loan, lines):
    return call('POST', f"/api/loans/{loan['id']}/write-off", user, {
        'revision': view(user, loan)['revision'], 'idempotency_key': str(uuid4()),
        'lines': [{'edition_id': edition, 'quantity': str(copies)} for edition, copies in lines]})


def choose(user, loan, choice, places=None):
    if places is None:
        places = [{key: entry[key] for key in ('location_id', 'edition_id', 'copies')}
                  for entry in side(user, loan)['awaiting_choice']]
    return call('POST', f"/api/loans/{loan['id']}/written-off", user, {
        'revision': view(user, loan)['revision'], 'idempotency_key': str(uuid4()), 'choice': choice,
        'places': places})


def written_off(view_of):
    return [(line['edition_id'], line['written_off']) for line in view_of['lines']]


def deck_lines(owner, deck_id):
    return {entry['edition_id']: entry['quantity'] for entry in detail(owner, deck_id)['deck_list']['lines']}


def test_a_write_off_leaves_the_lenders_collection_and_the_borrower_keeps_the_copies_where_they_sit(store):
    iono, ash, misty, binders, loan, charizard = lent_loan({'Binder': 3}, 3, 'Charizard')
    unsorted = node(ash, 'Unsorted')['id']
    ok(call('POST', '/api/loans/borrowed/move', ash, {
        'loan_id': loan['id'], 'edition_id': iono, 'from_location_id': charizard, 'to_location_id': unsorted,
        'quantity': '1', 'idempotency_key': str(uuid4())}))
    records, before = undo_records(misty), owner_revision(misty)
    gone = ok(write_off(misty, loan, [(iono, 2)]))
    assert (gone['state'], written_off(gone), gone['actions']) == (
        'handed_over', [(iono, '2')], ['start_return', 'write_off', 'change_return_by'])
    assert (lent(misty)['copies'], whole_collection(misty)) == ('1', ('0', '1'))
    assert undo_records(misty) == records and owner_revision(misty) == before + 1
    # Ash's copies stay as they were until he chooses: the choice needs him.
    assert sum(borrowed(loan).values()) == 3
    asked = view(ash, loan)
    assert (asked['awaiting_choice'], asked['needs_you'], asked['actions']) == (
        '2', True, ['start_return', 'choose_written_off'])
    assert [(entry['location_id'], entry['copies']) for entry in side(ash, loan)['awaiting_choice']] == [
        (unsorted, '1'), (charizard, '1')]
    # Ash still has them: they become his own where they sit, one Undo record per Location, and the Deck List stays.
    ash_records = undo_records(ash)
    kept = ok(choose(ash, loan, 'keep'))
    assert (kept['state'], kept['awaiting_choice'], kept['needs_you'], kept['actions']) == (
        'handed_over', '0', False, ['start_return'])
    assert holding(ash, unsorted, iono)['quantity'] == '1' and holding(ash, charizard, iono)['quantity'] == '1'
    assert borrowed(loan) == {(charizard, iono): 1}
    assert deck_lines(ash, charizard) == {iono: '3'}
    added = [entry for entry in undo_records(ash) if entry not in ash_records]
    assert len(added) == 2 and whole_collection(ash) == ('2', '0')
    # The last copy comes back: the Loan closes as written off.
    ok(start_return(ash, loan, [(iono, 1)]))
    closed = ok(confirm_return(misty, loan))
    assert (closed['state'], closed['closed_reason']) == ('closed', 'written_off')
    assert holding(misty, binders['Binder'], iono)['quantity'] == '1'
    # Keep's Undo is an Add's: it takes the kept copy away again.
    assert ok(undo(ash, added[0]['id']))
    assert whole_collection(ash) == ('1', '0')


def test_a_partial_write_off_across_several_decks_is_kept_where_each_copy_sits(store):
    iono, ash, misty, binders, loan, charizard = lent_loan({'Binder': 4}, 4, 'Charizard')
    gardevoir = deck(ash, 'Gardevoir', 0)
    ok(call('POST', '/api/loans/borrowed/move', ash, {
        'loan_id': loan['id'], 'edition_id': iono, 'from_location_id': charizard, 'to_location_id': gardevoir,
        'quantity': '2', 'idempotency_key': str(uuid4())}))
    ok(write_off(misty, loan, [(iono, 3)]))
    places = {entry['location_id']: int(entry['copies']) for entry in side(ash, loan)['awaiting_choice']}
    # Three of the four, two from one Deck and one from the other: both Decks give some.
    assert set(places) == {charizard, gardevoir} and sorted(places.values()) == [1, 2]
    ok(choose(ash, loan, 'keep'))
    for location, copies in places.items():
        assert holding(ash, location, iono)['quantity'] == str(copies)
    assert sum(borrowed(loan).values()) == 1
    assert deck_lines(ash, charizard) == {iono: '4'} and deck_lines(ash, gardevoir) == {iono: '2'}
    assert view(misty, loan)['lines'][0]['written_off'] == '3'


def test_remove_takes_the_written_off_copies_away_and_the_loan_closes_written_off(store):
    iono, ash, misty, binders, loan, charizard = lent_loan({'Binder': 2}, 2, 'Charizard')
    gone = ok(write_off(misty, loan, [(iono, 2)]))
    assert (gone['state'], gone['actions'], gone['needs_you']) == ('handed_over', ['change_return_by'], False)
    records = undo_records(ash)
    closed = ok(choose(ash, loan, 'remove'))
    assert (closed['state'], closed['closed_reason'], closed['closed_by']) == ('closed', 'written_off', 'you')
    assert borrowed(loan) == {} and undo_records(ash) == records
    assert deck_lines(ash, charizard) == {iono: '2'} and whole_collection(ash) == ('0', '0')
    assert (lent(misty)['copies'], whole_collection(misty)) == ('0', ('0', '0'))


def test_a_borrower_confirming_after_a_write_off_receives_only_the_rest(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, place(misty, 'Binder'), iono, 3)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 3)])), [(iono, 3)]))
    ok(handover(misty, loan))
    ok(write_off(misty, loan, [(iono, 1)]))
    assert code(take_back(misty, loan)) == (409, 'STEP_NOT_ALLOWED')
    confirmed = ok(handover(ash, loan))
    assert (confirmed['state'], confirmed['awaiting_choice']) == ('handed_over', '0')
    assert borrowed(loan) == {(node(ash, 'Unsorted')['id'], iono): 2}


def test_writing_off_everything_before_the_borrower_confirmed_closes_the_loan(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, place(misty, 'Binder'), iono, 2)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)])), [(iono, 2)]))
    ok(handover(misty, loan))
    closed = ok(write_off(misty, loan, [(iono, 2)]))
    assert (closed['state'], closed['closed_reason']) == ('closed', 'written_off')
    assert view(ash, loan)['actions'] == [] and borrowed(loan) == {}


def test_a_write_off_is_the_lenders_alone_once_handed_over_and_never_beyond_what_is_out(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, place(misty, 'Binder'), iono, 3)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 3)])), [(iono, 3)]))
    assert code(write_off(misty, loan, [(iono, 1)])) == (409, 'STEP_NOT_ALLOWED')
    ok(handover(misty, loan))
    ok(handover(ash, loan))
    assert code(write_off(ash, loan, [(iono, 1)])) == (409, 'STEP_NOT_ALLOWED')
    assert code(write_off(misty, loan, [(iono, 4)])) == (409, 'MORE_THAN_OUT')
    assert code(write_off(misty, loan, [(iono, 0)])) == (422, 'NOTHING_WRITTEN_OFF')
    assert code(write_off(misty, loan, [(str(uuid4()), 1)])) == (422, 'NOT_ON_LOAN')
    # Two copies Ash says he gave back are coming back: only the third can be written off.
    ok(start_return(ash, loan, [(iono, 2)]))
    refused = write_off(misty, loan, [(iono, 2)])
    assert refused.status_code == 409 and refused.json()['detail'] == {
        'code': 'MORE_THAN_OUT', 'edition_id': iono, 'out': '1'}
    ok(write_off(misty, loan, [(iono, 1)]))
    # Ash's choice names exactly the copies awaiting it.
    unsorted = node(ash, 'Unsorted')['id']
    assert code(choose(ash, loan, 'remove', [{'location_id': unsorted, 'edition_id': iono, 'copies': '2'}])) == (
        409, 'CHOICE_CHANGED')
    assert code(choose(misty, loan, 'remove', [{'location_id': unsorted, 'edition_id': iono, 'copies': '1'}])) == (
        409, 'STEP_NOT_ALLOWED')
    ok(choose(ash, loan, 'remove'))
    closed = ok(confirm_return(misty, loan))
    assert (closed['state'], closed['closed_reason']) == ('closed', 'written_off')
    assert holding(misty, node(misty, 'Binder')['id'], iono)['quantity'] == '2'


def test_a_write_off_racing_the_borrowers_deck_deletion_never_deadlocks(store):
    # The Write-off locks only the lender and writes the Loan row once; Ash's Deck deletion holds his owner row and
    # sets the Loan's Deck to NULL. A second write of the Loan row would key-share that Deck and close a cycle.
    iono, ash, misty, binders, loan, charizard = lent_loan({'Binder': 2}, 2, 'Charizard')
    body = {'revision': view(misty, loan)['revision'], 'idempotency_key': str(uuid4()),
            'lines': [{'edition_id': iono, 'quantity': '1'}]}
    found = node(ash, charizard)
    drop = _sleeping('loan_line', 'UPDATE', 'NEW.written_off > 0')
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            written = executor.submit(call, 'POST', f"/api/loans/{loan['id']}/write-off", misty, body)
            _asleep(watch, 1, [written])
            deleted = executor.submit(call, 'DELETE', f'/api/decks/{charizard}', ash,
                                      {'name': found['name'], 'version': found['version'],
                                       'idempotency_key': str(uuid4())})
            written, deleted = written.result(), deleted.result()
    finally:
        drop()
    assert written.status_code == 200, written.text
    assert deleted.status_code == 200, deleted.text
    assert borrowed(loan) == {(node(ash, 'Unsorted')['id'], iono): 2}
    assert view(ash, loan)['awaiting_choice'] == '1'
