"""Pure parts of the verification harness: scripts/verify.py, run_pytest.py, run_playwright.py, verify_resources.py,
verify_report.py, verify_discard.py and verify_reaper.py. Nothing here needs a database, a browser or a network;
api/tests/test_verify_reaper.py checks the reaper against PostgreSQL."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS))


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
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
        self.assertEqual(run_pytest.parse(['--fast', '--', '-k', 'x']), (True, ['-k', 'x']))
        self.assertEqual(run_pytest.parse(['--']), (False, []))

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

    def test_runner_options_are_reserved(self):
        self.assertEqual(run_playwright.reserved_argument(['web/tests/moves.spec.ts', '--workers=2']), '--workers=2')
        self.assertIsNone(run_playwright.reserved_argument(['web/tests/moves.spec.ts:15']))

    def test_report_totals_add_up_both_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / 'a.json', Path(directory) / 'b.json'
            first.write_text(json.dumps({'stats': {'expected': 50, 'unexpected': 1, 'flaky': 0, 'skipped': 1}}))
            second.write_text(json.dumps({'stats': {'expected': 1, 'unexpected': 0, 'flaky': 1, 'skipped': 0}}))
            self.assertEqual(run_playwright.report_totals([first, second]), {'passed': 51, 'failed': 1, 'flaky': 1, 'skipped': 1})


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
