"""The Decks index's rows (app redesign #181), through ``GET /api/decks``: each Deck carries its Deck List total, how many
of those copies the Deck holds, and its Target Format. The result in that Format and the cost to complete are the Deck's
own format-checks and cost reads (their own tests); the index never evaluates or prices a Deck."""
from uuid import uuid4

from test_decks import create
from test_holdings import add, call, fixture
from test_publications import list_cards

SUMMARY = ('deck_list_total', 'in_deck', 'target_format')


def rows(owner, cursor=None):
    response = call('GET', '/api/decks' + (f'?cursor={cursor}' if cursor else ''), owner)
    assert response.status_code == 200, response.text
    return response.json()


def summary(row):
    return {key: row[key] for key in SUMMARY}


def set_target(owner, deck, target):
    revision = call('GET', f'/api/decks/{deck}', owner).json()['deck_list']['revision']
    response = call('PUT', f'/api/decks/{deck}/deck-list/target-format', owner,
                    {'target_format': target, 'revision': revision, 'idempotency_key': str(uuid4())})
    assert response.status_code == 200, response.text


def test_each_row_carries_its_deck_list_total_the_copies_held_and_its_target_format():
    owner, other, _, _, edition, _ = fixture()
    alpha = create(owner, 'Alpha').json()['location']['id']
    beta = create(owner, 'Beta').json()['location']['id']
    # Three copies stored in Alpha (which lists them too, migration 031), then a Deck List of five: two still to gather.
    assert add(owner, alpha, edition, '3').status_code == 200
    list_cards(owner, alpha, {edition: 5})
    set_target(owner, beta, 'glc')

    body = rows(owner)
    found = {row['id']: row for row in body['decks']}
    assert summary(found[alpha]) == {'deck_list_total': '5', 'in_deck': '3', 'target_format': 'standard'}
    assert summary(found[beta]) == {'deck_list_total': '0', 'in_deck': '0', 'target_format': 'glc'}
    # The tree fields are as before.
    assert {key: found[alpha][key] for key in ('name', 'kind', 'parent_id', 'depth')} == \
        {'name': 'Alpha', 'kind': 'deck', 'parent_id': None, 'depth': 1}

    # Copies beyond the Deck List (surplus) never count: the Deck holds three, its list now names two.
    list_cards(owner, alpha, {edition: 2})
    assert summary({row['id']: row for row in rows(owner)['decks']}[alpha]) == \
        {'deck_list_total': '2', 'in_deck': '2', 'target_format': 'standard'}
    assert rows(other)['decks'] == []


def test_a_second_index_page_carries_the_same_fields():
    owner, _, _, _, edition, _ = fixture()
    for index in range(31):
        assert create(owner, f'Deck {index:02}').status_code == 201
    first = rows(owner)
    last = first['decks'][-1]
    assert summary(last) == {'deck_list_total': '0', 'in_deck': '0', 'target_format': 'standard'}
    second = rows(owner, first['next_cursor'])
    [only] = second['decks']
    assert only['name'] == 'Deck 30'
    assert summary(only) == {'deck_list_total': '0', 'in_deck': '0', 'target_format': 'standard'}
