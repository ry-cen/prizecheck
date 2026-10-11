"""Add and leaf contracts against PostgreSQL and signed HTTP requests."""
import hashlib
import hmac
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def call(method, path, user, body=None):
    payload = b"" if body is None else json.dumps(body, separators=(",", ":")).encode()
    stamp = str(int(time.time()))
    signed = f"{method}\n{path.split('?')[0]}\n{hashlib.sha256(payload).hexdigest()}\n{user}\n{stamp}".encode()
    headers = {"x-internal-user": user, "x-internal-time": stamp,
               "x-internal-signature": hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), signed, hashlib.sha256).hexdigest()}
    return client.request(method, path, headers={**headers, **({"content-type": "application/json"} if body is not None else {})}, content=payload if body is not None else None)


def fixture():
    owner, other = str(uuid4()), str(uuid4())
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s),(%s)", (owner, other))
        leaf = conn.execute("INSERT INTO location(owner_id,name,kind,id) VALUES (%s,'Unsorted','storage_leaf',%s) RETURNING id", (owner, uuid4())).fetchone()[0]
        other_leaf = conn.execute("INSERT INTO location(owner_id,name,kind,id) VALUES (%s,'Unsorted','storage_leaf',%s) RETURNING id", (other, uuid4())).fetchone()[0]
        identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,'Pikachu') RETURNING id", (str(uuid4()),)).fetchone()[0]
        printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',%s,%s) RETURNING id", (str(uuid4()), identity)).fetchone()[0]
        edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'unspecified',%s) RETURNING id", (printing, json.dumps({"label": "Unspecified Variant"}))).fetchone()[0]
        generation = uuid4()
        conn.execute("INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,1,%s,'test')", (generation, b"test"))
        conn.execute("""INSERT INTO catalog_generation_printing
          (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,source_fingerprint,basic_energy)
          VALUES (%s,%s,%s,'base','Base Set','25','Pikachu','pikachu','test','not_basic')""", (generation, printing, str(uuid4())))
        # The card attributes an import derives for a Basic Pokémon (migrations 026 and 034); Deck checks read them.
        conn.execute("""INSERT INTO catalog_derived_attribute
          (printing_id,rules_version,card_kind,basic_energy,types,rule_box,ace_spec,radiant,prism_star,basic_pokemon)
          VALUES (%s,2,'pokemon',false,'{Lightning}',false,false,false,false,true)""", (printing,))
        conn.execute("INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s)", (generation, edition, printing))
        conn.execute("UPDATE catalog_state SET active_generation=%s,revision=revision+1 WHERE singleton", (generation,))
    return owner, other, str(leaf), str(other_leaf), str(edition), str(generation)


def add(owner, leaf, edition, quantity, key=None):
    return call("POST", "/api/holdings", owner, {"location_id": leaf, "edition_id": edition,
                                                  "quantity": quantity, "idempotency_key": str(key or uuid4())})


def test_add_replay_increment_privacy_and_boundaries():
    owner, other, leaf, other_leaf, edition, generation = fixture()
    key = uuid4()
    first = add(owner, leaf, edition, "2", key)
    assert first.status_code == 200, first.text
    assert first.json()["quantity"] == "2"
    assert add(owner, leaf, edition, "2", key).json() == first.json()
    assert add(owner, leaf, edition, "3", key).json()["detail"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    second = add(owner, leaf, edition, "3")
    assert second.json()["quantity"] == "5"
    assert second.json()["owner_revision"] == first.json()["owner_revision"] + 1
    assert add(owner, leaf, edition, "2", key).json() == first.json()
    page = call("GET", f"/api/holdings/{leaf}", owner)
    assert page.status_code == 200, page.text
    assert len(page.json()["holdings"]) == 1
    assert page.json()["holdings"][0]["quantity"] == "5"
    assert page.json()["holdings"][0]["printing_name"] == "Pikachu"
    for invalid in ("0", "-1", "1.5", "", "9223372036854775808"):
        assert add(owner, leaf, edition, invalid).status_code == 422
    assert add(owner, leaf, edition, str(2**63 - 3)).json()["detail"]["code"] == "QUANTITY_OVERFLOW"
    assert add(owner, other_leaf, edition, "1").status_code == 404
    assert add(owner, str(uuid4()), edition, "1").status_code == 404
    assert call("GET", f"/api/holdings/{leaf}", other).status_code == 404
    assert call("GET", f"/api/holdings/{str(uuid4())}", other).status_code == 404
    assert add(other, other_leaf, edition, "1").json()["quantity"] == "1"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("UPDATE catalog_generation_edition SET active=false WHERE generation_id=%s AND edition_id=%s", (generation, edition))
    assert add(owner, leaf, edition, "1").json()["detail"]["code"] == "EDITION_UNAVAILABLE"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("UPDATE catalog_generation_edition SET active=true WHERE generation_id=%s AND edition_id=%s", (generation, edition))
        conn.execute("UPDATE catalog_generation_printing SET tombstoned=true WHERE generation_id=%s", (generation,))
    assert add(owner, leaf, edition, "1").json()["detail"]["code"] == "EDITION_UNAVAILABLE"


def test_concurrent_adds_and_failure_rollback():
    owner, _, leaf, _, edition, _ = fixture()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: add(owner, leaf, edition, "1"), range(12)))
    assert all(response.status_code == 200 for response in results)
    assert call("GET", f"/api/holdings/{leaf}", owner).json()["holdings"][0]["quantity"] == "12"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        before = conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s", (owner,)).fetchone()[0]
        conn.execute("CREATE OR REPLACE FUNCTION reject_holding_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced rollback'; END $$")
        conn.execute("CREATE TRIGGER reject_holding_test BEFORE UPDATE ON holding FOR EACH ROW EXECUTE FUNCTION reject_holding_test()")
    try:
        try:
            add(owner, leaf, edition, "1")
        except Exception:
            pass
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            assert conn.execute("SELECT quantity FROM holding WHERE owner_id=%s AND location_id=%s AND edition_id=%s", (owner, leaf, edition)).fetchone()[0] == 12
            assert conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s", (owner,)).fetchone()[0] == before
    finally:
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute("DROP TRIGGER reject_holding_test ON holding")
            conn.execute("DROP FUNCTION reject_holding_test()")


def test_maximum_quantity_and_inventory_cursor_refresh():
    owner, _, leaf, _, edition, generation = fixture()
    maximum = add(owner, leaf, edition, str(2**63 - 1))
    assert maximum.status_code == 200 and maximum.json()["quantity"] == str(2**63 - 1)
    assert add(owner, leaf, edition, "1").json()["detail"]["code"] == "QUANTITY_OVERFLOW"
    assert call("GET", f"/api/holdings/{leaf}", owner).json()["holdings"][0]["quantity"] == str(2**63 - 1)
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        printing = conn.execute("SELECT printing_id FROM catalog_edition WHERE id=%s", (edition,)).fetchone()[0]
        for index in range(49):
            new_edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,%s,%s) RETURNING id",
                                       (printing, f"test-{index:02d}", json.dumps({"label": f"Test {index:02d}"}))).fetchone()[0]
            conn.execute("INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s)", (generation, new_edition, printing))
            conn.execute("INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,1,1)", (owner, leaf, new_edition))
    first = call("GET", f"/api/holdings/{leaf}", owner).json()
    assert len(first["holdings"]) == 48 and first["next_cursor"]
    assert len(call("GET", f"/api/holdings/{leaf}?cursor={first['next_cursor']}", owner).json()["holdings"]) == 2
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        next_edition = conn.execute("SELECT edition_id FROM holding WHERE owner_id=%s AND edition_id<>%s LIMIT 1", (owner, edition)).fetchone()[0]
    assert add(owner, leaf, str(next_edition), "1").status_code == 200
    changed = call("GET", f"/api/holdings/{leaf}?cursor={first['next_cursor']}", owner)
    assert changed.status_code == 409 and changed.json()["detail"]["code"] == "INVENTORY_CHANGED"
