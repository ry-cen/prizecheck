"""Seeding the price cache with the records a successful runner check writes (ADR 0013). The catalog import no longer calls it
(ADR 0019); these tests call it after the import, until P9 removes the module."""
import copy
import json
import time
from datetime import timedelta

import pytest

from app import price_seed, quote_contract
from app.catalog_targets import MATCHING
from app.main import connect
from app.public_catalog import marketplace_states
from app.public_projection import ProjectionUnavailable
from app.public_records import catalog_edition_key, fence_key, public_record_store, quote_key, result_key
from test_catalog import reset_catalog
from test_catalog_metadata import Records, furret
from test_catalog_reconciliation import run as import_run
from test_catalog_targets import activate, card, isolated_rules  # noqa: F401  (isolated_rules is autouse)
from test_prices import ago, seed_quote as seed, world

PRICE_VIEW_KEYS = ("id", "pricing", "variants_detailed")


def price_view(record):
    return {key: record[key] for key in PRICE_VIEW_KEYS if key in record} if isinstance(record, dict) else None


def run(source):
    """The import, then the seeding the import used to do after its commit."""
    run_id = import_run(source)
    views = getattr(source, "price_views", None)
    if views:
        with connect() as conn:
            price_seed.seed_from_import(conn, run_id, dict(views))
    return run_id


PROVIDER_TIME = "2026-10-07T22:55:02Z"   # card(1)'s TCGplayer "updated"


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "filesystem")
    public_record_store().initialize(deadline=time.monotonic() + 5)
    return public_record_store()


def plain():
    """world()'s second Printing: an Unspecified Variant, never priced."""
    record = furret(id="meta-2", localId="2")
    del record["variants_detailed"]
    record["variants"] = {}
    return record


def exact(record):
    """The price view TCGdexSource.fetch keeps: the card parsed again with exact decimal text."""
    return price_view(json.loads(json.dumps(record), parse_float=str))


class PricedRecords(Records):
    """Like TCGdexSource: each fetch also keeps the card's exact-text price view and when it arrived."""

    def __init__(self, *records, views=None):
        super().__init__(*records)
        self.views = views or {}
        self.price_views = {}

    def fetch(self, source_id):
        record = super().fetch(source_id)
        view = self.views.get(source_id) or exact(record)
        self.price_views[source_id] = (copy.deepcopy(view), quote_contract.wall_ms())
        return record


def cached(store, edition):
    """(result, quote, fence) stored for the Edition's current revision."""
    ref, revision = edition["public_ref"], edition["mapping_revision"]
    keys = [result_key(ref, revision), quote_key(ref, revision), fence_key(ref, revision)]
    records = store.read_records(keys, deadline=time.monotonic() + 5).records
    return tuple(records[key].value for key in keys)


def iso_ms(text):
    return price_seed._checked_ms(text)


def active_generation():
    with connect() as conn:
        return conn.execute("SELECT active_generation FROM catalog_state WHERE singleton").fetchone()["active_generation"]


def run_outcome(run_id):
    with connect() as conn:
        return conn.execute("SELECT outcome FROM catalog_run WHERE id=%s", (run_id,)).fetchone()["outcome"]


def test_an_import_seeds_each_verified_edition_with_the_records_a_runner_check_writes(store):
    editions = world()
    normal, reverse, unspecified = editions["normal"], editions["reverse-holofoil"], editions["unspecified"]
    before = quote_contract.wall_ms()
    run(PricedRecords(card(1), plain()))
    after = quote_contract.wall_ms()
    for edition, amount in ((normal, "0.25"), (reverse, "0.43")):
        result, quote, fence = cached(store, edition)
        assert result["state"] == "quote" and result["attempt"] == 1 and set(result) == {"state", "attempt", "checked_at"}
        assert before <= iso_ms(result["checked_at"]) <= after
        assert quote == {"attempt": 1, "amount": amount, "currency": "USD", "source": "tcgdex", "card": "meta-1",
                         "variant": edition["quote_variant"], "provider_updated_at": PROVIDER_TIME}
        assert fence == {"v": 1, "attempt": 1}
    assert cached(store, unspecified) == (None, None, None)
    states = marketplace_states(store, [normal["public_ref"]], time.monotonic() + 5)
    assert states[normal["public_ref"]].quote.status == "quote"


def test_an_unverified_edition_gets_nothing(store):
    reset_catalog()  # No matching rule is active, so nothing is verified.
    run_id = run(PricedRecords(card(1), plain()))
    assert run_outcome(run_id) == "succeeded"
    with connect() as conn:
        rows = conn.execute("""SELECT e.public_ref,m.mapping_revision,m.mapping_state FROM catalog_edition e
          JOIN catalog_edition_metadata m ON m.edition_id=e.id""").fetchall()
    assert rows and all(row["mapping_state"] != "verified" for row in rows)
    for row in rows:
        assert cached(store, row) == (None, None, None)


def test_a_newer_cached_check_is_kept(store, monkeypatch):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "9.99", checked=ago(timedelta(minutes=10)))
    real, fetched = quote_contract.wall_ms, quote_contract.wall_ms() - 2 * 3_600_000
    monkeypatch.setattr(quote_contract, "wall_ms", lambda: fetched)  # the import received the cards two hours ago
    run(PricedRecords(card(1), plain()))
    monkeypatch.setattr(quote_contract, "wall_ms", real)
    result, quote, _ = cached(store, normal)
    assert quote["amount"] == "9.99" and result["attempt"] == 1
    result, quote, fence = cached(store, reverse)
    assert iso_ms(result["checked_at"]) == fetched and quote["amount"] == "0.43" and fence == {"v": 1, "attempt": 1}


def test_an_older_check_and_an_older_absence_are_superseded(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    seed(store, normal, "9.99", checked=ago(timedelta(hours=3)))
    seed(store, reverse, payload=False, result={"state": "absent", "attempt": 1, "checked_at": ago(timedelta(hours=3)),
                                                "expires_at": ago(timedelta(hours=2))})
    run(PricedRecords(card(1), plain()))
    for edition, amount in ((normal, "0.25"), (reverse, "0.43")):
        result, quote, fence = cached(store, edition)
        assert (result["state"], result["attempt"], quote["attempt"], quote["amount"]) == ("quote", 2, 2, amount)
        assert fence == {"v": 1, "attempt": 2}


def test_a_queued_refresh_or_an_unreadable_result_is_left_alone(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    ref, revision = normal["public_ref"], normal["mapping_revision"]
    work = quote_contract.work_record_key(ref, revision)
    version = store.read_records([work], deadline=time.monotonic() + 5).records[work].version
    assert store.compare_and_swap({work: version}, {work: quote_contract.new_work(
        ref, revision, "meta-1", "normal", "1001", "user:reader", quote_contract.wall_ms())}, deadline=time.monotonic() + 5)
    seed(store, reverse, payload=False, result={"state": "pending", "attempt": 1})
    run(PricedRecords(card(1), plain()))
    assert cached(store, normal) == (None, None, None)
    assert cached(store, reverse) == ({"state": "pending", "attempt": 1}, None, None)


def test_a_card_without_a_price_records_no_absence(store):
    editions = world()
    unpriced = card(1)
    unpriced["variants_detailed"][0]["pricing"]["tcgplayer"]["normal"]["marketPrice"] = None
    run(PricedRecords(unpriced, plain()))
    assert cached(store, editions["normal"]) == (None, None, None)
    assert cached(store, editions["reverse-holofoil"])[1]["amount"] == "0.43"


@pytest.mark.parametrize("amount", ["1e3", "-0.25", "1234567890123", "0.1234567", "NaN", " 0.25"])
def test_an_invalid_amount_skips_only_its_own_edition(store, amount):
    editions = world()
    view = exact(card(1))
    view["variants_detailed"][0]["pricing"]["tcgplayer"]["normal"]["marketPrice"] = amount
    run(PricedRecords(card(1), plain(), views={"meta-1": view}))
    assert cached(store, editions["normal"]) == (None, None, None)
    assert cached(store, editions["reverse-holofoil"])[1]["amount"] == "0.43"


def put(store, key, value):
    version = store.read_records([key], deadline=time.monotonic() + 5).records[key].version
    assert store.compare_and_swap({key: version}, {key: value}, deadline=time.monotonic() + 5)


def run_seed(store):
    with connect() as conn:
        return price_seed.seed_from_import(conn, active_generation(), {"meta-1": (exact(card(1)), quote_contract.wall_ms())},
                                           store=store)


def admit(store, edition, **over):
    ref, revision = edition["public_ref"], edition["mapping_revision"]
    work = {**quote_contract.new_work(ref, revision, "meta-1", "normal", "1001", "user:reader", quote_contract.wall_ms()),
            **over}
    put(store, quote_contract.work_record_key(ref, revision), work)


def test_an_expired_queued_work_record_does_not_block_seeding(store):
    editions = world()
    normal = editions["normal"]
    old = quote_contract.wall_ms() - 120_000  # one clock read: the record needs expires_ms == admitted_ms + JOB_TTL_MS
    admit(store, normal, admitted_ms=old, expires_ms=old + quote_contract.JOB_TTL_MS)
    outcome = run_seed(store)
    assert (outcome.seeded, outcome.skipped) == (2, {})
    assert cached(store, normal)[1]["amount"] == "0.25"


def test_a_running_or_unexpired_work_record_is_left_alone(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    old = quote_contract.wall_ms() - 120_000
    admit(store, normal, state="running", attempt=1, slot=0, owner="a" * 32, admitted_ms=old,
          expires_ms=old + quote_contract.JOB_TTL_MS)  # past its expiry but running
    admit(store, reverse)
    outcome = run_seed(store)
    assert (outcome.seeded, outcome.skipped) == (0, {"in_flight": 2})
    assert cached(store, normal) == (None, None, None) and cached(store, reverse) == (None, None, None)


def test_an_invalid_work_record_is_skipped_as_unreadable(store):
    editions = world()
    normal = editions["normal"]
    admit(store, normal, state="bogus")
    outcome = run_seed(store)
    assert (outcome.seeded, outcome.skipped) == (1, {"unreadable_work": 1})
    assert cached(store, normal) == (None, None, None)


def test_catalog_records_that_disagree_with_postgresql_are_ineligible(store):
    editions = world()
    normal = editions["normal"]
    key = catalog_edition_key(normal["public_ref"])
    record = copy.deepcopy(store.read_records([key], deadline=time.monotonic() + 5).records[key].value)
    record["marketplace"]["product_id"] = record["marketplace"]["product_id"] + 1
    put(store, key, record)
    outcome = run_seed(store)
    assert (outcome.seeded, outcome.skipped) == (1, {"ineligible": 1})
    assert cached(store, normal) == (None, None, None)


@pytest.mark.parametrize("fence", [True, ["attempt"], {"v": 1}])
def test_an_unreadable_fence_is_left_alone(store, fence):
    editions = world()
    normal = editions["normal"]
    put(store, fence_key(normal["public_ref"], normal["mapping_revision"]), fence)
    outcome = run_seed(store)
    assert (outcome.seeded, outcome.skipped) == (1, {"unreadable_fence": 1})
    assert cached(store, normal)[:2] == (None, None)


class Down:
    def read_records(self, *args, **kwargs):
        raise ProjectionUnavailable()

    def compare_and_swap(self, *args, **kwargs):
        raise ProjectionUnavailable()

    def operation_status(self, *args, **kwargs):
        raise ProjectionUnavailable()


def test_a_store_outage_never_fails_the_import(store, monkeypatch):
    editions = world()
    monkeypatch.setattr(price_seed, "public_record_store", lambda: Down())
    run_id = run(PricedRecords(card(1), plain()))
    assert run_outcome(run_id) == "succeeded" and active_generation() == run_id
    assert cached(store, editions["normal"]) == (None, None, None)
    with connect() as conn:
        outcome = price_seed.seed_from_import(conn, run_id, {"meta-1": (exact(card(1)), quote_contract.wall_ms())},
                                              store=Down())
    assert (outcome.seeded, outcome.stopped) == (0, "store_unavailable")


def test_an_unexpected_seeding_error_never_fails_the_import(store, monkeypatch):
    world()

    def broken(*args):
        raise RuntimeError("boom")
    monkeypatch.setattr(price_seed, "_candidates", broken)
    run_id = run(PricedRecords(card(1), plain()))
    assert run_outcome(run_id) == "succeeded" and active_generation() == run_id
    with connect() as conn:
        assert price_seed.seed_from_import(conn, run_id, {"meta-1": (exact(card(1)), 0)}).stopped == "error"


class Interleaved:
    """Lets a runner's newer check land between the seed's read and its CAS."""

    def __init__(self, inner, edition):
        self.inner, self.edition, self.fired = inner, edition, False

    def read_records(self, keys, **kwargs):
        return self.inner.read_records(keys, **kwargs)

    def compare_and_swap(self, expected, changes, **kwargs):
        if not self.fired:
            self.fired = True
            seed(self.inner, self.edition, "7.77", checked=ago(timedelta(minutes=10)))
        return self.inner.compare_and_swap(expected, changes, **kwargs)

    def operation_status(self, operation_id, **kwargs):
        return self.inner.operation_status(operation_id, **kwargs)


def test_a_runner_check_that_lands_between_the_read_and_the_cas_wins(store):
    editions = world()
    normal, reverse = editions["normal"], editions["reverse-holofoil"]
    fetched = quote_contract.wall_ms() - 3_600_000
    with connect() as conn:
        outcome = price_seed.seed_from_import(conn, active_generation(), {"meta-1": (exact(card(1)), fetched)},
                                              store=Interleaved(store, normal))
    assert (outcome.seeded, outcome.skipped, outcome.stopped) == (1, {"newer_check": 1}, None)
    assert cached(store, normal)[1]["amount"] == "7.77"
    result, quote, _ = cached(store, reverse)
    assert iso_ms(result["checked_at"]) == fetched and quote["amount"] == "0.43"


def test_seeding_changes_no_import_identity(store):
    world()

    def snapshot():
        with connect() as conn:
            editions = conn.execute("""SELECT e.id,e.public_ref,m.mapping_state,m.mapping_revision,m.public_revision,
              m.product_id,m.quote_variant,m.mapping_candidate,m.quote_candidate FROM catalog_edition e
              JOIN catalog_edition_metadata m ON m.edition_id=e.id ORDER BY e.id""").fetchall()
            printings = conn.execute("""SELECT gp.printing_id,gp.source_fingerprint FROM catalog_generation_printing gp
              JOIN catalog_state s ON s.singleton AND gp.generation_id=s.active_generation ORDER BY gp.printing_id""").fetchall()
            raw = conn.execute("""SELECT g.raw_sha256 FROM catalog_generation g JOIN catalog_state s
              ON s.singleton AND g.id=s.active_generation""").fetchone()
        return editions, printings, raw

    run(Records(card(1), plain()))
    unseeded = snapshot()
    run(PricedRecords(card(1), plain()))
    assert snapshot() == unseeded
