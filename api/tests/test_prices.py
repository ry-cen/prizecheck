"""Cached exact-Edition prices: pure validation first, then signed HTTP against PostgreSQL and a real record store."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.main import app, connect, operation_counter  # noqa: F401
from app.price_budget import Budget
from app.prices import format_usd, parse_amount

# ------------------------------------------------------------------ amounts and display


@pytest.mark.parametrize("text", ["0", "0.43", "1", "12.5", "999999999999", "999999999999.123456", "10"])
def test_strict_amounts_parse_to_exact_decimals(text):
    assert parse_amount(text) == Decimal(text)


@pytest.mark.parametrize("value", ["1e3", "NaN", "Infinity", "-0.01", "-0", "+1", " 1", "1 ", "01", "00.5", ".5", "5.", "1.1234567",
                                   "1,000", "9999999999999", "1_0", "０", "", "0x10", None, 1, 1.5, True, Decimal("1")])
def test_everything_but_the_strict_grammar_is_rejected(value):
    assert parse_amount(value) is None


def test_display_rounds_half_up_to_cents_only_at_display_and_marks_sub_cent_amounts():
    assert format_usd(Decimal("0.43")) == "$0.43"
    assert format_usd(Decimal("0.435")) == "$0.44"      # half-up, not banker's rounding
    assert format_usd(Decimal("0.445")) == "$0.45"
    assert format_usd(Decimal("0.4349999")) == "$0.43"
    assert format_usd(Decimal("1234567.5")) == "$1,234,567.50"
    assert format_usd(Decimal("999999999999.999999")) == "$1,000,000,000,000.00"
    assert format_usd(Decimal("0.01")) == "$0.01"
    assert format_usd(Decimal("0.009999")) == "<$0.01"
    assert format_usd(Decimal("0.000001")) == "<$0.01"


# ------------------------------------------------------------------ budget arithmetic


def test_budget_derives_the_wait_window_and_never_returns_a_zero_postgres_timeout(monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr("app.price_budget.time.monotonic", lambda: clock["now"])
    budget = Budget(hard=1003.0, caller="user:u")
    assert budget.wait_until == 1002.5
    assert (round(budget.remaining(), 3), round(budget.wait_remaining(), 3), budget.expired()) == (3.0, 2.5, False)
    assert budget.pg_timeout_ms() == 2500 and budget.pg_timeout_ms(final=True) == 2950  # 50 ms margin to answer
    clock["now"] = 1002.9999
    assert budget.wait_remaining() == 0 and not budget.expired() and budget.pg_timeout_ms() == 1 and budget.pg_timeout_ms(final=True) == 1
    clock["now"] = 1003.0
    assert budget.expired() and budget.remaining() == 0


# ================================================================== HTTP against PostgreSQL and a real record store
import hashlib  # noqa: E402
import hmac  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import socket  # noqa: E402
import time  # noqa: E402
from uuid import uuid4  # noqa: E402

import psycopg  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import prices  # noqa: E402
from app.price_reads import price_reads_enabled  # noqa: E402
from app.catalog_targets import MATCHING  # noqa: E402
from app.public_records import public_record_store, quote_key, result_key  # noqa: E402
from test_catalog import reset_catalog  # noqa: E402
from test_catalog_metadata import Records, furret  # noqa: E402
from test_catalog_reconciliation import run  # noqa: E402
from test_catalog_targets import activate, card, isolated_rules, metadata  # noqa: E402,F401  (isolated_rules is autouse)

client = TestClient(app)
PATH = "/api/prices/editions"
USER = "price-reader"


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "filesystem")
    public_record_store().initialize(deadline=time.monotonic() + 5)
    return public_record_store()


def sign(message):
    return hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), message.encode(), hashlib.sha256).hexdigest()


def headers_for(raw, *, method="POST", path=PATH, user=USER, ms=3000, caller=None, stamp=None, budget_stamp_ms=None,
                budget=True, forge=None):
    """Gateway headers: the identity stamp is epoch seconds, the budget stamp epoch milliseconds (when it signed)."""
    stamp = str(int(time.time()) if stamp is None else stamp)
    budget_stamp = str(int(time.time() * 1000) if budget_stamp_ms is None else budget_stamp_ms)
    body_hash = hashlib.sha256(raw).hexdigest()
    headers = {"content-type": "application/json"}
    if user:
        headers.update({"x-internal-user": user, "x-internal-time": stamp,
                        "x-internal-signature": sign(f"{method}\n{path}\n{body_hash}\n{user}\n{stamp}")})
    if budget:
        caller = caller or f"user:{user}"
        signature = sign(f"budget\n{method}\n{path}\n{body_hash}\n{caller}\n{ms}\n{budget_stamp}")
        headers.update({"x-internal-budget-ms": str(ms), "x-internal-budget-time": budget_stamp, "x-internal-caller": caller,
                        "x-internal-budget-signature": forge or signature})
    return headers


def post(body, *, raw=None, **options):
    raw = raw if raw is not None else json.dumps(body, separators=(",", ":")).encode()
    return client.post(PATH, content=raw, headers=headers_for(raw, **options))


def ids(*editions):
    return {"edition_ids": [str(edition) for edition in editions]}


def world(pagers=0):
    """Two verified Editions of one Printing (normal and reverse) and an Unspecified Variant Edition of another.

    `pagers` adds that many further unspecified Printings (used by the browser spec to fill more than one page)."""
    reset_catalog()
    with connect() as conn:
        conn.execute("DELETE FROM tcgplayer_price")  # an earlier test's rows would bind during the import's rebind
    activate(MATCHING, 1)
    plain = furret(id="meta-2", localId="2")
    del plain["variants_detailed"]
    plain["variants"] = {}
    extra = []
    for number in range(pagers):
        record = furret(id=f"pager-{number}", name=f"Aaa {number:02d}", localId=str(100 + number))
        del record["variants_detailed"]
        record["variants"] = {}
        extra.append(record)
    run(Records(card(1), plain, *extra))
    with connect() as conn:
        rows = conn.execute("""SELECT e.id,e.public_ref,e.descriptor,m.mapping_state,m.mapping_revision,m.product_id,m.quote_variant,p.source_id
          FROM catalog_edition e JOIN catalog_edition_metadata m ON m.edition_id=e.id JOIN catalog_printing p ON p.id=e.printing_id
          ORDER BY p.source_id""").fetchall()
    found = {"pagers": []}
    for row in rows:
        if row["source_id"] == "meta-2":
            found["unspecified"] = row
        elif row["source_id"] == "meta-1":
            found[row["quote_variant"]] = row
        else:
            found["pagers"].append(row)
    assert {"normal", "reverse-holofoil", "unspecified"} <= set(found), found
    return found


RELATIVE = object()  # seed() default: a time relative to now (an explicit None still means "no time")


def ago(delta):
    return (datetime.now(timezone.utc) - delta).replace(microsecond=0).isoformat().replace("+00:00", "Z")


SUB_TYPES = {"normal": "Normal", "reverse-holofoil": "Reverse Holofoil"}


def seed(store, edition, amount="0.43", *, low=None, mid=None, sub_type=None, product_id=None, revision=None, updated=RELATIVE,
         checked=RELATIVE, bind=True):
    """Seed what the daily import and `rebind` write: a ``tcgplayer_price`` row for the Edition's product and subtype, and an
    ``edition_price_binding`` row at the Edition's mapping revision. ``amount`` is the market price (None is a null one).
    ``store`` is unused; it stays so call sites read as before."""
    sub_type = sub_type or SUB_TYPES[edition["quote_variant"]]
    product_id = product_id or edition["product_id"]
    revision = revision or edition["mapping_revision"]
    # Relative to the wall clock: a snapshot a day old, seen ten minutes ago, so no seeded row ages into another band.
    updated = ago(timedelta(days=1)) if updated is RELATIVE else updated
    checked = ago(timedelta(minutes=10)) if checked is RELATIVE else checked
    with connect() as conn:
        conn.execute("""INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,low_price,mid_price,seen_at,source_updated_at)
          VALUES (%s,%s,%s::numeric,%s::numeric,%s::numeric,%s,%s) ON CONFLICT (product_id,sub_type_name) DO UPDATE SET
          market_price=EXCLUDED.market_price,low_price=EXCLUDED.low_price,mid_price=EXCLUDED.mid_price,
          seen_at=EXCLUDED.seen_at,source_updated_at=EXCLUDED.source_updated_at""",
                     (product_id, sub_type, amount, low, mid, checked, updated))
        if bind:
            conn.execute("""INSERT INTO edition_price_binding(edition_id,product_id,mapping_revision,sub_type_name)
              VALUES (%s,%s,%s,%s) ON CONFLICT (edition_id) DO UPDATE SET product_id=EXCLUDED.product_id,
              mapping_revision=EXCLUDED.mapping_revision,sub_type_name=EXCLUDED.sub_type_name,reason=NULL""",
                         (edition["id"], product_id, revision, sub_type))


def publish_prices(store=None):
    """Write the public ``price:`` records (what the import job's last step does) for every priced Edition, so the readers
    that never touch PostgreSQL (Published Deck cost, Discover) see what ``seed`` stored."""
    from app.public_prices import publish
    with connect() as conn:
        return publish(conn, store or public_record_store())


def seed_public(store, edition, amount="0.43", **options):
    """``seed`` the Edition's price row and binding, then publish the ``price:`` records."""
    seed(store, edition, amount, **options)
    publish_prices(store)


def ui_world(pagers=0):
    """Browser-spec seeding (web/tests/prices.spec.ts): the catalog, as ids. Quotes are seeded by ui_apply."""
    found = world(pagers)
    return {**{key: str(row["id"]) for key, row in found.items() if key != "pagers"}, "pagers": [str(row["id"]) for row in found["pagers"]]}


ROW_KEYS = ("amount", "low", "mid", "sub_type", "product_id", "revision", "updated", "checked", "bind")


def ui_apply(commands):
    """Browser-spec commands against the live stack's database. {op:'quote', edition, ...seed arguments} seeds a price row and
    its binding (what the private readers read) and then publishes the ``price:`` records (what the Published Deck cost and
    Discover read); {op:'sql', statement, edition} runs one UPDATE for the Edition and publishes again."""
    store = public_record_store()
    for command in commands:
        with connect() as conn:
            if command["op"] == "sql":
                conn.execute(command["statement"], (command["edition"],))
                continue
            edition = conn.execute("""SELECT e.id,e.public_ref,m.mapping_revision,m.product_id,m.quote_variant,p.source_id FROM catalog_edition e
              JOIN catalog_edition_metadata m ON m.edition_id=e.id JOIN catalog_printing p ON p.id=e.printing_id WHERE e.id=%s""",
                                   (command["edition"],)).fetchone()
        arguments = {key: value for key, value in command.items() if key not in ("op", "edition")}
        assert set(arguments) <= set(ROW_KEYS), arguments
        seed(store, edition, **arguments)
    publish_prices(store)


def prices_of(response):
    assert response.status_code == 200, response.text
    return {row["edition_id"]: row for row in response.json()["prices"]}


def test_each_edition_gets_its_own_price_and_every_other_state_is_labelled_not_zero(store):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43", updated=ago(timedelta(hours=72)))
    unknown = uuid4()
    response = post(ids(normal["id"], reverse["id"], plain["id"], unknown, normal["id"]))
    rows = prices_of(response)
    assert [row["edition_id"] for row in response.json()["prices"]] == [str(i) for i in (normal["id"], reverse["id"], plain["id"], unknown)]
    assert response.json()["withheld"] is False
    one = rows[str(normal["id"])]
    assert (one["status"], one["amount"], one["display_amount"], one["stale"], one["age"]) == ("quote", "0.25", "$0.25", False, "known")
    assert one["refresh"] is None and one["refresh_failed_at"] is None
    two = rows[str(reverse["id"])]
    assert (two["amount"], two["age"], two["stale"]) == ("0.43", "known", True)
    three = rows[str(plain["id"])]
    assert (three["status"], three["reason"], three["amount"]) == ("unavailable", "unspecified_variant", None)
    assert (rows[str(unknown)]["status"], rows[str(unknown)]["reason"]) == ("unavailable", "not_found")
    assert response.headers["cache-control"] == "no-store"


def test_amounts_are_exact_decimal_text_and_display_rounds_only_at_display(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "100.000000")
    seed(store, reverse, "0.004000")
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    assert (rows[str(normal["id"])]["amount"], rows[str(normal["id"])]["display_amount"]) == ("100", "$100.00")
    assert (rows[str(reverse["id"])]["amount"], rows[str(reverse["id"])]["display_amount"]) == ("0.004", "<$0.01")


def test_only_the_market_price_is_shown_and_an_empty_or_zero_one_is_no_price(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, None, low="0.10", mid="0.20")  # owner answer 1: no fallback to mid or low
    seed(store, reverse, "0")
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    for edition in (normal, reverse):
        row = rows[str(edition["id"])]
        assert (row["status"], row["reason"], row["amount"], row["display_amount"]) == ("unavailable", "no_price", None, None)
    seed(store, normal, "0.31", low="0.10", mid="0.20")
    assert prices_of(post(ids(normal["id"])))[str(normal["id"])]["amount"] == "0.31"


@pytest.mark.parametrize("amount", ["NaN", "-0.01", "0.000000"])
def test_an_invalid_or_zero_amount_is_no_price_for_its_own_row_only(store, amount):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, amount)
    seed(store, reverse, "0.43")
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    one = rows[str(normal["id"])]
    assert (one["status"], one["reason"], one["amount"]) == ("unavailable", "no_price", None)
    assert rows[str(reverse["id"])]["amount"] == "0.43"


def test_a_verified_unbound_edition_a_price_free_binding_and_a_missing_row_are_no_price(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    assert prices_of(post(ids(normal["id"])))[str(normal["id"])]["reason"] == "no_price"  # verified, never bound
    seed(store, normal, "0.25", bind=False)
    assert prices_of(post(ids(normal["id"])))[str(normal["id"])]["reason"] == "no_price"  # a price row but no binding
    with connect() as conn:
        conn.execute("""INSERT INTO edition_price_binding(edition_id,product_id,mapping_revision,reason)
          VALUES (%s,%s,%s,'shared_price') ON CONFLICT (edition_id) DO UPDATE SET sub_type_name=NULL,reason='shared_price'""",
                     (reverse["id"], reverse["product_id"], reverse["mapping_revision"]))
        conn.execute("DELETE FROM tcgplayer_price")
    seed(store, reverse, "0.43", bind=False)
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    assert {row["reason"] for row in rows.values()} == {"no_price"}  # an unbound reason hides a price on the same product
    with connect() as conn:
        conn.execute("""UPDATE edition_price_binding SET sub_type_name='Holofoil',reason=NULL WHERE edition_id=%s""", (reverse["id"],))
    assert prices_of(post(ids(reverse["id"])))[str(reverse["id"])]["reason"] == "no_price"  # bound to a subtype with no row


def test_a_binding_under_an_old_mapping_revision_or_product_is_ignored(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal)
    seed(store, reverse)
    assert {row["status"] for row in prices_of(post(ids(normal["id"], reverse["id"]))).values()} == {"quote"}
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET mapping_revision=mapping_revision+1 WHERE edition_id=%s", (normal["id"],))
        conn.execute("UPDATE edition_price_binding SET product_id=product_id+1 WHERE edition_id=%s", (reverse["id"],))
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    for edition in (normal, reverse):
        row = rows[str(edition["id"])]
        assert (row["status"], row["reason"], row["amount"]) == ("unavailable", "no_price", None)
    seed(store, normal, "9.99", revision=normal["mapping_revision"] + 1)  # a rebind under the new revision prices it again
    assert prices_of(post(ids(normal["id"])))[str(normal["id"])]["amount"] == "9.99"


def test_a_postgres_quarantine_hides_the_price_at_once(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal)
    seed(store, reverse)
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed' WHERE edition_id=%s", (normal["id"],))
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    one = rows[str(normal["id"])]
    assert (one["status"], one["reason"], one["amount"]) == ("unavailable", "quarantined", None)
    assert rows[str(reverse["id"])]["status"] == "quote"


def test_unverified_editions_keep_their_reason_and_a_price_row_does_not_verify_them(store):
    editions = world()
    reverse = editions["reverse-holofoil"]
    seed(store, reverse)
    with connect() as conn:
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='unverified',mapping_reason='no_matching_rule',product_id=NULL,
          quote_variant=NULL,mapping_basis=NULL,matching_activation_id=NULL,auto_closed=false WHERE edition_id=%s""", (reverse["id"],))
    assert prices_of(post(ids(reverse["id"])))[str(reverse["id"])]["reason"] == "unverified"


def test_quote_candidate_snapshots_never_price_an_edition(store):
    normal = world()["normal"]
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET quote_candidate=%s WHERE edition_id=%s",
                     (json.dumps({"market_price": 9.99, "amount": "9.99", "currency": "USD"}), normal["id"]))
    row = prices_of(post(ids(normal["id"])))[str(normal["id"])]
    assert (row["status"], row["reason"], row["amount"]) == ("unavailable", "no_price", None)


def test_staleness_uses_the_module_clock_and_the_snapshot_age(store, monkeypatch):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    base = datetime.now(timezone.utc).replace(microsecond=0)
    text = lambda moment: moment.isoformat().replace("+00:00", "Z")  # noqa: E731
    seed(store, normal, updated=text(base - timedelta(hours=48)), checked=text(base - timedelta(seconds=1)))
    seed(store, reverse, updated=text(base - timedelta(hours=48) + timedelta(seconds=1)))
    monkeypatch.setattr(prices, "_now", lambda: base)
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    assert rows[str(normal["id"])]["stale"] is False  # exactly 48 h
    assert rows[str(reverse["id"])]["stale"] is False
    monkeypatch.setattr(prices, "_now", lambda: base + timedelta(microseconds=500))
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    assert rows[str(normal["id"])]["stale"] is True and rows[str(normal["id"])]["checked_at"] == text(base - timedelta(seconds=1))
    assert rows[str(normal["id"])]["provider_updated_at"] == text(base - timedelta(hours=48))
    assert rows[str(reverse["id"])]["stale"] is False


# ------------------------------------------------------------------ the kill switch and the record store


def count_connects(patched):
    calls = []
    real = psycopg.connect
    patched.setattr(psycopg, "connect", lambda *a, **k: calls.append(a) or real(*a, **k))
    return calls


def test_price_reads_off_answers_no_price_for_every_row_without_a_query(store, monkeypatch):
    editions = world()
    normal, plain = editions["normal"], editions["unspecified"]
    seed(store, normal)
    unknown = uuid4()
    monkeypatch.setenv("PRICE_READS", "off")
    assert price_reads_enabled() is False
    with monkeypatch.context() as patched:
        calls = count_connects(patched)
        response = post(ids(normal["id"], plain["id"], unknown))
        stored = prices.stored_edition_quotes([normal["id"]])
    rows = prices_of(response)
    assert {(row["status"], row["reason"], row["amount"]) for row in rows.values()} == {("unavailable", "no_price", None)}
    assert response.json()["withheld"] is False
    assert stored[normal["id"]].reason == "no_price"
    assert calls == []
    monkeypatch.setenv("PRICE_READS", "of")
    assert price_reads_enabled() is False  # a mistyped value fails safe
    monkeypatch.setenv("PRICE_READS", "on")
    assert price_reads_enabled() is True and prices_of(post(ids(normal["id"])))[str(normal["id"])]["amount"] == "0.43"
    monkeypatch.delenv("PRICE_READS")
    assert price_reads_enabled() is True and prices_of(post(ids(normal["id"])))[str(normal["id"])]["amount"] == "0.43"


def test_no_price_route_reads_or_writes_the_record_store_or_calls_price_refresh(store, monkeypatch):
    from app import price_refresh, public_records
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal)
    seed(store, reverse, "0.43", checked=ago(timedelta(hours=30)))

    def forbidden(*args, **kwargs):
        raise AssertionError("a price read touched the record store or the refresh path")
    for name in ("public_record_store", "quote_states"):
        monkeypatch.setattr(public_records, name, forbidden)
    for name in ("evaluate_and_admit", "Row"):
        monkeypatch.setattr(price_refresh, name, forbidden)
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    assert {row["status"] for row in rows.values()} == {"quote"} and {row["refresh"] for row in rows.values()} == {None}
    assert prices.stored_edition_quotes([normal["id"], reverse["id"]])[normal["id"]].amount == "0.43"
    assert not hasattr(prices, "public_record_store") and not hasattr(prices, "price_refresh")


def test_stored_edition_quotes_answer_from_the_same_rows_and_none_when_postgres_cannot(store, monkeypatch):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, "0.25")
    views = prices.stored_edition_quotes([normal["id"], reverse["id"], plain["id"]])
    assert (views[normal["id"]].status, views[normal["id"]].amount) == ("quote", "0.25")
    assert views[reverse["id"]].reason == "no_price" and views[plain["id"]].reason == "unspecified_variant"
    assert prices.stored_edition_quotes([]) == {}

    def down(*args, **kwargs):
        raise psycopg.OperationalError("down")
    with monkeypatch.context() as patched:
        patched.setattr(psycopg, "connect", down)
        assert prices.stored_edition_quotes([normal["id"]]) is None


def test_a_postgres_failure_withholds_the_row_as_validation_unavailable(store, monkeypatch):
    normal = world()["normal"]
    seed(store, normal)

    def down(*args, **kwargs):
        raise psycopg.OperationalError("down")
    with monkeypatch.context() as patched:
        patched.setattr(psycopg, "connect", down)
        response = post(ids(normal["id"]))
    row = response.json()["prices"][0]
    assert (row["status"], row["reason"], row["amount"]) == ("failed", "validation_unavailable", None)
    assert response.json()["withheld"] is True


def test_a_catalog_pull_writes_no_quote_result_or_fence_record(store):
    from app import catalog
    from app.public_records import fence_key
    world()
    assert not hasattr(catalog, "seed_from_import") and not hasattr(catalog, "price_views") and not hasattr(catalog, "price_view")
    assert not hasattr(catalog.TCGdexSource(), "price_views")
    run(Records(card(1), furret(id="meta-2", localId="2")))
    with connect() as conn:
        rows = conn.execute("SELECT public_ref,mapping_revision FROM catalog_edition e JOIN catalog_edition_metadata m ON m.edition_id=e.id").fetchall()
    assert rows
    keys = [make(row["public_ref"], row["mapping_revision"]) for row in rows for make in (quote_key, result_key, fence_key)]
    assert {record.value for record in store.read_records(keys, deadline=time.monotonic() + 5).records.values()} == {None}


# ------------------------------------------------------------------ the trusted budget


def test_missing_or_forged_budget_metadata_is_401_and_reads_nothing(store, monkeypatch):
    normal = world()["normal"]
    monkeypatch.setattr(prices, "private_edition_quotes", lambda *a, **k: pytest.fail("a price read ran"))
    body = json.dumps(ids(normal["id"]), separators=(",", ":")).encode()
    assert post(None, raw=body, budget=False).status_code == 401
    assert post(None, raw=body, forge="0" * 64).status_code == 401
    assert post(None, raw=body, user=None, budget=True).status_code == 401  # no user headers at all
    assert post(None, raw=body, stamp=int(time.time()) - 31).status_code == 401
    assert post(None, raw=body, budget_stamp_ms=int(time.time() * 1000) - 31_000).status_code == 401
    valid = headers_for(body)
    for change in ({"x-internal-budget-ms": "99999"}, {"x-internal-budget-ms": "1"}, {"x-internal-caller": "user:someone-else"},
                   {"x-internal-budget-time": str(int(time.time() * 1000) + 1)}):
        assert client.post(PATH, content=body, headers={**valid, **change}).status_code == 401
    other = json.dumps(ids(uuid4()), separators=(",", ":")).encode()
    assert client.post(PATH, content=other, headers=valid).status_code == 401  # a budget is bound to its body


def test_a_budget_for_another_caller_cannot_be_used_with_this_users_identity(store, monkeypatch):
    normal = world()["normal"]
    monkeypatch.setattr(prices, "private_edition_quotes", lambda *a, **k: pytest.fail("a price read ran"))
    body = json.dumps(ids(normal["id"]), separators=(",", ":")).encode()
    assert post(None, raw=body, caller="user:attacker").status_code == 401
    assert post(None, raw=body, caller="anon:abcdef").status_code == 401


def test_a_client_supplied_deadline_is_ignored(store):
    normal = world()["normal"]
    body = json.dumps(ids(normal["id"]), separators=(",", ":")).encode()
    headers = {**headers_for(body, ms=0), "x-deadline": "60", "x-internal-budget": "60000", "timeout": "60"}
    response = client.post(PATH, content=body, headers=headers)
    assert response.status_code == 200 and response.json()["withheld"] is True


def test_time_since_the_gateway_signed_is_spent_budget(store, monkeypatch):
    normal = world()["normal"]
    seed(store, normal)
    body = json.dumps(ids(normal["id"]), separators=(",", ":")).encode()
    fresh = client.post(PATH, content=body, headers=headers_for(body))
    assert fresh.status_code == 200 and fresh.json()["withheld"] is False
    # Signed 3.5 s ago with 3000 ms granted: the gateway has already aborted, so no work may start.
    aged = headers_for(body, budget_stamp_ms=int(time.time() * 1000) - 3_500)
    with monkeypatch.context() as patched:
        patched.setattr(psycopg, "connect", lambda *a, **k: pytest.fail("a spent budget started a price query"))
        response = client.post(PATH, content=body, headers=aged)
    assert response.status_code == 200 and response.json()["withheld"] is True
    assert response.json()["prices"][0]["reason"] == "deadline"


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_an_exhausted_budget_withholds_immediately_without_touching_postgres(store, monkeypatch):
    normal = world()["normal"]
    seed(store, normal)

    def forbidden(*a, **k):
        raise AssertionError("an exhausted budget must not start work")
    monkeypatch.setattr(prices, "_read_rows", forbidden)
    started = time.monotonic()
    response = post(ids(normal["id"]), ms=0)
    assert time.monotonic() - started < 0.5
    assert response.status_code == 200 and response.json()["withheld"] is True
    row = response.json()["prices"][0]
    assert (row["status"], row["reason"], row["amount"]) == ("failed", "deadline", None)


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
@pytest.mark.slow(reason='wall-clock: waits out a stalled price query')
def test_a_stalled_price_query_withholds_the_row_inside_the_budget(store, monkeypatch):
    normal = world()["normal"]
    seed(store, normal)
    locker = psycopg.connect(os.environ["DATABASE_URL"])
    locker.execute("LOCK TABLE edition_price_binding IN ACCESS EXCLUSIVE MODE")
    try:
        started = time.monotonic()
        response = post(ids(normal["id"]), ms=1500)
        elapsed = time.monotonic() - started
    finally:
        locker.rollback()
        locker.close()
    assert elapsed < 1.5, elapsed
    row = response.json()["prices"][0]
    assert row["status"] == "failed" and row["reason"] in ("deadline", "validation_unavailable")
    assert (row["amount"], row["display_amount"]) == (None, None) and response.json()["withheld"] is True


def test_a_response_that_would_finish_after_the_hard_deadline_is_withheld(store, monkeypatch):
    normal = world()["normal"]
    seed(store, normal)
    real = prices._row_view

    def slow(*args, **kwargs):
        time.sleep(0.3)
        return real(*args, **kwargs)
    monkeypatch.setattr(prices, "_row_view", slow)
    response = post(ids(normal["id"]), ms=200)
    row = response.json()["prices"][0]
    assert (row["status"], row["reason"], row["amount"]) == ("failed", "deadline", None) and response.json()["withheld"] is True


# ------------------------------------------------------------------ request contract


def test_the_request_is_capped_strict_and_never_carries_a_target_or_force():
    some = uuid4()
    assert post({"edition_ids": [str(uuid4()) for _ in range(64)]}).status_code == 200
    assert post({"edition_ids": [str(uuid4()) for _ in range(65)]}).status_code == 422
    assert post({"edition_ids": []}).status_code == 422
    assert post({"edition_ids": ["not-a-uuid"]}).status_code == 422
    for extra in ({"force": True}, {"source_url": "http://example.test"}, {"target": "x"}, {"refresh": True}):
        assert post({**ids(some), **extra}).status_code == 422
    assert post(None, raw=b"not json").status_code == 422
    assert post(None, raw=b'["x"]').status_code == 422
    assert len(post(ids(some, some, some)).json()["prices"]) == 1


def test_bodies_over_16_kib_are_413_even_when_valid_json_and_correctly_signed():
    base = json.dumps(ids(uuid4()), separators=(",", ":")).encode()
    exact = base + b" " * (16 * 1024 - len(base))
    assert len(exact) == 16384 and post(None, raw=exact).status_code == 200
    over = exact + b" "
    assert len(over) == 16385 and post(None, raw=over).status_code == 413
    # Multi-byte padding is measured in bytes, not characters.
    wide = base[:-1] + b',"x":"' + "é".encode() * 8200 + b'"}'
    assert len(wide) > 16384 and post(None, raw=wide).status_code == 413


# ------------------------------------------------------------------ no side effects


def test_a_price_read_writes_nothing_and_contacts_nothing_but_postgres(store, monkeypatch):
    editions = world()
    normal, plain = editions["normal"], editions["unspecified"]
    seed(store, normal, checked=ago(timedelta(hours=30)))  # old rows are read as they are; there is nothing to refresh
    tables = ("catalog_edition", "catalog_edition_metadata", "catalog_printing", "catalog_public_outbox", "operations_hour",
              "tcgplayer_price", "tcgplayer_product", "edition_price_binding")

    def stamps():
        operation_counter.flush()  # counts from earlier requests are written in the background
        with connect() as conn:
            return {t: sorted(r["x"] for r in conn.execute(f"SELECT xmin::text||':'||ctid::text AS x FROM {t}")) for t in tables}
    before = stamps()
    real = socket.socket.connect

    def guarded(self, address):
        if not (isinstance(address, tuple) and address[1] == 5432) and not isinstance(address, str):
            raise AssertionError(f"unexpected network connection {address}")
        return real(self, address)
    monkeypatch.setattr(socket.socket, "connect", guarded)
    assert post(ids(normal["id"], plain["id"])).status_code == 200
    monkeypatch.undo()
    assert stamps() == before  # including operations_hour: the request counter is not written for price reads


def test_there_is_no_refresh_or_force_route():
    paths = {path: set(methods) for path, methods in app.openapi()["paths"].items() if path.startswith("/api/prices")}
    assert paths == {PATH: {"post"}}


def test_no_api_route_can_refresh_or_force_a_price():
    import re
    for path in app.openapi()["paths"]:
        assert not re.search(r"refresh|force|reload|revalidate|max.?age|no.?cache", path, re.I), path
    assert not any(re.search(r"refresh|force", name, re.I) for name in prices.PriceRequest.model_fields)
    for extra in ({"force": True}, {"refresh": True}, {"max_age": 0}, {"no_cache": True}):
        assert post({**ids(uuid4()), **extra}).status_code == 422


def test_cache_control_and_pragma_headers_change_nothing(store):
    normal = world()["normal"]
    seed(store, normal, checked=ago(timedelta(minutes=30)))
    raw = json.dumps(ids(normal["id"]), separators=(",", ":")).encode()
    headers = {**headers_for(raw), "cache-control": "no-cache, max-age=0", "pragma": "no-cache", "x-refresh": "1"}
    row = client.post(PATH, content=raw, headers=headers).json()["prices"][0]
    assert row["refresh"] is None and row["amount"] == "0.43"
