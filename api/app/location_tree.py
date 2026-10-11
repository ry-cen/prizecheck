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


class TreeLocation(TreeNode):
    """A tree row with the copies stored directly in it: the sum of its Holdings' quantities as a
    decimal string, "0" for Organizational Locations and empty leaves. Only the tree read carries it."""
    copy_count: str


class TreeResponse(BaseModel):
    locations: list[TreeLocation]
    owner_revision: int


class LocationCommandResult(BaseModel):
    location: TreeNode
    owner_revision: int


class CreateLocation(BaseModel):
    name: str
    parent_id: UUID | None = None
    parent_version: int | None = Field(default=None, ge=1)
    conversion: str | None = None
    idempotency_key: UUID


class EditLocation(BaseModel):
    name: str | None = None
    parent_id: UUID | None = None
    parent_version: int | None = Field(default=None, ge=1)
    conversion: str | None = None
    version: int = Field(ge=1)
    idempotency_key: UUID


class DeleteLocation(BaseModel):
    name: str
    version: int = Field(ge=1)
    idempotency_key: UUID


class DeleteLocationResult(BaseModel):
    deleted_id: UUID
    owner_revision: int


def error(status: int, code: str):
    raise HTTPException(status, {"code": code})


def cleaned_name(name: str) -> str:
    value = name.strip()
    if not value or len(value) > 120 or any(ord(c) < 32 for c in value):
        error(422, "INVALID_LOCATION_NAME")
    return value


def owner_and_rows(conn, user_id: str):
    created = conn.execute("INSERT INTO inventory_owner (user_id) VALUES (%s) ON CONFLICT DO NOTHING RETURNING user_id", (user_id,)).fetchone()
    owner = conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE", (user_id,)).fetchone()
    if created:
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


def has_holdings(conn, node_id):
    return bool(conn.execute("SELECT 1 FROM holding WHERE location_id=%s LIMIT 1", (node_id,)).fetchone())


def move_holdings(conn, owner_id, source_id, target_id, next_revision):
    conn.execute("""UPDATE holding SET location_id=%s,version=%s
      WHERE owner_id=%s AND location_id=%s""", (target_id, next_revision, owner_id, source_id))


def unsorted_child(conn, owner_id, parent_id, rows):
    check_name("Unsorted", parent_id, rows)
    row = conn.execute("""INSERT INTO location(id,owner_id,parent_id,name,kind)
      VALUES (%s,%s,%s,'Unsorted','storage_leaf') RETURNING id,name,kind,parent_id,version""",
                       (uuid4(), owner_id, parent_id)).fetchone()
    rows[row["id"]] = row
    return row


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
        copies = {row["location_id"]: row["copies"] for row in conn.execute(
            "SELECT location_id,sum(quantity)::text AS copies FROM holding WHERE owner_id=%s GROUP BY location_id", (user_id,)).fetchall()}
        return TreeResponse(locations=[TreeLocation(**row, depth=depth_of(row["id"], rows), copy_count=copies.get(row["id"], "0"))
                                       for row in sorted(rows.values(), key=lambda r: (depth_of(r["id"], rows), r["name"].casefold(), str(r["id"])))],
                            owner_revision=revision)


@router.post("", response_model=LocationCommandResult, status_code=201)
def create_location(command: CreateLocation, user_id: str = Depends(verified_user)):
    name = cleaned_name(command.name)
    with connect() as conn, conn.transaction():
        revision, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key, command.model_dump(mode="json"))
        if previous:
            return previous
        parent = check_parent(command.parent_id, command.parent_version, rows)
        if parent and depth_of(parent["id"], rows) >= 12:
            error(409, "LOCATION_DEPTH_LIMIT")
        check_name(name, command.parent_id, rows)
        stocked = bool(parent and parent["kind"] == "storage_leaf" and has_holdings(conn, parent["id"]))
        if stocked and command.conversion not in ("move_holdings_to_child", "create_unsorted_child"):
            error(409, "STOCKED_LOCATION_REQUIRES_CONVERSION")
        if command.conversion and not stocked:
            error(409, "INVALID_LOCATION_CONVERSION")
        if parent:
            conn.execute("UPDATE location SET kind='organization',version=version+1 WHERE id=%s", (parent["id"],))
        new_id = uuid4()
        row = conn.execute("INSERT INTO location(id,owner_id,parent_id,name,kind) VALUES (%s,%s,%s,%s,'storage_leaf') RETURNING id,name,kind,parent_id,version",
                           (new_id, user_id, command.parent_id, name)).fetchone()
        rows[row["id"]] = row
        if stocked:
            target = row if command.conversion == "move_holdings_to_child" else unsorted_child(conn, user_id, parent["id"], rows)
            move_holdings(conn, user_id, parent["id"], target["id"], revision + 1)
        return store_result(conn, user_id, command.idempotency_key, digest, row, rows)


@router.patch("/{location_id}", response_model=LocationCommandResult)
def edit_location(location_id: UUID, command: EditLocation, user_id: str = Depends(verified_user)):
    return apply_edit(location_id, command, user_id, deck=False)


def apply_edit(location_id: UUID, command: EditLocation, user_id: str, *, deck: bool):
    """Rename and/or reparent one Location in one transaction.

    The Location command (deck=False) and the Deck command (deck=True, ``PATCH /api/decks/{id}``)
    share every rule here: stale versions, sibling names, depth, cycles, stocked-leaf conversion and
    idempotent replay. Each command accepts only its own kind. A Deck never gains children, because
    ``check_parent`` refuses a Deck as the new parent."""
    name = cleaned_name(command.name) if command.name is not None else None
    with connect() as conn, conn.transaction():
        revision, rows = owner_and_rows(conn, user_id)
        fields = command.model_dump(mode="json", exclude_unset=True)
        # The Location digest payload is unchanged so stored Location commands keep replaying.
        # The Deck payload is tagged, so one key can't replay across the two commands.
        request = ({"action": "edit_deck", "deck_id": str(location_id), **fields} if deck
                   else {"location_id": str(location_id), **fields})
        digest, previous = replay(conn, user_id, command.idempotency_key, request)
        if previous:
            return previous
        current = rows.get(location_id)
        if deck:
            if current is None or current["kind"] != "deck":
                error(404, "DECK_NOT_FOUND")
        else:
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
        if command.conversion and not moving:
            error(409, "INVALID_LOCATION_CONVERSION")
        if not deck and current["name"] == "Unsorted" and current["parent_id"] is None and (moving or (name is not None and name != current["name"])):
            if has_holdings(conn, location_id) or any(row["parent_id"] == location_id for row in rows.values()):
                error(409, "LOCATION_NOT_EMPTY")
        if moving:
            parent = check_parent(destination, command.parent_version, rows)
            branch = descendants(location_id, rows)
            if destination in branch:
                error(409, "LOCATION_CYCLE")
            max_relative = max(depth_of(node_id, rows) - depth_of(location_id, rows) for node_id in branch)
            if (depth_of(destination, rows) if destination else 0) + 1 + max_relative > 12:
                error(409, "LOCATION_DEPTH_LIMIT")
            if parent:
                stocked = parent["kind"] == "storage_leaf" and has_holdings(conn, parent["id"])
                if stocked and command.conversion != "create_unsorted_child":
                    error(409, "STOCKED_LOCATION_REQUIRES_CONVERSION")
                if command.conversion and not stocked:
                    error(409, "INVALID_LOCATION_CONVERSION")
                conn.execute("UPDATE location SET kind='organization',version=version+1 WHERE id=%s", (parent["id"],))
                if stocked:
                    unsorted = unsorted_child(conn, user_id, parent["id"], rows)
                    move_holdings(conn, user_id, parent["id"], unsorted["id"], revision + 1)
            elif command.conversion:
                error(409, "INVALID_LOCATION_CONVERSION")
            old_parent_id = current["parent_id"]
            if old_parent_id is not None:
                last_child = not any(r["parent_id"] == old_parent_id and r["id"] != location_id for r in rows.values())
                conn.execute("UPDATE location SET kind=%s,version=version+1 WHERE id=%s", ('storage_leaf' if last_child else 'organization', old_parent_id))
        check_name(name or current["name"], destination, rows, exclude=location_id)
        row = conn.execute("UPDATE location SET name=%s,parent_id=%s,version=version+1 WHERE id=%s RETURNING id,name,kind,parent_id,version",
                           (name or current["name"], destination, location_id)).fetchone()
        rows[row["id"]] = row
        return store_result(conn, user_id, command.idempotency_key, digest, row, rows)


@router.delete("/{location_id}", response_model=DeleteLocationResult)
def delete_location(location_id: UUID, command: DeleteLocation, user_id: str = Depends(verified_user)):
    name = cleaned_name(command.name)
    with connect() as conn, conn.transaction():
        revision, rows = owner_and_rows(conn, user_id)
        digest, previous = replay(conn, user_id, command.idempotency_key,
                                  {"action": "delete", "location_id": str(location_id), **command.model_dump(mode="json")})
        if previous:
            return previous
        current = rows.get(location_id)
        if current is None:
            error(404, "LOCATION_NOT_FOUND")
        if current["kind"] == "deck":
            error(409, "DECK_REQUIRES_DECK_COMMAND")
        if current["version"] != command.version:
            error(409, "STALE_LOCATION")
        if current["name"] != name:
            error(409, "LOCATION_NAME_CONFIRMATION_MISMATCH")
        if has_holdings(conn, location_id) or any(row["parent_id"] == location_id for row in rows.values()):
            error(409, "LOCATION_NOT_EMPTY")
        conn.execute("DELETE FROM location WHERE owner_id=%s AND id=%s", (user_id, location_id))
        parent_id = current["parent_id"]
        if parent_id is not None:
            last_child = not any(row["parent_id"] == parent_id and row["id"] != location_id for row in rows.values())
            conn.execute("UPDATE location SET kind=%s,version=version+1 WHERE owner_id=%s AND id=%s",
                         ("storage_leaf" if last_child else "organization", user_id, parent_id))
        result = DeleteLocationResult(deleted_id=location_id, owner_revision=revision + 1).model_dump(mode="json")
        conn.execute("UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s", (user_id,))
        conn.execute("INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)",
                     (user_id, command.idempotency_key, digest, json.dumps(result)))
        return result
