import hashlib
import hmac
import os
import time
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.catalog import CatalogError, claim_run, execute_run
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
    first = client.post(path, headers=headers(owner, "POST", path)).json()
    second = client.post(path, headers=headers(owner, "POST", path)).json()
    assert first["run"]["id"] == second["run"]["id"]
    assert first["run"]["phase"] == "queued"
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_run").fetchone()["n"] == 1
        run_id = claim_run(conn)
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
        response = client.post(path, headers=headers(owner, "POST", path))
        assert response.status_code == 200
        with connect() as conn:
            run_id = claim_run(conn)
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
        client.post(path, headers=headers(owner, "POST", path))
        with connect() as conn:
            execute_run(conn, claim_run(conn), source)
    with connect() as conn:
        assert conn.execute("SELECT id FROM catalog_printing WHERE source_id='test-1'").fetchone()["id"] == original
        assert conn.execute("SELECT count(*) AS n FROM catalog_generation").fetchone()["n"] == 2
        assert conn.execute("SELECT count(*) AS n FROM catalog_review WHERE kind='variant_ambiguity'").fetchone()["n"] == 1
        assert conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"] == 3


def test_missing_energy_type_is_unresolved():
    reset_catalog()
    with connect() as conn:
        conn.execute("INSERT INTO catalog_run DEFAULT VALUES")
        run_id = claim_run(conn)
        class UncertainEnergy(Source):
            def fetch(self, source_id):
                card = super().fetch(source_id)
                card.pop("energyType", None)
                return card
        execute_run(conn, run_id, UncertainEnergy(ids=("test-1",)))
        row = conn.execute("SELECT basic_energy FROM catalog_generation_printing WHERE generation_id=%s", (run_id,)).fetchone()
        assert row["basic_energy"] == "unresolved"
