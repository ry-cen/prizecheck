"""Trusted request budget for deadline-bound routes (Edition prices, private Deck cost, Published Deck cost, Want List
cost, Trade value).

The gateway takes the receipt time, spends part of the three seconds on its own work, and signs what is
left for the API: milliseconds remaining, the epoch millisecond it signed at, and the caller. A client can
neither extend that deadline nor pick the caller, because the headers are stripped at the gateway and the
signature is checked here with the internal secret. The existing user/time/signature message that
``verified_user`` checks is unchanged (its time stays in seconds); this is a second, separately signed message.

The gateway aborts ``ms`` after it signed, so the time since the signing stamp (transit, queueing in this process,
the body read) is already spent: ``hard`` is now plus ``ms`` minus that elapsed time. Gateway and API share a host
clock, so no skew allowance is added; a clock running ahead only ends the budget early, with the labelled fallback.

``wait_until`` is the point where blocking waits stop (hard minus a 0.5 s reserve for the final
validation and the response). Budget arithmetic uses ``time.monotonic``; only the elapsed time since the signing
stamp is read from the wall clock.
"""
from dataclasses import dataclass, field
import hashlib
import hmac
import os
import re
import time

from fastapi import HTTPException, Request

HARD_SECONDS = 3.0
RESERVE_SECONDS = 0.5
REPLAY_WINDOW_SECONDS = 30
MAX_BODY_BYTES = 16 * 1024
FINAL_MARGIN_MS = 50              # Left after the final validation times out, to build the response.

# (method, path pattern) for every route that carries a gateway budget. Keep in step with BUDGETED_ROUTES in
# auth/src/server.ts; api/tests/test_trade_value.py fails when they differ.
BUDGETED_ROUTES = (
    ('POST', re.compile(r'^/api/prices/editions$')),
    ('GET', re.compile(r'^/api/decks/[^/]+/cost$')),
    ('GET', re.compile(r'^/api/public/decks/[^/]+/versions/[^/]+/cost$')),
    ('GET', re.compile(r'^/api/want-list/cost$')),
    ('POST', re.compile(r'^/api/trades/value$')),
)


def is_budgeted(method: str, path: str) -> bool:
    return any(method == allowed and pattern.fullmatch(path) for allowed, pattern in BUDGETED_ROUTES)


@dataclass(frozen=True)
class Budget:
    hard: float                       # Absolute time.monotonic() value the response must beat.
    caller: str                       # 'user:<id>' or 'anon:<keyed digest>' (public routes).
    wait_until: float = field(default=None)  # type: ignore[assignment]

    def __post_init__(self):
        if self.wait_until is None:
            object.__setattr__(self, 'wait_until', self.hard - RESERVE_SECONDS)

    def remaining(self) -> float:
        return max(0.0, self.hard - time.monotonic())

    def wait_remaining(self) -> float:
        return max(0.0, self.wait_until - time.monotonic())

    def expired(self) -> bool:
        return time.monotonic() >= self.hard

    def pg_timeout_ms(self, final: bool = False) -> int:
        """Statement/lock timeout for the current phase. Never 0, because PostgreSQL reads 0 as "no timeout"."""
        if final:
            return max(1, int(self.remaining() * 1000) - FINAL_MARGIN_MS)
        return max(1, int(self.wait_remaining() * 1000))


def budget_message(method: str, path: str, body_hash: str, caller: str, ms: str, stamp: str) -> bytes:
    return f'budget\n{method}\n{path}\n{body_hash}\n{caller}\n{ms}\n{stamp}'.encode()


def unauthorized():
    return HTTPException(401, 'Authentication required')


async def trusted_budget(request: Request) -> Budget:
    """FastAPI dependency: the gateway-signed budget for this exact request, or 401."""
    secret = os.environ.get('INTERNAL_AUTH_SECRET', '')
    headers = request.headers
    ms, stamp = headers.get('x-internal-budget-ms'), headers.get('x-internal-budget-time')
    caller, signature = headers.get('x-internal-caller'), headers.get('x-internal-budget-signature')
    if not secret or not all((ms, stamp, caller, signature)):
        raise unauthorized()
    if not re.fullmatch(r'[0-9]{1,5}', ms) or not re.fullmatch(r'[0-9]{1,15}', stamp) \
            or not re.fullmatch(r'(user|anon):[A-Za-z0-9._:-]{1,200}', caller):
        raise unauthorized()
    if abs(time.time() * 1000 - int(stamp)) > REPLAY_WINDOW_SECONDS * 1000:  # The budget stamp is epoch milliseconds.
        raise unauthorized()
    body_hash = hashlib.sha256(await request.body()).hexdigest()
    expected = hmac.new(secret.encode(), budget_message(request.method, request.url.path, body_hash, caller, ms, stamp),
                        hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise unauthorized()
    granted_ms = min(int(ms), HARD_SECONDS * 1000)
    spent_ms = max(0.0, time.time() * 1000 - int(stamp))  # Since the gateway signed; a future stamp counts as 0.
    return Budget(hard=time.monotonic() + max(0.0, granted_ms - spent_ms) / 1000, caller=caller)
