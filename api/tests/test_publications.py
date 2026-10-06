"""Private publication commands and anonymous sanitized object reads."""
from uuid import uuid4
import json
import os
import pytest
from test_holdings import fixture, call, add, client
from test_decks import create


@pytest.fixture(autouse=True)
def public_objects(tmp_path, monkeypatch):
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path))
    from app.public_projection import FilePublicProjection
    with FilePublicProjection().writer(initialize=True):
        pass


def command(owner, deck, method='POST', title='Public deck', key=None):
    body = {'idempotency_key': str(key or uuid4())}
    if method != 'DELETE':
        body['title'] = title
    return call(method, f'/api/decks/{deck}/publication', owner, body)


def test_snapshot_allowlist_private_edits_republish_revoke_and_burned_url():
    owner, other, leaf, _, edition, _ = fixture()
    deck = create(owner, 'Private name never public').json()['location']['id']
    add(owner, leaf, edition, '50')
    add(owner, deck, edition, '59')
    key = uuid4()
    publish = command(owner, deck, key=key)
    assert publish.status_code == 200, publish.text
    assert command(owner, deck, key=key).json() == publish.json()
    token = publish.json()['token']
    assert len(token) == 32
    path = f'/api/public/decks/{token}'
    response = client.get(path)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['x-robots-tag'] == 'noindex, nofollow'
    snapshot = response.json()
    assert set(snapshot) == {'title', 'published_at', 'version', 'total', 'identities', 'checks'}
    assert snapshot['title'] == 'Public deck' and snapshot['total'] == '59' and snapshot['version'] == 1
    identity = snapshot['identities'][0]
    assert set(identity) == {'name', 'quantity', 'editions'}
    assert set(identity['editions'][0]) == {'set_id','set_name','collector_number','variant','image_url','quantity'}
    assert set(snapshot['checks']) == {'size_status','shortage','excess','identities','disclaimer'}
    assert set(snapshot['checks']['identities'][0]) == {'name','quantity','status'}
    serialized = json.dumps(snapshot)
    for private in (owner, other, leaf, deck, edition, 'Private name never public', 'location_id', 'owner_id', 'email', 'owner_revision'):
        assert private not in serialized
    assert command(other, deck).status_code == 404
    assert command(other, deck, 'DELETE').status_code == 404
    add(owner, deck, edition, '2')
    assert client.get(path).json() == snapshot
    republished = command(owner, deck, 'PUT', 'Updated title')
    assert republished.status_code == 200 and republished.json()['token'] == token
    current = client.get(path).json()
    assert current['version'] == 2 and current['total'] == '61' and current['title'] == 'Updated title'
    assert command(owner, deck, 'DELETE').status_code == 200
    revoked = client.get(path)
    unknown = client.get('/api/public/decks/' + 'x'*32)
    assert revoked.status_code == unknown.status_code == 404
    assert revoked.json() == unknown.json()
    new = command(owner, deck).json()['token']
    assert new != token and client.get(path).status_code == 404
    assert client.get(f'/api/public/decks/{new}').json()['version'] == 1


def test_public_reads_do_not_need_private_database_and_storage_outage_is_not_404(monkeypatch):
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    add(owner, deck, edition, '1')
    token = command(owner, deck).json()['token']
    monkeypatch.setenv('DATABASE_URL', 'postgresql://unreachable:1/private')
    assert client.get(f'/api/public/decks/{token}').json()['total'] == '1'
    from pathlib import Path
    (Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json').unlink()
    assert client.get(f'/api/public/decks/{token}').status_code == 503
    assert client.get('/api/public/decks/' + 'z'*32).status_code == 503


def test_failed_object_write_preserves_whole_snapshot_and_retry_recovers(monkeypatch):
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    add(owner, deck, edition, '1')
    token = command(owner, deck).json()['token']
    path = f'/api/public/decks/{token}'
    old = client.get(path).json()
    add(owner, deck, edition, '2')
    key = uuid4()
    with monkeypatch.context() as patch:
        patch.setattr(os, 'replace', lambda *args: (_ for _ in ()).throw(OSError('object storage unavailable')))
        response = command(owner, deck, 'PUT', key=key)
        assert response.status_code == 503
        assert client.get(path).json() == old
    retried = command(owner, deck, 'PUT', key=key)
    assert retried.status_code == 200 and retried.json()['version'] == 2
    assert client.get(path).json()['total'] == '3'
    assert command(owner, deck, 'PUT', key=key).json() == retried.json()
    revoke_key = uuid4()
    with monkeypatch.context() as patch:
        patch.setattr(os, 'replace', lambda *args: (_ for _ in ()).throw(OSError('unavailable')))
        assert command(owner, deck, 'DELETE', key=revoke_key).status_code == 503
    assert command(owner, deck, 'DELETE', key=revoke_key).status_code == 200
    assert client.get(path).status_code == 404


def test_corrupt_projection_returns_safe_unavailable_and_title_is_plain_text():
    from pathlib import Path
    owner, _, _, _, _, _ = fixture()
    deck = create(owner).json()['location']['id']
    for title in ('<script>secret</script>', 'https://example.test', 'x'*121, '   ', 'bad\nname'):
        assert command(owner, deck, title=title).status_code == 422
    token = command(owner, deck, title='Research & testing').json()['token']
    path = Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json'
    value = json.loads(path.read_text())
    value['decks'][token]['snapshot']['owner_id'] = owner
    path.write_text(json.dumps(value))
    response = client.get(f'/api/public/decks/{token}')
    assert response.status_code == 503
    assert owner not in response.text


def test_missing_store_does_not_silently_discard_previously_published_objects():
    from pathlib import Path
    owner, _, _, _, _, _ = fixture()
    deck = create(owner).json()['location']['id']
    command(owner, deck)
    (Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json').unlink()
    assert command(owner, deck, 'PUT').status_code == 503


def test_cross_owner_commands_are_not_found_even_during_public_storage_outage():
    from pathlib import Path
    owner, other, _, _, _, _ = fixture()
    deck = create(owner).json()['location']['id']
    (Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json').unlink()
    assert command(other, deck).status_code == 404
    assert command(other, str(uuid4())).status_code == 404
