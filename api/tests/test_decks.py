"""Physical Deck behavior through authenticated HTTP against PostgreSQL."""
from uuid import uuid4
from test_holdings import fixture, call, add
from test_moves import start, stage, selected, commit


def create(owner, name='Physical Deck', key=None):
    return call('POST', '/api/decks', owner, {'name': name, 'idempotency_key': str(key or uuid4())})


def test_deck_creation_private_index_child_rejection_and_move_checks():
    owner, other, source, _, edition, _ = fixture()
    key = uuid4()
    response = create(owner, key=key)
    assert response.status_code == 201, response.text
    deck = response.json()['location']
    assert deck['kind'] == 'deck'
    assert create(owner, key=key).json() == response.json()
    assert call('GET', '/api/decks', owner).json()['decks'][0]['id'] == deck['id']
    assert call('GET', '/api/decks', other).json()['decks'] == []
    assert call('GET', f"/api/decks/{deck['id']}", other).status_code == 404
    child = call('POST', '/api/location-tree', owner, {'name': 'Child', 'parent_id': deck['id'], 'parent_version': 1, 'idempotency_key': str(uuid4())})
    assert child.json()['detail']['code'] == 'DECK_CANNOT_HAVE_CHILDREN'
    holding = add(owner, source, edition, '59').json()
    manifest = start(owner, source)
    stage(owner, manifest, [selected(edition, 59, holding['version'])])
    assert commit(owner, manifest, deck['id']).status_code == 200
    checks = call('GET', f"/api/decks/{deck['id']}", owner).json()['checks']
    assert checks['total'] == '59' and checks['shortage'] == '1' and checks['excess'] == '0'
    assert checks['identities'][0]['status'] == 'over_limit'
    assert checks['identities'][0]['quantity'] == '59'
    holding = add(owner, deck['id'], edition, '1').json()
    assert call('GET', f"/api/decks/{deck['id']}", owner).json()['checks']['size_status'] == 'complete'
    holding = add(owner, deck['id'], edition, '1').json()
    checks = call('GET', f"/api/decks/{deck['id']}", owner).json()['checks']
    assert checks['total'] == '61' and checks['excess'] == '1'
    manifest = start(owner, deck['id'])
    stage(owner, manifest, [selected(edition, 2, holding['version'])])
    assert commit(owner, manifest, source).status_code == 200
    assert call('GET', f"/api/decks/{deck['id']}", owner).json()['checks']['total'] == '59'


def test_four_copy_groups_printings_and_editions_and_requires_supported_energy():
    import os
    import psycopg
    owner, _, _, _, first, generation = fixture()
    deck = create(owner).json()['location']['id']
    # Three physically different Editions in two Printings share one Card Identity.
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        printing, identity = conn.execute('SELECT p.id,p.identity_id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE e.id=%s', (first,)).fetchone()
        second = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'reverse','{\"finish\":\"reverse\"}') RETURNING id", (printing,)).fetchone()[0]
        other_printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',%s,%s) RETURNING id", (str(uuid4()), identity)).fetchone()[0]
        third = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'normal','{}') RETURNING id", (other_printing,)).fetchone()[0]
        conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,source_fingerprint,basic_energy)
          VALUES (%s,%s,%s,'other','Other Set','4','Pikachu','pikachu','test','not_basic')""", (generation, other_printing, str(uuid4())))
        conn.execute('INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s),(%s,%s,%s)', (generation, second, printing, generation, third, other_printing))
    for edition, amount in ((first, '2'), (str(second), '1'), (str(third), '2')):
        assert add(owner, deck, edition, amount).status_code == 200
    result = call('GET', f'/api/decks/{deck}', owner).json()['checks']
    assert len(result['identities']) == 1
    assert result['identities'][0]['quantity'] == '5' and result['identities'][0]['status'] == 'over_limit'
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute("UPDATE catalog_generation_printing SET basic_energy='unresolved' WHERE generation_id=%s", (generation,))
    assert call('GET', f'/api/decks/{deck}', owner).json()['checks']['identities'][0]['status'] == 'unresolved'
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute("UPDATE catalog_generation_printing SET basic_energy='supported' WHERE generation_id=%s", (generation,))
    assert call('GET', f'/api/decks/{deck}', owner).json()['checks']['identities'][0]['status'] == 'basic_energy_exempt'


def test_deck_index_pages_bind_owner_and_inventory_revision():
    owner, other, _, _, _, _ = fixture()
    for index in range(32):
        assert create(owner, f'Deck {index:02}').status_code == 201
    first = call('GET', '/api/decks', owner).json()
    assert len(first['decks']) == 30 and first['next_cursor']
    second = call('GET', '/api/decks?cursor=' + first['next_cursor'], owner).json()
    assert [deck['name'] for deck in second['decks']] == ['Deck 30', 'Deck 31']
    assert second['next_cursor'] is None
    assert call('GET', '/api/decks?cursor=' + first['next_cursor'], other).status_code == 400
    assert call('GET', '/api/decks?cursor=invalid', owner).status_code == 400
    create(owner, 'Later')
    stale = call('GET', '/api/decks?cursor=' + first['next_cursor'], owner)
    assert stale.status_code == 409 and stale.json()['detail']['code'] == 'INVENTORY_CHANGED'
