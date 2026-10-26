"""Scanner fingerprint index job (#312; plumbing D4 and "Fingerprint file PCFP v1"): scripts/scanner_index_job.py.

Everything runs against a stub embedder and a stub fetcher: the API venv has no onnxruntime, OpenCV or numpy, and no test
here reaches the network. The one real-model test is marked slow and runs only in the job image's CI step (it skips
itself wherever onnxruntime is missing). This file imports no `app` module, so that step can run it from the image.
"""
import builtins
import hashlib
import importlib.util
import json
import os
import random
import re
import struct
import threading
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import psycopg
import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("scanner_index_job", ROOT / "scripts" / "scanner_index_job.py")
job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job)

MODEL = job.load_model(models_dir="/nonexistent")
BASE = "https://assets.tcgdex.net/en/fx"
FIXTURE = ROOT / "web" / "src" / "scanner" / "fixtures" / "parity" / "pcfp5.bin"


def db():
    return psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)


# --- Stubs -------------------------------------------------------------------------------------------------------------


class StubFetcher:
    """url -> image bytes by default; `broken` urls fail; every call is recorded."""

    def __init__(self, same_as=None):
        self.calls, self.broken, self.same_as = [], set(), same_as or {}
        self.lock = threading.Lock()

    def fetch(self, url):
        with self.lock:
            self.calls.append(url)
        if url in self.broken:
            raise job.FetchError("stub failure")
        return f"IMAGE-BYTES<{self.same_as.get(url, url)}>".encode()


class StubEmbedder:
    """A deterministic unit vector per image bytes."""

    def embed(self, data):
        rng = random.Random(data)
        vector = [rng.gauss(0, 1) for _ in range(job.DIM)]
        norm = sum(x * x for x in vector) ** 0.5
        return [job._f32(x / norm) for x in vector]


class Forbidden:
    def __init__(self, *args):
        raise AssertionError("the network and the model must stay unused")


def run(fetcher=None, full=False, embedder=None, database_url=None, **extra):
    fetcher = fetcher or StubFetcher()
    return job.run(database_url, model=MODEL, full=full, make_fetcher=lambda: fetcher,
                   make_embedder=lambda model: embedder or StubEmbedder(), workers=2, log=lambda *_: None, **extra)


# --- Catalog fixture ---------------------------------------------------------------------------------------------------


def reset():
    with db() as conn:
        conn.execute("TRUNCATE catalog_review,catalog_generation_edition,catalog_generation_printing,catalog_edition,"
                     "catalog_printing,catalog_identity,catalog_generation,catalog_run,scanner_fingerprint,"
                     "scanner_fingerprint_failure,scanner_index CASCADE")
        conn.execute("INSERT INTO catalog_state(singleton,active_generation,revision,last_success) VALUES (true,NULL,0,NULL) "
                     "ON CONFLICT(singleton) DO UPDATE SET active_generation=NULL,revision=0,last_success=NULL")


def seed(count, *, start=0, ids=None):
    """Adds printings fx-<start>.. to the active generation (creating it first), each with a distinct image_url."""
    ids = ids or [uuid4() for _ in range(count)]
    with db() as conn:
        state = conn.execute("SELECT active_generation FROM catalog_state").fetchone()
        generation = state[0]
        if generation is None:
            generation = uuid4()
            conn.execute("INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,0,'\\x00','x')",
                         (generation,))
            conn.execute("UPDATE catalog_state SET active_generation=%s,revision=1", (generation,))
        for offset, pid in enumerate(ids):
            n = start + offset
            identity = uuid4()
            conn.execute("INSERT INTO catalog_identity(id,identity_key,display_name) VALUES (%s,%s,%s)",
                         (identity, f"identity-{pid}", f"Card {n}"))
            conn.execute("INSERT INTO catalog_printing(id,source,source_id,identity_id) VALUES (%s,'tcgdex',%s,%s)",
                         (pid, f"fx-{pid}", identity))
            conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,
                 collector_number,display_name,search_name,image_url,source_fingerprint,basic_energy)
                 VALUES (%s,%s,%s,'fx','Fixture',%s,%s,%s,%s,'f','not_basic')""",
                         (generation, pid, f"fx-{pid}", str(n), f"Card {n}", f"card {n}", f"{BASE}/{n}"))
    return ids


def url_of(pid):
    with db() as conn:
        return conn.execute("SELECT image_url FROM catalog_generation_printing WHERE printing_id=%s", (pid,)).fetchone()[0]


def set_url(pid, url):
    with db() as conn:
        conn.execute("UPDATE catalog_generation_printing SET image_url=%s WHERE printing_id=%s", (url, pid))


def artifacts():
    with db() as conn:
        return conn.execute("SELECT sha256,model_id,catalog_revision,inputs_digest,count,inputs_count,bytes "
                            "FROM scanner_index ORDER BY created_at,sha256").fetchall()


def ledger():
    with db() as conn:
        return {row[0]: row[1:] for row in conn.execute(
            "SELECT printing_id,image_url,failures FROM scanner_fingerprint_failure")}


def age_failures(interval):
    with db() as conn:
        conn.execute("UPDATE scanner_fingerprint_failure SET last_failed_at = now() - %s::interval", (interval,))


# --- Pure pieces -------------------------------------------------------------------------------------------------------


def test_model_id_is_the_one_the_web_build_carries():
    declared = re.search(r'SCANNER_MODEL_ID = "([^"]+)"', (ROOT / "web" / "src" / "scanner" / "models.ts").read_text())
    assert MODEL.id == declared[1]
    assert re.fullmatch(r"[0-9a-f]{64}", MODEL.sha256)
    assert MODEL.path == Path("/nonexistent") / MODEL.sha256[:16] / MODEL.name


def test_backoff_is_an_hour_times_four_to_the_failures_less_one_up_to_seven_days():
    hour = 3600
    assert [job.backoff_seconds(n) for n in range(1, 8)] == [hour, 4 * hour, 16 * hour, 64 * hour, 7 * 24 * hour,
                                                              7 * 24 * hour, 7 * 24 * hour]


def test_quantize_scales_by_the_largest_value_and_rounds_half_to_even():
    scale, q = job.quantize([1.0, -0.5, 0.0, 0.3] + [0.0] * (job.DIM - 4))
    assert scale == struct.unpack("<f", struct.pack("<f", 1.0 / 127))[0]
    assert list(struct.unpack(f"<{job.DIM}b", q)[:4]) == [127, -64, 0, 38]  # -63.5 rounds to -64, 38.1 to 38
    scale, q = job.quantize([0.0] * job.DIM)
    assert scale == 0.0 and q == bytes(job.DIM)
    scale, q = job.quantize([-2.0] + [2.0] * (job.DIM - 1))
    assert struct.unpack(f"<{job.DIM}b", q)[0] == -127 and set(struct.unpack(f"<{job.DIM}b", q)[1:]) == {127}


@pytest.mark.parametrize("vector", [[0.0] * 10, [float("nan")] + [0.0] * (job.DIM - 1), [float("inf")] * job.DIM])
def test_quantize_refuses_a_vector_that_is_not_384_finite_numbers(vector):
    with pytest.raises(job.EmbedError):
        job.quantize(vector)


def test_pack_reproduces_the_fixture_the_phone_reads():
    data = FIXTURE.read_bytes()
    count = struct.unpack_from("<I", data, 8)[0]
    ids = [UUID(bytes=data[44 + 16 * i:60 + 16 * i]) for i in range(count)]
    scales = struct.unpack_from(f"<{count}f", data, 44 + 16 * count)
    base = 44 + 20 * count
    rows = [(ids[i], scales[i], data[base + job.DIM * i:base + job.DIM * (i + 1)]) for i in range(count)]
    assert job.pack_pcfp(data[12:44].hex(), reversed(rows)) == data


def test_inputs_digest_is_sha256_of_canonical_json():
    a, b = UUID(int=1), UUID(int=2)
    expected = hashlib.sha256(
        b'{"model":"m","printings":[["00000000-0000-0000-0000-000000000001","https://x/1"],'
        b'["00000000-0000-0000-0000-000000000002","https://x/\xc3\xa9"]]}').hexdigest()
    assert job.inputs_digest("m", [(a, "https://x/1"), (b, "https://x/é")]) == expected


# --- The fetcher -------------------------------------------------------------------------------------------------------


def fetcher_for(handler, limiter=None, **extra):
    return job.TcgdexFetcher("owner@example.test", limiter=limiter or job.RateLimiter(1000),
                             transport=httpx.MockTransport(handler), **extra)


def test_fetch_asks_for_low_webp_with_the_user_agent_and_keeps_bytes_in_memory():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, content=b"webp")

    assert fetcher_for(handler).fetch(f"{BASE}/7") == b"webp"
    assert str(seen[0].url) == f"{BASE}/7/low.webp"
    assert seen[0].headers["user-agent"] == "PrizeCheck-scanner-index/1 (+owner@example.test)"


@pytest.mark.parametrize("url", ["https://example.com/a", "http://assets.tcgdex.net/a", "https://tcgdex.net.evil.test/a",
                                 "https://eviltcgdex.net/a", "file:///etc/passwd",
                                 "https://user:pw@assets.tcgdex.net/a", "https://assets.tcgdex.net@evil.test/a",
                                 "https://assets.tcgdex.net:8443/a", "https://assets.tcgdex.net:bad/a"])
def test_fetch_refuses_hosts_outside_tcgdex(url):
    seen = []
    with pytest.raises(job.FetchError):
        fetcher_for(lambda request: seen.append(request)).fetch(url)
    assert seen == []


def test_fetch_allows_other_tcgdex_subdomains_and_follows_redirects_within_them():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if request.url.host == "assets.tcgdex.net":
            return httpx.Response(302, headers={"location": "https://cdn.tcgdex.net/real.webp"})
        return httpx.Response(200, content=b"ok")

    assert fetcher_for(handler).fetch(f"{BASE}/1") == b"ok"
    assert seen == [f"{BASE}/1/low.webp", "https://cdn.tcgdex.net/real.webp"]


def test_fetch_refuses_an_off_host_redirect_without_requesting_it():
    seen = []

    def handler(request):
        seen.append(request.url.host)
        return httpx.Response(302, headers={"location": "https://evil.example/steal.webp"})

    with pytest.raises(job.FetchError):
        fetcher_for(handler).fetch(f"{BASE}/1")
    assert seen == ["assets.tcgdex.net"]


def test_fetch_tries_twice_on_server_errors_and_timeouts_but_not_on_a_missing_image():
    calls = []

    def flaky(request):
        calls.append(1)
        return httpx.Response(503) if len(calls) == 1 else httpx.Response(200, content=b"second")

    assert fetcher_for(flaky).fetch(f"{BASE}/1") == b"second" and len(calls) == 2
    calls.clear()

    def always_down(request):
        calls.append(1)
        raise httpx.ConnectTimeout("slow")

    with pytest.raises(job.FetchError):
        fetcher_for(always_down).fetch(f"{BASE}/1")
    assert len(calls) == 2
    calls.clear()

    def missing(request):
        calls.append(1)
        return httpx.Response(404)

    with pytest.raises(job.FetchError):
        fetcher_for(missing).fetch(f"{BASE}/1")
    assert len(calls) == 1


def test_fetch_allows_an_explicit_port_443():
    assert fetcher_for(lambda r: httpx.Response(200, content=b"ok")).fetch("https://assets.tcgdex.net:443/en/x") == b"ok"


def test_a_429_waits_for_retry_after_capped_at_thirty_seconds_before_the_second_try():
    slept, answers = [], [httpx.Response(429, headers={"retry-after": "120"}), httpx.Response(200, content=b"ok")]
    assert fetcher_for(lambda r: answers.pop(0), sleep=slept.append).fetch(f"{BASE}/1") == b"ok"
    assert slept == [30]
    slept.clear()
    answers[:] = [httpx.Response(429, headers={"retry-after": "3"}), httpx.Response(200, content=b"ok")]
    fetcher_for(lambda r: answers.pop(0), sleep=slept.append).fetch(f"{BASE}/1")
    assert slept == [3]
    slept.clear()
    answers[:] = [httpx.Response(429, headers={"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"}), httpx.Response(200, content=b"ok")]
    fetcher_for(lambda r: answers.pop(0), sleep=slept.append).fetch(f"{BASE}/1")
    assert slept == []
    answers[:] = [httpx.Response(429, headers={"retry-after": "5"}), httpx.Response(429, headers={"retry-after": "5"})]
    with pytest.raises(job.FetchError):
        fetcher_for(lambda r: answers.pop(0), sleep=slept.append).fetch(f"{BASE}/1")
    assert slept == [5]  # no wait after the last try


def test_the_whole_request_has_a_twenty_second_deadline():
    now = [0.0]
    calls = []

    class Slow(httpx.SyncByteStream):
        def __iter__(self):
            for _ in range(3):
                now[0] += 15  # a trickle: each chunk arrives inside any per-read timeout
                yield b"x"

    def handler(request):
        calls.append(1)
        return httpx.Response(200, stream=Slow())

    with pytest.raises(job.FetchError):
        fetcher_for(handler, clock=lambda: now[0], sleep=lambda s: None).fetch(f"{BASE}/1")
    assert len(calls) == 2  # timed out, tried once more, timed out


def test_fetch_refuses_an_oversized_image():
    with pytest.raises(job.FetchError):
        fetcher_for(lambda request: httpx.Response(200, content=b"x" * (job.MAX_IMAGE_BYTES + 1))).fetch(f"{BASE}/1")


def test_the_rate_limiter_allows_five_requests_a_second():
    now = [0.0]
    slept = []

    def sleep(seconds):
        slept.append(seconds)
        now[0] += seconds

    limiter = job.RateLimiter(5, clock=lambda: now[0], sleep=sleep)
    for _ in range(11):
        limiter.wait()
    assert now[0] == pytest.approx(2.0)  # the 11th call starts 10 intervals of 0.2 s after the first
    assert all(s == pytest.approx(0.2) for s in slept)


def test_every_request_of_a_try_takes_a_slot():
    slots = []

    class Counting:
        def wait(self):
            slots.append(1)

    def handler(request):
        if request.url.host == "assets.tcgdex.net":
            return httpx.Response(301, headers={"location": "https://cdn.tcgdex.net/x.webp"})
        return httpx.Response(503)

    with pytest.raises(job.FetchError):
        fetcher_for(handler, limiter=Counting()).fetch(f"{BASE}/1")
    assert len(slots) == 4  # two tries, each a redirect and a final request


# --- The run -----------------------------------------------------------------------------------------------------------


def expected_file(ids_and_urls):
    """The PCFP bytes the stub embedder's vectors must produce, assembled here by hand from the resolution's table."""
    rows = []
    for pid, url in ids_and_urls:
        vector = StubEmbedder().embed(f"IMAGE-BYTES<{url}>".encode())
        rows.append((pid, vector))
    rows.sort(key=lambda row: row[0].bytes)
    out = b"PCFP" + (1).to_bytes(2, "little") + (384).to_bytes(2, "little") + len(rows).to_bytes(4, "little")
    out += bytes.fromhex(MODEL.sha256)
    out += b"".join(pid.bytes for pid, _ in rows)
    scales, vectors = [], b""
    for _, vector in rows:
        m = struct.unpack("<f", struct.pack("<f", max(abs(x) for x in vector) / 127))[0]
        scales.append(m)
        q = [max(-127, min(127, round(struct.unpack("<f", struct.pack("<f", x / m))[0]))) for x in vector]
        vectors += b"".join(v.to_bytes(1, "little", signed=True) for v in q)
    return out + b"".join(struct.pack("<f", s) for s in scales) + vectors


def test_the_published_file_has_the_pcfp_layout_byte_for_byte_on_three_printings():
    reset()
    ids = seed(3, ids=[UUID("f0000000-0000-4000-8000-000000000001"), UUID("0a000000-0000-4000-8000-000000000002"),
                       UUID("7c000000-0000-4000-8000-000000000003")])
    assert run() == 0
    (sha, model_id, revision, digest, count, inputs_count, data), = artifacts()
    want = expected_file([(pid, url_of(pid)) for pid in ids])
    assert data == want and len(data) == 44 + 404 * 3
    assert sha == hashlib.sha256(want).hexdigest() and model_id == MODEL.id
    assert (revision, count, inputs_count) == (1, 3, 3)
    assert data[:12] == b"PCFP\x01\x00\x80\x01\x03\x00\x00\x00" and data[12:44] == bytes.fromhex(MODEL.sha256)
    assert data[44:92] == b"".join(pid.bytes for pid in sorted(ids, key=lambda p: p.bytes))  # ascending UUID bytes
    printings = sorted((pid, url_of(pid)) for pid in ids)
    assert digest == hashlib.sha256(json.dumps(
        {"model": MODEL.id, "printings": [[str(pid), url] for pid, url in printings]},
        sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    with db() as conn:
        row = conn.execute("SELECT scale,vector FROM scanner_fingerprint WHERE printing_id=%s", (ids[0],)).fetchone()
    assert len(bytes(row[1])) == 384 and row[0] > 0


def test_tombstoned_printings_and_printings_without_art_are_not_inputs():
    reset()
    ids = seed(4)
    with db() as conn:
        conn.execute("UPDATE catalog_generation_printing SET tombstoned=true WHERE printing_id=%s", (ids[0],))
        conn.execute("UPDATE catalog_generation_printing SET image_url=NULL WHERE printing_id=%s", (ids[1],))
    fetcher = StubFetcher()
    assert run(fetcher) == 0
    assert sorted(fetcher.calls) == sorted(f"{url_of(pid)}" for pid in ids[2:])
    assert artifacts()[0][4:6] == (2, 2)


def test_an_empty_catalog_exits_zero_and_publishes_nothing():
    reset()
    assert run(StubFetcher()) == 0 and artifacts() == []
    seed(0)
    assert run(StubFetcher()) == 0 and artifacts() == []


def test_artifacts_are_pruned_to_the_newest_two():
    reset()
    ids = seed(3)
    shas = []
    for n in range(4):
        assert run() == 0
        shas.append(artifacts()[-1][0])
        set_url(ids[0], f"{BASE}/changed-{n}")
    assert len(set(shas)) == 4
    kept = artifacts()
    assert [row[0] for row in kept] == shas[-2:]
    assert all(row[1] == MODEL.id for row in kept)


def test_an_unchanged_sha_only_updates_the_revision_digest_and_count():
    reset()
    ids = seed(3)
    assert run() == 0
    before, = artifacts()
    with db() as conn:
        created = conn.execute("SELECT created_at FROM scanner_index").fetchone()[0]
    # Another url that serves the same picture: new digest, same vector, same file bytes.
    original = url_of(ids[0])
    set_url(ids[0], f"{BASE}/moved")
    with db() as conn:
        conn.execute("UPDATE catalog_state SET revision = revision + 5")
    fetcher = StubFetcher(same_as={f"{BASE}/moved": original})
    assert run(fetcher) == 0
    assert fetcher.calls == [f"{BASE}/moved"]
    after, = artifacts()
    assert after[0] == before[0] and after[6] == before[6]
    assert after[2] == 6 and after[3] != before[3] and after[4:6] == (3, 3)
    with db() as conn:
        assert conn.execute("SELECT created_at FROM scanner_index").fetchone()[0] == created


def test_image_bytes_are_never_written_to_disk_or_the_database(tmp_path, monkeypatch):
    reset()
    seed(3)
    opened = []
    real_open = builtins.open

    def spy(file, mode="r", *args, **kwargs):
        if any(flag in str(mode) for flag in "wax+"):
            opened.append(file)
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", spy)
    monkeypatch.chdir(tmp_path)
    assert run() == 0
    monkeypatch.undo()
    assert opened == [] and list(tmp_path.iterdir()) == []
    with db() as conn:
        for table, column in (("scanner_index", "bytes"), ("scanner_fingerprint", "vector")):
            assert conn.execute(f"SELECT count(*) FROM {table} WHERE position('\\x494d4147452d4259544553'::bytea in {column}) > 0"
                                ).fetchone()[0] == 0  # "IMAGE-BYTES"


def test_unchanged_inputs_use_no_network_and_no_model():
    reset()
    seed(5)
    assert run() == 0
    before = artifacts()
    assert job.run(None, model=MODEL, make_fetcher=Forbidden, make_embedder=Forbidden, log=lambda *_: None) == 0
    assert artifacts() == before


def test_a_changed_input_set_with_nothing_to_fetch_publishes_without_the_network():
    reset()
    ids = seed(5)
    assert run() == 0
    with db() as conn:
        conn.execute("UPDATE catalog_generation_printing SET tombstoned=true WHERE printing_id=%s", (ids[0],))
    assert job.run(None, model=MODEL, make_fetcher=Forbidden, make_embedder=Forbidden, log=lambda *_: None) == 0
    assert [row[4:6] for row in artifacts()] == [(5, 5), (4, 4)]


def test_full_fetches_every_printing_again():
    reset()
    seed(4)
    assert run() == 0
    fetcher = StubFetcher()
    assert run(fetcher, full=True) == 0
    assert len(fetcher.calls) == 4 and len(artifacts()) == 1


def test_failed_printing_retried_when_due():
    reset()
    ids = seed(100)
    fetcher = StubFetcher()
    fetcher.broken = {url_of(ids[7])}
    assert run(fetcher) == 0
    assert ledger() == {ids[7]: (url_of(ids[7]), 1)}
    first, = artifacts()
    assert first[4:6] == (99, 100)
    # Inside the hour: nothing is due, so nothing is fetched.
    again = StubFetcher()
    assert run(again) == 0 and again.calls == []
    # Past the hour it is due; it fails again and the next wait is 4 hours.
    age_failures("61 minutes")
    fetcher = StubFetcher()
    fetcher.broken = {url_of(ids[7])}
    assert run(fetcher) == 0
    assert fetcher.calls == [url_of(ids[7])] and ledger() == {ids[7]: (url_of(ids[7]), 2)}
    age_failures("3 hours")
    quiet = StubFetcher()
    assert run(quiet) == 0 and quiet.calls == []
    age_failures("5 hours")
    healed = StubFetcher()
    assert run(healed) == 0
    assert healed.calls == [url_of(ids[7])] and ledger() == {}
    latest = artifacts()[-1]
    assert latest[4:6] == (100, 100) and latest[0] != first[0]


def test_permanent_failures_do_not_block_new_set():
    reset()
    ids = seed(100)
    fetcher = StubFetcher()
    fetcher.broken = {url_of(ids[0])}
    assert run(fetcher) == 0
    seed(20, start=100)  # a new set arrives while one image stays broken
    fetcher = StubFetcher()
    fetcher.broken = {url_of(ids[0])}
    assert run(fetcher) == 0
    assert len(fetcher.calls) == 20 and url_of(ids[0]) not in fetcher.calls  # the broken one waits out its backoff
    latest = artifacts()[-1]
    assert latest[4:6] == (119, 120)
    assert ledger()[ids[0]][1] == 1


def test_systemic_failure_publishes_nothing():
    reset()
    ids = seed(100)
    fetcher = StubFetcher()
    fetcher.broken = {url_of(pid) for pid in ids[:3]}  # 3% of the 100 printings
    assert run(fetcher) == 2
    assert artifacts() == []
    assert ledger() == {}  # an outage must not put every printing into backoff
    with db() as conn:
        assert 0 < conn.execute("SELECT count(*) FROM scanner_fingerprint").fetchone()[0] <= 97  # the work is kept
    # Two failures is exactly 2%, which still publishes.
    fetcher = StubFetcher()
    fetcher.broken = {url_of(pid) for pid in ids[:2]}
    assert run(fetcher) == 0
    assert artifacts()[0][4:6] == (98, 100)


def test_a_dead_source_stops_early_instead_of_trying_every_printing():
    reset()
    ids = seed(300)
    fetcher = StubFetcher()
    fetcher.broken = {url_of(pid) for pid in ids}
    assert run(fetcher) == 2
    assert len(fetcher.calls) < 50 and artifacts() == []


def test_image_url_change_resets_backoff():
    reset()
    ids = seed(100)
    fetcher = StubFetcher()
    fetcher.broken = {url_of(ids[3])}
    assert run(fetcher) == 0
    age_failures("1 minute")
    with db() as conn:
        conn.execute("UPDATE scanner_fingerprint_failure SET failures = 3")
    # The same address inside its backoff is not retried.
    quiet = StubFetcher()
    assert run(quiet) == 0 and quiet.calls == []
    # A new address is due at once, whatever the old one's backoff, and its first failure counts as 1.
    new_url = f"{BASE}/new-art-3"
    set_url(ids[3], new_url)
    fetcher = StubFetcher()
    fetcher.broken = {new_url}
    assert run(fetcher) == 0
    assert fetcher.calls == [new_url] and ledger() == {ids[3]: (new_url, 1)}


def test_a_changed_image_url_replaces_the_old_art_in_the_file():
    reset()
    ids = seed(3)
    assert run() == 0
    set_url(ids[1], f"{BASE}/redrawn")
    fetcher = StubFetcher()
    fetcher.broken = {f"{BASE}/redrawn"}
    assert run(fetcher) == 2  # 1 of 3 failing is over 2%: the old file stays
    assert len(artifacts()) == 1
    assert run() == 0
    latest = artifacts()[-1]
    assert latest[6] == expected_file([(pid, url_of(pid)) for pid in ids])


def test_a_sha_that_belongs_to_another_model_is_never_republished_under_this_one():
    reset()
    ids = seed(3)
    assert run() == 0
    data = artifacts()[0][6]
    with db() as conn:
        conn.execute("UPDATE scanner_index SET model_id='other-model'")
    set_url(ids[0], f"{BASE}/elsewhere")
    fetcher = StubFetcher(same_as={f"{BASE}/elsewhere": f"{BASE}/0"})
    assert run(fetcher) == 2
    rows = artifacts()
    assert len(rows) == 1 and rows[0][1] == "other-model" and rows[0][6] == data and rows[0][3] == artifacts()[0][3]


def test_exit_code_1_when_the_database_is_unreachable():
    assert run(database_url="postgresql://nobody@127.0.0.1:1/none?connect_timeout=1") == 1


def test_exit_code_3_when_the_advisory_lock_is_held():
    reset()
    seed(3)
    with db() as holder:
        assert holder.execute("SELECT pg_try_advisory_lock(914711)").fetchone()[0]
        fetcher = StubFetcher()
        assert run(fetcher) == 3
        assert fetcher.calls == [] and artifacts() == []
    assert run() == 0  # released with the holder's connection


def test_exit_code_2_without_a_contact_for_the_user_agent(monkeypatch):
    reset()
    seed(3)
    monkeypatch.delenv("SCANNER_INDEX_CONTACT", raising=False)
    monkeypatch.delenv("OWNER_EMAIL", raising=False)
    assert job.run(None, model=MODEL, make_embedder=lambda m: StubEmbedder(), log=lambda *_: None) == 2
    assert artifacts() == []


def test_main_parses_full(monkeypatch):
    seen = {}
    monkeypatch.setattr(job, "run", lambda **kwargs: seen.update(kwargs) or 0)
    assert job.main(["--full"]) == 0 and seen == {"full": True}
    assert job.main([]) == 0 and seen == {"full": False}


# --- The real model (the job image's CI step only) ---------------------------------------------------------------------


@pytest.mark.slow(reason="process: loads the 24 MB embedder into ONNX Runtime")
def test_the_real_embedder_matches_the_spikes_quantisation():
    if os.environ.get("SCANNER_REAL_MODEL_REQUIRED"):  # the job image's CI step: a missing module fails, never skips
        import cv2
        import numpy as np
        import onnxruntime  # noqa: F401
    else:
        np = pytest.importorskip("numpy")
        cv2 = pytest.importorskip("cv2")
        pytest.importorskip("onnxruntime")
    model = job.load_model()
    job.verify_model_file(model)
    embedder = job.OnnxEmbedder(model)

    def card(seed):
        rng = np.random.default_rng(seed)
        small = rng.integers(0, 256, (24, 18, 3), dtype=np.uint8)
        return cv2.resize(small, (245, 330), interpolation=cv2.INTER_CUBIC)

    def encoded(image, ext):
        ok, buffer = cv2.imencode(ext, image)
        assert ok
        return buffer.tobytes()

    first = embedder.embed(encoded(card(1), ".webp"))
    assert len(first) == job.DIM
    assert np.linalg.norm(np.array(first, np.float32)) == pytest.approx(1.0, abs=1e-5)
    assert embedder.embed(encoded(card(1), ".webp")) == first  # deterministic
    other = embedder.embed(encoded(card(2), ".webp"))
    assert float(np.dot(first, other)) < 0.99
    with pytest.raises(job.EmbedError):
        embedder.embed(b"not an image")
    # Pure-Python quantisation equals the spike's float32 numpy quantize, bit for bit.
    vecs = np.array([first, other], np.float32)
    scale = (np.abs(vecs).max(axis=1) / 127.0).astype(np.float32)
    safe = np.where(scale > 0, scale, 1.0).astype(np.float32)
    want = np.clip(np.rint(vecs / safe[:, None]), -127, 127).astype(np.int8)
    for row, vector in enumerate((first, other)):
        got_scale, got_q = job.quantize(vector)
        assert np.float32(got_scale) == scale[row]
        assert np.frombuffer(got_q, np.int8).tolist() == want[row].tolist()
