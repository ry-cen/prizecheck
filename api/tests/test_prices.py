"""Cached exact-Edition prices: pure validation first, then signed HTTP against PostgreSQL and a real record store."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes the prices router while loading)
from app.price_budget import Budget
from app.prices import format_usd, parse_amount, validate_quote
from app.public_records import QuoteState

NOW = datetime(2026, 10, 9, 12, 0, 0, tzinfo=timezone.utc)
LOOKUP = {"source": "tcgdex", "card": "meta-1", "variant": "normal"}


def iso(delta):
    return (NOW - delta).isoformat().replace("+00:00", "Z")


def quote_state(amount="0.43", updated=None, checked=None, **payload):
    body = {"attempt": 1, "amount": amount, "currency": "USD", "source": "tcgdex", "card": "meta-1", "variant": "normal",
            "provider_updated_at": updated, **payload}
    result = {"state": "quote", "attempt": 1, "checked_at": checked}
    return QuoteState("quote", result, body, "g1")


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


# ------------------------------------------------------------------ what a state means


def view(state, lookup=LOOKUP, now=NOW):
    return validate_quote(lookup, state, now)


def test_an_unknown_state_is_not_cached_and_never_a_zero():
    result = view(QuoteState("unknown", None, None, "g"))
    assert (result.status, result.reason, result.amount, result.display_amount) == ("unavailable", "not_cached", None, None)
    assert result.currency == "USD" and result.age == "unknown" and result.stale is None


def test_absent_is_confirmed_unavailable_and_pending_hides_any_quote():
    absent = view(QuoteState("absent", {"state": "absent", "checked_at": iso(timedelta(hours=1))}, None, "g"))
    assert (absent.status, absent.reason, absent.amount) == ("unavailable", "confirmed_absent", None)
    assert absent.checked_at == iso(timedelta(hours=1))
    pending = view(QuoteState("pending", {"state": "pending"}, None, "g"))
    assert (pending.status, pending.amount, pending.display_amount) == ("pending", None, None)


def test_a_valid_quote_carries_exact_and_display_amounts_and_keeps_provider_age_apart_from_the_check():
    result = view(quote_state("0.435", updated=iso(timedelta(hours=3)), checked=iso(timedelta(minutes=5))))
    assert (result.status, result.reason, result.amount, result.display_amount) == ("quote", None, "0.435", "$0.44")
    assert result.provider_updated_at == iso(timedelta(hours=3)) and result.checked_at == iso(timedelta(minutes=5))
    assert (result.age, result.stale) == ("known", False)


def test_staleness_is_strictly_over_48_hours_of_provider_age():
    at = view(quote_state(updated=iso(timedelta(hours=48))))
    over = view(quote_state(updated=iso(timedelta(hours=48, microseconds=1))))
    assert (at.age, at.stale) == ("known", False)
    assert (over.age, over.stale) == ("known", True)


def test_a_fresh_check_never_renews_provider_age():
    result = view(quote_state(updated=iso(timedelta(days=30)), checked=iso(timedelta(seconds=1))))
    assert result.stale is True and result.provider_updated_at == iso(timedelta(days=30))


@pytest.mark.parametrize("updated", [None, "", "garbage", "2026-10-08T12:00:00", 17, "2999-01-01T00:00:00Z",
                                     "2026-10-09T12:06:00Z", "12/10/2026"])
def test_missing_garbled_naive_or_future_provider_time_is_age_unknown_not_fresh(updated):
    result = view(quote_state(updated=updated))
    assert result.status == "quote" and result.age == "unknown" and result.stale is None and result.provider_updated_at is None


@pytest.mark.parametrize("amount", ["1e3", "NaN", "-0.01", 0.43, 43, "12345678901234", "0.4300000", None])
def test_a_bad_amount_fails_only_that_quote_closed(amount):
    result = view(quote_state(amount))
    assert (result.status, result.reason, result.amount, result.display_amount) == ("failed", "invalid_quote", None, None)


def test_a_validated_zero_quote_is_a_real_zero_price():
    # spec: quotes are finite, nonnegative decimals; only missing data must never read as $0.
    result = view(quote_state("0"))
    assert (result.status, result.amount, result.display_amount) == ("quote", "0", "$0.00")


@pytest.mark.parametrize("change", [{"currency": "EUR"}, {"currency": None}, {"source": "other"}])
def test_currency_or_source_other_than_usd_tcgdex_is_invalid(change):
    state = quote_state(updated=iso(timedelta(hours=1)))
    state = QuoteState("quote", state.result, {**state.quote, **change}, "g")
    assert view(state).reason == "invalid_quote"


@pytest.mark.parametrize("change", [{"card": "other"}, {"variant": "holofoil"}, {"card": None}])
def test_a_quote_for_another_card_or_variant_than_the_reviewed_lookup_fails_closed(change):
    result = view(quote_state(**change))
    assert (result.status, result.reason, result.amount) == ("failed", "lookup_mismatch", None)


def test_a_malformed_provider_time_never_hides_a_valid_amount_and_a_malformed_check_time_is_dropped():
    result = view(quote_state(updated="nope", checked="also nope"))
    assert result.status == "quote" and result.checked_at is None and result.age == "unknown"


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
import threading  # noqa: E402
import time  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402
from uuid import uuid4  # noqa: E402

import psycopg  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import prices  # noqa: E402
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


def headers_for(raw, *, method="POST", path=PATH, user=USER, ms=3000, caller=None, stamp=None, budget=True, forge=None):
    stamp = str(int(time.time()) if stamp is None else stamp)
    body_hash = hashlib.sha256(raw).hexdigest()
    headers = {"content-type": "application/json"}
    if user:
        headers.update({"x-internal-user": user, "x-internal-time": stamp,
                        "x-internal-signature": sign(f"{method}\n{path}\n{body_hash}\n{user}\n{stamp}")})
    if budget:
        caller = caller or f"user:{user}"
        signature = sign(f"budget\n{method}\n{path}\n{body_hash}\n{caller}\n{ms}\n{stamp}")
        headers.update({"x-internal-budget-ms": str(ms), "x-internal-budget-time": stamp, "x-internal-caller": caller,
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
        rows = conn.execute("""SELECT e.id,e.public_ref,e.descriptor,m.mapping_state,m.mapping_revision,m.quote_variant,p.source_id
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


def seed(store, edition, amount="0.43", *, variant=None, card_id=None, state="quote", revision=None, updated=RELATIVE,
         checked=RELATIVE, payload=True, result=None, **over):
    """Write what ticket 08 will write: a result marker plus a quote payload under the Edition's reference and revision."""
    revision = revision or edition["mapping_revision"]
    ref = edition["public_ref"]
    # Defaults are relative to the wall clock: a provider time a day old and a check ten minutes old (under the 1 h
    # fresh band), so no seeded record ages into another band as the calendar moves.
    updated = ago(timedelta(days=1)) if updated is RELATIVE else updated
    checked = ago(timedelta(minutes=10)) if checked is RELATIVE else checked
    quote = {"attempt": 1, "amount": amount, "currency": "USD", "source": "tcgdex", "card": card_id or edition["source_id"],
             "variant": variant or edition["quote_variant"], "provider_updated_at": updated, **over}
    marker = result if result is not None else {"state": state, "attempt": 1, "checked_at": checked}
    keys = [quote_key(ref, revision), result_key(ref, revision)]
    snapshot = store.read_records(keys, deadline=time.monotonic() + 5)
    changes = {keys[1]: marker}
    if payload:
        changes[keys[0]] = quote
    assert store.compare_and_swap({key: snapshot.records[key].version for key in changes}, changes, deadline=time.monotonic() + 5)


def ui_world(pagers=0):
    """Browser-spec seeding (web/tests/prices.spec.ts): the catalog, as ids. Quotes are seeded by ui_apply."""
    found = world(pagers)
    return {**{key: str(row["id"]) for key, row in found.items() if key != "pagers"}, "pagers": [str(row["id"]) for row in found["pagers"]]}


def ui_apply(commands):
    """Browser-spec commands against the live stack's real record store. {op:'quote', edition, ...seed arguments} writes
    what ticket 08 will write; {op:'sql', statement, edition} runs one UPDATE for the Edition (PostgreSQL state)."""
    store = public_record_store()
    for command in commands:
        with connect() as conn:
            if command["op"] == "sql":
                conn.execute(command["statement"], (command["edition"],))
                continue
            edition = conn.execute("""SELECT e.id,e.public_ref,m.mapping_revision,m.quote_variant,p.source_id FROM catalog_edition e
              JOIN catalog_edition_metadata m ON m.edition_id=e.id JOIN catalog_printing p ON p.id=e.printing_id WHERE e.id=%s""",
                                   (command["edition"],)).fetchone()
        seed(store, edition, **{key: value for key, value in command.items() if key not in ("op", "edition")})


def prices_of(response):
    assert response.status_code == 200, response.text
    return {row["edition_id"]: row for row in response.json()["prices"]}


def test_each_edition_gets_its_own_quote_and_every_other_state_is_labelled_not_zero(store):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, "0.25")
    seed(store, reverse, "0.43", updated=None)
    unknown = uuid4()
    response = post(ids(normal["id"], reverse["id"], plain["id"], unknown, normal["id"]))
    rows = prices_of(response)
    assert [row["edition_id"] for row in response.json()["prices"]] == [str(i) for i in (normal["id"], reverse["id"], plain["id"], unknown)]
    assert response.json()["withheld"] is False
    one = rows[str(normal["id"])]
    assert (one["status"], one["amount"], one["display_amount"], one["stale"], one["age"]) == ("quote", "0.25", "$0.25", False, "known")
    two = rows[str(reverse["id"])]
    assert (two["amount"], two["age"], two["stale"]) == ("0.43", "unknown", None)
    three = rows[str(plain["id"])]
    assert (three["status"], three["reason"], three["amount"]) == ("unavailable", "unspecified_variant", None)
    assert (rows[str(unknown)]["status"], rows[str(unknown)]["reason"]) == ("unavailable", "not_found")
    assert response.headers["cache-control"] == "no-store"


def test_a_quote_without_a_result_marker_or_with_an_evicted_payload_is_not_cached(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, payload=False)  # a quote marker whose payload was evicted
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    assert [(r["status"], r["reason"]) for r in rows.values()] == [("unavailable", "not_cached")] * 2


def test_absent_is_final_and_pending_hides_the_quote_even_when_a_payload_exists(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, result={"state": "absent", "checked_at": ago(timedelta(minutes=10)),
                                 "expires_at": ago(-timedelta(minutes=50))})
    seed(store, reverse, result={"state": "pending"})
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    one = rows[str(normal["id"])]
    assert (one["status"], one["reason"], one["amount"]) == ("unavailable", "confirmed_absent", None)
    assert (rows[str(reverse["id"])]["status"], rows[str(reverse["id"])]["amount"]) == ("pending", None)


def test_a_quote_under_an_old_mapping_revision_is_invisible_after_the_revision_moves(store):
    normal = world()["normal"]
    seed(store, normal)
    assert prices_of(post(ids(normal["id"])))[str(normal["id"])]["status"] == "quote"
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET mapping_revision=mapping_revision+1 WHERE edition_id=%s", (normal["id"],))
    row = prices_of(post(ids(normal["id"])))[str(normal["id"])]
    assert (row["status"], row["reason"], row["amount"]) == ("unavailable", "not_cached", None)
    seed(store, normal, "9.99", revision=normal["mapping_revision"] + 1)
    assert prices_of(post(ids(normal["id"])))[str(normal["id"])]["amount"] == "9.99"


def test_a_postgres_quarantine_hides_the_price_before_any_outbox_delivery(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal)
    seed(store, reverse)
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed' WHERE edition_id=%s", (normal["id"],))
        undelivered = conn.execute("SELECT count(*) AS n FROM catalog_public_outbox WHERE delivered_at IS NULL").fetchone()["n"]
    assert undelivered > 0  # the store never heard about it; PostgreSQL alone decides
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    one = rows[str(normal["id"])]
    assert (one["status"], one["reason"], one["amount"]) == ("unavailable", "quarantined", None)
    assert rows[str(reverse["id"])]["status"] == "quote"


def test_the_store_quarantine_record_is_ignored_postgres_is_authoritative(store):
    from app.public_records import quarantine_key
    normal = world()["normal"]
    seed(store, normal)
    key = quarantine_key(normal["public_ref"])
    version = store.read_records([key], deadline=time.monotonic() + 5).records[key].version
    record = {"edition_ref": normal["public_ref"], "state": "quarantined", "revision": 9, "mapping_revision": normal["mapping_revision"]}
    assert store.compare_and_swap({key: version}, {key: record}, deadline=time.monotonic() + 5)
    assert prices_of(post(ids(normal["id"])))[str(normal["id"])]["status"] == "quote"


def test_unverified_and_unquoted_editions_are_labelled_and_never_read_the_store(store, monkeypatch):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET quote_variant=NULL WHERE edition_id=%s", (normal["id"],))
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='unverified',mapping_reason='no_matching_rule',product_id=NULL,
          quote_variant=NULL,mapping_basis=NULL,matching_activation_id=NULL,auto_closed=false WHERE edition_id=%s""", (reverse["id"],))
    reads = []
    real = prices.quote_states
    monkeypatch.setattr(prices, "quote_states", lambda *a, **k: reads.append(a) or real(*a, **k))
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    assert rows[str(normal["id"])]["reason"] == "no_quote_variant" and rows[str(reverse["id"])]["reason"] == "unverified"
    assert reads == []


def test_quote_candidate_snapshots_never_seed_a_price(store):
    normal = world()["normal"]
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET quote_candidate=%s WHERE edition_id=%s",
                     (json.dumps({"market_price": 9.99, "amount": "9.99", "currency": "USD"}), normal["id"]))
    row = prices_of(post(ids(normal["id"])))[str(normal["id"])]
    assert (row["status"], row["reason"], row["amount"]) == ("unavailable", "not_cached", None)


@pytest.mark.parametrize("amount", ["1e3", "NaN", "-0.01", 0.43, "1234567890123", "0.1234567"])
def test_an_invalid_amount_fails_only_its_own_row(store, amount):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, amount)
    seed(store, reverse, "0.43")
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    one = rows[str(normal["id"])]
    assert (one["status"], one["reason"], one["amount"]) == ("failed", "invalid_quote", None)
    assert rows[str(reverse["id"])]["amount"] == "0.43"


def test_a_quote_for_another_card_or_variant_than_postgres_published_fails_closed(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, card_id="someone-else")
    seed(store, reverse, variant="holofoil")
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    assert {r["reason"] for r in rows.values()} == {"lookup_mismatch"} and {r["status"] for r in rows.values()} == {"failed"}


def test_one_malformed_result_fails_only_its_own_row_not_the_batch(store):
    editions = world()
    normal, reverse, plain = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    seed(store, normal, result={"state": "nonsense"}, payload=False)
    seed(store, reverse)
    rows = prices_of(post(ids(normal["id"], reverse["id"], plain["id"])))
    assert (rows[str(normal["id"])]["status"], rows[str(normal["id"])]["reason"], rows[str(normal["id"])]["amount"]) == \
        ("failed", "invalid_quote", None)
    assert (rows[str(reverse["id"])]["status"], rows[str(reverse["id"])]["amount"]) == ("quote", "0.43")
    assert rows[str(plain["id"])]["reason"] == "unspecified_variant"


def test_a_malformed_quote_payload_fails_only_its_own_row(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal)
    seed(store, reverse)
    key = quote_key(normal["public_ref"], normal["mapping_revision"])
    version = store.read_records([key], deadline=time.monotonic() + 5).records[key].version
    assert store.compare_and_swap({key: version}, {key: ["not", "a", "dict"]}, deadline=time.monotonic() + 5)
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    assert (rows[str(normal["id"])]["status"], rows[str(normal["id"])]["reason"]) == ("failed", "invalid_quote")
    assert rows[str(reverse["id"])]["amount"] == "0.43"


def test_staleness_uses_the_module_clock_and_a_fresh_check_does_not_clear_it(store, monkeypatch):
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
    assert rows[str(reverse["id"])]["stale"] is False


# ------------------------------------------------------------------ the trusted budget


def test_missing_or_forged_budget_metadata_is_401_and_reads_nothing(store, monkeypatch):
    normal = world()["normal"]
    monkeypatch.setattr(prices, "private_edition_quotes", lambda *a, **k: pytest.fail("a price read ran"))
    body = json.dumps(ids(normal["id"]), separators=(",", ":")).encode()
    assert post(None, raw=body, budget=False).status_code == 401
    assert post(None, raw=body, forge="0" * 64).status_code == 401
    assert post(None, raw=body, user=None, budget=True).status_code == 401  # no user headers at all
    assert post(None, raw=body, stamp=int(time.time()) - 31).status_code == 401
    valid = headers_for(body)
    for change in ({"x-internal-budget-ms": "99999"}, {"x-internal-budget-ms": "1"}, {"x-internal-caller": "user:someone-else"},
                   {"x-internal-budget-time": str(int(time.time()) + 1)}):
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


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_an_exhausted_budget_withholds_immediately_without_touching_postgres_or_the_store(store, monkeypatch):
    normal = world()["normal"]
    seed(store, normal)

    def forbidden(*a, **k):
        raise AssertionError("an exhausted budget must not start work")
    monkeypatch.setattr(prices, "quote_states", forbidden)
    monkeypatch.setattr(prices, "_read_targets", forbidden)
    started = time.monotonic()
    response = post(ids(normal["id"]), ms=0)
    assert time.monotonic() - started < 0.5
    assert response.status_code == 200 and response.json()["withheld"] is True
    row = response.json()["prices"][0]
    assert (row["status"], row["reason"], row["amount"]) == ("failed", "deadline", None)


class Hanging(BaseHTTPRequestHandler):
    release = threading.Event()

    def do_POST(self):
        Hanging.release.wait(8)

    def log_message(self, *args):
        pass


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
@pytest.mark.slow(reason='wall-clock: a stalled relay holds the request up to its 3 s budget')
def test_a_relay_that_stalls_cannot_hold_the_answer_past_three_seconds(store, monkeypatch):
    editions = world()
    normal, plain = editions["normal"], editions["unspecified"]
    Hanging.release = threading.Event()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Hanging)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True).start()
    monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "http")
    monkeypatch.setenv("PUBLIC_PROJECTION_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("PUBLIC_PROJECTION_TOKEN", "t")
    try:
        started = time.monotonic()
        response = post(ids(normal["id"], plain["id"]))
        elapsed = time.monotonic() - started
    finally:
        Hanging.release.set()
        server.shutdown()
    assert elapsed < 3.0, elapsed
    rows = prices_of(response)
    assert (rows[str(normal["id"])]["status"], rows[str(normal["id"])]["reason"]) == ("failed", "deadline")
    assert rows[str(plain["id"])]["reason"] == "unspecified_variant"  # the rest of the page is independent
    assert response.json()["withheld"] is True


def test_the_http_adapter_works_from_the_synchronous_route(store, monkeypatch, tmp_path):
    import multiprocessing
    from public_records_fixture import serve_relay
    editions = world()
    normal = editions["normal"]
    config = {"adapter": "filesystem", "directory": str(tmp_path)}
    seed(store, normal, "3.10")
    receive, send = multiprocessing.get_context("spawn").Pipe(False)
    process = multiprocessing.get_context("spawn").Process(target=serve_relay, args=(config, send), daemon=True)
    process.start()
    try:
        port = receive.recv()
        monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "http")
        monkeypatch.setenv("PUBLIC_PROJECTION_URL", f"http://127.0.0.1:{port}")
        monkeypatch.setenv("PUBLIC_PROJECTION_TOKEN", "conformance-secret")
        row = prices_of(post(ids(normal["id"])))[str(normal["id"])]
    finally:
        process.terminate()
        process.join()
    assert (row["status"], row["amount"], row["display_amount"]) == ("quote", "3.10", "$3.10")


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
@pytest.mark.slow(reason='wall-clock: waits out a stalled final validation')
def test_a_stalled_final_validation_withholds_the_quote_inside_the_budget(store, monkeypatch):
    editions = world()
    normal = editions["normal"]
    seed(store, normal)
    locker = psycopg.connect(os.environ["DATABASE_URL"])
    real = prices.public_record_store

    class Locking:
        """An external store that, once it has answered, leaves PostgreSQL unable to answer the final read."""
        def __init__(self, inner):
            self.inner = inner

        def read_all(self, keys, **kwargs):
            answer = self.inner.read_all(keys, **kwargs)
            locker.execute("LOCK TABLE catalog_edition_metadata IN ACCESS EXCLUSIVE MODE")
            return answer

    monkeypatch.setattr(prices, "public_record_store", lambda: Locking(real()))
    try:
        started = time.monotonic()
        response = post(ids(normal["id"]), ms=1500)
        elapsed = time.monotonic() - started
    finally:
        locker.rollback()
        locker.close()
    assert elapsed < 1.5, elapsed
    row = response.json()["prices"][0]
    assert (row["status"], row["reason"], row["amount"], row["display_amount"]) == ("failed", "validation_unavailable", None, None)
    assert response.json()["withheld"] is True


def test_final_validation_drops_a_row_whose_mapping_changed_while_the_store_was_read(store, monkeypatch):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal)
    seed(store, reverse)
    real = prices.public_record_store

    class Racing:
        def __init__(self, inner):
            self.inner = inner

        def read_all(self, keys, **kwargs):
            answer = self.inner.read_all(keys, **kwargs)
            with connect() as conn:
                conn.execute("UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed' WHERE edition_id=%s", (normal["id"],))
                conn.execute("UPDATE catalog_edition_metadata SET mapping_revision=mapping_revision+1 WHERE edition_id=%s", (reverse["id"],))
            return answer

    monkeypatch.setattr(prices, "public_record_store", lambda: Racing(real()))
    rows = prices_of(post(ids(normal["id"], reverse["id"])))
    one, two = rows[str(normal["id"])], rows[str(reverse["id"])]
    assert (one["status"], one["reason"], one["amount"]) == ("unavailable", "quarantined", None)
    assert (two["status"], two["reason"], two["amount"]) == ("unavailable", "not_cached", None)


def test_a_response_that_would_finish_after_the_hard_deadline_is_withheld(store, monkeypatch):
    normal = world()["normal"]
    seed(store, normal)
    real = prices.validate_quote

    def slow(*args, **kwargs):
        time.sleep(0.3)
        return real(*args, **kwargs)
    monkeypatch.setattr(prices, "validate_quote", slow)
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


def test_an_under_one_hour_read_writes_nothing_and_contacts_nothing_but_postgres_and_the_store(store, monkeypatch):
    editions = world()
    normal, plain = editions["normal"], editions["unspecified"]
    seed(store, normal, checked=ago(timedelta(minutes=59)))  # inside the 1 h fresh band: no admission, no write
    tables = ("catalog_edition", "catalog_edition_metadata", "catalog_printing", "catalog_public_outbox", "operations_hour")

    def stamps():
        with connect() as conn:
            return {t: sorted(r["x"] for r in conn.execute(f"SELECT xmin::text||':'||ctid::text AS x FROM {t}")) for t in tables}
    before = stamps()
    key = result_key(normal["public_ref"], normal["mapping_revision"])
    generation = store.read_records([key], deadline=time.monotonic() + 5).generation
    real = socket.socket.connect

    def guarded(self, address):
        if not (isinstance(address, tuple) and address[1] == 5432) and not isinstance(address, str):
            raise AssertionError(f"unexpected network connection {address}")
        return real(self, address)
    monkeypatch.setattr(socket.socket, "connect", guarded)
    assert post(ids(normal["id"], plain["id"])).status_code == 200
    monkeypatch.undo()
    assert stamps() == before  # including operations_hour: the request counter is not written for price reads
    assert store.read_records([key], deadline=time.monotonic() + 5).generation == generation


def test_there_is_no_refresh_or_force_route():
    paths = {path: set(methods) for path, methods in app.openapi()["paths"].items() if path.startswith("/api/prices")}
    assert paths == {PATH: {"post"}}


# ------------------------------------------------------------------ ticket 07: access-triggered refresh
import re  # noqa: E402

from app import price_launcher, quote_contract  # noqa: E402
from app.public_projection import ProjectionUnavailable  # noqa: E402


@pytest.fixture
def launches(monkeypatch):
    calls = []
    monkeypatch.setattr(price_launcher, "spawn", lambda slot, owner: calls.append((slot, owner)) or True)
    return calls


def scheduler(store):
    key = quote_contract.scheduler_key()
    return store.read_records([key], deadline=time.monotonic() + 5).records[key].value


def test_no_api_route_can_refresh_or_force_a_price():
    for path in app.openapi()["paths"]:
        assert not re.search(r"refresh|force|reload|revalidate|max.?age|no.?cache", path, re.I), path
    assert not any(re.search(r"refresh|force", name, re.I) for name in prices.PriceRequest.model_fields)
    for extra in ({"force": True}, {"refresh": True}, {"max_age": 0}, {"no_cache": True}):
        assert post({**ids(uuid4()), **extra}).status_code == 422


def test_cache_control_and_pragma_headers_change_nothing(store, launches):
    normal = world()["normal"]
    seed(store, normal, checked=ago(timedelta(minutes=30)))
    raw = json.dumps(ids(normal["id"]), separators=(",", ":")).encode()
    headers = {**headers_for(raw), "cache-control": "no-cache, max-age=0", "pragma": "no-cache", "x-refresh": "1"}
    row = client.post(PATH, content=raw, headers=headers).json()["prices"][0]
    assert row["refresh"] is None and launches == [] and scheduler(store) is None


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_stale_quote_is_returned_now_and_refreshed_in_the_background(store, launches):
    normal = world()["normal"]
    seed(store, normal, checked=ago(timedelta(minutes=61)))
    started = time.monotonic()
    row = prices_of(post(ids(normal["id"])))[str(normal["id"])]
    assert time.monotonic() - started < 1.5
    assert (row["status"], row["amount"], row["refresh"]) == ("quote", "0.43", "background")
    sched = scheduler(store)
    assert list(sched["jobs"]) == [f"{normal['public_ref']}:{normal['mapping_revision']}"] and sched["interactive"] == {}
    assert len(launches) == 1


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_day_old_quote_waits_for_the_runner_and_returns_the_new_quote(store, launches):
    normal = world()["normal"]
    seed(store, normal, checked=ago(timedelta(hours=25)))

    def runner():
        time.sleep(0.4)
        seed(store, normal, "0.99", checked=ago(timedelta(0)))
    thread = threading.Thread(target=runner)
    thread.start()
    started = time.monotonic()
    row = prices_of(post(ids(normal["id"])))[str(normal["id"])]
    thread.join()
    assert time.monotonic() - started < 2.0
    assert (row["amount"], row["refresh"]) == ("0.99", "refreshed")


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
@pytest.mark.slow(reason='wall-clock: waits out the real 2.5 s wait window')
def test_a_day_old_quote_with_no_runner_times_out_inside_the_budget_and_keeps_the_cache(store, launches):
    normal = world()["normal"]
    checked = ago(timedelta(hours=25))
    seed(store, normal, checked=checked)
    started = time.monotonic()
    response = post(ids(normal["id"]))
    elapsed = time.monotonic() - started
    row = prices_of(response)[str(normal["id"])]
    assert 2.0 < elapsed < 3.0, elapsed
    assert (row["status"], row["amount"], row["refresh"], row["checked_at"]) == ("quote", "0.43", "timeout", checked)
    assert response.json()["withheld"] is False
    assert scheduler(store)["interactive"] == {}      # the permit is released after the response


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_launch_failure_answers_busy_at_once_and_never_errors(store, monkeypatch):
    monkeypatch.setattr(price_launcher, "spawn", lambda slot, owner: False)
    normal = world()["normal"]
    started = time.monotonic()
    row = prices_of(post(ids(normal["id"])))[str(normal["id"])]
    assert time.monotonic() - started < 1.5
    assert (row["status"], row["reason"], row["refresh"]) == ("unavailable", "not_cached", "busy")


def test_an_unavailable_store_during_admission_still_returns_the_cached_quote(store, monkeypatch, launches):
    normal = world()["normal"]
    seed(store, normal, checked=ago(timedelta(minutes=90)))
    real = prices.public_record_store()

    class Flaky:
        def read_all(self, *a, **k):
            return real.read_all(*a, **k)

        def read_records(self, *a, **k):
            return real.read_records(*a, **k)

        def compare_and_swap(self, *a, **k):
            raise ProjectionUnavailable()

        def operation_status(self, *a, **k):
            raise ProjectionUnavailable()
    monkeypatch.setattr(prices, "public_record_store", lambda: Flaky())
    row = prices_of(post(ids(normal["id"])))[str(normal["id"])]
    assert (row["status"], row["amount"], row["refresh"]) == ("quote", "0.43", "busy")


def test_different_users_are_treated_alike(store, launches):
    normal = world()["normal"]
    seed(store, normal, checked=ago(timedelta(minutes=90)))
    rows = [prices_of(post(ids(normal["id"]), user=user))[str(normal["id"])]["refresh"] for user in ("price-reader", "owner")]
    assert rows == ["background", "background"]
