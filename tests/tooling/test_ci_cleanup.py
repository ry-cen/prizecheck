"""scripts/ci.sh's EXIT trap, run against a copy of ci.sh whose python, servers, node and curl are stand-ins: it stops
the stacks' servers before it removes the directories they write to, keeps the gate's exit status, reports a directory
it could not remove, and runs on SIGTERM. Nothing here needs a database, a browser or a network."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]

# .venv/bin/python: the setup scripts succeed, verify_resources.py prepares one stack, run_playwright.py marks that the
# gate reached it and exits with FAKE_PLAYWRIGHT_EXIT after FAKE_PLAYWRIGHT_SLEEP seconds.
PYTHON = '''#!/usr/bin/env bash
case "$1" in
  scripts/verify_resources.py)
    mkdir -p "$VERIFY_WORK/stacks/s0"
    printf 'export TEST_ORIGIN=http://127.0.0.1:1 API_PORT=1 AUTH_PORT=2 WEB_PORT=3\\n' > "$VERIFY_WORK/stacks/s0/env.sh"
    echo 1 > "$VERIFY_WORK/stacks/count"
    echo '[]' > "$VERIFY_WORK/stacks/stacks.json" ;;
  scripts/run_playwright.py)
    touch "$TEST_LOG_DIR/playwright"
    sleep "${FAKE_PLAYWRIGHT_SLEEP:-0}"
    exit "${FAKE_PLAYWRIGHT_EXIT:-0}" ;;
esac
'''
# A stack server (uvicorn, and node for the gateway and vite). On SIGTERM it takes FAKE_SERVER_STOP_S to exit, then
# makes a last write to the projection directory, as a server flushing on shutdown would, and records that it stopped.
SERVER = '''#!/usr/bin/env bash
stopped() {
  sleep "${FAKE_SERVER_STOP_S:-0.5}"
  touch "$PUBLIC_PROJECTION_DIR/last-write-$$" 2>/dev/null
  echo "$$" >> "$TEST_LOG_DIR/stopped"
  exit 0
}
trap stopped TERM
if [ -n "${FAKE_SERVER_IGNORES_TERM:-}" ]; then trap '' TERM; fi
if [ -n "${FAKE_SERVER_LOCKS:-}" ]; then
  mkdir -p "$VERIFY_WORK/locked" && touch "$VERIFY_WORK/locked/file" 2>/dev/null; chmod 500 "$VERIFY_WORK/locked"
fi
echo "$$" >> "$TEST_LOG_DIR/started"
while :; do sleep .05; done
'''


def executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


class CiCleanupTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        base = Path(directory.name)
        self.checkout, self.logs, self.temporary = base / 'checkout', base / 'logs', base / 'tmp'
        for path in (self.logs, self.temporary):
            path.mkdir()
        (self.checkout / 'scripts').mkdir(parents=True)
        shutil.copy2(ROOT / 'scripts' / 'ci.sh', self.checkout / 'scripts' / 'ci.sh')
        executable(self.checkout / '.venv' / 'bin' / 'python', PYTHON)
        executable(self.checkout / '.venv' / 'bin' / 'uvicorn', SERVER)
        bin_directory = base / 'bin'
        executable(bin_directory / 'node', SERVER)
        # The stack answers once its three servers have started, as wait_for_stack's health check expects of a real one.
        executable(bin_directory / 'curl', '#!/bin/sh\n[ -f "$TEST_LOG_DIR/started" ] && [ "$(wc -l < "$TEST_LOG_DIR/started")" -ge 3 ]\n')
        self.environment = {'PATH': f'{bin_directory}:{os.environ["PATH"]}', 'HOME': str(base), 'TMPDIR': str(self.temporary),
                            'DATABASE_URL': 'postgresql://tcg@127.0.0.1:1/unused', 'TEST_LOG_DIR': str(self.logs),
                            # a browser shard: no guardrails or build, one stack, then run_playwright.py
                            'VERIFY_SUITE': 'browser', 'VERIFY_SHARD': '1/1'}

    def start(self, **settings):
        process = subprocess.Popen(['bash', 'scripts/ci.sh'], cwd=self.checkout, env=dict(self.environment, **settings),
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
        self.addCleanup(self.stop_leftovers, process)
        return process

    def run_gate(self, **settings):
        process = self.start(**settings)
        output = process.communicate(timeout=60)[0]
        return process.returncode, output

    def stop_leftovers(self, process):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        for path in self.temporary.rglob('*'):  # the read-only directory a test left, so the base directory goes
            if path.is_dir():
                path.chmod(0o700)

    def pids(self, name):
        path = self.logs / name
        return sorted(path.read_text().split()) if path.exists() else []

    def assert_nothing_left(self):
        self.assertEqual(self.pids('stopped'), self.pids('started'))
        self.assertEqual(len(self.pids('started')), 3)  # api, auth gateway and vite
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_a_passing_run_stops_its_servers_before_it_removes_their_directories(self):
        code, output = self.run_gate()
        self.assertEqual(code, 0, output)
        self.assert_nothing_left()
        self.assertNotIn('== cleanup', output)

    def test_the_gate_keeps_its_own_failure(self):
        code, output = self.run_gate(FAKE_PLAYWRIGHT_EXIT='3')
        self.assertEqual(code, 3, output)
        self.assert_nothing_left()

    def test_a_server_that_ignores_sigterm_is_killed_after_the_grace(self):
        code, output = self.run_gate(FAKE_SERVER_IGNORES_TERM='1', VERIFY_STOP_GRACE_S='1')
        self.assertEqual(code, 0, output)
        self.assertIn('sent SIGKILL', output)
        self.assertEqual(self.pids('stopped'), [])
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_a_directory_it_cannot_remove_fails_a_passing_run_and_is_named(self):
        if os.geteuid() == 0:
            self.skipTest('root removes a read-only directory')
        code, output = self.run_gate(FAKE_SERVER_LOCKS='1')
        self.assertEqual(code, 1, output)
        failures = [line.removeprefix('could not remove ') for line in (self.logs / 'cleanup-failures.txt').read_text().splitlines()]
        self.assertEqual(len(failures), 1)
        self.assertIn(f'== cleanup failed: could not remove {failures[0]}', output)
        self.assertEqual(self.pids('stopped'), self.pids('started'))
        # every other path was still removed
        self.assertEqual([path.name for path in self.temporary.iterdir()], [Path(failures[0]).name])

    def test_a_failing_run_keeps_its_own_exit_code_when_cleanup_also_fails(self):
        if os.geteuid() == 0:
            self.skipTest('root removes a read-only directory')
        code, output = self.run_gate(FAKE_SERVER_LOCKS='1', FAKE_PLAYWRIGHT_EXIT='3')
        self.assertEqual(code, 3, output)
        self.assertIn('== cleanup failed', output)

    def test_servers_that_outlive_sigkill_fail_the_run_and_keep_every_directory(self):
        # A process in uninterruptible I/O outlives SIGKILL; here a kill function that drops SIGKILL stands in for it.
        survives = self.temporary.parent / 'survives.sh'
        survives.write_text('kill() { if [ "$1" = -KILL ]; then return 0; fi; builtin kill "$@"; }\n')
        started = time.monotonic()
        code, output = self.run_gate(FAKE_SERVER_IGNORES_TERM='1', VERIFY_STOP_GRACE_S='1', BASH_ENV=str(survives))
        self.assertLess(time.monotonic() - started, 30)  # bounded: no wait for the survivors
        self.assertEqual(code, 1, output)
        self.assertIn('== cleanup failed: servers still running 1s after SIGKILL:', output)
        reported = (self.logs / 'cleanup-failures.txt').read_text()
        for pid in self.pids('started'):
            self.assertIn(pid, reported)
        kept = sorted(path.name for path in self.temporary.iterdir())
        self.assertEqual(len(kept), 5, kept)  # mail file, projection, catalog fixture, runner lock and work directories
        for name in kept:
            self.assertIn(name, reported)

    def test_sigterm_stops_the_servers_and_removes_the_directories(self):
        process = self.start(FAKE_PLAYWRIGHT_SLEEP='60')
        deadline = time.monotonic() + 30
        # the gate has started every server, recorded its pid and moved on to the Playwright stand-in
        while not (self.logs / 'playwright').exists() and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertTrue((self.logs / 'playwright').exists())
        os.killpg(process.pid, signal.SIGTERM)
        output = process.communicate(timeout=60)[0]
        self.assertEqual(process.returncode, 143, output)
        self.assert_nothing_left()


if __name__ == '__main__':
    unittest.main()
