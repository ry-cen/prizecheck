"""Returns (social network #255): either side starts a return of some or all of the copies out, and each side confirms
it for its own inventory, through signed HTTP against PostgreSQL.

The lender's confirmation puts the copies back where their picks took them from, or in Unsorted when that Location is
gone, with no Undo record; the borrower's takes the Borrowed Copies away, loose Locations first, and leaves the Deck's
lines. A return only one side confirmed is complete only when the other side's account no longer exists. The Loan
shows how many copies came back, and closes as returned once nothing is out and nothing was written off.
"""
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import psycopg

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.social import counts
from test_batch_add import undo_records
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, detail, hold, line
from test_friend_copies import node, ok, place
from test_handover import _asleep, _sleeping, borrowed, code, handover, lent, take_back, tree_lent
from test_holdings import call
from test_loan_promises import holding
from test_loans import accept, pair, sent, view
from want_list_swap_fixtures import seed_swap_catalog


def start_return(user, loan, lines, key=None):
    return call('POST', f"/api/loans/{loan['id']}/returns", user, {
        'revision': view(user, loan)['revision'], 'idempotency_key': str(key or uuid4()),
        'lines': [{'edition_id': edition, 'quantity': str(copies)} for edition, copies in lines]})


def confirm_return(user, loan):
    return call('POST', f"/api/loans/{loan['id']}/returns/confirm", user,
                {'revision': view(user, loan)['revision'], 'idempotency_key': str(uuid4())})


def owner_revision(owner):
    return ok(call('GET', '/api/location-tree', owner))['owner_revision']


def returned(view_of):
    return [(line['edition_id'], line['returned']) for line in view_of['lines']]


def lent_loan(sources, asked, deck_name=None, ordered=False):
    """Misty W. holds Iono PAL 185 in Binders (``sources``: name -> copies), lends Ash K. ``asked`` of them (into a new
    Deck of his named ``deck_name``, else Unsorted) and both confirm the handover. ``ordered``: as ``pair``'s."""
    ids = seed_swap_catalog()
    ash, misty = pair(ordered)
    iono = ids['PAL 185']
    binders = {name: place(misty, name) for name in sources}
    for name, copies in sources.items():
        hold(misty, binders[name], iono, copies)
    extra = {'deck_id': deck(ash, deck_name, 0)} if deck_name else {}
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, asked)], **extra)), [(iono, asked)]))
    ok(handover(misty, loan))
    ok(handover(ash, loan))
    return iono, ash, misty, binders, loan, extra.get('deck_id')


def leave(owner):
    """The collector deletes their account, as the spec's account deletion will: their owner row goes, its own rows
    with it, and their side of each Loan is set to NULL."""
    with connect() as conn:
        conn.execute('DELETE FROM inventory_owner WHERE user_id=%s', (owner,))


def test_a_partial_return_moves_each_sides_inventory_as_it_confirms_and_the_last_closes_the_loan(store):
    iono, ash, misty, binders, loan, charizard = lent_loan({'Binder': 3}, 3, 'Charizard')
    binder = binders['Binder']
    handed = view(misty, loan)
    assert (handed['state'], handed['actions'], handed['pending_return']) == (
        'handed_over', ['start_return', 'write_off'], None)
    assert view(ash, loan)['actions'] == ['start_return']
    records = undo_records(misty)
    # Ash gives one back: his own Borrowed Copies leave at once; Misty's Collection waits for her.
    ash_before = owner_revision(ash)
    given = ok(start_return(ash, loan, [(iono, 1)]))
    assert given['pending_return'] == {'started_by': 'you', 'lines': [{'edition_id': iono, 'copies': '1'}],
                                       'you_confirmed': True, 'they_confirmed': False}
    assert (given['actions'], given['needs_you'], returned(given)) == ([], False, [(iono, '0')])
    assert borrowed(loan) == {(charizard, iono): 2}
    assert owner_revision(ash) == ash_before + 1
    assert ok(call('GET', f'/api/holdings/{binder}', misty))['holdings'] == []
    asked = view(misty, loan)
    assert (asked['actions'], asked['needs_you'], asked['section']) == (
        ['confirm_return', 'write_off'], True, 'needs_you')
    assert asked['pending_return']['started_by'] == 'them'
    # Misty confirms: the copy is back in Binder, with no Undo record; the Loan shows it and stays out.
    misty_before = owner_revision(misty)
    back = ok(confirm_return(misty, loan))
    assert (back['state'], back['pending_return'], returned(back)) == ('handed_over', None, [(iono, '1')])
    assert holding(misty, binder, iono)['quantity'] == '1'
    assert owner_revision(misty) == misty_before + 1 and undo_records(misty) == records
    assert (lent(misty)['copies'], tree_lent(misty)) == ('2', '2')
    with connect() as conn:
        assert counts.lent_counts(conn, misty, None) == {UUID(iono): 2}
    # Misty records the rest: back in Binder now; Ash's copies stay until he says he gave them back.
    recorded = ok(start_return(misty, loan, [(iono, 2)]))
    assert recorded['pending_return']['started_by'] == 'you' and holding(misty, binder, iono)['quantity'] == '3'
    assert view(ash, loan)['actions'] == ['confirm_return'] and borrowed(loan) == {(charizard, iono): 2}
    closed = ok(confirm_return(ash, loan))
    assert (closed['state'], closed['closed_reason'], closed['closed_by'], closed['section']) == (
        'closed', 'returned', 'you', 'history')
    assert returned(closed) == [(iono, '3')] and closed['actions'] == []
    assert borrowed(loan) == {}
    assert view(misty, loan)['closed_by'] == 'them'
    assert (lent(misty)['copies'], tree_lent(misty)) == ('0', '0')
    # The Deck's line stays after the return: the Deck now misses the card.
    assert {entry['edition_id']: entry['quantity'] for entry in detail(ash, charizard)['deck_list']['lines']} == {
        iono: '3'}
    assert detail(ash, charizard)['to_get'] == '3'


def test_returned_copies_go_back_to_their_source_or_to_unsorted_when_it_is_gone(store):
    iono, ash, misty, binders, loan, _ = lent_loan({'Binder A': 1, 'Binder B': 2}, 3)
    found = node(misty, 'Binder A')
    ok(call('DELETE', f"/api/location-tree/{binders['Binder A']}", misty,
            {'version': found['version'], 'name': found['name'], 'idempotency_key': str(uuid4())}))
    ok(start_return(misty, loan, [(iono, 3)]))
    unsorted = node(misty, 'Unsorted')['id']
    assert holding(misty, binders['Binder B'], iono)['quantity'] == '2'
    assert holding(misty, unsorted, iono)['quantity'] == '1'
    ok(confirm_return(ash, loan))
    assert view(misty, loan)['closed_reason'] == 'returned'


def test_the_borrower_gives_back_loose_copies_first_and_a_deck_keeps_its_own(store):
    iono, ash, misty, binders, loan, charizard = lent_loan({'Binder': 3}, 3, 'Charizard')
    unsorted = node(ash, 'Unsorted')['id']
    ok(call('POST', '/api/loans/borrowed/move', ash, {
        'loan_id': loan['id'], 'edition_id': iono, 'from_location_id': charizard, 'to_location_id': unsorted,
        'quantity': '1', 'idempotency_key': str(uuid4())}))
    ok(start_return(ash, loan, [(iono, 2)]))
    assert borrowed(loan) == {(charizard, iono): 1}


def test_a_one_sided_return_completes_only_once_the_other_account_is_gone(store):
    iono, ash, misty, binders, loan, _ = lent_loan({'Binder': 3}, 3)
    pending = ok(start_return(ash, loan, [(iono, 1)]))
    assert pending['state'] == 'handed_over' and pending['pending_return']['they_confirmed'] is False
    ok(confirm_return(misty, loan))
    # Misty leaves: Ash's return of the rest needs only him, and closes the Loan.
    leave(misty)
    alone = view(ash, loan)
    assert (alone['actions'], alone['needs_you'], alone['other']['collector_id']) == (['start_return'], True, None)
    closed = ok(start_return(ash, loan, [(iono, 2)]))
    assert (closed['state'], closed['closed_reason'], closed['pending_return']) == ('closed', 'returned', None)
    assert borrowed(loan) == {}
    # The other way: Ash leaves, and Misty records her copies back on her own.
    iono, ash, misty, binders, loan, _ = lent_loan({'Binder': 2}, 2)
    leave(ash)
    closed = ok(start_return(misty, loan, [(iono, 2)]))
    assert (closed['state'], closed['closed_reason']) == ('closed', 'returned')
    assert holding(misty, binders['Binder'], iono)['quantity'] == '2'


def test_a_return_its_starter_began_before_the_other_side_left_is_finished_by_the_starter(store):
    # Ash gives 1 back and Misty leaves before confirming: the return waits on Ash, who finishes it alone (his copy
    # already went back when he started it), then returns the rest, and the Loan closes as returned.
    iono, ash, misty, binders, loan, _ = lent_loan({'Binder': 3}, 3)
    ok(start_return(ash, loan, [(iono, 1)]))
    leave(misty)
    alone = view(ash, loan)
    assert (alone['actions'], alone['needs_you'], alone['section']) == (['confirm_return'], True, 'needs_you')
    finished = ok(confirm_return(ash, loan))
    assert (finished['state'], finished['pending_return'], finished['actions']) == ('handed_over', None, ['start_return'])
    assert returned(finished) == [(iono, '1')] and borrowed(loan) == {(node(ash, 'Unsorted')['id'], iono): 2}
    closed = ok(start_return(ash, loan, [(iono, 2)]))
    assert (closed['state'], closed['closed_reason']) == ('closed', 'returned') and borrowed(loan) == {}
    # The other way: Misty records 1 back and Ash leaves; Misty finishes it alone, writes off the rest, and the Loan
    # closes as written off.
    iono, ash, misty, binders, loan, _ = lent_loan({'Binder': 3}, 3)
    ok(start_return(misty, loan, [(iono, 1)]))
    assert holding(misty, binders['Binder'], iono)['quantity'] == '1'
    leave(ash)
    alone = view(misty, loan)
    assert 'confirm_return' in alone['actions'] and alone['needs_you'] is True
    ok(confirm_return(misty, loan))
    assert holding(misty, binders['Binder'], iono)['quantity'] == '1'
    closed = ok(call('POST', f"/api/loans/{loan['id']}/write-off", misty, {
        'revision': view(misty, loan)['revision'], 'idempotency_key': str(uuid4()),
        'lines': [{'edition_id': iono, 'quantity': '2'}]}))
    assert (closed['state'], closed['closed_reason']) == ('closed', 'written_off')


def test_a_return_is_refused_beyond_what_is_out_and_one_waits_at_a_time(store):
    iono, ash, misty, binders, loan, _ = lent_loan({'Binder': 3}, 2)
    assert code(start_return(ash, loan, [(iono, 3)])) == (409, 'MORE_THAN_OUT')
    assert code(start_return(ash, loan, [(str(uuid4()), 1)])) == (422, 'NOT_ON_LOAN')
    assert code(start_return(ash, loan, [(iono, 0)])) == (422, 'NOTHING_RETURNED')
    assert code(start_return(ash, loan, [(iono, 1), (iono, 1)])) == (422, 'DUPLICATE_EDITION')
    key = uuid4()
    first = ok(start_return(ash, loan, [(iono, 1)], key))
    # The same key replays the answer and gives nothing more back.
    assert call('POST', f"/api/loans/{loan['id']}/returns", ash, {
        'revision': first['revision'] - 1, 'idempotency_key': str(key),
        'lines': [{'edition_id': iono, 'quantity': '1'}]}).json() == first
    assert sum(borrowed(loan).values()) == 1
    # One pending return at a time: neither side starts another until Misty confirms.
    assert code(start_return(misty, loan, [(iono, 1)])) == (409, 'STEP_NOT_ALLOWED')
    assert code(start_return(ash, loan, [(iono, 1)])) == (409, 'STEP_NOT_ALLOWED')
    assert code(confirm_return(ash, loan)) == (409, 'STEP_NOT_ALLOWED')
    ok(confirm_return(misty, loan))

    assert code(start_return(misty, loan, [(iono, 2)])) == (409, 'MORE_THAN_OUT')


def test_no_return_before_both_sides_confirmed_the_handover_and_no_take_back_after_one(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, place(misty, 'Binder'), iono, 2)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)])), [(iono, 2)]))
    ok(handover(misty, loan))
    assert 'start_return' not in view(misty, loan)['actions']
    assert code(start_return(misty, loan, [(iono, 1)])) == (409, 'STEP_NOT_ALLOWED')
    assert code(start_return(ash, loan, [(iono, 1)])) == (409, 'STEP_NOT_ALLOWED')
    # Ash leaves before confirming: Misty records the copies back on her own, and nothing reverses her write.
    leave(ash)
    assert view(misty, loan)['actions'] == ['start_return', 'take_back', 'write_off']
    ok(start_return(misty, loan, [(iono, 1)]))
    assert view(misty, loan)['actions'] == ['start_return', 'write_off']
    assert code(take_back(misty, loan)) == (409, 'STEP_NOT_ALLOWED')


def test_a_closing_return_racing_the_borrowers_deck_deletion_never_deadlocks(store):
    # Misty's confirmation writes the Loan row once; a second write would key-share Ash's Deck while his deletion of
    # it waits on the Loan row.
    iono, ash, misty, binders, loan, charizard = lent_loan({'Binder': 2}, 2, 'Charizard')
    ok(start_return(ash, loan, [(iono, 2)]))
    body = {'revision': view(misty, loan)['revision'], 'idempotency_key': str(uuid4())}
    found = node(ash, charizard)
    drop = _sleeping('loan_return', 'UPDATE', 'NEW.lender_confirmed_at IS NOT NULL')
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            confirmed = executor.submit(call, 'POST', f"/api/loans/{loan['id']}/returns/confirm", misty, body)
            _asleep(watch, 1, [confirmed])
            deleted = executor.submit(call, 'DELETE', f'/api/decks/{charizard}', ash,
                                      {'name': found['name'], 'version': found['version'],
                                       'idempotency_key': str(uuid4())})
            confirmed, deleted = confirmed.result(), deleted.result()
    finally:
        drop()
    assert confirmed.status_code == 200, confirmed.text
    assert deleted.status_code == 200, deleted.text
    assert view(ash, loan)['closed_reason'] == 'returned'
