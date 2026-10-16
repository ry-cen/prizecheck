"""What open Loans promise, and the invariant that a lender always holds at least that (social network #252, spec
"Lender-side data: Loan lines and picks"), against real PostgreSQL.

Per lender and Card Edition, the copies promised to Loans that are accepted (or offered) and not yet handed over never
exceed the copies held, wherever they are. Inventory Removal, the Undo of an add and Edition reassignment refuse first
with PROMISED_TO_LOAN; Moves are free, because a Location doesn't matter to a promise, and the Loan Pick List follows
copies a Deck deletion or a leaf conversion moves. Migration 106's deferred trigger is the backstop for any other write.
Two acceptances for the same copies run one after the other: the lender's command lock puts one collector's steps in
line, and behind it the lender's owner lock does, which the test shows with the command lock taken away. Steps racing
from the two sides of one Loan wait for each other and never deadlock.
"""
import os
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.social import counts, loans
from test_batch_add import batch, undo, undo_records
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, hold, line
from test_friend_copies import befriend, collector, node, ok, place
from test_holdings import call
from test_location_tree import tree
from test_loans import accept, pair, send, sent, side, step, view
from test_moves import commit, selected, stage, start
from want_list_swap_fixtures import seed_swap_catalog


def holding(owner, location, edition):
    return next(item for item in ok(call('GET', f'/api/holdings/{location}', owner))['holdings']
                if item['edition_id'] == edition)


def remove(owner, location, edition, copies):
    manifest = start(owner, location)
    found = holding(owner, location, edition)
    assert stage(owner, manifest, [selected(edition, copies, found['version'])]).status_code == 200
    return call('POST', f'/api/moves/manifests/{manifest}/remove', owner, {'idempotency_key': str(uuid4())})


def promised_loan(store, held=2, promised=2):
    """Misty W. holds ``held`` Iono PAL 185 in Binder and has promised ``promised`` of them to Ash K."""
    ids = seed_swap_catalog()
    ash, misty = pair()
    binder = place(misty, 'Binder')
    hold(misty, binder, ids['PAL 185'], held)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(ids['PAL 185'], promised)])), [(ids['PAL 185'], promised)]))
    return ids, ash, misty, binder, loan


def test_reserved_counts_read_only_accepted_loans_not_yet_handed_over(store):
    ids, ash, misty, binder, loan = promised_loan(store, held=3, promised=2)
    iono = ids['PAL 185']
    sent(ash, misty, [(iono, 1)])
    with connect() as conn:
        # The unanswered request reserves nothing; an Edition with nothing reserved is absent.
        assert {str(edition): copies for edition, copies in
                counts.reserved_counts(conn, misty, [iono, ids['SVI 166']]).items()} == {iono: 2}
        assert counts.reserved_counts(conn, ash, [iono]) == {}
        assert {(owner, str(edition)): copies for (owner, edition), copies in
                counts.reserved_by_owner(conn, [misty, ash]).items()} == {(misty, iono): 2}
        assert {str(edition): {str(location): copies for location, copies in found.items()}
                for edition, found in counts.reserved_picks(conn, misty, [iono]).items()} == {iono: {binder: 2}}
    ok(step(misty, loan, 'cancel'))
    with connect() as conn:
        assert counts.reserved_counts(conn, misty, [iono]) == {} and counts.reserved_picks(conn, misty, [iono]) == {}


def test_removal_refuses_promised_copies_and_takes_the_rest(store):
    ids, ash, misty, binder, loan = promised_loan(store, held=3, promised=2)
    iono = ids['PAL 185']
    refused = remove(misty, binder, iono, 2)
    assert (refused.status_code, refused.json()['detail']) == (
        409, {'code': 'PROMISED_TO_LOAN', 'edition_id': iono, 'promised': '2'})
    assert holding(misty, binder, iono)['quantity'] == '3'
    assert remove(misty, binder, iono, 1).status_code == 200
    # Moving promised copies is fine: the promise is per Edition, and the pick is then out of date.
    other = place(misty, 'Box')
    manifest = start(misty, binder)
    stage(misty, manifest, [selected(iono, 2, holding(misty, binder, iono)['version'])])
    assert commit(misty, manifest, other).status_code == 200
    assert remove(misty, other, iono, 1).json()['detail']['code'] == 'PROMISED_TO_LOAN'


def test_undo_of_an_add_and_edition_reassignment_refuse_promised_copies(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder = place(misty, 'Binder')
    added = ok(batch(misty, binder, [(iono, '2')]))
    ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    [record] = [entry for entry in undo_records(misty) if entry['id'] == added['undo_id']]
    refused = undo(misty, record['id'])
    assert (refused.status_code, refused.json()['detail']['code']) == (409, 'PROMISED_TO_LOAN')
    assert holding(misty, binder, iono)['quantity'] == '2'
    with connect() as conn:
        reviewer = conn.execute('SELECT user_id FROM inventory_owner LIMIT 1').fetchone()['user_id']
        conn.execute("""INSERT INTO catalog_edition_replacement(edition_id, replacement_edition_id, reviewer_id,
            evidence_url, reason) VALUES (%s, %s, %s, 'https://example.org/correction', 'Finish corrected')""",
                     (iono, ids['PAL 254'], reviewer))
    body = {'location_id': binder, 'edition_id': iono, 'replacement_edition_id': ids['PAL 254'], 'quantity': '2',
            'expected_version': holding(misty, binder, iono)['version'], 'idempotency_key': str(uuid4())}
    refused = call('POST', '/api/holdings/reassign', misty, body)
    assert (refused.status_code, refused.json()['detail']) == (
        409, {'code': 'PROMISED_TO_LOAN', 'edition_id': iono, 'promised': '1'})
    # The copy no Loan promises keeps its Edition too while the Loan is open (#254, spec "Open questions" 15).
    refused = call('POST', '/api/holdings/reassign', misty, {**body, 'quantity': '1', 'idempotency_key': str(uuid4())})
    assert (refused.status_code, refused.json()['detail']) == (409, {'code': 'EDITION_ON_LOAN'})


def test_a_direct_write_that_breaks_a_promise_fails_at_commit_and_a_move_within_one_commit_does_not(store):
    ids, ash, misty, binder, loan = promised_loan(store)
    iono = ids['PAL 185']
    with pytest.raises(psycopg.errors.CheckViolation):
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            conn.execute('UPDATE holding SET quantity = 1 WHERE owner_id=%s AND edition_id=%s', (misty, iono))
    with pytest.raises(psycopg.errors.CheckViolation):
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            conn.execute('UPDATE loan_line SET promised = 3 WHERE loan_id=%s', (loan['id'],))
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        # Out of one Holding and into another before the commit: still two copies.
        conn.execute('DELETE FROM holding WHERE owner_id=%s AND edition_id=%s', (misty, iono))
        conn.execute('INSERT INTO holding(owner_id, location_id, edition_id, quantity, version) VALUES (%s,%s,%s,2,1)',
                     (misty, node(misty, 'Unsorted')['id'], iono))
    assert holding(misty, node(misty, 'Unsorted')['id'], iono)['quantity'] == '2'
    # A Loan that starts reserving more than is held fails too.
    with pytest.raises(psycopg.errors.CheckViolation):
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            conn.execute("UPDATE loan SET state='requested' WHERE id=%s", (loan['id'],))
            conn.execute('DELETE FROM holding WHERE owner_id=%s AND edition_id=%s', (misty, iono))
            conn.execute("UPDATE loan SET state='accepted' WHERE id=%s", (loan['id'],))


def test_deck_deletion_and_leaf_conversion_move_the_picks_with_the_copies(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    gardevoir = deck(misty, 'Gardevoir', 0)
    hold(misty, gardevoir, iono, 2)
    line(misty, gardevoir, iono, 2)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    found = node(misty, gardevoir)
    assert call('DELETE', f'/api/decks/{gardevoir}', misty,
                {'name': found['name'], 'version': found['version'], 'idempotency_key': str(uuid4())}).status_code == 200
    unsorted = node(misty, 'Unsorted')['id']
    assert [(pick['location_id'], pick['copies']) for pick in side(misty, loan)['picks']] == [(unsorted, '1')]
    # Leaf conversion: Binder's copies move to its new child, and so does the pick.
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 1)
    second = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)])), [(iono, 2)]))
    picks = {pick['location_id'] for pick in side(misty, second)['picks']}
    assert binder in picks
    parent = node(misty, binder)
    child = call('POST', '/api/location-tree', misty, {
        'name': 'Page 1', 'parent_id': binder, 'conversion': 'move_holdings_to_child',
        'parent_version': parent['version'], 'idempotency_key': str(uuid4())})
    assert child.status_code == 201, child.text
    child_id = child.json()['location']['id']
    assert binder not in {pick['location_id'] for pick in side(misty, second)['picks']}
    assert child_id in {pick['location_id'] for pick in side(misty, second)['picks']}
    assert {item['id'] for item in tree(misty)} >= {child_id}


def test_two_acceptances_for_the_same_copies_run_one_after_the_other(store, monkeypatch):
    # Misty's two steps would already wait for each other on her command lock (begin_command). Without it, the second
    # acceptance still waits, on her owner row, and then sees the first's reservation.
    monkeypatch.setattr(loans, 'begin_command', _without_command_lock)
    ids = seed_swap_catalog()
    ash, misty = pair()
    (brock, _) = collector('Brock S.')
    befriend(brock, misty)
    iono = ids['PAL 185']
    hold(misty, place(misty, 'Binder'), iono, 2)
    first, second = (view(misty, sent(borrower, misty, [(iono, 2)])) for borrower in (ash, brock))
    held, hold_until = _hold_pick_insert(misty)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            winner = executor.submit(accept, misty, first, [(iono, 2)])
            hold_until(watch, winner)
            loser = executor.submit(accept, misty, second, [(iono, 2)])
            _waiting_on_a_row(watch, [winner, loser])
            winner, loser = winner.result(), loser.result()
    finally:
        held()
    assert winner.status_code == 200, winner.text
    # The second ran after the first committed and saw its reservation.
    assert (loser.status_code, loser.json()['detail']) == (
        409, {'code': 'NOT_ENOUGH_COPIES', 'edition_id': iono, 'available': '0'})
    with connect() as conn:
        assert {str(edition): copies for edition, copies in counts.reserved_counts(conn, misty, [iono]).items()} == {
            iono: 2}


def test_a_removal_racing_an_acceptance_never_leaves_the_lender_short_of_a_promise(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 2)
    loan = view(misty, sent(ash, misty, [(iono, 2)]))
    manifest = start(misty, binder)
    stage(misty, manifest, [selected(iono, 1, holding(misty, binder, iono)['version'])])
    held, hold_until = _hold_pick_insert(misty)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            accepted = executor.submit(accept, misty, loan, [(iono, 2)])
            hold_until(watch, accepted)
            removed = executor.submit(call, 'POST', f'/api/moves/manifests/{manifest}/remove', misty,
                                      {'idempotency_key': str(uuid4())})
            accepted, removed = accepted.result(), removed.result()
    finally:
        held()
    assert accepted.status_code == 200, accepted.text
    assert (removed.status_code, removed.json()['detail']['code']) == (409, 'PROMISED_TO_LOAN')
    assert holding(misty, binder, iono)['quantity'] == '2'


def test_an_edit_and_resend_racing_the_lenders_acceptance_waits_and_then_finds_the_request_answered(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, place(misty, 'Binder'), iono, 3)
    loan = view(misty, sent(ash, misty, [(iono, 1)]))
    held, hold_until = _hold_pick_insert(misty)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            accepted = executor.submit(accept, misty, loan, [(iono, 1)])
            hold_until(watch, accepted)
            resent = executor.submit(send, ash, misty, [(iono, 2)], replaces=loan['id'])
            accepted, resent = accepted.result(), resent.result()
    finally:
        held()
    assert accepted.status_code == 200, accepted.text
    # The resend waited on the Loan row, then found the request answered; neither side deadlocked.
    assert (resent.status_code, resent.json()['detail']['code']) == (409, 'LOAN_CHANGED')
    assert [loan['state'] for loan in ok(call('GET', '/api/social/loans', ash))['loans']] == ['accepted']


def test_both_sides_cancelling_at_once_run_one_after_the_other(store):
    ids = seed_swap_catalog()
    ash, misty = pair(ordered=True)
    iono = ids['PAL 185']
    hold(misty, place(misty, 'Binder'), iono, 2)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)])), [(iono, 2)]))
    held, hold_until = _sleep_in_pick_write('DELETE', f"OLD.owner_id = '{misty}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            lender = executor.submit(step, misty, loan, 'cancel')
            hold_until(watch, lender)
            borrower = executor.submit(step, ash, loan, 'cancel')
            lender, borrower = lender.result(), borrower.result()
    finally:
        held()
    assert lender.status_code == 200, lender.text
    # The borrower's cancel locks Ash, then waits on Misty; the lender's, under Misty's lock, still finishes.
    assert (borrower.status_code, borrower.json()['detail']['code']) == (409, 'LOAN_CHANGED')
    assert (view(ash, loan)['state'], view(ash, loan)['closed_by']) == ('closed', 'them')
    with connect() as conn:
        assert counts.reserved_counts(conn, misty, [iono]) == {}


def _without_command_lock(conn, user_id, key, payload):
    """``loans.begin_command`` without the caller's command lock: the owner row is the only lock left between two of
    one collector's steps."""
    loans.ensure_owner(conn, user_id)
    digest, stored = loans.replay(conn, user_id, key, payload)
    if stored is None:
        loans.count_loan_command(conn, user_id)
    return digest, stored


def _waiting_on_a_row(watch, submitted):
    """Waits until a session waits on a row lock (never an advisory lock) while every submitted call still runs."""
    deadline = time.monotonic() + 10
    while not watch.execute("""SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND wait_event IN ('transactionid','tuple')""").fetchone():
        assert time.monotonic() < deadline and not any(call.done() for call in submitted), \
            'no step waited on a row lock'
        time.sleep(0.01)


def _hold_pick_insert(owner):
    """An injected trigger that sleeps while the owner's first Loan pick is inserted, so the accepting transaction
    holds the owner lock for a while. Returns (drop it, wait until a submitted call is asleep in it)."""
    return _sleep_in_pick_write('INSERT', f"NEW.owner_id = '{owner}'")


def _sleep_in_pick_write(event, condition):
    """An injected trigger that sleeps 0.6 s in each ``loan_pick`` row ``event`` (INSERT, UPDATE or DELETE) that meets
    ``condition``, so the step writing it holds its locks for a while. Returns (drop it, wait until a submitted call is
    asleep in it)."""
    suffix = uuid4().hex
    function_name, trigger_name = f'hold_pick_{suffix}', f'hold_pick_trigger_{suffix}'
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute(f"CREATE FUNCTION {function_name}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                     "BEGIN PERFORM pg_sleep(0.6); RETURN NULL; END $$")
        conn.execute(f"""CREATE TRIGGER {trigger_name} AFTER {event} ON loan_pick FOR EACH ROW
          WHEN ({condition}) EXECUTE FUNCTION {function_name}()""")

    def drop():
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            conn.execute(f'DROP TRIGGER {trigger_name} ON loan_pick')
            conn.execute(f'DROP FUNCTION {function_name}()')

    def wait(watch, submitted):
        deadline = time.monotonic() + 10
        while not watch.execute("""SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event='PgSleep'""").fetchone():
            assert time.monotonic() < deadline and not submitted.done(), 'the held step never reached the trigger'
            time.sleep(0.01)

    return drop, wait
