"""Batch add (#175, spec "Batch add and Gather Undo") at the signed HTTP seam: POST /api/holdings/batch adds up to 200
Card Editions to one Location in one transaction with one owner revision, replays by key, and writes one Inventory
Undo record of the `add` kind. Undoing it takes exactly those copies out again, or answers UNDO_INCOMPATIBLE once one
has moved. The newest-only rule and the five-record limit are unchanged."""
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

from test_deck_list_moves import deck_list
from test_decks import create
from test_holdings import add, call, fixture
from test_moves import commit, edition_like, leaf, selected, stage, start


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def batch(owner, location, items, key=None):
    return call("POST", "/api/holdings/batch", owner, {
        "location_id": location, "idempotency_key": str(key or uuid4()),
        "items": [{"edition_id": edition, "quantity": quantity} for edition, quantity in items]})


def held(owner, location):
    """Every Holding in a Location, as {edition_id: quantity}."""
    holdings = ok(call("GET", f"/api/holdings/{location}", owner))["holdings"]
    return {holding["edition_id"]: holding["quantity"] for holding in holdings}


def revision(owner):
    return ok(call("GET", "/api/collection/revision", owner))["owner_revision"]


def undo_records(owner):
    return ok(call("GET", "/api/moves/undo", owner))


def undo(owner, undo_id, key=None):
    return call("POST", f"/api/moves/undo/{undo_id}", owner, {"idempotency_key": str(key or uuid4())})


def editions(edition, generation, count):
    return [edition] + [edition_like(edition, generation) for _ in range(count - 1)]


def move_one(owner, source, edition, destination):
    """One Collection Move of one copy, which writes one Undo record."""
    version = next(holding["version"] for holding in ok(call("GET", f"/api/holdings/{source}", owner))["holdings"]
                   if holding["edition_id"] == edition)
    manifest = start(owner, source)
    assert stage(owner, manifest, [selected(edition, 1, version)]).status_code == 200
    return ok(commit(owner, manifest, destination))


def test_a_batch_adds_every_edition_to_one_location_in_one_revision_and_replays_by_key():
    owner, other, unsorted, _, edition, generation = fixture()
    first, second, third = editions(edition, generation, 3)
    ok(add(owner, unsorted, first, "1"))
    before = revision(owner)
    key = uuid4()
    result = ok(batch(owner, unsorted, [(first, "2"), (second, "1"), (third, "5")], key))
    assert {name: value for name, value in result.items() if name != "undo_id"} == {
        "location_id": unsorted, "edition_count": 3, "copy_count": "8", "owner_revision": before + 1}
    assert revision(owner) == before + 1
    assert held(owner, unsorted) == {first: "3", second: "1", third: "5"}
    # The same key and items, in another order, replay the result and change nothing.
    assert ok(batch(owner, unsorted, [(third, "5"), (first, "2"), (second, "1")], key)) == result
    assert revision(owner) == before + 1 and held(owner, unsorted) == {first: "3", second: "1", third: "5"}
    reused = batch(owner, unsorted, [(first, "3"), (second, "1"), (third, "5")], key)
    assert reused.status_code == 409 and reused.json()["detail"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    # Two identical requests at once apply once and answer alike.
    again = uuid4()
    with ThreadPoolExecutor(max_workers=2) as pool:
        answers = list(pool.map(lambda _: batch(owner, unsorted, [(second, "4")], again), range(2)))
    assert [answer.status_code for answer in answers] == [200, 200]
    assert answers[0].json() == answers[1].json()
    assert held(owner, unsorted)[second] == "5" and revision(owner) == before + 2
    # Up to 200 Card Editions in one batch; another collector's view is untouched.
    many = editions(edition, generation, 200)
    big = ok(batch(owner, leaf(owner, "Bulk box"), [(item, "1") for item in many]))
    assert (big["edition_count"], big["copy_count"], big["owner_revision"]) == (200, "200", before + 3)
    assert call("GET", f"/api/holdings/{unsorted}", other).status_code == 404


def test_a_batch_is_all_or_nothing_and_names_the_card_edition_it_refuses():
    owner, other, unsorted, other_leaf, edition, generation = fixture()
    first, second = editions(edition, generation, 2)
    ok(add(owner, unsorted, second, str(2**63 - 2)))
    before = (revision(owner), held(owner, unsorted), undo_records(owner))

    def refused(response, status, code, **detail):
        assert response.status_code == status, response.text
        assert response.json()["detail"] == {"code": code, **detail}
        assert (revision(owner), held(owner, unsorted), undo_records(owner)) == before

    refused(batch(owner, unsorted, [(first, "1"), (second, "2")]), 422, "QUANTITY_OVERFLOW", edition_id=second)
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("UPDATE catalog_generation_edition SET active=false WHERE generation_id=%s AND edition_id=%s",
                     (generation, first))
    refused(batch(owner, unsorted, [(first, "1")]), 422, "EDITION_UNAVAILABLE", edition_id=first)
    unknown = str(uuid4())
    refused(batch(owner, unsorted, [(second, "1"), (unknown, "1")]), 422, "EDITION_UNAVAILABLE", edition_id=unknown)
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("UPDATE catalog_generation_edition SET active=true WHERE generation_id=%s AND edition_id=%s",
                     (generation, first))
    refused(batch(owner, unsorted, [(first, "1"), (first, "2")]), 422, "DUPLICATE_ADD_ITEM")
    refused(batch(owner, unsorted, [(first, "0")]), 422, "INVALID_QUANTITY")
    refused(batch(owner, other_leaf, [(first, "1")]), 404, "LOCATION_NOT_FOUND")
    refused(batch(owner, str(uuid4()), [(first, "1")]), 404, "LOCATION_NOT_FOUND")
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        folder = str(conn.execute("""INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Shelf','organization')
          RETURNING id""", (uuid4(), owner)).fetchone()[0])
    refused(batch(owner, folder, [(first, "1")]), 404, "LOCATION_NOT_FOUND")
    for size in (0, 201):
        response = batch(owner, unsorted, [(str(uuid4()), "1") for _ in range(size)])
        assert response.status_code == 422, response.text
    assert (revision(owner), held(owner, unsorted), undo_records(owner)) == before
    # The collector the Location belongs to can still add there.
    assert ok(batch(other, other_leaf, [(first, "1")]))["copy_count"] == "1"


def test_one_undo_takes_exactly_the_added_copies_out_and_keeps_collections_earlier_records():
    owner, _, unsorted, _, edition, generation = fixture()
    first, second, loose = editions(edition, generation, 3)
    ok(add(owner, unsorted, first, "1"))
    # Four earlier Moves in Collection, each with its own Undo record.
    shelves = [leaf(owner, f"Shelf {number}") for number in range(4)]
    ok(add(owner, unsorted, loose, "5"))
    for shelf in shelves:
        move_one(owner, unsorted, loose, shelf)
    earlier = undo_records(owner)
    assert [entry["destination_id"] for entry in earlier] == shelves[::-1]
    binder = leaf(owner, "Binder")
    ok(add(owner, binder, first, "1"))
    result = ok(batch(owner, binder, [(first, "2"), (second, "3")]))
    # The batch is one record on top, of the `add` kind: its Location and no source.
    entries = undo_records(owner)
    assert [(entry["id"], entry["action"], entry["source_id"], entry["destination_id"], entry["source_count"])
            for entry in entries[:1]] == [(result["undo_id"], "add", None, binder, 0)]
    assert entries[1:] == earlier
    before = revision(owner)
    key = uuid4()
    undone = ok(undo(owner, result["undo_id"], key))
    assert undone == {"edition_count": 2, "copy_count": "5", "owner_revision": before + 1, "source_count": 0,
                      "already_at_destination_count": "0", "undo_id": None}
    # Exactly the added copies leave: the copy that was there before stays, and nothing went anywhere else.
    assert held(owner, binder) == {first: "1"}
    assert held(owner, unsorted) == {first: "1", loose: "1"}
    assert ok(undo(owner, result["undo_id"], key)) == undone
    assert undo_records(owner) == earlier
    ok(undo(owner, earlier[0]["id"]))
    assert held(owner, shelves[-1]) == {} and held(owner, unsorted)[loose] == "2"
    # The five-record limit still holds: a batch is one record, and the oldest goes when a sixth arrives.
    for _ in range(2):
        ok(batch(owner, binder, [(second, "1")]))
    move_one(owner, unsorted, loose, shelves[0])
    actions = [entry["action"] for entry in undo_records(owner)]
    assert actions == ["move", "add", "add", "move", "move"]


def test_undoing_a_batch_is_newest_only_and_incompatible_once_one_of_its_copies_has_moved():
    owner, _, unsorted, _, edition, generation = fixture()
    first, second = editions(edition, generation, 2)
    shelf = leaf(owner, "Shelf")
    result = ok(batch(owner, unsorted, [(first, "2"), (second, "1")]))
    moved = move_one(owner, unsorted, first, shelf)
    not_newest = undo(owner, result["undo_id"])
    assert not_newest.status_code == 409 and not_newest.json()["detail"]["code"] == "UNDO_NOT_NEWEST"
    # With the Move's record dismissed, the batch is the newest again, but one of its copies has left its Location.
    assert call("DELETE", f"/api/moves/undo/{moved['undo_id']}", owner).status_code == 204
    before = (revision(owner), held(owner, unsorted), held(owner, shelf))
    incompatible = undo(owner, result["undo_id"])
    assert incompatible.status_code == 409, incompatible.text
    assert incompatible.json()["detail"] == {"code": "UNDO_INCOMPATIBLE", "destination_id": unsorted,
                                             "edition_id": first}
    assert (revision(owner), held(owner, unsorted), held(owner, shelf)) == before
    # The record counts copies, not which ones: with two copies of that Edition there again, Undo takes them out.
    ok(add(owner, unsorted, first, "1"))
    ok(undo(owner, result["undo_id"]))
    assert held(owner, unsorted) == {} and held(owner, shelf) == {first: "1"}


def test_a_batch_into_a_deck_extends_its_deck_list_and_its_undo_keeps_the_lines():
    owner, _, _, _, edition, generation = fixture()
    first, second = editions(edition, generation, 2)
    deck = create(owner).json()["location"]["id"]
    result = ok(batch(owner, deck, [(first, "2"), (second, "1")]))
    assert held(owner, deck) == {first: "2", second: "1"}
    # The copies extend the Deck List (migration 031's trigger).
    _, lines = deck_list(owner, deck)
    assert lines[first] == ("2", "2") and lines[second] == ("1", "1")
    before = (deck_list(owner, deck)[0], {name: line[0] for name, line in lines.items()})
    ok(undo(owner, result["undo_id"]))
    # Undo takes the copies out of the Deck but keeps its Deck List lines, as after any Move out of a Deck.
    assert held(owner, deck) == {}
    revision_after, after = deck_list(owner, deck)
    assert (revision_after, {name: line[0] for name, line in after.items()}) == before
    assert {name: line[1] for name, line in after.items()} == {first: "0", second: "0"}
