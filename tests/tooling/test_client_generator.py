import importlib.util
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(SCRIPTS))
    return module


gen = load('client_generator')
everything = load('generate_all_clients')

STRING = {'type': 'string'}
NULL = {'type': 'null'}
REF = {'$ref': '#/components/schemas/Card'}


class SchemaShapes(unittest.TestCase):
    def test_scalars_and_refs(self):
        ts = gen.SINGLE.ts_type
        self.assertEqual(ts(STRING), 'string')
        self.assertEqual(ts({'type': 'integer'}), 'number')
        self.assertEqual(ts({'type': 'number'}), 'number')
        self.assertEqual(ts({'type': 'boolean'}), 'boolean')
        self.assertEqual(ts(REF), 'Card')

    def test_nullable_is_a_union_with_null(self):
        self.assertEqual(gen.SINGLE.ts_type({'anyOf': [STRING, NULL]}), 'string | null')
        self.assertEqual(gen.SINGLE.ts_type({'anyOf': [REF, NULL]}), 'Card | null')

    def test_objects_without_a_model_are_records(self):
        self.assertEqual(gen.SINGLE.ts_type({'type': 'object'}), 'Record<string, unknown>')

    def test_enum_and_const_use_the_clients_quote(self):
        enum = {'type': 'string', 'enum': ['a', 'b']}
        const = {'type': 'string', 'const': 'a'}
        self.assertEqual(gen.SINGLE.ts_type(enum), "'a' | 'b'")
        self.assertEqual(gen.DOUBLE.ts_type(enum), '"a" | "b"')
        self.assertEqual(gen.SINGLE.ts_type(const), "'a'")
        self.assertEqual(gen.DOUBLE.ts_type(const), '"a"')

    def test_nullable_enum_inside_any_of(self):
        value = {'anyOf': [{'type': 'string', 'enum': ['x', 'y']}, NULL]}
        self.assertEqual(gen.SINGLE.ts_type(value), "'x' | 'y' | null")

    def test_array_of_a_plain_element_is_not_parenthesized(self):
        self.assertEqual(gen.SINGLE.ts_type({'type': 'array', 'items': STRING}), 'string[]')
        self.assertEqual(gen.SINGLE.ts_type({'type': 'array', 'items': REF}), 'Card[]')

    def test_array_of_a_union_is_parenthesized(self):
        # `A | B[]` would mean A or an array of B, so a union element always needs the parentheses.
        for style in (gen.SINGLE, gen.DOUBLE):
            self.assertEqual(style.ts_type({'type': 'array', 'items': {'anyOf': [REF, NULL]}}), '(Card | null)[]')
        enum = {'type': 'array', 'items': {'type': 'string', 'enum': ['a', 'b']}}
        self.assertEqual(gen.SINGLE.ts_type(enum), "('a' | 'b')[]")

    def test_nested_arrays(self):
        nested = {'type': 'array', 'items': {'type': 'array', 'items': {'anyOf': [STRING, NULL]}}}
        self.assertEqual(gen.SINGLE.ts_type(nested), '((string | null)[])[]')

    def test_always_parenthesized_arrays_are_a_kept_cosmetic_choice(self):
        style = gen.TypeStyle(parenthesize_arrays='always')
        self.assertEqual(style.ts_type({'type': 'array', 'items': STRING}), '(string)[]')
        self.assertEqual(style.ts_type({'type': 'array', 'items': {'anyOf': [STRING, NULL]}}), '(string | null)[]')

    def test_unknown_types_fail_loudly(self):
        with self.assertRaises(KeyError):
            gen.SINGLE.ts_type({'type': 'mystery'})

    DEFINITION = {'required': ['id', 'tags'], 'properties': {
        'id': STRING, 'tags': {'type': 'array', 'items': STRING}, 'parent': {'anyOf': [STRING, NULL]}}}

    def test_object_marks_optional_fields(self):
        self.assertEqual(gen.SINGLE.alias('Row', self.DEFINITION),
                         'export type Row = { id: string; tags: string[]; parent?: string | null };')

    def test_object_with_every_field_present(self):
        style = gen.TypeStyle(optional_marks=False)
        self.assertEqual(style.alias('Row', self.DEFINITION),
                         'export type Row = { id: string; tags: string[]; parent: string | null };')

    def test_fields_can_be_filtered_and_all_required(self):
        fields = gen.SINGLE.fields(self.DEFINITION, only=lambda name: name == 'parent', all_required=True)
        self.assertEqual(fields, ['parent: string | null'])

    def test_aliases_follow_the_names_given(self):
        schemas = {'A': self.DEFINITION, 'B': {'properties': {'n': {'type': 'integer'}}}}
        self.assertEqual(gen.SINGLE.aliases(schemas, ('B', 'A'))[0], 'export type B = { n?: number };')

    def test_a_model_without_fields_fails_loudly(self):
        with self.assertRaises(KeyError):
            gen.SINGLE.alias('Empty', {'type': 'object'})


class Transport(unittest.TestCase):
    def test_error_classes_differ_only_by_what_a_domain_carries(self):
        self.assertEqual(gen.error_class('PriceError'), '\n'.join([
            'export class PriceError extends Error {',
            '  constructor(public status: number, public code: string) { super(code); }',
            '}']))
        self.assertIn('public detail: Record<string, unknown> = {}) { super(code); }',
                      gen.error_class('SocialError', 'public detail: Record<string, unknown> = {}'))

    def test_docs_go_before_the_class_or_the_constructor(self):
        self.assertTrue(gen.error_class('E', doc='/** class */').startswith('/** class */\nexport class E'))
        self.assertIn('{\n  /** ctor */\n  constructor(', gen.error_class('E', constructor_doc='/** ctor */'))

    def test_failure_block_reads_the_apis_code_with_the_domain_default(self):
        self.assertEqual(gen.failure_block('PriceError', 'PRICE_REQUEST_FAILED'), '\n'.join([
            '  if (!response.ok) {',
            '    const payload = await response.json().catch(() => ({}));',
            "    throw new PriceError(response.status, payload?.detail?.code ?? 'PRICE_REQUEST_FAILED');",
            '  }']))

    def test_request_function_variants(self):
        plain = gen.simple_request('DeckError', 'DECK_REQUEST_FAILED')
        self.assertIn('async function request<T>(path: string, method: string, body?: object): Promise<T> {', plain)
        self.assertNotIn('signal', plain)
        self.assertNotIn('onResponse', plain)
        cancellable = gen.simple_request('DiscoveryError', 'D', signal=True)
        self.assertIn('body?: object, signal?: AbortSignal): Promise<T>', cancellable)
        self.assertIn("{ method, credentials: 'same-origin', signal,", cancellable)
        defaulted = gen.simple_request('HoldingError', 'H', method="method = 'GET'")
        self.assertIn("path: string, method = 'GET', body?: object", defaulted)
        observed = gen.simple_request('PublicationError', 'P', on_response=True)
        self.assertIn('onResponse?: (response: Response) => void', observed)
        self.assertLess(observed.index('onResponse?.(response);'), observed.index('return response.json()'))

    def test_detail_failure_keeps_the_whole_detail_object(self):
        lines = gen.detail_failure_lines('TradesError', 'TRADES_REQUEST_FAILED')
        self.assertIn("typeof payload.detail === 'object'", lines)
        self.assertIn("throw new TradesError(response.status, detail.code ?? 'TRADES_REQUEST_FAILED', detail);", lines)

    def test_header_names_the_script(self):
        self.assertEqual(gen.header('generate_x_client'),
                         '// Generated from FastAPI OpenAPI by scripts/generate_x_client.py. Do not edit.')
        self.assertEqual(gen.header('generate_x_client', source=False),
                         '// Generated by scripts/generate_x_client.py. Do not edit.')


def generated(name):
    return (ROOT / 'web/src' / f'{name}_generated.ts').read_text()


class DomainDifferencesInTheCommittedClients(unittest.TestCase):
    """What differs between clients on purpose; a refactor of the generators must not flatten it."""

    def error_signature(self, name, cls):
        match = re.search(rf'export class {cls} extends Error \{{\n(?:  /\*\*[^\n]*\*/\n)?  constructor\(([^)]*)\)', generated(name))
        self.assertIsNotNone(match, cls)
        return match.group(1)

    def test_each_errors_extra_fields(self):
        base = 'public status: number, public code: string'
        self.assertEqual(self.error_signature('prices', 'PriceError'), base)
        self.assertEqual(self.error_signature('decks', 'DeckError'), base)
        self.assertEqual(self.error_signature('holdings', 'HoldingError'), base + ', public editionId: string | null = null')
        self.assertEqual(self.error_signature('collection_import', 'CollectionImportError'),
                         base + ', public count: string | null = null')
        self.assertEqual(self.error_signature('moves', 'MoveError'), base + ', public detail: MoveErrorDetail = {}')
        for name, cls in (('profile', 'ProfileError'), ('trades', 'TradesError'), ('social', 'SocialError'),
                          ('scanner', 'ScannerError')):
            self.assertEqual(self.error_signature(name, cls), base + ', public detail: Record<string, unknown> = {}')

    def test_each_domains_default_code(self):
        defaults = {'location': 'LOCATION_REQUEST_FAILED', 'holdings': 'HOLDING_REQUEST_FAILED',
                    'decks': 'DECK_REQUEST_FAILED', 'settings': 'SETTINGS_REQUEST_FAILED',
                    'social': 'SOCIAL_REQUEST_FAILED', 'trades': 'TRADES_REQUEST_FAILED',
                    'scanner': 'SCANNER_REQUEST_FAILED', 'prices': 'PRICE_REQUEST_FAILED',
                    'catalog_browse': 'CATALOG_BROWSE_FAILED', 'live_export': 'LIVE_EXPORT_FAILED',
                    'collection_import': 'COLLECTION_IMPORT_REQUEST_FAILED'}
        for name, code in defaults.items():
            self.assertIn(f"'{code}'", generated(name), name)

    def test_only_some_clients_can_be_cancelled(self):
        for name in ('discovery', 'trades', 'social', 'prices', 'want_list', 'want_list_cost', 'format_checks',
                     'catalog_browse', 'mass_entry', 'live_export'):
            self.assertIn('AbortSignal', generated(name), name)
        for name in ('holdings', 'moves', 'decks', 'settings', 'profile', 'publications', 'location'):
            self.assertNotIn('AbortSignal', generated(name), name)

    def test_published_reads_send_no_cookie(self):
        for name in ('live_export', 'mass_entry', 'prices', 'format_checks'):
            self.assertIn("credentials: 'omit'", generated(name), name)
            self.assertIn("credentials: 'same-origin'", generated(name), name)

    def test_responses_that_always_carry_every_field_have_no_optional_marks(self):
        for name in ('prices', 'format_checks', 'catalog_browse'):
            types_block = generated(name).split('\n\n')[0]  # the generated types; hand-written query types follow
            self.assertNotRegex(types_block, r'\w\?:', name)

    def test_no_undo_move_has_a_dedicated_route_and_normal_requests_are_unchanged(self):
        moves = generated('moves')
        self.assertIn('put_away = false)', moves)
        self.assertIn('put_away ? { destination_id, idempotency_key, put_away } : { destination_id, idempotency_key }', moves)
        self.assertIn('export const commitMoveWithoutUndo =', moves)
        self.assertIn("/commit-without-undo`, 'POST', { destination_id, idempotency_key }", moves)
        self.assertNotIn('undo =', moves)
        self.assertNotIn('undo: false', moves)

    def test_domain_errors_stay_separate_except_the_shared_holding_error(self):
        for name in ('collection', 'reconciliation', 'metadata'):
            self.assertIn("from './holdings_generated'", generated(name))
            if name != 'collection':
                self.assertNotIn('export class', generated(name))
        # #473 keeps HoldingError for every Collection read; only the borrowed batch Move has its own write error.
        collection = generated('collection')
        self.assertEqual(re.findall(r'export class (\w+)', collection), ['BorrowedMoveError'])
        read_body = collection.split('async function read<T>', 1)[1].split('export const getCollection', 1)[0]
        self.assertIn('throw new HoldingError', read_body)
        self.assertNotIn('BorrowedMoveError', read_body)
        write_body = collection.split('export async function moveBorrowedCopies', 1)[1].split('export const', 1)[0]
        self.assertIn("fetch('/api/collection/borrowed/moves'", write_body)
        self.assertIn('throw new BorrowedMoveError', write_body)
        self.assertNotIn('HoldingError', write_body)
        self.assertNotIn('new BorrowedMoveError', collection.replace(write_body, ''))


class Emitters(unittest.TestCase):
    def test_every_emitter_has_its_own_generated_file(self):
        names = everything.emitter_names()
        self.assertIn('generate_client', names)
        self.assertEqual(len(names), len(list(SCRIPTS.glob('generate_*_client.py'))) + 1)
        targets = []
        for name in names:
            module = load(name)
            targets.append(module.TARGET)
            self.assertTrue(callable(module.render), name)
            self.assertTrue((ROOT / module.TARGET).exists(), name)
        self.assertEqual(len(set(targets)), len(targets))
        on_disk = {str(path.relative_to(ROOT)) for path in (ROOT / 'web/src').rglob('*generated.ts')}
        self.assertEqual(set(targets), on_disk)

    def test_riftbound_client_reads_the_riftbound_contract_through_its_prefix(self):
        module = load('generate_riftbound_catalog_client')
        text = (ROOT / module.TARGET).read_text()
        for needle in ("RIFTBOUND_API_PREFIX = '/api/riftbound'", '/catalog/editions', 'AbortSignal',
                       "credentials: 'same-origin'", "'RIFTBOUND_CATALOG_REQUEST_FAILED'"):
            self.assertIn(needle, text)
        self.assertNotIn("'/api/catalog", text)
        self.assertTrue(callable(module.load_openapi))

    def test_no_emitter_carries_its_own_schema_traversal(self):
        for name in everything.emitter_names():
            source = (SCRIPTS / f'{name}.py').read_text()
            self.assertNotIn('def ts_type', source, name)
            self.assertNotIn('"$ref"', source, name)
            self.assertNotIn("'$ref'", source, name)


class PokemonPrefix(unittest.TestCase):
    """The moved routes are called under /api/pokemon; every other path, and the OpenAPI contract, stay as they are."""

    def test_a_quoted_moved_route_gets_the_prefix_on_a_segment_boundary(self):
        rewrite = gen.pokemon_paths
        self.assertEqual(rewrite("fetch('/api/want-list')"), "fetch('/api/pokemon/want-list')")
        self.assertEqual(rewrite("fetch('/api/want-list' + x)"), "fetch('/api/pokemon/want-list' + x)")
        self.assertEqual(rewrite("`/api/catalog/editions${suffix}`"), "`/api/pokemon/catalog/editions${suffix}`")
        self.assertEqual(rewrite('"/api/collection-imports?x=1"'), '"/api/pokemon/collection-imports?x=1"')
        self.assertEqual(rewrite("'/api/admin/card-identities?printing_id=1'"),
                         "'/api/pokemon/admin/card-identities?printing_id=1'")
        self.assertEqual(rewrite("'/api/prices/editions'"), "'/api/pokemon/prices/editions'")

    def test_everything_else_is_left_alone(self):
        for text in ("'/api/catalogue'", "'/api/want-listing'", "'/api/collection'", "'/api/collection/borrowed'",
                     "'/api/scanner/index'", "'/api/trades/list'", "'/api/admin/operations'", "'/api/holdings/1'",
                     "'/api/decks/1/cost'", "'/api/public/decks/x'", "'/api/prices/other'", "'/api/pokemon/catalog'",
                     "// GET /api/want-list is the route", "'/api/health'"):
            self.assertEqual(gen.pokemon_paths(text), text, text)

    def test_assemble_applies_it_to_the_whole_file_text(self):
        self.assertEqual(gen.assemble(["// head", "fetch('/api/catalog/sets')"], "\n"),
                         "// head\nfetch('/api/pokemon/catalog/sets')\n")

    def test_the_route_lists_are_the_gateways(self):
        server = (ROOT / 'auth/src/pokemonRoutes.ts').read_text()
        trees = re.search(r'export const POKEMON_TREES = \[(.*?)\];', server, re.S).group(1)
        exact = re.search(r'export const POKEMON_EXACT[^=]*= \{(.*?)\};', server, re.S).group(1)
        self.assertEqual(tuple(re.findall(r'"([^"]+)"', trees)), gen.POKEMON_TREES)
        self.assertEqual(tuple(re.findall(r'^\s*"([^"]+)":', exact, re.M)), gen.POKEMON_EXACT)

    def test_every_moved_route_is_an_api_route(self):
        import json
        routes = {path for _, path, _ in json.loads((ROOT / 'api/tests/api_contract/routes.json').read_text())}
        for route in gen.POKEMON_TREES:
            self.assertTrue(any(path == f'/api/{route}' or path.startswith(f'/api/{route}/') for path in routes), route)
        for route in gen.POKEMON_EXACT:
            self.assertIn(f'/api/{route}', routes)

    def test_a_template_substitution_ends_a_path_and_an_exact_route_takes_no_subpath(self):
        self.assertEqual(gen.pokemon_paths("`/api/want-list${query}`"), "`/api/pokemon/want-list${query}`")
        self.assertEqual(gen.pokemon_paths("`/api/prices/editions${query}`"), "`/api/pokemon/prices/editions${query}`")
        self.assertEqual(gen.pokemon_paths("'/api/prices/editions/1'"), "'/api/prices/editions/1'")
        self.assertEqual(gen.pokemon_paths("'/api/trades/value/accept'"), "'/api/trades/value/accept'")
        self.assertEqual(gen.pokemon_paths("'/api/admin/reprint-groups/decisions'"), "'/api/pokemon/admin/reprint-groups/decisions'")
        self.assertEqual(gen.pokemon_paths("'/api/admin/reprint-groups'"), "'/api/admin/reprint-groups'")

    def test_no_committed_client_calls_a_moved_route_by_its_old_path(self):
        pattern = re.compile(r"""['"`]/api/(?:%s)(?=[/?'"`$])""" % '|'.join(map(re.escape, gen.POKEMON_ROUTES)))
        for path in sorted((ROOT / 'web/src').glob('*generated.ts')):
            self.assertIsNone(pattern.search(path.read_text()), path.name)
        for name, expected in (('want_list', "'/api/pokemon/want-list'"), ('prices', "'/api/pokemon/prices/editions'"),
                               ('trades', "'/api/pokemon/trades/value'"),
                               ('collection_import', '`/api/pokemon/collection-imports?'),
                               ('catalog_browse', '`/api/pokemon/catalog/editions'),
                               ('reconciliation', "'/api/pokemon/holdings/reassign'"),
                               ('metadata', "'/api/pokemon/admin/reprint-groups/decisions'"),
                               ('want_list_cost', "'/api/pokemon/want-list/cost'")):
            self.assertIn(expected, generated(name), name)
        self.assertIn("'/api/pokemon/admin/catalog-runs'", (ROOT / 'web/src/generated.ts').read_text())

    def test_unmoved_routes_keep_their_paths(self):
        self.assertIn("'/api/trades/list'", generated('trades'))
        self.assertIn("'/api/trade-wants'", generated('trades'))
        self.assertIn("'/api/locations'", (ROOT / 'web/src/generated.ts').read_text())
        self.assertNotIn('/api/pokemon', generated('scanner'))
        self.assertNotIn('/api/pokemon', generated('decks'))

    def test_the_emitters_still_assert_the_upstream_path_in_the_contract(self):
        source = (SCRIPTS / 'generate_catalog_browse_client.py').read_text()
        self.assertIn('assert "/api/catalog/editions" in openapi["paths"]', source)
        self.assertNotIn('/api/pokemon', source)


class WriteOrCheck(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.module = types.SimpleNamespace(TARGET='out_generated.ts', render=lambda openapi: openapi['text'],
                                            __file__='/x/generate_out_client.py')
        patcher = mock.patch.object(gen, 'ROOT', Path(self.directory.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_write_then_check(self):
        self.assertIsNone(gen.write_or_check(self.module, {'text': 'one\n'}, check=False))
        self.assertEqual((Path(self.directory.name) / 'out_generated.ts').read_text(), 'one\n')
        self.assertIsNone(gen.write_or_check(self.module, {'text': 'one\n'}, check=True))

    def test_an_emitter_can_supply_its_own_contract(self):
        self.module.load_openapi = lambda: {'text': 'own\n'}
        self.assertIsNone(gen.write_or_check(self.module, {'text': 'shared\n'}, check=False))
        self.assertEqual((Path(self.directory.name) / 'out_generated.ts').read_text(), 'own\n')

    def test_check_names_a_stale_file_and_the_script_that_fixes_it(self):
        self.assertIn('out_generated.ts is stale', gen.write_or_check(self.module, {'text': 'one\n'}, check=True))
        gen.write_or_check(self.module, {'text': 'one\n'}, check=False)
        problem = gen.write_or_check(self.module, {'text': 'two\n'}, check=True)
        self.assertIn('generate_out_client.py', problem)
        self.assertEqual((Path(self.directory.name) / 'out_generated.ts').read_text(), 'one\n')


if __name__ == '__main__':
    unittest.main()
