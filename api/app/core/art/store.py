"""Card art route and read-through store (#358, ADR 0020).

``GET /api/art/{printing_id}/{size}`` is signed-in only and keyed by catalog Printing, never by a source URL: the source
comes from catalog data (``resolve``) and must pass the exact-host check (``host_allowed``) before every hop, so the route
cannot act as an open proxy. On a miss the image is fetched once from the game's allowed host, checked (type, magic
bytes, 2 MiB cap), saved through ``art_storage`` and recorded in ``art_object``; later requests are served from the store
with no upstream request. Upstream failures are written to ``art_fetch_failure`` and backed off. Every served request
adds to ``art_hit`` (the signal for #361's upgrade job).

Concurrency (D8, D9): the API is one uvicorn process, so concurrent misses for one (Printing, size) coalesce on a striped
in-process lock. All blocking work runs in a dedicated small thread pool, so a cold page waiting on the rate limiter never
takes the threads other routes share. A temporary failure (a full queue, a lock wait, a failed fetch, a backoff) answers
503 ART_UNAVAILABLE with ``Retry-After`` and ``Cache-Control: no-store`` so a client retries; a Printing with no usable art
answers 404 ART_NOT_FOUND.

Warm-up (#396): ``warm_deck`` stores the small art of a saved deck's printings in the background through ``serve``, so the
first view finds them stored.

Game-free (design D11): the allowed host, the linked-art pattern and the fetcher come from the game's route module
(``app.games.pokemon.art.route``) as keyword parameters.
"""
import asyncio
import hashlib
import logging
import os
import re
import threading
import time
import urllib.parse
from concurrent.futures import CancelledError, ThreadPoolExecutor
from functools import partial
from dataclasses import dataclass
from typing import Callable, NamedTuple
from uuid import UUID

import httpx
from fastapi.responses import JSONResponse, RedirectResponse, Response

from app.art_storage import storage
from app.core.art.urls import SIZES, art_version
from app.core.art.dimensions import image_size
from app.db import connect

log = logging.getLogger(__name__)

RATE = 5
MAX_BYTES = 2 * 1024 * 1024
CONNECT_TIMEOUT = 3.0
READ_TIMEOUT = 8.0
DEADLINE = 10.0
MAX_REDIRECTS = 3
MAX_QUEUE_WAIT = 10.0
BACKOFF_BASE = 60
BACKOFF_CAP = 86400
TYPES = {
    "image/webp": lambda body: body[:4] == b"RIFF" and body[8:12] == b"WEBP",
    "image/png": lambda body: body[:8] == b"\x89PNG\r\n\x1a\n",
    "image/jpeg": lambda body: body[:3] == b"\xff\xd8\xff",
}
STRIPES = 256
LOCK_WAIT = 10.0
MAX_ADMITTED = 64
# Retry-After seconds for a temporary failure: a brief wait for load, the whole remaining backoff (at most RETRY_CAP).
RETRY_BUSY = 5
RETRY_CONTENDED = 3
RETRY_CAP = 3600
WARM_LIMIT = 200

IMMUTABLE = "private, max-age=31536000, immutable"
REVALIDATE = "private, no-cache"


def host_allowed(url: str, *, allowed_host: str) -> bool:
    """Exactly https://<allowed_host>: port absent or 443, no userinfo, no query or fragment."""
    if any(ord(char) <= 0x20 or ord(char) >= 0x7F for char in url):
        return False  # urlsplit drops tabs and newlines and httpx does not: they must agree on the host
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
        client = httpx.URL(url)
    except (ValueError, httpx.InvalidURL):
        return False
    if client.scheme != "https" or client.host != allowed_host:
        return False
    return (parts.scheme == "https" and (parts.hostname or "").lower() == allowed_host and "@" not in parts.netloc
            and port in (None, 443) and not parts.query and not parts.fragment)


def backoff_seconds(failures: int) -> int:
    """1 minute x 4^(n-1), at most a day: 1 min, 4 min, 16 min, 64 min, about 4.3 h, about 17 h, then 24 h."""
    return min(BACKOFF_CAP, BACKOFF_BASE * 4 ** max(0, min(failures, 20) - 1))


_stripes = [threading.Lock() for _ in range(STRIPES)]


def _lock_for(printing_id: str, size: str) -> threading.Lock:
    """The stripe lock for one (Printing, size), not for a source or a storage key (so a catalog update serializes too)."""
    return _stripes[int(hashlib.sha256(f"{printing_id}/{size}".encode()).hexdigest()[:8], 16) % STRIPES]


def upstream_target(url: str) -> str:
    """Where a request for a canonical (already allowlisted) URL is sent. Identity in production; only the CI-only
    ``api/tests/catalog_process_fixture/art_fixture.py`` replaces it, and only with a loopback http origin."""
    return url


class RateLimiter:
    """At most ``per_second`` slots a second across all threads. ``try_wait`` takes the next free slot and sleeps until
    it, or takes nothing and returns False when that slot is more than ``max_wait`` seconds away."""

    def __init__(self, per_second, clock=time.monotonic, sleep=time.sleep):
        self.interval = 1.0 / per_second
        self.clock, self.sleep = clock, sleep
        self.lock = threading.Lock()
        self.next_slot = 0.0

    def try_wait(self, max_wait: float) -> bool:
        with self.lock:
            now = self.clock()
            slot = max(now, self.next_slot)
            if slot - now > max_wait:
                return False
            self.next_slot = slot + self.interval
        if slot - now > 0:
            self.sleep(slot - now)
        return True


class FetchFailed(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class Busy(Exception):
    """The rate limiter's queue is too long: answer unavailable now and write nothing to the ledger."""


class ArtFetcher:
    def __init__(self, *, allowed_host, path_pattern: re.Pattern | None = None, transport=None, limiter=None, clock=time.monotonic):
        self.allowed_host = allowed_host
        self.path_pattern = path_pattern
        contact = os.environ.get("ART_FETCH_CONTACT")
        agent = f"PrizeCheck-art/1 (+{contact})" if contact else "PrizeCheck-art/1"
        self.clock = clock
        self.limiter = limiter or RateLimiter(RATE)
        self.client = httpx.Client(
            transport=transport,
            timeout=httpx.Timeout(READ_TIMEOUT, connect=CONNECT_TIMEOUT),
            follow_redirects=False,
            trust_env=False,
            headers={"User-Agent": agent, "Accept-Encoding": "identity"},
        )

    def fetch(self, source_url: str) -> tuple[bytes, str]:
        """The image bytes and content type for an allowlisted URL, or FetchFailed / Busy. One try, no retries."""
        deadline = self.clock() + DEADLINE
        url = source_url
        for _ in range(MAX_REDIRECTS + 1):
            if (not host_allowed(url, allowed_host=self.allowed_host)
                    or self.path_pattern is not None and not self.path_pattern.fullmatch(url)):
                raise FetchFailed("redirect")
            if self.clock() > deadline:
                raise FetchFailed("timeout")
            if not self.limiter.try_wait(MAX_QUEUE_WAIT):
                raise Busy()
            if self.clock() > deadline:
                raise Busy()  # the wait for a slot used the time; nothing was sent upstream
            try:
                with self.client.stream("GET", upstream_target(url)) as response:
                    if response.is_redirect:
                        url = urllib.parse.urljoin(url, response.headers.get("location", ""))
                        continue
                    if response.status_code != 200:
                        raise FetchFailed("status")
                    if response.headers.get("content-encoding", "identity").strip().lower() not in ("", "identity"):
                        raise FetchFailed("content_type")
                    kind = response.headers.get("content-type", "").split(";")[0].strip().lower()
                    if kind not in TYPES:
                        raise FetchFailed("content_type")
                    try:
                        declared = int(response.headers.get("content-length", "0"))
                    except ValueError:
                        declared = 0
                    if declared > MAX_BYTES:
                        raise FetchFailed("too_large")
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_BYTES:
                            raise FetchFailed("too_large")
                        if self.clock() > deadline:
                            raise FetchFailed("timeout")
                    body = bytes(body)
                    if not TYPES[kind](body):
                        raise FetchFailed("magic")
                    return body, kind
            except httpx.TimeoutException:
                raise FetchFailed("timeout") from None
            except httpx.TransportError:
                raise FetchFailed("transport") from None
            except httpx.HTTPError:
                raise FetchFailed("transport") from None
        raise FetchFailed("redirect")


@dataclass(frozen=True)
class LargeUpgrade:
    host: str
    pattern: re.Pattern
    fetcher: Callable[[], ArtFetcher]
    key_prefix: str
    beats: Callable[[str, int, int], bool]


class Art(NamedTuple):
    base: str
    small: str
    candidate: str | None
    upgrade_row: dict | None
    obj: dict | None
    failure: dict | None
    stored_upgrade: str | None


def resolve(conn, printing_id, size, *, allowed_host, linked_art):
    """Read the canonical sources; retained as a seam for the source-change concurrency test."""
    row = conn.execute("""SELECT low_image_url, high_image_url, large_upgrade_url, stored_upgrade_url
        FROM catalog_printing_art WHERE printing_id=%s""", (printing_id,)).fetchone()
    base = row["low_image_url" if size == "small" else "high_image_url"] if row else None
    if base and len(base) <= 2048 and (host_allowed(base, allowed_host=allowed_host) or linked_art.fullmatch(base)):
        return row
    return None


def _missing(code: str) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": {"code": code, "message": "Card art is not available."}})


def _unavailable(retry_after: float = RETRY_CONTENDED) -> JSONResponse:
    """A temporary failure: 503 with a retry hint, never cached (the 404 for missing art may be)."""
    return JSONResponse(status_code=503, headers={"Retry-After": str(max(1, min(RETRY_CAP, int(retry_after)))),
                                                  "Cache-Control": "no-store"},
                        content={"detail": {"code": "ART_UNAVAILABLE", "message": "Card art is not available right now."}})


def _image(data: bytes, content_type: str, cache: str) -> Response:
    return Response(content=data, media_type=content_type, headers={
        "Cache-Control": cache,
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
    })


def _linked(source: str, fresh: bool) -> Response:
    """Fallback art is linked, not copied (ADR 0019): the browser fetches it from the host the view names."""
    return RedirectResponse(source, status_code=302, headers={
        "Cache-Control": IMMUTABLE if fresh else REVALIDATE})


def _read(conn, printing_id, size, *, allowed_host, linked_art, upgrade) -> Art | None:
    row = resolve(conn, printing_id, size, allowed_host=allowed_host, linked_art=linked_art)
    if row is None:
        return None
    base = row["low_image_url" if size == "small" else "high_image_url"]
    candidate = row["large_upgrade_url"] if size == "large" and upgrade is not None else None
    if candidate and (len(candidate) > 2048 or not host_allowed(candidate, allowed_host=upgrade.host)
                      or not upgrade.pattern.fullmatch(candidate)):
        candidate = None
    comparison = conn.execute("""SELECT *, EXTRACT(EPOCH FROM now()-checked_at) AS age
        FROM art_large_upgrade WHERE printing_id=%s AND candidate_url=%s AND base_url=%s""",
        (printing_id, candidate, base)).fetchone() if candidate else None
    obj = conn.execute("SELECT * FROM art_object WHERE printing_id=%s AND size=%s", (printing_id, size)).fetchone()
    failure = conn.execute("""SELECT source_url, failures, EXTRACT(EPOCH FROM now()-last_failed_at) AS age
        FROM art_fetch_failure WHERE printing_id=%s AND size=%s""", (printing_id, size)).fetchone()
    return Art(base, row["low_image_url"], candidate, comparison, obj, failure,
               row["stored_upgrade_url"] if upgrade is not None else None)


def effective(art, upgrade):
    if not art.candidate:
        return art.base
    row = art.upgrade_row
    if row:
        if row["outcome"] == "won" and upgrade.beats(art.base, row["width"], row["height"]):
            return art.candidate
        if row["outcome"] == "lost" or (row["outcome"] == "failed" and row["age"] < backoff_seconds(row["failures"])):
            return art.base
    return "measure"


def _fresh(art, size, source, v):
    versions = {art_version(art.small, art.candidate if source == art.candidate else None)}
    if size == "small":
        versions.add(art_version(art.small, art.stored_upgrade))
    return v in versions


def _comparison(conn, pid, art, outcome, dims=None, reason=None):
    conn.execute("""INSERT INTO art_large_upgrade(printing_id,candidate_url,base_url,outcome,width,height,failures,reason)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (printing_id) DO UPDATE SET candidate_url=EXCLUDED.candidate_url, base_url=EXCLUDED.base_url,
          outcome=EXCLUDED.outcome,width=EXCLUDED.width,height=EXCLUDED.height,reason=EXCLUDED.reason,checked_at=now(),
          failures=CASE WHEN EXCLUDED.outcome='failed' AND art_large_upgrade.candidate_url=EXCLUDED.candidate_url
            AND art_large_upgrade.base_url=EXCLUDED.base_url THEN art_large_upgrade.failures+1 ELSE EXCLUDED.failures END""",
        (pid, art.candidate, art.base, outcome, dims[0] if dims else None, dims[1] if dims else None,
         1 if reason else 0, reason))


def _hit(conn, printing_id: UUID, size: str) -> None:
    conn.execute("""INSERT INTO art_hit(printing_id,size,hits,last_hit_at) VALUES (%s,%s,1,now())
        ON CONFLICT (printing_id,size) DO UPDATE SET hits=art_hit.hits+1, last_hit_at=now()""", (printing_id, size))


def _stored(conn, printing_id: UUID, size: str, source: str, obj, fresh: bool, count: bool = True):
    """The response for a stored object that matches the source and the bytes on disk, with the hit recorded; else None."""
    if not obj or obj["source_url"] != source:
        return None
    try:
        data = storage().get(obj["storage_key"])
    except (ValueError, OSError):
        data = None
    if data is None or hashlib.sha256(data).hexdigest() != obj["sha256"]:
        return None
    if count:
        _hit(conn, printing_id, size)
    return _image(data, obj["content_type"], IMMUTABLE if fresh else REVALIDATE)


def _store(pid, size, source, obj, data, content_type, fresh, count, key_prefix, extra=None):
    digest = hashlib.sha256(data).hexdigest()
    key = f"{key_prefix}/{size}/{str(pid)[:2]}/{pid}-{hashlib.sha256(source.encode()).hexdigest()[:16]}"
    try:
        storage().put(key, data)
    except OSError as error:
        log.warning("Art store write failed: %s", type(error).__name__)
        if count:
            with connect() as conn:
                _hit(conn, pid, size)
        return _image(data, content_type, REVALIDATE)
    with connect() as conn, conn.transaction():
        if extra is not None:
            extra(conn)
        conn.execute("""INSERT INTO art_object(printing_id,size,source_url,storage_key,sha256,content_type,byte_size)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (printing_id,size) DO UPDATE SET source_url=EXCLUDED.source_url,
              storage_key=EXCLUDED.storage_key, sha256=EXCLUDED.sha256, content_type=EXCLUDED.content_type,
              byte_size=EXCLUDED.byte_size, stored_at=now()""",
                     (pid, size, source, key, digest, content_type, len(data)))
        conn.execute("DELETE FROM art_fetch_failure WHERE printing_id=%s AND size=%s", (pid, size))
        if count:
            _hit(conn, pid, size)
    if obj and obj["storage_key"] != key:
        try:
            storage().delete(obj["storage_key"])
        except (ValueError, OSError):
            pass
    return _image(data, content_type, IMMUTABLE if fresh else REVALIDATE)


def serve(printing_id: str, size: str, v: str | None, count: bool = True, *, allowed_host: str,
          linked_art: re.Pattern, fetcher, key_prefix: str, upgrade: LargeUpgrade | None) -> Response:
    try:
        pid = UUID(printing_id)
    except ValueError:
        return _missing("ART_NOT_FOUND")
    if size not in SIZES:
        return _missing("ART_NOT_FOUND")
    args = dict(allowed_host=allowed_host, linked_art=linked_art, upgrade=upgrade)
    with connect() as conn:
        art = _read(conn, pid, size, **args)
        if art is None:
            return _missing("ART_NOT_FOUND")
        source = effective(art, upgrade)
        if source != "measure":
            fresh = _fresh(art, size, source, v)
            if linked_art.fullmatch(source):
                return _linked(source, fresh)
            answer = _stored(conn, pid, size, source, art.obj, fresh, count)
            if answer:
                return answer
    lock = _lock_for(str(pid), size)
    if not lock.acquire(timeout=LOCK_WAIT):
        return _unavailable(RETRY_CONTENDED)
    try:
        with connect() as conn:
            art = _read(conn, pid, size, **args)
        if art is None:
            return _missing("ART_NOT_FOUND")
        source = effective(art, upgrade)
        if source == "measure":
            try:
                data, kind = upgrade.fetcher().fetch(art.candidate)
            except Busy:
                source = art.base
            except FetchFailed as failed:
                with connect() as conn:
                    _comparison(conn, pid, art, "failed", reason=failed.reason)
                source = art.base
            else:
                dims = image_size(data, kind)
                if dims and upgrade.beats(art.base, *dims):
                    return _store(pid, size, art.candidate, art.obj, data, kind,
                                  v == art_version(art.small, art.candidate), count, upgrade.key_prefix,
                                  extra=lambda conn: _comparison(conn, pid, art, "won", dims))
                with connect() as conn:
                    _comparison(conn, pid, art, "lost", dims)
                source = art.base
        fresh = _fresh(art, size, source, v)
        if linked_art.fullmatch(source):
            return _linked(source, fresh)
        with connect() as conn:
            answer = _stored(conn, pid, size, source, art.obj, fresh, count)
        if answer:
            return answer
        failure = art.failure
        if failure and failure["source_url"] == source and failure["age"] < backoff_seconds(failure["failures"]):
            return _unavailable(backoff_seconds(failure["failures"]) - failure["age"])
        candidate = source == art.candidate
        try:
            data, content_type = (upgrade.fetcher if candidate else fetcher)().fetch(source)
        except Busy:
            return _unavailable(RETRY_BUSY)
        except FetchFailed as failed:
            with connect() as conn:
                if candidate:
                    _comparison(conn, pid, art, "failed", reason=failed.reason)
                    return _unavailable(RETRY_BUSY)
                row = conn.execute("""INSERT INTO art_fetch_failure(printing_id,size,source_url,failures,last_failed_at,reason)
                    VALUES (%s,%s,%s,1,now(),%s)
                    ON CONFLICT (printing_id,size) DO UPDATE SET
                      failures=CASE WHEN art_fetch_failure.source_url=EXCLUDED.source_url
                        THEN art_fetch_failure.failures+1 ELSE 1 END,
                      source_url=EXCLUDED.source_url,last_failed_at=now(),reason=EXCLUDED.reason RETURNING failures""",
                    (pid,size,source,failed.reason)).fetchone()
            return _unavailable(backoff_seconds(row["failures"]))
        return _store(pid, size, source, art.obj, data, content_type, fresh, count,
                      upgrade.key_prefix if candidate else key_prefix)
    finally:
        lock.release()


_pool: ThreadPoolExecutor | None = None
_pool_lock = threading.Lock()
_admit_lock = threading.Lock()
_admitted = 0


def _executor() -> ThreadPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="art")
        return _pool


# Warm-up: one background thread, apart from the request pool so a warm-up never takes a thread a page is waiting on. It
# calls ``serve``, so it shares the limiter (5 a second with the requests), the stripe locks and the failure backoff.
_warm_pool: ThreadPoolExecutor | None = None
_warm_pending: set[UUID] = set()
_warm_futures: list = []
_warm_lock = threading.Lock()
_warm_stop = threading.Event()  # set at shutdown: a running job stops before its next Printing


def _warm_executor() -> ThreadPoolExecutor:
    global _warm_pool
    with _warm_lock:
        if _warm_pool is None:
            _warm_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="art-warm")
        return _warm_pool


def _warm(printing_ids: list[UUID], allowed_host: str, linked_art: re.Pattern, fetcher, *, key_prefix: str, upgrade: LargeUpgrade | None) -> None:
    for index, pid in enumerate(printing_ids):
        if _warm_stop.is_set():
            with _warm_lock:
                _warm_pending.difference_update(printing_ids[index:])
            return
        try:
            serve(str(pid), "small", None, count=False, allowed_host=allowed_host, linked_art=linked_art, fetcher=fetcher,
                  key_prefix=key_prefix, upgrade=upgrade)
        except Exception as error:  # a warm-up is only a head start: nothing here may reach a caller
            log.warning("Art warm-up failed: %s", type(error).__name__)
        finally:
            with _warm_lock:
                _warm_pending.discard(pid)


def stop_warmups() -> None:
    """Shutdown: running jobs stop before their next Printing and queued ones are dropped."""
    global _warm_pool
    _warm_stop.set()
    with _warm_lock:
        pool, _warm_pool = _warm_pool, None
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)


def start_warmups() -> None:
    """Startup: a warm-up may run (the flag stays set after a shutdown in the same process, as in tests)."""
    _warm_stop.clear()


def warm_deck(conn, owner_id: str, deck_id: UUID, *, allowed_host: str, linked_art: re.Pattern, fetcher,
              key_prefix: str, upgrade: LargeUpgrade | None) -> None:
    """Queue background stores of the small art of a Deck's Printings that has none stored (#396). Called by the Deck List
    commands inside their transaction, so it reads the lines just written; it needs only ids, so the job never depends on
    the commit. Only a source on the game's allowed host is stored (linked fallback art needs nothing). Bounded to
    ``WARM_LIMIT`` Printings a call, and a Printing already queued is not queued twice. Never raises: a failed read is rolled back to its
    savepoint, and the save goes on."""
    if os.environ.get("ART_WARM_UP", "1") == "0":
        return
    try:
        with conn.transaction():
            # The Printing comes through catalog_edition, as the lines' display does (deck_list_display): a line whose
            # Edition left the active generation still shows its picture, so it is warmed too.
            rows = conn.execute("""SELECT DISTINCT pa.printing_id AS id, pa.low_image_url AS source
                FROM deck_list_line line
                JOIN catalog_edition edition ON edition.id=line.edition_id
                JOIN catalog_printing_art pa ON pa.printing_id=edition.printing_id
                WHERE line.owner_id=%s AND line.deck_id=%s AND pa.low_image_url LIKE %s
                  AND NOT EXISTS (SELECT 1 FROM art_object stored WHERE stored.printing_id=pa.printing_id
                    AND stored.size='small' AND stored.source_url=pa.low_image_url)
                ORDER BY pa.printing_id
                LIMIT %s""", (owner_id, deck_id, f"https://{allowed_host}/%", WARM_LIMIT)).fetchall()
        usable = [row["id"] for row in rows if len(row["source"]) <= 2048 and host_allowed(row["source"], allowed_host=allowed_host)]
        with _warm_lock:
            fresh = [pid for pid in usable if pid not in _warm_pending]
            _warm_pending.update(fresh)
        if fresh:
            try:
                future = _warm_executor().submit(_warm, fresh, allowed_host, linked_art, fetcher, key_prefix=key_prefix, upgrade=upgrade)
            except BaseException:
                with _warm_lock:
                    _warm_pending.difference_update(fresh)
                raise
            with _warm_lock:
                _warm_futures[:] = [f for f in _warm_futures if not f.done()] + [future]
    except Exception as error:
        log.warning("Art warm-up not queued: %s", type(error).__name__)


def join_warmups() -> None:
    """Wait for the queued warm-ups (tests: none may outlive its test)."""
    with _warm_lock:
        futures = list(_warm_futures)
    for future in futures:
        try:
            future.result()
        except CancelledError:
            pass


async def serve_admitted(printing_id: str, size: str, v: str | None, *, allowed_host: str, linked_art: re.Pattern,
                         fetcher, key_prefix: str, upgrade: LargeUpgrade | None) -> Response:
    """The route body: admit at most ``MAX_ADMITTED`` requests, then serve on the dedicated pool."""
    global _admitted
    with _admit_lock:
        if _admitted >= MAX_ADMITTED:
            return _unavailable(RETRY_CONTENDED)
        _admitted += 1
    try:
        return await asyncio.get_running_loop().run_in_executor(
            _executor(), partial(serve, printing_id, size, v, allowed_host=allowed_host, linked_art=linked_art,
                                 fetcher=fetcher, key_prefix=key_prefix, upgrade=upgrade))
    finally:
        with _admit_lock:
            _admitted -= 1
