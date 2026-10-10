"""Record contract for price refresh (tickets 07 admission and 08 runners). Pure: no I/O, no psycopg, no ``app.main``.

Every coordination and result record the refresh machinery stores is built and validated here, so the API
(admission) and the runner process (which must never import PostgreSQL code) agree on one shape. The shapes are
documented in docs/price-refresh.md; the 06 quote/result contract is docs/prices.md.

Times are integer epoch milliseconds, except the 06 ``checked_at`` / ``expires_at`` / ``provider_updated_at``
fields, which stay ISO-8601 text. Builders return plain dicts; validators return the value they were given or raise
``ContractError`` (a ``ValueError``). Validators are strict: wrong types (including ``bool`` for ``int``), unknown
fields, out-of-range numbers and violated caps are all refused.
"""
from datetime import datetime, timezone
from decimal import Decimal
import re
import time

from .public_records import admission_key, backoff_key, fence_key, lease_key, work_key

__all__ = [
    'ContractError', 'wall_ms', 'parse_amount', 'iso_from_ms',
    'SCHEDULER_SCOPE', 'SOURCE_BACKOFF_SCOPE', 'RUNNER_SLOTS', 'LEDGER_SHARDS',
    'FRESH_MS', 'HARD_MS', 'FUTURE_TOLERANCE_MS', 'JOB_TTL_MS', 'ABSENT_TTL_MS', 'MAX_JOBS', 'MAX_JOBS_PER_CALLER',
    'MAX_INTERACTIVE', 'MAX_INTERACTIVE_PER_CALLER', 'MAX_SOURCE_PERMITS', 'MAX_SOURCE_PER_CALLER',
    'MAX_SOURCE_PER_SLOT', 'MAX_NEW_JOBS_PER_ACCESS', 'LEDGER_CAP', 'BUCKET_CAPACITY_MILLI', 'BUCKET_REFILL_MILLI_PER_S',
    'LEASE_TTL_MS', 'LEASE_RENEW_MS', 'RESERVATION_TTL_MS', 'HARD_STOP_MS', 'BACKOFF_BASE_S', 'BACKOFF_CAP_S',
    'RETRY_AFTER_CAP_S', 'SLOT_STATES', 'JOB_STATES', 'SOURCE_BACKOFF_REASONS', 'EDITION_BACKOFF_REASONS',
    'scheduler_key', 'ledger_scope', 'ledger_key', 'runner_scope', 'runner_lease_key', 'source_backoff_key',
    'edition_backoff_scope', 'edition_backoff_key', 'job_id', 'split_job_id', 'work_record_key', 'fence_record_key',
    'ledger_shard', 'edition_backoff_delay_s',
    'new_scheduler', 'new_ledger_shard', 'new_runner_lease', 'new_source_backoff', 'new_edition_backoff', 'new_work',
    'new_fence', 'new_job', 'new_quote_result', 'new_absent_result', 'new_quote_payload',
    'validate_scheduler', 'validate_ledger_shard', 'validate_runner_lease', 'validate_source_backoff',
    'validate_edition_backoff', 'validate_work', 'validate_fence', 'validate_quote_result', 'validate_quote_payload',
    'slot_status', 'runner_target',
]


class ContractError(ValueError):
    """A record does not satisfy the contract."""


# --- Clock ---------------------------------------------------------------------------------------------------------
def wall_ms() -> int:
    """Epoch milliseconds. The single wall clock for admission, classification and runner records; tests patch it
    (``monkeypatch.setattr(quote_contract, 'wall_ms', ...)``). Callers must reach it as ``quote_contract.wall_ms()``."""
    return int(time.time() * 1000)


def iso_from_ms(ms: int) -> str:
    """Epoch milliseconds -> the ISO-8601 'Z' text used by the 06 ``checked_at`` / ``expires_at`` fields."""
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace('+00:00', 'Z')


# --- Amount grammar (06; moved verbatim from prices.py) --------------------------------------------------------------
_AMOUNT = re.compile(r'(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?')


def parse_amount(value) -> Decimal | None:
    """Strict decimal text -> Decimal, or None. Floats, exponents, signs, NaN/Infinity and long values are refused."""
    if type(value) is not str or not _AMOUNT.fullmatch(value):
        return None
    amount = Decimal(value)
    return amount if amount.is_finite() and amount >= 0 else None


# --- Constants -------------------------------------------------------------------------------------------------------
SCHEDULER_SCOPE = 'price:scheduler'
SOURCE_BACKOFF_SCOPE = 'price:source'
RUNNER_SLOTS = (0, 1)
LEDGER_SHARDS = 64

FRESH_MS = 3_600_000                  # a check younger than this is fresh: no admission, no write
HARD_MS = 24 * 3_600_000              # a check this old (or unreadable) must be refreshed before answering
FUTURE_TOLERANCE_MS = 5 * 60_000      # a checked_at further ahead than this is garbled
JOB_TTL_MS = 60_000                   # expires_ms = admitted_ms + this; set once, never extended
ABSENT_TTL_MS = 3_600_000             # result.expires_at = checked_at + this for an absent result

MAX_JOBS = 256
MAX_JOBS_PER_CALLER = 32
MAX_INTERACTIVE = 32
MAX_INTERACTIVE_PER_CALLER = 2
MAX_SOURCE_PERMITS = 8
MAX_SOURCE_PER_CALLER = 2
MAX_SOURCE_PER_SLOT = 4
MAX_NEW_JOBS_PER_ACCESS = 32
LEDGER_CAP = 10_000                   # anonymous callers admitted per interval
BUCKET_CAPACITY_MILLI = 8_000         # token bucket: capacity 8 tokens, tracked in milli-tokens
BUCKET_REFILL_MILLI_PER_S = 1_000     # refills 1 token per second

RESERVATION_TTL_MS = 5_000            # an unclaimed reservation older than this may be overwritten
LEASE_TTL_MS = 10_000
LEASE_RENEW_MS = 3_000
HARD_STOP_MS = 65_000                 # a runner is killed this long after its claim

BACKOFF_BASE_S = 60
BACKOFF_CAP_S = 900
RETRY_AFTER_CAP_S = 3_600

SLOT_STATES = ('reserved', 'running', 'exiting')
JOB_STATES = ('queued', 'running')
SOURCE_BACKOFF_REASONS = ('retry_after', 'rate_limited')
EDITION_BACKOFF_REASONS = ('timeout', 'transport', 'http_status', 'redirect', 'too_large', 'malformed', 'ambiguous',
                           'lookup_drift')

_REF = re.compile(r'[0-9a-f]{48}')
_OWNER = re.compile(r'[0-9a-f]{32}')
_CALLER = re.compile(r'(user|anon):[A-Za-z0-9._:-]{1,200}')
_ANON = re.compile(r'anon:[0-9a-f]{32}')
_CARD = re.compile(r'[A-Za-z0-9_.!%~-]{1,128}')
_VARIANT = re.compile(r'[A-Za-z0-9_.-]{1,64}')
_PRODUCT = re.compile(r'[A-Za-z0-9_.-]{1,64}')
_JOB = re.compile(r'([0-9a-f]{48}):([1-9][0-9]{0,18})')
_HOST = re.compile(r'[A-Za-z0-9_.:-]{1,128}')
_INT_MAX = 2 ** 63 - 1


# --- Scope and key builders ------------------------------------------------------------------------------------------
def scheduler_key() -> str:
    return admission_key(SCHEDULER_SCOPE)


def ledger_shard(caller: str) -> int:
    """Stable shard (0..63) of an anonymous caller. The digest is already uniform hex, so its leading byte decides."""
    if type(caller) is not str or not _ANON.fullmatch(caller):
        raise ContractError('ledger callers are anon:<32 hex>')
    return int(caller[5:7], 16) % LEDGER_SHARDS


def ledger_scope(shard: int) -> str:
    if type(shard) is not int or not 0 <= shard < LEDGER_SHARDS:
        raise ContractError('invalid ledger shard')
    return f'price:ledger:{shard:02d}'


def ledger_key(shard: int) -> str:
    return admission_key(ledger_scope(shard))


def runner_scope(slot: int) -> str:
    if type(slot) is not int or slot not in RUNNER_SLOTS:
        raise ContractError('invalid runner slot')
    return f'price:runner:{slot}'


def runner_lease_key(slot: int) -> str:
    return lease_key(runner_scope(slot))


def source_backoff_key() -> str:
    return backoff_key(SOURCE_BACKOFF_SCOPE)


def job_id(edition_ref: str, mapping_revision: int) -> str:
    """``<ref>:<rev>``: the identity of a job in ``scheduler.jobs``, ``fifo`` and the key suffix of ``work:``/``fence:``."""
    if type(edition_ref) is not str or not _REF.fullmatch(edition_ref):
        raise ContractError('invalid edition reference')
    if type(mapping_revision) is not int or not 0 < mapping_revision <= _INT_MAX:
        raise ContractError('invalid mapping revision')
    return f'{edition_ref}:{mapping_revision}'


def split_job_id(job: str) -> tuple[str, int]:
    match = _JOB.fullmatch(job) if type(job) is str else None
    if not match or int(match.group(2)) > _INT_MAX:
        raise ContractError('invalid job id')
    return match.group(1), int(match.group(2))


def edition_backoff_scope(edition_ref: str, mapping_revision: int) -> str:
    return 'price:edition:' + job_id(edition_ref, mapping_revision)


def edition_backoff_key(edition_ref: str, mapping_revision: int) -> str:
    return backoff_key(edition_backoff_scope(edition_ref, mapping_revision))


def work_record_key(edition_ref: str, mapping_revision: int) -> str:
    return work_key(edition_ref, mapping_revision)


def fence_record_key(edition_ref: str, mapping_revision: int) -> str:
    return fence_key(edition_ref, mapping_revision)


def edition_backoff_delay_s(failures: int, jitter: float = 1.0, retry_after_s: float | None = None) -> float:
    """Wait after the ``failures``-th consecutive failure: min(60*2^(k-1), 900) s x jitter (0.8..1.2), or a valid
    Retry-After when that asks for more. ``jitter`` is passed in so the function stays deterministic."""
    if type(failures) is not int or failures < 1:
        raise ContractError('failures must be a positive integer')
    if not 0.8 <= jitter <= 1.2:
        raise ContractError('jitter must be within 0.8..1.2')
    delay = min(BACKOFF_BASE_S * 2 ** min(failures - 1, 16), BACKOFF_CAP_S) * jitter
    return max(delay, retry_after_s) if retry_after_s is not None else delay


# --- Validation primitives -------------------------------------------------------------------------------------------
def _fail(what: str):
    raise ContractError(what)


def _int(value, what, lo=0, hi=_INT_MAX):
    if type(value) is not int or not lo <= value <= hi:
        _fail(f'{what} must be an integer in {lo}..{hi}')
    return value


def _opt_int(value, what, lo=0, hi=_INT_MAX):
    return None if value is None else _int(value, what, lo, hi)


def _pattern(value, pattern, what):
    if type(value) is not str or not pattern.fullmatch(value):
        _fail(f'invalid {what}')
    return value


def _dict(value, what, keys, optional=()):
    if type(value) is not dict:
        _fail(f'{what} must be an object')
    extra = set(value) - set(keys) - set(optional)
    missing = set(keys) - set(value)
    if extra or missing:
        _fail(f'{what} has unexpected or missing fields: {sorted(extra | missing)}')
    return value


def _version(value, what):
    if value != 1 or type(value) is not int:
        _fail(f'{what} v must be 1')


def _caller(value):
    return _pattern(value, _CALLER, 'caller')


# --- Builders and validators -----------------------------------------------------------------------------------------
def new_scheduler(now_ms: int) -> dict:
    """The empty scheduler: a full token bucket and no jobs, permits or ledger entries."""
    return {'v': 1, 'bucket': {'milli': BUCKET_CAPACITY_MILLI, 'at_ms': now_ms}, 'interactive': {}, 'jobs': {}, 'fifo': {},
            'ring': [], 'cursor': 0, 'source': {}, 'ledger': {'interval': 0, 'count': 0},
            'stats': {'admitted': 0, 'joined': 0, 'refused': {}, 'expired': 0, 'fenced': 0}}


def new_job(caller: str, card: str, admitted_ms: int) -> dict:
    """A ``scheduler.jobs`` entry. ``expires_ms`` is fixed here and never changes afterwards (invariant 8)."""
    return {'caller': caller, 'card': card, 'admitted_ms': admitted_ms, 'expires_ms': admitted_ms + JOB_TTL_MS,
            'state': 'queued', 'slot': None, 'owner': None, 'attempt': None}


def _validate_job(job_key, job):
    split_job_id(job_key)
    _dict(job, 'job', ('caller', 'card', 'admitted_ms', 'expires_ms', 'state', 'slot', 'owner', 'attempt'))
    _caller(job['caller'])
    _pattern(job['card'], _CARD, 'card')
    _int(job['admitted_ms'], 'admitted_ms')
    if _int(job['expires_ms'], 'expires_ms') != job['admitted_ms'] + JOB_TTL_MS:
        _fail('expires_ms is admitted_ms + 60000 and never extended')
    if job['state'] not in JOB_STATES:
        _fail('invalid job state')
    queued = job['state'] == 'queued'
    if queued != (job['slot'] is None and job['owner'] is None and job['attempt'] is None):
        _fail('a queued job has no slot, owner or attempt; a running job has all three')
    if not queued:
        if type(job['slot']) is not int or job['slot'] not in RUNNER_SLOTS:
            _fail('invalid job slot')
        _pattern(job['owner'], _OWNER, 'owner')
        _int(job['attempt'], 'attempt', 1)


def validate_scheduler(record) -> dict:
    """Shape, types and every cap of ``admission:price:scheduler`` (invariant 9: caps hold at every committed version)."""
    _dict(record, 'scheduler', ('v', 'bucket', 'interactive', 'jobs', 'fifo', 'ring', 'cursor', 'source', 'ledger', 'stats'))
    _version(record['v'], 'scheduler')
    bucket = _dict(record['bucket'], 'bucket', ('milli', 'at_ms'))
    _int(bucket['milli'], 'bucket.milli', 0, BUCKET_CAPACITY_MILLI)
    _int(bucket['at_ms'], 'bucket.at_ms')
    interactive = record['interactive']
    if type(interactive) is not dict or len(interactive) > MAX_INTERACTIVE:
        _fail('interactive permits are an object of at most 32')
    per_caller = {}
    for request_id, permit in interactive.items():
        _pattern(request_id, re.compile(r'[A-Za-z0-9_-]{1,64}'), 'request id')
        _dict(permit, 'interactive permit', ('caller', 'until_ms'))
        per_caller[_caller(permit['caller'])] = per_caller.get(permit['caller'], 0) + 1
        _int(permit['until_ms'], 'until_ms')
    if any(count > MAX_INTERACTIVE_PER_CALLER for count in per_caller.values()):
        _fail('more than 2 interactive permits for one caller')
    jobs = record['jobs']
    if type(jobs) is not dict or len(jobs) > MAX_JOBS:
        _fail('jobs are an object of at most 256')
    jobs_per_caller = {}
    for key, job in jobs.items():
        _validate_job(key, job)
        jobs_per_caller[job['caller']] = jobs_per_caller.get(job['caller'], 0) + 1
    if any(count > MAX_JOBS_PER_CALLER for count in jobs_per_caller.values()):
        _fail('more than 32 jobs for one caller')
    fifo = record['fifo']
    if type(fifo) is not dict:
        _fail('fifo must be an object')
    queued = {key for key, job in jobs.items() if job['state'] == 'queued'}
    listed = []
    for caller, entries in fifo.items():
        _caller(caller)
        if type(entries) is not list or not entries or len(entries) > MAX_JOBS_PER_CALLER:
            _fail('a fifo is a non-empty list of at most 32 job ids')
        for entry in entries:
            if entry not in jobs or jobs[entry]['caller'] != caller:
                _fail('a fifo entry must name one of the caller\'s own jobs')
        listed += entries
    if len(listed) != len(set(listed)) or set(listed) != queued:
        _fail('every queued job is in exactly one fifo and no other job is')
    ring = record['ring']
    if type(ring) is not list or len(ring) != len(set(ring)) or set(ring) != set(fifo) or any(type(c) is not str for c in ring):
        _fail('ring lists exactly the callers that have a fifo, once each')
    _int(record['cursor'], 'cursor', 0, max(len(ring), 1))
    if ring and record['cursor'] >= len(ring):
        _fail('cursor is outside the ring')
    source = record['source']
    if type(source) is not dict or len(source) > MAX_SOURCE_PERMITS:
        _fail('source permits are an object of at most 8')
    by_caller, by_slot, claimed = {}, {}, []
    for permit_id, permit in source.items():
        _pattern(permit_id, re.compile(r'[A-Za-z0-9_-]{1,64}'), 'permit id')
        _dict(permit, 'source permit', ('caller', 'slot', 'owner', 'jobs', 'started_ms'))
        by_caller[_caller(permit['caller'])] = by_caller.get(permit['caller'], 0) + 1
        if type(permit['slot']) is not int or permit['slot'] not in RUNNER_SLOTS:
            _fail('invalid permit slot')
        by_slot[permit['slot']] = by_slot.get(permit['slot'], 0) + 1
        _pattern(permit['owner'], _OWNER, 'owner')
        _int(permit['started_ms'], 'started_ms')
        if type(permit['jobs']) is not list or not permit['jobs']:
            _fail('a permit claims at least one job')
        for entry in permit['jobs']:
            if entry not in jobs or jobs[entry]['state'] != 'running':
                _fail('a permit claims only running jobs')
        claimed += permit['jobs']
    if len(claimed) != len(set(claimed)):
        _fail('a job is claimed by one permit')
    if any(count > MAX_SOURCE_PER_CALLER for count in by_caller.values()) \
            or any(count > MAX_SOURCE_PER_SLOT for count in by_slot.values()):
        _fail('source permit cap exceeded')
    ledger = _dict(record['ledger'], 'ledger', ('interval', 'count'))
    _int(ledger['interval'], 'ledger.interval')
    _int(ledger['count'], 'ledger.count', 0, LEDGER_CAP)
    stats = _dict(record['stats'], 'stats', ('admitted', 'joined', 'refused', 'expired', 'fenced'))
    for name in ('admitted', 'joined', 'expired', 'fenced'):
        _int(stats[name], f'stats.{name}')
    if type(stats['refused']) is not dict or len(stats['refused']) > 32 \
            or any(type(k) is not str or not 0 < len(k) <= 32 for k in stats['refused']):
        _fail('stats.refused maps a reason to a count')
    for count in stats['refused'].values():
        _int(count, 'stats.refused count')
    return record


def new_ledger_shard() -> dict:
    return {'v': 1, 'entries': {}}


def validate_ledger_shard(record, shard: int | None = None) -> dict:
    """``{v:1, entries:{"anon:<digest>":{expires_ms}}}``. Values carry nothing but the expiry (no IP, no counts)."""
    _dict(record, 'ledger shard', ('v', 'entries'))
    _version(record['v'], 'ledger shard')
    entries = record['entries']
    if type(entries) is not dict or len(entries) > LEDGER_CAP:
        _fail('ledger entries are an object')
    for caller, entry in entries.items():
        _pattern(caller, _ANON, 'ledger caller')
        if shard is not None and ledger_shard(caller) != shard:
            _fail('ledger entry is in the wrong shard')
        _dict(entry, 'ledger entry', ('expires_ms',))
        _int(entry['expires_ms'], 'expires_ms')
    return record


def new_runner_lease(owner: str, host: str, reserved_ms: int, launcher_pid: int) -> dict:
    """A freshly reserved slot, before any supervisor has claimed it."""
    return {'v': 1, 'owner': owner, 'state': 'reserved', 'host': host, 'reserved_ms': reserved_ms,
            'launcher_pid': launcher_pid, 'claimed_ms': None, 'supervisor_pid': None, 'worker_pid': None,
            'lease_until_ms': reserved_ms + RESERVATION_TTL_MS, 'hard_stop_ms': None}


def validate_runner_lease(record) -> dict | None:
    """``lease:price:runner:<n>``: ``None`` (free) or the lease. Reserved leases have no pids; claimed ones have all."""
    if record is None:
        return None
    _dict(record, 'runner lease', ('v', 'owner', 'state', 'host', 'reserved_ms', 'launcher_pid', 'claimed_ms',
                                   'supervisor_pid', 'worker_pid', 'lease_until_ms', 'hard_stop_ms'))
    _version(record['v'], 'runner lease')
    _pattern(record['owner'], _OWNER, 'owner')
    if record['state'] not in SLOT_STATES:
        _fail('invalid slot state')
    _pattern(record['host'], _HOST, 'host')
    _int(record['reserved_ms'], 'reserved_ms')
    _int(record['launcher_pid'], 'launcher_pid', 1, 2 ** 31)
    _int(record['lease_until_ms'], 'lease_until_ms')
    claimed = [record[name] for name in ('claimed_ms', 'supervisor_pid', 'worker_pid', 'hard_stop_ms')]
    if record['state'] == 'reserved':
        if any(value is not None for value in claimed):
            _fail('a reserved slot has no claim fields')
    else:
        _int(record['claimed_ms'], 'claimed_ms')
        _int(record['supervisor_pid'], 'supervisor_pid', 1, 2 ** 31)
        _int(record['worker_pid'], 'worker_pid', 1, 2 ** 31)
        _int(record['hard_stop_ms'], 'hard_stop_ms')
        if record['hard_stop_ms'] < record['claimed_ms']:
            _fail('hard_stop_ms precedes the claim')
    return record


SLOT_SAFETY_MS = 3_000                # a running slot this close to its hard stop does not count as a runner to wait for


def slot_status(lease, now_ms: int) -> str:
    """The one classification of a runner slot, shared by admission and the runner's handoff.

    ``free``: no lease, or a reservation older than the TTL (anyone may overwrite it). ``usable``: a young reservation, or a
    running lease that is live with more than ``SLOT_SAFETY_MS`` before its hard stop. ``reclaimable``: running or exiting
    with ``lease_until_ms <= now`` (a candidate for ``price_launcher.reclaim_slot``, never taken without the lock proof).
    ``winding_down``: live but leaving (exiting, or about to be killed); its supervisor hands the queue on. ``invalid``: not a
    runner lease at all. ``lease`` may be the raw stored value, a validated lease or the string ``'invalid'``; never raises."""
    if lease is None:
        return 'free'
    try:
        lease = validate_runner_lease(lease)
    except (ContractError, TypeError, ValueError, KeyError, RecursionError):
        return 'invalid'
    if lease is None:
        return 'free'
    if lease['state'] == 'reserved':
        return 'usable' if now_ms - lease['reserved_ms'] <= RESERVATION_TTL_MS else 'free'
    if lease['lease_until_ms'] <= now_ms:
        return 'reclaimable'
    if lease['state'] == 'running' and lease['hard_stop_ms'] > now_ms + SLOT_SAFETY_MS:
        return 'usable'
    return 'winding_down'


def runner_target(queued: int) -> int:
    """How many runners the queue calls for: a second one when more than four jobs wait."""
    return 2 if queued > 4 else 1


def new_source_backoff(reason: str, retry_ms: int, set_ms: int) -> dict:
    return {'v': 1, 'retry_ms': retry_ms, 'reason': reason, 'set_ms': set_ms}


def validate_source_backoff(record) -> dict:
    _dict(record, 'source backoff', ('v', 'retry_ms', 'reason', 'set_ms'))
    _version(record['v'], 'source backoff')
    _int(record['retry_ms'], 'retry_ms')
    _int(record['set_ms'], 'set_ms')
    if record['reason'] not in SOURCE_BACKOFF_REASONS:
        _fail('invalid source backoff reason')
    if record['retry_ms'] - record['set_ms'] > RETRY_AFTER_CAP_S * 1000:
        _fail('source backoff exceeds the 1 h cap')
    return record


def new_edition_backoff(failures: int, last_attempt_ms: int, retry_ms: int, reason: str) -> dict:
    return {'v': 1, 'failures': failures, 'last_attempt_ms': last_attempt_ms, 'retry_ms': retry_ms, 'reason': reason}


def validate_edition_backoff(record) -> dict:
    _dict(record, 'edition backoff', ('v', 'failures', 'last_attempt_ms', 'retry_ms', 'reason'))
    _version(record['v'], 'edition backoff')
    _int(record['failures'], 'failures', 1)
    _int(record['last_attempt_ms'], 'last_attempt_ms')
    _int(record['retry_ms'], 'retry_ms')
    if record['reason'] not in EDITION_BACKOFF_REASONS:
        _fail('invalid edition backoff reason')
    return record


def new_work(edition_ref: str, mapping_revision: int, card: str, variant: str, product_id: str, caller: str,
             admitted_ms: int) -> dict:
    return {'v': 1, 'edition_ref': edition_ref, 'mapping_revision': mapping_revision, 'card': card, 'variant': variant,
            'product_id': product_id, 'caller': caller, 'admitted_ms': admitted_ms, 'expires_ms': admitted_ms + JOB_TTL_MS,
            'state': 'queued', 'attempt': None, 'slot': None, 'owner': None}


def validate_work(record) -> dict:
    _dict(record, 'work', ('v', 'edition_ref', 'mapping_revision', 'card', 'variant', 'product_id', 'caller', 'admitted_ms',
                           'expires_ms', 'state', 'attempt', 'slot', 'owner'))
    _version(record['v'], 'work')
    job_id(record['edition_ref'], record['mapping_revision'])
    _pattern(record['card'], _CARD, 'card')
    _pattern(record['variant'], _VARIANT, 'variant')
    _pattern(record['product_id'], _PRODUCT, 'product_id')
    _caller(record['caller'])
    _int(record['admitted_ms'], 'admitted_ms')
    if _int(record['expires_ms'], 'expires_ms') != record['admitted_ms'] + JOB_TTL_MS:
        _fail('expires_ms is admitted_ms + 60000 and never extended')
    if record['state'] not in JOB_STATES:
        _fail('invalid work state')
    queued = record['state'] == 'queued'
    if queued != (record['attempt'] is None and record['slot'] is None and record['owner'] is None):
        _fail('queued work has no attempt, slot or owner; running work has all three')
    if not queued:
        _int(record['attempt'], 'attempt', 1)
        if type(record['slot']) is not int or record['slot'] not in RUNNER_SLOTS:
            _fail('invalid work slot')
        _pattern(record['owner'], _OWNER, 'owner')
    return record


def new_fence(attempt: int = 0) -> dict:
    return {'v': 1, 'attempt': attempt}


def validate_fence(record) -> dict:
    _dict(record, 'fence', ('v', 'attempt'))
    _version(record['v'], 'fence')
    _int(record['attempt'], 'attempt')
    return record


# --- 06 quote / result (docs/prices.md) ------------------------------------------------------------------------------
def new_quote_result(attempt: int, checked_at_ms: int) -> dict:
    return {'state': 'quote', 'attempt': attempt, 'checked_at': iso_from_ms(checked_at_ms)}


def new_absent_result(attempt: int, checked_at_ms: int) -> dict:
    """Confirmed absence. It also carries the attempt (07/08 addition to the 06 shape); the quote key is deleted in
    the same CAS."""
    return {'state': 'absent', 'attempt': attempt, 'checked_at': iso_from_ms(checked_at_ms),
            'expires_at': iso_from_ms(checked_at_ms + ABSENT_TTL_MS)}


def new_quote_payload(attempt: int, amount: str, card: str, variant: str, provider_updated_at: str | None) -> dict:
    return {'attempt': attempt, 'amount': amount, 'currency': 'USD', 'source': 'tcgdex', 'card': card, 'variant': variant,
            'provider_updated_at': provider_updated_at}


def _iso(value, what, nullable=False):
    if value is None and nullable:
        return None
    if type(value) is not str or not 0 < len(value) <= 40:
        _fail(f'{what} must be ISO-8601 text')
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        _fail(f'{what} must be ISO-8601 text')
    if moment.tzinfo is None or moment.utcoffset() is None:
        _fail(f'{what} needs a UTC offset')
    return value


def validate_quote_result(record) -> dict:
    """What the runner may write to ``result:``: only ``quote`` and ``absent`` (invariant 5; never ``pending``)."""
    if type(record) is not dict or record.get('state') not in ('quote', 'absent'):
        _fail('result state must be quote or absent')
    if record['state'] == 'quote':
        _dict(record, 'quote result', ('state', 'attempt', 'checked_at'), ('last_failure_at',))
        _iso(record.get('last_failure_at'), 'last_failure_at', nullable=True)
    else:
        _dict(record, 'absent result', ('state', 'attempt', 'checked_at', 'expires_at'))
        _iso(record['expires_at'], 'expires_at')
    _int(record['attempt'], 'attempt', 1)
    _iso(record['checked_at'], 'checked_at')
    return record


def validate_quote_payload(record) -> dict:
    _dict(record, 'quote', ('attempt', 'amount', 'currency', 'source', 'card', 'variant', 'provider_updated_at'))
    _int(record['attempt'], 'attempt', 1)
    if parse_amount(record['amount']) is None:
        _fail('amount must be strict decimal text')
    if record['currency'] != 'USD' or record['source'] != 'tcgdex':
        _fail('quotes are USD from tcgdex')
    _pattern(record['card'], _CARD, 'card')
    _pattern(record['variant'], _VARIANT, 'variant')
    _iso(record['provider_updated_at'], 'provider_updated_at', nullable=True)
    return record
