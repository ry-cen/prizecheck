"""The local Riftbound Catalog read API against a disposable migrated Riftbound database with synthetic rows.

The entry (app.riftbound_main) is imported through a fixture that asserts the process-wide operation counter writer is
unchanged, so building it here cannot rebind Pokémon's writer. Requests count on the entry's own counter, guarded here.
"""
import ast
import hashlib
import hmac
import json
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from riftbound_counts import counter, process_counter, restore_counter
from riftbound_catalog_seed import FINISHES, seed, wipe  # noqa: F401
from test_riftbound_catalog_track import admin, databases, fresh  # noqa: F401

CONTRACT = Path(__file__).parent / 'riftbound_contract'
APP_DIR = Path(__file__).resolve().parents[1] / 'app'
RB_SECRET, POKEMON_SECRET = 'synthetic-riftbound-secret', 'synthetic-pokemon-secret'
@pytest.fixture(scope='module')
def entry():
    before = process_counter._writer
    import app.riftbound_main as module
    assert process_counter._writer is before
    assert module.app.state.game_runtime.counter is counter is not process_counter
    return module


def signed(method, path, *, user='synthetic-user', secret=RB_SECRET, stamp=None, body=b''):
    stamp = int(time.time()) if stamp is None else stamp
    message = f"{method}\n{path}\n{hashlib.sha256(body).hexdigest()}\n{user}\n{stamp}".encode()
    return {'x-internal-user': user, 'x-internal-time': str(stamp),
            'x-internal-signature': hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()}


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
    with writer_off(url):
        yield Client(entry.app, url)


@contextmanager
def writer_off(url):
    """Keep the shared request-count writer off around a Catalog database, and always drain and restore it afterwards,
    even when either wipe raises, so a failed wipe cannot leave the process-wide writer disabled for later tests."""
    previous = counter.set_writer(None)
    try:
        wipe(url)
        try:
            yield
        finally:
            wipe(url)
    finally:
        restore_counter(previous)


@pytest.mark.parametrize('failing_wipes', [{1}, {2}, {1, 2}])
def test_writer_off_restores_the_writer_when_a_wipe_raises(monkeypatch, failing_wipes):
    sentinel, calls = object(), []
    original = counter.set_writer(sentinel)
    try:
        def flaky(url):
            calls.append(url)
            if len(calls) in failing_wipes:
                raise RuntimeError('synthetic wipe failure')
        monkeypatch.setattr(sys.modules[__name__], 'wipe', flaky)
        with pytest.raises(RuntimeError, match='synthetic wipe failure'):
            with writer_off('synthetic-url'):
                assert counter._writer is None
        assert counter._writer is sentinel
    finally:
        counter.set_writer(original)


ABSENT_EDITION = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f'  # a fixed synthetic id, so pytest ids match across xdist workers
PATHS = ['/api/catalog/sets', '/api/catalog/editions', f'/api/catalog/editions/{ABSENT_EDITION}']


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('case', ['no-secret', 'no-headers', 'no-signature', 'stale', 'future', 'bad-time', 'wrong-signature',
                                  'pokemon-key', 'other-path', 'wrong-method', 'huge-time', 'negative-time', 'float-time',
                                  'non-ascii-time', 'padded-time', 'non-ascii-signature', 'short-signature', 'long-signature',
                                  'non-hex-signature', 'uppercase-signature', 'non-ascii-user'])
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
    elif case == 'huge-time':
        headers['x-internal-time'] = '9' * 400
    elif case == 'negative-time':
        headers['x-internal-time'] = '-5'
    elif case == 'float-time':
        headers['x-internal-time'] = '1.5'
    elif case == 'non-ascii-time':
        headers['x-internal-time'] = b'\xb2'  # a superscript two: str.isdigit() is true for it
    elif case == 'padded-time':
        headers['x-internal-time'] = '0' * 40 + headers['x-internal-time']
    elif case == 'non-ascii-signature':
        headers['x-internal-signature'] = b'\xe9' * 64
    elif case == 'short-signature':
        headers['x-internal-signature'] = headers['x-internal-signature'][:63]
    elif case == 'long-signature':
        headers['x-internal-signature'] += '0'
    elif case == 'non-hex-signature':
        headers['x-internal-signature'] = 'g' * 64
    elif case == 'uppercase-signature':
        headers['x-internal-signature'] = headers['x-internal-signature'].upper()
    elif case == 'non-ascii-user':
        headers['x-internal-user'] = b'caf\xe9'
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


def test_a_printing_that_moved_sets_shows_the_current_sets_code(rb):
    _, made = seed(rb.url, [
        ('Synthetic Leaver', '001/100', '24344', 'Origins Synthetic', ('normal',)),
        ('Synthetic Joiner', '002/100', 'syn01', 'Synthetic Set 900', ('normal',)),
        ('Synthetic Stayer', '003/100', 'syn01', 'Synthetic Set 900', ('normal',))])
    leaver, joiner = made[('Synthetic Leaver', '001/100')], made[('Synthetic Joiner', '002/100')]
    stayer = made[('Synthetic Stayer', '003/100')]
    gen = uuid4()
    with psycopg.connect(rb.url) as conn:  # a later accepted generation moves the two Printings to each other's set
        conn.execute('INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,3,%s,%s)', (gen, b'synthetic', 'synthetic'))
        for card, name, number, set_id, set_name in ((leaver, 'Synthetic Leaver', '001/100', 'syn01', 'Synthetic Set 900'),
                                                     (joiner, 'Synthetic Joiner', '002/100', '24344', 'Origins Synthetic'),
                                                     (stayer, 'Synthetic Stayer', '003/100', 'syn01', 'Synthetic Set 900')):
            source_id = conn.execute('SELECT source_id FROM catalog_printing WHERE id=%s', (card['printing'],)).fetchone()[0]
            conn.execute('''INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,
                collector_number,display_name,search_name,source_fingerprint,basic_energy,tombstoned)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'synthetic','not_applicable',false)''',
                         (gen, card['printing'], source_id, set_id, set_name, number, name, name.lower()))
            conn.execute('INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active) VALUES (%s,%s,%s,true)',
                         (gen, card['editions'][0], card['printing']))
        conn.execute('UPDATE catalog_state SET active_generation=%s,revision=revision+1 WHERE singleton', (gen,))
    codes = {e['name']: (e['set']['id'], e['set']['code']) for e in rb.get('/api/catalog/editions').json()['editions']}
    assert codes == {'Synthetic Leaver': ('syn01', ''), 'Synthetic Joiner': ('24344', 'OGN'), 'Synthetic Stayer': ('syn01', '')}
    assert rb.get(f"/api/catalog/editions/{leaver['editions'][0]}").json()['set']['code'] == ''
    assert rb.get('/api/catalog/sets').json() == [{'id': '24344', 'name': 'Origins Synthetic', 'code': 'OGN'},
                                                  {'id': 'syn01', 'name': 'Synthetic Set 900', 'code': ''}]


def test_each_read_runs_in_one_repeatable_read_snapshot(rb, monkeypatch):
    """Proves the snapshot applies: inside the connection the isolation level is repeatable read and a transaction is open."""
    from psycopg.pq import TransactionStatus
    from app.games.riftbound.catalog import browse
    seen = []

    class Spy:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, *args):
            if not sql.startswith('SET TRANSACTION'):
                level = self.conn.execute('SHOW transaction_isolation').fetchone()['transaction_isolation']
                seen.append((level, self.conn.info.transaction_status))
            else:
                seen.append(sql)
            return self.conn.execute(sql, *args)

    class Opened:
        def __enter__(self):
            self.opened = real()
            return Spy(self.opened.__enter__())

        def __exit__(self, *exc):
            return self.opened.__exit__(*exc)
    real = browse.connect
    monkeypatch.setattr(browse, 'connect', lambda: Opened())
    for path in PATHS:
        seen.clear()
        rb.get(path)
        assert seen[0] == 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', path
        reads = seen[1:]
        assert len(reads) >= 1
        assert all(read == ('repeatable read', TransactionStatus.INTRANS) for read in reads), (path, reads)
    seen.clear()
    rb.get('/api/catalog/editions')
    assert len([x for x in seen if isinstance(x, tuple)]) == 2  # the list and the emptiness check share the snapshot


@pytest.mark.parametrize('params', [{'q': '\x00'}, {'q': 'a\x00b'}, {'set': '\x00'}, {'set': 'a\x00b'},
                                    {'q': 'x' * 121}, {'set': 'x' * 81}, {'page': 100001}, {'page': 0}, {'page': 'x'}],
                         ids=['q-nul', 'q-nul-inside', 'set-nul', 'set-nul-inside', 'q-long', 'set-long', 'page-huge', 'page-zero', 'page-text'])
def test_invalid_filters_are_422_not_500(rb, params):
    seed(rb.url, cards(1))
    assert rb.get('/api/catalog/editions', **params).status_code == 422


def test_filters_at_exactly_the_maximum_succeed(rb):
    seed(rb.url, cards(1))
    response = rb.get('/api/catalog/editions', q='x' * 120, set='y' * 80, page=100000)
    assert response.status_code == 200
    assert response.json() == {'editions': [], 'total': 0, 'pages': 1, 'catalog_empty': False}


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
    forbidden = ('app.games.pokemon', 'app.db', 'app.identity', 'app.main')
    for path in [*(APP_DIR / 'games' / 'riftbound').rglob('*.py'), APP_DIR / 'riftbound_main.py']:
        package = ['app', *path.relative_to(APP_DIR).parent.parts]
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                base = '.'.join(package[:len(package) - (node.level - 1)]) if node.level else ''
                module = '.'.join(x for x in (base, node.module) if x)
                names = [module, *(f'{module}.{a.name}' for a in node.names)]
            else:
                continue
            assert not [n for n in names if any(n == f or n.startswith(f + '.') for f in forbidden)], (path, names)


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


def test_browser_scenarios_match_the_connected_spec(rb):
    from riftbound_catalog_seed import scenario
    with psycopg.connect(rb.url) as conn:
        assert conn.execute('SELECT count(*) FROM catalog_generation').fetchone()[0] == 0  # freshly wiped
    scenario(rb.url, 'populated')
    first = rb.get('/api/catalog/editions').json()
    assert (first['total'], first['pages'], first['catalog_empty']) == (29, 2, False)
    assert first['editions'][0]['name'] == 'Alpha Sprite' and len(first['editions']) == 24
    assert len(rb.get('/api/catalog/editions', page=2).json()['editions']) == 5
    made = scenario(rb.url, 'unaccepted')['editions']
    with psycopg.connect(rb.url) as conn:
        assert conn.execute('SELECT count(*) FROM catalog_generation').fetchone()[0] == 1
        assert conn.execute('SELECT active_generation FROM catalog_state').fetchone()[0] is None
    assert len(made) == 28
    for name in ('unaccepted', 'empty'):
        if name == 'empty':
            assert scenario(rb.url, 'empty') == {'editions': {}}
        page = rb.get('/api/catalog/editions').json()
        assert (page['catalog_empty'], page['total']) == (True, 0)
        if name == 'empty':
            assert rb.get('/api/catalog/sets').json() == []
    with pytest.raises(ValueError):
        scenario(rb.url, 'nope')


def test_the_seed_command_acts_only_on_the_exact_loopback_database_it_was_told(rb):
    from contextlib import nullcontext
    from urllib.parse import quote

    from psycopg.conninfo import conninfo_to_dict

    from riftbound_catalog_seed import checked_url
    parts = conninfo_to_dict(rb.url)  # the harness hands over a keyword string; the seed takes a URL
    name = parts['dbname']
    host = f"[{parts['host']}]" if ':' in parts['host'] else parts['host']  # an IPv6 authority needs brackets
    authority = f"{quote(parts['user'], safe='')}:{quote(parts['password'], safe='')}@{host}:{parts['port']}"
    good = f"postgresql://{authority}/{name}"
    env = {'RIFTBOUND_DATABASE_URL': good}
    checked = conninfo_to_dict(checked_url(name, env, prefix=''))  # a real connection reports the name
    assert checked['hostaddr'] in ('127.0.0.1', '::1')  # the checked connection and the writes use one numeric address
    assert {key: checked[key] for key in ('user', 'password', 'host', 'port', 'dbname')} == {
        key: parts[key] for key in ('user', 'password', 'host', 'port', 'dbname')}
    with pytest.raises(SystemExit):  # the pattern alone is not enough: the effective name must be the one given
        checked_url('tcg_rb_other', env)
    with pytest.raises(SystemExit):
        checked_url(name, env)  # the harness database is not a tcg_rb_* database
    for key in ('PGHOSTADDR', 'PGSERVICE'):  # a libpq variable that redirects the target is refused before connecting
        with pytest.raises(SystemExit):
            checked_url(name, {**env, key: 'x'}, prefix='')

    def never(_):
        raise AssertionError('connected before the URL was refused')

    def reporting(database):  # a connection whose server says it is another database
        class Result:
            fetchone = staticmethod(lambda: (database,))
        return lambda url: nullcontext(type('Conn', (), {'execute': staticmethod(lambda query: Result)}))
    base = 'postgresql://u:p@127.0.0.1:5432/tcg_rb_x'  # fixed inputs: nothing here depends on the harness host
    for url in (base + '?dbname=other', base + '?host=db.example.test', base + '?hostaddr=10.0.0.5',
                'postgresql://u:p@db.example.test:5432/tcg_rb_x', 'postgresql://u:p@10.0.0.5:5432/tcg_rb_x',
                'postgresql://u:p@127.0.0.1:5432,evil.example:5432/tcg_rb_x', base + '#options=-c%20search_path%3Devil',
                base + '#host=evil.example', 'postgresql://u:p@127.0.0.1:5432,5433/tcg_rb_x',
                'postgresql://u:p@127.0.0.1,127.0.0.1:5432/tcg_rb_x', 'postgresql://u:p@[::1]:5432,[::1]:5432/tcg_rb_x',
                'postgresql://u:p@127.0.0.1:5432/tcg_rb_y'):
        with pytest.raises(SystemExit):
            checked_url('tcg_rb_x', {'RIFTBOUND_DATABASE_URL': url}, connect=never)
    for url, address in ((base, '127.0.0.1'), ('postgresql://u:p@[::1]:5432/tcg_rb_x', '::1')):
        found = conninfo_to_dict(checked_url('tcg_rb_x', {'RIFTBOUND_DATABASE_URL': url}, reporting('tcg_rb_x')))
        assert found['hostaddr'] == address and found['dbname'] == 'tcg_rb_x'
    with pytest.raises(SystemExit):
        checked_url('tcg_rb_x', {'RIFTBOUND_DATABASE_URL': base}, reporting('postgres'))

    # localhost is looked up once and pinned: every address must be loopback, and the connection gets one numeric one.
    named = {'RIFTBOUND_DATABASE_URL': 'postgresql://u:p@localhost:5432/tcg_rb_x'}

    def resolving(*addresses):
        return lambda host, port, **kw: [(2, 1, 6, '', (address, 0)) for address in addresses]
    pinned = conninfo_to_dict(checked_url('tcg_rb_x', named, reporting('tcg_rb_x'), getaddrinfo=resolving('::1', '127.0.0.1')))
    assert pinned['host'] == 'localhost' and pinned['hostaddr'] == '127.0.0.1'
    for addresses in (('10.0.0.5',), ('127.0.0.1', '10.0.0.5'), ()):
        with pytest.raises(SystemExit):
            checked_url('tcg_rb_x', named, never, getaddrinfo=resolving(*addresses))

    def unresolvable(*args, **kwargs):
        raise OSError('no such host')
    with pytest.raises(SystemExit):
        checked_url('tcg_rb_x', named, never, getaddrinfo=unresolvable)
