"""Display data on Deck List lines (app redesign #176, spec "Deck List contracts": Display data) over signed HTTP.

Every line in the Deck read and in every Deck List command response carries its Card Edition's name, set, collector
number, Variant Descriptor, image, card kind, Trainer Type, evolves from and Card Identity, so the deck builder draws a
line for a card the collector doesn't own without a second lookup. Card kind and Trainer Type are the effective card
attributes: a reviewed correction shows on the next read.

The catalog is imported through the real import (``seed``), so the attributes are derived the way a TCGdex pull derives
them. ``seed`` replaces the catalog, so these tests live in their own file.
"""
import json
from uuid import uuid4

import pytest

from app.main import connect
from test_attribute_corrections import decide, seed
from test_card_attributes import BULBASAUR_ME, ENERGY_SV, STAGE_ONE, SUPPORTER, SWITCH_ME, TOOL, edition_of
from test_deck_lists import add_line, change_line, detail, remove_line
from test_decks import create
from test_holdings import add, call
from test_moves import leaf

CARDS = (SUPPORTER, TOOL, STAGE_ONE, BULBASAUR_ME, SWITCH_ME, ENERGY_SV)
DISPLAY_FIELDS = ('name', 'set_id', 'set_name', 'collector_number', 'descriptor', 'image_url', 'card_kind',
                  'trainer_type', 'evolves_from', 'identity_id', 'identity_name', 'evolution_root', 'evolution_stage')
# What each card's line shows, by TCGdex id. The fixture records carry no image, so no line has artwork.
EXPECTED = {
    'fixture-sv01-910': {'name': 'Fixture Supporter', 'set_id': 'sv01', 'set_name': 'Scarlet & Violet',
                         'collector_number': '910', 'card_kind': 'trainer', 'trainer_type': 'supporter',
                         'evolves_from': None, 'identity_name': 'Fixture Supporter',
                         'evolution_root': None, 'evolution_stage': None},
    'fixture-sv01-912': {'name': 'Fixture Tool', 'set_id': 'sv01', 'set_name': 'Scarlet & Violet',
                         'collector_number': '912', 'card_kind': 'trainer', 'trainer_type': 'tool',
                         'evolves_from': None, 'identity_name': 'Fixture Tool',
                         'evolution_root': None, 'evolution_stage': None},
    'fixture-sv01-914': {'name': 'Fixture Stage 1', 'set_id': 'sv01', 'set_name': 'Scarlet & Violet',
                         'collector_number': '914', 'card_kind': 'pokemon', 'trainer_type': None,
                         'evolves_from': 'Fixture Basic', 'identity_name': 'Fixture Stage 1',
                         # Fixture Basic is not in this catalog, so the card is the root of its own line.
                         'evolution_root': 'Fixture Stage 1', 'evolution_stage': 0},
    'me01-001': {'name': 'Bulbasaur', 'set_id': 'me01', 'set_name': 'Mega Evolution', 'collector_number': '001',
                 'card_kind': 'pokemon', 'trainer_type': None, 'evolves_from': None, 'identity_name': 'Bulbasaur',
                 'evolution_root': 'Bulbasaur', 'evolution_stage': 0},
    # Switch's source names no Trainer Type: a Trainer of unknown type.
    'me01-130': {'name': 'Switch', 'set_id': 'me01', 'set_name': 'Mega Evolution', 'collector_number': '130',
                 'card_kind': 'trainer', 'trainer_type': None, 'evolves_from': None, 'identity_name': 'Switch',
                 'evolution_root': None, 'evolution_stage': None},
    'sv02-278': {'name': 'Basic Grass Energy', 'set_id': 'sv02', 'set_name': 'Paldea Evolved',
                 'collector_number': '278', 'card_kind': 'energy', 'trainer_type': None, 'evolves_from': None,
                 'identity_name': 'Basic Grass Energy', 'evolution_root': None, 'evolution_stage': None},
}


def collector():
    user = f"display-{uuid4()}"
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (user,))
    return user


def by_edition(deck_list):
    return {line['edition_id']: line for line in deck_list['lines']}


def shown(line):
    """A line's display data without the two fields checked separately (descriptor and Card Identity id)."""
    return {field: line[field] for field in DISPLAY_FIELDS if field not in ('descriptor', 'identity_id', 'image_url')}


def assert_display(deck_list, editions):
    """Every line in ``deck_list`` shows its card's display data; ``editions`` maps Edition id to TCGdex id."""
    lines = by_edition(deck_list)
    assert set(lines) == set(editions)
    for edition, source_id in editions.items():
        line = lines[edition]
        assert set(DISPLAY_FIELDS) <= set(line), line
        assert shown(line) == EXPECTED[source_id], source_id
        assert line['image_url'] is None
        assert line['descriptor'] == {'finish': 'normal'}


def test_every_line_in_the_deck_read_and_every_command_response_carries_display_data_owned_or_not():
    seed(*CARDS)
    owner = collector()
    deck = create(owner).json()['location']['id']
    editions = {edition_of(source_id): source_id for source_id in EXPECTED}
    # One card is owned elsewhere; every other line is for a card the collector doesn't own.
    supporter = edition_of('fixture-sv01-910')
    assert add(owner, leaf(owner), supporter, '1').status_code == 200
    revision, listed = 1, {}
    for edition, source_id in editions.items():
        response = add_line(owner, deck, edition, '2', revision)
        assert response.status_code == 200, response.text
        listed[edition] = source_id
        assert_display(response.json()['deck_list'], listed)
        revision = response.json()['deck_list']['revision']
    body = detail(owner, deck)
    assert_display(body['deck_list'], editions)
    # The Card Identity on each line is the one the basic four-copy check counts by.
    checked = {identity['identity_id']: identity['name'] for identity in body['deck_list_checks']['identities']}
    assert {line['identity_id']: line['identity_name'] for line in body['deck_list']['lines']} == checked
    changed = change_line(owner, deck, supporter, '3', revision)
    assert changed.status_code == 200, changed.text
    assert_display(changed.json()['deck_list'], editions)
    assert by_edition(changed.json()['deck_list'])[supporter]['quantity'] == '3'
    removed = remove_line(owner, deck, supporter, changed.json()['deck_list']['revision'])
    assert removed.status_code == 200, removed.text
    assert_display(removed.json()['deck_list'], {edition: source_id for edition, source_id in editions.items()
                                                 if edition != supporter})
    assert detail(owner, deck)['deck_list'] == removed.json()['deck_list']


def test_a_reviewed_trainer_type_correction_shows_on_the_next_read():
    found = seed(*CARDS)
    owner = collector()
    deck = create(owner).json()['location']['id']
    switch = edition_of('me01-130')
    assert add_line(owner, deck, switch, '4', 1).status_code == 200
    assert by_edition(detail(owner, deck)['deck_list'])[switch]['trainer_type'] is None
    response = decide(found['me01-130'], correction={'trainer_type': 'item'})
    assert response.status_code == 200, response.text
    line = by_edition(detail(owner, deck)['deck_list'])[switch]
    assert (line['card_kind'], line['trainer_type']) == ('trainer', 'item')


# What a response stored by an older release lacks: every display field (before #176), or the evolution root and stage
# (before migration 043).
STORED_WITHOUT = {'display data': DISPLAY_FIELDS, 'evolution roots': ('evolution_root', 'evolution_stage')}


@pytest.mark.parametrize('stored_without', sorted(STORED_WITHOUT))
@pytest.mark.parametrize('command', ['add', 'change', 'remove'])
def test_a_command_stored_by_an_older_release_replays_with_every_display_field(command, stored_without):
    seed(*CARDS)
    owner = collector()
    deck = create(owner).json()['location']['id']
    edition, other = edition_of('fixture-sv01-914'), edition_of('me01-001')
    # A second line keeps the response's lines non-empty even after a removal.
    assert add_line(owner, deck, other, '1', 1).status_code == 200
    if command != 'add':
        assert add_line(owner, deck, edition, '2', 2).status_code == 200
    key = uuid4()
    send = {'add': lambda: add_line(owner, deck, edition, '2', 2, key),
            'change': lambda: change_line(owner, deck, edition, '3', 3, key),
            'remove': lambda: remove_line(owner, deck, edition, 3, key)}[command]
    first = send()
    assert first.status_code == 200, first.text
    with connect() as conn:
        stored = conn.execute('SELECT response FROM location_command WHERE owner_id=%s AND request_key=%s',
                              (owner, key)).fetchone()['response']
        for line in stored['deck_list']['lines']:
            for field in STORED_WITHOUT[stored_without]:
                del line[field]
        conn.execute('UPDATE location_command SET response=%s WHERE owner_id=%s AND request_key=%s',
                     (json.dumps(stored), owner, key))
    replayed = send()
    assert replayed.status_code == 200, replayed.text
    assert replayed.json() == first.json()
    assert all(set(DISPLAY_FIELDS) <= set(line) for line in replayed.json()['deck_list']['lines'])
    # The replay changed nothing: the Deck List is still at the revision the first request made.
    assert detail(owner, deck)['deck_list']['revision'] == first.json()['deck_list']['revision']
