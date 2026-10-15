"""Collection Import's groups, landing Location and copies already held (#232; spec "The API": the summary's groups
and "already in your Collection" count, and the `{ group, include }` and `{ location_id }` changes).

A file's groups (Collectr portfolios, PriceCharting folders, Sorted lists) are listed in file order with the rows of
each that weren't left out, all included. Leaving one out drops its rows from every count, filter, download, change
and the save; bringing it back brings each row back as it was. Groups never become Locations. The landing Location
changes to any of the collector's Storage Leaves, as the start route allows. Rows and the summary count the copies of
each row's Card Edition already in the Collection, every Location and Deck.

GROUPS is a reconstructed Collectr export (test_collection_import's seed_import_catalog): Main (Starmie 2, Wartortle),
For Trade (Poké Ball 3) and Sold (Wigglytuff; Flying Pikachu, whose set the catalog lacks; a One Piece card, left out),
and a watchlist row with no group.
"""
import csv
import io
from uuid import uuid4

from app.main import connect  # first: app.main imports the routers, and they import it
from test_batch_add import held
from test_collection_import import all_rows, code, collector, edition, save, seed_import_catalog, started
from test_collection_import_finishes import change, changed, counts
from test_decks import create
from test_holdings import add, call

HEADER = ("Portfolio Name,Category,Set,Product Name,Card Number,Rarity,Variance,Grade,Card Condition,Average Cost Paid,"
          "Quantity,Market Price (As of 2026-09-14),Price Override,Watchlist,Date Added,Notes")
LINES = [
    "Main,Pokemon,Base Set,Starmie,064/102,Common,Normal,Ungraded,Near Mint,0,2,0.52,0,false,2026-03-01,",
    "Main,Pokemon,Base Set,Wartortle,042/102,Uncommon,Normal,Ungraded,Near Mint,0,1,3.10,0,false,2026-03-01,",
    "For Trade,Pokemon,Jungle,Poké Ball,064/064,Common,Normal,Ungraded,Near Mint,0,3,0.20,0,false,2026-03-02,",
    "Sold,Pokemon,Jungle,Wigglytuff,032/064,Rare,Holofoil,Ungraded,Near Mint,0,1,0.90,0,false,2026-03-03,",
    "Sold,Pokemon,Rising Rivals,Flying Pikachu,113/111,Secret Rare,Holofoil,Ungraded,Near Mint,0,1,120.00,0,false,"
    "2026-03-03,",
    "Sold,One Piece,Romance Dawn,Roronoa Zoro,OP01-025,SR,Normal,Ungraded,Near Mint,0,1,9.99,0,false,2026-03-03,",
    ",Pokemon,Base Set,Starmie,064/102,Common,Normal,Ungraded,Near Mint,,,0.52,0,true,2026-03-04,",
]
GROUPS = ("\n".join([HEADER, *LINES]) + "\n").encode()


def groups(summary):
    return [(group["name"], group["rows"], group["included"]) for group in summary["groups"]]


def csv_rows(owner, import_id, name):
    response = call("GET", f"/api/collection-imports/{import_id}/{name}", owner)
    assert response.status_code == 200, response.text
    return list(csv.reader(io.StringIO(response.content.decode("utf-8")[1:])))


def leaf(owner, name, parent=None, kind="storage_leaf"):
    with connect() as conn:
        return str(conn.execute("""INSERT INTO location(id,owner_id,parent_id,name,kind) VALUES (%s,%s,%s,%s,%s)
          RETURNING id""", (uuid4(), owner, parent, name, kind)).fetchone()["id"])


def location_names(owner):
    with connect() as conn:
        return sorted(row["name"] for row in conn.execute("SELECT name FROM location WHERE owner_id=%s", (owner,)))


def test_a_group_left_out_drops_out_of_every_count_list_download_and_the_save_and_comes_back_as_it_was():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, GROUPS)
    import_id = summary["id"]
    assert groups(summary) == [("Main", 2, True), ("For Trade", 1, True), ("Sold", 2, True)]
    assert summary["counts"] == counts(rows=7, needs_you=1, ready=4)
    assert summary["cards_to_add"] == "7"
    assert [(entry["reason"], entry["rows"]) for entry in summary["left_out"]] == [("watchlist", 1), ("other_game", 1)]
    assert [(row["row_number"], row["group"]) for row in all_rows(owner, import_id)] == [
        (1, "Main"), (2, "Main"), (3, "For Trade"), (4, "Sold"), (5, "Sold")]
    changed(owner, import_id, 1, {"rows": [4], "skip": True})

    # Leaving Sold out: its rows (one needing the collector, one skipped, one left out) drop out of everything.
    result = changed(owner, import_id, 2, {"group": "Sold", "include": False})
    assert result["results"] == [{"applied": 2, "not_applied": []}]
    after = result["summary"]
    assert after["draft_revision"] == 3
    assert groups(after) == [("Main", 2, True), ("For Trade", 1, True), ("Sold", 2, False)]
    assert after["counts"] == counts(rows=7, ready=3)
    assert after["cards_to_add"] == "6"
    assert [(entry["reason"], entry["rows"]) for entry in after["left_out"]] == [("watchlist", 1)]
    for filter_, expected in (("all", [1, 2, 3]), ("needs", []), ("skipped", []), ("finish", []), ("name", [])):
        assert [row["row_number"] for row in all_rows(owner, import_id, filter_)] == expected, filter_
    assert csv_rows(owner, import_id, "skipped.csv") == [HEADER.split(",")]
    assert csv_rows(owner, import_id, "left-out.csv") == [HEADER.split(","), next(csv.reader([LINES[6]]))]
    # No change reaches its rows, by number or by filter; leaving it out again changes nothing.
    result = changed(owner, import_id, 3, {"rows": [4, 5], "restore": True}, {"rows": [1, 5], "skip": True},
                     {"rows": [5], "pick": {"printing_id": all_rows(owner, import_id)[0]["card"]["printing_id"]}},
                     {"filter": "all", "restore": True}, {"group": "Sold", "include": False})
    assert result["results"] == [{"applied": 0, "not_applied": [4, 5]}, {"applied": 1, "not_applied": [5]},
                                 {"applied": 0, "not_applied": [5]}, {"applied": 0, "not_applied": [2, 3]},
                                 {"applied": 0, "not_applied": []}]
    assert result["summary"]["counts"] == counts(rows=7, ready=2, skipped=1)
    # A group the file doesn't have is refused, and nothing changes.
    for name in ("Binder", "sold", "Sold "):
        response = change(owner, import_id, 4, {"group": name, "include": False})
        assert response.status_code == 422 and code(response) == "GROUP_NOT_FOUND", response.text
    assert call("GET", "/api/collection-imports/current", owner).json()["draft_revision"] == 4

    # Bringing Sold back brings each row back as it was: row 4 still skipped, row 5 still needing the collector.
    result = changed(owner, import_id, 4, {"group": "Sold", "include": True}, {"rows": [1], "restore": True})
    assert result["results"][0] == {"applied": 2, "not_applied": []}
    assert groups(result["summary"]) == [("Main", 2, True), ("For Trade", 1, True), ("Sold", 2, True)]
    assert result["summary"]["counts"] == counts(rows=7, needs_you=1, ready=3, skipped=1)
    assert [(entry["reason"], entry["rows"]) for entry in result["summary"]["left_out"]] == [
        ("watchlist", 1), ("other_game", 1)]
    assert [row["row_number"] for row in all_rows(owner, import_id, "needs")] == [5]
    assert [row["row_number"] for row in all_rows(owner, import_id, "skipped")] == [4]

    # The save leaves Sold out, and every included copy lands in Unsorted: no group becomes a Location.
    before = location_names(owner)
    changed(owner, import_id, 5, {"group": "Sold", "include": False})
    response = save(owner, import_id, draft_revision=6)
    assert response.status_code == 200 and response.json()["copy_count"] == "6", response.text
    assert held(owner, unsorted) == {edition("base1-64", "normal"): "2", edition("base1-42", "normal"): "1",
                                     edition("base2-64", "normal"): "3"}
    assert location_names(owner) == before == ["Unsorted"]


def test_the_landing_location_changes_to_another_storage_leaf_and_the_save_lands_there():
    seed_import_catalog()
    owner, unsorted = collector()
    other, other_unsorted = collector()
    binder = leaf(owner, "Binder")
    shelf = leaf(owner, "Shelf", kind="organization")
    leaf(owner, "Box", parent=shelf)
    deck = create(owner, "Water Deck")
    assert deck.status_code == 201, deck.text
    summary = started(owner, unsorted, GROUPS)
    import_id = summary["id"]
    result = changed(owner, import_id, 1, {"location_id": binder})
    assert result["results"] == [{"applied": 0, "not_applied": []}]
    assert result["summary"]["location_id"] == binder and result["summary"]["location_name"] == "Binder"
    assert result["summary"]["draft_revision"] == 2
    # Anything but this collector's Storage Leaf is refused, as at the start, and the draft keeps its Location.
    for refused in (shelf, deck.json()["location"]["id"], other_unsorted, str(uuid4())):
        response = change(owner, import_id, 2, {"location_id": refused})
        assert response.status_code == 422 and code(response) == "NOT_STORAGE_LEAF", response.text
    current = call("GET", "/api/collection-imports/current", owner).json()
    assert current["location_id"] == binder and current["draft_revision"] == 2
    # A Location change and a group change in one request.
    result = changed(owner, import_id, 2, {"location_id": unsorted}, {"group": "Sold", "include": False},
                     {"location_id": binder})
    assert result["summary"]["location_id"] == binder
    assert result["summary"]["counts"] == counts(rows=7, ready=3)
    response = save(owner, import_id, draft_revision=3)
    assert response.status_code == 200, response.text
    assert response.json()["location_id"] == binder and response.json()["copy_count"] == "6"
    assert held(owner, binder) == {edition("base1-64", "normal"): "2", edition("base1-42", "normal"): "1",
                                   edition("base2-64", "normal"): "3"}
    assert held(owner, unsorted) == {}
    # A Location that stops being a Storage Leaf after the change still refuses the save (#226's REVIEW_CHANGED).
    spare = leaf(owner, "Spare")
    summary = started(owner, unsorted, GROUPS)
    changed(owner, summary["id"], 1, {"location_id": spare}, {"group": "Sold", "include": False})
    with connect() as conn:
        conn.execute("UPDATE location SET kind='organization' WHERE id=%s", (spare,))
    leaf(owner, "Pocket", parent=spare)
    response = save(owner, summary["id"], draft_revision=2)
    assert response.status_code == 409 and code(response) == "REVIEW_CHANGED", response.text


def test_rows_and_the_summary_count_copies_already_held_across_the_collection():
    seed_import_catalog()
    owner, unsorted = collector()
    binder = leaf(owner, "Binder")
    deck = create(owner, "Water Deck").json()["location"]["id"]
    starmie = edition("base1-64", "normal")
    for location, quantity in ((unsorted, "2"), (binder, "1"), (deck, "4")):
        response = add(owner, location, starmie, quantity)
        assert response.status_code == 200, response.text
    summary = started(owner, unsorted, GROUPS)
    import_id = summary["id"]
    # Starmie's 2 incoming copies are of a Card Edition already held (7 copies, in two Locations and a Deck).
    assert summary["already_held"] == "2"
    assert [(row["row_number"], row["held"]) for row in all_rows(owner, import_id)] == [
        (1, "7"), (2, "0"), (3, "0"), (4, "0"), (5, "0")]
    # It follows the rows that would be added: a skipped row or a group left out isn't added.
    assert changed(owner, import_id, 1, {"rows": [1], "skip": True})["summary"]["already_held"] == "0"
    assert changed(owner, import_id, 2, {"rows": [1], "restore": True})["summary"]["already_held"] == "2"
    assert changed(owner, import_id, 3, {"group": "Main", "include": False})["summary"]["already_held"] == "0"
    after = changed(owner, import_id, 4, {"group": "Main", "include": True}, {"group": "Sold", "include": False})
    assert after["summary"]["already_held"] == "2"
    assert save(owner, import_id, draft_revision=5).status_code == 200
    # A second import of the same file now finds every saved card held.
    summary = started(owner, unsorted, GROUPS)
    assert summary["already_held"] == "6"
    assert [row["held"] for row in all_rows(owner, summary["id"])] == ["9", "1", "3", "0", "0"]
