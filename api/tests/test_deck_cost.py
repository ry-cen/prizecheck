"""Complete private Deck cost (ticket 09): signed HTTP against PostgreSQL and a real record store.

Every assertion is on the route's answer (the same body the browser renders) or on what the shared stores hold
afterwards; nothing here calls the arithmetic or the capture directly.
"""
from datetime import timedelta
import os
import threading
import time
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app import price_launcher, price_refresh, prices, quote_contract
from app.public_projection import ProjectionUnavailable
from app.public_records import public_record_store
from test_catalog_targets import isolated_rules, owner  # noqa: F401  (isolated_rules is autouse)
from test_holdings import add, call
from test_prices import ago, client, headers_for, seed, world

USER = "deck-cost-owner"


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "filesystem")
    public_record_store().initialize(deadline=time.monotonic() + 5)
    return public_record_store()


@pytest.fixture(autouse=True)
def launches(monkeypatch):
    """No real runner is ever started here: admission sees a launcher that always succeeds and records the slot."""
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


def revision_of(user=USER):
    with connect() as conn:
        return conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s", (user,)).fetchone()["revision"]


def scheduler(store):
    key = quote_contract.scheduler_key()
    return store.read_records([key], deadline=time.monotonic() + 5).records[key].value


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


def test_unknown_provider_age_is_counted_by_copy_and_never_called_fresh_or_stale(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "1.10", updated=ago(timedelta(hours=1)))
    seed(store, reverse, "2.00", updated=None)
    result = body_of(cost(deck_with({normal["id"]: 1, reverse["id"]: 4})))
    assert (result["status"], result["amount"], result["display_amount"]) == ("priced", "9.1", "$9.10")
    assert (result["priced_copies"], result["total_copies"]) == ("5", "5")
    assert (result["stale_copies"], result["unknown_age_copies"]) == ("0", "4")


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
    monkeypatch.setattr(prices, "quote_states", lambda *a, **k: pytest.fail("an empty Deck read a price"))
    monkeypatch.setattr(price_refresh, "evaluate_and_admit", lambda *a, **k: pytest.fail("an empty Deck was admitted"))
    deck = deck_with({})
    result = body_of(cost(deck))
    assert result["status"] == "empty"
    assert (result["amount"], result["display_amount"]) == ("0", "$0.00")
    assert (result["priced_copies"], result["total_copies"], result["stale_copies"], result["unknown_age_copies"]) == ("0",) * 4
    assert result["owner_revision"] == revision_of()


def test_a_complete_scan_with_no_eligible_quote_is_price_unavailable_and_zero_of_n(store):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, result={"state": "absent", "checked_at": ago(timedelta(minutes=10)),
                                 "expires_at": ago(-timedelta(minutes=50))})
    # reverse: nothing cached at all; plain: an Unspecified Variant is never priced.
    result = body_of(cost(deck_with({normal["id"]: 2, reverse["id"]: 3, plain["id"]: 4})))
    assert result["status"] == "no_quotes"
    assert (result["amount"], result["display_amount"]) == (None, None)
    assert (result["priced_copies"], result["total_copies"]) == ("0", "9")


def test_a_store_outage_reports_no_numeric_coverage_only_the_total(store, monkeypatch):
    editions = world()
    normal, plain = editions["normal"], editions["unspecified"]
    seed(store, normal, "0.25")

    class Down:
        def read_all(self, *a, **k):
            raise ProjectionUnavailable()
        read_records = read_all
    monkeypatch.setattr(prices, "public_record_store", lambda: Down())
    result = body_of(cost(deck_with({normal["id"]: 2, plain["id"]: 5})))
    assert result["status"] == "incomplete" and result["reason"] == "store_unavailable"
    assert result["total_copies"] == "7"
    for field in ("amount", "display_amount", "priced_copies", "stale_copies", "unknown_age_copies"):
        assert result[field] is None, field


def test_an_exhausted_budget_reports_incomplete_without_touching_the_store(store, monkeypatch):
    normal = world()["normal"]
    seed(store, normal)
    monkeypatch.setattr(prices, "quote_states", lambda *a, **k: pytest.fail("an exhausted budget read the store"))
    deck = deck_with({normal["id"]: 2})
    started = time.monotonic()
    result = body_of(cost(deck, ms=0))
    assert time.monotonic() - started < 0.5
    assert result["status"] == "incomplete" and result["reason"] == "deadline"
    assert result["priced_copies"] is None and result["amount"] is None


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


# ------------------------------------------------------------------ invalidated and superseded quotes


def test_confirmed_absence_and_a_quarantined_mapping_never_enter_the_subtotal(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    # A confirmed absence whose superseded quote payload is still stored, and a quarantined mapping with a cached quote.
    seed(store, normal, "5.00", result={"state": "absent", "attempt": 1, "checked_at": ago(timedelta(minutes=10)),
                                         "expires_at": ago(-timedelta(minutes=50))})
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
            revision = conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='verified',mapping_reason=NULL,
              product_id=%s,quote_variant='normal',mapping_basis='matching_rule',matching_activation_id=%s,auto_closed=true
              WHERE edition_id=%s RETURNING mapping_revision""",
                                    (uuid4().int % 10**12, activation, edition["id"])).fetchone()["mapping_revision"]
            made.append({"id": edition["id"], "public_ref": edition["public_ref"], "mapping_revision": revision,
                         "quote_variant": "normal", "source_id": card})
    return made


def test_every_copy_of_a_large_deck_is_evaluated_with_one_admission_and_one_budget(store, monkeypatch):
    from app import public_records
    editions = verified_editions(70)          # 140 store keys: more than one 128-key read
    fresh, hard = editions[:30], editions[30:]
    for edition in fresh:
        seed(store, edition, "0.10")
    for edition in hard:                      # 40 day-old checks: more than the 32 new jobs one access may admit
        seed(store, edition, "0.20", checked=ago(timedelta(hours=25)))
    calls, batches = [], []
    real_admit, real_records = price_refresh.evaluate_and_admit, public_records._Records.read_all
    monkeypatch.setattr(price_refresh, "evaluate_and_admit",
                        lambda rows, *a, **k: calls.append(len(rows)) or real_admit(rows, *a, **k))

    def counting(self, keys, **kwargs):
        batches.append(len(list(keys)))
        return real_records(self, keys, **kwargs)
    monkeypatch.setattr(public_records._Records, "read_all", counting)
    deck = deck_with({edition["id"]: 2 for edition in editions})
    started = time.monotonic()
    result = body_of(cost(deck))
    elapsed = time.monotonic() - started
    assert calls == [70]                      # one access, every Deck row, one admission
    assert max(batches) >= 140
    assert 2.0 < elapsed < 3.0, elapsed       # the hard rows used one wait window for the whole Deck
    assert (result["status"], result["priced_copies"], result["total_copies"]) == ("priced", "140", "140")
    assert (result["amount"], result["display_amount"]) == ("22", "$22.00")   # 60 x 0.10 + 80 x 0.20, nothing omitted
    assert result["fallback_copies"] == "80"  # the day-old copies kept their labelled cached quote
    sched = scheduler(store)
    assert len(sched["jobs"]) == 32 and sched["interactive"] == {}


def test_bounded_admission_never_drops_copies_on_a_later_access(store):
    editions = verified_editions(40)
    for edition in editions:
        seed(store, edition, "0.20", checked=ago(timedelta(hours=2)))   # soft: answered now, refreshed in the background
    deck = deck_with({edition["id"]: 1 for edition in editions})
    first = body_of(cost(deck))
    assert (first["status"], first["priced_copies"], first["total_copies"], first["amount"]) == ("priced", "40", "40", "8")
    assert len(scheduler(store)["jobs"]) == 32       # 32 new jobs per access; the other 8 rows are labelled, not dropped
    second = body_of(cost(deck))                     # the caller's 32 outstanding jobs refuse more work, never copies
    assert (second["priced_copies"], second["total_copies"], second["amount"]) == ("40", "40", "8")
    assert len(scheduler(store)["jobs"]) == 32


# ------------------------------------------------------------------ locks, revisions and the rest of the page


def test_inventory_locks_are_released_before_the_wait_and_the_answer_names_its_revision(store):
    editions = world()
    normal, plain = editions["normal"], editions["unspecified"]
    seed(store, normal, "0.25", checked=ago(timedelta(hours=25)))     # hard: the request waits for a runner
    deck = deck_with({normal["id"]: 2})
    captured = revision_of()
    answer = {}
    waiting = threading.Thread(target=lambda: answer.setdefault("response", cost(deck)))
    waiting.start()
    time.sleep(0.6)                                                  # the request is inside its wait window now
    started = time.monotonic()
    added = add(USER, deck, str(plain["id"]), "1")
    checks = call("GET", f"/api/decks/{deck}", USER)
    elapsed = time.monotonic() - started
    waiting.join()
    assert added.status_code == 200, added.text
    assert checks.status_code == 200 and checks.json()["checks"]["total"] == "3"
    assert elapsed < 1.0, elapsed                                    # neither the write nor the checks waited for prices
    result = body_of(answer["response"])
    assert result["owner_revision"] == captured != revision_of()     # the client discards it for the newer revision
    assert (result["priced_copies"], result["total_copies"]) == ("2", "2")
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
    assert launches == [] and scheduler(store) is None
