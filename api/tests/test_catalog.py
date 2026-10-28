import hashlib
import hmac
import os
import time
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest
from fastapi.testclient import TestClient

from app.catalog import CatalogError, claim_run, execute_run
from unittest.mock import patch
from app.main import app, connect

client = TestClient(app)


def headers(user, method, path):
    stamp = str(int(time.time()))
    payload = f"{method}\n{path}\n{hashlib.sha256(b'').hexdigest()}\n{user}\n{stamp}".encode()
    signature = hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), payload, hashlib.sha256).hexdigest()
    return {"x-internal-user": user, "x-internal-time": stamp, "x-internal-signature": signature}


class Source:
    def __init__(self, ids=("test-1", "test-2"), second=None, fail=None):
        self.ids = set(ids)
        self.second = set(second) if second is not None else self.ids
        self.fail = fail
        self.calls = 0

    def enumerate(self):
        self.calls += 1
        return self.ids if self.calls == 1 else self.second

    def fetch(self, source_id):
        if source_id == self.fail:
            raise CatalogError("TCGdex request failed")
        number = source_id.split("-")[-1]
        return {"id": source_id, "name": "Grass Energy" if number == "1" else "Pikachu",
                "localId": number, "set": {"id": "test", "name": "Test Set"},
                "category": "Energy" if number == "1" else "Pokemon",
                "energyType": "Normal" if number == "1" else None,
                "variants": {"normal": True, "holo": False, "reverse": number == "2"}}



def claim_current(conn):
    run_id = conn.execute("SELECT id FROM catalog_run WHERE outcome IS NULL").fetchone()['id']
    conn.commit()
    return claim_run(conn,run_id)


def dispatch_fixture(owner):
    path = '/api/admin/catalog-runs'
    with patch('app.catalog_dispatch.launch_import'):
        return client.post(path,headers=headers(owner,'POST',path))

def reset_catalog():
    with connect() as conn:
        conn.execute("TRUNCATE catalog_review,catalog_generation_edition,catalog_generation_printing,catalog_edition,catalog_printing,catalog_identity,catalog_generation,catalog_run CASCADE")
        conn.execute("INSERT INTO catalog_state(singleton,active_generation,revision,last_success) VALUES (true,NULL,0,NULL) ON CONFLICT(singleton) DO UPDATE SET active_generation=NULL,revision=0,last_success=NULL")
        conn.execute("DELETE FROM owner_binding")


def seed_successful_generation():
    reset_catalog()
    owner, other = f"owner-{uuid4()}", f"other-{uuid4()}"
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s),(%s)", (owner, other))
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (owner,))
    path = "/api/admin/catalog-runs"
    assert client.get("/api/catalog/status", headers=headers(other, "GET", "/api/catalog/status")).json() == {
        "available": False, "revision": 0, "last_success": None}
    assert client.post(path, headers=headers(other, "POST", path)).status_code == 403
    first = dispatch_fixture(owner).json()
    second = dispatch_fixture(owner).json()
    assert first["run"]["id"] == second["run"]["id"]
    assert first["run"]["phase"] == "queued"
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_run").fetchone()["n"] == 1
        run_id = claim_current(conn)
        assert str(run_id) == first["run"]["id"]
        execute_run(conn, run_id, Source())
    status = client.get("/api/catalog/status", headers=headers(other, "GET", "/api/catalog/status")).json()
    assert status["available"] is True and status["revision"] == 1 and status["last_success"]
    with connect() as conn:
        rows = conn.execute("""SELECT gp.source_id,gp.basic_energy,e.descriptor
          FROM catalog_generation_printing gp JOIN catalog_generation_edition ge USING(generation_id,printing_id)
          JOIN catalog_edition e ON e.id=ge.edition_id ORDER BY gp.source_id""").fetchall()
        assert [row["basic_energy"] for row in rows] == ["supported", "not_basic", "not_basic"]
        assert {row["descriptor"]["finish"] for row in rows} == {"normal", "reverse"}
    return owner


def test_owner_dispatch_and_first_import_unavailable():
    seed_successful_generation()


def test_failed_fetch_changed_enumeration_and_promotion_preserve_generation():
    owner = seed_successful_generation()
    path = "/api/admin/catalog-runs"
    with connect() as conn:
        old = conn.execute("SELECT active_generation,revision FROM catalog_state").fetchone()
    scenarios = [Source(fail="test-2"), Source(second=("test-1",)), Source()]
    for index, source in enumerate(scenarios):
        response = dispatch_fixture(owner)
        assert response.status_code == 200
        with connect() as conn:
            run_id = claim_current(conn)
            with pytest.raises((CatalogError, RuntimeError)):
                execute_run(conn, run_id, source, before_promotion=(lambda: (_ for _ in ()).throw(RuntimeError("boom"))) if index == 2 else None)
            state = conn.execute("SELECT active_generation,revision FROM catalog_state").fetchone()
            assert state == old
            failed = conn.execute("SELECT phase,outcome,error FROM catalog_run WHERE id=%s", (run_id,)).fetchone()
            assert failed["phase"] == failed["outcome"] == "failed"
            assert "boom" not in failed["error"]


def test_stable_ids_review_and_bounded_raw_retention():
    owner = seed_successful_generation()
    with connect() as conn:
        original = conn.execute("SELECT id FROM catalog_printing WHERE source_id='test-1'").fetchone()["id"]
    path = "/api/admin/catalog-runs"
    class AmbiguousSource(Source):
        def fetch(self, source_id):
            card = super().fetch(source_id)
            if source_id == "test-2":
                card["variants"] = {"normal": True, "firstEdition": True}
            return card
    for source in (AmbiguousSource(), Source()):
        dispatch_fixture(owner)
        with connect() as conn:
            execute_run(conn, claim_current(conn), source)
    with connect() as conn:
        assert conn.execute("SELECT id FROM catalog_printing WHERE source_id='test-1'").fetchone()["id"] == original
        assert conn.execute("SELECT count(*) AS n FROM catalog_generation").fetchone()["n"] == 2
        assert conn.execute("SELECT count(*) AS n FROM catalog_review WHERE kind='variant_ambiguity'").fetchone()["n"] == 1
        assert conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"] == 3


def test_missing_energy_type_is_unresolved():
    reset_catalog()
    with connect() as conn:
        conn.execute("INSERT INTO catalog_run DEFAULT VALUES")
        run_id = claim_current(conn)
        class UncertainEnergy(Source):
            def fetch(self, source_id):
                card = super().fetch(source_id)
                card.pop("energyType", None)
                return card
        execute_run(conn, run_id, UncertainEnergy(ids=("test-1",)))
        row = conn.execute("SELECT basic_energy FROM catalog_generation_printing WHERE generation_id=%s", (run_id,)).fetchone()
        assert row["basic_energy"] == "unresolved"


def price_import_owner():
    owner, other = f"owner-{uuid4()}", f"other-{uuid4()}"
    with connect() as conn:
        conn.execute("TRUNCATE price_import, tcgplayer_product, tcgplayer_price RESTART IDENTITY")
        conn.execute("DELETE FROM owner_binding")
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s),(%s)", (owner, other))
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (owner,))
    return owner, other


def add_import(outcome, hours_ago=0, **columns):
    """One finished price_import row, finished `hours_ago` hours ago; extra columns are bound values."""
    if "unpriced" in columns:
        columns["unpriced"] = Jsonb(columns["unpriced"])
    names = ",".join(["outcome", "finished_at", "source_updated_at", *columns])
    marks = ",".join(["%s", "now()-%s*interval '1 hour'", "now()", *["%s"] * len(columns)])
    with connect() as conn:
        conn.execute(f"INSERT INTO price_import({names}) VALUES ({marks})", [outcome, hours_ago, *columns.values()])


def add_price(hours_ago=0):
    with connect() as conn:
        conn.execute("INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,seen_at,source_updated_at) "
                     "VALUES (1,'Normal',1,now(),now()-%s*interval '1 hour')", (hours_ago,))


def owner_status(owner):
    path = "/api/admin/catalog-runs"
    response = client.get(path, headers=headers(owner, "GET", path))
    assert response.status_code == 200
    return response.json()


def test_catalog_runs_price_import_before_any_import_and_access():
    owner, other = price_import_owner()
    body = owner_status(owner)
    assert body["last_price_import"] is None and body["last_good_price_import_at"] is None
    assert body["price_import_stale"] is False and body["price_source_stale"] is False
    path = "/api/admin/catalog-runs"
    assert client.get(path, headers=headers(other, "GET", path)).status_code == 403
    collector = client.get("/api/catalog/status", headers=headers(other, "GET", "/api/catalog/status")).text
    assert "price" not in collector.lower() and "tcg" not in collector.lower()


def test_catalog_runs_price_import_after_imported_run():
    owner, _ = price_import_owner()
    add_price()
    add_import("imported", verified_editions=10, priced_editions=7, groups_total=3,
               unpriced={"ambiguous": 2, "no_price": 1}, fallback_art=4)
    body = owner_status(owner)
    last = body["last_price_import"]
    assert (last["outcome"], last["verified_editions"], last["priced_editions"]) == ("imported", 10, 7)
    assert last["unpriced"] == {"ambiguous": 2, "no_price": 1} and last["fallback_art"] == 4
    assert body["last_good_price_import_at"] and body["source_updated_at_max"]
    assert body["price_import_stale"] is False and body["price_source_stale"] is False
    assert last["public_error"] is None and last["error_code"] is None


def test_catalog_runs_price_import_partial_failed_and_public_error_are_reported():
    owner, _ = price_import_owner()
    add_price()
    add_import("imported")
    add_import("partial", groups_failed=2, groups_total=5)
    last = owner_status(owner)["last_price_import"]
    assert (last["outcome"], last["groups_failed"]) == ("partial", 2)
    add_import("failed", error_code="stale_source")
    last = owner_status(owner)["last_price_import"]
    assert (last["outcome"], last["error_code"]) == ("failed", "stale_source")
    add_import("imported", public_error="publish failed")
    body = owner_status(owner)
    assert body["last_price_import"]["public_error"] == "publish failed"
    assert body["price_import_stale"] is False


def test_catalog_runs_price_import_last_good_run_over_48_hours_is_stale():
    owner, _ = price_import_owner()
    add_price()
    add_import("imported", 49)
    add_import("failed", error_code="group_list")
    body = owner_status(owner)
    assert body["price_import_stale"] is True and body["price_source_stale"] is False
    add_import("unchanged", 47)
    assert owner_status(owner)["price_import_stale"] is False


def test_catalog_runs_price_import_frozen_source_is_stale_though_latest_run_is_unchanged():
    owner, _ = price_import_owner()
    add_price(50)
    add_import("unchanged")
    body = owner_status(owner)
    assert body["last_price_import"]["outcome"] == "unchanged"
    assert body["price_import_stale"] is False and body["price_source_stale"] is True
