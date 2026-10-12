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


def list_cards(owner, deck, quantities):
    """Make the Deck's Deck List exactly ``{edition_id: quantity}`` (fixture state written to PostgreSQL), whatever the Deck
    holds: a published snapshot reads only these lines. Once Holdings added to a Deck extend its Deck List (ticket 05),
    copies already added are simply overwritten here. Advances the Deck List revision."""
    import psycopg
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('DELETE FROM deck_list_line WHERE owner_id=%s AND deck_id=%s', (owner, deck))
        for edition, quantity in quantities.items():
            conn.execute('INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity) VALUES (%s,%s,%s,%s)',
                         (owner, deck, edition, int(quantity)))
        assert conn.execute('UPDATE deck_list SET revision=revision+1 WHERE owner_id=%s AND deck_id=%s',
                            (owner, deck)).rowcount == 1


def command(owner, deck, method='POST', title='Public deck', key=None):
    body = {'idempotency_key': str(key or uuid4())}
    if method != 'DELETE':
        body['title'] = title
    return call(method, f'/api/decks/{deck}/publication', owner, body)


REF = '^[0-9a-f]{48}$'


def stored_decks():
    from pathlib import Path
    return json.loads((Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json').read_text())


def edition_refs(edition):
    import psycopg
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        return conn.execute("""SELECT e.public_ref,p.public_ref FROM catalog_edition e
          JOIN catalog_printing p ON p.id=e.printing_id WHERE e.id=%s""", (edition,)).fetchone()


def published_refs(snapshot):
    return [(e['edition_ref'], e['printing_ref']) for i in snapshot['identities'] for e in i['editions']]


def legacy_snapshot(token):
    """Rewrite one published snapshot as a pre-reference object, in canonical jsonb key order."""
    import psycopg
    from pathlib import Path
    path = Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json'
    state = json.loads(path.read_text())
    snapshot = state['decks'][token]['snapshot']
    for identity in snapshot['identities']:
        for edition in identity['editions']:
            del edition['edition_ref'], edition['printing_ref']
            edition.pop('printing_name', None)  # published before Deck Lists 09
    # A format pydantic would re-render ('Z'), so a model round trip is detectable.
    snapshot['published_at'] = '2025-01-02T03:04:05.123456+00:00'
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        snapshot = conn.execute('SELECT %s::jsonb', (json.dumps(snapshot),)).fetchone()[0]
    state['decks'][token]['snapshot'] = snapshot
    path.write_text(json.dumps(state, ensure_ascii=False, separators=(',', ':')))
    return snapshot


def snapshot_text(token):
    return json.dumps(stored_decks()['decks'][token]['snapshot'], ensure_ascii=False, separators=(',', ':'))


def test_legacy_snapshot_without_references_reads_without_guessed_associations():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    list_cards(owner, deck, {edition: 3})
    token = command(owner, deck).json()['token']
    legacy_snapshot(token)
    response = client.get(f'/api/public/decks/{token}')
    assert response.status_code == 200
    # Absent references stay absent in the stored object; the typed read model reports them as null.
    for identity in stored_decks()['decks'][token]['snapshot']['identities']:
        for stored in identity['editions']:
            assert 'edition_ref' not in stored and 'printing_ref' not in stored and 'printing_name' not in stored
    for identity in response.json()['identities']:
        for shown in identity['editions']:
            assert shown['edition_ref'] is None and shown['printing_ref'] is None and shown['printing_name'] is None
            assert shown['quantity'] == '3'


def test_owner_visibility_change_on_legacy_snapshot_leaves_stored_json_byte_identical():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    list_cards(owner, deck, {edition: 3})
    token = command(owner, deck).json()['token']
    legacy_snapshot(token)
    before = snapshot_text(token)
    assert 'edition_ref' not in before
    for visibility in ('listed', 'unlisted'):
        response = call('PATCH', f'/api/decks/{deck}/publication/visibility', owner,
                        {'visibility': visibility, 'idempotency_key': str(uuid4())})
        assert response.status_code == 200, response.text
        assert stored_decks()['decks'][token]['visibility'] == visibility
        after = snapshot_text(token)
        assert after == before
        assert 'edition_ref' not in after and 'printing_ref' not in after and 'printing_name' not in after
        assert '2025-01-02T03:04:05.123456+00:00' in after


def test_snapshot_allowlist_private_edits_republish_revoke_and_burned_url():
    owner, other, leaf, _, edition, _ = fixture()
    deck = create(owner, 'Private name never public').json()['location']['id']
    add(owner, leaf, edition, '50')
    list_cards(owner, deck, {edition: 59})
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
    assert set(identity['editions'][0]) == {'set_id','set_name','collector_number','variant','image_url','quantity','edition_ref','printing_ref','printing_name'}
    assert identity['editions'][0]['printing_name'] == 'Pikachu'
    assert published_refs(snapshot) == [edition_refs(edition)]
    assert all(__import__('re').fullmatch(REF[1:-1], ref) for pair in published_refs(snapshot) for ref in pair)
    assert set(snapshot['checks']) == {'size_status','shortage','excess','identities','disclaimer'}
    assert set(snapshot['checks']['identities'][0]) == {'name','quantity','status'}
    serialized = json.dumps(snapshot)
    for private in (owner, other, leaf, deck, edition, 'Private name never public', 'location_id', 'owner_id', 'email', 'owner_revision'):
        assert private not in serialized
    assert command(other, deck).status_code == 404
    assert command(other, deck, 'DELETE').status_code == 404
    list_cards(owner, deck, {edition: 61})
    add(owner, deck, edition, '2')
    assert client.get(path).json() == snapshot
    republished = command(owner, deck, 'PUT', 'Updated title')
    assert republished.status_code == 200 and republished.json()['token'] == token
    current = client.get(path).json()
    assert current['version'] == 2 and current['total'] == '61' and current['title'] == 'Updated title'
    assert published_refs(current) == [edition_refs(edition)]
    assert [e['quantity'] for i in current['identities'] for e in i['editions']] == ['61']
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
    list_cards(owner, deck, {edition: 1})
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
    list_cards(owner, deck, {edition: 1})
    token = command(owner, deck).json()['token']
    path = f'/api/public/decks/{token}'
    old = client.get(path).json()
    refs = edition_refs(edition)
    assert published_refs(old) == [refs]
    list_cards(owner, deck, {edition: 3})
    key = uuid4()
    with monkeypatch.context() as patch:
        patch.setattr(os, 'replace', lambda *args: (_ for _ in ()).throw(OSError('object storage unavailable')))
        response = command(owner, deck, 'PUT', key=key)
        assert response.status_code == 503
        assert client.get(path).json() == old
    # The failed command is durably queued with its references; the old object is untouched.
    assert published_refs(client.get(path).json()) == [refs]
    retried = command(owner, deck, 'PUT', key=key)
    assert retried.status_code == 200 and retried.json()['version'] == 2
    replayed = client.get(path).json()
    assert replayed['total'] == '3'
    assert published_refs(replayed) == [refs]
    assert [e['quantity'] for i in replayed['identities'] for e in i['editions']] == ['3']
    assert command(owner, deck, 'PUT', key=key).json() == retried.json()
    revoke_key = uuid4()
    with monkeypatch.context() as patch:
        patch.setattr(os, 'replace', lambda *args: (_ for _ in ()).throw(OSError('unavailable')))
        assert command(owner, deck, 'DELETE', key=revoke_key).status_code == 503
    assert command(owner, deck, 'DELETE', key=revoke_key).status_code == 200
    assert client.get(path).status_code == 404


def test_failed_republish_replay_cannot_revive_a_revoked_token_or_erase_the_invalidation(monkeypatch):
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    list_cards(owner, deck, {edition: 1})
    token = command(owner, deck).json()['token']
    path = f'/api/public/decks/{token}'
    stale = uuid4()
    with monkeypatch.context() as patch:
        patch.setattr(os, 'replace', lambda *args: (_ for _ in ()).throw(OSError('object storage unavailable')))
        assert command(owner, deck, 'PUT', key=stale).status_code == 503
    # The queued PUT is replayed before the DELETE, which is then the newest authority.
    assert command(owner, deck, 'DELETE').status_code == 200
    assert client.get(path).status_code == 404 and token not in stored_decks()['decks']
    replay = command(owner, deck, 'PUT', key=stale)
    assert replay.status_code == 200 and replay.json()['revoked'] is False
    assert client.get(path).status_code == 404 and token not in stored_decks()['decks']


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


def test_private_and_public_checks_share_rules_without_private_identity_serialization():
    import psycopg
    owner,_,_,_,edition,generation=fixture()
    deck=create(owner,'Private rules fixture').json()['location']['id']
    list_cards(owner,deck,{edition:5})
    # Both read the Basic Energy card attribute (migration 030).
    for basic_energy,status in [(False,'over_limit'),(None,'unresolved'),(True,'basic_energy_exempt')]:
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            conn.execute('UPDATE catalog_derived_attribute SET basic_energy=%s WHERE printing_id=(SELECT printing_id FROM catalog_edition WHERE id=%s)',(basic_energy,edition))
        # Publication checks the Deck List, so the private Deck List checks are the comparison.
        private=call('GET',f'/api/decks/{deck}',owner).json()['deck_list_checks']
        publication=command(owner,deck,'POST' if basic_energy is False else 'PUT').json()
        public=client.get(f"/api/public/decks/{publication['token']}").json()['checks']
        expected={'size_status':'shortage','shortage':'55','excess':'0'}
        assert {key:private[key] for key in expected}==expected
        assert {key:public[key] for key in expected}==expected
        assert private['identities'][0]['status']==public['identities'][0]['status']==status
        assert set(public['identities'][0])=={'name','quantity','status'}
        assert private['identities'][0]['identity_id'] not in json.dumps(public)
