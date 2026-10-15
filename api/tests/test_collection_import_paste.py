"""Collection Import paste (#234): the start route takes {"text": …} as JSON. Rows copied from a spreadsheet with a
header are read like the file; any other paste is lines, read with decklist import's line grammar
(decklist_text.read_line) and then the name fallback, and matched as a loose file is, plus decklist import's set code
aliases. A paste has a file's limits, and its downloads give back its lines as they were pasted.

Signed HTTP against PostgreSQL, with test_collection_import's catalog seed and test_collection_import_matching's
MATCHING_CARDS, plus PASTE_CARDS (real TCGdex set IDs, names and numbers).

| Research fixture | Reconstruction | Edge cases |
| X2 paste-spreadsheet-tsv.reconstruction.txt | tcgplayer-app-14.tsv, pasted as text | a tab-separated header |
| X3 paste-lines.reconstruction.txt | paste-mixed.txt (the same lines) | a title, PH, 2x, no quantity, #N, a tag |
| X3 | paste-lines.txt (#227's, on this suite's seed) | web/tests/collection-import-paste.spec.ts pastes it |
| TCGplayer plain-text export (grammar unconfirmed) | paste-tcgplayer-text.txt | a price line, finish tags |
"""
import hashlib
import hmac
import json
import os
import time
from pathlib import Path

import pytest

from app.main import connect  # first: app.main imports the routers, and they import it
from test_batch_add import held
from test_collection_import import FOURTEEN, all_rows, code, collector, edition, save, seed_import_catalog, started
from test_collection_import_finishes import changed, counts
from test_collection_import_matching import HOLO, MATCHING_CARDS, candidates, energy, outcomes, pokemon, trainer
from test_collection_import_reading import stored
from test_collection_import_resolve import printing
from test_holdings import call, client

FIXTURES = Path(__file__).parent / "collection_import_fixtures"
MIXED = (FIXTURES / "paste-mixed.txt").read_text()
TCGPLAYER_TEXT = (FIXTURES / "paste-tcgplayer-text.txt").read_text()
TSV = (FIXTURES / "tcgplayer-app-14.tsv").read_bytes()
# The cards paste-mixed.txt names that MATCHING_CARDS doesn't hold.
PASTE_CARDS = (
    trainer("sv02-185", "Iono", "185", HOLO),
    pokemon("sv02-097", "Mimikyu", "097", HOLO),
    pokemon("base1-4", "Charizard", "4", HOLO),
    energy("sve-013", "Basic Psychic Energy", "013"),
    pokemon("swshp-SWSH039", "Pikachu", "SWSH039", HOLO),
)
TOO_LARGE = {"code": "IMPORT_TOO_LARGE",
             "message": "This list is larger than 5 MB. Split it into two lists and import each one."}
TOO_MANY_ROWS = {"code": "IMPORT_TOO_MANY_ROWS",
                 "message": "This list has more than 10,000 rows. Split it into two lists and import each one."}
UNREADABLE = {"code": "IMPORT_UNREADABLE", "message": "PrizeCheck can't read this list. Paste it as plain text."}


def seed():
    seed_import_catalog(*MATCHING_CARDS, *PASTE_CARDS)


def post_body(user, location_id, body: bytes, content_type="application/json"):
    """POST /api/collection-imports with `body` as it is, signed as the gateway signs it."""
    stamp = str(int(time.time()))
    signed = f"POST\n/api/collection-imports\n{hashlib.sha256(body).hexdigest()}\n{user}\n{stamp}".encode()
    headers = {"x-internal-user": user, "x-internal-time": stamp, "content-type": content_type,
               "x-internal-signature": hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), signed,
                                                hashlib.sha256).hexdigest()}
    return client.post(f"/api/collection-imports?location_id={location_id}", content=body, headers=headers)


def paste(user, location_id, text: str):
    return post_body(user, location_id, json.dumps({"text": text}).encode())


def pasted(user, location_id, text: str):
    response = paste(user, location_id, text)
    assert response.status_code == 201, response.text
    return response.json()


def refused(response, status=422):
    assert response.status_code == status, response.text
    return response.json()["detail"]


def raw_lines(import_id):
    with connect() as conn:
        return [row["raw_text"] for row in conn.execute(
            "SELECT raw_text FROM collection_import_row WHERE import_id=%s ORDER BY row_number", (import_id,))]


def download(user, import_id, which):
    return call("GET", f"/api/collection-imports/{import_id}/{which}", user)


def sources(owner, summary):
    """Each row's quantity and source fields, as the review shows them, in paste order."""
    return [(row["quantity"], *(row["source"][field] for field in ("quantity", "name", "set_name", "number")))
            for row in all_rows(owner, summary["id"])]


def test_a_pasted_spreadsheet_with_a_header_is_read_like_the_file():
    seed_import_catalog()
    owner, unsorted = collector()
    for data in (TSV, FOURTEEN, b"sep=\t\n" + TSV):
        uploaded = started(owner, unsorted, data)
        as_file = (stored(uploaded["id"]), [(row["status"], row["source"]) for row in all_rows(owner, uploaded["id"])])
        # The paste replaces the uploaded draft: one open draft per collector.
        summary = pasted(owner, unsorted, data.decode("utf-8"))
        assert summary["lines"] is False and uploaded["lines"] is False
        assert summary["counts"] == uploaded["counts"] and summary["cards_to_add"] == uploaded["cards_to_add"]
        assert (stored(summary["id"]),
                [(row["status"], row["source"]) for row in all_rows(owner, summary["id"])]) == as_file
    assert stored(summary["id"])[0] == "tcgplayer_app"
    # A spreadsheet's rows come back in its columns, as a file's do.
    changed(owner, summary["id"], 1, {"rows": [1], "skip": True})
    response = download(owner, summary["id"], "skipped.csv")
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert 'filename="skipped-rows.csv"' in response.headers["content-disposition"]
    assert response.text.startswith("﻿Quantity,Name,Simple Name,Set,")
    # A first line that no preset or the fallback reads isn't a header: the paste is lines.
    summary = pasted(owner, unsorted, "Name,Quantity\nStarmie,1\n")
    assert summary["lines"] is True and summary["counts"]["rows"] == 2


def test_a_mixed_paste_reads_decklist_lines_and_free_text():
    seed()
    owner, unsorted = collector()
    summary = pasted(owner, unsorted, MIXED)
    assert summary["lines"] is True and summary["groups"] == [] and summary["left_out"] == []
    assert summary["counts"] == counts(rows=9, needs_you=3, ready=6)
    assert stored(summary["id"])[0] == "paste"
    assert outcomes(owner, summary) == [
        ("not_found", None),  # the title line: free text, no card of that name
        ("matched", "sv02-185"),  # 4 Iono PAL 185: the printed code table
        ("matched", "sv02-097"),  # PH dropped, 97 finds 097
        ("ambiguous", "sv01-039"),  # 2x is 2; Normal or Reverse Holo, no finish pasted: pick one
        ("ambiguous", "swsh6-145"),  # no quantity: one copy
        ("matched", "base1-4"),  # Charizard #4 Base Set: number and set name
        ("matched", "swsh12tg-TG01"),  # SIT's Trainer Gallery subset
        ("matched", "sve-013"),  # SVE: decklist import's alias table
        ("matched", "swshp-SWSH039")]  # a trailing " - SWSH039": the era's promo set
    assert sources(owner, summary) == [
        ("1", "", "My binder (Paldea + promos)", "", ""),
        ("4", "4", "Iono", "PAL", "185"),
        ("1", "1", "Mimikyu", "PAL", "97"),
        ("2", "2", "Charcadet", "SVI", "39"),
        ("1", "", "Klara", "CRE", "145"),
        ("1", "", "Charizard", "Base Set", "4"),
        ("1", "1", "Braixen", "SIT", "TG01"),
        ("3", "3", "Basic {P} Energy", "SVE", "13"),
        ("1", "", "Pikachu - SWSH039 (General Mills)", "", "SWSH039")]
    assert raw_lines(summary["id"]) == MIXED.splitlines()

    # Fixed and skipped like a file's rows, it saves.
    changed(owner, summary["id"], 1, {"rows": [1], "skip": True},
            {"rows": [4], "finish": {"type": "reverse"}}, {"rows": [5], "finish": {"type": "normal"}})
    assert save(owner, summary["id"], draft_revision=2).status_code == 200
    assert held(owner, unsorted) == {
        edition("sv02-185", "holo"): "4", edition("sv02-097", "holo"): "1",
        edition("sv01-039", "reverse"): "2", edition("swsh6-145", "normal"): "1",
        edition("base1-4", "holo"): "1", edition("swsh12tg-TG01", "holo"): "1", edition("sve-013", "normal"): "3",
        edition("swshp-SWSH039", "holo"): "1"}


def test_free_text_lines_read_a_quantity_a_grade_a_number_and_a_set():
    seed_import_catalog()
    owner, unsorted = collector()
    text = "\r\n".join([
        "Pokémon: 3",  # a decklist section header: not a row
        "",
        "* 3x Starmie BS 64",  # a bullet and 3x
        "Starmie #64 Base Set PSA 8",  # a grade set aside
        "1000 Water Energy",  # more than decklist import's 999
        "2 Wartortle",  # a quantity and a name: by name, no set
        "Wigglytuff JU 32 BGS 9.5",
        "$5.00",  # nothing but a price: Can't read
        "Poke Ball - 64 (Jungle)",
    ])
    summary = pasted(owner, unsorted, text)
    assert summary["counts"] == counts(rows=7, needs_you=3, ready=4)
    assert outcomes(owner, summary) == [
        ("matched", "base1-64"), ("matched", "base1-64"), ("matched", "base1-102"), ("ambiguous", None),
        ("matched", "base2-32"), ("unreadable", None), ("ambiguous", None)]
    assert sources(owner, summary) == [
        ("3", "3", "Starmie", "BS", "64"),
        ("1", "", "Starmie", "Base Set", "64"),
        ("1000", "1000", "Water Energy", "", ""),
        ("2", "2", "Wartortle", "", ""),
        ("1", "", "Wigglytuff", "JU", "32"),
        ("1", "", "", "", ""),
        ("1", "", "Poke Ball - 64 (Jungle)", "", "64")]
    assert candidates(summary)[3] == ["base1-42"] and candidates(summary)[6] == ["base2-64"]
    with connect() as conn:
        grades = [row["parsed"]["grade"] for row in conn.execute(
            "SELECT parsed FROM collection_import_row WHERE import_id=%s ORDER BY row_number", (summary["id"],))]
    assert grades == ["", "PSA 8", "", "", "BGS 9.5", "", ""]
    # Blank and header lines aren't rows, and each row keeps its line as pasted, without the line break.
    assert raw_lines(summary["id"]) == [line for line in text.split("\r\n") if line and line != "Pokémon: 3"]


def test_quantities_beyond_decklists_range_and_prices_anywhere_are_read_in_a_pasted_line():
    seed_import_catalog(*MATCHING_CARDS, *PASTE_CARDS, pokemon("sv01-025", "Pikachu", "025"),
                        energy("sve-003", "Basic Water Energy", "003"))
    owner, unsorted = collector()
    lines = [
        "1500 Basic Water Energy SVE 3",  # over decklist's 999: the quantity is kept, the rest is the grammar's
        "0 Pikachu SVI 25",  # no copies: Can't read, not one copy of "0 Pikachu"
        "1000x Pikachu SVI 25",  # a times sign over 999
        "Pikachu 2x SVI 25",  # a "2x" that isn't the quantity is left alone
        "3 Pikachu $1.65 SVI 25",  # a price between the name and the set
        "2 Iono $3 PAL 185",
        "1 Mew \u20ac12 MEW 151",
        "2 Iono PAL 185 $3.10",  # a trailing price: the set and number stay
        "1 Pikachu SVI 25 PSA 10 $40",  # a price after a grade
        "2 Dark Golduck (Reverse Holofoil) - $1.65",  # a tagged export line: the dash goes with the price
    ]
    summary = pasted(owner, unsorted, "\n".join(lines))
    rows = all_rows(owner, summary["id"])
    assert [(row["quantity"], row["status"]) for row in rows] == [
        ("1500", "matched"), (None, "unreadable"), ("1000", "matched"), ("1", "matched"), ("3", "matched"),
        ("2", "matched"), ("1", "not_found"), ("2", "matched"), ("1", "matched"), ("2", "ambiguous")]
    assert outcomes(owner, summary) == [
        ("matched", "sve-003"), ("unreadable", None), ("matched", "sv01-025"), ("matched", "sv01-025"),
        ("matched", "sv01-025"), ("matched", "sv02-185"), ("not_found", None), ("matched", "sv02-185"),
        ("matched", "sv01-025"), ("ambiguous", None)]
    assert sources(owner, summary) == [
        ("1500", "1500", "Basic Water Energy", "SVE", "3"),
        (None, "0", "Pikachu", "SVI", "25"),
        ("1000", "1000", "Pikachu", "SVI", "25"),
        ("1", "", "Pikachu 2x", "SVI", "25"),
        ("3", "3", "Pikachu", "SVI", "25"),
        ("2", "2", "Iono", "PAL", "185"),
        ("1", "1", "Mew", "MEW", "151"),
        ("2", "2", "Iono", "PAL", "185"),
        ("1", "1", "Pikachu", "SVI", "25"),
        ("2", "2", "Dark Golduck (Reverse Holofoil)", "", "")]
    for row in rows:
        assert not any(mark in value for value in row["source"].values() for mark in "$\u20ac\u00a3"), row["source"]
    with connect() as conn:
        grades = [row["parsed"]["grade"] for row in conn.execute(
            "SELECT parsed FROM collection_import_row WHERE import_id=%s ORDER BY row_number", (summary["id"],))]
    assert grades[8] == "PSA 10"
    assert candidates(summary)[9] == ["ex7-35"]


def test_tcgplayers_plain_text_export_is_read_as_lines():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = pasted(owner, unsorted, TCGPLAYER_TEXT)
    assert summary["lines"] is True
    assert summary["counts"] == counts(rows=5, needs_you=4, ready=1)
    assert outcomes(owner, summary) == [("not_found", None), ("matched", "base1-102"), ("ambiguous", None),
                                        ("ambiguous", None), ("ambiguous", None)]
    assert candidates(summary)[2:] == [["base1-64"], ["base2-32"], ["ex7-35"]]
    # The price on its top line is never read into a field, so no response carries it.
    rows = all_rows(owner, summary["id"])
    assert rows[0]["source"]["name"] == "Total:"
    assert "70.82" not in json.dumps(rows) + json.dumps(summary)
    # Picked, each card's Edition comes from the line's tag, as a file's name tag chooses it.
    changed(owner, summary["id"], 1, {"rows": [1], "skip": True},
            {"rows": [3], "pick": {"printing_id": printing("base1-64")}},
            {"rows": [4], "pick": {"printing_id": printing("base2-32")}},
            {"rows": [5], "pick": {"printing_id": printing("ex7-35")}})
    assert save(owner, summary["id"], draft_revision=2).status_code == 200
    assert held(owner, unsorted) == {edition("base1-102", "normal"): "5", edition("base1-64", "normal"): "1",
                                     edition("base2-32", "holo"): "1", edition("ex7-35", "reverse"): "2"}


def test_a_pastes_downloads_give_back_its_lines_as_typed():
    seed_import_catalog()
    owner, unsorted = collector()
    lines = ["4 Starmie BS 64", "  Flying  Pikachu  RR 113  ", "Wartortle’s pal, 2 copies", "Pikachu (JP) #1",
             "Elite Trainer Box", "1 Wigglytuff JU 32"]
    summary = pasted(owner, unsorted, "\n".join(lines))
    assert [(entry["reason"], entry["rows"]) for entry in summary["left_out"]] == [("not_english", 1), ("sealed", 1)]
    changed(owner, summary["id"], 1, {"rows": [2, 3], "skip": True})
    response = download(owner, summary["id"], "skipped.csv")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/plain; charset=utf-8"
    assert response.headers["content-disposition"] == 'attachment; filename="skipped-rows.txt"'
    assert response.headers["cache-control"] == "no-store"
    assert response.content == "  Flying  Pikachu  RR 113  \nWartortle’s pal, 2 copies\n".encode()
    response = download(owner, summary["id"], "left-out.csv")
    assert response.headers["content-disposition"] == 'attachment; filename="left-out-rows.txt"'
    assert response.content == b"Pikachu (JP) #1\nElite Trainer Box\n"
    # Nothing skipped: an empty download.
    changed(owner, summary["id"], 2, {"rows": [2, 3], "restore": True})
    assert download(owner, summary["id"], "skipped.csv").content == b""


def test_a_paste_has_a_files_limits_and_refusals():
    seed_import_catalog()
    owner, unsorted = collector()
    assert refused(paste(owner, unsorted, "1 Starmie BS 64\n" * 10_001)) == TOO_MANY_ROWS
    # A body over 5 MiB is refused before it is read, whatever the text inside, with the list's wording. (The text's
    # UTF-8 is never larger than its JSON body, so read_paste's own 5 MiB check is a guard HTTP can't reach.)
    limit = 5 * 1024 * 1024
    assert refused(paste(owner, unsorted, "é" * (limit // 2 + 1))) == TOO_LARGE
    assert refused(post_body(owner, unsorted, b'{"text": "' + b"a" * limit + b'"}')) == TOO_LARGE
    for text in ("", "\n \r\n\t\n", "Pokémon: 12\nTrainer: 3\n"):
        assert code(paste(owner, unsorted, text)) == "IMPORT_EMPTY"
    # A spreadsheet's header and no rows is empty too.
    assert code(paste(owner, unsorted, TSV.decode().splitlines()[0])) == "IMPORT_EMPTY"
    assert refused(paste(owner, unsorted, "1 Starmie BS 64\x00")) == UNREADABLE
    for body in (b"not json", b'{"text": 5}', b'{"text": "x", "more": 1}', b"[]", b'{"lines": ["x"]}',
                 b'"1 Starmie BS 64"', b"\xff\xfe"):
        assert refused(post_body(owner, unsorted, body))["code"] == "INVALID_PASTE", body
    # The file route's content types still read a file, not a paste.
    assert code(post_body(owner, unsorted, b'{"text": "1 Starmie BS 64"}', "text/csv")) == "IMPORT_UNREADABLE"
    # A refused start isn't counted, and none of these was stored.
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM collection_import_start WHERE owner_id=%s",
                            (owner,)).fetchone()["n"] == 0
    assert call("GET", "/api/collection-imports/current", owner).status_code == 404


@pytest.mark.slow(reason="capacity: stores and matches a 10,000-line pasted draft")
def test_ten_thousand_pasted_lines_are_one_import():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = pasted(owner, unsorted, "1 Starmie BS 64\n" * 10_000)
    assert summary["counts"] == counts(rows=10_000, ready=10_000) and summary["cards_to_add"] == "10000"
