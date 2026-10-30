"""Collection Import's filters (#231; spec "Matching": filters run first): watchlist rows, sealed product, other games
and non-English cards are left out with their reason, counted by reason in the summary with a few of each, listed by
no filter, changed by no change, saved never, and downloaded in the file's own columns. They still count toward the
10,000-row cap. Graded rows are ordinary copies.

The fixtures are reconstructions that keep the research exports' edge cases (C2's watchlist, (JP) and (CN) tags,
another game and sealed product; P1's Japanese and Chinese consoles, a box and a basketball card; D1's Japan-only sets
labelled English), with test_collection_import's seed_import_catalog:

- collectr-left-out.csv: 13 rows. Kept: Starmie 3, a CGC Wigglytuff, an unnumbered Water Energy with no rarity (a
  Basic Energy is never sealed) and a PSA Dark Golduck under the "Pokémon" category. Left out: two watchlist rows (one
  also another game), (JP) and (CN) tags, (JP) on a row with no number (non-English comes before sealed), Magic, a
  booster pack and an Elite Trainer Box (by name, one with a rarity) and a box with neither number nor rarity.
- pricecharting-left-out.csv: 7 rows. Kept: Starmie, a CGC Wigglytuff and an unnumbered Psychic Energy (PriceCharting
  has no rarity column, so its blank rarity means nothing). Left out: Chinese and Japanese consoles, a booster box and a
  basketball card.
- dragon-shield-left-out.csv: 5 rows. Kept: Starmie 2. Left out: Japan-only sets by code (any case) or by name alone,
  and a Japanese language.
"""
import csv
import io
from pathlib import Path

from app.games.pokemon.imports import collection_import_matcher as matcher
from app.main import connect  # first: app.main imports the routers, and they import it
from test_batch_add import held
from test_collection_import import (FOURTEEN, HEADER_12, all_rows, code, collector, edition, rows, save,
                                    seed_import_catalog, started, upload)
from test_collection_import_finishes import change
from test_holdings import call

FIXTURES = Path(__file__).parent / "collection_import_fixtures"
COLLECTR = (FIXTURES / "collectr-left-out.csv").read_bytes()
PRICECHARTING = (FIXTURES / "pricecharting-left-out.csv").read_bytes()
DRAGON_SHIELD = (FIXTURES / "dragon-shield-left-out.csv").read_bytes()
SORTED_HEADER = ("List Type,List Name,Collection,Format,Board,Quantity,Card Name,Set Code,Set Name,Card Number,"
                 "Condition,Printing,Rarity,Language,Price Bought,Date Bought,Parent List Type,Parent List Name,"
                 "Current Price (tcgplayer_marketsellprice),List Cover Image,Parent List Cover Image")
TCG_COLLECTOR_HEADER = ("TCG region,Expansion,Card number,Card number sorting order,Card name,Rarity,Card variant,"
                        "Card language,Card condition,Note,Quantity")


def reasons(import_id):
    """Each stored row's left-out reason, in row order (None for a kept row)."""
    with connect() as conn:
        return [row["left_out_reason"] for row in conn.execute(
            "SELECT left_out_reason FROM collection_import_row WHERE import_id=%s ORDER BY row_number",
            (import_id,))]


def left_out(summary):
    """The summary's left-out entries as (reason, rows, [(name, set, number)])."""
    return [(entry["reason"], entry["rows"], [(example["name"], example["set_name"], example["number"])
                                              for example in entry["examples"]])
            for entry in summary["left_out"]]


def listed(owner, import_id):
    return [row["row_number"] for row in all_rows(owner, import_id)]


def download(owner, import_id, name="left-out.csv"):
    return call("GET", f"/api/collection-imports/{import_id}/{name}", owner)


def test_collectr_rows_are_left_out_for_each_reason_in_order_and_graded_rows_are_kept():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, COLLECTR)
    assert reasons(summary["id"]) == [None, None, "watchlist", "not_english", "not_english", "other_game", "sealed",
                                      "sealed", "sealed", None, None, "watchlist", "not_english"]
    # counts.rows is every row of the file; the other counts leave the left-out rows out.
    assert summary["counts"] == {"rows": 13, "needs_you": 0, "ready": 4, "finish_unknown": 0, "by_name": 0,
                                 "skipped": 0}
    assert summary["cards_to_add"] == "11"
    assert left_out(summary) == [
        ("watchlist", 2, [("Wartortle", "Base Set", "042/102"), ("Roronoa Zoro", "Romance Dawn", "OP01-025")]),
        ("other_game", 1, [("Llanowar Elves", "Dominaria", "168")]),
        ("not_english", 3, [("Starmie (JP)", "Base Set", "064/102"), ("Poké Ball (CN)", "Jungle", "064/064"),
                            ("Weepinbell (JP)", "Jungle", "")]),
        ("sealed", 3, [("Jungle Booster Pack", "Jungle", ""),
                       ("Team Rocket Returns Elite Trainer Box", "Team Rocket Returns", ""),
                       ("Charizard Figure Box", "Base Set", "")])]
    # A watchlist row's blank quantity stays blank in its example.
    assert summary["left_out"][0]["examples"][0]["quantity"] == ""
    for filter_ in ("all", "needs", "finish", "name", "skipped"):
        assert all(row["row_number"] in (1, 2, 10, 11) for row in all_rows(owner, summary["id"], filter_))
    found = all_rows(owner, summary["id"])
    assert [(row["row_number"], row["status"], row["quantity"]) for row in found] == [
        (1, "matched", "3"), (2, "matched", "1"), (10, "matched", "6"), (11, "matched", "1")]
    assert [row["edition"]["edition_id"] for row in found] == [
        edition("base1-64", "normal"), edition("base2-32", "holo"), edition("base1-102", "normal"),
        edition("ex7-35", "reverse")]
    # The graded rows are ordinary copies: their grade is never in a response, and they are saved.
    current = call("GET", "/api/collection-imports/current", owner).text
    for hidden in ("CGC", "PSA", "graded", "1,210.00", "Unconfirmed"):
        assert hidden not in current and hidden not in rows(owner, summary["id"]).text
    response = save(owner, summary["id"])
    assert response.status_code == 200 and response.json()["copy_count"] == "11", response.text
    assert held(owner, unsorted) == {edition("base1-64", "normal"): "3", edition("base2-32", "holo"): "1",
                                     edition("base1-102", "normal"): "6", edition("ex7-35", "reverse"): "1"}


def test_pricecharting_consoles_and_dragon_shield_japan_only_sets_are_left_out():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, PRICECHARTING)
    assert reasons(summary["id"]) == [None, None, "not_english", "not_english", "sealed", None, "other_game"]
    assert summary["counts"] == {"rows": 7, "needs_you": 0, "ready": 3, "finish_unknown": 0, "by_name": 0,
                                 "skipped": 0}
    assert summary["cards_to_add"] == "5"
    assert left_out(summary) == [
        ("other_game", 1, [("LeBron James", "Basketball Cards 2003 Topps", "23")]),
        ("not_english", 2, [("Poke Ball", "Chinese Jungle", "64"), ("Wartortle", "Japanese Base Set", "42")]),
        ("sealed", 1, [("Booster Box", "Team Rocket Returns", "")])]
    # An Energy with no number is matched by its type, not left out as sealed.
    assert [(row["row_number"], row["card"]["name"]) for row in all_rows(owner, summary["id"])] == [
        (1, "Starmie"), (2, "Wigglytuff"), (6, "Psychic Energy")]

    summary = started(owner, unsorted, DRAGON_SHIELD)
    assert reasons(summary["id"]) == [None, "not_english", "not_english", "not_english", "not_english"]
    assert summary["counts"] == {"rows": 5, "needs_you": 0, "ready": 1, "finish_unknown": 0, "by_name": 0,
                                 "skipped": 0}
    assert left_out(summary) == [("not_english", 4, [("Crobat V", "Shiny Star V", "047 / 190"),
                                                     ("Urshifu VMAX", "Single Strike Master", "040 / 070"),
                                                     ("Clefable", "Rebellion Crash", "040 / 096")])]

    # Sorted, Dragon Shield's successor, reads the same Japan-only codes and its own two-letter languages.
    sorted_rows = "\n".join([
        SORTED_HEADER,
        "Folder,Binder A,pok,,,1,Starmie,BS,Base Set,064,NearMint,Normal,Common,en,0.16,2026-08-31,,,0.48,1,",
        "Folder,Binder A,pok,,,1,Crobat V,S4A,Shiny Star V,047,NearMint,Normal,Rare,en,4.00,2026-08-31,,,4.10,1,",
        "Folder,Binder A,pok,,,1,Starmie,BS,Base Set,064,NearMint,Normal,Common,jp,0.16,2026-08-31,,,0.48,1,", ""])
    summary = started(owner, unsorted, sorted_rows.encode())
    assert reasons(summary["id"]) == [None, "not_english", "not_english"]
    # TCG Collector's language column, and a loose file's Game and Language columns.
    collector_rows = "\r\n".join([
        TCG_COLLECTOR_HEADER,
        "International,Base Set,064/102,64,Starmie,Common,Non-holo,English,Near Mint,,1",
        "Japan,Base Set,064/102,64,Starmie,Common,Non-holo,Japanese,Near Mint,,1", ""])
    summary = started(owner, unsorted, collector_rows.encode())
    assert reasons(summary["id"]) == [None, "not_english"]
    loose = b"Game,Set,Number,Language,Qty\nPokemon,Base Set,64,EN,1\nLorcana,The First Chapter,1,English,1\n" \
            b"Pokemon,Base Set,64,German,1\n"
    summary = started(owner, unsorted, loose)
    assert reasons(summary["id"]) == [None, "other_game", "not_english"]


def test_a_blank_number_is_sealed_only_with_a_sealed_name_or_a_blank_rarity_the_file_has_a_column_for():
    seed_import_catalog()
    owner, unsorted = collector()
    # The TCGplayer app has a Rarity column: a row with neither number nor rarity is sealed, unless it is a Basic
    # Energy; a numbered card with a sealed-sounding word stays a card.
    lines = [HEADER_12.decode(),
             "1,Team Rocket Returns Booster Box,Team Rocket Returns Booster Box,Team Rocket Returns,,RR,Normal,"
             "Near Mint,English,,,",
             "1,Mystery Pack,Mystery Pack,Base Set,,BS,Normal,Near Mint,English,,,",
             "2,Water Energy,Water Energy,Base Set,,BS,Normal,Near Mint,English,,,",
             "1,Starmie Collection,Starmie,Base Set,064/102,BS,Normal,Near Mint,English,Common,,", ""]
    summary = started(owner, unsorted, "\n".join(lines).encode())
    assert reasons(summary["id"]) == ["sealed", "sealed", None, None]
    # A loose file without a rarity column: only a sealed name counts.
    summary = started(owner, unsorted, b"Name,Set\nStarmie,Base Set\nBase Set Theme Deck,Base Set\n")
    assert reasons(summary["id"]) == [None, "sealed"]
    assert [row["status"] for row in all_rows(owner, summary["id"])] == ["by_name"]


def test_left_out_rows_download_in_the_files_own_columns_and_count_toward_the_row_cap():
    seed_import_catalog()
    owner, unsorted = collector()
    other, _ = collector()
    summary = started(owner, unsorted, COLLECTR)
    response = download(owner, summary["id"])
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == 'attachment; filename="left-out-rows.csv"'
    assert response.headers["cache-control"] == "no-store"
    text = response.content.decode("utf-8")
    assert text.startswith("﻿") and text.endswith("\r\n")
    source = list(csv.reader(io.StringIO(COLLECTR.decode("utf-8"))))
    assert list(csv.reader(io.StringIO(text[1:]))) == [source[0]] + [source[number] for number in
                                                                     (3, 4, 5, 6, 7, 8, 9, 12, 13)]
    # The skipped rows' download is separate: nothing is skipped yet.
    skipped = download(owner, summary["id"], "skipped.csv").content.decode("utf-8")
    assert list(csv.reader(io.StringIO(skipped[1:]))) == [source[0]]
    # Owner-only, and only while the draft is open.
    assert download(other, summary["id"]).status_code == 404
    assert save(owner, summary["id"]).status_code == 200
    response = download(owner, summary["id"])
    assert response.status_code == 404 and code(response) == "IMPORT_NOT_FOUND"
    # A file with nothing left out downloads just its header.
    summary = started(owner, unsorted, FOURTEEN)
    assert summary["left_out"] == []
    text = download(owner, summary["id"]).content.decode("utf-8")
    assert text == "﻿" + FOURTEEN.split(b"\n", 1)[0].decode() + "\r\n"
    # 9,999 cards and two watchlist rows are 10,001 rows: too many.
    header, card, watched = COLLECTR.split(b"\n")[0], COLLECTR.split(b"\n")[1], COLLECTR.split(b"\n")[3]
    response = upload(owner, unsorted, b"\n".join([header, *[card] * 9_999, watched, watched]) + b"\n")
    assert response.status_code == 422 and code(response) == "IMPORT_TOO_MANY_ROWS", response.text


def test_no_change_reaches_a_left_out_row_and_the_save_leaves_them_out():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, COLLECTR)
    import_id = summary["id"]
    response = change(owner, import_id, 1, {"rows": [1, 3, 7], "skip": True})
    assert response.status_code == 200, response.text
    assert response.json()["results"] == [{"applied": 1, "not_applied": [3, 7]}]
    response = change(owner, import_id, 2, {"rows": [3], "restore": True},
                      {"rows": [4], "finish": {"type": "normal"}},
                      {"rows": [6], "pick": {"printing_id": all_rows(owner, import_id)[0]["card"]["printing_id"]}},
                      {"filter": "all", "skip": True})
    assert response.status_code == 200, response.text
    assert response.json()["results"] == [{"applied": 0, "not_applied": [3]}, {"applied": 0, "not_applied": [4]},
                                          {"applied": 0, "not_applied": [6]}, {"applied": 3, "not_applied": []}]
    after = response.json()["summary"]
    assert after["counts"] == {"rows": 13, "needs_you": 0, "ready": 0, "finish_unknown": 0, "by_name": 0,
                               "skipped": 4}
    assert after["left_out"] == summary["left_out"]
    assert reasons(import_id) == reasons(summary["id"])
    with connect() as conn:
        assert conn.execute("""SELECT count(*) AS n FROM collection_import_row WHERE import_id=%s
          AND left_out_reason IS NOT NULL AND (skipped OR fix IS NOT NULL OR printing_id IS NOT NULL)""",
                            (import_id,)).fetchone()["n"] == 0
    response = change(owner, import_id, 3, {"rows": [1], "restore": True})
    assert response.status_code == 200, response.text
    response = save(owner, import_id, draft_revision=4)
    assert response.status_code == 200 and response.json()["copy_count"] == "3", response.text
    assert held(owner, unsorted) == {edition("base1-64", "normal"): "3"}


def test_the_filters_order_their_reasons():
    assert matcher.LEFT_OUT_REASONS == ("watchlist", "other_game", "not_english", "sealed")
    blank = dict.fromkeys(("quantity", "name", "simple_name", "set_name", "set_code", "number", "finish", "language",
                           "rarity", "product_id", "category", "watchlist", "grade", "list_type"), "")
    row = {**blank, "watchlist": "true", "category": "One Piece", "name": "Luffy (JP)"}
    assert matcher.left_out_reason(row, "collectr", frozenset({"rarity"})) == "watchlist"
    assert matcher.left_out_reason({**row, "watchlist": ""}, "collectr", frozenset({"rarity"})) == "other_game"
    assert matcher.left_out_reason({**row, "watchlist": "", "category": "Pokémon"}, "collectr",
                                   frozenset({"rarity"})) == "not_english"
    both = frozenset({"number", "rarity"})
    assert matcher.left_out_reason({**blank, "name": "Pikachu", "category": "POKEMON"}, "collectr", both) == "sealed"
    # A rarity column alone, with no number column, doesn't make a blank rarity mean sealed.
    assert matcher.left_out_reason({**blank, "name": "Pikachu"}, "loose", frozenset({"rarity"})) is None
    assert matcher.left_out_reason({**blank, "name": "Pikachu"}, "loose", frozenset()) is None
    assert matcher.left_out_reason({**blank, "name": "Tinkaton", "number": "85"}, "loose", frozenset()) is None
    assert matcher.left_out_reason({**blank, "name": "Paldea Tin"}, "loose", frozenset()) == "sealed"
    # A special Energy with no number or rarity is a card, Basic or not; a sealed name still wins.
    assert matcher.left_out_reason({**blank, "name": "Double Turbo Energy"}, "collectr", both) is None
    assert matcher.left_out_reason({**blank, "name": "Psychic Energy"}, "collectr", both) is None
    assert matcher.left_out_reason({**blank, "name": "Energy Booster Box"}, "collectr", both) == "sealed"


def test_a_language_is_english_by_its_first_word_and_a_loose_file_without_a_number_keeps_a_blank_rarity():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, b"Name,Set,Language\nStarmie,Base Set,English (US)\nStaryu,Base Set,en-GB\n"
                                       b"Pikachu,Base Set,Japanese\nMew,Base Set,\nEevee,Base Set,ENG.\n"
                                       b"Ditto,Base Set,English/Japanese\n")
    assert reasons(summary["id"]) == [None, None, "not_english", None, None, None]
    summary = started(owner, unsorted, b"Name,Set,Rarity\nStarmie,Base Set,\nBase Set Theme Deck,Base Set,\n")
    assert reasons(summary["id"]) == [None, "sealed"]
