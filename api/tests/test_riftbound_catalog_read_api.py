"""The local Riftbound Catalog read API against a disposable migrated Riftbound database with synthetic rows.

The entry (app.riftbound_main) is imported through a fixture that puts the process-wide operation counter writer back,
so building it here cannot rebind Pokémon's writer for other tests in the same process.
"""
import ast
import hashlib
import hmac
import json
import time
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.core.ops.operation_counts import counter
from test_riftbound_catalog_track import admin, databases, fresh  # noqa: F401

CONTRACT = Path(__file__).parent / 'riftbound_contract'
APP_DIR = Path(__file__).resolve().parents[1] / 'app'
RB_SECRET, POKEMON_SECRET = 'synthetic-riftbound-secret', 'synthetic-pokemon-secret'
FINISHES = {'normal': {'finish': 'normal'}, 'foil': {'finish': 'foil'},
            'unspecified': {'kind': 'unspecified', 'label': 'Unspecified Variant'}}


@pytest.fixture(scope='module')
def entry():
    previous = counter.set_writer(None)
    try:
        import app.riftbound_main as module
    finally:
        counter.set_writer(previous)
    return module


def signed(method, path, *, user='synthetic-user', secret=RB_SECRET, stamp=None, body=b''):
    stamp = int(time.time()) if stamp is None else stamp
    message = f"{method}\n{path}\n{hashlib.sha256(body).hexdigest()}\n{user}\n{stamp}".encode()
    return {'x-internal-user': user, 'x-internal-time': str(stamp),
            'x-internal-signature': hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()}


def wipe(url):
    with psycopg.connect(url) as conn:
        conn.execute('''TRUNCATE catalog_generation_edition, catalog_generation_printing, catalog_generation,
            catalog_edition, catalog_printing_display, catalog_printing, catalog_identity, catalog_review CASCADE''')
        # CASCADE also empties catalog_state through its generation reference; put the singleton row back.
        conn.execute('INSERT INTO catalog_state(singleton,active_generation) VALUES (true,NULL) ON CONFLICT DO NOTHING')
        conn.execute('UPDATE catalog_state SET active_generation=NULL,revision=0 WHERE singleton')


def seed(url, cards, *, activate=True):
    """Insert one generation of cards [(name, number, set_id, set_name, finishes, flags)]; return (generation, {key: ids})."""
    gen, made = uuid4(), {}
    with psycopg.connect(url) as conn:
        conn.execute('INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,1,%s,%s)',
                     (gen, b'synthetic', 'synthetic'))
        for card in cards:
            name, number, set_id, set_name, finishes, flags = (*card, {})[:6] if len(card) == 5 else card
            identity = conn.execute('INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id',
                                    (str(uuid4()), name)).fetchone()[0]
            source_id = str(9000001 + uuid4().int % 1000000000)
            printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgcsv',%s,%s) RETURNING id",
                                    (source_id, identity)).fetchone()[0]
            conn.execute('''INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,
                collector_number,display_name,search_name,source_fingerprint,basic_energy,tombstoned)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'synthetic','not_applicable',%s)''',
                         (gen, printing, source_id, set_id, set_name, number, name, name.lower(), flags.get('tombstoned', False)))
            ids = []
            for finish in finishes:
                descriptor = FINISHES[finish]
                edition = conn.execute('''INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
                    VALUES (%s,%s,%s) RETURNING id''', (printing, json.dumps(descriptor, sort_keys=True), json.dumps(descriptor))).fetchone()[0]
                conn.execute('INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active) VALUES (%s,%s,%s,%s)',
                             (gen, edition, printing, flags.get('active', True)))
                ids.append(str(edition))
            made[(name, number)] = {'printing': str(printing), 'editions': ids}
        if activate:
            conn.execute('UPDATE catalog_state SET active_generation=%s,revision=revision+1 WHERE singleton', (gen,))
    return gen, made


class Client:
    def __init__(self, app, url):
        self.http, self.url = TestClient(app), url

    def get(self, path, **params):
        return self.http.get(path, params=params, headers=signed('GET', path))


@pytest.fixture
def rb(fresh, entry, monkeypatch):  # noqa: F811
    url = fresh[0]
    monkeypatch.setenv('RIFTBOUND_DATABASE_URL', url)
    monkeypatch.setenv('RIFTBOUND_INTERNAL_AUTH_SECRET', RB_SECRET)
    monkeypatch.setenv('INTERNAL_AUTH_SECRET', POKEMON_SECRET)
    monkeypatch.setenv('DATABASE_URL', 'postgresql://unused.invalid/pokemon')  # must never be opened
    previous = counter.set_writer(None)
    wipe(url)
    try:
        yield Client(entry.app, url)
    finally:
        wipe(url)
        counter.set_writer(previous)


PATHS = ['/api/catalog/sets', '/api/catalog/editions', f'/api/catalog/editions/{uuid4()}']


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('case', ['no-secret', 'no-headers', 'no-signature', 'stale', 'future', 'bad-time', 'wrong-signature',
                                  'pokemon-key', 'other-path', 'wrong-method'])
def test_every_route_requires_a_riftbound_signed_user(rb, monkeypatch, path, case):
    headers = signed('GET', path)
    if case == 'no-secret':
        monkeypatch.delenv('RIFTBOUND_INTERNAL_AUTH_SECRET')
    elif case == 'no-headers':
        headers = {}
    elif case == 'no-signature':
        headers.pop('x-internal-signature')
    elif case == 'stale':
        headers = signed('GET', path, stamp=int(time.time()) - 31)
    elif case == 'future':
        headers = signed('GET', path, stamp=int(time.time()) + 31)
    elif case == 'bad-time':
        headers['x-internal-time'] = 'soon'
    elif case == 'wrong-signature':
        headers['x-internal-signature'] = '0' * 64
    elif case == 'pokemon-key':
        headers = signed('GET', path, secret=POKEMON_SECRET)
    elif case == 'other-path':
        headers = signed('GET', '/api/catalog/other')
    elif case == 'wrong-method':
        headers = signed('POST', path)
    response = rb.http.get(path, headers=headers)
    assert response.status_code == 401
    assert response.json() == {'detail': 'Authentication required'}


def test_a_riftbound_signed_request_passes_and_the_pokemon_secret_is_not_needed(rb, monkeypatch):
    monkeypatch.delenv('INTERNAL_AUTH_SECRET')
    assert rb.get('/api/catalog/sets').status_code == 200
    assert rb.get('/api/catalog/editions').status_code == 200
    assert rb.get(PATHS[2]).status_code == 404


def test_an_empty_catalog_is_not_an_error(rb):
    assert rb.get('/api/catalog/sets').json() == []
    assert rb.get('/api/catalog/editions').json() == {'editions': [], 'total': 0, 'pages': 1, 'catalog_empty': True}
    assert rb.get('/api/catalog/editions', q='x', set='y', page=3).json()['catalog_empty'] is True
    seed(rb.url, [('Synthetic Unit 01', '001/100', 'syn01', 'Synthetic Set 900', ('normal',))], activate=False)
    assert rb.get('/api/catalog/editions').json()['catalog_empty'] is True  # no accepted generation yet


def cards(count):
    return [(f'Synthetic Unit {n:02d}', f'{n:03d}/100', 'syn01', 'Synthetic Set 900', ('normal',)) for n in range(1, count + 1)]


def test_sets_search_filter_and_detail(rb):
    _, made = seed(rb.url, [
        ('Synthetic Dragon', '001/100', 'syn01', 'Synthetic Set 900', ('normal', 'foil')),
        ('Synthetic Knight', '002/100', 'syn01', 'Synthetic Set 900', ('unspecified',)),
        ('Alpha Sprite', 'P-7', '24344', 'Origins Synthetic', ('normal',)),
    ])
    assert rb.get('/api/catalog/sets').json() == [
        {'id': '24344', 'name': 'Origins Synthetic', 'code': 'OGN'},
        {'id': 'syn01', 'name': 'Synthetic Set 900', 'code': ''}]
    everything = rb.get('/api/catalog/editions').json()
    assert (everything['total'], everything['pages'], everything['catalog_empty']) == (4, 1, False)
    assert [(e['name'], e['finish']) for e in everything['editions']] == [
        ('Alpha Sprite', 'normal'), ('Synthetic Dragon', 'foil'), ('Synthetic Dragon', 'normal'), ('Synthetic Knight', 'unspecified')]
    by_name = rb.get('/api/catalog/editions', q='  KNIGHT ').json()
    assert [e['name'] for e in by_name['editions']] == ['Synthetic Knight'] and by_name['total'] == 1
    assert rb.get('/api/catalog/editions', q='p-7').json()['editions'][0]['name'] == 'Alpha Sprite'
    assert {e['name'] for e in rb.get('/api/catalog/editions', q='002').json()['editions']} == {'Synthetic Knight'}
    in_set = rb.get('/api/catalog/editions', set='24344').json()
    assert in_set['total'] == 1 and in_set['editions'][0]['set'] == {'id': '24344', 'name': 'Origins Synthetic', 'code': 'OGN'}
    assert rb.get('/api/catalog/editions', set='24344', q='dragon').json()['total'] == 0
    assert rb.get('/api/catalog/editions', set='nope').json() == {'editions': [], 'total': 0, 'pages': 1, 'catalog_empty': False}
    one = rb.get(f"/api/catalog/editions/{made[('Synthetic Knight', '002/100')]['editions'][0]}").json()
    assert one == {'id': made[('Synthetic Knight', '002/100')]['editions'][0], 'printing_id': made[('Synthetic Knight', '002/100')]['printing'],
                   'name': 'Synthetic Knight', 'set': {'id': 'syn01', 'name': 'Synthetic Set 900', 'code': ''},
                   'number': '002/100', 'finish': 'unspecified', 'art': None}
    assert rb.get('/api/catalog/editions/not-a-uuid').status_code == 404
    assert rb.get(f'/api/catalog/editions/{uuid4()}').status_code == 404


def test_one_printing_with_two_finishes_is_two_editions(rb):
    _, made = seed(rb.url, [('Synthetic Dragon', '001/100', 'syn01', 'Synthetic Set 900', ('normal', 'foil'))])
    listed = rb.get('/api/catalog/editions').json()
    assert listed['total'] == 2 and len({e['id'] for e in listed['editions']}) == 2
    assert {e['printing_id'] for e in listed['editions']} == {made[('Synthetic Dragon', '001/100')]['printing']}
    assert sorted(e['finish'] for e in listed['editions']) == ['foil', 'normal']
    for edition in listed['editions']:
        assert rb.get(f"/api/catalog/editions/{edition['id']}").json() == edition


def test_paging_boundaries_and_totals(rb):
    from app.games.riftbound.catalog.browse import PAGE_SIZE
    seed(rb.url, cards(PAGE_SIZE * 2 + 1))
    first = rb.get('/api/catalog/editions').json()
    assert (first['total'], first['pages'], len(first['editions'])) == (PAGE_SIZE * 2 + 1, 3, PAGE_SIZE)
    assert first['editions'][0]['number'] == '001/100'
    second = rb.get('/api/catalog/editions', page=2).json()
    third = rb.get('/api/catalog/editions', page=3).json()
    assert [len(second['editions']), len(third['editions'])] == [PAGE_SIZE, 1]
    seen = [e['id'] for page in (first, second, third) for e in page['editions']]
    assert len(set(seen)) == PAGE_SIZE * 2 + 1
    beyond = rb.get('/api/catalog/editions', page=4).json()
    assert beyond['editions'] == [] and beyond['total'] == PAGE_SIZE * 2 + 1 and beyond['pages'] == 3
    assert rb.get('/api/catalog/editions', page=0).status_code == 422
    exact = rb.get('/api/catalog/editions', q='Unit 0').json()  # Unit 01..09
    assert (exact['total'], exact['pages']) == (9, 1)


def test_unaccepted_and_retired_rows_are_invisible(rb):
    seed(rb.url, [('Synthetic Old', '009/100', 'old01', 'Old Synthetic Set', ('normal',))])
    _, made = seed(rb.url, [
        ('Synthetic Shown', '001/100', 'syn01', 'Synthetic Set 900', ('normal', 'foil')),
        ('Synthetic Retired', '002/100', 'syn01', 'Synthetic Set 900', ('normal',), {'active': False}),
        ('Synthetic Tombstoned', '003/100', 'syn02', 'Synthetic Set 901', ('normal',), {'tombstoned': True}),
    ])
    seed(rb.url, [('Synthetic Pending', '004/100', 'syn03', 'Synthetic Set 902', ('normal',))], activate=False)
    with psycopg.connect(rb.url) as conn:  # a held pull: a review and a Printing with no membership in the active generation
        identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES ('held','Synthetic Held') RETURNING id").fetchone()[0]
        printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgcsv','9100001',%s) RETURNING id", (identity,)).fetchone()[0]
        conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'k','{\"finish\":\"normal\"}')", (printing,))
        conn.execute("INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail) VALUES (%s,'9100001','group_pull_held','x','held')", (printing,))
        conn.execute("INSERT INTO catalog_run(phase,outcome,error) VALUES ('failed','failed','synthetic')")
    listed = rb.get('/api/catalog/editions').json()
    assert [(e['name'], e['finish']) for e in listed['editions']] == [('Synthetic Shown', 'foil'), ('Synthetic Shown', 'normal')]
    assert listed['total'] == 2
    assert rb.get('/api/catalog/sets').json() == [{'id': 'syn01', 'name': 'Synthetic Set 900', 'code': ''}]
    for name in ('old', 'retired', 'tombstoned', 'pending', 'held'):
        assert rb.get('/api/catalog/editions', q=name).json()['total'] == 0
    for key in (('Synthetic Retired', '002/100'), ('Synthetic Tombstoned', '003/100')):
        assert rb.get(f"/api/catalog/editions/{made[key]['editions'][0]}").status_code == 404
    with psycopg.connect(rb.url) as conn:
        hidden = [str(r[0]) for r in conn.execute("SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='9100001'")]
    assert rb.get(f'/api/catalog/editions/{hidden[0]}').status_code == 404


def test_natural_number_order_and_no_leaked_fields(rb):
    seed(rb.url, [(f'Synthetic Same', n, 'syn01', 'Synthetic Set 900', ('normal',)) for n in ('10/100', '2/100', '1/100')])
    rows = rb.get('/api/catalog/editions').json()['editions']
    assert [e['number'] for e in rows] == ['1/100', '2/100', '10/100']
    assert set(rows[0]) == {'id', 'printing_id', 'name', 'set', 'number', 'finish', 'art'} and rows[0]['art'] is None
    assert set(rows[0]['set']) == {'id', 'name', 'code'}


def test_the_entry_serves_only_health_and_the_riftbound_routes(rb, entry, monkeypatch):
    monkeypatch.delenv('DATABASE_URL')
    monkeypatch.delenv('INTERNAL_AUTH_SECRET')
    paths = sorted({row[1] for row in route_table(entry.app) if row[1].startswith('/api/')})
    assert paths == ['/api/catalog/editions', '/api/catalog/editions/{edition_id}', '/api/catalog/sets', '/api/health']
    assert rb.http.get('/api/health').json() == {'status': 'ok'}
    assert rb.http.get('/api/decks').status_code == 404
    assert rb.get('/api/catalog/sets').status_code == 200  # with no DATABASE_URL at all


def test_the_riftbound_entry_is_not_wired_into_pokemon_or_deploy_files():
    assert 'riftbound' not in (APP_DIR / 'main.py').read_text().lower()
    root = APP_DIR.parents[1]
    for name in ('docker-compose.yml', 'compose.prod.yml', 'compose.deploy.yml'):
        assert 'riftbound_main' not in (root / name).read_text()
    for path in (root / 'deploy').rglob('*'):
        if path.is_file():
            assert 'riftbound_main' not in path.read_text(errors='ignore'), path
    for path in (APP_DIR / 'games' / 'riftbound').rglob('*.py'):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ''] if isinstance(node, ast.ImportFrom) else []
            assert not any(n.startswith('app.games.pokemon') for n in names), path


def route_table(app):
    rows = []
    for route in app.routes:
        for item in (route.effective_route_contexts() if hasattr(route, 'effective_route_contexts') else [route]):
            rows.append([sorted(item.methods) if getattr(item, 'methods', None) else None, item.path, item.name])
    return rows


def test_riftbound_openapi_snapshot(entry):
    assert json.dumps(entry.app.openapi(), indent=1, sort_keys=True) == (CONTRACT / 'openapi.json').read_text()


def test_riftbound_route_table_snapshot(entry):
    assert route_table(entry.app) == json.loads((CONTRACT / 'routes.json').read_text())
