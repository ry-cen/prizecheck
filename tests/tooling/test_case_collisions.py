"""Tracked names must resolve consistently on case-insensitive filesystems."""
from collections import defaultdict
from pathlib import Path, PurePosixPath
import os
import subprocess
import tempfile
from unittest import mock
import unittest

ROOT = Path(__file__).resolve().parents[2]
MODULE_EXTENSIONS = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'}


def collisions(paths):
    full, modules, directories = defaultdict(set), defaultdict(set), defaultdict(set)
    for path in paths:
        full[path.casefold()].add(path)
        parsed = PurePosixPath(path)
        for parent in parsed.parents:
            if str(parent) != '.':
                directories[str(parent).casefold()].add(str(parent))
        if parsed.suffix in MODULE_EXTENSIONS:
            modules[str(parsed.with_suffix('')).casefold()].add(path)
    conflicts = {tuple(sorted(group)) for inventory in (full, modules, directories)
                 for group in inventory.values() if len(group) > 1}
    for key in full.keys() & directories.keys():
        conflicts.add(tuple(sorted(full[key] | directories[key])))
    return sorted(conflicts)


# verify.py copies cached/nonignored source files, then links dependencies. Prune generated
# artifacts a guardrail run may have produced since that copy, and never follow directory links.
EXCLUDED_DIRECTORIES = {'.git', 'node_modules', '.venv', '.scratch', 'dist', '__pycache__',
                        '.pytest_cache', '.mypy_cache', '.ruff_cache', '.vite', '.vite-temp',
                        '.cache', 'coverage', 'htmlcov', 'test-results', 'playwright-report',
                        'blob-report', '.local'}


def source_inventory(root):
    # A copied source root has no Git metadata: never let inherited hook variables
    # or discovery of a parent repository redirect its inventory. For repositories,
    # use their normal index, not an inherited temporary index from commit -a/paths.
    if (root / '.git').exists():
        env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        probe = subprocess.run(['git', 'rev-parse', '--is-inside-work-tree'], cwd=root,
                               env=env, capture_output=True, text=True)
        if probe.returncode or probe.stdout.strip() != 'true':
            raise AssertionError(f'Cannot probe tracked source at {root}: {probe.stderr.strip() or probe.stdout.strip()}')
        result = subprocess.run(['git', 'ls-files', '-z'], cwd=root, env=env, capture_output=True, text=True)
        if result.returncode:
            raise AssertionError(f'Cannot inventory tracked source: {result.stderr.strip()}')
        paths = list(filter(None, result.stdout.split('\0')))
    else:
        paths = []
        for directory, children, files in os.walk(root):
            children[:] = [name for name in children if name not in EXCLUDED_DIRECTORIES
                           and not (Path(directory) / name).is_symlink()]
            paths.extend((Path(directory) / name).relative_to(root).as_posix() for name in files
                         if not name.endswith(('.pyc', '.pyo', '.tsbuildinfo', '.log')))
    if not paths:
        raise AssertionError(f'Empty source inventory at {root}; cannot check case collisions')
    return paths


def fixture_git(root, command, *paths):
    """Build fixtures independently of host config, templates, hooks and ignore rules."""
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull, GIT_CONFIG_NOSYSTEM='1')
    if command == 'init':
        arguments = ['init', '-q', '--initial-branch=fixture', '--template=']
    elif command == 'add':
        arguments = ['add', '-f', '--', *paths]
    else:
        raise ValueError(f'Unsupported fixture command: {command}')
    subprocess.run(['git', *arguments], cwd=root, env=env, check=True,
                   capture_output=True, text=True)


class CaseCollisionsTest(unittest.TestCase):
    def test_full_paths_collide(self):
        self.assertEqual(collisions(['docs/Guide.md', 'docs/guide.md']),
                         [('docs/Guide.md', 'docs/guide.md')])

    def test_module_stems_collide_across_extensions(self):
        self.assertEqual(collisions(['web/src/decks/DeckReadiness.tsx', 'web/src/decks/deckReadiness.ts']),
                         [('web/src/decks/DeckReadiness.tsx', 'web/src/decks/deckReadiness.ts')])
        for extension in ('.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'):
            with self.subTest(extension=extension):
                self.assertTrue(collisions(['a/Foo.ts', 'a/foo' + extension]))

    def test_distinct_tests_directories_and_nonmodules_do_not_collide(self):
        self.assertEqual(collisions(['deckReadiness.ts', 'deckReadiness.test.ts', 'deckReadiness.spec.ts',
                                     'a/item.ts', 'b/item.ts', 'item.css', 'item.js']), [])

    def test_files_and_ancestor_directories_collide(self):
        self.assertEqual(collisions(['a/Foo.ts', 'a/foo.ts/readme.md']),
                         [('a/Foo.ts', 'a/foo.ts')])
        self.assertEqual(collisions(['a/Foo/x', 'a/foo/y']), [('a/Foo', 'a/foo')])
        self.assertEqual(collisions(['a/foo/x', 'a/foo/y', 'b/Foo/x']), [])

    def test_git_free_copy_checks_source_and_excludes_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'source').mkdir()
            (root / 'source/Foo.tsx').touch()
            (root / 'source/foo.ts').touch()
            for name in EXCLUDED_DIRECTORIES - {'.git'}:
                (root / name).mkdir()
                (root / name / 'ignored.ts').touch()
            with mock.patch.dict(os.environ, {'GIT_CEILING_DIRECTORIES': str(root.resolve())}):
                paths = source_inventory(root)
            self.assertEqual(sorted(paths), ['source/Foo.tsx', 'source/foo.ts'])
            self.assertTrue(collisions(paths))

    def test_empty_git_free_copy_fails_clearly(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {'GIT_CEILING_DIRECTORIES': str(Path(directory).resolve())}):
                with self.assertRaisesRegex(AssertionError, 'Empty source inventory'):
                    source_inventory(Path(directory))

    def test_git_metadata_probe_failure_never_falls_back_to_a_walk(self):
        with tempfile.TemporaryDirectory() as directory:
            for metadata in ('directory', 'worktree_file'):
                with self.subTest(metadata=metadata):
                    root = Path(directory) / metadata
                    root.mkdir()
                    if metadata == 'directory':
                        (root / '.git').mkdir()
                    else:
                        (root / '.git').write_text('gitdir: missing-worktree-metadata\n')
                    (root / 'source.ts').touch()
                    with mock.patch.dict(os.environ, {'GIT_DIR': str(root / 'invalid-git-dir')}):
                        with self.assertRaisesRegex(AssertionError, 'Cannot probe tracked source'):
                            source_inventory(root)

    def hook_environment(self, work_tree):
        clean = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        root = Path(fixture.name)
        # No commits or hooks: init/add need no identity or signing, and an explicit
        # branch avoids depending on the user's default-branch configuration.
        fixture_git(root, 'init')
        (root / 'hook-fixture.ts').touch()
        fixture_git(root, 'add', 'hook-fixture.ts')
        env = dict(clean, GIT_DIR=str(root / '.git'), GIT_INDEX_FILE=str(root / '.git/index'), GIT_PREFIX='')
        if work_tree:
            env['GIT_WORK_TREE'] = str(root)
        return env

    def test_hook_overrides_cannot_redirect_git_free_inventory(self):
        for work_tree in (False, True):
            with self.subTest(work_tree=work_tree), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'fixture.ts').touch()
                with mock.patch.dict(os.environ, self.hook_environment(work_tree), clear=True):
                    # A git-free root must not ask Git anything, regardless of inherited overrides.
                    with mock.patch('subprocess.run', side_effect=AssertionError('Git consulted for git-free root')):
                        self.assertEqual(source_inventory(root), ['fixture.ts'])

    def test_hook_overrides_cannot_redirect_a_temporary_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture_git(root, 'init')
            (root / 'fixture.ts').touch()
            fixture_git(root, 'add', 'fixture.ts')
            for work_tree in (False, True):
                with self.subTest(work_tree=work_tree):
                    with mock.patch.dict(os.environ, self.hook_environment(work_tree), clear=True):
                        self.assertEqual(source_inventory(root), ['fixture.ts'])

    def test_hook_overrides_cannot_hide_broken_git_metadata(self):
        for metadata in ('directory', 'worktree_file'):
            for work_tree in (False, True):
                with self.subTest(metadata=metadata, work_tree=work_tree), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    if metadata == 'directory':
                        (root / '.git').mkdir()
                    else:
                        (root / '.git').write_text('gitdir: missing-worktree-metadata\n')
                    (root / 'fixture.ts').touch()
                    with mock.patch.dict(os.environ, self.hook_environment(work_tree), clear=True):
                        with self.assertRaisesRegex(AssertionError, 'Cannot probe tracked source'):
                            source_inventory(root)

    def test_hook_regressions_do_not_require_root_git_metadata(self):
        names = ('test_hook_overrides_cannot_redirect_git_free_inventory',
                 'test_hook_overrides_cannot_redirect_a_temporary_repository',
                 'test_hook_overrides_cannot_hide_broken_git_metadata')
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch(__name__ + '.ROOT', Path(directory)):
                result = unittest.TestResult()
                unittest.TestSuite(type(self)(name) for name in names).run(result)
        self.assertEqual(result.testsRun, 3)
        self.assertEqual(result.errors, [])
        self.assertEqual(result.failures, [])

    def test_fixture_tests_ignore_hostile_user_configuration(self):
        names = ('test_hook_overrides_cannot_redirect_git_free_inventory',
                 'test_hook_overrides_cannot_redirect_a_temporary_repository',
                 'test_hook_overrides_cannot_hide_broken_git_metadata')
        for explicit_global in (False, True):
            with self.subTest(explicit_global=explicit_global), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                template = home / 'template'
                (template / 'info').mkdir(parents=True)
                (template / 'info/exclude').write_text('*.ts\n')
                excludes = home / 'excludes'
                excludes.write_text('fixture.ts\nhook-fixture.ts\n')
                config = home / '.gitconfig'
                config.write_text(f'[init]\n    templateDir = "{template}"\n'
                                  f'[core]\n    excludesFile = "{excludes}"\n')
                env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
                env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / 'xdg'))
                if explicit_global:
                    env['GIT_CONFIG_GLOBAL'] = str(config)
                with mock.patch.dict(os.environ, env, clear=True):
                    result = unittest.TestResult()
                    unittest.TestSuite(type(self)(name) for name in names).run(result)
                self.assertEqual(result.testsRun, 3)
                self.assertEqual(result.errors, [])
                self.assertEqual(result.failures, [])

    def test_source_tree_has_no_collisions(self):
        self.assertEqual(collisions(source_inventory(ROOT)), [])
