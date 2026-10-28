"""Public price records (ticket P5, ADR 0019 design 4.6): the `price:` writer, its registry, its lock and its callers."""
import threading
import time
from uuid import uuid4

import pytest

from app import price_binding, price_import, public_prices
from app.db import connect
from app.public_prices import publish
from app.public_projection import ProjectionUnavailable
from app.public_records import FilePublicRecords, price_key
from test_price_binding import HOLO, NORMAL, REVERSE, add_editions, do_rebind, stock, world  # noqa: F401  (world is a fixture)
from test_price_import import Tcgcsv, price, product


@pytest.fixture
def store(tmp_path):
    return opened(tmp_path / "store")


def opened(directory):
    """An initialized store (initialization is a deploy step, never part of a publish)."""
    records = FilePublicRecords(directory)
    records.initialize(deadline=time.monotonic() + 10)
    return records


def refs_of(editions):
    with connect() as conn:
        return [conn.execute("SELECT public_ref FROM catalog_edition WHERE id = %s", (e,)).fetchone()["public_ref"]
                for e in editions]


def stored(store, refs):
    snapshot = store.read_all([price_key(r) for r in refs], deadline=time.monotonic() + 10).records
    return {r: snapshot[price_key(r)].value for r in refs}


def versions(store, refs):
    snapshot = store.read_all([price_key(r) for r in refs], deadline=time.monotonic() + 10).records
    return {r: snapshot[price_key(r)].version for r in refs}


def registry():
    with connect() as conn:
        return {r["edition_ref"] for r in conn.execute("SELECT edition_ref FROM public_price_ref")}


def run_publish(store):
    with connect() as conn:
        return publish(conn, store)


def mapping(edition):
    with connect() as conn:
        row = conn.execute("SELECT mapping_revision, product_id FROM catalog_edition_metadata WHERE edition_id = %s",
                           (edition,)).fetchone()
    return row["mapping_revision"], row["product_id"]


def set_price(product_id, sub_type, market):
    with connect() as conn:
        conn.execute("UPDATE tcgplayer_price SET market_price = %s WHERE product_id = %s AND sub_type_name = %s",
                     (market, product_id, sub_type))


@pytest.fixture
def priced(world, store):  # noqa: F811
    """Three priced Editions and one unpriced one, bound and not yet published."""
    stock((10, "Normal", "1.50"), (11, "Holofoil", "20"), (12, "Normal", "0.25"), (13, "Normal", None))
    editions = add_editions(world, [(NORMAL, 10), (HOLO, 11), (NORMAL, 12), (NORMAL, 13)])
    do_rebind()
    return editions, refs_of(editions)


# --- the records -------------------------------------------------------------------------------------------------------


def test_each_priced_edition_gets_exactly_one_record_of_the_allowlisted_shape(priced, store):
    editions, refs = priced
    result = run_publish(store)
    assert (result.written, result.deleted, result.unchanged) == (3, 0, 0)
    values = stored(store, refs)
    revision, product_id = mapping(editions[0])
    assert values[refs[0]] == {"mapping_revision": revision, "product_id": product_id, "amount": "1.5"}
    assert values[refs[1]]["amount"] == "20" and values[refs[2]]["amount"] == "0.25"
    assert values[refs[3]] is None  # a bound Edition with no market price has no record
    assert set(values[refs[0]]) == {"mapping_revision", "product_id", "amount"}
    assert registry() >= set(refs[:3])


def test_a_second_publish_with_no_changes_writes_nothing(priced, store):
    editions, refs = priced
    run_publish(store)
    before = versions(store, refs)
    generation = store.read_all([], deadline=time.monotonic() + 10).generation
    result = run_publish(store)
    assert (result.written, result.deleted, result.unchanged) == (0, 0, 3)
    assert versions(store, refs) == before
    assert store.read_all([], deadline=time.monotonic() + 10).generation == generation


def test_a_changed_price_writes_only_that_record(priced, store):
    editions, refs = priced
    run_publish(store)
    before = versions(store, refs)
    set_price(11, "Holofoil", "21.5")
    result = run_publish(store)
    assert (result.written, result.deleted, result.unchanged) == (1, 0, 2)
    after = versions(store, refs)
    assert [r for r in refs if after[r] != before[r]] == [refs[1]]
    assert stored(store, refs)[refs[1]]["amount"] == "21.5"


def test_an_edition_that_stops_being_priced_has_its_record_and_registry_row_deleted(priced, store):
    editions, refs = priced
    run_publish(store)
    set_price(10, "Normal", None)
    do_rebind()
    result = run_publish(store)
    assert (result.written, result.deleted, result.unchanged) == (0, 1, 2)
    assert stored(store, refs)[refs[0]] is None
    assert refs[0] not in registry()
    assert result == run_publish(store).__class__(0, 1, 2)
    assert run_publish(store).deleted == 0


def test_an_unverified_edition_loses_its_record(priced, store):
    editions, refs = priced
    run_publish(store)
    with connect() as conn:
        from test_price_binding import unverify
        unverify(conn, editions[2])
    do_rebind()
    run_publish(store)
    assert stored(store, refs)[refs[2]] is None


# --- the lock ----------------------------------------------------------------------------------------------------------


class Gate:
    """Wraps a store; the first compare_and_swap announces itself and waits to be released."""

    def __init__(self, inner):
        self.inner, self.reached, self.release, self.calls = inner, threading.Event(), threading.Event(), 0

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def compare_and_swap(self, *args, **kwargs):
        self.calls += 1
        if self.calls == 1:
            self.reached.set()
            assert self.release.wait(30)
        return self.inner.compare_and_swap(*args, **kwargs)


def test_two_publishes_run_one_after_the_other_and_the_second_ends_at_the_newest_price(priced, store):
    editions, refs = priced
    gate = Gate(store)
    order = []

    def first():
        with connect() as conn:
            publish(conn, gate)
        order.append("first")

    def second():
        with connect() as conn:
            publish(conn, store)
        order.append("second")

    one = threading.Thread(target=first)
    one.start()
    assert gate.reached.wait(30)  # the first holds the lock and is about to write its old snapshot
    two = threading.Thread(target=second)
    two.start()
    time.sleep(1)
    assert order == [] and two.is_alive()  # the second waits on the lock
    set_price(10, "Normal", "9.99")  # changes between the two
    gate.release.set()
    one.join(30)
    two.join(30)
    assert order == ["first", "second"]
    assert stored(store, refs)[refs[0]]["amount"] == "9.99"


def test_publish_after_rebind_on_one_connection_neither_deadlocks_nor_blocks(priced, store):
    editions, refs = priced
    with connect() as conn:
        counts = price_binding.rebind(conn)
        assert counts["priced"] == 3
        assert publish(conn, store).written == 3
        assert publish(conn, store).written == 0
    with connect() as conn:  # the session lock was released
        assert conn.execute("SELECT pg_try_advisory_lock(%s) AS got", (price_binding.PRICE_LOCK,)).fetchone()["got"]


def test_the_lock_is_released_when_a_publish_fails(priced, store):
    class Broken:
        def read_all(self, *a, **k):
            raise ProjectionUnavailable()
    with connect() as conn:
        with pytest.raises(ProjectionUnavailable):
            publish(conn, Broken())
        assert conn.execute("SELECT pg_try_advisory_lock(%s) AS got", (price_binding.PRICE_LOCK,)).fetchone()["got"]
        conn.execute("SELECT pg_advisory_unlock(%s)", (price_binding.PRICE_LOCK,))
    assert run_publish(store).written == 3


def test_a_slow_but_progressing_read_across_many_slices_succeeds(priced, store, monkeypatch):
    """Each slice has a fresh deadline: a read whose total time exceeds one deadline still works while every slice is quick."""
    clock = [0.0]
    monkeypatch.setattr(public_prices, "READ_SLICE", 1)
    monkeypatch.setattr(public_prices.time, "monotonic", lambda: clock[0])
    deadlines = []

    class Slow:
        def __getattr__(self, name):
            return getattr(store, name)

        def read_all(self, keys, *, deadline, **rest):
            assert deadline - clock[0] == public_prices.CHUNK_SECONDS  # fresh for this slice
            deadlines.append(deadline)
            clock[0] += public_prices.CHUNK_SECONDS * 0.6  # every slice is slow; all of them together are not in time
            return store.read_all(keys, deadline=time.monotonic() + 10, **rest)

    with connect() as conn:
        assert publish(conn, Slow()).written == 3
    assert len(deadlines) >= 4 and clock[0] > public_prices.CHUNK_SECONDS


# --- crash points ------------------------------------------------------------------------------------------------------


class Crash(Exception):
    pass


def test_a_crash_after_the_registry_insert_and_before_the_cas_reconciles_on_the_next_publish(priced, store, monkeypatch):
    editions, refs = priced
    run_publish(store)  # refs[0..2] stored
    set_price(10, "Normal", None)
    do_rebind()
    with connect() as conn:  # a fourth Edition becomes priced
        conn.execute("UPDATE tcgplayer_price SET market_price = 3 WHERE product_id = 13")
    do_rebind()

    class Crashing:
        def __getattr__(self, name):
            return getattr(store, name)

        def compare_and_swap(self, *a, **k):
            raise Crash()
    with connect() as conn, pytest.raises(Crash):
        publish(conn, Crashing())
    assert refs[3] in registry() and stored(store, refs)[refs[3]] is None  # registered, not yet written
    assert stored(store, refs)[refs[0]] is not None  # the old record is still there
    # now the new Edition stops being priced before the retry: the registry row has no record and no desire
    set_price(13, "Normal", None)
    do_rebind()
    run_publish(store)
    values = stored(store, refs)
    assert values[refs[0]] is None and values[refs[3]] is None and values[refs[1]] and values[refs[2]]
    assert registry() == set(refs[1:3])


def test_a_crash_after_the_cas_delete_and_before_the_registry_delete_reconciles_on_the_next_publish(priced, store, monkeypatch):
    editions, refs = priced
    run_publish(store)
    set_price(10, "Normal", None)
    do_rebind()
    real = public_prices._unregister

    def crash(conn, refs_):
        raise Crash()
    monkeypatch.setattr(public_prices, "_unregister", crash)
    with connect() as conn, pytest.raises(Crash):
        publish(conn, store)
    monkeypatch.setattr(public_prices, "_unregister", real)
    assert stored(store, refs)[refs[0]] is None and refs[0] in registry()  # deleted in the store, still registered
    run_publish(store)
    assert refs[0] not in registry() and registry() == set(refs[1:3])


def test_a_record_left_by_a_crashed_publish_of_an_edition_that_is_no_longer_desired_is_deleted(priced, store):
    editions, refs = priced
    run_publish(store)
    with connect() as conn:  # lose the binding rows altogether: nothing is desired any more
        conn.execute("DELETE FROM edition_price_binding")
    result = run_publish(store)
    assert result.deleted == 3 and all(v is None for v in stored(store, refs).values()) and registry() == set()


# --- callers -----------------------------------------------------------------------------------------------------------


def test_a_store_failure_sets_public_error_on_the_import_row_and_never_fails_the_import(world, monkeypatch):  # noqa: F811
    monkeypatch.setattr(price_import, "sleep", lambda seconds: None)

    def boom(conn, store=None):
        raise ProjectionUnavailable()
    monkeypatch.setattr(public_prices, "publish", boom)
    fake = Tcgcsv()
    fake.products = {1: [product(101, "A", "1")], 2: []}
    fake.prices = {1: [price(101, "Normal", 2.5)], 2: []}
    add_editions(world, [(NORMAL, 101)])
    with connect(autocommit=True) as conn:
        result = price_import.run(conn, fake.client())
        row = conn.execute("SELECT * FROM price_import ORDER BY id DESC LIMIT 1").fetchone()
    assert result.outcome == "imported" and result.exit_code == 0
    assert row["outcome"] == "imported" and row["public_error"] == "ProjectionUnavailable" and row["priced_editions"] == 1


def test_an_import_publishes_the_new_prices(world, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path / "projection"))
    projection = opened(tmp_path / "projection")
    monkeypatch.setattr(price_import, "sleep", lambda seconds: None)
    fake = Tcgcsv()
    fake.products = {1: [product(101, "A", "1")], 2: []}
    fake.prices = {1: [price(101, "Normal", 2.5)], 2: []}
    edition, = add_editions(world, [(NORMAL, 101)])
    with connect(autocommit=True) as conn:
        price_import.run(conn, fake.client())
        row = conn.execute("SELECT public_error FROM price_import ORDER BY id DESC LIMIT 1").fetchone()
    assert row["public_error"] is None
    ref, = refs_of([edition])
    assert stored(projection, [ref])[ref]["amount"] == "2.5"


def test_rebind_only_also_publishes(world, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path / "projection"))
    projection = opened(tmp_path / "projection")
    stock((10, "Normal", 1))
    edition, = add_editions(world, [(NORMAL, 10)])
    assert price_import.main(["--rebind-only"]) == 0
    ref, = refs_of([edition])
    assert stored(projection, [ref])[ref]["amount"] == "1"


def test_rebind_only_exits_non_zero_when_the_publish_fails(world, monkeypatch):  # noqa: F811
    monkeypatch.setattr(public_prices, "publish", lambda conn, store=None: (_ for _ in ()).throw(ProjectionUnavailable()))
    assert price_import.main(["--rebind-only"]) != 0


def test_the_post_commit_step_publishes_and_a_publish_failure_keeps_the_rebind_counts(world, tmp_path, monkeypatch, caplog):  # noqa: F811
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path / "projection"))
    projection = opened(tmp_path / "projection")
    stock((10, "Normal", 1))
    edition, = add_editions(world, [(NORMAL, 10)])
    with connect() as conn:
        counts = price_binding.rebind_best_effort(conn)
    ref, = refs_of([edition])
    assert counts["priced"] == 1 and stored(projection, [ref])[ref]["amount"] == "1"
    monkeypatch.setattr(public_prices, "publish", lambda conn, store=None: (_ for _ in ()).throw(ProjectionUnavailable()))
    assert price_binding.rebind_best_effort()["priced"] == 1
    assert "Price publish failed (ProjectionUnavailable)" in caplog.text


# --- capacity ----------------------------------------------------------------------------------------------------------


@pytest.mark.slow(reason="capacity: 40,000 priced Editions on the filesystem adapter")
@pytest.mark.serial(reason="an upper bound on elapsed time")
def test_a_first_publish_of_40000_records_finishes_inside_5_minutes(world, store):  # noqa: F811
    count = 40_000
    with connect() as conn, conn.transaction():
        conn.execute("""CREATE TEMP TABLE cap ON COMMIT DROP AS SELECT n, gen_random_uuid() AS identity_id,
          gen_random_uuid() AS printing_id, gen_random_uuid() AS edition_id FROM generate_series(1,%s) n""", (count,))
        conn.execute("INSERT INTO catalog_identity(id,identity_key,display_name) SELECT identity_id,'cap-'||identity_id,'Cap '||n FROM cap")
        conn.execute("INSERT INTO catalog_printing(id,source,source_id,identity_id) SELECT printing_id,'tcgdex','cap-'||printing_id,identity_id FROM cap")
        conn.execute("""INSERT INTO catalog_edition(id,printing_id,descriptor_key,descriptor)
          SELECT edition_id,printing_id,'normal','{"type":"normal"}'::jsonb FROM cap""")
        conn.execute("""UPDATE catalog_edition_metadata m SET mapping_state='verified',mapping_reason=NULL,product_id=1000+c.n,
          mapping_basis='matching_rule',matching_activation_id=%s,auto_closed=true,mapping_revision=mapping_revision+1
          FROM cap c WHERE m.edition_id=c.edition_id""", (world["activation"],))
        conn.execute("""INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,seen_at,source_updated_at)
          SELECT 1000+n,'Normal',1.5,now(),now() FROM cap""")
    assert do_rebind()["priced"] == count
    started = time.monotonic()
    result = run_publish(store)
    first = time.monotonic() - started
    started = time.monotonic()
    again = run_publish(store)
    print(f"capacity: first publish of {count} records {first:.1f}s, repeat {time.monotonic() - started:.1f}s")
    assert result.written == count and again.written == 0 and again.unchanged == count
    assert first < 300
