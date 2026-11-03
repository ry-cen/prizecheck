"""The Collection composition seam and cursors issued before its extraction (#521)."""
import base64
import ast
import hashlib
import hmac
import inspect
import json
import os
from urllib.parse import urlencode
from uuid import UUID

import psycopg
import pytest
from fastapi import HTTPException

from app.core.inventory import collection as reads, cursors
from app.games.pokemon.inventory import borrowed_gallery, collection
from test_api_contract import route_table
from test_collection_holding_filters import card, listing
from test_holdings import add, call, fixture


# Captured with HEAD 4c174070's app.collection.encode_cursor and this synthetic signing key.
OLD_TOKEN = (
    'eyJjb250ZXh0IjpbImNvbGxlY3Rpb24taG9sZGluZ3MiLCJvd25lciIsbnVsbCwicXVhbnRpdHktZGVzYyIsIiIsImJhc2UiLCJQ'
    'b2tlbW9uIixudWxsLCJGaXJlIiw3LFsxMSwxM11dLCJrZXkiOlsiMTIiLCJhYnJhIiwiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAt'
    'MDAwMDAwMDAwMDAxIiwiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAyIl19MCc4zYGP8dcDOzr694lrF8uoK50Z5lY8RFj8aKFUv2c'
)
OLD_CONTEXT = ['collection-holdings', 'owner', None, 'quantity-desc', '', 'base', 'Pokemon', None, 'Fire', 7, [11, 13]]
OLD_KEY = ['12', 'abra', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002']


def legacy_token(context, key):
    """The established wire shape, independent of the relocated production codec."""
    data = json.dumps({'context': context, 'key': key}, separators=(',', ':')).encode()
    mac = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), data, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(data + mac).decode().rstrip('=')


def test_pre_extraction_cursor_bytes_and_carried_values_stay_compatible(monkeypatch):
    monkeypatch.setenv('INTERNAL_AUTH_SECRET', 'collection-cursor-fixture')
    assert cursors.cursor_key(OLD_TOKEN, OLD_CONTEXT) == OLD_KEY
    assert cursors.encode_cursor(OLD_CONTEXT, OLD_KEY) == OLD_TOKEN
    assert cursors.anchor_value('edition_total', OLD_KEY[0]) == 12
    assert cursors.anchor_value('edition_id', OLD_KEY[2]) == UUID(OLD_KEY[2])


@pytest.mark.parametrize('slot,value,status,code', [
    (3, 'quantity-asc', 400, 'INVALID_CURSOR'),
    (6, None, 400, 'INVALID_CURSOR'),
    (8, 'Water', 400, 'INVALID_CURSOR'),
    (9, 8, 409, 'INVENTORY_CHANGED'),
    (10, [12, 13], 409, 'CATALOG_CHANGED'),
    (10, [11, 14], 409, 'CATALOG_CHANGED'),
])
def test_old_cursor_keeps_context_and_revision_errors(monkeypatch, slot, value, status, code):
    monkeypatch.setenv('INTERNAL_AUTH_SECRET', 'collection-cursor-fixture')
    context = list(OLD_CONTEXT)
    context[slot] = value
    with pytest.raises(HTTPException) as error:
        cursors.cursor_key(OLD_TOKEN, context)
    assert (error.value.status_code, error.value.detail) == (status, {'code': code})


def test_core_requires_explicit_keyword_only_facet_composition():
    for function, names in (
        (reads.collection_holdings, ('facet_columns', 'facet_joins', 'facet_conditions', 'facet_params', 'facet_context')),
        (reads.holding_columns, ('facet_columns',)),
        (reads.card_joins, ('facet_joins',)),
        (reads.holding_from, ('facet_joins',)),
    ):
        parameters = inspect.signature(function).parameters
        for name in names:
            assert parameters[name].kind == inspect.Parameter.KEYWORD_ONLY
            assert parameters[name].default == inspect.Parameter.empty
    with pytest.raises(TypeError):
        reads.collection_holdings(None, 'name-asc', '', '', None, 'owner')


def test_shared_inventory_keeps_game_facets_and_route_dependencies_out():
    for module in (reads, cursors):
        source = inspect.getsource(module)
        tree = ast.parse(source)
        # Pin the literal/SQL boundary as well as the import boundary enforced by guardrails.
        literals = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
        for forbidden in ('card_kind', 'trainer_type', 'elemental_types', 'catalog_card_attribute'):
            assert all(forbidden not in literal for literal in literals), (module.__name__, forbidden)
        assert not any(isinstance(node, ast.ImportFrom) and node.module and
                       (node.module.startswith('app.games.') or node.module == 'app.collection')
                       for node in ast.walk(tree))
        assert not any(isinstance(value, type(collection.router)) for value in vars(module).values())


def test_core_executes_supplied_sql_without_an_implicit_facet_join():
    owner, _, leaf, _, edition, _ = fixture()
    assert add(owner, leaf, edition, '3').status_code == 200
    # A SQL probe, not a game implementation: no ca relation or Pokémon response fields are supplied.
    page = reads.collection_holdings(None, 'quantity-desc', ' PIKA ', ' base ', None, owner,
                                     facet_columns='42 AS facet_probe', facet_joins='',
                                     facet_conditions=' AND h.quantity=%s', facet_params=[3],
                                     facet_context=[None, None, None])
    assert [(str(row['edition_id']), row['facet_probe']) for row in page['holdings']] == [(edition, 42)]
    assert not {'category', 'elemental_types', 'trainer_type'} & page['holdings'][0].keys()
    assert page['totals'].model_dump() == {'holdings': 1, 'editions': 1, 'copies': '3'}


def test_pokemon_composition_preserves_absent_null_empty_and_unknown_facets():
    owner, _, leaf, _, _, generation = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        editions = {
            'Absent': card(conn, generation, 'Absent', 'base', 'Base', '1'),
            'Null': card(conn, generation, 'Null', 'base', 'Base', '2'),
            'Empty': card(conn, generation, 'Empty', 'base', 'Base', '3', 'Pokemon'),
            'Unknown Trainer': card(conn, generation, 'Unknown Trainer', 'base', 'Base', '4', 'Trainer'),
            'Fire': card(conn, generation, 'Fire', 'base', 'Base', '5', 'Pokemon', ['Fire']),
        }
        conn.execute('DELETE FROM catalog_derived_attribute WHERE printing_id='
                     '(SELECT printing_id FROM catalog_edition WHERE id=%s)', (editions['Absent'],))
        conn.execute('UPDATE catalog_derived_attribute SET card_kind=NULL,types=NULL,trainer_type=NULL WHERE printing_id='
                     '(SELECT printing_id FROM catalog_edition WHERE id=%s)', (editions['Null'],))
        conn.execute("UPDATE catalog_derived_attribute SET types='{}' WHERE printing_id="
                     '(SELECT printing_id FROM catalog_edition WHERE id=%s)', (editions['Empty'],))
    for edition in editions.values():
        assert add(owner, leaf, edition, '1').status_code == 200
    response = listing(owner)
    assert response.status_code == 200, response.text
    rows = {row['printing_name']: row for row in response.json()['holdings']}
    for name in ('Absent', 'Null'):
        assert (rows[name]['category'], rows[name]['elemental_types'], rows[name]['trainer_type']) == (None, [], None)
    assert (rows['Empty']['category'], rows['Empty']['elemental_types']) == ('Pokemon', [])
    assert (rows['Unknown Trainer']['category'], rows['Unknown Trainer']['trainer_type']) == ('Trainer', None)
    for filters, expected in (({'category': 'Pokemon'}, ['Empty', 'Fire']),
                              ({'elemental_type': 'Fire'}, ['Fire']),
                              ({'category': 'Trainer'}, ['Unknown Trainer']),
                              ({'trainer_type': 'item'}, [])):
        filtered = listing(owner, **filters)
        assert filtered.status_code == 200, filtered.text
        assert [row['printing_name'] for row in filtered.json()['holdings']] == expected
        assert filtered.json()['totals'] == {'holdings': len(expected), 'editions': len(expected), 'copies': str(len(expected))}
    for field in ('category', 'trainer_type', 'elemental_type'):
        for value in ('', 'null', 'unknown'):
            assert listing(owner, **{field: value}).status_code == 422


def test_old_http_cursors_keep_normalization_sort_filters_and_page_limits(monkeypatch):
    owner, _, leaf, _, edition, _ = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        printing = conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s', (edition,)).fetchone()[0]
        editions = sorted(str(row[0]) for row in conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          SELECT %s,'compat-'||n,'{}'::jsonb FROM generate_series(1,51) n RETURNING id""", (printing,)))
        conn.execute('''INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,id,2,1 FROM unnest(%s::uuid[]) id''', (owner, leaf, editions))
    for path, size, result_key in (('/api/collection', 30, 'entries'), (f'/api/holdings/{leaf}', 48, 'holdings')):
        query = {'name': ' PIKA ', 'set_id': ' BASE ', 'collector_number': ' 25 ', 'sort': 'quantity'}
        first = call('GET', path + '?' + urlencode(query), owner).json()
        assert len(first[result_key]) == size
        context = [owner, leaf if result_key == 'holdings' else None, 'pika', 'base', '25', 'quantity',
                   first['owner_revision'], first['catalog_revision']]
        old = legacy_token(context, ['2', editions[size - 1]])
        assert first['next_cursor'] == old
        next_page = call('GET', path + '?' + urlencode({**query, 'cursor': old}), owner)
        assert next_page.status_code == 200, next_page.text
        assert [row['edition_id'] for row in next_page.json()[result_key]] == editions[size:]

    monkeypatch.setattr(reads, 'HOLDING_PAGE_SIZE', 2)
    query = {'name': ' PIKA ', 'set_id': ' base ', 'category': 'Pokemon', 'elemental_type': 'Lightning', 'sort': 'set-desc'}
    first = listing(owner, **query).json()
    assert len(first['holdings']) == 2
    raw = base64.urlsafe_b64decode(first['next_cursor'] + '=' * (-len(first['next_cursor']) % 4))
    context = json.loads(raw[:-32])['context']
    assert context[:-2] == ['collection-holdings', owner, None, 'set-desc', 'pika', 'base', 'Pokemon', None, 'Lightning']
    anchor = first['holdings'][-1]
    old = legacy_token(context, ['base set', 'base', False, '25', '25', anchor['edition_id'], leaf])
    assert first['next_cursor'] == old
    assert listing(owner, **{**query, 'name': 'pika', 'set_id': 'base'}, cursor=old).status_code == 200
    assert listing(owner, **{**query, 'elemental_type': 'Fire'}, cursor=old).status_code == 400
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('SELECT catalog_advance_attribute_revision()')
    changed = listing(owner, **query, cursor=old)
    assert (changed.status_code, changed.json()['detail']['code']) == (409, 'CATALOG_CHANGED')


def test_whole_game_routers_and_typed_models_keep_their_match_order():
    assert [(route.path, route.name) for route in collection.router.routes] == [
        ('/api/collection', 'collection'), ('/api/collection/editions/{edition_id}', 'distribution'),
        ('/api/collection/holdings', 'collection_holdings'), ('/api/collection/sets', 'collection_sets'),
        ('/api/collection/revision', 'collection_revision'),
    ]
    assert all(route.endpoint.__module__ == collection.__name__ for route in collection.router.routes)
    assert all(route.endpoint.__module__ == borrowed_gallery.__name__ for route in borrowed_gallery.router.routes)
    assert collection.CollectionHoldingView.__module__ == collection.__name__
    assert collection.CollectionHoldingPage.__module__ == collection.__name__
    table = route_table()
    collection_routes = [row for row in table if row[1].startswith('/api/collection/') or row[1] == '/api/collection']
    assert [row[1] for row in collection_routes] == [
        '/api/collection/borrowed', '/api/collection/borrowed/moves', '/api/collection',
        '/api/collection/editions/{edition_id}', '/api/collection/holdings', '/api/collection/sets', '/api/collection/revision',
    ]
