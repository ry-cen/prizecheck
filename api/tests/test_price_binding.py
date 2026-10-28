"""Price binding (ticket P3, ADR 0019 design 4.3): sub_type_for, rebind, its callers and its capacity."""
import json
import time
from uuid import uuid4

import pytest

from app import catalog, price_binding, price_import
from app.catalog_targets import MATCHING, activate_rule
from app.db import connect
from app.price_binding import rebind, sub_type_for
from test_catalog import reset_catalog
from test_price_import import T1, Tcgcsv, price, product

HOLO, NORMAL, REVERSE = {"type": "holo"}, {"type": "normal"}, {"type": "reverse"}


def offered(*names):
    return frozenset(names)


# --- sub_type_for ------------------------------------------------------------------------------------------------------

CASES = [
    ({"type": "holo", "stamp": ["1st-edition"]}, {"Unlimited Holofoil", "1st Edition Holofoil"}, ("1st Edition Holofoil", None)),
    ({"type": "holo", "subtype": "shadowless"}, {"Unlimited Holofoil", "1st Edition Holofoil"}, ("Unlimited Holofoil", None)),
    ({"type": "holo", "subtype": "shadowless", "stamp": ["1st-edition"], "thirdParty": {"tcgplayer": 1}},
     {"Unlimited Holofoil", "1st Edition Holofoil"}, ("1st Edition Holofoil", None)),
    (HOLO, {"Holofoil"}, ("Holofoil", None)),
    (NORMAL, {"Normal", "Reverse Holofoil"}, ("Normal", None)),
    (REVERSE, {"Normal", "Reverse Holofoil"}, ("Reverse Holofoil", None)),
    (NORMAL, {"1st Edition", "Unlimited"}, ("Unlimited", None)),
    ({"type": "normal", "stamp": ["1st-edition"]}, {"1st Edition", "Unlimited"}, ("1st Edition", None)),
    ({"type": "normal", "size": "jumbo"}, {"Normal"}, (None, "uncovered_variant")),
    ({"label": "Unspecified Variant"}, {"Normal"}, (None, "unspecified_variant")),
    (NORMAL, set(), (None, "no_product_rows")),
    (NORMAL, {"Holofoil"}, ("Holofoil", None)),
    ({"type": "normal", "stamp": ["staff"]}, {"Holofoil"}, (None, "uncovered_variant")),
    ({"type": "holo", "stamp": ["1st-edition"]}, {"Holofoil"}, (None, "uncovered_variant")),
    ({"type": "normal", "foil": "cosmos"}, {"Holofoil"}, (None, "uncovered_variant")),
    ({"type": "holo"}, {"Holofoil", "Unlimited Holofoil"}, (None, "ambiguous")),
    ({"finish": "reverse"}, {"Reverse Holofoil"}, ("Reverse Holofoil", None)),
    ("not a descriptor", {"Normal"}, (None, "unspecified_variant")),
    ({"type": "reverse", "stamp": ["1st-edition"]}, {"Reverse Holofoil"}, (None, "uncovered_variant")),
    ({}, {"Normal"}, (None, "uncovered_variant")),
]


@pytest.mark.parametrize("descriptor,names,expected", CASES)
def test_sub_type_for(descriptor, names, expected):
    assert sub_type_for(descriptor, frozenset(names)) == expected


# --- fixtures ----------------------------------------------------------------------------------------------------------


@pytest.fixture
def world():
    """A clean catalog and price store with one matching-rule activation that verified Editions can point at."""
    reset_catalog()
    owner = f"owner-{uuid4()}"
    with connect() as conn:
        conn.execute("TRUNCATE tcgplayer_product, tcgplayer_price, price_import RESTART IDENTITY")
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
        activation = conn.execute("""INSERT INTO catalog_rule_activation(kind,reviewer_id,evidence_url,reason,clock_revision)
          VALUES ('marketplace_matching',%s,'https://example.org/rule','Fixture activation',1) RETURNING id""",
                                  (owner,)).fetchone()["id"]
    yield {"activation": activation, "owner": owner}
    with connect() as conn:
        conn.execute("TRUNCATE tcgplayer_product, tcgplayer_price, price_import RESTART IDENTITY")


def add_editions(world, specs, verified=True):
    """specs: [(descriptor, product_id)]. One Printing per call; returns the Edition ids in order."""
    with connect() as conn, conn.transaction():
        identity, printing = uuid4(), uuid4()
        conn.execute("INSERT INTO catalog_identity(id,identity_key,display_name) VALUES (%s,%s,'Card')", (identity, f"k-{identity}"))
        conn.execute("INSERT INTO catalog_printing(id,source,source_id,identity_id) VALUES (%s,'tcgdex',%s,%s)",
                     (printing, f"p-{printing}", identity))
        ids = []
        for descriptor, product_id in specs:
            edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,%s,%s) RETURNING id",
                                   (printing, f"d-{uuid4()}", json.dumps(descriptor))).fetchone()["id"]
            ids.append(edition)
            if verified:
                verify(conn, world, edition, product_id)
    return ids


def verify(conn, world, edition, product_id):
    conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='verified',mapping_reason=NULL,product_id=%s,
      mapping_basis='matching_rule',matching_activation_id=%s,auto_closed=true,mapping_revision=mapping_revision+1
      WHERE edition_id=%s""", (product_id, world["activation"], edition))


def unverify(conn, edition):
    conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='unverified',mapping_reason=NULL,product_id=NULL,
      quote_variant=NULL,mapping_basis=NULL,matching_activation_id=NULL,auto_closed=false,mapping_revision=mapping_revision+1
      WHERE edition_id=%s""", (edition,))


def stock(*rows):
    """rows: (product_id, sub_type_name, market_price)."""
    with connect() as conn:
        for product_id, sub, market in rows:
            conn.execute("""INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,seen_at,source_updated_at)
              VALUES (%s,%s,%s,now(),now())""", (product_id, sub, market))


def bindings():
    with connect() as conn:
        return {r["edition_id"]: (r["product_id"], r["sub_type_name"], r["reason"])
                for r in conn.execute("SELECT * FROM edition_price_binding")}


def do_rebind():
    with connect() as conn:
        return rebind(conn)


# --- rebind ------------------------------------------------------------------------------------------------------------


def test_a_verified_edition_is_bound_to_its_subtype(world):
    stock((10, "Normal", 1), (10, "Reverse Holofoil", 2), (11, "Holofoil", 5))
    normal, reverse, holo = add_editions(world, [(NORMAL, 10), (REVERSE, 10), (HOLO, 11)])
    counts = do_rebind()
    assert bindings() == {normal: (10, "Normal", None), reverse: (10, "Reverse Holofoil", None), holo: (11, "Holofoil", None)}
    assert (counts["verified"], counts["bound"], counts["priced"]) == (3, 3, 3)


def test_an_unverified_edition_has_no_binding(world):
    stock((10, "Normal", 1))
    add_editions(world, [(NORMAL, 10)], verified=False)
    assert do_rebind()["verified"] == 0 and bindings() == {}


def test_unbound_reasons_are_stored_and_counted(world):
    stock((10, "Normal", 1))
    jumbo, none = add_editions(world, [({"type": "normal", "size": "jumbo"}, 10), (NORMAL, 99)])
    counts = do_rebind()
    assert bindings() == {jumbo: (10, None, "uncovered_variant"), none: (99, None, "no_product_rows")}
    assert (counts["uncovered_variant"], counts["no_product_rows"], counts["bound"]) == (1, 1, 0)


def test_a_bound_edition_with_no_market_price_is_bound_but_not_priced(world):
    stock((10, "Normal", None), (11, "Normal", 0))
    add_editions(world, [(NORMAL, 10)]); add_editions(world, [(NORMAL, 11)])
    counts = do_rebind()
    assert (counts["bound"], counts["priced"]) == (2, 0)


def test_two_editions_resolving_to_one_product_subtype_are_both_unbound(world):
    stock((10, "Normal", 1))
    one, two = add_editions(world, [(NORMAL, 10), ({"type": "normal", "size": "standard"}, 10)])
    counts = do_rebind()
    assert bindings() == {one: (10, None, "shared_price"), two: (10, None, "shared_price")} and counts["shared_price"] == 2


def test_a_staff_edition_on_its_own_product_binds(world):
    stock((10, "Normal", 1), (20, "Normal", 9))
    plain, staff = add_editions(world, [(NORMAL, 10), ({"type": "normal", "stamp": ["staff"]}, 20)])
    do_rebind()
    assert bindings() == {plain: (10, "Normal", None), staff: (20, "Normal", None)}


def test_a_staff_edition_sharing_the_unstamped_product_is_shared_price(world):
    stock((10, "Normal", 1), (10, "Reverse Holofoil", 2))
    plain, staff = add_editions(world, [(REVERSE, 10), ({"type": "normal", "stamp": ["staff"]}, 10)])
    do_rebind()
    assert bindings()[staff] == (10, None, "shared_price")
    assert bindings()[plain] == (10, "Reverse Holofoil", None)  # only the staff copy is held back when the subtypes differ


def test_a_foil_edition_sharing_a_product_with_the_same_subtype_unbinds_both(world):
    stock((10, "Holofoil", 1))
    plain, foil = add_editions(world, [(HOLO, 10), ({"type": "holo", "foil": "cosmos"}, 10)])
    do_rebind()
    assert bindings() == {plain: (10, None, "shared_price"), foil: (10, None, "shared_price")}


def test_verifying_a_second_edition_onto_a_bound_product_unbinds_both_after_the_rebind(world):
    stock((10, "Normal", 1))
    first, = add_editions(world, [(NORMAL, 10)])
    do_rebind()
    assert bindings()[first] == (10, "Normal", None)
    second, = add_editions(world, [(NORMAL, 10)])
    do_rebind()
    assert bindings() == {first: (10, None, "shared_price"), second: (10, None, "shared_price")}


def test_an_edition_that_stops_being_verified_loses_its_binding(world):
    stock((10, "Normal", 1))
    first, = add_editions(world, [(NORMAL, 10)])
    do_rebind()
    with connect() as conn:
        unverify(conn, first)
    do_rebind()
    assert bindings() == {}


def test_a_product_change_while_verified_rebinds_to_the_new_product(world):
    stock((10, "Normal", 1), (11, "Holofoil", 3))
    edition, = add_editions(world, [(NORMAL, 10)])
    do_rebind()
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET product_id=11 WHERE edition_id=%s", (edition,))
    do_rebind()
    assert bindings() == {edition: (11, "Holofoil", None)}


def test_a_second_rebind_changes_nothing(world):
    stock((10, "Normal", 1))
    add_editions(world, [(NORMAL, 10)])
    do_rebind()
    with connect() as conn:
        before = conn.execute("SELECT edition_id, bound_at FROM edition_price_binding").fetchall()
    do_rebind()
    with connect() as conn:
        assert conn.execute("SELECT edition_id, bound_at FROM edition_price_binding").fetchall() == before


# --- callers -----------------------------------------------------------------------------------------------------------


def test_the_post_commit_step_of_a_promotion_binds_the_new_verified_editions(world):
    stock((10, "Normal", 1))
    edition, = add_editions(world, [(NORMAL, 10)])
    catalog._publish_after_commit(connect(), uuid4(), object())
    assert bindings() == {edition: (10, "Normal", None)}


def test_a_rebind_failure_is_logged_and_never_fails_the_post_commit_step(world, monkeypatch, caplog):
    add_editions(world, [(NORMAL, 10)])

    def boom(conn):
        raise RuntimeError("secret detail")
    monkeypatch.setattr(price_binding, "rebind", boom)
    catalog._publish_after_commit(connect(), uuid4(), object())
    assert "Price rebind failed (RuntimeError)" in caplog.text and "secret detail" not in caplog.text
    assert bindings() == {}


def test_a_failing_rebind_never_fails_the_import_and_leaves_the_counts_empty(world, monkeypatch):
    def boom(conn):
        raise RuntimeError("no")
    monkeypatch.setattr(price_binding, "rebind", boom)
    monkeypatch.setattr(price_import, "sleep", lambda seconds: None)
    with connect(autocommit=True) as conn:
        result = price_import.run(conn, Tcgcsv().client())
        row = conn.execute("SELECT * FROM price_import ORDER BY id DESC LIMIT 1").fetchone()
    assert result.outcome == "imported" and row["verified_editions"] is None and row["unpriced"] == {}


def test_the_import_records_verified_priced_and_unpriced_by_reason(world, monkeypatch):
    monkeypatch.setattr(price_import, "sleep", lambda seconds: None)
    fake = Tcgcsv()
    fake.products = {1: [product(101, "A", "1"), product(102, "B", "2"), product(103, "C", "3")], 2: []}
    fake.prices = {1: [price(101, "Normal", 2.5), price(102, "Normal", None), price(103, "Normal", 1)], 2: []}
    add_editions(world, [(NORMAL, 101)]); add_editions(world, [(NORMAL, 102)])
    add_editions(world, [({"type": "normal", "size": "jumbo"}, 103)]); add_editions(world, [(NORMAL, 999)])
    with connect(autocommit=True) as conn:
        price_import.run(conn, fake.client())
        row = conn.execute("SELECT * FROM price_import ORDER BY id DESC LIMIT 1").fetchone()
    assert (row["verified_editions"], row["priced_editions"]) == (4, 1)
    assert row["unpriced"] == {"no_product_rows": 1, "uncovered_variant": 1, "no_price": 1}


def test_rebind_only_binds_without_fetching(world, monkeypatch):
    stock((10, "Normal", 1))
    edition, = add_editions(world, [(NORMAL, 10)])
    monkeypatch.setenv("DATABASE_URL", __import__("os").environ["DATABASE_URL"])
    monkeypatch.setattr(price_import, "make_client", lambda *a, **k: pytest.fail("rebind-only must not fetch"))
    assert price_import.main(["--rebind-only"]) == 0
    assert bindings() == {edition: (10, "Normal", None)}
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM price_import").fetchone()["n"] == 0


# --- capacity ----------------------------------------------------------------------------------------------------------


@pytest.mark.slow(reason="capacity: 40,000 verified Editions")
@pytest.mark.serial(reason="an upper bound on elapsed time")
def test_rebind_over_40000_editions_finishes_inside_30_seconds(world):
    count = 40_000
    with connect() as conn, conn.transaction():
        conn.execute("""CREATE TEMP TABLE cap ON COMMIT DROP AS SELECT n, gen_random_uuid() AS identity_id,
          gen_random_uuid() AS printing_id, gen_random_uuid() AS edition_id FROM generate_series(1,%s) n""", (count,))
        conn.execute("INSERT INTO catalog_identity(id,identity_key,display_name) SELECT identity_id,'cap-'||identity_id,'Cap '||n FROM cap")
        conn.execute("INSERT INTO catalog_printing(id,source,source_id,identity_id) SELECT printing_id,'tcgdex','cap-'||printing_id,identity_id FROM cap")
        conn.execute("""INSERT INTO catalog_edition(id,printing_id,descriptor_key,descriptor)
          SELECT edition_id,printing_id,'normal',CASE WHEN n%4=0 THEN '{"type":"reverse"}' ELSE '{"type":"normal"}' END::jsonb FROM cap""")
        conn.execute("""UPDATE catalog_edition_metadata m SET mapping_state='verified',mapping_reason=NULL,product_id=1000+c.n,
          mapping_basis='matching_rule',matching_activation_id=%s,auto_closed=true FROM cap c WHERE m.edition_id=c.edition_id""",
                     (world["activation"],))
        conn.execute("""INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,seen_at,source_updated_at)
          SELECT 1000+n,'Normal',1.5,now(),now() FROM cap UNION ALL
          SELECT 1000+n,'Reverse Holofoil',2.5,now(),now() FROM cap""")
    started = time.monotonic()
    counts = do_rebind()
    first = time.monotonic() - started
    started = time.monotonic()
    do_rebind()
    print(f"rebind of {count} Editions: first {first:.2f}s, repeat {time.monotonic() - started:.2f}s")
    assert counts["verified"] == count and counts["bound"] == count and counts["priced"] == count
    assert first < 30


# --- spawn_rebind: one coalescing worker -------------------------------------------------------------------------------

def test_rebind_burst_coalesces_into_two_passes(monkeypatch):
    import threading
    started, release = threading.Event(), threading.Event()
    state = {"passes": 0, "running": 0, "max": 0, "threads": set()}
    lock = threading.Lock()

    def fake():
        with lock:
            state["passes"] += 1
            state["running"] += 1
            state["max"] = max(state["max"], state["running"])
            state["threads"].add(threading.get_ident())
        started.set()
        release.wait(10)
        with lock:
            state["running"] -= 1

    monkeypatch.setattr(price_binding, "rebind_best_effort", fake)
    price_binding.spawn_rebind()
    assert started.wait(10)
    for _ in range(20):
        price_binding.spawn_rebind()
    release.set()
    price_binding.join_spawned_rebinds()
    assert state["passes"] == 2 and state["max"] == 1 and len(state["threads"]) == 1


def test_rebind_after_idle_starts_a_new_pass(monkeypatch):
    passes = []
    monkeypatch.setattr(price_binding, "rebind_best_effort", lambda: passes.append(1))
    price_binding.spawn_rebind()
    price_binding.join_spawned_rebinds()
    price_binding.spawn_rebind()
    price_binding.join_spawned_rebinds()
    assert len(passes) == 2


def test_rebind_pass_exception_is_logged_and_worker_keeps_serving(monkeypatch, caplog):
    calls = []

    def fake():
        calls.append(1)
        if len(calls) == 1:
            raise ValueError("secret detail")

    monkeypatch.setattr(price_binding, "rebind_best_effort", fake)
    with caplog.at_level("WARNING"):
        price_binding.spawn_rebind()
        price_binding.join_spawned_rebinds()
    assert "ValueError" in caplog.text and "secret detail" not in caplog.text
    price_binding.spawn_rebind()
    price_binding.join_spawned_rebinds()
    assert len(calls) == 2
