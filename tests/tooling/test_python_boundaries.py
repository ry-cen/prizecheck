import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('check_python_boundaries', ROOT / 'scripts/check_python_boundaries.py')
boundaries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundaries)

OWNERS = 'app core\napp.util core\napp.prices pokemon\napp.mixed_thing mixed\n'


def tree(directory, files):
    """A fixture api/app under directory, from {relative path: source}; returns the app directory."""
    app = Path(directory) / 'app'
    for relative, source in files.items():
        path = app / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
    return app


def run(files, owners=OWNERS, allow=''):
    with tempfile.TemporaryDirectory() as directory:
        return boundaries.check(tree(directory, {'__init__.py': '', **files}), owners, allow)


class PythonBoundariesTest(unittest.TestCase):
    def test_a_clean_tree_passes(self):
        files = {'main.py': 'from app import util', 'util.py': '', 'prices.py': 'from app import util',
                 'mixed_thing.py': '', 'core/__init__.py': '', 'core/a.py': 'from app import util'}
        self.assertEqual(run(files), [])

    def test_core_to_game_fails(self):
        files = {'util.py': 'from app.games.pokemon import x', 'games/__init__.py': '', 'games/pokemon/__init__.py': '',
                 'games/pokemon/x.py': '', 'prices.py': '', 'mixed_thing.py': ''}
        self.assertEqual(run(files), ['forbidden import app.util -> app.games.pokemon.x (core to game pokemon)'])

    def test_core_to_a_pokemon_owned_top_level_module_fails(self):
        self.assertEqual(run({'util.py': 'import app.prices', 'prices.py': '', 'mixed_thing.py': ''}),
                         ['forbidden import app.util -> app.prices (core to game pokemon)'])

    def test_a_mixed_module_counts_as_core(self):
        self.assertEqual(run({'mixed_thing.py': 'from app import prices', 'prices.py': '', 'util.py': ''}),
                         ['forbidden import app.mixed_thing -> app.prices (core to game pokemon)'])

    def test_core_package_to_root_or_mixed_fails(self):
        files = {'core/__init__.py': '', 'core/a.py': 'import app.main\nimport app.mixed_thing', 'main.py': '',
                 'mixed_thing.py': '', 'util.py': '', 'prices.py': ''}
        self.assertEqual(run(files), ['forbidden import app.core.a -> app.main (core to root)',
                                      'forbidden import app.core.a -> app.mixed_thing (core to a mixed module)'])

    def test_a_game_to_another_game_fails(self):
        files = {'games/__init__.py': '', 'games/pokemon/__init__.py': '', 'games/riftbound/__init__.py': '',
                 'games/pokemon/a.py': 'from ..riftbound import b', 'games/riftbound/b.py': '',
                 'util.py': '', 'prices.py': '', 'mixed_thing.py': ''}
        self.assertEqual(run(files), ['forbidden import app.games.pokemon.a -> app.games.riftbound.b (game pokemon to game riftbound)'])

    def test_a_game_may_import_core_and_root_may_import_anything(self):
        files = {'games/__init__.py': '', 'games/pokemon/__init__.py': '', 'games/pokemon/a.py': 'from app import util',
                 'util.py': '', 'main.py': 'from app.games.pokemon import a\nimport app.prices', 'prices.py': '',
                 'mixed_thing.py': ''}
        self.assertEqual(run(files), [])

    def test_a_function_level_import_is_seen(self):
        files = {'util.py': 'def f():\n    from app import prices\n    return prices', 'prices.py': '', 'mixed_thing.py': ''}
        self.assertEqual(run(files), ['forbidden import app.util -> app.prices (core to game pokemon)'])

    def test_a_relative_import_is_resolved(self):
        files = {'social/__init__.py': '', 'social/a.py': 'from .. import prices', 'prices.py': '', 'util.py': '',
                 'mixed_thing.py': ''}
        owners = OWNERS + 'app.social core\napp.social.a core\n'
        self.assertEqual(run(files, owners), ['forbidden import app.social.a -> app.prices (core to game pokemon)'])

    def test_importlib_import_module_in_core_fails(self):
        files = {'core/__init__.py': '', 'games/__init__.py': '', 'games/pokemon/__init__.py': '', 'games/pokemon/x.py': '',
                 'core/a.py': 'import importlib\nimportlib.import_module("app.games.pokemon.x")', 'util.py': '',
                 'prices.py': '', 'mixed_thing.py': ''}
        self.assertEqual(run(files), ['forbidden import app.core.a -> app.games.pokemon.x (core to game pokemon)'])

    def test_an_allow_listed_edge_passes(self):
        files = {'util.py': 'from app import prices', 'prices.py': '', 'mixed_thing.py': ''}
        self.assertEqual(run(files, allow='[edges]\napp.util -> app.prices\n'), [])

    def test_a_stale_allow_list_line_fails(self):
        files = {'util.py': '', 'prices.py': '', 'mixed_thing.py': ''}
        self.assertEqual(run(files, allow='[edges]\napp.util -> app.prices\n'),
                         ['stale allow-list edge app.util -> app.prices: no such forbidden import'])

    def test_an_unowned_module_fails(self):
        files = {'util.py': '', 'prices.py': '', 'mixed_thing.py': '', 'stray.py': ''}
        self.assertEqual(run(files), ['module app.stray is missing from the owners file'])

    def test_a_stale_owners_line_fails(self):
        files = {'util.py': '', 'prices.py': '', 'mixed_thing.py': ''}
        self.assertEqual(run(files, owners=OWNERS + 'app.gone core\n'), ['owners line names no module: app.gone'])

    def test_sql_on_an_identity_table_outside_identity_store_fails(self):
        files = {'util.py': 'Q = "SELECT 1 FROM session WHERE x"\nR = """\n  UPDATE "user" SET a=1"""\nS = "from sessions_x"',
                 'prices.py': '', 'mixed_thing.py': ''}
        self.assertEqual(run(files), ['SQL on an identity table outside identity_store.py: app.util: session',
                                      'SQL on an identity table outside identity_store.py: app.util: user'])

    def test_the_same_sql_inside_identity_store_passes(self):
        files = {'identity_store.py': 'Q = "SELECT 1 FROM session"', 'util.py': '', 'prices.py': '', 'mixed_thing.py': ''}
        self.assertEqual(run(files, owners=OWNERS + 'app.identity_store core\n'), [])

    def test_a_baselined_sql_hit_passes(self):
        files = {'util.py': 'Q = "DELETE FROM x JOIN account"', 'prices.py': '', 'mixed_thing.py': ''}
        self.assertEqual(run(files, allow='[sql]\napp.util: account\n'), [])

    def test_write_baseline_matches_the_check(self):
        files = {'__init__.py': '', 'util.py': 'from app import prices\nQ = "FROM account"', 'prices.py': '', 'mixed_thing.py': ''}
        with tempfile.TemporaryDirectory() as directory:
            app = tree(directory, files)
            failures, text = boundaries.baseline(app, OWNERS)
            self.assertEqual(failures, [])
            self.assertEqual(boundaries.check(app, OWNERS, text), [])
            self.assertIn('app.util -> app.prices', text)

    def test_the_checked_in_baseline_passes(self):
        self.assertEqual(boundaries.check(boundaries.APP, boundaries.OWNERS.read_text(), boundaries.ALLOWLIST.read_text()), [])


if __name__ == '__main__':
    unittest.main()
