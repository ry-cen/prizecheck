"""Handover (social network #253): each side confirms a Loan's handover for its own inventory, through signed HTTP
against PostgreSQL.

The lender's confirmation takes the picked copies out of their Locations with no Undo record: they are lent, in no
Location, still counted in the Collection and on the Lent out entry, read "lent to Sam" on a Deck's line and never go
on the Want List. The borrower's puts Borrowed Copies into the Loan's Deck, or Unsorted, never into their Holdings.
A side may take its confirmation back until the other confirms, which reverses only its own write; nobody can cancel
once a side has confirmed. A pick that went out of date is flagged with a suggested source and must be replaced first.
Steps from the two sides, on one Loan or on two, wait for each other and never deadlock, and neither does a step and the
other collector's Deck deletion: a step writes its Loan row once.
"""
import ast
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi import HTTPException

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app import moves
from app.social import counts
from app.social.loans import LoanStep, run_step
from test_batch_add import undo_records
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import counting, deck, detail, hold, line
from test_friend_copies import collector, node, ok, place
from test_holdings import call
from test_loan_promises import _waiting_on_a_row, holding
from test_loans import accept, pair, sent, side, step, view
from test_moves import commit, selected, stage, start
from test_want_list import section, want_list
from want_list_swap_fixtures import seed_swap_catalog


def handover(user, loan, key=None):
    return call('POST', f"/api/loans/{loan['id']}/handover", user,
                {'revision': view(user, loan)['revision'], 'idempotency_key': str(key or uuid4())})


def take_back(user, loan):
    return call('POST', f"/api/loans/{loan['id']}/take-back", user,
                {'revision': view(user, loan)['revision'], 'idempotency_key': str(uuid4())})


def use_suggested(user, loan):
    return call('POST', f"/api/loans/{loan['id']}/picks/use-suggested", user,
                {'revision': view(user, loan)['revision'], 'idempotency_key': str(uuid4())})


def code(response):
    return response.status_code, response.json()['detail']['code']


def borrowed(loan):
    """The Loan's Borrowed Copies as {(Location id, Edition id): copies}."""
    with connect() as conn:
        return {(str(row['location_id']), str(row['edition_id'])): row['quantity'] for row in conn.execute(
            'SELECT location_id, edition_id, quantity FROM borrowed_holding WHERE loan_id=%s', (loan['id'],))}


def lent(owner):
    return ok(call('GET', '/api/loans/lent-out', owner))


def tree_lent(owner):
    return ok(call('GET', '/api/location-tree', owner))['lent_copies']


def whole_collection(owner):
    body = ok(call('GET', '/api/collection/holdings', owner))
    return body['totals']['copies'], body['lent']


def accepted_loan(held=3, asked=3, deck_name=None, ordered=False):
    """Misty W. holds ``held`` Iono PAL 185 in Binder and accepted Ash K.'s request for ``asked`` of them. ``ordered``:
    as ``pair``'s."""
    ids = seed_swap_catalog()
    ash, misty = pair(ordered)
    binder = place(misty, 'Binder')
    hold(misty, binder, ids['PAL 185'], held)
    extra = {'deck_id': deck(ash, deck_name, 0)} if deck_name else {}
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(ids['PAL 185'], asked)], **extra)),
                     [(ids['PAL 185'], asked)]))
    return ids['PAL 185'], ash, misty, binder, loan


def test_the_lenders_handover_takes_the_picked_copies_out_and_lends_them_with_no_undo(store):
    iono, ash, misty, binder, loan = accepted_loan(held=5, asked=3)
    records = undo_records(misty)
    before = ok(call('GET', '/api/location-tree', misty))['owner_revision']
    confirmed = ok(handover(misty, loan))
    assert (confirmed['state'], confirmed['you_confirmed_handover'], confirmed['they_confirmed_handover']) == (
        'accepted', True, False)
    # Once handed over, the lender may also write copies off (#257).
    assert (confirmed['section'], confirmed['needs_you'], confirmed['actions']) == (
        'out_now', False, ['take_back', 'write_off'])
    assert holding(misty, binder, iono)['quantity'] == '2'
    assert undo_records(misty) == records
    assert ok(call('GET', '/api/location-tree', misty))['owner_revision'] == before + 1
    # Still Misty's: the Collection counts them, the tree's Lent out entry and its list show them.
    assert whole_collection(misty) == ('2', '3') and tree_lent(misty) == '3'
    assert [(card['edition_id'], card['copies'], card['borrower'], card['loan_id']) for card in lent(misty)['cards']] == [
        (iono, '3', 'Ash K.', loan['id'])]
    assert lent(misty)['copies'] == '3'
    with connect() as conn:
        assert {str(edition): copies for edition, copies in counts.lent_counts(conn, misty, None).items()} == {iono: 3}
        assert counts.reserved_counts(conn, misty, [iono]) == {}
    assert [(pick['name'], pick['copies'], pick['short']) for pick in side(misty, loan)['picks']] == [
        ('Binder', '3', '0')]
    # Ash is asked to confirm, and nothing is in Ash's inventory until then.
    asked = view(ash, loan)
    assert (asked['section'], asked['needs_you'], asked['actions']) == ('needs_you', True, ['confirm_handover'])
    assert borrowed(loan) == {}
    # A filtered or one-Location listing counts only Holdings.
    assert ok(call('GET', f'/api/collection/holdings?location_id={binder}', misty))['lent'] == '0'
    # The borrower confirms second: the Loan is handed over for both, and either side may start a return (#255).
    done = ok(handover(ash, loan))
    assert (done['state'], done['section'], done['actions']) == ('handed_over', 'out_now', ['start_return'])
    # The lender may also write copies off (#257).
    assert (view(misty, loan)['state'], view(misty, loan)['actions']) == (
        'handed_over', ['start_return', 'write_off'])


def test_the_borrowers_handover_puts_borrowed_copies_in_the_named_deck_and_never_in_holdings(store):
    iono, ash, misty, binder, loan = accepted_loan(deck_name='Charizard')
    charizard = side(ash, loan)['deck']['id']
    confirmed = ok(handover(ash, loan))
    assert (confirmed['state'], confirmed['you_confirmed_handover'], confirmed['section'], confirmed['actions']) == (
        'accepted', True, 'out_now', ['take_back'])
    assert borrowed(loan) == {(charizard, iono): 3}
    assert ok(call('GET', f'/api/holdings/{charizard}', ash))['holdings'] == []
    assert whole_collection(ash) == ('0', '0')
    # Misty is asked now; once she confirms, the Loan is handed over and nothing more can be taken back: either side
    # may start a return (#255).
    assert view(misty, loan)['needs_you'] is True
    done = ok(handover(misty, loan))
    assert (done['state'], done['section'], done['actions']) == (
        'handed_over', 'out_now', ['start_return', 'write_off'])
    assert view(ash, loan)['actions'] == ['start_return']
    assert code(take_back(ash, loan)) == (409, 'STEP_NOT_ALLOWED')


def test_borrowed_copies_go_to_unsorted_without_a_deck_and_follow_a_deleted_deck_there(store):
    iono, ash, misty, binder, loan = accepted_loan(held=4, asked=2)
    unsorted = node(ash, 'Unsorted')['id']
    ok(handover(ash, loan))
    assert borrowed(loan) == {(unsorted, iono): 2}
    # Unsorted holds Borrowed Copies, so it can't be deleted.
    found = node(ash, 'Unsorted')
    refused = call('DELETE', f"/api/location-tree/{found['id']}", ash,
                   {'version': found['version'], 'name': found['name'], 'idempotency_key': str(uuid4())})
    assert code(refused) == (409, 'LOCATION_NOT_EMPTY')
    # A Deck the borrower deletes after confirming: its Borrowed Copies follow it to Unsorted.
    gardevoir = deck(ash, 'Gardevoir', 0)
    second = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)], deck_id=gardevoir)), [(iono, 1)]))
    ok(handover(ash, second))
    assert borrowed(second) == {(gardevoir, iono): 1}
    named = node(ash, gardevoir)
    assert call('DELETE', f'/api/decks/{gardevoir}', ash, {'name': named['name'], 'version': named['version'],
                                                           'idempotency_key': str(uuid4())}).status_code == 200
    assert borrowed(second) == {(unsorted, iono): 1}
    # A Deck the borrower deletes before confirming: the Loan names no Deck now, and the copies go to Unsorted.
    dragapult = deck(ash, 'Dragapult', 0)
    third = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)], deck_id=dragapult)), [(iono, 1)]))
    named = node(ash, dragapult)
    assert call('DELETE', f'/api/decks/{dragapult}', ash, {'name': named['name'], 'version': named['version'],
                                                           'idempotency_key': str(uuid4())}).status_code == 200
    assert side(ash, third)['deck'] is None
    ok(handover(ash, third))
    assert borrowed(third) == {(unsorted, iono): 1}


def test_take_back_reverses_only_that_sides_write_and_nobody_cancels_after_a_confirmation(store):
    iono, ash, misty, binder, loan = accepted_loan(held=3, asked=2)
    ok(handover(misty, loan))
    assert code(step(ash, view(ash, loan), 'cancel')) == (409, 'STEP_NOT_ALLOWED')
    assert code(step(misty, view(misty, loan), 'cancel')) == (409, 'STEP_NOT_ALLOWED')
    records = undo_records(misty)
    back = ok(take_back(misty, loan))
    assert (back['state'], back['you_confirmed_handover'], back['actions']) == (
        'accepted', False, ['confirm_handover', 'cancel', 'change_return_by'])
    assert holding(misty, binder, iono)['quantity'] == '3' and undo_records(misty) == records
    with connect() as conn:
        assert {str(edition): copies for edition, copies in counts.reserved_counts(conn, misty, [iono]).items()} == {
            iono: 2}
    assert tree_lent(misty) == '0'
    # The borrower's take-back removes only the Borrowed Copies.
    ok(handover(ash, loan))
    assert borrowed(loan) != {}
    assert ok(take_back(ash, loan))['you_confirmed_handover'] is False
    assert borrowed(loan) == {} and holding(misty, binder, iono)['quantity'] == '3'
    assert code(take_back(ash, loan)) == (409, 'STEP_NOT_ALLOWED')


def test_nobody_cancels_once_only_the_borrower_has_confirmed(store):
    iono, ash, misty, binder, loan = accepted_loan(held=3, asked=2)
    ok(handover(ash, loan))
    assert code(step(ash, view(ash, loan), 'cancel')) == (409, 'STEP_NOT_ALLOWED')
    assert code(step(misty, view(misty, loan), 'cancel')) == (409, 'STEP_NOT_ALLOWED')
    assert 'cancel' not in view(ash, loan)['actions'] and 'cancel' not in view(misty, loan)['actions']
    assert view(misty, loan)['state'] == 'accepted' and borrowed(loan) != {}


def test_a_handover_or_take_back_replayed_with_its_key_writes_once(store):
    iono, ash, misty, binder, loan = accepted_loan(held=3, asked=2)
    path = f"/api/loans/{loan['id']}"

    def twice(user, route):
        body = {'revision': view(user, loan)['revision'], 'idempotency_key': str(uuid4())}
        first = ok(call('POST', f'{path}/{route}', user, body))
        before = (ok(call('GET', '/api/location-tree', user))['owner_revision'], view(user, loan)['revision'])
        assert ok(call('POST', f'{path}/{route}', user, body)) == first
        assert (ok(call('GET', '/api/location-tree', user))['owner_revision'], view(user, loan)['revision']) == before
        return first

    twice(misty, 'handover')
    assert holding(misty, binder, iono)['quantity'] == '1' and tree_lent(misty) == '2'
    twice(misty, 'take-back')
    assert holding(misty, binder, iono)['quantity'] == '3' and tree_lent(misty) == '0'
    unsorted = node(ash, 'Unsorted')['id']
    twice(ash, 'handover')
    assert borrowed(loan) == {(unsorted, iono): 2}
    twice(ash, 'take-back')
    assert borrowed(loan) == {}


def test_copies_taken_back_to_a_source_that_is_no_longer_a_storage_leaf_go_to_unsorted(store):
    iono, ash, misty, binder, loan = accepted_loan(held=2, asked=2)
    ok(handover(misty, loan))
    # Binder is empty while its copies are out, and gets a Location inside it: it can't hold cards now.
    page = place(misty, 'Page 1', 'Binder')
    assert node(misty, binder)['kind'] != 'storage_leaf'
    ok(take_back(misty, loan))
    unsorted = node(misty, 'Unsorted')['id']
    assert holding(misty, unsorted, iono)['quantity'] == '2'
    assert all(item['edition_id'] != iono for item in ok(call('GET', f'/api/holdings/{page}', misty))['holdings'])
    assert [(pick['location_id'], pick['name'], pick['copies']) for pick in side(misty, loan)['picks']] == [
        (unsorted, 'Unsorted', '2')]


def test_take_out_refuses_a_holding_short_of_the_copies_asked_and_writes_nothing(store):
    ids = seed_swap_catalog()
    owner, _ = collector()
    binder, box = place(owner, 'Binder'), place(owner, 'Box')
    hold(owner, binder, ids['PAL 185'], 3)
    hold(owner, box, ids['SVI 166'], 1)
    before = ok(call('GET', '/api/location-tree', owner))['owner_revision']
    with pytest.raises(moves.HoldingShort):
        with connect() as conn, conn.transaction():
            moves.take_out(conn, owner, [(UUID(binder), UUID(ids['PAL 185']), 1), (UUID(box), UUID(ids['SVI 166']), 2)],
                           before)
    assert holding(owner, binder, ids['PAL 185'])['quantity'] == '3'
    assert holding(owner, box, ids['SVI 166'])['quantity'] == '1'
    assert ok(call('GET', '/api/location-tree', owner))['owner_revision'] == before


def test_copies_taken_back_return_to_a_deck_as_they_left_it_and_a_gone_source_returns_to_unsorted(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    gardevoir = deck(misty, 'Gardevoir', 0)
    hold(misty, gardevoir, iono, 3)
    line(misty, gardevoir, iono, 2)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    ok(handover(misty, loan))
    ok(take_back(misty, loan))
    shown = detail(misty, gardevoir)
    assert [(entry['quantity'], entry['in_deck']) for entry in shown['deck_list']['lines']] == [('2', '2')]
    assert holding(misty, gardevoir, iono)['quantity'] == '3'
    # The Box the copy came from is deleted while it is out: taking back puts it in Unsorted.
    box = place(misty, 'Box')
    hold(misty, box, ids['SVI 166'], 1)
    second = ok(accept(misty, view(misty, sent(ash, misty, [(ids['SVI 166'], 1)])), [(ids['SVI 166'], 1)]))
    ok(handover(misty, second))
    found = node(misty, box)
    assert call('DELETE', f'/api/location-tree/{box}', misty, {'version': found['version'], 'name': found['name'],
                                                               'idempotency_key': str(uuid4())}).status_code == 200
    ok(take_back(misty, second))
    unsorted = node(misty, 'Unsorted')['id']
    assert holding(misty, unsorted, ids['SVI 166'])['quantity'] == '1'
    assert [(pick['location_id'], pick['name']) for pick in side(misty, second)['picks']] == [(unsorted, 'Unsorted')]


def test_an_out_of_date_pick_is_flagged_and_replaced_before_the_lenders_handover(store):
    iono, ash, misty, binder, loan = accepted_loan(held=3, asked=2)
    box = place(misty, 'Box')
    manifest = start(misty, binder)
    stage(misty, manifest, [selected(iono, 2, holding(misty, binder, iono)['version'])])
    assert commit(misty, manifest, box).status_code == 200
    lender = side(misty, loan)
    # Binder holds 1 now: the pick is short of 1, and the suggestion takes the other from Box.
    assert [(pick['name'], pick['copies'], pick['short']) for pick in lender['picks']] == [('Binder', '2', '1')]
    assert sorted((pick['name'], pick['copies']) for pick in lender['suggested']) == [('Binder', '1'), ('Box', '1')]
    assert code(handover(misty, loan)) == (409, 'PICKS_OUT_OF_DATE')
    assert code(use_suggested(ash, loan)) == (409, 'STEP_NOT_ALLOWED')
    ok(use_suggested(misty, loan))
    fixed = side(misty, loan)
    assert sorted((pick['name'], pick['copies'], pick['short']) for pick in fixed['picks']) == [
        ('Binder', '1', '0'), ('Box', '1', '0')]
    assert fixed['suggested'] == []
    assert code(use_suggested(misty, loan)) == (409, 'PICKS_UP_TO_DATE')
    ok(handover(misty, loan))
    assert holding(misty, box, iono)['quantity'] == '1'
    assert all(item['edition_id'] != iono for item in ok(call('GET', f'/api/holdings/{binder}', misty))['holdings'])


def test_lent_deck_copies_read_lent_to_count_as_missing_and_stay_off_the_want_list(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    gardevoir = deck(misty, 'Gardevoir', 0)
    hold(misty, gardevoir, iono, 2)
    line(misty, gardevoir, iono, 2)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    ok(handover(misty, loan))
    shown = detail(misty, gardevoir)
    assert shown['loans'] == [{'edition_id': iono, 'reserved': [], 'lent': [{'name': 'Ash K.', 'copies': '1'}],
                               'borrowed': []}]
    # Missing from the Deck itself, but owned: nothing to get, under either counting setting.
    assert [entry['in_deck'] for entry in shown['deck_list']['lines']] == ['1']
    assert shown['to_get'] == '0'
    assert section(want_list(misty), gardevoir)['lines'] == []
    counting(misty, 'one_at_a_time')
    assert detail(misty, gardevoir)['to_get'] == '0'
    # A loose copy lent out counts for a Deck short of it, as a Spare Copy would.
    counting(misty, 'all_at_once')
    arven = ids['SVI 166']
    hold(misty, node(misty, 'Unsorted')['id'], arven, 1)
    line(misty, gardevoir, arven, 2)
    second = ok(accept(misty, view(misty, sent(ash, misty, [(arven, 1)])), [(arven, 1)]))
    ok(handover(misty, second))
    [entry] = section(want_list(misty), gardevoir)['lines']
    assert (entry['edition_id'], entry['held'], entry['spare'], entry['lent'], entry['need']) == (arven, '0', '0', '1', '1')


def test_a_cancel_racing_the_lenders_handover_waits_and_then_finds_the_loan_changed(store):
    # Ash's id sorts first, so the borrower's cancel holds Ash's row while it waits on Misty's.
    iono, ash, misty, binder, loan = accepted_loan(held=2, asked=2, ordered=True)
    cancel_body = {'revision': view(ash, loan)['revision'], 'idempotency_key': str(uuid4())}
    drop = _sleeping('loan_pick', 'UPDATE', f"NEW.owner_id = '{misty}' AND NEW.state = 'lent'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            handed = executor.submit(handover, misty, loan)
            _asleep(watch, 1, [handed])
            cancelled = executor.submit(call, 'POST', f"/api/social/loans/{loan['id']}/cancel", ash, cancel_body)
            handed, cancelled = handed.result(), cancelled.result()
    finally:
        drop()
    assert handed.status_code == 200, handed.text
    assert code(cancelled) == (409, 'LOAN_CHANGED')
    assert view(ash, loan)['state'] == 'accepted' and tree_lent(misty) == '2'


def test_two_loans_stepped_from_both_sides_at_once_never_deadlock(store):
    iono, ash, misty, binder, first = accepted_loan(held=4, asked=2)
    ok(handover(misty, first))
    second = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)])), [(iono, 2)]))
    drops = [_sleeping('loan_pick', 'UPDATE', f"NEW.owner_id = '{misty}' AND NEW.state = 'reserved'"),
             _sleeping('borrowed_holding', 'INSERT', f"NEW.borrower_id = '{ash}'")]
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            taken_back = executor.submit(take_back, misty, first)
            confirmed = executor.submit(handover, ash, second)
            _asleep(watch, 2, [taken_back, confirmed])
            taken_back, confirmed = taken_back.result(), confirmed.result()
    finally:
        for drop in drops:
            drop()
    assert taken_back.status_code == 200, taken_back.text
    assert confirmed.status_code == 200, confirmed.text
    assert view(misty, first)['you_confirmed_handover'] is False
    assert view(ash, second)['you_confirmed_handover'] is True
    assert sorted(borrowed(second).values()) == [2]


def test_a_lenders_step_and_the_borrowers_deck_deletion_both_commit(store):
    # The Loan names Ash's Deck, so deleting it cascades into the Loan row Misty's handover holds. The handover writes
    # that row once, so it never key-shares Ash's owner row, which the Deck deletion holds FOR UPDATE meanwhile.
    iono, ash, misty, binder, loan = accepted_loan(held=2, asked=2, deck_name='Charizard')
    charizard = side(ash, loan)['deck']['id']
    named = node(ash, charizard)
    drop = _sleeping('loan_pick', 'UPDATE', f"NEW.owner_id = '{misty}' AND NEW.state = 'lent'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            handed = executor.submit(handover, misty, loan)
            _asleep(watch, 1, [handed])
            deleted = executor.submit(call, 'DELETE', f'/api/decks/{charizard}', ash,
                                      {'name': named['name'], 'version': named['version'],
                                       'idempotency_key': str(uuid4())})
            _waiting_on_a_row(watch, [handed, deleted])
            handed, deleted = handed.result(), deleted.result()
    finally:
        drop()
    assert handed.status_code == 200, handed.text
    assert deleted.status_code == 200, deleted.text
    assert view(misty, loan)['you_confirmed_handover'] is True and side(ash, loan)['deck'] is None


def test_a_step_the_database_ends_in_a_deadlock_answers_503_and_its_retry_runs(store):
    iono, ash, misty, binder, loan = accepted_loan(held=2, asked=2)
    key, revision = uuid4(), view(misty, loan)['revision']

    def deadlocked(conn, row):
        raise psycopg.errors.DeadlockDetected('deadlock detected')

    with pytest.raises(HTTPException) as refused:
        run_step(misty, UUID(loan['id']), LoanStep(revision=revision, idempotency_key=key), 'confirm_handover',
                 deadlocked, lambda role, row: [misty])
    assert (refused.value.status_code, refused.value.detail) == (503, {'code': 'INVENTORY_TEMPORARILY_UNAVAILABLE'})
    assert view(misty, loan)['revision'] == revision and holding(misty, binder, iono)['quantity'] == '2'
    # Nothing was recorded for the key, so the client's retry with it runs the step.
    retried = ok(call('POST', f"/api/loans/{loan['id']}/handover", misty,
                      {'revision': revision, 'idempotency_key': str(key)}))
    assert retried['you_confirmed_handover'] is True


def test_a_loan_step_writes_its_loan_row_once():
    # A second write of a Loan row in one transaction checks both collectors' keys again, key-sharing the other side's
    # owner row after the step's own locks. Only run_step's write_loan writes the row of an existing Loan; the other
    # write is a Borrow Request's Edit and resend, which closes the earlier request with one write of its row. The
    # inbox (#259) and the pick reads write no Loan row.
    app = Path(__file__).resolve().parents[1] / 'app'
    writes = {name: len(re.findall(r'\bUPDATE\s+loan\s', _string_constants(app / name)))
              for name in LOAN_MODULES}
    assert writes == {'social/owners.py': 0, 'social/loans.py': 1, 'loan_inventory.py': 1, 'borrowed_copies.py': 0,
                      'loan_picks.py': 0, 'social/inbox.py': 0}


def test_no_loan_step_takes_a_lock_that_holds_off_a_foreign_key_check():
    # Other collectors' writes key-share an owner's row (a Borrow Request names its lender) and a Loan row (a Borrowed
    # Holding names its Loan); a FOR UPDATE on an owner or Loan row in any Loan step would make them wait on it.
    app = Path(__file__).resolve().parents[1] / 'app'
    for name in LOAN_MODULES:
        sql = _string_constants(app / name)
        assert 'FOR UPDATE' not in sql.replace('FOR NO KEY UPDATE', ''), name
        # The modules that only read take no lock at all.
        assert 'FOR NO KEY UPDATE' in sql or name in ('borrowed_copies.py', 'loan_picks.py', 'social/inbox.py'), name
    assert 'owner_and_rows(' not in (app / 'loan_inventory.py').read_text()


# The modules with Loan steps or Loan reads.
LOAN_MODULES = ('social/owners.py', 'social/loans.py', 'loan_inventory.py', 'borrowed_copies.py', 'loan_picks.py',
                'social/inbox.py')


def _string_constants(path):
    """The module's string constants, docstrings left out: its SQL."""
    tree = ast.parse(path.read_text())
    docstrings = {id(node.body[0].value) for node in ast.walk(tree)
                  if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and node.body
                  and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant)}
    return ' '.join(node.value for node in ast.walk(tree)
                    if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings)


def _sleeping(table, event, condition):
    """An injected trigger that sleeps 0.6 s in each ``table`` row ``event`` that meets ``condition``, so the step
    writing it holds its locks a while. Returns a call that drops it."""
    suffix = uuid4().hex
    function_name, trigger_name = f'hold_{suffix}', f'hold_trigger_{suffix}'
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute(f"CREATE FUNCTION {function_name}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                     "BEGIN PERFORM pg_sleep(0.6); RETURN NULL; END $$")
        conn.execute(f"""CREATE TRIGGER {trigger_name} AFTER {event} ON {table} FOR EACH ROW
          WHEN ({condition}) EXECUTE FUNCTION {function_name}()""")

    def drop():
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            conn.execute(f'DROP TRIGGER {trigger_name} ON {table}')
            conn.execute(f'DROP FUNCTION {function_name}()')

    return drop


def _asleep(watch, sleepers, submitted):
    """Waits until ``sleepers`` sessions are asleep in an injected trigger."""
    deadline = time.monotonic() + 10
    while watch.execute("""SELECT count(*) AS asleep FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event='PgSleep'""").fetchone()[0] < sleepers:
        assert time.monotonic() < deadline and not any(call.done() for call in submitted), \
            'a held step never reached its trigger'
        time.sleep(0.01)
