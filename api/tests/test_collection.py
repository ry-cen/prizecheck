"""Collection read contracts through signed HTTP and disposable PostgreSQL fixtures."""
from uuid import uuid4
import os
import psycopg
import pytest
from test_holdings import call, fixture, add


def test_collection_aggregates_distribution_and_owner_isolation():
    owner, other, leaf, other_leaf, edition, _ = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        second = str(conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Binder','storage_leaf') RETURNING id", (uuid4(),owner)).fetchone()[0])
    add(owner, leaf, edition, '2')
    add(owner, second, edition, '3')
    add(other, other_leaf, edition, '99')
    page = call('GET','/api/collection',owner)
    assert page.status_code == 200, page.text
    assert len(page.json()['entries']) == 1
    assert page.json()['entries'][0]['quantity'] == '5'
    distribution = call('GET',f'/api/collection/editions/{edition}',owner)
    assert sorted(x['quantity'] for x in distribution.json()['holdings']) == ['2','3']
    assert call('GET','/api/collection',other).json()['entries'][0]['quantity'] == '99'


def test_collection_pages_filters_revision_and_organization_rollups():
    owner,other,leaf,_,edition,generation=fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        parent=str(conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Shelf','organization') RETURNING id",(uuid4(),owner)).fetchone()[0])
        conn.execute('UPDATE location SET parent_id=%s WHERE id=%s',(parent,leaf))
        printing=conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s',(edition,)).fetchone()[0]
        for n in range(32):
            eid=conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,%s,'{}') RETURNING id",(printing,f'collection-{n}')).fetchone()[0]
            conn.execute('INSERT INTO holding VALUES (%s,%s,%s,%s,1)',(owner,leaf,eid,n+1))
            conn.execute('INSERT INTO catalog_generation_edition VALUES (%s,%s,%s,true)',(generation,eid,printing))
    add(owner,leaf,edition,'2')
    first=call('GET','/api/collection?name=pika&set_id=base&sort=quantity',owner).json()
    assert len(first['entries'])==30 and first['entries'][0]['quantity']=='32'
    next_page=call('GET',f"/api/collection?name=pika&set_id=base&sort=quantity&cursor={first['next_cursor']}",owner).json()
    assert len(next_page['entries'])==3
    assert call('GET',f"/api/collection?cursor={first['next_cursor']}",owner).status_code==400
    rollup=call('GET',f'/api/collection?location_id={parent}',owner).json()
    assert len(rollup['entries'])==30
    assert call('GET',f'/api/collection?location_id={parent}',other).status_code==404
    assert call('GET','/api/collection?name=charizard',owner).json()['entries']==[]
    add(owner,leaf,edition,'1')
    stale=call('GET',f"/api/collection?name=pika&set_id=base&sort=quantity&cursor={first['next_cursor']}",owner)
    assert stale.status_code==409 and stale.json()['detail']['code']=='INVENTORY_CHANGED'


def test_leaf_filters_and_catalog_cursor_invalidation():
    owner,_,leaf,_,edition,generation=fixture()
    add(owner,leaf,edition,'4')
    assert call('GET',f'/api/holdings/{leaf}?name=charizard',owner).json()['holdings']==[]
    assert call('GET',f'/api/holdings/{leaf}?set_id=base&collector_number=25&sort=quantity',owner).json()['holdings'][0]['quantity']=='4'
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        printing=conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s',(edition,)).fetchone()[0]
        for n in range(49):
            eid=conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,%s,'{}') RETURNING id",(printing,f'leaf-{n}')).fetchone()[0]
            conn.execute('INSERT INTO holding VALUES (%s,%s,%s,1,1)',(owner,leaf,eid))
    first=call('GET',f'/api/holdings/{leaf}?sort=quantity',owner).json()
    assert len(first['holdings'])==48 and first['holdings'][0]['quantity']=='4'
    assert call('GET',f"/api/holdings/{leaf}?cursor={first['next_cursor']}",owner).status_code==400
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('UPDATE catalog_state SET revision=revision+1 WHERE singleton')
    changed=call('GET',f"/api/holdings/{leaf}?sort=quantity&cursor={first['next_cursor']}",owner)
    assert changed.status_code==409 and changed.json()['detail']['code']=='CATALOG_CHANGED'


@pytest.mark.slow(reason='capacity: a large Collection')
def test_large_collection_retains_exact_totals_and_indexed_distribution(tmp_path):
    owner,_,leaf,_,edition,generation=fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        printing=conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s',(edition,)).fetchone()[0]
        conn.execute("""INSERT INTO catalog_edition(id,printing_id,descriptor_key,descriptor)
          SELECT gen_random_uuid(),%s,'large-'||n,'{}'::jsonb FROM generate_series(1,25000) n""",(printing,))
        conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,id,1,1 FROM catalog_edition WHERE printing_id=%s AND descriptor_key LIKE 'large-%%'""",(owner,leaf,printing))
        conn.execute('ANALYZE holding')
        plans={}
        for label,sql,params in [
            ('distribution','SELECT location_id,quantity FROM holding WHERE owner_id=%s AND edition_id=%s',(owner,edition)),
            ('leaf_quantity','SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s ORDER BY quantity DESC,edition_id LIMIT 49',(owner,leaf)),
            ('totals','SELECT edition_id,sum(quantity) FROM holding WHERE owner_id=%s GROUP BY edition_id',(owner,))]:
            plan=conn.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params).fetchone()[0]
            plans[label]=plan
        (tmp_path/'collection-25000-plans.json').write_text(__import__('json').dumps(plans,indent=2))
        # This is the agreed PostgreSQL query-plan seam, independent of HTTP assertions.
        assert 'holding_owner_edition_location' in str(plans['distribution'])
        assert 'holding_owner_leaf_quantity' in str(plans['leaf_quantity'])
    page=call('GET','/api/collection',owner)
    assert page.status_code==200 and len(page.json()['entries'])==30
    assert all(x['quantity']=='1' for x in page.json()['entries'])
    assert page.json()['next_cursor']


def test_collection_entries_are_aggregates_and_distribution_has_real_leaf_holdings():
    owner,_,leaf,_,edition,_=fixture()
    add(owner,leaf,edition,'3')
    entry=call('GET','/api/collection',owner).json()['entries'][0]
    assert entry['quantity']=='3'
    assert not {'location_id','location_name','version'} & entry.keys()
    holding=call('GET',f'/api/collection/editions/{edition}',owner).json()['holdings'][0]
    assert holding['location_id']==leaf and holding['version']>=1
