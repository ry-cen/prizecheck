"""Collection Import: resolving flagged rows (#229). A row whose number fails is matched by its name within its set
(Matched by name for one card, Pick one for several, Not found for none: a Printing is never guessed from another
set), and a row whose set names no set the catalog holds is Pick one with every card of that name. The changes route
picks a card (a Printing or an Edition), skips and restores, by rows or by filter; the rows route lists each row's
candidate cards and filters Matched by name; skipped.csv downloads the skipped rows in the file's own columns. Signed
HTTP against PostgreSQL, with test_collection_import's seed and test_collection_import_matching's cards.
"""
import csv
import io
from pathlib import Path
from uuid import uuid4

import pytest

from app.games.pokemon.catalog import catalog_dispatch
from app.main import connect  # first: app.main imports the routers, and they import it
from test_collection_import import _card, all_rows, code, collector, edition, save, seed_import_catalog, started
from test_collection_import_finishes import DRAGON_SHIELD, TCGPLAYER, change, changed, counts
from test_collection_import_matching import (MATCHING_CARDS, candidates, csv_file, dragon_shield, imported, outcomes,
                                             printings, seed, tcgplayer)
from test_holdings import call

FIXTURES = Path(__file__).parent / "collection_import_fixtures"
BOSS = _card("swsh2-154", "Boss's Orders (Giovanni)", "154", "swsh2", "Rebel Clash", category="Trainer",
             trainerType="Supporter")


def printing(source_id):
    with connect() as conn:
        return str(conn.execute("SELECT id FROM catalog_printing WHERE source_id=%s", (source_id,)).fetchone()["id"])


def rows_of(owner, summary, filter_="all"):
    by_id = printings()
    return [(row["row_number"], row["status"], by_id[str(row["card"]["printing_id"])] if row["card"] else None)
            for row in all_rows(owner, summary["id"], filter_)]


def fixes(summary):
    with connect() as conn:
        return [row["fix"] for row in conn.execute(
            "SELECT fix FROM collection_import_row WHERE import_id=%s ORDER BY row_number", (summary["id"],))]


def download(owner, import_id):
    return call("GET", f"/api/collection-imports/{import_id}/skipped.csv", owner)


def test_a_name_within_the_rows_set_matches_one_card_offers_several_and_never_guesses_another_set():
    seed_import_catalog(*MATCHING_CARDS, BOSS)
    owner, _, summary = imported(
        TCGPLAYER,
        tcgplayer("Starmie", "Base Set", "999/102"),  # the number fails; Base Set has one Starmie
        tcgplayer("Poke Ball", "Jungle", ""),  # no accent, no number: Poké Ball
        tcgplayer("Boss's Orders", "Rebel Clash", ""),  # the catalog's (Giovanni) subtitle is optional
        tcgplayer("Klara", "SWSH06: Chilling Reign", "999/198"),  # two Klaras in the set: Pick one
        tcgplayer("Pikachu", "Fixture Promos", ""),  # two sets of that name, one Pikachu each: Pick one
        tcgplayer("Starmie", "Jungle", "999/64"),  # Starmie is in Base Set, not Jungle: never guessed
        tcgplayer("Klara", "Miscellaneous Cards & Products", ""),  # no set the catalog holds: every Klara
        tcgplayer("Starmie", "Prize Pack Series Cards", "12/150"),  # no set, one card of the name: still Pick one
        tcgplayer("Missingno", "Miscellaneous Cards & Products", "1"),  # nothing of the name: Not found
        tcgplayer("", "Base Set", ""),  # no number and no name: Can't read
        tcgplayer("Weepinbell", "Jungle", "999/64", ""),  # by name, on its Unspecified Variant: Finish unknown wins
        tcgplayer("Dark Golduck", "Team Rocket Returns", "", "Reverse Holofoil"),  # by name, its finish chosen
        tcgplayer("Dark Golduck", "Team Rocket Returns", "", ""))  # by name, its finish to pick
    assert outcomes(owner, summary) == [
        ("by_name", "base1-64"), ("by_name", "base2-64"), ("by_name", "swsh2-154"), ("ambiguous", None),
        ("ambiguous", None), ("not_found", None), ("ambiguous", None), ("ambiguous", None), ("not_found", None),
        ("unreadable", None), ("finish_unknown", "base2-48"), ("by_name", "ex7-35"), ("ambiguous", "ex7-35")]
    assert candidates(summary) == [[], [], [], ["swsh6-145", "swsh6-194"], ["fixtureimporta-1", "fixtureimportb-1"],
                                   [], ["swsh6-145", "swsh6-194"], ["base1-64"], [], [], [], [], []]
    assert summary["counts"] == counts(rows=13, needs_you=8, ready=5, finish_unknown=1, by_name=5)
    found = all_rows(owner, summary["id"])
    assert [card["name"] for card in found[3]["candidates"]] == ["Klara", "Klara"]
    assert [card["collector_number"] for card in found[3]["candidates"]] == ["145", "194"]
    assert found[3]["card"] is None and found[3]["needs_you"]
    # Matched by name: the ready rows whose card came from their name, whatever their finish says (row 11 is Finish
    # unknown), and only those; row 13's finish is still to pick, so it needs you. Each row reports by_name and picked.
    assert [number for number, _, _ in rows_of(owner, summary, "name")] == [1, 2, 3, 11, 12]
    assert [row["by_name"] for row in found] == [True] * 3 + [False] * 7 + [True] * 3
    assert not any(row["picked"] for row in found)


def test_a_missing_card_stays_not_found_and_no_route_starts_a_catalog_pull(monkeypatch):
    seed()

    def forbidden(*args, **kwargs):
        pytest.fail("a Collection Import route started a catalog pull")

    for name in ("dispatch_import", "launch_import"):
        monkeypatch.setattr(catalog_dispatch, name, forbidden)
    with connect() as conn:
        runs = conn.execute("SELECT count(*) AS n FROM catalog_run").fetchone()["n"]
    owner, _, summary = imported(TCGPLAYER, tcgplayer("Pecharunt ex", "SV: Shrouded Fable", "039/064"),
                                 tcgplayer("Starmie", "Base Set", "064/102"))
    assert outcomes(owner, summary) == [("not_found", None), ("matched", "base1-64")]
    result = changed(owner, summary["id"], 1, {"rows": [1], "skip": True})
    assert result["summary"]["counts"] == counts(rows=2, ready=1, skipped=1)
    assert download(owner, summary["id"]).status_code == 200
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_run").fetchone()["n"] == runs


def test_pick_by_printing_or_edition_resolves_a_row_and_records_the_fix():
    seed()
    owner, unsorted, summary = imported(
        TCGPLAYER, tcgplayer("Pikachu", "Fixture Promos", ""), tcgplayer("Dark Golduck", "Team Rocket Returns", "", ""),
        tcgplayer("Weepinbell", "Somewhere", "48"), tcgplayer("Missingno", "Base Set", "1"),
        tcgplayer("Starmie", "Base Set", "999/102"))
    import_id = summary["id"]
    assert summary["counts"] == counts(rows=5, needs_you=4, ready=1, by_name=1)
    golduck = edition("ex7-35", "reverse")
    result = changed(owner, import_id, 1,
                     {"rows": [1], "pick": {"printing_id": printing("fixtureimportb-1")}},  # one Edition: matched
                     {"rows": [2], "pick": {"printing_id": printing("ex7-35")}},  # no finish: still its finish to pick
                     {"rows": [3], "pick": {"edition_id": edition("base2-48")}},  # the Unspecified Variant
                     {"rows": [4], "pick": {"printing_id": printing("base1-42")}},  # a search result
                     {"rows": [5], "pick": {"edition_id": edition("base1-64", "normal")}})  # its own card: by name
    assert [item["applied"] for item in result["results"]] == [1, 1, 1, 1, 1]
    assert result["summary"]["draft_revision"] == 2
    # A pick ends Matched by name, even for the row's own card (row 5).
    assert result["summary"]["counts"] == counts(rows=5, needs_you=1, ready=4, finish_unknown=1)
    assert outcomes(owner, result["summary"]) == [
        ("matched", "fixtureimportb-1"), ("ambiguous", "ex7-35"), ("finish_unknown", "base2-48"),
        ("matched", "base1-42"), ("matched", "base1-64")]
    # Every picked row reports picked, including the search result for a Not found row and the card still waiting for
    # its finish, so Change can choose another; none is by_name any more.
    picked = all_rows(owner, import_id)
    assert [row["picked"] for row in picked] == [True] * 5 and not any(row["by_name"] for row in picked)
    # Picking the Edition finishes the row, and the fix keeps the pick, not an earlier finish.
    changed(owner, import_id, 2, {"rows": [2], "finish": {"type": "normal"}})
    result = changed(owner, import_id, 3, {"rows": [2], "pick": {"edition_id": golduck}})
    assert outcomes(owner, result["summary"])[1] == ("matched", "ex7-35")
    assert fixes(result["summary"])[1] == {"pick": {"printing_id": printing("ex7-35"), "edition_id": golduck}}
    assert fixes(result["summary"])[0] == {"pick": {"printing_id": printing("fixtureimportb-1")}}
    assert all_rows(owner, import_id)[1]["edition"]["edition_id"] == golduck
    response = save(owner, import_id, draft_revision=4)
    assert response.status_code == 200, response.text
    assert response.json()["copy_count"] == "5"


def test_pick_by_filter_applies_to_every_row_it_can_and_reports_the_rest():
    seed()
    owner, _, summary = imported(TCGPLAYER, tcgplayer("Pikachu", "Fixture Promos", ""),
                                 tcgplayer("Pikachu", "Fixture Promos", "", quantity="0"),
                                 tcgplayer("Pikachu", "Fixture Promos", ""),
                                 tcgplayer("Pikachu", "Fixture Promos", ""))
    import_id = summary["id"]
    changed(owner, import_id, 1, {"rows": [4], "skip": True})
    result = changed(owner, import_id, 2, {"filter": "needs", "pick": {"printing_id": printing("fixtureimporta-1")}})
    # A quantity that can't be read can't take a card; a skipped row isn't in Needs you.
    assert result["results"] == [{"applied": 2, "not_applied": [2]}]
    assert outcomes(owner, result["summary"]) == [("matched", "fixtureimporta-1"), ("unreadable", None),
                                                  ("matched", "fixtureimporta-1")]
    result = changed(owner, import_id, 3, {"rows": [2, 4], "pick": {"printing_id": printing("fixtureimporta-1")}})
    assert result["results"] == [{"applied": 0, "not_applied": [2, 4]}]


def test_skip_and_restore_by_rows_and_by_filter_and_skip_all():
    seed()
    owner, _, summary = imported(TCGPLAYER, tcgplayer("Starmie", "Base Set", "999/102"),
                                 tcgplayer("Pikachu", "Fixture Promos", ""), tcgplayer("Missingno", "Base Set", "1"),
                                 tcgplayer("Starmie", "Base Set", "064/102"))
    import_id = summary["id"]
    assert summary["counts"] == counts(rows=4, needs_you=2, ready=2, by_name=1)
    result = changed(owner, import_id, 1, {"filter": "name", "skip": True})
    assert result["results"] == [{"applied": 1, "not_applied": []}]
    assert result["summary"]["counts"] == counts(rows=4, needs_you=2, ready=1, skipped=1)
    # Skip all on Needs you.
    result = changed(owner, import_id, 2, {"filter": "needs", "skip": True})
    assert result["results"] == [{"applied": 2, "not_applied": []}]
    assert result["summary"]["counts"] == counts(rows=4, ready=1, skipped=3)
    assert [number for number, _, _ in rows_of(owner, result["summary"], "skipped")] == [1, 2, 3]
    result = changed(owner, import_id, 3, {"rows": [2, 4], "restore": True})
    assert result["results"] == [{"applied": 1, "not_applied": [4]}]
    result = changed(owner, import_id, 4, {"filter": "skipped", "restore": True})
    assert result["summary"]["counts"] == counts(rows=4, needs_you=2, ready=2, by_name=1)


def test_a_bad_pick_or_a_stale_revision_is_refused_and_changes_nothing():
    seed()
    owner, _, summary = imported(TCGPLAYER, tcgplayer("Pikachu", "Fixture Promos", ""))
    import_id = summary["id"]
    for bad in ({"rows": [1], "pick": {}},
                {"rows": [1], "pick": {"printing_id": printing("base1-64"),
                                       "edition_id": edition("base1-64", "normal")}},
                {"rows": [1], "pick": {"printing_id": printing("base1-64")}, "skip": True}):
        response = change(owner, import_id, 1, bad)
        assert response.status_code == 422 and code(response) == "INVALID_CHANGE", (bad, response.text)
    for bad in ({"rows": [1], "pick": {"printing_id": str(uuid4())}},
                {"rows": [1], "pick": {"edition_id": str(uuid4())}}):
        response = change(owner, import_id, 1, bad)
        assert response.status_code == 422 and code(response) == "INVALID_PICK", (bad, response.text)
    for bad in ({"rows": [1], "pick": {"printing_id": "x"}}, {"rows": [1], "pick": {"set_id": "base1"}},
                {"rows": [1], "pick": printing("base1-64")}):
        assert change(owner, import_id, 1, bad).status_code == 422, bad
    response = change(owner, import_id, 2, {"rows": [1], "pick": {"printing_id": printing("fixtureimporta-1")}})
    assert response.status_code == 409 and code(response) == "STALE_DRAFT"
    current = call("GET", "/api/collection-imports/current", owner).json()
    assert current["draft_revision"] == 1 and current["counts"] == summary["counts"]
    assert outcomes(owner, summary) == [("ambiguous", None)] and fixes(summary) == [None]


def test_skipped_rows_download_in_the_files_own_columns():
    seed()
    owner, unsorted = collector()
    twelve = (FIXTURES / "tcgplayer-app-12-crlf.csv").read_bytes()
    summary = started(owner, unsorted, twelve)
    import_id = summary["id"]
    response = download(owner, import_id)
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == 'attachment; filename="skipped-rows.csv"'
    assert response.headers["cache-control"] == "no-store"
    header = twelve.split(b"\r\n")[0].decode()
    assert response.content == ("﻿" + header + "\r\n").encode()  # nothing skipped: the header alone
    changed(owner, import_id, 1, {"rows": [1, 3], "skip": True})
    lines = twelve.decode().split("\r\n")
    assert download(owner, import_id).content.decode("utf-8") == "﻿" + "\r\n".join(
        [header, lines[1], lines[3]]) + "\r\n"
    changed(owner, import_id, 2, {"rows": [1], "restore": True})
    assert download(owner, import_id).content.decode("utf-8") == "﻿" + "\r\n".join([header, lines[3]]) + "\r\n"
    # A tab-separated file comes back as CSV with the same columns; a Dragon Shield file without its "sep=," line.
    for data in ((FIXTURES / "tcgplayer-app-14.tsv").read_bytes(),
                 csv_file(DRAGON_SHIELD, dragon_shield("Starmie", "BS", "Base Set", "064 / 102"))):
        summary = started(owner, unsorted, data)
        changed(owner, summary["id"], 1, {"rows": [1], "skip": True})
        text = download(owner, summary["id"]).content.decode("utf-8-sig")
        header_cells, row_cells = list(csv.reader(io.StringIO(text, newline="")))
        source_lines = [line for line in data.decode().splitlines() if line and not line.startswith('"sep=')]
        assert header_cells == next(csv.reader([source_lines[0]], delimiter="\t" if b"\t" in data else ","))
        assert row_cells == next(csv.reader([source_lines[1]], delimiter="\t" if b"\t" in data else ","))
    # Another collector's draft, an unknown one and a saved one are not found.
    other, _ = collector()
    for user, draft in ((other, summary["id"]), (owner, str(uuid4()))):
        response = download(user, draft)
        assert response.status_code == 404 and code(response) == "IMPORT_NOT_FOUND"
    changed(owner, summary["id"], 2, {"rows": [1], "restore": True})
    assert save(owner, summary["id"], draft_revision=3).status_code == 200
    assert download(owner, summary["id"]).status_code == 404


def test_a_by_name_row_keeps_by_name_through_a_finish_and_a_pick_clears_it():
    seed()
    owner, _, summary = imported(
        TCGPLAYER, tcgplayer("Weepinbell", "Jungle", "999/64", ""),  # by name, on its Unspecified Variant
        tcgplayer("Dark Golduck", "Team Rocket Returns", "", ""),  # by name, its finish to pick
        tcgplayer("Missingno", "Base Set", "1"))  # Not found
    import_id = summary["id"]
    assert outcomes(owner, summary) == [("finish_unknown", "base2-48"), ("ambiguous", "ex7-35"), ("not_found", None)]
    # Both are flagged by_name; only the ready one (Finish unknown) is in the name filter and its count.
    assert summary["counts"] == counts(rows=3, needs_you=2, ready=1, finish_unknown=1, by_name=1)
    assert [number for number, _, _ in rows_of(owner, summary, "name")] == [1]
    assert [row["by_name"] for row in all_rows(owner, import_id)] == [True, True, False]
    # Choosing the finish of the by-name Golduck leaves it Matched by name, and its pill and Change stay.
    result = changed(owner, import_id, 1, {"rows": [2], "finish": {"type": "reverse"}})
    assert outcomes(owner, result["summary"])[:2] == [("finish_unknown", "base2-48"), ("by_name", "ex7-35")]
    assert result["summary"]["counts"] == counts(rows=3, needs_you=1, ready=2, finish_unknown=1, by_name=2)
    assert [row["by_name"] for row in all_rows(owner, import_id)] == [True, True, False]
    # A picked Not found row reports picked, and can be picked again.
    changed(owner, import_id, 2, {"rows": [3], "pick": {"printing_id": printing("base1-42")}})
    row = all_rows(owner, import_id)[2]
    assert row["picked"] and not row["by_name"] and row["status"] == "matched"
    result = changed(owner, import_id, 3, {"rows": [3], "pick": {"printing_id": printing("base1-64")}},
                     {"rows": [1], "pick": {"printing_id": printing("base1-64")}})
    found = all_rows(owner, import_id)
    assert [(row["picked"], row["by_name"]) for row in found] == [(True, False), (False, True), (True, False)]
    assert [card for _, _, card in rows_of(owner, result["summary"])][2] == "base1-64"
