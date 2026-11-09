"""Migration tracks (IM-11, IM-12): the shared runner (scripts/migration_tracks.py), the Pokémon entry (scripts/migrate.py)
and the tools that list migration files (deploy/host/prizecheck-deploy.sh, scripts/release.py, scripts/release_runtime.py,
scripts/check_guardrails.py). Nothing here needs a database: the deploy script's Python is run against a fake psycopg, and
the DB-backed proof is api/tests/test_migration_tracks.py. A fixture tree with a core-only pending file is the case the
deploy used to skip."""
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import migration_tracks  # noqa: E402
from migration_tracks import Track  # noqa: E402
import release  # noqa: E402

DEPLOY = (ROOT / 'deploy/host/prizecheck-deploy.sh').read_text()


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tree(base, files):
    """Writes {'core/001_x.sql': text} under base/migrations and returns that directory."""
    for name, text in files.items():
        path = base / 'migrations' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return base / 'migrations'


class FakeConn:
    """Just enough of a psycopg connection for migration_tracks.apply: a ledger set and a log of executed SQL."""
    def __init__(self, applied=()):
        self.ledger, self.log = set(applied), []

    def execute(self, query, params=()):
        self.log.append((query, params))
        rows = [(1,)] if query.startswith('SELECT 1 FROM') and params[0] in self.ledger else []
        if query.startswith('INSERT INTO schema_migration'):
            self.ledger.add(params[0])
        return type('Result', (), {'fetchone': lambda self: rows[0] if rows else None})()

    def transaction(self):
        return type('Tx', (), {'__enter__': lambda self: None, '__exit__': lambda self, *args: False})()


class TrackTest(unittest.TestCase):
    def test_a_track_is_the_root_or_one_directory_under_migrations(self):
        for bad in ('a/b', '.', '..'):
            with self.assertRaises(ValueError):
                Track(bad)
        self.assertEqual((Track().ledger_name('001_x.sql'), Track('core').ledger_name('001_x.sql')), ('001_x.sql', 'core/001_x.sql'))

    def test_pending_core_files_plan_before_game_files_and_ledger_names_are_path_qualified(self):
        with tempfile.TemporaryDirectory() as folder:
            migrations = tree(Path(folder), {'001_a.sql': '', '010_b.sql': '', 'core/002_y.sql': '', 'core/001_x.sql': '', 'core/notes.txt': ''})
            plan = migration_tracks.planned(migrations, (Track('core'), Track()))
            self.assertEqual([name for name, _ in plan], ['core/001_x.sql', 'core/002_y.sql', '001_a.sql', '010_b.sql'])
            self.assertEqual(plan[0][1], migrations / 'core/001_x.sql')

    def test_the_entry_decides_the_order_and_a_missing_directory_is_an_empty_track(self):
        with tempfile.TemporaryDirectory() as folder:
            migrations = tree(Path(folder), {'001_a.sql': ''})
            self.assertEqual([n for n, _ in migration_tracks.planned(migrations, (Track('core'), Track()))], ['001_a.sql'])
            self.assertEqual(migration_tracks.planned(migrations, ()), [])

    def test_a_repeated_track_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                migration_tracks.planned(tree(Path(folder), {'001_a.sql': ''}), (Track(), Track()))

    def test_every_track_lists_the_root_and_each_directory_holding_sql(self):
        with tempfile.TemporaryDirectory() as folder:
            migrations = tree(Path(folder), {'001_a.sql': '', 'core/001_x.sql': '', 'auth/001_z.sql': '', 'empty/readme.md': ''})
            self.assertEqual(set(migration_tracks.files(migrations)), {'001_a.sql', 'core/001_x.sql', 'auth/001_z.sql'})

    def test_apply_records_qualified_names_core_first_and_skips_what_the_ledger_holds(self):
        with tempfile.TemporaryDirectory() as folder:
            migrations = tree(Path(folder), {'001_a.sql': 'SELECT 1', 'core/001_x.sql': 'SELECT 2', 'core/002_y.sql': 'SELECT 3'})
            conn, said = FakeConn(applied={'core/001_x.sql'}), []
            self.assertEqual(migration_tracks.apply(conn, migrations, (Track('core'), Track()), said.append),
                             ['core/002_y.sql', '001_a.sql'])
            self.assertEqual(said, ['Applied core/002_y.sql', 'Applied 001_a.sql'])
            self.assertEqual(conn.ledger, {'core/001_x.sql', 'core/002_y.sql', '001_a.sql'})
            self.assertEqual(migration_tracks.apply(conn, migrations, (Track('core'), Track()), said.append), [])


class PokemonEntryTest(unittest.TestCase):
    def test_the_entry_names_core_then_the_root_track_and_a_fresh_tree_plans_exactly_the_old_glob(self):
        migrate_source = (ROOT / 'scripts/migrate.py').read_text()
        self.assertIn('TRACKS = (Track("core"), Track())', migrate_source)
        self.assertIn('os.environ["DATABASE_URL"]', migrate_source)
        self.assertNotIn('GAME', migrate_source)
        old_glob = [p.name for p in sorted((ROOT / 'migrations').glob('*.sql'))]
        plan = migration_tracks.planned(ROOT / 'migrations', (Track('core'), Track()))
        self.assertEqual([name for name, _ in plan], old_glob)
        self.assertEqual([path.name for _, path in plan], old_glob)
        self.assertGreater(len(old_glob), 80)

    def test_importing_the_entry_applies_nothing_and_leaves_no_bytecode(self):
        run = subprocess.run([sys.executable, '-c', 'import sys; sys.path.insert(0, "scripts"); import migrate; print(migrate.TRACKS)'],
                             cwd=ROOT, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': ''}, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), "(Track(directory='core'), Track(directory=''))")


def heredoc(function_or_marker):
    """The Python the deploy script pipes into a container, found by what it opens with."""
    bodies = re.findall(r"<<'PY'[^\n]*\n(.*?)\nPY\n", DEPLOY, re.S)
    [body] = [b for b in bodies if function_or_marker in b]
    return body


FAKE_PSYCOPG = '''
import os
class Result:
    def __init__(self, rows): self.rows = rows
    def fetchone(self): return self.rows[0]
    def __iter__(self): return iter(self.rows)
class Conn:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def execute(self, query):
        if 'to_regclass' in query: return Result([(True,)])
        return Result([(name,) for name in os.environ['FAKE_LEDGER'].split(',') if name])
def connect(url, **options): return Conn()
'''


class DeployTest(unittest.TestCase):
    def run_in_app(self, body, files, ledger):
        """Runs deploy-script Python with /app replaced by a scratch tree holding the real scripts and fixture migrations."""
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder) / 'app'
            shutil.copytree(ROOT / 'scripts', app / 'scripts', ignore=shutil.ignore_patterns('__pycache__'))
            tree(app, files)
            (Path(folder) / 'fake').mkdir()
            (Path(folder) / 'fake/psycopg.py').write_text(FAKE_PSYCOPG)
            env = {**os.environ, 'PYTHONPATH': str(Path(folder) / 'fake'), 'DATABASE_URL': 'x', 'FAKE_LEDGER': ','.join(ledger),
                   'PYTHONDONTWRITEBYTECODE': '1'}
            return subprocess.run([sys.executable, '-c', body.replace('/app', str(app))], env=env, capture_output=True, text=True)

    def test_a_core_only_pending_file_is_listed_for_the_deploy(self):
        run = self.run_in_app(heredoc("print('schema' if exists"),
                              {'001_a.sql': '', 'core/001_x.sql': ''}, ['001_a.sql'])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.split(), ['schema', 'core/001_x.sql'])

    def test_pending_files_list_core_before_the_root_track_and_skip_applied_ones(self):
        files = {'001_a.sql': '', '002_b.sql': '', 'core/001_x.sql': '', 'core/002_y.sql': ''}
        run = self.run_in_app(heredoc("print('schema' if exists"), files, ['core/001_x.sql', '001_a.sql'])
        self.assertEqual(run.stdout.split(), ['schema', 'core/002_y.sql', '002_b.sql'])

    def test_the_smoke_check_requires_every_track_of_the_entry_in_the_ledger(self):
        body = heredoc('sys.exit(0 if files <= applied else 1)')
        files = {'001_a.sql': '', 'core/001_x.sql': ''}
        self.assertEqual(self.run_in_app(body, files, ['001_a.sql']).returncode, 1)
        self.assertEqual(self.run_in_app(body, files, ['001_a.sql', 'core/001_x.sql']).returncode, 0)


class ToolGlobTest(unittest.TestCase):
    def test_release_compatibility_covers_every_track(self):
        with tempfile.TemporaryDirectory() as folder:
            old = tree(Path(folder) / 'old', {'001_a.sql': 'a', 'core/001_x.sql': 'x'}).parent
            same = tree(Path(folder) / 'same', {'001_a.sql': 'a', 'core/001_x.sql': 'x', 'core/002_y.sql': 'y'}).parent
            changed = tree(Path(folder) / 'changed', {'001_a.sql': 'a', 'core/001_x.sql': 'changed'}).parent
            removed = tree(Path(folder) / 'removed', {'001_a.sql': 'a'}).parent
            release.compatible(old, same)
            for candidate in (changed, removed):
                with self.assertRaises(release.ReleaseError):
                    release.compatible(old, candidate)

    def test_the_local_runtime_requires_every_track_of_a_release_in_the_ledger(self):
        source = (ROOT / 'scripts/release_runtime.py').read_text()
        self.assertIn("required = set(migration_tracks.files(release/'migrations'))", source)

    def test_the_set_code_guardrail_reads_the_pokemon_track_and_a_core_file_cannot_mask_it(self):
        guardrails = load('guardrails', 'scripts/check_guardrails.py')
        tsv = 'sv01\tSVI\tName\tA\n'
        digest = f'-- set_codes.tsv digest: {hashlib.sha256(tsv.encode()).hexdigest()[:16]}\n'
        # 'core/…' sorts after every number, so by name alone it would have been the "newest" file.
        self.assertEqual(guardrails.set_code_migration_violations({'161_codes.sql': digest, 'core/001_x.sql': 'SELECT 1'}, tsv), [])
        self.assertTrue(guardrails.set_code_migration_violations({'core/001_codes.sql': digest}, tsv))


if __name__ == '__main__':
    unittest.main()
