"""Runner launch, slot reclaim and shared slot cleanup for price refresh (tickets 07 and 08).

Admission (07) reserves a runner slot in the record store and then calls ``spawn`` once, after the reservation has
committed. ``spawn`` starts a detached supervisor (``python -m app.price_runner``) that holds a ``flock`` on
``$PRICE_RUNNER_LOCK_DIR/slot-<n>-<owner>.lock`` for as long as either the supervisor or its forked worker lives. That
lock is the portable, PID-reuse-proof proof of termination used by ``reclaim_slot``.

Contract for ``spawn(slot, owner)``:

- ``slot`` is a runner slot (0 or 1) and ``owner`` the 32-hex nonce stored in ``lease:price:runner:<slot>``.
- It returns ``True`` only when a runner process was started for exactly that reservation, and ``False`` when
  nothing was started. It never raises for a launch failure; the caller then frees the slot best effort and leaves
  the jobs queued.
- It must not block on the child and must not touch PostgreSQL or the record store.
- It is called from a request thread, at most once per reservation.

Contract for ``reclaim_slot(store, slot, *, deadline=None, attempts=4, replace_with=None)`` (called by admission's
``_after_commit`` when work is pending and the slot's lease has run out, as its own bounded step):

- ``deadline`` is an absolute ``time.monotonic()`` value that bounds every store call, ``operation_status`` included; the
  request path passes ``min(wait_until, now + 0.6)`` with ``attempts=1``. Supervisor and operator callers pass neither and keep
  the 2 s per call default.
- ``replace_with`` is a new 32-hex owner: the cleanup CAS then writes a fresh ``reserved`` lease for it instead of freeing the
  slot, so the caller can ``spawn`` without a second CAS. Only a CAS that wrote it returns ``'reclaimed'``.

- ``'not_applicable'``: nothing to reclaim (free slot, live lease, a young unclaimed reservation, or a slot someone else
  already freed or replaced).
- ``'reclaimed'``: the slot was freed; for a claimed slot the owner's source permits were released, its unexpired
  running jobs requeued and its expired ones dropped, with every ``work:`` record rewritten (version bump fences any
  stale writer).
- ``'uncertain'``: termination cannot be proven (other host, lock still held, lock file missing). The slot is
  untouched; admission labels rows ``busy`` and records ``runner_uncertain``; the operator recovers with
  ``scripts/price_runners.py release --slot n --confirm-terminated``.

This module imports no PostgreSQL code. It must never import ``app.price_runner`` (the CI connect guard arms on that
import), so the cleanup shared by the supervisor and reclaim lives here.

CI replaces ``spawn`` through ``api/tests/catalog_process_fixture/price_fixture.py`` (record or fail the launch).
Callers must reach it as ``price_launcher.spawn(...)`` so a replacement takes effect.
"""
from copy import deepcopy
import fcntl
import os
from pathlib import Path
import re
import subprocess
import sys
from threading import Thread
import time
from uuid import uuid4

from . import quote_contract as qc
from .public_projection import ProjectionUnavailable
from .public_records import FilePublicRecords, OperationConflict

_SLOTS = (0, 1)
_OWNER = re.compile(r'[0-9a-f]{32}')
_HOST_VALUE = re.compile(r'[A-Za-z0-9_.:-]{1,128}')
API_DIR = Path(__file__).resolve().parents[1]
LOCK_DIR_ENV = 'PRICE_RUNNER_LOCK_DIR'
ENV_ALLOWLIST = ('PATH', 'LANG', 'NODE_ENV', 'PYTHONPATH')
ENV_ALLOW_PREFIXES = ('PUBLIC_PROJECTION_',)
STORE_TIMEOUT_S = 2.0


# --- Lock directory and host identity ---------------------------------------------------------------------------------
def lock_dir() -> Path:
    """Host-local directory for lock files and the host id (default ``.local/price-runners``), created private."""
    configured = os.environ.get(LOCK_DIR_ENV)
    path = Path(configured) if configured else API_DIR.parent / '.local' / 'price-runners'
    path = path.resolve()
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def lock_path(slot: int, owner: str, directory: Path | None = None) -> Path:
    if type(slot) is not int or slot not in _SLOTS or type(owner) is not str or not _OWNER.fullmatch(owner):
        raise ValueError('invalid runner reservation')
    return (directory or lock_dir()) / f'slot-{slot}-{owner}.lock'


def host_id(directory: Path | None = None) -> str:
    """Stable id of this host's lock directory, created once atomically (temp file + hard link)."""
    directory = directory or lock_dir()
    target = directory / 'host-id'
    for _ in range(3):
        try:
            value = target.read_text().strip()
            if _HOST_VALUE.fullmatch(value):
                return value
            raise ValueError('invalid host id file')
        except FileNotFoundError:
            pass
        temporary = directory / f'.host-id.{os.getpid()}.{uuid4().hex}'
        temporary.write_text('host-' + uuid4().hex)
        try:
            os.link(temporary, target)
        except FileExistsError:
            pass
        finally:
            temporary.unlink(missing_ok=True)
    raise OSError('host id unavailable')


# --- Spawn ----------------------------------------------------------------------------------------------------------
def runner_environment(directory: Path) -> dict:
    """Allowlisted child environment. PYTHONPATH stays (CI fixture); DATABASE_URL and the auth secrets never pass."""
    env = {key: os.environ[key] for key in ENV_ALLOWLIST if key in os.environ}
    env.update({key: value for key, value in os.environ.items() if key.startswith(ENV_ALLOW_PREFIXES)})
    env[LOCK_DIR_ENV] = str(directory)
    # The runner starts in api/, the API wherever it was started: hand over the store directory as the API resolves it
    # and absolute import paths, so both processes open the same records.
    env['PUBLIC_PROJECTION_DIR'] = str(FilePublicRecords().directory.parent)
    if env.get('PYTHONPATH'):
        env['PYTHONPATH'] = os.pathsep.join(str(Path(part).resolve()) for part in env['PYTHONPATH'].split(os.pathsep) if part)
    return env


def spawn(slot: int, owner: str) -> bool:
    """Start a detached supervisor for a reserved slot. ``False`` when nothing could be started."""
    if type(slot) is not int or slot not in _SLOTS or type(owner) is not str or not _OWNER.fullmatch(owner):
        raise ValueError('invalid runner reservation')
    descriptor = None
    path = None
    try:
        directory = lock_dir()
        path = lock_path(slot, owner, directory)
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        child = subprocess.Popen(
            [sys.executable, '-m', 'app.price_runner', '--slot', str(slot), '--owner', owner],
            cwd=API_DIR, env=runner_environment(directory), pass_fds=(descriptor,), start_new_session=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    except (OSError, ValueError, subprocess.SubprocessError):
        if path is not None:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        return False
    finally:
        if descriptor is not None:
            os.close(descriptor)  # The child's copy keeps the lock; ours must not.
    Thread(target=child.wait, daemon=True, name='price-runner-reaper').start()
    return True


# --- Store helpers shared with the runner -------------------------------------------------------------------------------
def deadline_in(seconds: float = STORE_TIMEOUT_S) -> float:
    return time.monotonic() + seconds


def _at(timeout: float, deadline: float | None) -> float:
    """The absolute deadline for one store call: the caller's, or ``timeout`` seconds from now."""
    return deadline if deadline is not None else deadline_in(timeout)


def commit(store, expected: dict, changes: dict, operation_id: str, *, timeout: float = STORE_TIMEOUT_S,
           deadline: float | None = None) -> bool:
    """One CAS whose unknown outcome is resolved: ``operation_status`` first, then the expected versions. ``True`` only
    when the change is known committed; ``False`` on conflict (or an operation id already used for other content).
    ``deadline`` (absolute monotonic) bounds the CAS and the ``operation_status`` follow-up together."""
    try:
        return bool(store.compare_and_swap(expected, changes, deadline=_at(timeout, deadline), operation_id=operation_id))
    except OperationConflict:
        return False
    except ProjectionUnavailable:
        pass
    try:
        if store.operation_status(operation_id, deadline=_at(timeout, deadline)):
            return True
    except ProjectionUnavailable:
        return False
    # Not logged: the write did not land (or lost a race we cannot attribute). Callers re-read before deciding.
    return False


def read(store, keys, *, timeout: float = STORE_TIMEOUT_S, generation=None, deadline: float | None = None):
    return store.read_records(list(keys), deadline=_at(timeout, deadline), generation=generation)


def scheduler_value(record):
    """The stored scheduler validated, or a fresh empty one when it has never been written."""
    return qc.validate_scheduler(deepcopy(record)) if record is not None else qc.new_scheduler(qc.wall_ms())


def tidy_scheduler(scheduler: dict) -> dict:
    """Restore the fifo/ring/cursor invariants after jobs were added or removed."""
    queued = {key for key, job in scheduler['jobs'].items() if job['state'] == 'queued'}
    fifo = {}
    for caller, entries in scheduler['fifo'].items():
        kept = [entry for entry in entries if entry in queued]
        if kept:
            fifo[caller] = kept
    ring = [caller for caller in scheduler['ring'] if caller in fifo]
    ring += [caller for caller in fifo if caller not in ring]
    scheduler['fifo'], scheduler['ring'] = fifo, ring
    scheduler['cursor'] = scheduler['cursor'] if ring and scheduler['cursor'] < len(ring) else 0
    return scheduler


def cleanup_slot(store, slot: int, owner: str, *, attempts: int = 4, deadline: float | None = None,
                 replace_with: str | None = None) -> bool:
    """Free ``slot`` if it is still held by ``owner``: release that owner's source permits, requeue its unexpired running
    jobs, drop the expired ones, rewrite each ``work:`` record (version bump) and clear the lease, in one CAS.

    ``replace_with`` (a new owner nonce) writes a fresh ``reserved`` lease for that owner in the same CAS instead of
    clearing the slot. ``deadline`` is absolute and bounds every call; no new attempt starts after it.

    Returns ``True`` when the slot is no longer held by ``owner`` (freed here, or already freed or replaced), ``False``
    when the store stayed unavailable or contended."""
    return _cleanup(store, slot, owner, attempts=attempts, deadline=deadline, replace_with=replace_with) != 'failed'


def _cleanup(store, slot, owner, *, attempts, deadline, replace_with) -> str:
    """``'freed'`` (this call's CAS committed), ``'gone'`` (the slot was no longer ``owner``'s) or ``'failed'``."""
    lease_key = qc.runner_lease_key(slot)
    scheduler_key = qc.scheduler_key()
    for _ in range(attempts):
        if deadline is not None and time.monotonic() >= deadline:
            return 'failed'
        try:
            snapshot = read(store, [scheduler_key, lease_key], deadline=deadline)
            lease = snapshot.records[lease_key].value
            if lease is None or (isinstance(lease, dict) and lease.get('owner') != owner):
                return 'gone'
            if not isinstance(lease, dict):
                return 'failed'
            scheduler = scheduler_value(snapshot.records[scheduler_key].value)
            owned = sorted((key for key, job in scheduler['jobs'].items()
                            if job['state'] == 'running' and job['owner'] == owner and job['slot'] == slot),
                           key=lambda key: scheduler['jobs'][key]['admitted_ms'])[:100]
            work_keys = {key: qc.work_record_key(*qc.split_job_id(key)) for key in owned}
            works = read(store, list(work_keys.values()), deadline=deadline).records if work_keys else {}
        except ProjectionUnavailable:
            continue
        except (ValueError, KeyError, TypeError):
            return 'failed'  # A corrupt scheduler needs the operator, not an automatic rewrite.
        now = qc.wall_ms()
        try:
            replacement = None if replace_with is None else qc.validate_runner_lease(
                qc.new_runner_lease(replace_with, host_id(), now, os.getpid()))
        except (OSError, ValueError):
            return 'failed'
        changes = {lease_key: replacement}
        expected = {scheduler_key: snapshot.records[scheduler_key].version, lease_key: snapshot.records[lease_key].version}
        for key in scheduler['source'].copy():
            if scheduler['source'][key]['owner'] == owner:
                del scheduler['source'][key]
        requeued = []
        for key in owned:
            job, work_record = scheduler['jobs'][key], works[work_keys[key]]
            expected[work_keys[key]] = work_record.version
            if job['expires_ms'] > now and isinstance(work_record.value, dict):
                job.update(state='queued', slot=None, owner=None, attempt=None)
                requeued.append(key)
                work = deepcopy(work_record.value)
                work.update(state='queued', attempt=None, slot=None, owner=None)
                changes[work_keys[key]] = qc.validate_work(work)
            else:
                del scheduler['jobs'][key]
                scheduler['stats']['expired'] += 1
                changes[work_keys[key]] = None
        for key in reversed(requeued):  # Oldest first at the head of each caller's fifo.
            fifo = scheduler['fifo'].setdefault(scheduler['jobs'][key]['caller'], [])
            fifo.insert(0, key)
        for caller in {scheduler['jobs'][key]['caller'] for key in requeued}:
            scheduler['fifo'][caller].sort(key=lambda key: (scheduler['jobs'][key]['admitted_ms'], key))
        changes[scheduler_key] = qc.validate_scheduler(tidy_scheduler(scheduler))
        if commit(store, expected, changes, f'cleanup:{slot}:{owner}:{uuid4().hex[:16]}', deadline=deadline):
            return 'freed'
    return 'failed'


# --- Reclaim --------------------------------------------------------------------------------------------------------
def reclaim_slot(store, slot: int, *, deadline: float | None = None, attempts: int = 4,
                 replace_with: str | None = None) -> str:
    """Same-host reclaim of an expired slot (see module docstring). Never creates a lock file."""
    lease_key = qc.runner_lease_key(slot)
    try:
        row = read(store, [lease_key], deadline=deadline).records[lease_key]
        lease = qc.validate_runner_lease(deepcopy(row.value))
    except ProjectionUnavailable:
        return 'uncertain'
    except (ValueError, KeyError, TypeError):
        return 'uncertain'
    if lease is None:
        return 'not_applicable'
    now = qc.wall_ms()
    if lease['state'] == 'reserved':
        if now - lease['reserved_ms'] <= qc.RESERVATION_TTL_MS:
            return 'not_applicable'
        try:
            replacement = None if replace_with is None else qc.validate_runner_lease(
                qc.new_runner_lease(replace_with, host_id(), now, os.getpid()))
        except (OSError, ValueError):
            return 'uncertain'
        return 'reclaimed' if commit(store, {lease_key: row.version}, {lease_key: replacement},
                                     f'unreserve:{slot}:{lease["owner"]}:{uuid4().hex[:16]}', deadline=deadline) else 'not_applicable'
    if lease['lease_until_ms'] > now:
        return 'not_applicable'
    try:
        directory = lock_dir()
        if lease['host'] != host_id(directory):
            return 'uncertain'
        descriptor = os.open(lock_path(slot, lease['owner'], directory), os.O_RDWR)  # No O_CREAT: absent means unknown.
    except OSError:
        return 'uncertain'
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            # EWOULDBLOCK: a process still holds the lock and may be alive (SIGSTOP) -- never replace it.
            return 'uncertain'
        outcome = _cleanup(store, slot, lease['owner'], attempts=attempts, deadline=deadline, replace_with=replace_with)
        if outcome == 'failed':
            return 'uncertain'
        if outcome == 'gone':
            return 'not_applicable'
        try:
            lock_path(slot, lease['owner'], directory).unlink(missing_ok=True)
        except OSError:
            pass
        return 'reclaimed'
    finally:
        os.close(descriptor)


def release_slot(store, slot: int) -> str:
    """Operator release (``scripts/price_runners.py release --confirm-terminated``): the operator asserts the runner is
    gone, so no host or lock check. Frees a claimed or reserved slot with the same cleanup as a reclaim. A lease that fails
    validation is released too (through its owner when it still names one, else the key is simply cleared)."""
    lease_key = qc.runner_lease_key(slot)
    row = read(store, [lease_key]).records[lease_key]
    if row.value is None:
        return 'not_applicable'
    try:
        lease = qc.validate_runner_lease(deepcopy(row.value))
        owner, state = lease['owner'], lease['state']
    except ValueError:
        raw = row.value.get('owner') if isinstance(row.value, dict) else None
        owner, state = (raw if type(raw) is str and _OWNER.fullmatch(raw) else None), None
    if state == 'reserved' or owner is None:
        ok = commit(store, {lease_key: row.version}, {lease_key: None}, f'release:{slot}:{owner}:{uuid4().hex[:16]}')
    else:
        ok = cleanup_slot(store, slot, owner)
    if ok and owner is not None:
        try:
            lock_path(slot, owner).unlink(missing_ok=True)
        except (OSError, ValueError):
            pass
    return 'released' if ok else 'failed'
