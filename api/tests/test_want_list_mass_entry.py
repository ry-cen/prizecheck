"""Buy on TCGplayer from the Want List (decklist import #210): ``GET /api/want-list/exports/tcgplayer`` and its ``.txt``
download through signed HTTP against PostgreSQL.

The export is exactly what the Want List shows under the account's counting setting: the combined total with no
``deck``, or that Deck's needs with one. It reuses the private Deck export's Mass Entry formatter and view, so its link,
text, coverage reason and less-specific rows are the Deck export's own. The download is pinned to the view the page
prepared. It is not a price access.

Every test starts a new owner, so no setting leaks between tests.
"""
import re
from uuid import uuid4

import pytest

from app.main import connect  # noqa: F401
from app import prices
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import buy_missing, counting, deck, hold, iono_world, line, new_owner
from test_holdings import call
from test_prices import client, seed, world
from test_want_list import want_list
from test_want_list_cost import body_of as cost_body, cost

BASE = "https://www.tcgplayer.com/massentry?productline=Pokemon&c="
PAIRED = ("want_list_counting", "settings_revision", "owner_revision", "deck_lists_digest", "deck_id")
VIEW = ("status", "url", "fallback_reason", "text", "inline", "byte_length", "lines", "line_count",
        "less_specific_count", "total_copies")


def export(owner, scope=None):
    response = call("GET", "/api/want-list/exports/tcgplayer" + (f"?deck={scope}" if scope else ""), owner)
    assert response.status_code == 200, response.text
    return response.json()


def download(owner, view, **override):
    """The ``.txt`` download pinned to ``view``, as the page's link builds it; ``override`` replaces a pin."""
    pins = {"owner_revision": view["owner_revision"], "settings_revision": view["settings_revision"],
            "deck_lists": view["deck_lists_digest"], **({"deck": view["deck_id"]} if view["deck_id"] else {}), **override}
    query = "&".join(f"{key}={value}" for key, value in pins.items() if value is not None)
    return call("GET", f"/api/want-list/exports/tcgplayer.txt?{query}", owner)


def quantities(view):
    return [entry["quantity"] for entry in view["lines"]]


def mixed_world(store):
    """Furret's normal Edition (a verified TCGplayer product, $0.25) and Furret's Unspecified Variant Printing (no
    product): Older lists 2 normal and holds 1; Newer lists 3 normal and 1 Unspecified. Returns (owner, older, newer)."""
    found = world()
    normal, plain = str(found["normal"]["id"]), str(found["unspecified"]["id"])
    seed(store, found["normal"], "0.25")
    owner, _ = new_owner()
    older, newer = deck(owner, "Older", 0), deck(owner, "Newer", 1)
    hold(owner, older, normal, 1)
    line(owner, older, normal, 2)
    line(owner, newer, normal, 3)
    line(owner, newer, plain, 1)
    return owner, older, newer


def test_all_decks_exports_the_combined_total_and_a_deck_exports_its_needs(store):
    owner, charizard, gardevoir, _ = iono_world(store)
    expected = {"all_at_once": {None: "4", charizard: "2", gardevoir: "2"},
                "one_at_a_time": {None: "2", charizard: "2", gardevoir: "0"}}
    for setting, totals in expected.items():
        counting(owner, setting)
        for scope, total in totals.items():
            view = export(owner, scope)
            shown = want_list(owner, scope)
            assert {key: view[key] for key in PAIRED} == {key: shown[key] for key in PAIRED}
            assert view["total_copies"] == shown["to_get"] == total, (setting, scope)
            if total == "0":
                assert (view["status"], view["lines"], view["url"]) == ("empty", [], None)
            else:
                # Iono stands in as Furret's normal Edition, a verified product: one link for every copy.
                assert (view["status"], quantities(view)) == ("link", [total])
                assert re.fullmatch(rf"{re.escape(BASE)}{total}-[0-9]+", view["url"]), view["url"]


def test_a_scoped_export_is_the_decks_own_buy_missing(store):
    owner, older, newer = mixed_world(store)
    for setting in ("all_at_once", "one_at_a_time"):
        counting(owner, setting)
        for deck_id in (older, newer):
            view, own = export(owner, deck_id), buy_missing(owner, deck_id)
            assert {key: view[key] for key in VIEW} == {key: own[key] for key in VIEW}, (setting, deck_id)


def test_coverage_and_less_specific_wording_follow_the_mass_entry_formatter(store):
    owner, older, newer = mixed_world(store)
    # Every Deck built at once: Older needs 1 normal; Newer can't count Older's copy and needs 3 normal and 1 plain.
    view = export(owner)
    assert (view["status"], view["url"], view["fallback_reason"]) == ("text", None, "missing_mapping")
    assert view["total_copies"] == "5"
    # One line per Printing, name only, so every line is less specific; the text keeps every copy.
    assert sorted(entry["text"] for entry in view["lines"]) == ["1 Furret", "4 Furret"]
    assert (view["line_count"], view["less_specific_count"]) == (2, 2)
    assert all(entry["less_specific"] for entry in view["lines"])
    assert sorted(view["text"].split("\n")) == ["1 Furret", "4 Furret"]
    # Older needs only the verified product: a link and no text.
    scoped = export(owner, older)
    assert (scoped["status"], scoped["text"]) == ("link", None)
    assert re.fullmatch(rf"{re.escape(BASE)}1-[0-9]+", scoped["url"]), scoped["url"]


def test_the_download_is_the_prepared_text_and_is_refused_once_anything_it_counted_moves(store):
    owner, older, newer = mixed_world(store)
    view = export(owner)
    response = download(owner, view)
    assert response.status_code == 200, response.text
    assert response.text == view["text"]
    assert response.headers["content-disposition"] == 'attachment; filename="tcgplayer-mass-entry.txt"'
    assert response.headers["cache-control"] == "no-store"
    scoped = export(owner, newer)
    assert download(owner, scoped).text == scoped["text"]

    # A Deck List edit moves neither revision: the digest refuses it.
    edition = want_list(owner, older)["sections"][0]["lines"][0]["edition_id"]
    line(owner, older, edition, 4)
    refused = download(owner, view)
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "DECK_LIST_CHANGED")
    # The setting moves only the settings revision.
    view = export(owner)
    counting(owner, "one_at_a_time")
    refused = download(owner, view)
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "SETTINGS_CHANGED")
    # A Holding change moves the inventory revision.
    view = export(owner)
    hold(owner, older, edition, 1)
    refused = download(owner, view)
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "INVENTORY_CHANGED")
    # Every pin is required and the digest has one form.
    view = export(owner)
    for missing in ("owner_revision", "settings_revision", "deck_lists"):
        assert download(owner, view, **{missing: None}).status_code == 422, missing
    assert download(owner, view, deck_lists="not-a-digest").status_code == 422


def test_nothing_to_get_downloads_nothing(store):
    owner, _ = new_owner()
    edition = str(world()["normal"]["id"])
    built = deck(owner, "Built", 0)
    hold(owner, built, edition, 2)          # moving copies in lists them: the Deck needs nothing
    for scope in (None, built):
        view = export(owner, scope)
        assert (view["status"], view["total_copies"], view["lines"]) == ("empty", "0", [])
        refused = download(owner, view)
        assert (refused.status_code, refused.json()["detail"]["code"]) == (422, "NOTHING_NOT_OWNED")


def test_the_export_and_the_cost_count_the_same_copies(store):
    owner, older, newer = mixed_world(store)
    for setting in ("all_at_once", "one_at_a_time"):
        counting(owner, setting)
        for scope in (None, older, newer):
            priced = cost_body(cost(owner, scope))
            view = export(owner, scope)
            assert view["total_copies"] == priced["total"]["total_copies"], (setting, scope)
            assert {key: view[key] for key in PAIRED} == {key: priced[key] for key in PAIRED}


def test_the_export_is_private_scoped_like_the_want_list_and_not_a_price_access(store, launches, monkeypatch):
    monkeypatch.setattr(prices, "quote_states", lambda *a, **k: pytest.fail("the export read a price"))
    owner, older, _ = mixed_world(store)
    stranger, _ = new_owner()
    unsorted = next(entry["id"] for entry in call("GET", "/api/location-tree", owner).json()["locations"]
                    if entry["name"] == "Unsorted")
    for scope, user in ((older, stranger), (str(uuid4()), owner), (unsorted, owner)):
        for path in ("/api/want-list/exports/tcgplayer", "/api/want-list/exports/tcgplayer.txt"):
            query = f"?deck={scope}" + ("&owner_revision=1&settings_revision=1&deck_lists=" + "0" * 32
                                         if path.endswith(".txt") else "")
            response = call("GET", path + query, user)
            assert (response.status_code, response.json()["detail"]["code"]) == (404, "DECK_NOT_FOUND"), path
    assert call("GET", "/api/want-list/exports/tcgplayer?deck=not-a-uuid", owner).status_code == 422
    assert client.get("/api/want-list/exports/tcgplayer").status_code == 401
    export(owner)
    export(owner, older)
    assert launches == []
