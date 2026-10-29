import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('check_bundle_boundary', ROOT / 'scripts/check_bundle_boundary.py')
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)

PUBLISHED = 'src/public/PublishedDeckPage.tsx'
WORKSPACE = 'src/workspace/Workspace.tsx'
RUNTIME = 'src/scanner/worker/ort.ts'
WORKER = 'src/scanner/worker/recognizer.worker.ts'
ORT_PACKAGE = '/node_modules/onnxruntime-web/dist/ort.mjs'


def write_build(directory, records):
    """A fixture build under directory: web/ (the web root) and out/ (manifest, chunks and their source maps)."""
    web, out = Path(directory) / 'web', Path(directory) / 'out'
    (out / '.vite').mkdir(parents=True)
    (out / 'assets').mkdir()
    web.mkdir()
    for record in records.values():
        (out / record['file']).write_text('x = 1;')
        sources = [os.path.relpath(source if os.path.isabs(source) else web / source, out / 'assets')
                   for source in record['sources']]
        (out / (record['file'] + '.map')).write_text(json.dumps({'version': 3, 'sources': sources, 'mappings': ''}))
    manifest = {key: {name: value for name, value in record.items() if name != 'sources'} for key, record in records.items()}
    (out / '.vite' / 'manifest.json').write_text(json.dumps(manifest))
    return out, web


def clean(**changes):
    records = {
        'index.html': {'file': 'assets/index.js', 'isEntry': True, 'imports': ['_shared.js'],
                       'dynamicImports': [PUBLISHED, WORKSPACE], 'sources': ['src/main.tsx', 'src/shell/Shell.tsx']},
        'scan.html': {'file': 'assets/scan.js', 'isEntry': True, 'imports': ['_shared.js'],
                      'sources': ['src/scanner/entry/main.tsx']},
        '_shared.js': {'file': 'assets/_shared.js', 'sources': ['src/ui/Button.tsx']},
        PUBLISHED: {'file': 'assets/published.js', 'isDynamicEntry': True, 'imports': ['_shared.js'],
                    'sources': [PUBLISHED]},
        WORKSPACE: {'file': 'assets/workspace.js', 'isDynamicEntry': True, 'sources': [WORKSPACE]},
    }
    for key, change in changes.items():
        records[key] = {**records[key], **change}
    return records


def run_check(directory, records, **kwargs):
    out, web = write_build(directory, records)
    return boundary.check(out, web, [PUBLISHED], [WORKSPACE], kwargs.pop('extra', []), **kwargs)


class BundleBoundaryTest(unittest.TestCase):
    def test_a_clean_split_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run_check(directory, clean())
            self.assertTrue(result['ok'])
            self.assertEqual(result['problems'], [])
            self.assertEqual([route['route'] for route in result['routes']], ['entry', PUBLISHED, 'scanner'])
            self.assertEqual(result['routes'][1]['chunks'], 3)

    def test_the_scanner_entry_may_reach_the_runtime(self):
        records = clean(**{'scan.html': {'imports': ['_shared.js', '_runtime.js']}})
        records['_runtime.js'] = {'file': 'assets/_runtime.js', 'sources': [RUNTIME, WORKER, ORT_PACKAGE]}
        with tempfile.TemporaryDirectory() as directory:
            result = run_check(directory, records, extra=[RUNTIME, WORKER])
            self.assertTrue(result['ok'], result['problems'])
            self.assertEqual(result['routes'][-1]['route'], 'scanner')

    def test_the_runtime_in_the_main_entry_fails(self):
        for source in (RUNTIME, WORKER):
            records = clean(**{'index.html': {'sources': ['src/main.tsx', source]}})
            with tempfile.TemporaryDirectory() as directory:
                result = run_check(directory, records, extra=[RUNTIME, WORKER])
                self.assertFalse(result['ok'])
                self.assertIn(f'{source} is in assets/index.js on the entry route', result['problems'])

    def test_the_runtime_in_a_public_pages_graph_fails(self):
        records = clean(**{PUBLISHED: {'imports': ['_shared.js', '_runtime.js']}})
        records['_runtime.js'] = {'file': 'assets/_runtime.js', 'sources': [RUNTIME]}
        with tempfile.TemporaryDirectory() as directory:
            result = run_check(directory, records, extra=[RUNTIME])
            self.assertIn(f'{RUNTIME} is in assets/_runtime.js on the {PUBLISHED} route', result['problems'])

    def test_the_onnx_package_is_only_allowed_in_the_scanner_entry(self):
        records = clean(**{'index.html': {'sources': ['src/main.tsx', ORT_PACKAGE]}})
        with tempfile.TemporaryDirectory() as directory:
            out, web = write_build(directory, records)
            result = boundary.check(out, web, [PUBLISHED], [WORKSPACE], [])
            self.assertIn('onnxruntime-web is in assets/index.js on the entry route', result['problems'])
        records = clean(**{PUBLISHED: {'sources': [PUBLISHED, ORT_PACKAGE]}})
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(run_check(directory, records)['ok'])

    def test_a_lazy_page_in_the_scanner_entry_fails(self):
        records = clean(**{'scan.html': {'sources': ['src/scanner/entry/main.tsx', WORKSPACE]}})
        with tempfile.TemporaryDirectory() as directory:
            result = run_check(directory, records)
            self.assertIn(f'{WORKSPACE} is in assets/scan.js on the scanner route', result['problems'])

    def test_both_entries_are_required(self):
        for missing in ('index.html', 'scan.html'):
            records = {key: record for key, record in clean().items() if key != missing}
            with tempfile.TemporaryDirectory() as directory:
                result = run_check(directory, records)
                self.assertFalse(result['ok'])
                self.assertIn('expected the entries', result['problems'][0])
        records = clean()
        records['extra.html'] = {'file': 'assets/extra.js', 'isEntry': True, 'sources': []}
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(run_check(directory, records)['ok'])

    def test_the_scanner_runtime_modules_are_extra_private_modules(self):
        self.assertTrue({RUNTIME, WORKER} <= set(boundary.EXTRA_PRIVATE_MODULES))

    def test_a_private_page_in_a_public_pages_graph_fails(self):
        records = clean(**{PUBLISHED: {'imports': ['_shared.js', '_leak.js']}})
        records['_leak.js'] = {'file': 'assets/_leak.js', 'sources': [WORKSPACE]}
        with tempfile.TemporaryDirectory() as directory:
            result = run_check(directory, records)
            self.assertFalse(result['ok'])
            self.assertIn(f'{WORKSPACE} is in assets/_leak.js on the {PUBLISHED} route', result['problems'])

    def test_an_extra_private_module_in_a_public_graph_fails(self):
        records = clean(**{PUBLISHED: {'sources': [PUBLISHED, 'src/trades/TradeScreen.tsx']}})
        with tempfile.TemporaryDirectory() as directory:
            result = run_check(directory, records, extra=['src/trades/TradeScreen.tsx'])
            self.assertFalse(result['ok'])

    def test_a_lazy_page_folded_into_the_entry_fails(self):
        records = clean(**{'index.html': {'sources': ['src/main.tsx', 'src/trades/TradesPage.tsx']}})
        with tempfile.TemporaryDirectory() as directory:
            out, web = write_build(directory, records)
            result = boundary.check(out, web, [PUBLISHED], [WORKSPACE, 'src/trades/TradesPage.tsx'], [])
            self.assertFalse(result['ok'])
            self.assertIn('src/trades/TradesPage.tsx has no chunk of its own; something imports it statically', result['problems'])
            self.assertIn('src/trades/TradesPage.tsx is in assets/index.js on the entry route', result['problems'])

    def test_a_public_page_in_the_entry_fails(self):
        records = clean(**{'index.html': {'sources': ['src/main.tsx', PUBLISHED]}})
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(run_check(directory, records)['ok'])

    def test_dynamic_imports_are_not_followed(self):
        records = clean(**{'index.html': {'dynamicImports': [PUBLISHED, WORKSPACE, 'src/trades/TradesPage.tsx']}})
        records['src/trades/TradesPage.tsx'] = {'file': 'assets/trades.js', 'isDynamicEntry': True,
                                                'sources': ['src/trades/TradesPage.tsx']}
        with tempfile.TemporaryDirectory() as directory:
            out, web = write_build(directory, records)
            result = boundary.check(out, web, [PUBLISHED], [WORKSPACE, 'src/trades/TradesPage.tsx'], [])
            self.assertTrue(result['ok'], result['problems'])

    def test_a_module_outside_the_web_root_is_not_a_leak(self):
        with tempfile.TemporaryDirectory() as directory:
            records = clean(**{PUBLISHED: {'sources': [PUBLISHED, str(Path(directory) / 'node_modules/x' / WORKSPACE)]}})
            self.assertTrue(run_check(directory, records)['ok'])

    def test_a_missing_source_map_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            out, web = write_build(directory, clean())
            (out / 'assets/_shared.js.map').unlink()
            result = boundary.check(out, web, [PUBLISHED], [WORKSPACE], [])
            self.assertFalse(result['ok'])
            self.assertIn('no source map for assets/_shared.js', result['problems'])

    def test_an_ineffective_dynamic_import_warning_fails(self):
        warning = ('(!) /x.tsx is dynamically imported by a but also statically imported by b, '
                   'dynamic import will not move module into another chunk.\n')
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(run_check(directory, clean(), build_output=warning)['ok'])

    def test_lazy_pages_are_parsed_in_both_forms(self):
        source = '''import { lazy } from "react";
export const loadA = () =>
  import("../a/APage");
export const A = lazy(() =>
  loadA().then((m) => ({ default: m.A }))
);
export const B = lazy(() =>
  import("../b/BPage").then((m) => ({ default: m.B }))
);
export function preload(path: string): void {
  loadA();
}
'''
        self.assertEqual(boundary.lazy_pages(source), {'A': 'src/a/APage', 'B': 'src/b/BPage'})

    def test_lazy_page_helper_pages_are_parsed_in_both_forms(self):
        source = '''export const loadA = () => import("../a/APage");
export const A = lazyPage(loadA, (m) => m.A);
export const B = lazyPage(
  () => import("../b/BPage"),
  (m) => m.B
);
export const C = lazyPage(missing, (m) => m.C);
'''
        self.assertEqual(boundary.lazy_pages(source), {'A': 'src/a/APage', 'B': 'src/b/BPage', 'C': None})

    def test_a_lazy_page_without_an_import_is_reported(self):
        source = 'export const X = lazy(() => missing().then((m) => ({ default: m.X })));'
        self.assertEqual(boundary.lazy_pages(source), {'X': None})
        with tempfile.TemporaryDirectory() as directory:
            web = Path(directory) / 'web'
            (web / 'src/shell').mkdir(parents=True)
            (web / 'src/public').mkdir()
            (web / 'src/shell/lazyPages.ts').write_text(source)
            (web / 'src/public/PublicPageView.tsx').write_text('import { X } from "../shell/lazyPages";')
            problems = boundary.page_sets(web)[3]
            self.assertIn('X in lazyPages.ts has no import path', problems)
            self.assertTrue(problems)

    def test_the_real_lazy_pages_split_into_public_and_private(self):
        public, private, extra, problems = boundary.page_sets(ROOT / 'web')
        self.assertEqual(problems, [])
        self.assertEqual(public, ['src/discover/DiscoverPage.tsx', 'src/public/InvitePage.tsx', PUBLISHED])
        self.assertTrue({WORKSPACE, 'src/collectionImport/CollectionImportPage.tsx', 'src/decks/DecksPage.tsx',
                         'src/decks/DeckBuilderPage.tsx', 'src/decks/import/ImportPage.tsx',
                         'src/decks/import/ReplaceListPage.tsx', 'src/catalog/CatalogPage.tsx', 'src/loans/LoansPage.tsx',
                         'src/trades/TradesPage.tsx', 'src/reports/MissingCardsPage.tsx',
                         'src/owner/OwnerControlsPage.tsx', 'src/trades/FriendTradeListPage.tsx'} <= set(private))
        self.assertEqual(len(extra), 6)

    def test_main_writes_the_report_before_failing(self):
        records = clean(**{PUBLISHED: {'imports': ['_shared.js', '_leak.js']}})
        records['_leak.js'] = {'file': 'assets/_leak.js', 'sources': [WORKSPACE]}
        with tempfile.TemporaryDirectory() as directory:
            out, web = write_build(directory, records)
            path = Path(directory) / 'report.json'
            with mock.patch.object(boundary, 'page_sets', return_value=([PUBLISHED], [WORKSPACE], [], [])), \
                    mock.patch.object(boundary, 'ROOT', Path(directory)), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(boundary.main(['--out', str(out), '--report', str(path)]), 1)
            self.assertFalse(json.loads(path.read_text())['ok'])

    def test_virtual_module_sources_are_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            out, web = write_build(directory, clean())
            path = out / 'assets/index.js.map'
            data = json.loads(path.read_text())
            data['sources'].append('\u0000vite/preload-helper.js')
            path.write_text(json.dumps(data))
            self.assertTrue(boundary.check(out, web, [PUBLISHED], [WORKSPACE], [])['ok'])
