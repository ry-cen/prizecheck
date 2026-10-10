"""Admission for price refresh (ticket 07), PostgreSQL-free: classification, caps, joins, backoff, ledger, slot reservation,
hard wait and permit release against both record-store adapters (filesystem and the HTTP relay), with the real monotonic
clock and deterministic interleavings (barriers, relay delay fault)."""
from copy import deepcopy
import fcntl
import json
import multiprocessing
import os
from types import SimpleNamespace
import subprocess
import sys
import threading
import time

import pytest

from app import price_launcher, price_refresh, quote_contract as qc
from app.price_budget import Budget
from app.price_refresh import Row, classify, evaluate_and_admit
from app.public_projection import ProjectionUnavailable
from app.public_records import FilePublicRecords, HttpPublicRecords, QuoteState, quote_key, quote_states, result_key
from public_records_fixture import fault, serve_relay

MIN, HOUR = 60_000, 3_600_000


def deadline(seconds=5):
    return time.monotonic() + seconds


def ref(i):
    return f'{i:048x}'


def state(status, checked_ms=None, **result):
    value = None if status in ('unknown', 'invalid') else {'state': status, 'attempt': 1, **result}
    if checked_ms is not None and value is not None:
        value['checked_at'] = qc.iso_from_ms(checked_ms)
    return QuoteState(status, value, None, 'g')


# ------------------------------------------------------------------ classification (pure)
@pytest.mark.parametrize('age_ms,expected', [
    (0, 'fresh'), (59 * MIN, 'fresh'), (HOUR - 1, 'fresh'), (HOUR, 'soft'), (61 * MIN, 'soft'),
    (24 * HOUR - 60_000, 'soft'), (24 * HOUR - 1, 'soft'), (24 * HOUR, 'hard'), (24 * HOUR + MIN, 'hard'),
    (-4 * MIN, 'fresh'), (-6 * MIN, 'hard')])
def test_quote_bands_have_exact_boundaries(age_ms, expected):
    now = 10_000_000_000_000
    assert classify(state('quote', now - age_ms), now) == expected


def test_missing_garbled_naive_unknown_invalid_and_pending_are_hard():
    now = 10_000_000_000_000
    assert classify(state('quote'), now) == 'hard'
    for bad in ('garbage', '2026-10-09T10:00:00', 17, None, ''):
        assert classify(QuoteState('quote', {'state': 'quote', 'checked_at': bad}, {}, 'g'), now) == 'hard'
    for status in ('unknown', 'invalid', 'pending'):
        assert classify(state(status, now), now) == 'hard'


def test_absent_follows_the_same_bands_by_checked_at():
    now = 10_000_000_000_000
    fresh = state('absent', now - 30 * MIN, expires_at=qc.iso_from_ms(now + 30 * MIN))
    assert classify(fresh, now) == 'fresh'
    assert classify(state('absent', now - 61 * MIN, expires_at=qc.iso_from_ms(now - MIN)), now) == 'soft'
    assert classify(state('absent', now - 25 * HOUR, expires_at=qc.iso_from_ms(now)), now) == 'hard'
    assert classify(state('absent', now - 30 * MIN, expires_at=qc.iso_from_ms(now - 1)), now) == 'soft'


def test_the_module_is_postgresql_free():
    code = ("import sys, json; import app.price_refresh; "
            "print(json.dumps([m for m in ('psycopg', 'app.main', 'app.prices') if m in sys.modules]))")
    out = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, check=True)
    assert json.loads(out.stdout) == []


# ------------------------------------------------------------------ store harness
class Env:
    def __init__(self, store, config, directory):
        self.store, self.config, self.directory = store, config, directory
        self.spawns = []

    def new_store(self):
        if self.config['adapter'] == 'http':
            return HttpPublicRecords(self.url, 'conformance-secret')
        return FilePublicRecords(self.directory)

    def seed(self, i, age_ms=None, *, status='quote', rev=1, **result):
        """Write what a runner writes for edition ``i``. age_ms None leaves the Edition unknown."""
        if age_ms is None:
            return
        keys = [result_key(ref(i), rev), quote_key(ref(i), rev)]
        snap = self.store.read_records(keys, deadline=deadline())
        now = qc.wall_ms()
        changes = {keys[0]: {'state': status, 'attempt': 1, 'checked_at': qc.iso_from_ms(now - age_ms), **result}}
        if status == 'quote':
            changes[keys[1]] = {'attempt': 1, 'amount': '1.00', 'currency': 'USD', 'source': 'tcgdex', 'card': f'c-{i}',
                                'variant': 'normal', 'provider_updated_at': None}
        assert self.store.compare_and_swap({k: snap.records[k].version for k in changes}, changes, deadline=deadline())

    def rows(self, indexes, store=None):
        store = store or self.store
        pairs = [(ref(i), 1) for i in indexes]
        states = quote_states(store, pairs, deadline=deadline())
        return [Row(i, ref(i), 1, {'card': f'c-{i}', 'variant': 'normal'}, 77, states[(ref(i), 1)]) for i in indexes]

    def budget(self, caller='user:a', seconds=3.0):
        return Budget(hard=time.monotonic() + seconds, caller=caller)

    def admit(self, indexes, caller='user:a', seconds=3.0, store=None):
        store = store or self.store
        return evaluate_and_admit(self.rows(indexes, store), caller, self.budget(caller, seconds), store)

    def value(self, key):
        return self.store.read_records([key], deadline=deadline()).records[key].value

    def scheduler(self):
        value = self.value(qc.scheduler_key())
        return qc.validate_scheduler(value) if value is not None else None

    def generation(self):
        return self.store.read_records([qc.scheduler_key()], deadline=deadline()).generation

    def put(self, key, value):
        version = self.store.read_records([key], deadline=deadline()).records[key].version
        assert self.store.compare_and_swap({key: version}, {key: value}, deadline=deadline())

    def seed_jobs(self, counts, *, now=None, queued=True):
        now = qc.wall_ms() if now is None else now
        sched = qc.new_scheduler(now)
        n = 5000
        for caller, count in counts.items():
            for _ in range(count):
                n += 1
                job = f'{ref(n)}:1'
                sched['jobs'][job] = qc.new_job(caller, f'x-{n}', now)
                sched['fifo'].setdefault(caller, []).append(job)
            sched['ring'].append(caller)
        self.put(qc.scheduler_key(), qc.validate_scheduler(sched))
        return sched


@pytest.fixture(autouse=True)
def lock_directory(tmp_path, monkeypatch):
    directory = tmp_path / 'locks'
    monkeypatch.setenv('PRICE_RUNNER_LOCK_DIR', str(directory))
    return directory


@pytest.fixture(params=['file', 'http'])
def env(request, tmp_path, monkeypatch):
    config = {'adapter': 'filesystem' if request.param == 'file' else 'http', 'directory': str(tmp_path)}
    process = None
    store = FilePublicRecords(tmp_path)
    store.initialize(deadline=deadline())
    if request.param == 'http':
        context = multiprocessing.get_context('spawn')
        receive, send = context.Pipe(duplex=False)
        process = context.Process(target=serve_relay, args=({'adapter': 'filesystem', 'directory': str(tmp_path)}, send))
        process.start()
        assert receive.poll(15)
        url = f'http://127.0.0.1:{receive.recv()}/manifest'
        store = HttpPublicRecords(url, 'conformance-secret')
    holder = Env(store, config, str(tmp_path))
    if process:
        holder.url = url
        holder.relay_config = {'adapter': 'http', 'directory': str(tmp_path)}
    else:
        holder.relay_config = None

    def spawn(slot, owner):
        holder.spawns.append((slot, owner))
        return True
    monkeypatch.setattr(price_launcher, 'spawn', spawn)
    yield holder
    if process:
        process.terminate()
        process.join(5)


def labels(admission):
    return {key: o.refresh for key, o in admission.outcomes.items()}


# ------------------------------------------------------------------ AC1 / AC2 reads
def test_fresh_rows_touch_nothing():
    class Forbidden:
        def __getattr__(self, name):
            raise AssertionError('a fresh read must not touch the store')
    now = qc.wall_ms()
    rows = [Row(1, ref(1), 1, {'card': 'c', 'variant': 'normal'}, 1, state('quote', now - 59 * MIN))]
    admission = evaluate_and_admit(rows, 'user:a', Budget(hard=time.monotonic() + 3, caller='user:a'), Forbidden())
    assert labels(admission) == {1: None} and admission.wait() == set()


def test_under_one_hour_writes_nothing(env):
    env.seed(1, 59 * MIN)
    env.seed(2, 5 * MIN, status='absent', expires_at=qc.iso_from_ms(qc.wall_ms() + 55 * MIN))
    generation = env.generation()
    admission = env.admit([1, 2])
    assert labels(admission) == {1: None, 2: None} and env.spawns == [] and env.generation() == generation


def test_a_soft_row_returns_background_and_queues_one_job_and_one_runner(env):
    env.seed(1, 61 * MIN)
    admission = env.admit([1])
    assert labels(admission) == {1: 'background'}
    sched = env.scheduler()
    job = f'{ref(1)}:1'
    assert list(sched['jobs']) == [job] and sched['jobs'][job]['state'] == 'queued' and sched['fifo'] == {'user:a': [job]}
    assert sched['jobs'][job]['expires_ms'] == sched['jobs'][job]['admitted_ms'] + 60_000
    work = qc.validate_work(env.value(qc.work_record_key(ref(1), 1)))
    assert (work['card'], work['variant'], work['product_id'], work['caller']) == ('c-1', 'normal', '77', 'user:a')
    assert len(env.spawns) == 1 and len(sched['interactive']) == 1
    slot, owner = env.spawns[0]
    lease = qc.validate_runner_lease(env.value(qc.runner_lease_key(slot)))
    assert lease['owner'] == owner and lease['state'] == 'reserved'
    admission.release()
    assert env.scheduler()['interactive'] == {}


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_failed_launch_frees_the_slot_keeps_the_jobs_and_answers_at_once(env, monkeypatch):
    monkeypatch.setattr(price_launcher, 'spawn', lambda slot, owner: False)
    started = time.monotonic()
    admission = env.admit([1])        # unknown: hard
    assert time.monotonic() - started < 1.0
    assert labels(admission) == {1: 'busy'} and admission.outcomes[1].reason == 'launch_failed'
    assert env.value(qc.runner_lease_key(0)) is None and env.value(qc.runner_lease_key(1)) is None
    assert list(env.scheduler()['jobs']) == [f'{ref(1)}:1']
    again = env.admit([1])            # the next access re-reserves and re-launches
    assert labels(again) == {1: 'busy'} and list(env.scheduler()['jobs']) == [f'{ref(1)}:1']


@pytest.mark.parametrize('age,klass', [(23 * HOUR + 59 * MIN, 'soft'), (24 * HOUR + MIN, 'hard'), (None, 'hard')])
def test_the_day_boundary_decides_whether_a_row_waits(env, age, klass):
    env.seed(1, age)
    admission = env.admit([1])
    assert admission.outcomes[1].klass == klass and admission.outcomes[1].awaiting == (klass == 'hard')


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_hard_row_that_a_runner_writes_mid_wait_is_refreshed(env):
    env.seed(1, 25 * HOUR)
    admission = env.admit([1], seconds=3.0)

    def runner():
        time.sleep(0.4)
        env.seed(1, 0)
    thread = threading.Thread(target=runner)
    thread.start()
    started = time.monotonic()
    changed = admission.wait()
    thread.join()
    assert changed == {1} and labels(admission) == {1: 'refreshed'} and time.monotonic() - started < 1.5


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_hard_row_that_nobody_refreshes_times_out_at_wait_until_and_keeps_the_cache(env):
    env.seed(1, 25 * HOUR)
    before = env.value(result_key(ref(1), 1))
    admission = env.admit([1], seconds=1.2)    # wait_until = 0.7 s after receipt
    started = time.monotonic()
    admission.wait()
    elapsed = time.monotonic() - started
    assert labels(admission) == {1: 'timeout'} and 0.3 < elapsed < 0.75
    assert env.value(result_key(ref(1), 1)) == before


def test_a_job_that_leaves_the_queue_without_a_result_is_failed_with_its_backoff_time(env):
    env.seed(1, 25 * HOUR)
    admission = env.admit([1])
    stamp = qc.wall_ms()
    sched = env.scheduler()
    job = f'{ref(1)}:1'
    del sched['jobs'][job], sched['fifo']['user:a']
    sched['ring'].remove('user:a')
    env.put(qc.scheduler_key(), qc.validate_scheduler(sched))
    env.put(qc.edition_backoff_key(ref(1), 1), qc.new_edition_backoff(1, stamp, stamp + 60_000, 'timeout'))
    admission.wait()
    assert labels(admission) == {1: 'failed'} and admission.outcomes[1].failed_at_ms == stamp


# ------------------------------------------------------------------ joins, coalescing, expiry (AC6, AC7)
def test_a_join_changes_nothing_and_never_extends_a_job(env):
    env.seed(1, 61 * MIN)
    env.admit([1]).release()
    first = env.value(qc.scheduler_key())['jobs']
    generation = env.generation()
    again = env.admit([1])
    assert labels(again) == {1: 'background'} and env.generation() == generation   # soft join: no write, no new runner
    assert env.value(qc.scheduler_key())['jobs'] == first and len(env.spawns) == 1


def test_a_hard_join_waits_without_requeueing(env):
    env.seed(1, 25 * HOUR)
    env.admit([1]).release()
    job = deepcopy(env.scheduler()['jobs'])
    second = env.admit([1], caller='user:b')
    assert second.outcomes[1].awaiting and env.scheduler()['jobs'] == job
    assert env.scheduler()['fifo'] == {'user:a': [f'{ref(1)}:1']}
    second.release()


def test_an_expired_queued_job_is_readmitted_with_a_new_lifetime(env):
    env.seed(1, 61 * MIN)
    now = qc.wall_ms()
    sched = qc.new_scheduler(now)
    job = f'{ref(1)}:1'
    sched['jobs'][job] = qc.new_job('user:old', 'c-1', now - 61_000)
    sched['fifo']['user:old'] = [job]
    sched['ring'] = ['user:old']
    env.put(qc.scheduler_key(), qc.validate_scheduler(sched))
    env.admit([1])
    after = env.scheduler()
    assert after['jobs'][job]['caller'] == 'user:a' and after['jobs'][job]['admitted_ms'] >= now
    assert 'user:old' not in after['fifo'] and after['ring'] == ['user:a'] and after['stats']['expired'] == 1


# ------------------------------------------------------------------ caps (AC3, AC4)
def test_two_interactive_permits_per_caller_and_the_rest_are_busy(env):
    for i in range(1, 5):
        env.seed(i, 25 * HOUR)
    results = [env.admit([i]) for i in range(1, 5)]
    assert [labels(r)[i] for i, r in zip(range(1, 5), results)] == [None, None, 'busy', 'busy']
    assert [r.outcomes[i].awaiting for i, r in zip(range(1, 5), results)] == [True, True, False, False]
    assert len(env.scheduler()['interactive']) == 2 and len(env.scheduler()['jobs']) == 2
    results[0].release()
    assert len(env.scheduler()['interactive']) == 1


def test_the_global_interactive_cap_is_32(env):
    now = qc.wall_ms()
    sched = qc.new_scheduler(now)
    for n in range(31):
        sched['interactive'][f'r{n}'] = {'caller': f'user:f{n // 2}', 'until_ms': now + 10_000}
    env.put(qc.scheduler_key(), qc.validate_scheduler(sched))
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    first, second = env.admit([1], caller='user:x'), env.admit([2], caller='user:y')
    assert [labels(first)[1], labels(second)[2]] == [None, 'busy']
    assert second.outcomes[2].reason == 'interactive_cap'


def test_expired_interactive_permits_do_not_count(env):
    now = qc.wall_ms()
    sched = qc.new_scheduler(now)
    sched['interactive'] = {'a': {'caller': 'user:a', 'until_ms': now - 1}, 'b': {'caller': 'user:a', 'until_ms': now - 5}}
    env.put(qc.scheduler_key(), qc.validate_scheduler(sched))
    env.seed(1, 25 * HOUR)
    assert env.admit([1]).outcomes[1].awaiting


def test_the_global_outstanding_job_cap_admits_one_of_two(env):
    env.seed_jobs({f'user:f{n}': 32 for n in range(7)} | {'user:f7': 31})    # 255 jobs
    for i in (1, 2):
        env.seed(i, 61 * MIN)
    admission = env.admit([1, 2])
    assert sorted(labels(admission).values()) == ['background', 'busy'] and len(env.scheduler()['jobs']) == 256


def test_sixty_four_hard_rows_admit_the_32_least_recent_and_a_follow_up_admits_none(env):
    # Rows 1..64: row i is (i + 25) hours old, so the oldest rows are the highest numbers.
    for i in range(1, 65):
        env.seed(i, (i + 25) * HOUR)
    admission = env.admit(list(range(1, 65)))
    admitted = {i for i in range(1, 65) if f'{ref(i)}:1' in env.scheduler()['jobs']}
    assert admitted == set(range(33, 65)) and len(env.scheduler()['jobs']) == 32
    assert {i for i, o in admission.outcomes.items() if o.refresh == 'busy'} == set(range(1, 33))
    admission.release()
    again = env.admit(list(range(1, 65)))
    assert len(env.scheduler()['jobs']) == 32 and {i for i, o in again.outcomes.items() if o.refresh == 'busy'} == set(range(1, 33))


@pytest.mark.slow(reason='capacity: 100 rows over four admissions')
def test_one_hundred_rows_progress_over_four_accesses(env):
    for i in range(1, 101):
        env.seed(i, (i + 25) * HOUR)
    seen = set()
    for _ in range(4):
        admission = env.admit(list(range(1, 101)))
        admission.release()
        sched = env.scheduler()
        seen |= set(sched['jobs'])
        for job in list(sched['jobs']):          # a runner finishes everything queued
            del sched['jobs'][job]
        sched['fifo'], sched['ring'], sched['cursor'] = {}, [], 0
        env.put(qc.scheduler_key(), qc.validate_scheduler(sched))
        for job in seen:
            env.seed(int(job.split(':')[0], 16), 0)
    assert len(seen) == 100


def test_duplicates_are_not_counted_twice(env):
    env.seed(1, 61 * MIN)
    env.admit([1]).release()
    env.admit([1], caller='user:b').release()
    assert len(env.scheduler()['jobs']) == 1 and env.scheduler()['stats']['admitted'] == 1


# ------------------------------------------------------------------ AC5 ledger
ANON = 'anon:' + '0f' * 16


def test_the_anonymous_ledger_caps_new_digests_and_keeps_existing_ones(env):
    now = qc.wall_ms()
    interval = now // HOUR
    sched = qc.new_scheduler(now)
    sched['ledger'] = {'interval': interval, 'count': qc.LEDGER_CAP}
    env.put(qc.scheduler_key(), qc.validate_scheduler(sched))
    existing = 'anon:' + '0f' * 16
    shard = qc.ledger_shard(existing)
    env.put(qc.ledger_key(shard), {'v': 1, 'entries': {existing: {'expires_ms': (interval + 1) * HOUR}}})
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    stranger = 'anon:' + '0f' * 15 + '0e'
    assert qc.ledger_shard(stranger) == shard
    refused = env.admit([1], caller=stranger)
    assert labels(refused) == {1: 'busy'} and refused.outcomes[1].reason == 'ledger_full'
    ok = env.admit([2], caller=existing)
    assert ok.outcomes[2].awaiting and env.scheduler()['ledger']['count'] == qc.LEDGER_CAP


def test_a_new_digest_is_counted_once_and_expired_entries_are_pruned(env):
    now = qc.wall_ms()
    interval = now // HOUR
    shard = qc.ledger_shard(ANON)
    stale = 'anon:' + '0f' + 'ab' * 15
    env.put(qc.ledger_key(shard), {'v': 1, 'entries': {stale: {'expires_ms': now - 1}}})
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    env.admit([1], caller=ANON).release()
    env.admit([2], caller=ANON).release()
    entries = env.value(qc.ledger_key(shard))['entries']
    assert entries == {ANON: {'expires_ms': (interval + 1) * HOUR}}
    assert env.scheduler()['ledger'] == {'interval': interval, 'count': 1}


# ------------------------------------------------------------------ AC8 backoff
@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_future_edition_backoff_blocks_admission_and_writes_nothing(env):
    env.seed(1, 25 * HOUR)
    now = qc.wall_ms()
    env.put(qc.edition_backoff_key(ref(1), 1), qc.new_edition_backoff(1, now, now + 60_000, 'timeout'))
    generation = env.generation()
    started = time.monotonic()
    admission = env.admit([1])
    admission.wait()
    assert labels(admission) == {1: 'backoff'} and time.monotonic() - started < 0.3
    assert env.generation() == generation and env.spawns == []


def test_a_past_edition_backoff_is_admitted(env):
    env.seed(1, 25 * HOUR)
    now = qc.wall_ms()
    env.put(qc.edition_backoff_key(ref(1), 1), qc.new_edition_backoff(1, now - 120_000, now - 1, 'timeout'))
    assert env.admit([1]).outcomes[1].awaiting


def test_source_backoff_blocks_every_admission_without_writing(env):
    env.seed(1, 25 * HOUR)
    env.seed(2, 61 * MIN)
    now = qc.wall_ms()
    env.put(qc.source_backoff_key(), qc.new_source_backoff('rate_limited', now + 30_000, now))
    generation = env.generation()
    admission = env.admit([1, 2])
    assert labels(admission) == {1: 'backoff', 2: 'backoff'} and env.generation() == generation and env.spawns == []


def test_every_input_row_gets_a_label_or_is_fresh(env):
    env.seed(1, 61 * MIN)
    env.seed(2, 5 * MIN)
    admission = env.admit([1, 2, 3])
    assert set(admission.outcomes) == {1, 2, 3} and admission.outcomes[2].klass == 'fresh'
    assert admission.outcomes[1].refresh == 'background' and admission.outcomes[3].awaiting


# ------------------------------------------------------------------ slots
def test_a_fresh_reservation_means_a_runner_is_coming_and_a_deep_queue_reserves_the_second_slot(env):
    for i in range(1, 8):
        env.seed(i, 61 * MIN)
    env.admit([1]).release()
    env.admit([2], caller='user:b').release()
    assert len(env.spawns) == 1
    env.admit([3, 4, 5, 6, 7], caller='user:c').release()
    assert sorted(slot for slot, _ in env.spawns) == [0, 1]


def test_a_stale_unclaimed_reservation_is_replaced_and_a_running_slot_is_left_alone(env):
    env.seed(1, 61 * MIN)
    old = qc.new_runner_lease('a' * 32, 'h', qc.wall_ms() - 6_000, 1)
    env.put(qc.runner_lease_key(0), old)
    running = qc.new_runner_lease('b' * 32, 'h', qc.wall_ms() - 20_000, 1)
    running.update(state='running', claimed_ms=qc.wall_ms() - 20_000, supervisor_pid=2, worker_pid=3,
                   lease_until_ms=qc.wall_ms() - 1, hard_stop_ms=qc.wall_ms() + 40_000)
    env.put(qc.runner_lease_key(1), running)
    env.admit([1]).release()
    assert env.spawns[0][0] == 0 and env.value(qc.runner_lease_key(0))['owner'] == env.spawns[0][1]
    assert env.value(qc.runner_lease_key(1)) == running


# ------------------------------------------------------------------ release
def test_release_removes_only_this_permit_and_is_idempotent(env):
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    a, b = env.admit([1]), env.admit([2], caller='user:b')
    assert len(env.scheduler()['interactive']) == 2
    until = env.scheduler()['interactive'][a.request_id]['until_ms']
    assert qc.wall_ms() < until <= qc.wall_ms() + 3_600
    a.release()
    a.release()
    assert list(env.scheduler()['interactive']) == [b.request_id]


# ------------------------------------------------------------------ concurrency
def test_two_independent_stores_admit_concurrently_without_losing_either_job(env):
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    barrier = threading.Barrier(2)
    out = {}

    def go(i, caller):
        store = env.new_store()
        rows = env.rows([i], store)
        barrier.wait(5)
        out[i] = evaluate_and_admit(rows, caller, env.budget(caller), store)
    threads = [threading.Thread(target=go, args=(1, 'user:a')), threading.Thread(target=go, args=(2, 'user:b'))]
    [t.start() for t in threads]
    [t.join(10) for t in threads]
    sched = env.scheduler()
    assert set(sched['jobs']) == {f'{ref(1)}:1', f'{ref(2)}:1'} and len(sched['interactive']) == 2
    assert [out[1].outcomes[1].awaiting, out[2].outcomes[2].awaiting] == [True, True]
    assert len(env.spawns) == 1       # one runner serves both: the second admitter saw the first reservation


def test_concurrent_requests_of_one_caller_never_exceed_the_caller_caps(env):
    for i in range(1, 7):
        env.seed(i, 25 * HOUR)
    barrier = threading.Barrier(6)
    out = []

    def go(i):
        store = env.new_store()
        rows = env.rows([i], store)
        barrier.wait(5)
        out.append(evaluate_and_admit(rows, 'user:a', env.budget('user:a'), store))
    threads = [threading.Thread(target=go, args=(i,)) for i in range(1, 7)]
    [t.start() for t in threads]
    [t.join(15) for t in threads]
    assert len(env.scheduler()['interactive']) <= qc.MAX_INTERACTIVE_PER_CALLER
    assert sum(1 for r in out for o in r.outcomes.values() if o.awaiting) <= 2


# ------------------------------------------------------------------ relay faults and committed versions
@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_slow_relay_bounds_admission_and_labels_rows_busy(env):
    if env.relay_config is None:
        pytest.skip('relay-only fault')
    env.seed(1, 25 * HOUR)
    rows = env.rows([1])
    with fault(env.relay_config, 'delay-transact', 1.5):
        started = time.monotonic()
        admission = evaluate_and_admit(rows, 'user:a', env.budget(seconds=3.0), env.store)
        elapsed = time.monotonic() - started
    assert labels(admission) == {1: 'busy'} and admission.outcomes[1].reason in ('store_unavailable', 'conflict')
    assert elapsed < 1.9 and env.spawns == []


def test_every_committed_scheduler_version_satisfies_every_cap(env):
    if env.relay_config is None:
        pytest.skip('relay-only log')
    for i in range(1, 10):
        env.seed(i, 25 * HOUR)
    for i in range(1, 10):
        env.admit([i], caller=f'user:{i % 3}').release()
    with open(f'{env.directory}/scheduler-commits.log') as log:
        commits = [json.loads(line) for line in log]
    assert len(commits) >= 9
    for record in commits:
        qc.validate_scheduler(record)


def test_the_store_is_unavailable_leaves_rows_busy_and_never_raises(env, monkeypatch):
    env.seed(1, 25 * HOUR)
    rows = env.rows([1])

    class Down:
        def read_all(self, *a, **k):
            raise ProjectionUnavailable()
    admission = evaluate_and_admit(rows, 'user:a', env.budget(), Down())
    assert labels(admission) == {1: 'busy'} and admission.outcomes[1].reason == 'store_unavailable'


# ------------------------------------------------------------------ reclaim, uncertain slots, deadlines (review M1-M4, F1, F5)
OWNER = 'd' * 32


def dead_scene(env, lock='free', *, index=1, slot=0, expired=True, lease_owner=None):
    """A runner that was SIGKILLed: its slot is running with a lease that has run out, it holds a source permit and one
    running job. ``lock``: 'free' (termination provable), 'held' (flock still taken) or 'missing' (no lock file)."""
    now = qc.wall_ms()
    job = f'{ref(index)}:1'
    sched = qc.new_scheduler(now)
    sched['jobs'][job] = qc.new_job('user:z', f'c-{index}', now)
    sched['jobs'][job].update(state='running', slot=slot, owner=OWNER, attempt=1)
    sched['source']['p1'] = {'caller': 'user:z', 'slot': slot, 'owner': OWNER, 'jobs': [job], 'started_ms': now}
    env.put(qc.scheduler_key(), qc.validate_scheduler(sched))
    work = qc.new_work(ref(index), 1, f'c-{index}', 'normal', '77', 'user:z', now)
    work.update(state='running', attempt=1, slot=slot, owner=OWNER)
    env.put(qc.work_record_key(ref(index), 1), qc.validate_work(work))
    lease = qc.new_runner_lease(lease_owner or OWNER, price_launcher.host_id(), now - 20_000, 1)
    lease.update(state='running', claimed_ms=now - 20_000, supervisor_pid=2, worker_pid=3,
                 lease_until_ms=now - 1 if expired else now + 10_000, hard_stop_ms=now + 45_000)
    env.put(qc.runner_lease_key(slot), qc.validate_runner_lease(lease))
    if lock == 'missing':
        return None
    descriptor = os.open(price_launcher.lock_path(slot, OWNER), os.O_RDWR | os.O_CREAT, 0o600)
    if lock == 'held':
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    os.close(descriptor)
    return None


@pytest.mark.parametrize('lock', ['held', 'missing'])
@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_an_uncertain_dead_slot_answers_busy_at_once_and_is_recorded_in_stats(env, lock):
    env.seed(1, 25 * HOUR)
    descriptor = dead_scene(env, lock)
    try:
        started = time.monotonic()
        admission = env.admit([1])
        admission.wait()
        elapsed = time.monotonic() - started
        assert labels(admission) == {1: 'busy'} and admission.outcomes[1].reason == 'runner_uncertain'
        assert elapsed < 0.3 and env.spawns == []
        assert env.value(qc.runner_lease_key(0))['owner'] == OWNER           # an unprovable slot is never touched
        admission.release()
        stats = env.scheduler()['stats']['refused']
        assert stats.get('runner_uncertain', 0) >= 1 and env.scheduler()['interactive'] == {}
    finally:
        if descriptor is not None:
            os.close(descriptor)


def slots_scene(env, specs):
    """Several runners at once. ``specs``: {slot: (index, lock, expired)}; each slot's owner holds one running job for
    edition ``index`` and one source permit. Returns {slot: owner} and the descriptors of held locks."""
    now = qc.wall_ms()
    sched = qc.new_scheduler(now)
    owners, held = {}, []
    for slot, (index, lock, expired) in specs.items():
        owner = f'{slot + 10:x}' * 32
        owners[slot] = owner
        job = f'{ref(index)}:1'
        sched['jobs'][job] = qc.new_job('user:z', f'c-{index}', now)
        sched['jobs'][job].update(state='running', slot=slot, owner=owner, attempt=1)
        sched['source'][f'p{slot}'] = {'caller': 'user:z', 'slot': slot, 'owner': owner, 'jobs': [job], 'started_ms': now}
        work = qc.new_work(ref(index), 1, f'c-{index}', 'normal', '77', 'user:z', now)
        work.update(state='running', attempt=1, slot=slot, owner=owner)
        env.put(qc.work_record_key(ref(index), 1), qc.validate_work(work))
        lease = qc.new_runner_lease(owner, price_launcher.host_id(), now - 20_000, 1)
        lease.update(state='running', claimed_ms=now - 20_000, supervisor_pid=2, worker_pid=3,
                     lease_until_ms=now - 1 if expired else now + 10_000, hard_stop_ms=now + 45_000)
        env.put(qc.runner_lease_key(slot), qc.validate_runner_lease(lease))
        if lock != 'missing':
            descriptor = os.open(price_launcher.lock_path(slot, owner), os.O_RDWR | os.O_CREAT, 0o600)
            if lock == 'held':
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                held.append(descriptor)
            else:
                os.close(descriptor)
    env.put(qc.scheduler_key(), qc.validate_scheduler(sched))
    return owners, held


def test_an_uncertain_slot_never_turns_a_row_on_a_live_slot_busy(env):
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    owners, held = slots_scene(env, {0: (1, 'free', False), 1: (2, 'held', True)})
    try:
        admission = env.admit([1, 2])
        assert admission.outcomes[1].awaiting and admission.outcomes[1].refresh is None   # its runner is alive
        assert labels(admission)[2] == 'busy' and admission.outcomes[2].reason == 'runner_uncertain'
        assert env.spawns == [] and env.value(qc.runner_lease_key(1))['owner'] == owners[1]
        admission.release()
    finally:
        for descriptor in held:
            os.close(descriptor)


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_reclaimed_slot_and_an_uncertain_slot_each_settle_their_own_rows(env):
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    owners, held = slots_scene(env, {0: (1, 'free', True), 1: (2, 'held', True)})
    try:
        started = time.monotonic()
        admission = env.admit([1, 2])
        assert time.monotonic() - started < 0.5
        (slot, owner), = env.spawns
        assert slot == 0 and env.value(qc.runner_lease_key(0))['owner'] == owner
        assert admission.outcomes[1].awaiting                                  # requeued; the new runner serves it
        assert labels(admission)[2] == 'busy' and admission.outcomes[2].reason == 'runner_uncertain'
        assert not admission.outcomes[2].awaiting
        admission.release()
    finally:
        for descriptor in held:
            os.close(descriptor)


def test_one_runner_is_spawned_for_a_short_queue_even_when_two_slots_are_reclaimable(env):
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    slots_scene(env, {0: (1, 'free', True), 1: (2, 'free', True)})
    admission = env.admit([1, 2])
    assert len(env.spawns) == 1                                               # two jobs call for one runner
    sched = env.scheduler()
    assert sched['source'] == {} and {job['state'] for job in sched['jobs'].values()} == {'queued'}
    assert [env.value(qc.runner_lease_key(s)) is None for s in (0, 1)].count(True) == 1
    assert admission.outcomes[1].awaiting and admission.outcomes[2].awaiting
    admission.release()


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_slot_freed_by_someone_else_without_a_runner_answers_at_once(env, monkeypatch):
    env.seed(1, 25 * HOUR)
    dead_scene(env, 'free')
    real = price_launcher.reclaim_slot

    def freed_elsewhere(store, slot, **kwargs):     # another API reclaimed it, then its spawn failed and it freed the slot
        assert real(store, slot) == 'reclaimed'
        return 'not_applicable'
    monkeypatch.setattr(price_launcher, 'reclaim_slot', freed_elsewhere)
    started = time.monotonic()
    admission = env.admit([1])
    admission.wait()
    assert labels(admission) == {1: 'busy'} and time.monotonic() - started < 0.5 and env.spawns == []


def test_a_reclaim_whose_answer_is_lost_still_spawns_into_its_reservation(env):
    class LostCleanup:
        def __init__(self, store):
            self.store = store

        def __getattr__(self, name):
            return getattr(self.store, name)

        def compare_and_swap(self, expected, changes, *, deadline, operation_id=None):
            done = self.store.compare_and_swap(expected, changes, deadline=deadline, operation_id=operation_id)
            if operation_id and operation_id.startswith('cleanup:'):
                raise ProjectionUnavailable()
            return done

        def operation_status(self, operation_id, *, deadline):
            raise ProjectionUnavailable()
    env.seed(1, 25 * HOUR)
    dead_scene(env, 'free')
    admission = evaluate_and_admit(env.rows([1]), 'user:a', env.budget(), LostCleanup(env.store))
    (slot, owner), = env.spawns
    assert env.value(qc.runner_lease_key(slot))['owner'] == owner and admission.outcomes[1].awaiting
    admission.release()


def test_launch_failed_is_counted_once_per_access(env, monkeypatch):
    monkeypatch.setattr(price_launcher, 'spawn', lambda slot, owner: False)
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    slots_scene(env, {1: (1, 'free', True)})                                  # slot 0 free: reserved; slot 1 reclaimed
    admission = env.admit([1, 2])
    assert labels(admission) == {1: 'busy', 2: 'busy'}
    admission.release()
    assert env.scheduler()['stats']['refused'].get('launch_failed') == 1


def test_a_dead_slot_with_a_free_lock_is_reclaimed_and_a_runner_is_spawned_for_the_requeued_job(env):
    env.seed(1, 25 * HOUR)
    dead_scene(env, 'free')
    admission = env.admit([1])
    job = f'{ref(1)}:1'
    (slot, owner), = env.spawns
    assert slot == 0 and owner != OWNER
    lease = qc.validate_runner_lease(env.value(qc.runner_lease_key(0)))
    assert lease['owner'] == owner and lease['state'] == 'reserved'
    sched = env.scheduler()
    assert sched['source'] == {} and sched['jobs'][job]['state'] == 'queued' and sched['fifo'] == {'user:z': [job]}
    assert admission.outcomes[1].awaiting                                  # a runner is coming for it
    assert not price_launcher.lock_path(0, OWNER).exists()
    admission.release()


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_dead_slot_whose_spawn_fails_answers_busy_and_frees_the_reservation(env, monkeypatch):
    monkeypatch.setattr(price_launcher, 'spawn', lambda slot, owner: False)
    env.seed(1, 25 * HOUR)
    dead_scene(env, 'free')
    started = time.monotonic()
    admission = env.admit([1])
    assert labels(admission) == {1: 'busy'} and time.monotonic() - started < 1.0
    assert env.value(qc.runner_lease_key(0)) is None and env.scheduler()['jobs'][f'{ref(1)}:1']['state'] == 'queued'


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_running_job_whose_slot_belongs_to_someone_else_is_busy_without_waiting(env):
    env.seed(1, 25 * HOUR)
    dead_scene(env, 'free', lease_owner='e' * 32, expired=False)
    started = time.monotonic()
    admission = env.admit([1])
    admission.wait()
    assert labels(admission) == {1: 'busy'} and admission.outcomes[1].reason == 'runner_uncertain'
    assert time.monotonic() - started < 0.3 and not admission.outcomes[1].awaiting


def test_a_running_job_on_a_live_slot_is_still_awaited(env):
    env.seed(1, 25 * HOUR)
    dead_scene(env, 'free', expired=False)
    admission = env.admit([1])
    assert admission.outcomes[1].awaiting and env.spawns == []
    admission.release()


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_reclaim_against_a_delayed_store_stays_inside_the_budget(env):
    if env.relay_config is None:
        pytest.skip('relay-only fault')
    env.seed(1, 61 * MIN)            # soft: no permit, so the reclaim is the only write the request attempts
    dead_scene(env, 'free')
    rows = env.rows([1])
    with fault(env.relay_config, 'delay-transact', 1.5):
        started = time.monotonic()
        admission = evaluate_and_admit(rows, 'user:a', env.budget(seconds=3.0), env.store)
        elapsed = time.monotonic() - started
    assert elapsed < 1.0 and labels(admission) == {1: 'busy'} and admission.outcomes[1].reason == 'runner_uncertain'


def test_slot_status_is_one_predicate_for_admission_and_handoff():
    now = 1_000_000

    def lease(state, **fields):
        value = qc.new_runner_lease(OWNER, 'h', now - 1_000, 1)
        if state != 'reserved':
            value.update(state=state, claimed_ms=now - 9_000, supervisor_pid=2, worker_pid=3, lease_until_ms=now + 5_000,
                         hard_stop_ms=now + 40_000)
        value.update(fields)
        return value
    status = qc.slot_status
    assert status(None, now) == 'free'
    assert status(lease('reserved'), now) == 'usable'
    assert status(lease('reserved', reserved_ms=now - 6_000, lease_until_ms=now - 1_000), now) == 'free'
    assert status(lease('running'), now) == 'usable'
    assert status(lease('running', hard_stop_ms=now + 2_000), now) == 'winding_down'
    assert status(lease('running', lease_until_ms=now), now) == 'reclaimable'
    assert status(lease('exiting'), now) == 'winding_down'
    assert status(lease('exiting', lease_until_ms=now - 1), now) == 'reclaimable'
    assert status({'v': 1}, now) == 'invalid' and status('invalid', now) == 'invalid' and status(7, now) == 'invalid'
    assert [qc.runner_target(n) for n in (0, 1, 4, 5, 9)] == [1, 1, 1, 2, 2]


# ------------------------------------------------------------------ F1: hard joins wait only when a runner is coming
@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_source_backoff_with_queued_joins_answers_at_once_and_writes_nothing(env):
    env.seed(1, 25 * HOUR)
    env.admit([1]).release()                                              # a queued job with a reserved slot
    now = qc.wall_ms()
    env.put(qc.source_backoff_key(), qc.new_source_backoff('rate_limited', now + 30_000, now))
    generation = env.generation()
    started = time.monotonic()
    admission = env.admit([1], caller='user:b')
    admission.wait()
    assert labels(admission) == {1: 'backoff'} and admission.outcomes[1].reason == 'source_backoff'
    assert time.monotonic() - started < 0.3 and env.generation() == generation


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_a_queued_hard_join_with_no_runner_coming_is_busy_at_once(env):
    env.seed(1, 25 * HOUR)
    env.admit([1]).release()
    for slot in (0, 1):                                                   # nothing usable, nothing free, nothing to reclaim
        env.put(qc.runner_lease_key(slot), {'v': 1, 'junk': True})
    started = time.monotonic()
    admission = env.admit([1], caller='user:b')
    admission.wait()
    assert labels(admission) == {1: 'busy'} and admission.outcomes[1].reason == 'no_runner'
    assert time.monotonic() - started < 0.3


def test_a_queued_hard_join_still_waits_when_a_reservation_is_made_in_the_same_cas(env):
    env.seed(1, 25 * HOUR)
    env.admit([1]).release()
    env.put(qc.runner_lease_key(0), None)
    env.put(qc.runner_lease_key(1), None)
    env.spawns.clear()
    admission = env.admit([1], caller='user:b')
    assert admission.outcomes[1].awaiting and len(env.spawns) == 1
    admission.release()


# ------------------------------------------------------------------ F5: an unknown admission outcome with a reservation
class LostAnswer:
    """Commits the admission CAS and then loses the answer, including the operation status."""

    def __init__(self, store):
        self.store = store

    def __getattr__(self, name):
        return getattr(self.store, name)

    def compare_and_swap(self, expected, changes, *, deadline, operation_id=None):
        done = self.store.compare_and_swap(expected, changes, deadline=deadline, operation_id=operation_id)
        if operation_id and operation_id.startswith('admit-'):
            raise ProjectionUnavailable()
        return done

    def operation_status(self, operation_id, *, deadline):
        raise ProjectionUnavailable()


def test_an_unknown_admission_outcome_with_a_reservation_still_spawns_the_runner(env):
    env.seed(1, 25 * HOUR)
    rows = env.rows([1])
    admission = evaluate_and_admit(rows, 'user:a', env.budget(), LostAnswer(env.store))
    (slot, owner), = env.spawns
    assert env.value(qc.runner_lease_key(slot))['owner'] == owner
    assert admission.permit_held
    admission.release()
    assert env.scheduler()['interactive'] == {}


def test_an_unknown_admission_outcome_that_did_not_land_spawns_nothing(env):
    class Dropped(LostAnswer):
        def compare_and_swap(self, expected, changes, *, deadline, operation_id=None):
            raise ProjectionUnavailable()
    env.seed(1, 25 * HOUR)
    admission = evaluate_and_admit(env.rows([1]), 'user:a', env.budget(), Dropped(env.store))
    assert env.spawns == [] and labels(admission) == {1: 'busy'}


# ------------------------------------------------------------------ M4: the post-wait reads keep the PostgreSQL reserve
class Sluggish:
    """Every read takes ``delay`` seconds and fails when it would outlast its own deadline."""

    def __init__(self, store, delay):
        self.store, self.delay, self.slow = store, delay, False

    def __getattr__(self, name):
        return getattr(self.store, name)

    def _slow(self, deadline):
        if self.slow:
            time.sleep(max(0.0, min(self.delay, deadline - time.monotonic())))
            if time.monotonic() >= deadline:
                raise ProjectionUnavailable()

    def read_all(self, keys, *, deadline, generation=None):
        self._slow(deadline)
        return self.store.read_all(keys, deadline=deadline, generation=generation)

    def read_records(self, keys, *, deadline, generation=None):
        self._slow(deadline)
        return self.store.read_records(keys, deadline=deadline, generation=generation)


def test_follow_up_reads_after_the_hard_wait_leave_the_postgresql_reserve(env):
    store = Sluggish(env.store, 0.2)
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    budget = Budget(hard=time.monotonic() + 1.5, caller='user:a')
    admission = evaluate_and_admit(env.rows([1, 2], store), 'user:a', budget, store)
    sched = env.scheduler()                                               # job 1 fails at once; job 2 stays pending
    gone = f'{ref(1)}:1'
    del sched['jobs'][gone]
    sched['fifo']['user:a'].remove(gone)
    env.put(qc.scheduler_key(), qc.validate_scheduler(sched))
    stamp = qc.wall_ms()
    env.put(qc.edition_backoff_key(ref(1), 1), qc.new_edition_backoff(1, stamp, stamp + 60_000, 'timeout'))
    store.slow = True
    admission.wait(budget)
    assert budget.remaining() >= 0.45, budget.remaining()
    assert labels(admission) == {1: 'failed', 2: 'timeout'}
    assert admission.outcomes[1].failed_at_ms is not None             # the shortened poll still left room for the follow-up
    store.slow = False
    admission.release()


def test_the_route_helper_rereads_changed_rows_inside_the_wait_window(env):
    from app import main  # noqa: F401  (main first: it includes the prices router while loading)
    from app import prices
    store = Sluggish(env.store, 0.2)
    env.seed(1, 25 * HOUR)
    env.seed(2, 25 * HOUR)
    budget = Budget(hard=time.monotonic() + 1.5, caller='user:a')
    pairs = [(ref(1), 1), (ref(2), 1)]
    states = quote_states(store, pairs, deadline=deadline())
    found = {i: (None, None, SimpleNamespace(quote_lookup={'card': f'c-{i}', 'variant': 'normal'}, product_id=77)) for i in (1, 2)}
    # A runner writes row 1 before the wait starts, so the wait resolves it; row 2 stays pending until the window ends.
    original = price_refresh.Admission.wait

    def write_then_wait(self, budget=None):
        env.seed(1, 0)
        store.slow = True
        return original(self, budget)
    price_refresh.Admission.wait = write_then_wait
    releases = []
    try:
        admission = prices._admit([1, 2], pairs, found, states, budget, store, releases)
    finally:
        price_refresh.Admission.wait = original
    assert budget.remaining() >= 0.45, budget.remaining()
    assert admission.outcomes[1].refresh == 'refreshed'
    store.slow = False
    releases[0]()
