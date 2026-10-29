"""Access-triggered price-refresh admission (ticket 07). PostgreSQL-free: no psycopg, no ``app.main``, no ``app.games.pokemon.prices.prices``.

``evaluate_and_admit(rows, caller, budget)`` classifies the stored state of each row by the age of ``result.checked_at``,
joins rows already in flight, admits new jobs under every cap with one bounded compare-and-swap, reserves a runner
slot when work is queued and nobody is coming, and calls ``price_launcher.spawn`` after the commit. When work is
pending but the only slot is a dead runner (lease run out), it asks ``price_launcher.reclaim_slot`` for one bounded
reclaim and spawns into the reservation that CAS wrote. It never writes a quote, never fetches a source, and never
changes a user-visible state: the caller always keeps the cached view. Reads under one hour write nothing and contact nothing. There is no way to force a refresh: only stored
state, the server clock and the signed caller decide.

Bands (``result.checked_at`` against ``quote_contract.wall_ms()``): under 1 h fresh; 1 h up to 24 h soft (cached now,
admitted in the background); 24 h or more, a missing/garbled/future (> 5 min) ``checked_at``, unknown, invalid,
evicted or pending: hard (admit, then wait until ``budget.wait_until``).

Record shapes and invariants: docs/price-refresh.md. Contract helpers: ``quote_contract``.
"""
from collections import namedtuple
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import os
import re
import secrets
import socket
import time
from uuid import uuid4

from . import price_launcher, quote_contract as qc
from .public_projection import ProjectionUnavailable
from .public_records import OperationConflict, public_record_store, quote_states, result_key

__all__ = ['Row', 'Outcome', 'Admission', 'evaluate_and_admit', 'classify', 'REFRESH_LABELS']

# (key, edition_ref, mapping_revision, lookup {'card', 'variant'}, product_id, QuoteState)
Row = namedtuple('Row', 'key edition_ref mapping_revision lookup product_id state')

REFRESH_LABELS = ('background', 'refreshed', 'timeout', 'busy', 'backoff', 'failed')
TRY_SECONDS = 0.6
MAX_TRIES = 2
POLL_SECONDS = 0.1
RELEASE_SECONDS = 1.0
RECLAIM_SECONDS = 0.6      # one reclaim step on the request path (read, lock proof, one CAS attempt)
FOLLOW_UP_SECONDS = 0.25   # of the hard wait kept for the reads that follow it, so they never touch the PostgreSQL reserve
CHUNK_ROWS = 64            # work: + backoff: per row = 128 keys
MAX_CHUNKS = 4
_STORE_ERRORS = (ProjectionUnavailable, qc.ContractError, ValueError, OSError, KeyError, TypeError)


@dataclass
class Outcome:
    klass: str                       # 'fresh' | 'soft' | 'hard'
    refresh: str | None = None       # one of REFRESH_LABELS, None while a hard row is still awaited or when fresh
    awaiting: bool = False           # a hard row whose job is in flight and whose answer waits for it
    failed_at_ms: int | None = None
    reason: str | None = None        # why a row was not admitted (stats vocabulary), for tests and logs
    job: str | None = None


def _checked_ms(state) -> int | None:
    """``result.checked_at`` as epoch ms, or None when missing, garbled or timezone-less."""
    result = state.result if isinstance(state.result, dict) else {}
    value = result.get('checked_at')
    if type(value) is not str or not 0 < len(value) <= 40:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is None or moment.utcoffset() is None:
        return None
    return int(moment.astimezone(timezone.utc).timestamp() * 1000)


def classify(state, now_ms: int) -> str:
    """'fresh' | 'soft' | 'hard' for one stored state."""
    if state.status not in ('quote', 'absent'):
        return 'hard'                                    # unknown, evicted, invalid, pending
    checked = _checked_ms(state)
    if checked is None or checked - now_ms > qc.FUTURE_TOLERANCE_MS:
        return 'hard'
    age = now_ms - checked
    if state.status == 'absent':
        expires = _expires_ms(state.result)
        if age < qc.FRESH_MS and (expires is None or now_ms < expires):
            return 'fresh'
    elif age < qc.FRESH_MS:
        return 'fresh'
    return 'soft' if age < qc.HARD_MS else 'hard'


def _expires_ms(result) -> int | None:
    value = result.get('expires_at') if isinstance(result, dict) else None
    if type(value) is not str:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return None if moment.tzinfo is None else int(moment.astimezone(timezone.utc).timestamp() * 1000)


def _host() -> str:
    name = re.sub(r'[^A-Za-z0-9_.:-]', '-', socket.gethostname())[:128]
    return name or 'host'


class Admission:
    """The outcome of one access. ``outcomes`` is keyed by ``Row.key``; ``refused`` counts refusal reasons."""

    def __init__(self, rows, caller, budget, store):
        self.rows, self.caller, self.budget, self.store = list(rows), caller, budget, store
        self.outcomes: dict = {}
        self.refused: dict[str, int] = {}
        self.reservations: list[tuple[int, str, bool]] = []     # (slot, owner, spawned)
        self.request_id = uuid4().hex
        self.permit_held = False
        self.committed = False
        self._released = False
        self._versions: dict[str, str] = {}                      # result key -> version when classified
        self._usable_before = 0
        self._slot_info: dict | None = None                      # what _plan saw of the runner slots, for the reclaim step
        self._late: dict[str, int] = {}                          # refusals decided after the commit; release() records them

    # ---- helpers -------------------------------------------------------------------------------------------
    def _refuse(self, row, label, reason):
        outcome = self.outcomes[row.key]
        outcome.refresh, outcome.awaiting, outcome.reason = label, False, reason
        self.refused[reason] = self.refused.get(reason, 0) + 1

    def _refuse_all_open(self, reason):
        for row in self.rows:
            outcome = self.outcomes[row.key]
            if outcome.klass != 'fresh' and outcome.refresh in (None, 'background'):
                self._refuse(row, 'busy', reason)

    def _deadline(self):
        return min(self.budget.wait_until, time.monotonic() + TRY_SECONDS)

    def _read(self, keys, deadline, generation):
        return self.store.read_all(keys, deadline=deadline, generation=generation)

    # ---- admission -----------------------------------------------------------------------------------------
    def run(self):
        now = qc.wall_ms()
        for row in self.rows:
            self.outcomes[row.key] = Outcome(classify(row.state, now))
        open_rows = [row for row in self.rows if self.outcomes[row.key].klass != 'fresh']
        if not open_rows:
            return self
        if self.store is None:
            self.store = public_record_store()
        try:
            self._admit(open_rows)
        except _STORE_ERRORS:
            self._refuse_all_open('store_unavailable')
        return self

    def _admit(self, open_rows):
        generation = open_rows[0].state.generation
        rows = list(self.rows)
        for attempt in range(1, MAX_TRIES + 1):
            if self.budget.wait_remaining() <= 0:
                return self._refuse_all_open('deadline')
            if attempt > 1:                         # re-read the latest store and reclassify
                self._reset_open()
                pairs = [(row.edition_ref, row.mapping_revision) for row in self.rows]
                states = quote_states(self.store, pairs, deadline=self._deadline())
                rows = [row._replace(state=states[(row.edition_ref, row.mapping_revision)]) for row in self.rows]
                self.rows = rows
                now = qc.wall_ms()
                for row in rows:
                    self.outcomes[row.key] = Outcome(classify(row.state, now))
                if all(self.outcomes[row.key].klass == 'fresh' for row in rows):
                    return None
                generation = None
            plan = self._plan(generation)
            if plan is None:                        # nothing to write; a dead runner may still need its slot reclaimed
                self._reclaim_dead(False)
                return None
            verdict = self._commit(plan, attempt)
            if verdict == 'committed':
                self._after_commit(plan)
                return None
            if verdict == 'unavailable':
                if self._recover_unknown(plan):
                    return None
                return self._refuse_all_open('store_unavailable')
        return self._refuse_all_open('conflict')

    def _reset_open(self):
        for key, outcome in self.outcomes.items():
            outcome.refresh = None
            outcome.awaiting = False
        self.refused.clear()

    def _plan(self, generation):
        now = qc.wall_ms()
        store, caller = self.store, self.caller
        rows = self.rows
        anon = caller.startswith('anon:')
        sched_key, source_key = qc.scheduler_key(), qc.source_backoff_key()
        lease_keys = [qc.runner_lease_key(slot) for slot in qc.RUNNER_SLOTS]
        shard_key = qc.ledger_key(qc.ledger_shard(caller)) if anon else None
        open_rows = [row for row in rows if self.outcomes[row.key].klass != 'fresh']
        base = [sched_key, *lease_keys, source_key] + ([shard_key] if shard_key else [])
        base += [result_key(row.edition_ref, row.mapping_revision) for row in open_rows]
        snap = self._read(base, self._deadline(), generation)
        generation = snap.generation
        rec = snap.records
        for row in open_rows:
            key = result_key(row.edition_ref, row.mapping_revision)
            self._versions[row.key] = rec[key].version

        # Scheduler (never overwrite a stored scheduler that fails the contract).
        stored = rec[sched_key].value
        sched = qc.new_scheduler(now) if stored is None else qc.validate_scheduler(deepcopy(stored))
        leases = []
        for key in lease_keys:
            try:
                leases.append(qc.validate_runner_lease(deepcopy(rec[key].value)))
            except qc.ContractError:
                leases.append('invalid')
        statuses = [qc.slot_status(lease, now) for lease in leases]
        usable = statuses.count('usable')
        free_slots = [slot for slot, status in zip(qc.RUNNER_SLOTS, statuses) if status == 'free']
        reclaimable = [slot for slot, status in zip(qc.RUNNER_SLOTS, statuses) if status == 'reclaimable']
        source_active = False
        if rec[source_key].value is not None:
            try:
                source_active = qc.validate_source_backoff(rec[source_key].value)['retry_ms'] > now
            except qc.ContractError:
                source_active = False

        # Prune expired interactive permits and expired *queued* jobs only; running jobs belong to their runner.
        for rid in [r for r, p in sched['interactive'].items() if p['until_ms'] <= now]:
            del sched['interactive'][rid]
        for job in [j for j, v in sched['jobs'].items() if v['state'] == 'queued' and v['expires_ms'] <= now]:
            self._drop_queued(sched, job)
            sched['stats']['expired'] += 1

        # Joins and candidates.
        joins, candidates = [], []
        for row in open_rows:
            job = qc.job_id(row.edition_ref, row.mapping_revision)
            self.outcomes[row.key].job = job
            (joins if job in sched['jobs'] else candidates).append((row, job))
        candidates.sort(key=lambda item: -1 if _checked_ms(item[0].state) is None else _checked_ms(item[0].state))

        admitted: list[tuple] = []     # (row, job, work_key, versions)
        expected_rows: dict[str, str] = {}
        if source_active:
            for row, _ in candidates:
                self._refuse(row, 'backoff', 'source_backoff')
        else:
            mine = sum(1 for v in sched['jobs'].values() if v['caller'] == caller)
            room = min(qc.MAX_NEW_JOBS_PER_ACCESS, qc.MAX_JOBS_PER_CALLER - mine, qc.MAX_JOBS - len(sched['jobs']))
            scanned = 0
            for start in range(0, len(candidates), CHUNK_ROWS):
                if room <= 0 or start // CHUNK_ROWS >= MAX_CHUNKS:
                    break
                chunk = candidates[start:start + CHUNK_ROWS]
                keys = []
                for row, _ in chunk:
                    keys += [qc.work_record_key(row.edition_ref, row.mapping_revision),
                             qc.edition_backoff_key(row.edition_ref, row.mapping_revision)]
                got = self._read(keys, self._deadline(), generation).records
                scanned += len(chunk)
                entries = []
                for row, job in chunk:
                    work_k = qc.work_record_key(row.edition_ref, row.mapping_revision)
                    back_k = qc.edition_backoff_key(row.edition_ref, row.mapping_revision)
                    retry = 0
                    last = 0
                    if got[back_k].value is not None:
                        try:
                            record = qc.validate_edition_backoff(got[back_k].value)
                            retry, last = record['retry_ms'], record['last_attempt_ms']
                        except qc.ContractError:
                            pass
                    entries.append((max(last, _checked_ms(row.state) or 0), row, job, work_k, back_k, retry, got))
                entries.sort(key=lambda e: e[0])
                for _, row, job, work_k, back_k, retry, got_ in entries:
                    if retry > now:
                        self._refuse(row, 'backoff', 'edition_backoff')
                    elif room <= 0:
                        self._refuse(row, 'busy', 'job_cap')
                    else:
                        admitted.append((row, job, work_k, back_k, got_[work_k].version, got_[back_k].version))
                        room -= 1
            for row, _ in candidates:
                if self.outcomes[row.key].refresh is None and all(row is not a[0] for a in admitted):
                    self._refuse(row, 'busy', 'job_cap')

        # A runner is coming for queued work when the source is clear and a slot is usable, can be reserved in this CAS
        # (a free slot), can be reclaimed after the commit, or is winding down (its supervisor hands the queue on).
        coming = not source_active and (usable > 0 or bool(free_slots) or bool(reclaimable) or 'winding_down' in statuses)

        # Awaiting rows: hard rows that are joined or admitted. A running job is awaited only while its slot's lease is
        # valid, owned by the job's owner and unexpired; one whose lease has run out waits for the reclaim; anything else
        # is uncertain and answers at once.
        dead_rows: dict[int, list] = {}          # slot -> keys of rows joined to a running job whose lease has run out
        queued_rows: list = []                    # keys of rows whose job is queued (joined or admitted now)
        for row, job in joins:
            outcome, entry = self.outcomes[row.key], sched['jobs'][job]
            blocked = None
            if entry['state'] == 'running':
                lease = leases[entry['slot']] if entry['slot'] in qc.RUNNER_SLOTS else 'invalid'
                if not isinstance(lease, dict) or lease['owner'] != entry['owner']:
                    blocked = ('busy', 'runner_uncertain')
                elif lease['lease_until_ms'] <= now:
                    if source_active:
                        blocked = ('backoff', 'source_backoff')
                    else:
                        dead_rows.setdefault(entry['slot'], []).append(row.key)
            elif source_active:
                blocked = ('backoff', 'source_backoff')
            elif not coming:
                blocked = ('busy', 'no_runner')
            else:
                queued_rows.append(row.key)
            if outcome.klass == 'soft':
                if blocked and blocked[1] == 'runner_uncertain':
                    self._refuse(row, *blocked)
                else:
                    outcome.refresh = 'background'
            elif blocked:
                self._refuse(row, *blocked)
            else:
                outcome.awaiting = True
        for item in admitted:
            outcome = self.outcomes[item[0].key]
            if coming:
                queued_rows.append(item[0].key)
            if outcome.klass == 'soft':
                outcome.refresh = 'background'
            elif coming:
                outcome.awaiting = True
            else:
                self._refuse(item[0], 'busy', 'no_runner')      # admitted and queued, but nobody can serve it now
        needs_permit = bool(admitted) or any(o.awaiting for o in self.outcomes.values())

        # Interactive permit and anonymous ledger.
        shard = None
        if needs_permit:
            live = sched['interactive']
            reason = None
            if len(live) >= qc.MAX_INTERACTIVE:
                reason = 'interactive_cap'
            elif sum(1 for p in live.values() if p['caller'] == caller) >= qc.MAX_INTERACTIVE_PER_CALLER:
                reason = 'caller_interactive_cap'
            if reason is None and anon:
                interval = now // qc.FRESH_MS          # one hour
                if sched['ledger']['interval'] != interval:
                    sched['ledger'] = {'interval': interval, 'count': 0}
                shard = qc.validate_ledger_shard(deepcopy(rec[shard_key].value) if rec[shard_key].value is not None
                                                 else qc.new_ledger_shard(), qc.ledger_shard(caller))
                shard['entries'] = {c: e for c, e in shard['entries'].items() if e['expires_ms'] > now}
                if caller not in shard['entries']:
                    if sched['ledger']['count'] >= qc.LEDGER_CAP:
                        reason = 'ledger_full'
                    else:
                        shard['entries'][caller] = {'expires_ms': (interval + 1) * qc.FRESH_MS}
                        sched['ledger']['count'] += 1
            if reason:
                taken = [a[0] for a in admitted]
                for row in open_rows:
                    outcome = self.outcomes[row.key]
                    if outcome.awaiting or (any(row is t for t in taken) and outcome.refresh in (None, 'background')):
                        self._refuse(row, 'busy', reason)
                admitted, needs_permit, shard = [], False, None
            else:
                sched['interactive'][self.request_id] = {
                    'caller': caller, 'until_ms': now + int(self.budget.remaining() * 1000) + 500}

        # New jobs.
        work_changes = {}
        for row, job, work_k, back_k, work_v, back_v in admitted:
            try:
                work = qc.new_work(row.edition_ref, row.mapping_revision, row.lookup['card'], row.lookup['variant'],
                                   str(row.product_id), caller, now)
                qc.validate_work(work)
            except (qc.ContractError, KeyError, TypeError):
                self._refuse(row, 'busy', 'invalid_work')
                continue
            sched['jobs'][job] = qc.new_job(caller, row.lookup['card'], now)
            sched['fifo'].setdefault(caller, []).append(job)
            if caller not in sched['ring']:
                sched['ring'].append(caller)
            work_changes[work_k] = work
            expected_rows[work_k] = work_v
            expected_rows[back_k] = back_v
            expected_rows[result_key(row.edition_ref, row.mapping_revision)] = self._versions[row.key]
            self.outcomes[row.key].job = job
        sched['stats']['admitted'] += len(work_changes)
        sched['stats']['joined'] += len(joins)

        # Runner slots.
        reservations = {}
        queued = [j for j, v in sched['jobs'].items() if v['state'] == 'queued']
        if queued and not source_active:
            target = qc.runner_target(len(queued))
            self._usable_before = usable
            for slot in free_slots:
                if usable + len(reservations) >= target:
                    break
                owner = secrets.token_hex(16)
                reservations[slot] = qc.validate_runner_lease(qc.new_runner_lease(owner, _host(), now, os.getpid()))
                reservations[slot]['_owner'] = owner
        else:
            self._usable_before = 0
        owners = {slot: lease.pop('_owner') for slot, lease in reservations.items()}
        self._slot_info = {'reclaimable': reclaimable, 'usable': usable, 'queued': len(queued), 'dead_rows': dead_rows,
                           'queued_rows': queued_rows, 'source_active': source_active}

        writing = bool(work_changes) or bool(reservations) or any(o.awaiting for o in self.outcomes.values())
        if not writing:
            return None
        refused = sched['stats']['refused']
        for reason, count in self.refused.items():
            if reason in refused or len(refused) < 32:
                refused[reason] = refused.get(reason, 0) + count
        qc.validate_scheduler(sched)
        expected = {sched_key: rec[sched_key].version, source_key: rec[source_key].version}
        for key in lease_keys:
            expected[key] = rec[key].version
        changes = {sched_key: sched, **work_changes}
        if shard is not None:
            expected[shard_key] = rec[shard_key].version
            changes[shard_key] = shard
        for slot, lease in reservations.items():
            changes[lease_keys[slot]] = lease
        expected.update(expected_rows)
        return {'expected': expected, 'changes': changes, 'owners': owners, 'queued_jobs': len(queued)}

    @staticmethod
    def _drop_queued(sched, job):
        caller = sched['jobs'].pop(job)['caller']
        entries = sched['fifo'].get(caller, [])
        if job in entries:
            entries.remove(job)
        if not entries:
            sched['fifo'].pop(caller, None)
            if caller in sched['ring']:
                index = sched['ring'].index(caller)
                sched['ring'].remove(caller)
                if index < sched['cursor']:
                    sched['cursor'] -= 1
        if sched['ring'] and sched['cursor'] >= len(sched['ring']):
            sched['cursor'] = 0
        if not sched['ring']:
            sched['cursor'] = 0

    def _commit(self, plan, attempt):
        operation = f'admit-{self.request_id}-{attempt}'
        deadline = self._deadline()
        try:
            ok = self.store.compare_and_swap(plan['expected'], plan['changes'], deadline=deadline, operation_id=operation)
        except OperationConflict:
            return 'conflict'
        except ProjectionUnavailable:
            try:
                ok = self.store.operation_status(operation, deadline=self.budget.wait_until) is True
            except ProjectionUnavailable:
                return 'unavailable'
            if not ok:
                return 'unavailable'
        return 'committed' if ok else 'conflict'

    def _after_commit(self, plan):
        self.committed = True
        self.permit_held = self.request_id in plan['changes'][qc.scheduler_key()]['interactive']
        launched = sum(1 for slot, owner in plan['owners'].items() if self._spawn_into(slot, owner))
        self._reclaim_dead(launched, reserved=bool(plan['owners']))

    def _spawn_into(self, slot, owner) -> bool:
        try:
            started = price_launcher.spawn(slot, owner) is True
        except Exception:  # noqa: BLE001 - a launcher never fails admission
            started = False
        self.reservations.append((slot, owner, started))
        if not started:
            self._free_slot(slot, owner)
        return started

    def _give_up(self, reason, keys):
        """No runner is coming for these rows: those that were waiting (or promised a background refresh) answer ``busy``
        now. Each reason is counted once per access in ``stats.refused``, by the post-response ``release()`` CAS, never by a
        new request-path write."""
        touched = False
        for key in keys:
            outcome = self.outcomes[key]
            if outcome.klass == 'fresh' or outcome.refresh in ('busy', 'backoff'):
                continue
            if outcome.awaiting or outcome.refresh == 'background':
                outcome.awaiting = False
                outcome.refresh = 'busy'
                outcome.reason = reason
                touched = True
        if touched:
            self._late.setdefault(reason, 1)

    def _reclaim_dead(self, launched, reserved=False):
        """Settle the runner slots after the admission CAS (or instead of it). Each slot whose lease has run out and that
        holds a joined job, or that the queue needs because nothing is usable, gets one bounded reclaim. Rows are settled
        per slot: an ``uncertain`` slot gives up only the rows joined to it; a slot reclaimed or freed elsewhere turns its
        rows into queued work. Queued work gives up only when something was attempted and no runner is usable or coming.
        Spawns respect ``runner_target``: a second runner only for more than four pending jobs."""
        info = self._slot_info
        if not info:
            return
        dead_rows = info['dead_rows']
        queued_rows = list(info['queued_rows'])
        pending = info['queued'] + sum(len(keys) for keys in dead_rows.values())
        target = qc.runner_target(pending)
        runners = info['usable'] + launched
        attempted = reserved
        launch_failed = reserved and launched == 0
        uncertain_keys: list = []
        deadline = min(self.budget.wait_until, time.monotonic() + RECLAIM_SECONDS)
        needs_queue = info['queued'] > 0 and info['usable'] == 0 and launched == 0
        for slot in info['reclaimable']:
            if slot not in dead_rows and not (needs_queue and runners < target):
                continue
            attempted = True
            owner = secrets.token_hex(16)
            replace = owner if not info['source_active'] and runners < target else None
            try:
                outcome = price_launcher.reclaim_slot(self.store, slot, deadline=deadline, attempts=1, replace_with=replace)
            except Exception:  # noqa: BLE001 - a reclaim never fails admission
                outcome = 'uncertain'
            if outcome == 'uncertain' and replace is not None and self._lease_owner(slot) == owner:
                outcome = 'reclaimed'            # the cleanup CAS landed; only its answer was lost
            keys = dead_rows.get(slot, [])
            if outcome == 'reclaimed':
                if replace is not None and self._spawn_into(slot, owner):
                    runners += 1
                elif replace is not None:
                    launch_failed = True
                queued_rows += keys              # requeued: served by whichever runner is coming
            elif outcome == 'uncertain':
                uncertain_keys += keys
            elif self._lease_owner(slot) is None:   # freed by someone else without a runner (failed spawn, release)
                queued_rows += keys
        if uncertain_keys:
            self._give_up('runner_uncertain', uncertain_keys)
        if attempted and runners == 0:
            self._give_up('launch_failed' if launch_failed else 'no_runner', queued_rows)

    def _lease_owner(self, slot):
        """One bounded read of a slot lease: its owner, ``None`` when the slot is free, ``''`` when unreadable or held by
        an unreadable lease."""
        key = qc.runner_lease_key(slot)
        try:
            value = self.store.read_records([key], deadline=min(self.budget.wait_until, time.monotonic() + 0.3)).records[key].value
        except _STORE_ERRORS:
            return ''
        if value is None or qc.slot_status(value, qc.wall_ms()) == 'free':
            return None
        return value.get('owner', '') if isinstance(value, dict) else ''

    def _recover_unknown(self, plan) -> bool:
        """The admission CAS answered neither yes nor no. A reservation inside it is all-or-nothing with the rest, so one
        bounded re-read of that lease tells whether it landed; if so the runner is spawned and the permit is ours to release."""
        if not plan['owners']:
            return False
        slot, owner = next(iter(plan['owners'].items()))
        key = qc.runner_lease_key(slot)
        try:
            value = self.store.read_records([key], deadline=min(self.budget.wait_until, time.monotonic() + 0.5)).records[key].value
        except _STORE_ERRORS:
            return False
        if not isinstance(value, dict) or value.get('owner') != owner:
            return False
        self._after_commit(plan)
        return True

    def _free_slot(self, slot, owner):
        key = qc.runner_lease_key(slot)
        deadline = min(self.budget.wait_until, time.monotonic() + 0.5)
        try:
            record = self.store.read_records([key], deadline=deadline).records[key]
            value = record.value
            if isinstance(value, dict) and value.get('owner') == owner and value.get('state') == 'reserved':
                self.store.compare_and_swap({key: record.version}, {key: None}, deadline=deadline,
                                            operation_id=f'free-{owner}')
        except _STORE_ERRORS + (OperationConflict,):
            pass  # best effort; the reservation expires on its own

    # ---- hard wait -----------------------------------------------------------------------------------------
    def wait(self, budget=None) -> set:
        """Poll until every awaited hard row resolves or ``wait_until`` passes. Returns the row keys whose ``result:``
        changed. Sets the final ``refresh`` label of each awaited row. Never waits past ``wait_until``."""
        budget = budget or self.budget
        awaiting = {row.key: row for row in self.rows if self.outcomes[row.key].awaiting}
        changed: set = set()
        if not awaiting:
            return changed
        sched_key = qc.scheduler_key()
        result_keys = {k: result_key(r.edition_ref, r.mapping_revision) for k, r in awaiting.items()}
        resolved: dict = {}
        stop_at = budget.wait_until          # polling stops here; once a row resolved, FOLLOW_UP_SECONDS earlier
        try:
            while True:
                snap = self.store.read_all([sched_key, *result_keys.values()], deadline=stop_at)
                jobs = (snap.records[sched_key].value or {}).get('jobs', {}) if isinstance(snap.records[sched_key].value, dict) else {}
                for key, row in awaiting.items():
                    if key in resolved:
                        continue
                    if snap.records[result_keys[key]].version != self._versions.get(key):
                        resolved[key] = True
                        changed.add(key)
                    elif self.outcomes[key].job not in jobs:
                        resolved[key] = False
                if resolved:                     # follow-up reads (failure stamps, changed rows) must fit before wait_until
                    stop_at = min(stop_at, budget.wait_until - FOLLOW_UP_SECONDS)
                if len(resolved) == len(awaiting) or stop_at - time.monotonic() <= POLL_SECONDS / 2:
                    break
                time.sleep(min(POLL_SECONDS, stop_at - time.monotonic()))
        except _STORE_ERRORS:
            pass
        failed = [k for k, moved in resolved.items() if not moved]
        stamps = {}
        if failed and budget.wait_remaining() > 0:
            try:
                keys = {k: qc.edition_backoff_key(awaiting[k].edition_ref, awaiting[k].mapping_revision) for k in failed}
                got = self.store.read_all(list(keys.values()), deadline=budget.wait_until).records
                for k, key in keys.items():
                    try:
                        stamps[k] = qc.validate_edition_backoff(deepcopy(got[key].value))['last_attempt_ms']
                    except qc.ContractError:
                        pass
            except _STORE_ERRORS:
                pass
        for key in awaiting:
            outcome = self.outcomes[key]
            outcome.awaiting = False
            if key not in resolved:
                outcome.refresh = 'timeout'
            elif resolved[key]:
                outcome.refresh = 'refreshed'
            else:
                outcome.refresh, outcome.failed_at_ms = 'failed', stamps.get(key)
        return changed

    # ---- release -------------------------------------------------------------------------------------------
    def release(self):
        """Best-effort release of the interactive permit with its own 1 s deadline; the TTL reclaims it otherwise. The same
        post-response CAS adds the refusals decided after the admission commit (``_late``) to ``stats.refused``."""
        if self._released or not (self.permit_held or self._late):
            return
        self._released = True
        deadline = time.monotonic() + RELEASE_SECONDS
        key = qc.scheduler_key()
        for attempt in range(3):
            try:
                record = self.store.read_records([key], deadline=deadline).records[key]
                if not isinstance(record.value, dict):
                    return
                sched = deepcopy(record.value)
                changed = sched['interactive'].pop(self.request_id, None) is not None
                refused = sched['stats']['refused']
                for reason, count in self._late.items():
                    if reason in refused or len(refused) < 32:
                        refused[reason] = refused.get(reason, 0) + count
                        changed = True
                if not changed:
                    return
                qc.validate_scheduler(sched)
                if self.store.compare_and_swap({key: record.version}, {key: sched}, deadline=deadline,
                                               operation_id=f'release-{self.request_id}-{attempt}'):
                    return
            except _STORE_ERRORS + (OperationConflict,):
                return


def evaluate_and_admit(rows, caller: str, budget, store=None) -> Admission:
    """Classify ``rows`` (``Row`` tuples whose ``state`` was read by ``quote_states``), admit new refresh jobs and return
    the ``Admission``: per-row ``outcomes`` (class and label), ``wait()`` for the hard rows and ``release()`` for the
    interactive permit. Never raises for a store problem; affected rows are labelled ``busy``."""
    return Admission(rows, caller, budget, store).run()
