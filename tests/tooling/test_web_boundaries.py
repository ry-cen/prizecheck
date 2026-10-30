import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('check_web_boundaries', ROOT / 'scripts/check_web_boundaries.py')
boundaries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundaries)

GAME = {'web/src/games/pokemon/formats.ts': 'export const F = 1;\n',
        'web/src/games/pokemon/index.ts': 'export const I = 1;\n',
        'web/src/games/riftbound/domains.ts': 'export const D = 1;\n',
        'web/src/ui/Pill.tsx': 'export const Pill = 1;\n'}
TO_FORMATS = 'web/src/catalog/a.ts -> web/src/games/pokemon/formats.ts'


def run(source, path='web/src/catalog/a.ts', allow=''):
    return boundaries.check({**GAME, path: source}, allow)


def shared_to_formats(line=1):
    return [f'forbidden import {TO_FORMATS} (shared to game pokemon, line {line})']


class WebBoundariesTest(unittest.TestCase):
    def test_a_clean_tree_passes(self):
        self.assertEqual(run('import { Pill } from "../ui/Pill";\nimport { useState } from "react";\n'), [])

    def test_a_shared_import_of_a_game_fails(self):
        self.assertEqual(run('import { F } from "../games/pokemon/formats";\n'), shared_to_formats())

    def test_type_imports_and_re_exports_count(self):
        for source in ('import type { F } from "../games/pokemon/formats";\n',
                       'export { F } from "../games/pokemon/formats";\n',
                       'export * from "../games/pokemon/formats";\n',
                       'export * as formats from "../games/pokemon/formats";\n',
                       'export type { F } from "../games/pokemon/formats.ts";\n',
                       "import { F } from '../games/pokemon/formats';\n"):
            with self.subTest(source=source):
                self.assertEqual(run(source), shared_to_formats())

    def test_a_multi_line_import_names_the_specifier_line(self):
        source = 'import {\n  A,\n  B,\n} from "../games/pokemon/formats";\n'
        self.assertEqual(run(source), shared_to_formats(4))

    def test_side_effect_and_dynamic_imports_count(self):
        for source in ('import "../games/pokemon/formats";\n',
                       'const m = await import("../games/pokemon/formats");\n',
                       'const m = lazy(() => import(\n  "../games/pokemon/formats"\n));\n',
                       'const m = import(`../games/pokemon/formats`);\n',
                       'type M = typeof import("../games/pokemon/formats");\n',
                       'import W from "../games/pokemon/formats?worker";\n'):
            with self.subTest(source=source):
                self.assertEqual(len(run(source)), 1)

    def test_a_folder_import_resolves_to_its_index(self):
        self.assertEqual(run('import { I } from "../games/pokemon";\n'),
                         ['forbidden import web/src/catalog/a.ts -> web/src/games/pokemon/index.ts '
                          '(shared to game pokemon, line 1)'])

    def test_comments_and_template_dynamic_imports_are_not_imports(self):
        source = ('// import { F } from "../games/pokemon/formats";\n'
                  '/* export * from "../games/pokemon/formats";\n   import("../games/pokemon/formats") */\n'
                  'const url = "https://example.test//x"; // import("../games/pokemon/formats")\n'
                  'const m = import(`../games/${name}/formats`);\n')
        self.assertEqual(run(source), [])

    def test_a_comment_marker_inside_a_string_does_not_hide_the_next_import(self):
        source = 'const url = "https://example.test/";\nimport { F } from "../games/pokemon/formats";\n'
        self.assertEqual(run(source), shared_to_formats(2))

    def test_a_second_statement_on_the_same_line_counts(self):
        for source in ('import { P } from "../ui/Pill"; import { F } from "../games/pokemon/formats";\n',
                       'const a = 1; export * from "../games/pokemon/formats";\n',
                       'if (a) { b(); } import "../games/pokemon/formats";\n',
                       'const a = 1;import type { F } from "../games/pokemon/formats";\n'):
            with self.subTest(source=source):
                self.assertEqual(run(source), shared_to_formats())

    def test_import_text_inside_a_string_is_not_an_import(self):
        source = ('const a = \'import("../games/pokemon/formats")\';\n'
                  'const b = "x; import { F } from \'../games/pokemon/formats\'";\n'
                  'const c = `\nimport "../games/pokemon/formats";\nexport * from "../games/pokemon/formats";\n`;\n'
                  'const d = "a \\" import(\'../games/pokemon/formats\')";\n'
                  'const e = loader.import("../games/pokemon/formats");\n')
        self.assertEqual(run(source), [])

    def test_an_import_after_a_string_with_import_text_still_counts(self):
        source = 'const a = "import x from \'y\'"; import { F } from "../games/pokemon/formats";\n'
        self.assertEqual(run(source), shared_to_formats())

    def test_a_bare_package_specifier_is_skipped(self):
        self.assertEqual(run('import x from "games/pokemon/formats";\n'), [])

    def test_a_game_may_import_shared_code_and_itself(self):
        source = 'import { Pill } from "../../ui/Pill";\nimport { I } from "./index";\n'
        self.assertEqual(run(source, 'web/src/games/pokemon/deckGroups.ts'), [])

    def test_a_game_to_another_game_fails(self):
        self.assertEqual(run('import { F } from "../pokemon/formats";\n', 'web/src/games/riftbound/x.ts'),
                         ['forbidden import web/src/games/riftbound/x.ts -> web/src/games/pokemon/formats.ts '
                          '(game riftbound to game pokemon, line 1)'])

    def test_a_shared_test_may_import_a_game_but_a_game_test_may_not_import_another(self):
        self.assertEqual(run('import { F } from "../games/pokemon/formats";\n', 'web/src/catalog/a.test.ts'), [])
        self.assertEqual(len(run('import { F } from "../pokemon/formats";\n', 'web/src/games/riftbound/x.test.tsx')), 1)

    def test_a_file_directly_under_games_fails(self):
        self.assertEqual(run('export const x = 1;\n', 'web/src/games/shared.ts'),
                         ['web/src/games/shared.ts is directly under web/src/games: put it in a game'])

    def test_an_allow_listed_composition_point_passes(self):
        self.assertEqual(run('import { F } from "../games/pokemon/formats";\n', allow=f'# why\n{TO_FORMATS}\n'), [])

    def test_a_stale_or_malformed_allow_list_line_fails(self):
        self.assertEqual(run('import { Pill } from "../ui/Pill";\n', allow=f'{TO_FORMATS}\nnot an edge\n'),
                         ['allow-list line 2 is not `<importer> -> <imported>`: not an edge',
                          f'stale allow-list edge {TO_FORMATS}: no such forbidden import'])

    def test_sources_reads_ts_and_tsx_under_web_src_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in ('web/src/a.ts', 'web/src/b/c.tsx', 'web/src/d.css', 'web/tests/e.ts'):
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).write_text('')
            self.assertEqual(sorted(boundaries.sources(root)), ['web/src/a.ts', 'web/src/b/c.tsx'])

    def test_the_tree_matches_its_allow_list(self):
        self.assertEqual(boundaries.check(boundaries.sources(ROOT), boundaries.ALLOWLIST.read_text(encoding='utf-8')), [])


if __name__ == '__main__':
    unittest.main()
