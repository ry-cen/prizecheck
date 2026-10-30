"""Add a card to a Deck List by its Card Printing (ticket 06): signed HTTP against PostgreSQL and a real record store.

Prices are controlled by writing what the price runner writes (``test_prices.seed``). Catalog order is read from the
catalog search route, the order the collector sees. No real runner is ever started.
"""
from datetime import timedelta
import json
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401
from app.games.pokemon.prices import prices
from test_catalog_targets import isolated_rules  # noqa: F401  (autouse)
from test_decks import create
from test_deck_lists import add_line, change_line, code, detail
from test_holdings import call, client
from test_prices import ago, seed, world


@pytest.fixture
def store():
    """The first argument of ``seed``; prices live in PostgreSQL, so there is no store."""
    return None


def printings_path(deck):
    return f"/api/decks/{deck}/deck-list/printings"


def add_printing(owner, deck, printing, quantity, revision, key=None):
    return call("POST", printings_path(deck), owner, {"printing_id": printing, "quantity": quantity, "revision": revision,
                                                      "idempotency_key": str(key or uuid4())})


def catalog(owner, number):
    """(printing id, Edition ids in catalog order) for the world's swsh3 card ``number``, from the catalog search."""
    response = call("GET", f"/api/catalog/search?set_id=swsh3&number={number}", owner)
    assert response.status_code == 200, response.text
    [printing] = response.json()["printings"]
    return printing["id"], [edition["id"] for edition in printing["editions"]]


def furret_world(owner):
    """The prices world: meta-1 with two verified, quotable Editions, and meta-2 with only an Unspecified Variant."""
    rows = world()
    by_id = {str(row["id"]): row for key, row in rows.items() if key != "pagers"}
    printing, order = catalog(owner, 1)
    assert len(order) == 2 and set(order) == {str(rows["normal"]["id"]), str(rows["reverse-holofoil"]["id"])}
    return printing, order, by_id


def deck_of(owner):
    response = create(owner, f"Deck {uuid4()}")
    assert response.status_code == 201, response.text
    return response.json()["location"]["id"]


def chosen(response):
    assert response.status_code == 200, response.text
    body = response.json()
    return body["edition_id"], body["chosen_by"]


def lines(body):
    return {line["edition_id"]: line["quantity"] for line in body["deck_list"]["lines"]}


# ------------------------------------------------------------------ which Edition is chosen


def test_the_edition_with_the_cheapest_stored_price_is_chosen_and_stored_as_an_ordinary_line(store):
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    seed(store, by_id[first], "0.50")
    seed(store, by_id[second], "0.10")
    deck = deck_of(owner)
    response = add_printing(owner, deck, printing, "3", 1)
    assert chosen(response) == (second, "cheapest_price")
    body = response.json()
    assert body["deck_id"] == deck
    assert body["deck_list"]["revision"] == 2
    assert lines(body) == {second: "3"}
    # The line carries its display data like every Deck List command response (app redesign #176).
    assert {"name", "set_name", "collector_number", "descriptor", "card_kind", "identity_id"} <= set(
        body["deck_list"]["lines"][0])
    # Deck detail shows the same line and nothing about how it was chosen.
    listed = detail(owner, deck)["deck_list"]
    assert listed == body["deck_list"]
    assert all("chosen_by" not in line for line in listed["lines"])
    # A priced Edition later in catalog order beats an unpriced earlier one.
    seed(store, by_id[first], None)
    seed(store, by_id[second], "7.00")
    assert chosen(add_printing(owner, deck_of(owner), printing, "1", 1)) == (second, "cheapest_price")


def test_a_response_stored_by_an_older_release_replays_with_every_display_field(store):
    """A retry of a command whose response was stored before #176 (no display data) or before migration 043 (no
    evolution root) replays the stored answer with today's display data on each line (``deck_list_display``)."""
    owner = str(uuid4())
    printing, (first_edition, second), by_id = furret_world(owner)
    seed(store, by_id[first_edition], "0.50")
    deck = deck_of(owner)
    key = uuid4()
    first = add_printing(owner, deck, printing, "1", 1, key)
    assert first.status_code == 200, first.text
    display = ("name", "set_id", "set_name", "collector_number", "descriptor", "image_url", "card_kind", "trainer_type",
               "evolves_from", "identity_id", "identity_name", "evolution_root", "evolution_stage")
    for stripped in (("evolution_root", "evolution_stage"), display):
        with connect() as conn:
            stored = conn.execute("SELECT response FROM location_command WHERE owner_id=%s AND request_key=%s",
                                  (owner, key)).fetchone()["response"]
            for line in stored["deck_list"]["lines"]:
                for field in stripped:
                    line.pop(field, None)
            conn.execute("UPDATE location_command SET response=%s WHERE owner_id=%s AND request_key=%s",
                         (json.dumps(stored), owner, key))
        replayed = add_printing(owner, deck, printing, "1", 1, key)
        assert replayed.status_code == 200, replayed.text
        assert replayed.json() == first.json()


def test_equal_prices_go_to_catalog_order_and_a_zero_price_is_no_price(store):
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    seed(store, by_id[first], "0.25")
    seed(store, by_id[second], "0.250")
    assert chosen(add_printing(owner, deck_of(owner), printing, "1", 1)) == (first, "cheapest_price")
    seed(store, by_id[second], "0")   # a zero market price is no price: it never wins as the cheapest
    assert chosen(add_printing(owner, deck_of(owner), printing, "1", 1)) == (first, "cheapest_price")


def test_with_no_stored_price_the_first_edition_in_catalog_order_is_chosen(store):
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    # Nothing cached at all.
    assert chosen(add_printing(owner, deck_of(owner), printing, "2", 1)) == (first, "catalog_order")
    # An empty market price (even with a low and a mid), a zero one and an unbound row are not prices either.
    seed(store, by_id[first], None, low="0.01", mid="0.02")
    seed(store, by_id[second], "0.01", bind=False)
    assert chosen(add_printing(owner, deck_of(owner), printing, "2", 1)) == (first, "catalog_order")
    seed(store, by_id[second], "0")
    assert chosen(add_printing(owner, deck_of(owner), printing, "2", 1)) == (first, "catalog_order")


def test_a_printing_with_only_an_unspecified_variant_edition_uses_it(store):
    owner = str(uuid4())
    furret_world(owner)
    printing, [only] = catalog(owner, 2)
    deck = deck_of(owner)
    response = add_printing(owner, deck, printing, "4", 1)
    assert chosen(response) == (only, "catalog_order")
    assert lines(response.json()) == {only: "4"}


def test_adding_by_printing_returns_the_decks_format_results(store):
    owner = str(uuid4())
    printing, (first, _), _ = furret_world(owner)
    deck = deck_of(owner)
    response = add_printing(owner, deck, printing, "2", 1)
    assert chosen(response) == (first, "catalog_order")
    body = response.json()
    checks = body["format_checks"]
    assert checks["deck_id"] == deck and checks["deck_list_revision"] == body["deck_list"]["revision"] == 2
    # The Deck's Target Format alone, Standard for a new Deck (app redesign #178).
    assert body["target_format"] == "standard" and [result["format"] for result in checks["results"]] == ["standard"]
    assert checks["results"][0]["status"] == "not_legal"  # two cards are not a 60-card deck
    # The results are saved with the Deck: an unchanged read reuses them (Deck Lists 17).
    read = call("GET", f"/api/decks/{deck}/format-checks", owner)
    assert read.status_code == 200, read.text
    assert read.json() == checks


def test_the_chosen_edition_never_changes_when_prices_change_later(store):
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    seed(store, by_id[first], "0.10")
    seed(store, by_id[second], "0.50")
    deck = deck_of(owner)
    key = uuid4()
    original = add_printing(owner, deck, printing, "2", 1, key)
    assert chosen(original) == (first, "cheapest_price")
    # The prices invert.
    seed(store, by_id[first], "0.90")
    seed(store, by_id[second], "0.05")
    assert lines(detail(owner, deck)) == {first: "2"}
    # A retry replays the original answer, rule included; it does not choose again.
    assert add_printing(owner, deck, printing, "2", 1, key).json() == original.json()
    assert lines(detail(owner, deck)) == {first: "2"}
    # Later edits keep naming the chosen Edition.
    changed = change_line(owner, deck, first, "3", 2)
    assert changed.status_code == 200, changed.text
    assert lines(changed.json()) == {first: "3"}
    # A new add sees the new prices.
    assert chosen(add_printing(owner, deck_of(owner), printing, "1", 1)) == (second, "cheapest_price")


def test_choosing_reads_old_rows_as_they_are_and_writes_no_price_data(store):
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    seed(store, by_id[first], "0.50", checked=ago(timedelta(hours=2)))
    seed(store, by_id[second], "0.10", checked=ago(timedelta(hours=25)))

    def stamps():
        with connect() as conn:
            return [sorted(r["x"] for r in conn.execute(f"SELECT xmin::text||':'||ctid::text AS x FROM {table}"))
                    for table in ("tcgplayer_price", "tcgplayer_product", "edition_price_binding")]
    before = stamps()
    assert chosen(add_printing(owner, deck_of(owner), printing, "1", 1)) == (second, "cheapest_price")
    assert stamps() == before


def test_an_unreadable_price_read_writes_nothing_and_a_retry_can_succeed(store, monkeypatch):
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    seed(store, by_id[second], "0.10")
    deck = deck_of(owner)

    def unavailable(*args, **kwargs):
        raise psycopg.OperationalError("down")
    key = uuid4()
    # monkeypatch.context(), not monkeypatch.undo(): undo would also drop the store fixture's environment.
    with monkeypatch.context() as patch:
        patch.setattr(prices, "_read_rows", unavailable)
        failed = add_printing(owner, deck, printing, "1", 1, key)
    assert failed.status_code == 503 and code(failed) == "PRICES_UNAVAILABLE"
    assert detail(owner, deck)["deck_list"] == {"revision": 1, "lines": []}
    retried = add_printing(owner, deck, printing, "1", 1, key)
    assert chosen(retried) == (second, "cheapest_price")
    # A replay never needs the cache.
    with monkeypatch.context() as patch:
        patch.setattr(prices, "_read_rows", unavailable)
        assert add_printing(owner, deck, printing, "1", 1, key).json() == retried.json()


def test_stale_prices_still_count_as_prices(store):
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    seed(store, by_id[first], "0.50")
    seed(store, by_id[second], "0.10", updated=ago(timedelta(hours=72)))
    assert chosen(add_printing(owner, deck_of(owner), printing, "1", 1)) == (second, "cheapest_price")


def test_amounts_compare_as_decimals_not_as_text(store):
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    seed(store, by_id[first], "10.00")
    seed(store, by_id[second], "9.50")
    assert chosen(add_printing(owner, deck_of(owner), printing, "1", 1)) == (second, "cheapest_price")
    seed(store, by_id[first], "0.250")
    seed(store, by_id[second], "0.25")
    assert chosen(add_printing(owner, deck_of(owner), printing, "1", 1)) == (first, "cheapest_price")


def test_a_failed_target_read_is_prices_unavailable_and_writes_nothing(store, monkeypatch):
    owner = str(uuid4())
    printing, _, _ = furret_world(owner)
    deck = deck_of(owner)

    def broken(*args, **kwargs):
        raise psycopg.OperationalError("down")
    with monkeypatch.context() as patch:
        patch.setattr(prices, "_read_rows", broken)
        failed = add_printing(owner, deck, printing, "1", 1)
    assert failed.status_code == 503 and code(failed) == "PRICES_UNAVAILABLE"
    assert detail(owner, deck)["deck_list"] == {"revision": 1, "lines": []}


# ------------------------------------------------------------------ the Deck List command rules


def test_a_chosen_edition_already_on_the_list_is_a_conflict_and_other_editions_get_their_own_line(store):
    owner = str(uuid4())
    printing, (first, second), _ = furret_world(owner)
    deck = deck_of(owner)
    assert add_line(owner, deck, second, "2", 1).status_code == 200
    # No prices: catalog order chooses the first Edition, which has no line yet.
    added = add_printing(owner, deck, printing, "1", 2)
    assert chosen(added) == (first, "catalog_order")
    assert lines(added.json()) == {first: "1", second: "2"}
    duplicate = add_printing(owner, deck, printing, "5", 3)
    assert duplicate.status_code == 409 and code(duplicate) == "DECK_LIST_LINE_EXISTS"
    assert detail(owner, deck)["deck_list"] == added.json()["deck_list"]


def test_revision_idempotency_ownership_and_input_follow_the_other_deck_list_commands(store):
    owner, other = str(uuid4()), str(uuid4())
    printing, (first, _), _ = furret_world(owner)
    deck = deck_of(owner)
    holdings_before = call("GET", f"/api/decks/{deck}/contents", owner).json()
    key = uuid4()
    first_add = add_printing(owner, deck, printing, "2", 1, key)
    assert chosen(first_add) == (first, "catalog_order")
    assert first_add.json()["deck_list"]["revision"] == 2
    # Editing a Deck List never changes Holdings or the inventory revision.
    assert call("GET", f"/api/decks/{deck}/contents", owner).json() == holdings_before
    stale = add_printing(owner, deck, printing, "1", 1)
    assert stale.status_code == 409 and code(stale) == "STALE_DECK_LIST"
    for reused in (add_printing(owner, deck, printing, "3", 1, key), add_line(owner, deck, first, "2", 2, key)):
        assert reused.status_code == 409 and code(reused) == "IDEMPOTENCY_KEY_REUSED"
    line_key = uuid4()
    assert add_line(owner, deck_of(owner), first, "1", 1, line_key).status_code == 200
    reused = add_printing(owner, deck, printing, "1", 2, line_key)
    assert reused.status_code == 409 and code(reused) == "IDEMPOTENCY_KEY_REUSED"
    unsorted = next(row["id"] for row in call("GET", "/api/location-tree", owner).json()["locations"] if row["name"] == "Unsorted")
    for missing in (add_printing(other, deck, printing, "1", 2), add_printing(owner, unsorted, printing, "1", 1),
                    add_printing(owner, str(uuid4()), printing, "1", 1)):
        assert missing.status_code == 404 and code(missing) == "DECK_NOT_FOUND"
    unknown = add_printing(owner, deck, str(uuid4()), "1", 2)
    assert unknown.status_code == 422 and code(unknown) == "PRINTING_UNAVAILABLE"
    for invalid in ("0", "-1", "1.5", "", "9223372036854775808"):
        rejected = add_printing(owner, deck, printing, invalid, 2)
        assert rejected.status_code == 422 and code(rejected) == "INVALID_QUANTITY"
    assert call("POST", printings_path(deck), owner, {"printing_id": printing, "quantity": "1", "revision": 0,
                                                     "idempotency_key": str(uuid4())}).status_code == 422
    assert client.post(printings_path(deck), json={"printing_id": printing, "quantity": "1", "revision": 2,
                                                   "idempotency_key": str(uuid4())}).status_code == 401
    # Failed commands leave the Deck List untouched.
    assert detail(owner, deck)["deck_list"] == first_add.json()["deck_list"]


def test_inactive_editions_are_never_chosen_and_a_printing_without_any_is_unavailable(store):
    owner = str(uuid4())
    printing, (first, second), by_id = furret_world(owner)
    seed(store, by_id[first], "0.01")
    seed(store, by_id[second], "0.99")
    with connect() as conn:
        conn.execute("UPDATE catalog_generation_edition SET active=false WHERE edition_id=%s", (first,))
    assert chosen(add_printing(owner, deck_of(owner), printing, "1", 1)) == (second, "cheapest_price")
    with connect() as conn:
        conn.execute("UPDATE catalog_generation_edition SET active=false WHERE edition_id=%s", (second,))
    response = add_printing(owner, deck_of(owner), printing, "1", 1)
    assert response.status_code == 422 and code(response) == "PRINTING_UNAVAILABLE"
