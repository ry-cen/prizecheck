"""Scanner save (#311; plumbing D11, D12): POST /api/scanner/save at the signed HTTP seam, in the structure of
test_batch_add.py. One Storage Leaf, one owner revision, a 30-day receipt, no undo record, and refusals in the
resolution's order with nothing written."""
import json
import os
from uuid import uuid4

import psycopg

import app.main  # noqa: F401  (registers the app)
from app.games.pokemon.scanner import scanner_save
from test_batch_add import editions, held, ok, revision, undo_records
from test_decks import create
from test_holdings import add, call, client, fixture
from test_moves import leaf

def save(owner, location, items, key=None):
    return call("POST", "/api/scanner/save", owner, {
        "location_id": location, "idempotency_key": str(key or uuid4()),
        "items": [{"edition_id": edition, "quantity": quantity} for edition, quantity in items]})


def refused(response, status, code, **detail):
    assert response.status_code == status, response.text
    assert response.json()["detail"] == {"code": code, **detail}


def counts(owner):
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        return {table: conn.execute(f"SELECT count(*) FROM {table} WHERE {column} = %s",
                                    (owner,)).fetchone()[0]
                for table, column in (("holding", "owner_id"), ("mutation_request", "owner_id"),
                                      ("move_response", "owner_id"), ("inventory_undo", "owner_id"),
                                      ("collection_import", "owner_id"))} | {
            "catalog_run": conn.execute("SELECT count(*) FROM catalog_run").fetchone()[0]}


def test_a_save_adds_every_edition_in_one_revision_writes_a_30_day_receipt_and_replays_by_key():
    owner, other, unsorted, _, edition, generation = fixture()
    first, second, third = editions(edition, generation, 3)
    ok(add(owner, unsorted, first, "1"))
    before, rows = revision(owner), counts(owner)
    key = uuid4()
    result = ok(save(owner, unsorted, [(first, "2"), (second, "1"), (third, "5")], key))
    assert result == {"location_id": unsorted, "edition_count": 3, "copy_count": "8", "owner_revision": before + 1}
    assert revision(owner) == before + 1
    assert held(owner, unsorted) == {first: "3", second: "1", third: "5"}
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        days = conn.execute("""SELECT extract(epoch FROM expires_at-now())/86400 FROM mutation_request
          WHERE owner_id=%s AND request_key=%s""", (owner, key)).fetchone()[0]
        response = conn.execute("""SELECT edition_count,copy_count,source_count,already_at_destination_count
          FROM move_response WHERE owner_id=%s AND request_key=%s""", (owner, key)).fetchone()
    assert 29.9 < days <= 30 and response == (3, 8, 0, 0)
    # Only the four tables change: no undo record and no import draft.
    after = counts(owner)
    assert after["inventory_undo"] == rows["inventory_undo"] and after["collection_import"] == 0
    assert (after["mutation_request"], after["move_response"]) == (rows["mutation_request"] + 1, rows["move_response"] + 1)
    assert undo_records(owner) == []
    # The same key and items, in another order, replay the result and change nothing.
    assert ok(save(owner, unsorted, [(third, "5"), (first, "2"), (second, "1")], key)) == result
    assert revision(owner) == before + 1 and held(owner, unsorted) == {first: "3", second: "1", third: "5"}
    refused(save(owner, unsorted, [(first, "3"), (second, "1"), (third, "5")], key), 409, "IDEMPOTENCY_KEY_REUSED")
    # A key used by batch add answers IDEMPOTENCY_KEY_REUSED here, even with the same items.
    batched = uuid4()
    ok(call("POST", "/api/holdings/batch", owner, {"location_id": unsorted, "idempotency_key": str(batched),
                                                   "items": [{"edition_id": second, "quantity": "1"}]}))
    refused(save(owner, unsorted, [(second, "1")], batched), 409, "IDEMPOTENCY_KEY_REUSED")
    assert call("GET", f"/api/holdings/{unsorted}", other).status_code == 404


def test_a_receipt_without_a_stored_outcome_answers_replay_outcome_unavailable():
    owner, _, unsorted, _, edition, _ = fixture()
    key = uuid4()
    ok(save(owner, unsorted, [(edition, "1")], key))
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("DELETE FROM move_response WHERE owner_id=%s AND request_key=%s", (owner, key))
    refused(save(owner, unsorted, [(edition, "1")], key), 409, "REPLAY_OUTCOME_UNAVAILABLE")


def test_an_expired_receipt_is_purged_and_the_key_runs_again():
    owner, _, unsorted, _, edition, _ = fixture()
    key = uuid4()
    ok(save(owner, unsorted, [(edition, "1")], key))
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("UPDATE mutation_request SET expires_at=now()-interval '1 second' WHERE owner_id=%s", (owner,))
    ok(save(owner, unsorted, [(edition, "1")], key))
    assert held(owner, unsorted) == {edition: "2"}


def test_a_destination_that_is_not_the_owners_childless_storage_leaf_answers_destination_changed():
    owner, _, unsorted, other_leaf, edition, _ = fixture()
    deck = create(owner).json()["location"]["id"]
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        folder = str(conn.execute("""INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Shelf','organization')
          RETURNING id""", (uuid4(), owner)).fetchone()[0])
        gone = leaf(owner, "Gone")
        conn.execute("DELETE FROM location WHERE id=%s", (gone,))
        parent = leaf(owner, "Parent")
        conn.execute("INSERT INTO location(id,owner_id,name,kind,parent_id) VALUES (%s,%s,'Child','storage_leaf',%s)",
                     (uuid4(), owner, parent))
    before = (revision(owner), counts(owner))
    for destination in (gone, str(uuid4()), other_leaf, deck, folder, parent):
        refused(save(owner, destination, [(edition, "1")]), 409, "DESTINATION_CHANGED", location_id=destination)
    assert (revision(owner), counts(owner)) == before


def test_editions_changed_lists_every_inactive_or_tombstoned_edition_and_destination_wins():
    owner, _, unsorted, other_leaf, edition, generation = fixture()
    first, second, third, fine = editions(edition, generation, 4)
    unknown = str(uuid4())
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("UPDATE catalog_generation_edition SET active=false WHERE generation_id=%s AND edition_id=%s",
                     (generation, first))
        printing = conn.execute("SELECT printing_id FROM catalog_edition WHERE id=%s", (third,)).fetchone()[0]
        printings = {name: str(conn.execute("SELECT printing_id FROM catalog_edition WHERE id=%s", (name,)).fetchone()[0])
                     for name in (first, second, third)}
        # A new Printing, tombstoned, with an active Edition: the Edition is unavailable with it.
        identity = conn.execute("SELECT identity_id FROM catalog_printing WHERE id=%s", (printing,)).fetchone()[0]
        dead = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',%s,%s) RETURNING id",
                            (str(uuid4()), identity)).fetchone()[0]
        conn.execute("""INSERT INTO catalog_generation_printing
          (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,
           source_fingerprint,basic_energy,tombstoned)
          SELECT generation_id,%s,%s,set_id,set_name,'98',display_name,search_name,source_fingerprint,basic_energy,true
          FROM catalog_generation_printing WHERE generation_id=%s AND printing_id=%s""",
                     (dead, str(uuid4()), generation, printing))
        tombstoned = str(conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          VALUES (%s,'unspecified',%s) RETURNING id""", (dead, json.dumps({"label": "Unspecified Variant"}))).fetchone()[0])
        conn.execute("INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s)",
                     (generation, tombstoned, dead))
    before = (revision(owner), held(owner, unsorted), counts(owner))
    expected = sorted(
        [{"edition_id": first, "printing_id": printings[first]}, {"edition_id": tombstoned, "printing_id": str(dead)},
         {"edition_id": unknown, "printing_id": None}], key=lambda row: row["edition_id"])
    response = save(owner, unsorted, [(fine, "1"), (unknown, "1"), (tombstoned, "1"), (first, "1")])
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {"code": "EDITIONS_CHANGED", "editions": expected}
    # Destination wins when both apply.
    refused(save(owner, other_leaf, [(first, "1")]), 409, "DESTINATION_CHANGED", location_id=other_leaf)
    assert (revision(owner), held(owner, unsorted), counts(owner)) == before
    # With the Editions active again, the save goes through.
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("UPDATE catalog_generation_edition SET active=true WHERE generation_id=%s AND edition_id=%s",
                     (generation, first))
    assert ok(save(owner, unsorted, [(fine, "1"), (first, "1")]))["copy_count"] == "2"


def test_a_malformed_request_a_duplicate_edition_and_an_overflow_write_nothing():
    owner, _, unsorted, _, edition, generation = fixture()
    first, second = editions(edition, generation, 2)
    ok(add(owner, unsorted, second, str(2**63 - 2)))
    before = (revision(owner), held(owner, unsorted), counts(owner))
    refused(save(owner, unsorted, [(first, "1"), (first, "2")]), 422, "DUPLICATE_ADD_ITEM")
    refused(save(owner, unsorted, [(first, "1"), (second, "2")]), 422, "QUANTITY_OVERFLOW", edition_id=second)
    for quantity in ("0", "10000", "01", "-1", "1.5", "", " 1"):
        assert save(owner, unsorted, [(first, quantity)]).status_code == 422, quantity
    for size in (0, 201):
        assert save(owner, unsorted, [(str(uuid4()), "1") for _ in range(size)]).status_code == 422
    assert call("POST", "/api/scanner/save", owner, {"location_id": unsorted}).status_code == 422
    assert (revision(owner), held(owner, unsorted), counts(owner)) == before


def test_200_editions_at_the_largest_quantity_fit_the_gateway_body_limit_and_save():
    owner, _, unsorted, _, edition, generation = fixture()
    many = editions(edition, generation, 200)
    items = [(item, "9999") for item in many]
    body = json.dumps({"location_id": unsorted, "idempotency_key": str(uuid4()),
                       "items": [{"edition_id": item, "quantity": quantity} for item, quantity in items]},
                      separators=(",", ":")).encode()
    assert len(body) <= 16384
    result = ok(save(owner, unsorted, items))
    assert (result["edition_count"], result["copy_count"]) == (200, str(200 * 9999))


def test_a_database_error_answers_503_with_nothing_written_and_the_retry_with_the_key_runs(monkeypatch):
    owner, _, unsorted, _, edition, _ = fixture()
    key = uuid4()
    before = (revision(owner), counts(owner))
    real = scanner_save.lock_owner

    def failing(conn, user_id):
        raise psycopg.errors.OperationalError("connection lost")

    monkeypatch.setattr(scanner_save, "lock_owner", failing)
    refused(save(owner, unsorted, [(edition, "1")], key), 503, "INVENTORY_TEMPORARILY_UNAVAILABLE")
    monkeypatch.setattr(scanner_save, "lock_owner", real)
    assert (revision(owner), counts(owner)) == before
    assert ok(save(owner, unsorted, [(edition, "1")], key))["owner_revision"] == before[0] + 1


def test_a_signed_out_request_is_refused():
    owner, _, unsorted, _, edition, _ = fixture()
    payload = {"location_id": unsorted, "idempotency_key": str(uuid4()), "items": [{"edition_id": edition, "quantity": "1"}]}
    assert client.post("/api/scanner/save", json=payload).status_code in (401, 403)
