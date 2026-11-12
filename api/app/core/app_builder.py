"""Common FastAPI composition. No game is selected here.

Building twice creates independent route/middleware stacks sharing the process counter.
An entry explicitly supplies its connection factory to bind the shared writer.
Repeated builds without a factory leave that binding alone; supplying one again
replaces the writer, rather than registering a second counter or background thread.
"""
import time
from collections.abc import Callable, Sequence
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from .ops.operation_counts import Count, DatabaseWriter, counter as operation_counter
from .prices.price_budget import is_budgeted


def build_app(*, title: str, version: str, routers: Sequence[APIRouter],
              lifespan_hooks: tuple[Sequence[Callable], Sequence[Callable]],
              health_endpoint: Callable, health_response_model: type[BaseModel],
              connect: Callable | None = None) -> FastAPI:
    """Compose one entry's routes and hooks, optionally binding its counter writer.

    The entry supplies its health callable/model to preserve their public Python identity.
    """
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Background startup work, in the order the routers' startup handlers used to run.
        startup, shutdown = lifespan_hooks
        for hook in startup:
            hook()
        yield
        for hook in shutdown:
            hook()
        # Give counts still queued a short, bounded time to reach PostgreSQL, then stop the writer thread.
        await run_in_threadpool(operation_counter.stop)

    app = FastAPI(title=title, version=version, lifespan=lifespan)
    app.add_api_route("/api/health", health_endpoint, methods=["GET"], response_model=health_response_model)

    for included in routers:
        app.include_router(included)

    if connect is not None:
        operation_counter.set_writer(DatabaseWriter(connect))

    @app.middleware('http')
    async def bounded_operational_counts(request: Request,call_next):
        started = time.perf_counter()
        response = await call_next(request)
        # Anonymous projection requests must never wake the private database.
        # Budgeted routes (prices) are exempt: a count is a read route writing, and their three seconds are spent.
        # The count is only handed to the background writer (app/core/ops/operation_counts.py); nothing here waits on PostgreSQL.
        if request.url.path.startswith('/api/') and not request.url.path.startswith('/api/public/') and request.url.path!='/api/health' \
                and not is_budgeted(request.method, request.url.path):
            operation_counter.record(Count(
                failures=int(response.status_code>=500),
                authorization_denials=int(response.status_code in (401,403)),
                elapsed_ms=int((time.perf_counter()-started)*1000),
                projection_failures=int(response.status_code>=500 and '/publication' in request.url.path)))
        return response

    return app
