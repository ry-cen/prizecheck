"""Listed discovery through private visibility commands and public projection reads."""
from uuid import uuid4
import os
import pytest
from test_holdings import fixture, call, client
from test_decks import create
from test_publications import command, list_cards, public_objects, publish_gate_fixture


def visibility(owner, deck, value, key=None):
    """Change the Deck's publication visibility. These tests list small Deck Lists that aren't legal in any Format, so a
    snapshot listed here is exempt from Discover's legality filter (``publish_gate_fixture.exempt_listing``); Discover's
    own tests (test_discover_listing.py) list through the route and exempt nothing."""
    response = call('PATCH', f'/api/decks/{deck}/publication/visibility', owner,
                    {'visibility': value, 'idempotency_key': str(key or uuid4())})
    if response.status_code == 200 and value == 'listed':
        publish_gate_fixture.exempt_listing(response.json()['token'])
    return response


def test_listing_changes_next_public_request_without_mutating_snapshot(monkeypatch):
    owner, other, _, _, edition, _ = fixture()
    deck = create(owner, 'Secret private box').json()['location']['id']
    list_cards(owner, deck, {edition: 59})
    token = command(owner, deck, title='Friends & rivals').json()['token']
    path = f'/api/public/decks/{token}'
    before = client.get(path).json()
    assert client.get('/api/public/discovery').json()['decks'] == []
    assert token not in client.get('/api/public/sitemap.xml').text
    assert visibility(other, deck, 'listed').status_code == 404
    key = uuid4()
    changed = visibility(owner, deck, 'listed', key)
    assert changed.status_code == 200, changed.text
    assert visibility(owner, deck, 'listed', key).json() == changed.json()
    assert client.get(path).json() == before
    assert client.get(path).headers['x-robots-tag'] == 'index, follow'
    listed = client.get('/api/public/discovery?q=rivals').json()['decks']
    assert len(listed) == 1
    assert set(listed[0]) == {'url','title','total','published_at','checks','image_url','featured_name','target_format',
                              'target_format_status','cost'}
    assert listed[0]['title'] == 'Friends & rivals' and listed[0]['total'] == '59'
    assert len(client.get('/api/public/discovery?q=Pikachu').json()['decks']) == 1
    assert client.get('/api/public/discovery?q=Secret').json()['decks'] == []
    sitemap = client.get('/api/public/sitemap.xml').text
    assert f'/published/{token}' in sitemap and owner not in sitemap and deck not in sitemap
    list_cards(owner, deck, {edition: 61})
    assert client.get('/api/public/discovery').json()['decks'][0]['total'] == '59'
    with monkeypatch.context() as patch:
        patch.setenv('DATABASE_URL', 'postgresql://unreachable:1/private')
        assert client.get('/api/public/discovery').status_code == 200
        assert client.get('/api/public/sitemap.xml').status_code == 200
    assert visibility(owner, deck, 'unlisted').status_code == 200
    assert client.get('/api/public/discovery').json()['decks'] == []
    assert token not in client.get('/api/public/sitemap.xml').text
    assert client.get(path).headers['x-robots-tag'] == 'noindex, nofollow'
    assert client.get(path).json() == before


@pytest.mark.slow(reason='capacity: publishes 32 Decks')
def test_discovery_pages_are_bounded_recent_and_revision_query_bound():
    owner, _, _, _, edition, _ = fixture()
    decks = []
    for index in range(32):
        deck = create(owner, f'Private {index}').json()['location']['id']
        list_cards(owner, deck, {edition: 1})
        token = command(owner, deck, title=f'Public {index:02}').json()['token']
        assert visibility(owner, deck, 'listed').status_code == 200
        decks.append((deck,token))
    first = client.get('/api/public/discovery').json()
    assert len(first['decks']) == 30 and first['next_cursor']
    assert first['decks'][0]['title'] == 'Public 31'
    second = client.get('/api/public/discovery', params={'cursor':first['next_cursor']}).json()
    assert [item['title'] for item in second['decks']] == ['Public 01','Public 00']
    assert second['next_cursor'] is None
    assert client.get('/api/public/discovery', params={'cursor':first['next_cursor'], 'q':'Pikachu'}).status_code == 400
    assert client.get('/api/public/discovery?cursor=invalid').status_code == 400
    assert visibility(owner, decks[-1][0], 'unlisted').status_code == 200
    stale = client.get('/api/public/discovery', params={'cursor':first['next_cursor']})
    assert stale.status_code == 409 and stale.json()['detail']['code'] == 'DISCOVERY_CHANGED'
    assert command(owner, decks[0][0], 'DELETE').status_code == 200
    assert decks[0][1] not in client.get('/api/public/sitemap.xml').text


def test_failed_visibility_object_write_is_atomic_and_idempotently_recoverable(monkeypatch):
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    list_cards(owner, deck, {edition: 1})
    token = command(owner, deck).json()['token']
    key = uuid4()
    with monkeypatch.context() as patch:
        patch.setattr(os, 'replace', lambda *args: (_ for _ in ()).throw(OSError('unavailable')))
        assert visibility(owner, deck, 'listed', key).status_code == 503
        assert client.get('/api/public/discovery').json()['decks'] == []
        assert token not in client.get('/api/public/sitemap.xml').text
        assert client.get(f'/api/public/decks/{token}').headers['x-robots-tag'] == 'noindex, nofollow'
    assert visibility(owner, deck, 'listed', key).status_code == 200
    assert len(client.get('/api/public/discovery').json()['decks']) == 1
    assert client.get(f'/api/public/decks/{token}').json()['version'] == 1
