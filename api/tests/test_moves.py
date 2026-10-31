"""Move API contracts and PostgreSQL atomicity at the signed HTTP seam."""
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

import pytest
from test_holdings import add, call, fixture


def leaf(owner, name="Binder"):
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        return str(conn.execute("""INSERT INTO location(id,owner_id,name,kind)
          VALUES (%s,%s,%s,'storage_leaf') RETURNING id""", (uuid4(), owner, name)).fetchone()[0])


def edition_like(edition, generation):
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        printing = conn.execute("SELECT printing_id FROM catalog_edition WHERE id=%s", (edition,)).fetchone()[0]
        new = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          VALUES (%s,%s,'{}') RETURNING id""", (printing, str(uuid4()))).fetchone()[0]
        conn.execute("""INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id)
          VALUES (%s,%s,%s)""", (generation, new, printing))
        return str(new)


def start(owner, source):
    response = call("POST", "/api/moves/manifests", owner, {"source_id": source})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def stage(owner, manifest_id, items):
    return call("PUT", f"/api/moves/manifests/{manifest_id}/items", owner, {"items": items})


def commit(owner, manifest_id, destination, key=None):
    return call("POST", f"/api/moves/manifests/{manifest_id}/commit", owner,
                {"destination_id": destination, "idempotency_key": str(key or uuid4())})


def selected(edition, amount, version):
    return {"edition_id": edition, "quantity": str(amount), "expected_version": version}


def quantities(owner, source, destination):
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        return conn.execute("""SELECT location_id::text,edition_id::text,quantity,version FROM holding
          WHERE owner_id=%s AND location_id IN (%s,%s) ORDER BY location_id,edition_id""",
                            (owner, source, destination)).fetchall()


def test_multi_edition_move_replay_and_cross_owner_privacy():
    owner, other, source, other_leaf, first, generation = fixture()
    second = edition_like(first, generation)
    destination = leaf(owner)
    one = add(owner, source, first, "5").json()
    two = add(owner, source, second, "3").json()
    manifest_id = start(owner, source)
    items = [selected(first, 2, one["version"]), selected(second, 3, two["version"])]
    assert stage(owner, manifest_id, items).json()["item_count"] == 2
    assert stage(owner, manifest_id, items).json()["item_count"] == 2
    assert stage(other, manifest_id, items).status_code == 404
    assert commit(other, manifest_id, other_leaf).status_code == 404
    key = uuid4()
    result = commit(owner, manifest_id, destination, key)
    assert result.status_code == 200, result.text
    body = result.json()
    assert body.pop("undo_id")
    assert body == {"edition_count": 2, "copy_count": "5", "owner_revision": two["owner_revision"] + 1,
                    "source_count": 1, "already_at_destination_count": "0"}
    assert commit(owner, manifest_id, destination, key).json() == result.json()
    assert commit(owner, manifest_id, source, key).json()["detail"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    rows = quantities(owner, source, destination)
    assert [(row[0], row[1], row[2]) for row in rows] == sorted([
        (source, first, 3), (destination, first, 2), (destination, second, 3)])


def test_stale_same_leaf_invalid_destination_and_preserved_manifest():
    owner, other, source, other_leaf, edition, _ = fixture()
    destination = leaf(owner)
    current = add(owner, source, edition, "3").json()
    manifest_id = start(owner, source)
    assert stage(owner, manifest_id, [selected(edition, 2, current["version"])]).status_code == 200
    assert commit(owner, manifest_id, source).json()["detail"]["code"] == "SAME_LOCATION"
    assert commit(owner, manifest_id, other_leaf).status_code == 404
    add(owner, source, edition, "1")
    stale = commit(owner, manifest_id, destination)
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "STALE_HOLDING"
    assert quantities(owner, source, destination)[0][2] == 4
    assert stage(owner, manifest_id, [selected(edition, 2, current["version"])]).json()["item_count"] == 1
    replacement = start(owner, source)
    latest = call("GET", f"/api/holdings/{source}", owner).json()["holdings"][0]
    assert stage(owner, replacement, [selected(edition, 2, latest["version"])]).status_code == 200
    assert commit(owner, replacement, destination).status_code == 200


def test_two_tab_race_only_one_move_applies():
    owner, _, source, _, edition, _ = fixture()
    destination = leaf(owner)
    current = add(owner, source, edition, "2").json()
    # Both tabs stage against the same version; a second manifest supersedes the first.
    first = start(owner, source)
    stage(owner, first, [selected(edition, 1, current["version"])])
    second = start(owner, source)
    stage(owner, second, [selected(edition, 1, current["version"])])
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda manifest_id: commit(owner, manifest_id, destination), [first, second]))
    assert sorted(response.status_code for response in outcomes) == [200, 404]
    assert sum(row[2] for row in quantities(owner, source, destination)) == 2


def test_rollback_when_destination_write_fails():
    owner, _, source, _, edition, _ = fixture()
    destination = leaf(owner)
    current = add(owner, source, edition, "2").json()
    manifest_id = start(owner, source)
    stage(owner, manifest_id, [selected(edition, 1, current["version"])])
    before = quantities(owner, source, destination)
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("""CREATE OR REPLACE FUNCTION reject_move_test() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.location_id='%s'::uuid THEN RAISE EXCEPTION 'forced rollback'; END IF; RETURN NEW; END $$""" % destination)
        conn.execute("CREATE TRIGGER reject_move_test BEFORE INSERT ON holding FOR EACH ROW EXECUTE FUNCTION reject_move_test()")
    try:
        assert commit(owner, manifest_id, destination).status_code == 503
        assert quantities(owner, source, destination) == before
    finally:
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute("DROP TRIGGER reject_move_test ON holding")
            conn.execute("DROP FUNCTION reject_move_test()")
    assert commit(owner, manifest_id, destination).status_code == 200


@pytest.mark.slow(reason='capacity: 25 000 Editions')
def test_failed_25000_edition_move_is_wholly_rejected():
    owner, _, source, _, edition, _ = fixture()
    destination = leaf(owner)
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        printing = conn.execute("SELECT printing_id FROM catalog_edition WHERE id=%s", (edition,)).fetchone()[0]
        ids = [row[0] for row in conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          SELECT %s,'bulk-' || %s || '-' || n,'{}'::jsonb FROM generate_series(1,25000) AS n
          RETURNING id""", (printing, str(uuid4()))).fetchall()]
        conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,id,2,1 FROM unnest(%s::uuid[]) AS id""", (owner, source, ids))
    manifest_id = start(owner, source)
    for index in range(0, len(ids), 500):
        batch = [selected(str(item), 1, 1 if index + offset else 2)
                 for offset, item in enumerate(ids[index:index + 500])]
        staged = stage(owner, manifest_id, batch)
        assert staged.status_code == 200, staged.text
    failed = commit(owner, manifest_id, destination)
    assert failed.status_code == 409 and failed.json()["detail"]["code"] == "STALE_HOLDING"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        source_count = conn.execute("SELECT count(*) FROM holding WHERE owner_id=%s AND location_id=%s", (owner, source)).fetchone()[0]
        destination_count = conn.execute("SELECT count(*) FROM holding WHERE owner_id=%s AND location_id=%s", (owner, destination)).fetchone()[0]
        assert source_count == 25000 and destination_count == 0


def commit_without_undo(owner, manifest_id, destination, key):
    body = {'destination_id': destination, 'idempotency_key': str(key)}
    return call('POST', f'/api/moves/manifests/{manifest_id}/commit-without-undo', owner, body)


def stage_quantity(owner, source, edition, count):
    row = next(row for row in call('GET', f'/api/holdings/{source}', owner).json()['holdings']
               if row['edition_id'] == edition)
    manifest_id = start(owner, source)
    result = stage(owner, manifest_id, [selected(edition, count, row['version'])])
    assert result.status_code == 200, result.text
    return manifest_id


def test_move_without_undo_writes_no_record_and_replays_without_one():
    from uuid import UUID
    from app.inventory_core import undo_id_for
    owner, _, source, _, edition, _ = fixture()
    destination = leaf(owner)
    assert add(owner, source, edition, '12').status_code == 200
    # Fill the surviving history: a no-Undo Move must neither replace nor trim any of these five records.
    for _ in range(5):
        normal = commit(owner, stage_quantity(owner, source, edition, 1), destination)
        assert normal.status_code == 200, normal.text
    previous = call('GET', '/api/moves/undo', owner).json()
    assert len(previous) == 5 and previous[0]['id'] == normal.json()['undo_id']
    key = uuid4()
    manifest_id = stage_quantity(owner, source, edition, 2)
    response = commit_without_undo(owner, manifest_id, destination, key)
    assert response.status_code == 200, response.text
    first = response.json()
    assert first['undo_id'] is None
    assert first['owner_revision'] == normal.json()['owner_revision'] + 1
    assert call('GET', '/api/moves/undo', owner).json() == previous
    forbidden_id = str(undo_id_for(owner, UUID(str(key))))
    assert forbidden_id not in {entry['id'] for entry in previous}
    denied = call('POST', f'/api/moves/undo/{forbidden_id}', owner, {'idempotency_key': str(uuid4())})
    assert denied.status_code == 404 and denied.json()['detail']['code'] == 'UNDO_NOT_FOUND'
    replay = commit_without_undo(owner, manifest_id, destination, key)
    assert replay.status_code == 200, replay.text
    assert replay.json() == first and replay.json()['undo_id'] is None
    assert call('GET', '/api/moves/undo', owner).json() == previous
    assert sorted(row[2] for row in quantities(owner, source, destination)) == [5, 7]


@pytest.mark.parametrize('strict_first', [False, True])
def test_cross_route_key_reuse_is_refused(strict_first):
    owner, _, source, _, edition, _ = fixture()
    destination = leaf(owner)
    assert add(owner, source, edition, '3').status_code == 200
    manifest_id = stage_quantity(owner, source, edition, 1)
    key = uuid4()
    first, other = (commit_without_undo, commit) if strict_first else (commit, commit_without_undo)
    response = first(owner, manifest_id, destination, key)
    assert response.status_code == 200, response.text
    before = quantities(owner, source, destination)
    mismatch = other(owner, manifest_id, destination, key)
    assert (mismatch.status_code, mismatch.json()['detail']['code']) == (409, 'IDEMPOTENCY_KEY_REUSED')
    assert quantities(owner, source, destination) == before


def test_normal_move_keeps_the_legacy_digest_and_undo():
    import hashlib
    import json
    owner, _, source, _, edition, _ = fixture()
    destination = leaf(owner)
    assert add(owner, source, edition, '2').status_code == 200
    manifest_id = stage_quantity(owner, source, edition, 1)
    key = uuid4()
    first = commit(owner, manifest_id, destination, key)
    assert first.status_code == 200 and first.json()['undo_id'], first.text
    replay = commit(owner, manifest_id, destination, key)
    assert replay.status_code == 200 and replay.json() == first.json(), replay.text
    payload = {'action': 'move', 'manifest_id': manifest_id, 'destination_id': destination}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        assert conn.execute('SELECT command_digest FROM mutation_request WHERE owner_id=%s AND request_key=%s',
                            (owner, key)).fetchone()[0] == digest


def test_concurrent_no_undo_duplicates_apply_once():
    owner, _, source, _, edition, _ = fixture()
    destination = leaf(owner)
    before = add(owner, source, edition, '2').json()
    manifest_id = stage_quantity(owner, source, edition, 1)
    key = uuid4()
    previous = call('GET', '/api/moves/undo', owner).json()
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: commit_without_undo(owner, manifest_id, destination, key), range(2)))
    assert all(response.status_code == 200 for response in responses), [response.text for response in responses]
    assert responses[0].json() == responses[1].json()
    assert responses[0].json()['owner_revision'] == before['owner_revision'] + 1
    assert responses[0].json()['undo_id'] is None
    assert sorted(row[2] for row in quantities(owner, source, destination)) == [1, 1]
    assert call('GET', '/api/moves/undo', owner).json() == previous


@pytest.mark.parametrize('extra', [{}, {'destination_id': None}, {'destination_id': str(uuid4()), 'put_away': True}])
def test_no_undo_route_cannot_remove_or_put_away_before_locking(monkeypatch, extra):
    from app import moves
    owner, _, _, _, _, _ = fixture()
    def must_not_lock(*args):
        pytest.fail('Invalid no-Undo commands must be refused before any lock or replay')
    monkeypatch.setattr(moves, 'lock_owner', must_not_lock)
    response = call('POST', f'/api/moves/manifests/{uuid4()}/commit-without-undo', owner,
                    {'idempotency_key': str(uuid4()), **extra})
    assert response.status_code == 422, response.text


@pytest.mark.parametrize('strict', [False, True])
@pytest.mark.parametrize('refusal', ['stale', 'same', 'missing_destination', 'foreign_manifest'])
def test_commit_routes_have_the_same_refusals_and_no_partial_write(strict, refusal):
    owner, other, source, _, edition, _ = fixture()
    destination = leaf(owner)
    current = add(owner, source, edition, '2').json()
    manifest_id = start(owner, source)
    assert stage(owner, manifest_id, [selected(edition, 1, current['version'])]).status_code == 200
    if refusal == 'stale':
        assert add(owner, source, edition, '1').status_code == 200
    target = source if refusal == 'same' else str(uuid4()) if refusal == 'missing_destination' else destination
    caller = other if refusal == 'foreign_manifest' else owner
    before = quantities(owner, source, destination)
    previous = call('GET', '/api/moves/undo', owner).json()
    response = (commit_without_undo if strict else commit)(caller, manifest_id, target, uuid4())
    expected = {'stale': (409, 'STALE_HOLDING'), 'same': (409, 'SAME_LOCATION'),
                'missing_destination': (404, 'LOCATION_NOT_FOUND'), 'foreign_manifest': (404, 'MOVE_MANIFEST_NOT_FOUND')}
    assert (response.status_code, response.json()['detail']['code']) == expected[refusal], response.text
    assert quantities(owner, source, destination) == before
    assert call('GET', '/api/moves/undo', owner).json() == previous


def test_no_undo_reused_key_with_a_different_destination_is_refused():
    owner, _, source, _, edition, _ = fixture()
    destination, elsewhere = leaf(owner), leaf(owner, 'Elsewhere')
    assert add(owner, source, edition, '2').status_code == 200
    manifest_id, key = stage_quantity(owner, source, edition, 1), uuid4()
    assert commit_without_undo(owner, manifest_id, destination, key).status_code == 200
    response = commit_without_undo(owner, manifest_id, elsewhere, key)
    assert (response.status_code, response.json()['detail']['code']) == (409, 'IDEMPOTENCY_KEY_REUSED')
    assert sorted(row[2] for row in quantities(owner, source, destination)) == [1, 1]


def test_older_undo_after_no_undo_move_still_applies_recorded_quantities():
    owner, _, source, _, edition, _ = fixture()
    destination = leaf(owner)
    assert add(owner, source, edition, '5').status_code == 200
    normal = commit(owner, stage_quantity(owner, source, edition, 2), destination)
    assert normal.status_code == 200, normal.text
    no_undo = commit_without_undo(owner, stage_quantity(owner, source, edition, 1), destination, uuid4())
    assert no_undo.status_code == 200, no_undo.text
    reversed_ = call('POST', f"/api/moves/undo/{normal.json()['undo_id']}", owner,
                     {'idempotency_key': str(uuid4())})
    assert reversed_.status_code == 200 and reversed_.json()['copy_count'] == '2', reversed_.text
    # These are quantities, with no claim about which physical copies an older Undo takes.
    assert {(row[0], row[2]) for row in quantities(owner, source, destination)} == {(source, 4), (destination, 1)}


def test_an_older_quantity_based_undo_can_use_a_replenished_destination():
    owner, _, source, _, edition, _ = fixture()
    destination, elsewhere = leaf(owner), leaf(owner, 'Elsewhere')
    assert add(owner, source, edition, '6').status_code == 200
    normal = commit(owner, stage_quantity(owner, source, edition, 2), destination)
    assert normal.status_code == 200, normal.text
    moved = commit_without_undo(owner, stage_quantity(owner, destination, edition, 2), elsewhere, uuid4())
    assert moved.status_code == 200, moved.text
    undo_path = f"/api/moves/undo/{normal.json()['undo_id']}"
    refused = call('POST', undo_path, owner, {'idempotency_key': str(uuid4())})
    assert refused.status_code == 409 and refused.json()['detail']['code'] == 'UNDO_INCOMPATIBLE'
    replenished = commit_without_undo(owner, stage_quantity(owner, source, edition, 2), destination, uuid4())
    assert replenished.status_code == 200, replenished.text
    applied = call('POST', undo_path, owner, {'idempotency_key': str(uuid4())})
    assert applied.status_code == 200 and applied.json()['copy_count'] == '2', applied.text
    assert {(row[0], row[2]) for row in quantities(owner, source, destination)} == {(source, 4)}
    # No history barrier or physical-copy identity check: later replenishment made this quantity check pass.
    assert call('GET', f'/api/holdings/{elsewhere}', owner).json()['holdings'][0]['quantity'] == '2'


def test_normal_and_no_undo_commits_share_the_owner_lock():
    owner, _, source, _, edition, _ = fixture()
    destination = leaf(owner)
    assert add(owner, source, edition, '2').status_code == 200
    manifest_id = stage_quantity(owner, source, edition, 1)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda operation: operation(owner, manifest_id, destination, uuid4()),
                                  [commit, commit_without_undo]))
    assert sorted(response.status_code for response in responses) == [200, 404], [r.text for r in responses]
    assert sorted(row[2] for row in quantities(owner, source, destination)) == [1, 1]


def test_no_undo_move_rolls_back_and_retries_with_the_same_key():
    owner, _, source, _, edition, _ = fixture()
    destination = leaf(owner)
    assert add(owner, source, edition, '2').status_code == 200
    manifest_id, key = stage_quantity(owner, source, edition, 1), uuid4()
    before = quantities(owner, source, destination)
    previous = call('GET', '/api/moves/undo', owner).json()
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute("""CREATE FUNCTION reject_no_undo_move_test() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.location_id='%s'::uuid THEN RAISE EXCEPTION 'forced rollback'; END IF; RETURN NEW; END $$""" % destination)
        conn.execute('CREATE TRIGGER reject_no_undo_move_test BEFORE INSERT ON holding FOR EACH ROW EXECUTE FUNCTION reject_no_undo_move_test()')
    try:
        assert commit_without_undo(owner, manifest_id, destination, key).status_code == 503
        assert quantities(owner, source, destination) == before
        assert call('GET', '/api/moves/undo', owner).json() == previous
    finally:
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            conn.execute('DROP TRIGGER reject_no_undo_move_test ON holding')
            conn.execute('DROP FUNCTION reject_no_undo_move_test()')
    response = commit_without_undo(owner, manifest_id, destination, key)
    assert response.status_code == 200 and response.json()['undo_id'] is None, response.text
    assert commit_without_undo(owner, manifest_id, destination, key).json() == response.json()
    assert call('GET', '/api/moves/undo', owner).json() == previous
