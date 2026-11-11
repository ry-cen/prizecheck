"""The Python catalog run vocabulary must match the immutable migration's CHECK lists."""
import importlib.util
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('catalog_run_states',
    ROOT / 'api/app/games/pokemon/catalog/catalog_run_states.py')
states = importlib.util.module_from_spec(spec)
spec.loader.exec_module(states)


class CatalogRunStatesTest(unittest.TestCase):
    def test_phase_and_outcome_tuples_match_migration_checks(self):
        sql = (ROOT / 'migrations/003_catalog.sql').read_text()
        run_table = re.search(r'CREATE TABLE catalog_run\s*\((.*?)\n\);', sql, re.S).group(1)
        for column, values in [('phase', states.PHASES), ('outcome', states.OUTCOMES)]:
            with self.subTest(column=column):
                check = re.search(rf'CHECK\s*\({column}\s+(?:IS NULL OR {column}\s+)?IN\s*\(([^)]+)\)\)',
                                  run_table, re.I)
                self.assertIsNotNone(check)
                self.assertEqual(values, tuple(re.findall(r"'([^']+)'", check.group(1))))
