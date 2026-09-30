"""Owner-scoped Location tree commands and read model."""
import hashlib
import json
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .main import connect, verified_user

router = APIRouter(prefix="/api/location-tree", tags=["locations"])


class TreeNode(BaseModel):
    id: UUID
    name: str
    kind: str
    parent_id: UUID | None
    version: int
    depth: int


class TreeResponse(BaseModel):
    locations: list[TreeNode]
    owner_revision: int


class LocationCommandResult(BaseModel):
    location: TreeNode
    owner_revision: int


class CreateLocation(BaseModel):
    name: str
    parent_id: UUID | None = None
    parent_version: int | None = Field(default=None, ge=1)
    idempotency_key: UUID


class EditLocation(BaseModel):
    name: str | None = None
    parent_id: UUID | None = None
    parent_version: int | None = Field(default=None, ge=1)
    version: int = Field(ge=1)
    idempotency_key: UUID


def error(status: int, code: str):
    raise HTTPException(status, {"code": code})


def cleaned_name(name: str) -> str:
    value = name.strip()
    if not value or len(value) > 120 or any(ord(c) < 32 for c in value):
        error(422, "INVALID_LOCATION_NAME")
    return value


def owner_and_rows(conn, user_id: str):
    conn.execute("INSERT INTO inventory_owner (user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user_id,))
    owner = conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE", (user_id,)).fetchone()
    rows = conn.execute("SELECT id,name,kind,parent_id,version FROM location WHERE owner_id=%s", (user_id,)).fetchall()
    if not rows:
        conn.execute("INSERT INTO location(id,owner_id,parent_id,name,kind) VALUES (%s,%s,NULL,'Unsorted','storage_leaf')", (uuid4(), user_id))
        rows = conn.execute("SELECT id,name,kind,parent_id,version FROM location WHERE owner_id=%s", (user_id,)).fetchall()
    return owner["revision"], {row["id"]: row for row in rows}


def depth_of(node_id, rows):
    depth, seen = 0, set()
    while node_id is not None:
        if node_id in seen or node_id not in rows:
            error(409, "INVALID_LOCATION_TREE")
        seen.add(node_id)
        depth += 1
        node_id = rows[node_id]["parent_id"]
    return depth


def descendants(node_id, rows):
    result = {node_id}
    while True:
        next_result = result | {row["id"] for row in rows.values() if row["parent_id"] in result}
        if next_result == result:
            return result
        result = next_result


def node_model(row, rows):
    return TreeNode(**row, depth=depth_of(row["id"], rows))


def check_parent(parent_id, parent_version, rows):
    if parent_id is None:
        return None
    parent = rows.get(parent_id)
    if parent is None:
        error(404, "LOCATION_NOT_FOUND")
    if parent["kind"] == "deck":
        error(409, "DECK_CANNOT_HAVE_CHILDREN")
    if parent_version is None or parent["version"] != parent_version:
        error(409, "STALE_LOCATION")
    return parent


def check_name(name, parent_id, rows, exclude=None):
    if any(row["id"] != exclude and row["parent_id"] == parent_id and row["name"].casefold() == name.casefold() for row in rows.values()):
        error(409, "LOCATION_NAME_CONFLICT")


def check_empty(conn, node_id):
    # Ticket 04 installs Holdings. Once present, edits of stocked nodes are
    # held for the explicit conversion flow in ticket 06.
    if conn.execute("SELECT to_regclass('holding') AS table_name").fetchone()["table_name"]:
        if conn.execute("SELECT 1 FROM holding WHERE location_id=%s LIMIT 1", (node_id,)).fetchone():
            error(409, "STOCKED_LOCATION_REQUIRES_CONVERSION")


def replay(conn, user_id, key, payload):
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    row = conn.execute("SELECT request_digest,response FROM location_command WHERE owner_id=%s AND request_key=%s", (user_id, key)).fetchone()
    if row:
        if row["request_digest"] != digest:
            error(409, "IDEMPOTENCY_KEY_REUSED")
        return digest, row["response"]
    return digest, None


def store_result(conn, user_id, key, digest, row, rows):
    revision = conn.execute("UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s RETURNING revision", (user_id,)).fetchone()["revision"]
    result = LocationCommandResult(location=node_model(row, rows), owner_revision=revision).model_dump(mode="json")
    conn.execute("INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)",
                 (user_id, key, digest, json.dumps(result)))
    return result


@router.get("", response_model=TreeResponse)
def tree(user_id: str = Depends(verified_user)):
    with connect() as conn, conn.transaction():
        revision, rows = owner_and_rows(conn, user_id)
        return TreeResponse(locations=[node_model(row, rows) for row in sorted(rows.values(), key=lambda r: (depth_of(r["id"], rows), r["name"].casefold(), str(r["id"])))], owner_revision=revision)


@router.post("", response_model=LocationCommandResult, status_code=201)
def create_location(command: CreateLocation, user_id: str = Depends(verified_user)):
    name = cleaned_name(command.name)
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, command.model_dump(mode="json"))
        if previous:
            return previous
        parent = check_parent(command.parent_id, command.parent_version, rows)
        if parent and depth_of(parent["id"], rows) >= 12:
            error(409, "LOCATION_DEPTH_LIMIT")
        check_name(name, command.parent_id, rows)
        if parent:
            if parent["kind"] == "storage_leaf":
                check_empty(conn, parent["id"])
            conn.execute("UPDATE location SET kind='organization',version=version+1 WHERE id=%s", (parent["id"],))
        new_id = uuid4()
        row = conn.execute("INSERT INTO location(id,owner_id,parent_id,name,kind) VALUES (%s,%s,%s,%s,'storage_leaf') RETURNING id,name,kind,parent_id,version",
                           (new_id, user_id, command.parent_id, name)).fetchone()
        rows[row["id"]] = row
        return store_result(conn, user_id, command.idempotency_key, digest, row, rows)


@router.patch("/{location_id}", response_model=LocationCommandResult)
def edit_location(location_id: UUID, command: EditLocation, user_id: str = Depends(verified_user)):
    name = cleaned_name(command.name) if command.name is not None else None
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, {"location_id": str(location_id), **command.model_dump(mode="json", exclude_unset=True)})
        if previous:
            return previous
        current = rows.get(location_id)
        if current is None:
            error(404, "LOCATION_NOT_FOUND")
        if current["kind"] == "deck":
            error(409, "DECK_REQUIRES_DECK_COMMAND")
        if current["version"] != command.version:
            error(409, "STALE_LOCATION")
        if command.name is None and "parent_id" not in command.model_fields_set:
            error(400, "EMPTY_LOCATION_EDIT")
        destination = command.parent_id if "parent_id" in command.model_fields_set else current["parent_id"]
        moving = destination != current["parent_id"]
        if moving:
            parent = check_parent(destination, command.parent_version, rows)
            branch = descendants(location_id, rows)
            if destination in branch:
                error(409, "LOCATION_CYCLE")
            max_relative = max(depth_of(node_id, rows) - depth_of(location_id, rows) for node_id in branch)
            if (depth_of(destination, rows) if destination else 0) + 1 + max_relative > 12:
                error(409, "LOCATION_DEPTH_LIMIT")
            check_empty(conn, location_id)
            if parent:
                if parent["kind"] == "storage_leaf":
                    check_empty(conn, parent["id"])
                conn.execute("UPDATE location SET kind='organization',version=version+1 WHERE id=%s", (parent["id"],))
            old_parent_id = current["parent_id"]
            if old_parent_id is not None:
                last_child = not any(r["parent_id"] == old_parent_id and r["id"] != location_id for r in rows.values())
                conn.execute("UPDATE location SET kind=%s,version=version+1 WHERE id=%s", ('storage_leaf' if last_child else 'organization', old_parent_id))
        check_name(name or current["name"], destination, rows, exclude=location_id)
        row = conn.execute("UPDATE location SET name=%s,parent_id=%s,version=version+1 WHERE id=%s RETURNING id,name,kind,parent_id,version",
                           (name or current["name"], destination, location_id)).fetchone()
        rows[row["id"]] = row
        return store_result(conn, user_id, command.idempotency_key, digest, row, rows)
