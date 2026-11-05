"""Local verification integration at argument/environment/collection seams. No DB/service/browser fixture."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from contextlib import ExitStack, nullcontext

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import local_verify
import run_pytest
from local_admission import Registry
from local_api_selection import fingerprint


class LocalVerificationTest(unittest.TestCase):
    def test_worker_budgets_and_admin_override_are_enforced(self):
        for args in (['--suite', 'api'], ['--suite', 'api', '--pytest-workers', '3'],
                     ['--admin-url', 'postgresql://other@localhost/postgres']):
            with self.assertRaises(ValueError):
                local_verify.arguments(args)
        args, forwarded, prepare, exclusive = local_verify.arguments(
            ['--prepare', '--suite', 'api', '--pytest-workers', '2', '--', 'api/tests/test_holdings.py'])
        self.assertEqual(args.pytest_workers, 2)
        self.assertTrue(prepare)
        self.assertNotIn('--prepare', forwarded)
        self.assertFalse(exclusive)

    def test_admin_url_aliases_cannot_override_the_generated_local_url(self):
        other = 'postgresql://other@127.0.0.1:5433/postgres'
        sentinel = 'postgresql://unused@127.0.0.1/postgres'
        for option in ('--admin-url', '--admin', '--admin-u', '--a'):
            for url in (other, sentinel):
                for tokens in ([option, url], [option + '=' + url]):
                    with self.subTest(tokens=tokens), self.assertRaises(ValueError):
                        local_verify.arguments(tokens)
        # The intentional direct CI/admin-URL parser retains its existing interface.
        self.assertEqual(local_verify.verify.parse_arguments(['--admin-url', other]).admin_url, other)
        self.assertEqual(local_verify.verify.parse_arguments(['--admin-u=' + other]).admin_url, other)

    def test_child_receives_only_generated_url_and_release_follows_pg_stop(self):
        generated = 'postgresql://owned@127.0.0.1:5439/postgres'
        args, command, _, _ = local_verify.arguments(['--suite', 'api', '--pytest-workers', '2', '--', 'api/tests/test_holdings.py'])
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory).resolve()
            registry = Registry(root / 'registry')
            instance = mock.Mock()
            instance.record.return_value = None
            instance.url.return_value = generated
            instance.native_bins.return_value = root / 'pg16'
            events = []

            def child(command, registry, token, env, cwd):
                self.assertEqual(env['TEST_ADMIN_DATABASE_URL'], generated)
                self.assertNotIn('DATABASE_URL', env)
                self.assertNotIn('--admin-url', command)
                self.assertNotIn('postgresql://unused@127.0.0.1/postgres', command)
                self.assertEqual(len(registry.snapshot()), 1)
                events.append('child cleaned')
                artifacts = root / 'artifacts'
                artifacts.mkdir()
                Path(env['VERIFY_ADMISSION_RECEIPT']).write_text(json.dumps(dict(token=token, clean=True, artifacts=str(artifacts))))
                return 0, True

            def stop():
                self.assertEqual(events, ['child cleaned'])
                self.assertEqual(len(registry.snapshot()), 1)
                events.append('PG stopped')
                return 0

            def running(bins):
                self.assertEqual(events[-1], 'PG stopped')
                events.append('PG verified absent')
                return False

            instance.native_running.side_effect = running
            for name, value in (('ROOT', root),):
                stack.enter_context(mock.patch.object(local_verify, name, value))
            stack.enter_context(mock.patch.object(local_verify, 'fingerprint', return_value='key'))
            stack.enter_context(mock.patch.object(local_verify, 'source_fingerprint', return_value='source'))
            stack.enter_context(mock.patch.object(local_verify, 'supervise', side_effect=child))
            stack.enter_context(mock.patch.object(local_verify.db, 'Instance', return_value=instance))
            stack.enter_context(mock.patch.object(local_verify.db, 'native_bin_dir', return_value=root / 'pg16'))
            stack.enter_context(mock.patch.object(local_verify.db, 'candidate_bin_dirs', return_value=[]))
            stack.enter_context(mock.patch.object(local_verify.db.subprocess, 'run', return_value=mock.Mock(stdout='postgres (PostgreSQL) 16.0')))
            stack.enter_context(mock.patch.object(local_verify.db, 'start', return_value=(instance, {'backend': 'native', 'major': 16})))
            stack.enter_context(mock.patch.object(local_verify.db, 'state_lock', return_value=nullcontext()))
            stack.enter_context(mock.patch.object(local_verify.db, 'stop_locked', side_effect=stop))
            self.assertEqual(local_verify.run_admitted(args, command, False, 'api', 'key', registry), 0)
            self.assertEqual(events, ['child cleaned', 'PG stopped', 'PG verified absent'])
            self.assertEqual(registry.snapshot(), [])

    def automatic_run(self, report, outcome=0, changed=False, selectors=None, cached=False):
        # Real queue admission/release with a fake prepared run; no database, service or application fixture.
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory).resolve()
            registry = Registry(root / 'registry')
            events = []
            evidence = dict(report) if cached else {}

            def phase(args, command, prepare, mode, key, actual_registry):
                self.assertIs(actual_registry, registry)
                self.assertEqual(registry.snapshot(), [], 'previous phase must release before requeue')
                token = registry.enqueue(root, mode, args.pytest_workers if mode == 'api' else 0)
                self.assertTrue(registry.admit(token))
                events.append(('prepare' if prepare else 'tests', mode, list(command), key))
                if prepare:
                    evidence.update(report)
                registry.remove(token)  # Fake harness resource cleanup and PG stop completed.
                return outcome

            stack.enter_context(mock.patch.object(local_verify, 'ROOT', root))
            stack.enter_context(mock.patch.object(local_verify, 'physical_dependencies'))
            stack.enter_context(mock.patch.object(local_verify, 'Registry', return_value=registry))
            stack.enter_context(mock.patch.object(local_verify, 'fingerprint', side_effect=['key', 'changed' if changed else 'key']))
            stack.enter_context(mock.patch.object(local_verify, 'collection_report', side_effect=lambda key: dict(evidence)))
            stack.enter_context(mock.patch.object(local_verify, 'run_admitted', side_effect=phase))
            argv = ['--suite', 'api', '--pytest-workers', '2', '--', *(selectors or ['api/tests/test_holdings.py'])]
            try:
                code = local_verify.main(argv)
            except RuntimeError as error:
                code = str(error)
            return code, events

    def test_fresh_selection_releases_exclusive_preparation_then_requeues_api_tests(self):
        code, events = self.automatic_run(dict(version=1, complete=True, nodeids=['case'], serial=[]))
        self.assertEqual(code, 0)
        self.assertEqual([(e[0], e[1]) for e in events], [('prepare', 'exclusive'), ('tests', 'api')])
        self.assertEqual(events[0][2:], events[1][2:])  # Same exact selector/worker/fingerprint identity.

    def test_serial_and_unknown_selections_never_share_slots(self):
        code, events = self.automatic_run(dict(version=1, complete=True, nodeids=['case'], serial=['case']))
        self.assertEqual(code, 0)
        self.assertEqual([(e[0], e[1]) for e in events], [('prepare', 'exclusive'), ('tests', 'exclusive')])
        code, events = self.automatic_run({}, selectors=['--lf'])
        self.assertEqual(code, 0)
        self.assertEqual([(e[0], e[1]) for e in events], [('tests', 'exclusive')])

    def test_cached_selection_needs_no_extra_prepare(self):
        code, events = self.automatic_run(dict(version=1, complete=True, nodeids=['case'], serial=[]), cached=True)
        self.assertEqual(code, 0)
        self.assertEqual([(e[0], e[1]) for e in events], [('tests', 'api')])

    def test_preparation_failure_missing_evidence_or_changed_fingerprint_stops_before_tests(self):
        report = dict(version=1, complete=True, nodeids=['case'], serial=[])
        for options, expected in ((dict(outcome=7), 7), (dict(report={}), 'no complete classification'),
                                  (dict(changed=True), 'changed after preparation')):
            settings = dict(report=report, **{k:v for k,v in options.items() if k != 'report'})
            if 'report' in options:
                settings['report'] = options['report']
            code, events = self.automatic_run(**settings)
            if isinstance(expected, int):
                self.assertEqual(code, expected)
            else:
                self.assertIn(expected, code)
            self.assertEqual([(e[0], e[1]) for e in events], [('prepare', 'exclusive')])

    def test_inherited_urls_temp_and_pytest_overrides_are_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with mock.patch.dict(os.environ, dict(TEST_ADMIN_DATABASE_URL='untrusted', DATABASE_URL='untrusted',
                                                 TMPDIR='/elsewhere', PYTEST_ADDOPTS='--lf', VERIFY_SUITE='browser')):
                env = local_verify.local_environment(root)
            for name in ('TEST_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PYTEST_ADDOPTS', 'VERIFY_SUITE'):
                self.assertNotIn(name, env)
            self.assertEqual(env['TMPDIR'], str(root / '.scratch/tmp'))
            self.assertTrue(Path(env['TMPDIR']).is_dir())

    def test_borrowed_dependencies_and_tmpdir_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / '.venv').mkdir()
            (root / 'node_modules').mkdir()
            local_verify.physical_dependencies(root)
            (root / 'node_modules').rmdir()
            (root / 'node_modules').symlink_to(root / '.venv', target_is_directory=True)
            with self.assertRaises(RuntimeError):
                local_verify.physical_dependencies(root)
            (root / '.scratch').mkdir()
            (root / '.scratch/tmp').symlink_to(root / '.venv', target_is_directory=True)
            with self.assertRaises(RuntimeError):
                local_verify.local_environment(root)

    def test_cleanup_receipt_is_not_inferred_from_child_exit_or_signal(self):
        self.assertFalse(local_verify.receipt_clean({}, 'token'))
        self.assertFalse(local_verify.receipt_clean({'token': 'other', 'clean': True}, 'token'))
        self.assertFalse(local_verify.receipt_clean({'token': 'token', 'clean': False}, 'token'))
        self.assertTrue(local_verify.receipt_clean({'token': 'token', 'clean': True}, 'token'))

    def test_fingerprint_binds_source_arguments_worktree_and_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ('.venv', 'node_modules'):
                (root / name).mkdir()
            source = root / 'test.py'
            source.write_text('one')
            with mock.patch('local_api_selection.subprocess.check_output', return_value=b'test.py\0'):
                key = fingerprint(root, ['selection'])
                self.assertNotEqual(key, fingerprint(root, ['other']))
                source.write_text('two')
                self.assertNotEqual(key, fingerprint(root, ['selection']))
                source.write_text('one')
                (root / '.venv/package.py').write_text('package')
                self.assertNotEqual(key, fingerprint(root, ['selection']))

    def test_dynamic_inherited_and_parameter_serial_markers_are_collected_and_guarded(self):
        # Uses pytest's real collection of a tiny generated module. No application conftest or fixtures.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'report.json'
            executed = root / 'executed'
            (root / 'pytest.ini').write_text('[pytest]\nmarkers =\n    serial(reason): exclusive\n')
            (root / 'conftest.py').write_text('''import pytest
def pytest_collection_modifyitems(items):
    for item in items:
        if item.name == 'test_hook_mark':
            item.add_marker(getattr(pytest.mark, 'serial')('added by collection hook'))
''')
            (root / 'test_selection.py').write_text(f'''import pytest
class TestInherited:
    pytestmark = getattr(pytest.mark, 'serial')('inherited dynamically')
    @pytest.mark.parametrize('value', [pytest.param(1, marks=pytest.mark.serial('parameter'))])
    def test_example(self, value):
        open({str(executed)!r}, 'w').close()
def test_hook_mark():
    open({str(executed)!r}, 'w').close()
''')
            env = dict(os.environ, PYTHONPATH=str(ROOT / 'scripts'), PYTEST_DISABLE_PLUGIN_AUTOLOAD='1',
                       VERIFY_ADMISSION_COLLECTION=str(report), VERIFY_ADMISSION_MODE='api')
            command = [sys.executable, '-m', 'pytest', '-q', '-p', 'local_admission_pytest', str(root / 'test_selection.py')]
            result = subprocess.run([*command, '--collect-only'], cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            evidence = json.loads(report.read_text())
            self.assertEqual(len(evidence['serial']), 2)
            self.assertFalse(evidence['complete'])  # Parent run_pytest, not a hook, attests the successful exit.
            result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Serial cases appeared', result.stdout + result.stderr)
            self.assertFalse(executed.exists())

    def test_admitted_run_cannot_ignore_failed_collection(self):
        with mock.patch.dict(os.environ, {'VERIFY_ADMISSION_MODE': 'api'}), \
             mock.patch.object(run_pytest.subprocess, 'run', return_value=mock.Mock(returncode=2)) as run:
            self.assertEqual(run_pytest.main(['--', 'api/tests/test_holdings.py']), 2)
            self.assertEqual(run.call_count, 1)

    def test_missing_pytest_reports_fail_without_hiding_a_child_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {'TEST_LOG_DIR': directory}, clear=True), \
                 mock.patch.object(run_pytest.subprocess, 'run', return_value=mock.Mock(returncode=0)):
                self.assertEqual(run_pytest.main(['--', 'api/tests/test_holdings.py']), 1)
            with mock.patch.dict(os.environ, {'TEST_LOG_DIR': directory}, clear=True), \
                 mock.patch.object(run_pytest.subprocess, 'run', side_effect=[mock.Mock(returncode=7), mock.Mock(returncode=0)]):
                self.assertEqual(run_pytest.main(['--', 'api/tests/test_holdings.py']), 7)

    def test_unknown_pytest_status_cannot_become_a_successful_cli_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {'TEST_LOG_DIR': directory}, clear=True), \
                 mock.patch.object(run_pytest.subprocess, 'run', return_value=mock.Mock(returncode=None)):
                self.assertEqual(run_pytest.main(['--', 'api/tests/test_holdings.py']), 1)
            with mock.patch.dict(os.environ, {'TEST_LOG_DIR': directory, 'VERIFY_ADMISSION_MODE': 'api'}, clear=True), \
                 mock.patch.object(run_pytest.subprocess, 'run', return_value=mock.Mock(returncode=None)) as run:
                self.assertEqual(run_pytest.main(['--', 'api/tests/test_holdings.py']), 1)
                self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
