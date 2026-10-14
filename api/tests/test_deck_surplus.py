"""Surplus in the Deck read (app redesign #180): copies held in a Deck beyond its Deck List carry what the deck builder
draws and the Holding version its Put away Move needs, and putting them away is one ordinary Move with one Undo record.
Exercised through the real routes over signed HTTP."""
from test_deck_list_moves import deck_list, held, newest_undo, undo
from test_deck_lists import DISPLAY_FIELDS, change_line, deck_revision, detail, put_line, remove_line
from test_decks import create
from test_holdings import add, call, fixture
from test_moves import commit, edition_like, leaf, selected, stage, start


def ok(response):
    assert response.status_code == 200, response.text
    return response


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


def test_putting_surplus_away_is_one_move_and_its_undo_returns_the_copies_to_the_deck_list():
    owner, deck, edition, cut, _ = cut_deck()
    shelf = leaf(owner, 'Shelf')
    revision, lines = deck_list(owner, deck)
    assert lines == {edition: ('2', '2')}
    body = detail(owner, deck)
    manifest = start(owner, deck)
    ok(stage(owner, manifest, [selected(row['edition_id'], row['quantity'], row['version']) for row in body['surplus']]))
    result = ok(commit(owner, manifest, shelf)).json()
    assert (result['copy_count'], result['source_count'], result['edition_count']) == ('5', 1, 2)
    # One Undo record, the newest, names this Move.
    assert newest_undo(owner) == result['undo_id']
    assert held(owner, shelf) == {edition: '3', cut: '2'} and held(owner, deck) == {edition: '2'}
    # Moving copies out of a Deck never changes its Deck List.
    after = detail(owner, deck)
    assert after['surplus'] == [] and deck_list(owner, deck) == (revision, {edition: ('2', '2')})
    # Undo puts every copy back in the Deck. Copies arriving in a Deck join its Deck List (migration 031), so the cut
    # copies come back listed, not as surplus, and the Deck List revision advances (once per trigger statement: the
    # returning Holdings are one insert and one update here).
    undo(owner, result['undo_id'])
    assert held(owner, deck) == {edition: '5', cut: '2'} and held(owner, shelf) == {}
    restored, lines = deck_list(owner, deck)
    assert restored > revision and lines == {edition: ('5', '5'), cut: ('2', '2')}
    assert detail(owner, deck)['surplus'] == []
