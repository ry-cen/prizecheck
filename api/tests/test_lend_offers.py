"""Lend Offers (social network #258), through signed HTTP against PostgreSQL.

The lender selects copies in their Collection and offers them to a Friend: sending reserves them at once, and the Loan
Pick List is the selected Holdings, so the same copies are never offered or promised twice. The borrower accepts all or
part (the rest is released, last pick first) into one of their Decks or Unsorted, or declines; the lender can
withdraw. Releasing copies moves the lender's revision. An offer nobody answered for 14 days nudges both sides once.
"""
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, hold
from test_friend_copies import collector, copies, node, ok, place
from test_handover import _asleep, _sleeping, borrowed, code, handover
from test_holdings import call
from test_loan_promises import remove
from test_loans import accept, pair, revision_of, sent, side, step, view
from want_list_swap_fixtures import seed_swap_catalog


def offer(lender, borrower, picks, **extra):
    """``picks``: (Location id, Edition id, copies), in the order selected."""
    return call('POST', '/api/loans/offers', lender, {
        'borrower_id': borrower, 'idempotency_key': str(uuid4()), **extra,
        'copies': [{'location_id': location, 'edition_id': edition, 'quantity': str(count)}
                   for location, edition, count in picks]})


def take(borrower, loan, lines, deck_id=None):
    return call('POST', f"/api/loans/{loan['id']}/accept-offer", borrower, {
        'revision': view(borrower, loan)['revision'], 'idempotency_key': str(uuid4()), 'deck_id': deck_id,
        'lines': [{'edition_id': edition, 'promised': str(count)} for edition, count in lines]})


def picks(owner, loan):
    return [(entry['location_id'], entry['copies']) for entry in side(owner, loan)['picks']]


def offering():
    """Misty W. holds Iono PAL 185: 2 in Binder A and 1 in Binder B; Ash K. is her Friend."""
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binders = {name: place(misty, name) for name in ('Binder A', 'Binder B')}
    hold(misty, binders['Binder A'], iono, 2)
    hold(misty, binders['Binder B'], iono, 1)
    return ids, iono, ash, misty, binders


def test_an_offer_reserves_the_selected_copies_where_they_are_as_soon_as_it_is_sent(store):
    ids, iono, ash, misty, binders = offering()
    before = revision_of(misty)
    loan = ok(offer(misty, ash, [(binders['Binder B'], iono, 1), (binders['Binder A'], iono, 1)],
                    return_by='2099-01-31'), 201)
    assert (loan['kind'], loan['state'], loan['role'], loan['section'], loan['actions'], loan['return_by']) == (
        'lend_offer', 'offered', 'lender', 'pending', ['withdraw'], '2099-01-31')
    assert [(line['edition_id'], line['requested'], line['promised']) for line in loan['lines']] == [(iono, '2', '2')]
    assert revision_of(misty) == before + 1
    assert picks(misty, loan) == [(binders['Binder A'], '1'), (binders['Binder B'], '1')]
    asked = view(ash, loan)
    assert (asked['role'], asked['needs_you'], asked['section'], asked['actions']) == (
        'borrower', True, 'needs_you', ['accept', 'decline'])
    # Reserved at once: Ash sees one spare copy left, Binder B's only copy can't be offered again, and a Removal
    # can't take copies the offer needs (a Location doesn't matter to a promise, so one copy may go).
    assert copies(ash, [misty]) == {(misty, iono): (1, 0)}
    refused = offer(misty, ash, [(binders['Binder B'], iono, 1)])
    assert refused.status_code == 409 and refused.json()['detail'] == {
        'code': 'NOT_ENOUGH_COPIES', 'edition_id': iono, 'available': '0'}
    assert remove(misty, binders['Binder A'], iono, 2).json()['detail']['code'] == 'PROMISED_TO_LOAN'
    # A Borrow Request accepted for the last free copy takes Binder A's, so nothing is left there to offer.
    request = sent(ash, misty, [(iono, 1)])
    ok(accept(misty, view(misty, request), [(iono, 1)]))
    assert code(offer(misty, ash, [(binders['Binder A'], iono, 1)])) == (409, 'NOT_ENOUGH_COPIES')


def test_the_borrower_accepts_part_of_an_offer_into_a_deck_and_the_last_picks_are_released(store):
    ids, iono, ash, misty, binders = offering()
    boss = ids['PAL 172']
    hold(misty, binders['Binder B'], boss, 2)
    loan = ok(offer(misty, ash, [(binders['Binder A'], iono, 2), (binders['Binder B'], iono, 1),
                                 (binders['Binder B'], boss, 2)]), 201)
    charizard = deck(ash, 'Charizard', 0)
    before = revision_of(misty)
    assert code(take(ash, loan, [(iono, 4), (boss, 2)])) == (422, 'MORE_THAN_OFFERED')
    assert code(take(ash, loan, [(iono, 0), (boss, 0)])) == (422, 'NOTHING_PROMISED')
    assert code(take(ash, loan, [(iono, 1)])) == (422, 'LINES_DONT_MATCH')
    assert code(take(ash, loan, [(iono, 1), (boss, 2)], str(uuid4()))) == (404, 'DECK_NOT_FOUND')
    assert code(take(misty, loan, [(iono, 1), (boss, 2)])) == (409, 'STEP_NOT_ALLOWED')
    # The lender's Accept route is not the borrower's.
    assert code(accept(ash, view(ash, loan), [(iono, 1), (boss, 2)])) == (409, 'STEP_NOT_ALLOWED')
    taken = ok(take(ash, loan, [(iono, 1), (boss, 0)], charizard))
    assert (taken['state'], taken['needs_you'], taken['actions']) == (
        'accepted', False, ['confirm_handover', 'cancel'])
    assert [(line['edition_id'], line['requested'], line['promised']) for line in taken['lines']] == [
        (iono, '3', '1'), (boss, '2', '0')]
    assert side(ash, loan)['deck']['id'] == charizard
    # Binder B's Iono (the last pick) and both Boss's Orders go back; one of Binder A's two stays reserved.
    assert picks(misty, loan) == [(binders['Binder A'], '1')]
    assert revision_of(misty) == before + 1
    assert copies(ash, [misty]) == {(misty, iono): (2, 0), (misty, boss): (2, 0)}
    ok(handover(misty, loan))
    ok(handover(ash, loan))
    assert borrowed(loan) == {(charizard, iono): 1}


def test_a_full_accept_releases_nothing_and_decline_or_withdraw_release_everything(store):
    ids, iono, ash, misty, binders = offering()
    loan = ok(offer(misty, ash, [(binders['Binder A'], iono, 2)]), 201)
    before = revision_of(misty)
    taken = ok(take(ash, loan, [(iono, 2)]))
    assert (taken['state'], revision_of(misty), side(ash, loan)['deck']) == ('accepted', before, None)
    assert picks(misty, loan) == [(binders['Binder A'], '2')]
    declined = ok(offer(misty, ash, [(binders['Binder B'], iono, 1)]), 201)
    before = revision_of(misty)
    gone = ok(step(ash, view(ash, declined), 'decline'))
    assert (gone['state'], gone['closed_reason'], gone['closed_by'], gone['actions']) == (
        'closed', 'declined', 'you', [])
    assert revision_of(misty) == before + 1 and picks(misty, declined) == []
    withdrawn = ok(offer(misty, ash, [(binders['Binder B'], iono, 1)]), 201)
    assert code(step(ash, view(ash, withdrawn), 'withdraw')) == (409, 'STEP_NOT_ALLOWED')
    before = revision_of(misty)
    gone = ok(step(misty, view(misty, withdrawn), 'withdraw'))
    assert (gone['state'], gone['closed_reason'], view(ash, withdrawn)['closed_by']) == ('closed', 'withdrawn', 'them')
    assert revision_of(misty) == before + 1
    assert copies(ash, [misty]) == {(misty, iono): (1, 0)}


def test_an_offer_is_refused_beyond_the_selected_holdings_or_to_anyone_but_a_friend(store):
    ids, iono, ash, misty, binders = offering()
    stranger, _ = collector('Brock S.')
    assert code(offer(misty, misty, [(binders['Binder A'], iono, 1)])) == (409, 'OWN_ACCOUNT')
    assert code(offer(misty, stranger, [(binders['Binder A'], iono, 1)])) == (409, 'NOT_FRIENDS')
    assert code(offer(misty, ash, [(binders['Binder A'], iono, 3)])) == (409, 'NOT_ENOUGH_COPIES')
    # Copies named twice count together.
    assert code(offer(misty, ash, [(binders['Binder B'], iono, 1), (binders['Binder B'], iono, 1)])) == (
        409, 'NOT_ENOUGH_COPIES')
    assert code(offer(misty, ash, [(node(ash, 'Unsorted')['id'], iono, 1)])) == (409, 'NOT_ENOUGH_COPIES')
    assert code(offer(misty, ash, [(binders['Binder A'], iono, 1)], return_by='2000-01-01')) == (
        422, 'INVALID_RETURN_BY')
    assert ok(offer(misty, ash, [(binders['Binder A'], iono, 2), (binders['Binder B'], iono, 1)]), 201)


def test_an_unanswered_offer_nudges_both_sides_once_after_14_days(store):
    ids, iono, ash, misty, binders = offering()
    loan = ok(offer(misty, ash, [(binders['Binder A'], iono, 1)]), 201)
    with connect() as conn:
        conn.execute("UPDATE loan SET created_at = now() - interval '14 days' WHERE id=%s", (loan['id'],))
    assert view(misty, loan)['notices'] == ['nudge'] and view(ash, loan)['notices'] == ['nudge']
    assert ok(call('POST', f"/api/social/loans/{loan['id']}/notices/seen", ash, {'kinds': ['nudge']}))['notices'] == []
    assert view(misty, loan)['notices'] == ['nudge']
    ok(take(ash, loan, [(iono, 1)]))
    assert view(misty, loan)['notices'] == []


def test_accepting_an_offer_waits_for_the_borrowers_deck_deletion_and_finds_the_deck_gone(store):
    # Ash's Deck deletion holds his owner row while it deletes the Deck. The accept locks his owner row before it
    # checks the Deck, so it waits and then finds the Deck gone: never a foreign-key error or a deadlock.
    ids, iono, ash, misty, binders = offering()
    loan = ok(offer(misty, ash, [(binders['Binder A'], iono, 1)]), 201)
    charizard = deck(ash, 'Charizard', 0)
    found = node(ash, charizard)
    body = {'revision': view(ash, loan)['revision'], 'idempotency_key': str(uuid4()), 'deck_id': charizard,
            'lines': [{'edition_id': iono, 'promised': '1'}]}
    drop = _sleeping('location', 'DELETE', "OLD.kind = 'deck'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            deleted = executor.submit(call, 'DELETE', f'/api/decks/{charizard}', ash,
                                      {'name': found['name'], 'version': found['version'],
                                       'idempotency_key': str(uuid4())})
            _asleep(watch, 1, [deleted])
            taken = executor.submit(call, 'POST', f"/api/loans/{loan['id']}/accept-offer", ash, body)
            deleted, taken = deleted.result(), taken.result()
    finally:
        drop()
    assert deleted.status_code == 200, deleted.text
    assert code(taken) == (404, 'DECK_NOT_FOUND')
    assert view(ash, loan)['state'] == 'offered'
    # And an accept that went first: the deletion waits for it, and the cards then go to Unsorted.
    charizard = deck(ash, 'Charizard 2', 0)
    found = node(ash, charizard)
    ok(take(ash, loan, [(iono, 1)], charizard))
    ok(call('DELETE', f'/api/decks/{charizard}', ash,
            {'name': found['name'], 'version': found['version'], 'idempotency_key': str(uuid4())}))
    assert side(ash, loan)['deck'] is None
