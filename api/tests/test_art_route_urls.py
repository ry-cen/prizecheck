"""The signed-in app shows card art from the art route (#360, ADR 0020).

Every signed-in read that returns an image address returns ``/api/art/{printing_id}/{size}?v=...`` and no TCGdex or
TCGplayer address. A Printing with only fallback art gets a route address too, and the route answers it with a redirect to the
linked image; a Printing with no art has no address. The Published Deck page and the public catalog are anonymous and keep
their direct addresses.
"""
import json
import re
import time
from pathlib import Path
from uuid import uuid4

import pytest

from app.games.pokemon.catalog import public_catalog
from app.art_urls import art_url, art_version, large_direct_url
from app.main import app, connect
from app.public_projection import public_projection_store, public_record_store
from app.public_records import catalog_printing_key
from fastapi.testclient import TestClient
from test_catalog import headers
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches  # noqa: F401  (an autouse fixture)
from test_deck_counting import hold, line
from test_decks import create
from test_deck_lists import detail
from test_discover_listing import LEGAL, catalog, published
from test_for_trade_locations import mark
from test_friend_copies import collection, ok, place
from test_published_cost import USER, store  # noqa: F401  (an autouse fixture)
from test_holdings import call
from test_trade_lists import friend_list, friends
from test_trade_matches import matches
from test_trade_wants import set_want
from want_list_swap_fixtures import seed_swap_catalog

client = TestClient(app)
ROUTE = re.compile(r"^/api/art/[0-9a-f-]{36}/(small|large)\?v=[0-9a-f]{8}$")
IMAGE_KEYS = {"image_url", "low_image_url", "high_image_url"}
HOST = "https://assets.tcgdex.net/en/fixture/"
FALLBACK_PRODUCT = 500


def image_values(value, found=None):
    """Every non-null value under an image key, anywhere in a response."""
    found = [] if found is None else found
    if isinstance(value, dict):
        for key, item in value.items():
            if key in IMAGE_KEYS and item is not None:
                found.append(item)
            else:
                image_values(item, found)
    elif isinstance(value, list):
        for item in value:
            image_values(item, found)
    return found


def only_routes(name, body, expect):
    """The response has at least ``expect`` image addresses, all art-route addresses, and names no art host."""
    values = image_values(body)
    assert len(values) >= expect, (name, values)
    assert all(ROUTE.match(value) for value in values), (name, values)
    text = json.dumps(body)
    assert "tcgdex.net" not in text and "tcgplayer" not in text, name
    return values


@pytest.fixture
def swap_world():
    """The Swap catalog with art: every Printing has a TCGdex image, except SVE 13 (no art at all) and PAF 80 (only a
    TCGplayer fallback, as ``card_art.refresh_fallbacks`` would leave it)."""
    ids = seed_swap_catalog()
    with connect() as conn:
        conn.execute("""UPDATE catalog_generation_printing gp SET image_url=%s || gp.source_id
          WHERE gp.generation_id=(SELECT active_generation FROM catalog_state)""", (HOST,))
        conn.execute("""UPDATE catalog_generation_printing SET image_url=NULL
          WHERE source_id IN ('sve-013','sv04.5-080')""")
        assert not conn.execute("""SELECT 1 FROM catalog_printing_display pd JOIN catalog_printing p ON p.id=pd.printing_id
          WHERE p.source_id IN ('sve-013','sv04.5-080') AND pd.image_url IS NOT NULL""").fetchone()
        paf = conn.execute("SELECT id FROM catalog_printing WHERE source_id='sv04.5-080'").fetchone()["id"]
        conn.execute("TRUNCATE tcgplayer_product CASCADE")
        conn.execute("""INSERT INTO tcgplayer_product(product_id,group_id,name,number,number_key,image_count,seen_at,source_updated_at)
          VALUES (%s,1,'Iono','80','80',1,now(),now())""", (FALLBACK_PRODUCT,))
        conn.execute("INSERT INTO catalog_printing_fallback_art(printing_id,product_id) VALUES (%s,%s)", (paf, FALLBACK_PRODUCT))
    return ids, paf


def test_every_signed_in_read_carries_route_addresses_and_no_art_host(swap_world):
    ids, paf = swap_world
    (misty, misty_handle), (ash, _) = friends("Misty W.", "Ash K.")
    iono, fallback, bare = ids["PAL 185"], ids["PAF 80"], ids["SVE 13"]
    binder = place(misty, "Trade Binder")
    for edition in (iono, fallback, bare):
        hold(misty, binder, edition, 1)
    ok(mark(misty, binder))
    deck = create(ash, f"Art deck {uuid4()}").json()["location"]["id"]
    for edition in (iono, fallback, bare):
        line(ash, deck, edition, 2)
    ok(set_want(ash, iono, 1))
    answers = {
        "trade matches": {"rows": matches(ash)["rows"]},
        "deck import review": call("POST", "/api/decks/import/review", ash,
                                   {"source": {"text": "4 Iono PAL 185\n"}, "fixes": []}),
        "holdings": call("GET", f"/api/holdings/{binder}", misty),
        "collection": call("GET", "/api/collection", misty),
        "collection holdings": call("GET", "/api/collection/holdings", misty),
        "trade list": call("GET", "/api/trades/list", misty),
        "friend trade list": friend_list(ash, misty_handle),
        "friend collection": collection(ash, misty_handle),
        "deck": call("GET", f"/api/decks/{deck}", ash),
        "decks": call("GET", "/api/decks", ash),
        "want list": call("GET", "/api/want-list", ash),
    }
    assert answers["trade matches"]["rows"], "Misty offers the Iono Ash wants"
    for name, response in answers.items():
        body = response if isinstance(response, dict) else response.json()
        if not isinstance(response, dict):
            assert response.status_code == 200, (name, response.text)
        # The Deck index shows a cover only when the Deck leads with a card it can picture.
        only_routes(name, body, 0 if name == "decks" else 1)
    deck_lines = detail(ash, deck)["deck_list"]["lines"]
    by_edition = {entry["edition_id"]: entry["image_url"] for entry in deck_lines}
    assert ROUTE.match(by_edition[iono]) and ROUTE.match(by_edition[fallback]) and by_edition[bare] is None
    assert by_edition[iono].endswith("?v=" + art_version(HOST + "sv02-185/low.webp"))
    # The fallback Printing's address names its own Printing and the fallback source's version.
    assert by_edition[fallback].startswith(f"/api/art/{paf}/small?v=")


def test_the_route_serves_fallback_art_as_a_link_and_a_bare_printing_has_none(swap_world):
    ids, paf = swap_world
    with connect() as conn:
        bare = conn.execute("SELECT id FROM catalog_printing WHERE source_id='sve-013'").fetchone()["id"]
    user = f"art-{uuid4()}"
    for size, suffix in (("small", "200w"), ("large", "400w")):
        path = f"/api/art/{paf}/{size}"
        found = client.get(path, headers=headers(user, "GET", path), follow_redirects=False)
        assert found.status_code == 302, found.text
        assert found.headers["location"] == f"https://tcgplayer-cdn.tcgplayer.com/product/{FALLBACK_PRODUCT}_{suffix}.jpg"
        assert found.headers["cache-control"] == "private, no-cache"
    # A current address is cached for a year; the two sizes of one Printing share a version.
    with connect() as conn:
        small = conn.execute("SELECT small_art_url, large_art_url FROM catalog_printing_art WHERE printing_id=%s", (paf,)).fetchone()
    for address in (small["small_art_url"], small["large_art_url"]):
        path, query = address.split("?")
        found = client.get(path, params=dict(pair.split("=") for pair in query.split("&")),
                           headers=headers(user, "GET", path), follow_redirects=False)
        assert found.status_code == 302 and found.headers["cache-control"] == "private, max-age=31536000, immutable", address
    path = f"/api/art/{bare}/small"
    assert client.get(path, headers=headers(user, "GET", path), follow_redirects=False).status_code == 404


def test_the_sql_address_and_version_match_the_python_ones(swap_world):
    with connect() as conn:
        rows = conn.execute("""SELECT a.printing_id, a.tcgdex_url, a.low_image_url, a.small_art_url, a.large_art_url, a.art_version
          FROM catalog_printing_art a WHERE a.low_image_url IS NOT NULL""").fetchall()
        none = conn.execute("""SELECT small_art_url, large_art_url, art_version FROM catalog_printing_art
          WHERE low_image_url IS NULL LIMIT 1""").fetchone()
    assert rows and none == {"small_art_url": None, "large_art_url": None, "art_version": None}
    tcgdex = [row for row in rows if row["tcgdex_url"]]
    assert tcgdex
    for row in tcgdex:
        assert row["small_art_url"] == art_url(row["printing_id"], row["tcgdex_url"], "small")
        assert row["large_art_url"] == art_url(row["printing_id"], row["tcgdex_url"], "large")
        assert row["art_version"] == art_version(row["low_image_url"])


def test_the_published_page_and_the_public_catalog_keep_their_direct_addresses(store):
    catalog()
    deck, token = published(LEGAL)
    page = client.get(f"/api/public/decks/{token}")
    assert page.status_code == 200, page.text
    expected = {f"{HOST}{source_id}/low.webp" for source_id, _ in LEGAL}
    assert set(image_values(page.json())) == expected
    # The large picture is a direct address too (the page is anonymous: no art route), added on read and never stored.
    large = {edition["large_image_url"] for identity in page.json()["identities"] for edition in identity["editions"]}
    assert large == {f"{HOST}{source_id}/high.webp" for source_id, _ in LEGAL}
    assert "/api/art/" not in page.text
    for path in ("/api/public/discovery", f"/api/public/decks/{token}/versions/1/exports/live"):
        assert "/api/art/" not in client.get(path).text, path
    # The same Deck, read by its owner, gets route addresses (the shape is shared; the audience is not).
    private = detail(USER, deck)
    only_routes("the owner's deck", private, len(LEGAL))
    # Rollback safety: the large address is added on read and never stored (PublicModel rejects unknown fields).
    stored = public_projection_store().read()[token]["snapshot"]
    assert all("large_image_url" not in edition for identity in stored["identities"] for edition in identity["editions"])
    with connect() as conn:
        public_catalog.drain_to_completion(conn)
        printing = conn.execute("SELECT public_ref FROM catalog_printing WHERE source_id='me01-001'").fetchone()
    key = catalog_printing_key(printing["public_ref"])
    record = public_record_store().read_records([key], deadline=time.monotonic() + 5).records[key].value
    assert record["image_url"] == f"{HOST}me01-001/low.webp"


def test_only_the_anonymous_reads_the_art_route_and_the_paged_lists_select_the_source_urls():
    """A signed-in read that selects ``art.low_image_url`` hands collectors a direct address unless it builds the route
    address itself: the big paged lists (Collection, holdings, Catalog browse) select the raw source and call
    ``route_address`` on the page's rows only, so a large Collection does not hash a version per catalog row. Every
    other signed-in read selects ``small_art_url`` or ``large_art_url``. The anonymous reads, the art route's resolver and
    the fallback chooser read the source columns by design."""
    root = Path(__file__).resolve().parents[1] / "app"
    anonymous = {"public_catalog.py", "publications.py", "art_store.py", "card_art.py"}
    paged = {"collection.py", "holdings.py", "catalog_browse.py"}
    offenders = [str(path.relative_to(root)) for path in root.rglob("*.py")
                 if path.name not in anonymous | paged and re.search(r"\bart\.(low|high)_image_url\b", path.read_text())]
    assert offenders == []
    for name in paged:
        text = next(root.rglob(name)).read_text()
        assert "route_address(" in text and "art.small_art_url" not in text, name
