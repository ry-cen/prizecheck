"""Scanner manifest, number table and fingerprint file routes (#310; plumbing D4, D5, D7)."""
import gzip
import json
from fastapi.testclient import TestClient

from app.main import app, connect  # first: app.main includes the routers
from app import scanner, set_codes
from test_catalog import headers
from test_catalog_search import promote

client = TestClient(app)
USER = "scanner-reader"
SHA = "ab" * 32
OTHER_SHA = "cd" * 32


def get(path, **params):
    return client.get(path, params=params, headers=headers(USER, "GET", path))


def seed(names=None):
    promote(names or {"card-1": "Pikachu", "card-2": "Raichu"})
    scanner._cards_cache = None
    with connect() as conn:
        conn.execute("DELETE FROM scanner_index")
        state = conn.execute("SELECT active_generation FROM catalog_state").fetchone()
        conn.execute("INSERT INTO catalog_generation_set_count(generation_id,set_id,official,total) VALUES (%s,'fixture',25,30)",
                     (state["active_generation"],))
        conn.execute("INSERT INTO catalog_generation_set(generation_id,set_id,release_date) VALUES (%s,'fixture','2023-03-31')",
                     (state["active_generation"],))
    return state["active_generation"]


def artifact(model, sha, content=b"x", created="2026-01-01", count=3):
    with connect() as conn:
        conn.execute("""INSERT INTO scanner_index(sha256,model_id,catalog_revision,inputs_digest,count,inputs_count,bytes,created_at)
          VALUES (%s,%s,1,'d',%s,%s,%s,%s)""", (sha, model, count, count + 1, content, created))


def manifest(model="model-a"):
    return get("/api/scanner/manifest", model=model)


def table():
    key = manifest().json()["cards"]["key"]
    return json.loads(gzip.decompress(get(f"/api/scanner/cards/{key}").content))


def test_routes_need_a_signed_in_collector_and_none_is_public():
    seed()
    for method, path in (("get", "/api/scanner/manifest?model=m"), ("get", "/api/scanner/cards/abc"),
                         ("get", f"/api/scanner/fingerprints/{SHA}"), ("post", "/api/scanner/printings")):
        assert getattr(client, method)(path).status_code == 401
    paths = {path for path in app.openapi()["paths"] if "scanner" in path}
    assert {"/api/scanner/manifest", "/api/scanner/cards/{key}", "/api/scanner/fingerprints/{sha256}",
            "/api/scanner/printings"} <= paths
    assert all(path.startswith("/api/scanner/") for path in paths)


def test_cards_gzip_has_the_documented_shape_and_set_counts_come_from_the_table():
    generation = seed()
    answer = manifest()
    assert answer.status_code == 200
    body = answer.json()
    assert body["format"] == 1 and body["model"] == "model-a" and body["catalog_revision"] == 1
    assert body["fingerprints"] is None
    assert body["cards"]["url"] == f'/api/scanner/cards/{body["cards"]["key"]}' and len(body["cards"]["key"]) == 16
    response = get(body["cards"]["url"])
    assert response.status_code == 200
    assert len(response.content) == body["cards"]["bytes"]
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"] == 'attachment; filename="cards.json.gz"'
    data = json.loads(gzip.decompress(response.content))
    assert data["format"] == 1 and data["key"] == body["cards"]["key"] and data["catalog_revision"] == 1
    assert data["sets"] == [{"id": "fixture", "code": None, "official": 25, "total": 30, "released": "2023-03-31"}]
    columns = data["printings"]
    assert set(columns) == {"id", "set", "number", "name", "image"}
    assert columns["id"] == sorted(columns["id"]) and len(columns["id"]) == 2
    assert sorted(columns["name"]) == ["Pikachu", "Raichu"] and columns["set"] == [0, 0]
    assert sorted(columns["number"], key=str) == ["1", "2"]
    assert sorted(columns["image"], key=lambda value: value or "") == [None, "https://assets.tcgdex.net/en/fixture/card-1"]
    # A set with no count row, release row or printed code carries nulls.
    with connect() as conn:
        conn.execute("DELETE FROM catalog_generation_set_count WHERE generation_id=%s", (generation,))
        conn.execute("DELETE FROM catalog_generation_set WHERE generation_id=%s", (generation,))
    scanner._cards_cache = None
    assert table()["sets"] == [{"id": "fixture", "code": None, "official": None, "total": None, "released": None}]


def test_cards_hold_active_printings_only_and_a_known_set_has_its_printed_code():
    generation = seed()
    set_id, code = next(iter(set_codes.CODES.items()))
    with connect() as conn:
        conn.execute("UPDATE catalog_generation_printing SET set_id=%s WHERE generation_id=%s AND source_id='card-2'",
                     (set_id, generation))
        conn.execute("UPDATE catalog_generation_printing SET tombstoned=true WHERE generation_id=%s AND source_id='card-1'",
                     (generation,))
    scanner._cards_cache = None
    data = table()
    assert [row["id"] for row in data["sets"]] == [set_id] and data["sets"][0]["code"] == code
    assert data["printings"]["name"] == ["Raichu"]


def test_two_builds_at_one_key_are_byte_equal():
    seed()
    with connect() as conn:
        state = conn.execute("SELECT active_generation, revision FROM catalog_state").fetchone()
        key = scanner.cards_key(state)
        first = scanner.build_cards(conn, state, key)
    with connect() as conn:
        second = scanner.build_cards(conn, state, key)
    assert first == second
    assert first[4:8] == b"\x00\x00\x00\x00"  # mtime 0 in the gzip header
    scanner._cards_cache = None
    assert get(f"/api/scanner/cards/{key}").content == first


def test_cards_no_content_encoding():
    seed()
    response = get(manifest().json()["cards"]["url"])
    assert "content-encoding" not in response.headers
    assert response.content[:2] == b"\x1f\x8b"  # still the gzip bytes: nothing inflated them


def test_the_key_follows_the_revision_and_a_stale_key_answers_404():
    seed()
    old = manifest().json()["cards"]
    with connect() as conn:
        conn.execute("UPDATE catalog_state SET revision=revision+1")
    new = manifest().json()
    assert new["cards"]["key"] != old["key"] and new["catalog_revision"] == 2
    stale = get(old["url"])
    assert stale.status_code == 404 and stale.json()["detail"]["code"] == "CARDS_NOT_CURRENT"
    assert get(new["cards"]["url"]).status_code == 200
    assert get("/api/scanner/cards/not-a-key").json()["detail"]["code"] == "CARDS_NOT_CURRENT"


def test_the_last_build_is_kept_in_memory(monkeypatch):
    seed()
    builds = []
    real = scanner.build_cards
    monkeypatch.setattr(scanner, "build_cards", lambda *args: builds.append(1) or real(*args))
    url = manifest().json()["cards"]["url"]
    assert get(url).status_code == 200 and manifest().status_code == 200
    assert len(builds) == 1
    with connect() as conn:
        conn.execute("UPDATE catalog_state SET revision=revision+1")
    manifest()
    assert len(builds) == 2


def test_no_catalog_means_no_manifest_and_no_current_key():
    seed()
    with connect() as conn:
        conn.execute("UPDATE catalog_state SET active_generation=NULL")
    scanner._cards_cache = None
    answer = manifest()
    assert answer.status_code == 404 and answer.json()["detail"]["code"] == "CATALOG_UNAVAILABLE"
    assert get("/api/scanner/cards/" + "0" * 16).json()["detail"]["code"] == "CARDS_NOT_CURRENT"


def test_manifest_offers_the_newest_artifact_of_the_asked_model_only():
    seed()
    artifact("model-a", SHA, b"old", created="2026-01-01")
    artifact("model-a", OTHER_SHA, b"newer bytes", created="2026-02-01", count=7)
    artifact("model-b", "ef" * 32, b"b", created="2026-03-01")
    assert manifest("model-a").json()["fingerprints"] == {
        "sha256": OTHER_SHA, "url": f"/api/scanner/fingerprints/{OTHER_SHA}", "bytes": 11, "count": 7, "dim": 384}
    assert manifest("model-b").json()["fingerprints"]["sha256"] == "ef" * 32
    assert manifest("model-c").json()["fingerprints"] is None
    assert manifest("m" * 64).status_code == 200
    assert manifest("m" * 65).status_code == 422
    assert get("/api/scanner/manifest").status_code == 422
    assert manifest("").status_code == 422


def test_fingerprints_stream_the_stored_bytes_and_a_pruned_sha_is_404():
    seed()
    every_byte = bytes(range(256)) * 4
    artifact("model-a", SHA, every_byte)
    response = get(f"/api/scanner/fingerprints/{SHA}")
    assert response.status_code == 200 and response.content == every_byte
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert "content-encoding" not in response.headers
    with connect() as conn:
        conn.execute("DELETE FROM scanner_index")
    gone = get(f"/api/scanner/fingerprints/{SHA}")
    assert gone.status_code == 404 and gone.json()["detail"]["code"] == "FINGERPRINTS_NOT_FOUND"
    assert get("/api/scanner/fingerprints/" + "g" * 64).status_code == 422
    assert get("/api/scanner/fingerprints/" + "a" * 63).status_code == 422
