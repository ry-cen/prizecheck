"""Characterization of behaviour the shared-core split changes the code under (design-brief WP-B2, split-map section 8).

Each test pins what today's code answers, so a package that moves or rewrites the code can show the answer did not change.
The expected values are today's responses; a failure here after a split is a changed behaviour, not a test to adjust.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
from uuid import uuid4

import psycopg

from test_holdings import call, client, fixture
from test_decks import create
from test_publications import command, list_cards, public_objects  # noqa: F401  (the autouse fixture that gives each test its projection directory)
from test_catalog_reconciliation import run
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_card_attributes import edition_of
from test_deck_format_checks import CARDS, deck_with
from test_deck_lists import change_line
from test_target_format import LEGAL_IN_STANDARD
from app.main import connect


def signed_cursor(context, key):
    """A leaf cursor as the route signs it: base64url of the compact JSON, then its HMAC-SHA256."""
    data = json.dumps({'context': context, 'key': key}, separators=(',', ':')).encode()
    signature = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), data, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(data + signature).decode().rstrip('=')


def test_leaf_holdings_pages_by_quantity():
    owner, _, leaf, _, edition, generation = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        printing = conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s', (edition,)).fetchone()[0]
        # A second Printing in a set that has a printed code (sv02 is PAL); the fixture's own set, base, has none.
        identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,'Raichu') RETURNING id", (str(uuid4()),)).fetchone()[0]
        second = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',%s,%s) RETURNING id", (str(uuid4()), identity)).fetchone()[0]
        conn.execute("""INSERT INTO catalog_generation_printing
          (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,source_fingerprint,basic_energy)
          VALUES (%s,%s,%s,'sv02','Paldea Evolved','7','Raichu','raichu','test','not_basic')""", (generation, second, str(uuid4())))
        # 101 holdings of quantities 1 to 5 across both Printings, so equal quantities tie and Edition id breaks them.
        for index in range(101):
            owner_of = printing if index % 2 else second
            added = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,%s,%s) RETURNING id",
                                 (owner_of, f'qty-{index:03d}', json.dumps({'label': f'Qty {index:03d}'}))).fetchone()[0]
            conn.execute('INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s)', (generation, added, owner_of))
            conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,%s,1)', (owner, leaf, added, index % 5 + 1))
        revisions = conn.execute('SELECT (SELECT revision FROM inventory_owner WHERE user_id=%s) AS owner_revision,(SELECT revision FROM catalog_state WHERE singleton) AS catalog_revision', (owner,)).fetchone()
        rows = conn.execute('SELECT h.edition_id,h.quantity,cgp.set_id FROM holding h JOIN catalog_edition e ON e.id=h.edition_id JOIN catalog_generation_printing cgp ON cgp.generation_id=%s AND cgp.printing_id=e.printing_id WHERE h.owner_id=%s AND h.location_id=%s', (generation, owner, leaf)).fetchall()
    ordered = sorted(rows, key=lambda row: (-row[1], row[0]))
    assert len(ordered) == 101
    first = call('GET', f'/api/holdings/{leaf}?sort=quantity', owner)
    assert first.status_code == 200, first.text
    assert [(h['edition_id'], h['quantity']) for h in first.json()['holdings']] == [(str(row[0]), str(row[1])) for row in ordered[:48]]
    context = [owner, leaf, '', '', '', 'quantity', first.json()['owner_revision'], first.json()['catalog_revision']]
    assert first.json()['next_cursor'] == signed_cursor(context, [str(ordered[47][1]), str(ordered[47][0])])
    page = call('GET', f"/api/holdings/{leaf}?sort=quantity&cursor={first.json()['next_cursor']}", owner)
    assert page.status_code == 200, page.text
    body = page.json()
    assert [(h['edition_id'], h['quantity']) for h in body['holdings']] == [(str(row[0]), str(row[1])) for row in ordered[48:96]]
    codes = {'sv02': 'PAL', 'base': 'base'}
    assert [h['set_code'] for h in body['holdings']] == [codes[row[2]] for row in ordered[48:96]]
    assert {h['set_code'] for h in body['holdings']} == {'PAL', 'base'}
    assert [h['set_id'] for h in body['holdings']] == [row[2] for row in ordered[48:96]]
    assert body['next_cursor'] == signed_cursor(context, [str(ordered[95][1]), str(ordered[95][0])])
    assert body['owner_revision'] == first.json()['owner_revision'] and body['catalog_revision'] == first.json()['catalog_revision']
    last = call('GET', f"/api/holdings/{leaf}?sort=quantity&cursor={body['next_cursor']}", owner)
    assert [(h['edition_id'], h['quantity']) for h in last.json()['holdings']] == [(str(row[0]), str(row[1])) for row in ordered[96:]]
    assert last.json()['next_cursor'] is None


def test_discovery_refuses_an_unreadable_listing():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner, 'Listed deck').json()['location']['id']
    list_cards(owner, deck, {edition: 3})
    token = command(owner, deck).json()['token']
    path = Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json'
    value = json.loads(path.read_text())
    value['decks'][token]['visibility'] = 'friends-only'
    path.write_text(json.dumps(value))
    response = client.get('/api/public/discovery')
    assert response.status_code == 503
    assert response.json() == {'detail': {'code': 'PUBLIC_PROJECTION_UNAVAILABLE'}}
    assert response.headers['x-robots-tag'] == 'index, follow'
    assert response.headers['cache-control'] == 'no-store'


def test_visibility_change_retries_an_unreadable_snapshot():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner, 'Published deck').json()['location']['id']
    list_cards(owner, deck, {edition: 3})
    token = command(owner, deck).json()['token']
    path = Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json'
    value = json.loads(path.read_text())
    value['decks'][token]['snapshot']['owner_id'] = owner  # fails PublicSnapshot validation
    path.write_text(json.dumps(value))
    stored = path.read_bytes()
    key = uuid4()
    response = call('PATCH', f'/api/decks/{deck}/publication/visibility', owner, {'visibility': 'listed', 'idempotency_key': str(key)})
    assert response.status_code == 503
    assert response.json() == {'detail': {'code': 'PUBLICATION_UNAVAILABLE'}}
    assert path.read_bytes() == stored
    with connect() as conn:
        assert conn.execute('SELECT visibility FROM deck_publication WHERE token=%s', (token,)).fetchone()['visibility'] == 'unlisted'
        assert conn.execute('SELECT count(*) AS n FROM publication_command WHERE owner_id=%s AND request_key=%s', (owner, key)).fetchone()['n'] == 0


DISPLAY_KEYS = ('card_kind', 'trainer_type', 'evolves_from', 'evolution_root', 'evolution_stage')


def test_legacy_replay_without_format_checks():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with(LEGAL_IN_STANDARD)
    key = uuid4()
    cut = change_line(owner, deck, edition_of('sv02-278'), '50', 5, key)
    assert cut.status_code == 200, cut.text
    stored = cut.json()
    assert stored['format_checks'] is not None and stored['target_format'] == 'standard'
    assert all(set(DISPLAY_KEYS) <= set(line) for line in stored['deck_list']['lines'])
    # A response stored before display data, the Target Format and format checks: none of those keys.
    old = {name: value for name, value in stored.items() if name not in ('target_format', 'format_checks')}
    old['deck_list'] = {**stored['deck_list'], 'lines': [{name: value for name, value in line.items() if name not in DISPLAY_KEYS}
                                                         for line in stored['deck_list']['lines']]}
    assert 'target_format' not in old and 'format_checks' not in old
    with connect() as conn:
        assert conn.execute('UPDATE location_command SET response=%s WHERE owner_id=%s AND request_key=%s',
                            (json.dumps(old), owner, key)).rowcount == 1
    replay = change_line(owner, deck, edition_of('sv02-278'), '50', 5, key)
    assert replay.status_code == 200, replay.text
    assert replay.json() == {**stored, 'target_format': 'standard', 'format_checks': None}
    assert replay.json()['target_format'] == 'standard' and replay.json()['format_checks'] is None
    assert all(set(DISPLAY_KEYS) <= set(line) for line in replay.json()['deck_list']['lines'])
