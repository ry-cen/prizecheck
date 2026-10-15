"""Collection Import (#226): the TCGplayer app export read, matched by set name and number, stored as an import draft,
paged, and saved into one Storage Leaf in one step, against PostgreSQL and signed HTTP requests posted straight to the
API (the gateway's body limit is a separate follow-up).

The fixtures in collection_import_fixtures/ are reconstructions, not the research export: the TCGplayer app's 12- and
14-column headers with this file's catalog seed (seed_import_catalog), CRLF line endings in the 12-column file, quoted
cells with commas and doubled quotes, an accented name and a blank quantity.
"""
import ast
import hashlib
import hmac
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest

from app.main import connect  # first: app.main imports the routers, and they import it
from app import catalog_dispatch, price_launcher, price_refresh, prices, public_records  # noqa: E402
from test_batch_add import batch, held, revision, undo_records
from test_card_attributes import card
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_decks import create
from test_holdings import add, call, client

FIXTURES = Path(__file__).parent / "collection_import_fixtures"
FOURTEEN = (FIXTURES / "tcgplayer-app-14.csv").read_bytes()
TWELVE = (FIXTURES / "tcgplayer-app-12-crlf.csv").read_bytes()
HEADER_12 = TWELVE.split(b"\r\n", 1)[0]
STARMIE_ROW = b"1,Starmie,Starmie,Base Set,064/102,BS,Normal,Near Mint,English,Common,900003,800003\n"
UNREADABLE_MESSAGE = ("PrizeCheck can't read this file. It reads CSV exports from the TCGplayer app, Collectr, "
                      "PriceCharting, TCG Collector, Dragon Shield and Sorted, and CSV files with columns for each "
                      "card's set and its number or name.")


def _card(source_id, name, number, set_id, set_name, variants=None, **extra):
    record = card(id=source_id, name=name, localId=number, set={"id": set_id, "name": set_name}, rarity="Common",
                  **extra)
    return {**record, "variants": variants} if variants else record


def _detailed(*variants):
    """TCGdex variants_detailed entries, standard size unless a variant says otherwise."""
    return [{"size": "standard", **variant} for variant in variants]


# A TCGdex marketplace lookup ID kept in one Edition's descriptor: no response may carry it (#230).
LOOKUP_ID = 7770001


def seed_import_catalog(*extra):
    """Browser fixture too (web/tests/collection-import*.spec.ts). Fifteen Printings through the importer, and any
    `extra` TCGdex-shaped records in the same import (test_collection_import_matching's sets):

    - Base Set: Wartortle 42, Starmie 64, Psychic Energy 101 and Water Energy 102, one Normal Edition each;
    - Jungle: Wigglytuff 32 (Holo only), Weepinbell 48 (Normal and the Unspecified Variant: first edition) and
      Poké Ball 64 (Normal);
    - Team Rocket Returns: Dark Golduck 35 (Normal and Reverse Holo, no Unspecified Variant);
    - two sets both named Fixture Promos, each with a Pikachu 1;
    - Fixture Finishes (#230), described as TCGdex describes them today, so none has an Unspecified Variant:
      Exeggcute 1 (normal, reverse, Poké Ball and Master Ball reverse; its normal one carries LOOKUP_ID), Suicune 2
      (holo, and holo with the 1st Edition stamp), Pineco 3 (normal, reverse, a set-logo stamp and Cosmos reverse),
      Clefairy 4 (unlimited, shadowless, shadowless 1st Edition, and jumbo) and Celebi V 5 (holo only).
    No Rising Rivals set and no Base Set 999."""
    reset_catalog()
    base, jungle, finishes = ("base1", "Base Set"), ("base2", "Jungle"), ("fixturefin", "Fixture Finishes")
    run(Records(
        _card("base1-42", "Wartortle", "42", *base, category="Pokemon", types=["Water"]),
        _card("base1-64", "Starmie", "64", *base, category="Pokemon", types=["Water"]),
        _card("base1-101", "Psychic Energy", "101", *base, category="Energy", energyType="Normal"),
        _card("base1-102", "Water Energy", "102", *base, category="Energy", energyType="Normal"),
        _card("base2-32", "Wigglytuff", "32", *jungle, variants={"holo": True}, category="Pokemon",
              types=["Colorless"]),
        _card("base2-48", "Weepinbell", "48", *jungle, variants={"normal": True, "firstEdition": True},
              category="Pokemon", types=["Grass"]),
        _card("base2-64", "Poké Ball", "64", *jungle, category="Trainer", trainerType="Item"),
        _card("ex7-35", "Dark Golduck", "35", "ex7", "Team Rocket Returns", variants={"normal": True, "reverse": True},
              category="Pokemon", types=["Water"]),
        _card("fixtureimporta-1", "Pikachu", "1", "fixtureimporta", "Fixture Promos", category="Pokemon",
              types=["Lightning"]),
        _card("fixtureimportb-1", "Pikachu", "1", "fixtureimportb", "Fixture Promos", category="Pokemon",
              types=["Lightning"]),
        _card("fixturefin-1", "Exeggcute", "1", *finishes, category="Pokemon", types=["Grass"],
              variants_detailed=_detailed({"type": "normal", "thirdParty": {"tcgplayer": LOOKUP_ID}},
                                          {"type": "reverse"}, {"type": "reverse", "foil": "pokeball"},
                                          {"type": "reverse", "foil": "masterball"})),
        _card("fixturefin-2", "Suicune", "2", *finishes, category="Pokemon", types=["Water"],
              variants_detailed=_detailed({"type": "holo"}, {"type": "holo", "stamp": ["1st-edition"]})),
        _card("fixturefin-3", "Pineco", "3", *finishes, category="Pokemon", types=["Grass"],
              variants_detailed=_detailed({"type": "normal"}, {"type": "reverse"},
                                          {"type": "normal", "stamp": ["set-logo"]},
                                          {"type": "reverse", "foil": "cosmos"})),
        _card("fixturefin-4", "Clefairy", "4", *finishes, category="Pokemon", types=["Colorless"],
              variants_detailed=_detailed({"type": "normal", "subtype": "unlimited"},
                                          {"type": "normal", "subtype": "shadowless"},
                                          {"type": "normal", "subtype": "shadowless", "stamp": ["1st-edition"]},
                                          {"type": "normal", "size": "jumbo"})),
        _card("fixturefin-5", "Celebi V", "5", *finishes, category="Pokemon", types=["Grass"],
              variants_detailed=_detailed({"type": "holo"})),
        *extra,
    ))


def edition(source_id, finish=None):
    """The Edition of this Printing with `finish`, or its Unspecified Variant for None."""
    with connect() as conn:
        found = conn.execute("""SELECT e.id,e.descriptor FROM catalog_edition e
          JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=%s""", (source_id,)).fetchall()
    for row in found:
        descriptor = row["descriptor"]
        if (descriptor.get("finish") == finish) if finish else descriptor.get("label") == "Unspecified Variant":
            return str(row["id"])
    raise AssertionError(f"no {finish or 'unspecified'} Edition of {source_id}: {found}")


def collector():
    """A new collector and their root Unsorted Storage Leaf."""
    owner = f"import-{uuid4()}"
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
        unsorted = conn.execute("""INSERT INTO location(id,owner_id,parent_id,name,kind)
          VALUES (%s,%s,NULL,'Unsorted','storage_leaf') RETURNING id""", (uuid4(), owner)).fetchone()["id"]
    return owner, str(unsorted)


def upload(user, location_id, data: bytes):
    """POST /api/collection-imports with the file's bytes as the body, signed as the gateway signs it."""
    stamp = str(int(time.time()))
    signed = f"POST\n/api/collection-imports\n{hashlib.sha256(data).hexdigest()}\n{user}\n{stamp}".encode()
    headers = {"x-internal-user": user, "x-internal-time": stamp, "content-type": "text/csv",
               "x-internal-signature": hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), signed,
                                                hashlib.sha256).hexdigest()}
    return client.post(f"/api/collection-imports?location_id={location_id}", content=data, headers=headers)


def started(user, location_id, data: bytes):
    response = upload(user, location_id, data)
    assert response.status_code == 201, response.text
    return response.json()


def rows(user, import_id, filter_="all", cursor=None):
    query = f"?filter={filter_}" + (f"&cursor={cursor}" if cursor else "")
    return call("GET", f"/api/collection-imports/{import_id}/rows{query}", user)


def all_rows(user, import_id, filter_="all"):
    found, cursor = [], None
    while True:
        response = rows(user, import_id, filter_, cursor)
        assert response.status_code == 200, response.text
        page = response.json()
        found += page["rows"]
        cursor = page["next_cursor"]
        if cursor is None:
            return found


def save(user, import_id, draft_revision=1, key=None):
    return call("POST", f"/api/collection-imports/{import_id}/save", user,
                {"draft_revision": draft_revision, "idempotency_key": str(key or uuid4())})


def code(response):
    return response.json()["detail"]["code"]


def stored_rows(import_id):
    with connect() as conn:
        return conn.execute("SELECT count(*) AS n FROM collection_import_row WHERE import_id=%s",
                            (import_id,)).fetchone()["n"]


def file_of(count, row=STARMIE_ROW):
    return HEADER_12 + b"\n" + row * count


def sized_file(size):
    """A 12-column file of exactly `size` bytes, all Starmie rows, the last padded by its name."""
    head = HEADER_12 + b"\n"
    count = (size - len(head)) // len(STARMIE_ROW) - 1
    body = head + STARMIE_ROW * count
    template = b"1,%s,Starmie,Base Set,064/102,BS,Normal,Near Mint,English,Common,900003,800003\n"
    pad = size - len(body) - len(template % b"")
    data = body + template % (b"S" * pad)
    assert len(data) == size
    return data


def test_the_fourteen_column_export_matches_by_set_name_and_number():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, FOURTEEN)
    assert summary["draft_revision"] == 1 and summary["location_id"] == unsorted
    assert summary["location_name"] == "Unsorted"
    # #230: Dark Golduck's Reverse Holofoil (row 9) now chooses its Reverse Holo Edition.
    assert summary["counts"] == {"rows": 13, "needs_you": 4, "ready": 9, "finish_unknown": 1, "skipped": 0}
    assert summary["cards_to_add"] == "16"
    found = all_rows(owner, summary["id"])
    assert [row["row_number"] for row in found] == list(range(1, 14))
    status = {row["row_number"]: (row["status"], row["quantity"]) for row in found}
    assert status == {
        1: ("matched", "5"), 2: ("matched", "1"), 3: ("matched", "1"), 4: ("matched", "2"), 5: ("matched", "1"),
        6: ("matched", "1"), 7: ("finish_unknown", "1"), 8: ("matched", "3"), 9: ("matched", "1"),
        10: ("not_found", "1"), 11: ("not_found", "1"), 12: ("ambiguous", "1"), 13: ("unreadable", None)}
    by_number = {row["row_number"]: row for row in found}
    assert by_number[1]["edition"]["edition_id"] == edition("base1-102", "normal")
    assert by_number[1]["card"]["name"] == "Water Energy" and by_number[1]["card"]["set_name"] == "Base Set"
    assert by_number[1]["card"]["collector_number"] == "102"
    assert {by_number[n]["edition"]["edition_id"] for n in (3, 4, 5)} == {edition("base1-64", "normal")}
    assert by_number[5]["source"]["name"] == 'Starmie (Holiday, "Cosmos")'
    assert by_number[6]["edition"]["edition_id"] == edition("base2-32", "holo")
    assert by_number[7]["edition"]["edition_id"] == edition("base2-48")
    assert by_number[7]["edition"]["descriptor"]["label"] == "Unspecified Variant"
    assert by_number[8]["source"] == {"quantity": "3", "name": "Poké Ball", "set_name": "Jungle", "number": "64/64",
                                      "finish": "Unlimited"}
    assert by_number[9]["card"]["name"] == "Dark Golduck"
    assert by_number[9]["edition"]["edition_id"] == edition("ex7-35", "reverse")
    assert by_number[12]["card"] is None and by_number[12]["edition"] is None
    assert by_number[13]["source"]["quantity"] == "two"
    assert [row["needs_you"] for row in found] == [False] * 9 + [True] * 4
    needs = all_rows(owner, summary["id"], "needs")
    assert [row["row_number"] for row in needs] == [10, 11, 12, 13]


def test_the_twelve_column_export_reads_crlf_quoting_a_blank_quantity_a_bom_and_windows_1252():
    seed_import_catalog()
    owner, unsorted = collector()
    for data in (TWELVE, b"\xef\xbb\xbf" + TWELVE, TWELVE.decode("utf-8").encode("cp1252")):
        summary = started(owner, unsorted, data)
        assert summary["counts"] == {"rows": 6, "needs_you": 0, "ready": 6, "finish_unknown": 1, "skipped": 0}
        assert summary["cards_to_add"] == "10"
        found = all_rows(owner, summary["id"])
        assert found[2]["source"]["name"] == "Wartortle, Shadowless" and found[2]["quantity"] == "4"
        assert found[3]["status"] == "finish_unknown"
        assert found[5]["source"]["name"] == "Poké Ball" and found[5]["source"]["quantity"] == ""
        assert found[5]["quantity"] == "1"


def test_rows_page_by_one_hundred_and_refuse_a_bad_cursor():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, file_of(250))
    assert summary["counts"] == {"rows": 250, "needs_you": 0, "ready": 250, "finish_unknown": 0, "skipped": 0}
    first = rows(owner, summary["id"]).json()
    assert len(first["rows"]) == 100 and first["next_cursor"] == "100" and first["draft_revision"] == 1
    second = rows(owner, summary["id"], cursor="100").json()
    assert [second["rows"][0]["row_number"], len(second["rows"]), second["next_cursor"]] == [101, 100, "200"]
    third = rows(owner, summary["id"], cursor="200").json()
    assert [len(third["rows"]), third["next_cursor"]] == [50, None]
    assert rows(owner, summary["id"], "needs").json()["rows"] == []
    for bad in ("abc", "-1", "1.5", "1234567890123"):
        response = rows(owner, summary["id"], cursor=bad)
        assert response.status_code == 400 and code(response) == "INVALID_CURSOR"


def test_only_the_collectors_own_storage_leaf_can_receive_an_import():
    seed_import_catalog()
    owner, unsorted = collector()
    other, other_unsorted = collector()
    with connect() as conn:
        folder = conn.execute("""INSERT INTO location(id,owner_id,parent_id,name,kind)
          VALUES (%s,%s,NULL,'Shelf','organization') RETURNING id""", (uuid4(), owner)).fetchone()["id"]
        conn.execute("""INSERT INTO location(id,owner_id,parent_id,name,kind)
          VALUES (%s,%s,%s,'Binder','storage_leaf')""", (uuid4(), owner, folder))
    deck = create(owner, "Water Deck")
    assert deck.status_code == 201, deck.text
    deck_id = deck.json()["location"]["id"]
    for location in (folder, deck_id, other_unsorted, uuid4()):
        response = upload(owner, location, TWELVE)
        assert response.status_code == 422 and code(response) == "NOT_STORAGE_LEAF", response.text
    current = call("GET", "/api/collection-imports/current", owner)
    assert current.status_code == 404 and code(current) == "IMPORT_NOT_FOUND"


def test_a_file_over_five_megabytes_or_ten_thousand_rows_is_refused_with_a_message_to_split_it():
    seed_import_catalog()
    owner, unsorted = collector()
    large = upload(owner, unsorted, sized_file(5 * 1024 * 1024 + 1))
    assert large.status_code == 422 and large.json()["detail"] == {
        "code": "IMPORT_TOO_LARGE",
        "message": "This file is larger than 5 MB. Split it into two files and import each one."}
    # Exactly 5 MB is not too large; its 60,000-odd rows are too many.
    many = upload(owner, unsorted, sized_file(5 * 1024 * 1024))
    assert many.status_code == 422 and many.json()["detail"] == {
        "code": "IMPORT_TOO_MANY_ROWS",
        "message": "This file has more than 10,000 rows. Split it into two files and import each one."}
    assert code(upload(owner, unsorted, file_of(10_001))) == "IMPORT_TOO_MANY_ROWS"
    assert call("GET", "/api/collection-imports/current", owner).status_code == 404


def test_the_body_is_measured_when_content_length_is_missing_or_understates_it():
    seed_import_catalog()
    owner, unsorted = collector()
    data = sized_file(5 * 1024 * 1024 + 1)
    stamp = str(int(time.time()))
    signed = f"POST\n/api/collection-imports\n{hashlib.sha256(data).hexdigest()}\n{owner}\n{stamp}".encode()
    headers = {"x-internal-user": owner, "x-internal-time": stamp, "content-type": "text/csv",
               "x-internal-signature": hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), signed,
                                                hashlib.sha256).hexdigest()}
    url = f"/api/collection-imports?location_id={unsorted}"

    def chunks():
        for start in range(0, len(data), 65536):
            yield data[start:start + 65536]

    for extra in ({}, {"content-length": "10"}):
        response = client.post(url, content=chunks() if not extra else data, headers={**headers, **extra})
        assert response.status_code == 422 and code(response) == "IMPORT_TOO_LARGE", (extra, response.text)
    assert call("GET", "/api/collection-imports/current", owner).status_code == 404


@pytest.mark.slow(reason="capacity: stores and matches a 10,000-row import draft")
def test_ten_thousand_rows_are_one_import():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, file_of(10_000))
    assert summary["counts"] == {"rows": 10_000, "needs_you": 0, "ready": 10_000, "finish_unknown": 0, "skipped": 0}
    assert summary["cards_to_add"] == "10000"


def test_unreadable_empty_and_undecodable_files_and_a_missing_catalog_are_refused():
    seed_import_catalog()
    owner, unsorted = collector()
    # #227's loose fallback reads a "Name,Set" file, so an unknown header is now one with no card columns at all, and
    # IMPORT_UNREADABLE carries the message that lists the trackers whose files are read.
    unreadable = {"code": "IMPORT_UNREADABLE", "message": UNREADABLE_MESSAGE}
    cases = {b"": unreadable, b"Item,Cost\nStarmie,1\n": unreadable, b"\x81\x8d\x8f\x90\x9d": unreadable,
             HEADER_12 + b"\n1,Star\x00mie\n": unreadable, HEADER_12 + b"\r\n\r\n": {"code": "IMPORT_EMPTY"}}
    for data, expected in cases.items():
        response = upload(owner, unsorted, data)
        assert response.status_code == 422 and response.json()["detail"] == expected, (data, response.text)
    with connect() as conn:
        conn.execute("UPDATE catalog_state SET active_generation=NULL WHERE singleton")
    response = upload(owner, unsorted, TWELVE)
    assert response.status_code == 503 and code(response) == "CATALOG_UNAVAILABLE"
    assert call("GET", "/api/collection-imports/current", owner).status_code == 404


def test_one_open_draft_per_collector_and_no_one_else_sees_it():
    seed_import_catalog()
    owner, unsorted = collector()
    other, _ = collector()
    first = started(owner, unsorted, FOURTEEN)
    second = started(owner, unsorted, TWELVE)
    assert first["id"] != second["id"]
    current = call("GET", "/api/collection-imports/current", owner)
    assert current.status_code == 200 and current.json() == second
    assert code(rows(owner, first["id"])) == "IMPORT_NOT_FOUND" and stored_rows(first["id"]) == 0
    assert code(rows(other, second["id"])) == "IMPORT_NOT_FOUND"
    assert call("GET", "/api/collection-imports/current", other).status_code == 404
    response = save(other, second["id"])
    assert response.status_code == 404 and code(response) == "IMPORT_NOT_FOUND"


def test_save_adds_every_ready_copy_in_one_revision_without_undo_and_replays():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, TWELVE)
    starmie = edition("base1-64", "normal")
    assert add(owner, unsorted, starmie, "1").status_code == 200
    before, undo_before = revision(owner), undo_records(owner)
    key = uuid4()
    response = save(owner, summary["id"], key=key)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result == {"import_id": summary["id"], "location_id": unsorted, "edition_count": 5, "copy_count": "10",
                      "owner_revision": before + 1}
    assert "undo_id" not in result
    expected = {starmie: "4", edition("base1-42", "normal"): "4", edition("base2-48"): "1",
                edition("base2-32", "holo"): "1", edition("base2-64", "normal"): "1"}
    assert held(owner, unsorted) == expected
    assert revision(owner) == before + 1 and undo_records(owner) == undo_before
    assert stored_rows(summary["id"]) == 0
    assert call("GET", "/api/collection-imports/current", owner).status_code == 404
    for again in (key, uuid4()):
        replay = save(owner, summary["id"], key=again)
        assert replay.status_code == 200 and replay.json() == result
    assert held(owner, unsorted) == expected and revision(owner) == before + 1
    # The saved draft's receipt outlives the next import.
    started(owner, unsorted, FOURTEEN)
    replay = save(owner, summary["id"], key=key)
    assert replay.status_code == 200 and replay.json() == result
    assert held(owner, unsorted) == expected and revision(owner) == before + 1
    reused = batch(owner, unsorted, [(starmie, "1")], key)
    assert reused.status_code == 409 and code(reused) == "IDEMPOTENCY_KEY_REUSED"


def test_a_recorded_key_whose_draft_is_gone_has_no_outcome_to_replay():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, TWELVE)
    key = uuid4()
    assert save(owner, summary["id"], key=key).status_code == 200
    with connect() as conn:
        conn.execute("DELETE FROM collection_import WHERE id=%s", (summary["id"],))
    response = save(owner, summary["id"], key=key)
    assert response.status_code == 409 and code(response) == "REPLAY_OUTCOME_UNAVAILABLE"
    unknown = save(owner, uuid4())
    assert unknown.status_code == 404 and code(unknown) == "IMPORT_NOT_FOUND"


def test_two_saves_at_once_add_the_copies_once():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, TWELVE)
    before = revision(owner)
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(lambda _: save(owner, summary["id"]), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    assert revision(owner) == before + 1
    assert held(owner, unsorted)[edition("base1-64", "normal")] == "3"


def test_save_refuses_while_rows_need_the_collector_or_for_another_draft_revision():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, FOURTEEN)
    before = revision(owner)
    response = save(owner, summary["id"])
    assert response.status_code == 422 and response.json()["detail"] == {"code": "ROWS_NEED_YOU", "count": "4"}
    clean = started(owner, unsorted, TWELVE)
    response = save(owner, clean["id"], draft_revision=2)
    assert response.status_code == 409 and code(response) == "STALE_DRAFT"
    assert held(owner, unsorted) == {} and revision(owner) == before
    assert stored_rows(clean["id"]) == 6


def test_save_refuses_review_changed_when_the_leaf_or_an_edition_is_gone():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, TWELVE)
    # Unsorted becomes a folder (as location_tree does when a Location is made inside it), then a leaf again.
    with connect() as conn:
        conn.execute("UPDATE location SET kind='organization' WHERE id=%s", (unsorted,))
        child = conn.execute("""INSERT INTO location(id,owner_id,parent_id,name,kind)
          VALUES (%s,%s,%s,'Box','storage_leaf') RETURNING id""", (uuid4(), owner, unsorted)).fetchone()["id"]
    response = save(owner, summary["id"])
    assert response.status_code == 409 and code(response) == "REVIEW_CHANGED"
    with connect() as conn:
        conn.execute("DELETE FROM location WHERE id=%s", (child,))
        conn.execute("UPDATE location SET kind='storage_leaf' WHERE id=%s", (unsorted,))
        conn.execute("""UPDATE catalog_generation_edition SET active=false
          WHERE generation_id=(SELECT active_generation FROM catalog_state WHERE singleton) AND edition_id=%s""",
                     (edition("base2-32", "holo"),))
    response = save(owner, summary["id"])
    assert response.status_code == 409 and code(response) == "REVIEW_CHANGED"
    assert held(owner, unsorted) == {} and stored_rows(summary["id"]) == 6
    with connect() as conn:
        conn.execute("""UPDATE catalog_generation_edition SET active=true
          WHERE generation_id=(SELECT active_generation FROM catalog_state WHERE singleton) AND edition_id=%s""",
                     (edition("base2-32", "holo"),))
    assert save(owner, summary["id"]).status_code == 200


def test_no_route_reads_prices_or_starts_a_catalog_pull_or_returns_source_data(monkeypatch):
    seed_import_catalog()
    owner, unsorted = collector()
    with connect() as conn:
        runs = conn.execute("SELECT count(*) AS n FROM catalog_run").fetchone()["n"]

    def forbidden(*args, **kwargs):
        pytest.fail("a Collection Import route reached prices or the catalog importer")

    for module, name in ((price_launcher, "spawn"), (public_records, "quote_states"),
                         (prices, "private_edition_quotes"), (price_refresh, "evaluate_and_admit"),
                         (catalog_dispatch, "dispatch_import"), (catalog_dispatch, "launch_import")):
        monkeypatch.setattr(module, name, forbidden)
    texts = []
    for data in (FOURTEEN, TWELVE):
        response = upload(owner, unsorted, data)
        texts.append(response.text)
        import_id = response.json()["id"]
        texts += [rows(owner, import_id).text, call("GET", "/api/collection-imports/current", owner).text]
    texts.append(save(owner, import_id).text)
    for text in texts:
        assert "tcgplayer" not in text.lower() and "$" not in text
        assert "900001" not in text and "800001" not in text and "Near Mint" not in text
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_run").fetchone()["n"] == runs
    # And the modules don't import them.
    banned = {"prices", "price_refresh", "price_launcher", "public_records", "catalog_dispatch", "catalog"}
    for module in ("collection_import", "collection_import_reader", "collection_import_matcher",
                   "collection_import_finish", "collection_import_aliases"):
        tree = ast.parse((Path(__file__).parents[1] / "app" / f"{module}.py").read_text())
        imported = {alias.name for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
                    for alias in node.names} | {node.module.split(".")[-1] for node in ast.walk(tree)
                                                if isinstance(node, ast.ImportFrom) and node.module}
        assert not imported & banned, (module, imported & banned)
