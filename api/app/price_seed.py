"""Seed the price cache from a catalog import (ADR 0013).

A full pull already receives each card's TCGdex pricing. After the import has committed and its catalog records are
published, each verified Edition with a published quote lookup gets the records the price runner writes on a
successful source check (docs/price-refresh.md, "Import seeding"):

- the quote is chosen by ``tcgdex_record.select_quote`` from the card parsed with exact decimal text, as the runner
  chooses it from a card it fetched, and passes the same ``quote_contract`` validators;
- ``checked_at`` is when the import received the card; ``provider_updated_at`` is TCGdex's own pricing time;
- one CAS per batch expects every key it read, bumps ``fence:`` to the attempt it writes, and never touches the
  scheduler, ``work:`` or ``backoff:``.

An Edition keeps whatever the cache holds when PostgreSQL and the store's catalog records disagree, a refresh is
queued unexpired or running (``work:``, a stale expired one does not count), the cached check is as new or newer, the cached result is pending or unreadable, or the
provider lists no price: an import never records confirmed absence. Seeding is best effort. It never raises, and a
store outage ends it without touching the committed import.
"""
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import logging
import time
from uuid import uuid4

from psycopg.pq import TransactionStatus

from . import price_launcher
from . import quote_contract as qc
from .catalog_targets import edition_targets, is_unspecified
from .public_catalog import _marketplace as marketplace_of
from .public_projection import ProjectionUnavailable
from .public_records import catalog_edition_key, public_record_store, quarantine_key, quote_key, result_key
from .tcgdex_record import Absent, Quote, select_quote

log = logging.getLogger(__name__)
BATCH = 16               # Editions per CAS: six expected keys each, so 96 keys (the store allows 128).
WRITE_TRIES = 3          # A batch whose CAS lost a race is re-read and re-planned; what still conflicts is the runner's.
STORE_SECONDS = 5.0      # Per store call.
BUDGET_SECONDS = 600.0   # The whole seed. It runs under the importer's lock.
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

CANDIDATES = """SELECT e.id,e.public_ref,e.descriptor,p.source_id
  FROM catalog_generation_edition ge JOIN catalog_edition e ON e.id=ge.edition_id
  JOIN catalog_printing p ON p.id=e.printing_id
  WHERE ge.generation_id=%s AND ge.active AND p.source='tcgdex' AND p.source_id=ANY(%s)
  ORDER BY p.source_id,e.public_ref"""


@dataclass(frozen=True)
class Candidate:
    ref: str
    revision: int
    source_id: str
    product_id: int
    lookup: dict


@dataclass
class SeedResult:
    seeded: int = 0
    skipped: dict = field(default_factory=dict)   # reason -> number of Editions
    stopped: str | None = None                    # 'store_unavailable', 'budget' or 'error' when seeding ended early

    def skip(self, reason, count=1):
        self.skipped[reason] = self.skipped.get(reason, 0) + count


def seed_from_import(conn, generation_id, priced, store=None) -> SeedResult:
    """Seed the cache for ``generation_id``'s Editions from ``priced``: source id -> (price view, epoch ms it arrived).

    Called after the import committed and published its catalog records. Never raises."""
    result = SeedResult()
    try:
        candidates = _candidates(conn, generation_id, priced)
        if candidates:
            _seed(store or public_record_store(), candidates, priced, result)
    except ProjectionUnavailable:
        result.stopped = 'store_unavailable'
    except Exception as exc:  # Best effort: report only the class, never details.
        result.stopped = 'error'
        log.warning('Import price seeding stopped (%s)', type(exc).__name__)
    if result.seeded or result.skipped or result.stopped:
        log.info('Import price seeding: %d seeded, skipped %s, stopped %s', result.seeded,
                 dict(sorted(result.skipped.items())), result.stopped)
    return result


def _candidates(conn, generation_id, priced) -> list[Candidate]:
    """Price-eligible Editions of the new generation, from one committed read: no transaction stays open while the
    store is read or written."""
    if not priced:
        return []
    if conn.info.transaction_status != TransactionStatus.IDLE:
        conn.rollback()  # The import is committed; anything a failed publish left open is not part of it.
    with conn.transaction():
        rows = conn.execute(CANDIDATES, (generation_id, list(priced))).fetchall()
        targets = edition_targets(conn, [row['id'] for row in rows])
    found = []
    for row in rows:
        target = targets.get(row['id'])
        if target is None or target.state != 'verified' or target.quote_lookup is None or target.product_id is None \
                or target.mapping_revision < 1 or is_unspecified(row['descriptor']):
            continue
        found.append(Candidate(row['public_ref'], target.mapping_revision, row['source_id'], target.product_id,
                               target.quote_lookup))
    return found


def _keys(candidate) -> dict:
    ref, revision = candidate.ref, candidate.revision
    return {'result': result_key(ref, revision), 'quote': quote_key(ref, revision),
            'fence': qc.fence_record_key(ref, revision), 'work': qc.work_record_key(ref, revision),
            'edition': catalog_edition_key(ref), 'quarantine': quarantine_key(ref)}


def _seed(store, candidates, priced, result):
    deadline = time.monotonic() + BUDGET_SECONDS
    for start in range(0, len(candidates), BATCH):
        if time.monotonic() > deadline:
            result.stopped = 'budget'
            return
        _seed_batch(store, candidates[start:start + BATCH], priced, result)


def _seed_batch(store, batch, priced, result):
    named = [(candidate, _keys(candidate)) for candidate in batch]
    read_keys = [key for _, keys in named for key in keys.values()]
    planned, skipped = [], []
    for _ in range(WRITE_TRIES):
        rows = price_launcher.read(store, read_keys, timeout=STORE_SECONDS).records
        planned, skipped = [], []
        for candidate, keys in named:
            view, fetched_ms = priced[candidate.source_id]
            plan = _plan(candidate, keys, rows, view, fetched_ms)
            if isinstance(plan, str):
                skipped.append(plan)
            else:
                planned.append((keys, plan))
        if not planned:
            break
        expected = {key: rows[key].version for keys, _ in planned for key in keys.values()}
        changes = {key: value for _, plan in planned for key, value in plan.items()}
        if price_launcher.commit(store, expected, changes, f'seed:{uuid4().hex}', timeout=STORE_SECONDS):
            result.seeded += len(planned)
            planned = []
            break
    for reason in skipped:
        result.skip(reason)
    if planned:
        result.skip('conflict', len(planned))


def _checked_ms(text) -> int:
    return (datetime.fromisoformat(text) - EPOCH) // timedelta(milliseconds=1)


def _plan(candidate, keys, rows, view, fetched_ms):
    """The records to write for one Edition, or the reason it keeps what the cache holds."""
    edition = rows[keys['edition']].value
    checked = marketplace_of(candidate.ref, edition, rows[keys['quarantine']].value)
    if checked != ('verified', None, candidate.revision, candidate.product_id, candidate.lookup):
        return 'ineligible'      # The store's catalog records lag or disagree with PostgreSQL.
    work = rows[keys['work']].value
    if work is not None:
        try:
            work = qc.validate_work(deepcopy(work))
        except (qc.ContractError, TypeError):
            return 'unreadable_work'
        if work['state'] == 'running' or work['expires_ms'] > qc.wall_ms():
            return 'in_flight'   # A refresh is queued or running: its check wins.
        # An expired queued job left its record behind: it blocks nothing, and ``work:`` stays in ``expected`` so a
        # fresh admission still fences the seed out.
    attempt = 0
    current = rows[keys['result']].value
    if current is not None:
        try:
            current = qc.validate_quote_result(deepcopy(current))
            checked_ms = _checked_ms(current['checked_at'])
        except (qc.ContractError, TypeError, ValueError, OverflowError):
            return 'unreadable_result'
        if checked_ms >= fetched_ms:
            return 'newer_check'
        attempt = current['attempt']
    fence = rows[keys['fence']].value
    try:
        attempt = max(attempt, qc.validate_fence(deepcopy(fence))['attempt'] if fence is not None else 0) + 1
    except (qc.ContractError, TypeError):
        return 'unreadable_fence'
    try:
        chosen = select_quote(view, edition['descriptor'], candidate.lookup, candidate.product_id)
    except Exception:
        return 'invalid'
    if isinstance(chosen, Absent):
        return 'absent'          # Never recorded as confirmed absence from an import.
    if not isinstance(chosen, Quote) or qc.parse_amount(chosen.amount) is None:
        return 'invalid'
    lookup = candidate.lookup
    payload = qc.new_quote_payload(attempt, chosen.amount, lookup['card'], lookup['variant'], chosen.provider_updated_at)
    try:
        payload = qc.validate_quote_payload(payload)
    except qc.ContractError:
        try:  # As the runner does: an unusable provider time never hides a valid amount.
            payload = qc.validate_quote_payload({**payload, 'provider_updated_at': None})
        except qc.ContractError:
            return 'invalid'
    return {keys['fence']: qc.validate_fence(qc.new_fence(attempt)),
            keys['result']: qc.validate_quote_result(qc.new_quote_result(attempt, fetched_ms)),
            keys['quote']: payload}
