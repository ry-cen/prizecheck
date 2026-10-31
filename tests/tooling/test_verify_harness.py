"""Pure parts of the verification harness: scripts/verify.py, run_pytest.py, run_playwright.py, verify_resources.py,
verify_report.py, verify_discard.py, verify_reaper.py, and the pytest shard split in api/tests/conftest.py. Nothing here
needs a database, a browser or a network; api/tests/test_verify_reaper.py checks the reaper against PostgreSQL."""
from contextlib import ExitStack
import importlib.util
import io
import json
import os
from pathlib import Path
import random
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))


def load(name, path=None):
    spec = importlib.util.spec_from_file_location(name, path or SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify = load('verify')
run_pytest = load('run_pytest')
run_playwright = load('run_playwright')
verify_resources = load('verify_resources')
verify_report = load('verify_report')
verify_discard = load('verify_discard')
verify_reaper = load('verify_reaper')
# Importing the conftest applies an xdist worker's prepared settings when PYTEST_XDIST_WORKER is set; these tests only
# need its pure shard split, so they load it as a plain process would.
with mock.patch.dict(os.environ, {'PYTEST_XDIST_WORKER': ''}):
    api_conftest = load('api_tests_conftest', ROOT / 'api' / 'tests' / 'conftest.py')
ADMIN = 'postgresql://tcg@127.0.0.1:5432/postgres'


class VerifyArgumentsTest(unittest.TestCase):
    def test_operations_run_in_the_full_gate_and_their_own_suite_but_not_under_fast(self):
        self.assertTrue(verify.runs_operations('all', False))
        self.assertFalse(verify.runs_operations('all', True))
        self.assertTrue(verify.runs_operations('operations', True))
        self.assertFalse(verify.runs_operations('api', False))

    def test_selectors_need_the_api_or_browser_suite(self):
        with self.assertRaises(SystemExit):
            verify.parse_arguments(['--admin-url', ADMIN, '--suite', 'all', '--', 'api/tests/test_api.py'])

    def test_api_selectors_and_fast_are_kept(self):
        args = verify.parse_arguments(['--admin-url', ADMIN, '--suite', 'api', '--fast', '--', '-k', 'health'])
        self.assertEqual((args.suite, args.fast, args.selectors), ('api', True, ['-k', 'health']))

    def test_only_suites_that_run_them_get_workers(self):
        self.assertEqual(verify.effective_workers('all', 6, 4), (6, 4))
        self.assertEqual(verify.effective_workers('api', 6, 4), (6, 1))
        self.assertEqual(verify.effective_workers('browser', 6, 4), (1, 4))
        self.assertEqual(verify.effective_workers('auth', 6, 4), (1, 1))

    def test_burn_in_chooses_its_own_tests(self):
        for extra in (['--suite', 'browser'], ['--', 'web/tests/moves.spec.ts']):
            with self.assertRaises(SystemExit):
                verify.parse_arguments(['--admin-url', ADMIN, '--burn-in', *extra])
        args = verify.parse_arguments(['--admin-url', ADMIN, '--burn-in', '--fast', '--base', 'origin/main'])
        self.assertEqual((args.burn_in, args.fast, args.base, args.repeat), (True, True, 'origin/main', None))
        self.assertEqual(verify.parse_arguments(['--admin-url', ADMIN]).base, 'origin/dev')

    def test_repeat_needs_burn_in_or_a_browser_or_auth_suite(self):
        for argv in (['--repeat', '3'], ['--suite', 'api', '--repeat', '3'], ['--suite', 'browser', '--repeat', '0']):
            with self.assertRaises(SystemExit, msg=argv):
                verify.parse_arguments(['--admin-url', ADMIN, *argv])
        self.assertEqual(verify.parse_arguments(['--admin-url', ADMIN, '--suite', 'browser', '--repeat', '20']).repeat, 20)
        self.assertEqual(verify.parse_arguments(['--admin-url', ADMIN, '--suite', 'auth', '--repeat', '5']).repeat, 5)

    def test_burn_in_gets_browser_stacks_but_no_pytest_workers_or_operations(self):
        self.assertEqual(verify.effective_workers('burn-in', 6, 4), (1, 4))
        self.assertFalse(verify.runs_operations('burn-in', False))

    def test_repeats_reach_only_the_suite_that_asked(self):
        self.assertEqual(verify.repeat_settings('browser', 20, None), (20, 1))
        self.assertEqual(verify.repeat_settings('auth', 5, None), (1, 5))
        self.assertEqual(verify.repeat_settings('all', None, None), (1, 1))
        self.assertEqual(verify.repeat_settings('burn-in', None, {'repeat': 3, 'vitest_repeat': 5}), (3, 5))

    def test_shard_is_k_of_n_for_the_api_or_browser_suite(self):
        for suite in ('api', 'browser'):
            self.assertEqual(verify.parse_arguments(['--admin-url', ADMIN, '--suite', suite, '--fast', '--shard', '3/10']).shard,
                             '3/10')
        self.assertEqual(verify.parse_arguments(['--admin-url', ADMIN, '--suite', 'api', '--shard', '1/1']).shard, '1/1')
        self.assertIsNone(verify.parse_arguments(['--admin-url', ADMIN, '--suite', 'api']).shard)
        for shard in ('0/3', '4/3', '3', '1/0', 'a/b', '1/3/5', ' 1/3', '01/3', '-1/3', ''):
            with self.assertRaises(SystemExit, msg=shard):
                verify.parse_arguments(['--admin-url', ADMIN, '--suite', 'api', '--shard', shard])
        for argv in (['--shard', '1/3'], ['--suite', 'auth', '--shard', '1/3'], ['--suite', 'operations', '--shard', '1/3'],
                     ['--burn-in', '--shard', '1/3']):
            with self.assertRaises(SystemExit, msg=argv):
                verify.parse_arguments(['--admin-url', ADMIN, *argv])

    def test_the_shard_reaches_ci_sh_and_an_unsharded_run_sets_it_empty(self):
        settings = verify.verify_settings('browser', True, '2/10', [], [], 1, 1, None)
        self.assertEqual((settings['VERIFY_SUITE'], settings['VERIFY_FAST'], settings['VERIFY_SHARD']), ('browser', '1', '2/10'))
        settings = verify.verify_settings('all', False, None, ['postgresql://tcg@127.0.0.1:5432/run_gw0'], [], 1, 1, None)
        self.assertEqual((settings['VERIFY_SHARD'], settings['VERIFY_OPERATIONS']), ('', '1'))
        self.assertEqual(json.loads(settings['VERIFY_PYTEST_DATABASE_URLS']), ['postgresql://tcg@127.0.0.1:5432/run_gw0'])
        plan = {'vitest': ['auth/tests/a.test.ts'], 'specs': ['web/tests/b.spec.ts', 'web/tests/c.spec.ts'], 'repeat': 3,
                'vitest_repeat': 5}
        settings = verify.verify_settings('burn-in', True, None, [], [], 3, 5, plan)
        self.assertEqual((settings['VERIFY_BURN_IN_VITEST'], settings['VERIFY_BURN_IN_SPECS'], settings['VERIFY_REPEAT']),
                         ('auth/tests/a.test.ts', 'web/tests/b.spec.ts web/tests/c.spec.ts', '3'))

    def test_ci_sh_shards_both_runners_and_leaves_the_build_to_unsharded_browser_runs(self):
        gate = (SCRIPTS / 'ci.sh').read_text()
        self.assertIn('scripts/run_pytest.py ${VERIFY_FAST:+--fast} ${VERIFY_SHARD:+--shard "$VERIFY_SHARD"} -- "$@"', gate)
        self.assertIn('${VERIFY_SHARD:+--shard "$VERIFY_SHARD"} -- "$@"', gate.split('scripts/run_playwright.py', 1)[1])
        self.assertIn('api:*|browser:?*) ;;', gate)
        self.assertIn('VERIFY_SHARD needs the api or browser suite', gate)

    def test_ci_sh_checks_the_bundle_boundary_after_the_build(self):
        gate = (SCRIPTS / 'ci.sh').read_text()
        self.assertIn('npm run guardrails; npm run build; .venv/bin/python scripts/check_bundle_boundary.py '
                      '--report "$TEST_LOG_DIR/bundle-boundary.json"', gate)

    def test_databases_and_ports_follow_the_workers(self):
        self.assertEqual(verify.database_names('run', 2, 3), ['run', 'run_gw0', 'run_gw1', 'run_s1', 'run_s2'])
        self.assertEqual(verify.database_names('run', 1, 1), ['run'])
        self.assertEqual((verify.port_count(1), verify.port_count(4)), (6, 15))


class ClockGuardTest(unittest.TestCase):
    def test_a_quiet_run_has_no_warnings(self):
        self.assertEqual(verify.clock_warnings(1.2, {'start': 0.04, 'end': -0.3}), [])
        self.assertEqual(verify.clock_warnings(0.0, {'start': None, 'end': None}), [])

    def test_a_suspended_host_or_a_skewed_database_clock_is_reported(self):
        warnings = verify.clock_warnings(540.0, {'start': 0.04, 'end': -312.5})
        self.assertEqual(len(warnings), 2)
        self.assertIn('suspended for about 540 s', warnings[0])
        self.assertIn('-312.5 s off the host clock at the end', warnings[1])

    def test_the_gate_runs_ci_sh_with_the_selectors(self):
        command = verify.gate_command(['-k', 'x'])
        self.assertEqual(command[-4:], ['bash', 'scripts/ci.sh', '-k', 'x'])
        self.assertIn(command[0], ('bash', 'caffeinate'))


class GateLifecycleTest(unittest.TestCase):
    """verify.py runs ci.sh in its own session and stops whatever is left of it before it removes the copied checkout
    and the databases, and keeps git in the copy from finding a repository around the temporary directory."""

    def test_the_gate_runs_in_its_own_session_and_what_it_leaves_running_is_stopped(self):
        with tempfile.TemporaryDirectory() as directory, (Path(directory) / 'log').open('w+') as log:
            leaves_a_child = 'import os, subprocess; print(os.getsid(0) == os.getpid()); subprocess.Popen(["sleep", "60"])'
            outcome = {}
            code = verify.run_gate([sys.executable, '-c', leaves_a_child], directory, dict(os.environ), log, outcome)
            log.seek(0)
            self.assertEqual((code, outcome, log.read().strip()), (0, {'leftovers': ['SIGTERM'], 'stopped': True}, 'True'))

    def test_a_gate_that_leaves_nothing_running_is_not_signalled(self):
        with tempfile.TemporaryDirectory() as directory, (Path(directory) / 'log').open('w') as log:
            outcome = {}
            code = verify.run_gate([sys.executable, '-c', 'raise SystemExit(3)'], directory, dict(os.environ), log, outcome)
            self.assertEqual((code, outcome), (3, {'leftovers': [], 'stopped': True}))

    def test_a_group_that_ignores_sigterm_is_killed(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        ready = Path(directory.name) / 'ready'
        process = subprocess.Popen(['bash', '-c', 'trap "" TERM; sleep 60 & touch "$1"; wait', 'gate', str(ready)],
                                   start_new_session=True)
        self.addCleanup(process.wait)
        deadline = time.monotonic() + 30
        while not ready.exists() and time.monotonic() < deadline:  # signalled before its trap, it would just exit
            time.sleep(.05)
        self.assertEqual(verify.stop_group(process, grace=.5), (['SIGTERM', 'SIGKILL'], True))
        self.assertFalse(verify.group_running(process.pid))

    def test_a_group_still_running_after_sigkill_is_not_reported_stopped(self):
        # A process in uninterruptible I/O outlives SIGKILL; signals that reach nobody stand in for it.
        process = subprocess.Popen(['true'], start_new_session=True)
        self.addCleanup(process.wait)
        with mock.patch.object(verify, 'group_running', return_value=True), mock.patch.object(verify.os, 'killpg') as killpg:
            self.assertEqual(verify.stop_group(process, grace=.2), (['SIGTERM', 'SIGKILL'], False))
        self.assertEqual([call.args[1] for call in killpg.call_args_list], [verify.signal.SIGTERM, verify.signal.SIGKILL])

    def test_an_interrupted_run_stops_the_gate_before_the_interruption_reaches_main(self):
        started = []

        class Interrupted(subprocess.Popen):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                started.append(self)

            def wait(self, timeout=None):
                raise KeyboardInterrupt

        outcome = {}
        with tempfile.TemporaryDirectory() as directory, (Path(directory) / 'log').open('w') as log, \
                mock.patch.object(verify.subprocess, 'Popen', Interrupted):
            with self.assertRaises(KeyboardInterrupt):
                verify.run_gate(['bash', '-c', 'sleep 60 & sleep 60'], directory, dict(os.environ), log, outcome)
        self.assertFalse(verify.group_running(started[0].pid))
        self.assertEqual(outcome, {'leftovers': ['SIGTERM'], 'stopped': True})

    def test_a_second_signal_waits_until_the_stop_is_recorded(self):
        previous = signal.signal(signal.SIGTERM, verify.exit_on_signal)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        finished = []

        def stop_group(process, grace):
            os.kill(os.getpid(), signal.SIGTERM)  # a second SIGTERM in the middle of the stop
            time.sleep(.2)
            finished.append(True)
            return ['SIGTERM'], True

        outcome = {}
        with mock.patch.object(verify, 'stop_group', stop_group), self.assertRaises(SystemExit) as raised:
            verify.stop_gate(object(), outcome)
        self.assertEqual((finished, outcome, raised.exception.code), ([True], {'leftovers': ['SIGTERM'], 'stopped': True}, 143))

    def test_cleanup_failures_are_what_ci_sh_reported_and_what_stopping_the_gate_found(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(verify.cleanup_failures(directory), [])
            (Path(directory) / 'cleanup-failures.txt').write_text('could not remove /tmp/work\n')
            self.assertEqual(verify.cleanup_failures(directory), ['could not remove /tmp/work'])
        self.assertEqual(verify.stop_failures({'leftovers': [], 'stopped': True}), [])
        self.assertEqual(verify.stop_failures({'leftovers': ['SIGTERM', 'SIGKILL'], 'stopped': False}), [
            'processes the gate started were still running after it exited; sent SIGTERM, SIGKILL',
            'processes of the gate were still running after SIGKILL; its checkout and databases were kept'])

    def test_a_cleanup_failure_fails_a_passing_run_and_a_failing_run_keeps_its_code(self):
        self.assertEqual([verify.final_result(code, failures) for code, failures in
                          ((0, []), (0, ['could not remove /tmp/work']), (7, ['could not remove /tmp/work']), (7, []))],
                         [0, 1, 7, 7])

    def test_the_gate_inherits_no_git_variables_and_a_ceiling_at_the_temporary_directory(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(tempfile, 'tempdir', directory), \
                mock.patch.dict(os.environ, {'GIT_DIR': '/elsewhere/.git', 'GIT_INDEX_FILE': '/elsewhere/index'}):
            environment = verify.inherited_environment()
        self.assertEqual([key for key in environment if key.startswith('GIT_')], ['GIT_CEILING_DIRECTORIES'])
        self.assertEqual(environment['GIT_CEILING_DIRECTORIES'], os.path.realpath(directory))

    def test_the_ceiling_keeps_git_in_a_copied_checkout_out_of_the_repository_around_it(self):
        # TMPDIR=<checkout>/.scratch/tmp puts the copied checkout and the tests' temporary directories inside a repository.
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(os.path.realpath(directory))
            subprocess.run(['git', 'init', '-q'], cwd=repository, env=verify.git_environment(), check=True)
            temporary = repository / '.scratch' / 'tmp'
            copies = [temporary / 'tcg-verify-x' / 'checkout' / 'api', temporary / 'tmpabc']
            for copy in copies:
                copy.mkdir(parents=True)
            toplevel = lambda copy, environment: subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=copy,
                                                                env=environment, capture_output=True, text=True)
            with mock.patch.object(tempfile, 'tempdir', str(temporary)):
                ceiling = verify.inherited_environment()['GIT_CEILING_DIRECTORIES']
            for copy in copies:
                with self.subTest(copy=copy.relative_to(repository)):
                    self.assertEqual(toplevel(copy, verify.git_environment()).stdout.strip(), str(repository))
                    found = toplevel(copy, dict(verify.git_environment(), GIT_CEILING_DIRECTORIES=ceiling))
                    self.assertNotEqual(found.returncode, 0)
                    self.assertIn('not a git repository', found.stderr)


class BurnInTest(unittest.TestCase):
    SOURCES = {
        'web/tests/support/motion.ts': 'export async function animationsFinished() {}',
        'web/tests/support/touch-target.ts': 'import { expect } from "@playwright/test";\nimport { animationsFinished } from "./motion";',
        'web/tests/support/browser-stack.ts': 'export function applyBrowserStack(): void {}',
        'web/tests/moves.spec.ts': 'import {\n  expectTouchTarget,\n} from "./support/touch-target";',
        'web/tests/decks.spec.ts': 'import { test } from "@playwright/test";',
        'auth/tests/support/servers.ts': 'import { spawn } from "node:child_process";',
        'auth/tests/price-runners-harness.ts': 'export { sleep } from "./support/servers";',
        'auth/tests/http.test.ts': 'import { launch } from "./support/servers";\nimport { x } from "../src/publicReads.js";',
        'auth/tests/price-runners.test.ts': '// @module-tag slow\nimport { Harness } from "./price-runners-harness";',
        'auth/tests/mail.test.ts': 'import { spawn } from "node:child_process";',
    }

    def test_local_imports_are_the_relative_specifiers(self):
        source = ('import { a } from "./a";\nimport "./b";\nexport { c } from "../c";\nimport {\n  d,\n} from \'./support/d\';\n'
                  'import { Pool } from "pg";\nimport { join } from "node:path";')
        self.assertEqual(verify.local_imports(source), ['./a', './b', '../c', './support/d'])
        self.assertEqual(verify.resolve_import('auth/tests/http.test.ts', '../src/publicReads.js', self.SOURCES), None)
        self.assertEqual(verify.resolve_import('web/tests/moves.spec.ts', './support/touch-target', self.SOURCES),
                         'web/tests/support/touch-target.ts')

    def test_changed_tests_are_chosen_directly(self):
        changed = {'web/tests/decks.spec.ts', 'auth/tests/mail.test.ts', 'api/app/main.py'}
        self.assertEqual(verify.burn_in_selection(changed, self.SOURCES, fast=True),
                         (['auth/tests/mail.test.ts'], ['web/tests/decks.spec.ts']))

    def test_a_changed_support_file_chooses_the_tests_that_import_it_through_any_chain(self):
        self.assertEqual(verify.burn_in_selection({'web/tests/support/motion.ts'}, self.SOURCES, fast=False),
                         ([], ['web/tests/moves.spec.ts']))
        self.assertEqual(verify.burn_in_selection({'auth/tests/support/servers.ts'}, self.SOURCES, fast=False),
                         (['auth/tests/http.test.ts', 'auth/tests/price-runners.test.ts'], []))

    def test_fast_leaves_out_wholly_slow_vitest_files(self):
        self.assertEqual(verify.burn_in_selection({'auth/tests/support/servers.ts'}, self.SOURCES, fast=True),
                         (['auth/tests/http.test.ts'], []))

    def test_config_and_unimported_support_changes_choose_nothing(self):
        changed = {'playwright.config.ts', 'vitest.config.ts', 'web/tests/support/browser-stack.ts'}
        self.assertEqual(verify.burn_in_selection(changed, self.SOURCES, fast=False), ([], []))

    def test_repeats_fit_the_budget_within_their_bounds(self):
        self.assertEqual([verify.burn_in_repeats(tests) for tests in (0, 1, 24, 48, 70, 500)], [10, 10, 10, 5, 3, 3])

    def test_listed_tests_count_every_nested_suite(self):
        report = {'suites': [{'specs': [{'tests': [{}, {}]}], 'suites': [{'specs': [{'tests': [{}]}, {'tests': []}]}]}]}
        self.assertEqual(verify.listed_tests(report), 3)
        self.assertEqual(verify.listed_tests({'suites': []}), 0)

    def test_changed_files_are_the_working_tree_against_the_merge_base(self):
        self.assert_changed_files_in_a_new_repository()

    def test_git_variables_a_hook_exports_reach_neither_the_test_repository_nor_the_hooks_own(self):
        # A pre-commit hook in a linked worktree exports GIT_DIR and GIT_INDEX_FILE; the test's `git init` once followed
        # them and set the shared repository to bare (#281).
        with tempfile.TemporaryDirectory() as directory:
            hooked = Path(directory)
            subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=hooked, env=verify.git_environment(),
                           check=True, capture_output=True)
            exported = {'GIT_DIR': str(hooked / '.git'), 'GIT_INDEX_FILE': str(hooked / '.git' / 'index'),
                        'GIT_WORK_TREE': str(hooked)}
            with mock.patch.dict(os.environ, exported):
                self.assert_changed_files_in_a_new_repository()
            bare = subprocess.run(['git', 'config', 'core.bare'], cwd=hooked, env=verify.git_environment(),
                                  capture_output=True, text=True).stdout.strip()
            self.assertEqual(bare, 'false')
            commits = subprocess.run(['git', 'rev-list', '--all'], cwd=hooked, env=verify.git_environment(),
                                     capture_output=True, text=True).stdout
            self.assertEqual(commits, '')

    def assert_changed_files_in_a_new_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git = lambda *args: subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.test', *args],
                                               cwd=root, env=verify.git_environment(), check=True, capture_output=True)
            git('init', '-q', '-b', 'dev')
            for name in ('kept.ts', 'edited.ts', 'deleted.ts'):
                (root / name).write_text('base\n')
            git('add', '.')
            git('commit', '-q', '-m', 'base')
            git('checkout', '-q', '-b', 'feature')
            (root / 'committed.ts').write_text('new\n')
            git('add', 'committed.ts')
            git('commit', '-q', '-m', 'feature')
            (root / 'edited.ts').write_text('changed\n')
            (root / 'deleted.ts').unlink()
            (root / 'untracked.ts').write_text('new\n')
            merge_base, changed = verify.changed_files('dev', root)
            self.assertRegex(merge_base, r'^[0-9a-f]{40}$')
            self.assertEqual(changed, {'committed.ts', 'edited.ts', 'untracked.ts'})

    def test_a_network_change_is_named_as_not_evidence(self):
        lines = verify.network_warnings(['browser/parallel/moves-drag'])
        self.assertEqual(len(lines), 1)
        self.assertIn('net::ERR_NETWORK_CHANGED in browser/parallel/moves-drag', lines[0])
        self.assertIn('not evidence', lines[0])


class VerifyDiscardTest(unittest.TestCase):
    def test_only_an_exact_run_directory_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            runs = Path(directory) / 'verification'
            run = runs / '20261010T195314Z-28c6ae5f'
            run.mkdir(parents=True)
            (run / 'verification.log').write_text('')
            self.assertEqual(verify_discard.run_directory('20261010T195314Z-28c6ae5f', runs), run)
            for bad in ('', ' ', '.', '..', '*', '20261010T195314Z-28c6ae5f/..', '../verification', '/', None):
                with self.assertRaises(ValueError, msg=repr(bad)):
                    verify_discard.run_directory(bad, runs)

    def test_a_missing_or_foreign_directory_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            runs = Path(directory) / 'verification'
            (runs / '20261010T195314Z-00000000').mkdir(parents=True)  # no log or result: not a run
            for run_id in ('20261010T195314Z-00000000', '20261010T195314Z-11111111'):
                with self.assertRaises(ValueError):
                    verify_discard.run_directory(run_id, runs)

    def test_the_command_refuses_an_empty_id_without_removing_anything(self):
        self.assertEqual(verify_discard.main(['']), 2)
        self.assertEqual(verify_discard.main([]), 2)


class RunPytestTest(unittest.TestCase):
    def test_marker_expressions(self):
        self.assertEqual(run_pytest.marker_expressions(False), ('not serial', 'serial'))
        self.assertEqual(run_pytest.marker_expressions(True), ('not serial and not slow', 'serial and not slow'))

    def test_runner_options_are_reserved(self):
        for selectors in (['-m', 'slow'], ['-mslow'], ['-n', '4'], ['-p', 'no:xdist'], ['--dist=load'], ['--junitxml', 'x']):
            self.assertIsNotNone(run_pytest.reserved_argument(selectors), selectors)
        self.assertIsNone(run_pytest.reserved_argument(['api/tests/test_api.py::test_x', '-k', 'health', '-x', '--lf']))

    def test_one_empty_pass_is_fine_but_not_two(self):
        self.assertEqual([run_pytest.combined_status(codes) for codes in ([0, 0], [0, 5], [5, 0], [5, 5], [1, 0], [5, 2])],
                         [0, 0, 0, 5, 1, 2])

    def test_parallel_pass_uses_xdist_only_with_worker_databases(self):
        (_, parallel), (_, serial) = run_pytest.commands(False, 6, Path('logs'), [])
        self.assertEqual(parallel[parallel.index('-n') + 1], '6')
        self.assertIn('loadfile', parallel)
        self.assertEqual(parallel[-1], 'api/tests')
        self.assertIn('no:xdist', serial)
        (_, parallel), _ = run_pytest.commands(True, 0, Path('logs'), ['api/tests/test_api.py'])
        self.assertNotIn('-n', parallel)
        self.assertEqual(parallel[parallel.index('-m') + 1], 'not serial and not slow')
        self.assertEqual(parallel[-1], 'api/tests/test_api.py')

    def test_selectors_follow_the_double_dash(self):
        self.assertEqual(run_pytest.parse(['--fast', '--', '-k', 'x']), (True, None, ['-k', 'x']))
        self.assertEqual(run_pytest.parse(['--']), (False, None, []))
        self.assertEqual(run_pytest.parse(['--fast', '--shard', '2/3', '--']), (True, '2/3', []))

    def test_the_shard_reaches_pytest_and_an_inherited_one_is_dropped(self):
        inherited = {'PATH': '/bin', 'VERIFY_PYTEST_SHARD': '9/9', 'PYTHONPATH': 'elsewhere'}
        self.assertEqual(run_pytest.pytest_environment(inherited, '2/3'),
                         {'PATH': '/bin', 'VERIFY_PYTEST_SHARD': '2/3', 'PYTHONPATH': 'api'})
        self.assertEqual(run_pytest.pytest_environment(inherited, None), {'PATH': '/bin', 'PYTHONPATH': 'api'})
        self.assertEqual(inherited['VERIFY_PYTEST_SHARD'], '9/9')

    def test_junit_counts_add_up_both_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / 'a.xml', Path(directory) / 'b.xml'
            first.write_text('<testsuites><testsuite tests="5" failures="1" errors="0" skipped="1"/></testsuites>')
            second.write_text('<testsuites><testsuite tests="3" failures="0" errors="1" skipped="0"/></testsuites>')
            self.assertEqual(run_pytest.junit_counts([first, second, Path(directory) / 'missing.xml']),
                             {'passed': 5, 'failed': 1, 'errors': 1, 'skipped': 1})


class RunPlaywrightTest(unittest.TestCase):
    def test_serial_tests_run_alone_and_fast_leaves_out_slow(self):
        self.assertEqual(run_playwright.passes(4, False),
                         [('parallel', ['--workers', '4', '--grep-invert', '@serial']), ('serial', ['--workers', '1', '--grep', '@serial'])])
        self.assertEqual(run_playwright.passes(4, True)[0][1][-1], '@serial|@slow')
        self.assertEqual(run_playwright.passes(4, True)[1][1][-2:], ['--grep-invert', '@slow'])

    def test_repeat_each_reaches_both_passes(self):
        (_, parallel), (_, serial) = run_playwright.passes(2, True, 5)
        self.assertEqual(parallel[-2:], ['--repeat-each', '5'])
        self.assertEqual(serial[-2:], ['--repeat-each', '5'])
        self.assertNotIn('--repeat-each', run_playwright.passes(2, True)[0][1])
        self.assertEqual(run_playwright.parse(['--workers', '2', '--repeat-each', '3', '--', 'web/tests/moves.spec.ts']),
                         (2, False, 3, None, ['web/tests/moves.spec.ts']))

    def test_a_shard_reaches_both_passes(self):
        (_, parallel), (_, serial) = run_playwright.passes(2, True, 1, '3/10')
        self.assertEqual(parallel, ['--workers', '2', '--grep-invert', '@serial|@slow', '--shard', '3/10'])
        self.assertEqual(serial, ['--workers', '1', '--grep', '@serial', '--grep-invert', '@slow', '--shard', '3/10'])
        self.assertTrue(all('--shard' not in arguments for _, arguments in run_playwright.passes(2, True)))
        self.assertEqual(run_playwright.parse(['--workers', '2', '--fast', '--shard', '3/10', '--']), (2, True, 1, '3/10', []))
        self.assertEqual(run_playwright.reserved_argument(['--shard=1/2']), '--shard=1/2')

    def test_runner_options_are_reserved(self):
        self.assertEqual(run_playwright.reserved_argument(['web/tests/moves.spec.ts', '--repeat-each=3']), '--repeat-each=3')
        self.assertEqual(run_playwright.reserved_argument(['web/tests/moves.spec.ts', '--workers=2']), '--workers=2')
        self.assertIsNone(run_playwright.reserved_argument(['web/tests/moves.spec.ts:15']))

    def test_report_totals_add_up_both_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / 'a.json', Path(directory) / 'b.json'
            first.write_text(json.dumps({'stats': {'expected': 50, 'unexpected': 1, 'flaky': 0, 'skipped': 1}}))
            second.write_text(json.dumps({'stats': {'expected': 1, 'unexpected': 0, 'flaky': 1, 'skipped': 0}}))
            self.assertEqual(run_playwright.report_totals([first, second]), {'passed': 51, 'failed': 1, 'flaky': 1, 'skipped': 1})


class PytestShardTest(unittest.TestCase):
    WEIGHTS = {f'api/tests/test_{number:03}.py': (number * 37) % 23 for number in range(130)}

    def item(self, path, name, slow=False):
        return SimpleNamespace(nodeid=f'{path}::{name}', get_closest_marker=lambda marker: object() if slow and marker == 'slow' else None)

    def test_every_file_lands_in_exactly_one_shard(self):
        for total in (1, 2, 3, 4, 10):
            shards = api_conftest.shard_files(self.WEIGHTS, total)
            self.assertEqual(set(shards), set(self.WEIGHTS), total)
            self.assertTrue(set(shards.values()) <= set(range(total)), total)
            parts = [{path for path, shard in shards.items() if shard == index} for index in range(total)]
            self.assertEqual(sum(len(part) for part in parts), len(self.WEIGHTS))
            self.assertEqual(set().union(*parts), set(self.WEIGHTS))

    def test_the_split_ignores_input_order_and_balances_the_weight(self):
        shards = api_conftest.shard_files(self.WEIGHTS, 3)
        paths = list(self.WEIGHTS)
        random.Random(7).shuffle(paths)
        self.assertEqual(api_conftest.shard_files({path: self.WEIGHTS[path] for path in paths}, 3), shards)
        loads = [sum(weight for path, weight in self.WEIGHTS.items() if shards[path] == index) for index in range(3)]
        self.assertLessEqual(max(loads) - min(loads), max(self.WEIGHTS.values()))

    def test_shard_settings_are_k_of_n(self):
        self.assertIsNone(api_conftest.shard_setting(''))
        self.assertEqual(api_conftest.shard_setting('2/3'), (2, 3))
        for value in ('0/3', '4/3', '3', 'a/b', '1/3/5', '01/3'):
            with self.assertRaises(pytest.UsageError, msg=value):
                api_conftest.shard_setting(value)

    def collect(self, items, shard):
        config = SimpleNamespace(hook=SimpleNamespace(pytest_deselected=mock.Mock()))
        kept = list(items)
        with mock.patch.dict(os.environ, {'VERIFY_PYTEST_SHARD': shard}):
            api_conftest.pytest_collection_modifyitems(config, kept)
        return kept, config.hook.pytest_deselected

    def test_the_hook_keeps_one_shard_in_order_and_reports_the_rest_deselected(self):
        items = [self.item(f'api/tests/test_{path}.py', f'test_{number}', slow=path == 'c')
                 for path in ('a', 'b', 'c', 'd', 'e') for number in range(len(path) + 'abcde'.index(path))]
        seen = []
        for number in (1, 2, 3):
            kept, deselected = self.collect(items, f'{number}/3')
            self.assertEqual(kept, [item for item in items if item in kept])  # collection order is kept
            dropped = deselected.call_args.kwargs['items'] if deselected.called else []
            self.assertEqual(len(kept) + len(dropped), len(items))
            self.assertEqual({item.nodeid.split('::')[0] for item in kept} & {item.nodeid.split('::')[0] for item in dropped}, set())
            seen += kept
        self.assertEqual(sorted(item.nodeid for item in seen), sorted(item.nodeid for item in items))

    def test_without_a_shard_the_hook_changes_nothing(self):
        items = [self.item('api/tests/test_a.py', 'test_x')]
        kept, deselected = self.collect(items, '')
        self.assertEqual(kept, items)
        deselected.assert_not_called()


class VerifyResourcesTest(unittest.TestCase):
    def gate_environment(self, directory):
        return {'DATABASE_URL': 'postgresql://tcg@127.0.0.1:5432/run', 'API_PORT': '9000', 'AUTH_PORT': '9001',
                'WEB_PORT': '9002', 'API_ORIGIN': 'http://127.0.0.1:9000', 'PUBLIC_ORIGIN': 'http://localhost:9002',
                'TEST_ORIGIN': 'http://localhost:9002', 'TEST_BASE_URL': 'http://localhost:9002',
                'REVIEW_BROWSER_ORIGIN': 'http://localhost:9002', 'MAIL_FILE': f'{directory}/mail',
                'PUBLIC_PROJECTION_DIR': f'{directory}/projection', 'CATALOG_PROCESS_FIXTURE_DIR': f'{directory}/fixture',
                'PRICE_RUNNER_LOCK_DIR': f'{directory}/locks',
                'VERIFY_PYTEST_DATABASE_URLS': json.dumps(['postgresql://tcg@127.0.0.1:5432/run_gw0', 'postgresql://tcg@127.0.0.1:5432/run_gw1']),
                'VERIFY_EXTRA_STACKS': json.dumps([{'database_url': 'postgresql://tcg@127.0.0.1:5432/run_s1', 'api_port': 9100,
                                                    'auth_port': 9101, 'web_port': 9102}])}

    def test_prepare_writes_worker_and_stack_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / 'work'
            initialized = []
            verify_resources.prepare(work, self.gate_environment(directory), pytest_workers=True, stacks=True, setup=initialized.append)
            worker = json.loads((work / 'pytest' / 'gw1' / 'env.json').read_text())
            self.assertEqual(set(worker), set(verify_resources.WORKER_KEYS))
            self.assertEqual(worker['DATABASE_URL'], 'postgresql://tcg@127.0.0.1:5432/run_gw1')
            self.assertTrue(Path(worker['PUBLIC_PROJECTION_DIR']).is_dir() and Path(worker['MAIL_FILE']).is_file())
            stacks = json.loads((work / 'stacks' / 'stacks.json').read_text())
            self.assertEqual((work / 'stacks' / 'count').read_text(), '2')
            self.assertEqual([set(stack) for stack in stacks], [set(verify_resources.STACK_KEYS)] * 2)
            self.assertEqual((stacks[0]['DATABASE_URL'], stacks[0]['TEST_ORIGIN']), ('postgresql://tcg@127.0.0.1:5432/run', 'http://localhost:9002'))
            self.assertEqual((stacks[1]['DATABASE_URL'], stacks[1]['API_ORIGIN'], stacks[1]['TEST_ORIGIN']),
                             ('postgresql://tcg@127.0.0.1:5432/run_s1', 'http://127.0.0.1:9100', 'http://localhost:9102'))
            self.assertNotEqual(stacks[0]['MAIL_FILE'], stacks[1]['MAIL_FILE'])
            # The gate's own database is already migrated; both workers and the extra stack are initialized.
            self.assertEqual(len(initialized), 3)

    def test_release_gate_mode_has_only_the_gate_stack(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = {key: value for key, value in self.gate_environment(directory).items() if not key.startswith('VERIFY_')}
            initialized = []
            verify_resources.prepare(Path(directory) / 'work', environment, pytest_workers=True, stacks=True, setup=initialized.append)
            self.assertEqual((Path(directory) / 'work' / 'stacks' / 'count').read_text(), '1')
            self.assertFalse((Path(directory) / 'work' / 'pytest').exists())
            self.assertEqual(initialized, [])

    def test_shell_exports_survive_bash(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'env.sh'
            path.write_text(verify_resources.shell_exports({'VALUE': "a b'c\"$HOME"}))
            shown = subprocess.run(['bash', '-c', f'. {path}; printf %s "$VALUE"'], capture_output=True, text=True, check=True).stdout
            self.assertEqual(shown, "a b'c\"$HOME")


class VerifyReportTest(unittest.TestCase):
    def test_phases_and_totals(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / 'phases.tsv').write_text('setup\tstart\t100\nsetup\tend\t120\npytest\tstart\t120\npytest\tend\t300\nbrowser\tstart\t300\n')
            (run / 'pytest-parallel.xml').write_text('<testsuites><testsuite tests="2" failures="0" errors="0" skipped="0">'
                                                     '<testcase classname="api.tests.test_a" name="test_x" time="3.5"/>'
                                                     '<testcase classname="api.tests.test_a" name="test_y" time="0.5"/></testsuite></testsuites>')
            (run / 'verification.log').write_text('')
            totals = verify_report.summarize(run)
            self.assertEqual(totals['phases'], {'setup': 20, 'pytest': 180})
            self.assertEqual(totals['pytest'], {'passed': 2, 'failed': 0, 'errors': 0, 'skipped': 0})
            self.assertIsNone(totals['playwright'])
            self.assertIsNone(totals['vitest'])
            self.assertIn('api.tests.test_a::test_x | parallel | 3.5', (run / 'verification.log').read_text())

    def test_the_bundle_boundary_reaches_the_summary_and_result(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            route = {'route': 'entry', 'chunks': 1, 'bytes': 10, 'leaks': []}
            (run / 'bundle-boundary.json').write_text(json.dumps({'ok': True, 'routes': [route] * 4, 'problems': []}))
            (run / 'verification.log').write_text('')
            totals = verify_report.summarize(run)
            self.assertIn('bundle boundary: ok (the entry and 3 public pages)', (run / 'verification.log').read_text())
            self.assertIs(totals['bundle_boundary']['ok'], True)

    def test_a_failed_bundle_boundary_lists_its_first_problems(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / 'bundle-boundary.json').write_text(json.dumps({'ok': False, 'routes': [], 'problems': ['a', 'b', 'c', 'd']}))
            (run / 'verification.log').write_text('')
            totals = verify_report.summarize(run)
            self.assertIn('bundle boundary: failed: a; b; c and 1 more', (run / 'verification.log').read_text())
            self.assertIs(totals['bundle_boundary']['ok'], False)

    def test_without_a_bundle_boundary_report_the_summary_leaves_it_out(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / 'verification.log').write_text('')
            totals = verify_report.summarize(run)
            self.assertIsNone(totals['bundle_boundary'])
            self.assertNotIn('bundle boundary', (run / 'verification.log').read_text())

    def test_failed_tests_are_named_with_their_pass_and_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / 'pytest-serial.xml').write_text('<testsuites><testsuite tests="2" failures="1" errors="0" skipped="0">'
                                                   '<testcase classname="api.tests.test_a" name="test_x" time="1"><failure/></testcase>'
                                                   '<testcase classname="api.tests.test_a" name="test_y" time="1"/></testsuite></testsuites>')
            (run / 'playwright-parallel.json').write_text(json.dumps({'stats': {'expected': 1, 'unexpected': 1}, 'suites': [
                {'specs': [{'file': 'moves.spec.ts', 'line': 15, 'title': 'drag', 'tests': [
                    {'status': 'unexpected', 'results': [{'parallelIndex': 2, 'duration': 10}]}]},
                           {'file': 'decks.spec.ts', 'line': 9, 'title': 'ok', 'tests': [
                    {'status': 'expected', 'results': [{'parallelIndex': 0, 'duration': 10}]}]}]}]}))
            (run / 'verification.log').write_text('')
            totals = verify_report.summarize(run)
            self.assertEqual(totals['failed'], ['playwright parallel: moves.spec.ts:15 › drag (unexpected, worker 2)',
                                                'pytest serial: api.tests.test_a::test_x'])
            self.assertIn('Failed tests:\n- playwright parallel: moves.spec.ts:15', (run / 'verification.log').read_text())

    def test_vitest_counts_include_tests_left_out_by_fast_as_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / 'vitest.xml').write_text('<testsuites><testsuite name="auth/tests/a.test.ts" tests="3" failures="0" errors="0" skipped="2">'
                                            '<testcase classname="auth/tests/a.test.ts" name="fast" time="0.25"/>'
                                            '<testcase classname="auth/tests/a.test.ts" name="slow" time="0"><skipped/></testcase>'
                                            '<testcase classname="auth/tests/a.test.ts" name="slower" time="0"><skipped/></testcase>'
                                            '</testsuite></testsuites>')
            (run / 'verification.log').write_text('')
            totals = verify_report.summarize(run)
            self.assertEqual(totals['vitest'], {'passed': 1, 'failed': 0, 'errors': 0, 'skipped': 2})
            self.assertIn('vitest: 1 passed, 0 failed, 0 errors, 2 skipped (one run)', (run / 'verification.log').read_text())


    def test_vitest_repeats_add_up_and_name_their_run(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            for number, failure in ((1, ''), (2, '<failure/>'), (10, '')):
                (run / f'vitest-{number}.xml').write_text(
                    f'<testsuites><testsuite name="auth/tests/a.test.ts" tests="1" failures="{int(bool(failure))}" errors="0" skipped="0">'
                    f'<testcase classname="auth/tests/a.test.ts" name="x" time="0.5">{failure}</testcase></testsuite></testsuites>')
            (run / 'vitest-x.xml').write_text('not a report')
            (run / 'verification.log').write_text('')
            self.assertEqual([path.name for path in verify_report.vitest_reports(run)], ['vitest-1.xml', 'vitest-2.xml', 'vitest-10.xml'])
            totals = verify_report.summarize(run)
            self.assertEqual(totals['vitest'], {'passed': 2, 'failed': 1, 'errors': 0, 'skipped': 0})
            self.assertEqual(totals['failed'], ['vitest run 2: auth/tests/a.test.ts › x'])
            self.assertIn('vitest: 2 passed, 1 failed, 0 errors, 0 skipped (3 runs)', (run / 'verification.log').read_text())

    def test_network_changes_name_the_failed_tests_whose_trace_shows_one(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            for test, network in (('changed', b'{"_failureText":"net::ERR_NETWORK_CHANGED"}'), ('other', b'{"status":200}')):
                (run / 'browser' / 'parallel' / test).mkdir(parents=True)
                with zipfile.ZipFile(run / 'browser' / 'parallel' / test / 'trace.zip', 'w') as archive:
                    archive.writestr('1-trace.network', network)
                    archive.writestr('1-trace.trace', b'{}')
            (run / 'browser' / 'serial' / 'broken').mkdir(parents=True)
            (run / 'browser' / 'serial' / 'broken' / 'trace.zip').write_bytes(b'not a zip')
            self.assertEqual(verify_report.network_changes(run), ['browser/parallel/changed'])
            self.assertEqual(verify_report.network_changes(run / 'missing'), [])


class VerifyReaperTest(unittest.TestCase):
    RUN = '20261010T195314Z-28c6ae5f'
    BASE = 'tcg_verify_0123456789abcdef'
    HOST = 'host-a'
    NOW = 1_000_000.0

    def owner(self, **changes):
        values = dict(run=self.RUN, host=self.HOST, pid=4242, started='Sat Oct 10 19:53:14 2026', created=self.NOW - 3600)
        values.update(changes)
        return verify_reaper.Owner(**values)

    def member(self, name=None, owner=None, sessions=0, comment=None):
        if owner is not None:
            comment = verify_reaper.owner_record(owner)
        return verify_reaper.Member(name or self.BASE, comment, sessions)

    def decide(self, members, probe=lambda pid: None, **options):
        return verify_reaper.decide(members, host=self.HOST, now=self.NOW, probe=probe, **options)

    def test_only_names_verify_makes_are_grouped_by_run(self):
        names = verify.database_names(self.BASE, 3, 3)
        runs, strays = verify_reaper.group_candidates([verify_reaper.Member(name, None, 0) for name in names])
        self.assertEqual(list(runs), [self.BASE])
        self.assertEqual([member.name for member in runs[self.BASE]], names)
        self.assertEqual(strays, [])
        others = ['tcg_verify_', 'tcg_verify_0123456789abcde', 'tcg_verify_0123456789ABCDEF', self.BASE + '_x',
                  self.BASE + '_gw', self.BASE + '_s', 'tcg_release_0123456789abcdef', 'tcg_prices_' + 'a' * 32]
        runs, strays = verify_reaper.group_candidates([verify_reaper.Member(name, None, 0) for name in others])
        self.assertEqual((runs, [member.name for member in strays]), ({}, others))

    def test_owner_records_round_trip_and_foreign_comments_are_refused(self):
        owner = self.owner()
        self.assertEqual(verify_reaper.parse_owner(verify_reaper.owner_record(owner)), owner)
        self.assertEqual(verify_reaper.parse_owner(verify_reaper.owner_record(self.owner(started=None))), self.owner(started=None))
        record = json.loads(verify_reaper.owner_record(owner))
        for changes in ({'tool': 'other'}, {'version': 2}, {'run': 'x'}, {'host': ''}, {'pid': True}, {'pid': 1},
                        {'pid': '4242'}, {'started': ''}, {'created': 'now'}, {'created': float('nan')}, {'created': 10 ** 400}):
            self.assertIsNone(verify_reaper.parse_owner(json.dumps({**record, **changes})), changes)
        for comment in (None, '', 'a note', '[]', '{}'):
            self.assertIsNone(verify_reaper.parse_owner(comment), comment)

    def test_owner_state_is_dead_only_for_a_missing_or_reused_pid(self):
        owner = self.owner()
        self.assertEqual(verify_reaper.owner_state(owner, lambda pid: None), 'dead')
        self.assertEqual(verify_reaper.owner_state(owner, lambda pid: 'Sun Oct 11 04:00:00 2026'), 'dead')
        self.assertEqual(verify_reaper.owner_state(owner, lambda pid: owner.started), 'alive')
        self.assertEqual(verify_reaper.owner_state(self.owner(started=None), lambda pid: 'any'), 'alive')
        self.assertEqual(verify_reaper.owner_state(owner, lambda pid: verify_reaper.UNKNOWN), 'unknown')

    def test_a_changed_start_string_is_dead_only_when_the_process_began_after_the_record(self):
        owner = self.owner(started='Sat Oct 10 19:53:14 2026', created=1791662000.0)  # 19:53:20 UTC
        self.assertEqual(verify_reaper.owner_state(owner, lambda pid: 'Sat Oct 10 19:53:14 2026'), 'alive')
        self.assertEqual(verify_reaper.owner_state(owner, lambda pid: 'Sat Oct 10 19:53:15 2026'), 'unknown')
        self.assertEqual(verify_reaper.owner_state(owner, lambda pid: 'Sat Oct 10 19:53:24 2026'), 'unknown')
        self.assertEqual(verify_reaper.owner_state(owner, lambda pid: 'Sat Oct 10 19:53:30 2026'), 'dead')
        self.assertEqual(verify_reaper.owner_state(owner, lambda pid: 'not a date'), 'unknown')

    def test_a_dead_owners_unused_old_run_is_dropped_whole(self):
        verdict = self.decide([self.member(owner=self.owner()), self.member(self.BASE + '_gw0')])
        self.assertTrue(verdict.drop)
        self.assertIn('has exited', verdict.reason)

    def test_every_other_run_is_kept(self):
        dead = self.owner()
        kept = {
            'session': [self.member(owner=dead), self.member(self.BASE + '_gw0', sessions=1)],
            'untagged': [self.member(), self.member(self.BASE + '_gw0')],
            'foreign comment': [self.member(owner=dead), self.member(self.BASE + '_s1', comment='a note')],
            'disagreeing owners': [self.member(owner=dead), self.member(self.BASE + '_gw0', owner=self.owner(pid=4343))],
            'other host': [self.member(owner=self.owner(host='host-b'))],
            'young': [self.member(owner=self.owner(created=self.NOW - 30))],
            'future': [self.member(owner=self.owner(created=self.NOW + 600))],
        }
        for case, members in kept.items():
            self.assertFalse(self.decide(members).drop, case)
        self.assertFalse(self.decide([self.member(owner=dead)], probe=lambda pid: dead.started).drop)
        self.assertFalse(self.decide([self.member(owner=dead)], probe=lambda pid: verify_reaper.UNKNOWN).drop)
        self.assertTrue(self.decide([self.member(owner=self.owner(created=self.NOW - 30))], min_age=10).drop)

    def test_drop_never_forces_and_a_late_session_keeps_the_database(self):
        class Connection:
            def __init__(self, error=None):
                self.error, self.statements = error, []

            def execute(self, statement, *args):
                self.statements.append(statement)
                if self.error:
                    raise self.error

        connection = Connection()
        self.assertIsNone(verify_reaper.drop_if_unused(connection, self.BASE))
        shown = repr(connection.statements[0])
        self.assertIn('DROP DATABASE IF EXISTS', shown)
        self.assertNotIn('FORCE', shown)
        self.assertIn('session connected', verify_reaper.drop_if_unused(Connection(verify_reaper.psycopg.errors.ObjectInUse()), self.BASE))
        self.assertIn('LockNotAvailable', verify_reaper.drop_if_unused(Connection(verify_reaper.psycopg.errors.LockNotAvailable()), self.BASE))

    def test_ps_tells_a_running_process_from_an_exited_one(self):
        started = verify_reaper.process_started(os.getpid())
        self.assertIsInstance(started, str)
        self.assertEqual(verify_reaper.process_started(os.getpid()), started)
        child = subprocess.Popen([sys.executable, '-c', 'pass'])
        child.wait()
        self.assertIsNone(verify_reaper.process_started(child.pid))

    def test_host_identity_is_stable_and_hashed(self):
        identity = verify_reaper.host_identity()
        self.assertRegex(identity, r'^[0-9a-f]{16}$')
        self.assertEqual(verify_reaper.host_identity.__wrapped__(), identity)

    def test_an_unreachable_server_is_reported_not_raised(self):
        with mock.patch.object(verify_reaper.psycopg, 'connect', side_effect=verify_reaper.psycopg.OperationalError('refused')):
            lines, dropped = verify_reaper.reap(ADMIN)
        self.assertEqual(dropped, [])
        self.assertEqual(lines, ['== reaper: skipped: database error (OperationalError)'])


if __name__ == '__main__':
    unittest.main()


def gate(exit_code, leftovers=(), stopped=True):
    """A stand-in for verify.run_gate: the gate exits with exit_code, and stopping it finds `leftovers` and `stopped`."""
    def run_gate(command, cwd, env, log, outcome):
        outcome.update(leftovers=list(leftovers), stopped=stopped)
        return exit_code
    return run_gate


class MainCleanupTest(unittest.TestCase):
    """main() fails a passing run that could not clean up, and keeps the checkout and databases of a gate that is
    still running after SIGKILL."""

    def run_main(self, run_gate, admin=ADMIN):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / 'tmp').mkdir()
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(verify, 'ROOT', root))
            stack.enter_context(mock.patch.object(tempfile, 'tempdir', str(root / 'tmp')))
            for name, value in (('reap', ([], [])), ('database_skew', 0), ('network_changes', []), ('summarize', {}),
                                ('current_owner', {}), ('report_timing_warnings', {'timing_warnings': []})):
                stack.enter_context(mock.patch.object(verify, name, return_value=value))
            stack.enter_context(mock.patch.object(verify, 'create_databases',
                                                  side_effect=lambda conn, names, owner, created: created.extend(names)))
            stack.enter_context(mock.patch.object(verify.psycopg, 'connect'))
            stack.enter_context(mock.patch.object(verify.subprocess, 'check_output', return_value=b''))
            stack.enter_context(mock.patch.object(verify, 'run_gate', side_effect=run_gate))
            drop = stack.enter_context(mock.patch.object(verify, 'drop_databases'))
            output = stack.enter_context(mock.patch('sys.stdout', new_callable=io.StringIO))
            code = verify.main(['--admin-url', admin, '--suite', 'api', '--pytest-workers', '2'])
        report = json.loads(next(root.glob('.scratch/verification/*/result.json')).read_text())
        return code, report, drop, output.getvalue(), sorted(path.name for path in (root / 'tmp').iterdir())

    def test_a_passing_run_that_left_processes_running_fails(self):
        code, report, drop, output, temporary = self.run_main(gate(0, ['SIGTERM']))
        self.assertEqual((code, report['exit_code']), (1, 1))
        self.assertEqual(report['cleanup_failures'],
                         ['processes the gate started were still running after it exited; sent SIGTERM'])
        self.assertIn('CLEANUP FAILED: processes the gate started', output)
        drop.assert_called_once()
        self.assertEqual(temporary, [])

    def test_a_failing_run_keeps_its_own_exit_code(self):
        code, report, _, _, _ = self.run_main(gate(7, ['SIGTERM']))
        self.assertEqual((code, report['exit_code']), (7, 7))

    def test_a_gate_still_running_after_sigkill_keeps_its_checkout_and_databases(self):
        admin = 'postgresql://tcg:test-secret-password@127.0.0.1:5432/postgres'
        code, report, drop, output, temporary = self.run_main(gate(0, ['SIGTERM', 'SIGKILL'], stopped=False), admin)
        self.assertEqual((code, report['exit_code'], report['database_removed']), (1, 1, False))
        self.assertIn('processes of the gate were still running after SIGKILL; its checkout and databases were kept',
                      report['cleanup_failures'])
        drop.assert_not_called()
        self.assertEqual(len(temporary), 1)
        self.assertIn('RETAINED: the copied checkout ', output)
        for database in report['databases']:
            self.assertIn(database, output)
        self.assertIn(temporary[0], output)
        self.assertNotIn('test-secret-password', output)


class TimingWarningsTest(unittest.TestCase):
    def test_breach_is_recorded_without_failure_and_reported(self):
        support = load('timing_support', ROOT / 'api/tests/timing_support.py')
        for worker in ('gw0', ''):
            with self.subTest(worker=worker), tempfile.TemporaryDirectory() as directory:
                with mock.patch.dict(os.environ, {'TEST_LOG_DIR': directory, 'PYTEST_CURRENT_TEST': 'api/tests/test_example.py::test_read (call)', 'PYTEST_XDIST_WORKER': worker}):
                    self.assertIsNone(support.within_budget(2, 1, 'read', unit='ms'))
                report = verify.report_timing_warnings(Path(directory))
                self.assertEqual(json.loads(json.dumps(report))['timing_warnings'], [{
                    'nodeid': 'api/tests/test_example.py::test_read', 'measured': 2, 'budget': 1, 'unit': 'ms', 'what': 'read'}])
                self.assertEqual((Path(directory) / 'verification.log').read_text(),
                                 '== WARNING: timing budget exceeded: api/tests/test_example.py::test_read: 2 > 1 ms\n')

    def test_invalid_lines_leave_valid_breaches_in_the_report(self):
        breach = {'nodeid': 'test_read', 'measured': 2, 'budget': 1, 'unit': 's', 'what': 'read'}
        for invalid in ('{"nodeid":', '{}'):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory:
                (Path(directory) / 'timing-warnings-worker.jsonl').write_text(
                    json.dumps(breach) + '\n' + invalid + '\n' + json.dumps(breach) + '\n')
                self.assertEqual(verify.report_timing_warnings(directory), {'timing_warnings': [breach, breach]})

    def test_a_broken_timing_report_preserves_the_gate_result_and_result_json(self):
        for exit_code in (0, 7):
            with self.subTest(exit_code=exit_code), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                stack.enter_context(mock.patch.object(verify, 'ROOT', Path(directory)))
                for name, value in (('reap', ([], [])), ('database_skew', 0), ('network_changes', []),
                                    ('summarize', {}), ('create_databases', None), ('current_owner', {})):
                    stack.enter_context(mock.patch.object(verify, name, return_value=value))
                stack.enter_context(mock.patch.object(verify.psycopg, 'connect'))
                stack.enter_context(mock.patch.object(verify.subprocess, 'check_output', return_value=b''))
                stack.enter_context(mock.patch.object(verify, 'run_gate', side_effect=gate(exit_code)))
                stack.enter_context(mock.patch.object(verify, 'report_timing_warnings', side_effect=OSError('broken report')))
                self.assertEqual(verify.main(['--admin-url', ADMIN, '--suite', 'api']), exit_code)
                report = json.loads(next(Path(directory).glob('.scratch/verification/*/result.json')).read_text())
                self.assertEqual(report['exit_code'], exit_code)
                self.assertEqual(report['timing_warnings'], [])
                self.assertEqual(report['timing_report_error'], 'OSError')

    def test_within_budget_records_nothing(self):
        support = load('timing_support', ROOT / 'api/tests/timing_support.py')
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {'TEST_LOG_DIR': directory}):
                support.within_budget(1, 1, 'read')
                support.within_budget(0.5, 1, 'read')
            self.assertEqual(list(Path(directory).iterdir()), [])
            self.assertEqual(verify.report_timing_warnings(Path(directory)), {'timing_warnings': []})

    def test_outside_runner_prints_to_stderr(self):
        support = load('timing_support', ROOT / 'api/tests/timing_support.py')
        with mock.patch.dict(os.environ, {'TEST_LOG_DIR': ''}), mock.patch('sys.stderr') as stderr:
            support.within_budget(2, 1, 'read')
        self.assertIn('timing budget exceeded', ''.join(call.args[0] for call in stderr.write.call_args_list))
