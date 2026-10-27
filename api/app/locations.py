"""Owner-scoped Location list and lookup."""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .db import connect
from .identity import verified_user

router = APIRouter()


class Location(BaseModel):
    id: UUID
    name: str
    kind: str
    parent_id: UUID | None
    version: int


class LocationsResponse(BaseModel):
    locations: list[Location]


@router.get("/api/locations", response_model=LocationsResponse)
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


@router.get("/api/locations/{location_id}", response_model=Location)
def location(location_id: UUID, user_id: str = Depends(verified_user)):
    with connect() as conn:
        row = conn.execute(
            "SELECT id, name, kind, parent_id, version FROM location WHERE id = %s AND owner_id = %s",
            (location_id, user_id),
        ).fetchone()
    if row is None:
        raise HTTPException(404, "Location not found")
    return Location(**row)
