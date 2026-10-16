"""The Deck rename and move command (PATCH /api/decks/{id}) through signed HTTP against PostgreSQL.

It shares the Location edit's rules: stale versions, sibling names, depth, stocked-leaf conversion
and idempotent replay. A Deck stays a Deck, never becomes a parent, and keeps its own cards."""
import os
from uuid import uuid4

import psycopg

from test_location_conversion import holdings, stocked_owner
from test_location_tree import call, change, make, tree


def code(response):
    return response.json()["detail"]["code"]


def node(owner, node_id):
    return next(item for item in tree(owner) if item["id"] == node_id)


def new_deck(owner, name="Battle Deck"):
    response = call("POST", "/api/decks", owner, {"name": name, "idempotency_key": str(uuid4())})
    assert response.status_code == 201, response.text
    return response.json()["location"]


def edit(owner, deck, key=None, **changes):
    body = {"version": deck["version"], "idempotency_key": str(key or uuid4()), **changes}
    return call("PATCH", f"/api/decks/{deck['id']}", owner, body)


def into(parent):
    return {"parent_id": parent["id"], "parent_version": parent["version"]}


def test_deck_rename_and_move_keep_it_a_deck_that_never_becomes_a_parent():
    owner = str(uuid4())
    deck = new_deck(owner)
    shelf = make(owner, "Shelf").json()["location"]

    renamed = edit(owner, deck, name="  Mew Deck ")
    assert renamed.status_code == 200, renamed.text
    result = renamed.json()
    assert result["location"] == {**deck, "name": "Mew Deck", "version": deck["version"] + 1}
    assert "copy_count" not in result["location"]

    moved = edit(owner, result["location"], **into(shelf))
    assert moved.status_code == 200, moved.text
    assert moved.json()["owner_revision"] > result["owner_revision"]
    deck = moved.json()["location"]
    assert deck["parent_id"] == shelf["id"] and deck["depth"] == 2 and deck["kind"] == "deck"
    shelf_now = node(owner, shelf["id"])
    assert shelf_now["kind"] == "organization" and shelf_now["version"] > shelf["version"]
    listed = call("GET", "/api/decks", owner).json()["decks"]
    assert [(item["id"], item["name"], item["depth"]) for item in listed] == [(deck["id"], "Mew Deck", 2)]
    assert call("GET", f"/api/decks/{deck['id']}", owner).json()["deck"]["parent_id"] == shelf["id"]

    # Still never a parent: no child Location, no Location moved in, no Deck moved in.
    child = make(owner, "Inside", deck)
    assert child.status_code == 409 and code(child) == "DECK_CANNOT_HAVE_CHILDREN"
    spare = make(owner, "Spare").json()["location"]
    nested = change(owner, spare, **into(deck))
    assert nested.status_code == 409 and code(nested) == "DECK_CANNOT_HAVE_CHILDREN"
    other_deck = new_deck(owner, "Other Deck")
    stacked = edit(owner, other_deck, **into(deck))
    assert stacked.status_code == 409 and code(stacked) == "DECK_CANNOT_HAVE_CHILDREN"

    # Rename and move in one command; leaving the folder empty turns it back into an empty leaf.
    both = edit(owner, deck, name="Top Deck", parent_id=None)
    assert both.status_code == 200, both.text
    assert both.json()["location"]["name"] == "Top Deck" and both.json()["location"]["parent_id"] is None
    assert node(owner, shelf["id"])["kind"] == "storage_leaf"
    assert node(owner, deck["id"])["kind"] == "deck"


def test_deck_command_accepts_only_the_owners_decks_and_real_edits():
    owner, other = str(uuid4()), str(uuid4())
    deck = new_deck(owner)
    folder = make(owner, "Folder").json()["location"]
    not_a_deck = call("PATCH", f"/api/decks/{folder['id']}", owner,
                      {"name": "Renamed", "version": folder["version"], "idempotency_key": str(uuid4())})
    assert not_a_deck.status_code == 404 and code(not_a_deck) == "DECK_NOT_FOUND"
    assert node(owner, folder["id"])["name"] == "Folder"
    stolen = edit(other, deck, name="Stolen")
    assert stolen.status_code == 404 and code(stolen) == "DECK_NOT_FOUND"
    missing = call("PATCH", f"/api/decks/{uuid4()}", owner, {"name": "Ghost", "version": 1, "idempotency_key": str(uuid4())})
    assert missing.status_code == 404 and code(missing) == "DECK_NOT_FOUND"
    empty = edit(owner, deck)
    assert empty.status_code == 400 and code(empty) == "EMPTY_LOCATION_EDIT"
    blank = edit(owner, deck, name="   ")
    assert blank.status_code == 422 and code(blank) == "INVALID_LOCATION_NAME"
    # The Location edit still refuses Decks.
    location_edit = change(owner, deck, name="Via Location edit")
    assert location_edit.status_code == 409 and code(location_edit) == "DECK_REQUIRES_DECK_COMMAND"
    assert node(owner, deck["id"]) == {**deck, "copy_count": "0", "hidden": False, "hidden_by": None}


def test_deck_edit_with_a_stale_version_changes_nothing():
    owner = str(uuid4())
    deck = new_deck(owner)
    assert edit(owner, deck, name="First").status_code == 200
    late = edit(owner, deck, name="Late")
    assert late.status_code == 409 and code(late) == "STALE_LOCATION"
    fresh = node(owner, deck["id"])
    assert fresh["name"] == "First"

    folder = make(owner, "Folder").json()["location"]
    assert change(owner, folder, name="Folder 2").status_code == 200
    stale_parent = edit(owner, fresh, **into(folder))
    assert stale_parent.status_code == 409 and code(stale_parent) == "STALE_LOCATION"
    assert node(owner, deck["id"]) == fresh
    assert node(owner, folder["id"])["kind"] == "storage_leaf"


def test_deck_edit_rejects_a_sibling_name_ignoring_case():
    owner = str(uuid4())
    deck = new_deck(owner)
    make(owner, "Binder")
    new_deck(owner, "Other Deck")
    for taken in ("BINDER", " other deck "):
        clash = edit(owner, deck, name=taken)
        assert clash.status_code == 409 and code(clash) == "LOCATION_NAME_CONFLICT"
    folder = make(owner, "Folder").json()["location"]
    make(owner, "battle deck", folder)
    folder = node(owner, folder["id"])
    moved = edit(owner, deck, **into(folder))
    assert moved.status_code == 409 and code(moved) == "LOCATION_NAME_CONFLICT"
    assert node(owner, deck["id"]) == {**deck, "copy_count": "0", "hidden": False, "hidden_by": None}
    assert node(owner, folder["id"]) == folder


def test_deck_cannot_move_into_a_deck_itself_or_a_missing_parent():
    owner, other = str(uuid4()), str(uuid4())
    deck = new_deck(owner)
    other_deck = new_deck(owner, "Other Deck")
    for target in (other_deck, deck):
        refused = edit(owner, deck, **into(target))
        assert refused.status_code == 409 and code(refused) == "DECK_CANNOT_HAVE_CHILDREN"
    foreign = make(other, "Foreign").json()["location"]
    for target in ({"id": str(uuid4()), "version": 1}, foreign):
        refused = edit(owner, deck, **into(target))
        assert refused.status_code == 404 and code(refused) == "LOCATION_NOT_FOUND"
    assert node(owner, deck["id"]) == {**deck, "copy_count": "0", "hidden": False, "hidden_by": None}


def test_deck_move_respects_the_depth_limit():
    owner = str(uuid4())
    deck = new_deck(owner)
    chain = [make(owner, "Level 1").json()["location"]]
    for level in range(2, 13):
        chain.append(make(owner, f"Level {level}", node(owner, chain[-1]["id"])).json()["location"])
    level12 = node(owner, chain[-1]["id"])
    assert level12["depth"] == 12
    too_deep = edit(owner, deck, **into(level12))
    assert too_deep.status_code == 409 and code(too_deep) == "LOCATION_DEPTH_LIMIT"
    assert node(owner, deck["id"])["parent_id"] is None
    assert node(owner, level12["id"]) == level12
    level11 = node(owner, chain[-2]["id"])
    deepest = edit(owner, deck, **into(level11))
    assert deepest.status_code == 200, deepest.text
    assert deepest.json()["location"]["depth"] == 12


def test_deck_move_into_a_stocked_leaf_puts_its_cards_in_a_new_unsorted_child():
    owner, root, edition = stocked_owner()
    deck = new_deck(owner)
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,2,1)",
                     (owner, deck["id"], edition))
    before = sorted(holdings(owner), key=lambda row: row["quantity"])
    checks = call("GET", f"/api/decks/{deck['id']}", owner).json()["checks"]
    contents = call("GET", f"/api/decks/{deck['id']}/contents", owner).json()["editions"]

    blocked = edit(owner, deck, **into(root))
    assert blocked.status_code == 409 and code(blocked) == "STOCKED_LOCATION_REQUIRES_CONVERSION"
    # The Location edit's other conversion would pour the leaf's cards into the Deck; it is refused.
    poured = edit(owner, deck, **into(root), conversion="move_holdings_to_child")
    assert poured.status_code == 409 and code(poured) == "STOCKED_LOCATION_REQUIRES_CONVERSION"
    renamed_with_conversion = edit(owner, deck, name="Renamed", conversion="create_unsorted_child")
    assert renamed_with_conversion.status_code == 409 and code(renamed_with_conversion) == "INVALID_LOCATION_CONVERSION"
    assert sorted(holdings(owner), key=lambda row: row["quantity"]) == before
    assert len(tree(owner)) == 2

    converted = edit(owner, deck, **into(root), conversion="create_unsorted_child")
    assert converted.status_code == 200, converted.text
    nodes = tree(owner)
    unsorted = next(n for n in nodes if n["parent_id"] == root["id"] and n["name"] == "Unsorted")
    assert next(n for n in nodes if n["id"] == root["id"])["kind"] == "organization"
    moved = next(n for n in nodes if n["id"] == deck["id"])
    assert moved["parent_id"] == root["id"] and moved["kind"] == "deck" and moved["copy_count"] == "2"
    assert sorted(holdings(owner), key=lambda row: row["quantity"]) == [
        {"location_id": deck["id"], "quantity": 2}, {"location_id": unsorted["id"], "quantity": 3}]
    # Deck checks and contents read the same cards as before the move.
    assert call("GET", f"/api/decks/{deck['id']}", owner).json()["checks"] == checks
    assert call("GET", f"/api/decks/{deck['id']}/contents", owner).json()["editions"] == contents

    # A conversion against a target that holds no cards is refused.
    folder = make(owner, "Empty").json()["location"]
    moved = node(owner, deck["id"])
    needless = edit(owner, moved, **into(folder), conversion="create_unsorted_child")
    assert needless.status_code == 409 and code(needless) == "INVALID_LOCATION_CONVERSION"


def test_deck_edit_replays_and_refuses_a_reused_key():
    owner = str(uuid4())
    deck = new_deck(owner)
    key = uuid4()
    first = edit(owner, deck, key=key, name="Replay Deck")
    assert first.status_code == 200, first.text
    assert edit(owner, deck, key=key, name="Replay Deck").json() == first.json()
    assert node(owner, deck["id"])["version"] == deck["version"] + 1
    reused = edit(owner, deck, key=key, name="Something else")
    assert reused.status_code == 409 and code(reused) == "IDEMPOTENCY_KEY_REUSED"
    # A later change doesn't alter what the first key replays.
    assert edit(owner, first.json()["location"], name="Later").status_code == 200
    assert edit(owner, deck, key=key, name="Replay Deck").json() == first.json()
    # One key never crosses between the Deck command and the Location edit, in either direction.
    folder = make(owner, "Folder").json()["location"]
    across = call("PATCH", f"/api/location-tree/{deck['id']}", owner,
                  {"name": "Replay Deck", "version": deck["version"], "idempotency_key": str(key)})
    assert across.status_code == 409 and code(across) == "IDEMPOTENCY_KEY_REUSED"
    location_key = uuid4()
    assert change(owner, folder, name="Folder 2", idempotency_key=str(location_key)).status_code == 200
    back = call("PATCH", f"/api/decks/{folder['id']}", owner,
                {"name": "Folder 2", "version": folder["version"], "idempotency_key": str(location_key)})
    assert back.status_code == 409 and code(back) == "IDEMPOTENCY_KEY_REUSED"
    assert node(owner, deck["id"])["name"] == "Later"


def test_a_top_level_deck_named_unsorted_is_not_the_protected_default_leaf():
    # The Location rule protects the owner's default top-level Unsorted leaf when it holds cards.
    stocked, root, edition = stocked_owner()
    refused = change(stocked, root, name="Archive")
    assert refused.status_code == 409 and code(refused) == "LOCATION_NOT_EMPTY"
    shelf = make(stocked, "Shelf").json()["location"]
    clash = change(stocked, shelf, name="Unsorted")
    assert clash.status_code == 409 and code(clash) == "LOCATION_NAME_CONFLICT"

    # Once the default leaf has been renamed away, a Deck may take the name and is not covered by the rule.
    owner = str(uuid4())
    default = tree(owner)[0]
    assert change(owner, default, name="Old default").status_code == 200
    deck = new_deck(owner)
    renamed = edit(owner, deck, name="Unsorted")
    assert renamed.status_code == 200, renamed.text
    deck = renamed.json()["location"]
    assert deck["name"] == "Unsorted" and deck["parent_id"] is None and deck["kind"] == "deck"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,2,1)", (owner, deck["id"], edition))
    shelf = make(owner, "Shelf").json()["location"]
    moved = edit(owner, deck, name="Mew Deck", **into(shelf))
    assert moved.status_code == 200, moved.text
    assert moved.json()["location"]["name"] == "Mew Deck" and moved.json()["location"]["kind"] == "deck"
    assert holdings(owner) == [{"location_id": deck["id"], "quantity": 2}]
