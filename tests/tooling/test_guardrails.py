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
