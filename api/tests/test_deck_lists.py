"""Deck Lists (ADR 0009): storage, revision-checked commands, conversion and basic checks, through signed HTTP."""
import json
import os
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

from test_catalog_references import migrate
from test_holdings import add, call, client, fixture
from test_decks import create
from test_moves import edition_like, leaf

MIGRATION = '025_deck_lists.sql'


def lines_path(deck, edition=None):
    return f'/api/decks/{deck}/deck-list/lines' + (f'/{edition}' if edition else '')


def add_line(owner, deck, edition, quantity, revision, key=None):
    return call('POST', lines_path(deck), owner, {'edition_id': edition, 'quantity': quantity, 'revision': revision,
                                                  'idempotency_key': str(key or uuid4())})


def change_line(owner, deck, edition, quantity, revision, key=None):
    return call('PATCH', lines_path(deck, edition), owner, {'quantity': quantity, 'revision': revision,
                                                            'idempotency_key': str(key or uuid4())})


def remove_line(owner, deck, edition, revision, key=None):
    return call('DELETE', lines_path(deck, edition), owner, {'revision': revision, 'idempotency_key': str(key or uuid4())})


def detail(owner, deck):
    response = call('GET', f'/api/decks/{deck}', owner)
    assert response.status_code == 200, response.text
    return response.json()


def code(response):
    return response.json()['detail']['code']


def test_a_new_deck_has_an_empty_deck_list_and_its_detail_is_private():
    owner, other, _, _, _, _ = fixture()
    deck = create(owner).json()['location']['id']
    body = detail(owner, deck)
    assert body['deck_list'] == {'revision': 1, 'lines': []}
    assert body['deck_list_checks']['total'] == '0' and body['deck_list_checks']['size_status'] == 'shortage'
    assert body['checks']['total'] == '0'
    assert body['deck_list_checks']['disclaimer'] == body['checks']['disclaimer']
    assert call('GET', f'/api/decks/{deck}', other).status_code == 404


def test_add_change_and_remove_lines_return_the_deck_list_with_in_deck_counts():
    owner, _, _, _, edition, generation = fixture()
    deck = create(owner).json()['location']['id']
    assert add(owner, deck, edition, '3').status_code == 200
    contents = call('GET', f'/api/decks/{deck}/contents', owner).json()
    not_owned = edition_like(edition, generation)
    added = add_line(owner, deck, edition, '4', 1)
    assert added.status_code == 200, added.text
    assert added.json() == {'deck_id': deck, 'deck_list': {'revision': 2, 'lines': [
        {'edition_id': edition, 'quantity': '4', 'in_deck': '3'}]}}
    second = add_line(owner, deck, not_owned, '2', 2).json()['deck_list']
    assert second['revision'] == 3
    assert {line['edition_id']: (line['quantity'], line['in_deck']) for line in second['lines']} == {
        edition: ('4', '3'), not_owned: ('2', '0')}
    assert [line['edition_id'] for line in second['lines']] == sorted([edition, not_owned])
    # Cutting below the held copies caps the in-this-Deck count at the line quantity.
    changed = change_line(owner, deck, edition, '2', 3)
    assert changed.status_code == 200, changed.text
    assert changed.json()['deck_list']['revision'] == 4
    assert {'edition_id': edition, 'quantity': '2', 'in_deck': '2'} in changed.json()['deck_list']['lines']
    removed = remove_line(owner, deck, not_owned, 4)
    assert removed.status_code == 200, removed.text
    assert removed.json()['deck_list'] == {'revision': 5, 'lines': [{'edition_id': edition, 'quantity': '2', 'in_deck': '2'}]}
    assert detail(owner, deck)['deck_list'] == removed.json()['deck_list']
    # Editing the Deck List never changes Holdings or the inventory revision.
    assert call('GET', f'/api/decks/{deck}/contents', owner).json() == contents


def test_commands_replay_and_reject_stale_revisions_reused_keys_and_bad_input():
    owner, _, _, _, edition, generation = fixture()
    deck = create(owner).json()['location']['id']
    key = uuid4()
    first = add_line(owner, deck, edition, '2', 1, key)
    assert first.status_code == 200, first.text
    # A retry replays the stored result even though its revision is now stale.
    assert add_line(owner, deck, edition, '2', 1, key).json() == first.json()
    for reused in (add_line(owner, deck, edition, '3', 1, key), change_line(owner, deck, edition, '3', 2, key)):
        assert reused.status_code == 409 and code(reused) == 'IDEMPOTENCY_KEY_REUSED'
    other_edition = edition_like(edition, generation)
    stale = add_line(owner, deck, other_edition, '1', 1)
    assert stale.status_code == 409 and code(stale) == 'STALE_DECK_LIST'
    for stale in (change_line(owner, deck, edition, '5', 1), remove_line(owner, deck, edition, 1)):
        assert stale.status_code == 409 and code(stale) == 'STALE_DECK_LIST'
    duplicate = add_line(owner, deck, edition, '1', 2)
    assert duplicate.status_code == 409 and code(duplicate) == 'DECK_LIST_LINE_EXISTS'
    missing = change_line(owner, deck, other_edition, '1', 2)
    assert missing.status_code == 404 and code(missing) == 'DECK_LIST_LINE_NOT_FOUND'
    missing = remove_line(owner, deck, other_edition, 2)
    assert missing.status_code == 404 and code(missing) == 'DECK_LIST_LINE_NOT_FOUND'
    for invalid in ('0', '-1', '1.5', '', '9223372036854775808'):
        for rejected in (add_line(owner, deck, other_edition, invalid, 2), change_line(owner, deck, edition, invalid, 2)):
            assert rejected.status_code == 422 and code(rejected) == 'INVALID_QUANTITY'
    assert call('POST', lines_path(deck), owner, {'edition_id': other_edition, 'quantity': '1', 'revision': 0,
                                                  'idempotency_key': str(uuid4())}).status_code == 422
    # Failed commands leave the Deck List untouched.
    assert detail(owner, deck)['deck_list'] == first.json()['deck_list']
    change_key, remove_key = uuid4(), uuid4()
    changed = change_line(owner, deck, edition, '9223372036854775807', 2, change_key)
    assert changed.json()['deck_list']['lines'][0]['quantity'] == '9223372036854775807'
    assert change_line(owner, deck, edition, '9223372036854775807', 2, change_key).json() == changed.json()
    removed = remove_line(owner, deck, edition, 3, remove_key)
    assert removed.json()['deck_list'] == {'revision': 4, 'lines': []}
    assert remove_line(owner, deck, edition, 3, remove_key).json() == removed.json()
    # Location commands and Deck List commands share one idempotency namespace per owner.
    create_key = uuid4()
    assert create(owner, 'Second', create_key).status_code == 201
    reused = add_line(owner, deck, edition, '1', 4, create_key)
    assert reused.status_code == 409 and code(reused) == 'IDEMPOTENCY_KEY_REUSED'


def test_commands_and_detail_are_owner_scoped_and_need_a_deck():
    owner, other, unsorted, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    for response in (add_line(other, deck, edition, '1', 1), change_line(other, deck, edition, '1', 1),
                     remove_line(other, deck, edition, 1), add_line(owner, unsorted, edition, '1', 1),
                     change_line(owner, unsorted, edition, '1', 1), remove_line(owner, unsorted, edition, 1),
                     add_line(owner, str(uuid4()), edition, '1', 1), change_line(owner, str(uuid4()), edition, '1', 1),
                     remove_line(owner, str(uuid4()), edition, 1)):
        assert response.status_code == 404 and code(response) == 'DECK_NOT_FOUND'
    # The same key belongs to each owner separately.
    key = uuid4()
    assert add_line(owner, deck, edition, '1', 1, key).status_code == 200
    theirs = create(other).json()['location']['id']
    assert add_line(other, theirs, edition, '1', 1, key).status_code == 200
    assert detail(owner, deck)['deck_list']['lines'][0]['quantity'] == '1'
    assert client.post(lines_path(deck), json={'edition_id': edition, 'quantity': '1', 'revision': 2,
                                               'idempotency_key': str(uuid4())}).status_code == 401


def test_adding_needs_an_available_edition_but_existing_lines_survive_deactivation():
    owner, _, _, _, edition, generation = fixture()
    deck = create(owner).json()['location']['id']
    assert add_line(owner, deck, edition, '1', 1).status_code == 200
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('UPDATE catalog_generation_edition SET active=false WHERE generation_id=%s AND edition_id=%s',
                     (generation, edition))
    inactive = edition_like(edition, generation)
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('UPDATE catalog_generation_edition SET active=false WHERE generation_id=%s AND edition_id=%s',
                     (generation, inactive))
    assert code(add_line(owner, deck, inactive, '1', 2)) == 'EDITION_UNAVAILABLE'
    assert code(add_line(owner, deck, str(uuid4()), '1', 2)) == 'EDITION_UNAVAILABLE'
    assert change_line(owner, deck, edition, '3', 2).status_code == 200
    assert remove_line(owner, deck, edition, 3).status_code == 200


def test_deck_list_checks_count_every_line_including_cards_not_owned():
    owner, _, _, _, first, generation = fixture()
    deck = create(owner).json()['location']['id']
    # Three Editions in two Printings share one Card Identity; none of them is owned.
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        printing, identity = conn.execute('SELECT p.id,p.identity_id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE e.id=%s', (first,)).fetchone()
        second = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'reverse','{\"finish\":\"reverse\"}') RETURNING id", (printing,)).fetchone()[0]
        other_printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',%s,%s) RETURNING id", (str(uuid4()), identity)).fetchone()[0]
        third = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'normal','{}') RETURNING id", (other_printing,)).fetchone()[0]
        conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,source_fingerprint,basic_energy)
          VALUES (%s,%s,%s,'other','Other Set','4','Pikachu','pikachu','test','not_basic')""", (generation, other_printing, str(uuid4())))
        conn.execute('INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s),(%s,%s,%s)', (generation, second, printing, generation, third, other_printing))
    revision = 1
    for edition, amount in ((first, '2'), (str(second), '1'), (str(third), '2')):
        response = add_line(owner, deck, edition, amount, revision)
        assert response.status_code == 200, response.text
        revision = response.json()['deck_list']['revision']
    body = detail(owner, deck)
    assert body['deck_list_checks']['total'] == '5' and body['deck_list_checks']['shortage'] == '55'
    assert len(body['deck_list_checks']['identities']) == 1
    assert body['deck_list_checks']['identities'][0]['quantity'] == '5' and body['deck_list_checks']['identities'][0]['status'] == 'over_limit'
    assert body['checks']['total'] == '0'
    assert all(line['in_deck'] == '0' for line in body['deck_list']['lines'])
    # Holdings that are not on the Deck List do not count.
    unlisted = edition_like(first, generation)
    assert add(owner, deck, unlisted, '7').status_code == 200
    body = detail(owner, deck)
    assert body['deck_list_checks']['total'] == '5' and body['checks']['total'] == '7'
    # The 60-card check follows line quantities.
    revision = change_line(owner, deck, first, '57', revision).json()['deck_list']['revision']
    assert detail(owner, deck)['deck_list_checks']['size_status'] == 'complete'
    change_line(owner, deck, first, '58', revision)
    checks = detail(owner, deck)['deck_list_checks']
    assert checks['total'] == '61' and checks['excess'] == '1' and checks['size_status'] == 'excess'
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute("UPDATE catalog_generation_printing SET basic_energy='unresolved' WHERE generation_id=%s", (generation,))
    assert detail(owner, deck)['deck_list_checks']['identities'][0]['status'] == 'unresolved'
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute("UPDATE catalog_generation_printing SET basic_energy='supported' WHERE generation_id=%s", (generation,))
    assert detail(owner, deck)['deck_list_checks']['identities'][0]['status'] == 'basic_energy_exempt'


def test_deck_list_lines_never_count_toward_the_collection():
    owner, _, unsorted, _, edition, generation = fixture()
    binder = leaf(owner)
    deck = create(owner).json()['location']['id']
    add(owner, binder, edition, '2')
    before = call('GET', '/api/collection', owner).json()
    distribution = call('GET', f'/api/collection/editions/{edition}', owner).json()
    not_owned = edition_like(edition, generation)
    revision = add_line(owner, deck, edition, '4', 1).json()['deck_list']['revision']
    add_line(owner, deck, not_owned, '3', revision)
    after = call('GET', '/api/collection', owner).json()
    assert after == before
    assert [(entry['edition_id'], entry['quantity']) for entry in after['entries']] == [(edition, '2')]
    assert call('GET', f'/api/collection/editions/{edition}', owner).json() == distribution
    assert call('GET', f'/api/collection/editions/{not_owned}', owner).json()['holdings'] == []


def test_a_deck_inserted_without_the_deck_route_still_gets_an_empty_deck_list():
    owner, _, _, _, edition, _ = fixture()
    deck = str(uuid4())
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Older application Deck','deck')", (deck, owner))
    assert detail(owner, deck)['deck_list'] == {'revision': 1, 'lines': []}
    assert add_line(owner, deck, edition, '1', 1).status_code == 200


def test_migration_converts_each_existing_deck_from_its_holdings(monkeypatch):
    admin = os.environ.get('RECOVERY_TEST_DATABASE_URL')
    if not admin:
        pytest.skip('RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server')
    name = 'tcg_decklist_migration_' + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before=MIGRATION)
        owner, other = 'collector-' + uuid4().hex, 'other-' + uuid4().hex
        built, empty, binder, theirs = (uuid4() for _ in range(4))
        with psycopg.connect(url) as conn:
            conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s),(%s)', (owner, other))
            identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES ('pikachu','Pikachu') RETURNING id").fetchone()[0]
            printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex','base-25',%s) RETURNING id", (identity,)).fetchone()[0]
            unspecified = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
              VALUES (%s,'unspecified',%s) RETURNING id""", (printing, json.dumps({'kind': 'unspecified', 'label': 'Unspecified Variant'}))).fetchone()[0]
            normal = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
              VALUES (%s,'normal','{"finish":"normal"}') RETURNING id""", (printing,)).fetchone()[0]
            for location, who, label, kind in ((built, owner, 'Built', 'deck'), (empty, owner, 'Planned', 'deck'),
                                               (binder, owner, 'Binder', 'storage_leaf'), (theirs, other, 'Theirs', 'deck')):
                conn.execute('INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,%s,%s)', (location, who, label, kind))
            for who, location, edition, quantity in ((owner, built, unspecified, 3), (owner, built, normal, 9007199254740993),
                                                     (owner, binder, normal, 5), (other, theirs, normal, 1)):
                conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,%s,1)',
                             (who, location, edition, quantity))
        migrate(url)
        monkeypatch.setenv('DATABASE_URL', url)
        lines = detail(owner, built)['deck_list']
        assert lines['revision'] == 1
        assert sorted((line['edition_id'], line['quantity'], line['in_deck']) for line in lines['lines']) == sorted([
            (str(unspecified), '3', '3'), (str(normal), '9007199254740993', '9007199254740993')])
        assert detail(owner, built)['deck_list_checks']['total'] == detail(owner, built)['checks']['total'] == '9007199254740996'
        assert detail(owner, empty)['deck_list'] == {'revision': 1, 'lines': []}
        assert detail(other, theirs)['deck_list']['lines'] == [{'edition_id': str(normal), 'quantity': '1', 'in_deck': '1'}]
        assert call('GET', f'/api/decks/{binder}', owner).status_code == 404
        assert call('GET', f'/api/decks/{theirs}', owner).status_code == 404
        # Holdings are unchanged by the conversion.
        assert sorted(row['quantity'] for row in call('GET', f'/api/decks/{built}/contents', owner).json()['editions']) == [
            '3', '9007199254740993']
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
