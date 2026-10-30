"""Card art route and read-through store (#358, ADR 0020)."""
import gzip
import hashlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient

from app import art_storage
from app.core.art import store as art_store
from app.core.art.store import ArtFetcher, RateLimiter, backoff_seconds
from app.core.art.urls import art_version
from app.games.pokemon.art import route as art_route
from app.games.pokemon.art.hosts import ALLOWED_HOST
from app.games.pokemon.art.urls import art_url
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
    monkeypatch.setattr(art_route, "_fetcher",
                        ArtFetcher(allowed_host=ALLOWED_HOST, transport=httpx.MockTransport(stub.handler), limiter=RateLimiter(100000)))
    return stub


@pytest.fixture
def pids():
    promote({"card-1": "Pikachu", "card-2": "Raichu"})
    with connect() as conn:
        return {row["source_id"]: row["id"] for row in conn.execute("SELECT id, source_id FROM catalog_printing")}


def assert_unavailable(answer, retry_after=None):
    """A temporary failure: 503 ART_UNAVAILABLE that a client may retry and no cache may keep."""
    assert answer.status_code == 503 and answer.json()["detail"]["code"] == "ART_UNAVAILABLE"
    assert answer.headers["cache-control"] == "no-store"
    assert int(answer.headers["retry-after"]) >= 1
    if retry_after is not None:
        assert int(answer.headers["retry-after"]) <= retry_after
    return True


def get(pid, size="small", v="auto", user=USER, **params):
    path = f"/api/art/{pid}/{size}"
    if v == "auto":
        v = art_version(SMALL)
    if v is not None:
        params["v"] = v
    return client.get(path, params=params, headers=headers(user, "GET", path), follow_redirects=False)


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
    assert_unavailable(answer)
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
    assert_unavailable(answer, 60)
    assert objects(pid) == [] and [path for path in tmp_path.rglob("*") if path.is_file()] == []
    assert [row["failures"] for row in ledger(pid)] == [1] and upstream.count == 1
    backed_off = get(pid)
    assert_unavailable(backed_off, 60) and upstream.count == 1
    assert 55 <= int(backed_off.headers["retry-after"]) <= 60  # the rest of the wait, not the whole of it
    sql("UPDATE art_fetch_failure SET last_failed_at = now() - interval '61 seconds'")
    assert_unavailable(get(pid), 240) and upstream.count == 2
    assert [row["failures"] for row in ledger(pid)] == [2]
    # Not due for the longer second wait.
    assert get(pid).status_code == 503 and upstream.count == 2


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
    answer = get(pids["card-2"])  # no art at all: missing, not temporary
    assert answer.status_code == 404 and answer.json()["detail"]["code"] == "ART_NOT_FOUND"
    assert "retry-after" not in answer.headers
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

    def spy(conn, printing_id, size, **hosts):
        found = real(conn, printing_id, size, **hosts)
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
    assert_unavailable(get(pids["card-1"]), 5) and upstream.count == 0
    monkeypatch.undo()
    monkeypatch.setattr(art_store, "LOCK_WAIT", 0.05)
    lock = art_store._lock_for(str(pids["card-1"]), "small")
    lock.acquire()
    try:
        answer = get(pids["card-1"])
    finally:
        lock.release()
    assert_unavailable(answer, 5)
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
    monkeypatch.setattr(art_route, "_fetcher", ArtFetcher(allowed_host=ALLOWED_HOST, transport=httpx.MockTransport(upstream.handler), limiter=limiter))
    assert_unavailable(get(pids["card-1"]), 5)
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
    fetcher = ArtFetcher(allowed_host=ALLOWED_HOST, transport=httpx.MockTransport(lambda request: seen.append(request.headers) or upstream.responder(request)))
    fetcher.limiter = RateLimiter(100000)
    fetcher.fetch(SMALL)
    assert seen[0]["user-agent"] == "PrizeCheck-art/1 (+owner@example.test)" and seen[0]["accept-encoding"] == "identity"


def test_an_encoded_answer_is_refused(pids, upstream):
    upstream.responder = lambda request: httpx.Response(200, content=gzip.compress(webp(8)), headers={
        "content-type": "image/webp", "content-encoding": "gzip"})
    assert_unavailable(get(pids["card-1"]))
    assert ledger(pids["card-1"])[0]["reason"] == "content_type"


def test_production_upstream_target_is_identity():
    assert art_store.upstream_target("https://assets.tcgdex.net/a") == "https://assets.tcgdex.net/a"
    assert art_store.upstream_target.__module__ == "app.core.art.store"


def test_a_streamed_body_over_the_cap_is_too_large(pids, upstream):
    upstream.responder = FAILURES["streamed_large"]
    assert_unavailable(get(pids["card-1"]))
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
    assert_unavailable(get(pids["card-2"]))
    assert ledger(pids["card-2"])[0]["reason"] == "redirect"


def test_a_deadline_passing_mid_body_is_a_timeout(pids, upstream, monkeypatch):
    now = [0.0]

    def slow(request):
        now[0] += art_store.DEADLINE + 1
        return httpx.Response(200, content=webp(8), headers={"content-type": "image/webp"})

    upstream.responder = slow
    fetcher = ArtFetcher(allowed_host=ALLOWED_HOST, transport=httpx.MockTransport(upstream.handler), limiter=RateLimiter(100000), clock=lambda: now[0])
    monkeypatch.setattr(art_route, "_fetcher", fetcher)
    assert_unavailable(get(pids["card-1"]))
    assert ledger(pids["card-1"])[0]["reason"] == "timeout"


def test_a_deadline_spent_waiting_for_a_slot_writes_no_ledger_entry(pids, upstream, monkeypatch):
    now = [0.0]
    limiter = RateLimiter(100000)
    real = limiter.try_wait

    def waited(max_wait):
        now[0] += art_store.DEADLINE + 1
        return real(max_wait)

    limiter.try_wait = waited
    monkeypatch.setattr(art_route, "_fetcher", ArtFetcher(allowed_host=ALLOWED_HOST, transport=httpx.MockTransport(upstream.handler), limiter=limiter,
                                                           clock=lambda: now[0]))
    assert_unavailable(get(pids["card-1"]))
    assert upstream.count == 0 and ledger(pids["card-1"]) == []


@pytest.fixture
def candidate(pids, monkeypatch):
    from app.games.pokemon.art.hosts import TCGPLAYER_HOST, TCGPLAYER_LARGE
    monkeypatch.setenv('ART_TCGPLAYER_SOURCE', 'on')
    stub = Upstream()
    from test_art_dimensions import jpeg
    stub.responder = lambda request: httpx.Response(200, content=jpeg(), headers={'content-type':'image/jpeg'})
    monkeypatch.setattr(art_route, '_tcgplayer_fetcher', ArtFetcher(allowed_host=TCGPLAYER_HOST,
        path_pattern=TCGPLAYER_LARGE, transport=httpx.MockTransport(stub.handler), limiter=RateLimiter(100000)))
    with connect() as conn:
        conn.execute('INSERT INTO catalog_printing_art_product(printing_id,product_id) VALUES (%s,123)', (pids['card-1'],))
    return stub


def comparison(pid):
    with connect() as conn:
        return conn.execute('SELECT * FROM art_large_upgrade WHERE printing_id=%s',(pid,)).fetchone()


def test_sharper_tcgplayer_large_is_stored_and_served_after_one_view(pids, upstream, candidate):
    pid = pids['card-1']
    assert get(pid,'large').headers['content-type'] == 'image/jpeg'
    assert get(pid,'large').status_code == 200
    assert candidate.count == 1 and upstream.count == 0
    with connect() as conn:
        assert conn.execute("SELECT source_url FROM art_object WHERE printing_id=%s AND size='large'",(pid,)).fetchone()['source_url'] == candidate.urls[0]
    assert comparison(pid)['outcome'] == 'won'


def test_smaller_tcgplayer_large_keeps_tcgdex_and_is_not_refetched(pids, upstream, candidate):
    from test_art_dimensions import jpeg
    candidate.responder = lambda request: httpx.Response(200,content=jpeg(600,825),headers={'content-type':'image/jpeg'})
    for _ in range(3):
        assert get(pids['card-1'],'large').content == webp(64)
    assert candidate.count == 1 and comparison(pids['card-1'])['outcome'] == 'lost'


@pytest.mark.parametrize('width,height,status', [(600,825,200),(200,280,302)])
def test_tcgplayer_only_large_is_stored_not_redirected(pids, candidate, width, height, status):
    from test_art_dimensions import jpeg
    pid = pids['card-2']
    with connect() as conn:
        conn.execute('INSERT INTO catalog_printing_fallback_art(printing_id,product_id) VALUES (%s,123)', (pid,))
    candidate.responder = lambda request: httpx.Response(200,content=jpeg(width,height),headers={'content-type':'image/jpeg'})
    answer = get(pid,'large')
    assert answer.status_code == status
    if status == 302:
        assert answer.headers['location'].endswith('_400w.jpg')
    else:
        assert answer.headers['content-type'] == 'image/jpeg'


@pytest.mark.parametrize('fallback', [False,True])
def test_setting_off_behaves_as_today(pids, candidate, monkeypatch, fallback):
    pid = pids['card-2' if fallback else 'card-1']
    if fallback:
        with connect() as conn:
            conn.execute('INSERT INTO catalog_printing_fallback_art(printing_id,product_id) VALUES (%s,123)', (pid,))
    assert get(pid,'large').status_code == 200
    monkeypatch.setenv('ART_TCGPLAYER_SOURCE','off')
    answer = get(pid,'large')
    assert candidate.count == 1
    assert answer.status_code == (302 if fallback else 200)
    if not fallback:
        assert answer.content == webp(64)
        with connect() as conn:
            assert conn.execute("SELECT source_url FROM art_object WHERE printing_id=%s AND size='large'",(pid,)).fetchone()['source_url'] == LARGE


def test_version_changes_with_the_large_source(pids, candidate):
    pid = pids['card-1']
    with connect() as conn:
        before = conn.execute('SELECT art_version FROM catalog_printing_art WHERE printing_id=%s',(pid,)).fetchone()['art_version']
    get(pid,'large')
    with connect() as conn:
        after = conn.execute('SELECT art_version FROM catalog_printing_art WHERE printing_id=%s',(pid,)).fetchone()['art_version']
    assert before != after
    assert get(pid,'large',v=after).headers['cache-control'] == art_store.IMMUTABLE
    assert get(pid,'large',v=before).headers['cache-control'] == art_store.REVALIDATE
    for version in (before,after):
        assert get(pid,'small',v=version).headers['cache-control'] == art_store.IMMUTABLE


def test_candidate_failure_backs_off_and_falls_back_to_base(pids, candidate):
    candidate.responder = lambda request: httpx.Response(500)
    for _ in range(2):
        assert get(pids['card-1'],'large').content == webp(64)
    assert candidate.count == 1 and comparison(pids['card-1'])['outcome'] == 'failed'


def test_tcgplayer_fetcher_refuses_other_paths():
    from app.games.pokemon.art.hosts import TCGPLAYER_HOST, TCGPLAYER_LARGE
    urls=[]
    def handler(request):
        urls.append(str(request.url))
        return httpx.Response(302,headers={'location':'/product/124_400w.jpg'})
    fetcher=ArtFetcher(allowed_host=TCGPLAYER_HOST,path_pattern=TCGPLAYER_LARGE,
                       transport=httpx.MockTransport(handler),limiter=RateLimiter(100000))
    for suffix in ('400w.jpg','1000x1000.jpg'):
        with pytest.raises(art_store.FetchFailed,match='redirect'):
            fetcher.fetch(f'https://{TCGPLAYER_HOST}/product/123_{suffix}')
    assert urls == []
    with pytest.raises(art_store.FetchFailed,match='redirect'):
        fetcher.fetch(f'https://{TCGPLAYER_HOST}/product/123_in_1000x1000.jpg')
    assert len(urls)==1


def test_candidate_write_failure_does_not_record_a_win(pids, candidate, monkeypatch):
    def broken(*args):
        raise OSError('disk full')
    monkeypatch.setattr(art_storage.DiskArtStorage, 'put', broken)
    answer = get(pids['card-1'],'large')
    assert answer.status_code == 200 and answer.headers['cache-control'] == art_store.REVALIDATE
    assert comparison(pids['card-1']) is None


def test_busy_candidate_falls_back_without_a_comparison(pids, candidate, monkeypatch):
    def busy(*args):
        raise art_store.Busy()
    monkeypatch.setattr(art_route._tcgplayer_fetcher,'fetch',busy)
    assert get(pids['card-1'],'large').content == webp(64)
    assert comparison(pids['card-1']) is None


def test_purge_tcgplayer_restores_version_and_keeps_base_objects(pids, candidate, monkeypatch):
    import runpy
    from pathlib import Path
    pid = pids['card-1']
    get(pid,'small')
    get(pid,'large')
    old_key = next(row['storage_key'] for row in objects(pid) if row['size'] == 'large')
    tool = runpy.run_path(str(Path(__file__).resolve().parents[2] / 'scripts' / 'art_store.py'))
    assert tool['purge_tcgplayer']() == 2
    monkeypatch.setenv('ART_TCGPLAYER_SOURCE','off')
    assert tool['purge_tcgplayer']() == 0
    assert comparison(pid) is None
    assert [row['size'] for row in objects(pid)] == ['small']
    assert art_storage.storage().get(old_key) is None
    with connect() as conn:
        assert conn.execute('SELECT art_version FROM catalog_printing_art WHERE printing_id=%s',(pid,)).fetchone()['art_version'] == art_version(SMALL)


@pytest.mark.parametrize('replacement,outcome', [('win', 'won'), ('small', 'lost'), ('failure', 'failed')])
@pytest.mark.parametrize('fallback', [False, True])
def test_missing_winner_is_remeasured_and_falls_back(pids, candidate, upstream, replacement, outcome, fallback):
    from test_art_dimensions import jpeg
    pid = pids['card-2' if fallback else 'card-1']
    if fallback:
        with connect() as conn:
            conn.execute('INSERT INTO catalog_printing_fallback_art(printing_id,product_id) VALUES (%s,123)', (pid,))
    assert get(pid, 'large').status_code == 200
    obj = next(row for row in objects(pid) if row['size'] == 'large')
    art_storage.storage().delete(obj['storage_key'])
    data = jpeg(800, 1100) if replacement == 'win' else jpeg(200, 280)
    candidate.responder = lambda request: (httpx.Response(500) if replacement == 'failure' else
        httpx.Response(200, content=data, headers={'content-type': 'image/jpeg'}))
    answer = get(pid, 'large')
    assert comparison(pid)['outcome'] == outcome
    if replacement == 'win':
        assert answer.status_code == 200 and answer.content == data
        assert (comparison(pid)['width'], comparison(pid)['height']) == (800, 1100)
    elif fallback:
        assert answer.status_code == 302 and answer.headers['location'].endswith('_400w.jpg')
    else:
        assert answer.status_code == 200 and answer.content == webp(64)
    assert candidate.count == 2
    assert get(pid, 'large').status_code == answer.status_code
    assert candidate.count == 2


def test_off_on_recovery_remeasures_the_candidate(pids, candidate, monkeypatch):
    from test_art_dimensions import jpeg
    pid = pids['card-1']
    assert get(pid, 'large').headers['content-type'] == 'image/jpeg'
    monkeypatch.setenv('ART_TCGPLAYER_SOURCE', 'off')
    assert get(pid, 'large').content == webp(64)
    monkeypatch.setenv('ART_TCGPLAYER_SOURCE', 'on')
    candidate.responder = lambda request: httpx.Response(200, content=jpeg(200, 280), headers={'content-type': 'image/jpeg'})
    assert get(pid, 'large').content == webp(64)
    assert comparison(pid)['outcome'] == 'lost'
    assert (comparison(pid)['width'], comparison(pid)['height']) == (200, 280)
    assert candidate.count == 2


def test_purge_keeps_a_concurrently_replaced_base_row_and_pointer(pids, candidate, monkeypatch):
    import runpy
    from contextlib import contextmanager
    from pathlib import Path
    from app.core.art.public import read_pointer
    pid = pids['card-1']
    assert get(pid, 'large').status_code == 200
    monkeypatch.setenv('ART_TCGPLAYER_SOURCE', 'off')
    tool = runpy.run_path(str(Path(__file__).resolve().parents[2] / 'scripts' / 'art_store.py'))
    purge = tool['purge_tcgplayer']
    replaced = []

    class Interleaved:
        def __init__(self, conn):
            self.conn = conn

        def transaction(self):
            return self.conn.transaction()

        def execute(self, sql, params=None):
            if sql.startswith('DELETE FROM art_object') and not replaced:
                assert get(pid, 'large').content == webp(64)
                replaced.append(next(row for row in objects(pid) if row['size'] == 'large'))
            return self.conn.execute(sql, params)

    @contextmanager
    def interleaved_connect():
        with connect() as conn:
            yield Interleaved(conn)

    monkeypatch.setitem(purge.__globals__, 'connect', interleaved_connect)
    assert purge() == 0
    assert objects(pid) == replaced
    assert art_storage.storage().get(replaced[0]['storage_key']) == webp(64)
    with connect() as conn:
        ref = conn.execute('SELECT public_ref FROM catalog_printing WHERE id=%s', (pid,)).fetchone()['public_ref']
    assert read_pointer(ref, 'large')['key'] == replaced[0]['storage_key']
