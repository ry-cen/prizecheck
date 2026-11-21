"""The app-owned per-game runtime: one process serves two games without sharing a database, a sign-in key, a cursor key
or a request counter, and Pokémon's requests, cursors and counts behave exactly as before."""
import ast
import base64
import hashlib
import hmac
import inspect
import json
import os
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi import APIRouter, HTTPException
from fastapi.testclient import TestClient

import app.deck_deletion as deck_deletion
import app.location_tree as location_tree
from app import identity
from app.core import app_builder, game_runtime as core_runtime
from app.core.decks import index as deck_index
from app.core.inventory import cursors, holdings, locations, moves
from app.core.ops import operation_counts
from app.core.ops.operation_counts import Count, OperationCounter
from app.core.routing import only
from app.games.pokemon.runtime import POKEMON
from app.games.riftbound import identity as rb_identity
from app.games.riftbound.runtime import RIFTBOUND
from app.main import HealthResponse, app as pokemon_app, health
from app.riftbound_main import app as riftbound_app
from test_riftbound_catalog_track import admin, databases, fresh  # noqa: F401

API = Path(__file__).resolve().parents[1]
CORE_HANDLER_MODULES = {'app.core.inventory.holdings', 'app.core.inventory.moves', 'app.core.inventory.locations',
                        'app.location_tree', 'app.deck_deletion'}
VERIFIERS = {identity.verified_user, core_runtime.verified_user, rb_identity.verified_user}
CONTEXT = ['user', None, 'name', 3, 4]


def signed(method, path, *, user, secret, body=b''):
    stamp = str(int(time.time()))
    message = f"{method}\n{path}\n{hashlib.sha256(body).hexdigest()}\n{user}\n{stamp}".encode()
    return {'x-internal-user': user, 'x-internal-time': stamp,
            'x-internal-signature': hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()}


def calls_in(dependant):
    """Every callable in a route's dependency tree, once per place it is declared."""
    found = []
    for sub in dependant.dependencies:
        found.append(sub.call)
        found.extend(calls_in(sub))
    return found


def routes_of(app):
    for route in app.routes:
        for item in (route.effective_route_contexts() if hasattr(route, 'effective_route_contexts') else [route]):
            if getattr(item, 'dependant', None) is not None:
                yield item


@pytest.fixture
def process_counter_off():
    """Keep Pokémon's process-wide writer off, then drain what was queued and put it back."""
    previous = operation_counts.counter.set_writer(None)
    try:
        yield
    finally:
        assert operation_counts.counter.flush()
        operation_counts.counter.set_writer(previous)


def bare_app(routers, **options):
    return app_builder.build_app(title='Test', version='1', routers=routers, lifespan_hooks=((), ()),
                                 health_endpoint=health, health_response_model=HealthResponse, **options)


# 1
def test_core_routes_resolve_their_runtime_from_the_app():
    checked = 0
    for route in routes_of(pokemon_app):
        if route.endpoint.__module__ not in CORE_HANDLER_MODULES:
            continue
        checked += 1
        calls = calls_in(route.dependant)
        assert core_runtime.verified_user in calls and core_runtime.game_runtime in calls, route.path
        assert identity.verified_user not in calls, route.path
    assert checked >= 20


# 2
def test_no_route_verifies_twice():
    for app in (pokemon_app, riftbound_app):
        for route in routes_of(app):
            verifiers = [call for call in calls_in(route.dependant) if call in VERIFIERS]
            assert len(set(verifiers)) <= 1, (route.path, verifiers)


# 3
def test_core_seam_modules_name_no_entry_globals():
    seam = [API / 'app/core/inventory' / name for name in ('collection.py', 'holdings.py', 'moves.py', 'locations.py', 'cursors.py')]
    seam += [API / 'app/location_tree.py', API / 'app/deck_deletion.py', API / 'app/core/decks/index.py']
    entry_globals = {'app.db', 'app.identity', 'db', 'identity'}
    for path in seam:
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom):
                named = node.module or ''
                assert named not in entry_globals, (path.name, named)
                if named in ('', 'app'):
                    assert not {alias.name for alias in node.names} & {'db', 'identity'}, path.name
            if isinstance(node, ast.Import):
                assert not {alias.name for alias in node.names} & entry_globals, path.name
    for function in (cursors.encode_cursor, cursors.cursor_key, cursors.decode_cursor,
                     deck_index.deck_cursor_encode, deck_index.deck_cursor_decode):
        parameter = inspect.signature(function).parameters['secret']
        assert parameter.kind is inspect.Parameter.KEYWORD_ONLY and parameter.default is inspect.Parameter.empty
    # price_budget and discovery are Pokémon-only today and outside this seam.
    known = {'prices/price_budget.py', 'publications/discovery.py'}
    for path in (API / 'app/core').rglob('*.py'):
        if path.relative_to(API / 'app/core').as_posix() not in known:
            assert 'INTERNAL_AUTH_SECRET' not in path.read_text(), path


# 4
def test_an_app_without_a_runtime_fails_closed(monkeypatch, process_counter_off):
    monkeypatch.setenv('INTERNAL_AUTH_SECRET', 'pk-test')
    monkeypatch.setattr(psycopg, 'connect', lambda *a, **k: pytest.fail('a database was opened'))
    app = bare_app((location_tree.router,))
    response = TestClient(app, raise_server_exceptions=False).get(
        '/api/location-tree', headers=signed('GET', '/api/location-tree', user='u', secret='pk-test'))
    assert response.status_code == 500


# 5
@pytest.mark.parametrize('path', ['/api/holdings/batch', '/api/location-tree'])
def test_body_and_auth_error_order_is_unchanged(path):
    client = TestClient(pokemon_app)
    headers = {'content-type': 'application/json'}
    assert client.post(path, content=b'{', headers=headers).status_code == 422
    assert client.post(path, content=b'{"location_id":"x"}', headers=headers).status_code == 401


class Recorder:
    def __init__(self):
        self.total = Count(requests=0)

    def write(self, count):
        self.total = self.total + count


def spy_on_connections(monkeypatch):
    opened, real = [], psycopg.connect

    def connect(conninfo='', *args, **kwargs):
        opened.append(conninfo)
        return real(conninfo, *args, **kwargs)
    monkeypatch.setattr(psycopg, 'connect', connect)
    return opened


# 6
@pytest.mark.parametrize('first', ['pokemon_first', 'riftbound_first'])
def test_two_games_in_one_process(first, fresh, monkeypatch):  # noqa: F811
    rb_url, pk_url = fresh[0], os.environ['DATABASE_URL']
    monkeypatch.setenv('INTERNAL_AUTH_SECRET', 'pk-test')
    monkeypatch.setenv('RIFTBOUND_INTERNAL_AUTH_SECRET', 'rb-test')
    monkeypatch.setenv('RIFTBOUND_DATABASE_URL', rb_url)
    global_before = operation_counts.counter._writer
    user, other, location, other_location = str(uuid4()), str(uuid4()), uuid4(), uuid4()
    for url, rows in ((pk_url, [(user, location, 'PK shelf')]),
                      (rb_url, [(user, location, 'RB shelf'), (other, other_location, 'V shelf')])):
        with psycopg.connect(url) as conn:
            for owner, place, name in rows:
                conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
                conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,%s,'storage_leaf')", (place, owner, name))
    apps, recorders = {}, {}
    for game in ((POKEMON, RIFTBOUND) if first == 'pokemon_first' else (RIFTBOUND, POKEMON)):
        app = bare_app((location_tree.router, moves.router), runtime=replace(game, counter=OperationCounter()))
        recorders[game.game] = Recorder()
        app.state.game_runtime.counter.set_writer(recorders[game.game])  # after the build, which binds a database writer
        apps[game.game] = app
    opened = spy_on_connections(monkeypatch)
    sent = {'pokemon': 0, 'riftbound': 0}

    def get(client, game, path, *, who, secret):
        sent[game] += 1
        opened.clear()
        response = client.get(path, headers=signed('GET', path, user=who, secret=secret))
        return response

    with TestClient(apps['pokemon']) as pk:
        with TestClient(apps['riftbound']) as rb:
            for _ in range(3):
                tree = get(pk, 'pokemon', '/api/location-tree', who=user, secret='pk-test')
                assert tree.status_code == 200 and 'PK shelf' in tree.text and 'RB shelf' not in tree.text
                assert set(opened) == {pk_url}
                tree = get(rb, 'riftbound', '/api/location-tree', who=user, secret='rb-test')
                assert tree.status_code == 200 and 'RB shelf' in tree.text and 'PK shelf' not in tree.text
                assert set(opened) == {rb_url}
                mine = get(rb, 'riftbound', '/api/location-tree', who=other, secret='rb-test')
                assert mine.status_code == 200 and 'V shelf' in mine.text and str(location) not in mine.text
                assert get(pk, 'pokemon', '/api/moves/undo', who=user, secret='pk-test').status_code == 200
                assert set(opened) == {pk_url}
                assert get(rb, 'riftbound', '/api/moves/undo', who=user, secret='rb-test').status_code == 200
                assert set(opened) == {rb_url}
                assert get(rb, 'riftbound', '/api/location-tree', who=user, secret='pk-test').status_code == 401
                assert get(pk, 'pokemon', '/api/location-tree', who=user, secret='rb-test').status_code == 401
                assert not opened
        # The Riftbound app has shut down and stopped its counter; Pokémon's requests still count on its own.
        for _ in range(2):
            assert get(pk, 'pokemon', '/api/location-tree', who=user, secret='pk-test').status_code == 200
    for game in ('pokemon', 'riftbound'):
        assert apps[game].state.game_runtime.counter.flush()
        assert recorders[game].total.requests == sent[game], game
    assert operation_counts.counter._writer is global_before


# 7
def test_a_cursor_is_bound_to_its_game_even_with_one_shared_secret(monkeypatch):
    monkeypatch.setenv('INTERNAL_AUTH_SECRET', 'same')
    monkeypatch.setenv('RIFTBOUND_INTERNAL_AUTH_SECRET', 'same')
    deck_row = {'sort_name': 'a', 'id': uuid4()}
    for own, other in ((POKEMON, RIFTBOUND), (RIFTBOUND, POKEMON)):
        token = cursors.encode_cursor(CONTEXT, ['k'], secret=own.cursor_secret)
        assert cursors.cursor_key(token, CONTEXT, secret=own.cursor_secret) == ['k']
        with pytest.raises(HTTPException) as error:
            cursors.cursor_key(token, CONTEXT, secret=other.cursor_secret)
        assert (error.value.status_code, error.value.detail) == (400, {'code': 'INVALID_CURSOR'})
        deck = deck_index.deck_cursor_encode('u', 1, deck_row, secret=own.cursor_secret)
        assert deck_index.deck_cursor_decode(deck, 'u', 1, secret=own.cursor_secret) == ('a', deck_row['id'])
        with pytest.raises(HTTPException) as error:
            deck_index.deck_cursor_decode(deck, 'u', 1, secret=other.cursor_secret)
        assert error.value.status_code == 400


# 8
def test_old_pokemon_cursors_still_decode(monkeypatch):
    monkeypatch.setenv('INTERNAL_AUTH_SECRET', 'legacy-secret')
    key = os.environ['INTERNAL_AUTH_SECRET'].encode()

    def legacy(payload):
        data = json.dumps(payload, separators=(',', ':')).encode()
        return base64.urlsafe_b64encode(data + hmac.new(key, data, hashlib.sha256).digest()).decode().rstrip('=')
    token = legacy({'context': CONTEXT, 'key': ['k', 'v']})
    assert cursors.cursor_key(token, CONTEXT, secret=POKEMON.cursor_secret) == ['k', 'v']
    assert cursors.encode_cursor(CONTEXT, ['k', 'v'], secret=POKEMON.cursor_secret) == token
    row = {'sort_name': 'abra', 'id': uuid4()}
    deck = legacy({'v': 1, 'u': 'u', 'r': 4, 'k': ['abra', str(row['id'])]})
    assert deck_index.deck_cursor_encode('u', 4, row, secret=POKEMON.cursor_secret) == deck
    assert deck_index.deck_cursor_decode(deck, 'u', 4, secret=POKEMON.cursor_secret) == ('abra', row['id'])


# 9
@pytest.mark.parametrize('game', [POKEMON, RIFTBOUND], ids=['pokemon', 'riftbound'])
def test_a_missing_secret_keeps_its_errors(game, monkeypatch):
    monkeypatch.delenv('INTERNAL_AUTH_SECRET', raising=False)
    monkeypatch.delenv('RIFTBOUND_INTERNAL_AUTH_SECRET', raising=False)
    with pytest.raises(HTTPException) as error:
        cursors.cursor_key('AAAA', CONTEXT, secret=game.cursor_secret)
    assert (error.value.status_code, error.value.detail) == (400, {'code': 'INVALID_CURSOR'})
    with pytest.raises(HTTPException) as error:
        deck_index.deck_cursor_decode('AAAA', 'u', 1, secret=game.cursor_secret)
    assert error.value.status_code == 400
    with pytest.raises(KeyError):
        cursors.encode_cursor(CONTEXT, ['k'], secret=game.cursor_secret)
    with pytest.raises(KeyError):
        deck_index.deck_cursor_encode('u', 1, {'sort_name': 'a', 'id': uuid4()}, secret=game.cursor_secret)


# 10
def test_only_selects_in_source_order_and_fails_loudly():
    source = APIRouter()
    for name in ('first', 'second', 'third'):
        source.add_api_route(f'/{name}', lambda: None, name=name)
    twin = APIRouter()
    twin.add_api_route('/a', lambda: None, name='same')
    twin.add_api_route('/b', lambda: None, name='same')
    before = list(source.routes)
    picked = only(source, 'third', 'first')
    assert [route.name for route in picked.routes] == ['first', 'third']
    assert picked is not source and list(source.routes) == before
    with pytest.raises(ValueError):
        only(source, 'missing')
    with pytest.raises(ValueError):
        only(source, 'first', 'first')
    with pytest.raises(ValueError):
        only(twin, 'same')
    with pytest.raises(ValueError):
        only(source)


# 11
def test_importing_the_riftbound_entry_leaves_the_process_counter_alone():
    script = ('import app.core.ops.operation_counts as oc\n'
              'before = oc.counter._writer\n'
              'import app.riftbound_main as entry\n'
              'assert oc.counter._writer is before\n'
              'assert entry.app.state.game_runtime.counter is not oc.counter\n')
    names = {'DATABASE_URL', 'INTERNAL_AUTH_SECRET', 'RIFTBOUND_DATABASE_URL', 'RIFTBOUND_INTERNAL_AUTH_SECRET'}
    env = {key: value for key, value in os.environ.items() if key not in names}
    done = subprocess.run([sys.executable, '-c', script], cwd=API, env=env, capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr
