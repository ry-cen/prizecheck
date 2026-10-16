"""Edition reassignment carries open Loans to the replacement Edition (social network spec item 15, the owner's
decision of 2026-10-16), through signed HTTP against PostgreSQL.

A collector's reassignment of copies of a deprecated Card Edition to its replacement moves their open Loans that name
it: lines, picks, return lines and Borrowed Copies, merged with any the Loan has for the replacement. Before the
lender's handover only the lender's own reassignment moves a Loan, and a Loan reserving copies moves only when the
lender's copies of the replacement then cover every promise in it; after the handover either side's does. Each Loan
moved changes its revision, the other side's inventory revision moves, and no Location or Deck crosses between sides.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import hold
from test_friend_copies import node, ok, place
from test_handover import _asleep, _sleeping, borrowed, code, handover
from test_holdings import call
from test_loan_promises import holding
from test_loans import accept, pair, revision_of, sent, side, view
from test_returns import confirm_return, lent_loan, start_return
from test_write_off import deck_lines
from want_list_swap_fixtures import seed_swap_catalog


def link(edition, replacement):
    """Records ``replacement`` as ``edition``'s replacement, reviewed by a collector already signed in."""
    with connect() as conn:
        reviewer = conn.execute('SELECT user_id FROM inventory_owner LIMIT 1').fetchone()['user_id']
        conn.execute("""INSERT INTO catalog_edition_replacement(edition_id, replacement_edition_id, reviewer_id,
            evidence_url, reason) VALUES (%s, %s, %s, 'https://example.org/correction', 'Finish corrected')
            ON CONFLICT DO NOTHING""", (edition, replacement, reviewer))


def reassign(owner, location, edition, replacement, copies):
    return call('POST', '/api/holdings/reassign', owner, {
        'location_id': location, 'edition_id': edition, 'replacement_edition_id': replacement,
        'quantity': str(copies), 'expected_version': holding(owner, location, edition)['version'],
        'idempotency_key': str(uuid4())})


def lines(user, loan):
    return [(line['edition_id'], line['requested'], line['promised']) for line in view(user, loan)['lines']]


def editions():
    """Iono PAL 185 and its replacement PAL 254, linked."""
    ids = seed_swap_catalog()
    link(ids['PAL 185'], ids['PAL 254'])
    return ids['PAL 185'], ids['PAL 254']


def replacement_for(iono):
    """PAL 254 of the catalog already seeded (``lent_loan`` seeds its own, with new ids), linked as Iono PAL 185's
    replacement."""
    with connect() as conn:
        fixed = str(conn.execute("""SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id = e.printing_id
          WHERE p.source_id = 'sv02-254'""").fetchone()['id'])
    link(iono, fixed)
    return fixed


def test_the_lenders_reassignment_carries_a_request_and_an_accepted_loan_and_nothing_of_hers_reaches_the_borrower(store):
    ash, misty = pair()
    iono, fixed = editions()
    binder = place(misty, 'Binder Secret')
    hold(misty, binder, iono, 3)
    asked = sent(ash, misty, [(iono, 1)])
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)])), [(iono, 2)]))
    before = {owner: revision_of(owner) for owner in (ash, misty)}
    stale = view(ash, loan)
    assert ok(reassign(misty, binder, iono, fixed, 3))['quantity'] == '3'
    # Both Loans name the replacement now, on both sides; Misty's picks follow; the Loans' revisions moved.
    assert lines(ash, asked) == [(fixed, '1', '0')] and lines(misty, loan) == [(fixed, '2', '2')]
    assert [(pick['edition_id'], pick['location_id'], pick['short']) for pick in side(misty, loan)['picks']] == [
        (fixed, binder, '0')]
    assert view(ash, loan)['revision'] > stale['revision']
    assert code(call('POST', f"/api/social/loans/{loan['id']}/cancel", ash,
                     {'revision': stale['revision'], 'idempotency_key': str(uuid4())})) == (409, 'LOAN_CHANGED')
    assert revision_of(ash) == before[ash] + 1 and revision_of(misty) == before[misty] + 1
    # Ash reads no Location of Misty's on either Loan.
    for found in (asked, loan):
        assert 'Binder Secret' not in json.dumps(view(ash, found)) + json.dumps(side(ash, found))
    # The Loans carry on as the replacement: she accepts the request and hands both over.
    ok(accept(misty, view(misty, asked), [(fixed, 1)]))
    ok(handover(misty, loan))
    ok(handover(ash, loan))
    assert borrowed(loan) == {(node(ash, 'Unsorted')['id'], fixed): 2}


def test_a_reserving_loan_moves_once_the_lenders_replacement_copies_cover_it_and_spread_copies_are_refused(store):
    ash, misty = pair()
    iono, fixed = editions()
    first, second = place(misty, 'Binder A'), place(misty, 'Binder B')
    hold(misty, first, iono, 2)
    hold(misty, second, iono, 1)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)])), [(iono, 2)]))
    # One replacement copy can't cover the 2 promised: the Loan stays on Iono, which still covers it.
    ok(reassign(misty, second, iono, fixed, 1))
    assert lines(misty, loan) == [(iono, '2', '2')]
    # Two more cover it: the Loan moves.
    ok(reassign(misty, first, iono, fixed, 2))
    assert lines(misty, loan) == [(fixed, '2', '2')]
    # Promised copies spread one per Location: neither reassignment alone covers the promise, so each is refused until
    # the copies are Moved together.
    ash, misty = pair()
    first, second = place(misty, 'Binder A'), place(misty, 'Binder B')
    hold(misty, first, iono, 1)
    hold(misty, second, iono, 1)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)])), [(iono, 2)]))
    refused = reassign(misty, first, iono, fixed, 1)
    assert (refused.status_code, refused.json()['detail']) == (
        409, {'code': 'PROMISED_TO_LOAN', 'edition_id': iono, 'promised': '2'})
    assert lines(misty, loan) == [(iono, '2', '2')] and holding(misty, first, iono)['quantity'] == '1'


def test_the_borrowers_reassignment_moves_a_handed_over_loan_with_its_borrowed_copies_but_not_one_still_reserved(store):
    iono, ash, misty, binders, loan, charizard = lent_loan({'Binder': 4}, 2, 'Charizard')
    fixed = replacement_for(iono)
    pending = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    box = place(ash, 'Box')
    hold(ash, box, iono, 2)
    before = revision_of(misty)
    ok(reassign(ash, box, iono, fixed, 1))
    # The handed-over Loan follows Ash: his Borrowed Copies in Charizard and Misty's lent line name the replacement,
    # and his Deck's line for the replacement rises as owned copies arriving there would; Iono's line stays.
    assert lines(misty, loan) == [(fixed, '2', '2')] and borrowed(loan) == {(charizard, fixed): 2}
    assert deck_lines(ash, charizard) == {iono: '2', fixed: '2'}
    assert revision_of(misty) == before + 1
    # The Loan Misty hasn't handed over yet stays on Iono: its promise is on her copies.
    assert lines(ash, pending) == [(iono, '1', '1')]
    # Ash gives the copies back: they come back to Misty as the replacement.
    ok(start_return(ash, loan, [(fixed, 2)]))
    ok(confirm_return(misty, loan))
    assert holding(misty, binders['Binder'], fixed)['quantity'] == '2'
    assert view(misty, loan)['state'] == 'closed'


def test_a_loan_with_lines_for_both_editions_merges_them(store):
    ash, misty = pair()
    iono, fixed = editions()
    binder = place(misty, 'Binder')
    hold(misty, binder, iono, 2)
    hold(misty, binder, fixed, 1)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1), (fixed, 1)])), [(iono, 1), (fixed, 1)]))
    ok(handover(misty, loan))
    ok(handover(ash, loan))
    ok(start_return(ash, loan, [(iono, 1)]))
    ok(reassign(misty, binder, iono, fixed, 1))
    # One line, one Borrowed Copy row and one pending return line for the replacement, their counts added together.
    assert lines(ash, loan) == [(fixed, '2', '2')]
    assert borrowed(loan) == {(node(ash, 'Unsorted')['id'], fixed): 1}
    assert [(line['edition_id'], line['copies']) for line in view(misty, loan)['pending_return']['lines']] == [
        (fixed, '1')]
    # The copy back is the replacement: her reassigned copy and the returned one.
    ok(confirm_return(misty, loan))
    assert holding(misty, binder, fixed)['quantity'] == '2'


def test_a_reassignment_racing_the_other_sides_step_on_the_loan_waits_and_never_deadlocks(store):
    # Ash's id sorts first. His return holds his owner row and the Loan row; Misty's reassignment locks Ash's row
    # first, waits, then reads the Loan as his return left it and carries the return's line with it.
    iono, ash, misty, binders, loan, _ = lent_loan({'Binder': 3}, 2, ordered=True)
    fixed = replacement_for(iono)
    drop = _sleeping('borrowed_holding', 'DELETE', f"OLD.borrower_id = '{ash}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            given = executor.submit(start_return, ash, loan, [(iono, 2)])
            _asleep(watch, 1, [given])
            moved = executor.submit(reassign, misty, binders['Binder'], iono, fixed, 1)
            given, moved = given.result(), moved.result()
    finally:
        drop()
    assert given.status_code == 200, given.text
    assert moved.status_code == 200, moved.text
    assert lines(misty, loan) == [(fixed, '2', '2')]
    assert view(misty, loan)['pending_return']['lines'] == [{'edition_id': fixed, 'copies': '2'}]
    ok(confirm_return(misty, loan))
    assert holding(misty, binders['Binder'], fixed)['quantity'] == '3'
