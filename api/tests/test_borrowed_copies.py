"""Borrowed Copies across the app (social network #254, spec "Inventory touch-points"), through signed HTTP against
PostgreSQL.

A Borrowed Copy behaves like an owned copy inside the borrower's Deck: it fills that Deck's lines (under either counting
setting, for that Deck only), counts in its checks, contents, capture and cost, reads "from Misty W." on its line and
grows its Deck List exactly as an owned copy does, through the one shared SQL rule. It is never spare, Surplus,
offered, owned or counted in the Collection, and it moves only through its own route. Lent copies count as owned in the
catalog and as lent, never as not owned, on the lender's Deck.

Every test seeds the Swap catalog (Iono PAL 185, PAL 254 and PAF 80; Arven SVI 166) and starts new collectors.
"""
from uuid import UUID, uuid4

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.copy_allocation import allocate, available_to
from app.deck_list_capture import capture_deck_list
from app.import_replace import read_replaced, replacement
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import body_of, cost, launches, store  # noqa: F401  (autouse fixtures)
from test_batch_add import undo, undo_records
from test_deck_counting import counting, deck, detail, hold, line
from test_friend_copies import copies, node, ok, place
from test_handover import borrowed, handover
from test_holdings import call
from test_loan_promises import holding, remove
from test_loans import accept, pair, sent, view
from test_want_list import section, want_list
from want_list_swap_fixtures import seed_swap_catalog


def lend(ash, misty, edition, count, deck_id=None):
    """Misty W. lends Ash K. ``count`` copies of ``edition`` from a new Binder, into ``deck_id`` (None: Unsorted), and
    both confirm the handover."""
    binder = place(misty, f'Binder {uuid4().hex[:6]}')
    hold(misty, binder, edition, count)
    extra = {'deck_id': deck_id} if deck_id else {}
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(edition, count)], **extra)), [(edition, count)]))
    ok(handover(misty, loan))
    ok(handover(ash, loan))
    return loan


def lines_of(owner, deck_id):
    return {entry['edition_id']: entry['quantity'] for entry in detail(owner, deck_id)['deck_list']['lines']}


def move(owner, loan, edition, source, target, count, key=None):
    return call('POST', '/api/loans/borrowed/move', owner, {
        'loan_id': loan['id'], 'edition_id': edition, 'from_location_id': source, 'to_location_id': target,
        'quantity': str(count), 'idempotency_key': str(key or uuid4())})


def code(response):
    return response.status_code, response.json()['detail']['code']


def test_borrowed_copies_fill_the_lines_of_the_deck_they_are_in_and_no_other_under_either_setting(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    charizard, gardevoir = deck(ash, 'Charizard', 0), deck(ash, 'Gardevoir', 1)
    arven = ids['SVI 166']
    hold(ash, charizard, arven, 1)
    line(ash, charizard, iono, 2)
    line(ash, gardevoir, iono, 1)
    lend(ash, misty, iono, 2, charizard)
    for setting in ('all_at_once', 'one_at_a_time'):
        counting(ash, setting)
        shown = detail(ash, charizard)
        assert shown['to_get'] == '0', setting
        owned = {entry['edition_id']: entry for entry in shown['ownership']}[iono]
        assert (owned['in_deck'], owned['elsewhere'], owned['lent'], owned['not_owned']) == ('2', '0', '0', '0')
        assert {entry['edition_id']: entry['in_deck'] for entry in shown['deck_list']['lines']} == {iono: '2', arven: '1'}
        assert shown['loans'] == [{'edition_id': iono, 'reserved': [], 'lent': [],
                                   'borrowed': [{'name': 'Misty W.', 'copies': '2'}]}]
        assert shown['checks']['total'] == '3'
        assert section(want_list(ash), charizard)['lines'] == []
        # Gardevoir never counts Charizard's Borrowed Copies, even One Deck at a time.
        [wanted] = section(want_list(ash), gardevoir)['lines']
        assert (wanted['need'], wanted['borrowed'], wanted['spare'], wanted['other_decks']) == ('1', '0', '0', '0')
        assert detail(ash, gardevoir)['to_get'] == '1', setting
    index = {entry['id']: entry for entry in ok(call('GET', '/api/decks', ash))['decks']}
    assert (index[charizard]['deck_list_total'], index[charizard]['in_deck']) == ('3', '3')
    contents = ok(call('GET', f'/api/decks/{charizard}/contents', ash))['editions']
    assert sorted((entry['edition_id'], entry['quantity']) for entry in contents) == sorted([(iono, '2'), (arven, '1')])
    captured = capture_deck_list(UUID(charizard), ash)
    assert ({str(edition): count for edition, count in captured.holdings.items()},
            [line.need for line in captured.lines]) == ({iono: 2, arven: 1}, [0, 0])
    # The Estimated Deck Cost counts them, and nothing is left to complete.
    costed = body_of(cost(charizard, user=ash))
    assert (costed['total_copies'], costed['cost_to_complete']['total_copies']) == ('3', '0')


def test_a_borrowed_copy_grows_a_deck_list_exactly_as_an_owned_copy_does(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    # One Deck takes owned copies and its twin the same copies borrowed: their Deck Lists come out the same.
    owned, lent = deck(ash, 'Owned', 0), deck(ash, 'Borrowed', 1)
    for deck_id in (owned, lent):
        hold(ash, deck_id, iono, 2)
    assert lines_of(ash, owned) == lines_of(ash, lent) == {iono: '2'}
    revision = detail(ash, lent)['deck_list']['revision']
    hold(ash, owned, iono, 1)
    hold(ash, owned, arven, 2)
    lend(ash, misty, iono, 1, lent)
    lend(ash, misty, arven, 2, lent)
    assert lines_of(ash, owned) == lines_of(ash, lent) == {iono: '3', arven: '2'}
    assert detail(ash, lent)['deck_list']['revision'] > revision
    # Copies arriving where the line already covers them change nothing; nor do copies leaving.
    line(ash, lent, iono, 4)
    loan = lend(ash, misty, iono, 1)
    unsorted = node(ash, 'Unsorted')['id']
    ok(move(ash, loan, iono, unsorted, lent, 1))
    assert lines_of(ash, lent)[iono] == '4'
    ok(move(ash, loan, iono, lent, unsorted, 1))
    assert lines_of(ash, lent)[iono] == '4'
    owned_lines = {entry['edition_id']: entry for entry in detail(ash, lent)['ownership']}
    assert owned_lines[iono]['in_deck'] == '3'


def test_borrowed_copies_are_never_spare_surplus_offered_owned_or_shown_to_friends(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    charizard = deck(ash, 'Charizard', 0)
    hold(ash, charizard, iono, 1)
    line(ash, charizard, iono, 1)
    loan = lend(ash, misty, iono, 2)
    unsorted = node(ash, 'Unsorted')['id']
    ok(move(ash, loan, iono, unsorted, charizard, 2))
    # The copies arriving raised the line to 3; cut it back so two Borrowed Copies sit beyond it.
    line(ash, charizard, iono, 1)
    shown = detail(ash, charizard)
    assert shown['surplus'] == [] and shown['ownership'][0]['in_deck'] == '1'
    whole = ok(call('GET', '/api/collection/holdings', ash))
    assert whole['totals']['copies'] == '1'
    assert next(item for item in ok(call('GET', '/api/location-tree', ash))['locations']
                if item['id'] == charizard)['copy_count'] == '1'
    assert ok(call('GET', '/api/location-tree', ash))['borrowed_copies'] == '2'
    with connect() as conn:
        found = allocate(conn, ash, [UUID(iono)], 'all_at_once')
        assert found.copies[UUID(iono)].spare == 0 and found.owned == {UUID(iono): 1}
        # Use cards I own offers a new Deck only Charizard's own copy, never a Borrowed one.
        offered = available_to(conn, ash, [UUID(iono)], 'one_at_a_time')
        assert offered.editions[UUID(iono)].elsewhere == ((UUID(charizard), 1),)
        # Replace's preview: only the owned copy would be Surplus.
        preview = replacement(read_replaced(conn, ash, UUID(charizard)), [])
        assert [(str(row.edition_id), row.quantity) for row in preview.surplus] == [(iono, '1')]
    # A Friend sees Ash's own copy only.
    assert copies(misty, [ash], [iono]) == {(ash, iono): (0, 1)}
    browse = ok(call('GET', f'/api/catalog/editions?deck_id={charizard}&q=Iono', ash))['editions']
    found_row = next(row for row in browse if row['edition_id'] == iono)
    assert (found_row['owned'], found_row['in_deck'], found_row['free']) == (1, 3, 0)
    # Swap hints never offer them: owned, the two beyond Charizard's line would be offered for another Iono. One Deck
    # at a time offers Charizard's own copy, and only that one.
    wanting = deck(ash, 'Wanting', 1)
    line(ash, wanting, ids['PAL 254'], 1)
    for setting, offered_copies in (('all_at_once', None), ('one_at_a_time', '1')):
        counting(ash, setting)
        [wanted] = section(want_list(ash), wanting)['lines']
        assert (wanted['need'], wanted['swap'] and wanted['swap']['count']) == ('1', offered_copies), setting
    # Inventory Removal and its Undo take and give back Ash's own copy only.
    removed = ok(remove(ash, charizard, iono, 1))
    assert borrowed(loan) == {(charizard, iono): 2}
    assert ok(undo(ash, removed['undo_id']))
    assert holding(ash, charizard, iono)['quantity'] == '1' and borrowed(loan) == {(charizard, iono): 2}
    assert all(entry['id'] != removed['undo_id'] for entry in undo_records(ash))


def test_the_lenders_catalog_counts_lent_copies_as_owned_and_the_deck_reads_them_lent(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    gardevoir = deck(misty, 'Gardevoir', 0)
    hold(misty, gardevoir, iono, 2)
    line(misty, gardevoir, iono, 3)
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    ok(handover(misty, loan))
    [owned] = detail(misty, gardevoir)['ownership']
    assert (owned['in_deck'], owned['elsewhere'], owned['lent'], owned['not_owned']) == ('1', '0', '1', '1')
    pick = ok(call('GET', f'/api/decks/{gardevoir}/pick-list', misty))
    assert pick['rows'] == []
    # Every copy of Arven lent out: still owned in the catalog, and the owned filter keeps it.
    lend(ash, misty, arven, 1)
    rows = {row['edition_id']: row for row in ok(call('GET', '/api/catalog/editions?owned=true', misty))['editions']}
    assert (rows[iono]['owned'], rows[arven]['owned']) == (2, 1)
    assert arven not in {row['edition_id'] for row in
                         ok(call('GET', '/api/catalog/editions?owned=true', ash))['editions']}


def test_borrowed_copies_move_between_the_borrowers_locations_only_through_their_route(store):
    ids = seed_swap_catalog()
    ash, misty = pair()
    iono = ids['PAL 185']
    loan = lend(ash, misty, iono, 3)
    unsorted = node(ash, 'Unsorted')['id']
    box = place(ash, 'Box')
    revision = ok(call('GET', '/api/location-tree', ash))['owner_revision']
    key = uuid4()
    moved = ok(move(ash, loan, iono, unsorted, box, 2, key))
    assert [(card['location_name'], card['copies'], card['lender']) for card in moved['cards']] == [
        ('Box', '2', 'Misty W.'), ('Unsorted', '1', 'Misty W.')]
    assert moved['copies'] == '3'
    assert borrowed(loan) == {(box, iono): 2, (unsorted, iono): 1}
    assert ok(call('GET', '/api/location-tree', ash))['owner_revision'] == revision + 1
    # The same key replays the answer and moves nothing more.
    assert ok(move(ash, loan, iono, unsorted, box, 2, key)) == moved and borrowed(loan)[(box, iono)] == 2
    assert ok(call('GET', '/api/loans/borrowed', ash)) == moved
    assert code(move(ash, loan, iono, unsorted, box, 2)) == (409, 'NOT_ENOUGH_BORROWED')
    assert code(move(ash, loan, iono, unsorted, node(misty, 'Unsorted')['id'], 1)) == (404, 'LOCATION_NOT_FOUND')
    assert code(move(misty, loan, iono, unsorted, node(misty, 'Unsorted')['id'], 1)) == (409, 'NOT_ENOUGH_BORROWED')
    # Never the borrower's own copies, and never in their Holdings.
    assert ok(call('GET', f'/api/holdings/{box}', ash))['holdings'] == []
    # A Location that holds only Borrowed Copies can't be deleted.
    found = node(ash, 'Box')
    refused = call('DELETE', f"/api/location-tree/{box}", ash,
                   {'version': found['version'], 'name': found['name'], 'idempotency_key': str(uuid4())})
    assert code(refused) == (409, 'LOCATION_NOT_EMPTY')
