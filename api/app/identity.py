"""Who is calling: the auth gateway's signed identity and the owner check."""
import hashlib
import hmac
import os
import time

from fastapi import Header, HTTPException, Request


async def verified_user(
    request: Request,
    x_internal_user: str | None = Header(default=None),
    x_internal_time: str | None = Header(default=None),
    x_internal_signature: str | None = Header(default=None),
) -> str:
    """The user id the auth gateway signed for this request, or 401."""
    secret = os.environ.get("INTERNAL_AUTH_SECRET", "")
    if not secret or not all((x_internal_user, x_internal_time, x_internal_signature)):
        raise HTTPException(401, "Authentication required")
    try:
        stamp = int(x_internal_time)
    except (ValueError, TypeError):
        raise HTTPException(401, "Authentication required") from None
    if abs(time.time() - stamp) > 30:
        raise HTTPException(401, "Authentication required")
    path = request.url.path
    body_hash = hashlib.sha256(await request.body()).hexdigest()
    message = f"{request.method}\n{path}\n{body_hash}\n{x_internal_user}\n{stamp}".encode()
    expected = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, x_internal_signature):
        raise HTTPException(401, "Authentication required")
    return x_internal_user


def require_owner(conn, user_id: str):
    """Raise 403 unless user_id is the bound owner."""
    row = conn.execute("SELECT 1 FROM owner_binding WHERE singleton AND user_id=%s", (user_id,)).fetchone()
    if not row:
        raise HTTPException(403, "Owner access required")
