import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('guardrails', ROOT/'scripts/check_guardrails.py')
guardrails = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardrails)

PAIR = ('161_likely_reprint_dismissals.sql', '161_tcgplayer_large_art.sql')


def tree(names):
    directory = tempfile.TemporaryDirectory()
    for name in names:
        (Path(directory.name)/name).write_text('select 1;\n')
    return directory


class MigrationNumberTest(unittest.TestCase):
    def check(self, names, with_pair=True):
        with tree([*names, *(PAIR if with_pair else ())]) as directory:
            return guardrails.migration_number_violations(directory)

    def test_a_new_duplicate_fails(self):
        self.assertTrue(self.check(['001_a.sql', '002_b.sql', '002_c.sql']))

    def test_a_third_file_on_the_allowed_number_fails(self):
        self.assertTrue(self.check(['161_third.sql']))

    def test_the_allow_listed_pair_passes(self):
        self.assertEqual(self.check(['160_a.sql', '162_b.sql']), [])

    def test_a_renamed_allow_listed_file_fails(self):
        self.assertTrue(self.check([PAIR[0], '161_renamed.sql'], with_pair=False))

    def test_a_missing_allow_listed_file_fails(self):
        self.assertTrue(self.check([PAIR[0], '162_b.sql'], with_pair=False))

    def test_only_top_level_sql_files_count(self):
        with tree(['001_a.sql', *PAIR]) as directory:
            (Path(directory)/'core').mkdir()
            (Path(directory)/'core'/'001_a.sql').write_text('select 1;\n')
            self.assertEqual(guardrails.migration_number_violations(directory), [])

    def test_the_real_tree_passes(self):
        self.assertEqual(guardrails.migration_number_violations(ROOT/'migrations'), [])

    def test_disabling_the_check_makes_the_duplicate_test_fail(self):
        with mock.patch.object(guardrails, 'migration_number_violations', lambda directory, allowed=None: []):
            with self.assertRaises(AssertionError):
                self.test_a_new_duplicate_fails()


if __name__ == '__main__':
    unittest.main()
