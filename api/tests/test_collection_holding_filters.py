"""Search, filters and sort on the workspace Holding listing, and the owned-set list (ticket #104)."""
import itertools
import json
import os
from urllib.parse import urlencode
from uuid import uuid4

import psycopg

from app.games.pokemon.catalog.card_attributes import ATTRIBUTE_COLUMNS, RULES, derive, derive_evolves_from
from test_collection_holdings import PAGE, location
from test_holdings import add, call, fixture


def card(conn, generation, name, set_id, set_name, number, category=None, types=None, trainer_type=None):
    """One Edition of a new Printing in the active generation, with its retained source record and the card attributes
    the derivation rules give that record (Collection's filters read the effective attributes, migration 041). The row
    is written directly: re-deriving the whole catalog would also rewrite other tests' hand-made attribute rows."""
    identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id",
                            (str(uuid4()), name)).fetchone()[0]
    source_id = str(uuid4())
    printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',%s,%s) RETURNING id",
                            (source_id, identity)).fetchone()[0]
    edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'unspecified','{}') RETURNING id",
                           (printing,)).fetchone()[0]
    conn.execute("""INSERT INTO catalog_generation_printing
      (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,source_fingerprint,basic_energy)
      VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'test','not_basic')""",
                 (generation, printing, str(uuid4()), set_id, set_name, number, name, name.lower()))
    conn.execute("INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s)",
                 (generation, edition, printing))
    record = {"name": name, **({"category": category} if category else {}), **({"types": types} if types else {}),
              **({"trainerType": trainer_type} if trainer_type else {})}
    conn.execute("UPDATE catalog_printing_metadata SET source_record=%s WHERE printing_id=%s", (json.dumps(record), printing))
    attributes = derive(source_id, record)
    values = [list(value) if column == "types" and value is not None else value
              for column, value in zip(ATTRIBUTE_COLUMNS, (getattr(attributes, column) for column in ATTRIBUTE_COLUMNS))]
    conn.execute(f"""INSERT INTO catalog_derived_attribute(printing_id,rules_version,{','.join(ATTRIBUTE_COLUMNS)},evolves_from)
      VALUES (%s,%s,{','.join(['%s'] * len(ATTRIBUTE_COLUMNS))},%s)""",
                 (printing, RULES.VERSION, *values, derive_evolves_from(record)))
    return str(edition)


def listing(user, **params):
    query = urlencode({key: value for key, value in params.items() if value is not None})
    return call('GET', '/api/collection/holdings' + (f'?{query}' if query else ''), user)


def names(response):
    assert response.status_code == 200, response.text
    return [(row['printing_name'], row['location_name']) for row in response.json()['holdings']]


def editions(response):
    """Edition names in listing order, each once (an Edition's Holdings are adjacent)."""
    order = []
    for name, _ in names(response):
        if not order or order[-1] != name:
            order.append(name)
    assert len(order) == len(set(order)), order
    return order


def seed():
    """Six Printings across two sets and two leaves. Collector numbers 1, 4 and 10 test numeric order."""
    owner, other, unsorted, other_leaf, _, generation = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        e = {
            'Abra': card(conn, generation, 'Abra', 'base', 'Base Set', '10', 'Pokemon', ['Psychic']),
            'Charmander': card(conn, generation, 'Charmander', 'base', 'Base Set', '4', 'Pokemon', ['Fire']),
            'Fire Energy': card(conn, generation, 'Fire Energy', 'jungle', 'Jungle', '2', 'Energy', ['Fire']),
            'Mew': card(conn, generation, 'Mew', 'jungle', 'Jungle', '1', 'Pokemon', ['Psychic', 'Water']),
            'Potion': card(conn, generation, 'Potion', 'base', 'Base Set', '1', 'Trainer', trainer_type='Item'),
            'Unknown': card(conn, generation, 'Unknown', 'promo', 'Promo', 'SWSH001'),
        }
        alpha = location(conn, owner, 'alpha')
        beta = location(conn, owner, 'beta')
    for leaf, name, quantity in ((alpha, 'Abra', '1'), (alpha, 'Charmander', '3'), (beta, 'Charmander', '1'),
                                 (beta, 'Fire Energy', '2'), (alpha, 'Mew', '4'), (beta, 'Potion', '5'),
                                 (beta, 'Unknown', '1')):
        response = add(owner, leaf, e[name], quantity)
        assert response.status_code == 200, response.text
    assert add(other, other_leaf, e['Abra'], '9').status_code == 200
    return owner, other, alpha, beta, e


def test_listing_filters_by_name_set_category_trainer_type_and_elemental_type():
    owner, other, alpha, beta, _ = seed()
    everything = listing(owner)
    assert editions(everything) == ['Abra', 'Charmander', 'Fire Energy', 'Mew', 'Potion', 'Unknown']
    rows = {row['printing_name']: row for row in everything.json()['holdings']}
    assert (rows['Mew']['category'], rows['Mew']['elemental_types']) == ('Pokemon', ['Psychic', 'Water'])
    assert (rows['Potion']['category'], rows['Potion']['elemental_types']) == ('Trainer', [])
    assert (rows['Unknown']['category'], rows['Unknown']['elemental_types']) == (None, [])
    assert (rows['Potion']['trainer_type'], rows['Mew']['trainer_type'], rows['Unknown']['trainer_type']) == (
        'item', None, None)

    # Name search: case-insensitive substring; % and _ are literal characters.
    assert editions(listing(owner, name='  CHAR ')) == ['Charmander']
    assert editions(listing(owner, name='e')) == ['Charmander', 'Fire Energy', 'Mew']
    assert editions(listing(owner, name='%')) == [] and editions(listing(owner, name='_')) == []
    assert editions(listing(owner, set_id='jungle')) == ['Fire Energy', 'Mew']
    assert editions(listing(owner, category='Pokemon')) == ['Abra', 'Charmander', 'Mew']
    assert editions(listing(owner, category='Trainer')) == ['Potion']
    assert editions(listing(owner, category='Energy')) == ['Fire Energy']
    assert editions(listing(owner, trainer_type='item')) == ['Potion']
    assert editions(listing(owner, trainer_type='supporter')) == []
    # Elemental types are a Pokémon's types (the effective card attributes): a Basic Energy has none.
    assert editions(listing(owner, elemental_type='Fire')) == ['Charmander']
    # A dual-type card matches either type.
    assert editions(listing(owner, elemental_type='Water')) == ['Mew']
    assert editions(listing(owner, elemental_type='Psychic')) == ['Abra', 'Mew']
    # Filters combine independently.
    assert editions(listing(owner, set_id='base', elemental_type='Psychic')) == ['Abra']
    assert editions(listing(owner, set_id='jungle', category='Pokemon', elemental_type='Psychic')) == ['Mew']
    assert editions(listing(owner, set_id='jungle', category='Trainer')) == []
    assert editions(listing(owner, name='a', category='Pokemon', location_id=alpha)) == ['Abra', 'Charmander']
    assert names(listing(owner, name='char', location_id=beta)) == [('Charmander', 'beta')]
    # Totals describe the filtered view, so the grid's size matches what is listed.
    assert listing(owner, elemental_type='Fire').json()['totals'] == {'holdings': 2, 'editions': 1, 'copies': '4'}
    assert listing(owner, category='Trainer', set_id='jungle').json()['totals'] == {'holdings': 0, 'editions': 0, 'copies': '0'}
    # Another owner's copies never show up.
    assert names(listing(other, elemental_type='Psychic')) == [('Abra', 'Unsorted')]
    for bad in ({'category': 'Item'}, {'trainer_type': 'Item'}, {'elemental_type': 'Plasma'}, {'sort': 'price-asc'}, {'sort': 'name'},
                {'name': 'x' * 121}, {'set_id': 'x' * 81}):
        assert listing(owner, **bad).status_code == 422, bad


def test_listing_sorts_by_name_set_number_and_quantity_in_the_view():
    owner, _, alpha, beta, _ = seed()
    assert editions(listing(owner, sort='name-asc')) == ['Abra', 'Charmander', 'Fire Energy', 'Mew', 'Potion', 'Unknown']
    assert editions(listing(owner, sort='name-desc')) == ['Unknown', 'Potion', 'Mew', 'Fire Energy', 'Charmander', 'Abra']
    # Set name, then collector number in numeric order (1, 4, 10).
    assert editions(listing(owner, sort='set-asc')) == ['Potion', 'Charmander', 'Abra', 'Mew', 'Fire Energy', 'Unknown']
    assert editions(listing(owner, sort='set-desc')) == ['Unknown', 'Fire Energy', 'Mew', 'Abra', 'Charmander', 'Potion']
    # Quantity is the Card Edition's total in the current view; ties read A–Z either way.
    assert editions(listing(owner, sort='quantity-desc')) == ['Potion', 'Charmander', 'Mew', 'Fire Energy', 'Abra', 'Unknown']
    assert editions(listing(owner, sort='quantity-asc')) == ['Abra', 'Unknown', 'Fire Energy', 'Charmander', 'Mew', 'Potion']
    # In beta Charmander has 1 copy, not 4, so it falls behind Fire Energy.
    assert editions(listing(owner, sort='quantity-desc', location_id=beta)) == ['Potion', 'Fire Energy', 'Charmander', 'Unknown']
    # Filters keep or drop whole Editions; the sort applies to what is left.
    assert editions(listing(owner, sort='quantity-asc', category='Pokemon')) == ['Abra', 'Charmander', 'Mew']
    # Copies of one Edition keep source Location order whatever the direction.
    for sort in ('name-asc', 'name-desc', 'set-desc', 'quantity-desc'):
        charmander = [leaf for name, leaf in names(listing(owner, sort=sort)) if name == 'Charmander']
        assert charmander == ['alpha', 'beta'], sort


def test_sorted_and_filtered_pages_walk_every_holding_once_and_bind_cursors_to_the_query():
    owner, other, unsorted, _, edition, generation = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        binder = location(conn, owner, 'binder')
        case = location(conn, owner, 'case')
        printing = conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s', (edition,)).fetchone()[0]
        conn.execute("UPDATE catalog_printing_metadata SET source_record=%s WHERE printing_id=%s",
                     (json.dumps({'category': 'Pokemon', 'types': ['Lightning']}), printing))
        many = sorted(str(row[0]) for row in conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          SELECT %s,'walk-'||n,'{}'::jsonb FROM generate_series(1,600) n RETURNING id""", (printing,)).fetchall())
        # Quantities 1-7 in binder and 1 in Unsorted give many equal Edition totals, so ties are exercised.
        quantity = {edition_id: 1 + index % 7 for index, edition_id in enumerate(many)}
        conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,id,q,1 FROM unnest(%s::uuid[],%s::int[]) AS t(id,q)""",
                     (owner, binder, many, [quantity[edition_id] for edition_id in many]))
        conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,id,1,1 FROM unnest(%s::uuid[]) id""", (owner, unsorted, many))
        # A third place for one Edition makes a page boundary split that Edition's Holdings.
        conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,1,1)',
                     (owner, case, many[0]))
        trainer = card(conn, generation, 'Walk Trainer', 'base', 'Base Set', '99', 'Trainer')
        conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,9,1)',
                     (owner, binder, trainer))
    places = {edition_id: [binder, unsorted] for edition_id in many}
    places[many[0]] = [binder, case, unsorted]
    total = {edition_id: quantity[edition_id] + 1 + (edition_id == many[0]) for edition_id in many}

    def walk(**params):
        pages, cursor = [], None
        while True:
            response = listing(owner, cursor=cursor, **params)
            assert response.status_code == 200, response.text
            pages.append(response.json())
            cursor = pages[-1]['next_cursor']
            if not cursor:
                return pages

    def rows(pages):
        return [(row['edition_id'], row['location_id']) for page in pages for row in page['holdings']]

    # Same name everywhere, so quantity ties fall back to Edition id; Locations always ascend by path.
    by_quantity = sorted(many, key=lambda edition_id: (-total[edition_id], edition_id))
    pages = walk(sort='quantity-desc', category='Pokemon')
    assert [len(page['holdings']) for page in pages] == [PAGE, PAGE, 201]
    assert pages[0]['totals'] == {'holdings': 1201, 'editions': 600, 'copies': str(sum(total.values()))}
    assert rows(pages) == [(edition_id, leaf) for edition_id in by_quantity for leaf in places[edition_id]]
    split = rows(pages)
    assert any(split[n - 1][0] == split[n][0] for n in (PAGE, 2 * PAGE))  # a boundary splits an Edition

    pages = walk(sort='name-desc', elemental_type='Lightning')
    assert rows(pages) == [(edition_id, leaf) for edition_id in reversed(many) for leaf in places[edition_id]]
    assert walk(sort='set-asc', category='Trainer')[0]['holdings'][0]['edition_id'] == trainer

    second = walk(sort='quantity-desc', category='Pokemon')[0]['next_cursor']
    for wrong in (dict(sort='quantity-asc', category='Pokemon'), dict(sort='quantity-desc'),
                  dict(sort='quantity-desc', category='Pokemon', name='p'),
                  dict(sort='quantity-desc', category='Pokemon', elemental_type='Lightning'),
                  dict(sort='quantity-desc', category='Pokemon', trainer_type='item'),
                  dict(sort='quantity-desc', category='Pokemon', set_id='base'),
                  dict(sort='quantity-desc', category='Pokemon', location_id=binder)):
        response = listing(owner, cursor=second, **wrong)
        assert response.status_code == 400 and response.json()['detail']['code'] == 'INVALID_CURSOR', (wrong, response.text)
    assert listing(other, cursor=second, sort='quantity-desc', category='Pokemon').status_code == 400


def test_every_sort_walks_a_realistic_collection_in_reference_order():
    owner, _, _, _, _, generation = fixture()
    sets = (('base', 'Base Set'), ('jungle', 'Jungle'), ('promo', 'Promo'))
    # Numbers collide on their leading digits (1, 01, 001, 10, 100) and one is not numeric.
    numbers = ('1', '01', '10', '001', '100', 'SWSH001', '2', '20')
    info, held = {}, {}
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        leaves = {name: location(conn, owner, name) for name in ('alpha', 'beta', 'gamma')}
        for index in range(270):
            set_id, set_name = sets[index % 3]
            number = numbers[(index // 3 + index) % len(numbers)]
            name = f'Card {index % 50:02d}'
            edition = card(conn, generation, name, set_id, set_name, number, 'Pokemon', ['Fire'])
            info[edition] = {'name': name.lower(), 'set_key': set_name.lower(), 'set_id': set_id, 'number': number}
            places = [('alpha', 1 + index % 4)]
            if index % 3:
                places.append(('beta', 1 + index % 5))
            if index % 3 == 2:
                places.append(('gamma', 2))
            held[edition] = places
            for place, quantity in places:
                conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,%s,1)',
                             (owner, leaves[place], edition, quantity))
    expected_pairs = {(edition, leaves[place]) for edition, places in held.items() for place, _ in places}
    assert len(expected_pairs) > PAGE
    total = {edition: sum(quantity for _, quantity in places) for edition, places in held.items()}
    order = ('alpha', 'beta', 'gamma')

    def number_key(number):
        digits = ''.join(itertools.takewhile(str.isdigit, number))
        return (not digits, int(digits or 0), number.lower())

    def reference(sort):
        key, direction = sort.split('-')
        down = direction == 'desc'
        if key == 'name':
            ranked = sorted(info, key=lambda e: (info[e]['name'], e), reverse=down)
        elif key == 'set':
            ranked = sorted(info, key=lambda e: (info[e]['set_key'], info[e]['set_id'], *number_key(info[e]['number']), e),
                            reverse=down)
        else:  # Ties read A-Z in both directions.
            ranked = sorted(info, key=lambda e: (-total[e] if down else total[e], info[e]['name'], e))
        return [(edition, leaves[place]) for edition in ranked
                for place in sorted((place for place, _ in held[edition]), key=order.index)]

    for sort in ('name-asc', 'name-desc', 'set-asc', 'set-desc', 'quantity-asc', 'quantity-desc'):
        walked, cursor, pages = [], None, 0
        while True:
            response = listing(owner, sort=sort, cursor=cursor)
            assert response.status_code == 200, (sort, response.text)
            body = response.json()
            pages += 1
            walked += [(row['edition_id'], row['location_id']) for row in body['holdings']]
            cursor = body['next_cursor']
            if not cursor:
                break
        assert pages >= 2, sort
        assert len(walked) == len(set(walked)), sort  # no duplicate (edition, location) pair
        assert set(walked) == expected_pairs, sort  # every Holding, once
        seen = []
        for edition_id, _ in walked:
            if not seen or seen[-1] != edition_id:
                seen.append(edition_id)
        assert len(seen) == len(set(seen)), sort  # each Edition's Holdings are adjacent
        assert walked == reference(sort), sort  # Location order within an Edition and the whole order


def test_owned_sets_list_each_set_once_by_name_for_the_view():
    owner, other, alpha, beta, _ = seed()
    sets = call('GET', '/api/collection/sets', owner)
    assert sets.status_code == 200, sets.text
    assert sets.json()['sets'] == [{'set_id': 'base', 'set_name': 'Base Set'}, {'set_id': 'jungle', 'set_name': 'Jungle'},
                                   {'set_id': 'promo', 'set_name': 'Promo'}]
    assert sets.json()['owner_revision'] == listing(owner).json()['owner_revision']
    in_alpha = call('GET', f'/api/collection/sets?location_id={alpha}', owner).json()['sets']
    assert in_alpha == [{'set_id': 'base', 'set_name': 'Base Set'}, {'set_id': 'jungle', 'set_name': 'Jungle'}]
    assert call('GET', '/api/collection/sets', other).json()['sets'] == [{'set_id': 'base', 'set_name': 'Base Set'}]
    for missing in (call('GET', f'/api/collection/sets?location_id={alpha}', other),
                    call('GET', f'/api/collection/sets?location_id={uuid4()}', owner)):
        assert missing.status_code == 404 and missing.json()['detail']['code'] == 'LOCATION_NOT_FOUND'
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        shelf = location(conn, owner, 'shelf', 'organization')
    folder = call('GET', f'/api/collection/sets?location_id={shelf}', owner)
    assert folder.status_code == 409 and folder.json()['detail']['code'] == 'NOT_STORAGE_LEAF', folder.text
    newcomer = call('GET', '/api/collection/sets', str(uuid4())).json()
    assert newcomer == {'sets': [], 'owner_revision': 1}
