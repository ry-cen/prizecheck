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


NESTED = 'core/x/001_a.sql'


class NestedMigrationTest(unittest.TestCase):
    """A .sql file two or more directories below migrations/ is refused by name where it used to be ignored (S3R-11). Root
    files and files directly in a track directory behave as they always did. The suffix is matched as the runner globs it:
    lower-case .sql only, at every depth."""
    def test_nested_files_are_listed_by_path_and_one_level_files_are_not(self):
        with tempfile.TemporaryDirectory() as folder:
            migrations = tree(Path(folder), {'001_a.sql': '', 'core/001_x.sql': '', NESTED: '', 'a/b/c/002_b.sql': '',
                                             'core/x/readme.md': '', 'core/x/002_b.SQL': ''})
            self.assertEqual(migration_tracks.nested_files(migrations), ['a/b/c/002_b.sql', NESTED])
            self.assertEqual(migration_tracks.nested_files(tree(Path(folder) / 'ok', {'001_a.sql': '', 'core/001_x.sql': ''})), [])

    def test_every_listing_function_refuses_the_tree_and_names_each_file(self):
        with tempfile.TemporaryDirectory() as folder:
            migrations = tree(Path(folder), {'001_a.sql': '', 'core/001_x.sql': '', NESTED: '', 'a/b/c/002_b.sql': ''})
            for call in (lambda: migration_tracks.planned(migrations, (Track('core'), Track())),
                         lambda: migration_tracks.files(migrations), lambda: migration_tracks.every_track(migrations)):
                with self.assertRaises(migration_tracks.NestedMigrationError) as raised:
                    call()
                self.assertIn('migrations/core/x/001_a.sql', str(raised.exception))
                self.assertIn('migrations/a/b/c/002_b.sql', str(raised.exception))

    def test_apply_refuses_before_it_runs_or_records_anything(self):
        with tempfile.TemporaryDirectory() as folder:
            migrations = tree(Path(folder), {'001_a.sql': 'SELECT 1', 'core/001_x.sql': 'SELECT 2', NESTED: 'SELECT 3'})
            conn, said = FakeConn(), []
            with self.assertRaises(migration_tracks.NestedMigrationError):
                migration_tracks.apply(conn, migrations, (Track('core'), Track()), said.append)
            self.assertEqual((conn.log, conn.ledger, said), ([], set(), []))

    def test_root_and_one_level_files_still_plan_and_apply_and_a_nested_non_sql_or_upper_case_file_is_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            migrations = tree(Path(folder), {'001_a.sql': 'SELECT 1', 'core/001_x.sql': 'SELECT 2', 'core/x/notes.txt': '',
                                             'core/x/002_b.SQL': '', 'core/003_c.SQL': ''})
            conn = FakeConn()
            self.assertEqual(migration_tracks.apply(conn, migrations, (Track('core'), Track()), lambda line: None),
                             ['core/001_x.sql', '001_a.sql'])
            self.assertEqual(set(migration_tracks.files(migrations)), {'001_a.sql', 'core/001_x.sql'})

    def test_a_symlinked_directory_is_not_followed(self):
        with tempfile.TemporaryDirectory() as folder:
            migrations = tree(Path(folder), {'001_a.sql': '', 'core/001_x.sql': ''})
            outside = Path(folder) / 'outside'
            (outside / 'deep').mkdir(parents=True)
            (outside / 'deep' / '009_z.sql').write_text('')
            (migrations / 'core' / 'link').symlink_to(outside, target_is_directory=True)
            self.assertEqual(migration_tracks.nested_files(migrations), [])

    def test_the_release_tools_refuse_a_nested_file_in_either_release(self):
        with tempfile.TemporaryDirectory() as folder:
            clean = tree(Path(folder) / 'clean', {'001_a.sql': 'a', 'core/001_x.sql': 'x'}).parent
            nested = tree(Path(folder) / 'nested', {'001_a.sql': 'a', 'core/001_x.sql': 'x', NESTED: 'n'}).parent
            for previous, candidate in ((clean, nested), (nested, clean)):
                with self.assertRaises(release.ReleaseError) as raised:
                    release.compatible(previous, candidate)
                self.assertEqual(str(raised.exception), 'A migration file sits more than one directory below migrations/; migrations cannot be compared')
                self.assertIn('migrations/core/x/001_a.sql', str(raised.exception.__cause__))
            with self.assertRaises(release.ReleaseError):
                release.migration_files(nested / 'migrations')
            release.compatible(clean, clean)


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
    def execute(self, query, params=()):
        with open(os.environ['FAKE_SQL_LOG'], 'a') as log:
            log.write(query.splitlines()[0] + '\\n')
        if 'to_regclass' in query: return Result([(True,)])
        return Result([(name,) for name in os.environ['FAKE_LEDGER'].split(',') if name])
def connect(url, **options): return Conn()
'''

# What a release before migration tracks did on import: its migrate.py ran its migrations at module level.
OLD_IMAGE_MIGRATE = '''
import os
import psycopg
with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY)")
'''
BEFORE_TRACKS = 'c42d6fb142811ede4db9e393b68d6b6543585571'  # dev before migration tracks: no migration_tracks.py


class DeployTest(unittest.TestCase):
    def run_in_app(self, body, files, ledger, scripts=None):
        """Runs deploy-script Python with /app replaced by a scratch tree holding fixture migrations and `scripts` (this
        checkout's by default), against a fake psycopg. The result's `.sql` lists the first line of each statement run."""
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder) / 'app'
            shutil.copytree(scripts or ROOT / 'scripts', app / 'scripts', ignore=shutil.ignore_patterns('__pycache__'))
            tree(app, files)
            (Path(folder) / 'fake').mkdir()
            (Path(folder) / 'fake/psycopg.py').write_text(FAKE_PSYCOPG)
            log = Path(folder) / 'sql.log'
            env = {**os.environ, 'PYTHONPATH': str(Path(folder) / 'fake'), 'DATABASE_URL': 'x', 'FAKE_LEDGER': ','.join(ledger),
                   'FAKE_SQL_LOG': str(log), 'PYTHONDONTWRITEBYTECODE': '1'}
            run = subprocess.run([sys.executable, '-c', body.replace('/app', str(app))], env=env, capture_output=True, text=True)
            run.sql = log.read_text().splitlines() if log.exists() else []
            return run

    def test_a_core_only_pending_file_is_listed_for_the_deploy(self):
        run = self.run_in_app(heredoc("print('schema' if exists"),
                              {'001_a.sql': '', 'core/001_x.sql': ''}, ['001_a.sql'])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.split(), ['schema', 'core/001_x.sql'])

    def test_pending_files_list_core_before_the_root_track_and_skip_applied_ones(self):
        files = {'001_a.sql': '', '002_b.sql': '', 'core/001_x.sql': '', 'core/002_y.sql': ''}
        run = self.run_in_app(heredoc("print('schema' if exists"), files, ['core/001_x.sql', '001_a.sql'])
        self.assertEqual(run.stdout.split(), ['schema', 'core/002_y.sql', '002_b.sql'])

    def test_the_deploy_list_and_smoke_check_refuse_a_nested_file_but_the_old_image_fallback_is_unchanged(self):
        files = {'001_a.sql': '', NESTED: ''}
        for body in (heredoc("print('schema' if exists"), heredoc('sys.exit(0 if files <= applied else 1)')):
            run = self.run_in_app(body, files, ['001_a.sql'])
            self.assertNotEqual(run.returncode, 0)
            self.assertIn('migrations/core/x/001_a.sql', run.stderr)
        # An image from before migration tracks has no migration_tracks.py: the flat glob it always had, with nothing new to trip.
        body = heredoc('sys.exit(0 if files <= applied else 1)')
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'migrate.py').write_text(OLD_IMAGE_MIGRATE)
            self.assertEqual(self.run_in_app(body, files, ['001_a.sql'], Path(folder)).returncode, 0)

    def test_the_smoke_check_requires_every_track_of_the_entry_in_the_ledger(self):
        body = heredoc('sys.exit(0 if files <= applied else 1)')
        files = {'001_a.sql': '', 'core/001_x.sql': ''}
        self.assertEqual(self.run_in_app(body, files, ['001_a.sql']).returncode, 1)
        self.assertEqual(self.run_in_app(body, files, ['001_a.sql', 'core/001_x.sql']).returncode, 0)

    def assert_smoke_passes_without_importing_the_entry(self, scripts):
        """The smoke check also runs in the previous release on a rollback or a restore. That release has the flat root
        files only, no migration_tracks.py, and a migrate.py that migrates when imported."""
        body = heredoc('sys.exit(0 if files <= applied else 1)')
        run = self.run_in_app(body, {'001_a.sql': '', '002_b.sql': ''}, ['001_a.sql', '002_b.sql'], scripts)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.sql, ['SELECT name FROM schema_migration'])
        self.assertEqual(self.run_in_app(body, {'001_a.sql': '', '002_b.sql': ''}, ['001_a.sql'], scripts).returncode, 1)

    def test_the_smoke_check_passes_in_an_image_from_before_migration_tracks(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'migrate.py').write_text(OLD_IMAGE_MIGRATE)
            self.assert_smoke_passes_without_importing_the_entry(Path(folder))

    def test_the_smoke_check_passes_against_the_scripts_of_the_commit_before_migration_tracks(self):
        if subprocess.run(['git', 'cat-file', '-e', BEFORE_TRACKS + '^{commit}'], cwd=ROOT, capture_output=True).returncode:
            self.skipTest('a shallow clone does not hold ' + BEFORE_TRACKS)
        with tempfile.TemporaryDirectory() as folder:
            archive = subprocess.run(['git', 'archive', BEFORE_TRACKS, 'scripts'], cwd=ROOT, capture_output=True, check=True).stdout
            subprocess.run(['tar', '-x', '-C', folder], input=archive, check=True)
            self.assertFalse((Path(folder) / 'scripts/migration_tracks.py').exists())
            self.assert_smoke_passes_without_importing_the_entry(Path(folder) / 'scripts')

    def test_the_smoke_check_passes_against_this_checkouts_scripts(self):
        body = heredoc('sys.exit(0 if files <= applied else 1)')
        run = self.run_in_app(body, {'001_a.sql': '', 'core/001_x.sql': ''}, ['001_a.sql', 'core/001_x.sql'])
        self.assertEqual(run.returncode, 0, run.stderr)


class LoneReleaseCopyTest(unittest.TestCase):
    """tests/operations/test_release.py copies only release.py into a scratch repository and runs its gate there. The
    commit checks must still run, and the migration comparison must refuse rather than pass without the track tool."""
    def lone_copy(self, folder):
        (Path(folder) / 'scripts').mkdir(parents=True)
        shutil.copy2(ROOT / 'scripts/release.py', Path(folder) / 'scripts/release.py')
        return Path(folder) / 'scripts/release.py'

    def test_the_gate_reaches_its_commit_check_from_a_lone_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder) / 'repo'
            script = self.lone_copy(repo)
            # A commit hook exports GIT_DIR and GIT_INDEX_FILE; git would then init, configure and stage into the real
            # repository instead of the scratch one.
            env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=repo, text=True, env=env).strip()
            git('init', '-q', '-b', 'main')
            git('config', 'user.email', 'fixture@example.test')
            git('config', 'user.name', 'Release fixture')
            (repo / 'fixture').write_text('first')
            git('add', '.'); git('commit', '-q', '-m', 'first')
            previous = git('rev-parse', 'HEAD')
            (repo / 'fixture').write_text('second')
            git('add', '.'); git('commit', '-q', '-m', 'second')
            run = subprocess.run([sys.executable, str(script), 'gate', '--commit', previous, '--main-ref', 'refs/heads/main',
                                  '--store', str(Path(folder) / 'releases'), '--admin-url', 'postgresql://localhost/postgres'],
                                 capture_output=True, text=True, env=env)
            self.assertNotEqual(run.returncode, 0)
            self.assertNotIn('ModuleNotFoundError', run.stderr)
            self.assertIn('Exact main commit required', run.stderr)
            self.assertFalse((Path(folder) / 'releases').exists())

    def test_the_migration_comparison_refuses_without_the_track_tool_instead_of_passing(self):
        with tempfile.TemporaryDirectory() as folder:
            script = self.lone_copy(Path(folder) / 'lone')
            old = tree(Path(folder) / 'old', {'001_a.sql': 'a', 'core/001_x.sql': 'x'}).parent
            new = tree(Path(folder) / 'new', {'001_a.sql': 'a', 'core/001_x.sql': 'changed'}).parent
            code = ('import importlib.util, sys; from pathlib import Path\n'
                    f'spec = importlib.util.spec_from_file_location("lone_release", {str(script)!r}); m = importlib.util.module_from_spec(spec)\n'
                    'spec.loader.exec_module(m)\n'
                    'try:\n    m.compatible(Path(sys.argv[1]), Path(sys.argv[2]))\nexcept m.ReleaseError as error:\n    print(error); sys.exit(7)\n')
            run = subprocess.run([sys.executable, '-I', '-c', code, str(old), str(new)], capture_output=True, text=True, cwd=folder)
            self.assertEqual((run.returncode, run.stdout.strip()), (7, 'migration_tracks.py is missing beside release.py; migrations cannot be compared'), run.stderr)


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
        self.assertIn("required = set(migration_files(release/'migrations'))", source)

    def test_the_set_code_guardrail_reads_the_pokemon_track_and_a_core_file_cannot_mask_it(self):
        guardrails = load('guardrails', 'scripts/check_guardrails.py')
        tsv = 'sv01\tSVI\tName\tA\n'
        digest = f'-- set_codes.tsv digest: {hashlib.sha256(tsv.encode()).hexdigest()[:16]}\n'
        # 'core/…' sorts after every number, so by name alone it would have been the "newest" digest file, and a stale one.
        STALE = '-- set_codes.tsv digest: 0000000000000000\n'
        self.assertEqual(guardrails.set_code_migration_violations({'161_codes.sql': digest, 'core/001_x.sql': STALE + 'SELECT 1'}, tsv), [])
        self.assertTrue(guardrails.set_code_migration_violations({'core/001_codes.sql': digest}, tsv))


if __name__ == '__main__':
    unittest.main()
