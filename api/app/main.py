"""Private inventory API. Only the auth gateway may assert a user identity."""
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from .borrowed_gallery import router as borrowed_gallery_router
from .db import connect
from .operation_counts import Count, DatabaseWriter, counter as operation_counter
from .price_budget import is_budgeted
from app.games.pokemon.app import LIFESPAN_HOOKS, ROUTERS


class HealthResponse(BaseModel):
    status: str


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Background startup work, in the order the routers' startup handlers used to run.
    startup, shutdown = LIFESPAN_HOOKS
    for hook in startup:
        hook()
    yield
    for hook in shutdown:
        hook()
    # Give counts still queued a short, bounded time to reach PostgreSQL, then stop the writer thread.
    await run_in_threadpool(operation_counter.stop)


app = FastAPI(title="PrizeCheck API", version="0.1.0", lifespan=lifespan)


@app.get("/api/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok")


app.include_router(borrowed_gallery_router)

for included in ROUTERS:
    app.include_router(included)

operation_counter.set_writer(DatabaseWriter(lambda **options: connect(**options)))


@app.middleware('http')
async def bounded_operational_counts(request: Request,call_next):
    started = time.perf_counter()
    response = await call_next(request)
    # Anonymous projection requests must never wake the private database.
    # Budgeted routes (prices) are exempt: a count is a read route writing, and their three seconds are spent.
    # The count is only handed to the background writer (app/operation_counts.py); nothing here waits on PostgreSQL.
    if request.url.path.startswith('/api/') and not request.url.path.startswith('/api/public/') and request.url.path!='/api/health' \
            and not is_budgeted(request.method, request.url.path):
        operation_counter.record(Count(
            failures=int(response.status_code>=500),
            authorization_denials=int(response.status_code in (401,403)),
            elapsed_ms=int((time.perf_counter()-started)*1000),
            projection_failures=int(response.status_code>=500 and '/publication' in request.url.path)))
    return response
