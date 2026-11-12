"""Audit real Linux discovery results without repeating admission process fixtures."""
import sys
import unittest

import io
from pathlib import Path
import tempfile
import uuid

EXPECTED_IDS = (
    'test_local_admission.AdmissionTest.test_two_worktrees_overlap_third_waits_and_four_workers_is_the_bound',
    'test_local_admission.AdmissionTest.test_exclusive_drains_without_later_api_overtaking',
    'test_local_admission.AdmissionTest.test_same_worktree_cannot_overlap_and_api_budget_is_validated',
    'test_local_admission.AdmissionTest.test_exception_after_admission_retains_ownership',
    'test_local_admission.AdmissionTest.test_dead_active_owner_is_never_automatically_reaped',
    'test_local_admission.AdmissionTest.test_recovery_refuses_live_owner_or_live_child_group',
    'test_local_admission.AdmissionTest.test_only_dead_waiter_can_be_discarded',
    'test_local_admission.AdmissionTest.test_unknown_identity_blocks_instead_of_expiring_ownership',
    'test_local_admission.AdmissionTest.test_child_failure_preserves_exit_status_and_proves_empty_group',
    'test_local_admission.AdmissionTest.test_atomic_claims_from_separate_processes_and_worktree_paths',
    'test_local_admission.AdmissionTest.test_crashed_supervisor_keeps_live_child_reserved',
    'test_local_admission.AdmissionTest.test_interrupt_waits_for_child_cleanup_and_does_not_forward_second_interrupt',
    'test_local_admission.AdmissionTest.test_startup_interrupt_is_forwarded_once_only_after_child_registration',
    'test_local_verify.LocalVerificationTest.test_child_receives_only_generated_url_and_release_follows_pg_stop',
    'test_local_verify.LocalVerificationTest.test_fresh_selection_releases_exclusive_preparation_then_requeues_api_tests',
    'test_local_verify.LocalVerificationTest.test_serial_and_unknown_selections_never_share_slots',
    'test_local_verify.LocalVerificationTest.test_cached_selection_needs_no_extra_prepare',
    'test_local_verify.LocalVerificationTest.test_preparation_failure_missing_evidence_or_changed_fingerprint_stops_before_tests',
)


class CoverageSuite(unittest.TestSuite):
    """Observe the shared discovery result and audit it when the runner finishes."""
    def __init__(self, tests, expected=EXPECTED_IDS):
        super().__init__(tests)
        self.expected = set(expected)

    def run(self, result, debug=False):
        successful = set()
        original_success, original_stop = result.addSuccess, result.stopTestRun

        def success(test):
            successful.add(test.id())
            original_success(test)

        def stop():
            # Restore dispatch before running the final assertion on the same result.
            result.addSuccess, result.stopTestRun = original_success, original_stop

            def audit():
                missing = self.expected - successful
                if missing:
                    raise AssertionError('Required Linux tests did not execute successfully: ' +
                                         ', '.join(sorted(missing)))

            unittest.FunctionTestCase(audit, description='Required Linux admission coverage').run(result)
            original_stop()

        result.addSuccess, result.stopTestRun = success, stop
        return super().run(result, debug)


def load_tests(loader, tests, pattern):
    # This module sorts before the target modules in full discovery. No target imports:
    # an import-time SkipTest there must not prevent installing the final audit here.
    return CoverageSuite(tests) if sys.platform == 'linux' else tests


class LinuxAdmissionCoverageTest(unittest.TestCase):
    def test_expected_ids_pin_thirteen_admission_and_five_verify_tests(self):
        self.assertEqual(len(set(EXPECTED_IDS)), 18)
        self.assertEqual(sum(name.startswith('test_local_admission.AdmissionTest.') for name in EXPECTED_IDS), 13)
        self.assertEqual(sum(name.startswith('test_local_verify.LocalVerificationTest.') for name in EXPECTED_IDS), 5)

    def run_mutation(self, mutation):
        # Use normal import/discovery, module fixtures, suite dispatch and runner finalization.
        with tempfile.TemporaryDirectory() as directory:
            name = 'test_admission_mutation_' + uuid.uuid4().hex
            source = """import unittest
calls = []
class Admission(unittest.TestCase):
    def test_required(self):
        calls.append('body')
"""
            if mutation == 'class_skip':
                source = source.replace('class Admission', "@unittest.skip('class mutation')\nclass Admission")
            elif mutation == 'method_skip':
                source = source.replace('    def test_required', "    @unittest.skip('method mutation')\n    def test_required")
            elif mutation == 'renamed':
                source = source.replace('test_required', 'test_renamed')
            elif mutation == 'removed':
                source = 'import unittest\ncalls = []\n'
            elif mutation == 'setup_skip':
                source += "    def setUp(self):\n        self.skipTest('fixture mutation')\n"
            elif mutation == 'class_fixture_skip':
                source += "    @classmethod\n    def setUpClass(cls):\n        raise unittest.SkipTest('class fixture mutation')\n"
            elif mutation == 'module_fixture_skip':
                source += "def setUpModule():\n    raise unittest.SkipTest('module fixture mutation')\n"
            elif mutation == 'import_skip':
                source = "import unittest\nraise unittest.SkipTest('import mutation')\n"
            elif mutation == 'body_skip':
                source += "        self.skipTest('body mutation')\n"
            (Path(directory) / (name + '.py')).write_text(source)
            previous_path = sys.path[:]
            try:
                suite = unittest.TestLoader().discover(directory, pattern=name + '.py')
                stream = io.StringIO()
                result = unittest.TextTestRunner(stream=stream).run(
                    CoverageSuite(suite, (name + '.Admission.test_required',)))
                calls = getattr(sys.modules.get(name), 'calls', [])
                return result, stream.getvalue(), calls
            finally:
                sys.path[:] = previous_path
                sys.modules.pop(name, None)

    def test_all_skip_and_missing_test_mutations_fail_real_discovery(self):
        for mutation in ('class_skip', 'method_skip', 'renamed', 'removed', 'setup_skip',
                         'class_fixture_skip', 'module_fixture_skip', 'import_skip', 'body_skip'):
            with self.subTest(mutation=mutation):
                result, output, _ = self.run_mutation(mutation)
                self.assertFalse(result.wasSuccessful(), output)
                self.assertEqual(len(result.failures), 1, output)
                self.assertIn('Required Linux tests did not execute successfully', output)

    def test_successful_real_body_executes_once(self):
        result, output, calls = self.run_mutation('success')
        self.assertTrue(result.wasSuccessful(), output)
        self.assertEqual(result.testsRun, 2)  # One real test and the final coverage assertion.
        self.assertEqual(calls, ['body'])
