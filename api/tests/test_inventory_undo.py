from uuid import uuid4
import pytest
from test_holdings import add, call, fixture
from test_moves import start, stage, selected, leaf, commit


def test_removal_replay_and_multi_step_undo():
    owner, _, source, _, edition, _ = fixture()
    dest = leaf(owner)
    initial = add(owner, source, edition, '5').json()
    manifest = start(owner, source)
    stage(owner, manifest, [selected(edition, 2, initial['version'])])
    assert commit(owner, manifest, dest).status_code == 200
    current = call('GET', f'/api/holdings/{source}', owner).json()['holdings'][0]
    manifest = start(owner, source)
    stage(owner, manifest, [selected(edition, 3, current['version'])])
    body = {'idempotency_key': str(uuid4())}
    response = call('POST', f'/api/moves/manifests/{manifest}/remove', owner, body)
    assert response.status_code == 200, response.text
    assert call('POST', f'/api/moves/manifests/{manifest}/remove', owner, body).json() == response.json()
    assert call('GET', f'/api/holdings/{source}', owner).json()['holdings'] == []
    entries = call('GET', '/api/moves/undo', owner).json()
    assert [entry['action'] for entry in entries] == ['remove', 'move']
    for entry in entries:
        response = call('POST', f"/api/moves/undo/{entry['id']}", owner, {'idempotency_key': str(uuid4())})
        assert response.status_code == 200, response.text
    assert call('GET', f'/api/holdings/{source}', owner).json()['holdings'][0]['quantity'] == '5'
    assert call('GET', f'/api/holdings/{dest}', owner).json()['holdings'] == []


def test_conflict_dismissal_compatible_add_and_expired_vs_deleted():
    import os
    import psycopg
    owner, other, source, _, edition, _ = fixture()
    dest = leaf(owner)
    initial = add(owner, source, edition, '3').json()
    manifest = start(owner, source)
    stage(owner, manifest, [selected(edition, 2, initial['version'])])
    commit(owner, manifest, dest)
    entry = call('GET', '/api/moves/undo', owner).json()[0]
    assert call('POST', f"/api/moves/undo/{entry['id']}", other, {'idempotency_key': str(uuid4())}).status_code == 404
    add(owner, source, edition, '4')
    key = {'idempotency_key': str(uuid4())}
    assert call('POST', f"/api/moves/undo/{entry['id']}", owner, key).status_code == 200
    assert call('POST', f"/api/moves/undo/{entry['id']}", owner, key).status_code == 200
    assert call('GET', f'/api/holdings/{source}', owner).json()['holdings'][0]['quantity'] == '7'
    current = call('GET', f'/api/holdings/{source}', owner).json()['holdings'][0]
    manifest = start(owner, source)
    stage(owner, manifest, [selected(edition, 1, current['version'])])
    commit(owner, manifest, dest)
    entry = call('GET', '/api/moves/undo', owner).json()[0]
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute("UPDATE inventory_undo SET expires_at=clock_timestamp() WHERE id=%s", (entry['id'],))
    assert call('GET', '/api/moves/undo', owner).json() == []
    assert call('POST', f"/api/moves/undo/{entry['id']}", owner, {'idempotency_key': str(uuid4())}).status_code == 410
    add(owner, source, edition, '1')
    assert call('POST', f"/api/moves/undo/{entry['id']}", owner, {'idempotency_key': str(uuid4())}).status_code == 404


def test_newest_only_conflict_dismissal_five_entries_and_concurrent_replay():
    from concurrent.futures import ThreadPoolExecutor
    owner, _, source, _, edition, _ = fixture()
    dest = leaf(owner)
    add(owner, source, edition, '10')
    for _ in range(6):
        current = call('GET', f'/api/holdings/{source}', owner).json()['holdings'][0]
        manifest = start(owner, source)
        stage(owner, manifest, [selected(edition, 1, current['version'])])
        assert commit(owner, manifest, dest).status_code == 200
    entries = call('GET', '/api/moves/undo', owner).json()
    assert len(entries) == 5
    assert call('POST', f"/api/moves/undo/{entries[1]['id']}", owner, {'idempotency_key': str(uuid4())}).json()['detail']['code'] == 'UNDO_NOT_NEWEST'
    current = call('GET', f'/api/holdings/{dest}', owner).json()['holdings'][0]
    manifest = start(owner, dest)
    stage(owner, manifest, [selected(edition, 6, current['version'])])
    assert call('POST', f'/api/moves/manifests/{manifest}/remove', owner, {'idempotency_key': str(uuid4())}).status_code == 200
    newest = call('GET', '/api/moves/undo', owner).json()[0]
    assert call('DELETE', f"/api/moves/undo/{newest['id']}", owner).status_code == 204
    entries = call('GET', '/api/moves/undo', owner).json()
    assert call('POST', f"/api/moves/undo/{entries[0]['id']}", owner, {'idempotency_key': str(uuid4())}).json()['detail']['code'] == 'UNDO_INCOMPATIBLE'
    assert call('DELETE', f"/api/moves/undo/{entries[0]['id']}", owner).status_code == 204
    add(owner,dest,edition,'5')
    entry = call('GET', '/api/moves/undo', owner).json()[0]
    key = {'idempotency_key':str(uuid4())}
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: call('POST',f"/api/moves/undo/{entry['id']}",owner,key), range(2)))
    assert responses[0].json() == responses[1].json()
    assert responses[0].status_code == 200


@pytest.mark.slow(reason='capacity: 25 000 Editions')
def test_worst_case_25000_edition_removal_payload_is_bounded_and_restored():
    import os
    import psycopg
    owner, _, source, _, edition, _ = fixture()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        printing = conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s',(edition,)).fetchone()[0]
        ids = [str(row[0]) for row in conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) SELECT %s,%s||n,'{}'::jsonb FROM generate_series(1,25000) n RETURNING id",(printing,str(uuid4()))).fetchall()]
        conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) SELECT %s,%s,id,1,1 FROM unnest(%s::uuid[]) id',(owner,source,ids))
    manifest = start(owner,source)
    for i in range(0,len(ids),500):
        assert stage(owner,manifest,[selected(item,1,1) for item in ids[i:i+500]]).status_code == 200
    result = call('POST',f'/api/moves/manifests/{manifest}/remove',owner,{'idempotency_key':str(uuid4())})
    assert result.status_code == 200 and result.json()['edition_count'] == 25000
    entry = call('GET','/api/moves/undo',owner).json()[0]
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        size, seconds = conn.execute('SELECT pg_column_size(payload),extract(epoch FROM expires_at-created_at) FROM inventory_undo WHERE id=%s',(entry['id'],)).fetchone()
    assert seconds == 600
    assert size < 2_000_000  # At most 10 MB for five maximal 25,000-Edition payloads.
    assert call('POST',f"/api/moves/undo/{entry['id']}",owner,{'idempotency_key':str(uuid4())}).status_code == 200
    assert call('GET',f'/api/holdings/{source}',owner).json()['holdings']
