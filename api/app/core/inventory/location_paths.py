"""Full Location paths for a collector's own inventory views."""
from uuid import UUID


# Full Location paths such as "Shelf / Binder 2", as the ``paths`` CTE; its two parameters are the owner's id. The
# depth guard only stops a corrupt cycle; Location commands already cap the tree at 12 levels.
LOCATION_PATHS = """WITH RECURSIVE paths AS (
  SELECT id,name::text AS path,1 AS depth FROM location WHERE owner_id=%s AND parent_id IS NULL
  UNION ALL
  SELECT child.id,parent.path||' / '||child.name,parent.depth+1
  FROM location child JOIN paths parent ON child.parent_id=parent.id
  WHERE child.owner_id=%s AND parent.depth<32)"""


def location_paths(conn, owner_id: str) -> dict[UUID, str]:
    """Every one of the owner's Locations by id with its full path, in one read. Location names are unique only among
    siblings, so a path is what tells "Binder A / Page 1" from "Binder B / Page 1". Only ever read for the owner's own
    view: Friends never see Location or Deck names."""
    return {row["id"]: row["path"] for row in conn.execute(f"{LOCATION_PATHS} SELECT id,path FROM paths",
                                                             (owner_id, owner_id))}
