"""A valid signed page cursor belongs only to the endpoint that issued it."""
from uuid import UUID

import pytest
from fastapi import HTTPException

from app.core.decks.index import deck_cursor_decode, deck_cursor_encode
from app.core.inventory.cursors import cursor_key, encode_cursor
from app.core.publications.discovery import cursor_decode, cursor_encode
from app.games.pokemon.catalog.catalog_search import _decode_cursor, _encode_cursor


ENDPOINTS = ('collection', 'decks', 'discovery', 'catalog_search')


@pytest.fixture
def cursors(monkeypatch):
    # Every endpoint uses the same secret and current revision: refusal must come from
    # endpoint validation, rather than a bad signature, another user or a stale page.
    monkeypatch.setenv('INTERNAL_AUTH_SECRET', 'cursor-cross-endpoint-test-secret')
    user = 'cursor-collector'
    revision = 7
    row_id = UUID('00000000-0000-4000-8000-000000000001')
    context = [user, None, 'pikachu', '', '', 'name', revision, revision]
    filters = ('pikachu', '', '')
    discovery_key = ['2026-11-08T12:00:00+00:00', 'a' * 32]
    return {
        'collection': (
            encode_cursor(context, ['pikachu', str(row_id)]),
            # Pin the shared decoder before any consumer adds its key-shape checks.
            lambda token: cursor_key(token, context),
            ['pikachu', str(row_id)],
            400,
        ),
        'decks': (
            deck_cursor_encode(user, revision, {'sort_name': 'pikachu', 'id': row_id}),
            lambda token: deck_cursor_decode(token, user, revision),
            ('pikachu', row_id),
            400,
        ),
        'discovery': (
            cursor_encode('pikachu', 'standard', revision, discovery_key),
            lambda token: cursor_decode(token, 'pikachu', 'standard', revision),
            tuple(discovery_key),
            400,
        ),
        'catalog_search': (
            _encode_cursor(filters, revision, {
                'search_name': 'pikachu', 'set_id': 'base',
                'collector_number': '58', 'id': row_id,
            }),
            lambda token: _decode_cursor(token, filters, revision),
            ('pikachu', 'base', '58', row_id),
            422,
        ),
    }


@pytest.mark.parametrize('endpoint', ENDPOINTS)
def test_each_decoder_accepts_its_own_cursor(cursors, endpoint):
    token, decode, expected, _ = cursors[endpoint]
    assert decode(token) == expected


@pytest.mark.parametrize(
    'source,target',
    [(source, target) for source in ENDPOINTS for target in ENDPOINTS if source != target],
    ids=[f'{source}-to-{target}' for source in ENDPOINTS for target in ENDPOINTS if source != target],
)
def test_each_decoder_refuses_every_other_endpoints_cursor(cursors, source, target):
    token = cursors[source][0]
    _, decode, _, status = cursors[target]
    with pytest.raises(HTTPException) as refused:
        decode(token)
    assert refused.value.status_code == status
    assert refused.value.detail == (
        {'code': 'INVALID_CURSOR', 'message': 'Invalid search cursor.'}
        if target == 'catalog_search' else {'code': 'INVALID_CURSOR'}
    )
