"""Who is calling the Riftbound backend: the gateway's signed identity, verified with Riftbound's own key.

Same header and HMAC transport as ``app.identity.verified_user`` (the gateway signs method, path, body hash, user and
time), but the secret is ``RIFTBOUND_INTERNAL_AUTH_SECRET``. ADR 0023 gives Riftbound its own key, so a request signed
with Pokémon's ``INTERNAL_AUTH_SECRET`` is rejected here. No key is created or configured by this code.

This repeats ``verified_user``'s check rather than sharing it, because the slice leaves ``app.identity`` untouched.
Consolidating the signature check into one core helper is a later candidate.
"""
import hashlib
import hmac
import os
import time

from fastapi import Header, HTTPException, Request

SECRET_ENV = "RIFTBOUND_INTERNAL_AUTH_SECRET"
MAX_SKEW_SECONDS = 30


async def verified_user(
    request: Request,
    x_internal_user: str | None = Header(default=None),
    x_internal_time: str | None = Header(default=None),
    x_internal_signature: str | None = Header(default=None),
) -> str:
    """The user id the gateway signed for this request, or 401."""
    secret = os.environ.get(SECRET_ENV, "")
    if not secret or not all((x_internal_user, x_internal_time, x_internal_signature)):
        raise HTTPException(401, "Authentication required")
    try:
        stamp = int(x_internal_time)
    except (ValueError, TypeError):
        raise HTTPException(401, "Authentication required") from None
    if abs(time.time() - stamp) > MAX_SKEW_SECONDS:
        raise HTTPException(401, "Authentication required")
    body_hash = hashlib.sha256(await request.body()).hexdigest()
    message = f"{request.method}\n{request.url.path}\n{body_hash}\n{x_internal_user}\n{stamp}".encode()
    expected = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, x_internal_signature):
        raise HTTPException(401, "Authentication required")
    return x_internal_user
