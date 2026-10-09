"""Trusted PostgreSQL-to-shared-records writer for public-safe catalog records.

Anonymous readers resolve opaque Edition/Printing references only through these
records. Values are a strict allowlist: the public reference, display fields and
the physical descriptor. Internal UUIDs, source IDs, owners, Holdings, Locations,
sessions, review state and quotes never appear here.

Failure semantics: the records store is a derived, rebuildable copy. A failed
write never rolls back the PostgreSQL commit that triggered it, and it never
touches Published Deck snapshots, visibility or the discovery revision (those live
in the separate publication projection). `publish_catalog_best_effort` swallows and
reports failure; `backfill` (scripts/backfill_public_catalog.py) is the idempotent
retry/recovery path and rewrites only records whose value differs.
"""
import logging
import time
from dataclasses import dataclass

from .public_projection import ProjectionUnavailable, public_record_store
from .public_records import catalog_edition_key, catalog_printing_key

log = logging.getLogger(__name__)
BATCH_KEYS = 128
PRINTING_PAGE = 40
ATTEMPTS = 4
BUDGET_SECONDS = 20


@dataclass(frozen=True)
class CatalogPublication:
    written: int
    unchanged: int


def public_image_url(image_url):
    """The same derived image the frozen Published Deck rows use."""
    return f'{image_url}/low.webp' if image_url else None


def printing_value(row):
    return {'printing_ref': row['printing_ref'], 'name': row['display_name'], 'set_id': row['set_id'],
            'set_name': row['set_name'], 'collector_number': row['collector_number'],
            'image_url': public_image_url(row['image_url'])}


def edition_value(row):
    return {'edition_ref': row['edition_ref'], 'printing_ref': row['printing_ref'], 'descriptor': row['descriptor']}


def _pages(conn, printing_ids):
    last = None
    while True:
        printings = conn.execute("""SELECT p.id,p.public_ref AS printing_ref,ci.display_name,
          coalesce(pd.set_id,'') AS set_id,coalesce(pd.set_name,'') AS set_name,
          coalesce(pd.collector_number,'') AS collector_number,pd.image_url
          FROM catalog_printing p JOIN catalog_identity ci ON ci.id=p.identity_id
          LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
          WHERE (%s::uuid IS NULL OR p.id>%s::uuid) AND (%s::uuid[] IS NULL OR p.id=ANY(%s::uuid[]))
          ORDER BY p.id LIMIT %s""", (last, last, printing_ids, printing_ids, PRINTING_PAGE)).fetchall()
        if not printings:
            return
        editions = conn.execute("""SELECT e.public_ref AS edition_ref,p.public_ref AS printing_ref,e.descriptor
          FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          WHERE e.printing_id=ANY(%s::uuid[]) ORDER BY e.id""", ([row['id'] for row in printings],)).fetchall()
        desired = {catalog_printing_key(row['printing_ref']): printing_value(row) for row in printings}
        desired.update({catalog_edition_key(row['edition_ref']): edition_value(row) for row in editions})
        yield desired
        last = printings[-1]['id']


def _sync(store, desired, budget):
    keys = list(desired)
    written = 0
    for start in range(0, len(keys), BATCH_KEYS):
        chunk = {key: desired[key] for key in keys[start:start + BATCH_KEYS]}
        for _ in range(ATTEMPTS):
            snapshot = store.read_records(list(chunk), deadline=budget)
            changes = {key: value for key, value in chunk.items() if snapshot.records[key].value != value}
            if not changes:
                break
            if store.compare_and_swap({key: snapshot.records[key].version for key in changes}, changes, deadline=budget):
                written += len(changes)
                break
        else:
            raise ProjectionUnavailable()
    return written


def publish_catalog(conn, *, printing_ids=None, store=None):
    """Write missing/changed records for all (or the given) Printings and their Editions.

    Raises ProjectionUnavailable when the records store cannot be written. Safe to
    repeat: unchanged records are not rewritten.
    """
    store = store or public_record_store()
    budget = time.monotonic() + BUDGET_SECONDS
    written = total = 0
    ids = [str(value) for value in printing_ids] if printing_ids is not None else None
    for desired in _pages(conn, ids):
        written += _sync(store, desired, budget)
        total += len(desired)
    return CatalogPublication(written=written, unchanged=total - written)


def publish_catalog_best_effort(conn=None, *, printing_ids=None):
    """Post-commit hook: never raises, never affects the committed PostgreSQL work."""
    try:
        if conn is None:
            from .main import connect
            with connect() as own:
                publish_catalog(own, printing_ids=printing_ids)
        else:
            try:
                publish_catalog(conn, printing_ids=printing_ids)
            finally:
                conn.rollback()
        return True
    except Exception as exc:  # Records are rebuildable; report only the class, never details.
        log.warning('Public catalog records not published (%s); run scripts/backfill_public_catalog.py', type(exc).__name__)
        return False


def backfill():
    """Idempotent full republish from PostgreSQL; raises when the store is unavailable."""
    from .main import connect
    with connect() as conn:
        return publish_catalog(conn)
