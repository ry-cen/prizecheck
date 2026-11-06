"""Exercise the disposable logger's privacy, bounds and failure isolation without a browser or DB."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]


class Sh02DiagnosticsTest(unittest.TestCase):
    def test_protocol_capture_is_private_bounded_and_passive(self):
        result = subprocess.run(['node', '--test', 'scripts/sh02-diagnostics.test.mjs'], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
