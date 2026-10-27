"""For trade Locations (Trading #267) through signed HTTP against PostgreSQL.

A collector marks any Location but a Deck For trade; the mark covers every Location inside it, including ones added or
moved in later, except Decks, and a Location inside a marked one can't be un-marked on its own. The tree read reports
``for_trade`` (effectively For trade, unlike ``hidden``) and ``for_trade_by`` (the nearest marked Location above).
For trade and hidden are independent. Marking changes nothing the collector counts, reserves nothing and never moves
the inventory revision. The SQL function the Trade List will use (``for_trade_locations``, migration 140) and the
tree read's rule agree. No Friend-facing response carries either field.
"""
import os
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from app.main import app, connect  # noqa: F401
from app.social import counts
from test_catalog_references import migrate
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture, as test_friend_copies uses)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures, as test_friend_copies uses)
from test_decks import create
from test_deck_counting import hold, line
from test_friend_copies import befriend, collection, collector
from test_holdings import add, call, client, fixture
from test_location_tree import change, make, tree
from want_list_swap_fixtures import seed_swap_catalog

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = '140_for_trade_locations.sql'


def ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def node(owner, location_id):
    return next(item for item in tree(owner) if item['id'] == location_id)


def created(owner, name, parent=None):
    return ok(make(owner, name, parent), 201)['location']


def deck_in(owner, name, parent=None):
    """A Deck made through the Deck route, moved inside ``parent`` (a Location id) when given; returns its id."""
    deck_id = ok(create(owner, name), 201)['location']['id']
    if parent:
        target = node(owner, parent)
        ok(call('PATCH', f'/api/decks/{deck_id}', owner,
                {'parent_id': parent, 'parent_version': target['version'], 'version': node(owner, deck_id)['version'],
                 'idempotency_key': str(uuid4())}))
    return deck_id


def mark(owner, location_id, for_trade=True, key=None, version=None):
    current = node(owner, location_id)
    return call('PUT', f'/api/location-tree/{location_id}/for-trade', owner,
                {'for_trade': for_trade, 'version': version or current['version'], 'idempotency_key': str(key or uuid4())})


def hide(owner, location_id, hidden=True):
    return ok(call('PUT', f'/api/location-tree/{location_id}/hidden', owner,
                   {'hidden': hidden, 'version': node(owner, location_id)['version'], 'idempotency_key': str(uuid4())}))


def marks(owner):
    """{name: (for_trade, name of for_trade_by or None)} for every Location of the owner."""
    rows = tree(owner)
    names = {row['id']: row['name'] for row in rows}
    return {row['name']: (row['for_trade'], names.get(row['for_trade_by'])) for row in rows}


def effectively_for_trade(owner):
    return {UUID(row['id']) for row in tree(owner) if row['for_trade']}


def sql_for_trade(owners):
    """for_trade_locations as {owner: {Location id}}; owners with none are absent."""
    found = {}
    with connect() as conn:
        for row in conn.execute('SELECT owner_id,location_id FROM for_trade_locations(%s)', (owners,)):
            found.setdefault(row['owner_id'], set()).add(row['location_id'])
    return found


def test_marking_covers_every_location_inside_including_ones_added_later():
    owner = str(uuid4())
    storage = created(owner, 'Storage')
    binders = created(owner, 'Binders', node(owner, storage['id']))
    created(owner, 'Binder 1', node(owner, binders['id']))
    elsewhere = created(owner, 'Shelf')
    response = ok(mark(owner, storage['id']))
    assert (response['for_trade'], response['for_trade_by']) == (True, None)
    assert response['location']['id'] == storage['id']
    assert marks(owner) == {'Unsorted': (False, None), 'Storage': (True, None), 'Binders': (True, 'Storage'),
                            'Binder 1': (True, 'Storage'), 'Shelf': (False, None)}
    # Added later, at any depth.
    late = created(owner, 'Binder 2', node(owner, binders['id']))
    assert marks(owner)['Binder 2'] == (True, 'Storage')
    # Moved in, then out.
    ok(change(owner, node(owner, elsewhere['id']), parent_id=binders['id'],
              parent_version=node(owner, binders['id'])['version']))
    assert marks(owner)['Shelf'] == (True, 'Storage')
    ok(change(owner, node(owner, elsewhere['id']), parent_id=None))
    assert marks(owner)['Shelf'] == (False, None)
    # The nearest marked Location is named.
    ok(mark(owner, binders['id']))
    assert marks(owner)['Binder 2'] == (True, 'Binders') and marks(owner)['Binders'] == (True, 'Storage')
    assert node(owner, late['id'])['for_trade_by'] == binders['id']


def test_a_location_inside_a_marked_one_cannot_be_unmarked_on_its_own():
    owner = str(uuid4())
    storage = created(owner, 'Storage')
    binder = created(owner, 'Binder', node(owner, storage['id']))
    ok(mark(owner, storage['id']))
    refused = mark(owner, binder['id'], for_trade=False)
    assert refused.status_code == 409
    assert refused.json()['detail'] == {'code': 'LOCATION_FOR_TRADE_BY_PARENT', 'for_trade_by': storage['id']}
    assert marks(owner)['Binder'] == (True, 'Storage')
    # Marking it too is allowed; it reads as covered while the parent is marked, and stays For trade after.
    marked = ok(mark(owner, binder['id']))
    assert (marked['for_trade'], marked['for_trade_by']) == (True, storage['id'])
    assert marks(owner)['Binder'] == (True, 'Storage')
    ok(mark(owner, storage['id'], for_trade=False))
    assert marks(owner) == {'Unsorted': (False, None), 'Storage': (False, None), 'Binder': (True, None)}
    unmarked = ok(mark(owner, binder['id'], for_trade=False))
    assert (unmarked['for_trade'], unmarked['for_trade_by']) == (False, None)
    assert marks(owner)['Binder'] == (False, None)


def test_a_deck_cannot_be_marked_and_a_deck_inside_a_marked_box_is_left_out():
    owner = str(uuid4())
    box = created(owner, 'Box')
    created(owner, 'Sleeve', node(owner, box['id']))
    inside = deck_in(owner, f'Boxed Deck {uuid4().hex[:6]}', box['id'])
    loose = deck_in(owner, f'Loose Deck {uuid4().hex[:6]}')
    for deck_id in (inside, loose):
        for for_trade in (True, False):
            before = node(owner, deck_id)['version']
            refused = mark(owner, deck_id, for_trade=for_trade)
            assert (refused.status_code, refused.json()['detail']) == (409, {'code': 'DECK_NOT_FOR_TRADE'})
            assert node(owner, deck_id)['version'] == before
    ok(mark(owner, box['id']))
    rows = {row['id']: row for row in tree(owner)}
    assert (rows[inside]['for_trade'], rows[inside]['for_trade_by']) == (False, None)
    assert (rows[loose]['for_trade'], rows[loose]['for_trade_by']) == (False, None)
    assert rows[box['id']]['for_trade'] is True
    # The SQL rule leaves the Deck out too.
    found = sql_for_trade([owner])[owner]
    assert UUID(inside) not in found and found == effectively_for_trade(owner) and len(found) == 2
    # The database refuses a marked Deck whatever writes it.
    with pytest.raises(psycopg.errors.CheckViolation), psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('UPDATE location SET for_trade=true WHERE id=%s', (inside,))


def test_hidden_and_for_trade_are_independent():
    owner = str(uuid4())
    storage = created(owner, 'Storage')
    binder = created(owner, 'Binder', node(owner, storage['id']))
    hide(owner, storage['id'])
    ok(mark(owner, storage['id']))
    rows = {row['name']: row for row in tree(owner)}
    assert (rows['Storage']['hidden'], rows['Storage']['for_trade']) == (True, True)
    assert (rows['Binder']['hidden_by'], rows['Binder']['for_trade_by']) == (storage['id'], storage['id'])
    hide(owner, storage['id'], hidden=False)
    assert (node(owner, storage['id'])['hidden'], node(owner, storage['id'])['for_trade']) == (False, True)
    hide(owner, storage['id'])
    ok(mark(owner, storage['id'], for_trade=False))
    assert (node(owner, storage['id'])['hidden'], node(owner, storage['id'])['for_trade']) == (True, False)
    assert node(owner, binder['id'])['hidden_by'] == storage['id']


def test_commands_are_versioned_idempotent_and_private():
    owner, other = str(uuid4()), str(uuid4())
    shelf = created(owner, 'Shelf')
    stale = mark(owner, shelf['id'], version=shelf['version'] + 5)
    assert (stale.status_code, stale.json()['detail']['code']) == (409, 'STALE_LOCATION')
    revision = ok(call('GET', '/api/location-tree', owner))['owner_revision']
    key = uuid4()
    first_response = mark(owner, shelf['id'], key=key)
    first = ok(first_response)
    assert first['location']['version'] == shelf['version'] + 1
    assert ok(call('GET', '/api/location-tree', owner))['owner_revision'] == revision
    replayed = call('PUT', f"/api/location-tree/{shelf['id']}/for-trade", owner,
                    {'for_trade': True, 'version': shelf['version'], 'idempotency_key': str(key)})
    assert replayed.json() == first
    assert replayed.content == first_response.content
    reused = call('PUT', f"/api/location-tree/{shelf['id']}/for-trade", owner,
                  {'for_trade': False, 'version': shelf['version'], 'idempotency_key': str(key)})
    assert reused.json()['detail']['code'] == 'IDEMPOTENCY_KEY_REUSED'
    # A key used to hide can't be replayed as a For trade change.
    hide_key = uuid4()
    ok(call('PUT', f"/api/location-tree/{shelf['id']}/hidden", owner,
            {'hidden': True, 'version': first['location']['version'], 'idempotency_key': str(hide_key)}))
    crossed = call('PUT', f"/api/location-tree/{shelf['id']}/for-trade", owner,
                   {'for_trade': True, 'version': first['location']['version'], 'idempotency_key': str(hide_key)})
    assert crossed.json()['detail']['code'] == 'IDEMPOTENCY_KEY_REUSED'
    tree(other)
    stolen = call('PUT', f"/api/location-tree/{shelf['id']}/for-trade", other,
                  {'for_trade': False, 'version': node(owner, shelf['id'])['version'], 'idempotency_key': str(uuid4())})
    assert (stolen.status_code, stolen.json()['detail']['code']) == (404, 'LOCATION_NOT_FOUND')
    assert node(owner, shelf['id'])['for_trade'] is True
    unsigned = client.put(f"/api/location-tree/{shelf['id']}/for-trade",
                          json={'for_trade': False, 'version': 1, 'idempotency_key': str(uuid4())})
    assert unsigned.status_code == 401


def test_marking_reserves_nothing_and_changes_nothing_the_collector_counts():
    owner, _, unsorted, _, edition, _ = fixture()
    box = created(owner, 'Box')
    ok(add(owner, box['id'], edition, '3'))
    deck = ok(create(owner, 'Counted Deck'), 201)['location']
    ok(add(owner, deck['id'], edition, '1'))
    line(owner, deck['id'], edition, 3)
    detail = f"/api/decks/{deck['id']}"
    paths = ['/api/want-list', detail, f'{detail}/pick-list', '/api/decks', f'/api/collection?location_id={unsorted}',
             f"/api/collection?location_id={box['id']}"]

    def counted(path):
        # Every figure, without Location versions: a Location's version moves with every change to it, marking included.
        def strip(value):
            if isinstance(value, dict):
                return {key: strip(item) for key, item in value.items() if key != 'version'}
            if isinstance(value, list):
                return [strip(item) for item in value]
            return value
        return strip(ok(call('GET', path, owner)))

    def stored():
        with connect() as conn:
            return (counts.reserved_counts(conn, owner, [UUID(edition)]),
                    conn.execute('SELECT count(*) AS n FROM inventory_undo WHERE owner_id=%s', (owner,)).fetchone()['n'],
                    conn.execute('SELECT count(*) AS n FROM loan_pick WHERE owner_id=%s', (owner,)).fetchone()['n'])

    before = {path: counted(path) for path in paths}
    held = stored()
    revision = ok(call('GET', '/api/location-tree', owner))['owner_revision']
    ok(mark(owner, box['id']))
    ok(mark(owner, unsorted))
    assert ok(call('GET', '/api/location-tree', owner))['owner_revision'] == revision
    for path in paths:
        assert counted(path) == before[path], path
    assert stored() == held
    ok(mark(owner, box['id'], for_trade=False))
    assert ok(call('GET', '/api/location-tree', owner))['owner_revision'] == revision
    for path in paths:
        assert counted(path) == before[path], path
    assert stored() == held


def test_the_sql_rule_agrees_with_the_tree_for_several_owners_at_once():
    owners = [str(uuid4()), str(uuid4()), str(uuid4())]
    for index, owner in enumerate(owners):
        top = created(owner, 'Top')
        middle = created(owner, 'Middle', node(owner, top['id']))
        created(owner, 'Bottom', node(owner, middle['id']))
        deck_in(owner, f'Deck {uuid4().hex[:6]}', middle['id'])
        created(owner, 'Side')
        if index == 0:
            ok(mark(owner, top['id']))
        if index == 1:
            ok(mark(owner, middle['id']))
    found = sql_for_trade(owners)
    assert found.get(owners[0], set()) == effectively_for_trade(owners[0]) and len(found[owners[0]]) == 3
    assert found.get(owners[1], set()) == effectively_for_trade(owners[1]) and len(found[owners[1]]) == 2
    assert owners[2] not in found and effectively_for_trade(owners[2]) == set()


def social_schema_refs_and_fields():
    """Every component name a /api/social response reaches by $ref, and every property name it can hold."""
    spec = app.openapi()
    components = spec['components']['schemas']
    refs, names = set(), set()

    def walk(schema):
        if isinstance(schema, dict):
            if '$ref' in schema:
                name = schema['$ref'].split('/')[-1]
                if name not in refs:
                    refs.add(name)
                    walk(components[name])
                return
            names.update((schema.get('properties') or {}).keys())
            for value in schema.values():
                walk(value)
        elif isinstance(schema, list):
            for value in schema:
                walk(value)

    for route, methods in spec['paths'].items():
        if route.startswith('/api/social'):
            walk(methods)
    return refs, names


def test_no_friend_facing_response_carries_the_for_trade_fields(store):
    refs, names = social_schema_refs_and_fields()
    assert refs, 'the walk reached no /api/social component'
    assert not names & {'for_trade', 'for_trade_by'}
    assert not refs & {'TreeNode', 'TreeLocation', 'TreeResponse', 'SetLocationForTrade', 'LocationForTradeResult'}
    # A Friend's Collection of a marked binder carries neither field.
    ids = seed_swap_catalog()
    (ash, _), (misty, misty_handle) = collector(), collector()
    befriend(ash, misty)
    binder = created(misty, 'Trade Binder')
    hold(misty, binder['id'], ids['PAL 185'], 2)
    ok(mark(misty, binder['id']))
    assert [card['edition_id'] for card in ok(collection(ash, misty_handle, show='all'))['cards']] == [ids['PAL 185']]
    for params in ({}, {'show': 'all'}):
        assert 'for_trade' not in collection(ash, misty_handle, **params).text


def test_migration_140_adds_the_flag_unmarked_and_runs_again():
    admin = os.environ.get('RECOVERY_TEST_DATABASE_URL')
    if not admin:
        pytest.skip('RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server')
    name = 'tcg_for_trade_' + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before=MIGRATION)
        owner = 'collector-' + uuid4().hex
        deck_id = uuid4()
        with psycopg.connect(url) as conn:
            conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
            conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Unsorted','storage_leaf')",
                         (uuid4(), owner))
            conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Old Deck','deck')", (deck_id, owner))
        migrate(url)
        with psycopg.connect(url, row_factory=dict_row) as conn:
            assert conn.execute('SELECT DISTINCT for_trade FROM location WHERE owner_id=%s', (owner,)).fetchall() \
                == [{'for_trade': False}]
            for _ in range(2):
                with conn.transaction():
                    conn.execute((ROOT / 'migrations' / MIGRATION).read_text())
            assert conn.execute("""SELECT count(*) AS n FROM pg_constraint WHERE conrelid='location'::regclass
              AND conname='location_deck_not_for_trade'""").fetchone() == {'n': 1}
            assert conn.execute("SELECT count(*) AS n FROM pg_indexes WHERE indexname='location_for_trade'").fetchone() \
                == {'n': 1}
            assert conn.execute('SELECT count(*) AS n FROM for_trade_locations(%s)', ([owner],)).fetchone() == {'n': 0}
            with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
                conn.execute('UPDATE location SET for_trade=true WHERE id=%s', (deck_id,))
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
