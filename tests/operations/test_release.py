"""Release command boundary checks, independent of a production provider."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class ReleaseTest(unittest.TestCase):
    def test_gate_rejects_commit_other_than_selected_main_without_creating_store(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Path(temp)/'releases'
            result = subprocess.run([str(ROOT/'.venv/bin/python'), str(ROOT/'scripts/release.py'), 'gate', '--commit', 'a38c674', '--main-ref', 'refs/heads/codex/mvp-integration', '--store', str(store), '--admin-url', 'postgresql://localhost/postgres'],capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse(store.exists())
            self.assertIn(b"Exact main commit required", result.stderr)
