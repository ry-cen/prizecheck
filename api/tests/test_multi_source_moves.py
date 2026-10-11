"""Multi-source Move, Removal and Undo at the signed HTTP seam (collector workspace spec, API test list)."""
import hashlib
import json
import os
import time
from uuid import uuid4

import psycopg
import pytest

from test_holdings import add, call, fixture
from test_location_tree import make, tree
from test_moves import commit, edition_like, leaf, stage

MAX = 2**63 - 1


def begin(owner, source=None):
    response = call("POST", "/api/moves/manifests", owner, {} if source is None else {"source_id": source})
    assert response.status_code == 201, response.text
    return response.json()


def item(source, edition, amount, version):
    return {"source_id": source, "edition_id": edition, "quantity": str(amount), "expected_version": version}


def remove(owner, manifest_id, key=None):
    return call("POST", f"/api/moves/manifests/{manifest_id}/remove", owner, {"idempotency_key": str(key or uuid4())})


def undo(owner, entry_id, key=None):
    return call("POST", f"/api/moves/undo/{entry_id}", owner, {"idempotency_key": str(key or uuid4())})


def undo_entries(owner):
    response = call("GET", "/api/moves/undo", owner)
    assert response.status_code == 200, response.text
    return response.json()


def inventory(owner):
    """Every Holding of the owner and the owner revision: the observable state a failure must not change."""
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        rows = conn.execute("""SELECT location_id::text,edition_id::text,quantity,version FROM holding
          WHERE owner_id=%s ORDER BY location_id,edition_id""", (owner,)).fetchall()
        revision = conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s", (owner,)).fetchone()[0]
    return rows, revision


def held(owner, location, edition):
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        row = conn.execute("SELECT quantity FROM holding WHERE owner_id=%s AND location_id=%s AND edition_id=%s",
                           (owner, location, edition)).fetchone()
    return row[0] if row else 0


def three_sources():
    """Sources A, B, C and destination D. Edition one is in A (5) and B (4); Edition two is in C (3)."""
    owner, other, a, other_leaf, one, generation = fixture()
    two = edition_like(one, generation)
    b, c, d = leaf(owner, "Binder B"), leaf(owner, "Box C"), leaf(owner, "Deck box D")
    versions = {(a, one): add(owner, a, one, "5").json()["version"],
                (b, one): add(owner, b, one, "4").json()["version"],
                (c, two): add(owner, c, two, "3").json()["version"]}
    return owner, other, other_leaf, (a, b, c, d), (one, two), versions


def test_atomic_move_across_three_sources_with_replay_and_key_reuse():
    owner, other, other_leaf, (a, b, c, d), (one, two), versions = three_sources()
    started = begin(owner)
    assert started["source_id"] is None and started["item_count"] == 0
    items = [item(a, one, 2, versions[(a, one)]), item(b, one, 4, versions[(b, one)]), item(c, two, 3, versions[(c, two)])]
    assert stage(owner, started["id"], items).json()["item_count"] == 3
    assert stage(owner, started["id"], items).json()["item_count"] == 3  # identical restage is a no-op
    assert stage(other, started["id"], items).status_code == 404
    before_revision = inventory(owner)[1]
    key = uuid4()
    result = commit(owner, started["id"], d, key)
    assert result.status_code == 200, result.text
    assert result.json() == {"edition_count": 2, "copy_count": "9", "owner_revision": before_revision + 1,
                             "source_count": 3, "already_at_destination_count": "0"}
    assert (held(owner, a, one), held(owner, b, one), held(owner, c, two)) == (3, 0, 0)
    assert (held(owner, d, one), held(owner, d, two)) == (6, 3)
    assert commit(owner, started["id"], d, key).json() == result.json()
    reused = commit(owner, started["id"], a, key)
    assert reused.status_code == 409 and reused.json()["detail"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert commit(other, started["id"], other_leaf).status_code == 404
    entry = undo_entries(owner)[0]
    assert (entry["action"], entry["source_id"], entry["destination_id"], entry["source_count"]) == ("move", None, d, 3)


def test_staging_requires_owned_sources_and_unique_source_edition_pairs():
    owner, other, other_leaf, (a, b, _, _), (one, _), versions = three_sources()
    manifest_id = begin(owner)["id"]
    unsourced = stage(owner, manifest_id, [{"edition_id": one, "quantity": "1", "expected_version": versions[(a, one)]}])
    assert unsourced.status_code == 422 and unsourced.json()["detail"] == {"code": "SOURCE_REQUIRED", "edition_id": one}
    foreign = stage(owner, manifest_id, [item(other_leaf, one, 1, 1)])
    assert foreign.status_code == 404 and foreign.json()["detail"] == {"code": "LOCATION_NOT_FOUND", "source_id": other_leaf}
    twice = stage(owner, manifest_id, [item(a, one, 1, versions[(a, one)]), item(a, one, 1, versions[(a, one)])])
    assert twice.status_code == 422 and twice.json()["detail"]["code"] == "DUPLICATE_MOVE_ITEM"
    # The same Card Edition from two sources is two items.
    assert stage(owner, manifest_id, [item(a, one, 1, versions[(a, one)]), item(b, one, 1, versions[(b, one)])]).json()["item_count"] == 2
    conflict = stage(owner, manifest_id, [item(a, one, 2, versions[(a, one)])])
    assert conflict.status_code == 409 and conflict.json()["detail"] == {"code": "DUPLICATE_MOVE_ITEM", "source_id": a, "edition_id": one}
    # A default source still applies to items that omit one, alongside explicit sources.
    defaulted = begin(owner, a)
    assert defaulted["source_id"] == a
    mixed = [{"edition_id": one, "quantity": "1", "expected_version": versions[(a, one)]}, item(b, one, 1, versions[(b, one)])]
    assert stage(owner, defaulted["id"], mixed).json()["item_count"] == 2
    clash = stage(owner, defaulted["id"], [{"edition_id": one, "quantity": "1", "expected_version": versions[(a, one)]},
                                           item(a, one, 1, versions[(a, one)])])
    assert clash.status_code == 422 and clash.json()["detail"]["code"] == "DUPLICATE_MOVE_ITEM"


def test_already_at_destination_is_excluded_and_all_no_op_is_rejected():
    owner, _, _, (a, b, _, _), (one, _), versions = three_sources()
    manifest_id = begin(owner)["id"]
    stage(owner, manifest_id, [item(a, one, 2, versions[(a, one)]), item(b, one, 4, versions[(b, one)])])
    result = commit(owner, manifest_id, b)
    assert result.status_code == 200, result.text
    body = result.json()
    assert (body["edition_count"], body["copy_count"], body["source_count"], body["already_at_destination_count"]) == (1, "2", 1, "4")
    assert (held(owner, a, one), held(owner, b, one)) == (3, 6)
    entry = undo_entries(owner)[0]
    assert (entry["source_id"], entry["source_count"]) == (a, 1)  # one real source: the record names it
    current = call("GET", f"/api/holdings/{b}", owner).json()["holdings"][0]
    no_op = begin(owner)["id"]
    stage(owner, no_op, [item(b, one, 6, current["version"])])
    before = inventory(owner)
    rejected = commit(owner, no_op, b)
    assert rejected.status_code == 409 and rejected.json()["detail"]["code"] == "SAME_LOCATION"
    assert inventory(owner) == before
    assert stage(owner, no_op, [item(b, one, 6, current["version"])]).json()["item_count"] == 1  # manifest kept


def stale(owner, manifest_id, sources, editions, versions):
    a, b, _, _ = sources
    add(owner, b, editions[0], "1")  # another tab changes B after staging
    return "STALE_HOLDING", b, editions[0]


def insufficient(owner, manifest_id, sources, editions, versions):
    _, _, c, _ = sources
    stage(owner, manifest_id, [item(c, editions[1], 4, versions[(c, editions[1])])])  # C holds only 3
    return "INSUFFICIENT_QUANTITY", c, editions[1]


def overflow(owner, manifest_id, sources, editions, versions):
    a, b, _, d = sources
    add(owner, d, editions[0], str(MAX - 5))  # each source alone fits; together they overflow
    return "QUANTITY_OVERFLOW", min(a, b), editions[0]


def non_leaf(owner, manifest_id, sources, editions, versions):
    _, b, _, _ = sources
    node = next(n for n in tree(owner) if n["id"] == b)
    converted = call("POST", "/api/location-tree", owner, {"name": "Pages", "parent_id": b, "parent_version": node["version"],
                                                          "conversion": "move_holdings_to_child", "idempotency_key": str(uuid4())})
    assert converted.status_code == 201, converted.text
    return "LOCATION_NOT_FOUND", b, editions[0]


@pytest.mark.parametrize("conflict", [stale, insufficient, overflow, non_leaf], ids=lambda f: f.__name__)
def test_conflicts_change_nothing_and_name_the_source(conflict):
    owner, _, _, sources, editions, versions = three_sources()
    a, b, _, d = sources
    manifest_id = begin(owner)["id"]
    stage(owner, manifest_id, [item(a, editions[0], 3, versions[(a, editions[0])]),
                               item(b, editions[0], 3, versions[(b, editions[0])])])
    code, source, edition = conflict(owner, manifest_id, sources, editions, versions)
    before = inventory(owner)
    response = commit(owner, manifest_id, d)
    assert response.status_code == (404 if code == "LOCATION_NOT_FOUND" else 409), response.text
    assert response.json()["detail"] == {"code": code, "source_id": source, "edition_id": edition}
    assert inventory(owner) == before
    assert undo_entries(owner) == []


def test_multi_source_removal_is_atomic_and_one_undo_restores_every_source():
    owner, _, _, (a, b, c, _), (one, two), versions = three_sources()
    manifest_id = begin(owner)["id"]
    stage(owner, manifest_id, [item(a, one, 5, versions[(a, one)]), item(b, one, 1, versions[(b, one)]), item(c, two, 2, versions[(c, two)])])
    key = uuid4()
    removed = remove(owner, manifest_id, key)
    assert removed.status_code == 200, removed.text
    body = removed.json()
    assert (body["edition_count"], body["copy_count"], body["source_count"], body["already_at_destination_count"]) == (2, "8", 3, "0")
    assert remove(owner, manifest_id, key).json() == body
    assert (held(owner, a, one), held(owner, b, one), held(owner, c, two)) == (0, 3, 1)
    entry = undo_entries(owner)[0]
    assert (entry["action"], entry["source_id"], entry["destination_id"], entry["source_count"]) == ("remove", None, None, 3)
    restored = undo(owner, entry["id"])
    assert restored.status_code == 200, restored.text
    assert (restored.json()["edition_count"], restored.json()["copy_count"], restored.json()["source_count"]) == (2, "8", 3)
    assert (held(owner, a, one), held(owner, b, one), held(owner, c, two)) == (5, 4, 3)


def test_removal_failure_in_one_source_changes_nothing():
    owner, _, _, (a, b, _, _), (one, _), versions = three_sources()
    manifest_id = begin(owner)["id"]
    stage(owner, manifest_id, [item(a, one, 1, versions[(a, one)]), item(b, one, 5, versions[(b, one)])])  # B holds 4
    before = inventory(owner)
    response = remove(owner, manifest_id)
    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "INSUFFICIENT_QUANTITY", "source_id": b, "edition_id": one}
    assert inventory(owner) == before


def test_multi_source_move_undo_restores_shared_edition_to_every_source():
    owner, _, _, (a, b, c, d), (one, two), versions = three_sources()
    add(owner, d, one, "1")
    manifest_id = begin(owner)["id"]
    stage(owner, manifest_id, [item(a, one, 2, versions[(a, one)]), item(b, one, 4, versions[(b, one)]), item(c, two, 3, versions[(c, two)])])
    assert commit(owner, manifest_id, d).status_code == 200
    assert held(owner, d, one) == 7
    entry = undo_entries(owner)[0]
    key = uuid4()
    restored = undo(owner, entry["id"], key)
    assert restored.status_code == 200, restored.text
    assert undo(owner, entry["id"], key).json() == restored.json()
    assert (held(owner, a, one), held(owner, b, one), held(owner, c, two)) == (5, 4, 3)
    assert (held(owner, d, one), held(owner, d, two)) == (1, 0)
    assert undo_entries(owner) == []


def test_multi_source_undo_is_incompatible_when_a_source_became_organizational():
    owner, _, _, (a, b, c, d), (one, two), versions = three_sources()
    manifest_id = begin(owner)["id"]
    stage(owner, manifest_id, [item(a, one, 2, versions[(a, one)]), item(b, one, 4, versions[(b, one)]), item(c, two, 3, versions[(c, two)])])
    assert commit(owner, manifest_id, d).status_code == 200
    entry = undo_entries(owner)[0]
    emptied = next(n for n in tree(owner) if n["id"] == b)
    assert make(owner, "Pages", emptied).status_code == 201  # B now has a child, so it is Organizational
    before = inventory(owner)
    response = undo(owner, entry["id"])
    assert response.status_code == 409 and response.json()["detail"] == {"code": "UNDO_INCOMPATIBLE", "source_id": b}
    assert inventory(owner) == before
    assert call("DELETE", f"/api/moves/undo/{entry['id']}", owner).status_code == 204


def test_multi_source_undo_is_incompatible_when_destination_lacks_the_summed_quantity():
    owner, _, _, (a, b, _, d), (one, _), versions = three_sources()
    manifest_id = begin(owner)["id"]
    stage(owner, manifest_id, [item(a, one, 2, versions[(a, one)]), item(b, one, 2, versions[(b, one)])])
    assert commit(owner, manifest_id, d).status_code == 200
    multi = undo_entries(owner)[0]
    current = call("GET", f"/api/holdings/{d}", owner).json()["holdings"][0]
    later = begin(owner, d)["id"]
    stage(owner, later, [{"edition_id": one, "quantity": "1", "expected_version": current["version"]}])
    assert remove(owner, later).status_code == 200  # D now holds 3: enough for either source, not both
    newer = undo_entries(owner)[0]
    assert call("DELETE", f"/api/moves/undo/{newer['id']}", owner).status_code == 204
    before = inventory(owner)
    response = undo(owner, multi["id"])
    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "UNDO_INCOMPATIBLE", "source_id": min(a, b), "edition_id": one}
    assert inventory(owner) == before


def test_multi_source_undo_is_incompatible_when_restoring_would_overflow_a_source():
    owner, _, _, (a, b, c, d), (one, two), versions = three_sources()
    manifest_id = begin(owner)["id"]
    stage(owner, manifest_id, [item(a, one, 2, versions[(a, one)]), item(b, one, 2, versions[(b, one)]), item(c, two, 1, versions[(c, two)])])
    assert commit(owner, manifest_id, d).status_code == 200
    entry = undo_entries(owner)[0]
    add(owner, b, one, str(MAX - 3))  # B now holds MAX - 1, so restoring 2 more overflows
    before = inventory(owner)
    response = undo(owner, entry["id"])
    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "UNDO_INCOMPATIBLE", "source_id": b, "edition_id": one}
    assert inventory(owner) == before


def test_multi_source_undo_is_incompatible_when_the_destination_stopped_being_a_leaf():
    owner, _, _, (a, b, c, d), (one, two), versions = three_sources()
    manifest_id = begin(owner)["id"]
    stage(owner, manifest_id, [item(a, one, 2, versions[(a, one)]), item(b, one, 2, versions[(b, one)]), item(c, two, 1, versions[(c, two)])])
    assert commit(owner, manifest_id, d).status_code == 200
    entry = undo_entries(owner)[0]
    node = next(n for n in tree(owner) if n["id"] == d)
    converted = call("POST", "/api/location-tree", owner, {"name": "Pages", "parent_id": d, "parent_version": node["version"],
                                                          "conversion": "move_holdings_to_child", "idempotency_key": str(uuid4())})
    assert converted.status_code == 201, converted.text
    before = inventory(owner)
    response = undo(owner, entry["id"])
    assert response.status_code == 409 and response.json()["detail"] == {"code": "UNDO_INCOMPATIBLE", "destination_id": d}
    assert inventory(owner) == before


def test_commit_to_an_unowned_destination_names_the_destination():
    owner, _, other_leaf, (a, _, _, _), (one, _), versions = three_sources()
    manifest_id = begin(owner)["id"]
    stage(owner, manifest_id, [item(a, one, 1, versions[(a, one)])])
    before = inventory(owner)
    response = commit(owner, manifest_id, other_leaf)
    assert response.status_code == 404
    assert response.json()["detail"] == {"code": "LOCATION_NOT_FOUND", "destination_id": other_leaf}
    assert inventory(owner) == before
    assert undo_entries(owner) == []


def test_starting_a_manifest_validates_the_default_source():
    owner, _, other_leaf, (_, _, _, d), _, _ = three_sources()
    foreign = call("POST", "/api/moves/manifests", owner, {"source_id": other_leaf})
    assert foreign.status_code == 404 and foreign.json()["detail"] == {"code": "LOCATION_NOT_FOUND", "source_id": other_leaf}
    assert make(owner, "Pages", next(n for n in tree(owner) if n["id"] == d)).status_code == 201  # D is now Organizational
    organizational = call("POST", "/api/moves/manifests", owner, {"source_id": d})
    assert organizational.status_code == 404 and organizational.json()["detail"] == {"code": "LOCATION_NOT_FOUND", "source_id": d}
    unsourced = call("POST", "/api/moves/manifests", owner, {"source_id": None})
    assert unsourced.status_code == 201, unsourced.text
    assert unsourced.json()["source_id"] is None


def test_previous_application_records_keep_working_after_migration():
    """Rows written by the single-source application, using its exact statements, stay usable."""
    owner, _, _, (a, _, _, d), (one, two), versions = three_sources()
    second = add(owner, a, two, "2").json()["version"]
    manifest_id = uuid4()
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("INSERT INTO move_manifest(owner_id,id,source_id) VALUES (%s,%s,%s)", (owner, manifest_id, a))
        values = json.dumps([{"edition_id": one, "quantity": 2, "expected_version": versions[(a, one)]}])
        conn.execute("""INSERT INTO move_manifest_item(owner_id,edition_id,quantity,expected_version)
          SELECT %s,edition_id,quantity,expected_version FROM jsonb_to_recordset(%s::jsonb)
          AS staged(edition_id uuid,quantity bigint,expected_version bigint)
          ON CONFLICT (owner_id,edition_id) DO NOTHING""", (owner, values))
    # The new application sees the previous application's staged item and adds to it.
    assert stage(owner, manifest_id, [{"edition_id": two, "quantity": "2", "expected_version": second}]).json()["item_count"] == 2
    key = uuid4()
    moved = commit(owner, manifest_id, d, key)
    assert moved.status_code == 200, moved.text
    assert (moved.json()["edition_count"], moved.json()["copy_count"], moved.json()["source_count"]) == (2, "4", 1)
    # A single-source Undo record in the previous payload shape: items without source_id.
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("""UPDATE inventory_undo SET payload=(SELECT jsonb_agg(entry - 'source_id') FROM jsonb_array_elements(payload) entry)
          WHERE owner_id=%s""", (owner,))
        # A replay row as the previous application wrote it: no source or already-there counts.
        legacy_key, legacy_manifest = uuid4(), uuid4()
        digest = hashlib.sha256(json.dumps({"action": "move", "manifest_id": str(legacy_manifest), "destination_id": str(d)},
                                           sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        conn.execute("INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision) VALUES (%s,%s,%s,7)",
                     (owner, legacy_key, digest))
        conn.execute("INSERT INTO move_response(owner_id,request_key,edition_count,copy_count) VALUES (%s,%s,1,2)", (owner, legacy_key))
    entry = undo_entries(owner)[0]
    assert (entry["source_id"], entry["source_count"]) == (a, 1)
    assert undo(owner, entry["id"]).status_code == 200
    assert (held(owner, a, one), held(owner, a, two), held(owner, d, one), held(owner, d, two)) == (5, 2, 0, 0)
    assert commit(owner, str(legacy_manifest), d, legacy_key).json() == {
        "edition_count": 1, "copy_count": "2", "owner_revision": 7, "source_count": 1, "already_at_destination_count": "0"}


@pytest.mark.serial(reason='wall-clock: asserts the two-minute 25,000-Edition Move budget')
@pytest.mark.slow(reason='capacity: 25 000 Editions across five sources')
def test_25000_edition_move_across_five_sources_within_two_minutes():
    owner, _, first_source, _, edition, _ = fixture()
    sources = [first_source] + [leaf(owner, f"Capacity source {n}") for n in range(2, 6)]
    destination = leaf(owner, "Capacity destination")
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        printing = conn.execute("SELECT printing_id FROM catalog_edition WHERE id=%s", (edition,)).fetchone()[0]
        ids = [str(row[0]) for row in conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          SELECT %s,'multi-' || %s || '-' || n,'{}'::jsonb FROM generate_series(1,25000) AS n RETURNING id""",
                                                   (printing, str(uuid4()))).fetchall()]
        placed = [(sources[index % 5], eid) for index, eid in enumerate(ids)]
        conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,location_id,edition_id,2,1 FROM unnest(%s::uuid[],%s::uuid[]) AS p(location_id,edition_id)""",
                     (owner, [source for source, _ in placed], [eid for _, eid in placed]))
    started = time.perf_counter()
    manifest_id = begin(owner)["id"]
    for index in range(0, len(placed), 500):
        staged = stage(owner, manifest_id, [item(source, eid, 1, 1) for source, eid in placed[index:index + 500]])
        assert staged.status_code == 200, staged.text
    moved = commit(owner, manifest_id, destination)
    elapsed = time.perf_counter() - started
    assert moved.status_code == 200, moved.text
    assert (moved.json()["edition_count"], moved.json()["copy_count"], moved.json()["source_count"]) == (25000, "25000", 5)
    assert elapsed < 120, f"25,000-Edition multi-source Move took {elapsed:.1f} s"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        for source in sources:
            assert conn.execute("SELECT count(*),sum(quantity) FROM holding WHERE owner_id=%s AND location_id=%s",
                                (owner, source)).fetchone() == (5000, 5000)
        assert conn.execute("SELECT count(*),sum(quantity) FROM holding WHERE owner_id=%s AND location_id=%s",
                            (owner, destination)).fetchone() == (25000, 25000)
        entry = undo_entries(owner)[0]
        size = conn.execute("SELECT pg_column_size(payload) FROM inventory_undo WHERE id=%s", (entry["id"],)).fetchone()[0]
    assert entry["source_count"] == 5 and size < 2_000_000
    assert undo(owner, entry["id"]).status_code == 200
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        assert conn.execute("SELECT count(*),sum(quantity) FROM holding WHERE owner_id=%s AND location_id=ANY(%s::uuid[])",
                            (owner, sources)).fetchone() == (25000, 50000)
        assert conn.execute("SELECT count(*) FROM holding WHERE owner_id=%s AND location_id=%s", (owner, destination)).fetchone()[0] == 0
