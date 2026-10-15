"""Collection Import drafts and bounds (#233): an open draft expires a day after its last change and a saved draft's
receipt a day after its save, and neither is read after that; the sweep deletes them with their rows. A collector starts
at most 20 drafts in any 24 hours. A save refused because a Card Edition is no longer active returns those rows to
Needs you. Another collector's draft id answers 404 on every route. 10,000 rows parse and match within 10 seconds.

Signed HTTP against PostgreSQL, with test_collection_import's catalog seed. Expiry is tested by moving a draft's
expires_at (and the start log's started_at) into the past, never by waiting.
"""
import csv
import io
import time
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest

from app.main import connect  # first: app.main imports the routers, and they import it
from test_batch_add import held, revision
from test_collection_import import (FOURTEEN, TWELVE, all_rows, code, collector, file_of, rows, save,
                                    seed_import_catalog, started, stored_rows, upload)
from test_collection_import_finishes import change, changed, counts, edition_where, tcgplayer
from test_collection_import_matching import seed
from test_holdings import call

FIXTURES = Path(__file__).parent / "collection_import_fixtures"
CURRENT = "/api/collection-imports/current"
# Older than any draft another test leaves expired, so the sweep, oldest first, reaches it first.
LONG_AGO = "2000-01-01T00:00:00Z"


def current(user):
    return call("GET", CURRENT, user)


def draft_row(import_id):
    with connect() as conn:
        return conn.execute("""SELECT status,created_at,changed_at,expires_at,saved_at FROM collection_import
          WHERE id=%s""", (import_id,)).fetchone()


def expire(import_id):
    with connect() as conn:
        conn.execute("UPDATE collection_import SET expires_at=%s WHERE id=%s", (LONG_AGO, import_id))


def set_active(source_ids_and_facets, active):
    editions = [edition_where(source_id, **facets) for source_id, facets in source_ids_and_facets]
    with connect() as conn:
        conn.execute("""UPDATE catalog_generation_edition SET active=%s
          WHERE generation_id=(SELECT active_generation FROM catalog_state WHERE singleton)
            AND edition_id=ANY(%s::uuid[])""", (active, editions))


def test_an_open_draft_expires_a_day_after_its_last_change_and_the_sweep_deletes_its_rows():
    seed_import_catalog()
    owner, unsorted = collector()
    other, _ = collector()
    summary = started(owner, unsorted, TWELVE)
    import_id = summary["id"]
    started_draft = draft_row(import_id)
    assert started_draft["expires_at"] - started_draft["changed_at"] == timedelta(hours=24)
    # A change moves the expiry to a day after it.
    with connect() as conn:
        conn.execute("""UPDATE collection_import SET changed_at=now()-interval '23 hours',
            expires_at=now()+interval '1 hour' WHERE id=%s""", (import_id,))
    changed(owner, import_id, 1, {"rows": [1], "skip": True})
    after = draft_row(import_id)
    assert after["changed_at"] > started_draft["changed_at"]
    assert after["expires_at"] - after["changed_at"] == timedelta(hours=24)

    # Expired, it is read by no route, though its rows wait for the sweep.
    expire(import_id)
    refused = {
        "rows": rows(owner, import_id),
        "changes": change(owner, import_id, 2, {"rows": [2], "skip": True}),
        "skipped.csv": call("GET", f"/api/collection-imports/{import_id}/skipped.csv", owner),
        "left-out.csv": call("GET", f"/api/collection-imports/{import_id}/left-out.csv", owner),
        "save": save(owner, import_id, draft_revision=2),
    }
    for route, response in refused.items():
        assert response.status_code == 404 and code(response) == "IMPORT_NOT_FOUND", (route, response.text)
    assert stored_rows(import_id) == 6
    # Any collector's next look at their own draft sweeps it, rows and all.
    assert current(other).status_code == 404
    assert draft_row(import_id) is None and stored_rows(import_id) == 0
    assert current(owner).status_code == 404


def test_a_saved_drafts_receipt_answers_replays_for_a_day_then_is_gone():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, TWELVE)
    key = uuid4()
    first = save(owner, summary["id"], key=key)
    assert first.status_code == 200, first.text
    receipt = draft_row(summary["id"])
    assert receipt["status"] == "saved" and receipt["expires_at"] - receipt["saved_at"] == timedelta(hours=24)
    assert stored_rows(summary["id"]) == 0
    assert save(owner, summary["id"], key=uuid4()).json() == first.json()
    before, holdings = revision(owner), held(owner, unsorted)

    expire(summary["id"])
    replay = save(owner, summary["id"], key=key)
    assert replay.status_code == 409 and code(replay) == "REPLAY_OUTCOME_UNAVAILABLE"
    again = save(owner, summary["id"], key=uuid4())
    assert again.status_code == 404 and code(again) == "IMPORT_NOT_FOUND"
    assert revision(owner) == before and held(owner, unsorted) == holdings
    assert current(owner).status_code == 404
    assert draft_row(summary["id"]) is None


def test_a_collector_starts_at_most_twenty_imports_a_day():
    seed_import_catalog()
    owner, unsorted = collector()
    other, other_unsorted = collector()
    one = file_of(1)
    # A refused start isn't counted.
    assert code(upload(owner, unsorted, b"Item,Cost\nStarmie,1\n")) == "IMPORT_UNREADABLE"
    assert code(upload(owner, str(uuid4()), one)) == "NOT_STORAGE_LEAF"
    for _ in range(20):
        last = started(owner, unsorted, one)
    refused = upload(owner, unsorted, TWELVE)
    assert refused.status_code == 429 and refused.json()["detail"] == {
        "code": "IMPORT_RATE_LIMITED", "message": "You can start 20 imports a day. Try again tomorrow."}
    # The open draft stays, and changing and saving it aren't limited.
    assert current(owner).json() == last
    changed(owner, last["id"], 1, {"rows": [1], "restore": True})
    assert save(owner, last["id"], draft_revision=2).status_code == 200
    # Another collector has their own 20.
    started(other, other_unsorted, one)
    # A day after a start, it no longer counts, and the start log keeps only the last 24 hours.
    with connect() as conn:
        conn.execute("""UPDATE collection_import_start SET started_at=now()-interval '24 hours'
          WHERE id=(SELECT id FROM collection_import_start WHERE owner_id=%s ORDER BY started_at LIMIT 1)""", (owner,))
    started(owner, unsorted, one)
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM collection_import_start WHERE owner_id=%s",
                            (owner,)).fetchone()["n"] == 20
    assert code(upload(owner, unsorted, one)) == "IMPORT_RATE_LIMITED"


def test_a_save_returns_rows_whose_card_edition_was_withdrawn_to_needs_you_and_refuses_review_changed():
    seed_import_catalog()
    owner, unsorted = collector()
    summary = started(owner, unsorted, tcgplayer(("Exeggcute", "Reverse Holofoil"), ("Celebi V", "Holofoil"),
                                                 ("Suicune", "Holofoil")))
    import_id = summary["id"]
    assert summary["counts"] == counts(rows=3, ready=3)
    # The collector chose Exeggcute's finish themselves: that choice is cleared with the Edition.
    changed(owner, import_id, 1, {"rows": [1], "finish": {"type": "reverse"}})
    before = revision(owner)
    set_active([("fixturefin-1", {"type": "reverse"}), ("fixturefin-5", {"type": "holo"})], False)
    response = save(owner, import_id, draft_revision=2)
    assert response.status_code == 409 and code(response) == "REVIEW_CHANGED"
    assert held(owner, unsorted) == {} and revision(owner) == before

    reloaded = current(owner).json()
    assert reloaded["draft_revision"] == 3 and reloaded["counts"] == counts(rows=3, needs_you=2, ready=1)
    waiting = {row["row_number"]: row for row in all_rows(owner, import_id, "needs")}
    # Exeggcute keeps its card and waits for a finish from the Editions still active; Celebi V has none left.
    exeggcute, celebi = waiting[1], waiting[2]
    assert (exeggcute["status"], exeggcute["card"]["name"], exeggcute["edition"]) == ("ambiguous", "Exeggcute", None)
    assert edition_where("fixturefin-1", type="reverse") not in {item["edition_id"] for item in exeggcute["editions"]}
    assert len(exeggcute["editions"]) == 3
    assert (celebi["status"], celebi["card"], celebi["picked"], celebi["by_name"]) == ("not_found", None, False, False)
    with connect() as conn:
        assert conn.execute("SELECT fix FROM collection_import_row WHERE import_id=%s AND row_number=1",
                            (import_id,)).fetchone()["fix"] in (None, {})

    # They wait for the collector like any other row; fixed or skipped, the save goes through.
    response = save(owner, import_id, draft_revision=3)
    assert response.status_code == 422 and code(response) == "ROWS_NEED_YOU"
    changed(owner, import_id, 3, {"rows": [1], "finish": {"type": "normal"}}, {"rows": [2], "skip": True})
    assert save(owner, import_id, draft_revision=4).status_code == 200
    assert held(owner, unsorted) == {edition_where("fixturefin-1", type="normal"): "1",
                                     edition_where("fixturefin-2", type="holo"): "1"}
    set_active([("fixturefin-1", {"type": "reverse"}), ("fixturefin-5", {"type": "holo"})], True)


def test_another_collectors_draft_id_answers_404_on_every_route():
    seed_import_catalog()
    owner, unsorted = collector()
    other, _ = collector()
    summary = started(owner, unsorted, FOURTEEN)
    import_id = summary["id"]
    refused = {
        "rows": rows(other, import_id),
        "changes": change(other, import_id, 1, {"rows": [1], "skip": True}),
        "skipped.csv": call("GET", f"/api/collection-imports/{import_id}/skipped.csv", other),
        "left-out.csv": call("GET", f"/api/collection-imports/{import_id}/left-out.csv", other),
        "save": save(other, import_id),
    }
    for route, response in refused.items():
        assert response.status_code == 404 and code(response) == "IMPORT_NOT_FOUND", (route, response.text)
    assert current(other).status_code == 404
    # Nothing reached the owner's draft.
    assert current(owner).json() == summary


def budget_file(count=10_000):
    """`count` rows of the TCGplayer match-rate fixture's 14 columns, each with a product ID nothing names: four in ten
    as the fixture has them, three in ten at a number no set holds (so they fall through to the name), and three in ten
    with a card and set name the catalog doesn't hold."""
    lines = (FIXTURES / "match-rate-tcgplayer.csv").read_text().splitlines()
    header, base = lines[0], [next(csv.reader([line])) for line in lines[1:] if line.strip()]
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    for index in range(count):
        row = list(base[index % len(base)])
        kind = index % 10
        if kind in (4, 5, 6):
            row[4] = f"{1000 + index}/999"
        elif kind >= 7:
            row[1] = row[2] = f"Unknown Card {index}"
            row[3] = f"Unknown Set {index % 400}"
            row[4] = str(index)
        row[10] = str(950000 + index)
        writer.writerow(row)
    return (header + "\n" + out.getvalue()).encode()


# Not slow, though it builds a 10,000-row draft: the ticket asks for this budget in CI, which runs the fast tier. About
# 0.6 s against the 10 s bound (#233).
@pytest.mark.serial(reason="asserts an upper bound on the start route's elapsed time")
def test_ten_thousand_fixture_rows_parse_and_match_within_ten_seconds():
    seed()
    owner, unsorted = collector()
    data = budget_file()
    began = time.perf_counter()
    response = upload(owner, unsorted, data)
    took = time.perf_counter() - began
    assert response.status_code == 201, response.text
    assert response.json()["counts"] == counts(rows=10_000, needs_you=3400, ready=6600, by_name=1800)
    assert took < 10, f"10,000 rows took {took:.1f} s"
