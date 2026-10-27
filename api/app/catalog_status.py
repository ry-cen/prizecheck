"""Catalog availability for collectors and the owner's catalog run controls."""
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from . import catalog_dispatch
from .db import connect
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


class OwnerCatalogStatus(BaseModel):
    catalog: CatalogStatus
    run: CatalogRun | None
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
          (outcome IS NULL AND coalesce(lease_until,started_at+interval '2 minutes')<=clock_timestamp()) AS heartbeat_stale
          FROM catalog_run ORDER BY (outcome IS NULL) DESC,started_at DESC LIMIT 1""").fetchone()
        reviews = conn.execute("""SELECT id,kind,source_id,detail,created_at FROM catalog_review
          WHERE status='pending' ORDER BY created_at LIMIT 50""").fetchall()
        return OwnerCatalogStatus(catalog=catalog_status_row(conn), run=CatalogRun(**run) if run else None,
                                  pending_reviews=[CatalogReview(**row) for row in reviews])


@router.post("/api/admin/catalog-runs", response_model=OwnerCatalogStatus)
def start_catalog_run(user_id: str = Depends(verified_user)):
    with connect() as conn:
        require_owner(conn, user_id)
        conn.commit()
        catalog_dispatch.dispatch_import(conn)
    return owner_catalog_status(user_id)
