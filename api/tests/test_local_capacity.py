"""Opt-in capacity proof at the agreed HTTP/PostgreSQL seams; never a launch proof."""
import json
import math
import os
import platform
import time
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from test_holdings import call, fixture
from test_moves import commit, leaf, selected, stage, start

pytestmark = pytest.mark.skipif(not os.environ.get('LOCAL_CAPACITY_REPORT'), reason='explicit disposable capacity command only')


def test_local_capacity_fixture_and_atomic_moves():
    owner, _, source, _, edition, generation = fixture()
    destination = leaf(owner, 'Capacity destination')
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) SELECT %s||n FROM generate_series(1,998) n', ('capacity-',))
        conn.execute('''INSERT INTO "user"(id,name,email,"emailVerified")
          SELECT user_id,'Synthetic account',user_id||'@example.invalid',true FROM inventory_owner''')
        conn.execute('''INSERT INTO session(id,token,"userId","expiresAt","updatedAt")
          SELECT gen_random_uuid()::text,gen_random_uuid()::text,id,now()+interval '30 days',now()
          FROM "user" ORDER BY id LIMIT 200''')
        printing = conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s', (edition,)).fetchone()[0]
        ids = [str(row[0]) for row in conn.execute('''INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          SELECT %s,'capacity-'||n,'{"label":"Synthetic variant"}'::jsonb FROM generate_series(1,25000) n RETURNING id''', (printing,))]
        conn.execute('''INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id)
          SELECT %s,id,%s FROM unnest(%s::uuid[]) id''', (generation,printing,ids))
        conn.execute('''INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,id,6,1 FROM unnest(%s::uuid[]) id''', (owner,source,ids))
        assert conn.execute('SELECT count(*) FROM "user"').fetchone()[0] == 1000
        assert conn.execute('SELECT count(*) FROM holding WHERE owner_id=%s', (owner,)).fetchone()[0] == 25000
        conn.execute('ANALYZE')
        initial_bytes = conn.execute('SELECT pg_database_size(current_database())').fetchone()[0]
    timings = {}
    for label,path,key,count in [('collection','/api/collection','entries',30),('leaf',f'/api/holdings/{source}','holdings',48)]:
        call('GET',path,owner)  # explicit warm-up excluded
        values = []
        for _ in range(20):
            before = time.perf_counter()
            response = call('GET',path,owner)
            values.append(time.perf_counter()-before)
            assert response.status_code == 200 and len(response.json()[key]) == count
            assert response.json()['next_cursor']
        timings[label] = {'samples_seconds':values,'p95_seconds':sorted(values)[math.ceil(len(values)*.95)-1]}
    moves = []
    for move in range(5):
        before = time.perf_counter()
        manifest = start(owner,source)
        for offset in range(0,len(ids),500):
            assert stage(owner,manifest,[selected(eid,1,move+1) for eid in ids[offset:offset+500]]).status_code == 200
        staged_seconds = time.perf_counter()-before
        commit_start = time.perf_counter()
        response = commit(owner,manifest,destination)
        assert response.status_code == 200, response.text
        assert response.json()['edition_count'] == 25000 and response.json()['copy_count'] == '25000'
        moves.append({'stage_seconds':staged_seconds,'commit_http_seconds':time.perf_counter()-commit_start,'total_seconds':time.perf_counter()-before})
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            assert conn.execute('SELECT count(*),sum(quantity),min(quantity),max(quantity) FROM holding WHERE owner_id=%s AND location_id=%s',(owner,source)).fetchone() == (25000,25000*(5-move),5-move,5-move)
            assert conn.execute('SELECT count(*),sum(quantity),min(quantity),max(quantity) FROM holding WHERE owner_id=%s AND location_id=%s',(owner,destination)).fetchone() == (25000,25000*(move+1),move+1,move+1)
    assert len(call('GET','/api/moves/undo',owner).json()) == 5
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        payloads = [row[0] for row in conn.execute('SELECT pg_column_size(payload) FROM inventory_undo WHERE owner_id=%s',(owner,))]
        assert len(payloads) == 5 and all(size > 0 for size in payloads)
        plans = {}
        for label,sql,params in [
            ('leaf_quantity','SELECT edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=%s ORDER BY quantity DESC,edition_id LIMIT 49',(owner,source)),
            ('distribution','SELECT location_id,quantity FROM holding WHERE owner_id=%s AND edition_id=%s',(owner,ids[0])),
            ('totals','SELECT edition_id,sum(quantity) FROM holding WHERE owner_id=%s GROUP BY edition_id',(owner,))]:
            plans[label] = conn.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params).fetchone()[0]
        report = {'fixture':'SYNTHETIC: 1000 users, 200 session records, initially 25000 Holdings, one synthetic Printing with 25000 synthetic Editions; five full-size Move inverses',
          'environment':{'platform':platform.platform(),'python':platform.python_version(),'postgresql':conn.execute('SHOW server_version').fetchone()[0], 'transport':'FastAPI TestClient HTTP contract (in process), local PostgreSQL; excludes network/auth gateway/browser'},
          'initial_database_bytes':initial_bytes,'final_database_bytes':conn.execute('SELECT pg_database_size(current_database())').fetchone()[0],
          'undo_payload_bytes':payloads,'warm_http':timings,'moves':moves,'plans':plans,
          'unverified':['full English catalog and realistic catalog cardinality','real 200 monthly active workload and 10000 monthly public views','cold starts/internet/browser timings','provider quotas/costs','transaction-only duration (commit HTTP includes transaction and serialization)','production readiness']}
    Path(os.environ['LOCAL_CAPACITY_REPORT']).write_text(json.dumps(report,indent=2))
