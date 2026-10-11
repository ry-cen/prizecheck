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
    assert result.json() == {"edition_count": 2, "copy_count": "5", "owner_revision": two["owner_revision"] + 1}
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
