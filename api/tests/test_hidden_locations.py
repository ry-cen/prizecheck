"""Hidden Locations (social network #249) through signed HTTP against PostgreSQL.

Any Location can be hidden from Friends; hiding covers every Location inside it, including ones added or moved in
later, and a Location inside a hidden one can't be shown on its own. The tree read marks both. Hiding changes nothing
the collector counts and never moves the inventory revision. The SQL function Friend reads will use
(``hidden_locations``) and the tree read's rule agree.
"""
import os
import random
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app.social.hidden_locations import hidden_location_ids
from test_catalog_references import migrate
from test_decks import create
from test_holdings import add, call, client, fixture
from test_location_tree import change, make, tree

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = '101_hidden_locations.sql'


def node(owner, location_id):
    return next(item for item in tree(owner) if item['id'] == location_id)


def hide(owner, location_id, hidden=True, key=None, version=None):
    current = node(owner, location_id)
    return call('PUT', f'/api/location-tree/{location_id}/hidden', owner,
                {'hidden': hidden, 'version': version or current['version'], 'idempotency_key': str(key or uuid4())})


def marks(owner):
    """{name: (hidden, name of hidden_by or None)} for every Location of the owner."""
    rows = tree(owner)
    names = {row['id']: row['name'] for row in rows}
    return {row['name']: (row['hidden'], names.get(row['hidden_by'])) for row in rows}


def effectively_hidden(owner):
    """The tree read's hidden set: hidden by the collector or by a Location above."""
    return {UUID(row['id']) for row in tree(owner) if row['hidden'] or row['hidden_by']}


def ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def created(owner, name, parent=None):
    return ok(make(owner, name, parent), 201)['location']


def test_hiding_covers_every_location_inside_including_ones_added_later():
    owner = str(uuid4())
    storage = created(owner, 'Storage')
    binders = created(owner, 'Binders', node(owner, storage['id']))
    binder = created(owner, 'Binder 1', node(owner, binders['id']))
    elsewhere = created(owner, 'Shelf')
    response = ok(hide(owner, storage['id']))
    assert (response['hidden'], response['hidden_by']) == (True, None)
    assert response['location']['id'] == storage['id']
    assert marks(owner) == {'Unsorted': (False, None), 'Storage': (True, None), 'Binders': (False, 'Storage'),
                            'Binder 1': (False, 'Storage'), 'Shelf': (False, None)}
    # Added later, at any depth.
    late = created(owner, 'Binder 2', node(owner, binders['id']))
    assert marks(owner)['Binder 2'] == (False, 'Storage')
    # Moved in, then out.
    ok(change(owner, node(owner, elsewhere['id']), parent_id=binders['id'], parent_version=node(owner, binders['id'])['version']))
    assert marks(owner)['Shelf'] == (False, 'Storage')
    ok(change(owner, node(owner, elsewhere['id']), parent_id=None))
    assert marks(owner)['Shelf'] == (False, None)
    # The nearest hidden Location is named.
    ok(hide(owner, binders['id']))
    assert marks(owner)['Binder 2'] == (False, 'Binders') and marks(owner)['Binders'] == (True, 'Storage')
    assert node(owner, late['id'])['hidden_by'] == binders['id'] and node(owner, binder['id'])['hidden_by'] == binders['id']


def test_a_location_inside_a_hidden_one_cannot_be_shown_on_its_own():
    owner = str(uuid4())
    storage = created(owner, 'Storage')
    binder = created(owner, 'Binder', node(owner, storage['id']))
    ok(hide(owner, storage['id']))
    refused = hide(owner, binder['id'], hidden=False)
    assert refused.status_code == 409
    assert refused.json()['detail'] == {'code': 'LOCATION_HIDDEN_BY_PARENT', 'hidden_by': storage['id']}
    # Hiding it too is allowed, and it stays hidden after the parent is shown.
    assert ok(hide(owner, binder['id']))['hidden_by'] == storage['id']
    ok(hide(owner, storage['id'], hidden=False))
    assert marks(owner) == {'Unsorted': (False, None), 'Storage': (False, None), 'Binder': (True, None)}
    ok(hide(owner, binder['id'], hidden=False))
    assert marks(owner)['Binder'] == (False, None)


def test_every_kind_of_location_can_be_hidden():
    owner, _, unsorted, _, edition, _ = fixture()
    folder = created(owner, 'Folder')
    leaf = created(owner, 'Leaf', node(owner, folder['id']))
    deck = ok(create(owner, 'Hidden Deck'), 201)['location']
    for location in (folder, leaf, deck, {'id': unsorted}):
        assert ok(hide(owner, location['id']))['hidden'] is True
    kinds = {row['kind'] for row in tree(owner) if row['hidden']}
    assert kinds == {'organization', 'storage_leaf', 'deck'}
    assert node(owner, unsorted)['hidden'] is True


def test_converting_a_hidden_stocked_leaf_keeps_its_new_unsorted_child_hidden():
    owner, _, unsorted, _, edition, _ = fixture()
    leaf = created(owner, 'Box')
    ok(add(owner, leaf['id'], edition, '2'))
    ok(hide(owner, leaf['id']))
    body = {'name': 'Sleeve', 'parent_id': leaf['id'], 'parent_version': node(owner, leaf['id'])['version'],
            'conversion': 'create_unsorted_child', 'idempotency_key': str(uuid4())}
    ok(call('POST', '/api/location-tree', owner, body), 201)
    found = marks(owner)
    assert found['Box'] == (True, None)
    assert found['Sleeve'] == (False, 'Box')
    # The conversion's new Unsorted child, which now holds the copies, is hidden too.
    assert sorted(name for name, mark in found.items() if mark == (False, 'Box')) == ['Sleeve', 'Unsorted']


def test_commands_are_versioned_idempotent_and_private():
    owner, other = str(uuid4()), str(uuid4())
    shelf = created(owner, 'Shelf')
    stale = hide(owner, shelf['id'], version=shelf['version'] + 5)
    assert (stale.status_code, stale.json()['detail']['code']) == (409, 'STALE_LOCATION')
    key = uuid4()
    first = ok(hide(owner, shelf['id'], key=key))
    assert first['location']['version'] > shelf['version']
    replayed = call('PUT', f"/api/location-tree/{shelf['id']}/hidden", owner,
                    {'hidden': True, 'version': shelf['version'], 'idempotency_key': str(key)})
    assert replayed.json() == first
    reused = call('PUT', f"/api/location-tree/{shelf['id']}/hidden", owner,
                  {'hidden': False, 'version': shelf['version'], 'idempotency_key': str(key)})
    assert reused.json()['detail']['code'] == 'IDEMPOTENCY_KEY_REUSED'
    tree(other)
    stolen = call('PUT', f"/api/location-tree/{shelf['id']}/hidden", other,
                  {'hidden': False, 'version': first['location']['version'], 'idempotency_key': str(uuid4())})
    assert (stolen.status_code, stolen.json()['detail']['code']) == (404, 'LOCATION_NOT_FOUND')
    assert node(owner, shelf['id'])['hidden'] is True
    unsigned = client.put(f"/api/location-tree/{shelf['id']}/hidden",
                          json={'hidden': False, 'version': 1, 'idempotency_key': str(uuid4())})
    assert unsigned.status_code == 401


def test_hiding_changes_nothing_the_collector_counts():
    owner, _, unsorted, _, edition, _ = fixture()
    deck = ok(create(owner, 'Counted Deck'), 201)['location']
    ok(add(owner, deck['id'], edition, '1'))
    detail = f"/api/decks/{deck['id']}"
    paths = ['/api/want-list', detail, '/api/decks', f'/api/collection?location_id={unsorted}']

    def counted(path):
        # Every figure, without Location versions: a Location's version moves with every change to it, hiding included.
        def strip(value):
            if isinstance(value, dict):
                return {key: strip(item) for key, item in value.items() if key != 'version'}
            if isinstance(value, list):
                return [strip(item) for item in value]
            return value
        return strip(ok(call('GET', path, owner)))

    before = {path: counted(path) for path in paths}
    revision = ok(call('GET', '/api/location-tree', owner))['owner_revision']
    ok(hide(owner, unsorted))
    ok(hide(owner, deck['id']))
    assert ok(call('GET', '/api/location-tree', owner))['owner_revision'] == revision
    for path in paths:
        assert counted(path) == before[path], path


def test_the_sql_rule_friend_reads_use_agrees_with_the_tree_for_several_owners_at_once():
    owners = [str(uuid4()), str(uuid4()), str(uuid4())]
    for index, owner in enumerate(owners):
        top = created(owner, 'Top')
        middle = created(owner, 'Middle', node(owner, top['id']))
        created(owner, 'Bottom', node(owner, middle['id']))
        created(owner, 'Side')
        if index == 0:
            ok(hide(owner, top['id']))
        if index == 1:
            ok(hide(owner, middle['id']))
    with connect() as conn:
        found = hidden_location_ids(conn, owners)
    assert found.get(owners[0], set()) == effectively_hidden(owners[0]) and len(found[owners[0]]) == 3
    assert found.get(owners[1], set()) == effectively_hidden(owners[1]) and len(found[owners[1]]) == 2
    assert owners[2] not in found and effectively_hidden(owners[2]) == set()


@pytest.mark.parametrize('seed', [1, 7, 42, 2026])
def test_the_sql_rule_agrees_with_the_tree_on_random_trees(seed):
    rng = random.Random(seed)
    owners = [str(uuid4()) for _ in range(3)]
    for owner in owners:
        ids = []
        for number in range(12):
            parent = node(owner, rng.choice(ids)) if ids and rng.random() < 0.8 else None
            response = make(owner, f'L{number}', parent)
            if response.status_code == 201:  # The tree's own rules (depth, stocked leaves) may refuse a parent.
                ids.append(response.json()['location']['id'])
        assert len(ids) >= 6
        for location_id in rng.sample(ids, rng.randint(2, 6)):
            if not node(owner, location_id)['hidden']:  # Includes ones already hidden by a Location above.
                ok(hide(owner, location_id))
        # Move one Location into a hidden subtree (a refused move, such as into its own subtree, changes nothing).
        hidden_ids = [row['id'] for row in tree(owner) if row['hidden'] and row['id'] in ids]
        mover = node(owner, rng.choice(ids))
        target = node(owner, rng.choice(hidden_ids))
        change(owner, mover, parent_id=target['id'], parent_version=target['version'])
    with connect() as conn:
        found = hidden_location_ids(conn, owners)
    for owner in owners:
        assert found.get(owner, set()) == effectively_hidden(owner)
    assert any(effectively_hidden(owner) for owner in owners)


def test_migration_101_adds_the_flag_shown_and_runs_again():
    admin = os.environ.get('RECOVERY_TEST_DATABASE_URL')
    if not admin:
        pytest.skip('RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server')
    name = 'tcg_hidden_' + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before=MIGRATION)
        owner = 'collector-' + uuid4().hex
        with psycopg.connect(url) as conn:
            conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
            conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Unsorted','storage_leaf')",
                         (uuid4(), owner))
        migrate(url)
        with psycopg.connect(url, row_factory=dict_row) as conn:
            assert conn.execute('SELECT hidden FROM location WHERE owner_id=%s', (owner,)).fetchone() == {'hidden': False}
            with conn.transaction():
                conn.execute((ROOT / 'migrations' / MIGRATION).read_text())
            assert conn.execute('SELECT count(*) AS n FROM hidden_locations(%s)', ([owner],)).fetchone() == {'n': 0}
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
