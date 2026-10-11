"""Safe Location conversion and deletion through signed HTTP commands."""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest

from test_location_tree import call, change, make, tree


def stocked_owner():
    owner = str(uuid4())
    root = tree(owner)[0]
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,'Pikachu') RETURNING id", (str(uuid4()),)).fetchone()[0]
        printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',%s,%s) RETURNING id", (str(uuid4()), identity)).fetchone()[0]
        edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'unspecified',%s) RETURNING id", (printing, json.dumps({"label": "Unspecified Variant"}))).fetchone()[0]
        conn.execute("INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,3,1)", (owner, root["id"], edition))
    return owner, root, edition


def holdings(owner):
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=psycopg.rows.dict_row) as conn:
        return [{"location_id": str(row["location_id"]), "quantity": row["quantity"]}
                for row in conn.execute("SELECT location_id,quantity FROM holding WHERE owner_id=%s", (owner,)).fetchall()]


def test_stocked_leaf_can_put_holdings_in_named_child_or_unsorted_child():
    for choice, expected in (("move_holdings_to_child", "Pages"), ("create_unsorted_child", "Unsorted")):
        owner, root, _ = stocked_owner()
        blocked = make(owner, "Pages", root)
        assert blocked.status_code == 409 and blocked.json()["detail"]["code"] == "STOCKED_LOCATION_REQUIRES_CONVERSION"
        assert len(tree(owner)) == 1 and holdings(owner)[0]["location_id"] == root["id"]
        response = call("POST", "/api/location-tree", owner, {"name": "Pages", "parent_id": root["id"], "parent_version": root["version"], "conversion": choice, "idempotency_key": str(uuid4())})
        assert response.status_code == 201, response.text
        nodes = tree(owner)
        assert next(n for n in nodes if n["id"] == root["id"])["kind"] == "organization"
        assert len(nodes) == (2 if choice == "move_holdings_to_child" else 3)
        target = next(n for n in nodes if n["parent_id"] == root["id"] and n["name"] == expected)
        assert holdings(owner) == [{"location_id": target["id"], "quantity": 3}]


def test_reparent_stocked_destination_requires_conversion_and_preserves_source():
    owner, destination, _ = stocked_owner()
    source = make(owner, "Source").json()["location"]
    blocked = change(owner, source, parent_id=destination["id"], parent_version=destination["version"])
    assert blocked.status_code == 409 and blocked.json()["detail"]["code"] == "STOCKED_LOCATION_REQUIRES_CONVERSION"
    converted = change(owner, source, parent_id=destination["id"], parent_version=destination["version"], conversion="create_unsorted_child")
    assert converted.status_code == 200, converted.text
    nodes = tree(owner)
    unsorted = next(n for n in nodes if n["parent_id"] == destination["id"] and n["name"] == "Unsorted")
    assert holdings(owner) == [{"location_id": unsorted["id"], "quantity": 3}]
    assert next(n for n in nodes if n["id"] == source["id"])["parent_id"] == destination["id"]


def test_delete_requires_name_empty_childless_version_and_owner():
    owner, root, _ = stocked_owner()
    body = {"name": "Unsorted", "version": root["version"], "idempotency_key": str(uuid4())}
    assert call("DELETE", f"/api/location-tree/{root['id']}", owner, body).json()["detail"]["code"] == "LOCATION_NOT_EMPTY"
    assert call("DELETE", f"/api/location-tree/{root['id']}", str(uuid4()), body).status_code == 404
    parent = make(owner, "Parent").json()["location"]
    child_of_parent = make(owner, "Nested", parent).json()["location"]
    parent = next(node for node in tree(owner) if node["id"] == parent["id"])
    assert call("DELETE", f"/api/location-tree/{parent['id']}", owner,
                {"name": "Parent", "version": parent["version"], "idempotency_key": str(uuid4())}).json()["detail"]["code"] == "LOCATION_NOT_EMPTY"
    assert next(node for node in tree(owner) if node["id"] == child_of_parent["id"])["parent_id"] == parent["id"]
    child = make(owner, "Empty").json()["location"]
    wrong = {"name": "Wrong", "version": child["version"], "idempotency_key": str(uuid4())}
    assert call("DELETE", f"/api/location-tree/{child['id']}", owner, wrong).status_code == 409
    correct = {**wrong, "name": "Empty", "idempotency_key": str(uuid4())}
    result = call("DELETE", f"/api/location-tree/{child['id']}", owner, correct)
    assert result.status_code == 200, result.text
    assert call("DELETE", f"/api/location-tree/{child['id']}", owner, correct).json() == result.json()
    assert all(n["id"] != child["id"] for n in tree(owner))


def test_two_tabs_cannot_both_convert_same_leaf():
    owner, root, _ = stocked_owner()
    def convert(name):
        return call("POST", "/api/location-tree", owner, {"name": name, "parent_id": root["id"], "parent_version": root["version"], "conversion": "move_holdings_to_child", "idempotency_key": str(uuid4())})
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(convert, ("A", "B")))
    assert sorted(r.status_code for r in results) == [201, 409]
    assert len(holdings(owner)) == 1 and len(tree(owner)) == 2


def test_stocked_source_can_move_and_final_child_removal_restores_empty_leaf():
    owner, root, _ = stocked_owner()
    source = make(owner, "Source").json()["location"]
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("UPDATE holding SET location_id=%s WHERE owner_id=%s AND location_id=%s", (source["id"], owner, root["id"]))
    parent = make(owner, "Parent").json()["location"]
    moved = change(owner, source, parent_id=parent["id"], parent_version=parent["version"])
    assert moved.status_code == 200, moved.text
    assert holdings(owner) == [{"location_id": source["id"], "quantity": 3}]
    parent = next(node for node in tree(owner) if node["id"] == parent["id"])
    assert parent["kind"] == "organization"
    moved_source = moved.json()["location"]
    assert change(owner, moved_source, parent_id=None).status_code == 200
    parent = next(node for node in tree(owner) if node["id"] == parent["id"])
    assert parent["kind"] == "storage_leaf"
    deleted = call("DELETE", f"/api/location-tree/{parent['id']}", owner,
                   {"name": "Parent", "version": parent["version"], "idempotency_key": str(uuid4())})
    assert deleted.status_code == 200, deleted.text


def test_unsorted_root_can_be_renamed_only_after_it_is_empty():
    owner, root, _ = stocked_owner()
    blocked = change(owner, root, name="New Name")
    assert blocked.status_code == 409 and blocked.json()["detail"]["code"] == "LOCATION_NOT_EMPTY"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("DELETE FROM holding WHERE owner_id=%s AND location_id=%s", (owner, root["id"]))
    renamed = change(owner, root, name="New Name")
    assert renamed.status_code == 200, renamed.text


def test_empty_unsorted_root_can_be_deleted_without_reappearing():
    owner = str(uuid4())
    root = tree(owner)[0]
    response = call("DELETE", f"/api/location-tree/{root['id']}", owner,
                    {"name": "Unsorted", "version": root["version"], "idempotency_key": str(uuid4())})
    assert response.status_code == 200, response.text
    assert tree(owner) == []
    assert call("GET", "/api/locations", owner).json()["locations"] == []


def test_failed_holding_transfer_rolls_back_location_conversion():
    owner, root, _ = stocked_owner()
    suffix = uuid4().hex
    function_name, trigger_name = f"fail_conversion_{suffix}", f"fail_conversion_trigger_{suffix}"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute(f"CREATE FUNCTION {function_name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected conversion failure'; END $$")
        conn.execute(f"CREATE TRIGGER {trigger_name} BEFORE UPDATE ON holding FOR EACH ROW EXECUTE FUNCTION {function_name}()")
    try:
        with pytest.raises(psycopg.Error):
            call("POST", "/api/location-tree", owner, {"name": "Pages", "parent_id": root["id"],
                 "parent_version": root["version"], "conversion": "move_holdings_to_child", "idempotency_key": str(uuid4())})
        assert len(tree(owner)) == 1
        assert tree(owner)[0]["kind"] == "storage_leaf"
        assert holdings(owner) == [{"location_id": root["id"], "quantity": 3}]
    finally:
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute(f"DROP TRIGGER {trigger_name} ON holding")
            conn.execute(f"DROP FUNCTION {function_name}()")


def test_tree_reports_copies_stored_in_each_location():
    owner, root, edition = stocked_owner()
    stocked_owner()  # Another owner's three copies never count.
    empty = make(owner, "Empty").json()["location"]
    folder = make(owner, "Folder").json()["location"]
    assert make(owner, "Inside", folder).status_code == 201
    deck_id = uuid4()
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Deck','deck')", (deck_id, owner))
        conn.execute("INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,2,1)", (owner, deck_id, edition))
    assert {node["name"]: node["copy_count"] for node in tree(owner)} == {
        "Unsorted": "3", "Empty": "0", "Folder": "0", "Inside": "0", "Deck": "2"}
    # Command results keep their shape; only the tree read carries copy counts.
    renamed = change(owner, empty, name="Still empty")
    assert renamed.status_code == 200, renamed.text
    assert "copy_count" not in renamed.json()["location"]
