"""Admission contract tests. Standard-library fake processes only; no installs, DB, listeners or browser."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from local_admission import Registry, group_alive, identity, reservation, supervise
from local_api_selection import eligible, narrow, source_fingerprint


class AdmissionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.registry = Registry(self.root / 'registry')

    def enqueue(self, name, mode='api', workers=2):
        return self.registry.enqueue(self.root / name, mode, workers if mode == 'api' else 0)

    def finish_supervisor(self, process):
        # Keep the helper alive long enough to reap its child, even when a regression fails an assertion.
        for record in self.registry.snapshot():
            pid = record.get('child')
            if record['pid'] == process.pid and pid and identity(pid) == record.get('child_identity'):
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def test_two_worktrees_overlap_third_waits_and_four_workers_is_the_bound(self):
        first, second, third = [self.enqueue(name) for name in ('a', 'b', 'c')]
        self.assertTrue(self.registry.admit(first))
        self.assertTrue(Registry(self.root / 'registry').admit(second))
        self.assertFalse(self.registry.admit(third))
        self.assertEqual(sum(r['workers'] for r in self.registry.snapshot() if r['status'] == 'active'), 4)
        self.registry.remove(first)
        self.assertTrue(self.registry.admit(third))

    def test_exclusive_drains_without_later_api_overtaking(self):
        first = self.enqueue('a')
        self.assertTrue(self.registry.admit(first))
        exclusive = self.enqueue('exclusive', 'exclusive')
        late = self.enqueue('late')
        self.assertFalse(self.registry.admit(exclusive))
        self.assertFalse(self.registry.admit(late))
        self.registry.remove(first)
        self.assertFalse(self.registry.admit(late))
        self.assertTrue(self.registry.admit(exclusive))
        self.assertFalse(self.registry.admit(late))
        self.registry.remove(exclusive)
        self.assertTrue(self.registry.admit(late))

    def test_same_worktree_cannot_overlap_and_api_budget_is_validated(self):
        first, second = self.enqueue('same'), self.enqueue('same', workers=1)
        self.assertTrue(self.registry.admit(first))
        self.assertFalse(self.registry.admit(second))
        for workers in (0, 3, 4):
            with self.assertRaises(ValueError):
                self.enqueue('bad', workers=workers)

    def test_exception_after_admission_retains_ownership(self):
        with self.assertRaisesRegex(RuntimeError, 'failed'):
            with reservation(self.registry, self.root, 'exclusive'):
                raise RuntimeError('failed')
        self.assertEqual(self.registry.snapshot()[0]['status'], 'active')
        self.assertFalse(self.registry.admit(self.enqueue('later')))

    def test_dead_active_owner_is_never_automatically_reaped(self):
        token = self.enqueue('dead')
        self.assertTrue(self.registry.admit(token))
        self.registry.update(token, identity='previous-boot:old-pid')
        self.assertFalse(self.registry.admit(self.enqueue('later')))
        with self.assertRaises(RuntimeError):
            self.registry.recover(token, False)
        self.registry.recover(token, True)

    def test_recovery_refuses_live_owner_or_live_child_group(self):
        token = self.enqueue('owner')
        self.assertTrue(self.registry.admit(token))
        with self.assertRaises(RuntimeError):
            self.registry.recover(token, True)
        self.registry.update(token, identity='old', child=os.getpgrp())
        with self.assertRaises(RuntimeError):
            self.registry.recover(token, True)

    def test_only_dead_waiter_can_be_discarded(self):
        dead = self.enqueue('dead', 'exclusive')
        self.registry.update(dead, identity='old')
        later = self.enqueue('later')
        self.assertTrue(self.registry.admit(later))
        self.assertNotIn(dead, [r['token'] for r in self.registry.snapshot()])

    def test_unknown_identity_blocks_instead_of_expiring_ownership(self):
        token = self.enqueue('uncertain')
        with mock.patch('local_admission.identity', side_effect=PermissionError('proc unavailable')):
            with self.assertRaises(PermissionError):
                self.registry.admit(token)
        self.assertEqual(len(self.registry.snapshot()), 1)

    def test_entry_helper_restores_inherited_sigchld_and_child_exit_status(self):
        helper = """import json,signal,subprocess,sys
assert signal.getsignal(signal.SIGCHLD) == signal.SIG_IGN
sys.path.insert(0, sys.argv[1])
from local_admission import reset_sigchld
reset_sigchld()
code = subprocess.run([sys.executable, '-c', 'raise SystemExit(7)']).returncode
print(json.dumps(dict(exit_code=code, sigchld_default=signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL)))
"""
        # exec preserves ignored SIGCHLD without changing the test runner's disposition.
        launcher = ("import os,signal,sys\n"
                    "signal.signal(signal.SIGCHLD, signal.SIG_IGN)\n"
                    "os.execv(sys.executable, [sys.executable, '-c', sys.argv[1], sys.argv[2]])\n")
        result = subprocess.run([sys.executable, '-c', launcher, helper, str(SCRIPTS)],
                                cwd=self.root, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), dict(exit_code=7, sigchld_default=True))

    def test_child_failure_preserves_exit_status_and_proves_empty_group(self):
        token = self.enqueue('run', 'exclusive')
        self.assertTrue(self.registry.admit(token))
        code, empty = supervise([sys.executable, '-c', 'raise SystemExit(7)'], self.registry, token)
        self.assertEqual(code, 7)
        self.assertTrue(empty)

    def test_atomic_claims_from_separate_processes_and_worktree_paths(self):
        helper = '''import sys,time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from local_admission import Registry
root, name = Path(sys.argv[2]), sys.argv[3]
r = Registry(root / 'registry')
t = r.enqueue(root / name, 'api', 2)
while not r.admit(t): time.sleep(.01)
(root / (name + '.active')).touch()
while not (root / (name + '.release')).exists(): time.sleep(.01)
r.remove(t)
'''
        processes = [subprocess.Popen([sys.executable, '-c', helper, str(SCRIPTS), str(self.root), name])
                     for name in ('a', 'b', 'c')]
        try:
            deadline = time.monotonic() + 5
            while len(list(self.root.glob('*.active'))) < 2 and time.monotonic() < deadline:
                time.sleep(.01)
            active = sorted(self.root.glob('*.active'))
            self.assertEqual(len(active), 2)
            # All three are enqueued before releasing a slot; only two processes can have claimed one.
            deadline = time.monotonic() + 5
            while len(self.registry.snapshot()) < 3 and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(len(self.registry.snapshot()), 3)
            self.assertEqual(len(list(self.root.glob('*.active'))), 2)
            (self.root / (active[0].stem + '.release')).touch()
            deadline = time.monotonic() + 5
            while len(list(self.root.glob('*.active'))) < 3 and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(len(list(self.root.glob('*.active'))), 3)
        finally:
            for name in ('a', 'b', 'c'):
                (self.root / (name + '.release')).touch()
            for process in processes:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

    def test_crashed_supervisor_keeps_live_child_reserved(self):
        ready = self.root / 'child.json'
        # Parent the live fixture here so even a non-reaping container PID 1 cannot leave an orphan/zombie.
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'], start_new_session=True)
        helper = f'''import sys
sys.path.insert(0, {str(SCRIPTS)!r})
from local_admission import Registry, identity
from pathlib import Path
r = Registry({str(self.root / 'registry')!r})
t = r.enqueue({str(self.root / 'crash')!r}, 'api', 2)
assert r.admit(t)
r.update(t, child={child.pid}, child_identity=identity({child.pid}))
Path({str(ready)!r}).touch()
import time
time.sleep(10)
'''
        process = subprocess.Popen([sys.executable, '-c', helper], start_new_session=True)
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists())
            process.kill()
            process.wait(timeout=5)
            self.assertTrue(group_alive(child.pid))
            self.assertFalse(self.registry.admit(self.enqueue('later')))
            crashed = next(r for r in self.registry.snapshot() if r['root'].endswith('/crash'))
            self.assertEqual(crashed['status'], 'retained')
            with self.assertRaises(RuntimeError):
                self.registry.recover(crashed['token'], True)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            child.kill()
            child.wait(timeout=5)

    def test_interrupt_waits_for_child_cleanup_and_does_not_forward_second_interrupt(self):
        # A helper supervisor receives real signals; child publishes cleanup only after receiving TERM.
        ready, stopping, done, result = [self.root / name for name in ('ready', 'stopping', 'done', 'result')]
        child = ('import signal,time,json,os; from pathlib import Path; '
                 f'signal.signal(signal.SIGTERM, lambda *a: (Path({str(stopping)!r}).touch(),time.sleep(.2),Path({str(done)!r}).touch(),exit(0))); '
                 f'Path({str(ready)+".new"!r}).write_text(json.dumps([os.getpid(), sorted(int(s) for s in signal.pthread_sigmask(signal.SIG_BLOCK, []))])); '
                 f'Path({str(ready)+".new"!r}).replace({str(ready)!r}); time.sleep(10)')
        helper = f'''import sys
sys.path.insert(0, {str(SCRIPTS)!r})
from local_admission import Registry, supervise
from pathlib import Path
import json
r = Registry({str(self.root / 'registry')!r})
t = r.enqueue({str(self.root / 'helper')!r}, 'exclusive')
assert r.admit(t)
code, empty = supervise([sys.executable, '-c', {child!r}], r, t)
Path({str(result)!r}).write_text(json.dumps([code, empty, Path({str(done)!r}).exists()]))
'''
        process = subprocess.Popen([sys.executable, '-c', helper], start_new_session=True)
        self.addCleanup(self.finish_supervisor, process)
        deadline = time.monotonic() + 5
        while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(ready.exists())
        child_pid, mask = json.loads(ready.read_text())
        self.assertFalse(set(mask) & {int(signal.SIGINT), int(signal.SIGTERM), int(signal.SIGHUP)})
        process.send_signal(signal.SIGTERM)
        deadline = time.monotonic() + 5
        while not stopping.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(stopping.exists())
        process.send_signal(signal.SIGINT)
        process.wait(timeout=5)
        self.assertEqual(json.loads(result.read_text()), [143, True, True])

    def test_startup_interrupt_is_forwarded_once_only_after_child_registration(self):
        ready, done, result = [self.root / name for name in ('ready', 'done', 'result')]
        child = ('import signal,time; from pathlib import Path; '
                 f'signal.signal(signal.SIGTERM, lambda *a: (Path({str(done)!r}).touch(),exit(0))); '
                 f'Path({str(ready)!r}).touch(); time.sleep(10)')
        helper = f'''import sys,os,signal,time,json
sys.path.insert(0, {str(SCRIPTS)!r})
from local_admission import Registry, supervise
from pathlib import Path
r = Registry({str(self.root / 'registry')!r})
t = r.enqueue({str(self.root / 'startup')!r}, 'exclusive')
assert r.admit(t)
original = r.update
def register(*args, **kwargs):
    deadline = time.monotonic() + 5
    while not Path({str(ready)!r}).exists() and time.monotonic() < deadline: time.sleep(.01)
    assert Path({str(ready)!r}).exists()
    os.kill(os.getpid(), signal.SIGTERM)
    os.kill(os.getpid(), signal.SIGHUP)
    assert not Path({str(done)!r}).exists(), 'signal forwarded before registration'
    original(*args, **kwargs)
r.update = register
code, empty = supervise([sys.executable, '-c', {child!r}], r, t)
Path({str(result)!r}).write_text(json.dumps([code, empty, Path({str(done)!r}).exists()]))
'''
        process = subprocess.Popen([sys.executable, '-c', helper], start_new_session=True)
        self.addCleanup(self.finish_supervisor, process)
        process.wait(timeout=7)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(json.loads(result.read_text()), [143, True, True])

    def test_unknown_and_serial_collection_evidence_fails_closed(self):
        self.assertFalse(eligible({}))
        self.assertFalse(eligible(dict(version=1, complete=True, nodeids=['a'], serial=['a'])))
        self.assertFalse(eligible(dict(version=1, complete=False, nodeids=['a'], serial=[])))
        self.assertFalse(eligible(dict(version=1, complete=True, nodeids=[], serial=[])))
        self.assertTrue(eligible(dict(version=1, complete=True, nodeids=['a'], serial=[])))
        for selectors in ([], ['api/tests'], ['--lf'], ['api/tests/test_a.py', '--override-ini=x'], ['../test_a.py']):
            self.assertFalse(narrow(selectors))
        self.assertTrue(narrow(['api/tests/test_a.py::Test::test_case', '-k', 'one or two']))

    def test_snapshot_matches_copied_bytes_and_changes_invalidate_it(self):
        (self.root / 'test.py').write_text('one')
        first = source_fingerprint(self.root, ['test.py', 'missing.py'])
        (self.root / 'test.py').write_text('two')
        self.assertNotEqual(first, source_fingerprint(self.root, ['test.py', 'missing.py']))


if __name__ == '__main__':
    unittest.main()
