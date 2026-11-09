import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('guardrails', ROOT/'scripts/check_guardrails.py')
guardrails = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardrails)

PAIR = ('161_likely_reprint_dismissals.sql', '161_tcgplayer_large_art.sql')
ALLOWED = {'161': PAIR}


def tree(names):
    directory = tempfile.TemporaryDirectory()
    for name in names:
        (Path(directory.name)/name).write_text('select 1;\n')
    return directory


class MigrationNumberTest(unittest.TestCase):
    def check(self, names, with_pair=True):
        with tree([*names, *(PAIR if with_pair else ())]) as directory:
            return guardrails.migration_number_violations(directory, ALLOWED)

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
            self.assertEqual(guardrails.migration_number_violations(directory, ALLOWED), [])

    def test_the_real_tree_passes(self):
        self.assertEqual(guardrails.migration_number_violations(ROOT/'migrations', guardrails.ALLOWED_DUPLICATE_MIGRATIONS), [])

    def test_a_zero_padded_name_fails(self):
        self.assertTrue(self.check(['162_a.sql', '0162_b.sql']))

    def test_names_the_runner_applies_without_a_number_and_underscore_fail(self):
        for name in ('162.sql', '162-x.sql', '162a_x.sql', 'readme.sql'):
            self.assertTrue(self.check(['162_a.sql', name]), name)

    def test_the_allow_list_matches_in_any_order(self):
        allowed = {'161': tuple(reversed(PAIR))}
        with tree(PAIR) as directory:
            self.assertEqual(guardrails.migration_number_violations(directory, allowed), [])

    def test_nothing_is_allowed_by_default(self):
        with tree(['001_a.sql']) as directory:
            self.assertEqual(guardrails.migration_number_violations(directory), [])
        with tree(PAIR) as directory:
            self.assertTrue(guardrails.migration_number_violations(directory))

    def run_main(self, names):
        """Runs the real main() on a planted root: the real release scripts and .dockerignore, an empty tree otherwise,
        and the set-code check stubbed, so the migration check alone decides the outcome."""
        with tree([]) as root:
            root = Path(root)
            (root/'migrations').mkdir()
            for name in names:
                (root/'migrations'/name).write_text('select 1;\n')
            for relative in ('scripts/release.py', 'scripts/release_runtime.py', '.dockerignore', 'api/app/games/pokemon/catalog/set_codes.tsv'):
                (root/relative).parent.mkdir(parents=True, exist_ok=True)
                (root/relative).write_text((ROOT/relative).read_text(encoding='utf-8'), encoding='utf-8')
            output = io.StringIO()
            with (mock.patch.object(guardrails, 'ROOT', root), mock.patch.object(guardrails, 'set_code_migration_violations', lambda *_: []),
                  contextlib.redirect_stdout(output)):
                return guardrails.main(), output.getvalue()

    def test_main_passes_on_unique_numbers(self):
        self.assertEqual(self.run_main(['001_a.sql', '002_b.sql', *PAIR]), (0, ''))

    def test_main_runs_the_check_and_fails_on_a_duplicate(self):
        status, output = self.run_main(['001_a.sql', '001_b.sql', *PAIR])
        self.assertEqual(status, 1)
        self.assertIn('migrations share number 001', output)


if __name__ == '__main__':
    unittest.main()
