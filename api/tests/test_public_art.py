"""Anonymous art must never connect to PostgreSQL."""
import hashlib

import psycopg
import pytest

from app.art_storage import storage
from app.core.art.public import public_address, pointer_key, read_pointer, write_pointer
from test_art_store import client, get, pids, upstream  # noqa: F401
from app.main import connect


@pytest.fixture
def forbidden(monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError('public art opened PostgreSQL')
    monkeypatch.setattr(psycopg, 'connect', fail)
    monkeypatch.setenv('DATABASE_URL', 'postgresql://unreachable:1/private')


def test_public_art_serves_stored_bytes_without_postgres(pids, upstream, monkeypatch):
    pid = pids['card-1']
    answer = get(pid)
    assert answer.status_code == 200
    with connect() as conn:
        ref = conn.execute('SELECT public_ref FROM catalog_printing WHERE id=%s', (pid,)).fetchone()['public_ref']
    def forbidden(*args, **kwargs):
        raise AssertionError('public art opened PostgreSQL')
    monkeypatch.setattr(psycopg, 'connect', forbidden)
    monkeypatch.setenv('DATABASE_URL', 'postgresql://unreachable:1/private')
    address = public_address(ref, 'small', excluded_prefixes=())
    response = client.get(address)
    assert response.content == answer.content
    assert response.headers['cache-control'] == 'public, max-age=31536000, immutable'
    assert response.headers['cross-origin-resource-policy'] == 'same-origin'
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert client.get(address.split('?')[0] + '?v=wrong').headers['cache-control'] == 'public, no-cache'


@pytest.mark.parametrize('case', ['missing', 'gone', 'sha', 'json'])
def test_public_art_missing_is_404_no_store(upstream, forbidden, case):
    ref = 'a' * 48
    if case in ('gone', 'sha'):
        write_pointer(ref, 'small', storage_key='tcgdex/test', sha256='0'*64, content_type='image/webp')
    if case == 'sha':
        storage().put('tcgdex/test', b'wrong')
    if case == 'json':
        storage().put(pointer_key(ref, 'small'), b'{')
    answer = client.get(f'/api/public/art/{ref}/small')
    assert answer.status_code == 404
    assert answer.json()['detail']['code'] == 'ART_NOT_FOUND'
    assert answer.headers['cache-control'] == 'no-store'


def test_public_art_hides_tcgplayer_when_off(upstream, forbidden, monkeypatch):
    ref, data = 'b'*48, b'\xff\xd8\xffimage'
    storage().put('tcgplayer/large/test', data)
    write_pointer(ref, 'large', storage_key='tcgplayer/large/test', sha256=hashlib.sha256(data).hexdigest(), content_type='image/jpeg')
    assert client.get(public_address(ref, 'large', excluded_prefixes=())).status_code == 200
    monkeypatch.setenv('ART_TCGPLAYER_SOURCE', 'off')
    assert public_address(ref, 'large', excluded_prefixes=('tcgplayer',)) is None
    assert client.get(f'/api/public/art/{ref}/large').status_code == 404


@pytest.mark.parametrize('value', [{}, {'key': '../bad', 'sha256': '0'*64, 'content_type': 'image/webp'},
                                    {'key': 'ok', 'sha256': 'x'*64, 'content_type': 'image/webp'},
                                    {'key': 'ok', 'sha256': '0'*64, 'content_type': 'text/html'}])
def test_pointer_shape(upstream, value):
    import json
    ref = 'c'*48
    storage().put(pointer_key(ref, 'small'), json.dumps(value).encode())
    assert read_pointer(ref, 'small') is None
