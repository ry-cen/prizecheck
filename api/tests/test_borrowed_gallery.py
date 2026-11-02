"""Owner gallery and atomic Borrowed Moves, through signed HTTP against PostgreSQL (#473)."""
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode
from uuid import uuid4


from app import borrowed_gallery
from app.main import connect
from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import launches, store  # noqa: F401
from test_collection_listing_golden import hand_over, world
from test_friend_copies import befriend, collector, node, ok
from test_handover import handover
from test_holdings import call, add
from test_loans import accept, sent, view
from test_returns import confirm_return, start_return


def setup():
    owner, lender, editions, labels, box, deck = world()
    edition = editions['sv01/004']
    source = node(owner, 'Unsorted')['id']
    ok(add(lender, node(lender, 'Unsorted')['id'], edition, '6'))
    loan = hand_over(owner, lender, edition, 3)
    return owner, lender, edition, source, box, deck, loan


def read(owner, **params):
    return call('GET', '/api/collection/borrowed?' + urlencode(params), owner)


def item(loan, edition, source, count=1):
    return {'loan_id': loan['id'], 'edition_id': edition, 'from_location_id': source, 'quantity': str(count)}


def move(owner, destination, items, key=None):
    return call('POST', '/api/collection/borrowed/moves', owner,
                {'to_location_id': destination, 'items': items, 'idempotency_key': str(key or uuid4())})


def test_a_locations_borrowed_copies_list_with_their_lender_and_stay_out_of_its_counts(store):
    owner, lender, edition, source, box, _, loan = setup()
    before = ok(call('GET', '/api/collection/holdings?location_id=' + box, owner))['totals']
    ok(move(owner, box, [item(loan, edition, source, 2)]))
    body = ok(read(owner, location_id=box))
    assert body['total'] == '2'
    assert [(row['loan_id'], row['lender'], row['location_path'], row['set_code']) for row in body['copies']] == [
        (loan['id'], 'Misty W.', 'Shelf / Box', 'SVI')]
    assert body['copies'][0]['image_url']
    assert ok(call('GET', '/api/collection/holdings?location_id=' + box, owner))['totals'] == before


def test_all_owned_lists_every_borrowed_copy_and_its_totals_and_lent_stay_owned_only(store):
    owner, _, edition, source, box, _, loan = setup()
    before = ok(call('GET', '/api/collection/holdings', owner))
    ok(move(owner, box, [item(loan, edition, source)]))
    assert ok(read(owner))['total'] == '3'
    after = ok(call('GET', '/api/collection/holdings', owner))
    assert (before['totals'], before['lent']) == (after['totals'], after['lent'])


def test_two_loans_of_one_card_in_one_location_are_two_rows_by_lender(store):
    owner, _, edition, source, _, _, _ = setup()
    other, _ = collector('Brock B.')
    befriend(owner, other)
    ok(add(other, node(other, 'Unsorted')['id'], edition, '1'))
    hand_over(owner, other, edition, 1)
    rows = ok(read(owner, location_id=source))['copies']
    assert [row['lender'] for row in rows] == ['Brock B.', 'Misty W.']
    assert len({row['loan_id'] for row in rows}) == 2


def test_the_borrowed_read_takes_the_listing_search_and_filters(store):
    owner, _, edition, source, _, _, loan = setup()
    for params in ({'name': '_'}, {'set_id': 'sv01'}, {'category': 'Trainer'}, {'trainer_type': 'item'},
                   {'name': 'Under', 'set_id': 'sv01', 'category': 'Trainer', 'trainer_type': 'item'}):
        assert ok(read(owner, **params))['total'] == '3'
    for params in ({'name': '%'}, {'name': '!'}, {'elemental_type': 'Fire'}, {'set_id': 'sv02'}):
        assert ok(read(owner, **params))['total'] == '0'
    # Add a literal percent name, which must not broaden to every card.
    with connect() as conn:
        percent = str(conn.execute("SELECT e.id FROM catalog_edition e JOIN catalog_printing_display pd "
                                   "ON pd.printing_id=e.printing_id WHERE pd.display_name='Rate %'").fetchone()['id'])
    lender = view(owner, loan)['other']['collector_id']
    ok(add(lender, node(lender, 'Unsorted')['id'], percent, '1'))
    hand_over(owner, lender, percent, 1)
    assert [row['printing_name'] for row in ok(read(owner, name='%'))['copies']] == ['Rate %']


def test_the_borrowed_read_refuses_a_foreign_or_folder_location(store):
    owner, lender, _, _, _, _, _ = setup()
    foreign = node(lender, 'Unsorted')['id']
    folder = node(owner, 'Shelf')['id']
    assert read(owner, location_id=foreign).status_code == 404
    assert read(owner, location_id=folder).status_code == 409


def test_the_borrowed_read_refuses_past_its_cap(store, monkeypatch):
    owner, _, edition, source, box, deck, loan = setup()
    ok(move(owner, box, [item(loan, edition, source)]))
    monkeypatch.setattr(borrowed_gallery, 'BORROWED_GALLERY_CAP', 2)
    assert len(ok(read(owner))['copies']) == 2
    ok(move(owner, deck, [item(loan, edition, source)]))
    answer = read(owner)
    assert (answer.status_code, answer.json()['detail']['code']) == (409, 'TOO_MANY_BORROWED')


def test_both_listings_carry_one_snapshot_and_an_attribute_change_moves_it(store):
    owner, *_ = setup()
    before = ok(read(owner))['snapshot']
    assert before == ok(call('GET', '/api/collection/holdings', owner))['snapshot']
    with connect() as conn:
        conn.execute('SELECT catalog_advance_attribute_revision()')
    after = ok(read(owner))['snapshot']
    assert after != before
    assert after == ok(call('GET', '/api/collection/holdings', owner))['snapshot']


def test_the_set_filter_offers_borrowed_cards_sets_in_a_location_and_in_all_owned(store):
    owner, _, edition, source, box, _, loan = setup()
    # Empty the owned Box: the filter must still find the borrowed set there.
    with connect() as conn:
        conn.execute('DELETE FROM holding WHERE owner_id=%s AND location_id=%s', (owner, box))
    ok(move(owner, box, [item(loan, edition, source)]))
    for query in ('', '?location_id=' + box):
        assert 'sv01' in {row['set_id'] for row in ok(call('GET', '/api/collection/sets' + query, owner))['sets']}


def test_borrowed_copies_move_in_one_batch_with_one_revision_and_no_undo(store):
    owner, _, edition, source, box, deck, loan = setup()
    ok(move(owner, box, [item(loan, edition, source)]))
    before = ok(read(owner))['owner_revision']
    with connect() as conn:
        undo = conn.execute('SELECT count(*) AS n FROM inventory_undo WHERE owner_id=%s', (owner,)).fetchone()['n']
    result = ok(move(owner, deck, [item(loan, edition, source), item(loan, edition, box)]))
    assert result == {'copy_count': '2', 'owner_revision': before + 1}
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM inventory_undo WHERE owner_id=%s', (owner,)).fetchone()['n'] == undo


def test_a_batch_with_one_short_item_moves_nothing_and_names_it(store):
    owner, _, edition, source, box, deck, loan = setup()
    before = ok(read(owner))
    short = item(loan, edition, box)
    answer = move(owner, deck, [item(loan, edition, source), short])
    assert answer.status_code == 409
    assert answer.json()['detail'] == {'code': 'NOT_ENOUGH_BORROWED', **{k:v for k,v in short.items() if k != 'quantity'}}
    assert ok(read(owner)) == before


def test_a_batch_refuses_a_foreign_loan_and_a_foreign_source(store):
    owner, lender, edition, source, box, _, loan = setup()
    before = ok(read(owner))
    assert move(lender, node(lender, 'Unsorted')['id'], [item(loan, edition, source)]).json()['detail']['code'] == 'NOT_ENOUGH_BORROWED'
    assert move(owner, box, [item(loan, edition, node(lender, 'Unsorted')['id'])]).json()['detail']['code'] == 'NOT_ENOUGH_BORROWED'
    assert ok(read(owner)) == before


def test_a_batch_refuses_same_location_duplicates_and_a_foreign_or_folder_destination(store):
    owner, lender, edition, source, box, _, loan = setup()
    row = item(loan, edition, source)
    for destination, rows, code in ((source, [row], 'SAME_LOCATION'), (box, [row,row], 'DUPLICATE_MOVE_ITEM'),
                                   (node(lender, 'Unsorted')['id'], [row], 'LOCATION_NOT_FOUND'),
                                   (node(owner, 'Shelf')['id'], [row], 'LOCATION_NOT_FOUND')):
        assert move(owner, destination, rows).json()['detail']['code'] == code
    assert ok(read(owner))['total'] == '3'


def test_a_batch_replays_by_key_and_refuses_a_reused_key_with_other_items(store):
    owner, _, edition, source, box, _, loan = setup()
    key = uuid4()
    rows = [item(loan, edition, source)]
    first = ok(move(owner, box, rows, key))
    assert ok(move(owner, box, rows, key)) == first
    assert move(owner, box, [item(loan, edition, source, 2)], key).json()['detail']['code'] == 'IDEMPOTENCY_KEY_REUSED'
    assert ok(read(owner, location_id=box))['total'] == '1'


def test_two_concurrent_batches_with_one_key_move_once_and_answer_alike(store):
    owner, _, edition, source, box, _, loan = setup()
    key = uuid4()
    with ThreadPoolExecutor(max_workers=2) as pool:
        answers = list(pool.map(lambda _: move(owner, box, [item(loan, edition, source)], key), range(2)))
    assert ok(answers[0]) == ok(answers[1])
    assert ok(read(owner, location_id=box))['total'] == '1'


def test_a_batch_into_a_deck_raises_its_deck_list_line(store):
    owner, _, edition, source, _, deck, loan = setup()
    ok(move(owner, deck, [item(loan, edition, source, 3)]))
    body = ok(call('GET', f'/api/decks/{deck}', owner))
    assert next(row for row in body['deck_list']['lines'] if row['edition_id'] == edition)['quantity'] == '3'


def test_a_batch_racing_the_borrowers_return_confirmation_serialises(store):
    owner, lender, edition, source, box, _, loan = setup()
    ok(start_return(lender, loan, [(edition, 3)]))
    with ThreadPoolExecutor(max_workers=2) as pool:
        moved = pool.submit(move, owner, box, [item(loan, edition, source, 3)])
        returned = pool.submit(confirm_return, owner, loan)
        moved, returned = moved.result(), returned.result()
    ok(returned)
    assert moved.status_code == 200 or (moved.status_code == 409 and moved.json()['detail']['code'] == 'NOT_ENOUGH_BORROWED')
    assert ok(read(owner))['total'] == '0'


def test_a_batch_racing_a_handover_confirmation_of_another_loan_serialises(store):
    owner, lender, edition, source, _, deck, loan = setup()
    accepted = ok(accept(lender, view(lender, sent(owner, lender, [(edition, 2)], deck_id=deck)), [(edition, 2)]))
    ok(handover(lender, accepted))
    with ThreadPoolExecutor(max_workers=2) as pool:
        moved = pool.submit(move, owner, deck, [item(loan, edition, source)])
        arrived = pool.submit(handover, owner, accepted)
        ok(moved.result()); ok(arrived.result())
    assert ok(read(owner))['total'] == '5'
    assert ok(read(owner, location_id=deck))['total'] == '3'


def test_owned_commit_replays_by_key_even_with_an_expired_manifest(store):
    # The mixed operation must not re-stage after a lost commit response: replay precedes manifest validation.
    from test_moves import commit, selected, stage, start
    owner, _, edition, _, box, deck, _ = setup()
    before = ok(call('GET', '/api/collection/holdings?location_id=' + box, owner))
    row = next(row for row in before['holdings'] if row['edition_id'] == edition)
    manifest = start(owner, box)
    ok(stage(owner, manifest, [selected(edition, 1, row['version'])]))
    key = uuid4()
    first = ok(commit(owner, manifest, deck, key))
    with connect() as conn:
        conn.execute("""INSERT INTO move_manifest(owner_id,id,source_id,expires_at)
          VALUES (%s,%s,%s,now()-interval '1 hour')""", (owner, manifest, box))
    assert ok(commit(owner, manifest, deck, key)) == first
    after = ok(call('GET', '/api/collection/holdings?location_id=' + box, owner))
    assert int(next(row for row in after['holdings'] if row['edition_id'] == edition)['quantity']) == int(row['quantity']) - 1
