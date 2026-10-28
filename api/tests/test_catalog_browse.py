"""The Catalog browse route (app redesign #173, spec "Catalog browse route" and "Testing Decisions") over signed HTTP.

``GET /api/catalog/editions`` lists Card Editions with their card type, stored Format Standing and the caller's copies;
``GET /api/catalog/sets`` lists the active catalog's sets for the set picker. Every test fixes the day Format Standing is
computed for (``format_standing.today``): the rules files' dates would otherwise change the expected standings over time.
"""
import dataclasses
import os
from datetime import date
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo

from app import format_evaluator as evaluator
from app import format_standing
from app.catalog import SetDetails, TCGdexSource
from app.catalog_browse import _rules_release_dates
from app.main import app, connect
from test_attribute_corrections import decide, seed
from test_card_attributes import BULBASAUR_ME, ENERGY_SV, EX_BW, SUPPORTER, SWITCH_ME, card, edition_of
from test_card_identity import JUNIPER, LETTER, MAGNOLIA, PLAIN
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_references import migrate
from test_catalog_search import promote
from test_deck_format_checks import DELTA_POKEMON, deck_with, standard
from test_expanded_format_checks import SCOOP_UP_NET
from test_holdings import add, call
from test_moves import leaf
from test_reprint_groups import CANDY_ME, CANDY_SV

AS_OF = date(2026, 10, 11)  # the rules files' date
ROOT_MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"
# Legal everywhere (Bulbasaur me01-001); Items with a Trainer Type (both Rare Candy, Scoop Up Net); a Trainer whose
# source gives no Trainer Type (Switch); a Supporter; a Basic Energy; a card whose set the rules don't record, unknown in
# Standard (fixture-me06-3); cards not legal in Standard (Giratina-EX bw6-124, Scoop Up Net swsh2-165).
CARDS = (BULBASAUR_ME, CANDY_ME, CANDY_SV, SWITCH_ME, SUPPORTER, ENERGY_SV, SCOOP_UP_NET, DELTA_POKEMON, EX_BW)
# Sixty-one more Printings in a set the rules don't record, so a walk of the whole catalog has a second page.
FILLERS = tuple(card(id=f"fixture-zz-{i}", name=f"Zubat {i:02d}", localId=str(i), category="Pokemon",
                     set={"id": "fixturezz", "name": "Fixture Zubats"}) for i in range(1, 62))


def named(number, name, category="Pokemon", **fields):
    """One Printing of the name search fixture, all in one set the rules don't record."""
    return card(id=f"fixture-names-{number}", name=name, localId=str(number), category=category,
                set={"id": "fixturenames", "name": "Fixture Names"}, **fields)


# Names for the name search: accents, punctuation, a possessive, near misses (Charmander, Chatot) and a subtitle.
NAMED = (named(1, "Charizard"), named(2, "Charmander"), named(3, "Chatot"), named(4, "Gardevoir"),
         named(5, "Farfetch’d"), named(6, "Porygon-Z"), named(7, "Mr. Mime"),
         named(8, "Pokémon Center Lady", "Trainer", trainerType="Supporter"),
         named(9, "Boss's Orders", "Trainer", trainerType="Supporter"), JUNIPER)
EDITIONS = "/api/catalog/editions"
client = TestClient(app)


def seed_gallery():
    """Browser fixture (web/tests/catalog-gallery.spec.ts): CARDS and FILLERS through the importer, 70 Printings with
    one Edition each. Bulbasaur has artwork. The spec runs on today's date, so it relies only on standings no date
    changes: Giratina-EX (bw6) is not legal in Standard, and the Delta Reign and Fixture Zubats cards are unknown there
    because the rules don't record their sets."""
    reset_catalog()
    bulbasaur = {**BULBASAUR_ME, "image": "https://assets.tcgdex.net/en/me/me01/001"}
    # Eras for the set picker's folders (web/tests/catalog-gallery.spec.ts). The dates are the ones the rules files give
    # (so the gallery order is the same), me06 has none, and fixturezz has no series: it lands in the last folder.
    mega, sv, swsh, bw = ("mega", "Mega Evolution"), ("sv", "Scarlet & Violet"), ("swsh", "Sword & Shield"), ("bw", "Black & White")
    run(DatedRecords({"me01": date(2025, 9, 26), "sv01": date(2023, 3, 31), "sv02": date(2023, 6, 9),
                      "swsh2": date(2020, 5, 1), "bw6": date(2012, 8, 15)},
                     bulbasaur, *(record for record in CARDS if record is not BULBASAUR_ME), *FILLERS,
                     series={"me01": mega, "me06": mega, "sv01": sv, "sv02": sv, "swsh2": swsh, "bw6": bw}))


def seed_popup():
    """Browser fixture (web/tests/catalog-popup.spec.ts, #174): Bulbasaur with artwork and three Editions (Normal,
    Reverse Holo and Holo), the Holo retired so it has no tile; Rare Candy and Switch; and Professor's Research
    (Professor Juniper), whose Card Identity is "Professor's Research". Newest set first, the tiles are Bulbasaur
    Normal, Bulbasaur Reverse Holo, Rare Candy and Switch (me01), then Professor's Research (swsh4.5)."""
    reset_catalog()
    bulbasaur = {**BULBASAUR_ME, "image": "https://assets.tcgdex.net/en/me/me01/001",
                 "variants": {"normal": True, "reverse": True, "holo": True}}
    run(Records(bulbasaur, CANDY_ME, SWITCH_ME, JUNIPER))
    with connect() as conn:
        conn.execute("""UPDATE catalog_generation_edition SET active=false
          WHERE generation_id=(SELECT active_generation FROM catalog_state WHERE singleton)
            AND edition_id=(SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
                            WHERE p.source_id='me01-001' AND e.descriptor->>'finish'='holo')""")


@pytest.fixture(autouse=True)
def fixed_day(monkeypatch):
    monkeypatch.setattr(format_standing, "today", lambda: AS_OF)


def collector():
    user = f"browse-{uuid4()}"
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (user,))
    return user


def browse(user, expect=200, **params):
    query = "&".join(f"{key}={value}" for key, value in params.items() if value is not None)
    response = call("GET", EDITIONS + (f"?{query}" if query else ""), user)
    assert response.status_code == expect, response.text
    return response.json()


def names(user, **params):
    return [(row["name"], row["set_id"], row["collector_number"]) for row in browse(user, **params)["editions"]]


def error(response):
    return response.json()["detail"]["code"]


def walk(user, **params):
    """Every page of a query, following next_cursor."""
    pages = [browse(user, **params)]
    while pages[-1]["next_cursor"]:
        pages.append(browse(user, **params, cursor=pages[-1]["next_cursor"]))
    return pages


# ------------------------------------------------------------------ access and availability


def test_a_signed_out_caller_is_refused():
    seed(*CARDS)
    assert client.get(EDITIONS).status_code == 401
    assert client.get("/api/catalog/sets").status_code == 401
    forged = {"x-internal-user": "someone", "x-internal-time": "1", "x-internal-signature": "0" * 64}
    assert client.get(EDITIONS, headers=forged).status_code == 401


def test_before_the_first_import_the_catalog_is_unavailable():
    reset_catalog()
    user = collector()
    page = browse(user, q="pikachu")
    assert (page["available"], page["editions"], page["next_cursor"], page["printings"]) == (False, [], None, 0)
    sets = call("GET", "/api/catalog/sets", user).json()
    assert (sets["available"], sets["sets"]) == (False, [])


# ------------------------------------------------------------------ rows, smart search and filters


def test_a_row_carries_display_data_card_type_standing_and_copies():
    seed(*CARDS)
    user = collector()
    binder = leaf(user)
    assert add(user, binder, edition_of("me01-001"), "3").status_code == 200
    page = browse(user, q="bulbasaur")
    assert page["available"] is True and page["printings"] == len(CARDS) and page["matches"] == 1
    [row] = page["editions"]
    with connect() as conn:
        printing = conn.execute("SELECT id FROM catalog_printing WHERE source_id='me01-001'").fetchone()["id"]
    assert row == {
        "edition_id": edition_of("me01-001"), "printing_id": str(printing), "name": "Bulbasaur", "set_id": "me01",
        "set_name": "Mega Evolution", "set_code": "MEG", "collector_number": "001", "descriptor": row["descriptor"], "image_url": None,
        "card_kind": "pokemon", "trainer_type": None, "evolves_from": None, "regulation_mark": "I",
        "standing": {name: {"status": "legal", "reasons": []} for name in ("standard", "expanded", "glc")},
        "owned": 3, "in_deck": None, "free": None}
    assert row["descriptor"]  # the Edition's Variant Descriptor, as the other catalog reads return it
    assert page["owner_revision"] >= 2 and page["catalog_revision"] >= 1 and page["last_success"]


def test_smart_search_reads_a_known_set_and_number_otherwise_a_name_search_and_may_be_empty():
    seed(*CARDS)
    user = collector()
    everything = browse(user)
    assert everything["search"] == {"mode": "all", "text": "", "set_id": None, "set_name": None, "set_code": None,
                                    "number": None}
    assert len(everything["editions"]) == everything["matches"] == len(CARDS)
    # A printed set code or a TCGdex set ID, in any case, then a number; leading zeros don't count.
    page = browse(user, q="MEG%201")
    assert page["search"] == {"mode": "set_number", "text": "meg 1", "set_id": "me01", "set_name": "Mega Evolution",
                              "set_code": "MEG", "number": "1"}
    assert [row["name"] for row in page["editions"]] == ["Bulbasaur"]
    assert browse(user, q="ME01%201")["search"]["set_code"] == "MEG"
    assert names(user, q="me01%201") == names(user, q="meg%20001") == [("Bulbasaur", "me01", "001")]
    assert names(user, q="meg%20%23125") == [("Rare Candy", "me01", "125")]
    # Anything else is a name search.
    candy = browse(user, q="%20rare%20%20")
    assert candy["search"]["mode"] == "name" and candy["search"]["text"] == "rare"
    assert [row[1:] for row in names(user, q="rare")] == [("me01", "125"), ("sv01", "191")]
    assert browse(user, q="zz01%20125")["search"]["mode"] == "name"   # not a known set: a name search
    assert names(user, q="zz01%20125") == []
    assert names(user, q="bulbasaur%20001") == []                      # a name, not a set
    assert browse(user, q="x" * 121, expect=422)


def test_each_filter_narrows_the_rows():
    seed(*CARDS)
    user = collector()
    # Newest set first (rules-file dates here): Mega Evolution, then Dragons Exalted, then Delta Reign, which has no date.
    assert [row[0] for row in names(user, kind="pokemon")] == ["Bulbasaur", "Giratina-EX", "Fixture Pokémon"]
    assert [row[0] for row in names(user, kind="supporter")] == ["Fixture Supporter"]
    assert [row[0] for row in names(user, kind="item")] == ["Rare Candy", "Rare Candy", "Scoop Up Net"]
    assert [row[0] for row in names(user, kind="energy")] == ["Basic Grass Energy"]
    # Switch's source gives no Trainer Type: it matches no Trainer Type chip, only no kind at all.
    for kind in ("supporter", "item", "tool", "stadium"):
        assert "Switch" not in [row[0] for row in names(user, kind=kind)], kind
    assert "Switch" in [row[0] for row in names(user)]
    assert browse(user, kind="trainer", expect=422)
    # A set filter lists that set in collector number order.
    assert names(user, set_id="me01") == [("Bulbasaur", "me01", "001"), ("Rare Candy", "me01", "125"),
                                          ("Switch", "me01", "130")]
    assert names(user, set_id="nope") == []
    # Owned only.
    binder = leaf(user)
    assert add(user, binder, edition_of("me01-130"), "2").status_code == 200
    assert names(user, owned="true") == [("Switch", "me01", "130")]
    assert names(user, owned="true", kind="pokemon") == []
    sets = call("GET", "/api/catalog/sets", user).json()
    assert sets["available"] is True
    assert [(entry["set_id"], entry["printings"]) for entry in sets["sets"]] == [
        ("me06", 1), ("bw6", 1), ("me01", 3), ("sv02", 1), ("swsh2", 1), ("sv01", 2)]  # A-Z by set name


def test_a_format_filter_hides_only_not_legal_cards_and_keeps_unknown_ones():
    seed(*CARDS)
    user = collector()
    every = browse(user)["editions"]
    with connect() as conn:
        stored = format_standing.read_standings(conn, [row["edition_id"] for row in every])
    for row in every:  # each row reports its Printing's stored standing
        for name in evaluator.FORMATS:
            found = stored[UUID(row["edition_id"])][name]
            assert row["standing"][name] == {"status": found.status,
                                             "reasons": [finding["reason"] for finding in found.findings]}, row
    for name in evaluator.FORMATS:
        shown = {row["edition_id"] for row in browse(user, format=name)["editions"]}
        assert shown == {row["edition_id"] for row in every if row["standing"][name]["status"] != "not_legal"}, name
    standard_rows = {row["name"]: row for row in browse(user, format="standard")["editions"]}
    assert standard_rows["Fixture Pokémon"]["standing"]["standard"]["status"] == "unknown"
    assert standard_rows["Fixture Pokémon"]["standing"]["standard"]["reasons"]
    assert "Giratina-EX" not in standard_rows and "Bulbasaur" in standard_rows
    assert browse(user, format="modified", expect=422)


def test_ownership_counts_with_and_without_a_deck():
    seed(*CARDS)
    user = collector()
    binder = leaf(user)
    created = call("POST", "/api/decks", user, {"name": "Browse deck", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    assert add(user, binder, edition_of("me01-001"), "3").status_code == 200
    assert add(user, deck, edition_of("me01-001"), "2").status_code == 200
    assert add(user, deck, edition_of("me01-125"), "1").status_code == 200

    def counts(**params):
        return {row["name"] + " " + row["set_id"]: (row["owned"], row["in_deck"], row["free"])
                for row in browse(user, set_id="me01", **params)["editions"]}

    assert counts() == {"Bulbasaur me01": (5, None, None), "Rare Candy me01": (1, None, None),
                        "Switch me01": (0, None, None)}
    assert counts(deck_id=deck) == {"Bulbasaur me01": (5, 2, 3), "Rare Candy me01": (1, 1, 0),
                                    "Switch me01": (0, 0, 0)}
    # Another collector's Deck, a Storage Leaf and an unknown id are not this collector's Decks.
    other = collector()
    assert error(call("GET", f"{EDITIONS}?deck_id={deck}", other)) == "DECK_NOT_FOUND"
    assert call("GET", f"{EDITIONS}?deck_id={binder}", user).status_code == 404
    assert call("GET", f"{EDITIONS}?deck_id={uuid4()}", user).status_code == 404
    # Copies are the caller's own: the other collector sees none.
    assert {row["owned"] for row in browse(other, set_id="me01")["editions"]} == {0}


def test_a_printing_filter_lists_that_printings_active_editions_with_copies_and_regulation_mark():
    """The CardPopup's read (#174): one Card Printing's active Editions, each with the caller's copies (and with
    deck_id the copies in that Deck), the regulation mark and the Printing's Format Standing. A retired Edition is not
    listed; the popup takes it from the Printing detail instead."""
    seed({**BULBASAUR_ME, "variants": {"normal": True, "reverse": True, "holo": True}},
         *(record for record in CARDS if record is not BULBASAUR_ME))
    user = collector()
    binder = leaf(user)
    with connect() as conn:
        printing = str(conn.execute("SELECT id FROM catalog_printing WHERE source_id='me01-001'").fetchone()["id"])
        editions = {row["finish"]: str(row["id"]) for row in conn.execute(
            "SELECT id,descriptor->>'finish' AS finish FROM catalog_edition WHERE printing_id=%s", (printing,))}
    created = call("POST", "/api/decks", user, {"name": "Popup deck", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    assert add(user, binder, editions["reverse"], "2").status_code == 200
    assert add(user, deck, editions["reverse"], "1").status_code == 200

    page = browse(user, printing_id=printing)
    rows = {row["descriptor"]["finish"]: row for row in page["editions"]}
    assert set(rows) == {"normal", "reverse", "holo"} and page["matches"] == 3 and page["next_cursor"] is None
    assert {finish: row["owned"] for finish, row in rows.items()} == {"normal": 0, "reverse": 3, "holo": 0}
    assert {row["printing_id"] for row in rows.values()} == {printing}
    assert {row["regulation_mark"] for row in rows.values()} == {"I"}
    assert {row["standing"]["standard"]["status"] for row in rows.values()} == {"legal"}
    # Variant order within the Printing, the order the Printing detail lists its Editions in.
    with connect() as conn:
        ordered = [str(row["id"]) for row in conn.execute(
            "SELECT id FROM catalog_edition WHERE printing_id=%s ORDER BY descriptor_key,id", (printing,))]
    assert [row["edition_id"] for row in page["editions"]] == ordered
    in_deck = {row["descriptor"]["finish"]: (row["owned"], row["in_deck"], row["free"])
               for row in browse(user, printing_id=printing, deck_id=deck)["editions"]}
    assert in_deck == {"normal": (0, 0, 0), "reverse": (3, 1, 2), "holo": (0, 0, 0)}

    # A retired Edition has no row; an unknown Printing has none; a malformed id is refused.
    with connect() as conn:
        conn.execute("""UPDATE catalog_generation_edition SET active=false WHERE edition_id=%s
          AND generation_id=(SELECT active_generation FROM catalog_state)""", (editions["holo"],))
    assert {row["descriptor"]["finish"] for row in browse(user, printing_id=printing)["editions"]} == {
        "normal", "reverse"}
    assert browse(user, printing_id=str(uuid4()))["editions"] == []
    assert browse(user, printing_id="not-a-printing", expect=422)
    # Another collector sees the Printing's Editions with none of these copies.
    assert {row["owned"] for row in browse(collector(), printing_id=printing)["editions"]} == {0}


def test_an_identity_filter_lists_every_active_edition_of_one_card_identity():
    """The deck builder's "Swap this copy for" (#177): every active Edition of one Card Identity across its Printings
    (Professor's Research and its subtitled reprints), each with the caller's copies, and nothing of another Card
    Identity (Professor's Letter)."""
    seed(JUNIPER, MAGNOLIA, PLAIN, LETTER)
    user = collector()
    with connect() as conn:
        identity = str(conn.execute(
            "SELECT identity_id FROM catalog_printing WHERE source_id='sv01-189'").fetchone()["identity_id"])
        letter = str(conn.execute(
            "SELECT identity_id FROM catalog_printing WHERE source_id='fixture-letter-1'").fetchone()["identity_id"])
    created = call("POST", "/api/decks", user, {"name": "Swap deck", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    assert add(user, deck, edition_of("swsh1-178"), "1").status_code == 200
    assert add(user, leaf(user), edition_of("swsh1-178"), "2").status_code == 200

    page = browse(user, identity_id=identity, deck_id=deck)
    assert page["matches"] == 3 and page["next_cursor"] is None
    assert {(row["name"], row["set_id"], row["owned"], row["in_deck"], row["free"]) for row in page["editions"]} == {
        ("Professor's Research", "sv01", 0, 0, 0),
        ("Professor's Research (Professor Juniper)", "swsh4.5", 0, 0, 0),
        ("Professor's Research (Professor Magnolia)", "swsh1", 3, 1, 2)}
    # Another Card Identity's Editions, an unknown identity and a malformed id.
    assert names(user, identity_id=letter) == [("Professor's Letter", "fixture-letters", "1")]
    assert browse(user, identity_id=str(uuid4()))["editions"] == []
    assert browse(user, identity_id="not-an-identity", expect=422)


# ------------------------------------------------------------------ paging and stale cursors


def test_keyset_pages_of_sixty_and_a_409_when_a_revision_or_the_standing_key_changes(monkeypatch):
    promote({f"card-{i}": f"Pikachu {i:02d}" for i in range(1, 71)})  # 70 Printings, 71 Editions (card-1 has two)
    user = collector()
    pages = walk(user, q="pik")
    assert [len(page["editions"]) for page in pages] == [60, 11]
    assert pages[0]["matches"] == 71 and pages[1]["matches"] is None and pages[1]["printings"] is None
    ids = [row["edition_id"] for page in pages for row in page["editions"]]
    assert len(set(ids)) == 71
    listed = [(row["name"], row["edition_id"]) for page in pages for row in page["editions"]]
    assert [name for name, _ in listed] == sorted(name for name, _ in listed)
    assert [row["name"] for row in browse(user, set_id="fixture")["editions"]][:3] == [
        "Pikachu 01", "Pikachu 01", "Pikachu 02"]  # collector number order within a set

    first = browse(user, q="pik")
    cursor = first["next_cursor"]
    # Another query's cursor, and a forged one, are refused.
    assert error(call("GET", f"{EDITIONS}?q=pika&cursor={cursor}", user)) == "INVALID_CURSOR"
    assert error(call("GET", f"{EDITIONS}?q=pik&printing_id={uuid4()}&cursor={cursor}", user)) == "INVALID_CURSOR"
    assert error(call("GET", f"{EDITIONS}?q=pik&identity_id={uuid4()}&cursor={cursor}", user)) == "INVALID_CURSOR"
    assert call("GET", f"{EDITIONS}?q=pik&cursor={cursor[:-2]}xx", user).status_code == 400
    # The owner revision moved: start again.
    binder = leaf(user)
    assert add(user, binder, ids[0], "1").status_code == 200
    stale = call("GET", f"{EDITIONS}?q=pik&cursor={cursor}", user)
    assert (stale.status_code, error(stale)) == (409, "INVENTORY_CHANGED")
    # The catalog revision moved.
    cursor = browse(user, q="pik")["next_cursor"]
    with connect() as conn:
        conn.execute("UPDATE catalog_state SET revision=revision+1")
    stale = call("GET", f"{EDITIONS}?q=pik&cursor={cursor}", user)
    assert (stale.status_code, error(stale)) == (409, "CATALOG_CHANGED")
    # Only one Format's standing key moved (a Gym Leader Challenge rules deploy): a Standard-filtered walk restarts
    # too, because every row carries all three standings.
    cursor = browse(user, q="pik", format="standard")["next_cursor"]
    rules = evaluator.format_rules
    monkeypatch.setattr(evaluator, "format_rules", lambda name: dataclasses.replace(rules(name), sha256="f" * 64)
                        if name == "glc" else rules(name))
    stale = call("GET", f"{EDITIONS}?q=pik&format=standard&cursor={cursor}", user)
    assert (stale.status_code, error(stale)) == (409, "CATALOG_CHANGED")
    restarted = browse(user, q="pik", format="standard")
    assert len(restarted["editions"]) == 60
    assert len(browse(user, q="pik", format="standard", cursor=restarted["next_cursor"])["editions"]) == 11


def test_busy_standings_answer_503_and_a_reader_retries_once_while_the_request_is_young(monkeypatch):
    seed(*CARDS)
    user = collector()
    calls = []
    ensure = format_standing.ensure_current

    def counted(*args, **kwargs):
        calls.append(1)
        return ensure(*args, **kwargs)

    def busy(*args, **kwargs):
        raise format_standing.StandingBusy("held")

    monkeypatch.setattr(format_standing, "ensure_current", busy)
    response = call("GET", EDITIONS, user)
    assert (response.status_code, error(response)) == (503, "FORMAT_STANDING_BUSY")

    # A commit made the standings stale between ensure_current and the snapshot, once: the reader makes them current
    # again and answers.
    monkeypatch.setattr(format_standing, "ensure_current", counted)
    keys = format_standing.current_keys
    stale_once = [True]
    monkeypatch.setattr(format_standing, "current_keys",
                        lambda conn, *a, **k: None if stale_once and stale_once.pop() else keys(conn))
    assert len(browse(user)["editions"]) == len(CARDS) and len(calls) == 2
    # Stale every time: one retry, then 503.
    calls.clear()
    monkeypatch.setattr(format_standing, "current_keys", lambda conn, *a, **k: None)
    response = call("GET", EDITIONS, user)
    assert (response.status_code, error(response), len(calls)) == (503, "FORMAT_STANDING_BUSY", 2)
    # No retry once the request is older than RETRY_WITHIN_S, so the proxy never times out first.
    calls.clear()
    from app import catalog_browse
    monkeypatch.setattr(catalog_browse, "RETRY_WITHIN_S", 0.0)
    response = call("GET", EDITIONS, user)
    assert (response.status_code, len(calls)) == (503, 1)


# ------------------------------------------------------------------ one source for card type


def test_one_reviewed_trainer_type_correction_moves_the_kind_filter_collections_filter_and_the_format_result():
    """The spec's "Card attributes" test. One attribute decision corrects Switch, whose source gives no Trainer Type, to
    an Item with regulation mark G. Trainer Type is not a Format Standing input, so the decision also corrects a
    standing input (mark G rotated out of Standard on 2026-04-10): in the same attribute revision the browse route's
    Item chip gains Switch and its Standard chip drops it, Collection's Item filter gains it, the Deck format check turns
    not legal, and a browse cursor from before the decision restarts."""
    found = seed(*CARDS, *FILLERS)
    switch = found["me01-130"]
    user = collector()
    assert add(user, leaf(user), edition_of("me01-130"), "1").status_code == 200
    owner, deck = deck_with([("me01-001", 1), ("me01-125", 4), ("me01-130", 4), ("sv02-278", 51)])
    assert standard(owner, deck, AS_OF.isoformat())["status"] == "legal"

    def collection(**params):
        query = "&".join(f"{key}={value}" for key, value in params.items())
        response = call("GET", f"/api/collection/holdings?{query}", user)
        assert response.status_code == 200, response.text
        return [row["printing_name"] for row in response.json()["holdings"]]

    assert "Switch" not in [row[0] for row in names(user, kind="item")]
    assert [row[0] for row in names(user, q="switch", format="standard")] == ["Switch"]
    assert collection(trainer_type="item") == []
    cursor = browse(user)["next_cursor"]  # a walk of the whole catalog, begun before the decision
    assert cursor

    response = decide(switch, correction={"trainer_type": "item", "regulation_mark": "G"})
    assert response.status_code == 200, response.text
    assert response.json()["effective"]["trainer_type"] == "item"

    assert "Switch" in [row[0] for row in names(user, kind="item")]
    assert names(user, q="switch", format="standard") == []
    [row] = browse(user, q="switch")["editions"]
    assert (row["trainer_type"], row["standing"]["standard"]["status"]) == ("item", "not_legal")
    assert collection(trainer_type="item") == ["Switch"]
    assert standard(owner, deck, AS_OF.isoformat())["status"] == "not_legal"
    stale = call("GET", f"{EDITIONS}?cursor={cursor}", user)
    assert (stale.status_code, error(stale)) == (409, "CATALOG_CHANGED")


# A main set and its Trainer Gallery, which inherits its code; Gym Heroes, whose code G1 is Generations' TCGdex set ID.
CODED = (card(id="swsh9-001", name="Brilliant Rowlet", localId="001", category="Pokemon",
              set={"id": "swsh9", "name": "Brilliant Stars"}),
         card(id="swsh9tg-TG01", name="Gallery Flareon", localId="TG01", category="Pokemon",
              set={"id": "swsh9tg", "name": "Brilliant Stars Trainer Gallery"}),
         card(id="gym1-5", name="Gym Heroes Card", localId="5", category="Pokemon",
              set={"id": "gym1", "name": "Gym Heroes"}),
         card(id="g1-5", name="Generations Card", localId="5", category="Pokemon",
              set={"id": "g1", "name": "Generations"}),
         card(id="fixture-zz-1", name="Uncoded Card", localId="1", category="Pokemon",
              set={"id": "fixturezz", "name": "Fixture Zubats"}))


def test_printed_codes_show_and_search_and_a_set_without_one_falls_back_to_its_tcgdex_id():
    reset_catalog()
    run(Records(*CODED))
    user = collector()
    shown = {row["name"]: row["set_code"] for row in browse(user)["editions"]}
    assert shown == {"Brilliant Rowlet": "BRS", "Gallery Flareon": "BRS", "Gym Heroes Card": "G1",
                     "Generations Card": "GEN", "Uncoded Card": "fixturezz"}
    # A code its subset inherits searches both sets; zeros after a number's letters don't count.
    assert names(user, q="BRS%201") == [("Brilliant Rowlet", "swsh9", "001")]
    assert names(user, q="brs%20tg1") == [("Gallery Flareon", "swsh9tg", "TG01")]
    assert browse(user, q="brs%20tg1")["search"]["set_code"] == "BRS"
    # A printed code wins over a TCGdex set ID that reads the same.
    assert names(user, q="g1%205") == [("Gym Heroes Card", "gym1", "5")]
    assert names(user, q="gen%205") == [("Generations Card", "g1", "5")]
    # A set without a code searches by its TCGdex set ID.
    page = browse(user, q="FIXTUREZZ%201")
    assert page["search"]["set_code"] == "fixturezz" and [row["name"] for row in page["editions"]] == ["Uncoded Card"]
    # A known code whose sets aren't in the catalog is a name search.
    assert browse(user, q="pal%20185")["search"]["mode"] == "name"
    sets = {entry["set_id"]: entry["set_code"] for entry in call("GET", "/api/catalog/sets", user).json()["sets"]}
    assert sets == {"swsh9": "BRS", "swsh9tg": "BRS", "gym1": "G1", "g1": "GEN", "fixturezz": "fixturezz"}


def test_a_name_starting_with_a_set_code_is_a_name_search_unless_the_number_matches():
    reset_catalog()
    run(Records(card(id="sv03.5-1", name="Mew", localId="1", category="Pokemon",
                     set={"id": "sv03.5", "name": "151"}),
                card(id="sv03.5-2", name="Mew ex", localId="2", category="Pokemon",
                     set={"id": "sv03.5", "name": "151"})))
    user = collector()
    page = browse(user, q="mew%20ex")
    assert page["search"]["mode"] == "name" and [row["name"] for row in page["editions"]] == ["Mew ex"]
    page = browse(user, q="mew%201")
    assert page["search"]["mode"] == "set_number" and [row["name"] for row in page["editions"]] == ["Mew"]
    assert browse(user, q="sv03.5%20ex")["search"]["mode"] == "name"


def test_a_name_search_finds_the_words_anywhere_in_a_name_ignoring_accents_spaces_and_punctuation():
    reset_catalog()
    run(Records(*NAMED))
    user = collector()

    def found(q):
        page = browse(user, q=q)
        assert page["search"]["mode"] == "name", (q, page["search"])
        return sorted(row["name"] for row in page["editions"])

    assert found("juniper") == ["Professor's Research (Professor Juniper)"]
    assert found("zard") == ["Charizard"]
    assert found("char") == ["Charizard", "Charmander"]  # part of no other name: never Chatot
    assert found("pokemon") == found("POK%C3%89MON") == ["Pokémon Center Lady"]
    assert found("farfetchd") == found("farfetch%27d") == found("farfetch%E2%80%99d") == ["Farfetch’d"]
    assert found("porygonz") == found("porygon%20z") == found("porygon-z") == ["Porygon-Z"]
    assert found("mr%20mime") == found("mr.%20mime") == found("mrmime") == ["Mr. Mime"]
    assert (found("boss%20orders") == found("boss%27s%20orders") == found("bosss%20orders")
            == found("boss%E2%80%99s") == ["Boss's Orders"])
    assert browse(user, q="%20Mr.%20%20Mime")["search"]["text"] == "mr. mime"  # trimmed, collapsed, case folded
    assert found("%21%21%21") == []  # no letters or digits: no name contains it


def test_a_name_no_card_has_lists_close_spellings_and_says_so():
    reset_catalog()
    run(Records(*NAMED))
    user = collector()
    page = browse(user, q="charzard")
    assert page["search"] == {"mode": "fuzzy", "text": "charzard", "set_id": None, "set_name": None,
                              "set_code": None, "number": None}
    assert [row["name"] for row in page["editions"]] == ["Charizard"] and page["matches"] == 1
    page = browse(user, q="gardivoir")
    assert page["search"]["mode"] == "fuzzy" and [row["name"] for row in page["editions"]] == ["Gardevoir"]
    # Under five letters, or far from every name, a search never reads as a close spelling.
    for q in ("chaz", "zzzzzzzz"):
        page = browse(user, q=q)
        assert (page["search"]["mode"], page["editions"]) == ("name", []), q
    # The filters narrow close spellings like any rows; with none left the search reads as a name search.
    assert browse(user, q="charzard", kind="pokemon")["search"]["mode"] == "fuzzy"
    page = browse(user, q="charzard", kind="supporter")
    assert (page["search"]["mode"], page["editions"]) == ("name", [])
    # Whether a name exists asks the whole catalog: a name the collector owns no copy of is no misspelling.
    page = browse(user, q="charizard", owned="true")
    assert (page["search"]["mode"], page["editions"]) == ("name", [])
    page = browse(user, q="charzard", owned="true")
    assert (page["search"]["mode"], page["editions"]) == ("name", [])
    assert add(user, leaf(user), edition_of("fixture-names-1"), "1").status_code == 200
    page = browse(user, q="charzard", owned="true")
    assert page["search"]["mode"] == "fuzzy" and [row["name"] for row in page["editions"]] == ["Charizard"]


def test_close_spelling_pages_keep_their_mode_and_a_name_that_appears_restarts_the_walk():
    promote({f"card-{i}": f"Charizard {i:02d}" for i in range(1, 71)})  # 70 Printings, 71 Editions (card-1 has two)
    user = collector()
    pages = walk(user, q="charzard")
    assert [len(page["editions"]) for page in pages] == [60, 11]
    assert {page["search"]["mode"] for page in pages} == {"fuzzy"}
    assert len({row["edition_id"] for page in pages for row in page["editions"]}) == 71
    cursor = pages[0]["next_cursor"]
    # A listed name now contains the words typed, so the search reads as a name search: the walk restarts even
    # though, as here, the catalog revision did not move.
    with connect() as conn:
        conn.execute("""UPDATE catalog_generation_printing SET display_name='Charzard Prime'
          WHERE generation_id=(SELECT active_generation FROM catalog_state) AND display_name='Charizard 70'""")
    stale = call("GET", f"{EDITIONS}?q=charzard&cursor={cursor}", user)
    assert (stale.status_code, error(stale)) == (409, "CATALOG_CHANGED")
    page = browse(user, q="charzard")
    assert page["search"]["mode"] == "name" and [row["name"] for row in page["editions"]] == ["Charzard Prime"]


def test_a_retired_edition_has_no_tile():
    seed(*CARDS)
    user = collector()
    with connect() as conn:
        conn.execute("""UPDATE catalog_generation_edition SET active=false WHERE edition_id=%s
          AND generation_id=(SELECT active_generation FROM catalog_state)""", (edition_of("me01-001"),))
    assert names(user, q="bulbasaur") == []
    assert len(browse(user)["editions"]) == len(CARDS) - 1


class DatedRecords(Records):
    """A catalog source that, like TCGdexSource, gives each set's release date and series (None or absent: TCGdex gives
    none). ``series`` maps a set ID to a (series id, series name) pair."""

    def __init__(self, dates, *records, series=None):
        super().__init__(*records)
        self.dates = dates
        self.series = series or {}

    def set_details(self, set_ids):
        found = {set_id: SetDetails(self.dates.get(set_id), *self.series.get(set_id, (None, None)))
                 for set_id in set_ids}
        return {set_id: value for set_id, value in found.items() if value.release_date or value.series_id}


def numbered(set_id, set_name, count, name="Card"):
    return tuple(card(id=f"{set_id}-{i}", name=f"{name} {i:02d}", localId=str(i), category="Pokemon",
                      set={"id": set_id, "name": set_name}) for i in range(1, count + 1))


def test_newest_set_first_in_natural_number_order_and_an_undated_set_last():
    reset_catalog()
    # Imported dates win over the rules files (me01 is dated 2025-09-26 there, sv01 2023-03-31).
    dates = {"me01": date(2020, 1, 1), "sv01": date(2024, 6, 1), "zzfresh": date(2026, 9, 1)}
    run(DatedRecords(dates, *numbered("sv01", "Scarlet & Violet", 10, "Violet"), *numbered("me01", "Mega Evolution", 2),
                     *numbered("zzfresh", "Fresh Set", 2, "Fresh"), *numbered("zundated", "Undated Set", 2, "Old")))
    with connect() as conn:
        stored = {row["set_id"]: row["release_date"] for row in conn.execute(
            "SELECT set_id,release_date FROM catalog_generation_set").fetchall()}
    assert stored == dates
    user = collector()
    listed = [(row[1], row[2]) for row in names(user)]
    assert listed == [("zzfresh", "1"), ("zzfresh", "2"), *[("sv01", str(i)) for i in range(1, 11)],
                      ("me01", "1"), ("me01", "2"), ("zundated", "1"), ("zundated", "2")]
    # A name search keeps newest set first.
    assert [row[1] for row in names(user, q="violet%200")] == ["sv01"] * 9
    # A set filter lists that set alone, in number order.
    assert [row[2] for row in names(user, set_id="sv01")] == [str(i) for i in range(1, 11)]


def test_a_catalog_imported_before_set_dates_orders_by_the_rules_files():
    reset_catalog()
    run(Records(*numbered("sv01", "Scarlet & Violet", 1), *numbered("me01", "Mega Evolution", 1),
                *numbered("zundated", "Undated Set", 1)))
    user = collector()
    assert [row[1] for row in names(user)] == ["me01", "sv01", "zundated"]


def test_keyset_pages_cross_a_set_boundary_and_reach_undated_sets():
    reset_catalog()
    run(DatedRecords({"zznew": date(2026, 1, 1), "zzold": date(2010, 1, 1)},
                     *numbered("zznew", "New Set", 61, "New"), *numbered("zzold", "Old Set", 5, "Old"),
                     *numbered("zzundated", "Undated Set", 3, "Undated")))
    user = collector()
    pages = walk(user)
    assert [len(page["editions"]) for page in pages] == [60, 9]
    listed = [(row["set_id"], row["collector_number"]) for page in pages for row in page["editions"]]
    assert listed == ([("zznew", str(i)) for i in range(1, 62)] + [("zzold", str(i)) for i in range(1, 6)]
                      + [("zzundated", str(i)) for i in range(1, 4)])
    # A cursor still restarts when the catalog moves.
    with connect() as conn:
        conn.execute("UPDATE catalog_state SET revision=revision+1")
    stale = call("GET", f"{EDITIONS}?cursor={pages[0]['next_cursor']}", user)
    assert (stale.status_code, error(stale)) == (409, "CATALOG_CHANGED")


def test_tcgdex_set_details_are_best_effort():
    source = TCGdexSource()

    def answer(request):
        set_id = request.url.path.rsplit("/", 1)[1]
        if set_id == "good":
            return httpx.Response(200, json={"id": "good", "releaseDate": "2024-11-08",
                                             "serie": {"id": "sv", "name": "Scarlet & Violet"}})
        if set_id == "bad-date":
            return httpx.Response(200, json={"id": "bad-date", "releaseDate": "2024/11/08",
                                             "serie": {"id": "sv", "name": "Scarlet & Violet"}})
        if set_id == "no-serie":
            return httpx.Response(200, json={"id": "no-serie", "releaseDate": "2020-02-07"})
        if set_id == "bad-serie":
            return httpx.Response(200, json={"id": "bad-serie", "releaseDate": "2020-02-07",
                                             "serie": {"id": 7, "name": "Seven"}})
        if set_id == "blank-serie":
            return httpx.Response(200, json={"id": "blank-serie", "serie": {"id": "xy", "name": "  "}})
        if set_id == "serie-not-object":
            return httpx.Response(200, json={"id": "serie-not-object", "serie": "xy"})
        if set_id == "nul-name":
            return httpx.Response(200, json={"id": "nul-name", "serie": {"id": "xy", "name": "X\x00Y"}})
        if set_id == "long-name":
            return httpx.Response(200, json={"id": "long-name", "serie": {"id": "xy", "name": "x" * 201}})
        if set_id == "long-id":
            return httpx.Response(200, json={"id": "long-id", "serie": {"id": "x" * 129, "name": "XY"}})
        if set_id == "nothing":
            return httpx.Response(200, json={"id": "nothing"})
        if set_id == "wrong-id":
            return httpx.Response(200, json={"id": "other", "releaseDate": "2024-11-08",
                                             "serie": {"id": "sv", "name": "Scarlet & Violet"}})
        if set_id == "broken":
            raise httpx.ConnectError("down")
        return httpx.Response(404)

    source.client = httpx.Client(transport=httpx.MockTransport(answer))
    ids = ["good", "bad-date", "no-serie", "bad-serie", "blank-serie", "serie-not-object", "nul-name", "long-name", "long-id", "nothing", "wrong-id",
           "broken", "missing"]
    assert source.set_details(ids) == {
        "good": SetDetails(date(2024, 11, 8), "sv", "Scarlet & Violet"),
        "bad-date": SetDetails(None, "sv", "Scarlet & Violet"),  # a series without a date still has a row
        "no-serie": SetDetails(date(2020, 2, 7), None, None),
        "bad-serie": SetDetails(date(2020, 2, 7), None, None)}


def test_an_import_stores_each_sets_series_and_the_sets_endpoint_returns_it_with_the_release_date():
    reset_catalog()
    sv, ssh = ("sv", "Scarlet & Violet"), ("swsh", "Sword & Shield")
    run(DatedRecords({"sv01": date(2023, 3, 31), "swsh2": None},
                     *numbered("sv01", "Scarlet & Violet", 2, "Violet"), *numbered("swsh2", "Rebel Clash", 1, "Clash"),
                     *numbered("zundated", "Undated Set", 1, "Old"), series={"sv01": sv, "swsh2": ssh}))
    with connect() as conn:
        stored = {row["set_id"]: (row["release_date"], row["series_id"], row["series_name"]) for row in conn.execute(
            "SELECT set_id,release_date,series_id,series_name FROM catalog_generation_set").fetchall()}
    # A series with no valid date has a row with a null date; a set with neither has no row.
    assert stored == {"sv01": (date(2023, 3, 31), "sv", "Scarlet & Violet"), "swsh2": (None, "swsh", "Sword & Shield")}
    sets = call("GET", "/api/catalog/sets", collector()).json()["sets"]
    rules = dict(zip(*_rules_release_dates()))
    assert rules.get("swsh2") and "zundated" not in rules
    assert [(entry["set_id"], entry["series_id"], entry["series_name"], entry["release_date"]) for entry in sets] == [
        ("swsh2", "swsh", "Sword & Shield", rules["swsh2"].isoformat()),  # no stored date: the rules files' date
        ("sv01", "sv", "Scarlet & Violet", "2023-03-31"),  # the stored date wins
        ("zundated", None, None, None)]  # still A-Z by set name; a set with neither returns nulls


def test_a_catalog_imported_before_set_series_returns_null_series_and_the_rules_files_dates():
    reset_catalog()
    run(Records(*numbered("sv01", "Scarlet & Violet", 1), *numbered("zundated", "Undated Set", 1)))
    sets = call("GET", "/api/catalog/sets", collector()).json()["sets"]
    assert [(entry["set_id"], entry["series_id"], entry["series_name"], entry["release_date"]) for entry in sets] == [
        ("sv01", None, None, dict(zip(*_rules_release_dates()))["sv01"].isoformat()), ("zundated", None, None, None)]


def test_migration_044_creates_an_empty_table_and_runs_again():
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    name = "tcg_set_release_" + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before="044_catalog_set_release.sql")
        with psycopg.connect(url) as conn:
            revisions = conn.execute("""SELECT (SELECT revision FROM catalog_state),
              (SELECT revision FROM catalog_attribute_state)""").fetchone()
            generation = conn.execute("""INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256)
              VALUES (gen_random_uuid(),0,'',repeat('0',64)) RETURNING id""").fetchone()[0]
        migrate(url)
        with psycopg.connect(url) as conn:
            assert conn.execute("SELECT count(*) FROM catalog_generation_set").fetchone()[0] == 0
            assert conn.execute("""SELECT (SELECT revision FROM catalog_state),
              (SELECT revision FROM catalog_attribute_state)""").fetchone() == revisions
            conn.execute("INSERT INTO catalog_generation_set VALUES (%s,'sv08','2024-11-08')", (generation,))
            conn.execute((ROOT_MIGRATIONS / "044_catalog_set_release.sql").read_text())  # runs again
            assert conn.execute("SELECT count(*) FROM catalog_generation_set").fetchone()[0] == 1
            conn.execute("DELETE FROM catalog_generation WHERE id=%s", (generation,))
            assert conn.execute("SELECT count(*) FROM catalog_generation_set").fetchone()[0] == 0
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))


def test_migration_155_keeps_a_dated_row_adds_the_series_columns_and_runs_again():
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    name = "tcg_set_series_" + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before="155_set_series.sql")
        with psycopg.connect(url) as conn:
            revisions = conn.execute("""SELECT (SELECT revision FROM catalog_state),
              (SELECT revision FROM catalog_attribute_state)""").fetchone()
            generation = conn.execute("""INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256)
              VALUES (gen_random_uuid(),0,'',repeat('0',64)) RETURNING id""").fetchone()[0]
            conn.execute("INSERT INTO catalog_generation_set VALUES (%s,'sv08','2024-11-08')", (generation,))
        migrate(url)
        with psycopg.connect(url) as conn:
            assert conn.execute("SELECT set_id,release_date,series_id,series_name FROM catalog_generation_set"
                                ).fetchall() == [("sv08", date(2024, 11, 8), None, None)]
            assert conn.execute("""SELECT (SELECT revision FROM catalog_state),
              (SELECT revision FROM catalog_attribute_state)""").fetchone() == revisions
            conn.execute("INSERT INTO catalog_generation_set VALUES (%s,'sv09',NULL,'sv','Scarlet & Violet')", (generation,))
            for bad in ("'x',NULL,NULL,NULL",  # says nothing
                        "'x','2024-01-01','sv',NULL", "'x','2024-01-01',NULL,'Name'",  # half a series
                        "'x',NULL,'sv',''"):
                with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
                    conn.execute(f"INSERT INTO catalog_generation_set VALUES (%s,{bad})", (generation,))
            conn.execute((ROOT_MIGRATIONS / "155_set_series.sql").read_text())  # runs again
            assert conn.execute("SELECT count(*) FROM catalog_generation_set").fetchone()[0] == 2
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))


def _fixture_printing(conn, identity, generation, number, display):
    printing = conn.execute("INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',%s) RETURNING id",
                            (identity,)).fetchone()[0]
    conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,
      collector_number,display_name,search_name,source_fingerprint,basic_energy)
      VALUES (%s,%s,%s,'fixture','Fixture Set',%s,%s,%s,'manual','unresolved')""",
                 (generation, printing, f"manual:{number}", number, display, display.casefold()))


def test_migration_048_fills_the_search_columns_for_existing_and_new_printings_and_runs_again():
    admin = os.environ.get("RECOVERY_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server")
    name = "tcg_name_search_" + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    columns = ("SELECT search_words,search_key,search_key_bare FROM catalog_generation_printing"
               " WHERE collector_number=%s")
    try:
        migrate(url, before="048_catalog_name_search.sql")
        with psycopg.connect(url) as conn:
            identity = conn.execute("""INSERT INTO catalog_identity(identity_key,display_name)
              VALUES ('fixture','Fixture') RETURNING id""").fetchone()[0]
            generation = conn.execute("""INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256)
              VALUES (gen_random_uuid(),0,'',repeat('0',64)) RETURNING id""").fetchone()[0]
            _fixture_printing(conn, identity, generation, "1", "Boss’s Orders")
            revision = conn.execute("SELECT revision FROM catalog_state").fetchone()[0]
        migrate(url)
        with psycopg.connect(url) as conn:
            # Existing rows are filled as the migration runs; it moves no revision.
            assert conn.execute(columns, ("1",)).fetchone() == ("bosss orders", "bosssorders", "bossorders")
            assert conn.execute("SELECT revision FROM catalog_state").fetchone()[0] == revision
            # Every later insert is filled by the database, though the writer names no search column.
            _fixture_printing(conn, identity, generation, "2", "Porygon-Z")
            assert conn.execute(columns, ("2",)).fetchone() == ("porygon z", "porygonz", "porygonz")
            assert conn.execute("SELECT catalog_search_words(%s)", ("Flabébé  Mr. Mime ♀",)).fetchone()[0] == \
                "flabebe mr mime"
            conn.execute((ROOT_MIGRATIONS / "048_catalog_name_search.sql").read_text())  # runs again
            assert conn.execute(columns, ("1",)).fetchone() == ("bosss orders", "bosssorders", "bossorders")
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
