"""A Deck's cover card (#291) through signed HTTP against PostgreSQL.

``GET /api/decks`` gives each Deck a ``cover``: the card the collector picked with ``PUT /api/decks/{id}/cover``, or else
the Deck List line with the most copies (ties: a Pokémon, then the first name, then the lowest Edition id). The pick is a
``deck_cover`` row whose foreign key to the Deck List line clears it whenever the line leaves the Deck List. Setting or
clearing it moves no Deck List revision, Deck version or inventory revision. ``seed`` replaces the catalog, so these tests
live in their own file.
"""
import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

from app.main import connect
from test_attribute_corrections import seed
from test_card_attributes import BULBASAUR_ME, ENERGY_SV, STAGE_ONE, SWITCH_ME, edition_of
from test_catalog_references import migrate
from test_deck_lists import change_line, code, detail, remove_line
from test_decks import create
from test_holdings import call
from test_moves import leaf
from test_publications import list_cards

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = '052_deck_cover.sql'
BULBASAUR_ART = {**BULBASAUR_ME, 'image': 'https://assets.tcgdex.net/en/me/me01/001'}
CARDS = (BULBASAUR_ART, SWITCH_ME, ENERGY_SV, STAGE_ONE)


def collector():
    user = f'cover-{uuid4()}'
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (user,))
    return user


def new_deck(owner, name=None):
    return create(owner, name or f'Deck {uuid4()}').json()['location']['id']


def set_cover(owner, deck, edition, expected, key=None):
    return call('PUT', f'/api/decks/{deck}/cover', owner,
                {'edition_id': edition, 'expected_edition_id': expected, 'idempotency_key': str(key or uuid4())})


def index_cover(owner, deck):
    response = call('GET', '/api/decks', owner)
    assert response.status_code == 200, response.text
    return {entry['id']: entry['cover'] for entry in response.json()['decks']}[deck]


def cards():
    seed(*CARDS)
    return {'bulbasaur': edition_of('me01-001'), 'switch': edition_of('me01-130'),
            'energy': edition_of('sv02-278'), 'stage_one': edition_of('fixture-sv01-914')}


def test_an_empty_deck_has_no_cover_and_nothing_picked():
    cards()
    owner = collector()
    deck = new_deck(owner)
    assert detail(owner, deck)['cover_edition_id'] is None
    assert index_cover(owner, deck) is None


def test_the_automatic_cover_is_the_line_with_most_copies_then_a_pokemon_then_the_first_name():
    found = cards()
    owner = collector()
    cases = [({'energy': 10, 'bulbasaur': 4}, 'energy'),
             # A Pokémon beats "Basic..." alphabetically.
             ({'energy': 4, 'bulbasaur': 4}, 'bulbasaur'),
             ({'bulbasaur': 4, 'stage_one': 4, 'energy': 2}, 'bulbasaur'),
             # No Pokémon among the tied lines: by name.
             ({'switch': 4, 'energy': 4}, 'energy')]
    for quantities, expected in cases:
        deck = new_deck(owner)
        list_cards(owner, deck, {found[key]: count for key, count in quantities.items()})
        cover = index_cover(owner, deck)
        assert cover['edition_id'] == found[expected], quantities
        assert cover['name'] == {'energy': 'Basic Grass Energy', 'bulbasaur': 'Bulbasaur'}[expected]
        if expected == 'bulbasaur':
            assert cover['image_url'] == 'https://assets.tcgdex.net/en/me/me01/001/low.webp'
    deck = new_deck(owner)
    list_cards(owner, deck, {found['switch']: 4})
    assert index_cover(owner, deck)['image_url'] is None


def test_set_as_cover_picks_the_cover_and_clearing_it_returns_to_the_automatic_one():
    found = cards()
    owner = collector()
    deck = new_deck(owner)
    list_cards(owner, deck, {found['energy']: 51, found['switch']: 4, found['bulbasaur']: 1})
    detail(owner, deck)  # A first read may save its format result; measure after it.
    before = detail(owner, deck)
    revision, version, owner_revision = before['deck_list']['revision'], before['deck']['version'], before['owner_revision']
    assert index_cover(owner, deck)['edition_id'] == found['energy']

    response = set_cover(owner, deck, found['switch'], None)
    assert response.status_code == 200, response.text
    assert response.json() == {'deck_id': deck, 'cover_edition_id': found['switch']}
    assert detail(owner, deck)['cover_edition_id'] == found['switch']
    assert index_cover(owner, deck)['edition_id'] == found['switch']

    cleared = set_cover(owner, deck, None, found['switch'])
    assert cleared.status_code == 200, cleared.text
    assert cleared.json() == {'deck_id': deck, 'cover_edition_id': None}
    assert detail(owner, deck)['cover_edition_id'] is None
    assert index_cover(owner, deck)['edition_id'] == found['energy']

    after = detail(owner, deck)
    assert (after['deck_list']['revision'], after['deck']['version'], after['owner_revision']) == (
        revision, version, owner_revision)
    # Edits made with the values read before the cover commands are not stale.
    renamed = call('PATCH', f'/api/decks/{deck}', owner,
                   {'name': 'Renamed', 'version': version, 'idempotency_key': str(uuid4())})
    assert renamed.status_code == 200, renamed.text
    changed = change_line(owner, deck, found['switch'], '3', revision)
    assert changed.status_code == 200, changed.text


def test_the_cover_command_checks_the_expected_pick():
    found = cards()
    owner = collector()
    deck = new_deck(owner)
    list_cards(owner, deck, {found['energy']: 51, found['switch']: 4, found['bulbasaur']: 1})
    assert set_cover(owner, deck, found['switch'], None).status_code == 200
    stale = set_cover(owner, deck, found['bulbasaur'], None)
    assert (stale.status_code, code(stale)) == (409, 'STALE_DECK_COVER')
    assert detail(owner, deck)['cover_edition_id'] == found['switch']
    clearing = set_cover(owner, deck, None, None)
    assert (clearing.status_code, code(clearing)) == (409, 'STALE_DECK_COVER')
    assert detail(owner, deck)['cover_edition_id'] == found['switch']


def test_the_cover_command_is_idempotent_and_a_replay_answers_as_then():
    found = cards()
    owner = collector()
    deck = new_deck(owner)
    list_cards(owner, deck, {found['energy']: 51, found['switch']: 4, found['bulbasaur']: 1})
    key = uuid4()
    first = set_cover(owner, deck, found['switch'], None, key)
    assert first.status_code == 200, first.text
    second = set_cover(owner, deck, found['switch'], None, key)
    assert second.status_code == 200 and second.json() == first.json()
    assert set_cover(owner, deck, found['bulbasaur'], found['switch']).status_code == 200
    replay = set_cover(owner, deck, found['switch'], None, key)
    assert replay.status_code == 200 and replay.json() == first.json()
    reused = set_cover(owner, deck, found['bulbasaur'], None, key)
    assert (reused.status_code, code(reused)) == (409, 'IDEMPOTENCY_KEY_REUSED')


def test_the_cover_command_refuses_a_card_not_on_the_deck_list_and_anything_but_the_owners_deck():
    found = cards()
    owner, other = collector(), collector()
    deck = new_deck(owner)
    list_cards(owner, deck, {found['energy']: 51, found['switch']: 4})
    refused = set_cover(owner, deck, found['bulbasaur'], None)
    assert (refused.status_code, code(refused)) == (409, 'COVER_NOT_ON_DECK_LIST')
    assert detail(owner, deck)['cover_edition_id'] is None
    for target in (deck, leaf(owner), uuid4()):
        who = other if target == deck else owner
        missing = set_cover(who, target, found['switch'], None)
        assert (missing.status_code, code(missing)) == (404, 'DECK_NOT_FOUND')
    assert detail(owner, deck)['cover_edition_id'] is None
    body = call('PUT', f'/api/decks/{deck}/cover', owner,
                {'edition_id': found['switch'], 'idempotency_key': str(uuid4())})
    assert body.status_code == 422


def test_a_picked_card_that_leaves_the_deck_list_falls_back_and_is_not_restored():
    found = cards()
    owner = collector()
    deck = new_deck(owner)
    quantities = {found['energy']: 51, found['switch']: 4, found['bulbasaur']: 1}
    list_cards(owner, deck, quantities)
    assert set_cover(owner, deck, found['bulbasaur'], None).status_code == 200
    removed = remove_line(owner, deck, found['bulbasaur'], detail(owner, deck)['deck_list']['revision'])
    assert removed.status_code == 200, removed.text
    assert detail(owner, deck)['cover_edition_id'] is None
    assert index_cover(owner, deck)['edition_id'] == found['energy']
    list_cards(owner, deck, quantities)
    assert detail(owner, deck)['cover_edition_id'] is None
    assert index_cover(owner, deck)['edition_id'] == found['energy']


def test_migration_052_adds_deck_cover_and_runs_again():
    admin = os.environ.get('RECOVERY_TEST_DATABASE_URL')
    if not admin:
        pytest.skip('RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server')
    name = 'tcg_deck_cover_' + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before=MIGRATION)
        owner, deck = 'collector-' + uuid4().hex, uuid4()
        with psycopg.connect(url) as conn:
            identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,'Pikachu') "
                                    'RETURNING id', (str(uuid4()),)).fetchone()[0]
            printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',%s,%s) "
                                    'RETURNING id', (str(uuid4()), identity)).fetchone()[0]
            edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) "
                                   "VALUES (%s,'unspecified','{\"label\": \"Unspecified Variant\"}') RETURNING id",
                                   (printing,)).fetchone()[0]
            conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
            # The location trigger (migration 029) gives the Deck its Deck List.
            conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Built','deck')", (deck, owner))
            conn.execute('INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity) VALUES (%s,%s,%s,2)',
                         (owner, deck, edition))
        migrate(url)
        with psycopg.connect(url) as conn:
            conn.execute('INSERT INTO deck_cover(owner_id,deck_id,edition_id) VALUES (%s,%s,%s)', (owner, deck, edition))
            assert conn.execute('SELECT count(*) FROM deck_cover WHERE owner_id=%s', (owner,)).fetchone()[0] == 1
            # Running the migration again changes nothing.
            with conn.transaction():
                conn.execute((ROOT / 'migrations' / MIGRATION).read_text())
            assert conn.execute('SELECT count(*) FROM deck_cover WHERE owner_id=%s', (owner,)).fetchone()[0] == 1
            conn.execute('DELETE FROM deck_list_line WHERE owner_id=%s AND deck_id=%s', (owner, deck))
            assert conn.execute('SELECT count(*) FROM deck_cover WHERE owner_id=%s', (owner,)).fetchone()[0] == 0
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
