"""Stored command responses, captured from the code before the shared-core split, replay byte for byte (design-brief WP-B4).

Each file in replay_fixtures/ is one stored response as that code wrote it: a Deck List or Deck command's
``location_command.response``, or a publication command's ``publication_command.result``, with the request that made it.
The test stores the fixture under a fresh idempotency key and sends the request again, so the answer is the stored response
as ``decks.replayed`` or ``publications.mutate`` hands it back. Drift in what a split moves (``keep_response``, ``replayed``,
the request digests) shows here. The fixtures are never regenerated to make a test pass.
"""
import hashlib
import json
from pathlib import Path
from uuid import uuid4

import pytest

from app.main import connect
from test_holdings import call
from test_publications import public_objects  # noqa: F401  (autouse: gives each test an initialised projection directory)

FIXTURES = Path(__file__).parent / 'replay_fixtures'
NAMES = ['add_line', 'change_line', 'remove_line', 'change_list', 'set_target_format', 'set_cover', 'add_printing',
         'publish', 'republish', 'visibility', 'revoke']
OWNER = 'replay-fixture-owner'


def fixture_named(name):
    return json.loads((FIXTURES / f'{name}.json').read_text())


def test_every_fixture_file_is_replayed():
    assert sorted(path.stem for path in FIXTURES.glob('*.json')) == sorted(NAMES)


@pytest.mark.parametrize('name', NAMES)
def test_a_stored_response_replays_byte_for_byte(name):
    fixture = fixture_named(name)
    key = uuid4()
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING', (OWNER,))
        if fixture['kind'] == 'deck':
            conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                         (OWNER, key, fixture['digest'], json.dumps(fixture['response'])))
        else:
            deck_id = fixture['path'].split('/')[3]
            payload = {'deck_id': deck_id, 'action': fixture['action'], **fixture['body'], 'idempotency_key': str(key)}
            conn.execute('INSERT INTO deck_publication(token,owner_id,deck_id,title) VALUES (%s,%s,NULL,%s) ON CONFLICT DO NOTHING',
                         (fixture['token'], OWNER, fixture['title']))
            conn.execute('INSERT INTO publication_command(owner_id,request_key,request_digest,token,projection,result,projected) VALUES (%s,%s,%s,%s,%s,%s,true)',
                         (OWNER, key, hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest(), fixture['token'],
                          json.dumps(fixture['projection']), json.dumps(fixture['response'])))
    response = call(fixture['method'], fixture['path'], OWNER, {**fixture['body'], 'idempotency_key': str(key)})
    assert response.status_code == 200, response.text
    assert json.dumps(response.json(), sort_keys=True) == json.dumps(fixture['response'], sort_keys=True)
