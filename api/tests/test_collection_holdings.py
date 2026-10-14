"""Holding-level Collection listing for the workspace gallery, through signed HTTP and disposable PostgreSQL."""
import os
from uuid import uuid4

import psycopg

from test_holdings import add, call, client, fixture

PAGE = 500  # app.collection.HOLDING_PAGE_SIZE


def printing_edition(conn, generation, name, number):
    """One Edition of a new Printing in the active generation. Separate Printings keep tile labels distinct."""
    identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id",
                            (str(uuid4()), name)).fetchone()[0]
    printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',%s,%s) RETURNING id",
                            (str(uuid4()), identity)).fetchone()[0]
    edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'unspecified','{}') RETURNING id",
                           (printing,)).fetchone()[0]
    conn.execute("""INSERT INTO catalog_generation_printing
      (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,source_fingerprint,basic_energy)
      VALUES (%s,%s,%s,'base','Base Set',%s,%s,%s,'test','not_basic')""",
                 (generation, printing, str(uuid4()), number, name, name.lower()))
    conn.execute("INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s)",
                 (generation, edition, printing))
    return str(edition)


def location(conn, owner, name, kind='storage_leaf', parent=None):
    return str(conn.execute("INSERT INTO location(id,owner_id,name,kind,parent_id) VALUES (%s,%s,%s,%s,%s) RETURNING id",
                            (uuid4(), owner, name, kind, parent)).fetchone()[0])


def listing(user, location_id=None, cursor=None):
    query = '&'.join(f'{name}={value}' for name, value in (('location_id', location_id), ('cursor', cursor)) if value)
    return call('GET', '/api/collection/holdings' + (f'?{query}' if query else ''), user)


def summary(response):
    return [(row['printing_name'], row['location_name'], row['quantity']) for row in response.json()['holdings']]


def test_holdings_list_by_edition_then_location_path_for_all_owned_and_one_leaf():
    owner, other, unsorted, other_leaf, _, generation = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        abra = printing_edition(conn, generation, 'Abra', '1')
        raichu = printing_edition(conn, generation, 'Raichu', '2')
        zubat = printing_edition(conn, generation, 'Zubat', '3')
        shelf = location(conn, owner, 'shelf', 'organization')
        alpha = location(conn, owner, 'alpha', parent=shelf)
        beta = location(conn, owner, 'beta', parent=shelf)
        deck = location(conn, owner, 'deck one', 'deck')
    results = [add(owner, leaf, edition, quantity) for leaf, edition, quantity in
               ((beta, raichu, '2'), (unsorted, raichu, '1'), (alpha, raichu, '3'),
                (unsorted, abra, '1'), (alpha, zubat, '1'), (deck, zubat, '2'))]
    assert all(result.status_code == 200 for result in results), [result.text for result in results]
    assert add(other, other_leaf, raichu, '9').status_code == 200

    everything = listing(owner)
    assert everything.status_code == 200, everything.text
    body = everything.json()
    # Card Edition by name, then source Location by full path: "deck one" < "shelf / alpha" < "shelf / beta" < "unsorted".
    assert summary(everything) == [('Abra', 'Unsorted', '1'), ('Raichu', 'alpha', '3'), ('Raichu', 'beta', '2'),
                                   ('Raichu', 'Unsorted', '1'), ('Zubat', 'deck one', '2'), ('Zubat', 'alpha', '1')]
    assert [row['location_id'] for row in body['holdings']] == [unsorted, alpha, beta, unsorted, deck, alpha]
    assert [row['edition_id'] for row in body['holdings']] == [abra, raichu, raichu, raichu, zubat, zubat]
    # Nested Locations list their full path; top-level ones list just their name.
    assert [row['location_path'] for row in body['holdings']] == [
        'Unsorted', 'shelf / alpha', 'shelf / beta', 'Unsorted', 'deck one', 'shelf / alpha']
    first = body['holdings'][0]
    assert first['set_name'] == 'Base Set' and first['collector_number'] == '1' and first['image_url'] is None
    assert all(row['version'] >= 1 for row in body['holdings'])
    assert body['totals'] == {'holdings': 6, 'editions': 3, 'copies': '10'}
    assert body['next_cursor'] is None
    assert body['owner_revision'] == results[-1].json()['owner_revision']

    one_leaf = listing(owner, alpha)
    assert summary(one_leaf) == [('Raichu', 'alpha', '3'), ('Zubat', 'alpha', '1')]
    assert one_leaf.json()['totals'] == {'holdings': 2, 'editions': 2, 'copies': '4'}
    assert summary(listing(owner, deck)) == [('Zubat', 'deck one', '2')]

    folder = listing(owner, shelf)
    assert folder.status_code == 409 and folder.json()['detail']['code'] == 'NOT_STORAGE_LEAF'
    for missing in (listing(other, alpha), listing(owner, other_leaf), listing(owner, str(uuid4()))):
        assert missing.status_code == 404 and missing.json()['detail']['code'] == 'LOCATION_NOT_FOUND'
    assert summary(listing(other)) == [('Raichu', 'Unsorted', '9')]

    newcomer = listing(str(uuid4())).json()
    assert newcomer['holdings'] == [] and newcomer['owner_revision'] == 1
    assert newcomer['totals'] == {'holdings': 0, 'editions': 0, 'copies': '0'}


def test_holding_pages_walk_every_holding_once_and_bind_cursors():
    owner, other, unsorted, _, edition, _ = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        binder = location(conn, owner, 'binder')
        case = location(conn, owner, 'case')
        printing = conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s', (edition,)).fetchone()[0]
        editions = sorted(str(row[0]) for row in conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          SELECT %s,'page-'||n,'{}'::jsonb FROM generate_series(1,600) n RETURNING id""", (printing,)).fetchall())
        conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,id,1,1 FROM unnest(%s::uuid[]) id""", (owner, unsorted, editions))
        conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,id,2,1 FROM unnest(%s::uuid[]) id""", (owner, binder, editions))
        # A third copy place for the first Edition makes every page boundary split an Edition's Holdings.
        conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,1,1)',
                     (owner, case, editions[0]))
    # Every Edition has the same name, so order is Edition id, then path: binder < case < unsorted.
    expected = [(editions[0], binder), (editions[0], case), (editions[0], unsorted)]
    expected += [(edition_id, leaf) for edition_id in editions[1:] for leaf in (binder, unsorted)]

    pages, cursor = [], None
    while True:
        response = listing(owner, cursor=cursor)
        assert response.status_code == 200, response.text
        pages.append(response.json())
        cursor = pages[-1]['next_cursor']
        if not cursor:
            break
    assert [len(page['holdings']) for page in pages] == [PAGE, PAGE, 201]
    assert pages[0]['totals'] == {'holdings': 1201, 'editions': 600, 'copies': '1801'}
    assert pages[1]['totals'] is None and pages[2]['totals'] is None
    walked = [(row['edition_id'], row['location_id']) for page in pages for row in page['holdings']]
    assert walked == expected
    assert walked[PAGE - 1][0] == walked[PAGE][0]  # the first boundary splits one Edition's Holdings

    second = pages[0]['next_cursor']
    for wrong in (listing(owner, unsorted, cursor=second), listing(other, cursor=second),
                  listing(owner, cursor=second[:-4] + ('AAAA' if not second.endswith('AAAA') else 'BBBB')),
                  listing(owner, cursor='not-a-cursor'),
                  listing(owner, cursor=call('GET', '/api/collection', owner).json()['next_cursor'])):
        assert wrong.status_code == 400 and wrong.json()['detail']['code'] == 'INVALID_CURSOR', wrong.text

    assert add(owner, unsorted, edition, '1').status_code == 200
    stale = listing(owner, cursor=second)
    assert stale.status_code == 409 and stale.json()['detail']['code'] == 'INVENTORY_CHANGED'
    fresh = listing(owner).json()['next_cursor']
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('UPDATE catalog_state SET revision=revision+1 WHERE singleton')
    changed = listing(owner, cursor=fresh)
    assert changed.status_code == 409 and changed.json()['detail']['code'] == 'CATALOG_CHANGED'
    # An attribute decision moves cards between Collection's filters, so it ends a walk the same way (migration 041).
    fresh = listing(owner).json()['next_cursor']
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('SELECT catalog_advance_attribute_revision()')
    changed = listing(owner, cursor=fresh)
    assert changed.status_code == 409 and changed.json()['detail']['code'] == 'CATALOG_CHANGED'


def test_a_cursor_carries_its_anchor_so_the_next_page_does_not_reread_it():
    owner, _, unsorted, _, edition, _ = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        printing = conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s', (edition,)).fetchone()[0]
        editions = sorted(str(row[0]) for row in conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          SELECT %s,'anchor-'||n,'{}'::jsonb FROM generate_series(1,%s) n RETURNING id""", (printing, PAGE + 5)).fetchall())
        conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,id,1,1 FROM unnest(%s::uuid[]) id""", (owner, unsorted, editions))
    first = listing(owner).json()
    anchor = first['holdings'][-1]
    assert anchor['edition_id'] == editions[PAGE - 1]  # same name everywhere, so Edition id order
    # A white-box probe: drop the anchor Holding without moving the owner revision. A server that re-reads
    # the anchor row answers INVENTORY_CHANGED; one that carries the anchor's sort values continues after it.
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('DELETE FROM holding WHERE owner_id=%s AND location_id=%s AND edition_id=%s',
                     (owner, anchor['location_id'], anchor['edition_id']))
        catalog_revision = conn.execute('SELECT revision FROM catalog_state WHERE singleton').fetchone()[0]
        attribute_revision = conn.execute('SELECT revision FROM catalog_attribute_state WHERE singleton').fetchone()[0]
    second = listing(owner, cursor=first['next_cursor'])
    assert second.status_code == 200, second.text
    assert [row['edition_id'] for row in second.json()['holdings']] == editions[PAGE:]
    # A cursor in the earlier shape (the anchor's Edition and Location only), correctly signed, is refused.
    from app.collection import encode_cursor
    context = ['collection-holdings', owner, None, 'name-asc', '', '', None, None, None,
               first['owner_revision'], [catalog_revision, attribute_revision]]
    legacy = listing(owner, cursor=encode_cursor(context, [anchor['edition_id'], anchor['location_id']]))
    assert legacy.status_code == 400 and legacy.json()['detail']['code'] == 'INVALID_CURSOR', legacy.text


def test_a_page_boundary_inside_deep_non_ascii_paths_walks_every_holding_once():
    owner, _, _, _, edition, _ = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        printing = conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s', (edition,)).fetchone()[0]
        # Eleven folders of 120-character non-ASCII names, then three Storage Leaves: the deepest legal paths.
        parent = None
        for level in range(11):
            parent = location(conn, owner, f'Ünïcødé {level:02d} ' + 'ß' * 108, 'organization', parent)
        leaves = [location(conn, owner, 'Ä' * 119 + suffix, parent=parent) for suffix in 'abc']
        editions = sorted(str(row[0]) for row in conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          SELECT %s,'deep-'||n,'{}'::jsonb FROM generate_series(1,167) n RETURNING id""", (printing,)).fetchall())
        for leaf in leaves:
            conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
              SELECT %s,%s,id,1,1 FROM unnest(%s::uuid[]) id""", (owner, leaf, editions))
    # 501 Holdings: the first page ends after the second of the last Edition's three Holdings.
    expected = [(edition_id, leaf) for edition_id in editions for leaf in leaves]
    walked, cursor = [], None
    while True:
        response = listing(owner, cursor=cursor)
        assert response.status_code == 200, response.text
        body = response.json()
        walked += [(row['edition_id'], row['location_id']) for row in body['holdings']]
        cursor = body['next_cursor']
        if not cursor:
            break
        assert len(cursor) <= 2048  # the Location path never rides in the cursor
    assert walked == expected


def test_owner_revision_read_follows_each_change_for_its_owner_only():
    owner, other, unsorted, _, edition, _ = fixture()
    before = call('GET', '/api/collection/revision', owner)
    assert before.status_code == 200, before.text
    added = add(owner, unsorted, edition, '1')
    assert added.status_code == 200, added.text
    after = call('GET', '/api/collection/revision', owner).json()
    assert after == {'owner_revision': added.json()['owner_revision']}
    assert after['owner_revision'] > before.json()['owner_revision']
    assert call('GET', '/api/collection/revision', other).json() == {'owner_revision': listing(other).json()['owner_revision']}
    assert call('GET', '/api/collection/revision', str(uuid4())).json() == {'owner_revision': 1}
    assert client.get('/api/collection/revision').status_code == 401
