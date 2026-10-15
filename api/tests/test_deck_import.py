"""Decklist import (ticket #212): signed HTTP against PostgreSQL and a real record store.

The parser has no tests of its own; it is read through POST /api/decks/import/review, which reads a pasted list against
the catalog by printed set code and number, and writes nothing. POST /api/decks/import creates the Deck. Prices are
controlled by writing what the price runner writes (``test_prices.seed``); no real runner is ever started.
"""
from datetime import timedelta
import os
import time
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app import price_launcher, prices
from app.public_projection import ProjectionUnavailable
from app.public_records import public_record_store, result_key
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_targets import isolated_rules  # noqa: F401  (autouse)
from test_decks import create
from test_deck_lists import code, detail
from test_deck_list_printing import catalog, furret_world
from test_holdings import call, client
from test_prices import ago, seed
from deck_import_fixtures import EXPECTED, FIXTURES, printed, seed_import_catalog
from app import quote_contract

REVIEW = "/api/decks/import/review"
IMPORT = "/api/decks/import"


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "filesystem")
    public_record_store().initialize(deadline=time.monotonic() + 5)
    return public_record_store()


@pytest.fixture(autouse=True)
def launches(monkeypatch):
    """Records any runner launch; reviewing a list must never cause one."""
    calls = []
    monkeypatch.setattr(price_launcher, "spawn", lambda slot, owner: calls.append((slot, owner)) or True)
    return calls


def scheduler(store):
    key = quote_contract.scheduler_key()
    return store.read_records([key], deadline=time.monotonic() + 5).records[key].value


def review(owner, text, fixes=(), expect=200):
    response = call("POST", REVIEW, owner, {"source": {"text": text}, "fixes": list(fixes)})
    assert response.status_code == expect, response.text
    return response.json()


def import_deck(owner, name, lines, target="standard", key=None):
    return call("POST", IMPORT, owner, {"name": name, "target_format": target, "lines": lines,
                                        "idempotency_key": str(key or uuid4())})


def rows(body):
    return [(l["line"], l["section"], l["quantity"], l["status"]) for l in body["lines"]]


def delete_deck(owner, location):
    return call("DELETE", f"/api/decks/{location['id']}", owner,
                {"name": location["name"], "version": location["version"], "idempotency_key": str(uuid4())})


def sql(statement, params=()):
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        cursor = conn.execute(statement, params)
        return cursor.fetchall() if cursor.description else None


def deck_count(owner):
    return len(call("GET", "/api/decks", owner).json()["decks"])


def reading(body):
    return [(l["line"], l["name"], l["set_code"], l["number"], l["ph"]) for l in body["lines"]]


# ------------------------------------------------------------------ the parser, through the review route


def test_the_nine_research_fixtures_read_by_section_quantity_and_status(launches):
    seed_import_catalog()
    owner = str(uuid4())
    for key, text in FIXTURES.items():
        body = review(owner, text.replace("\n", "\r\n") if key == "F7" else text)
        expected = EXPECTED[key]
        assert rows(body) == expected["cards"], key
        assert [(i["line"], i["text"]) for i in body["ignored"]] == expected["ignored"], key
        totals = body["totals"]
        assert totals["cards"] == expected["total"], key
        assert totals["card_lines"] == len(expected["cards"]), key
        assert totals["ignored"] == len(expected["ignored"]), key
        assert totals["to_resolve"] == sum(1 for row in expected["cards"] if row[3] == "not_found"), key
        assert sum(int(e["quantity"]) for e in body["deck_list"]) == sum(
            int(row[2]) for row in expected["cards"] if row[3] == "matched"), key
    assert launches == []


def test_line_endings_a_bom_and_invisible_spaces_read_like_the_plain_text():
    seed_import_catalog()
    owner = str(uuid4())

    def same(variant, plain, texts=False):
        got, want = review(owner, variant), review(owner, plain)
        assert rows(got) == rows(want)
        assert reading(got) == reading(want)
        assert [(i["line"], i["text"]) for i in got["ignored"]] == [(i["line"], i["text"]) for i in want["ignored"]]
        if texts:
            assert [l["text"] for l in got["lines"]] == [l["text"] for l in want["lines"]]

    same("﻿" + FIXTURES["F1"], FIXTURES["F1"])
    same(FIXTURES["F3"].replace("\n", "\r"), FIXTURES["F3"])
    same(FIXTURES["F7"], FIXTURES["F7"].replace("\n", "\r\n"))
    same(FIXTURES["F6"].replace(" ", " ").replace("Hoothoot", "Hoo​thoot"), FIXTURES["F6"], texts=True)


def test_tcg_online_bullets_headers_and_the_empty_set_energy_line():
    seed_import_catalog()
    body = review(str(uuid4()), FIXTURES["F8"])
    lines = {l["line"]: l for l in body["lines"]}
    assert {k: lines[3][k] for k in ("name", "set_code", "number", "status", "section")} == {
        "name": "Farfetch'd", "set_code": "TEU", "number": "127", "status": "matched", "section": "pokemon"}
    assert {k: lines[8][k] for k in ("name", "set_code", "number", "status", "section")} == {
        "name": "Water Energy", "set_code": "", "number": "12", "status": "not_found", "section": "energy"}
    assert lines[8]["text"] == "* 20 Water Energy  12"


def test_ph_is_kept_on_the_line_and_changes_nothing():
    seed_import_catalog()
    body = review(str(uuid4()), "1 Mimikyu PAL 97 PH\n1 Mimikyu PAL 97\n")
    first, second = body["lines"]
    assert first["status"] == second["status"] == "matched"
    assert first["printing"]["printing_id"] == second["printing"]["printing_id"]
    assert first["parts"][0]["edition_id"] == second["parts"][0]["edition_id"]
    assert [first["ph"], second["ph"]] == [True, False]
    assert first["text"].endswith(" PH")
    assert body["deck_list"] == [{"edition_id": first["parts"][0]["edition_id"], "quantity": "2"}]


def test_names_keep_colons_apostrophes_and_curly_apostrophes():
    seed_import_catalog()
    body = review(str(uuid4()), "1 Technical Machine: Evolution PAR 178\n3 Farfetch’d TEU 127\n")
    assert [l["status"] for l in body["lines"]] == ["matched", "matched"]
    assert [l["name"] for l in body["lines"]] == ["Technical Machine: Evolution", "Farfetch'd"]
    assert "’" in body["lines"][1]["text"]


def test_a_line_with_no_set_code_and_number_cant_be_read():
    seed_import_catalog()
    body = review(str(uuid4()), "4 Iono\n3 Nest Ball\n2 Mew ex 151\n4 Iono PAL\n")
    assert [l["status"] for l in body["lines"]] == ["unreadable"] * 4
    assert [(l["set_code"], l["number"]) for l in body["lines"]] == [(None, None)] * 4
    assert [l["name"] for l in body["lines"]] == ["Iono", "Nest Ball", "Mew ex 151", "Iono PAL"]
    for line in body["lines"]:
        assert not line["printing"] and not line["parts"] and not line["editions"]
    assert body["totals"]["to_resolve"] == 4


def test_headers_never_count_and_totals_come_from_the_lines():
    seed_import_catalog()
    body = review(str(uuid4()), "Pokemon: 99\n1 Mimikyu PAL 97\nTrainer Cards - 1\n4 Iono PAL 185\nTotal Cards: 60\n")
    assert [l["section"] for l in body["lines"]] == ["pokemon", "trainer"]
    assert body["totals"]["cards"] == "5"
    assert [(i["line"], i["text"]) for i in body["ignored"]] == [(5, "Total Cards: 60")]


def test_text_over_20000_characters_is_refused():
    seed_import_catalog()
    owner = str(uuid4())
    text = "1 Iono PAL 185\n" + "x" * (20_000 - 15)
    assert len(text) == 20_000
    body = review(owner, text)
    assert body["totals"]["card_lines"] == 1 and body["totals"]["ignored"] == 1
    refused = call("POST", REVIEW, owner, {"source": {"text": text + "x"}, "fixes": []})
    assert refused.status_code == 422 and code(refused) == "IMPORT_TOO_LONG"


def test_more_than_200_card_lines_is_refused():
    seed_import_catalog()
    owner = str(uuid4())
    body = review(owner, "1 Iono PAL 185\n" * 200)
    assert body["totals"]["card_lines"] == 200
    [entry] = body["deck_list"]
    assert entry["quantity"] == "200"
    refused = call("POST", REVIEW, owner, {"source": {"text": "1 Iono PAL 185\n" * 200 + "4 Iono\n"}, "fixes": []})
    assert refused.status_code == 422 and code(refused) == "IMPORT_TOO_MANY_LINES"


# ------------------------------------------------------------------ matching by printed set code


def test_a_code_and_number_find_one_printing_without_a_name_cross_check():
    seed_import_catalog()
    body = review(str(uuid4()), "2 Pikachu PAL 185\n1 Mimikyu PAL 0097\n")
    first, second = body["lines"]
    assert first["status"] == second["status"] == "matched"
    assert first["printing"]["name"] == "Iono"
    assert first["printing"]["set_code"] == "PAL" and first["printing"]["collector_number"] == "185"
    assert second["printing"]["collector_number"] == "097"


def test_a_code_outside_the_printed_code_table_is_not_found():
    seed_import_catalog()
    body = review(str(uuid4()), "1 Mimikyu PR-SV 75\n6 Basic {P} Energy SVE 13\n1 Iono SV02 185\n"
                                "7 Psychic Energy Energy 31\n")
    assert [l["status"] for l in body["lines"]] == ["not_found"] * 4
    assert [l["set_code"] for l in body["lines"]] == ["PR-SV", "SVE", "SV02", "Energy"]


def test_several_printings_for_one_code_and_number_ask_the_collector_to_pick():
    reset_catalog()
    run(Records(printed("swsh9", "Brilliant Stars", "40", "Lumineon V", "Pokemon"),
                printed("swsh9tg", "Brilliant Stars Trainer Gallery", "040", "Lumineon V", "Pokemon")))
    owner = str(uuid4())
    body = review(owner, "1 Lumineon V BRS 40\n")
    [line] = body["lines"]
    assert line["status"] == "ambiguous"
    assert [c["set_code"] for c in line["candidates"]] == ["BRS", "BRS"]
    assert line["printing"] is None and line["parts"] == [] and body["deck_list"] == []
    assert body["totals"]["to_resolve"] == 1
    second = line["candidates"][1]["printing_id"]
    fixed = review(owner, "1 Lumineon V BRS 40\n", [{"line": 1, "printing_id": second}])
    assert fixed["lines"][0]["status"] == "picked"
    assert fixed["lines"][0]["printing"]["printing_id"] == second


def test_a_printing_with_no_active_edition_or_withdrawn_is_not_found():
    owner = str(uuid4())
    seed_import_catalog()
    sql("""UPDATE catalog_generation_edition SET active=false WHERE printing_id =
           (SELECT id FROM catalog_printing WHERE source_id = 'sv02-185')""")
    assert review(owner, "1 Iono PAL 185")["lines"][0]["status"] == "not_found"
    seed_import_catalog()
    sql("UPDATE catalog_generation_printing SET tombstoned=true WHERE source_id='sv02-172'")
    assert review(owner, "1 Boss's Orders PAL 172")["lines"][0]["status"] == "not_found"


# ------------------------------------------------------------------ which Edition new copies get


def test_new_copies_get_the_cheapest_stored_quote_and_no_runner_is_launched(store, launches):
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    seed(store, by_id[first], "0.50")
    seed(store, by_id[second], "0.10", checked=ago(timedelta(hours=25)))
    keys = [result_key(by_id[edition]["public_ref"], by_id[edition]["mapping_revision"]) for edition in (first, second)]
    generation = store.read_records(keys, deadline=time.monotonic() + 5).generation
    body = review(owner, "2 Furret DAA 1\n")
    [line] = body["lines"]
    assert line["parts"] == [{"edition_id": second, "quantity": "2", "source": "new", "chosen_by": "cheapest_price"}]
    assert [e["edition_id"] for e in line["editions"]] == [first, second]
    assert [e["display_price"] for e in line["editions"]] == ["$0.50", "$0.10"]
    assert launches == []
    assert scheduler(store) is None
    assert store.read_records(keys, deadline=time.monotonic() + 5).generation == generation


def test_without_a_stored_quote_new_copies_take_the_first_edition_in_catalog_order():
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    _, [only] = catalog(owner, 2)
    one, two = review(owner, "2 Furret DAA 1\n4 Furret DAA 2\n")["lines"]
    assert one["parts"][0]["chosen_by"] == "catalog_order" and one["parts"][0]["edition_id"] == first
    assert two["parts"][0]["chosen_by"] == "catalog_order" and two["parts"][0]["edition_id"] == only
    assert [e["display_price"] for e in two["editions"]] == [None]


def test_an_unreadable_price_cache_is_prices_unavailable(monkeypatch):
    owner = str(uuid4())
    furret_world(owner)

    def unavailable(*args, **kwargs):
        raise ProjectionUnavailable()

    with monkeypatch.context() as patch:
        patch.setattr(prices, "public_record_store", unavailable)
        refused = call("POST", REVIEW, owner, {"source": {"text": "2 Furret DAA 1\n"}, "fixes": []})
        assert refused.status_code == 503 and code(refused) == "PRICES_UNAVAILABLE"
        assert review(owner, "4 Iono\n")["totals"]["to_resolve"] == 1


# ------------------------------------------------------------------ fixes

TEXT = "Pokémon: 3\n1 Mimikyu PAL 97 PH\n2 Iono PAL 185\n1 Iono PAL 185\n4 Iono\n1 Meowth ex POR 62\n"


def first_pass(owner):
    seed_import_catalog()
    body = review(owner, TEXT)
    mimikyu, iono = body["lines"][0], body["lines"][1]
    return (body, mimikyu["printing"]["printing_id"], mimikyu["parts"][0]["edition_id"],
            iono["printing"]["printing_id"], iono["parts"][0]["edition_id"])


def test_fixes_drop_pick_a_card_or_choose_an_edition():
    owner = str(uuid4())
    body, mimikyu, mimikyu_edition, iono, iono_edition = first_pass(owner)
    assert [l["status"] for l in body["lines"]] == ["matched", "matched", "matched", "unreadable", "not_found"]
    assert body["deck_list"] == [{"edition_id": mimikyu_edition, "quantity": "1"},
                                 {"edition_id": iono_edition, "quantity": "3"}]
    fixes = [{"line": 5, "printing_id": iono}, {"line": 6, "drop": True}]
    fixed = review(owner, TEXT, fixes)
    assert [l["status"] for l in fixed["lines"]] == ["matched", "matched", "matched", "picked", "dropped"]
    assert fixed["lines"][4]["printing"] is None and fixed["lines"][4]["parts"] == []
    assert fixed["totals"] == {"card_lines": 5, "cards": "8", "ignored": 0, "to_resolve": 0}
    assert fixed["deck_list"][1]["quantity"] == "7"
    chosen = review(owner, TEXT, fixes + [{"line": 2, "edition_id": mimikyu_edition}])
    assert chosen["lines"][0]["status"] == "matched"
    assert chosen["lines"][0]["parts"][0]["chosen_by"] == "collector"
    picked = review(owner, TEXT, [{"line": 5, "edition_id": iono_edition}])
    assert picked["lines"][3]["status"] == "picked" and picked["lines"][3]["parts"][0]["chosen_by"] == "collector"
    again = review(owner, TEXT, [{"line": 2, "printing_id": mimikyu}])
    assert again["lines"][0]["status"] == "matched"


def test_lines_naming_one_edition_merge_into_one_deck_list_line():
    owner = str(uuid4())
    body, _, mimikyu_edition, _, iono_edition = first_pass(owner)
    assert [e["edition_id"] for e in body["deck_list"]] == [mimikyu_edition, iono_edition]
    assert body["deck_list"][1]["quantity"] == "3"


def test_bad_fixes_are_refused():
    owner = str(uuid4())
    _, mimikyu, mimikyu_edition, iono, iono_edition = first_pass(owner)

    def refused(fixes, expect):
        response = call("POST", REVIEW, owner, {"source": {"text": TEXT}, "fixes": fixes})
        assert response.status_code == 422, (fixes, response.text)
        assert code(response) == expect, fixes

    refused([{"line": 99, "drop": True}], "INVALID_FIX")
    refused([{"line": 1, "drop": True}], "INVALID_FIX")
    refused([{"line": 5}], "INVALID_FIX")
    refused([{"line": 5, "drop": True, "printing_id": iono}], "INVALID_FIX")
    refused([{"line": 5, "drop": True}, {"line": 5, "printing_id": iono}], "INVALID_FIX")
    refused([{"line": 3, "edition_id": mimikyu_edition}], "INVALID_FIX")
    refused([{"line": 5, "printing_id": str(uuid4())}], "PRINTING_UNAVAILABLE")
    refused([{"line": 5, "edition_id": str(uuid4())}], "EDITION_UNAVAILABLE")


def test_the_review_is_read_only_signed_and_answers_revisions():
    seed_import_catalog()
    payload = {"source": {"text": "1 Iono PAL 185\n"}, "fixes": []}
    assert client.post(REVIEW, json=payload).status_code == 401
    stranger = str(uuid4())
    assert review(stranger, "1 Iono PAL 185\n")["owner_revision"] == 1
    assert sql("SELECT count(*) FROM inventory_owner WHERE user_id=%s", (stranger,)) == [(0,)]
    owner = str(uuid4())
    deck = create(owner, "Existing").json()["location"]["id"]

    def counts():
        return (sql("SELECT count(*) FROM location WHERE owner_id=%s", (owner,)),
                sql("SELECT count(*) FROM location_command WHERE owner_id=%s", (owner,)))

    before = counts()
    one, two = review(owner, "1 Iono PAL 185\n"), review(owner, "1 Iono PAL 185\n")
    assert one["owner_revision"] == two["owner_revision"] == detail(owner, deck)["owner_revision"]
    assert one["catalog_revision"] == sql("SELECT revision FROM catalog_state")[0][0]
    assert counts() == before


# ------------------------------------------------------------------ creating the Deck


def test_import_creates_the_deck_its_target_format_and_lines_in_one_command():
    owner = str(uuid4())
    _, mimikyu, mimikyu_edition, iono, iono_edition = first_pass(owner)
    fixes = [{"line": 5, "printing_id": iono}, {"line": 6, "drop": True}]
    body = review(owner, TEXT, fixes)
    earlier = create(owner, "Earlier").json()["owner_revision"]
    response = import_deck(owner, "Gardevoir", body["deck_list"], target="expanded")
    assert response.status_code == 201, response.text
    result = response.json()
    location = result["location"]
    assert location["kind"] == "deck" and location["name"] == "Gardevoir" and location["parent_id"] is None
    assert result["deck_id"] == location["id"]
    assert result["deck_list"]["revision"] == 2
    assert {(l["edition_id"], l["quantity"]) for l in result["deck_list"]["lines"]} == {
        (e["edition_id"], e["quantity"]) for e in body["deck_list"]}
    for line in result["deck_list"]["lines"]:
        assert line["name"] and line["set_name"] and line["identity_id"]
    assert result["target_format"] == "expanded"
    checks = result["format_checks"]
    assert [r["format"] for r in checks["results"]] == ["expanded"]
    assert checks["deck_list_revision"] == 2
    assert result["owner_revision"] == earlier + 1
    stored = detail(owner, location["id"])
    assert stored["deck_list"] == result["deck_list"] and stored["target_format"] == "expanded"
    listed = {d["id"]: d for d in call("GET", "/api/decks", owner).json()["decks"]}
    assert listed[location["id"]]["deck_list_total"] == "8"


def test_import_replays_and_refuses_a_reused_key():
    owner = str(uuid4())
    _, _, _, _, _ = first_pass(owner)
    lines = review(owner, TEXT)["deck_list"]
    key = uuid4()
    first = import_deck(owner, "Gardevoir", lines, key=key)
    assert first.status_code == 201, first.text
    again = import_deck(owner, "Gardevoir", list(reversed(lines)), key=key)
    assert again.status_code == 201 and again.json() == first.json()
    names = [d["name"] for d in call("GET", "/api/decks", owner).json()["decks"]]
    assert names.count("Gardevoir") == 1
    reused = import_deck(owner, "Gardevoir", lines[:1], key=key)
    assert reused.status_code == 409 and code(reused) == "IDEMPOTENCY_KEY_REUSED"


def test_import_checks_the_name_as_create_deck_does():
    owner = str(uuid4())
    seed_import_catalog()
    for name in ("", "   ", "x" * 121, "bad\x01name"):
        refused = import_deck(owner, name, [])
        assert refused.status_code == 422 and code(refused) == "INVALID_LOCATION_NAME", repr(name)
    assert create(owner, "Alpha").status_code == 201
    count = deck_count(owner)
    for name in ("alpha", "Unsorted"):
        refused = import_deck(owner, name, [])
        assert refused.status_code == 409 and code(refused) == "LOCATION_NAME_CONFLICT", name
    assert deck_count(owner) == count


def test_import_refuses_unavailable_and_duplicate_editions_and_unknown_formats():
    owner = str(uuid4())
    seed_import_catalog()
    body = review(owner, "1 Iono PAL 185\n1 Boss's Orders PAL 172\n1 Mimikyu PAL 97\n")
    iono, boss, mimikyu = [l["parts"][0]["edition_id"] for l in body["lines"]]
    sql("""UPDATE catalog_generation_edition SET active=false WHERE printing_id =
           (SELECT id FROM catalog_printing WHERE source_id = 'sv02-185')""")
    sql("UPDATE catalog_generation_printing SET tombstoned=true WHERE source_id='sv02-172'")
    create(owner, "Earlier")
    count, revision = deck_count(owner), review(owner, "")["owner_revision"]

    def refused(lines, name="Gardevoir", target="standard", expect=None):
        response = import_deck(owner, name, lines, target=target)
        assert response.status_code == 422, response.text
        if expect:
            assert code(response) == expect, response.text
        assert deck_count(owner) == count and review(owner, "")["owner_revision"] == revision

    refused([{"edition_id": iono, "quantity": "1"}], expect="EDITION_UNAVAILABLE")
    refused([{"edition_id": boss, "quantity": "1"}], expect="EDITION_UNAVAILABLE")
    refused([{"edition_id": str(uuid4()), "quantity": "1"}], expect="EDITION_UNAVAILABLE")
    refused([{"edition_id": mimikyu, "quantity": "1"}, {"edition_id": mimikyu, "quantity": "2"}],
            expect="DUPLICATE_EDITION")
    refused([{"edition_id": mimikyu, "quantity": "1"}], target="modern", expect="UNKNOWN_FORMAT")
    refused([{"edition_id": mimikyu, "quantity": "0"}], expect="INVALID_QUANTITY")
    refused([{"edition_id": mimikyu, "quantity": "-1"}], expect="INVALID_QUANTITY")
    refused([{"edition_id": str(uuid4()), "quantity": "1"} for _ in range(201)])


def test_an_empty_list_creates_an_empty_deck():
    owner = str(uuid4())
    response = import_deck(owner, "Blank", [])
    assert response.status_code == 201, response.text
    assert response.json()["deck_list"] == {"revision": 2, "lines": []}


def test_undo_is_deleting_the_deck():
    owner = str(uuid4())
    _, _, _, _, _ = first_pass(owner)
    response = import_deck(owner, "Gardevoir", review(owner, TEXT)["deck_list"])
    assert response.status_code == 201, response.text
    location = response.json()["location"]
    deleted = delete_deck(owner, location)
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["edition_count"] == 0
    assert call("GET", f"/api/decks/{location['id']}", owner).status_code == 404
    assert sql("SELECT count(*) FROM deck_list_line WHERE owner_id=%s AND deck_id=%s", (owner, location["id"])) == [(0,)]
