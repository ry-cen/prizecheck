"""Discover lists only legal decks (app redesign #182, spec "Publishing and public routes"): anonymous HTTP against a real
manifest and record store.

The cards come from minimal TCGdex records through a real catalog import, so their format facts reach the record store
through the catalog outbox and the real rules files judge them. Today is fixed through Discover's clock
(``discovery.today``) and the publish gate's (``deck_format_checks.today``). Some snapshots here aren't legal on purpose,
so their Decks publish through ``test_publications.command`` (exempt from the publish gate only); every snapshot is
Listed through the visibility route itself, so Discover's legality filter is never exempted here
(``publish_gate_fixture.exempt_listing`` is for older listing tests).

No fixture card is both format-legal and mapped to a TCGplayer product, so ``priced`` writes a verified Edition record
and a cached quote straight to the record store, as a reviewed mapping and a finished quote fetch would.
Discover calls run with PostgreSQL forbidden.
"""
from datetime import date, timedelta
import itertools
import json
import os
import time
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app import deck_format_checks, discovery, format_evaluator
from app.public_records import catalog_edition_key, quarantine_key
from test_card_attributes import BULBASAUR_ME, ENERGY_MEE, ENERGY_SV, RARE_CANDY_ME, card, edition_of
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_deck_format_checks import CARDS
from test_holdings import add, call
from test_moves import leaf
from test_prices import ago, client, seed
from test_publications import command, edition_refs, legacy_snapshot
from test_published_cost import USER, generation, launches, listed_deck, store  # noqa: F401  (store, launches: autouse)
from test_target_format import set_target

TODAY = date(2026, 10, 11)
LEGAL = (("me01-001", 1), ("me01-125", 4), ("me01-130", 4), ("sv02-278", 51))
OVER = (("me01-001", 1), ("fixture-sv01-901", 3), ("fixture-sv01-902", 2), ("sv05-157", 1), ("sv05-162", 1),
        ("sv02-278", 52))
UNKNOWN = (("fixture-me06-3", 4), ("fixture-me05-901", 4), ("sv02-278", 52))
ROTATING = (("me01-001", 1), ("sv01-172", 4), ("me01-125", 4), ("sv02-278", 51))
# A Basic Pokémon ex legal in Standard: the featured card of a deck that holds it, over a Pokémon with more copies.
SPROUT_EX = card(id="fixture-me01-904", name="Fixture Sprout ex", localId="904", category="Pokemon",
                 set={"id": "me01", "name": "Mega Evolution"}, regulationMark="I", suffix="ex", stage="Basic",
                 rarity="Double rare", types=["Grass"])
SUMMARY_KEYS = {"url", "title", "total", "published_at", "checks", "image_url", "featured_name", "target_format",
                "target_format_status", "cost"}
_products = itertools.count(910_001)


@pytest.fixture(autouse=True)
def today(monkeypatch):
    monkeypatch.setattr(deck_format_checks, "today", lambda: TODAY)
    monkeypatch.setattr(discovery, "today", lambda: TODAY)


def pictured(record):
    """The card with art, so the snapshot freezes an image for it."""
    return {**record, "image": f"https://assets.tcgdex.net/en/fixture/{record['id']}"}


def catalog(*extra):
    reset_catalog()
    run(Records(*(pictured(record) for record in (*CARDS, *extra))))


def published(cards, title="Discover deck"):
    """A Deck whose Deck List is ``cards`` ((TCGdex ID, quantity) pairs) and which holds none of them, published (exempt
    from the publish gate only) and Listed through the visibility route; returns (deck, token)."""
    deck = listed_deck({edition_of(source_id): quantity for source_id, quantity in cards})
    response = command(USER, deck, title=title)
    assert response.status_code == 200, response.text
    token = response.json()["token"]
    assert list_publicly(USER, deck).status_code == 200
    return deck, token


def list_publicly(owner, deck, value="listed"):
    return call("PATCH", f"/api/decks/{deck}/publication/visibility", owner,
                {"visibility": value, "idempotency_key": str(uuid4())})


def discover(query="", *, guard=True):
    """Discover's answer: PostgreSQL is forbidden, and every answer carries the public headers."""
    def forbidden(*args, **kwargs):
        raise AssertionError("Discover opened a PostgreSQL connection")
    with pytest.MonkeyPatch.context() as patch:
        if guard:
            patch.setattr(psycopg, "connect", forbidden)
            patch.setenv("DATABASE_URL", "postgresql://unreachable:1/private")
        response = client.get("/api/public/discovery" + query)
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-robots-tag"] == "index, follow"
    return response


def listed(query=""):
    response = discover(query)
    assert response.status_code == 200, response.text
    return response.json()["decks"]


def tokens(query=""):
    return [item["url"].removeprefix("/published/") for item in listed(query)]


def public_status(token, target="standard"):
    response = client.get(f"/api/public/decks/{token}/versions/1/format-checks?format={target}")
    assert response.status_code == 200, response.text
    [result] = response.json()["results"]
    return result["status"]


def priced(store, source_id, amount, **quote):
    """Make the Edition of ``source_id`` price-eligible with a cached quote of ``amount``."""
    edition_ref = edition_refs(edition_of(source_id))[0]
    keys = [catalog_edition_key(edition_ref), quarantine_key(edition_ref)]
    found = store.read_records(keys, deadline=time.monotonic() + 5).records
    edition, quarantine = found[keys[0]].value, found[keys[1]].value
    revision = edition["marketplace"]["mapping_revision"] + 1
    marketplace = {"state": "verified", "reason": None, "mapping_revision": revision, "product_id": next(_products),
                   "quote_lookup": {"source": "tcgdex", "card": source_id, "variant": "normal"}}
    assert store.compare_and_swap({key: found[key].version for key in keys},
                                  {keys[0]: {**edition, "marketplace": marketplace},
                                   keys[1]: {**quarantine, "mapping_revision": revision}},
                                  deadline=time.monotonic() + 5)
    seed(store, {"public_ref": edition_ref, "mapping_revision": revision, "source_id": source_id,
                 "quote_variant": "normal"}, amount, **quote)


def manifest():
    return (Path(os.environ["PUBLIC_PROJECTION_DIR"]) / "current.json").read_bytes()


def listing_world(prefix):
    """Discover's browser spec (web/tests/discover-page.spec.ts) on its stack: the format-check cards with art, four of them
    priced, then four Listed decks titled ``prefix`` and a name, published in this order: "Full" (every copy priced),
    "Partial" (two Fixture Sprout ex not priced), "Bare" (no copy priced; Target Format Expanded) and "Over" (not legal,
    so never shown). Returns {name: token}."""
    from app import public_catalog
    from app.public_records import public_record_store
    catalog(SPROUT_EX, ENERGY_MEE)
    with connect() as conn:
        public_catalog.drain_to_completion(conn)
    store = public_record_store()
    for source_id, amount in (("me01-001", "1.25"), ("me01-125", "10.00"), ("me01-130", "2.50"), ("sv02-278", "0.30")):
        priced(store, source_id, amount)
    partial = (("me01-001", 1), ("fixture-me01-904", 2), ("me01-125", 4), ("me01-130", 4), ("sv02-278", 49))
    bare = (("fixture-me01-904", 1), ("mee-001", 59))
    found = {}
    for name, cards, target in (("Full", LEGAL, "standard"), ("Partial", partial, "standard"),
                                ("Bare", bare, "expanded"), ("Over", OVER, "standard")):
        deck = listed_deck({edition_of(source_id): quantity for source_id, quantity in cards})
        if target != "standard":
            assert set_target(USER, deck, target, 2).status_code == 200
        response = command(USER, deck, title=f"{prefix} {name}")
        assert response.status_code == 200, response.text
        found[name] = response.json()["token"]
        assert list_publicly(USER, deck).status_code == 200
    return found


def test_only_snapshots_legal_in_their_target_format_today_are_listed_as_the_published_route_judges_them(store):
    catalog()
    decks = {status: published(cards, title=f"{status} deck")[1]
             for status, cards in (("legal", LEGAL), ("not_legal", OVER), ("unknown", UNKNOWN))}
    assert tokens() == [decks["legal"]]
    # Discover and the Published Deck format results judge every snapshot the same way.
    for status, token in decks.items():
        assert public_status(token) == status
        assert (token in tokens()) == (status == "legal")
    [found] = listed()
    assert set(found) == SUMMARY_KEYS
    assert (found["title"], found["total"], found["target_format"], found["target_format_status"]) == (
        "legal deck", "60", "standard", "legal")
    assert found["cost"] == {"amount": None, "priced_copies": "0", "total_copies": "60"}
    # A snapshot published before references (no Printing to prove) can't be confirmed, so it leaves.
    legacy_snapshot(decks["legal"])
    assert tokens() == []


def test_a_deck_leaves_when_it_stops_being_legal_and_returns_when_legal_again(store, monkeypatch):
    catalog()
    _, token = published(ROTATING)
    # Regulation mark G rotates out of Standard on 2026-04-10.
    for day, shown in ((date(2026, 4, 9), True), (date(2026, 4, 10), False), (date(2026, 4, 9), True),
                       (date(2026, 4, 10), False)):
        monkeypatch.setattr(discovery, "today", lambda day=day: day)
        assert (tokens() == [token]) is shown, day


def test_a_delivered_attribute_correction_and_a_rules_deploy_each_move_the_listing(store, monkeypatch):
    from test_attribute_corrections import decide, grant, seed as seed_catalog
    ids = seed_catalog(*(pictured(record) for record in (RARE_CANDY_ME, ENERGY_SV, BULBASAUR_ME)))
    _, token = published((("me01-001", 1), ("me01-125", 4), ("sv02-278", 55)))
    assert tokens() == [token]
    # A reviewed correction re-stamps the Printing: once delivered, Discover reads the new fact.
    printing = ids["me01-125"]
    grant(printing)
    corrected = decide(printing, correction={"regulation_mark": "G"})
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["public_delivery"] == "delivered"
    assert tokens() == []
    grant(printing)
    removed = decide(printing, decision="remove")
    assert removed.status_code == 200, removed.text
    assert tokens() == [token]
    # A deployed rules revision that bans Rare Candy changes the rules file's SHA-256, so the cached result is redone.
    source = (format_evaluator.RULES_DIR / "standard.toml").read_text()
    assert source.count("bans = []") == 1
    banned = format_evaluator.load_rules(source.replace("bans = []", 'bans = [\n  { set = "me01", number = "125", '
                                                        'name = "Rare Candy", banned_from = 2026-10-01 },\n]').encode())
    real_rules = format_evaluator.format_rules
    with monkeypatch.context() as patch:
        patch.setattr(format_evaluator, "format_rules", lambda name: banned if name == "standard" else real_rules(name))
        assert tokens() == []
    assert tokens() == [token]


def test_a_result_is_evaluated_once_and_reused_until_a_key_part_moves(store, monkeypatch):
    from app import published_format_checks
    catalog()
    _, token = published(LEGAL, title="Cached deck")
    real, calls = published_format_checks.checks_for, []
    monkeypatch.setattr(published_format_checks, "checks_for",
                        lambda active, *args: calls.append(active.token) or real(active, *args))
    assert tokens() == [token] and tokens() == [token]
    # Two reads, one evaluation: the digest is this snapshot's own, so no earlier test cached its key.
    assert calls.count(token) == 1
    # Another rule-date window (2026-04-09 falls before the 2026-04-10 rotation): evaluated once more, then reused.
    monkeypatch.setattr(discovery, "today", lambda: date(2026, 4, 9))
    tokens()
    tokens()
    assert calls.count(token) == 2


def test_format_filters_by_target_format_and_binds_the_cursor(store):
    catalog()
    _, standard = published(LEGAL, title="Standard list")
    deck = listed_deck({edition_of(source_id): quantity for source_id, quantity in LEGAL})
    assert set_target(USER, deck, "expanded", 2).status_code == 200
    expanded = command(USER, deck, title="Expanded list").json()["token"]
    assert list_publicly(USER, deck).status_code == 200
    assert set(tokens()) == {standard, expanded}
    assert tokens("?format=standard") == [standard]
    assert tokens("?format=expanded") == [expanded]
    assert listed("?format=expanded")[0]["target_format"] == "expanded"
    assert tokens("?format=glc") == []
    for value in ("unlimited", "", "Standard"):
        refused = discover(f"?format={value}")
        assert refused.status_code == 422 and refused.json()["detail"]["code"] == "UNKNOWN_FORMAT", value
    revision = discover().json()["revision"]
    cursor = discovery.cursor_encode("", "standard", revision, ["2099-01-01T00:00:00+00:00", standard])
    assert discover(f"?format=standard&cursor={cursor}").status_code == 200
    assert discover(f"?format=expanded&cursor={cursor}").json()["detail"]["code"] == "INVALID_CURSOR"
    assert discover(f"?cursor={cursor}").status_code == 400


def test_cost_comes_from_cached_quotes_only_and_never_admits_a_refresh(store, launches):
    catalog()
    _, token = published(LEGAL)
    assert listed()[0]["cost"] == {"amount": None, "priced_copies": "0", "total_copies": "60"}
    priced(store, "me01-001", "0.25")
    priced(store, "me01-125", "1.50")
    priced(store, "me01-130", "0.10")
    assert listed()[0]["cost"] == {"amount": "6.65", "priced_copies": "9", "total_copies": "60"}
    # A stale cached quote still counts as priced.
    priced(store, "sv02-278", "0.05", updated=ago(timedelta(days=5)))
    before, records = manifest(), generation(store)
    assert listed()[0]["cost"] == {"amount": "9.2", "priced_copies": "60", "total_copies": "60"}
    # Discover wrote nothing (no admission, work or quote record, no manifest byte) and started no refresh.
    assert generation(store) == records and manifest() == before and launches == []
    assert "age" not in json.dumps(listed()[0]["cost"])


def test_a_deck_that_cannot_be_confirmed_is_an_outage_and_a_cached_result_never_stands_in(store, monkeypatch):
    catalog()
    _, token = published(LEGAL)
    assert tokens() == [token]
    records = Path(os.environ["PUBLIC_PROJECTION_DIR"]) / "records"
    records.rename(records.with_name("records-away"))
    outage = discover()
    assert outage.status_code == 503 and outage.json()["detail"]["code"] == "PUBLIC_CATALOG_UNAVAILABLE"
    records.with_name("records-away").rename(records)
    assert tokens() == [token]
    monkeypatch.setattr(discovery, "DISCOVER_SECONDS", 0)
    assert discover().status_code == 503


def test_a_store_that_answers_and_confirms_no_legal_deck_is_an_empty_200(store):
    catalog()
    published(OVER)
    response = discover()
    assert response.status_code == 200 and response.json()["decks"] == [] and response.json()["next_cursor"] is None


def test_a_deadline_that_stops_the_walk_keeps_older_decks_reachable_by_cursor(store, monkeypatch):
    catalog()
    found = [published(LEGAL, title=f"Deck {number}")[1] for number in range(4)]
    newest_first = found[::-1]
    monkeypatch.setattr(discovery, "PAGE", 2)
    monkeypatch.setattr(discovery, "CHUNK", 1)
    real_confirm, offset = discovery.confirm, [0.0]
    def slow(*args):
        answer = real_confirm(*args)
        offset[0] = 100.0  # the deadline passes once the first chunk is confirmed
        return answer
    monkeypatch.setattr(discovery, "confirm", slow)
    monkeypatch.setattr(discovery, "time", type("Clock", (), {"monotonic": staticmethod(lambda: time.monotonic() + offset[0])}))
    first = discover().json()
    assert [item["url"].removeprefix("/published/") for item in first["decks"]] == newest_first[:1]
    assert first["next_cursor"] is not None
    monkeypatch.setattr(discovery, "confirm", real_confirm)
    monkeypatch.setattr(discovery, "time", time)
    second = discover(f"?cursor={first['next_cursor']}").json()
    assert [item["url"].removeprefix("/published/") for item in second["decks"]] == newest_first[1:3]
    third = discover(f"?cursor={second['next_cursor']}").json()
    assert [item["url"].removeprefix("/published/") for item in third["decks"]] == newest_first[3:] and third["next_cursor"] is None


def test_paging_crosses_chunk_boundaries_with_decks_that_are_not_legal_mixed_in(store, monkeypatch):
    catalog()
    legal, mixed = [], []
    for number in range(7):
        keep = number % 3 != 1
        token = published(LEGAL if keep else OVER, title=f"Mixed {number}")[1]
        mixed.append(token)
        if keep:
            legal.append(token)
    expected = legal[::-1]
    monkeypatch.setattr(discovery, "PAGE", 2)
    monkeypatch.setattr(discovery, "CHUNK", 3)
    seen, query = [], ""
    for _ in range(5):
        page = discover(query).json()
        seen += [item["url"].removeprefix("/published/") for item in page["decks"]]
        if page["next_cursor"] is None:
            break
        query = f"?cursor={page['next_cursor']}"
    assert seen == expected


def test_a_version_1_cursor_is_refused_even_when_correctly_signed(store):
    import base64, hashlib, hmac
    catalog()
    _, token = published(LEGAL)
    revision = discover().json()["revision"]
    payload = json.dumps({"v": 1, "q": "", "r": revision, "k": ["2099-01-01T00:00:00+00:00", token]},
                         separators=(",", ":")).encode()
    mac = hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), payload, hashlib.sha256).digest()
    cursor = base64.urlsafe_b64encode(payload + mac).decode().rstrip("=")
    refused = discover(f"?cursor={cursor}")
    assert refused.status_code == 400 and refused.json()["detail"]["code"] == "INVALID_CURSOR"


def test_the_featured_card_is_the_rule_box_pokemon_then_the_pokemon_with_the_most_copies(store):
    catalog(SPROUT_EX)
    _, plain = published(LEGAL, title="Plain")
    _, ruled = published((("me01-001", 4), ("fixture-me01-904", 2), ("me01-125", 4), ("me01-130", 4),
                          ("sv02-278", 46)), title="Ruled")
    featured = {item["title"]: (item["featured_name"], item["image_url"]) for item in listed()}
    # Not the alphabetically first card (Basic Grass Energy), nor the one with the most copies.
    assert featured["Plain"] == ("Bulbasaur", "https://assets.tcgdex.net/en/fixture/me01-001/low.webp")
    assert featured["Ruled"] == ("Fixture Sprout ex", "https://assets.tcgdex.net/en/fixture/fixture-me01-904/low.webp")


def test_no_discover_answer_contains_ownership_or_storage(store):
    catalog()
    owner = f"discover-{uuid4()}"
    created = call("POST", "/api/decks", owner, {"name": "Secret deck name", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    binder = leaf(owner, "Secret binder")
    editions = {source_id: edition_of(source_id) for source_id, _ in LEGAL}
    # The owner holds the Deck's copies in the Deck (which lists them) and spare copies in a binder: none of it may
    # reach Discover.
    for source_id, quantity in LEGAL:
        assert add(owner, deck, editions[source_id], str(quantity)).status_code == 200
    assert add(owner, binder, editions["me01-001"], "2").status_code == 200
    published_now = call("POST", f"/api/decks/{deck}/publication", owner,
                         {"title": "Open list", "idempotency_key": str(uuid4())})
    assert published_now.status_code == 200, published_now.text
    assert list_publicly(owner, deck).status_code == 200
    body = discover().json()
    [found] = body["decks"]
    assert set(body) == {"decks", "revision", "next_cursor"}
    assert set(found) == SUMMARY_KEYS and set(found["cost"]) == {"amount", "priced_copies", "total_copies"}
    text = json.dumps(body)
    for secret in (owner, deck, binder, "Secret deck name", "Secret binder", *editions.values()):
        assert secret not in text
    for word in ("owner", "location", "holding", "storage", "leaf", "owned", "deck_id"):
        assert word not in text.lower(), word
