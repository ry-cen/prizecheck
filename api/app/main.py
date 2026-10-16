"""Private inventory API. Only the auth gateway may assert a user identity."""
import hashlib
import hmac
import os
import time
from datetime import datetime
from contextlib import asynccontextmanager
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row


class Location(BaseModel):
    id: UUID
    name: str
    kind: str
    parent_id: UUID | None
    version: int


class LocationsResponse(BaseModel):
    locations: list[Location]


class HealthResponse(BaseModel):
    status: str


class CatalogStatus(BaseModel):
    available: bool
    revision: int
    last_success: datetime | None


class CatalogRun(BaseModel):
    id: UUID
    phase: str
    outcome: str | None
    enumerated_count: int
    fetched_count: int
    validated_count: int
    error: str | None
    started_at: datetime
    finished_at: datetime | None
    heartbeat_stale: bool


class CatalogReview(BaseModel):
    id: UUID
    kind: str
    source_id: str
    detail: str
    created_at: datetime


class OwnerCatalogStatus(BaseModel):
    catalog: CatalogStatus
    run: CatalogRun | None
    pending_reviews: list[CatalogReview]


def connect():
    return psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row)


async def verified_user(
    request: Request,
    x_internal_user: str | None = Header(default=None),
    x_internal_time: str | None = Header(default=None),
    x_internal_signature: str | None = Header(default=None),
) -> str:
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


app = FastAPI(title="PrizeCheck API", version="0.1.0")


@app.get("/api/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok")


@app.get("/api/locations", response_model=LocationsResponse)
def locations(user_id: str = Depends(verified_user)):
    with connect() as conn:
        with conn.transaction():
            # One transaction protects onboarding against repeated tabs/requests.
            created = conn.execute("INSERT INTO inventory_owner (user_id) VALUES (%s) ON CONFLICT DO NOTHING RETURNING user_id", (user_id,)).fetchone()
            if created:
                conn.execute("""INSERT INTO location (id, owner_id, parent_id, name, kind)
                  VALUES (gen_random_uuid(), %s, NULL, 'Unsorted', 'storage_leaf')""", (user_id,))
            rows = conn.execute(
                "SELECT id, name, kind, parent_id, version FROM location WHERE owner_id = %s ORDER BY created_at, id",
                (user_id,),
            ).fetchall()
    return LocationsResponse(locations=[Location(**row) for row in rows])


@app.get("/api/locations/{location_id}", response_model=Location)
def location(location_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        row = conn.execute(
            "SELECT id, name, kind, parent_id, version FROM location WHERE id = %s AND owner_id = %s",
            (location_id, user_id),
        ).fetchone()
    if row is None:
        raise HTTPException(404, "Location not found")
    return Location(**row)


def require_owner(conn, user_id: str):
    row = conn.execute("SELECT 1 FROM owner_binding WHERE singleton AND user_id=%s", (user_id,)).fetchone()
    if not row:
        raise HTTPException(403, "Owner access required")


def catalog_status_row(conn) -> CatalogStatus:
    row = conn.execute("SELECT active_generation, revision, last_success FROM catalog_state WHERE singleton").fetchone()
    return CatalogStatus(available=row["active_generation"] is not None, revision=row["revision"], last_success=row["last_success"])


@app.get("/api/catalog/status", response_model=CatalogStatus)
def catalog_status(user_id: str = Depends(verified_user)):
    with connect() as conn:
        return catalog_status_row(conn)


@app.get("/api/admin/catalog-runs", response_model=OwnerCatalogStatus)
def owner_catalog_status(user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        run = conn.execute("""SELECT id,phase,outcome,enumerated_count,fetched_count,validated_count,error,started_at,finished_at,
          (outcome IS NULL AND coalesce(lease_until,started_at+interval '2 minutes')<=clock_timestamp()) AS heartbeat_stale
          FROM catalog_run ORDER BY (outcome IS NULL) DESC,started_at DESC LIMIT 1""").fetchone()
        reviews = conn.execute("""SELECT id,kind,source_id,detail,created_at FROM catalog_review
          WHERE status='pending' ORDER BY created_at LIMIT 50""").fetchall()
        return OwnerCatalogStatus(catalog=catalog_status_row(conn), run=CatalogRun(**run) if run else None,
                                  pending_reviews=[CatalogReview(**row) for row in reviews])


@app.post("/api/admin/catalog-runs", response_model=OwnerCatalogStatus)
def start_catalog_run(user_id: str = Depends(verified_user)):
    from .catalog_dispatch import dispatch_import
    with connect() as conn:
        require_owner(conn, user_id)
        conn.commit()
        dispatch_import(conn)
    return owner_catalog_status(user_id)


from .location_tree import router as location_tree_router  # noqa: E402
from .catalog_search import router as catalog_search_router  # noqa: E402
from .holdings import router as holdings_router  # noqa: E402
from .missing_cards import router as missing_cards_router  # noqa: E402
from .moves import router as moves_router  # noqa: E402

app.include_router(location_tree_router)
app.include_router(catalog_search_router)
app.include_router(holdings_router)
app.include_router(missing_cards_router)
app.include_router(moves_router)
from .collection import router as collection_router  # noqa: E402
app.include_router(collection_router)
from .catalog_browse import router as catalog_browse_router  # noqa: E402
app.include_router(catalog_browse_router)
from .settings import router as settings_router  # noqa: E402
app.include_router(settings_router)

from .decks import router as decks_router  # noqa: E402
app.include_router(decks_router)
from .deck_list_printing import router as deck_list_printing_router  # noqa: E402
app.include_router(deck_list_printing_router)
from .deck_import import router as deck_import_router  # noqa: E402
app.include_router(deck_import_router)
from .deck_pick_list import router as deck_pick_list_router  # noqa: E402
app.include_router(deck_pick_list_router)
from .deck_deletion import router as deck_deletion_router  # noqa: E402
app.include_router(deck_deletion_router)
from .catalog_reconciliation import router as catalog_reconciliation_router  # noqa: E402
app.include_router(catalog_reconciliation_router)
from .metadata_reviews import router as metadata_reviews_router  # noqa: E402
app.include_router(metadata_reviews_router)
from .attribute_corrections import router as attribute_corrections_router  # noqa: E402
app.include_router(attribute_corrections_router)
from .reprint_group_reviews import router as reprint_group_reviews_router  # noqa: E402
app.include_router(reprint_group_reviews_router)

from .publications import router as publications_router  # noqa: E402
app.include_router(publications_router)

from .discovery import router as discovery_router  # noqa: E402
app.include_router(discovery_router)

from .operations import router as operations_router  # noqa: E402
app.include_router(operations_router)

from .prices import router as prices_router  # noqa: E402
app.include_router(prices_router)
from .deck_live_export import router as deck_live_export_router  # noqa: E402
app.include_router(deck_live_export_router)
from .deck_mass_entry import router as deck_mass_entry_router  # noqa: E402
app.include_router(deck_mass_entry_router)
from .deck_cost import router as deck_cost_router  # noqa: E402
app.include_router(deck_cost_router)
from .want_list import router as want_list_router  # noqa: E402
app.include_router(want_list_router)
from .want_list_cost import router as want_list_cost_router  # noqa: E402
app.include_router(want_list_cost_router)
from .want_list_mass_entry import router as want_list_mass_entry_router  # noqa: E402
app.include_router(want_list_mass_entry_router)
from .deck_format_checks import router as deck_format_checks_router  # noqa: E402
app.include_router(deck_format_checks_router)
from .published_cost import router as published_cost_router  # noqa: E402
app.include_router(published_cost_router)
from .published_live_export import router as published_live_export_router  # noqa: E402
app.include_router(published_live_export_router)
from .published_mass_entry import router as published_mass_entry_router  # noqa: E402
app.include_router(published_mass_entry_router)
from .published_format_checks import router as published_format_checks_router  # noqa: E402
app.include_router(published_format_checks_router)
from .format_standing import router as format_standing_router  # noqa: E402
app.include_router(format_standing_router)
from .collection_import import router as collection_import_router  # noqa: E402
app.include_router(collection_import_router)
from .social.profile import router as profile_router, public_router as public_invite_router  # noqa: E402
app.include_router(profile_router)
app.include_router(public_invite_router)
from .social.friends import router as friends_router  # noqa: E402
app.include_router(friends_router)


from .price_budget import is_budgeted  # noqa: E402


@app.middleware('http')
async def bounded_operational_counts(request: Request,call_next):
    started = time.perf_counter()
    response = await call_next(request)
    # Anonymous projection requests must never wake the private database.
    # Budgeted routes (prices) are exempt: this write is a synchronous PostgreSQL connect on the event loop before the
    # response is sent, which would spend their three seconds and make a read route write.
    if request.url.path.startswith('/api/') and not request.url.path.startswith('/api/public/') and request.url.path!='/api/health' \
            and not is_budgeted(request.method, request.url.path):
        try:
            with connect() as conn:
                conn.execute("""INSERT INTO operations_hour(hour,requests,failures,authorization_denials,elapsed_ms)
                  VALUES(date_trunc('hour',now()),1,%s,%s,%s)
                  ON CONFLICT(hour) DO UPDATE SET requests=operations_hour.requests+1,
                  failures=operations_hour.failures+excluded.failures,
                  authorization_denials=operations_hour.authorization_denials+excluded.authorization_denials,
                  elapsed_ms=operations_hour.elapsed_ms+excluded.elapsed_ms""",
                  (int(response.status_code>=500),int(response.status_code in (401,403)),int((time.perf_counter()-started)*1000)))
                if response.status_code>=500 and '/publication' in request.url.path:
                    conn.execute('UPDATE operations_state SET projection_failures=projection_failures+1 WHERE singleton')
                conn.execute("DELETE FROM operations_hour WHERE hour<now()-interval '48 hours'")
        except psycopg.Error:
            pass
    return response
