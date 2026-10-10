"""Bounded on-demand TCGdex card client for the price runners (08-A, plan 2.4).

The origin is fixed in production (the CI fixture rewrites ``ORIGIN`` on import; there is no origin parameter).
One call makes at most two attempts inside a single 2 s deadline, never follows a redirect, ignores proxy
environment, caps the body at 2 MiB and keeps no raw external error text: failures are fixed reason codes.
Charging a token per attempt is the runner's concern: it passes ``may_retry`` and is asked before each retry.
"""
import json
import queue
import random
import re
import threading
import time
from dataclasses import dataclass
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable
from urllib.parse import quote

import httpx

ORIGIN = 'https://api.tcgdex.net'
PATH = '/v2/en/cards/'
DEADLINE_S = 2.0
MAX_ATTEMPTS = 2
MAX_BYTES = 2 * 1024 * 1024
RETRY_WAIT_S = (0.5, 1.0)
RETRY_MARGIN_S = 0.2
RETRY_AFTER_MAX_S = 3600
REASONS = ('timeout', 'transport', 'http_status', 'redirect', 'too_large', 'malformed')

_CARD = re.compile(r'[A-Za-z0-9_.!%~-]{1,128}')
_SECONDS = re.compile(r'[0-9]{1,12}')
_uniform = random.uniform


@dataclass
class Fetched:
    ok: bool
    record: Any = None
    reason: str | None = None       # one of REASONS when not ok
    status: int | None = None       # last HTTP status seen, if any
    retry_after: int | None = None  # validated seconds (1..3600) from the last 429/5xx response, else None
    attempts: int = 0


def parse_retry_after(value, now: float | None = None) -> int | None:
    """Integer seconds >= 1, or a future HTTP-date, capped at one hour; anything else is None."""
    if type(value) is not str:
        return None
    value = value.strip()
    if _SECONDS.fullmatch(value):
        seconds = int(value)
    else:
        try:
            moment = parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        seconds = int(moment.timestamp() - (time.time() if now is None else now))
    return min(seconds, RETRY_AFTER_MAX_S) if seconds >= 1 else None


def _attempt(url: str, deadline: float, cancelled: threading.Event):
    """One bounded GET. Returns ('ok', status, body, retry_after) or ('fail', reason, status, retry_after)."""
    def remaining():
        left = deadline - time.monotonic()
        if left <= 0 or cancelled.is_set():
            raise TimeoutError
        return left
    try:
        with httpx.Client(follow_redirects=False, trust_env=False, timeout=httpx.Timeout(remaining()),
                          headers={'Accept': 'application/json', 'Accept-Encoding': 'identity'}) as client:
            with client.stream('GET', url) as response:
                status = response.status_code
                retry_after = parse_retry_after(response.headers.get('retry-after')) if status in (429, 503) or status >= 500 else None
                if 300 <= status < 400:
                    return 'fail', 'redirect', status, None
                if status != 200:
                    return 'fail', 'http_status', status, retry_after
                chunks, size = [], 0
                for chunk in response.iter_raw():
                    remaining()
                    size += len(chunk)
                    if size > MAX_BYTES:
                        return 'fail', 'too_large', status, None
                    chunks.append(chunk)
                return 'ok', status, b''.join(chunks), None
    except (TimeoutError, httpx.TimeoutException):
        return 'fail', 'timeout', None, None
    except Exception:
        return 'fail', 'transport', None, None


def _bounded(url: str, deadline: float):
    results: queue.Queue = queue.Queue()
    cancelled = threading.Event()
    threading.Thread(target=lambda: results.put(_attempt(url, deadline, cancelled)), daemon=True).start()
    try:
        return results.get(timeout=max(deadline - time.monotonic(), 0) + 0.01)
    except queue.Empty:
        cancelled.set()
        return 'fail', 'timeout', None, None


def fetch(card, may_retry: Callable[[], bool] | None = None) -> Fetched:
    """GET one card record. ``may_retry`` is asked (and may spend a token) only when a retry is otherwise allowed."""
    if type(card) is not str or not _CARD.fullmatch(card):
        return Fetched(False, reason='malformed')
    url = ORIGIN + PATH + quote(card, safe='-._~')
    deadline = time.monotonic() + DEADLINE_S
    outcome = Fetched(False)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        outcome.attempts = attempt
        kind, first, second, third = _bounded(url, deadline)
        if kind == 'ok':
            outcome.status = first
            try:
                outcome.record = json.loads(second.decode('utf-8'), parse_float=str)
            except (ValueError, RecursionError):
                outcome.reason = 'malformed'
                return outcome
            outcome.ok, outcome.reason, outcome.retry_after = True, None, None
            return outcome
        outcome.reason, outcome.retry_after = first, third
        if second is not None:
            outcome.status = second
        retryable = first in ('timeout', 'transport') or (first == 'http_status' and (second == 429 or second >= 500))
        if not retryable or attempt == MAX_ATTEMPTS:
            return outcome
        if outcome.retry_after is not None and outcome.retry_after > RETRY_WAIT_S[1]:
            return outcome  # the origin asked for longer than our retry window; never retry early
        wait = _uniform(*RETRY_WAIT_S)
        if deadline - time.monotonic() < wait + RETRY_MARGIN_S:
            return outcome
        if may_retry is not None and not may_retry():
            return outcome
        time.sleep(wait)
    return outcome
