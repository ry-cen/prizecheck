"""Pick List and put-away (ADR 0009): suggested sources for Deck List copies stored elsewhere, confirming them as Moves
into the Deck, and putting surplus copies away. Exercised through the real routes over signed HTTP."""
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

from test_deck_list_moves import held
from test_deck_lists import change_line, code, deck_revision, detail, put_line, remove_line, states
from test_decks import create
from test_holdings import add, call, fixture
from test_moves import commit, edition_like, leaf, selected, stage, start


def pick_list(owner, deck):
    response = call('GET', f'/api/decks/{deck}/pick-list', owner)
    assert response.status_code == 200, response.text
    return response.json()


def confirm(owner, deck, items, revision, key=None):
    return call('POST', f'/api/decks/{deck}/pick-list/confirm', owner,
                {'items': items, 'deck_list_revision': revision, 'idempotency_key': str(key or uuid4())})


def item(source, edition, quantity, version):
    return {'source_id': source, 'edition_id': edition, 'quantity': str(quantity), 'expected_version': version}


def suggested(body, editions=None):
    """Confirm items for the suggested sources of the given rows, or of every row."""
    return [item(source['location_id'], row['edition_id'], source['suggested'], source['version'])
            for row in body['rows'] if editions is None or row['edition_id'] in editions
            for source in row['sources'] if source['suggested'] != '0']


def rows(body):
    return {row['edition_id']: row for row in body['rows']}


def plan(row):
    """Each source as (Location, kind, available, committed, suggested, warning short_by or None)."""
    return [(source['location_id'], source['kind'], source['available'], source['committed'], source['suggested'],
             source['warning'] and source['warning']['short_by']) for source in row['sources']]


def versions(owner, location):
    return {row['edition_id']: row['version'] for row in call('GET', f'/api/holdings/{location}', owner).json()['holdings']}


def ok(response):
    assert response.status_code == 200, response.text
    return response


def test_suggestions_take_loose_storage_from_the_fewest_locations_then_other_decks():
    owner, _, unsorted, _, edition, generation = fixture()
    few, owned, missing = (edition_like(edition, generation) for _ in range(3))
    deck = create(owner, 'Target').json()['location']['id']
    binder, attic, box = leaf(owner, 'Binder'), leaf(owner, 'attic'), leaf(owner, 'Box')
    spare_deck, built = (create(owner, name).json()['location']['id'] for name in ('Spare Deck', 'Built Deck'))
    # Built Deck holds 2 copies for its own line; Spare Deck holds 1 copy it no longer lists.
    put_line(owner, built, edition, '2')
    ok(add(owner, built, edition, '2'))
    put_line(owner, spare_deck, edition, '1')
    ok(add(owner, spare_deck, edition, '1'))
    ok(remove_line(owner, spare_deck, edition, deck_revision(owner, spare_deck)))
    for location, quantity in ((unsorted, '1'), (binder, '3'), (attic, '3')):
        ok(add(owner, location, edition, quantity))
    for location, quantity in ((unsorted, '1'), (binder, '1'), (box, '3')):
        ok(add(owner, location, few, quantity))
    put_line(owner, deck, edition, '11')
    put_line(owner, deck, few, '2')
    put_line(owner, deck, owned, '1')
    ok(add(owner, deck, owned, '1'))
    put_line(owner, deck, missing, '2')
    body = pick_list(owner, deck)
    # Only lines with copies elsewhere are picked; a line in the Deck or not owned at all is not.
    assert set(rows(body)) == {edition, few}
    row = rows(body)[edition]
    assert (row['quantity'], row['in_deck'], row['elsewhere'], row['not_owned']) == ('11', '0', '10', '1')
    # Loose storage first, largest first (ties by name); then another Deck's unlisted copy; then a Deck's own copies,
    # with a warning that taking them leaves it short.
    assert plan(row) == [(attic, 'storage_leaf', '3', '0', '3', None), (binder, 'storage_leaf', '3', '0', '3', None),
                         (unsorted, 'storage_leaf', '1', '0', '1', None), (spare_deck, 'deck', '1', '0', '1', None),
                         (built, 'deck', '2', '2', '2', '2')]
    assert row['sources'][-1]['warning'] == {'deck_id': built, 'name': 'Built Deck', 'short_by': '2'}
    # One Location holding enough copies is suggested alone; the smaller holdings stay available for overrides.
    assert plan(rows(body)[few]) == [(box, 'storage_leaf', '3', '0', '2', None), (binder, 'storage_leaf', '1', '0', '0', None),
                                     (unsorted, 'storage_leaf', '1', '0', '0', None)]
    # Every source carries its Holding version for confirming.
    for picked in body['rows']:
        for source in picked['sources']:
            assert source['version'] == versions(owner, source['location_id'])[picked['edition_id']]
    deck_body = detail(owner, deck)
    assert body['deck_id'] == deck and body['put_away'] == []
    assert body['deck_list_revision'] == deck_body['deck_list']['revision']
    assert body['owner_revision'] == deck_body['owner_revision']
    assert body['competition'] == deck_body['competition']


def test_another_decks_unlisted_copies_come_before_the_copies_it_needs():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner, 'Target').json()['location']['id']
    built, other = (create(owner, name).json()['location']['id'] for name in ('Deck A', 'Deck X'))
    # Deck A holds 2 copies, all for its own line; Deck X holds 3 for a line of 2, so one copy is beyond its line.
    put_line(owner, built, edition, '2')
    ok(add(owner, built, edition, '2'))
    put_line(owner, other, edition, '2')
    ok(add(owner, other, edition, '3'))
    ok(change_line(owner, other, edition, '2', deck_revision(owner, other)))
    put_line(owner, deck, edition, '1')
    # Deck X's copy beyond its line leaves Deck X whole, so it comes before any copy a Deck needs.
    assert plan(pick_list(owner, deck)['rows'][0]) == [(other, 'deck', '3', '2', '1', None),
                                                       (built, 'deck', '2', '2', '0', None)]
    ok(change_line(owner, deck, edition, '2', deck_revision(owner, deck)))
    body = pick_list(owner, deck)
    # The second copy comes from the Deck already being visited, with a warning that it leaves Deck X short.
    assert plan(body['rows'][0]) == [(other, 'deck', '3', '2', '2', '1'), (built, 'deck', '2', '2', '0', None)]
    assert body['rows'][0]['sources'][0]['warning'] == {'deck_id': other, 'name': 'Deck X', 'short_by': '1'}
    # Confirming takes the copies anyway; Deck X keeps its line and is now short.
    ok(confirm(owner, deck, suggested(body), body['deck_list_revision']))
    assert states(detail(owner, other))[edition][:2] == ('2', '1')
    assert states(detail(owner, deck)) == {edition: ('2', '2', '0', '0')}
    assert held(owner, built) == {edition: '2'}


def test_the_pick_list_is_private_and_empty_when_nothing_is_elsewhere():
    owner, other, unsorted, other_leaf, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    body = pick_list(owner, deck)
    assert body == {'deck_id': deck, 'deck_list_revision': 1, 'owner_revision': body['owner_revision'], 'rows': [],
                    'put_away': [], 'competition': []}
    # Another owner's copies are never a source.
    ok(add(other, other_leaf, edition, '4'))
    put_line(owner, deck, edition, '2')
    assert pick_list(owner, deck)['rows'] == []
    ok(add(owner, unsorted, edition, '1'))
    body = pick_list(owner, deck)
    assert [row['edition_id'] for row in body['rows']] == [edition]
    # Another owner's Deck, a Storage Leaf that is not a Deck and an unknown id are all not found.
    for target, user in ((deck, other), (unsorted, owner), (str(uuid4()), owner)):
        response = call('GET', f'/api/decks/{target}/pick-list', user)
        assert (response.status_code, code(response)) == (404, 'DECK_NOT_FOUND')
    response = confirm(other, deck, [item(other_leaf, edition, 1, versions(other, other_leaf)[edition])],
                       body['deck_list_revision'])
    assert (response.status_code, code(response)) == (404, 'DECK_NOT_FOUND')
    assert held(other, other_leaf) == {edition: '4'} and held(owner, deck) == {}


def test_surplus_is_listed_for_put_away_and_a_move_puts_it_away():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    shelf = leaf(owner, 'Shelf')
    put_line(owner, deck, edition, '5')
    ok(add(owner, deck, edition, '5'))
    ok(change_line(owner, deck, edition, '2', deck_revision(owner, deck)))
    body = pick_list(owner, deck)
    version = versions(owner, deck)[edition]
    assert body['rows'] == []
    assert body['put_away'] == [{'edition_id': edition, 'quantity': '3', 'version': version}]
    # Putting surplus away is an ordinary Move to a Location the collector chooses.
    manifest = start(owner, deck)
    assert stage(owner, manifest, [selected(edition, 3, version)]).status_code == 200
    ok(commit(owner, manifest, shelf))
    after = pick_list(owner, deck)
    assert after['put_away'] == [] and after['rows'] == []
    assert after['deck_list_revision'] == body['deck_list_revision']
    assert held(owner, shelf) == {edition: '3'} and held(owner, deck) == {edition: '2'}
    assert states(detail(owner, deck)) == {edition: ('2', '2', '0', '0')}


def test_confirming_one_row_moves_only_its_copies_and_leaves_the_deck_list_alone():
    owner, _, _, _, edition, generation = fixture()
    second = edition_like(edition, generation)
    deck = create(owner).json()['location']['id']
    binder = leaf(owner)
    ok(add(owner, binder, edition, '4'))
    ok(add(owner, binder, second, '2'))
    put_line(owner, deck, edition, '3')
    put_line(owner, deck, second, '2')
    body = pick_list(owner, deck)
    lines = detail(owner, deck)['deck_list']
    response = ok(confirm(owner, deck, suggested(body, {edition}), body['deck_list_revision']))
    assert response.json() == {'edition_count': 1, 'copy_count': '3', 'owner_revision': body['owner_revision'] + 1}
    assert held(owner, deck) == {edition: '3'}
    assert held(owner, binder) == {edition: '1', second: '2'}
    after = pick_list(owner, deck)
    assert set(rows(after)) == {second}
    # The line already needed these copies (migration 027), so neither it nor the revision changed.
    assert after['deck_list_revision'] == body['deck_list_revision']
    assert [(line['edition_id'], line['quantity']) for line in detail(owner, deck)['deck_list']['lines']] == [
        (line['edition_id'], line['quantity']) for line in lines['lines']]


def test_confirming_a_selection_moves_those_rows_from_several_sources_in_one_move():
    owner, _, unsorted, _, edition, generation = fixture()
    second, third = edition_like(edition, generation), edition_like(edition, generation)
    deck = create(owner).json()['location']['id']
    binder, box = leaf(owner, 'Binder'), leaf(owner, 'Box')
    ok(add(owner, binder, edition, '2'))
    ok(add(owner, box, second, '1'))
    ok(add(owner, unsorted, third, '1'))
    for card in (edition, second, third):
        put_line(owner, deck, card, '2' if card == edition else '1')
    body = pick_list(owner, deck)
    response = ok(confirm(owner, deck, suggested(body, {edition, second}), body['deck_list_revision']))
    assert response.json() == {'edition_count': 2, 'copy_count': '3', 'owner_revision': body['owner_revision'] + 1}
    assert held(owner, deck) == {edition: '2', second: '1'}
    assert held(owner, binder) == {} and held(owner, box) == {} and held(owner, unsorted) == {third: '1'}
    assert set(rows(pick_list(owner, deck))) == {third}


def test_confirming_all_rows_moves_every_suggested_copy_at_once():
    owner, _, unsorted, _, edition, generation = fixture()
    second = edition_like(edition, generation)
    deck = create(owner, 'Target').json()['location']['id']
    binder = leaf(owner, 'Binder')
    other = create(owner, 'Deck X').json()['location']['id']
    put_line(owner, other, edition, '1')
    ok(add(owner, other, edition, '1'))
    ok(add(owner, binder, edition, '2'))
    ok(add(owner, unsorted, second, '1'))
    put_line(owner, deck, edition, '3')
    put_line(owner, deck, second, '1')
    body = pick_list(owner, deck)
    items = suggested(body)
    assert {(entry['source_id'], entry['quantity']) for entry in items} == {(binder, '2'), (other, '1'), (unsorted, '1')}
    response = ok(confirm(owner, deck, items, body['deck_list_revision']))
    assert response.json() == {'edition_count': 2, 'copy_count': '4', 'owner_revision': body['owner_revision'] + 1}
    after = pick_list(owner, deck)
    assert after['rows'] == [] and after['deck_list_revision'] == body['deck_list_revision']
    assert states(detail(owner, deck)) == {edition: ('3', '3', '0', '0'), second: ('1', '1', '0', '0')}
    assert held(owner, other) == {} and states(detail(owner, other)) == {edition: ('1', '0', '1', '0')}


def test_a_source_override_moves_copies_from_the_chosen_locations():
    owner, _, unsorted, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    binder, box = leaf(owner, 'Binder'), leaf(owner, 'Box')
    for location, quantity in ((unsorted, '1'), (binder, '1'), (box, '3')):
        ok(add(owner, location, edition, quantity))
    put_line(owner, deck, edition, '2')
    body = pick_list(owner, deck)
    assert [entry['source_id'] for entry in suggested(body)] == [box]
    sources = {source['location_id']: source for source in body['rows'][0]['sources']}
    chosen = [item(location, edition, 1, sources[location]['version']) for location in (unsorted, binder)]
    ok(confirm(owner, deck, chosen, body['deck_list_revision']))
    assert held(owner, box) == {edition: '3'} and held(owner, unsorted) == {} and held(owner, binder) == {}
    assert held(owner, deck) == {edition: '2'}
    after = pick_list(owner, deck)
    assert after['rows'] == [] and after['deck_list_revision'] == body['deck_list_revision']
    # Taking more than the line needs is still a Move into the Deck: the line rises to cover the extra copy.
    ok(confirm(owner, deck, [item(box, edition, 1, versions(owner, box)[edition])], after['deck_list_revision']))
    assert detail(owner, deck)['deck_list'] == {'revision': after['deck_list_revision'] + 1,
                                                'lines': [{'edition_id': edition, 'quantity': '3', 'in_deck': '3'}]}


def test_stale_or_invalid_confirmations_change_nothing():
    owner, other, unsorted, other_leaf, edition, generation = fixture()
    second, unlisted = edition_like(edition, generation), edition_like(edition, generation)
    deck = create(owner).json()['location']['id']
    binder = leaf(owner, 'Binder')
    for location, card, quantity in ((binder, edition, '2'), (unsorted, edition, '2'), (unsorted, second, '1'),
                                     (binder, unlisted, '1')):
        ok(add(owner, location, card, quantity))
    put_line(owner, deck, edition, '4')
    put_line(owner, deck, second, '1')
    ok(add(other, other_leaf, edition, '1'))
    body = pick_list(owner, deck)
    items = suggested(body)
    revision = body['deck_list_revision']
    # A Holding that changed since the Pick List was read is stale, and no other source moves either.
    ok(add(owner, unsorted, edition, '1'))
    before = (held(owner, binder), held(owner, unsorted), held(owner, deck), call('GET', '/api/moves/undo', owner).json())
    response = confirm(owner, deck, items, revision)
    assert response.status_code == 409
    assert response.json()['detail'] == {'code': 'STALE_HOLDING', 'source_id': unsorted, 'edition_id': edition}
    current = pick_list(owner, deck)
    fresh = {(entry['source_id'], entry['edition_id']): entry for entry in suggested(current)}
    binder_version = versions(owner, binder)[edition]
    cases = [
        ([item(binder, edition, 3, binder_version)], revision, 409, 'INSUFFICIENT_QUANTITY'),
        (list(fresh.values()), revision + 1, 409, 'STALE_DECK_LIST'),
        ([item(binder, unlisted, 1, versions(owner, binder)[unlisted])], revision, 422, 'EDITION_NOT_ON_DECK_LIST'),
        ([item(deck, edition, 1, 1)], revision, 409, 'SAME_LOCATION'),
        ([item(other_leaf, edition, 1, versions(other, other_leaf)[edition])], revision, 404, 'LOCATION_NOT_FOUND'),
        ([item(str(uuid4()), edition, 1, 1) for _ in range(6)], revision, 422, 'TOO_MANY_PICK_SOURCES'),
        ([item(binder, edition, 1, binder_version)] * 2, revision, 422, 'DUPLICATE_MOVE_ITEM'),
        ([item(binder, edition, 0, binder_version)], revision, 422, 'INVALID_QUANTITY'),
    ]
    for chosen, deck_list_revision, status, expected in cases:
        response = confirm(owner, deck, chosen, deck_list_revision)
        assert (response.status_code, code(response)) == (status, expected), (expected, response.text)
    unknown = call('POST', f'/api/decks/{uuid4()}/pick-list/confirm', owner,
                   {'items': list(fresh.values()), 'deck_list_revision': revision, 'idempotency_key': str(uuid4())})
    assert unknown.status_code == 404 and code(unknown) == 'DECK_NOT_FOUND'
    assert (held(owner, binder), held(owner, unsorted), held(owner, deck), call('GET', '/api/moves/undo', owner).json()) == before
    assert pick_list(owner, deck)['owner_revision'] == current['owner_revision']
    # The re-read Pick List confirms.
    ok(confirm(owner, deck, list(fresh.values()), current['deck_list_revision']))
    assert held(owner, deck) == {edition: '4', second: '1'}


def test_a_confirmation_replays_by_its_idempotency_key():
    owner, _, unsorted, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    binder = leaf(owner)
    ok(add(owner, binder, edition, '3'))
    ok(add(owner, unsorted, edition, '1'))
    put_line(owner, deck, edition, '2')
    body = pick_list(owner, deck)
    items, key = suggested(body), uuid4()
    first = ok(confirm(owner, deck, items, body['deck_list_revision'], key))
    assert ok(confirm(owner, deck, items, body['deck_list_revision'], key)).json() == first.json()
    assert held(owner, deck) == {edition: '2'} and held(owner, binder) == {edition: '1'}
    assert pick_list(owner, deck)['owner_revision'] == first.json()['owner_revision']
    reused = confirm(owner, deck, [item(unsorted, edition, 1, versions(owner, unsorted)[edition])],
                     body['deck_list_revision'], key)
    assert reused.status_code == 409 and code(reused) == 'IDEMPOTENCY_KEY_REUSED'
    # Keys are shared with every inventory command: one used by a Move cannot confirm picks.
    move_key = uuid4()
    manifest = start(owner, binder)
    assert stage(owner, manifest, [selected(edition, 1, versions(owner, binder)[edition])]).status_code == 200
    ok(commit(owner, manifest, unsorted, move_key))
    reused = confirm(owner, deck, [item(unsorted, edition, 1, versions(owner, unsorted)[edition])],
                     body['deck_list_revision'], move_key)
    assert reused.status_code == 409 and code(reused) == 'IDEMPOTENCY_KEY_REUSED'


def test_each_source_of_a_confirmation_is_undone_like_an_ordinary_move():
    owner, _, unsorted, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    binder = leaf(owner, 'Binder')
    ok(add(owner, binder, edition, '2'))
    ok(add(owner, unsorted, edition, '1'))
    put_line(owner, deck, edition, '3')
    body = pick_list(owner, deck)
    ok(confirm(owner, deck, suggested(body), body['deck_list_revision']))
    entries = call('GET', '/api/moves/undo', owner).json()
    assert len(entries) == 2
    assert {(entry['action'], entry['source_id'], entry['destination_id']) for entry in entries} == {
        ('move', binder, deck), ('move', unsorted, deck)}
    restored = {binder: {edition: '2'}, unsorted: {edition: '1'}}
    newest = entries[0]
    ok(call('POST', f"/api/moves/undo/{newest['id']}", owner, {'idempotency_key': str(uuid4())}))
    remaining = binder if newest['source_id'] == unsorted else unsorted
    assert held(owner, newest['source_id']) == restored[newest['source_id']] and held(owner, remaining) == {}
    after = pick_list(owner, deck)
    assert rows(after)[edition]['elsewhere'] == restored[newest['source_id']][edition]
    ok(call('POST', f"/api/moves/undo/{entries[1]['id']}", owner, {'idempotency_key': str(uuid4())}))
    assert held(owner, binder) == restored[binder] and held(owner, unsorted) == restored[unsorted]
    assert held(owner, deck) == {}
    # Taking copies back out of the Deck leaves its line.
    assert detail(owner, deck)['deck_list'] == {'revision': body['deck_list_revision'],
                                                'lines': [{'edition_id': edition, 'quantity': '3', 'in_deck': '0'}]}


def test_concurrent_confirmations_of_the_same_copies_move_them_once():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    binder = leaf(owner)
    ok(add(owner, binder, edition, '4'))
    put_line(owner, deck, edition, '2')
    body = pick_list(owner, deck)
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(lambda _: confirm(owner, deck, suggested(body), body['deck_list_revision']), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert [code(response) for response in responses if response.status_code == 409] == ['STALE_HOLDING']
    assert held(owner, deck) == {edition: '2'} and held(owner, binder) == {edition: '2'}


def test_confirm_write_path_invariants_overflow_organization_sources_and_versions():
    owner, _, unsorted, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    ok(add(owner, unsorted, edition, '5'))
    put_line(owner, deck, edition, '5')
    # (a) Arriving copies that would pass the maximum quantity are refused and nothing moves.
    full = create(owner, 'Overflow Target').json()['location']['id']
    ok(add(owner, full, edition, str(2**63 - 3)))
    revision = pick_list(owner, full)['deck_list_revision']
    undo = call('GET', '/api/moves/undo', owner).json()
    response = confirm(owner, full, [item(unsorted, edition, 5, versions(owner, unsorted)[edition])], revision)
    assert (response.status_code, code(response)) == (409, 'QUANTITY_OVERFLOW'), response.text
    assert held(owner, unsorted) == {edition: '5'} and held(owner, full) == {edition: str(2**63 - 3)}
    assert call('GET', '/api/moves/undo', owner).json() == undo
    # (b) An organizational Location is never a source.
    organization = str(uuid4())
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Shelf Group','organization')",
                     (organization, owner))
    body = pick_list(owner, deck)
    response = confirm(owner, deck, [item(organization, edition, 1, 1)], body['deck_list_revision'])
    assert (response.status_code, code(response)) == (404, 'LOCATION_NOT_FOUND'), response.text
    assert held(owner, unsorted) == {edition: '5'}
    # (d) After a confirm, the source and Deck Holding versions equal the returned owner revision.
    chosen = [item(unsorted, edition, 2, versions(owner, unsorted)[edition])]
    result = ok(confirm(owner, deck, chosen, body['deck_list_revision'])).json()
    assert versions(owner, unsorted)[edition] == result['owner_revision']
    assert versions(owner, deck)[edition] == result['owner_revision']
    assert held(owner, unsorted) == {edition: '3'}


def test_a_confirmation_names_at_most_five_sources_and_keeps_all_their_undo_records():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    sources = [leaf(owner, f'Box {number}') for number in range(6)]
    for source in sources:
        ok(add(owner, source, edition, '1'))
    put_line(owner, deck, edition, '6')
    before = pick_list(owner, deck)
    revision = before['deck_list_revision']
    items = [item(source, edition, 1, versions(owner, source)[edition]) for source in sources]
    # A sixth source is refused and nothing is written.
    response = confirm(owner, deck, items, revision)
    assert (response.status_code, code(response)) == (422, 'TOO_MANY_PICK_SOURCES'), response.text
    assert held(owner, deck) == {} and pick_list(owner, deck)['owner_revision'] == before['owner_revision']
    assert call('GET', '/api/moves/undo', owner).json() == []
    # Exactly five sources move, and all five undo records remain listed.
    ok(confirm(owner, deck, items[:5], revision))
    entries = call('GET', '/api/moves/undo', owner).json()
    assert len(entries) == 5
    assert {entry['source_id'] for entry in entries} == set(sources[:5])
    assert {entry['destination_id'] for entry in entries} == {deck}


def test_a_stale_holding_is_reported_for_another_deck_as_a_source():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner, 'Target').json()['location']['id']
    donor = create(owner, 'Donor').json()['location']['id']
    put_line(owner, donor, edition, '2')
    ok(add(owner, donor, edition, '2'))
    put_line(owner, deck, edition, '1')
    body = pick_list(owner, deck)
    version = versions(owner, donor)[edition]
    ok(add(owner, donor, edition, '1'))
    response = confirm(owner, deck, [item(donor, edition, 1, version)], body['deck_list_revision'])
    assert response.status_code == 409
    assert response.json()['detail'] == {'code': 'STALE_HOLDING', 'source_id': donor, 'edition_id': edition}
    assert held(owner, donor) == {edition: '3'} and held(owner, deck) == {}
