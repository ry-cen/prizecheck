"""Surplus in the Deck read (app redesign #180): copies held in a Deck beyond its Deck List carry what the deck builder
draws and the Holding version its Put away Move needs, and putting them away is one Move with one Undo record, whose
Undo returns the copies as surplus (migration 047). Exercised through the real routes over signed HTTP."""
from uuid import uuid4

from test_deck_list_moves import deck_list, held, newest_undo, undo
from test_deck_lists import DISPLAY_FIELDS, change_line, deck_revision, detail, put_line, remove_line
from test_decks import create
from test_holdings import add, call, fixture
from test_moves import commit, edition_like, leaf, selected, stage, start


def ok(response):
    assert response.status_code == 200, response.text
    return response


def put_away(owner, manifest_id, destination, key=None):
    """Commits a Move marked as the deck builder's Put away."""
    return call('POST', f'/api/moves/manifests/{manifest_id}/commit', owner,
                {'destination_id': destination, 'idempotency_key': str(key or uuid4()), 'put_away': True})


def surplus(owner, deck):
    return {row['edition_id']: row['quantity'] for row in detail(owner, deck)['surplus']}


def staged_surplus(owner, deck):
    """A Move manifest from the Deck holding every surplus row at the Deck read's versions."""
    manifest = start(owner, deck)
    ok(stage(owner, manifest, [selected(row['edition_id'], row['quantity'], row['version'])
                               for row in detail(owner, deck)['surplus']]))
    return manifest


def versions(owner, location):
    return {row['edition_id']: row['version'] for row in call('GET', f'/api/holdings/{location}', owner).json()['holdings']}


def cut_deck():
    """A Deck holding 5 copies of ``edition`` listed at 2 (3 surplus) and 2 copies of ``cut`` whose line was removed
    (2 surplus), with each line's display data read while it was still listed."""
    owner, _, _, _, edition, generation = fixture()
    cut = edition_like(edition, generation)
    deck = create(owner).json()['location']['id']
    put_line(owner, deck, edition, '5')
    put_line(owner, deck, cut, '2')
    ok(add(owner, deck, edition, '5'))
    ok(add(owner, deck, cut, '2'))
    listed = {line['edition_id']: line for line in detail(owner, deck)['deck_list']['lines']}
    ok(change_line(owner, deck, edition, '2', deck_revision(owner, deck)))
    ok(remove_line(owner, deck, cut, deck_revision(owner, deck)))
    return owner, deck, edition, cut, listed


def test_surplus_rows_carry_display_data_and_the_holding_version():
    owner, deck, edition, cut, listed = cut_deck()
    body = detail(owner, deck)
    current = versions(owner, deck)
    rows = {row['edition_id']: row for row in body['surplus']}
    assert {edition: rows[edition]['quantity'], cut: rows[cut]['quantity']} == {edition: '3', cut: '2'}
    for row in body['surplus']:
        assert set(row) == {'edition_id', 'quantity', 'version'} | DISPLAY_FIELDS
        # The version is the Deck's Holding version, as Collection's Holdings read reports it.
        assert row['version'] == current[row['edition_id']]
        # A card cut from the list entirely still has its name, set, number, Variant and art.
        assert {field: row[field] for field in DISPLAY_FIELDS} == {
            field: listed[row['edition_id']][field] for field in DISPLAY_FIELDS}
    # Surplus never counts toward the Deck List.
    assert body['deck_list_checks']['total'] == '2'


def test_putting_surplus_away_is_one_move_and_its_undo_returns_the_copies_as_surplus():
    owner, deck, edition, cut, _ = cut_deck()
    shelf = leaf(owner, 'Shelf')
    revision, lines = deck_list(owner, deck)
    assert lines == {edition: ('2', '2')}
    result = ok(put_away(owner, staged_surplus(owner, deck), shelf)).json()
    assert (result['copy_count'], result['source_count'], result['edition_count']) == ('5', 1, 2)
    # One Undo record, the newest, names this Move.
    assert newest_undo(owner) == result['undo_id']
    assert held(owner, shelf) == {edition: '3', cut: '2'} and held(owner, deck) == {edition: '2'}
    # Moving copies out of a Deck never changes its Deck List.
    assert surplus(owner, deck) == {} and deck_list(owner, deck) == (revision, {edition: ('2', '2')})
    # Undo puts every copy back in the Deck as surplus: Deck List Undo and inventory Undo never undo each other, so
    # neither the cut line nor the removed one comes back, and the Deck List revision stays (migration 047).
    undo(owner, result['undo_id'])
    assert held(owner, deck) == {edition: '5', cut: '2'} and held(owner, shelf) == {}
    assert deck_list(owner, deck) == (revision, {edition: ('2', '2')})
    assert surplus(owner, deck) == {edition: '3', cut: '2'}


def test_an_unmarked_move_of_the_same_copies_still_lists_them_again_on_undo():
    """Only a Put away's Undo returns copies as surplus: Collection's ordinary Move out of a Deck keeps migration 031's
    rule, so its Undo covers the returned copies on the Deck List."""
    owner, deck, edition, cut, _ = cut_deck()
    shelf = leaf(owner, 'Shelf')
    revision, _ = deck_list(owner, deck)
    result = ok(commit(owner, staged_surplus(owner, deck), shelf)).json()
    undo(owner, result['undo_id'])
    assert held(owner, deck) == {edition: '5', cut: '2'}
    restored, lines = deck_list(owner, deck)
    assert restored > revision and lines == {edition: ('5', '5'), cut: ('2', '2')}
    assert surplus(owner, deck) == {}


def test_a_put_away_undo_replays_once_and_leaves_later_moves_into_the_deck_covered():
    owner, deck, edition, cut, _ = cut_deck()
    shelf = leaf(owner, 'Shelf')
    revision, _ = deck_list(owner, deck)
    result = ok(put_away(owner, staged_surplus(owner, deck), shelf)).json()
    key = uuid4()
    first = undo(owner, result['undo_id'], key)
    assert undo(owner, result['undo_id'], key).json() == first.json()
    assert held(owner, deck) == {edition: '5', cut: '2'}
    assert deck_list(owner, deck) == (revision, {edition: ('2', '2')})
    # The switch ends with the Undo's transaction: a copy moved into the Deck afterwards joins its Deck List again (only
    # that copy: the two surplus copies stay surplus, migration 031's rule).
    binder = leaf(owner, 'Binder')
    ok(add(owner, binder, cut, '1'))
    manifest = start(owner, binder)
    ok(stage(owner, manifest, [selected(cut, '1', versions(owner, binder)[cut])]))
    ok(commit(owner, manifest, deck))
    after, lines = deck_list(owner, deck)
    assert after > revision and lines[cut] == ('1', '1') and surplus(owner, deck) == {edition: '3', cut: '2'}


def test_put_away_is_refused_unless_it_moves_copies_out_of_one_deck():
    owner, deck, edition, cut, _ = cut_deck()
    shelf, binder = leaf(owner, 'Shelf'), leaf(owner, 'Binder')
    ok(add(owner, binder, edition, '2'))

    def refused(response):
        assert (response.status_code, response.json()['detail']['code']) == (422, 'PUT_AWAY_NEEDS_ONE_DECK'), response.text

    # From a Storage Leaf.
    manifest = start(owner, binder)
    ok(stage(owner, manifest, [selected(edition, '1', versions(owner, binder)[edition])]))
    refused(put_away(owner, manifest, shelf))
    # From a Deck and a Storage Leaf at once.
    manifest = call('POST', '/api/moves/manifests', owner, {}).json()['id']
    ok(stage(owner, manifest, [
        {**selected(edition, '1', versions(owner, deck)[edition]), 'source_id': deck},
        {**selected(edition, '1', versions(owner, binder)[edition]), 'source_id': binder}]))
    refused(put_away(owner, manifest, shelf))
    # As an Inventory Removal.
    manifest = staged_surplus(owner, deck)
    refused(call('POST', f'/api/moves/manifests/{manifest}/remove', owner,
                 {'idempotency_key': str(uuid4()), 'put_away': True}))
    # Nothing moved.
    assert held(owner, deck) == {edition: '5', cut: '2'} and held(owner, binder) == {edition: '2'}
    assert held(owner, shelf) == {}
