"""Catalog availability for collectors and the owner's catalog run controls."""
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from . import catalog_dispatch
from .db import connect
from .metadata_reviews import matched_by_number_editions
from .identity import require_owner, verified_user

router = APIRouter()


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


class PriceImportRun(BaseModel):
    """The newest finished price import (owner only; collector responses never carry it)."""
    outcome: str
    started_at: datetime
    finished_at: datetime | None
    source_updated_at: datetime | None
    groups_total: int | None
    groups_failed: int
    verified_editions: int | None
    priced_editions: int | None
    unpriced: dict[str, int]
    fallback_art: int | None
    public_error: str | None
    error_code: str | None


class CatalogCheck(BaseModel):
    """The newest scheduled change check (#340; owner only, collector responses never carry it)."""
    outcome: str | None
    started_at: datetime
    finished_at: datetime | None
    new_count: int | None
    removed_count: int | None
    catalog_run_id: UUID | None
    run_outcome: str | None
    error_code: str | None
    index_exit_code: int | None
    # Computed in the database. An unfinished check older than 30 minutes crashed.
    unfinished_stale: bool = False
    # A pull succeeded after this check began, so a `paused` check no longer describes the catalog.
    pull_succeeded_after: bool = False


class OwnerCatalogStatus(BaseModel):
    catalog: CatalogStatus
    run: CatalogRun | None
    last_check: CatalogCheck | None = None
    last_price_import: PriceImportRun | None = None
    last_good_price_import_at: datetime | None = None
    source_updated_at_max: datetime | None = None
    # Computed in the database so the 48 h rule never depends on the browser's clock.
    price_import_stale: bool = False
    price_source_stale: bool = False
    # Verified Editions the card-number path matched (the Metadata tab lists them for review).
    matched_by_number: int = 0
    pending_reviews: list[CatalogReview]


def catalog_status_row(conn) -> CatalogStatus:
    row = conn.execute("SELECT active_generation, revision, last_success FROM catalog_state WHERE singleton").fetchone()
    return CatalogStatus(available=row["active_generation"] is not None, revision=row["revision"], last_success=row["last_success"])


@router.get("/api/catalog/status", response_model=CatalogStatus)
def catalog_status(user_id: str = Depends(verified_user)):
    with connect() as conn:
        return catalog_status_row(conn)


@router.get("/api/admin/catalog-runs", response_model=OwnerCatalogStatus)
def owner_catalog_status(user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        run = conn.execute("""SELECT id,phase,outcome,enumerated_count,fetched_count,validated_count,error,started_at,finished_at,
          (outcome IS NULL AND coalesce(lease_until,started_at+interval '2 minutes')<=clock_timestamp()
           AND NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND database=(
               SELECT oid FROM pg_database WHERE datname=current_database())
             AND classid=0 AND objid=%s AND objsubid=1)) AS heartbeat_stale
          FROM catalog_run ORDER BY (outcome IS NULL) DESC,started_at DESC LIMIT 1""",(catalog_dispatch.RUNNER_LOCK,)).fetchone()
        reviews = conn.execute("""SELECT id,kind,source_id,detail,created_at FROM catalog_review
          WHERE status='pending' ORDER BY created_at LIMIT 50""").fetchall()
        latest = conn.execute("""SELECT outcome,started_at,finished_at,source_updated_at,groups_total,groups_failed,verified_editions,
          priced_editions,unpriced,fallback_art,public_error,error_code
          FROM price_import WHERE outcome IS NOT NULL ORDER BY id DESC LIMIT 1""").fetchone()
        ages = conn.execute("""SELECT g.good,s.source_max,
          coalesce(g.good < now()-interval '48 hours', true) AS import_stale,
          coalesce(s.source_max < now()-interval '48 hours', true) AS source_stale
          FROM (SELECT max(finished_at) AS good FROM price_import WHERE outcome IN ('imported','unchanged')) g,
               (SELECT max(source_updated_at) AS source_max FROM tcgplayer_price) s""").fetchone()
        check = conn.execute("""SELECT c.outcome,c.started_at,c.finished_at,c.new_count,c.removed_count,c.catalog_run_id,
          r.outcome AS run_outcome,c.error_code,c.index_exit_code,
          (c.outcome IS NULL AND c.started_at < clock_timestamp() - interval '30 minutes') AS unfinished_stale,
          EXISTS (SELECT 1 FROM catalog_run s WHERE s.outcome = 'succeeded' AND s.finished_at > c.started_at) AS pull_succeeded_after
          FROM catalog_check c LEFT JOIN catalog_run r ON r.id = c.catalog_run_id
          ORDER BY c.started_at DESC, c.id LIMIT 1""").fetchone()
        return OwnerCatalogStatus(catalog=catalog_status_row(conn), run=CatalogRun(**run) if run else None,
                                  last_check=CatalogCheck(**check) if check else None,
                                  last_price_import=PriceImportRun(**latest) if latest else None,
                                  last_good_price_import_at=ages["good"], source_updated_at_max=ages["source_max"],
                                  matched_by_number=len(matched_by_number_editions(conn)),
                                  price_import_stale=bool(latest) and ages["import_stale"],
                                  price_source_stale=bool(latest) and ages["source_stale"],
                                  pending_reviews=[CatalogReview(**row) for row in reviews])


@router.post("/api/admin/catalog-runs", response_model=OwnerCatalogStatus)
def start_catalog_run(user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        conn.commit()
        catalog_dispatch.dispatch_import(conn)
    return owner_catalog_status(user_id)
