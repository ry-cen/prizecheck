"""Complete private Deck cost (ticket 09): signed HTTP against PostgreSQL, priced from the imported TCGCSV rows (ADR 0019).

Every assertion is on the route's answer (the same body the browser renders) or on what the shared stores hold
afterwards; nothing here calls the arithmetic or the capture directly.
"""
from datetime import timedelta
import os
import time
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401
from app import price_launcher, quote_contract
from app.games.pokemon.prices import prices
from app.public_records import public_record_store
from test_catalog_targets import isolated_rules, owner  # noqa: F401  (isolated_rules is autouse)
from test_holdings import add, call
from test_prices import ago, client, headers_for, seed, world
from test_settings import change, read

USER = "deck-cost-owner"


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    """Prices live in PostgreSQL; the record store stays only for the files that import this fixture and check it is
    untouched (the first argument of ``seed`` is unused)."""
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "filesystem")
    public_record_store().initialize(deadline=time.monotonic() + 5)
    return public_record_store()


@pytest.fixture(autouse=True)
def launches(monkeypatch):
    """Records any runner launch (other files import this fixture): pricing never starts one."""
    calls = []
    monkeypatch.setattr(price_launcher, "spawn", lambda slot, owner: calls.append((slot, owner)) or True)
    return calls


def path_of(deck):
    return f"/api/decks/{deck}/cost"


def cost(deck, *, user=USER, **options):
    path = path_of(deck)
    return client.get(path, headers=headers_for(b"", method="GET", path=path, user=user, **options))


def body_of(response):
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def scheduler(store):
    key = quote_contract.scheduler_key()
    return store.read_records([key], deadline=time.monotonic() + 5).records[key].value


def deck_with(quantities, user=USER):
    """A private Deck holding ``{edition_id: quantity}`` (and an owner with one storage leaf); returns its id."""
    deck = uuid4()
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user,))
        if not conn.execute("SELECT 1 FROM location WHERE owner_id=%s AND kind='storage_leaf'", (user,)).fetchone():
            conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Unsorted','storage_leaf')", (uuid4(), user))
        conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,%s,'deck')", (deck, user, f"Deck {deck}"))
        for edition, quantity in quantities.items():
            conn.execute("INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,%s,1)",
                         (user, deck, edition, quantity))
        conn.execute("UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s", (user,))
    return str(deck)


def deck_list_with(lines, *, held=None, unsorted=None, other_deck=None, user=USER):
    """A private Deck whose Deck List is exactly ``lines`` ``{edition_id: quantity}``, holding ``held`` in the Deck,
    ``unsorted`` in the owner's Unsorted leaf and ``other_deck`` in another of the owner's Decks; returns its id.

    Holdings go in first: moving copies into a Deck raises its lines (migration 031), so the lines are written last to
    leave exactly the list asked for (a held Edition without a line is surplus)."""
    deck = deck_with(held or {}, user)
    with connect() as conn:
        leaf = conn.execute("SELECT id FROM location WHERE owner_id=%s AND kind='storage_leaf' ORDER BY id LIMIT 1",
                            (user,)).fetchone()["id"]
        other = uuid4()
        conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,%s,'deck')", (other, user, f"Deck {other}"))
        for location, copies in ((leaf, unsorted or {}), (other, other_deck or {})):
            for edition, quantity in copies.items():
                conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,%s,1)
                  ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE SET quantity=holding.quantity+EXCLUDED.quantity""",
                             (user, location, edition, quantity))
        conn.execute("DELETE FROM deck_list_line WHERE owner_id=%s AND deck_id=%s", (user, deck))
        for edition, quantity in lines.items():
            conn.execute("INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity) VALUES (%s,%s,%s,%s)",
                         (user, deck, edition, quantity))
        conn.execute("UPDATE deck_list SET revision=revision+1 WHERE owner_id=%s AND deck_id=%s", (user, deck))
        conn.execute("UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s", (user,))
    return deck


def figures(result):
    """The fields every cost figure shares, for comparing a nested figure with the top-level one."""
    return {key: result[key] for key in ("status", "reason", "total_copies", "priced_copies", "stale_copies",
                                         "unknown_age_copies", "fallback_copies", "amount", "display_amount", "currency")}


EMPTY = {"status": "empty", "reason": None, "total_copies": "0", "priced_copies": "0", "stale_copies": "0",
         "unknown_age_copies": "0", "fallback_copies": "0", "amount": "0", "display_amount": "$0.00", "currency": "USD"}


def detail_of(deck, user=USER):
    response = call("GET", f"/api/decks/{deck}", user)
    assert response.status_code == 200, response.text
    return response.json()


def revision_of(user=USER):
    with connect() as conn:
        return conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s", (user,)).fetchone()["revision"]


# ------------------------------------------------------------------ the visible example


def test_three_at_25_cents_two_stale_at_43_and_one_unpriced_is_161_and_five_of_six(store):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, "0.25", updated=ago(timedelta(hours=1)))
    # Stale by provider age (72 h) even though the successful check is ten minutes old.
    seed(store, reverse, "0.43", updated=ago(timedelta(hours=72)), checked=ago(timedelta(minutes=10)))
    deck = deck_with({normal["id"]: 3, reverse["id"]: 2, plain["id"]: 1})
    result = body_of(cost(deck))
    assert result["status"] == "priced"
    assert (result["amount"], result["display_amount"], result["currency"]) == ("1.61", "$1.61", "USD")
    assert (result["priced_copies"], result["total_copies"]) == ("5", "6")
    assert (result["stale_copies"], result["unknown_age_copies"]) == ("2", "0")
    assert result["owner_revision"] == revision_of()
    assert result["deck_id"] == deck
    # Copies moved into a Deck join its Deck List, so the Deck List costs what the Holdings cost; all of it is owned.
    assert result["deck_list_cost"] == figures(result)
    assert result["cost_to_complete"] == EMPTY
    assert result["deck_list_revision"] == detail_of(deck)["deck_list"]["revision"]


def test_only_the_market_price_counts_and_a_row_with_only_low_or_mid_is_unpriced(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "1.10")
    seed(store, reverse, None, low="2.00", mid="2.50")
    result = body_of(cost(deck_with({normal["id"]: 1, reverse["id"]: 4})))
    assert (result["status"], result["amount"], result["display_amount"]) == ("priced", "1.1", "$1.10")
    assert (result["priced_copies"], result["total_copies"]) == ("1", "5")
    assert (result["stale_copies"], result["unknown_age_copies"], result["fallback_copies"]) == ("0", "0", "0")


def test_with_price_reads_off_every_figure_is_no_quotes_and_nothing_is_queried(store, monkeypatch):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43")
    deck = deck_list_with({normal["id"]: 2, reverse["id"]: 1}, held={normal["id"]: 1})
    monkeypatch.setenv("PRICE_READS", "off")
    monkeypatch.setattr(prices, "_read_rows", lambda *a, **k: pytest.fail("a price query ran"))
    result = body_of(cost(deck))
    for figure in (result, result["deck_list_cost"], result["cost_to_complete"]):
        assert figure["status"] == "no_quotes" and (figure["amount"], figure["display_amount"]) == (None, None)
        assert figure["priced_copies"] == "0" and figure["fallback_copies"] == "0"
    assert result["total_copies"] == "1"


def test_the_subtotal_is_exact_and_rounded_once_at_display(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "0.333")
    seed(store, reverse, "0.001")
    result = body_of(cost(deck_with({normal["id"]: 3, reverse["id"]: 4})))
    # Per-row rounding would give 3 x $0.33 + 4 x $0.00 = $0.99; the exact sum is 1.003.
    assert (result["amount"], result["display_amount"]) == ("1.003", "$1.00")


def test_a_sub_cent_total_is_labelled_and_never_rounded_to_zero(store):
    normal = world()["normal"]
    seed(store, normal, "0.000001")
    result = body_of(cost(deck_with({normal["id"]: 3})))
    assert (result["amount"], result["display_amount"]) == ("0.000003", "<$0.01")


def test_huge_quantities_and_amounts_stay_exact_beyond_double_and_decimal_context_precision(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "999999999999.999999")
    seed(store, reverse, "0.5")
    big = 2**63 - 1
    result = body_of(cost(deck_with({normal["id"]: big, reverse["id"]: 9007199254740993})))
    exact = (999999999999999999 * big + 500000 * 9007199254740993)
    whole, micros = divmod(exact, 10**6)
    assert result["amount"] == f"{whole}.{micros:06d}".rstrip("0").rstrip(".")
    cents = (exact + 5000) // 10000
    assert result["display_amount"] == f"${cents // 100:,}.{cents % 100:02d}"
    assert result["total_copies"] == str(big + 9007199254740993)
    assert result["priced_copies"] == result["total_copies"]


# ------------------------------------------------------------------ empty, no quote, incomplete


def test_an_empty_deck_is_zero_dollars_with_no_cards_and_reads_no_price(store, monkeypatch):
    monkeypatch.setattr(prices, "_read_rows", lambda *a, **k: pytest.fail("an empty Deck read a price"))
    deck = deck_with({})
    result = body_of(cost(deck))
    assert result["status"] == "empty"
    assert (result["amount"], result["display_amount"]) == ("0", "$0.00")
    assert (result["priced_copies"], result["total_copies"], result["stale_copies"], result["unknown_age_copies"]) == ("0",) * 4
    assert result["owner_revision"] == revision_of()
    assert result["deck_list_cost"] == result["cost_to_complete"] == EMPTY
    assert result["deck_list_revision"] == detail_of(deck)["deck_list"]["revision"]


def test_a_complete_scan_with_no_eligible_quote_is_price_unavailable_and_zero_of_n(store):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, None)
    # reverse: no price row at all; plain: an Unspecified Variant is never priced.
    result = body_of(cost(deck_with({normal["id"]: 2, reverse["id"]: 3, plain["id"]: 4})))
    assert result["status"] == "no_quotes"
    assert (result["amount"], result["display_amount"]) == (None, None)
    assert (result["priced_copies"], result["total_copies"]) == ("0", "9")


def test_a_postgres_price_outage_reports_no_numeric_coverage_only_the_total(store, monkeypatch):
    editions = world()
    normal, plain = editions["normal"], editions["unspecified"]
    seed(store, normal, "0.25")

    def down(*a, **k):
        raise psycopg.OperationalError("down")
    monkeypatch.setattr(prices, "_read_rows", down)
    result = body_of(cost(deck_with({normal["id"]: 2, plain["id"]: 5})))
    assert result["status"] == "incomplete" and result["reason"] == "validation_unavailable"
    assert result["total_copies"] == "7"
    for field in ("amount", "display_amount", "priced_copies", "stale_copies", "unknown_age_copies"):
        assert result[field] is None, field
    assert result["deck_list_cost"] == figures(result)
    # Every line is in the Deck: nothing needs buying, so no price was needed for the cost to complete.
    assert result["cost_to_complete"] == EMPTY


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_an_exhausted_budget_reports_incomplete_without_reading_a_price(store, monkeypatch):
    normal = world()["normal"]
    seed(store, normal)
    monkeypatch.setattr(prices, "_read_rows", lambda *a, **k: pytest.fail("an exhausted budget read a price"))
    deck = deck_with({normal["id"]: 2})
    started = time.monotonic()
    result = body_of(cost(deck, ms=0))
    assert time.monotonic() - started < 0.5
    assert result["status"] == "incomplete" and result["reason"] == "deadline"
    assert result["priced_copies"] is None and result["amount"] is None
    assert result["deck_list_revision"] is None
    for name in ("deck_list_cost", "cost_to_complete"):
        assert result[name] == figures(result), name


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
@pytest.mark.slow(reason='wall-clock: waits out a real ~1 s lock timeout')
def test_a_held_inventory_lock_answers_inside_the_budget_without_a_count(store):
    normal = world()["normal"]
    seed(store, normal)
    deck = deck_with({normal["id"]: 2})
    writer = psycopg.connect(os.environ["DATABASE_URL"])
    try:
        writer.execute("SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE", (USER,))
        started = time.monotonic()
        result = body_of(cost(deck, ms=1500))
        elapsed = time.monotonic() - started
    finally:
        writer.rollback()
        writer.close()
    assert elapsed < 1.5, elapsed
    # Either the lock wait or the request clock ends first; both are honest and neither reports a count.
    assert result["status"] == "incomplete" and result["reason"] in ("inventory_unavailable", "deadline")
    assert result["total_copies"] is None and result["owner_revision"] is None and result["priced_copies"] is None
    assert result["deck_list_revision"] is None
    for name in ("deck_list_cost", "cost_to_complete"):
        assert (result[name]["status"], result[name]["reason"], result[name]["total_copies"]) == (
            "incomplete", result["reason"], None), name


# ------------------------------------------------------------------ invalidated and superseded quotes


def test_an_empty_market_price_and_a_quarantined_mapping_never_enter_the_subtotal(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    # An empty market price next to a stored mid price, and a quarantined mapping with a price row.
    seed(store, normal, None, mid="5.00")
    seed(store, reverse, "7.00")
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='physical_conflict' WHERE edition_id=%s",
                     (reverse["id"],))
    result = body_of(cost(deck_with({normal["id"]: 1, reverse["id"]: 1})))
    assert (result["status"], result["priced_copies"], result["total_copies"], result["amount"]) == ("no_quotes", "0", "2", None)


# ------------------------------------------------------------------ every row, one admission, one budget


def verified_editions(count):
    """``count`` verified single-finish Editions written by SQL (the importer is too slow for large Decks)."""
    made = []
    with connect() as conn:
        activation = conn.execute("""INSERT INTO catalog_rule_activation(kind,reviewer_id,evidence_url,reason,clock_revision)
          VALUES ('marketplace_matching',%s,'https://example.org/rule','Fixture activation',1) RETURNING id""",
                                  (owner(),)).fetchone()["id"]
        for _ in range(count):
            card = f"deck-cost-{uuid4().hex[:12]}"
            identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id",
                                    (card, card)).fetchone()["id"]
            printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',%s,%s) RETURNING id",
                                    (card, identity)).fetchone()["id"]
            edition = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
              VALUES (%s,'normal','{"finish":"normal"}') RETURNING id,public_ref""", (printing,)).fetchone()
            product = 1 + uuid4().int % 2_000_000_000
            revision = conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='verified',mapping_reason=NULL,
              product_id=%s,quote_variant='normal',mapping_basis='matching_rule',matching_activation_id=%s,auto_closed=true
              WHERE edition_id=%s RETURNING mapping_revision""",
                                    (product, activation, edition["id"])).fetchone()["mapping_revision"]
            made.append({"id": edition["id"], "public_ref": edition["public_ref"], "mapping_revision": revision,
                         "quote_variant": "normal", "source_id": card, "product_id": product})
    return made


def test_every_copy_of_a_large_deck_is_evaluated_with_one_price_query(store, monkeypatch):
    editions = verified_editions(70)
    fresh, old = editions[:30], editions[30:]
    for edition in fresh:
        seed(store, edition, "0.10")
    for edition in old:
        seed(store, edition, "0.20", updated=ago(timedelta(hours=72)))
    queries = []
    real = prices._read_rows
    monkeypatch.setattr(prices, "_read_rows", lambda ids, timeout: queries.append(len(ids)) or real(ids, timeout))
    deck = deck_with({edition["id"]: 2 for edition in editions})
    result = body_of(cost(deck))
    assert queries == [70]                    # one read, every Deck row
    assert (result["status"], result["priced_copies"], result["total_copies"]) == ("priced", "140", "140")
    assert (result["amount"], result["display_amount"]) == ("22", "$22.00")   # 60 x 0.10 + 80 x 0.20, nothing omitted
    assert result["deck_list_cost"] == figures(result) and result["cost_to_complete"] == EMPTY
    assert (result["stale_copies"], result["fallback_copies"]) == ("80", "0")


def test_a_deck_larger_than_one_access_is_priced_without_dropping_copies(store):
    editions = verified_editions(40)
    for edition in editions:
        seed(store, edition, "0.20", checked=ago(timedelta(hours=2)))
    deck = deck_with({edition["id"]: 1 for edition in editions})
    for _ in range(2):
        answer = body_of(cost(deck))
        assert (answer["status"], answer["priced_copies"], answer["total_copies"], answer["amount"]) == ("priced", "40", "40", "8")


# ------------------------------------------------------------------ locks, revisions and the rest of the page


def test_the_answer_names_the_owner_revision_it_was_captured_at(store):
    editions = world()
    normal, plain = editions["normal"], editions["unspecified"]
    seed(store, normal, "0.25")
    deck = deck_with({normal["id"]: 2})
    captured = revision_of()
    result = body_of(cost(deck))
    assert result["owner_revision"] == captured
    assert (result["priced_copies"], result["total_copies"]) == ("2", "2")
    added = add(USER, deck, str(plain["id"]), "1")
    assert added.status_code == 200, added.text
    assert revision_of() != captured                       # the client discards the first answer for the newer revision
    assert body_of(cost(deck))["total_copies"] == "3"


def test_the_route_is_private_signed_and_budgeted(store, monkeypatch):
    normal = world()["normal"]
    deck = deck_with({normal["id"]: 1})
    assert cost(deck, user="someone-else").status_code == 404
    assert cost(str(uuid4())).status_code == 404
    monkeypatch.setattr(prices, "private_edition_quotes", lambda *a, **k: pytest.fail("a price read ran"))
    assert cost(deck, budget=False).status_code == 401
    assert cost(deck, forge="0" * 64).status_code == 401
    assert cost(deck, caller="user:someone-else").status_code == 401
    path = path_of(deck)
    assert client.get(path).status_code == 401
    other = path_of(uuid4())
    assert client.get(other, headers=headers_for(b"", method="GET", path=path, user=USER)).status_code == 401  # bound to its path


def test_no_request_field_forces_a_refresh(store, launches):
    normal = world()["normal"]
    seed(store, normal, checked=ago(timedelta(minutes=30)))
    deck = deck_with({normal["id"]: 1})
    path = path_of(deck)
    headers = {**headers_for(b"", method="GET", path=path, user=USER), "cache-control": "no-cache", "pragma": "no-cache"}
    response = client.get(path + "?force=1&refresh=1&max_age=0", headers=headers)
    assert body_of(response)["priced_copies"] == "1"
    assert launches == []


# ------------------------------------------------------------------ Deck List cost and cost to complete (Deck Lists 08)


def test_deck_list_cost_counts_every_line_and_cost_to_complete_only_the_copies_still_needed(store):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43")
    # A new owner: the counting setting is the account's, so a change must not reach the file's other tests.
    user = f"deck-cost-{uuid4()}"
    # normal: 1 in the Deck, 1 in Unsorted, 2 not owned; reverse: 1 held by another Deck for its own line, 1 not owned;
    # plain (never priced): 1 not owned.
    deck = deck_list_with({normal["id"]: 4, reverse["id"]: 2, plain["id"]: 1}, held={normal["id"]: 1},
                          unsorted={normal["id"]: 1}, other_deck={reverse["id"]: 1}, user=user)
    result = body_of(cost(deck, user=user))
    # The top-level figure stays the cost of the Deck's Holdings.
    assert (result["status"], result["amount"], result["priced_copies"], result["total_copies"]) == ("priced", "0.25", "1", "1")
    listed = result["deck_list_cost"]
    assert (listed["status"], listed["amount"], listed["display_amount"]) == ("priced", "1.86", "$1.86")
    assert (listed["priced_copies"], listed["total_copies"]) == ("6", "7")
    # Every Deck built at once (the default): the other Deck's copy covers its own line, so this Deck needs both reverse.
    complete = result["cost_to_complete"]
    assert (complete["status"], complete["amount"], complete["display_amount"]) == ("priced", "1.36", "$1.36")
    assert (complete["priced_copies"], complete["total_copies"]) == ("4", "5")
    detail = detail_of(deck, user)
    assert complete["total_copies"] == detail["to_get"]
    assert result["want_list_counting"] == detail["want_list_counting"] == "all_at_once"
    assert result["settings_revision"] == detail["settings_revision"] == 1
    assert result["deck_list_revision"] == detail["deck_list"]["revision"]
    assert result["owner_revision"] == detail["owner_revision"] == revision_of(user)
    # One Deck at a time: the figure before the setting, exactly the Deck detail's not-owned copies.
    assert change(user, "one_at_a_time", read(user)["revision"]).status_code == 200
    result = body_of(cost(deck, user=user))
    complete = result["cost_to_complete"]
    assert (complete["status"], complete["amount"], complete["display_amount"]) == ("priced", "0.93", "$0.93")
    assert (complete["priced_copies"], complete["total_copies"]) == ("3", "4")
    detail = detail_of(deck, user)
    assert complete["total_copies"] == detail["to_get"] == str(sum(int(line["not_owned"]) for line in detail["ownership"]))
    assert (result["want_list_counting"], result["settings_revision"]) == ("one_at_a_time", 2)
    assert result["owner_revision"] == detail["owner_revision"] == revision_of(user)


def test_spare_copies_are_never_counted_as_needing_purchase_and_another_decks_own_copies_follow_the_setting(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43")
    user = f"deck-cost-{uuid4()}"
    # Every listed copy is owned, in Unsorted or held by another Deck for its own line, but none is in this Deck yet.
    deck = deck_list_with({normal["id"]: 2, reverse["id"]: 3}, unsorted={normal["id"]: 5}, other_deck={reverse["id"]: 3},
                          user=user)
    result = body_of(cost(deck, user=user))
    assert figures(result) == EMPTY                       # the Deck holds no cards
    assert (result["deck_list_cost"]["amount"], result["deck_list_cost"]["total_copies"]) == ("1.79", "5")
    # Every Deck built at once (the default): the loose normal copies are spare; the other Deck's reverse are its own.
    complete = result["cost_to_complete"]
    assert (complete["status"], complete["amount"], complete["priced_copies"], complete["total_copies"]) == (
        "priced", "1.29", "3", "3")
    # One Deck at a time: every copy outside the Deck counts.
    assert change(user, "one_at_a_time", read(user)["revision"]).status_code == 200
    assert body_of(cost(deck, user=user))["cost_to_complete"] == EMPTY   # a real $0.00: nothing needs buying


def test_an_unpriced_not_owned_line_is_never_counted_as_zero(store):
    editions = world()
    normal, plain = editions["normal"], editions["unspecified"]
    seed(store, normal, "0.25")
    deck = deck_list_with({normal["id"]: 1, plain["id"]: 2}, held={normal["id"]: 1})
    result = body_of(cost(deck))
    complete = result["cost_to_complete"]
    assert (complete["status"], complete["priced_copies"], complete["total_copies"]) == ("no_quotes", "0", "2")
    assert (complete["amount"], complete["display_amount"]) == (None, None)
    listed = result["deck_list_cost"]
    assert (listed["status"], listed["amount"], listed["priced_copies"], listed["total_copies"]) == ("priced", "0.25", "1", "3")


def test_a_deck_with_no_cards_yet_prices_its_deck_list_in_one_read(store, monkeypatch):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43", updated=ago(timedelta(hours=72)))
    calls = []
    real = prices._read_rows
    monkeypatch.setattr(prices, "_read_rows", lambda ids, timeout: calls.append(len(ids)) or real(ids, timeout))
    deck = deck_list_with({normal["id"]: 2, reverse["id"]: 1})
    result = body_of(cost(deck))
    assert calls == [2]                                   # every listed Edition, one read
    assert figures(result) == EMPTY
    listed = result["deck_list_cost"]
    assert (listed["status"], listed["amount"], listed["priced_copies"], listed["total_copies"]) == ("priced", "0.93", "3", "3")
    assert listed["stale_copies"] == "1"
    assert result["cost_to_complete"] == listed           # nothing is owned yet


def test_cut_copies_stay_in_the_holdings_figure_but_leave_the_deck_list(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43")
    deck = deck_list_with({normal["id"]: 1}, held={normal["id"]: 3, reverse["id"]: 1})
    result = body_of(cost(deck))
    assert (result["amount"], result["priced_copies"], result["total_copies"]) == ("1.18", "4", "4")
    assert (result["deck_list_cost"]["amount"], result["deck_list_cost"]["total_copies"]) == ("0.25", "1")
    assert result["cost_to_complete"] == EMPTY


def test_a_failed_row_makes_only_the_figures_containing_it_incomplete(store, monkeypatch):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43")
    real_quotes = prices.private_edition_quotes
    calls = []

    def failing_reverse(ids, *args, **kwargs):
        calls.append(set(ids))
        views = real_quotes(ids, *args, **kwargs)
        views[reverse["id"]] = prices._failed([reverse["id"]], "validation_unavailable")[reverse["id"]]
        return views
    monkeypatch.setattr(prices, "private_edition_quotes", failing_reverse)
    # reverse is held but cut from the Deck List; normal is listed and not owned.
    deck = deck_list_with({normal["id"]: 2}, held={reverse["id"]: 1})
    result = body_of(cost(deck))
    assert (result["status"], result["reason"], result["total_copies"]) == ("incomplete", "validation_unavailable", "1")
    assert (result["deck_list_cost"]["status"], result["deck_list_cost"]["amount"]) == ("priced", "0.5")
    assert result["cost_to_complete"] == result["deck_list_cost"]
    # One quote read covers the held and the listed Editions together.
    assert calls == [{normal["id"], reverse["id"]}]
