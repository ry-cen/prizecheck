"""Rev3 take-back contract. Tests-only commit D intentionally fails T4, the amended
T10/T11 cases, cancelling T12 cases, T14, T15, both-suspended and selected lift
orderings, and the sentinel check. No xfail hides the baseline. T13 and the bulk
closure parity/dedup regression should pass before and after the production fix.
"""
import os
import sys
import traceback
import time
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import contextmanager
from threading import Event, Lock, current_thread
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest

from app import loan_inventory, loan_picks
from app.main import connect  # noqa: F401
from app.social import loans
from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import store  # noqa: F401
from test_deck_counting import hold
from test_friend_copies import collector, befriend, ok, place
from test_holdings import call
from test_loans import accept, pair, sent, view
from want_list_swap_fixtures import seed_swap_catalog


@contextmanager
def race(deadline_s=10):
    """Test-only bounded cleanup, including cancellation of real PostgreSQL backends."""
    watch = psycopg.connect(os.environ['DATABASE_URL'], autocommit=True)
    executor = ThreadPoolExecutor(max_workers=4)
    futures, events, holders, pids = [], [], [], {}
    workers = {}
    r = SimpleNamespace(watch=watch, executor=executor, events=events, holders=holders,
                        pids=pids, deadline=time.monotonic() + deadline_s, cleanup=[])
    r.left = lambda: max(0, r.deadline - time.monotonic())
    def submit(*args, **kwargs):
        def request():
            worker = current_thread()
            state = {'thread': worker.name, 'native_id': worker.native_id,
                     'process_pid': os.getpid(), 'state': 'running', 'call': args[0].__name__}
            workers[worker.ident] = state
            try:
                return args[0](*args[1:], **kwargs)
            finally:
                state['state'] = 'returned'
        future = executor.submit(request)
        futures.append(future)
        return future
    r.submit = submit
    def wait_until(predicate, what):
        while not predicate():
            assert r.left() > 0, (what, r.lock_graph())
            time.sleep(0.01)
    r.wait_until = wait_until
    r.blocked_by = lambda pid, by: bool(watch.execute("""SELECT 1 FROM pg_stat_activity
      WHERE pid=%s AND wait_event_type='Lock' AND %s=ANY(pg_blocking_pids(pid))""", (pid, by)).fetchone())
    r.lock_graph = lambda: watch.execute("""SELECT l.pid,l.locktype,l.relation::regclass AS rel,l.page,l.tuple,
      l.transactionid,l.virtualxid,l.mode,l.granted,pg_blocking_pids(l.pid) AS blocked_by,
      a.wait_event_type,a.wait_event FROM pg_locks l JOIN pg_stat_activity a USING(pid)
      WHERE l.pid=ANY(%s) ORDER BY l.pid,l.granted""", (list(pids.values()),)).fetchall()
    passed, cancelled, errors, graph, survivors = False, False, [], [], []
    gate_errors = []
    def cleanup_call(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            errors.append(exc)
            return None
    try:
        yield r
        passed = True
    finally:
        try:
            for event in events:
                cleanup_call(event.set)
            for holder in holders:
                try:
                    cleanup_call(holder.rollback)
                finally:
                    cleanup_call(holder.close)
            _, unfinished = wait(futures, timeout=r.left())
            if unfinished:
                graph = cleanup_call(r.lock_graph)
                print('RACE CLEANUP: cancelling unfinished requests', graph, flush=True)
                for pid in set(pids.values()):
                    if cleanup_call(lambda: watch.execute('SELECT 1 FROM pg_stat_activity WHERE pid=%s', (pid,)).fetchone()):
                        # Continue cancelling other backends even if one cancellation fails.
                        cleanup_call(watch.execute, 'SELECT pg_cancel_backend(%s)', (pid,))
                        cancelled = True
                until = time.monotonic() + 3
                while time.monotonic() < until and cleanup_call(lambda: watch.execute(
                        'SELECT 1 FROM pg_stat_activity WHERE pid=ANY(%s)', (list(pids.values()),)).fetchone()):
                    time.sleep(0.01)
                for pid in set(pids.values()):
                    if cleanup_call(lambda: watch.execute('SELECT 1 FROM pg_stat_activity WHERE pid=%s', (pid,)).fetchone()):
                        cleanup_call(watch.execute, 'SELECT pg_terminate_backend(%s)', (pid,))
        finally:
            # One shared five-second budget covers result collection AND worker joins.
            # A Future timeout cannot stop its thread, so shutdown must never wait unboundedly.
            finish = time.monotonic() + 5
            try:
                for future in futures:
                    cleanup_call(future.result, timeout=max(0, finish - time.monotonic()))
            finally:
                try:
                    cleanup_call(executor.shutdown, wait=False, cancel_futures=True)
                    for worker in tuple(executor._threads):
                        cleanup_call(worker.join, timeout=max(0, finish - time.monotonic()))
                    backend_states = cleanup_call(lambda: watch.execute(
                        'SELECT pid,state,wait_event_type,wait_event FROM pg_stat_activity WHERE pid=ANY(%s)',
                        (list(pids.values()),)).fetchall())
                    frames = sys._current_frames()
                    for worker in tuple(executor._threads):
                        if worker.is_alive():
                            state = dict(workers.get(worker.ident, {}))
                            state.update(thread=worker.name, native_id=worker.native_id,
                                         process_pid=os.getpid(), alive=True,
                                         backend_pids=dict(pids), backend_states=backend_states,
                                         futures=[str(future) for future in futures],
                                         stack=traceback.format_stack(frames[worker.ident]) if worker.ident in frames else [])
                            survivors.append(state)
                finally:
                    # Release every test gate before DROP can need a lock held by a gated request.
                    # Closing watch also releases its session locks if the explicit unlock fails.
                    try:
                        cleanup_call(watch.execute, 'SELECT pg_advisory_unlock_all()')
                    finally:
                        try:
                            cleanup_call(watch.close)
                        finally:
                            for cleanup in reversed(r.cleanup):
                                try:
                                    cleanup()
                                except Exception as exc:
                                    gate_errors.append(exc)
                                    errors.append(exc)
        if survivors:
            raise AssertionError(('race workers survived bounded teardown', survivors, errors))
        if gate_errors:
            raise AssertionError(('race gate cleanup failed', gate_errors))
        if passed:
            assert not cancelled, ('cleanup cancelled a backend', graph)
            if errors:
                raise errors[0]
        elif errors:
            print('RACE CLEANUP ERRORS', errors, flush=True)


def world(borrower_low=True, accepted=True, edition=None):
    edition = edition or seed_swap_catalog()['PAL 185']
    low, high = pair(ordered=True)
    b, l = (low, high) if borrower_low else (high, low)
    assert (b < l) is borrower_low
    hold(l, place(l, 'Binder'), edition, 8)
    q = sent(b, l, [(edition, 2)])
    if accepted:
        q = ok(accept(l, view(l, q), [(edition, 2)]))
    return edition, b, l, q


def command(user, q, action, revision=None, key=None, **extra):
    return call('POST', f"/api/loans/{q['thread_id']}/{action}", user, {
        'loan_id': q['loan_id'], 'revision': revision if revision is not None else view(user, q)['revision'],
        'idempotency_key': str(key or uuid4()), **extra})


def observe(r, monkeypatch):
    original = loans.begin_owner_command
    replayed = {}
    mutex = Lock()
    def identify(conn, user, *args, **kwargs):
        with mutex:
            name = user if user not in r.pids else f'{user}:retry'
            r.pids[name] = conn.execute('SELECT pg_backend_pid() AS pid').fetchone()['pid']
        result = original(conn, user, *args, **kwargs)
        replayed[name] = result[1] is not None
        return result
    monkeypatch.setattr(loans, 'begin_owner_command', identify)
    return replayed


def pause(r, monkeypatch, user, rollback=False):
    paused, release = Event(), Event()
    r.events.append(release)
    original = loan_inventory.run_step
    calls, mutex = [], Lock()
    def held(who, qid, step, action, apply, locks, *args, **kwargs):
        def boundary(conn, row):
            with mutex:
                calls.append(who)
                first = len(calls) == 1
            if who == user and first:
                paused.set()
                assert release.wait(timeout=r.left()), 'paused step was not released'
                if rollback:
                    raise psycopg.errors.DeadlockDetected('test leader rollback')
            return apply(conn, row)
        return original(who, qid, step, action, boundary, locks, *args, **kwargs)
    monkeypatch.setattr(loan_inventory, 'run_step', held)
    return paused, release, calls


def row(q):
    with connect() as conn:
        return conn.execute('SELECT * FROM loan WHERE id=%s', (q['loan_id'],)).fetchone()


def count(table, q):
    with connect() as conn:
        return conn.execute(f'SELECT count(*) AS n FROM {table} WHERE loan_id=%s', (q['loan_id'],)).fetchone()['n']


@pytest.mark.parametrize('borrower_low', [True, False])
@pytest.mark.parametrize('variant', ['frozen', 'next'])
def test_both_sides_on_one_loan_take_turns_on_the_loan_row(store, monkeypatch, borrower_low, variant):
    _, b, l, q = world(borrower_low)
    rev, key = q['revision'], uuid4()
    with race() as r:
        observe(r, monkeypatch)
        paused, release, _ = pause(r, monkeypatch, l)
        a = r.submit(command, l, q, 'handover', rev)
        r.wait_until(paused.is_set, 'leader not paused')
        z = r.submit(command, b, q, 'handover', rev + (variant == 'next'), key)
        r.wait_until(lambda: b in r.pids and r.blocked_by(r.pids[b], r.pids[l]), 'borrower did not wait')
        graph = r.lock_graph()
        assert any(x[0] == r.pids[b] and not x[8] and x[1] in ('transactionid', 'tuple') for x in graph), graph
        assert any(x[0] == r.pids[b] and x[2] == 'loan' and x[7] == 'RowShareLock' and x[8] for x in graph), graph
        # This relation lock is acquired by the follower's SELECT ... FOR NO KEY UPDATE on the Loan.
        assert not probe(r, 'loan', q['loan_id'], 'SHARE')
        release.set()
        assert a.result(timeout=r.left()).status_code == 200
        response = z.result(timeout=r.left())
        assert response.status_code == (409 if variant == 'frozen' else 200), response.text
        if variant == 'frozen':
            assert response.json()['detail'] == {'code': 'LOAN_CHANGED'}
            assert row(q)['revision'] == rev + 1 and row(q)['state'] == 'accepted'
            assert row(q)['lender_handover_at'] and row(q)['borrower_handover_at'] is None
            assert count('borrowed_holding', q) == 0
            with connect() as conn:
                assert conn.execute('SELECT 1 FROM location_command WHERE owner_id=%s AND request_key=%s', (b, key)).fetchone() is None
            ok(r.submit(command, b, q, 'handover', rev + 1).result(timeout=r.left()))
        assert row(q)['revision'] == rev + 2 and row(q)['state'] == 'handed_over'
        with connect() as conn:
            assert conn.execute('SELECT sum(quantity) AS n FROM borrowed_holding WHERE loan_id=%s', (q['loan_id'],)).fetchone()['n'] == 2


def test_a_borrowers_loans_with_two_lenders_step_in_parallel(store, monkeypatch):
    edition, b, l, q = world()
    l2, _ = collector()
    befriend(b, l2)
    hold(l2, place(l2, 'Binder'), edition, 2)
    q2 = ok(accept(l2, view(l2, sent(b, l2, [(edition, 2)])), [(edition, 2)]))
    with race() as r:
        observe(r, monkeypatch)
        paused, release, _ = pause(r, monkeypatch, l)
        a = r.submit(command, l, q, 'handover')
        r.wait_until(paused.is_set, 'leader not paused')
        ok(r.submit(command, l2, q2, 'handover').result(timeout=r.left()))
        ok(r.submit(command, b, q2, 'handover').result(timeout=r.left()))
        assert not release.is_set()
        release.set()
        ok(a.result(timeout=r.left()))
    assert row(q)['revision'] == q['revision'] + 1
    assert row(q2)['revision'] == q2['revision'] + 2 and row(q2)['state'] == 'handed_over'


def test_disjoint_pairs_step_in_parallel(store, monkeypatch):
    edition, _, l, q = world()
    _, _, l2, q2 = world(edition=edition)
    with race() as r:
        observe(r, monkeypatch)
        paused, release, _ = pause(r, monkeypatch, l)
        a = r.submit(command, l, q, 'handover')
        r.wait_until(paused.is_set, 'leader not paused')
        ok(r.submit(command, l2, q2, 'handover').result(timeout=r.left()))
        assert not release.is_set()
        release.set()
        ok(a.result(timeout=r.left()))


@pytest.mark.parametrize('borrower_first', [True, False])
@pytest.mark.parametrize('first_step', ['take_back', 'handover'])
def test_a_lenders_take_back_and_a_borrowers_handover_on_two_loans_run_in_parallel(store, monkeypatch, borrower_first, first_step):
    edition, b, l, q = world(borrower_first)
    ok(command(l, q, 'handover'))
    q2 = ok(accept(l, view(l, sent(b, l, [(edition, 2)])), [(edition, 2)]))
    leader = l if first_step == 'take_back' else b
    ops = {'take_back': (l, q, 'take-back'), 'handover': (b, q2, 'handover')}
    with race() as r:
        observe(r, monkeypatch)
        paused, release, _ = pause(r, monkeypatch, leader)
        a = r.submit(command, *ops[first_step])
        r.wait_until(paused.is_set, 'leader not paused')
        other = 'handover' if first_step == 'take_back' else 'take_back'
        z = r.submit(command, *ops[other])
        follower = ops[other][0]
        r.wait_until(lambda: follower in r.pids and r.blocked_by(r.pids[follower], r.pids[leader]), 'follower did not wait on take-back owner locks')
        release.set()
        ok(z.result(timeout=r.left()))
        ok(a.result(timeout=r.left()))
    assert view(l, q)['you_confirmed_handover'] is False
    assert view(b, q2)['you_confirmed_handover'] is True
    with connect() as conn:
        assert sorted(int(x['quantity']) for x in conn.execute('SELECT quantity FROM borrowed_holding WHERE loan_id=%s', (q2['loan_id'],))) == [2]


@pytest.mark.parametrize('borrower_low', [True, False])
def test_a_two_owner_cancel_paused_between_its_owner_locks_never_closes_a_cycle(store, monkeypatch, borrower_low):
    edition, b, l, q = world(borrower_low)
    q2 = ok(accept(l, view(l, sent(b, l, [(edition, 2)])), [(edition, 2)]))
    with race() as r:
        observe(r, monkeypatch)
        between, release = Event(), Event()
        r.events.append(release)
        original = loans.lock_owners
        def locks(conn, *ids):
            ids = sorted(set(ids))
            if len(ids) != 2:
                return original(conn, *ids)
            for i, owner in enumerate(ids):
                original(conn, owner)
                if i == 0:
                    between.set()
                    assert release.wait(timeout=r.left())
        monkeypatch.setattr(loans, 'lock_owners', locks)
        a = r.submit(command, b, q, 'cancel')
        r.wait_until(between.is_set, 'cancel did not pause between owners')
        z = r.submit(command, l, q2, 'handover')
        if borrower_low:
            ok(z.result(timeout=r.left()))
            assert not release.is_set()
        else:
            r.wait_until(lambda: l in r.pids and r.blocked_by(r.pids[l], r.pids[b]), 'lender did not wait')
        release.set()
        ok(a.result(timeout=r.left()))
        ok(z.result(timeout=r.left()))
    assert (row(q)['state'], row(q)['closed_reason'], row(q)['revision']) == ('closed', 'cancelled', q['revision'] + 1)
    assert count('loan_pick', q) == 0
    assert row(q2)['lender_handover_at'] and row(q2)['revision'] == q2['revision'] + 1
    with connect() as conn:
        assert {x['state'] for x in conn.execute('SELECT state FROM loan_pick WHERE loan_id=%s', (q2['loan_id'],))} == {'lent'}


def probe(r, table, ident, mode):
    # Each NOWAIT probe uses a fresh transaction and rolls it back immediately.
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        try:
            column = 'user_id' if table == 'inventory_owner' else 'id'
            conn.execute(f'SELECT 1 FROM {table} WHERE {column}=%s FOR {mode} NOWAIT', (ident,))
            return True
        except psycopg.errors.LockNotAvailable:
            return False
        finally:
            conn.rollback()


@pytest.mark.parametrize('borrower_low', [True, False])
@pytest.mark.parametrize('first', ['edit', 'rename'])
def test_a_terms_edit_and_the_lenders_rename_both_commit(store, monkeypatch, borrower_low, first):
    edition, b, l, q = world(borrower_low, accepted=False)
    name = 'Rename Gate'
    suffix, gate = uuid4().hex, uuid4().int % (2**60)
    fn = 'loan_lock_gate_' + suffix
    with race() as r:
        observe(r, monkeypatch)
        from app.social import profile
        owner_rows = profile.owner_and_rows
        def identify_rename(conn, user, *args, **kwargs):
            if user == l:
                r.pids['rename'] = conn.execute('SELECT pg_backend_pid() AS pid').fetchone()['pid']
            return owner_rows(conn, user, *args, **kwargs)
        monkeypatch.setattr(profile, 'owner_and_rows', identify_rename)
        paused, release, _ = pause(r, monkeypatch, b)
        def edit():
            return command(b, q, 'terms', lines=[{'edition_id': edition, 'quantity': '1'}], deck_id=None, return_by=None)
        def rename():
            try:
                return call('PUT', '/api/profile/display-name', l, {'display_name': name, 'idempotency_key': str(uuid4())})
            except psycopg.errors.DeadlockDetected as exc:
                # TestClient propagates an unhandled server exception; real HTTP answers 500.
                print('T6 DEADLOCK VICTIM: rename', str(exc), flush=True)
                from httpx import Response
                return Response(500, text=str(exc))
        try:
            if first == 'edit':
                a = r.submit(edit)
                r.wait_until(paused.is_set, 'edit did not pause')
                z = r.submit(rename)
            else:
                # The trigger is test-only and is always removed; production triggers are unchanged.
                r.watch.execute(f'CREATE FUNCTION {fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared({gate}); RETURN NEW; END $$')
                r.watch.execute(f"CREATE TRIGGER {fn} BEFORE UPDATE OF display_name ON collector_profile FOR EACH ROW WHEN (NEW.display_name='Rename Gate') EXECUTE FUNCTION {fn}()")
                def drop_gate():
                    # Test-only connection/startup and DDL limits. A surviving rename must fail cleanup,
                    # rather than hold teardown forever. Production connections are unchanged.
                    with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=3,
                                         options='-c lock_timeout=1000 -c statement_timeout=3000') as conn:
                        conn.execute(f'DROP TRIGGER IF EXISTS {fn} ON collector_profile')
                        conn.execute(f'DROP FUNCTION IF EXISTS {fn}()')
                r.cleanup.append(drop_gate)
                r.watch.execute('SELECT pg_advisory_lock(%s)', (gate,))
                z = r.submit(rename)
            def rename_pid():
                # After narrowing, rename can wait in owner_and_rows before its UPDATE is reached.
                if 'rename' in r.pids:
                    return True
                found = r.watch.execute("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND query LIKE 'UPDATE collector_profile SET display_name%%' AND state='active'").fetchone()
                if found:
                    r.pids['rename'] = found[0]
                return found
            r.wait_until(rename_pid, 'rename backend not found')
            if first == 'rename':
                r.wait_until(lambda: r.watch.execute("SELECT 1 FROM pg_stat_activity WHERE pid=%s AND wait_event='advisory'", (r.pids['rename'],)).fetchone(), 'rename gate not reached')
                assert not probe(r, 'inventory_owner', l, 'KEY SHARE')
                # No apply gate here: the edit must wait before its old Loan lock after the fix.
                release.set()
                a = r.submit(edit)
            r.wait_until(lambda: b in r.pids and r.blocked_by(r.pids['rename'] if first == 'edit' else r.pids[b], r.pids[b] if first == 'edit' else r.pids['rename']), 'expected edit/rename wait missing')
            graph = r.lock_graph()
            owner_free = probe(r, 'inventory_owner', l, 'KEY SHARE')
            loan_free = probe(r, 'loan', q['loan_id'], 'SHARE')
            print('T6 OBSERVATION', borrower_low, first, 'owner_key_share=', owner_free, 'loan_share=', loan_free, 'graph=', graph, flush=True)
            release.set()
            r.watch.execute('SELECT pg_advisory_unlock(%s)', (gate,))
            edited, renamed = a.result(timeout=r.left()), z.result(timeout=r.left())
            print('T6 RESULTS', edited.status_code, edited.text, renamed.status_code, renamed.text, flush=True)
            if edited.status_code == 200 and renamed.status_code == 200 and (not owner_free if first == 'edit' else not loan_free):
                print('T6 BASELINE INCONCLUSIVE: no deadlock despite baseline wait', flush=True)
            if first == 'edit':
                assert owner_free
                assert not any(x[0] == r.pids['rename'] and x[2] == 'loan' and x[8] for x in graph)
            else:
                assert loan_free
            assert edited.status_code == renamed.status_code == 200
            replacement = edited.json()
            assert replacement['loan_id'] != q['loan_id']
            assert row(replacement)['lender_name'] == name
        except Exception:
            print('T6: inspect RESULTS for a deadlock; absent deadlock evidence is INCONCLUSIVE at commit A', flush=True)
            raise
        finally:
            release.set()
            r.watch.execute('SELECT pg_advisory_unlock(%s)', (gate,))
            print('T6 FINAL LOCK GRAPH', r.lock_graph(), flush=True)


def test_date_steps_never_wait_on_either_owner_row(store, monkeypatch):
    from test_return_by import change, ask, answer, day
    _, b, l, q = world()
    ok(change(l, q, day(10)))
    ok(command(l, q, 'handover'))
    for operation in ((change, l, q, day(12)), (ask, b, q, day(20)), (answer, l, q, 'approve')):
        with race() as r, monkeypatch.context() as scoped:
            observe(r, scoped)
            holder = psycopg.connect(os.environ['DATABASE_URL'])
            r.holders.append(holder)
            holder.execute('SELECT 1 FROM inventory_owner WHERE user_id=ANY(%s) ORDER BY user_id FOR NO KEY UPDATE', ([b, l],))
            ok(r.submit(*operation).result(timeout=r.left()))
    assert view(b, q)['return_by'] == day(20)


@pytest.mark.parametrize('original', ['commits', 'rolls_back'])
def test_a_same_key_retry_while_the_step_still_runs_answers_its_result(store, monkeypatch, original):
    _, b, l, q = world()
    key, rev = uuid4(), q['revision']
    with race() as r:
        replayed = observe(r, monkeypatch)
        paused, release, calls = pause(r, monkeypatch, l, rollback=original == 'rolls_back')
        a = r.submit(command, l, q, 'handover', rev, key)
        r.wait_until(paused.is_set, 'leader not paused')
        z = r.submit(command, l, q, 'handover', rev, key)
        retry = l + ':retry'
        r.wait_until(lambda: retry in r.pids and r.blocked_by(r.pids[retry], r.pids[l]), 'retry did not wait')
        assert any(x[0] == r.pids[retry] and x[1] == 'advisory' and not x[8] for x in r.lock_graph())
        release.set()
        first, second = a.result(timeout=r.left()), z.result(timeout=r.left())
        assert first.status_code == (200 if original == 'commits' else 503)
        assert second.status_code == 200
        if original == 'commits':
            assert first.json() == second.json()
        else:
            assert first.json()['detail'] == {'code': 'INVENTORY_TEMPORARILY_UNAVAILABLE'}
        assert replayed[retry] is (original == 'commits')
        assert len(calls) == (1 if original == 'commits' else 2)
    assert row(q)['revision'] == rev + 1
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM location_command WHERE owner_id=%s AND request_key=%s', (l, key)).fetchone()['n'] == 1
        assert conn.execute("SELECT sum(quantity) AS n FROM loan_pick WHERE loan_id=%s AND state='lent'", (q['loan_id'],)).fetchone()['n'] == 2


def test_a_lenders_handover_scans_its_picks_twice(store, monkeypatch):
    _, _, l, q = world()
    calls = []
    actual = loan_inventory.pick_shortfalls
    def counted(*args, **kwargs):
        calls.append(1)
        return actual(*args, **kwargs)
    monkeypatch.setattr(loan_inventory, 'pick_shortfalls', counted)
    monkeypatch.setattr(loan_picks, 'pick_shortfalls', counted)
    with race() as r:
        observe(r, monkeypatch)
        # Include the screen's fresh revision read, as the existing handover HTTP helper does.
        from test_handover import handover
        saved = ok(r.submit(handover, l, q).result(timeout=r.left()))
        assert len(calls) == 2
        fresh = view(l, q)
        assert saved == fresh


@pytest.mark.parametrize('suspended', ['borrower', 'lender'])
@pytest.mark.parametrize('order', ['suspension_first', 'take_back_first'])
def test_a_partners_take_back_and_a_suspension_settle_in_one_serial_order(store, monkeypatch, suspended, order):
    """A partner take-back and Suspension cancel in either authorized serial order."""
    _take_back_suspension(store, monkeypatch, suspended, order, own=False)


@pytest.mark.parametrize('suspended', ['borrower', 'lender'])
@pytest.mark.parametrize('order', ['suspension_first', 'take_back_first'])
def test_the_suspended_collectors_own_take_back_and_a_suspension_settle_in_one_serial_order(store, monkeypatch, suspended, order):
    """The suspended taker cancels atomically, or Suspension retries after the take-back."""
    _take_back_suspension(store, monkeypatch, suspended, order, own=True)


def _take_back_suspension(store, monkeypatch, suspended, order, own):
    from app.social import reports
    from test_trade_reports import as_owner, filed, decide
    from test_friend_copies import collector, befriend, place
    edition, b, l, q = world()
    account = b if suspended == 'borrower' else l
    partner = l if account == b else b
    taker = account if own else partner
    ok(command(taker, q, 'handover'))
    # A third-party report must not Block the Loan pair. filed is the existing SQL-only report helper.
    reporter, _ = collector()
    admin, report_id = as_owner(), filed(reporter, account)
    p2, _ = collector()
    befriend(account, p2)
    other_b, other_l = (account, p2) if suspended == 'borrower' else (p2, account)
    hold(other_l, place(other_l, 'Other binder'), edition, 2)
    q2 = view(other_b, sent(other_b, other_l, [(edition, 2)]))
    with race() as r:
        observe(r, monkeypatch)
        original = reports.lock_owners
        partners = reports.unconfirmed_partners
        reads, entries = [], []
        def counted(conn, user):
            # Installed only for this decision, after setup: no other Suspension invocation is counted.
            assert user == account
            reads.append(user)
            return partners(conn, user)
        def identify(conn, *ids):
            r.pids['suspend'] = conn.execute('SELECT pg_backend_pid() AS pid').fetchone()['pid']
            entries.append(tuple(ids))
            return original(conn, *ids)
        monkeypatch.setattr(reports, 'lock_owners', identify)
        monkeypatch.setattr(reports, 'unconfirmed_partners', counted)
        before = snapshot(b, l, q)
        if order == 'suspension_first':
            ok(r.submit(decide, admin, report_id, 'suspend').result(timeout=r.left()))
            assert row(q)['state'] == 'accepted'
            assert row(q)['lender_handover_at' if taker == l else 'borrower_handover_at'] is not None
            response = ok(r.submit(command, taker, q, 'take-back').result(timeout=r.left()))
            assert (response['state'], response['closed_reason']) == ('closed', 'cancelled')
            assert len(reads) == 2
        else:
            paused, release, _ = pause(r, monkeypatch, taker)
            a = r.submit(command, taker, q, 'take-back')
            r.wait_until(paused.is_set, 'take-back not paused')
            z = r.submit(decide, admin, report_id, 'suspend')
            r.wait_until(lambda: entries and 'suspend' in r.pids and r.blocked_by(r.pids['suspend'], r.pids[taker]), 'suspension did not wait at owner-lock entry')
            graph = r.lock_graph()
            assert any(x[0] == r.pids['suspend'] and not x[8] and x[1] in ('transactionid', 'tuple') for x in graph), graph
            assert len(reads) == 1
            release.set()
            assert ok(a.result(timeout=r.left()))['state'] == 'accepted'
            ok(z.result(timeout=r.left()))
            assert len(reads) == 4
        assert_cancelled(q, b, l, taker, account, before, loan_delta=1 if order == 'suspension_first' else 2)
        with connect() as conn:
            assert conn.execute('SELECT suspended_at IS NOT NULL AS yes FROM collector_profile WHERE user_id=%s', (account,)).fetchone()['yes']
            assert conn.execute("SELECT count(*) AS n FROM thread_event WHERE thread_id=%s AND kind='closed_suspended'", (q2['thread_id'],)).fetchone()['n'] == 1
    assert row(q2)['state'] == 'closed'



def snapshot(b, l, q, key=None):
    """Exact committed state, including identities/timestamps, for late-rollback inspection."""
    with connect() as conn:
        result = {
            'loan': conn.execute('SELECT * FROM loan WHERE id=%s', (q['loan_id'],)).fetchone(),
            'owners': {x['user_id']: x['revision'] for x in conn.execute('SELECT user_id,revision FROM inventory_owner WHERE user_id=ANY(%s)', ([b, l],))},
            'picks': conn.execute('SELECT * FROM loan_pick WHERE loan_id=%s ORDER BY id', (q['loan_id'],)).fetchall(),
            'holdings': conn.execute('SELECT * FROM holding WHERE owner_id=ANY(%s) ORDER BY owner_id,location_id,edition_id', ([b, l],)).fetchall(),
            'borrowed': conn.execute('SELECT * FROM borrowed_holding WHERE loan_id=%s ORDER BY location_id,edition_id', (q['loan_id'],)).fetchall(),
            'events': conn.execute('SELECT * FROM thread_event WHERE thread_id=%s ORDER BY created_at,id', (q['thread_id'],)).fetchall(),
            'updates': conn.execute('SELECT * FROM inbox_update WHERE loan_id=%s ORDER BY id', (q['loan_id'],)).fetchall(),
            'thread': conn.execute('SELECT * FROM thread WHERE id=%s', (q['thread_id'],)).fetchone(),
        }
        if key is not None:
            result['command'] = conn.execute('SELECT * FROM location_command WHERE owner_id=ANY(%s) AND request_key=%s', ([b, l], key)).fetchall()
        return result


def assert_cancelled(q, b, l, taker, actor, before, loan_delta=1):
    after = snapshot(b, l, q)
    found = after['loan']
    assert (found['state'], found['closed_reason'], found['closed_by']) == ('closed', 'cancelled', actor)
    assert found['closed_at'] is not None
    assert found['lender_handover_at'] is None and found['borrower_handover_at'] is None
    assert found['revision'] == before['loan']['revision'] + loan_delta
    assert after['owners'][l] == before['owners'][l] + 1 + int(taker == l)
    assert after['owners'][b] == before['owners'][b] + int(taker == b)
    assert after['picks'] == [] and after['borrowed'] == []
    events = after['events'][len(before['events']):]
    slot = lambda owner: 'low' if owner == min(b, l) else 'high'
    assert [(e['kind'], e['actor']) for e in events] == [('handover_taken_back', slot(taker)), ('closed_suspended', slot(actor))]
    assert events[1]['data'] == {}
    old = {u['id'] for u in before['updates']}
    updates = [u for u in after['updates'] if u['id'] not in old]
    recipient = b if actor == l else l
    assert [(u['kind'], u['recipient_id'], u['other_name']) for u in updates] == [
        ('cancelled', recipient, before['loan']['lender_name' if actor == l else 'borrower_name'])]
    assert after['thread']['last_activity_at'] > before['thread']['last_activity_at']
    assert view(taker, q)['actions'] == [] and view(taker, q)['section'] == 'history'
    return after


def suspended_loan(taker_role, who='partner', borrower_low=True):
    from test_trade_reports import as_owner, filed, decide
    edition, b, l, q = world(borrower_low)
    taker = l if taker_role == 'lender' else b
    partner = b if taker == l else l
    ok(command(taker, q, 'handover'))
    admin = as_owner()
    reporter, _ = collector()
    targets = [partner] if who == 'partner' else [taker] if who == 'self' else [b, l]
    for target in targets:
        ok(decide(admin, filed(reporter, target), 'suspend'))
    assert row(q)['state'] == 'accepted'
    return edition, b, l, q, taker, partner, admin


@pytest.mark.parametrize('taker_role', ['lender', 'borrower'])
@pytest.mark.parametrize('case', ['control', 'suspended_partner'])
def test_a_take_back_that_cancels_releases_inventory_and_counts_once(store, monkeypatch, taker_role, case):
    edition, b, l, q = world()
    taker = l if taker_role == 'lender' else b
    partner = b if taker == l else l
    ok(command(taker, q, 'handover'))
    if case == 'suspended_partner':
        from test_trade_reports import as_owner, filed, decide
        reporter, _ = collector()
        ok(decide(as_owner(), filed(reporter, partner), 'suspend'))
    before = snapshot(b, l, q)
    writes, touches = [], []
    real_write, real_touch = loans.write_loan, loans.touch_threads
    def write(conn, ident, changes):
        writes.append(ident)
        return real_write(conn, ident, changes)
    def touch(conn, updates):
        touches.append(list(updates))
        return real_touch(conn, updates)
    monkeypatch.setattr(loans, 'write_loan', write)
    monkeypatch.setattr(loans, 'touch_threads', touch)
    with race() as r:
        observe(r, monkeypatch)
        result = ok(r.submit(command, taker, q, 'take-back').result(timeout=r.left()))
        after = snapshot(b, l, q)
        assert writes == [q['loan_id']] or [str(x) for x in writes] == [q['loan_id']]
        assert len(touches) == 1 and [str(x) for x in touches[0]] == [q['thread_id']]
        assert after['loan']['revision'] == before['loan']['revision'] + 1
        assert after['borrowed'] == []
        if taker == l:
            assert sum(int(x['quantity']) for x in after['holdings'] if x['owner_id'] == l and str(x['edition_id']) == edition) == 8
        else:
            assert after['holdings'] == before['holdings']
        if case == 'suspended_partner':
            assert result['state'] == 'closed'
            assert_cancelled(q, b, l, taker, partner, before)
        else:
            assert result['state'] == 'accepted'
            assert {p['state'] for p in after['picks']} == {'reserved'}
            assert sum(int(p['quantity']) for p in after['picks']) == 2
            assert after['owners'][l] == before['owners'][l] + int(taker == l)
            assert after['owners'][b] == before['owners'][b] + int(taker == b)
            assert len(after['events']) == len(before['events']) + 1
            assert after['events'][-1]['kind'] == 'handover_taken_back'
            assert after['updates'] == before['updates']
            assert after['thread']['last_activity_at'] > before['thread']['last_activity_at']


@pytest.mark.parametrize('case', ['both_confirmed', 'one_confirmed', 'control'])
@pytest.mark.parametrize('taker_role', ['lender', 'borrower'])
def test_no_cancellation_while_a_handover_stays_confirmed(store, monkeypatch, case, taker_role):
    _, b, l, q = world()
    taker = l if taker_role == 'lender' else b
    partner = b if taker == l else l
    ok(command(taker, q, 'handover'))
    if case == 'both_confirmed':
        ok(command(partner, q, 'handover'))
    if case != 'control':
        from test_trade_reports import as_owner, filed, decide
        reporter, _ = collector()
        ok(decide(as_owner(), filed(reporter, partner), 'suspend'))
    before = snapshot(b, l, q)
    with race() as r:
        observe(r, monkeypatch)
        if case == 'both_confirmed':
            for user in (b, l):
                response = r.submit(command, user, q, 'take-back').result(timeout=r.left())
                assert (response.status_code, response.json()['detail']) == (409, {'code': 'STEP_NOT_ALLOWED'})
            assert snapshot(b, l, q) == before
        elif case == 'one_confirmed':
            assert before['loan']['state'] == 'accepted'
            assert before['loan']['lender_handover_at' if taker == l else 'borrower_handover_at']
            assert ok(r.submit(command, partner, q, 'handover').result(timeout=r.left()))['state'] == 'handed_over'
        else:
            assert ok(r.submit(command, taker, q, 'take-back').result(timeout=r.left()))['state'] == 'accepted'
        assert not any(e['kind'].startswith('closed_') for e in snapshot(b, l, q)['events'])


@pytest.mark.parametrize('taker_role', ['lender', 'borrower'])
def test_both_suspended_take_back_uses_the_other_participant_as_actor(store, monkeypatch, taker_role):
    _, b, l, q, taker, partner, _ = suspended_loan(taker_role, who='both')
    before = snapshot(b, l, q)
    with race() as r:
        observe(r, monkeypatch)
        ok(r.submit(command, taker, q, 'take-back').result(timeout=r.left()))
        # This is a valid take-back-then-other-Suspension serial order, not the uniquely required order.
        assert_cancelled(q, b, l, taker, partner, before)


@pytest.mark.parametrize('original', ['commits', 'rolls_back'])
@pytest.mark.parametrize('taker_role', ['lender', 'borrower'])
def test_a_cancelling_take_back_replays_and_rolls_back_whole(store, monkeypatch, original, taker_role):
    _cancelling_retry(monkeypatch, taker_role, 'helper' if original == 'rolls_back' else None)


@pytest.mark.parametrize('site', ['write', 'event', 'store'])
@pytest.mark.parametrize('taker_role', ['lender', 'borrower'])
def test_a_late_cancelling_take_back_failure_rolls_back_whole(store, monkeypatch, site, taker_role):
    _cancelling_retry(monkeypatch, taker_role, site)


def _cancelling_retry(monkeypatch, taker_role, site):
    _, b, l, q, taker, partner, _ = suspended_loan(taker_role)
    key = uuid4()
    before = snapshot(b, l, q, key)
    assert before['command'] == []
    with race() as r:
        replayed = observe(r, monkeypatch)
        paused, release, calls = pause(r, monkeypatch, taker, rollback=False)
        if site:
            # At D the helper is deliberately absent; fail visibly, without xfail, before launching a request.
            symbol = {'helper': 'cancel_unconfirmed', 'write': 'write_loan', 'event': 'loan_event', 'store': 'store'}[site]
            real = getattr(loans, symbol)
            injected = []
            def late(*args, **kwargs):
                result = real(*args, **kwargs)
                match = site != 'event' or (args[3] if len(args) > 3 else kwargs['kind']) == 'closed_suspended'
                if match and not injected:
                    injected.append(True)
                    raise psycopg.errors.DeadlockDetected('test late rollback: ' + site)
                return result
            monkeypatch.setattr(loans, symbol, late)
        a = r.submit(command, taker, q, 'take-back', before['loan']['revision'], key)
        r.wait_until(paused.is_set, 'take-back not paused')
        if site is None:
            z = r.submit(command, taker, q, 'take-back', before['loan']['revision'], key)
            retry = taker + ':retry'
            r.wait_until(lambda: retry in r.pids and r.blocked_by(r.pids[retry], r.pids[taker]), 'retry did not wait on advisory lock')
            assert any(x[0] == r.pids[retry] and x[1] == 'advisory' and not x[8] for x in r.lock_graph())
            release.set()
            first = a.result(timeout=r.left())
            second = z.result(timeout=r.left())
            assert first.status_code == second.status_code == 200
            assert first.json() == second.json()
            assert replayed[retry] and len(calls) == 1
        else:
            # The follower is not submitted until every rollback assertion has completed.
            release.set()
            first = a.result(timeout=r.left())
            assert (first.status_code, first.json()['detail']) == (503, {'code': 'INVENTORY_TEMPORARILY_UNAVAILABLE'})
            assert injected == [True]
            assert snapshot(b, l, q, key) == before
            assert before['loan']['lender_handover_at' if taker == l else 'borrower_handover_at'] is not None
            second = r.submit(command, taker, q, 'take-back', before['loan']['revision'], key).result(timeout=r.left())
            assert second.status_code == 200, second.text
            assert replayed[taker + ':retry'] is False and len(calls) == 2
        assert (second.json()['state'], second.json()['closed_reason']) == ('closed', 'cancelled')
        assert_cancelled(q, b, l, taker, partner, before)
        after = snapshot(b, l, q, key)
        assert len(after['command']) == 1
        # A fresh key never repeats the cancellation of a now-closed round.
        refused = r.submit(command, taker, q, 'take-back', before['loan']['revision']).result(timeout=r.left())
        assert (refused.status_code, refused.json()['detail']) == (409, {'code': 'LOAN_CHANGED'})


@pytest.mark.parametrize('taker_role', ['lender', 'borrower'])
@pytest.mark.parametrize('borrower_low', [True, False])
def test_a_take_back_locks_both_participants_ascending(store, monkeypatch, taker_role, borrower_low):
    from test_agreement_locks import recorded, assert_adr_0015, LOAN_LOCK
    _, b, l, q = world(borrower_low)
    taker = l if taker_role == 'lender' else b
    ok(command(taker, q, 'handover'))
    current = view(taker, q)
    lock_args = []
    real = loans.lock_owners
    def locks(conn, *ids):
        lock_args.append(list(ids))
        return real(conn, *ids)
    monkeypatch.setattr(loans, 'lock_owners', locks)
    with race() as r:
        observe(r, monkeypatch)
        opened = recorded(monkeypatch, loans)
        ok(r.submit(command, taker, q, 'take-back', current['revision']).result(timeout=r.left()))
        assert len(lock_args) == 1 and len(lock_args[0]) == 2 and set(lock_args[0]) == {b, l}
        assert len(opened) == 1
        statements = opened[0].statements
        assert_adr_0015(statements, 'loan', [b, l])
        loan_at = next(i for i, (text, _) in enumerate(statements) if LOAN_LOCK.search(text))
        for text, params in statements[loan_at + 1:]:
            if text.startswith('UPDATE inventory_owner SET'):
                assert params[-1] in {b, l}


def test_closure_helper_preserves_order_recipients_and_lender_revision_dedup(store, monkeypatch):
    from test_ending_friendship import end
    edition, b, l, q = world()
    q2 = ok(accept(l, view(l, sent(b, l, [(edition, 2)])), [(edition, 2)]))
    before = snapshot(b, l, q)['owners']
    trace = []
    for symbol in ('record_update', 'close', 'write_loan', 'loan_event', 'advance_revision'):
        real = getattr(loans, symbol)
        def wrapped(*args, _symbol=symbol, _real=real, **kwargs):
            trace.append((_symbol, args[1]))
            return _real(*args, **kwargs)
        monkeypatch.setattr(loans, symbol, wrapped)
    with race() as r:
        observe(r, monkeypatch)
        ok(r.submit(end, 'block', b, l).result(timeout=r.left()))
        after = snapshot(b, l, q)['owners']
        assert after == {b: before[b], l: before[l] + 1}
        expected = []
        for ident in sorted([q['loan_id'], q2['loan_id']]):
            expected.extend((name, ident) for name in ('record_update', 'close', 'write_loan', 'loan_event'))
        expected.append(('advance_revision', l))
        normalized = [(name, str(arg['id']) if isinstance(arg, dict) else str(arg)) for name, arg in trace]
        assert normalized == expected
        with connect() as conn:
            updates = conn.execute("SELECT loan_id,recipient_id,other_name,kind FROM inbox_update WHERE loan_id=ANY(%s) AND kind='cancelled' ORDER BY loan_id", ([q['loan_id'], q2['loan_id']],)).fetchall()
        assert [(str(x['loan_id']), x['recipient_id'], x['other_name'], x['kind']) for x in updates] == [
            (ident, l, row(q)['borrower_name'], 'cancelled') for ident in sorted([q['loan_id'], q2['loan_id']])]
        assert count('loan_pick', q) == count('loan_pick', q2) == 0


def test_closure_and_replacement_sentinels_are_mutually_exclusive(store, monkeypatch):
    from app.social.loans import LoanStep
    _, b, l, q = world()
    ok(command(b, q, 'handover'))
    q = view(b, q)
    before = snapshot(b, l, q)
    key = uuid4()
    with race() as r:
        observe(r, monkeypatch)
        def invalid(conn, current):
            return {'_replacement': uuid4(), '_closure': (l, 'closed_suspended')}
        def attempt():
            try:
                loans.run_step(b, q['thread_id'], LoanStep(loan_id=q['loan_id'], revision=q['revision'], idempotency_key=key),
                               'take_back', invalid, lambda role, row: [b, l])
            except AssertionError as exc:
                return str(exc)
            raise AssertionError('conflicting sentinels were accepted')
        assert 'mutually exclusive' in r.submit(attempt).result(timeout=r.left())
        assert snapshot(b, l, q) == before


@pytest.mark.parametrize('order', ['lift_first', 'take_back_first'])
@pytest.mark.parametrize('taker_role', ['lender', 'borrower'])
@pytest.mark.parametrize('suspended_side', ['self', 'partner'])
def test_a_suspension_lift_and_take_back_serialize_on_the_suspended_owner(store, monkeypatch, order, taker_role, suspended_side):
    from app.social import reports
    from test_trade_reports import restore
    _, b, l, q, taker, partner, admin = suspended_loan(taker_role, who=suspended_side)
    account = taker if suspended_side == 'self' else partner
    before = snapshot(b, l, q)
    with race() as r:
        observe(r, monkeypatch)
        original = reports.lock_owners
        entered, held_lift, release_lift = Event(), Event(), Event()
        r.events.append(release_lift)
        def lifting_locks(conn, *ids):
            assert account in ids
            r.pids['lift'] = conn.execute('SELECT pg_backend_pid() AS pid').fetchone()['pid']
            entered.set()
            result = original(conn, *ids)
            if order == 'lift_first':
                held_lift.set()
                assert release_lift.wait(timeout=r.left())
            return result
        monkeypatch.setattr(reports, 'lock_owners', lifting_locks)
        if order == 'lift_first':
            lifting = r.submit(restore, admin, account, 'suspension')
            r.wait_until(held_lift.is_set, 'lift did not hold S owner')
            taken = r.submit(command, taker, q, 'take-back')
            r.wait_until(lambda: taker in r.pids and r.blocked_by(r.pids[taker], r.pids['lift']), 'take-back did not wait on lift')
            release_lift.set()
            ok(lifting.result(timeout=r.left()))
            result = ok(taken.result(timeout=r.left()))
            assert result['state'] == 'accepted'
            after = snapshot(b, l, q)
            assert after['loan']['lender_handover_at'] is None and after['loan']['borrower_handover_at'] is None
            assert len(after['events']) == len(before['events']) + 1
            assert after['events'][-1]['kind'] == 'handover_taken_back'
            assert after['updates'] == before['updates']
        else:
            paused, release, _ = pause(r, monkeypatch, taker)
            taken = r.submit(command, taker, q, 'take-back')
            r.wait_until(paused.is_set, 'take-back did not pause')
            lifting = r.submit(restore, admin, account, 'suspension')
            r.wait_until(lambda: entered.is_set() and r.blocked_by(r.pids['lift'], r.pids[taker]), 'lift did not wait on take-back')
            release.set()
            assert ok(taken.result(timeout=r.left()))['state'] == 'closed'
            ok(lifting.result(timeout=r.left()))
            assert_cancelled(q, b, l, taker, account, before)
        with connect() as conn:
            assert conn.execute('SELECT suspended_at FROM collector_profile WHERE user_id=%s', (account,)).fetchone()['suspended_at'] is None
