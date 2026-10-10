"""Pure parts of the verification harness: scripts/verify.py, run_pytest.py, run_playwright.py, verify_resources.py and
verify_report.py. Nothing here needs a database, a browser or a network."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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
ADMIN = 'postgresql://tcg@127.0.0.1:5432/postgres'


class VerifyArgumentsTest(unittest.TestCase):
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
            self.assertIn('api.tests.test_a::test_x | parallel | 3.5', (run / 'verification.log').read_text())


if __name__ == '__main__':
    unittest.main()
