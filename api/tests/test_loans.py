"""Borrow Requests and the Loans they become (social network #252): ``social.loans`` (``/api/social/loans``) and
``loan_inventory`` (``/api/loans``), through signed HTTP against PostgreSQL.

A borrower sends a Friend a Borrow Request for Card Edition lines, each capped at what the Friend could lend now. The
lender accepts all or part of it, which reserves the promised copies and makes the Loan Pick List (spares first), or
declines it; the borrower can withdraw it; either side can cancel an accepted Loan nobody has confirmed a handover for.
Both sides read the same Loan, and each reads its own Locations or Deck only through its own side.

Every test seeds the Swap catalog (Iono PAL 185, PAL 254 and PAF 80; Arven SVI 166) and starts new collectors.
"""
from pathlib import Path
from uuid import uuid4

from app.main import connect  # noqa: F401
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, detail, hold, line
from test_friend_copies import befriend, block, collector, copies, hide, node, ok, place
from test_holdings import call
from want_list_swap_fixtures import seed_swap_catalog


def send(borrower, lender, lines, **extra):
    return call('POST', '/api/loans', borrower, {
        'lender_id': lender, 'lines': [{'edition_id': edition, 'quantity': str(count)} for edition, count in lines],
        'idempotency_key': str(uuid4()), **extra})


def sent(borrower, lender, lines, **extra):
    return ok(send(borrower, lender, lines, **extra), 201)


def accept(lender, loan, promised, key=None):
    return call('POST', f"/api/loans/{loan['id']}/accept", lender, {
        'revision': loan['revision'], 'idempotency_key': str(key or uuid4()),
        'lines': [{'edition_id': edition, 'promised': str(count)} for edition, count in promised]})


def step(user, loan, action, key=None, revision=None):
    return call('POST', f"/api/social/loans/{loan['id']}/{action}", user,
                {'revision': revision or loan['revision'], 'idempotency_key': str(key or uuid4())})


def view(user, loan):
    return ok(call('GET', f"/api/social/loans/{loan['id']}", user))


def side(user, loan):
    return ok(call('GET', f"/api/loans/{loan['id']}/side", user))


def lines_of(body):
    return [(line['edition_id'], line['requested'], line['promised']) for line in body['lines']]


def revision_of(owner):
    return ok(call('GET', '/api/location-tree', owner))['owner_revision']


def pair(ordered=False):
    """Ash K. borrows from Misty W., Friends. ``ordered``: Ash's account id sorts below Misty's, so a step that locks
    both owners in ascending order locks Ash's row first, the order the lock tests need."""
    (ash, _), (misty, _) = collector(), collector()
    if ordered:
        ash, misty = sorted([ash, misty])
    for owner, name in ((ash, 'Ash K.'), (misty, 'Misty W.')):
        ok(call('PUT', '/api/profile/display-name', owner, {'display_name': name, 'idempotency_key': str(uuid4())}))
    befriend(ash, misty)
    return ash, misty


def test_a_request_reserves_nothing_until_the_lender_accepts_part_of_it(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    hold(misty, node(misty, 'Unsorted')['id'], ids['PAL 185'], 3)
    gyarados = deck(misty, 'Gyarados', 0)
    hold(misty, gyarados, ids['SVI 166'], 1)
    line(misty, gyarados, ids['SVI 166'], 1)
    charizard = deck(ash, 'Charizard', 0)
    loan = sent(ash, misty, [(ids['PAL 185'], 2), (ids['SVI 166'], 1)], deck_id=charizard, return_by='2099-01-31')
    assert (loan['kind'], loan['state'], loan['role'], loan['section'], loan['needs_you']) == (
        'borrow_request', 'requested', 'borrower', 'pending', False)
    assert loan['actions'] == ['withdraw', 'edit_and_resend']
    assert (loan['other']['collector_id'], loan['other']['display_name'], loan['return_by']) == (
        misty, 'Misty W.', '2099-01-31')
    assert lines_of(loan) == [(ids['PAL 185'], '2', '0'), (ids['SVI 166'], '1', '0')]
    # Nothing is reserved for an unanswered request: Ash still sees all of Misty's copies.
    assert copies(ash, [misty]) == {(misty, ids['PAL 185']): (3, 0), (misty, ids['SVI 166']): (0, 1)}
    asked = view(misty, loan)
    assert (asked['role'], asked['section'], asked['needs_you'], asked['actions']) == (
        'lender', 'needs_you', True, ['accept', 'decline'])
    assert asked['other']['display_name'] == 'Ash K.'
    assert side(misty, loan)['can_promise'] == [{'edition_id': ids['PAL 185'], 'available': '3'},
                                                {'edition_id': ids['SVI 166'], 'available': '1'}]
    before = revision_of(misty)
    accepted = ok(accept(misty, asked, [(ids['PAL 185'], 2), (ids['SVI 166'], 0)]))
    assert (accepted['state'], accepted['section'], accepted['needs_you'], accepted['actions']) == (
        'accepted', 'pending', False, ['confirm_handover', 'cancel', 'change_return_by'])
    assert lines_of(accepted) == [(ids['PAL 185'], '2', '2'), (ids['SVI 166'], '1', '0')]
    assert revision_of(misty) == before + 1
    # The promised copies are reserved: Ash sees one spare copy left; the line left out reserved nothing.
    assert copies(ash, [misty]) == {(misty, ids['PAL 185']): (1, 0), (misty, ids['SVI 166']): (0, 1)}
    assert side(misty, accepted)['picks'] == [
        {'edition_id': ids['PAL 185'], 'location_id': node(misty, 'Unsorted')['id'], 'name': 'Unsorted', 'path': 'Unsorted',
         'copies': '2', 'short': '0'}]
    assert view(ash, loan)['lines'] == accepted['lines']
    assert side(ash, loan)['deck']['id'] == charizard


def test_the_loan_pick_list_takes_spare_copies_first_and_the_largest_holding_first(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    small, large = place(misty, 'Binder A'), place(misty, 'Binder B')
    hold(misty, small, iono, 1)
    hold(misty, large, iono, 3)
    gardevoir = deck(misty, 'Gardevoir', 0)
    hold(misty, gardevoir, iono, 3)
    line(misty, gardevoir, iono, 2)
    loan = sent(ash, misty, [(iono, 6)])
    ok(accept(misty, view(misty, loan), [(iono, 6)]))
    picks = {pick['name']: pick['copies'] for pick in side(misty, loan)['picks']}
    # Loose copies, largest first, then the Deck's copy beyond its line, then one the Deck holds for its line.
    assert picks == {'Binder B': '3', 'Binder A': '1', node(misty, gardevoir)['name']: '2'}
    # A second Loan takes only copies no other pick takes.
    (brock, _) = collector('Brock S.')
    befriend(brock, misty)
    second = sent(brock, misty, [(iono, 1)])
    ok(accept(misty, view(misty, second), [(iono, 1)]))
    assert [(pick['name'], pick['copies']) for pick in side(misty, second)['picks']] == [
        (node(misty, gardevoir)['name'], '1')]
    # Every copy is promised now; the Deck still counts its own copies until handover.
    assert copies(ash, [misty]) == {}
    assert detail(misty, gardevoir)['to_get'] == '0'


def test_a_deck_line_reads_reserved_for_the_borrower_while_the_copies_stay_in_the_deck(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    gardevoir = deck(misty, 'Gardevoir', 0)
    hold(misty, gardevoir, iono, 2)
    line(misty, gardevoir, iono, 2)
    assert detail(misty, gardevoir)['loans'] == []
    loan = sent(ash, misty, [(iono, 1)])
    # A request reserves nothing, so the line reads nothing yet.
    assert detail(misty, gardevoir)['loans'] == []
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    found = detail(misty, gardevoir)
    assert found['loans'] == [{'edition_id': iono, 'reserved': [{'name': 'Ash K.', 'copies': '1'}], 'lent': [],
                               'borrowed': []}]
    # The copies stay in the Deck and count for it: nothing to get, and the Deck List line is whole.
    assert found['to_get'] == '0' and [entry['in_deck'] for entry in found['deck_list']['lines']] == ['2']
    # A Display Name change reaches the label and the Loan.
    ok(call('PUT', '/api/profile/display-name', ash, {'display_name': 'Ash Ketchum', 'idempotency_key': str(uuid4())}))
    assert detail(misty, gardevoir)['loans'][0]['reserved'] == [{'name': 'Ash Ketchum', 'copies': '1'}]
    assert view(misty, loan)['other']['display_name'] == 'Ash Ketchum'


def test_decline_withdraw_and_cancel_end_a_loan_and_release_what_it_reserved(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, node(misty, 'Unsorted')['id'], iono, 2)
    declined = ok(step(misty, view(misty, sent(ash, misty, [(iono, 1)])), 'decline'))
    assert (declined['state'], declined['closed_reason'], declined['closed_by'], declined['section']) == (
        'closed', 'declined', 'you', 'history')
    told = view(ash, declined)
    assert (told['closed_by'], told['actions']) == ('them', ['edit_and_resend'])
    withdrawn = ok(step(ash, sent(ash, misty, [(iono, 1)]), 'withdraw'))
    assert (withdrawn['closed_reason'], withdrawn['closed_by']) == ('withdrawn', 'you')
    # Cancel, by the borrower: the reservation goes and the lender's revision moves.
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 2)])), [(iono, 2)]))
    assert copies(ash, [misty]) == {}
    before = revision_of(misty)
    cancelled = ok(step(ash, view(ash, loan), 'cancel'))
    assert (cancelled['closed_reason'], cancelled['closed_by'], cancelled['actions']) == (
        'cancelled', 'you', ['edit_and_resend'])
    assert copies(ash, [misty]) == {(misty, iono): (2, 0)}
    assert revision_of(misty) == before + 1
    assert side(misty, cancelled)['picks'] == []
    # Cancel, by the lender.
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    assert ok(step(misty, loan, 'cancel'))['closed_by'] == 'you'
    assert copies(ash, [misty]) == {(misty, iono): (2, 0)}


def test_a_step_names_the_revision_it_read_and_only_the_two_sides_may_take_the_steps_allowed(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    (stranger, _) = collector('Gary O.')
    iono = ids['PAL 185']
    hold(misty, node(misty, 'Unsorted')['id'], iono, 2)
    loan = sent(ash, misty, [(iono, 1)])
    for response in (call('GET', f"/api/social/loans/{loan['id']}", stranger),
                     call('GET', f"/api/loans/{loan['id']}/side", stranger),
                     step(stranger, loan, 'decline'), accept(stranger, loan, [(iono, 1)])):
        assert (response.status_code, response.json()['detail']['code']) == (404, 'LOAN_NOT_FOUND')
    assert step(ash, loan, 'decline').json()['detail']['code'] == 'STEP_NOT_ALLOWED'
    assert accept(ash, loan, [(iono, 1)]).json()['detail']['code'] == 'STEP_NOT_ALLOWED'
    assert step(misty, loan, 'withdraw').json()['detail']['code'] == 'STEP_NOT_ALLOWED'
    stale = step(misty, loan, 'decline', revision=loan['revision'] + 1)
    assert (stale.status_code, stale.json()['detail']['code']) == (409, 'LOAN_CHANGED')
    # A replay answers what the step answered, and is not taken again.
    key = uuid4()
    first = ok(accept(misty, loan, [(iono, 1)], key))
    assert ok(accept(misty, loan, [(iono, 1)], key)) == first
    assert copies(ash, [misty]) == {(misty, iono): (1, 0)}
    reused = accept(misty, loan, [(iono, 0)], key)
    assert (reused.status_code, reused.json()['detail']['code']) == (409, 'IDEMPOTENCY_KEY_REUSED')
    # An accepted request can't be withdrawn or accepted again.
    assert step(ash, first, 'withdraw').json()['detail']['code'] == 'STEP_NOT_ALLOWED'
    assert accept(misty, first, [(iono, 1)]).json()['detail']['code'] == 'STEP_NOT_ALLOWED'


def test_a_request_goes_only_to_a_friend_for_copies_they_could_lend_and_to_your_own_deck(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    (gary, _) = collector('Gary O.')
    iono = ids['PAL 185']
    hold(misty, node(misty, 'Unsorted')['id'], iono, 1)
    binder = place(misty, 'Secret Binder')
    hold(misty, binder, iono, 2)
    hide(misty, 'Secret Binder')

    def refused(response, status, code):
        assert (response.status_code, response.json()['detail']['code']) == (status, code), response.text
        return response.json()['detail']

    refused(send(ash, ash, [(iono, 1)]), 409, 'OWN_ACCOUNT')
    refused(send(gary, misty, [(iono, 1)]), 409, 'NOT_FRIENDS')
    refused(send(ash, misty, [(iono, 1), (iono, 1)]), 422, 'DUPLICATE_EDITION')
    refused(send(ash, misty, [(iono, 1)], return_by='2000-01-01'), 422, 'INVALID_RETURN_BY')
    refused(send(ash, misty, [(iono, 1)], deck_id=deck(misty, 'Not yours', 0)), 404, 'DECK_NOT_FOUND')
    refused(send(ash, misty, [(iono, 1)], deck_id=node(ash, 'Unsorted')['id']), 404, 'DECK_NOT_FOUND')
    # Copies in a hidden Location can't be asked for.
    assert refused(send(ash, misty, [(iono, 2)]), 409, 'NOT_LENDABLE') == {
        'code': 'NOT_LENDABLE', 'edition_id': iono, 'available': '1'}
    refused(send(ash, misty, [(ids['SVI 166'], 1)]), 409, 'NOT_LENDABLE')
    # After a Block nothing more can be sent.
    block(misty, ash)
    refused(send(ash, misty, [(iono, 1)]), 409, 'NOT_FRIENDS')


def test_accepting_promises_each_line_at_most_what_was_asked_and_what_the_lender_holds(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    unsorted = node(misty, 'Unsorted')['id']
    hold(misty, unsorted, iono, 2)
    hold(misty, unsorted, arven, 1)
    loan = view(misty, sent(ash, misty, [(iono, 2), (arven, 1)]))

    def code(response):
        return response.status_code, response.json()['detail']['code']

    assert code(accept(misty, loan, [(iono, 2)])) == (422, 'LINES_DONT_MATCH')
    assert code(accept(misty, loan, [(iono, 2), (arven, 1), (ids['PAL 254'], 1)])) == (422, 'LINES_DONT_MATCH')
    assert code(accept(misty, loan, [(iono, 3), (arven, 1)])) == (422, 'MORE_THAN_REQUESTED')
    assert code(accept(misty, loan, [(iono, 0), (arven, 0)])) == (422, 'NOTHING_PROMISED')
    # Another Loan took one Iono since: only one can be promised now, though the hidden copies would count.
    (brock, _) = collector('Brock S.')
    befriend(brock, misty)
    ok(accept(misty, view(misty, sent(brock, misty, [(iono, 1)])), [(iono, 1)]))
    short = accept(misty, loan, [(iono, 2), (arven, 1)])
    assert (short.status_code, short.json()['detail']) == (
        409, {'code': 'NOT_ENOUGH_COPIES', 'edition_id': iono, 'available': '1'})
    assert side(misty, loan)['can_promise'][0] == {'edition_id': iono, 'available': '1'}
    assert lines_of(ok(accept(misty, loan, [(iono, 1), (arven, 1)]))) == [(iono, '2', '1'), (arven, '1', '1')]


def test_edit_and_resend_replaces_the_unanswered_request_in_one_step(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, node(misty, 'Unsorted')['id'], iono, 3)
    first = sent(ash, misty, [(iono, 1)])
    second = sent(ash, misty, [(iono, 2)], replaces=first['id'])
    assert (view(ash, first)['state'], view(ash, first)['closed_reason']) == ('closed', 'withdrawn')
    assert lines_of(second) == [(iono, '2', '0')]
    ok(accept(misty, view(misty, second), [(iono, 2)]))
    # Only an unanswered request of yours to the same Friend can be replaced.
    for replaced in (second['id'], first['id'], str(uuid4())):
        response = send(ash, misty, [(iono, 1)], replaces=replaced)
        assert (response.status_code, response.json()['detail']['code']) == (409, 'LOAN_CHANGED')


def test_the_loans_tab_lists_open_loans_then_history_and_counts_what_needs_you(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    hold(misty, node(misty, 'Unsorted')['id'], iono, 3)
    waiting = sent(ash, misty, [(iono, 1)])
    accepted = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    closed = ok(step(ash, sent(ash, misty, [(iono, 1)]), 'withdraw'))
    tab = ok(call('GET', '/api/social/loans', misty))
    assert [(loan['id'], loan['section']) for loan in tab['loans']] == [
        (accepted['id'], 'pending'), (waiting['id'], 'needs_you'), (closed['id'], 'history')]
    assert tab['needs_you'] == 1
    mine = ok(call('GET', '/api/social/loans', ash))
    assert [loan['section'] for loan in mine['loans']] == ['pending', 'pending', 'history'] and mine['needs_you'] == 0
    assert ok(call('GET', '/api/social/loans', collector()[0])) == {'loans': [], 'needs_you': 0}


def test_loan_steps_have_an_hourly_limit_of_their_own(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    hold(misty, node(misty, 'Unsorted')['id'], ids['PAL 185'], 1)
    with connect() as conn:
        conn.execute("""INSERT INTO handle_lookup_event(user_id, kind, created_at)
          SELECT %s, 'loan_command', now() - interval '30 minutes' FROM generate_series(1, 120)""", (ash,))
    over = send(ash, misty, [(ids['PAL 185'], 1)])
    assert over.status_code == 429 and over.json()['detail'] == {'code': 'TOO_MANY_CHANGES', 'retry_after_minutes': 30}
    # Friend commands keep their own count.
    (gary, _) = collector('Gary O.')
    assert call('POST', '/api/social/friend-requests', ash,
                {'collector_id': gary, 'idempotency_key': str(uuid4())}).status_code == 200


def test_each_side_reads_its_own_locations_and_decks_and_never_the_others(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    binder = place(misty, 'Misty Private Binder')
    hold(misty, binder, iono, 2)
    misty_deck = deck(misty, 'Misty Water Deck', 0)
    hold(misty, misty_deck, iono, 1)
    ash_deck = deck(ash, 'Ash Secret Deck', 0)
    loan = sent(ash, misty, [(iono, 3)], deck_id=ash_deck)
    accepted = ok(accept(misty, view(misty, loan), [(iono, 3)]))
    lender_side, borrower_side = side(misty, loan), side(ash, loan)
    assert {pick['name'] for pick in lender_side['picks']} == {'Misty Private Binder', node(misty, misty_deck)['name']}
    assert borrower_side == {'loan_id': loan['id'], 'deck': {'id': ash_deck, 'name': node(ash, ash_deck)['name']},
                             'can_promise': [], 'picks': [], 'suggested': [], 'awaiting_choice': []}
    seen_by_ash = ' '.join(call(method, path, ash).text for method, path in (
        ('GET', '/api/social/loans'), ('GET', f"/api/social/loans/{loan['id']}"), ('GET', f"/api/loans/{loan['id']}/side")))
    seen_by_ash += str(loan)
    for secret in ('Misty Private Binder', binder, 'Misty Water Deck', misty_deck):
        assert secret not in seen_by_ash, secret
    seen_by_misty = ' '.join(call(method, path, misty).text for method, path in (
        ('GET', '/api/social/loans'), ('GET', f"/api/social/loans/{loan['id']}"), ('GET', f"/api/loans/{loan['id']}/side")))
    seen_by_misty += str(accepted)
    for secret in ('Ash Secret Deck', ash_deck):
        assert secret not in seen_by_misty, secret


def test_a_loan_outlives_both_collectors_accounts(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    hold(misty, node(misty, 'Unsorted')['id'], ids['PAL 185'], 1)
    loan = sent(ash, misty, [(ids['PAL 185'], 1)])
    # Each account deletion clears that side's id on the Loan; the second leaves both NULL and the names stay.
    for owner in (misty, ash):
        with connect() as conn:
            conn.execute('DELETE FROM inventory_owner WHERE user_id=%s', (owner,))
    with connect() as conn:
        row = conn.execute('SELECT lender_id, borrower_id, lender_name, borrower_name FROM loan WHERE id=%s',
                           (loan['id'],)).fetchone()
    assert row == {'lender_id': None, 'borrower_id': None, 'lender_name': 'Misty W.', 'borrower_name': 'Ash K.'}


def test_migration_107_gives_an_older_loan_table_the_check_both_deleted_accounts_pass(store):
    # A database that applied migration 105 before its check read <> has the IS DISTINCT FROM one; 107 replaces it,
    # and running 107 again changes nothing. Rolled back, so the table keeps its check.
    sql = (Path(__file__).resolve().parents[2] / 'migrations' / '107_loan_two_collectors.sql').read_text()
    check = """SELECT pg_get_constraintdef(oid) AS check FROM pg_constraint
      WHERE conrelid = 'loan'::regclass AND conname = 'loan_two_collectors'"""
    with connect() as conn, conn.transaction(force_rollback=True):
        conn.execute('ALTER TABLE loan DROP CONSTRAINT loan_two_collectors')
        conn.execute('ALTER TABLE loan ADD CONSTRAINT loan_two_collectors '
                     'CHECK (lender_id IS DISTINCT FROM borrower_id) NOT VALID')
        conn.execute(sql)
        assert conn.execute(check).fetchone()['check'] == 'CHECK ((lender_id <> borrower_id))'
        conn.execute(sql)
        assert conn.execute(check).fetchone()['check'] == 'CHECK ((lender_id <> borrower_id))'
