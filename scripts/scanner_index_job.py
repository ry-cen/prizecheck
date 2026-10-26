"""Build the card scanner's fingerprint index (#312; plumbing D4 and "Fingerprint file PCFP v1", ADR 0017).

    python scripts/scanner_index_job.py [--full]

For every non-tombstoned printing of the active catalog generation that has an image_url, the job downloads
`{image_url}/low.webp`, embeds it with the pinned embedder (web/scanner-models.lock.json), quantises the vector to int8
and keeps it in scanner_fingerprint. It then assembles the PCFP v1 file from those rows and publishes it in
scanner_index, where GET /api/scanner/fingerprints/{sha256} serves it. It runs by hand after a catalog pull in its own
image (deploy/docker/scanner-index.Dockerfile); no scheduler is installed (ADR 0002). Image bytes live in memory only.

Only printings with no fingerprint for their current image_url are fetched ("missing"), and of those only the ones whose
failure ledger entry is absent, for another image_url or past its backoff ("due"). `--full` ignores existing rows and
fetches everything: use it after a preprocessing change or to refresh art.

Exit codes: 0 published or nothing was due, 1 the database is unreachable, 2 systemic failure (more than 2% of the
printings failed this run, the embedder or its model file is unusable, or no contact is configured for the User-Agent):
nothing was published, 3 another run holds the advisory lock 914711.

Environment: DATABASE_URL; SCANNER_INDEX_CONTACT (else OWNER_EMAIL) goes into the User-Agent; SCANNER_MODELS_DIR (default
/opt/scanner-models) holds `<sha256[0:16]>/<name>` as scripts/fetch-scanner-models.mjs lays it out; SCANNER_MODELS_LOCK
overrides the lock file path.
"""
import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import struct
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
LOCK_FILE = ROOT / "web" / "scanner-models.lock.json"
MODELS_DIR = Path("/opt/scanner-models")
ADVISORY_LOCK = 914711
DIM = 384
WORKERS = 4
REQUESTS_PER_SECOND = 5
TIMEOUT_SECONDS = 20
TRIES = 2
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_REDIRECTS = 3
MAX_RETRY_AFTER_SECONDS = 30
SYSTEMIC_FAILURE_PERCENT = 2
KEEP_ARTIFACTS = 2
BACKOFF_BASE_SECONDS = 3600
BACKOFF_CAP_SECONDS = 7 * 24 * 3600
ALLOWED_HOST = "assets.tcgdex.net"
ALLOWED_SUFFIX = ".tcgdex.net"

OK, UNREACHABLE, SYSTEMIC, LOCKED = 0, 1, 2, 3


class Systemic(Exception):
    """The run cannot produce a trustworthy index (exit 2)."""


class FetchError(Exception):
    """One image could not be downloaded."""


class _Retryable(FetchError):
    """A timeout, a transport fault, a 429 or a 5xx: worth the second try, after `delay` seconds when the server asked."""

    def __init__(self, message="retry", delay=0):
        super().__init__(message)
        self.delay = delay


class EmbedError(Exception):
    """One image could not be turned into a vector."""


# --- The model ---------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Model:
    id: str
    sha256: str
    name: str
    size: int
    path: Path


def load_model(lock_file=None, models_dir=None):
    """The pinned embedder from the lock file the web image uses. The id is the one web/src/scanner/models.ts carries
    (scripts/fetch-scanner-models.mjs modelId): family, the first 8 hex of the embedder's sha256 and the preprocessing."""
    lock_file = Path(lock_file or os.environ.get("SCANNER_MODELS_LOCK") or LOCK_FILE)
    models_dir = Path(models_dir or os.environ.get("SCANNER_MODELS_DIR") or MODELS_DIR)
    lock = json.loads(lock_file.read_text())
    embedders = [f for f in lock["files"] if f["role"] == "embedder"]
    if len(embedders) != 1:
        raise Systemic(f"{lock_file}: exactly one file must have role embedder")
    file = embedders[0]
    sha = file["sha256"]
    return Model(
        id=f"{lock['family']}-{sha[:8]}-p{lock['preprocessing']}",
        sha256=sha,
        name=file["name"],
        size=int(file["bytes"]),
        path=models_dir / sha[:16] / file["name"],
    )


def verify_model_file(model):
    """The model file's size and sha256 against the lock, before it is trusted with the whole catalog."""
    try:
        size = model.path.stat().st_size
        digest = hashlib.sha256()
        with open(model.path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
    except OSError as error:
        raise Systemic(f"embedder model {model.path} cannot be read: {error.strerror}") from None
    if size != model.size or digest.hexdigest() != model.sha256:
        raise Systemic(f"embedder model {model.path} does not match web/scanner-models.lock.json")


class OnnxEmbedder:
    """The spike's embedder (scanspike/embed.py), one image per session.run: the int8 model quantises activations
    dynamically over a batch, so a batch would give vectors that differ from the phone's single-image queries. numpy,
    OpenCV and onnxruntime are imported here only, so the API test venv never needs them."""

    MEAN = (0.485, 0.456, 0.406)
    STD = (0.229, 0.224, 0.225)

    def __init__(self, model):
        import cv2
        import numpy as np
        import onnxruntime as ort

        self._cv2, self._np = cv2, np
        self._mean = np.array(self.MEAN, np.float32)
        self._std = np.array(self.STD, np.float32)
        self.session = ort.InferenceSession(str(model.path), ort.SessionOptions(), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        names = [output.name for output in self.session.get_outputs()]
        if "pooler_output" in names:
            self.output_name, self._cls = "pooler_output", False
        elif "last_hidden_state" in names:
            self.output_name, self._cls = "last_hidden_state", True
        else:
            raise Systemic(f"embedder has neither pooler_output nor last_hidden_state: {names}")

    def _decode(self, data):
        cv2, np = self._cv2, self._np
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
        if image is None:
            raise EmbedError("image cannot be decoded")
        if image.ndim == 2:
            return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        if image.shape[2] == 4:  # composite on mid grey as the spike's load_reference
            alpha = image[:, :, 3:4].astype(np.float32) / 255.0
            out = image[:, :, :3].astype(np.float32) * alpha + 128.0 * (1.0 - alpha)
            return np.clip(np.rint(out), 0, 255).astype(np.uint8)
        return image

    def embed(self, data):
        """The L2-normalised float32 embedding of encoded image bytes, as a list of 384 floats."""
        cv2, np = self._cv2, self._np
        rgb = cv2.cvtColor(self._decode(data), cv2.COLOR_BGR2RGB)
        rgb = cv2.resize(rgb, (224, 224), interpolation=cv2.INTER_AREA)
        x = (rgb.astype(np.float32) / 255.0 - self._mean) / self._std
        x = np.ascontiguousarray(x.transpose(2, 0, 1), dtype=np.float32)
        out = self.session.run([self.output_name], {self.input_name: x[None]})[0]
        if self._cls:
            out = out[:, 0, :]
        out = np.asarray(out, np.float32)
        if out.ndim != 2 or out.shape != (1, DIM):
            raise EmbedError(f"unexpected embedding shape {out.shape}")
        norm = np.linalg.norm(out, axis=1, keepdims=True)
        return (out / np.maximum(norm, 1e-12)).astype(np.float32)[0].tolist()


# --- Quantisation and the PCFP file -------------------------------------------------------------------------------------


def _f32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


def quantize(vector):
    """(scale, 384 int8 bytes) for an L2-normalised vector, as the spike's quantize (scanspike/index.py) does it in
    float32: scale = max|v| / 127, q = round(v / scale) clipped to [-127, 127], halves to even. Pure Python, so the API
    test venv needs no numpy; each division is rounded to float32 as numpy's float32 arrays would."""
    if len(vector) != DIM:
        raise EmbedError(f"embedding has {len(vector)} values, want {DIM}")
    if not all(math.isfinite(x) for x in vector):
        raise EmbedError("embedding is not finite")
    scale = _f32(max(abs(x) for x in vector) / 127.0)
    safe = scale if scale > 0 else 1.0
    quantized = [max(-127, min(127, round(_f32(x / safe)))) for x in vector]
    return scale, struct.pack(f"<{DIM}b", *quantized)


def pack_pcfp(model_sha256, rows):
    """PCFP v1 bytes (the resolution's "Fingerprint file PCFP v1"), little-endian: magic, u16 format 1, u16 dim 384,
    u32 count, the model's raw sha256, the printing UUIDs ascending in RFC 4122 byte order, an f32 scale per row, then
    the int8 vectors row-major. `rows` are (printing UUID, scale, vector bytes) in any order."""
    ordered = sorted(rows, key=lambda row: row[0].bytes)
    out = [b"PCFP", struct.pack("<HHI", 1, DIM, len(ordered)), bytes.fromhex(model_sha256)]
    out.extend(row[0].bytes for row in ordered)
    out.extend(struct.pack("<f", row[1]) for row in ordered)
    for row in ordered:
        if len(row[2]) != DIM:
            raise ValueError("a fingerprint vector is not 384 bytes")
        out.append(bytes(row[2]))
    return b"".join(out)


def inputs_digest(model_id, inputs):
    """sha256 of the canonical JSON of the model id and the (printing id, image_url) pairs, sorted by printing id."""
    body = {"model": model_id, "printings": [[str(pid), url] for pid, url in inputs]}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def backoff_seconds(failures):
    """1 hour x 4^(n-1), at most 7 days: 1 h, 4 h, 16 h, 64 h, then 7 days."""
    return min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 4 ** max(0, min(failures, 20) - 1))


# --- Fetching ----------------------------------------------------------------------------------------------------------


def host_allowed(url):
    """An https URL on assets.tcgdex.net or a *.tcgdex.net host, with no userinfo and no port but 443."""
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or "@" in parts.netloc or port not in (None, 443):
        return False
    return host == ALLOWED_HOST or host.endswith(ALLOWED_SUFFIX)


class RateLimiter:
    """At most `per_second` calls to wait() proceed each second across all threads: each caller takes the next free slot."""

    def __init__(self, per_second, clock=time.monotonic, sleep=time.sleep):
        self.interval = 1.0 / per_second
        self.clock, self.sleep = clock, sleep
        self.lock = threading.Lock()
        self.next_slot = 0.0

    def wait(self):
        with self.lock:
            slot = max(self.clock(), self.next_slot)
            self.next_slot = slot + self.interval
        delay = slot - self.clock()
        if delay > 0:
            self.sleep(delay)


def retry_after(value):
    """Seconds a `Retry-After` header asks for (whole seconds only), at most MAX_RETRY_AFTER_SECONDS; 0 when absent."""
    try:
        return max(0, min(MAX_RETRY_AFTER_SECONDS, int(value)))
    except (TypeError, ValueError):
        return 0


class TcgdexFetcher:
    """Downloads `{image_url}/low.webp` into memory from assets.tcgdex.net or another *.tcgdex.net host. A redirect to
    any other host is refused; every request, retries and redirect hops included, takes a rate limiter slot."""

    def __init__(self, contact, limiter=None, transport=None, clock=time.monotonic, sleep=time.sleep):
        import httpx

        self.clock, self.sleep = clock, sleep
        self._httpx = httpx
        self.limiter = limiter or RateLimiter(REQUESTS_PER_SECOND)
        self.client = httpx.Client(
            transport=transport,
            timeout=httpx.Timeout(TIMEOUT_SECONDS),
            follow_redirects=False,
            headers={"User-Agent": f"PrizeCheck-scanner-index/1 (+{contact})"},
        )

    def fetch(self, image_url):
        url = image_url.rstrip("/") + "/low.webp"
        if not host_allowed(url):
            raise FetchError("image host is not allowed")
        for attempt in range(TRIES):
            try:
                return self._get(url)
            except _Retryable as error:
                if attempt + 1 < TRIES and error.delay:
                    self.sleep(error.delay)
        raise FetchError("image could not be downloaded")

    def _get(self, url):
        httpx = self._httpx
        deadline = self.clock() + TIMEOUT_SECONDS  # the whole try, redirects and body included
        for _ in range(MAX_REDIRECTS + 1):
            self.limiter.wait()
            if self.clock() > deadline:
                raise _Retryable("timed out")
            try:
                with self.client.stream("GET", url) as response:
                    if response.is_redirect:
                        target = response.headers.get("location", "")
                        url = urllib.parse.urljoin(url, target)
                        if not host_allowed(url):
                            raise FetchError("redirect to a host that is not allowed")
                        continue
                    if response.status_code >= 500 or response.status_code == 429:
                        raise _Retryable("retry", retry_after(response.headers.get("retry-after")))
                    if response.status_code != 200:
                        raise FetchError(f"image answered {response.status_code}")
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if self.clock() > deadline:
                            raise _Retryable("timed out")
                        if len(body) > MAX_IMAGE_BYTES:
                            raise FetchError("image is too large")
                    return bytes(body)
            except (httpx.TimeoutException, httpx.TransportError):
                raise _Retryable("retry") from None
        raise FetchError("too many redirects")


# --- The run -----------------------------------------------------------------------------------------------------------


def read_inputs(conn):
    """(revision, generation, inputs): inputs are (printing id, image_url) of non-tombstoned active-generation printings
    with an image_url, ascending by printing id."""
    state = conn.execute("SELECT active_generation, revision FROM catalog_state").fetchone()
    if state is None or state[0] is None:
        return None, None, []
    rows = conn.execute(
        """SELECT printing_id, image_url FROM catalog_generation_printing
           WHERE generation_id = %s AND NOT tombstoned AND image_url IS NOT NULL AND image_url <> ''""",
        (state[0],),
    ).fetchall()
    return state[1], state[0], sorted(((pid, url) for pid, url in rows), key=lambda row: str(row[0]))


def find_due(conn, model_id, inputs, full):
    """(missing, due): missing printings have no fingerprint for their current image_url; due are those of them with no
    failure ledger entry for that image_url or whose backoff has run out. --full makes every input missing and due."""
    if full:
        return list(inputs), list(inputs)
    have = {(pid, url) for pid, url in conn.execute(
        "SELECT printing_id, image_url FROM scanner_fingerprint WHERE model_id = %s", (model_id,))}
    missing = [item for item in inputs if item not in have]
    if not missing:
        return [], []
    ledger = {pid: (url, failures, failed_at) for pid, url, failures, failed_at in conn.execute(
        "SELECT printing_id, image_url, failures, last_failed_at FROM scanner_fingerprint_failure WHERE model_id = %s",
        (model_id,))}
    now = conn.execute("SELECT now()").fetchone()[0]
    due = []
    for pid, url in missing:
        entry = ledger.get(pid)
        if entry is None or entry[0] != url:
            due.append((pid, url))
        elif entry[2].timestamp() + backoff_seconds(entry[1]) <= now.timestamp():
            due.append((pid, url))
    return missing, due


def fetch_and_embed(fetcher, embedder, url):
    """(scale, vector bytes) for one image. Raises FetchError or EmbedError; the bytes never leave this call."""
    return quantize(embedder.embed(fetcher.fetch(url)))


def embed_due(conn, model_id, due, fetcher, embedder, limit, workers, log):
    """Fetch and embed `due` on a worker pool. Each success is stored at once (a stopped run keeps its work). Returns the
    failed (printing id, image_url) list; stops starting new work once the failures pass `limit`."""
    failed, done = [], 0
    iterator = iter(due)
    pending = {}

    def work(item):
        try:
            return fetch_and_embed(fetcher, embedder, item[1])
        except Exception:  # a fetch, decode or embed fault, whatever its kind, is that image's failure
            return None

    def top_up(pool):
        while len(pending) < workers * 2 and len(failed) <= limit:
            item = next(iterator, None)
            if item is None:
                return
            pending[pool.submit(work, item)] = item

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        top_up(pool)
        while pending:
            finished, _ = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in finished:
                pid, url = pending.pop(future)
                result = future.result()
                done += 1
                if result is None:
                    failed.append((pid, url))
                    continue
                scale, vector = result
                with conn.transaction():
                    conn.execute(
                        """INSERT INTO scanner_fingerprint(printing_id, model_id, image_url, scale, vector)
                           VALUES (%s, %s, %s, %s, %s)
                           ON CONFLICT (printing_id, model_id) DO UPDATE
                           SET image_url = EXCLUDED.image_url, scale = EXCLUDED.scale, vector = EXCLUDED.vector,
                               computed_at = now()""",
                        (pid, model_id, url, scale, vector),
                    )
                    conn.execute("DELETE FROM scanner_fingerprint_failure WHERE printing_id = %s AND model_id = %s",
                                 (pid, model_id))
                if done % 500 == 0:
                    log(f"scanner index: {done}/{len(due)} done, {len(failed)} failed")
            top_up(pool)
    return failed


def record_failures(conn, model_id, failed):
    """One more failure per printing; a changed image_url starts again at 1."""
    for pid, url in failed:
        conn.execute(
            """INSERT INTO scanner_fingerprint_failure(printing_id, model_id, image_url, failures, last_failed_at)
               VALUES (%s, %s, %s, 1, now())
               ON CONFLICT (printing_id, model_id) DO UPDATE
               SET failures = CASE WHEN scanner_fingerprint_failure.image_url = EXCLUDED.image_url
                                   THEN scanner_fingerprint_failure.failures + 1 ELSE 1 END,
                   image_url = EXCLUDED.image_url, last_failed_at = now()""",
            (pid, model_id, url),
        )


def newest_artifact(conn, model_id):
    return conn.execute(
        "SELECT sha256, inputs_digest FROM scanner_index WHERE model_id = %s ORDER BY created_at DESC, sha256 LIMIT 1",
        (model_id,),
    ).fetchone()


def publish(conn, model, revision, digest, inputs):
    """Assemble the file from the current fingerprints of the inputs and publish it, in one transaction. Returns
    (sha256, embedded count, whether a new artifact was stored)."""
    with conn.transaction():
        stored = {pid: (url, scale, bytes(vector)) for pid, url, scale, vector in conn.execute(
            "SELECT printing_id, image_url, scale, vector FROM scanner_fingerprint WHERE model_id = %s", (model.id,))}
        rows = [(pid, stored[pid][1], stored[pid][2]) for pid, url in inputs if pid in stored and stored[pid][0] == url]
        data = pack_pcfp(model.sha256, rows)
        sha = hashlib.sha256(data).hexdigest()
        newest = conn.execute(
            "SELECT sha256 FROM scanner_index WHERE model_id = %s ORDER BY created_at DESC, sha256 LIMIT 1 FOR UPDATE",
            (model.id,),
        ).fetchone()
        if newest is not None and newest[0] == sha:
            conn.execute(
                "UPDATE scanner_index SET catalog_revision = %s, inputs_digest = %s, inputs_count = %s WHERE sha256 = %s",
                (revision, digest, len(inputs), sha),
            )
            new = False
        else:
            # An older artifact with these exact bytes (art reverted) is promoted to newest rather than duplicated.
            other = conn.execute("SELECT model_id FROM scanner_index WHERE sha256 = %s", (sha,)).fetchone()
            if other is not None and other[0] != model.id:
                raise Systemic(f"the new file's sha256 already belongs to model {other[0]}; nothing was published")
            conn.execute(
                """INSERT INTO scanner_index(sha256, model_id, catalog_revision, inputs_digest, count, inputs_count, bytes)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (sha256) DO UPDATE
                   SET catalog_revision = EXCLUDED.catalog_revision, inputs_digest = EXCLUDED.inputs_digest,
                       inputs_count = EXCLUDED.inputs_count, created_at = now()""",
                (sha, model.id, revision, digest, len(rows), len(inputs), data),
            )
            new = True
        conn.execute(
            """DELETE FROM scanner_index WHERE model_id = %s AND sha256 NOT IN
               (SELECT sha256 FROM scanner_index WHERE model_id = %s ORDER BY created_at DESC, sha256 LIMIT %s)""",
            (model.id, model.id, KEEP_ARTIFACTS),
        )
    return sha, len(rows), new


def build(conn, model, make_fetcher, make_embedder, full, workers, log):
    revision, _, inputs = read_inputs(conn)
    if not inputs:
        log("scanner index: the active catalog has no printings with art; nothing to do")
        return OK
    digest = inputs_digest(model.id, inputs)
    missing, due = find_due(conn, model.id, inputs, full)
    newest = newest_artifact(conn, model.id)
    if newest is not None and newest[1] == digest and not due and not full:
        log(f"scanner index: current ({len(inputs) - len(missing)} of {len(inputs)} printings embedded); nothing due")
        return OK
    failed = []
    if due:
        log(f"scanner index: {len(due)} printings to fetch ({len(missing)} missing of {len(inputs)})")
        fetcher = make_fetcher()
        embedder = make_embedder(model)
        failed = embed_due(conn, model.id, due, fetcher, embedder, len(inputs) * SYSTEMIC_FAILURE_PERCENT // 100,
                           workers, log)
    if len(failed) * 100 > len(inputs) * SYSTEMIC_FAILURE_PERCENT:
        # The ledger is left alone: an outage must not push every printing into backoff.
        log(f"scanner index: {len(failed)} of {len(inputs)} printings failed (over {SYSTEMIC_FAILURE_PERCENT}%); "
            "nothing published")
        return SYSTEMIC
    record_failures(conn, model.id, failed)
    sha, count, new = publish(conn, model, revision, digest, inputs)
    log(f"scanner index: {'published' if new else 'unchanged'} {sha[:16]}, {count} of {len(inputs)} printings, "
        f"{len(failed)} failed this run")
    return OK


def default_fetcher():
    contact = os.environ.get("SCANNER_INDEX_CONTACT") or os.environ.get("OWNER_EMAIL")
    if not contact:
        raise Systemic("SCANNER_INDEX_CONTACT (or OWNER_EMAIL) is not set; the User-Agent must name an owner contact")
    return TcgdexFetcher(contact)


def default_embedder(model):
    verify_model_file(model)
    return OnnxEmbedder(model)


def run(database_url=None, *, model=None, full=False, make_fetcher=default_fetcher, make_embedder=default_embedder,
        workers=WORKERS, log=print):
    """One job run; returns the exit code. The factories are called only when something is due."""
    try:
        conn = psycopg.connect(database_url or os.environ["DATABASE_URL"], autocommit=True, connect_timeout=10)
    except (psycopg.Error, KeyError):
        log("scanner index: the database is unreachable")
        return UNREACHABLE
    try:
        if not conn.execute("SELECT pg_try_advisory_lock(%s)", (ADVISORY_LOCK,)).fetchone()[0]:
            log("scanner index: another run holds the lock; nothing was changed")
            return LOCKED
        try:
            return build(conn, model or load_model(), make_fetcher, make_embedder, full, workers, log)
        except Systemic as error:
            log(f"scanner index: {error}")
            return SYSTEMIC
        except psycopg.Error as error:
            log(f"scanner index: the database failed ({type(error).__name__})")
            return UNREACHABLE
        except Exception as error:  # an unforeseen fault is a failed run, never a clean exit
            log(f"scanner index: failed ({type(error).__name__}: {error})")
            return SYSTEMIC
    finally:
        conn.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build and publish the card scanner's fingerprint index.")
    parser.add_argument("--full", action="store_true", help="ignore existing fingerprints and fetch every image")
    args = parser.parse_args(argv)
    return run(full=args.full)


if __name__ == "__main__":
    sys.exit(main())
