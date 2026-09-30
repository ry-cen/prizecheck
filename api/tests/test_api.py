import hashlib
import hmac
import os
import time
from uuid import uuid4

import psycopg
from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def headers(user: str):
    stamp = str(int(time.time()))
    payload = f"GET\n/api/locations\n{hashlib.sha256(b'').hexdigest()}\n{user}\n{stamp}".encode()
    signature = hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), payload, hashlib.sha256).hexdigest()
    return {"x-internal-user": user, "x-internal-time": stamp, "x-internal-signature": signature}


def test_health_and_internal_auth_boundary():
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/locations").status_code == 401
    forged = headers("forged")
    forged["x-internal-signature"] = "0" * 64
    assert client.get("/api/locations", headers=forged).status_code == 401
    expired = headers("forged")
    expired["x-internal-time"] = "1"
    assert client.get("/api/locations", headers=expired).status_code == 401


def test_two_owner_isolation_and_unsorted_idempotence():
    first = f"api-test-{uuid4()}"
    second = f"api-test-{uuid4()}"
    one = client.get("/api/locations", headers=headers(first))
    assert one.status_code == 200
    leaf = one.json()["locations"][0]
    assert leaf["name"] == "Unsorted" and leaf["kind"] == "storage_leaf"
    assert client.get("/api/locations", headers=headers(first)).json()["locations"] == [leaf]
    two = client.get("/api/locations", headers=headers(second)).json()["locations"][0]
    assert two["id"] != leaf["id"]
    other_headers = headers(second)
    other_headers["x-internal-signature"] = hmac.new(
        os.environ["INTERNAL_AUTH_SECRET"].encode(),
        f"GET\n/api/locations/{leaf['id']}\n{hashlib.sha256(b'').hexdigest()}\n{second}\n{other_headers['x-internal-time']}".encode(),
        hashlib.sha256,
    ).hexdigest()
    assert client.get(f"/api/locations/{leaf['id']}", headers=other_headers).status_code == 404
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        assert conn.execute("SELECT count(*) FROM location WHERE owner_id = %s", (first,)).fetchone()[0] == 1
