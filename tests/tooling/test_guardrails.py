import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('guardrails', Path(__file__).resolve().parents[2]/'scripts/check_guardrails.py')
guardrails = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardrails)


class GuardrailTest(unittest.TestCase):
    def test_private_transport_bypass_is_rejected(self):
        self.assertTrue(guardrails.violations('def forward():\n return urllib.request.urlopen(request)', 'release_runtime.py'))

    def test_raw_external_exception_is_rejected(self):
        self.assertTrue(guardrails.violations('try: run()\nexcept Exception as error: print(str(error))', 'release_runtime.py'))

    def test_fixed_release_errors_are_allowed(self):
        self.assertFalse(guardrails.violations('if isinstance(error, ReleaseError):\n print(str(error))\nelse:\n print("Operation failed")', 'release_runtime.py'))

    def test_ambient_proxy_helper_is_rejected(self):
        self.assertTrue(guardrails.violations('def direct_http_open(request, timeout):\n return urllib.request.build_opener().open(request)', 'release.py'))

    def test_aliased_transport_bypass_is_rejected(self):
        self.assertTrue(guardrails.violations('from urllib.request import urlopen as send\ndef forward():\n return send(request)', 'release_runtime.py'))

    def test_named_external_exception_is_rejected(self):
        self.assertTrue(guardrails.violations('try: run()\nexcept Exception as failure: print(str(failure))', 'release_runtime.py'))

    def test_dynamic_release_error_is_rejected(self):
        self.assertTrue(guardrails.violations('raise ReleaseError(str(error))', 'release_runtime.py'))

    def test_interpolated_external_exception_is_rejected(self):
        self.assertTrue(guardrails.violations('try: run()\nexcept Exception as error: print(f"Failed: {error}")', 'release_runtime.py'))

    def test_host_wide_process_search_is_rejected(self):
        for source in ('subprocess.run(["pkill", "-f", "app.price_runner"])', 'run("pgrep", ["-f", "uvicorn"])', 'killall node'):
            self.assertTrue(guardrails.process_search_violations(source), source)

    def test_scoped_process_cleanup_is_allowed(self):
        self.assertFalse(guardrails.process_search_violations('os.killpg(pid, signal.SIGKILL)\nrun("ps", ["-o", "pid=", "-p", pids])'))

    def test_runner_test_without_tier_marks_is_rejected(self):
        self.assertTrue(guardrails.tier_violations('def test_runner(fs_env, proc):\n pass', 'test_x.py'))
        self.assertTrue(guardrails.tier_violations('@pytest.mark.slow(reason="process: real runner")\ndef test_runner(proc):\n pass', 'test_x.py'))

    def test_runner_test_with_tier_marks_is_allowed(self):
        source = ('@pytest.mark.serial(reason="process: asserts real runner timing")\n'
                  '@pytest.mark.slow(reason="process: launches real runner processes")\n'
                  'def test_runner(fs_env, proc):\n pass')
        self.assertFalse(guardrails.tier_violations(source, 'test_x.py'))

    def test_slow_mark_needs_a_category(self):
        for mark in ('@pytest.mark.slow', '@pytest.mark.slow(reason="takes a while")', '@pytest.mark.slow("process: x")'):
            self.assertTrue(guardrails.tier_violations(f'{mark}\ndef test_x():\n pass', 'test_x.py'), mark)
        self.assertFalse(guardrails.tier_violations('@pytest.mark.slow(reason="capacity: 25 000 Editions")\ndef test_x():\n pass', 'test_x.py'))

    def test_serial_mark_needs_a_reason(self):
        self.assertTrue(guardrails.tier_violations('@pytest.mark.serial\ndef test_x():\n pass', 'test_x.py'))
        self.assertFalse(guardrails.tier_violations('@pytest.mark.serial(reason="wall-clock: asserts < 0.3 s")\ndef test_x():\n pass', 'test_x.py'))
