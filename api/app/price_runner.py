"""Bounded on-demand price runner (ticket 08): supervisor plus forked worker. Run as ``python -m app.price_runner``.

Process model (docs/price-refresh.md, ADR 0008):

- The *supervisor* is the entrypoint. It forks the *worker* first, before any thread or HTTP transport exists, then
  claims the reserved slot with a CAS before any other I/O. A failed claim kills the parked worker and exits 0.
- The supervisor renews the lease every 3 s (slot key only, fenced by owner and version, never by time), kills the worker
  with SIGKILL at ``hard_stop_ms`` and runs the cleanup CAS (release permits, requeue/drop jobs, free the slot).
- The worker runs the scheduler loop: claim queued jobs under the scheduler caps, fetch one source card per claim, write
  each Edition with its own CAS, release the permit. It exits 2 s after it last had anything to do.
- Both processes inherit the flock fd the launcher took; the lock is held while either lives.

This module never imports psycopg, ``app.main`` or ``app.prices``, and its environment has no ``DATABASE_URL``. The
source client and the quote selector live in ``app.price_source`` / ``app.tcgdex_record`` and are imported lazily.

Interface assumed from those modules (reconcile when they land):

- ``price_source.fetch_card(card, may_retry)`` returns an object with ``ok`` (bool). On success ``record`` is the parsed
  JSON dict. On failure ``reason`` (one of ``EDITION_BACKOFF_REASONS``), and optionally ``status`` (int),
  ``retry_after_s`` (a valid Retry-After in seconds, else ``None``) and ``rate_limited`` (bool). ``may_retry()`` takes a
  token for a second attempt and returns whether one was available.
- ``tcgdex_record.select_quote(record, descriptor, lookup, product_id)`` returns an object with ``kind`` in
  ``quote | absent | failure``; ``quote`` carries ``amount`` (strict decimal text) and ``provider_updated_at`` (ISO text or
  ``None``), ``failure`` carries ``reason``.
"""
from copy import deepcopy
import argparse
import importlib
import json
import os
import queue
import random
import re
import signal
import sys
import threading
import time
from uuid import uuid4

from . import price_launcher
from . import quote_contract as qc
from .public_projection import ProjectionUnavailable
from .public_records import (OperationConflict, catalog_edition_key, public_record_store, quarantine_key, quote_key,
                             result_key)

IDLE_S = 2.0
POLL_S = 0.05
MAX_GROUP = 16                    # Editions claimed together for one source card (keeps the claim CAS under 128 keys).
FETCH_MARGIN_MS = 2_000           # now + 2 s <= expires_ms before a job is claimed
STOP_MARGIN_MS = 2_500            # now + 2.5 s <= hard_stop_ms before a claim
CLEANUP_GRACE_MS = 60_000
CLAIM_RETRIES = 3
WRITE_TRIES = 3

EDITION_KEYS = {'edition_ref', 'printing_ref', 'descriptor', 'revision', 'marketplace'}
MARKETPLACE_KEYS = {'state', 'reason', 'mapping_revision', 'product_id', 'quote_lookup'}
QUARANTINE_KEYS = {'edition_ref', 'revision', 'mapping_revision', 'state'}


class Unavailable(Exception):
    """A store call failed or timed out inside the runner."""


# --- Marketplace validation (copy of ``public_catalog._marketplace``; that module imports PostgreSQL code) -----------
def _int(value):
    return type(value) is int and value >= 0


def marketplace_of(ref, edition, quarantine):
    """Validated (state, reason, mapping_revision, product_id, quote_lookup), or None to fail closed."""
    try:
        if not isinstance(edition, dict) or not isinstance(quarantine, dict) or set(edition) != EDITION_KEYS \
                or set(quarantine) != QUARANTINE_KEYS or edition['edition_ref'] != ref or quarantine['edition_ref'] != ref:
            return None
        market = edition['marketplace']
        if not isinstance(market, dict) or set(market) != MARKETPLACE_KEYS or not _int(edition['revision']) \
                or edition['revision'] != quarantine['revision'] or not _int(market['mapping_revision']) \
                or market['mapping_revision'] != quarantine['mapping_revision'] \
                or market['state'] not in ('verified', 'unverified', 'quarantined') or quarantine['state'] not in ('clear', 'quarantined'):
            return None
        lookup = market['quote_lookup']
        if lookup is not None and (not isinstance(lookup, dict) or set(lookup) != {'source', 'card', 'variant'}
                                   or not all(isinstance(lookup[key], str) and lookup[key] for key in lookup)):
            return None
        product = market['product_id']
        if product is not None and (type(product) is not int or product <= 0):
            return None
        if market['reason'] is not None and not isinstance(market['reason'], str):
            return None
    except (KeyError, TypeError):
        return None
    if quarantine['state'] == 'quarantined' or market['state'] == 'quarantined':
        return 'quarantined', market['reason'], market['mapping_revision'], None, None
    if market['state'] != 'verified':
        return market['state'], market['reason'], market['mapping_revision'], None, None
    if product is None:
        return None
    return 'verified', None, market['mapping_revision'], product, lookup


def eligible(work, edition, quarantine):
    """The job's Edition is still verified, clear, at the job's revision, with the product and lookup the job was admitted
    under (the work record stores ``product_id`` as text, the catalog record as an integer)."""
    checked = marketplace_of(work['edition_ref'], edition, quarantine)
    if checked is None or checked[0] != 'verified' or checked[2] != work['mapping_revision']:
        return False
    return str(checked[3]) == work['product_id'] \
        and checked[4] == {'source': 'tcgdex', 'card': work['card'], 'variant': work['variant']}


# --- Source seam ------------------------------------------------------------------------------------------------------
def _default_fetcher():
    module = importlib.import_module('app.price_source')
    return module.fetch


def _default_selector():
    module = importlib.import_module('app.tcgdex_record')
    return module.select_quote


def _failure_reason(value):
    return value if value in qc.EDITION_BACKOFF_REASONS else 'transport'


class Outcome:
    """A normalised per-Edition decision: ``quote`` / ``absent`` / ``failure``."""

    def __init__(self, kind, amount=None, provider_updated_at=None, reason=None, retry_after_s=None, rate_limited=False):
        self.kind, self.amount, self.provider_updated_at = kind, amount, provider_updated_at
        self.reason, self.retry_after_s, self.rate_limited = reason, retry_after_s, rate_limited


def fetch_failure(fetched):
    retry = getattr(fetched, 'retry_after', None)
    retry = float(retry) if type(retry) in (int, float) and not isinstance(retry, bool) and retry >= 1 else None
    return Outcome('failure', reason=_failure_reason(getattr(fetched, 'reason', None)),
                   retry_after_s=None if retry is None else min(retry, qc.RETRY_AFTER_CAP_S),
                   rate_limited=getattr(fetched, 'status', None) == 429 or (getattr(fetched, 'status', None) == 503 and retry is not None))


def decide(selector, record, descriptor, lookup, product_id):
    try:
        chosen = selector(record, descriptor, lookup, product_id)
    except Exception:
        return Outcome('failure', reason='malformed')
    kind = {'Quote': 'quote', 'Absent': 'absent', 'Failure': 'failure'}.get(type(chosen).__name__)
    if kind == 'absent':
        return Outcome('absent')
    if kind == 'quote' and qc.parse_amount(getattr(chosen, 'amount', None)) is not None:
        updated = getattr(chosen, 'provider_updated_at', None)
        try:
            qc.validate_quote_payload(qc.new_quote_payload(1, chosen.amount, lookup['card'], lookup['variant'], updated))
        except qc.ContractError:
            updated = None
        return Outcome('quote', amount=chosen.amount, provider_updated_at=updated)
    return Outcome('failure', reason=_failure_reason(getattr(chosen, 'reason', 'malformed')) if kind == 'failure' else 'malformed')


# --- Claim bookkeeping ----------------------------------------------------------------------------------------------------
class Job:
    def __init__(self, job_id, work, attempt):
        self.id, self.work, self.attempt = job_id, work, attempt
        self.ref, self.revision = work['edition_ref'], work['mapping_revision']


class Claim:
    def __init__(self, permit_id, caller, card, jobs):
        self.permit_id, self.caller, self.card, self.jobs = permit_id, caller, card, jobs


def _ms_after(delay_s):
    return qc.wall_ms() + int(delay_s * 1000)


class Worker:
    """The claim/fetch/write loop. ``fetcher`` and ``selector`` default to the lazily imported source modules."""

    def __init__(self, store, slot, owner, hard_stop_ms, *, fetcher=None, selector=None, idle_s=IDLE_S, poll_s=POLL_S):
        self.store, self.slot, self.owner, self.hard_stop_ms = store, slot, owner, hard_stop_ms
        self._fetcher, self._selector = fetcher, selector
        self.idle_s, self.poll_s = idle_s, poll_s
        self.inflight = 0
        self.lock = threading.Lock()
        self.work_queue = queue.Queue()
        self.threads = []
        self.scheduler_key, self.lease_key = qc.scheduler_key(), qc.runner_lease_key(slot)
        self.source_key = qc.source_backoff_key()

    # --- store ---------------------------------------------------------------------------------------------------
    def read(self, keys):
        try:
            return price_launcher.read(self.store, keys).records
        except ProjectionUnavailable as error:
            raise Unavailable() from error

    def commit(self, expected, changes, operation_id):
        return price_launcher.commit(self.store, expected, changes, operation_id)

    # --- loop ----------------------------------------------------------------------------------------------------
    def run(self):
        """Returns ``idle`` (clean idle exit), ``stopped`` (hard stop margin reached) or ``fenced`` (lease lost)."""
        for number in range(4):
            thread = threading.Thread(target=self._pool, name=f'price-fetch-{number}', daemon=True)
            thread.start()
            self.threads.append(thread)
        idle_since = None
        result = 'idle'
        while True:
            if qc.wall_ms() + STOP_MARGIN_MS > self.hard_stop_ms:
                result = 'stopped'
                break
            claimed = 'none'
            if self.inflight < qc.MAX_SOURCE_PER_SLOT:
                try:
                    claimed = self.try_claim()
                except Unavailable:
                    claimed = 'unavailable'
            if claimed == 'lost':
                result = 'fenced'
                break
            if claimed in ('claimed', 'retry'):
                idle_since = None
                continue
            if self.inflight:
                idle_since = None
            elif idle_since is None:
                idle_since = time.monotonic()
            elif time.monotonic() - idle_since >= self.idle_s:
                if self.try_idle_exit():
                    break
                idle_since = None
            time.sleep(self.poll_s if idle_since is None else max(0.0, min(self.poll_s, idle_since + self.idle_s - time.monotonic())))
        for _ in self.threads:
            self.work_queue.put(None)
        for thread in self.threads:
            thread.join()
        return result

    def _pool(self):
        while True:
            claim = self.work_queue.get()
            if claim is None:
                return
            try:
                self.process(claim)
            finally:
                with self.lock:
                    self.inflight -= 1

    # --- claim ---------------------------------------------------------------------------------------------------
    def try_claim(self):
        now = qc.wall_ms()
        first = self.read([self.scheduler_key, self.lease_key, self.source_key])
        lease = first[self.lease_key].value
        if lease is None or lease.get('owner') != self.owner or lease.get('state') != 'running':
            return 'lost'
        raw = first[self.scheduler_key].value
        if raw is None:
            return 'none'
        scheduler = qc.validate_scheduler(deepcopy(raw))
        backoff = first[self.source_key].value
        if backoff is not None and qc.validate_source_backoff(backoff)['retry_ms'] > now:
            return 'none'
        expired = [key for key, job in scheduler['jobs'].items() if job['state'] == 'queued' and job['expires_ms'] <= now]
        if expired:
            return 'retry' if self.cancel(first[self.scheduler_key].version, scheduler, expired[:40], expired=True) else 'none'
        permits = scheduler['source']
        by_caller, mine = {}, 0
        for permit in permits.values():
            by_caller[permit['caller']] = by_caller.get(permit['caller'], 0) + 1
            mine += permit['slot'] == self.slot
        if len(permits) >= qc.MAX_SOURCE_PERMITS or mine >= qc.MAX_SOURCE_PER_SLOT:
            return 'none'
        milli = min(qc.BUCKET_CAPACITY_MILLI, scheduler['bucket']['milli'] + max(0, now - scheduler['bucket']['at_ms'])
                    * qc.BUCKET_REFILL_MILLI_PER_S // 1000)
        if milli < 1000:
            return 'none'
        ring = scheduler['ring']
        for step in range(len(ring)):
            index = (scheduler['cursor'] + step) % len(ring)
            caller = ring[index]
            if by_caller.get(caller, 0) >= qc.MAX_SOURCE_PER_CALLER:
                continue
            head = scheduler['fifo'][caller][0]
            if now + FETCH_MARGIN_MS > scheduler['jobs'][head]['expires_ms']:
                continue
            return self.claim_group(first, scheduler, caller, head, index, milli, now)
        return 'none'

    def claim_group(self, first, scheduler, caller, head, index, milli, now):
        card = scheduler['jobs'][head]['card']
        group = sorted((key for key, job in scheduler['jobs'].items() if job['state'] == 'queued' and job['card'] == card
                        and now + FETCH_MARGIN_MS <= job['expires_ms'] and key != head),
                       key=lambda key: scheduler['jobs'][key]['admitted_ms'])[:MAX_GROUP - 1]
        group = [head] + group
        keys, names = [], {}
        for job_id in group:
            ref, revision = qc.split_job_id(job_id)
            names[job_id] = (qc.work_record_key(ref, revision), qc.fence_record_key(ref, revision), result_key(ref, revision),
                             quote_key(ref, revision), catalog_edition_key(ref), quarantine_key(ref),
                             qc.edition_backoff_key(ref, revision))
            keys += names[job_id]
        rows = self.read(keys)
        bad, ready = [], []
        for job_id in group:
            work_key, fence_key, _, _, edition_key, quarantine_key_, backoff_key = names[job_id]
            try:
                work = qc.validate_work(deepcopy(rows[work_key].value))
                fence = qc.validate_fence(deepcopy(rows[fence_key].value)) if rows[fence_key].value is not None else qc.new_fence()
                backoff = rows[backoff_key].value
                active = backoff is not None and qc.validate_edition_backoff(backoff)['retry_ms'] > now
            except (qc.ContractError, TypeError):
                bad.append(job_id)
                continue
            job = scheduler['jobs'][job_id]
            if work['state'] != 'queued' or work['card'] != job['card'] or work['caller'] != job['caller'] \
                    or work['expires_ms'] != job['expires_ms'] or active \
                    or not eligible(work, rows[edition_key].value, rows[quarantine_key_].value):
                bad.append(job_id)
                continue
            ready.append(Job(job_id, work, fence['attempt'] + 1))
        if bad:
            self.cancel(first[self.scheduler_key].version, scheduler, bad)
            return 'retry'
        permit_id = uuid4().hex[:24]
        new = deepcopy(scheduler)
        new['bucket'] = {'milli': milli - 1000, 'at_ms': now}
        new['source'][permit_id] = {'caller': caller, 'slot': self.slot, 'owner': self.owner, 'jobs': list(group), 'started_ms': now}
        changes, expected = {self.scheduler_key: new}, {self.scheduler_key: first[self.scheduler_key].version,
                                                         self.lease_key: first[self.lease_key].version,
                                                         self.source_key: first[self.source_key].version}
        for job in ready:
            work_key, fence_key, result_k, quote_k, edition_k, quarantine_k, _ = names[job.id]
            for key in (work_key, fence_key, result_k, quote_k, edition_k, quarantine_k):
                expected[key] = rows[key].version
            new['jobs'][job.id].update(state='running', slot=self.slot, owner=self.owner, attempt=job.attempt)
            changes[fence_key] = qc.new_fence(job.attempt)
            running = dict(job.work, state='running', attempt=job.attempt, slot=self.slot, owner=self.owner)
            changes[work_key] = qc.validate_work(running)
        new = price_launcher.tidy_scheduler(new)
        survivors = [name for name in scheduler['ring'] if name in new['fifo']]
        new['ring'] = survivors
        new['cursor'] = (sum(1 for name in scheduler['ring'][:index + 1] if name in new['fifo'])) % len(survivors) if survivors else 0
        changes[self.scheduler_key] = qc.validate_scheduler(new)
        if not self.commit(expected, changes, f'claim:{self.slot}:{self.owner}:{permit_id}'):
            return 'retry'
        with self.lock:
            self.inflight += 1
        self.work_queue.put(Claim(permit_id, caller, card, ready))
        return 'claimed'

    def cancel(self, version, scheduler, job_ids, expired=False):
        """Remove queued jobs from the scheduler and delete their ``work:`` records. No backoff, no check-age change."""
        expected, changes = {self.scheduler_key: version}, {}
        new = deepcopy(scheduler)
        refs = {job_id: qc.work_record_key(*qc.split_job_id(job_id)) for job_id in job_ids}
        works = self.read(list(refs.values()))
        for job_id, key in refs.items():
            expected[key], changes[key] = works[key].version, None
            del new['jobs'][job_id]
        if expired:
            new['stats']['expired'] += len(job_ids)
        changes[self.scheduler_key] = qc.validate_scheduler(price_launcher.tidy_scheduler(new))
        return self.commit(expected, changes, f'cancel:{self.slot}:{self.owner}:{uuid4().hex[:16]}')

    def try_idle_exit(self):
        try:
            rows = self.read([self.scheduler_key, self.lease_key, self.source_key])
            lease = rows[self.lease_key].value
            if lease is None or lease.get('owner') != self.owner:
                return True
            now = qc.wall_ms()
            raw = rows[self.scheduler_key].value
            if raw is not None:
                scheduler = qc.validate_scheduler(deepcopy(raw))
                blocked = rows[self.source_key].value is not None and rows[self.source_key].value.get('retry_ms', 0) > now
                if not blocked and any(job['state'] == 'queued' and job['expires_ms'] > now for job in scheduler['jobs'].values()):
                    return False
            exiting = dict(lease, state='exiting')
            expected = {self.scheduler_key: rows[self.scheduler_key].version, self.lease_key: rows[self.lease_key].version}
            return self.commit(expected, {self.lease_key: qc.validate_runner_lease(exiting)},
                               f'exiting:{self.slot}:{self.owner}:{uuid4().hex[:16]}')
        except Unavailable:
            return True  # The store is down: leave; the supervisor's cleanup (or a reclaim) frees the slot.
        except (qc.ContractError, TypeError, ValueError):
            return True

    # --- fetch and write -----------------------------------------------------------------------------------------------
    def take_token(self):
        for _ in range(3):
            try:
                row = self.read([self.scheduler_key])[self.scheduler_key]
                scheduler = qc.validate_scheduler(deepcopy(row.value))
            except (Unavailable, qc.ContractError, TypeError):
                return False
            now = qc.wall_ms()
            milli = min(qc.BUCKET_CAPACITY_MILLI, scheduler['bucket']['milli']
                        + max(0, now - scheduler['bucket']['at_ms']) * qc.BUCKET_REFILL_MILLI_PER_S // 1000)
            if milli < 1000 or now + STOP_MARGIN_MS > self.hard_stop_ms:
                return False
            scheduler['bucket'] = {'milli': milli - 1000, 'at_ms': now}
            if self.commit({self.scheduler_key: row.version}, {self.scheduler_key: qc.validate_scheduler(scheduler)},
                           f'token:{self.slot}:{self.owner}:{uuid4().hex[:16]}'):
                return True
        return False

    def process(self, claim):
        fenced = 0
        try:
            fetch = self._fetcher or _default_fetcher()
            select = self._selector or _default_selector()
            try:
                fetched = fetch(claim.card, self.take_token)
            except Exception:
                fetched = None
            failure = None
            if fetched is None or getattr(fetched, 'ok', False) is not True or not isinstance(getattr(fetched, 'record', None), dict):
                failure = fetch_failure(fetched) if fetched is not None and getattr(fetched, 'ok', None) is False \
                    else Outcome('failure', reason='transport')
            if failure is not None and failure.rate_limited:
                self.set_source_backoff(failure)
            for job in claim.jobs:
                try:
                    status = self.write_job(job, fetched, failure, select)
                except Unavailable:
                    status = 'fenced'
                fenced += status == 'fenced'
        except Exception:
            fenced += 0
        finally:
            self.release(claim, fenced)

    def set_source_backoff(self, failure):
        for _ in range(3):
            try:
                row = self.read([self.source_key])[self.source_key]
            except Unavailable:
                return
            now = qc.wall_ms()
            delay = failure.retry_after_s if failure.retry_after_s is not None else qc.BACKOFF_BASE_S
            retry = now + int(min(delay, qc.RETRY_AFTER_CAP_S) * 1000)
            reason = 'rate_limited' if failure.rate_limited and failure.retry_after_s is None else 'retry_after'
            try:
                if row.value is not None:
                    retry = max(retry, qc.validate_source_backoff(deepcopy(row.value))['retry_ms'])
            except qc.ContractError:
                pass
            record = qc.new_source_backoff(reason, retry, now)
            if self.commit({self.source_key: row.version}, {self.source_key: record}, f'source-backoff:{self.owner}:{uuid4().hex[:16]}'):
                return

    def write_job(self, job, fetched, failure, select):
        """One Edition, one CAS. Returns ``quote``, ``absent``, ``failure``, ``done`` or ``fenced`` (abandoned)."""
        ref, revision = job.ref, job.revision
        keys = {'result': result_key(ref, revision), 'quote': quote_key(ref, revision), 'fence': qc.fence_record_key(ref, revision),
                'work': qc.work_record_key(ref, revision), 'edition': catalog_edition_key(ref), 'quarantine': quarantine_key(ref),
                'backoff': qc.edition_backoff_key(ref, revision)}
        operation = f'price:{ref}:{revision}:{job.attempt}'
        for _ in range(WRITE_TRIES):
            try:
                rows = self.read(list(keys.values()))
            except Unavailable:
                time.sleep(0.2)
                if qc.wall_ms() + 500 > self.hard_stop_ms:
                    return 'fenced'
                continue
            value = {name: rows[key].value for name, key in keys.items()}
            if value['work'] is None:
                result = value['result']
                return 'done' if isinstance(result, dict) and result.get('attempt') == job.attempt else 'fenced'
            work = value['work']
            if work.get('state') != 'running' or work.get('owner') != self.owner or work.get('slot') != self.slot \
                    or work.get('attempt') != job.attempt or value['fence'] != qc.new_fence(job.attempt) \
                    or not eligible(job.work, value['edition'], value['quarantine']):
                return 'fenced'
            outcome = failure
            if outcome is None:
                outcome = decide(select, fetched.record, value['edition']['descriptor'],
                                 value['edition']['marketplace']['quote_lookup'], value['edition']['marketplace']['product_id'])
            now = qc.wall_ms()
            changes = {keys['work']: None}
            if outcome.kind == 'quote':
                lookup = value['edition']['marketplace']['quote_lookup']
                changes[keys['result']] = qc.validate_quote_result(qc.new_quote_result(job.attempt, now))
                changes[keys['quote']] = qc.validate_quote_payload(qc.new_quote_payload(
                    job.attempt, outcome.amount, lookup['card'], lookup['variant'], outcome.provider_updated_at))
                changes[keys['backoff']] = None
            elif outcome.kind == 'absent':
                changes[keys['result']] = qc.validate_quote_result(qc.new_absent_result(job.attempt, now))
                changes[keys['quote']] = None
                changes[keys['backoff']] = None
            else:
                previous = value['backoff']
                failures = (previous['failures'] if isinstance(previous, dict) and type(previous.get('failures')) is int else 0) + 1
                delay = qc.edition_backoff_delay_s(min(failures, 64), random.uniform(0.8, 1.2), outcome.retry_after_s)
                changes[keys['backoff']] = qc.validate_edition_backoff(qc.new_edition_backoff(
                    failures, now, now + int(delay * 1000), outcome.reason))
            expected = {key: rows[key].version for key in keys.values()}
            try:
                if self.commit(expected, changes, operation):
                    return outcome.kind
            except OperationConflict:
                return 'fenced'
        return 'fenced'

    def release(self, claim, fenced):
        """Release the source permit and remove the claim's jobs, after the writes. Retried until the hard stop; a permit is
        never freed by time alone."""
        attempts = {job.id: job.attempt for job in claim.jobs}
        while qc.wall_ms() < self.hard_stop_ms:
            try:
                row = self.read([self.scheduler_key])[self.scheduler_key]
                scheduler = qc.validate_scheduler(deepcopy(row.value))
            except (Unavailable, qc.ContractError, TypeError):
                time.sleep(0.2)
                continue
            if claim.permit_id not in scheduler['source']:
                return
            del scheduler['source'][claim.permit_id]
            for job_id in list(scheduler['jobs']):
                job = scheduler['jobs'][job_id]
                if job['state'] == 'running' and job['owner'] == self.owner and job['attempt'] == attempts.get(job_id):
                    del scheduler['jobs'][job_id]
            scheduler['stats']['fenced'] += fenced
            if self.commit({self.scheduler_key: row.version}, {self.scheduler_key: qc.validate_scheduler(price_launcher.tidy_scheduler(scheduler))},
                           f'release:{self.slot}:{self.owner}:{claim.permit_id}:{uuid4().hex[:8]}'):
                return
            time.sleep(0.02)


# --- Supervisor ----------------------------------------------------------------------------------------------------------
def claim_slot(store, slot, owner, worker_pid):
    """The supervisor's first store action: reserved -> running, owner and age checked. Returns the new lease or None."""
    key = qc.runner_lease_key(slot)
    for _ in range(CLAIM_RETRIES):
        try:
            row = price_launcher.read(store, [key]).records[key]
        except ProjectionUnavailable:
            continue
        lease = row.value
        now = qc.wall_ms()
        if not isinstance(lease, dict) or lease.get('state') != 'reserved' or lease.get('owner') != owner:
            if isinstance(lease, dict) and lease.get('owner') == owner and lease.get('supervisor_pid') == os.getpid():
                return lease
            return None
        if now - lease['reserved_ms'] > qc.RESERVATION_TTL_MS:
            return None
        claimed = dict(lease, state='running', supervisor_pid=os.getpid(), worker_pid=worker_pid,
                       host=price_launcher.host_id(), claimed_ms=now, lease_until_ms=now + qc.LEASE_TTL_MS,
                       hard_stop_ms=now + qc.HARD_STOP_MS)
        try:
            qc.validate_runner_lease(claimed)
        except qc.ContractError:
            return None
        if price_launcher.commit(store, {key: row.version}, {key: claimed}, f'claim-slot:{slot}:{owner}'):
            return claimed
    return None


class Renewer(threading.Thread):
    """Extends the lease every 3 s with a CAS on the slot key only; fences on owner, never on time."""

    def __init__(self, store, slot, owner):
        super().__init__(name='price-lease-renewal', daemon=True)
        self.store, self.slot, self.owner = store, slot, owner
        self.stop, self.lost = threading.Event(), False

    def run(self):
        key = qc.runner_lease_key(self.slot)
        while not self.stop.wait(qc.LEASE_RENEW_MS / 1000):
            for _ in range(3):
                try:
                    row = price_launcher.read(self.store, [key]).records[key]
                except ProjectionUnavailable:
                    break
                lease = row.value
                if not isinstance(lease, dict) or lease.get('owner') != self.owner:
                    self.lost = True
                    return
                renewed = dict(lease, lease_until_ms=qc.wall_ms() + qc.LEASE_TTL_MS)
                if price_launcher.commit(self.store, {key: row.version}, {key: renewed},
                                         f'renew:{self.slot}:{self.owner}:{uuid4().hex[:16]}'):
                    break


def worker_main(control, slot, owner):
    """The forked worker: parked until the supervisor's claim commits, then the scheduler loop."""
    code = 1
    try:
        for name in ('app.price_source', 'app.tcgdex_record'):  # Warm the imports while the claim CAS is in flight.
            try:
                importlib.import_module(name)
            except ImportError:
                pass
        raw = os.read(control, 4096)
        if not raw:
            os._exit(0)
        info = json.loads(raw)
        Worker(public_record_store(), slot, owner, info['hard_stop_ms']).run()
        code = 0
    finally:
        os._exit(code)


def supervise(slot, owner):
    ctrl_read, ctrl_write = os.pipe()
    worker = os.fork()  # Before any thread or HTTP transport exists.
    if worker == 0:
        os.close(ctrl_write)
        worker_main(ctrl_read, slot, owner)
        os._exit(1)
    os.close(ctrl_read)
    store = public_record_store()
    lease = claim_slot(store, slot, owner, worker)
    if lease is None:
        os.close(ctrl_write)  # EOF: the parked worker exits without any source I/O.
        _reap(worker, kill=True)
        return 0
    renewer = Renewer(store, slot, owner)
    renewer.start()
    os.write(ctrl_write, json.dumps({'hard_stop_ms': lease['hard_stop_ms']}).encode())
    os.close(ctrl_write)
    while True:
        done, _ = os.waitpid(worker, os.WNOHANG)
        if done:
            break
        if renewer.lost or qc.wall_ms() >= lease['hard_stop_ms']:
            _reap(worker, kill=True)
            break
        time.sleep(0.02)
    renewer.stop.set()
    if renewer.lost:
        return 0
    give_up = lease['hard_stop_ms'] + CLEANUP_GRACE_MS
    while not price_launcher.cleanup_slot(store, slot, owner):
        if qc.wall_ms() >= give_up:
            return 0  # The lock frees on exit; a same-host reclaim recovers the slot.
        time.sleep(0.5)
    try:
        price_launcher.lock_path(slot, owner).unlink(missing_ok=True)
    except OSError:
        pass
    handoff(store, slot)
    return 0


def _reap(pid, kill):
    try:
        if kill:
            os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass


def handoff(store, freed_slot):
    """Reserve a free slot and spawn a successor when runnable jobs remain and no other slot can serve them."""
    scheduler_key, source_key = qc.scheduler_key(), qc.source_backoff_key()
    keys = [scheduler_key, source_key] + [qc.runner_lease_key(slot) for slot in qc.RUNNER_SLOTS]
    try:
        rows = price_launcher.read(store, keys).records
        raw = rows[scheduler_key].value
        now = qc.wall_ms()
        if raw is None or (rows[source_key].value or {}).get('retry_ms', 0) > now:
            return False
        scheduler = qc.validate_scheduler(deepcopy(raw))
        if not any(job['state'] == 'queued' and job['expires_ms'] > now for job in scheduler['jobs'].values()):
            return False
        usable = False
        for slot in qc.RUNNER_SLOTS:
            lease = rows[qc.runner_lease_key(slot)].value
            if lease is not None and lease['state'] != 'exiting' and (lease['state'] == 'reserved'
                    and now - lease['reserved_ms'] <= qc.RESERVATION_TTL_MS or lease['state'] == 'running'
                    and lease['lease_until_ms'] > now and (lease['hard_stop_ms'] or 0) > now + 3_000):
                usable = True
        if usable:
            return False
        free = [slot for slot in (freed_slot, *qc.RUNNER_SLOTS) if rows[qc.runner_lease_key(slot)].value is None]
        if not free:
            return False
        slot, owner = free[0], uuid4().hex
        key = qc.runner_lease_key(slot)
        reservation = qc.new_runner_lease(owner, price_launcher.host_id(), now, os.getpid())
        if not price_launcher.commit(store, {key: rows[key].version}, {key: reservation}, f'handoff:{slot}:{owner}'):
            return False
    except (ProjectionUnavailable, qc.ContractError, KeyError, TypeError, OSError):
        return False
    if not price_launcher.spawn(slot, owner):
        try:
            row = price_launcher.read(store, [key]).records[key]
            if isinstance(row.value, dict) and row.value.get('owner') == owner:
                price_launcher.commit(store, {key: row.version}, {key: None}, f'unreserve:{slot}:{owner}:{uuid4().hex[:8]}')
        except ProjectionUnavailable:
            pass
        return False
    return True


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--slot', type=int, required=True, choices=qc.RUNNER_SLOTS)
    parser.add_argument('--owner', required=True)
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[0-9a-f]{32}', args.owner):
        return 2
    return supervise(args.slot, args.owner)


if __name__ == '__main__':
    sys.exit(main())
