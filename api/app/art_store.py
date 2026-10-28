"""Card art route and read-through store (#358, ADR 0020).

``GET /api/art/{printing_id}/{size}`` is signed-in only and keyed by catalog Printing, never by a source URL: the source
comes from catalog data (``resolve``) and must pass the exact-host check (``host_allowed``) before every hop, so the route
cannot act as an open proxy. On a miss the image is fetched once from ``https://assets.tcgdex.net``, checked (type, magic
bytes, 2 MiB cap), saved through ``art_storage`` and recorded in ``art_object``; later requests are served from the store
with no upstream request. Upstream failures are written to ``art_fetch_failure`` and backed off. Every served request
adds to ``art_hit`` (the signal for #361's upgrade job).

Concurrency (D8, D9): the API is one uvicorn process, so concurrent misses for one (Printing, size) coalesce on a striped
in-process lock. All blocking work runs in a dedicated small thread pool, so a cold page waiting on the rate limiter never
takes the threads other routes share. Every failure answers 404 ART_UNAVAILABLE so API fault counts stay meaningful.
"""
import asyncio
import hashlib
import logging
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import JSONResponse, Response

from .art_storage import storage
from .art_urls import SIZES, art_version, tcgdex_source
from .db import connect
from .identity import verified_user

log = logging.getLogger(__name__)

ALLOWED_HOST = "assets.tcgdex.net"
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

IMMUTABLE = "private, max-age=31536000, immutable"
REVALIDATE = "private, no-cache"


def host_allowed(url: str) -> bool:
    """Exactly https://assets.tcgdex.net: port absent or 443, no userinfo, no query or fragment."""
    if any(ord(char) <= 0x20 or ord(char) >= 0x7F for char in url):
        return False  # urlsplit drops tabs and newlines and httpx does not: they must agree on the host
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
        client = httpx.URL(url)
    except (ValueError, httpx.InvalidURL):
        return False
    if client.scheme != "https" or client.host != ALLOWED_HOST:
        return False
    return (parts.scheme == "https" and (parts.hostname or "").lower() == ALLOWED_HOST and "@" not in parts.netloc
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
    def __init__(self, transport=None, limiter=None, clock=time.monotonic):
        import os

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
            if not host_allowed(url):
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


_fetcher: ArtFetcher | None = None
_fetcher_lock = threading.Lock()


def fetcher() -> ArtFetcher:
    global _fetcher
    with _fetcher_lock:
        if _fetcher is None:
            _fetcher = ArtFetcher()
        return _fetcher


def resolve(conn, printing_id: UUID, size: str) -> str | None:
    """The source URL for a (Printing, size) in the active generation, or None. The one plug-in point for later sources."""
    row = conn.execute("""SELECT gp.image_url FROM catalog_state s JOIN catalog_generation_printing gp
        ON gp.generation_id = s.active_generation
        WHERE s.singleton AND gp.printing_id = %s AND NOT gp.tombstoned""", (printing_id,)).fetchone()
    if not row:
        return None
    source = tcgdex_source(row["image_url"], size)
    # art_object.source_url holds at most 2048 characters: a longer source could be fetched but never stored.
    return source if source and len(source) <= 2048 and host_allowed(source) else None


def _missing(code: str) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": {"code": code, "message": "Card art is not available."}})


def _unavailable() -> JSONResponse:
    return _missing("ART_UNAVAILABLE")


def _image(data: bytes, content_type: str, cache: str) -> Response:
    return Response(content=data, media_type=content_type, headers={
        "Cache-Control": cache,
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
    })


def _read(conn, printing_id: UUID, size: str):
    """(source, object row, ledger row) for a (Printing, size); the ledger row carries its age in database seconds."""
    source = resolve(conn, printing_id, size)
    if source is None:
        return None, None, None
    obj = conn.execute("SELECT * FROM art_object WHERE printing_id=%s AND size=%s", (printing_id, size)).fetchone()
    failure = conn.execute("""SELECT source_url, failures, EXTRACT(EPOCH FROM now() - last_failed_at) AS age
        FROM art_fetch_failure WHERE printing_id=%s AND size=%s""", (printing_id, size)).fetchone()
    return source, obj, failure


def _hit(conn, printing_id: UUID, size: str) -> None:
    conn.execute("""INSERT INTO art_hit(printing_id,size,hits,last_hit_at) VALUES (%s,%s,1,now())
        ON CONFLICT (printing_id,size) DO UPDATE SET hits=art_hit.hits+1, last_hit_at=now()""", (printing_id, size))


def _stored(conn, printing_id: UUID, size: str, source: str, obj, v: str | None):
    """The response for a stored object that matches the source and the bytes on disk, with the hit recorded; else None."""
    if not obj or obj["source_url"] != source:
        return None
    try:
        data = storage().get(obj["storage_key"])
    except (ValueError, OSError):
        data = None
    if data is None or hashlib.sha256(data).hexdigest() != obj["sha256"]:
        return None
    _hit(conn, printing_id, size)
    return _image(data, obj["content_type"], IMMUTABLE if v == art_version(source) else REVALIDATE)


def serve(printing_id: str, size: str, v: str | None) -> Response:
    try:
        pid = UUID(printing_id)
    except ValueError:
        return _missing("ART_NOT_FOUND")
    if size not in SIZES:
        return _missing("ART_NOT_FOUND")
    with connect() as conn:
        source, obj, _ = _read(conn, pid, size)
        if source is None:
            return _missing("ART_NOT_FOUND")
        answer = _stored(conn, pid, size, source, obj, v)
    if answer:
        return answer
    lock = _lock_for(str(pid), size)
    if not lock.acquire(timeout=LOCK_WAIT):
        return _unavailable()
    try:
        with connect() as conn:
            source, obj, failure = _read(conn, pid, size)
            if source is None:
                return _missing("ART_NOT_FOUND")
            answer = _stored(conn, pid, size, source, obj, v)
        if answer:
            return answer
        if failure and failure["source_url"] == source and failure["age"] < backoff_seconds(failure["failures"]):
            return _unavailable()
        try:
            data, content_type = fetcher().fetch(source)
        except Busy:
            return _unavailable()
        except FetchFailed as failed:
            with connect() as conn:
                conn.execute("""INSERT INTO art_fetch_failure(printing_id,size,source_url,failures,last_failed_at,reason)
                    VALUES (%s,%s,%s,1,now(),%s)
                    ON CONFLICT (printing_id,size) DO UPDATE SET
                      failures = CASE WHEN art_fetch_failure.source_url = EXCLUDED.source_url
                                      THEN art_fetch_failure.failures + 1 ELSE 1 END,
                      source_url = EXCLUDED.source_url, last_failed_at = now(), reason = EXCLUDED.reason""",
                             (pid, size, source, failed.reason))
            return _unavailable()
        digest = hashlib.sha256(data).hexdigest()
        key = f"tcgdex/{size}/{str(pid)[:2]}/{pid}-{hashlib.sha256(source.encode()).hexdigest()[:16]}"
        try:
            storage().put(key, data)
        except OSError as error:
            log.warning("Art store write failed: %s", type(error).__name__)
            with connect() as conn:
                _hit(conn, pid, size)
            return _image(data, content_type, REVALIDATE)
        with connect() as conn, conn.transaction():
            conn.execute("""INSERT INTO art_object(printing_id,size,source_url,storage_key,sha256,content_type,byte_size)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (printing_id,size) DO UPDATE SET source_url=EXCLUDED.source_url,
                  storage_key=EXCLUDED.storage_key, sha256=EXCLUDED.sha256, content_type=EXCLUDED.content_type,
                  byte_size=EXCLUDED.byte_size, stored_at=now()""",
                         (pid, size, source, key, digest, content_type, len(data)))
            conn.execute("DELETE FROM art_fetch_failure WHERE printing_id=%s AND size=%s", (pid, size))
            _hit(conn, pid, size)
        if obj and obj["storage_key"] != key:
            try:
                storage().delete(obj["storage_key"])
            except (ValueError, OSError):
                pass
        return _image(data, content_type, IMMUTABLE if v == art_version(source) else REVALIDATE)
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


router = APIRouter(prefix="/api/art")


@router.get("/{printing_id}/{size}", response_class=Response, responses={200: {"content": {"image/webp": {}}}})
async def art(printing_id: str = Path(max_length=64), size: str = Path(max_length=16),
              v: str | None = Query(None, max_length=16), user_id: str = Depends(verified_user)):
    global _admitted
    with _admit_lock:
        if _admitted >= MAX_ADMITTED:
            return _unavailable()
        _admitted += 1
    try:
        return await asyncio.get_running_loop().run_in_executor(_executor(), serve, printing_id, size, v)
    finally:
        with _admit_lock:
            _admitted -= 1
