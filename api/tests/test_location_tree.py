"""Location contracts exercised through HTTP against real PostgreSQL."""
import hashlib
import hmac
import json
import os
import time
from uuid import uuid4

import psycopg
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def call(method, path, user, body=None):
    payload = b"" if body is None else json.dumps(body, separators=(",", ":")).encode()
    stamp = str(int(time.time()))
    signed = f"{method}\n{path}\n{hashlib.sha256(payload).hexdigest()}\n{user}\n{stamp}".encode()
    headers = {"x-internal-user": user, "x-internal-time": stamp,
               "x-internal-signature": hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), signed, hashlib.sha256).hexdigest()}
    return client.request(method, path, headers={**headers, **({"content-type": "application/json"} if body is not None else {})}, content=payload if body is not None else None)


def tree(user):
    response = call("GET", "/api/location-tree", user)
    assert response.status_code == 200, response.text
    return response.json()["locations"]


def make(user, name, parent=None, key=None):
    body = {"name": name, "idempotency_key": str(key or uuid4())}
    if parent:
        body.update(parent_id=parent["id"], parent_version=parent["version"])
    return call("POST", "/api/location-tree", user, body)


def change(user, node, **changes):
    body = {"version": node["version"], "idempotency_key": str(uuid4()), **changes}
    return call("PATCH", f"/api/location-tree/{node['id']}", user, body)


def test_names_versions_idempotency_and_owner_isolation():
    owner, other = str(uuid4()), str(uuid4())
    assert tree(owner)[0]["name"] == "Unsorted"
    key = uuid4()
    first = make(owner, " Binder ", key=key)
    assert first.status_code == 201, first.text
    binder = first.json()["location"]
    assert binder["name"] == "Binder" and binder["depth"] == 1
    assert make(owner, " Binder ", key=key).json() == first.json()
    assert make(owner, "Different", key=key).json()["detail"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert make(owner, "binder").json()["detail"]["code"] == "LOCATION_NAME_CONFLICT"
    child = make(owner, "Page", binder).json()["location"]
    assert child["depth"] == 2
    fresh_binder = next(item for item in tree(owner) if item["id"] == binder["id"])
    assert fresh_binder["kind"] == "organization" and fresh_binder["version"] > binder["version"]
    assert make(owner, "Late page", binder).json()["detail"]["code"] == "STALE_LOCATION"
    assert change(owner, child, name="Page 1").json()["location"]["parent_id"] == binder["id"]
    assert change(owner, child, name="Page 2").json()["detail"]["code"] == "STALE_LOCATION"
    assert call("PATCH", f"/api/location-tree/{child['id']}", other, {"name": "Stolen", "version": 1, "idempotency_key": str(uuid4())}).status_code == 404
    assert make(other, "Bad", {"id": binder["id"], "version": fresh_binder["version"]}).status_code == 404
    assert all(item["id"] != binder["id"] for item in tree(other))
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        assert conn.execute("SELECT count(*) FROM location WHERE owner_id=%s AND lower(name)='binder'", (owner,)).fetchone()[0] == 1
        deck_id = uuid4()
        conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Test Deck','deck')", (deck_id, owner))
    assert make(owner, "Inside deck", {"id": str(deck_id), "version": 1}).json()["detail"]["code"] == "DECK_CANNOT_HAVE_CHILDREN"
    assert call("PATCH", f"/api/location-tree/{deck_id}", owner, {"name": "Changed Deck", "version": 1, "idempotency_key": str(uuid4())}).json()["detail"]["code"] == "DECK_REQUIRES_DECK_COMMAND"


def test_reparent_descendants_cycle_depth_and_atomic_failure():
    owner = str(uuid4())
    source = make(owner, "Source").json()["location"]
    nested = make(owner, "Nested", source).json()["location"]
    source = next(item for item in tree(owner) if item["id"] == source["id"])
    destination = make(owner, "Destination").json()["location"]
    moved = change(owner, source, parent_id=destination["id"], parent_version=destination["version"])
    assert moved.status_code == 200, moved.text
    nodes = tree(owner)
    assert next(item for item in nodes if item["id"] == nested["id"])["depth"] == 3
    assert next(item for item in nodes if item["id"] == nested["id"])["version"] == nested["version"]
    moved_node = moved.json()["location"]
    cycle = change(owner, moved_node, parent_id=nested["id"], parent_version=nested["version"])
    assert cycle.status_code == 409 and cycle.json()["detail"]["code"] == "LOCATION_CYCLE"
    assert next(item for item in tree(owner) if item["id"] == moved_node["id"])["parent_id"] == destination["id"]
    current = moved_node
    for level in range(3, 13):
        current = make(owner, f"Level {level}", current).json()["location"]
        current = next(item for item in tree(owner) if item["id"] == current["id"])
    over = make(owner, "Too deep", current)
    assert over.status_code == 409 and over.json()["detail"]["code"] == "LOCATION_DEPTH_LIMIT"
    extra = make(owner, "Extra").json()["location"]
    deep_move = change(owner, extra, parent_id=current["id"], parent_version=current["version"])
    assert deep_move.status_code == 409 and deep_move.json()["detail"]["code"] == "LOCATION_DEPTH_LIMIT"
    assert next(item for item in tree(owner) if item["id"] == extra["id"])["parent_id"] is None
    assert len(tree(owner)) == 15  # Unsorted, Destination, Source, Nested, ten deeper nodes, Extra.
