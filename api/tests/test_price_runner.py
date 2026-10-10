"""Price runner (ticket 08-B): worker loop, supervisor, launcher and reclaim.

Store semantics run against both adapters (filesystem and the HTTP relay). Process tests launch the real detached
supervisor through ``price_launcher.spawn`` with a test-local ``sitecustomize`` that registers fake ``app.price_source`` /
``app.tcgdex_record`` modules which talk to a real local HTTP server, so the runner is exercised end to end without
08-A. Admission (07-A) is simulated by seeding records with the ``quote_contract`` builders.
"""
import json
import multiprocessing
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

import pytest

from app import price_launcher, price_refresh, price_runner, price_source, tcgdex_record
from app import quote_contract as qc
from app.price_budget import Budget
from app.public_projection import ProjectionUnavailable
from app.public_records import (catalog_edition_key, catalog_printing_key, quarantine_key, quote_key, quote_states, result_key)
from public_records_fixture import backend_from_config, serve_relay, store_from_config

API_DIR = Path(__file__).resolve().parents[1]
FIXTURE_DIR = Path(__file__).resolve().parent / 'catalog_process_fixture'
SCHEDULER = qc.scheduler_key()


def deadline(seconds=5):
    return time.monotonic() + seconds


def ref(index):
    return f'{index:048x}'


def owner_nonce():
    return uuid4().hex


# --- Store fixtures ---------------------------------------------------------------------------------------------------
def start_relay(config):
    context = multiprocessing.get_context('spawn')
    receive, send = context.Pipe(duplex=False)
    process = context.Process(target=serve_relay, args=(config, send, None, None))
    process.start()
    assert receive.poll(10)
    url = f'http://127.0.0.1:{receive.recv()}/manifest'
    receive.close()
    return process, url


class Env:
    """A store plus the environment a runner process needs to reach the same store."""

    def __init__(self, store, variables):
        self.store, self.variables = store, variables

    def get(self, key):
        return self.store.read_records([key], deadline=deadline()).records[key].value

    def version(self, key):
        return self.store.read_records([key], deadline=deadline()).records[key].version

    def put(self, changes):
        rows = self.store.read_records(list(changes), deadline=deadline()).records
        assert self.store.compare_and_swap({key: rows[key].version for key in changes}, changes, deadline=deadline())


@pytest.fixture(params=['filesystem', 'http'])
def env(request, tmp_path, monkeypatch):
    config = {'adapter': request.param, 'directory': str(tmp_path / 'records')}
    Path(config['directory']).mkdir()
    backend_from_config(config).initialize(deadline=deadline())
    variables = {'PUBLIC_PROJECTION_DIR': config['directory'], 'PUBLIC_PROJECTION_ADAPTER': 'filesystem'}
    relay = None
    if request.param == 'http':
        relay, url = start_relay(config)
        variables = {'PUBLIC_PROJECTION_ADAPTER': 'http', 'PUBLIC_PROJECTION_URL': url,
                     'PUBLIC_PROJECTION_TOKEN': 'conformance-secret'}
    for name, value in variables.items():
        monkeypatch.setenv(name, value)
    yield Env(store_from_config(config, variables.get('PUBLIC_PROJECTION_URL')), variables)
    if relay:
        relay.terminate()
        relay.join(5)


@pytest.fixture
def fs_env(tmp_path, monkeypatch):
    config = {'adapter': 'filesystem', 'directory': str(tmp_path / 'records')}
    Path(config['directory']).mkdir()
    backend_from_config(config).initialize(deadline=deadline())
    variables = {'PUBLIC_PROJECTION_DIR': config['directory'], 'PUBLIC_PROJECTION_ADAPTER': 'filesystem'}
    for name, value in variables.items():
        monkeypatch.setenv(name, value)
    return Env(store_from_config(config), variables)


@pytest.fixture(autouse=True)
def lock_directory(tmp_path, monkeypatch):
    directory = tmp_path / 'locks'
    monkeypatch.setenv('PRICE_RUNNER_LOCK_DIR', str(directory))
    return directory


# --- Seeding (simulates admission) -------------------------------------------------------------------------------------
def edition_record(index, card, variant, *, revision=1, product=1000, state='verified'):
    return {'edition_ref': ref(index), 'printing_ref': ref(index + 5000), 'descriptor': {'kind': 'normal', 'name': variant},
            'revision': 1,
            'marketplace': {'state': state, 'reason': None, 'mapping_revision': revision, 'product_id': product + index,
                            'quote_lookup': {'source': 'tcgdex', 'card': card, 'variant': variant}}}


def quarantine_record(index, revision=1, state='clear'):
    return {'edition_ref': ref(index), 'revision': 1, 'mapping_revision': revision, 'state': state}


def seed(env, specs, *, lease=None, slot=0, now=None, scheduler=None, rev=1):
    """specs: dicts with index, card, caller (default user:a), variant (default normal), expires offset, extra records."""
    now = qc.wall_ms() if now is None else now
    scheduler = scheduler or qc.new_scheduler(now)
    changes = {}
    for spec in specs:
        index, card = spec['index'], spec['card']
        caller = spec.get('caller', 'user:a')
        variant = spec.get('variant', 'normal')
        admitted = now + spec.get('admitted_offset', 0)
        job_id = qc.job_id(ref(index), rev)
        job = qc.new_job(caller, card, admitted)
        work = qc.new_work(ref(index), rev, card, variant, str(1000 + index), caller, admitted)
        scheduler['jobs'][job_id] = job
        scheduler['fifo'].setdefault(caller, []).append(job_id)
        if caller not in scheduler['ring']:
            scheduler['ring'].append(caller)
        changes[catalog_edition_key(ref(index))] = edition_record(index, card, variant, revision=rev)
        changes[quarantine_key(ref(index))] = quarantine_record(index, rev)
        changes[qc.work_record_key(ref(index), rev)] = work
    changes[SCHEDULER] = qc.validate_scheduler(scheduler)
    if lease is not None:
        changes[qc.runner_lease_key(slot)] = lease
    env.put(changes)
    return scheduler


def running_lease(owner, slot=0, *, now=None, host=None, pid=None):
    now = qc.wall_ms() if now is None else now
    lease = qc.new_runner_lease(owner, host or price_launcher.host_id(), now, os.getpid())
    lease.update(state='running', claimed_ms=now, supervisor_pid=pid or os.getpid(), worker_pid=pid or os.getpid(),
                 lease_until_ms=now + qc.LEASE_TTL_MS, hard_stop_ms=now + qc.HARD_STOP_MS)
    return qc.validate_runner_lease(lease)


class Fetched:
    ok = True

    def __init__(self, record):
        self.record = record


class Failed:
    ok = False

    def __init__(self, reason='http_status', status=500, retry_after=None):
        self.reason, self.status, self.retry_after = reason, status, retry_after


def select_by_record(record, descriptor, lookup, product_id):
    """Stands in for ``tcgdex_record.select_quote`` with its real result types.
    record: {'price': '1.50'|None, 'updated': iso, 'fail': {variant: reason}}"""
    if lookup['variant'] in record.get('fail', {}):
        return tcgdex_record.Failure(record['fail'][lookup['variant']])
    if record['price'] is None:
        return tcgdex_record.Absent()
    return tcgdex_record.Quote(record['price'], lookup['card'], lookup['variant'], record.get('updated'))


def test_runner_maps_the_real_source_and_record_types():
    assert price_runner.fetch_failure(price_source.Fetched(False, reason='http_status', status=429, retry_after=90)).rate_limited
    failure = price_runner.fetch_failure(price_source.Fetched(False, reason='http_status', status=500, retry_after=30))
    assert (failure.reason, failure.retry_after_s, failure.rate_limited) == ('http_status', 30.0, False)
    assert price_runner.fetch_failure(price_source.Fetched(False, reason='http_status', status=503, retry_after=30)).rate_limited
    lookup = {'source': 'tcgdex', 'card': 'c-1', 'variant': 'normal'}
    quote = price_runner.decide(lambda *a: tcgdex_record.Quote('1.5', 'c-1', 'normal', '2026-10-01T00:00:00Z'), {}, {}, lookup, 5)
    assert (quote.kind, quote.amount) == ('quote', '1.5')
    assert price_runner.decide(lambda *a: tcgdex_record.Absent(), {}, {}, lookup, 5).kind == 'absent'
    assert price_runner.decide(lambda *a: tcgdex_record.Failure('ambiguous'), {}, {}, lookup, 5).reason == 'ambiguous'


def make_worker(env, owner, fetcher, *, slot=0, selector=select_by_record, idle_s=0.3, hard_stop=None):
    lease = env.get(qc.runner_lease_key(slot))
    return price_runner.Worker(env.store, slot, owner, hard_stop or lease['hard_stop_ms'], fetcher=fetcher, selector=selector,
                               idle_s=idle_s, poll_s=0.02)


def run_worker(env, fetcher, specs, *, selector=select_by_record, **kwargs):
    owner = owner_nonce()
    seed(env, specs, lease=running_lease(owner))
    worker = make_worker(env, owner, fetcher, selector=selector, **kwargs)
    assert worker.run() == 'idle'
    return owner, worker


def ok_fetcher(price='1.50', updated='2026-10-01T00:00:00Z', calls=None):
    def fetch(card, may_retry):
        if calls is not None:
            calls.append(card)
        return Fetched({'price': price, 'updated': updated})
    return fetch


def state_of(env, index, rev=1):
    return {name: env.get(key) for name, key in {
        'result': result_key(ref(index), rev), 'quote': quote_key(ref(index), rev), 'fence': qc.fence_record_key(ref(index), rev),
        'work': qc.work_record_key(ref(index), rev), 'backoff': qc.edition_backoff_key(ref(index), rev)}.items()}


# --- Worker: writes ---------------------------------------------------------------------------------------------------
def test_quote_write_is_one_attempt_across_result_quote_and_fence(env):
    before = qc.wall_ms()
    run_worker(env, ok_fetcher(), [{'index': 1, 'card': 'base1-1'}])
    state = state_of(env, 1)
    assert state['result']['state'] == 'quote' and state['result']['attempt'] == state['quote']['attempt'] == state['fence']['attempt'] == 1
    assert state['quote'] == {'attempt': 1, 'amount': '1.50', 'currency': 'USD', 'source': 'tcgdex', 'card': 'base1-1',
                              'variant': 'normal', 'provider_updated_at': '2026-10-01T00:00:00Z'}
    assert state['work'] is None and state['backoff'] is None
    assert qc.validate_quote_result(state['result']) and state['result']['checked_at'] >= qc.iso_from_ms(before - 1000)
    scheduler = env.get(SCHEDULER)
    assert scheduler['jobs'] == {} and scheduler['source'] == {} and scheduler['fifo'] == {} and scheduler['ring'] == []
    assert env.get(qc.runner_lease_key(0))['state'] == 'exiting'


def test_unchanged_price_rewrites_with_a_new_attempt_and_source_updated_time(env):
    old = qc.wall_ms() - 2 * 3_600_000
    env.put({result_key(ref(1), 1): qc.new_quote_result(1, old),
             quote_key(ref(1), 1): qc.new_quote_payload(1, '1.50', 'base1-1', 'normal', '2026-10-01T00:00:00Z'),
             qc.fence_record_key(ref(1), 1): qc.new_fence(1)})
    run_worker(env, ok_fetcher(price='1.50', updated='2026-10-01T00:00:00Z'), [{'index': 1, 'card': 'base1-1'}])
    state = state_of(env, 1)
    assert state['result']['attempt'] == state['quote']['attempt'] == state['fence']['attempt'] == 2
    assert state['result']['checked_at'] > qc.iso_from_ms(old + 3_600_000)
    assert state['quote']['provider_updated_at'] == '2026-10-01T00:00:00Z'


def test_absent_is_written_atomically_and_a_later_failure_keeps_it(env):
    env.put({quote_key(ref(1), 1): qc.new_quote_payload(1, '2.00', 'base1-1', 'normal', None),
             result_key(ref(1), 1): qc.new_quote_result(1, qc.wall_ms() - 10_000_000), qc.fence_record_key(ref(1), 1): qc.new_fence(1)})
    run_worker(env, ok_fetcher(price=None), [{'index': 1, 'card': 'base1-1'}])
    state = state_of(env, 1)
    assert state['result']['state'] == 'absent' and state['result']['attempt'] == 2 and state['quote'] is None
    assert state['result']['expires_at'] > state['result']['checked_at']
    result_version = env.version(result_key(ref(1), 1))
    seed(env, [{'index': 1, 'card': 'base1-1'}], lease=running_lease(owner_nonce()), scheduler=env.get(SCHEDULER))
    owner = env.get(qc.runner_lease_key(0))['owner']
    assert make_worker(env, owner, lambda card, may_retry: Failed()).run() == 'idle'
    assert env.version(result_key(ref(1), 1)) == result_version
    assert state_of(env, 1)['backoff']['failures'] == 1


def test_failure_never_touches_result_or_quote_and_backs_off(env):
    env.put({result_key(ref(1), 1): qc.new_quote_result(1, qc.wall_ms() - 90_000_000),
             quote_key(ref(1), 1): qc.new_quote_payload(1, '3.00', 'base1-1', 'normal', None), qc.fence_record_key(ref(1), 1): qc.new_fence(1)})
    versions = [env.version(result_key(ref(1), 1)), env.version(quote_key(ref(1), 1))]
    start = qc.wall_ms()
    run_worker(env, lambda card, may_retry: Failed('http_status', 500), [{'index': 1, 'card': 'base1-1'}])
    state = state_of(env, 1)
    assert [env.version(result_key(ref(1), 1)), env.version(quote_key(ref(1), 1))] == versions
    backoff = state['backoff']
    assert backoff['failures'] == 1 and backoff['reason'] == 'http_status' and backoff['last_attempt_ms'] >= start
    assert 48_000 <= backoff['retry_ms'] - backoff['last_attempt_ms'] <= 72_000
    assert state['work'] is None and state['fence']['attempt'] == 2
    assert env.get(SCHEDULER)['source'] == {}


def test_partial_success_writes_one_edition_and_backs_off_the_other(env):
    fail = {'price': '4.00', 'updated': None, 'fail': {'reverse': 'lookup_drift'}}
    run_worker(env, lambda card, may_retry: Fetched(fail),
               [{'index': 1, 'card': 'base1-2', 'variant': 'normal'}, {'index': 2, 'card': 'base1-2', 'variant': 'reverse'}])
    assert state_of(env, 1)['result']['state'] == 'quote'
    other = state_of(env, 2)
    assert other['result'] is None and other['quote'] is None and other['backoff']['reason'] == 'lookup_drift'
    assert other['work'] is None


def test_rate_limit_sets_source_backoff_and_blocks_further_claims(env):
    calls = []

    def fetch(card, may_retry):
        calls.append(card)
        if card == 'a-2':
            time.sleep(0.6)  # Outlast the 429's backoff write; the caller cap keeps a-3 queued until a permit frees.
            return Fetched({'price': '1.00', 'updated': None})
        return Failed('http_status', 429, retry_after=120)
    run_worker(env, fetch, [{'index': i, 'card': f'a-{i}'} for i in (1, 2, 3)])
    assert 'a-3' not in calls  # Never fetched while the source is backing off.
    backoff = qc.validate_source_backoff(env.get(qc.source_backoff_key()))
    assert backoff['reason'] == 'retry_after' and 100_000 <= backoff['retry_ms'] - backoff['set_ms'] <= 125_000
    assert qc.job_id(ref(3), 1) in env.get(SCHEDULER)['jobs'] and 'a-1' in calls
    assert env.get(SCHEDULER)['jobs'][qc.job_id(ref(3), 1)]['state'] == 'queued'


def test_unknown_commit_outcome_is_resolved_by_operation_status(env):
    class Lossy:
        def __init__(self, store):
            self.store, self.lost = store, 0

        def __getattr__(self, name):
            return getattr(self.store, name)

        def compare_and_swap(self, expected, changes, *, deadline, operation_id=None):
            committed = self.store.compare_and_swap(expected, changes, deadline=deadline, operation_id=operation_id)
            if operation_id and operation_id.startswith('price:') and not self.lost:
                self.lost += 1
                raise ProjectionUnavailable()
            return committed

    owner = owner_nonce()
    seed(env, [{'index': 1, 'card': 'base1-1'}], lease=running_lease(owner))
    lossy = Lossy(env.store)
    worker = price_runner.Worker(lossy, 0, owner, env.get(qc.runner_lease_key(0))['hard_stop_ms'], fetcher=ok_fetcher(),
                                 selector=select_by_record, idle_s=0.3, poll_s=0.02)
    assert worker.run() == 'idle' and lossy.lost == 1
    assert state_of(env, 1)['result']['attempt'] == 1


# --- Worker: fencing ---------------------------------------------------------------------------------------------------
def gated(calls=None):
    reached, release = threading.Event(), threading.Event()

    def fetch(card, may_retry):
        if calls is not None:
            calls.append(card)
        reached.set()
        assert release.wait(20)
        return Fetched({'price': '9.99', 'updated': None})
    return fetch, reached, release


def run_gated(env, mutate, *, expect='idle'):
    owner = owner_nonce()
    seed(env, [{'index': 1, 'card': 'base1-1'}], lease=running_lease(owner))
    fetch, reached, release = gated()
    worker = make_worker(env, owner, fetch)
    outcome = []
    thread = threading.Thread(target=lambda: outcome.append(worker.run()))
    thread.start()
    assert reached.wait(10)
    mutate(env, owner)
    release.set()
    thread.join(20)
    assert outcome == [expect]
    return owner


def test_reclaim_mid_fetch_fences_the_stale_writer(env):
    def reclaim(env, owner):
        assert price_launcher.cleanup_slot(env.store, 0, owner)
    run_gated(env, reclaim, expect='fenced')
    state = state_of(env, 1)
    assert state['result'] is None and state['quote'] is None
    assert state['work']['state'] == 'queued' and state['fence']['attempt'] == 1  # Requeued, not written.


def test_quarantine_mid_fetch_writes_nothing(env):
    run_gated(env, lambda env, owner: env.put({quarantine_key(ref(1)): quarantine_record(1, 1, 'quarantined')}))
    state = state_of(env, 1)
    assert state['result'] is None and state['quote'] is None
    assert env.get(SCHEDULER)['jobs'] == {} and env.get(SCHEDULER)['stats']['fenced'] == 1


def test_revision_bump_mid_fetch_writes_under_neither_revision(env):
    def bump(env, owner):
        env.put({catalog_edition_key(ref(1)): edition_record(1, 'base1-1', 'normal', revision=2),
                 quarantine_key(ref(1)): quarantine_record(1, 2)})
    run_gated(env, bump)
    for revision in (1, 2):
        state = state_of(env, 1, revision)
        assert state['result'] is None and state['quote'] is None


def test_eviction_of_the_quote_payload_mid_fetch_retries_once(env):
    run_gated(env, lambda env, owner: env.put({quote_key(ref(1), 1): qc.new_quote_payload(7, '0.10', 'base1-1', 'normal', None)}))
    assert state_of(env, 1)['quote']['attempt'] == 1 and state_of(env, 1)['quote']['amount'] == '9.99'


def test_expired_and_ineligible_jobs_are_cancelled_without_a_fetch(env):
    calls = []
    now = qc.wall_ms()
    owner = owner_nonce()
    seed(env, [{'index': 1, 'card': 'old-1', 'admitted_offset': -70_000}, {'index': 2, 'card': 'drift-1'}],
         lease=running_lease(owner))
    env.put({catalog_edition_key(ref(2)): {**edition_record(2, 'drift-1', 'normal'),
                                           'marketplace': {**edition_record(2, 'drift-1', 'normal')['marketplace'], 'product_id': 77}}})
    assert make_worker(env, owner, ok_fetcher(calls=calls)).run() == 'idle'
    assert calls == [] and env.get(SCHEDULER)['jobs'] == {}
    assert env.get(SCHEDULER)['stats']['expired'] == 1
    assert state_of(env, 1)['work'] is None and state_of(env, 2)['work'] is None


def test_lost_lease_stops_claims(env):
    owner = owner_nonce()
    seed(env, [{'index': 1, 'card': 'base1-1'}], lease=running_lease(owner_nonce()))
    calls = []
    assert make_worker(env, owner, ok_fetcher(calls=calls)).run() == 'fenced' and calls == []


# --- Worker: caps ---------------------------------------------------------------------------------------------------------
def test_concurrency_caps_hold_per_slot_and_per_caller(env):
    lock = threading.Lock()
    live, peak = {}, {'all': 0, 'caller': 0}
    callers = {f'card-{i}': f'user:{"abc"[i % 3]}' for i in range(8)}

    def fetch(card, may_retry):
        with lock:
            live[card] = callers[card]
            peak['all'] = max(peak['all'], len(live))
            for caller in set(live.values()):
                peak['caller'] = max(peak['caller'], list(live.values()).count(caller))
        time.sleep(0.25)
        with lock:
            del live[card]
        return Fetched({'price': '1.00', 'updated': None})
    run_worker(env, fetch, [{'index': i, 'card': f'card-{i}', 'caller': callers[f'card-{i}']} for i in range(8)])
    assert 2 <= peak['all'] <= 4 and peak['caller'] <= 2
    assert all(state_of(env, i)['result']['state'] == 'quote' for i in range(8))


def test_empty_bucket_spaces_fetches_about_a_second_apart(fs_env):
    owner = owner_nonce()
    scheduler = qc.new_scheduler(qc.wall_ms())
    scheduler['bucket'] = {'milli': 0, 'at_ms': qc.wall_ms()}
    seed(fs_env, [{'index': i, 'card': f'slow-{i}', 'caller': f'user:{"ab"[i % 2]}'} for i in range(3)], lease=running_lease(owner),
         scheduler=scheduler)
    times = []

    def fetch(card, may_retry):
        times.append(time.monotonic())
        return Fetched({'price': '1.00', 'updated': None})
    assert make_worker(fs_env, owner, fetch).run() == 'idle'
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert len(times) == 3 and all(0.8 <= gap <= 1.6 for gap in gaps), gaps


def test_idle_exit_follows_two_seconds_of_nothing(fs_env):
    owner = owner_nonce()
    seed(fs_env, [], lease=running_lease(owner))
    worker = price_runner.Worker(fs_env.store, 0, owner, qc.wall_ms() + 60_000, fetcher=ok_fetcher(), selector=select_by_record)
    start = time.monotonic()
    assert worker.run() == 'idle'
    assert 1.9 <= time.monotonic() - start <= 2.4
    assert fs_env.get(qc.runner_lease_key(0))['state'] == 'exiting'


def test_idle_exit_declines_while_runnable_jobs_wait(fs_env):
    owner = owner_nonce()
    seed(fs_env, [{'index': 1, 'card': 'later-1'}], lease=running_lease(owner))
    worker = make_worker(fs_env, owner, ok_fetcher())
    assert worker.try_idle_exit() is False and fs_env.get(qc.runner_lease_key(0))['state'] == 'running'


# --- Marketplace parity -----------------------------------------------------------------------------------------------------
def test_marketplace_validation_matches_the_catalog_reader():
    from app.public_catalog import _marketplace
    good = edition_record(1, 'c-1', 'normal')
    cases = [
        (good, quarantine_record(1)), (good, quarantine_record(1, state='quarantined')), (good, quarantine_record(1, revision=2)),
        (edition_record(1, 'c-1', 'normal', state='unverified'), quarantine_record(1)),
        (edition_record(1, 'c-1', 'normal', state='quarantined'), quarantine_record(1)),
        ({**good, 'extra': 1}, quarantine_record(1)), (None, quarantine_record(1)), (good, None),
        ({**good, 'edition_ref': ref(9)}, quarantine_record(1)),
        ({**good, 'marketplace': {**good['marketplace'], 'product_id': '12'}}, quarantine_record(1)),
        ({**good, 'marketplace': {**good['marketplace'], 'product_id': None}}, quarantine_record(1)),
        ({**good, 'marketplace': {**good['marketplace'], 'quote_lookup': {'source': 'tcgdex', 'card': '', 'variant': 'x'}}}, quarantine_record(1)),
        ({**good, 'marketplace': {**good['marketplace'], 'quote_lookup': None}}, quarantine_record(1)),
        ({**good, 'marketplace': {**good['marketplace'], 'reason': 3}}, quarantine_record(1)),
    ]
    for edition, quarantine in cases:
        assert price_runner.marketplace_of(ref(1), edition, quarantine) == _marketplace(ref(1), edition, quarantine)


def test_runner_modules_load_no_postgres_code():
    code = 'import sys; sys.path.insert(0, "'+str(API_DIR)+'"); import app.price_runner, app.price_launcher, app.price_source, app.tcgdex_record; bad=[m for m in sys.modules if m.split(".")[0] in ("psycopg","psycopg_pool") or m in ("app.main","app.prices","app.public_catalog")]; print(bad)'
    out = subprocess.run([sys.executable, '-c', code], cwd=API_DIR, env={'PYTHONPATH': str(API_DIR), 'PATH': os.environ['PATH']},
                         capture_output=True, text=True, check=True).stdout
    assert out.strip() == '[]'


# --- Launcher helpers: cleanup and reclaim ---------------------------------------------------------------------------------------
def claimed_scene(env, *, expired=False, host=None):
    """A claimed slot whose owner holds a permit on one unexpired and one expired running job."""
    owner = owner_nonce()
    now = qc.wall_ms()
    seed(env, [{'index': 1, 'card': 'live-1'}, {'index': 2, 'card': 'live-1', 'variant': 'reverse'},
               {'index': 3, 'card': 'dead-1', 'admitted_offset': -59_000}], lease=running_lease(owner, now=now - 20_000 if expired else now,
                                                                                               host=host))
    scheduler = env.get(SCHEDULER)
    jobs = list(scheduler['jobs'])
    for job_id in jobs:
        job = scheduler['jobs'][job_id]
        job.update(state='running', slot=0, owner=owner, attempt=1)
    scheduler['fifo'], scheduler['ring'] = {}, []
    scheduler['source'] = {'p1': {'caller': 'user:a', 'slot': 0, 'owner': owner, 'jobs': jobs, 'started_ms': now}}
    works = {}
    for job_id in jobs:
        key = qc.work_record_key(*qc.split_job_id(job_id))
        works[key] = {**env.get(key), 'state': 'running', 'attempt': 1, 'slot': 0, 'owner': owner}
    env.put({SCHEDULER: qc.validate_scheduler(scheduler), **works})
    return owner, jobs


def test_cleanup_requeues_unexpired_drops_expired_and_bumps_work_versions(env):
    owner, jobs = claimed_scene(env)
    keys = [qc.work_record_key(*qc.split_job_id(job)) for job in jobs]
    versions = {key: env.version(key) for key in keys}
    time.sleep(1.1)
    env_now = qc.wall_ms()
    assert price_launcher.cleanup_slot(env.store, 0, owner)
    scheduler = env.get(SCHEDULER)
    assert scheduler['source'] == {} and env.get(qc.runner_lease_key(0)) is None
    queued = {job for job, value in scheduler['jobs'].items() if value['state'] == 'queued'}
    assert queued == {jobs[0], jobs[1]} and set(scheduler['jobs']) == queued
    assert scheduler['fifo'] == {'user:a': sorted(queued, key=lambda j: (scheduler['jobs'][j]['admitted_ms'], j))} and scheduler['ring'] == ['user:a']
    assert all(env.version(key) != versions[key] for key in keys[:2]) and env.get(keys[0])['state'] == 'queued'
    assert env.get(keys[2]) is None and scheduler['stats']['expired'] == 1


def test_cleanup_ignores_a_slot_held_by_someone_else(env):
    owner, _ = claimed_scene(env)
    version = env.version(SCHEDULER)
    assert price_launcher.cleanup_slot(env.store, 0, owner_nonce())
    assert env.version(SCHEDULER) == version and env.get(qc.runner_lease_key(0))['owner'] == owner


def hold_lock(slot, owner):
    descriptor = os.open(price_launcher.lock_path(slot, owner), os.O_RDWR | os.O_CREAT, 0o600)
    import fcntl
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return descriptor


def test_reclaim_requires_an_expired_same_host_lease_and_a_free_lock(env, monkeypatch):
    owner, _ = claimed_scene(env, expired=True)
    key = qc.runner_lease_key(0)
    # A lease that has not expired is not a candidate.
    assert price_launcher.reclaim_slot(env.store, 0) == 'uncertain'  # expired by construction, but no lock file yet
    lease = env.get(key)
    lease['lease_until_ms'] = qc.wall_ms() - 1
    env.put({key: lease})
    # No lock file: termination is unproven, and the helper must not create one.
    assert price_launcher.reclaim_slot(env.store, 0) == 'uncertain'
    assert not price_launcher.lock_path(0, owner).exists() and env.get(key) is not None
    # Lock held (a SIGSTOP'd process): uncertain.
    descriptor = hold_lock(0, owner)
    try:
        assert price_launcher.reclaim_slot(env.store, 0) == 'uncertain' and env.get(key)['owner'] == owner
    finally:
        os.close(descriptor)
    # Lock free: reclaimed, the lock file removed.
    assert price_launcher.reclaim_slot(env.store, 0) == 'reclaimed'
    assert env.get(key) is None and not price_launcher.lock_path(0, owner).exists()
    assert price_launcher.reclaim_slot(env.store, 0) == 'not_applicable'


def test_reclaim_never_trusts_another_host(env):
    owner, _ = claimed_scene(env, expired=True, host='other-host')
    key = qc.runner_lease_key(0)
    lease = env.get(key)
    lease['lease_until_ms'] = qc.wall_ms() - 1
    env.put({key: lease})
    hold_lock(0, owner)
    os.close(os.open(price_launcher.lock_path(0, owner), os.O_RDWR))
    assert price_launcher.reclaim_slot(env.store, 0) == 'uncertain'
    assert env.get(key)['owner'] == owner


def test_unclaimed_reservation_is_replaceable_only_after_five_seconds(env):
    key = qc.runner_lease_key(1)
    young = qc.new_runner_lease(owner_nonce(), price_launcher.host_id(), qc.wall_ms(), os.getpid())
    env.put({key: young})
    assert price_launcher.reclaim_slot(env.store, 1) == 'not_applicable'
    old = qc.new_runner_lease(owner_nonce(), price_launcher.host_id(), qc.wall_ms() - 6_000, os.getpid())
    env.put({key: old})
    assert price_launcher.reclaim_slot(env.store, 1) == 'reclaimed' and env.get(key) is None


def test_operator_release_frees_a_claimed_slot_without_a_lock_check(env):
    owner, jobs = claimed_scene(env, host='other-host')
    assert price_launcher.release_slot(env.store, 0) == 'released'
    assert env.get(qc.runner_lease_key(0)) is None and env.get(SCHEDULER)['source'] == {}
    assert price_launcher.release_slot(env.store, 0) == 'not_applicable'


def test_operator_script_status_and_release(fs_env):
    owner, _ = claimed_scene(fs_env)
    base = [sys.executable, str(API_DIR.parent / 'scripts' / 'price_runners.py')]
    environment = {**os.environ, **fs_env.variables, 'PYTHONPATH': str(API_DIR)}
    status = json.loads(subprocess.run(base + ['status'], env=environment, capture_output=True, text=True, check=True).stdout)
    assert status['slots']['0']['owner'] == owner and status['slots']['1'] is None and status['source_permits'] == 1
    refused = subprocess.run(base + ['release', '--slot', '0'], env=environment, capture_output=True, text=True)
    assert refused.returncode != 0 and fs_env.get(qc.runner_lease_key(0)) is not None
    done = subprocess.run(base + ['release', '--slot', '0', '--confirm-terminated'], env=environment, capture_output=True, text=True)
    assert done.returncode == 0 and fs_env.get(qc.runner_lease_key(0)) is None


def test_host_id_is_created_once_and_stable(lock_directory):
    first = price_launcher.host_id()
    assert price_launcher.host_id() == first
    assert [p.name for p in lock_directory.iterdir()] == ['host-id']


def test_environment_allowlist_drops_database_and_secrets(monkeypatch, lock_directory):
    for name, value in {'DATABASE_URL': 'postgresql://x', 'INTERNAL_AUTH_SECRET': 's', 'BETTER_AUTH_SECRET': 's',
                        'PUBLIC_PROJECTION_DIR': '/p', 'PYTHONPATH': '/fixture:/api', 'PATH': '/bin', 'LANG': 'C',
                        'NODE_ENV': 'test', 'OTHER': '1'}.items():
        monkeypatch.setenv(name, value)
    environment = price_launcher.runner_environment(price_launcher.lock_dir())
    assert {'PATH', 'LANG', 'NODE_ENV', 'PYTHONPATH', 'PUBLIC_PROJECTION_DIR', 'PRICE_RUNNER_LOCK_DIR'} <= set(environment)
    assert all(name.startswith('PUBLIC_PROJECTION_') or name in {'PATH', 'LANG', 'NODE_ENV', 'PYTHONPATH', 'PRICE_RUNNER_LOCK_DIR'} for name in environment)
    assert environment['PRICE_RUNNER_LOCK_DIR'] == str(lock_directory.resolve())


def test_spawn_reports_failure_without_raising_and_leaves_no_lock(monkeypatch, lock_directory):
    def boom(*args, **kwargs):
        raise OSError('no exec')
    monkeypatch.setattr(subprocess, 'Popen', boom)
    owner = owner_nonce()
    assert price_launcher.spawn(0, owner) is False
    assert not price_launcher.lock_path(0, owner).exists()
    with pytest.raises(ValueError):
        price_launcher.spawn(2, owner)


def test_handoff_reserves_a_slot_only_for_runnable_jobs(env, monkeypatch):
    spawned = []
    monkeypatch.setattr(price_launcher, 'spawn', lambda slot, owner: spawned.append((slot, owner)) or True)
    assert price_runner.handoff(env.store, 0) is False and spawned == []
    seed(env, [{'index': 1, 'card': 'next-1'}])
    assert price_runner.handoff(env.store, 0) is True
    (slot, owner), = spawned
    reservation = env.get(qc.runner_lease_key(slot))
    assert slot == 0 and reservation['owner'] == owner and reservation['state'] == 'reserved'
    assert price_runner.handoff(env.store, 0) is False  # A fresh reservation already serves the queue.
    env.put({qc.runner_lease_key(0): None})
    monkeypatch.setattr(price_launcher, 'spawn', lambda slot, owner: False)
    assert price_runner.handoff(env.store, 0) is False and env.get(qc.runner_lease_key(0)) is None


def test_handoff_leaves_queued_jobs_to_a_healthy_running_slot(env, monkeypatch):
    spawned = []
    monkeypatch.setattr(price_launcher, 'spawn', lambda slot, owner: spawned.append((slot, owner)) or True)
    healthy = running_lease(owner_nonce(), 1)
    healthy['lease_until_ms'] = qc.wall_ms() + 4_000  # Mid-renewal: far less than a full 10 s left, still valid.
    seed(env, [{'index': 1, 'card': 'next-1'}], lease=healthy, slot=1)
    assert price_runner.handoff(env.store, 0) is False and spawned == []
    expired = dict(healthy, lease_until_ms=qc.wall_ms() - 1)
    env.put({qc.runner_lease_key(1): expired})
    assert price_runner.handoff(env.store, 0) is True and spawned[0][0] == 0


def test_runner_store_directory_matches_the_api_even_from_another_working_directory(tmp_path, monkeypatch):
    monkeypatch.delenv('PUBLIC_PROJECTION_DIR', raising=False)
    monkeypatch.chdir(tmp_path)
    expected = str(Path('.local/public-projections').resolve())
    monkeypatch.setenv('PYTHONPATH', 'relative/dir')
    environment = price_launcher.runner_environment(price_launcher.lock_dir())
    assert environment['PUBLIC_PROJECTION_DIR'] == expected
    assert environment['PYTHONPATH'] == str((tmp_path / 'relative' / 'dir').resolve())


# --- Real processes ----------------------------------------------------------------------------------------------------------------
FAKE_SOURCE = '''
import json, os, socket, sys, time, urllib.request, urllib.error
_dir = os.environ["PRICE_RUNNER_LOCK_DIR"]
_config = json.load(open(os.path.join(_dir, "fake-source.json")))

class _Result:
    pass

def fetch(card, may_retry):
    _marker = os.path.join(_dir, "crashed")
    if card in _config.get("crash_once", []) and not os.path.exists(_marker):
        open(_marker, "w").close()
        os._exit(3)  # A worker that dies with a nonzero status before any request.
    with open(os.path.join(_dir, "fake-env.json"), "w") as out:
        json.dump({"env": sorted(os.environ), "psycopg": any(m.split(".")[0] == "psycopg" for m in sys.modules)}, out)
    try:
        socket.create_connection(("192.0.2.1", 9), timeout=0.2)
    except OSError:
        pass
    result = _Result()
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        request = urllib.request.Request(_config["origin"] + "/cards/" + card, headers={"x-fixture-pid": str(os.getpid())})
        with opener.open(request, timeout=_config.get("timeout", 20)) as response:
            result.ok, result.record = True, json.load(response)
    except urllib.error.HTTPError as error:
        result.ok, result.reason, result.status = False, "http_status", error.code
        retry = error.headers.get("Retry-After")
        result.retry_after = int(float(retry)) if retry else None
    except Exception:
        result.ok, result.reason = False, "transport"
    return result
'''
FAKE_RECORD = '''
class Quote:
    def __init__(self, amount, card, variant, provider_updated_at):
        self.amount, self.card, self.variant, self.provider_updated_at = amount, card, variant, provider_updated_at

class Absent:
    pass

def select_quote(record, descriptor, lookup, product_id):
    if record["price"] is None:
        return Absent()
    return Quote(record["price"], lookup["card"], lookup["variant"], record.get("updated"))
'''
SITECUSTOMIZE = '''
import os, sys, types
sys.path.insert(0, {fixture!r})
import price_fixture
price_fixture.install()
if os.path.exists(os.path.join(os.environ.get("PRICE_RUNNER_LOCK_DIR", "/nonexistent"), "fake-source.json")):
    for name, source in (("app.price_source", {source!r}), ("app.tcgdex_record", {record!r})):
        module = types.ModuleType(name)
        exec(compile(source, name, "exec"), module.__dict__)
        sys.modules[name] = module
'''


class FakeSource:
    """A real local HTTP server standing in for TCGdex: per-card price, optional hold until released, request log."""

    def __init__(self):
        self.requests, self.hold, self.lock = [], {}, threading.Lock()
        self.prices = {}
        self.arrived = threading.Event()
        self.live, self.peak, self.callers, self.delay = {}, {'all': 0}, {}, 0.0
        source = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                card = self.path.rsplit('/', 1)[-1]
                pid = self.headers.get('x-fixture-pid')
                with source.lock:
                    source.requests.append((card, time.time()))
                    source.live[card] = pid
                    source.peak['all'] = max(source.peak['all'], len(source.live))
                    for key in {pid, source.callers.get(card)}:
                        count = sum(1 for c, p in source.live.items() if p == key or source.callers.get(c) == key)
                        source.peak[key] = max(source.peak.get(key, 0), count)
                source.arrived.set()
                gate = source.hold.get(card)
                if gate is not None:
                    gate.wait(120)
                time.sleep(source.delay)
                with source.lock:
                    source.live.pop(card, None)
                body = json.dumps({'price': source.prices.get(card, '1.25'), 'updated': '2026-10-02T00:00:00Z'}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except OSError:
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def close(self):
        for gate in self.hold.values():
            gate.set()
        self.server.shutdown()


@pytest.fixture
def proc(tmp_path, lock_directory, monkeypatch):
    """Everything a launched runner needs: fake source, test sitecustomize on PYTHONPATH, secrets that must not leak."""
    source = FakeSource()
    lock_directory.mkdir(parents=True, exist_ok=True)
    (lock_directory / 'fake-source.json').write_text(json.dumps({'origin': source.origin}))
    hooks = tmp_path / 'hooks'
    hooks.mkdir()
    (hooks / 'sitecustomize.py').write_text(SITECUSTOMIZE.format(fixture=str(FIXTURE_DIR), source=FAKE_SOURCE, record=FAKE_RECORD))
    monkeypatch.setenv('PYTHONPATH', f'{hooks}{os.pathsep}{API_DIR}')
    monkeypatch.setenv('DATABASE_URL', 'postgresql://secret@127.0.0.1:1/none')
    monkeypatch.setenv('INTERNAL_AUTH_SECRET', 'must-not-leak')
    started = []  # Process-group ids (each runner is its own session leader) of runners THIS test launched.
    real_popen = subprocess.Popen

    class Recording(real_popen):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            started.append(self.pid)
    monkeypatch.setattr(subprocess, 'Popen', Recording)
    yield source, started
    source.close()
    for pid in set(started):
        try:
            os.killpg(pid, signal.SIGCONT)
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    wait_for(lambda: not group_processes(started), timeout=5)  # Only this test's processes; other runs' runners are untouched.


def group_processes(groups):
    """Pids currently alive in the given process groups."""
    out = subprocess.run(['ps', '-ax', '-o', 'pid=,pgid='], capture_output=True, text=True).stdout.split()
    wanted = {int(group) for group in groups}
    return [int(pid) for pid, pgid in zip(out[::2], out[1::2]) if int(pgid) in wanted]


def reserve_and_spawn(env, started, slot=0, *, reserved_ms=None):
    owner = owner_nonce()
    now = qc.wall_ms()
    reservation = qc.new_runner_lease(owner, price_launcher.host_id(), reserved_ms or now, os.getpid())
    env.put({qc.runner_lease_key(slot): reservation})
    committed = time.time()
    assert price_launcher.spawn(slot, owner) is True
    return owner, committed


def wait_for(predicate, timeout=15, step=0.02):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    raise AssertionError('timed out')


def supervisor_pid(env, slot=0):
    lease = wait_for(lambda: (env.get(qc.runner_lease_key(slot)) or {}).get('supervisor_pid') and env.get(qc.runner_lease_key(slot)))
    return lease['supervisor_pid'], lease['worker_pid']


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_launched_runner_serves_a_job_with_a_clean_environment_and_exits_when_idle(env, proc, lock_directory):
    source, started = proc
    seed(env, [{'index': 1, 'card': 'base1-1'}])
    owner, _ = reserve_and_spawn(env, started)
    supervisor, worker = supervisor_pid(env)
    started.append(supervisor)
    wait_for(lambda: env.get(result_key(ref(1), 1)))
    wrote = time.monotonic()
    assert env.get(quote_key(ref(1), 1))['amount'] == '1.25'
    wait_for(lambda: not alive(supervisor) and not alive(worker), timeout=5)
    assert time.monotonic() - wrote <= 2.3
    assert env.get(qc.runner_lease_key(0)) is None and env.get(SCHEDULER)['source'] == {}
    assert not price_launcher.lock_path(0, owner).exists()
    seen = json.loads((lock_directory / 'fake-env.json').read_text())
    assert 'DATABASE_URL' not in seen['env'] and 'INTERNAL_AUTH_SECRET' not in seen['env'] and seen['psycopg'] is False
    # The CI connect guard armed in the launched runner: the non-loopback attempt was refused and logged.
    assert '192.0.2.1' in (lock_directory / 'guard-violations.log').read_text()


def test_late_or_foreign_claim_exits_without_any_source_io(fs_env, proc):
    source, started = proc
    seed(fs_env, [{'index': 1, 'card': 'base1-1'}])
    owner, _ = reserve_and_spawn(fs_env, started, reserved_ms=qc.wall_ms() - 6_000)
    lease = fs_env.get(qc.runner_lease_key(0))
    time.sleep(1.5)
    assert source.requests == [] and fs_env.get(qc.runner_lease_key(0)) == lease and lease['state'] == 'reserved'
    assert fs_env.get(result_key(ref(1), 1)) is None
    assert not price_launcher.lock_path(0, owner).exists()      # F6: a supervisor whose claim failed removes its lock file


def test_cold_start_from_admission_commit_to_first_request(fs_env, proc):
    source, started = proc
    samples = []
    for number in range(20):
        source.arrived.clear()
        source.requests.clear()
        seed(fs_env, [{'index': number + 1, 'card': f'cold-{number}'}], scheduler=fs_env.get(SCHEDULER) or None)
        owner, committed = reserve_and_spawn(fs_env, started)
        assert source.arrived.wait(10)
        samples.append(source.requests[0][1] - committed)
        supervisor, worker = supervisor_pid(fs_env)
        wait_for(lambda: fs_env.get(result_key(ref(number + 1), 1)))
        wait_for(lambda: not alive(supervisor), timeout=6)
        wait_for(lambda: fs_env.get(qc.runner_lease_key(0)) is None)
    samples.sort()
    p95 = samples[int(len(samples) * 0.95) - 1]
    print(f'cold start s: min={samples[0]:.3f} median={samples[len(samples) // 2]:.3f} p95={p95:.3f} max={samples[-1]:.3f}')
    assert p95 <= 0.6, samples


def test_sigkilled_group_is_reclaimed_through_the_lock_with_one_extra_fetch(env, proc, monkeypatch):
    source, started = proc
    source.hold['kill-1'] = threading.Event()
    seed(env, [{'index': 1, 'card': 'kill-1'}])
    owner, _ = reserve_and_spawn(env, started)
    supervisor, worker = supervisor_pid(env)
    started.append(supervisor)
    assert source.arrived.wait(10)
    os.killpg(supervisor, signal.SIGKILL)
    wait_for(lambda: not alive(supervisor) and not alive(worker), timeout=5)
    real = qc.wall_ms
    monkeypatch.setattr(qc, 'wall_ms', lambda: real() + 11_000)  # Past the 10 s lease; the job (60 s) is still unexpired.
    assert price_launcher.reclaim_slot(env.store, 0) == 'reclaimed'
    monkeypatch.setattr(qc, 'wall_ms', real)
    scheduler = env.get(SCHEDULER)
    assert scheduler['source'] == {} and [job['state'] for job in scheduler['jobs'].values()] == ['queued']
    source.hold['kill-1'].set()
    reserve_and_spawn(env, started)
    wait_for(lambda: env.get(result_key(ref(1), 1)))
    assert len(source.requests) == 2 and env.get(result_key(ref(1), 1))['attempt'] == 2
    assert env.get(qc.fence_record_key(ref(1), 1))['attempt'] == 2 and env.get(qc.work_record_key(ref(1), 1)) is None
    wait_for(lambda: env.get(qc.runner_lease_key(0)) is None, timeout=6)


def test_sigstopped_runner_is_not_replaced_and_completes_after_sigcont(fs_env, proc, monkeypatch):
    source, started = proc
    source.hold['stop-1'] = threading.Event()
    seed(fs_env, [{'index': 1, 'card': 'stop-1'}])
    owner, _ = reserve_and_spawn(fs_env, started)
    supervisor, worker = supervisor_pid(fs_env)
    started.append(supervisor)
    assert source.arrived.wait(10)
    before = fs_env.get(qc.runner_lease_key(0))['lease_until_ms']
    os.killpg(supervisor, signal.SIGSTOP)
    stopped = time.monotonic()
    time.sleep(11.2)  # Past the 10 s lease, in real time.
    assert fs_env.get(qc.runner_lease_key(0))['lease_until_ms'] < qc.wall_ms()
    assert price_launcher.reclaim_slot(fs_env.store, 0) == 'uncertain'  # The lock is still held: never replaced.
    assert fs_env.get(qc.runner_lease_key(0))['owner'] == owner and time.monotonic() - stopped > 11
    os.killpg(supervisor, signal.SIGCONT)
    # Renewal resumes at once: the lease runs out again no sooner than ten seconds from now, not from the claim.
    renewed = wait_for(lambda: fs_env.get(qc.runner_lease_key(0))['lease_until_ms'] > qc.wall_ms() and fs_env.get(qc.runner_lease_key(0)), timeout=5)
    assert renewed['lease_until_ms'] > before + 10_000 and renewed['owner'] == owner
    source.hold['stop-1'].set()
    wait_for(lambda: fs_env.get(result_key(ref(1), 1)))
    assert fs_env.get(result_key(ref(1), 1))['attempt'] == 1 and len(source.requests) == 1
    wait_for(lambda: fs_env.get(qc.runner_lease_key(0)) is None, timeout=6)  # Cleanup still frees the slot normally.


def test_two_runner_processes_respect_slot_caller_and_global_caps(env, proc):
    source, started = proc
    source.delay = 0.4
    callers = {f'cap-{i}': f'user:{"abcde"[i % 5]}' for i in range(12)}
    source.callers = callers
    seed(env, [{'index': i + 1, 'card': f'cap-{i}', 'caller': callers[f'cap-{i}']} for i in range(12)])
    reserve_and_spawn(env, started, 0)
    reserve_and_spawn(env, started, 1)
    pids = {}
    for slot in (0, 1):
        supervisor, worker = supervisor_pid(env, slot)
        started.append(supervisor)
        pids[str(worker)] = slot
    counts, sampling = [], threading.Event()

    def sample():
        while not sampling.is_set():
            counts.append(len(group_processes(started)))
            time.sleep(0.05)
    sampler = threading.Thread(target=sample)
    sampler.start()
    try:
        for i in range(12):
            wait_for(lambda: env.get(result_key(ref(i + 1), 1)), timeout=40)
    finally:
        sampling.set()
        sampler.join()
    assert 2 <= max(counts) <= 4  # A supervisor and a worker per slot, never more.
    assert source.peak['all'] <= 8
    for pid, slot in pids.items():
        assert source.peak.get(pid, 0) <= 4, (pid, slot)
    assert all(source.peak.get(caller, 0) <= 2 for caller in set(callers.values()))
    assert sorted(card for card, _ in source.requests) == sorted(callers)  # One fetch per card.


def test_hanging_worker_is_killed_at_the_sixty_five_second_hard_stop(fs_env, proc, lock_directory):
    source, started = proc
    source.hold['hang-1'] = threading.Event()
    (lock_directory / 'fake-source.json').write_text(json.dumps({'origin': source.origin, 'timeout': 200}))
    seed(fs_env, [{'index': 1, 'card': 'hang-1'}])
    owner, _ = reserve_and_spawn(fs_env, started)
    supervisor, worker = supervisor_pid(fs_env)
    started.append(supervisor)
    claimed = fs_env.get(qc.runner_lease_key(0))['claimed_ms']
    assert fs_env.get(qc.runner_lease_key(0))['hard_stop_ms'] - claimed == 65_000
    start = time.monotonic()
    wait_for(lambda: not alive(worker), timeout=75, step=0.2)
    elapsed = time.monotonic() - start
    assert 55 <= elapsed <= 72
    wait_for(lambda: fs_env.get(qc.runner_lease_key(0)) is None, timeout=10)
    scheduler = fs_env.get(SCHEDULER)
    assert scheduler['source'] == {} and scheduler['jobs'] == {}  # The 60 s job expired and was dropped by the cleanup CAS.
    assert fs_env.get(result_key(ref(1), 1)) is None and not alive(supervisor)
    assert price_launcher.reclaim_slot(fs_env.store, 0) == 'not_applicable'


# --- Review fixes: reclaim from the request path, deadlines, uncertain slots ------------------------------------------------------
def admit_rows(env, indexes, cards, *, seconds=3.0, caller='user:a'):
    """Admission the way the route runs it: states from ``quote_states``, a trusted budget, the real launcher."""
    pairs = [(ref(i), 1) for i in indexes]
    states = quote_states(env.store, pairs, deadline=deadline())
    rows = [price_refresh.Row(i, ref(i), 1, {'card': cards[i], 'variant': 'normal'}, 1000 + i, states[(ref(i), 1)]) for i in indexes]
    return price_refresh.evaluate_and_admit(rows, caller, Budget(hard=time.monotonic() + seconds, caller=caller), env.store)


def expire_lease(env, slot=0):
    key = qc.runner_lease_key(slot)
    lease = env.get(key)
    lease['lease_until_ms'] = qc.wall_ms() - 1
    env.put({key: lease})


def kill_runner(env, started, source, card):
    """Spawn a runner, let its fetch reach the source (the pre-write pause), SIGKILL the whole group, expire its lease."""
    source.hold[card] = threading.Event()
    owner, _ = reserve_and_spawn(env, started)
    supervisor, worker = supervisor_pid(env)
    started.append(supervisor)
    assert source.arrived.wait(10)
    os.killpg(supervisor, signal.SIGKILL)
    wait_for(lambda: not alive(supervisor) and not alive(worker), timeout=5)
    expire_lease(env)
    return owner


def test_the_next_access_reclaims_a_sigkilled_runner_and_the_hard_row_completes(env, proc):
    source, started = proc
    seed(env, [{'index': 1, 'card': 'kill-1'}])
    dead = kill_runner(env, started, source, 'kill-1')
    source.hold['kill-1'].set()
    begin = time.monotonic()
    admission = admit_rows(env, [1], {1: 'kill-1'})
    admission.wait()
    elapsed = time.monotonic() - begin
    assert admission.outcomes[1].refresh == 'refreshed' and elapsed < 2.4, (admission.outcomes[1], elapsed)
    state = state_of(env, 1)
    assert state['result']['state'] == 'quote' and state['result']['attempt'] == state['fence']['attempt'] == 2
    assert len(source.requests) == 2 and state['work'] is None
    assert not price_launcher.lock_path(0, dead).exists()
    admission.release()
    wait_for(lambda: env.get(qc.runner_lease_key(0)) is None, timeout=6)
    assert env.get(SCHEDULER)['source'] == {}


def test_a_runner_killed_before_its_write_and_reclaimed_never_resurrects_the_old_quote(env, proc):
    source, started = proc
    source.prices['kill-2'] = None                                         # the source now says the Edition has no price
    seed(env, [{'index': 1, 'card': 'kill-2'}])
    env.put({result_key(ref(1), 1): qc.new_quote_result(1, qc.wall_ms() - 25 * 3_600_000),
             quote_key(ref(1), 1): qc.new_quote_payload(1, '7.00', 'kill-2', 'normal', None), qc.fence_record_key(ref(1), 1): qc.new_fence(1)})
    before = {name: env.get(key) for name, key in (('result', result_key(ref(1), 1)), ('quote', quote_key(ref(1), 1)))}
    kill_runner(env, started, source, 'kill-2')
    assert {name: env.get(key) for name, key in (('result', result_key(ref(1), 1)), ('quote', quote_key(ref(1), 1)))} == before
    source.hold['kill-2'].set()
    admission = admit_rows(env, [1], {1: 'kill-2'})
    admission.wait()
    state = state_of(env, 1)
    assert admission.outcomes[1].refresh == 'refreshed'
    assert state['result']['state'] == 'absent' and state['quote'] is None and state['result']['attempt'] == state['fence']['attempt'] == 3
    admission.release()


def test_a_stopped_runner_with_an_expired_lease_is_uncertain_at_once_and_recorded(fs_env, proc):
    source, started = proc
    source.hold['stop-2'] = threading.Event()
    seed(fs_env, [{'index': 1, 'card': 'stop-2'}])
    owner, _ = reserve_and_spawn(fs_env, started)
    supervisor, worker = supervisor_pid(fs_env)
    started.append(supervisor)
    assert source.arrived.wait(10)
    os.killpg(supervisor, signal.SIGSTOP)
    expire_lease(fs_env)
    begin = time.monotonic()
    admission = admit_rows(fs_env, [1], {1: 'stop-2'})
    admission.wait()
    elapsed = time.monotonic() - begin
    assert admission.outcomes[1].refresh == 'busy' and admission.outcomes[1].reason == 'runner_uncertain' and elapsed < 0.3, elapsed
    assert fs_env.get(qc.runner_lease_key(0))['owner'] == owner
    admission.release()
    assert fs_env.get(SCHEDULER)['stats']['refused'].get('runner_uncertain', 0) >= 1
    os.killpg(supervisor, signal.SIGCONT)
    source.hold['stop-2'].set()
    wait_for(lambda: fs_env.get(result_key(ref(1), 1)))


def test_a_crashed_worker_leaves_its_jobs_queued_and_hands_off_to_nobody(fs_env, proc, lock_directory):
    source, started = proc
    (lock_directory / 'fake-source.json').write_text(json.dumps({'origin': source.origin, 'crash_once': ['crash-1']}))
    seed(fs_env, [{'index': 1, 'card': 'crash-1'}])
    reserve_and_spawn(fs_env, started)
    supervisor, worker = supervisor_pid(fs_env)
    started.append(supervisor)
    wait_for(lambda: not alive(supervisor), timeout=10)
    time.sleep(2.5)                                                       # a successor would have started and served the job
    assert (lock_directory / 'crashed').exists()
    assert fs_env.get(qc.runner_lease_key(0)) is None and fs_env.get(result_key(ref(1), 1)) is None
    assert source.requests == [] and [job['state'] for job in fs_env.get(SCHEDULER)['jobs'].values()] == ['queued']


# --- Review fixes: store-level launcher helpers -----------------------------------------------------------------------------------
class Stalled:
    """Every store call sleeps up to ``delay`` (never past its own deadline) and then fails."""

    def __init__(self, store, delay):
        self.store, self.delay, self.calls = store, delay, 0

    def _stall(self, deadline):
        self.calls += 1
        time.sleep(max(0.0, min(self.delay, deadline - time.monotonic())))
        raise ProjectionUnavailable()

    def read_records(self, keys, *, deadline, generation=None):
        self._stall(deadline)

    def compare_and_swap(self, expected, changes, *, deadline, operation_id=None):
        self._stall(deadline)

    def operation_status(self, operation_id, *, deadline):
        self._stall(deadline)


def test_launcher_helpers_stop_at_an_absolute_deadline(env):
    owner, _ = claimed_scene(env, expired=True)
    stalled = Stalled(env.store, 5.0)
    begin = time.monotonic()
    assert price_launcher.cleanup_slot(stalled, 0, owner, deadline=begin + 0.4) is False
    assert time.monotonic() - begin < 0.7
    begin = time.monotonic()
    assert price_launcher.reclaim_slot(stalled, 0, deadline=begin + 0.4, attempts=1) == 'uncertain'
    assert time.monotonic() - begin < 0.7
    begin = time.monotonic()
    assert price_launcher.commit(stalled, {SCHEDULER: 'x'}, {SCHEDULER: {}}, 'op-1', deadline=begin + 0.4) is False
    assert time.monotonic() - begin < 0.7
    begin = time.monotonic()
    with pytest.raises(ProjectionUnavailable):
        price_launcher.read(stalled, [SCHEDULER], deadline=begin + 0.3)
    assert time.monotonic() - begin < 0.6


def test_a_reclaim_writes_a_fresh_reservation_in_the_same_cas(env):
    owner, jobs = claimed_scene(env, expired=True)
    key = qc.runner_lease_key(0)
    lease = env.get(key)
    lease['lease_until_ms'] = qc.wall_ms() - 1
    env.put({key: lease})
    os.close(os.open(price_launcher.lock_path(0, owner), os.O_RDWR | os.O_CREAT, 0o600))
    successor = owner_nonce()
    assert price_launcher.reclaim_slot(env.store, 0, replace_with=successor) == 'reclaimed'
    fresh = qc.validate_runner_lease(env.get(key))
    assert fresh['owner'] == successor and fresh['state'] == 'reserved' and fresh['host'] == price_launcher.host_id()
    assert fresh['launcher_pid'] == os.getpid() and env.get(SCHEDULER)['source'] == {}
    # Someone else already replaced the slot: nothing is written and nothing is claimed to have been reclaimed.
    assert price_launcher.reclaim_slot(env.store, 0, replace_with=owner_nonce()) == 'not_applicable'
    assert env.get(key)['owner'] == successor


# --- Review fixes: runner loop (F3, F4, F6) -------------------------------------------------------------------------------------------
def test_a_corrupt_scheduler_or_source_backoff_is_nothing_to_claim_not_a_crash(fs_env):
    owner = owner_nonce()
    seed(fs_env, [], lease=running_lease(owner))
    fs_env.put({SCHEDULER: {'v': 1, 'bogus': True}})
    assert make_worker(fs_env, owner, ok_fetcher()).run() == 'idle'
    seed(fs_env, [{'index': 1, 'card': 'base1-1'}], scheduler=None)
    fs_env.put({qc.source_backoff_key(): {'junk': 1}})
    assert make_worker(fs_env, owner, ok_fetcher()).run() == 'idle'


def test_source_backoff_is_validated_and_clamped_to_one_hour_after_it_is_set(fs_env):
    now = qc.wall_ms()
    fs_env.put({qc.source_backoff_key(): qc.new_source_backoff('retry_after', now + 10 * 3_600_000 + 3_600_000, now + 10 * 3_600_000)})
    worker = make_worker(fs_env, owner_nonce(), ok_fetcher(), hard_stop=now + 60_000)
    worker.set_source_backoff(price_runner.Outcome('failure', reason='http_status', retry_after_s=3_600.0, rate_limited=True))
    record = qc.validate_source_backoff(fs_env.get(qc.source_backoff_key()))
    assert record['retry_ms'] - record['set_ms'] <= 3_600_000 and record['retry_ms'] <= qc.wall_ms() + 3_600_000


class LostClaim:
    """The claim CAS commits and the answer, including the operation status, is lost."""

    def __init__(self, store):
        self.store, self.lost = store, 0

    def __getattr__(self, name):
        return getattr(self.store, name)

    def compare_and_swap(self, expected, changes, *, deadline, operation_id=None):
        done = self.store.compare_and_swap(expected, changes, deadline=deadline, operation_id=operation_id)
        if operation_id and operation_id.startswith('claim:') and not self.lost:
            self.lost += 1
            raise ProjectionUnavailable()
        return done

    def operation_status(self, operation_id, *, deadline):
        raise ProjectionUnavailable()


def test_a_lost_claim_answer_does_not_strand_the_claim(env):
    owner = owner_nonce()
    seed(env, [{'index': 1, 'card': 'base1-1'}], lease=running_lease(owner))
    lossy = LostClaim(env.store)
    worker = price_runner.Worker(lossy, 0, owner, env.get(qc.runner_lease_key(0))['hard_stop_ms'], fetcher=ok_fetcher(),
                                 selector=select_by_record, idle_s=0.3, poll_s=0.02)
    assert worker.run() == 'idle' and lossy.lost == 1
    assert state_of(env, 1)['result']['state'] == 'quote' and env.get(SCHEDULER)['jobs'] == {}
    assert env.get(SCHEDULER)['source'] == {}


def test_a_lost_claim_race_pauses_with_jitter_before_retrying(fs_env, monkeypatch):
    pauses = []
    monkeypatch.setattr(price_runner, '_retry_pause', lambda: pauses.append(1))
    owner = owner_nonce()
    seed(fs_env, [], lease=running_lease(owner))
    worker = make_worker(fs_env, owner, ok_fetcher())
    answers = iter(['retry', 'retry'])
    worker.try_claim = lambda: next(answers, 'none')
    assert worker.run() == 'idle' and len(pauses) == 2


def test_operator_release_accepts_an_invalid_lease_and_the_script_prints_no_traceback(fs_env):
    owner = owner_nonce()
    key = qc.runner_lease_key(0)
    fs_env.put({key: {'v': 1, 'owner': owner, 'state': 'bogus'}})
    assert price_launcher.release_slot(fs_env.store, 0) == 'released' and fs_env.get(key) is None
    fs_env.put({key: {'junk': True}})
    base = [sys.executable, str(API_DIR.parent / 'scripts' / 'price_runners.py')]
    environment = {**os.environ, **fs_env.variables, 'PYTHONPATH': str(API_DIR)}
    done = subprocess.run(base + ['release', '--slot', '0', '--confirm-terminated'], env=environment, capture_output=True, text=True)
    assert 'Traceback' not in done.stderr and fs_env.get(key) is None and done.returncode == 0
    broken = subprocess.run(base + ['release', '--slot', '0', '--confirm-terminated'], env={**environment, 'PUBLIC_PROJECTION_DIR': '/nonexistent/x'},
                            capture_output=True, text=True)
    assert 'Traceback' not in broken.stderr and broken.returncode == 1


# --- Review fixes: handoff shares the admission slot predicate (M3.6) -------------------------------------------------------------------
def test_handoff_treats_a_stale_reservation_as_free_and_survives_a_malformed_lease(env, monkeypatch):
    spawned = []
    monkeypatch.setattr(price_launcher, 'spawn', lambda slot, owner: spawned.append((slot, owner)) or True)
    seed(env, [{'index': 1, 'card': 'next-1'}])
    stale = qc.new_runner_lease(owner_nonce(), price_launcher.host_id(), qc.wall_ms() - 6_000, os.getpid())
    env.put({qc.runner_lease_key(0): stale, qc.runner_lease_key(1): {'junk': True}})
    assert price_runner.handoff(env.store, 1) is True
    (slot, owner), = spawned
    assert slot == 0 and env.get(qc.runner_lease_key(0))['owner'] == owner and env.get(qc.runner_lease_key(1)) == {'junk': True}


def test_handoff_reserves_the_second_slot_when_more_than_four_jobs_wait(env, monkeypatch):
    spawned = []
    monkeypatch.setattr(price_launcher, 'spawn', lambda slot, owner: spawned.append((slot, owner)) or True)
    seed(env, [{'index': i, 'card': f'next-{i}', 'caller': f'user:{"abcde"[i % 5]}'} for i in range(1, 6)])
    assert price_runner.handoff(env.store, 0) is True
    assert sorted(slot for slot, _ in spawned) == [0, 1]
    assert price_runner.handoff(env.store, 0) is False                   # two fresh reservations already cover the queue


# --- Review fixes: AC5 and capacity ------------------------------------------------------------------------------------------------------
def test_runner_writes_leave_catalog_quarantine_and_printing_versions_unchanged(env):
    keys = [catalog_edition_key(ref(1)), quarantine_key(ref(1)), catalog_printing_key(ref(1 + 5000))]
    seed(env, [{'index': 1, 'card': 'base1-1'}, {'index': 2, 'card': 'base1-2'}])
    env.put({keys[2]: {'printing': 'fixture'}})
    keys += [catalog_edition_key(ref(2)), quarantine_key(ref(2))]
    before = {key: env.version(key) for key in keys}
    run_worker_on_seeded(env, ok_fetcher())
    assert {key: env.version(key) for key in keys} == before
    assert state_of(env, 1)['result']['state'] == 'quote' and state_of(env, 2)['result']['state'] == 'quote'


def run_worker_on_seeded(env, fetcher):
    owner = owner_nonce()
    env.put({qc.runner_lease_key(0): running_lease(owner)})
    assert make_worker(env, owner, fetcher).run() == 'idle'


def test_a_store_at_capacity_keeps_the_absent_result_the_runner_wrote(tmp_path, monkeypatch):
    config = {'adapter': 'filesystem', 'directory': str(tmp_path / 'records'), 'max_entries': 1}
    Path(config['directory']).mkdir()
    backend_from_config(config).initialize(deadline=deadline())
    small = Env(store_from_config(config), {})
    seed(small, [{'index': 1, 'card': 'gone-1'}, {'index': 2, 'card': 'busy-2', 'caller': 'user:b'}, {'index': 3, 'card': 'busy-3', 'caller': 'user:c'}])
    prices = {'gone-1': None, 'busy-2': '2.00', 'busy-3': '3.00'}

    def fetch(card, may_retry):
        return Fetched({'price': prices[card], 'updated': None})
    run_worker_on_seeded(small, fetch)
    one = state_of(small, 1)
    assert one['result']['state'] == 'absent' and one['quote'] is None
    assert one['result']['expires_at'] > one['result']['checked_at']
