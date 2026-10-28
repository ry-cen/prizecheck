"""Card art route and read-through store (#358, ADR 0020)."""
import gzip
import hashlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient

from app import art_storage, art_store
from app.art_store import ArtFetcher, RateLimiter, backoff_seconds
from app.art_urls import art_url, art_version
from app.main import app, connect
from test_catalog import headers
from test_catalog_search import promote

client = TestClient(app)
USER = "art-reader"
BASE = "https://assets.tcgdex.net/en/fixture/card-1"
SMALL, LARGE = BASE + "/low.webp", BASE + "/high.webp"


def webp(n):
    return b"RIFF" + n.to_bytes(4, "little") + b"WEBP" + b"\0" * n


PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


class Upstream:
    """The counting upstream stub: every request is recorded under a lock, then answered by `responder`."""

    def __init__(self):
        self.lock = threading.Lock()
        self.urls = []
        self.delay = 0.0
        self.responder = lambda request: httpx.Response(200, content=webp(64), headers={"content-type": "image/webp"})

    def handler(self, request):
        with self.lock:
            self.urls.append(str(request.url))
        if self.delay:
            time.sleep(self.delay)
        return self.responder(request)

    @property
    def count(self):
        with self.lock:
            return len(self.urls)


@pytest.fixture(autouse=True)
def upstream(monkeypatch, tmp_path):
    monkeypatch.setenv("ART_STORE_DIR", str(tmp_path))
    stub = Upstream()
    monkeypatch.setattr(art_store, "_fetcher",
                        ArtFetcher(transport=httpx.MockTransport(stub.handler), limiter=RateLimiter(100000)))
    return stub


@pytest.fixture
def pids():
    promote({"card-1": "Pikachu", "card-2": "Raichu"})
    with connect() as conn:
        return {row["source_id"]: row["id"] for row in conn.execute("SELECT id, source_id FROM catalog_printing")}


def get(pid, size="small", v="auto", user=USER, **params):
    path = f"/api/art/{pid}/{size}"
    if v == "auto":
        v = art_version(SMALL if size == "small" else LARGE)
    if v is not None:
        params["v"] = v
    return client.get(path, params=params, headers=headers(user, "GET", path))


def sql(query, *args):
    with connect() as conn:
        cursor = conn.execute(query, args)
        return cursor.fetchall() if cursor.description else None


def set_image(pid, image_url):
    sql("UPDATE catalog_generation_printing SET image_url=%s WHERE printing_id=%s", image_url, pid)


def objects(pid):
    return sql("SELECT * FROM art_object WHERE printing_id=%s ORDER BY size", pid)


def ledger(pid):
    return sql("SELECT * FROM art_fetch_failure WHERE printing_id=%s", pid)


def test_small_and_large_return_the_tcgdex_bytes_with_headers(pids, upstream):
    upstream.responder = lambda request: httpx.Response(
        200, content=webp(64 if request.url.path.endswith("low.webp") else 128), headers={"content-type": "image/webp"})
    small, large = get(pids["card-1"]), get(pids["card-1"], "large")
    assert (small.status_code, large.status_code) == (200, 200)
    assert upstream.urls == [SMALL, LARGE]
    assert small.content == webp(64) and large.content == webp(128)
    for answer in (small, large):
        assert answer.headers["content-type"] == "image/webp"
        assert answer.headers["cache-control"] == "private, max-age=31536000, immutable"
        assert answer.headers["cross-origin-resource-policy"] == "same-origin"
        assert answer.headers["x-content-type-options"] == "nosniff"
    assert "set-cookie" not in small.headers and "access-control-allow-origin" not in small.headers


def test_a_second_request_is_served_from_the_store(pids, upstream):
    first, second = get(pids["card-1"]), get(pids["card-1"])
    assert first.status_code == second.status_code == 200 and first.content == second.content
    assert upstream.count == 1


def test_ten_concurrent_first_requests_fetch_once(pids, upstream):
    upstream.delay = 0.3
    with ThreadPoolExecutor(10) as pool:
        answers = list(pool.map(lambda _: get(pids["card-1"]), range(10)))
    assert [answer.status_code for answer in answers] == [200] * 10
    assert len({answer.content for answer in answers}) == 1
    assert upstream.count == 1


def test_signed_out_unknown_bad_size_and_no_image_are_denied_without_upstream(pids, upstream):
    assert client.get(f"/api/art/{pids['card-1']}/small").status_code == 401
    set_image(pids["card-2"], None)
    from uuid import uuid4
    for pid, size in ((uuid4(), "small"), ("not-a-uuid", "small"), (pids["card-1"], "medium"), (pids["card-2"], "small")):
        answer = get(pid, size, v=None)
        assert answer.status_code == 404 and answer.json()["detail"]["code"] == "ART_NOT_FOUND", (pid, size)
        assert "cache-control" not in answer.headers
    assert upstream.count == 0


def test_no_parameter_or_catalog_value_reaches_another_host(pids, upstream):
    for bad in ("https://evil.example/x", "https://assets.tcgdex.net.evil.example/x", "https://u@assets.tcgdex.net/x",
                "http://assets.tcgdex.net/x", "https://assets.tcgdex.net:8443/x", "https://assets.tcg\tdex.net/x",
                " https://assets.tcgdex.net/x", "https://assets.tcgdex.net/x\n", "https://assets.tcgdex.net/" + "a" * 2100):
        set_image(pids["card-1"], bad)
        answer = get(pids["card-1"], v=None)
        assert answer.status_code == 404 and answer.json()["detail"]["code"] == "ART_NOT_FOUND", bad
    assert upstream.count == 0
    set_image(pids["card-1"], BASE)
    assert get(pids["card-1"], v="../../x", url="https://evil.example").status_code == 200
    assert get(pids["card-1"], v=None, host="evil.example").status_code == 200
    assert upstream.urls == [SMALL]
    # A redirect to another host is a failure and that host is never requested.
    set_image(pids["card-2"], "https://assets.tcgdex.net/en/fixture/card-2")
    upstream.responder = lambda request: httpx.Response(302, headers={"location": "https://evil.example/"})
    answer = get(pids["card-2"], v=None)
    assert answer.status_code == 404 and answer.json()["detail"]["code"] == "ART_UNAVAILABLE"
    assert upstream.urls[1:] == ["https://assets.tcgdex.net/en/fixture/card-2/low.webp"]
    assert ledger(pids["card-2"])[0]["reason"] == "redirect"


def timeout(request):
    raise httpx.ReadTimeout("slow", request=request)


FAILURES = {
    "status": lambda request: httpx.Response(404),
    "timeout": timeout,
    "html": lambda request: httpx.Response(200, content=b"<html>", headers={"content-type": "text/html"}),
    "large": lambda request: httpx.Response(200, content=webp(art_store.MAX_BYTES), headers={"content-type": "image/webp"}),
    "svg": lambda request: httpx.Response(200, content=b"<svg/>", headers={"content-type": "image/svg+xml"}),
    "magic": lambda request: httpx.Response(200, content=PNG, headers={"content-type": "image/webp"}),
}


class Chunks(httpx.SyncByteStream):
    """A body with no Content-Length, so only the streaming cap can stop it."""

    def __iter__(self):
        yield webp(0)[:12]
        for _ in range(art_store.MAX_BYTES // 65536 + 2):
            yield b"\0" * 65536


FAILURES["streamed_large"] = lambda request: httpx.Response(200, stream=Chunks(), headers={"content-type": "image/webp"})


@pytest.mark.parametrize("name", FAILURES)
def test_failures_store_nothing_and_back_off(name, pids, upstream, tmp_path):
    upstream.responder = FAILURES[name]
    pid = pids["card-1"]
    answer = get(pid)
    assert answer.status_code == 404 and answer.json()["detail"]["code"] == "ART_UNAVAILABLE"
    assert objects(pid) == [] and [path for path in tmp_path.rglob("*") if path.is_file()] == []
    assert [row["failures"] for row in ledger(pid)] == [1] and upstream.count == 1
    assert get(pid).status_code == 404 and upstream.count == 1
    sql("UPDATE art_fetch_failure SET last_failed_at = now() - interval '61 seconds'")
    assert get(pid).status_code == 404 and upstream.count == 2
    assert [row["failures"] for row in ledger(pid)] == [2]
    # Not due for the longer second wait.
    assert get(pid).status_code == 404 and upstream.count == 2


def test_a_success_clears_the_ledger(pids, upstream):
    upstream.responder = FAILURES["status"]
    get(pids["card-1"])
    upstream.responder = Upstream().responder
    sql("UPDATE art_fetch_failure SET last_failed_at = now() - interval '61 seconds'")
    assert get(pids["card-1"]).status_code == 200
    assert ledger(pids["card-1"]) == []


def test_backoff_schedule():
    assert [backoff_seconds(n) for n in range(1, 9)] == [60, 240, 960, 3840, 15360, 61440, 86400, 86400]


def test_a_changed_source_gets_a_new_version_and_object(pids, upstream):
    pid = pids["card-1"]
    assert get(pid).status_code == 200
    old = objects(pid)[0]
    moved = "https://assets.tcgdex.net/en/fixture/moved"
    before = art_url(pid, BASE)
    set_image(pid, moved)
    after = art_url(pid, moved)
    assert before != after
    answer = get(pid, v=after.split("v=")[1])
    assert answer.status_code == 200 and upstream.urls == [SMALL, moved + "/low.webp"]
    new = objects(pid)[0]
    assert new["source_url"] == moved + "/low.webp" and new["storage_key"] != old["storage_key"]
    assert new["sha256"] == hashlib.sha256(answer.content).hexdigest()
    assert art_storage.storage().get(old["storage_key"]) is None
    assert art_storage.storage().get(new["storage_key"]) == answer.content


def test_row_matches_disk_and_a_missing_or_corrupt_file_is_refetched(pids, upstream, tmp_path):
    pid = pids["card-1"]
    body = get(pid).content
    row = objects(pid)[0]
    assert row["sha256"] == hashlib.sha256(body).hexdigest() and row["byte_size"] == len(body)
    assert row["content_type"] == "image/webp" and row["stored_at"] is not None
    path = tmp_path / row["storage_key"]
    assert path.read_bytes() == body
    path.unlink()
    assert get(pid).content == body and upstream.count == 2 and path.read_bytes() == body
    path.write_bytes(b"corrupt")
    assert get(pid).content == body and upstream.count == 3 and path.read_bytes() == body


def test_each_served_request_counts_a_hit(pids, upstream):
    pid = pids["card-1"]
    seen = []
    for _ in range(3):
        assert get(pid).status_code == 200
        seen.append(sql("SELECT hits, last_hit_at FROM art_hit WHERE printing_id=%s AND size='small'", pid)[0])
    assert [row["hits"] for row in seen] == [1, 2, 3]
    assert seen[0]["last_hit_at"] < seen[1]["last_hit_at"] < seen[2]["last_hit_at"]
    assert get(pid, "medium").status_code == 404
    upstream.responder = FAILURES["status"]
    assert get(pids["card-2"]).status_code == 404
    assert sql("SELECT hits FROM art_hit WHERE printing_id=%s", pid)[0]["hits"] == 3
    assert sql("SELECT count(*) AS n FROM art_hit WHERE printing_id=%s", pids["card-2"])[0]["n"] == 0


def test_a_stale_or_missing_version_is_not_immutable(pids):
    assert get(pids["card-1"]).headers["cache-control"].endswith("immutable")
    for v in ("00000000", None):
        answer = get(pids["card-1"], v=v)
        assert answer.status_code == 200 and answer.content == webp(64)
        assert answer.headers["cache-control"] == "private, no-cache"


def test_requests_across_a_source_change_serialize(pids, upstream, monkeypatch):
    pid = pids["card-1"]
    moved = "https://assets.tcgdex.net/en/fixture/moved"
    resolved = threading.Event()
    real = art_store.resolve

    def spy(conn, printing_id, size):
        found = real(conn, printing_id, size)
        resolved.set()
        return found

    monkeypatch.setattr(art_store, "resolve", spy)
    lock = art_store._lock_for(str(pid), "small")
    pool = ThreadPoolExecutor(1)
    lock.acquire()
    try:
        pending = pool.submit(get, pid, "small", None)
        assert resolved.wait(10)
        set_image(pid, moved)
    finally:
        lock.release()
    answer = pending.result()
    pool.shutdown()
    assert answer.status_code == 200, answer.json()
    assert upstream.urls == [moved + "/low.webp"]
    assert objects(pid)[0]["source_url"] == moved + "/low.webp"


def test_admission_cap_and_lock_timeout_answer_unavailable(pids, upstream, monkeypatch):
    monkeypatch.setattr(art_store, "MAX_ADMITTED", 0)
    answer = get(pids["card-1"])
    assert answer.status_code == 404 and answer.json()["detail"]["code"] == "ART_UNAVAILABLE" and upstream.count == 0
    monkeypatch.undo()
    monkeypatch.setattr(art_store, "LOCK_WAIT", 0.05)
    lock = art_store._lock_for(str(pids["card-1"]), "small")
    lock.acquire()
    try:
        answer = get(pids["card-1"])
    finally:
        lock.release()
    assert answer.status_code == 404 and answer.json()["detail"]["code"] == "ART_UNAVAILABLE"
    assert upstream.count == 0 and ledger(pids["card-1"]) == []


def test_rate_limiter_refuses_a_slot_beyond_the_wait():
    now, slept = [0.0], []
    limiter = RateLimiter(5, clock=lambda: now[0], sleep=slept.append)
    assert all(limiter.try_wait(1.0) for _ in range(6))
    taken = limiter.next_slot
    assert limiter.try_wait(1.0) is False and limiter.next_slot == taken
    assert slept and max(slept) <= 1.0
    now[0] = 5.0
    assert limiter.try_wait(1.0) is True


def test_a_busy_limiter_answers_unavailable_without_a_ledger_entry(pids, upstream, monkeypatch):
    limiter = RateLimiter(1, clock=lambda: 0.0, sleep=lambda seconds: None)
    limiter.next_slot = 60.0
    monkeypatch.setattr(art_store, "_fetcher", ArtFetcher(transport=httpx.MockTransport(upstream.handler), limiter=limiter))
    answer = get(pids["card-1"])
    assert answer.status_code == 404 and answer.json()["detail"]["code"] == "ART_UNAVAILABLE"
    assert upstream.count == 0 and ledger(pids["card-1"]) == []


def test_store_write_failure_serves_without_recording(pids, monkeypatch):
    def refuse(self, key, data):
        raise OSError("disk full")

    monkeypatch.setattr(art_storage.DiskArtStorage, "put", refuse)
    answer = get(pids["card-1"])
    assert answer.status_code == 200 and answer.headers["cache-control"] == "private, no-cache"
    assert objects(pids["card-1"]) == [] and ledger(pids["card-1"]) == []
    assert sql("SELECT hits FROM art_hit WHERE printing_id=%s", pids["card-1"])[0]["hits"] == 1


def test_upstream_requests_carry_the_art_user_agent(pids, upstream, monkeypatch):
    monkeypatch.setenv("ART_FETCH_CONTACT", "owner@example.test")
    seen = []
    fetcher = ArtFetcher(transport=httpx.MockTransport(lambda request: seen.append(request.headers) or upstream.responder(request)))
    fetcher.limiter = RateLimiter(100000)
    fetcher.fetch(SMALL)
    assert seen[0]["user-agent"] == "PrizeCheck-art/1 (+owner@example.test)" and seen[0]["accept-encoding"] == "identity"


def test_an_encoded_answer_is_refused(pids, upstream):
    upstream.responder = lambda request: httpx.Response(200, content=gzip.compress(webp(8)), headers={
        "content-type": "image/webp", "content-encoding": "gzip"})
    assert get(pids["card-1"]).status_code == 404
    assert ledger(pids["card-1"])[0]["reason"] == "content_type"


def test_production_upstream_target_is_identity():
    assert art_store.upstream_target("https://assets.tcgdex.net/a") == "https://assets.tcgdex.net/a"
    assert art_store.upstream_target.__module__ == "app.art_store"


def test_a_streamed_body_over_the_cap_is_too_large(pids, upstream):
    upstream.responder = FAILURES["streamed_large"]
    assert get(pids["card-1"]).status_code == 404
    assert ledger(pids["card-1"])[0]["reason"] == "too_large"


def test_a_same_host_redirect_is_followed_and_too_many_hops_fail(pids, upstream):
    def hop(request):
        if request.url.path.endswith("moved.webp"):
            return httpx.Response(200, content=webp(8), headers={"content-type": "image/webp"})
        return httpx.Response(302, headers={"location": "/en/fixture/moved.webp"})

    upstream.responder = hop
    answer = get(pids["card-1"])
    assert answer.status_code == 200 and answer.content == webp(8)
    assert upstream.urls == [SMALL, "https://assets.tcgdex.net/en/fixture/moved.webp"]
    set_image(pids["card-2"], "https://assets.tcgdex.net/en/fixture/card-2")
    upstream.responder = lambda request: httpx.Response(302, headers={"location": str(request.url) + "x"})
    assert get(pids["card-2"]).status_code == 404
    assert ledger(pids["card-2"])[0]["reason"] == "redirect"


def test_a_deadline_passing_mid_body_is_a_timeout(pids, upstream, monkeypatch):
    now = [0.0]

    def slow(request):
        now[0] += art_store.DEADLINE + 1
        return httpx.Response(200, content=webp(8), headers={"content-type": "image/webp"})

    upstream.responder = slow
    fetcher = ArtFetcher(transport=httpx.MockTransport(upstream.handler), limiter=RateLimiter(100000), clock=lambda: now[0])
    monkeypatch.setattr(art_store, "_fetcher", fetcher)
    assert get(pids["card-1"]).status_code == 404
    assert ledger(pids["card-1"])[0]["reason"] == "timeout"


def test_a_deadline_spent_waiting_for_a_slot_writes_no_ledger_entry(pids, upstream, monkeypatch):
    now = [0.0]
    limiter = RateLimiter(100000)
    real = limiter.try_wait

    def waited(max_wait):
        now[0] += art_store.DEADLINE + 1
        return real(max_wait)

    limiter.try_wait = waited
    monkeypatch.setattr(art_store, "_fetcher", ArtFetcher(transport=httpx.MockTransport(upstream.handler), limiter=limiter,
                                                           clock=lambda: now[0]))
    assert get(pids["card-1"]).status_code == 404
    assert upstream.count == 0 and ledger(pids["card-1"]) == []
