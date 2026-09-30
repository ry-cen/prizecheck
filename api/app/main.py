"""Private inventory API. Only the auth gateway may assert a user identity."""
import hashlib
import hmac
import os
import time
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


app = FastAPI(title="TCG Collection API", version="0.1.0")


@app.get("/api/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok")


@app.get("/api/locations", response_model=LocationsResponse)
def locations(user_id: str = Depends(verified_user)):
    with connect() as conn:
        with conn.transaction():
            # One transaction protects onboarding against repeated tabs/requests.
            conn.execute("INSERT INTO inventory_owner (user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user_id,))
            conn.execute(
                """INSERT INTO location (id, owner_id, parent_id, name, kind)
                   SELECT gen_random_uuid(), %s, NULL, 'Unsorted', 'storage_leaf'
                   WHERE NOT EXISTS (
                     SELECT 1 FROM location WHERE owner_id = %s AND parent_id IS NULL AND name = 'Unsorted'
                   ) ON CONFLICT DO NOTHING""",
                (user_id, user_id),
            )
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
