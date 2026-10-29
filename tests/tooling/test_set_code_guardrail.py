import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT/relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guardrails = load('guardrails', 'scripts/check_guardrails.py')
migration = load('set_code_migration', 'scripts/set_code_migration.py')
TSV = 'sv01\tSVI\tScarlet & Violet\tA,B\nsv02\tPAL\tPaldea Evolved\tA,B\n'
EDITED = TSV + 'sv03\tOBF\tObsidian Flames\tA,B\n'


class SetCodeGuardrailTest(unittest.TestCase):
    def test_matching_digest_passes(self):
        self.assertEqual(guardrails.set_code_migration_violations({'160_catalog_set_code.sql': migration.render(TSV)}, TSV), [])

    def test_tsv_edit_without_a_new_migration_fails(self):
        problems = guardrails.set_code_migration_violations({'160_catalog_set_code.sql': migration.render(TSV)}, EDITED)
        self.assertEqual(len(problems), 1)
        self.assertIn('FAILED: set_codes.tsv changed; run scripts/set_code_migration.py <next number>', problems[0][1])

    def test_a_newer_migration_with_the_new_digest_passes(self):
        files = {'160_catalog_set_code.sql': migration.render(TSV), '161_set_codes.sql': migration.render(EDITED)}
        self.assertEqual(guardrails.set_code_migration_violations(files, EDITED), [])
        self.assertTrue(guardrails.set_code_migration_violations(files, TSV))

    def test_migrations_without_a_digest_line_are_ignored_and_none_at_all_fails(self):
        files = {'159_other.sql': 'SELECT 1;\n', '160_catalog_set_code.sql': migration.render(TSV), '161_other.sql': 'SELECT 2;\n'}
        self.assertEqual(guardrails.set_code_migration_violations(files, TSV), [])
        self.assertTrue(guardrails.set_code_migration_violations({'159_other.sql': 'SELECT 1;\n'}, TSV))

    def test_render_is_deterministic_and_lists_rows_in_file_order(self):
        self.assertEqual(migration.render(TSV), migration.render(TSV))
        lines = migration.render(TSV).splitlines()
        self.assertEqual(lines[0], f'-- set_codes.tsv digest: {migration.digest(TSV)}')
        self.assertEqual(lines[1], 'DELETE FROM catalog_set_code;')
        self.assertEqual(lines[2:], ['INSERT INTO catalog_set_code(set_id, code) VALUES', "('sv01', 'SVI'),", "('sv02', 'PAL');"])

    def test_malformed_rows_are_rejected(self):
        for text in ('sv01\tsvi\tName\tA\n', 'sv01\tSVI\tName\n', 'sv01\tSVI\tN\tA\nsv01\tPAL\tN\tA\n'):
            with self.assertRaises(ValueError):
                migration.render(text)

    def test_the_committed_migrations_match_the_committed_tsv(self):
        files = {path.name: path.read_text() for path in (ROOT/'migrations').glob('*.sql')}
        self.assertEqual(guardrails.set_code_migration_violations(files, (ROOT/'api/app/games/pokemon/catalog/set_codes.tsv').read_text(encoding='utf-8')), [])

    def test_the_script_refuses_to_overwrite_a_migration(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder)/'migrations').mkdir()
            target = Path(folder)/'migrations/999_set_codes.sql'
            target.write_text('kept')
            original = migration.ROOT
            migration.ROOT = Path(folder)
            try:
                self.assertEqual(migration.main(['x', '999']), 1)
            finally:
                migration.ROOT = original
            self.assertEqual(target.read_text(), 'kept')


if __name__ == '__main__':
    unittest.main()
