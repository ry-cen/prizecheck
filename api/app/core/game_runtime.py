"""What one game's API supplies to the shared core: its database, sign-in check, cursor key and request counter.
An app binds one runtime on ``app.state``; core handlers resolve it per request and never import an entry's globals.
An app with no runtime fails closed (500) before any database is opened."""
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import Header, Request

from app.core.ops.operation_counts import OperationCounter


@dataclass(frozen=True)
class GameRuntime:
    game: str  # 'pokemon' | 'riftbound'
    connect: Callable[..., Any]  # psycopg factory: connect(**options)
    verify: Callable[[Request, str | None, str | None, str | None], Awaitable[str]]
    cursor_secret: Callable[[], bytes]  # resolved lazily, at sign/verify time only
    counter: OperationCounter


def runtime_of(request: Request) -> GameRuntime:
    runtime = getattr(request.app.state, 'game_runtime', None)
    if runtime is None:
        raise RuntimeError('no game runtime is bound to this app')  # fail closed: 500, no database touched
    return runtime


async def game_runtime(request: Request) -> GameRuntime:
    return runtime_of(request)


async def verified_user(
    request: Request,
    x_internal_user: str | None = Header(default=None),
    x_internal_time: str | None = Header(default=None),
    x_internal_signature: str | None = Header(default=None),
) -> str:
    """The user id this app's runtime verifies from the gateway's signed headers, or 401."""
    return await runtime_of(request).verify(request, x_internal_user, x_internal_time, x_internal_signature)
