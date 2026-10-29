"""Publish each priced Edition's price as a public record (ADR 0019, design section 4.6). The writer only: no reader uses it yet.

`price:<edition_ref>` holds exactly {"mapping_revision", "product_id", "amount"}; no date, subtype or source. `publish` is
always a full pass: it holds session advisory lock 914713 (the lock `rebind` takes) from before it reads the desired state
until its last compare-and-swap, so two publishers never interleave and a retry re-reads PostgreSQL instead of replaying an
old snapshot. The registry table `public_price_ref` is kept a superset of the store (a ref is committed there before its
first write and removed only after its delete has committed), so a crash leaves extra registry rows and never an orphan
record; the set reconciled is desired plus registry.
"""
import logging
import time
from dataclasses import dataclass
from decimal import Decimal

from psycopg.pq import TransactionStatus

from .price_binding import PRICE_LOCK
from app.public_projection import public_record_store
from app.public_records import MAX_BATCH, price_key
from app.quote_contract import parse_amount

log = logging.getLogger(__name__)
CHUNK = MAX_BATCH           # Keys per compare-and-swap.
CHUNK_SECONDS = 10          # Per store call (one read slice or one compare-and-swap), so a full publish is never bounded by one deadline.
ATTEMPTS = 4                # Re-read-and-retry rounds when a compare-and-swap loses.
LOCK_SECONDS = 600          # How long a publisher waits for the one in front of it.
LOCK_POLL = 0.2
REGISTRY_CHUNK = 5000
READ_SLICE = 40 * MAX_BATCH  # Keys per store read; each slice gets a fresh deadline.

DESIRED = """SELECT e.public_ref, m.mapping_revision, m.product_id, p.market_price
  FROM catalog_edition e
  JOIN catalog_edition_metadata m ON m.edition_id = e.id AND m.mapping_state = 'verified'
  JOIN edition_price_binding b ON b.edition_id = e.id AND b.product_id = m.product_id
                              AND b.mapping_revision = m.mapping_revision AND b.sub_type_name IS NOT NULL
  JOIN tcgplayer_price p ON p.product_id = b.product_id AND p.sub_type_name = b.sub_type_name
  WHERE p.market_price > 0"""


@dataclass(frozen=True)
class PublishResult:
    written: int
    deleted: int
    unchanged: int


class PublishLockTimeout(Exception):
    """Another publisher held the price lock for longer than LOCK_SECONDS."""


class PublishRaced(Exception):
    """Every round lost a compare-and-swap to another writer of the same keys."""


def amount_text(value: Decimal) -> str:
    return format(value.normalize(), 'f')


def desired_values(conn) -> dict[str, dict]:
    """{edition_ref: record value} for every priced Edition, from one statement (one snapshot)."""
    wanted = {}
    for row in conn.execute(DESIRED).fetchall():
        amount = amount_text(row['market_price'])
        if parse_amount(amount) is None:  # an amount no reader would accept is not published
            continue
        wanted[row['public_ref']] = {'mapping_revision': row['mapping_revision'], 'product_id': row['product_id'],
                                     'amount': amount}
    return wanted


def _settle(conn):
    """Commit a transaction the connection opened implicitly, so that what follows reads and writes committed state."""
    if conn.info.transaction_status == TransactionStatus.INTRANS:
        conn.commit()


def _lock(conn):
    limit = time.monotonic() + LOCK_SECONDS
    while not conn.execute('SELECT pg_try_advisory_lock(%s) AS got', (PRICE_LOCK,)).fetchone()['got']:
        _settle(conn)
        if time.monotonic() >= limit:
            raise PublishLockTimeout()
        time.sleep(LOCK_POLL)
    _settle(conn)


def _unlock(conn):
    try:
        if conn.info.transaction_status == TransactionStatus.INERROR:
            conn.rollback()
        conn.execute('SELECT pg_advisory_unlock(%s)', (PRICE_LOCK,))
        _settle(conn)
    except Exception as error:  # a dead connection has already dropped its session locks
        log.warning('Price lock release failed (%s)', type(error).__name__)


def _registry(conn) -> set[str]:
    rows = conn.execute('SELECT edition_ref FROM public_price_ref').fetchall()
    _settle(conn)
    return {row['edition_ref'] for row in rows}


def _register(conn, refs):
    refs = sorted(refs)
    for start in range(0, len(refs), REGISTRY_CHUNK):
        conn.execute('INSERT INTO public_price_ref(edition_ref) SELECT * FROM unnest(%s::text[]) ON CONFLICT DO NOTHING',
                     (refs[start:start + REGISTRY_CHUNK],))
    _settle(conn)  # committed before the first write


def _unregister(conn, refs):
    refs = sorted(refs)
    for start in range(0, len(refs), REGISTRY_CHUNK):
        conn.execute('DELETE FROM public_price_ref WHERE edition_ref = ANY(%s)', (refs[start:start + REGISTRY_CHUNK],))
    _settle(conn)  # only after the delete has committed in the store


def _deadline():
    return time.monotonic() + CHUNK_SECONDS


def _read(store, store_keys):
    """Read every key in slices, each with its own deadline. Safe because the price lock makes publish the only writer of
    `price:` keys, so the slices need no shared snapshot."""
    records = {}
    for start in range(0, len(store_keys), READ_SLICE):
        records.update(store.read_all(store_keys[start:start + READ_SLICE], deadline=_deadline()).records)
    return records


def _round(conn, store):
    """One re-read-and-write pass. Returns (written, deleted, unchanged, lost) where lost means a compare-and-swap failed."""
    wanted = desired_values(conn)
    _settle(conn)
    registered = _registry(conn)
    _register(conn, set(wanted) - registered)
    refs = sorted(set(wanted) | registered)
    keys = {ref: price_key(ref) for ref in refs}
    current = _read(store, list(keys.values()))
    changes = [ref for ref in refs if current[keys[ref]].value != wanted.get(ref)]
    gone_already = [ref for ref in refs if ref not in wanted and current[keys[ref]].value is None]
    written = deleted = 0
    lost = False
    for start in range(0, len(changes), CHUNK):
        part = changes[start:start + CHUNK]
        expected = {keys[ref]: current[keys[ref]].version for ref in part}
        if not store.compare_and_swap(expected, {keys[ref]: wanted.get(ref) for ref in part}, deadline=_deadline()):
            lost = True
            continue
        removed = [ref for ref in part if ref not in wanted]
        written += len(part) - len(removed)
        deleted += len(removed)
        _unregister(conn, removed)
    _unregister(conn, gone_already)
    return written, deleted, len(wanted) - sum(1 for ref in changes if ref in wanted), lost


def publish(conn, store=None) -> PublishResult:
    """Write `price:` records so the store equals PostgreSQL's priced Editions; only differences are written.

    `conn` may be autocommit or not (an implicit transaction it holds is committed). Raises on a store or database failure
    (ProjectionUnavailable, psycopg errors, PublishLockTimeout, PublishRaced); the callers record or log it and go on."""
    store = store or public_record_store()
    _settle(conn)
    _lock(conn)
    try:
        written = deleted = 0
        for _ in range(ATTEMPTS):
            done_written, done_deleted, unchanged, lost = _round(conn, store)
            written += done_written
            deleted += done_deleted
            if not lost:
                log.info('Published prices: %d written, %d deleted, %d unchanged', written, deleted, unchanged)
                return PublishResult(written, deleted, unchanged)
        raise PublishRaced()
    finally:
        _unlock(conn)
