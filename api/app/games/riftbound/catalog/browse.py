"""Riftbound Catalog read routes: sets, a paged Edition list and one Edition.

Internal app paths only; the public prefix and gateway mapping are not decided (ADR 0023). Grounding for every relation
and column is in docs/planning/riftbound-backend/catalog-read-api.md.

An Edition is visible only when the active accepted generation (``catalog_state.active_generation``) lists it with
``catalog_generation_edition.active`` and its Printing is not ``catalog_generation_printing.tombstoned``: the rule the
shared ``AVAILABLE`` reader uses. Held, failed and unapproved pulls never become the active generation, so they never show.
Nothing here returns art, prices, facets, source ids or provenance.
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.catalog.card_facts import number_order
from app.games.riftbound.db import connect
from app.games.riftbound.identity import verified_user

PAGE_SIZE = 24

router = APIRouter(prefix="/api/catalog", dependencies=[Depends(verified_user)])


class CatalogSet(BaseModel):
    id: str
    name: str
    code: str


class CatalogEdition(BaseModel):
    id: UUID
    printing_id: UUID
    name: str
    set: CatalogSet
    number: str
    finish: str
    art: str | None = None  # Riftbound art views return no art yet, so this is always null.


class CatalogEditionPage(BaseModel):
    editions: list[CatalogEdition]
    total: int
    pages: int
    catalog_empty: bool


VISIBLE = """
  FROM catalog_state s
  JOIN catalog_generation_edition ge ON ge.generation_id = s.active_generation AND ge.active
  JOIN catalog_generation_printing gp ON gp.generation_id = ge.generation_id AND gp.printing_id = ge.printing_id
       AND NOT gp.tombstoned
  JOIN catalog_edition e ON e.id = ge.edition_id AND e.printing_id = ge.printing_id
  JOIN catalog_printing_set_code psc ON psc.printing_id = gp.printing_id
  WHERE s.singleton"""

EDITIONS = f"""SELECT e.id, e.printing_id, gp.display_name AS name, gp.set_id, gp.set_name, psc.set_code AS code,
  gp.collector_number AS number, e.descriptor {VISIBLE}
  AND (%(set)s = '' OR gp.set_id = %(set)s)
  AND (%(q)s = '' OR position(lower(%(q)s) in lower(gp.display_name)) > 0
       OR position(lower(%(q)s) in lower(gp.collector_number)) > 0)"""

ONE = f"""SELECT e.id, e.printing_id, gp.display_name AS name, gp.set_id, gp.set_name, psc.set_code AS code,
  gp.collector_number AS number, e.descriptor {VISIBLE} AND e.id = %s"""

SETS = f"""SELECT gp.set_id AS id, gp.set_name AS name, min(psc.set_code) AS code {VISIBLE}
  GROUP BY gp.set_id, gp.set_name ORDER BY gp.set_name, gp.set_id"""

ANY_EDITION = f"SELECT EXISTS (SELECT 1 {VISIBLE}) AS present"


def finish(descriptor) -> str:
    """The Edition's finish key from its descriptor ('normal', 'foil'), or 'unspecified'."""
    value = descriptor.get("finish") if isinstance(descriptor, dict) else None
    return value if isinstance(value, str) and value else "unspecified"


def edition(row) -> CatalogEdition:
    return CatalogEdition(id=row["id"], printing_id=row["printing_id"], name=row["name"],
                          set=CatalogSet(id=row["set_id"], name=row["set_name"], code=row["code"]),
                          number=row["number"], finish=finish(row["descriptor"]))


def order(row):
    """Card order as the shared Card.order reads (name, set, natural collector number), then finish, then the Edition id."""
    return row["name"].casefold(), row["set_name"], number_order(row["number"]), finish(row["descriptor"]), row["id"]


@router.get("/sets", response_model=list[CatalogSet])
def sets():
    with connect() as conn:
        return [CatalogSet(**row) for row in conn.execute(SETS).fetchall()]


@router.get("/editions", response_model=CatalogEditionPage)
def editions(q: str = "", set_id: str = Query("", alias="set"), page: int = Query(1, ge=1)):
    with connect() as conn:
        rows = sorted(conn.execute(EDITIONS, {"q": q.strip(), "set": set_id}).fetchall(), key=order)
        present = conn.execute(ANY_EDITION).fetchone()["present"]
    start = (page - 1) * PAGE_SIZE
    return CatalogEditionPage(editions=[edition(row) for row in rows[start:start + PAGE_SIZE]], total=len(rows),
                              pages=max(1, -(-len(rows) // PAGE_SIZE)), catalog_empty=not present)


@router.get("/editions/{edition_id}", response_model=CatalogEdition)
def edition_detail(edition_id: str):
    try:
        found = UUID(edition_id)
    except ValueError:
        raise HTTPException(404, "Edition not found") from None
    with connect() as conn:
        row = conn.execute(ONE, (found,)).fetchone()
    if row is None:
        raise HTTPException(404, "Edition not found")
    return edition(row)
