"""Collection Import reading (#227): every supported tracker's export, the loose fallback, zip uploads and decoding,
through the start route against PostgreSQL, with the statuses, groups and stored fields asserted.

The fixtures in collection_import_fixtures/ are reconstructions, not the research exports (whose licences weren't
checked): each keeps its research fixture's header and edge cases, with this suite's catalog seed (seed_import_catalog
in test_collection_import). Matching is #228's product IDs, set aliases, number rules and Basic Energy by type, #229's
names within a set, and #230's finish table, so some rows here wait for a later ticket: the watchlist, sealed,
other-game and non-English filters (#231). Each such row's comment names the ticket that changes it.

| Research fixture | Reconstruction | Edge cases |
| T1 tcgplayer-app.real.csv | tcgplayer-app-14.csv, tcgplayer-app-12-crlf.csv (#226's tests) | both headers, CRLF, quoting |
| C1 collectr-14col.real.csv | collectr-14.csv | dated price column, watchlist, trailing spaces, grade, sealed |
| C2 collectr-16col.real.csv | collectr-16.csv | 16 columns, portfolios, "1,055.48", another game, BOM, cp1252 |
| P1 pricecharting.real.csv | pricecharting.csv (also zipped) | Name [Variant] #N either way round, folders, Japanese, games |
| TC1 tcg-collector.real.csv | tcg-collector-crlf.csv | CRLF, repeated rows, quoted note |
| D1 dragon-shield-pokemon.real.csv | dragon-shield-sep.csv | "sep=," (quoted, bare, absent), "042 / 102", "032VL" |
| S1 sorted-pokemon.real.csv | sorted.csv | 21 columns, lists, a Deck list, "pok"/"mtg", with and without "sep=," |
| X1 tcgplayer-legacy.reconstruction.csv | tcgplayer-legacy.csv | the loose fallback by Product ID |
| X2 paste-spreadsheet-tsv.reconstruction.txt | tcgplayer-app-14.tsv (also zipped) | tab-separated |
| X3 paste-lines.reconstruction.txt | paste-lines.txt | refused as a file; pasting it is #234 |

A zip is read when it holds one CSV, TSV or TXT entry, stored or deflated; directory entries and Finder metadata
(__MACOSX/, ._*, .DS_Store) are ignored. Anything else, including bzip2 or LZMA entries, is IMPORT_BAD_ZIP.
"""
import io
import re
import zipfile
from pathlib import Path
from uuid import uuid4

from app.main import connect  # first: app.main imports the routers, and they import it
from test_collection_import import (UNREADABLE_MESSAGE, all_rows, code, collector, edition, save, seed_import_catalog,
                                    sized_file, started, upload)
from test_batch_add import held
from test_holdings import call

FIXTURES = Path(__file__).parent / "collection_import_fixtures"
COLLECTR_14 = (FIXTURES / "collectr-14.csv").read_bytes()
COLLECTR_16 = (FIXTURES / "collectr-16.csv").read_bytes()
PRICECHARTING = (FIXTURES / "pricecharting.csv").read_bytes()
TCG_COLLECTOR = (FIXTURES / "tcg-collector-crlf.csv").read_bytes()
DRAGON_SHIELD = (FIXTURES / "dragon-shield-sep.csv").read_bytes()
SORTED = (FIXTURES / "sorted.csv").read_bytes()
TSV = (FIXTURES / "tcgplayer-app-14.tsv").read_bytes()
LEGACY = (FIXTURES / "tcgplayer-legacy.csv").read_bytes()
OTHER_APP = (FIXTURES / "other-app.csv").read_bytes()
PASTE_LINES = (FIXTURES / "paste-lines.txt").read_bytes()
# A tracker's name, or a detected source's stored value, anywhere in a response body. "Unsorted" is a Location name.
TRACKER = re.compile(r"tcg ?player|collectr|price ?charting|tcg[ _]?collector|dragon[ _]?shield|(?<!un)sorted|loose",
                     re.IGNORECASE)


def zipped(*entries, compression=zipfile.ZIP_DEFLATED):
    """A zip holding (name, bytes) entries; a name ending in "/" is a directory."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return buffer.getvalue()


def encrypted(data: bytes) -> bytes:
    """A one-entry zip marked encrypted: general-purpose flag bit 0 in the local header (offset 6) and in the central
    directory entry (offset 8). zipfile can't write an encrypted archive."""
    raw = bytearray(data)
    raw[6] |= 0x1
    central = raw.rfind(b"PK\x01\x02")
    raw[central + 8] |= 0x1
    return bytes(raw)


def statuses(owner, summary):
    return [(row["status"], row["quantity"]) for row in all_rows(owner, summary["id"])]


def stored(import_id):
    """(the draft's stored source, [(group, parsed fields)] in row order)."""
    with connect() as conn:
        source = conn.execute("SELECT source FROM collection_import WHERE id=%s", (import_id,)).fetchone()["source"]
        found = conn.execute("""SELECT group_name,parsed FROM collection_import_row WHERE import_id=%s
          ORDER BY row_number""", (import_id,)).fetchall()
    return source, [(row["group_name"], row["parsed"]) for row in found]


def refused(owner, location, data, expected):
    response = upload(owner, location, data)
    assert response.status_code == 422 and code(response) == expected, response.text
    return response.json()["detail"]


def test_both_collectr_headers_read_their_portfolios_grades_and_watchlist():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, COLLECTR_14)
    assert summary["counts"] == {"rows": 7, "needs_you": 2, "ready": 5, "finish_unknown": 1, "by_name": 0, "skipped": 0}
    assert summary["cards_to_add"] == "9"
    assert statuses(owner, summary) == [
        ("matched", "1"),  # a watchlist row with a blank quantity; #231 leaves it out
        ("matched", "2"), ("finish_unknown", "1"), ("matched", "1"),
        ("matched", "4"),  # "Base Set (Unlimited)": the collection set-name alias table (#228)
        ("ambiguous", "1"),  # Cosmos Holo: Dark Golduck has no such Edition (#230)
        ("not_found", "1")]  # a sealed booster box: no number, but a name; #231 leaves it out
    source, rows = stored(summary["id"])
    assert source == "collectr"
    assert [group for group, _ in rows] == [None, "Main", "Main", "Graded", "Main", "Main", "Main"]
    assert rows[0][1]["watchlist"] == "true" and rows[0][1]["quantity"] == ""
    assert rows[1][1]["watchlist"] == "" and rows[1][1]["name"] == "Starmie" and rows[1][1]["category"] == "Pokemon"
    assert rows[1][1]["grade"] == "" and rows[3][1]["grade"] == "CGC 8.5"
    assert rows[3][1]["finish"] == "Unlimited Holofoil" and rows[5][1]["name"] == "Dark Golduck (Cosmos Holo)"
    cp1252 = COLLECTR_16.decode("utf-8").encode("cp1252")
    for data in (COLLECTR_16, b"\xef\xbb\xbf" + COLLECTR_16, cp1252, b"\xef\xbb\xbf" + cp1252):
        summary = started(owner, unsorted, data)
        assert summary["counts"] == {"rows": 4, "needs_you": 1, "ready": 3, "finish_unknown": 0,
                                     "by_name": 0, "skipped": 0}
        assert summary["cards_to_add"] == "4"
        assert statuses(owner, summary) == [
            ("matched", "1"), ("matched", "2"), ("matched", "1"),
            ("not_found", "1")]  # a One Piece card; #231 leaves other games out
        source, rows = stored(summary["id"])
        assert source == "collectr"
        assert [group for group, _ in rows] == ["Main", "For Trade", "For Trade", "Main"]
        assert rows[1][1]["name"] == "Poké Ball" and rows[1][1]["grade"] == "PSA 10.0"
        assert rows[3][1]["category"] == "One Piece"
        assert all_rows(owner, summary["id"])[1]["edition"]["edition_id"] == edition("base2-64", "normal")


def test_pricecharting_splits_name_variant_and_number_and_reads_its_zip_as_is():
    seed_import_catalog()
    owner, unsorted = collector()
    for data in (PRICECHARTING, zipped(("collection_20260809.csv", PRICECHARTING))):
        summary = started(owner, unsorted, data)
        assert summary["counts"] == {"rows": 9, "needs_you": 3, "ready": 6, "finish_unknown": 1,
                                     "by_name": 0, "skipped": 0}
        assert summary["cards_to_add"] == "7"
        assert statuses(owner, summary) == [
            ("matched", "1"), ("matched", "1"),  # one row per copy, added together at save
            ("matched", "1"), ("finish_unknown", "2"),
            ("matched", "1"),  # [Reverse Holo] chooses Dark Golduck's Reverse Holo Edition (#230)
            ("ambiguous", "1"),  # a Japanese console names no set: Pick one by name (#229); #231 leaves it out
            ("matched", "1"),  # an Energy with no number: Basic Energy by type, in its own set (#228)
            ("not_found", "1"),  # sealed: no number, but a name; #231 leaves it out
            ("not_found", "1")]  # another game; #231
        source, rows = stored(summary["id"])
        assert source == "pricecharting"
        assert [group for group, _ in rows] == ["Collection", "Hits", "Hits", None, None, None, None, None,
                                                "Collection"]
        fields = [parsed for _, parsed in rows]
        assert [(f["name"], f["number"], f["finish"]) for f in fields[:5]] == [
            ("Starmie", "64", ""), ("Starmie", "64", ""), ("Wigglytuff", "32", "Holo"),
            ("Weepinbell", "48", "1st Edition"), ("Dark Golduck", "35", "Reverse Holo")]
        assert fields[0]["set_name"] == "Base Set" and fields[0]["category"] == "Pokemon"
        assert fields[0]["product_id"] == "" and fields[0]["grade"] == "" and fields[2]["grade"] == "PSA 10"
        assert fields[5]["language"] == "Japanese" and fields[5]["set_name"] == "Japanese Base Set"
        assert fields[6]["name"] == "Water Energy" and fields[6]["number"] == ""
        assert fields[8]["category"] == "YuGiOh Legend of Blue Eyes" and fields[8]["number"] == "LOB-005"
        assert fields[8]["name"] == "Dark Magician" and fields[8]["finish"] == "1st Edition"


def test_tcg_collector_reads_crlf_and_repeated_rows():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, TCG_COLLECTOR)
    assert summary["counts"] == {"rows": 6, "needs_you": 0, "ready": 6, "finish_unknown": 0, "by_name": 0, "skipped": 0}
    assert summary["cards_to_add"] == "33"
    assert statuses(owner, summary) == [
        ("matched", "2"), ("matched", "1"), ("matched", "1"),
        ("matched", "1"),  # Normal: Weepinbell's Normal Edition (#230)
        ("matched", "27"),  # "Base Set Energies" names no set: Basic Water Energy by type (#228)
        ("matched", "1")]  # Reverse Holo: Dark Golduck's Reverse Holo Edition (#230)
    source, rows = stored(summary["id"])
    assert source == "tcg_collector" and [group for group, _ in rows] == [None] * 6
    assert rows[0][1]["finish"] == "Non-holo" and rows[0][1]["language"] == "English"
    assert rows[0][1]["number"] == "064/102"


def test_dragon_shield_skips_its_sep_line_and_sorted_reads_with_or_without_one():
    seed_import_catalog()
    owner, unsorted = collector()
    unquoted = DRAGON_SHIELD.replace(b'"sep=,"', b"sep=,", 1)
    for data in (DRAGON_SHIELD, unquoted, DRAGON_SHIELD.split(b"\n", 1)[1]):
        summary = started(owner, unsorted, data)
        assert summary["counts"] == {"rows": 4, "needs_you": 1, "ready": 3, "finish_unknown": 0,
                                     "by_name": 0, "skipped": 0}
        assert summary["cards_to_add"] == "4"
        assert statuses(owner, summary) == [
            ("matched", "1"), ("matched", "2"),
            ("matched", "1"),  # "032VL" is also read as 032 (#228's number rules)
            ("not_found", "1")]  # a Japan-only set; #231 leaves it out
        source, rows = stored(summary["id"])
        assert source == "dragon_shield"
        assert [group for group, _ in rows] == ["Binder", "Binder", "Binder", "Trades"]
        assert rows[0][1]["number"] == "042 / 102" and rows[0][1]["set_code"] == "BS"
    for data in (SORTED, b'"sep=,"\r\n' + SORTED):
        summary = started(owner, unsorted, data)
        assert summary["counts"] == {"rows": 4, "needs_you": 1, "ready": 3, "finish_unknown": 0,
                                     "by_name": 0, "skipped": 0}
        assert summary["cards_to_add"] == "5"
        assert statuses(owner, summary) == [
            ("matched", "1"), ("matched", "3"),
            ("matched", "1"),  # a row from a Deck list
            ("not_found", "1")]  # a Magic card; #231 leaves other games out
        source, rows = stored(summary["id"])
        assert source == "sorted"
        assert [group for group, _ in rows] == ["Binder A", "Binder A", "Water Deck", "Binder A"]
        assert [parsed["list_type"] for _, parsed in rows] == ["Folder", "Folder", "Deck", "Folder"]
        assert [parsed["category"] for _, parsed in rows] == ["pok", "pok", "pok", "mtg"]
        assert rows[1][1]["name"] == "Poké Ball" and rows[1][1]["language"] == "en"


def test_a_tab_separated_export_reads_like_its_csv():
    seed_import_catalog()
    owner, unsorted = collector()
    for data in (TSV, zipped(("cards.TSV", TSV))):
        summary = started(owner, unsorted, data)
        assert summary["counts"] == {"rows": 4, "needs_you": 1, "ready": 3, "finish_unknown": 0,
                                     "by_name": 0, "skipped": 0}
        assert summary["cards_to_add"] == "7"
        assert statuses(owner, summary) == [
            ("matched", "5"), ("matched", "1"), ("matched", "1"),
            ("not_found", "1")]  # "SV01: …" names sv01 (#228's alias table), which this seed doesn't hold
        source, rows = stored(summary["id"])
        assert source == "tcgplayer_app"
        assert rows[1][1]["simple_name"] == "Wigglytuff" and rows[1][1]["product_id"] == "900004"
        assert rows[2][1]["name"] == "Starmie, Holiday Calendar"


def test_the_loose_fallback_reads_name_like_columns_and_product_ids():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, OTHER_APP)
    assert summary["counts"] == {"rows": 3, "needs_you": 1, "ready": 2, "finish_unknown": 0, "by_name": 0, "skipped": 0}
    assert summary["cards_to_add"] == "3"
    assert statuses(owner, summary) == [("matched", "2"), ("matched", "1"), ("not_found", "1")]
    source, rows = stored(summary["id"])
    assert source == "loose" and [group for group, _ in rows] == ["Shelf"] * 3
    assert rows[1][1]["finish"] == "Holo" and rows[1][1]["name"] == "Wigglytuff" and rows[1][1]["number"] == "32"
    # TCGplayer's previous-app file: Product ID alone is enough to read it. This seed maps none of its product IDs, so
    # nothing matches (test_collection_import_matching maps them).
    summary = started(owner, unsorted, LEGACY)
    assert statuses(owner, summary) == [("unreadable", "1"), ("unreadable", "1"), ("unreadable", "2")]
    source, rows = stored(summary["id"])
    assert source == "loose" and [group for group, _ in rows] == ["Binder 1", "Binder 1", "Trade Pile"]
    assert [parsed["product_id"] for _, parsed in rows] == ["900002", "900005", "900003"]
    assert rows[1][1]["finish"] == "1st Edition"
    # A recognised header always wins; one extra column makes Collectr's header loose, which still reads it.
    lines = COLLECTR_14.split(b"\n")
    lines[0] += b",Extra"
    summary = started(owner, unsorted, b"\n".join(lines))
    assert stored(summary["id"])[0] == "loose"
    assert summary["counts"] == {"rows": 7, "needs_you": 2, "ready": 5, "finish_unknown": 1, "by_name": 0, "skipped": 0}
    assert [group for group, _ in stored(summary["id"])[1]][:4] == [None, "Main", "Main", "Graded"]
    # A set column with a number or a name is enough; a name alone isn't.
    summary = started(owner, unsorted, b"Set,Number\nBase Set,64\n")
    assert statuses(owner, summary) == [("matched", "1")]
    summary = started(owner, unsorted, b"Name,Set\nStarmie,Base Set\n")
    assert statuses(owner, summary) == [("by_name", "1")]  # by name within its set (#229)
    for data in (b"Name,Quantity\nStarmie,1\n", b"Item,Cost\nStarmie,1\n", PASTE_LINES):
        # A paste-style list isn't a file; pasting it is #234.
        assert refused(owner, unsorted, data, "IMPORT_UNREADABLE") == {
            "code": "IMPORT_UNREADABLE", "message": UNREADABLE_MESSAGE}
    for tracker in ("TCGplayer app", "Collectr", "PriceCharting", "TCG Collector", "Dragon Shield", "Sorted"):
        assert tracker in UNREADABLE_MESSAGE


def test_a_zip_holds_exactly_one_csv_tsv_or_txt_file():
    seed_import_catalog()
    owner, unsorted = collector()
    one = zipped(("collection.csv", PRICECHARTING))
    for data in (one, zipped(("export/", b""), ("export/collection.csv", PRICECHARTING)),
                 zipped(("collection.txt", PRICECHARTING), compression=zipfile.ZIP_STORED)):
        assert started(owner, unsorted, data)["counts"]["rows"] == 9
    bad_zip = {"code": "IMPORT_BAD_ZIP",
               "message": "PrizeCheck can't read this zip file. It must hold one CSV, TSV or TXT file, with no password."}
    for data in (zipped(("a.csv", PRICECHARTING), ("b.csv", PRICECHARTING)),
                 zipped(("inner.zip", one)),
                 zipped(("collection.csv", one)),
                 zipped(("collection.xlsx", PRICECHARTING)),
                 encrypted(one),
                 zipped(("collection.csv", PRICECHARTING), compression=zipfile.ZIP_BZIP2),
                 zipped(("collection.csv", PRICECHARTING), compression=zipfile.ZIP_LZMA),
                 zipped(),
                 b"PK\x03\x04" + b"\x00" * 40):
        assert refused(owner, unsorted, data, "IMPORT_BAD_ZIP") == bad_zip
    # Over 5 MB once unzipped is too large, however small the zip; exactly 5 MB is read (and has too many rows).
    large = zipped(("collection.csv", sized_file(5 * 1024 * 1024 + 1)))
    assert len(large) < 1024 * 1024
    assert refused(owner, unsorted, large, "IMPORT_TOO_LARGE") == {
        "code": "IMPORT_TOO_LARGE",
        "message": "This file is larger than 5 MB. Split it into two files and import each one."}
    refused(owner, unsorted, zipped(("collection.csv", sized_file(5 * 1024 * 1024))), "IMPORT_TOO_MANY_ROWS")
    # A zip that understates its entry's size fails its check instead of reading past it.
    forged = bytearray(large)
    central = forged.rfind(b"PK\x01\x02")
    forged[central + 24:central + 28] = (1000).to_bytes(4, "little")
    forged[22:26] = (1000).to_bytes(4, "little")
    refused(owner, unsorted, bytes(forged), "IMPORT_BAD_ZIP")
    refused(owner, unsorted, zipped(("collection.csv", b"")), "IMPORT_UNREADABLE")
    assert call("GET", "/api/collection-imports/current", owner).json()["counts"]["rows"] == 9


def test_a_zip_ignores_macos_finder_metadata_entries():
    seed_import_catalog()
    owner, unsorted = collector()
    meta = b"\x00\x05"
    for data in (zipped(("export.csv", PRICECHARTING), ("__MACOSX/._export.csv", meta)),
                 zipped(("__MACOSX/", b""), ("__MACOSX/._export.csv", meta), ("export.csv", PRICECHARTING)),
                 zipped(("export.csv", PRICECHARTING), ("._export.csv", meta)),
                 zipped(("export/", b""), ("export/collection.csv", PRICECHARTING),
                        ("export/.DS_Store", b"\x00\x00\x00\x01Bud1"), ("__MACOSX/export/._collection.csv", meta))):
        assert started(owner, unsorted, data)["counts"]["rows"] == 9
    bad_zip = {"code": "IMPORT_BAD_ZIP",
               "message": "PrizeCheck can't read this zip file. It must hold one CSV, TSV or TXT file, with no password."}
    # Metadata alone is not a file, a second real entry still counts, and encrypted metadata still refuses the zip.
    for data in (zipped(("__MACOSX/._export.csv", meta)),
                 zipped(("a.csv", PRICECHARTING), ("__MACOSX/._a.csv", b"\x00"), ("b.csv", PRICECHARTING)),
                 encrypted(zipped(("export.csv", PRICECHARTING), ("__MACOSX/._x", meta)))):
        assert refused(owner, unsorted, data, "IMPORT_BAD_ZIP") == bad_zip
    assert call("GET", "/api/collection-imports/current", owner).json()["counts"]["rows"] == 9


def test_cells_read_as_decklist_import_reads_them():
    """Every cell, header cells included, goes through decklist import's normalisation (decklist_text.normalise):
    zero-width characters removed, no-break spaces as spaces, NFC, curly apostrophes as "'". The row's raw text keeps
    the cells as the file had them."""
    seed_import_catalog()
    owner, unsorted = collector()
    # A zero-width space before Quantity still reads as the TCGplayer app's header; a no-break space inside a set
    # name and a zero-width space inside a number still match; decomposed accents and curly apostrophes read as
    # decklist import reads them.
    lines = [
        "\u200bQuantity,Name,Simple Name,Set,Card\u00a0Number,Set Code,Printing,Condition,Language,Rarity,"
        "Product ID,SKU",
        "1,Starmie,Starmie,Base\u00a0Set,064/102,BS,Normal,Near Mint,English,Common,900003,800003",
        "2,Starmie,Starmie,Base\u202fSet,06\u200b4/102,BS,Normal,Near Mint,English,Common,900003,800004",
        "1,Poke\u0301 Ball,Poke\u0301 Ball,Jungle,64/64,JU,Normal,Near Mint,English,Common,900007,800007",
        "1,Misty\u2019s Starmie \u2018Promo\u2019,Starmie,Base Set,064/102,BS,Normal,Near Mint,English,Common,"
        "900003,800005",
    ]
    summary = started(owner, unsorted, ("\n".join(lines) + "\n").encode("utf-8"))
    assert summary["counts"] == {"rows": 4, "needs_you": 0, "ready": 4, "finish_unknown": 0, "by_name": 0, "skipped": 0}
    assert summary["cards_to_add"] == "5"
    found = all_rows(owner, summary["id"])
    assert [row["status"] for row in found] == ["matched"] * 4
    assert [row["source"] for row in found] == [
        {"quantity": "1", "name": "Starmie", "set_name": "Base Set", "number": "064/102", "finish": "Normal"},
        {"quantity": "2", "name": "Starmie", "set_name": "Base Set", "number": "064/102", "finish": "Normal"},
        {"quantity": "1", "name": "Pok\u00e9 Ball", "set_name": "Jungle", "number": "64/64", "finish": "Normal"},
        {"quantity": "1", "name": "Misty's Starmie 'Promo'", "set_name": "Base Set", "number": "064/102",
         "finish": "Normal"}]
    assert found[0]["edition"]["edition_id"] == edition("base1-64", "normal")
    assert found[2]["edition"]["edition_id"] == edition("base2-64", "normal")
    source, rows = stored(summary["id"])
    assert source == "tcgplayer_app"
    assert rows[1][1]["set_name"] == "Base Set" and rows[1][1]["number"] == "064/102"
    assert rows[3][1]["name"] == "Misty's Starmie 'Promo'" and rows[3][1]["simple_name"] == "Starmie"
    with connect() as conn:
        raw = [row["raw_text"] for row in conn.execute(
            "SELECT raw_text FROM collection_import_row WHERE import_id=%s ORDER BY row_number",
            (summary["id"],)).fetchall()]
    assert "Base\u202fSet" in raw[1] and "06\u200b4/102" in raw[1] and "Misty\u2019s" in raw[3]
    # A Windows-1252 file's no-break space (0xA0) and curly apostrophe (0x92) read the same way.
    summary = started(owner, unsorted, b"Set,Number,Name\r\nBase\xa0Set,64,Misty\x92s Starmie\r\n")
    found = all_rows(owner, summary["id"])
    assert [row["status"] for row in found] == ["matched"]
    assert found[0]["source"] == {"quantity": "", "name": "Misty's Starmie", "set_name": "Base Set", "number": "64",
                                  "finish": ""}


def test_no_response_names_the_detected_source():
    seed_import_catalog()
    owner, unsorted = collector()
    bodies = []
    for data in (COLLECTR_14, COLLECTR_16, PRICECHARTING, zipped(("collection.csv", PRICECHARTING)), TCG_COLLECTOR,
                 DRAGON_SHIELD, SORTED, TSV, LEGACY, OTHER_APP):
        response = upload(owner, unsorted, data)
        assert response.status_code == 201, response.text
        import_id = response.json()["id"]
        bodies.append(response.text)
        bodies.append(call("GET", "/api/collection-imports/current", owner).text)
        for filter_ in ("all", "needs"):
            bodies.append(call("GET", f"/api/collection-imports/{import_id}/rows?filter={filter_}", owner).text)
    ready = b"\n".join(COLLECTR_16.split(b"\n")[:4]) + b"\n"
    summary = started(owner, unsorted, ready)
    assert summary["counts"] == {"rows": 3, "needs_you": 0, "ready": 3, "finish_unknown": 0, "by_name": 0, "skipped": 0}
    response = save(owner, summary["id"], key=uuid4())
    assert response.status_code == 200, response.text
    bodies.append(response.text)
    assert held(owner, unsorted) == {edition("base1-64", "normal"): "1", edition("base2-64", "normal"): "3"}
    for body in bodies:
        assert not TRACKER.search(body), body
        assert "Portfolio" not in body and "console" not in body and "1,055.48" not in body and "PSA" not in body


def test_a_row_or_header_cell_of_only_zero_width_characters_counts_as_blank():
    """Blank rows and the header's trailing blank cells are judged after normalisation, so a cell of only zero-width
    characters is blank too."""
    seed_import_catalog()
    owner, unsorted = collector()
    header = ("Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU"
              ",​")
    card = "1,Starmie,Starmie,Base Set,064/102,BS,Normal,Near Mint,English,Common,900003,800003"
    lines = [header, "​,⁠,﻿" + "," * 10, card, "​"]
    summary = started(owner, unsorted, ("\n".join(lines) + "\n").encode("utf-8"))
    assert summary["counts"] == {"rows": 1, "needs_you": 0, "ready": 1, "finish_unknown": 0, "by_name": 0, "skipped": 0}
    assert [row["status"] for row in all_rows(owner, summary["id"])] == ["matched"]
    assert stored(summary["id"])[0] == "tcgplayer_app"
