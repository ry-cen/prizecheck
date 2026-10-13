"""A collector's provider name, picture and email never reach a public response (OAuth spec #147, story 59)."""
import os
import uuid

import psycopg

from test_decks import create
from test_discovery import visibility
from test_holdings import client, fixture
from test_publications import command, list_cards, public_objects  # noqa: F401  (autouse projection store)

NAME = 'Profile Name Never Public'
IMAGE = 'https://lh3.googleusercontent.com/a/profile-never-public'
EMAIL = f'profile-never-public-{uuid.uuid4().hex}@example.test'


def test_provider_profile_never_reaches_published_deck_discovery_or_sitemap():
    owner, _, _, _, edition, _ = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('INSERT INTO "user"(id,name,email,"emailVerified",image) VALUES (%s,%s,%s,true,%s)',
                     (owner, NAME, EMAIL, IMAGE))
    deck = create(owner, 'Profile privacy deck').json()['location']['id']
    list_cards(owner, deck, {edition: 60})
    published = command(owner, deck, title='Profile privacy')
    assert published.status_code == 200, published.text
    token = published.json()['token']
    assert visibility(owner, deck, 'listed').status_code == 200
    responses = [
        client.get(f'/api/public/decks/{token}'),
        client.get('/api/public/discovery'),
        client.get('/api/public/discovery?q=Profile'),
        client.get('/api/public/sitemap.xml'),
    ]
    assert all(response.status_code == 200 for response in responses)
    version = f'/api/public/decks/{token}/versions/1'
    for suffix in ('cost', 'format-checks', 'exports/live', 'exports/live.txt', 'exports/tcgplayer',
                   'exports/tcgplayer.txt'):
        response = client.get(f'{version}/{suffix}')
        # format-checks answers a documented 503 when the fixture has no public catalog; anything else must be < 500.
        assert response.status_code < 500 or 'PUBLIC_CATALOG_UNAVAILABLE' in response.text, (suffix, response.status_code)
        responses.append(response)
    assert any(token in response.text or 'Profile privacy' in response.text for response in responses)
    for response in responses:
        for private in (NAME, IMAGE, EMAIL, 'profile-never-public'):
            assert private not in response.text
