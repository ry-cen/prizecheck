import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('check_python_boundaries', ROOT / 'scripts/check_python_boundaries.py')
boundaries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundaries)
REAL = boundaries.load_rules()

CLEAN_PRICE_SOURCE = (
    'import httpx\nimport json\nORIGIN = "https://api.tcgdex.net"\n'
    'def fetch(card, may_retry):\n'
    '    client = httpx.Client(follow_redirects=False, trust_env=False, timeout=1)\n'
    '    return json.loads(client.get(ORIGIN).text, parse_float=str)\n')
ALLOWED = {'app.social': set(), 'app.social.a': {('app.social', 'b'), ('app.util', 'helper')}, 'app.social.b': set()}


def rules(**data):
    """A rules object holding only the configured rules, with the real patterns and social packages."""
    return types.SimpleNamespace(RULES=data, SOCIAL_PACKAGES=['app.social'], INVENTORY_TABLE=REAL.INVENTORY_TABLE,
                                 HIDDEN_CALL=REAL.HIDDEN_CALL, SEVERAL_OWNERS_TABLE=REAL.SEVERAL_OWNERS_TABLE,
                                 SEVERAL_OWNERS_FILTER=REAL.SEVERAL_OWNERS_FILTER)


def run(rule, files, **data):
    """The failures of one rule on a fixture checkout from {repository path: source}."""
    with tempfile.TemporaryDirectory() as directory:
        for relative, source in {'api/app/__init__.py': '', **files}.items():
            if source is None:
                continue
            path = Path(directory) / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(source)
        return boundaries.run_rule(boundaries.Tree(directory), rule, rules(**{rule: data}))[1]


def social(extra=None):
    """A clean social area: a package, a (reading) choke point and a quiet module."""
    return {'api/app/social/__init__.py': '', 'api/app/social/a.py': 'from . import b\nfrom ..util import helper',
            'api/app/social/b.py': '', 'api/app/util.py': 'def helper(): pass', **(extra or {})}


class ImportersTest(unittest.TestCase):
    DATA = {'imported': 'app.set_codes', 'importers': {'app.display', 'app.social.reads'}}
    CLEAN = {'api/app/set_codes.py': '', 'api/app/display.py': 'from . import set_codes', 'api/app/social/__init__.py': '',
             'api/app/social/reads.py': 'from .. import set_codes', 'api/app/other.py': 'from . import display'}

    def test_clean_tree_passes_and_the_recursive_scan_sees_a_nested_importer(self):
        self.assertEqual(run('set-codes-importers', self.CLEAN, **self.DATA), [])

    def test_an_extra_import_in_an_export_module_fails(self):
        files = {**self.CLEAN, 'api/app/export.py': 'from . import set_codes'}
        self.assertEqual(run('set-codes-importers', files, **self.DATA),
                         ['set-codes-importers: unexpected app.export'])

    def test_every_spelling_and_a_function_level_import_counts(self):
        for source in ('from app import set_codes', 'import app.set_codes', 'from .set_codes import CODES',
                       'def f():\n    from . import set_codes'):
            files = {**self.CLEAN, 'api/app/export.py': source}
            self.assertEqual(run('set-codes-importers', files, **self.DATA),
                             ['set-codes-importers: unexpected app.export'], source)

    def test_an_import_of_a_submodule_counts_once_the_target_is_a_package(self):
        files = {**self.CLEAN, 'api/app/set_codes.py': None, 'api/app/set_codes/__init__.py': 'from . import table',
                 'api/app/set_codes/table.py': '', 'api/app/export.py': 'from .set_codes import table'}
        self.assertEqual(run('set-codes-importers', files, **self.DATA), ['set-codes-importers: unexpected app.export'])

    def test_a_missing_importer_fails_because_the_list_is_exact(self):
        files = {**self.CLEAN, 'api/app/display.py': ''}
        self.assertEqual(run('set-codes-importers', files, **self.DATA), ['set-codes-importers: missing app.display'])

    def test_import_aliases_importers_is_the_same_exact_scan(self):
        data = {'imported': 'app.import_aliases', 'importers': {'app.deck_import'}}
        files = {'api/app/import_aliases.py': '', 'api/app/deck_import.py': 'from . import import_aliases'}
        self.assertEqual(run('import-aliases-importers', files, **data), [])
        files['api/app/games/__init__.py'] = ''
        files['api/app/games/x.py'] = 'from .. import import_aliases'
        self.assertEqual(run('import-aliases-importers', files, **data), ['import-aliases-importers: unexpected app.games.x'])


class FormatRulesTest(unittest.TestCase):
    DATA = {'module': 'app.format_evaluator', 'file': 'format_rules/imported_sets.txt'}

    def test_the_file_beside_the_module_passes(self):
        files = {'api/app/format_evaluator.py': '', 'api/app/format_rules/imported_sets.txt': ''}
        self.assertEqual(run('format-rules-beside-evaluator', files, **self.DATA), [])

    def test_a_package_evaluator_holds_the_file_in_its_own_directory(self):
        files = {'api/app/format_evaluator/__init__.py': '', 'api/app/format_evaluator/format_rules/imported_sets.txt': ''}
        self.assertEqual(run('format-rules-beside-evaluator', files, **self.DATA), [])

    def test_the_file_left_behind_after_the_module_moves_fails(self):
        files = {'api/app/core/__init__.py': '', 'api/app/core/format_evaluator.py': '',
                 'api/app/format_rules/imported_sets.txt': ''}
        data = {'module': 'app.core.format_evaluator', 'file': self.DATA['file']}
        self.assertEqual(run('format-rules-beside-evaluator', files, **data),
                         ['format-rules-beside-evaluator: format_rules/imported_sets.txt is not beside app.core.format_evaluator'])

    def test_a_missing_module_fails(self):
        self.assertEqual(run('format-rules-beside-evaluator', {}, **self.DATA),
                         ['format-rules-beside-evaluator: no module app.format_evaluator'])


class TsvReadersTest(unittest.TestCase):
    DATA = {'pattern': REAL.RULES['import-aliases-tsv-readers']['pattern'], 'readers': {'api/app/import_aliases.py'}}

    def test_one_reader_passes(self):
        self.assertEqual(run('import-aliases-tsv-readers',
                             {'api/app/import_aliases.py': 'PATH = "import_aliases.tsv"', 'scripts/x.py': 'import_aliases'},
                             **self.DATA), [])

    def test_a_script_or_a_nested_module_that_names_the_file_fails(self):
        base = {'api/app/import_aliases.py': "PATH = 'import_aliases.tsv'"}
        self.assertEqual(run('import-aliases-tsv-readers', {**base, 'scripts/x.py': 'open("import_aliases.tsv")'}, **self.DATA),
                         ['import-aliases-tsv-readers: unexpected scripts/x.py'])
        self.assertEqual(run('import-aliases-tsv-readers', {**base, 'api/app/core/y.py': 'F = "import_aliases.tsv"'}, **self.DATA),
                         ['import-aliases-tsv-readers: unexpected api/app/core/y.py'])

    def test_the_reader_moving_away_fails_until_its_entry_is_renamed(self):
        files = {'api/app/games/import_aliases.py': 'PATH = "import_aliases.tsv"'}
        self.assertEqual(run('import-aliases-tsv-readers', files, **self.DATA),
                         ['import-aliases-tsv-readers: unexpected api/app/games/import_aliases.py; '
                          'missing api/app/import_aliases.py'])


class PriceSourceTest(unittest.TestCase):
    DATA = REAL.RULES['price-source-client']

    def fails(self, source, *details):
        found = run('price-source-client', {'api/app/price_source.py': source}, **self.DATA)
        self.assertEqual(found, [f'price-source-client: {detail}' for detail in details])

    def test_the_clean_client_passes(self):
        self.fails(CLEAN_PRICE_SOURCE)

    def test_a_second_origin_fails(self):
        self.fails(CLEAN_PRICE_SOURCE + 'OTHER = "http://example.test"\n',
                   "origin literals are ['https://api.tcgdex.net', 'http://example.test'], not ['https://api.tcgdex.net']")

    def test_a_different_origin_fails(self):
        self.fails(CLEAN_PRICE_SOURCE.replace('api.tcgdex.net', 'api.example.test'),
                   "origin literals are ['https://api.example.test'], not ['https://api.tcgdex.net']")

    def test_a_second_client_or_none_fails(self):
        self.fails(CLEAN_PRICE_SOURCE + 'other = httpx.Client(follow_redirects=False, trust_env=False)\n',
                   '2 httpx.Client(...) calls, not exactly one')
        self.fails(CLEAN_PRICE_SOURCE.replace('httpx.Client(', 'make('), '0 httpx.Client(...) calls, not exactly one')

    def test_unsafe_client_settings_fail(self):
        self.fails(CLEAN_PRICE_SOURCE.replace('follow_redirects=False', 'follow_redirects=True'),
                   'httpx.Client keyword follow_redirects is True, not False')
        self.fails(CLEAN_PRICE_SOURCE.replace(' trust_env=False,', ''), 'httpx.Client keyword trust_env is None, not False')

    def test_json_loads_without_parse_float_or_no_json_loads_fails(self):
        self.fails(CLEAN_PRICE_SOURCE + 'x = json.loads("1")\n', 'json.loads on line 7 passes no parse_float')
        self.fails(CLEAN_PRICE_SOURCE.replace('json.loads(', 'str('), 'no json.loads call')

    def test_a_changed_fetch_signature_fails(self):
        self.fails(CLEAN_PRICE_SOURCE.replace('(card, may_retry)', '(card, may_retry, extra=None)'),
                   "fetch takes ['card', 'may_retry', 'extra'], not ['card', 'may_retry']")
        self.fails(CLEAN_PRICE_SOURCE.replace('def fetch', 'def get'), "fetch takes None, not ['card', 'may_retry']")

    def test_a_missing_module_fails(self):
        self.assertEqual(run('price-source-client', {}, **self.DATA), ['price-source-client: no module app.price_source'])


class HostTest(unittest.TestCase):
    DATA = {'host': 'tcgcsv.com', 'allowed': {'app.price_import'}}

    def test_the_price_import_alone_passes_and_so_does_an_empty_tree(self):
        self.assertEqual(run('tcgcsv-host', {'api/app/price_import.py': 'U = "https://TCGCSV.com/x"'}, **self.DATA), [])
        self.assertEqual(run('tcgcsv-host', {'api/app/price_import.py': ''}, **self.DATA), [])

    def test_another_module_naming_the_host_fails_in_any_case(self):
        self.assertEqual(run('tcgcsv-host', {'api/app/other.py': '# see TcgCsv.com'}, **self.DATA),
                         ['tcgcsv-host: unexpected app.other'])

    def test_a_nested_module_fails_where_the_old_top_level_glob_would_miss_it(self):
        files = {'api/app/games/__init__.py': '', 'api/app/games/pokemon/__init__.py': '',
                 'api/app/games/pokemon/x.py': 'URL = "https://tcgcsv.com/tcgplayer"'}
        self.assertEqual(run('tcgcsv-host', files, **self.DATA), ['tcgcsv-host: unexpected app.games.pokemon.x'])


class SocialInventoryTest(unittest.TestCase):
    DATA = {'readers': {'app.social.a'}}

    def files(self, a='SQL = "SELECT 1 FROM holding h"', extra=None):
        return social({'api/app/social/a.py': a, **(extra or {})})

    def test_the_choke_point_alone_passes(self):
        self.assertEqual(run('social-inventory-readers', self.files(), **self.DATA), [])

    def test_another_social_module_reading_inventory_fails(self):
        files = self.files(extra={'api/app/social/b.py': 'SQL = "SELECT 1 FROM friend f JOIN deck_list_line l ON true"'})
        self.assertEqual(run('social-inventory-readers', files, **self.DATA), ['social-inventory-readers: unexpected app.social.b'])

    def test_a_call_of_a_hidden_rule_in_prose_counts(self):
        files = self.files(extra={'api/app/social/b.py': '# hidden_locations(conn)'})
        self.assertEqual(run('social-inventory-readers', files, **self.DATA), ['social-inventory-readers: unexpected app.social.b'])

    def test_a_docstring_is_not_a_read(self):
        files = self.files(extra={'api/app/social/b.py': '"""FROM holding"""'})
        self.assertEqual(run('social-inventory-readers', files, **self.DATA), [])

    def test_the_exact_list_fails_when_the_reader_stops_reading(self):
        self.assertEqual(run('social-inventory-readers', self.files(a=''), **self.DATA),
                         ['social-inventory-readers: missing app.social.a'])

    def test_a_module_outside_the_social_area_may_read(self):
        files = self.files(extra={'api/app/holdings.py': 'SQL = "SELECT 1 FROM holding"'})
        self.assertEqual(run('social-inventory-readers', files, **self.DATA), [])


class SocialImportsTest(unittest.TestCase):
    def test_a_clean_area_passes(self):
        self.assertEqual(run('social-allowed-imports', social(), allowed=ALLOWED), [])

    def test_a_new_import_fails_in_every_spelling(self):
        for source, found in (('from ..want_list import capture', 'app.want_list capture'),
                              ('from app.want_list import capture', 'app.want_list capture'),
                              ('import app.want_list', 'app.want_list *'),
                              ('import app.want_list as w', 'app.want_list *'),
                              ('from .. import want_list', 'app want_list'),
                              ('from . import c', 'app.social c'),
                              ('def f():\n    from .. import want_list', 'app want_list'),
                              ('import importlib\nimportlib.import_module("app.want_list")', 'app.want_list *')):
            files = social({'api/app/social/b.py': source})
            self.assertEqual(run('social-allowed-imports', files, allowed=ALLOWED),
                             [f'social-allowed-imports: app.social.b imports {found}, which its entry does not allow'], source)

    def test_an_import_of_another_name_from_an_allowed_module_fails(self):
        files = social({'api/app/social/a.py': 'from . import b, c\nfrom ..util import helper'})
        self.assertEqual(run('social-allowed-imports', files, allowed=ALLOWED),
                         ['social-allowed-imports: app.social.a imports app.social c, which its entry does not allow'])

    def test_outside_imports_are_ignored(self):
        files = social({'api/app/social/b.py': 'import json\nfrom pathlib import Path\nimport fastapi.routing'})
        self.assertEqual(run('social-allowed-imports', files, allowed=ALLOWED), [])

    def test_a_social_module_without_an_entry_fails(self):
        files = social({'api/app/social/new.py': ''})
        self.assertEqual(run('social-allowed-imports', files, allowed=ALLOWED),
                         ['social-allowed-imports: the social area and the map differ: unexpected app.social.new'])

    def test_an_entry_without_a_module_fails(self):
        files = social()
        del files['api/app/social/b.py']
        files['api/app/social/a.py'] = 'from ..util import helper'
        self.assertEqual(run('social-allowed-imports', files, allowed=ALLOWED),
                         ['social-allowed-imports: the social area and the map differ: missing app.social.b'])

    def test_a_nested_social_package_is_part_of_the_area(self):
        files = social({'api/app/social/deep/__init__.py': '', 'api/app/social/deep/c.py': ''})
        self.assertEqual(run('social-allowed-imports', files, allowed=ALLOWED),
                         ['social-allowed-imports: the social area and the map differ: '
                          'unexpected app.social.deep, app.social.deep.c'])


class FriendsOfTest(unittest.TestCase):
    DATA = {'pattern': REAL.RULES['friends-of-readers']['pattern'], 'readers': {'app.social.a'}}

    def test_the_named_reader_passes(self):
        self.assertEqual(run('friends-of-readers', social({'api/app/social/a.py': 'Q = "friends_of(x)"'}), **self.DATA), [])

    def test_any_other_module_naming_it_fails_even_outside_the_social_area(self):
        files = social({'api/app/social/a.py': 'friends_of', 'api/app/trade_list.py': 'SQL = "friends_of(%s)"'})
        self.assertEqual(run('friends-of-readers', files, **self.DATA), ['friends-of-readers: unexpected app.trade_list'])

    def test_a_longer_name_is_not_the_friends_rule(self):
        files = social({'api/app/social/a.py': 'friends_of', 'api/app/x.py': 'friends_of_friends = 1'})
        self.assertEqual(run('friends-of-readers', files, **self.DATA), [])


class SeveralOwnersTest(unittest.TestCase):
    DATA = {'readers': {'app.social.a'}}
    SQL = 'SQL = "SELECT 1 FROM holding h WHERE h.owner_id = ANY(%s)"'

    def test_the_choke_point_may_and_so_may_a_tree_without_one(self):
        self.assertEqual(run('several-owners-readers', social({'api/app/social/a.py': self.SQL}), **self.DATA), [])
        self.assertEqual(run('several-owners-readers', social(), **self.DATA), [])

    def test_another_module_reading_several_owners_fails(self):
        files = social({'api/app/holdings.py': self.SQL})
        self.assertEqual(run('several-owners-readers', files, **self.DATA), ['several-owners-readers: unexpected app.holdings'])

    def test_one_owner_and_a_docstring_do_not_count(self):
        files = social({'api/app/x.py': 'SQL = "SELECT 1 FROM holding h WHERE h.owner_id = %s"',
                        'api/app/y.py': 'def f():\n    """FROM holding WHERE owner_id = ANY(%s)"""\n    return 1\n'})
        self.assertEqual(run('several-owners-readers', files, **self.DATA), [])


class NoFriendIdsTest(unittest.TestCase):
    DATA = {'module': 'app.trade_inventory', 'name': 'friend_ids'}

    def test_other_imports_pass(self):
        files = {'api/app/trade_inventory.py': 'from .social.friends import other\nfrom .social import friend_ids_x'}
        self.assertEqual(run('trade-steps-no-friend-ids', files, **self.DATA), [])

    def test_importing_the_friends_set_fails_however_it_is_spelled(self):
        for source in ('from .social.friends import friend_ids', 'from app.social.friends import friend_ids as f',
                       'def f():\n    from .social.friends import friend_ids'):
            self.assertEqual(run('trade-steps-no-friend-ids', {'api/app/trade_inventory.py': source}, **self.DATA),
                             ['trade-steps-no-friend-ids: app.trade_inventory imports the name friend_ids: '
                              'app.social.friends friend_ids'], source)

    def test_a_missing_module_fails(self):
        self.assertEqual(run('trade-steps-no-friend-ids', {}, **self.DATA),
                         ['trade-steps-no-friend-ids: no module app.trade_inventory'])


class SocialAreaCompleteTest(unittest.TestCase):
    DATA = {'directory': 'social'}

    def test_the_listed_package_passes(self):
        self.assertEqual(run('social-area-complete', social(), **self.DATA), [])

    def test_a_new_social_folder_fails(self):
        files = social({'api/app/core/social/x.py': ''})
        self.assertEqual(run('social-area-complete', files, **self.DATA),
                         ['social-area-complete: package app.core.social is not in SOCIAL_PACKAGES'])

    def test_a_folder_of_another_name_or_without_python_files_passes(self):
        files = social({'api/app/core/socials/x.py': '', 'api/app/core/social/notes.txt': ''})
        self.assertEqual(run('social-area-complete', files, **self.DATA), [])


class GuardHelpersTest(unittest.TestCase):
    """The inputs of api/tests/test_social_contract.py's guard self-tests, run against the checker's copies."""

    def test_the_inventory_guard_catches_every_way_to_read_an_inventory_table(self):
        def caught(sql):
            return boundaries.inventory_reads(f'READ = {sql!r}\n', REAL)

        for sql in ('SELECT 1 FROM holding h', 'SELECT 1 FROM public.holding h', 'SELECT 1 FROM "holding"',
                    'SELECT 1 FROM "public"."holding"', 'SELECT 1 FROM friend f, holding h', 'SELECT 1 FROM ONLY holding',
                    'SELECT 1 FROM friend f JOIN deck_list_line l ON true', 'select 1 from Location', 'FROM borrowed_holding',
                    'SELECT quantity FROM trade_want w', 'SELECT 1 FROM friend f JOIN trade_accept a ON true'):
            self.assertTrue(caught(sql), sql)
        reads = lambda source: boundaries.inventory_reads(source, REAL)
        self.assertTrue(reads("sql = f'SELECT 1 FROM friend f JOIN {schema}.x x ON true JOIN public.location l ON true'"))
        self.assertTrue(reads("sql = f'SELECT 1 FROM friend f, {extra} JOIN holding h ON true'"))
        self.assertTrue(reads("sql = 'SELECT 1 ' 'FROM holding'"))
        self.assertTrue(reads('rows = hidden_locations(conn, owners)') and reads('ids = hidden_location_ids(x)'))
        self.assertTrue(reads("SQL = 'SELECT 1 FROM for_trade_locations(ARRAY[%s]::text[]) f'\n"))
        self.assertTrue(reads('"""Calls trade_listable (owners)."""\n') and reads('# for_trade_locations(x)\n'))
        for sql in ('SELECT location_id FROM friends_of(ARRAY[%s]::text[]) f', 'SELECT 1 FROM collector_profile p',
                    'SELECT holding_id, deck_list_id FROM friendship', 'UPDATE x SET location = 1'):
            self.assertFalse(caught(sql), sql)
        self.assertFalse(reads('"""Reads from holding, location and deck_list."""\ndef f():\n    """FROM holding"""\n'))

    def test_the_import_guard_reads_every_way_to_import_inside_the_app(self):
        def found(source):
            return boundaries.app_imports('app.social.mod', source, False, 'app')

        self.assertEqual(found('from ..want_list import capture_want_list\nfrom . import counts\nfrom .x import y\nimport json'),
                         {('app.want_list', 'capture_want_list'), ('app.social', 'counts'), ('app.social.x', 'y')})
        self.assertEqual(found('from app.want_list import capture_want_list\nimport app.location_tree as lt\n'
                               'from app.social.friend_copies import READ\nfrom app import copy_allocation\n'
                               'def f():\n    from ..hidden_locations import x'),
                         {('app.want_list', 'capture_want_list'), ('app.location_tree', '*'),
                          ('app.social.friend_copies', 'READ'), ('app', 'copy_allocation'), ('app.hidden_locations', 'x')})

    def test_a_package_init_resolves_relative_imports_from_its_own_directory(self):
        self.assertEqual(boundaries.app_imports('app.social', 'from . import a\nfrom .. import b', True, 'app'),
                         {('app.social', 'a'), ('app', 'b')})

    def test_the_several_owners_guard_catches_a_filter_on_a_list_of_owners(self):
        def reads(source):
            return boundaries.several_owners_reads(source, REAL)

        for sql in ('SELECT 1 FROM holding h WHERE h.owner_id = ANY(%s)',
                    'SELECT 1 FROM public.location l WHERE owner_id=any (%s)',
                    'SELECT 1 FROM friend f JOIN deck_list_line l ON true WHERE l.owner_id = ANY(%s::text[])',
                    'SELECT 1 FROM borrowed_holding b WHERE b.borrower_id = ANY(%s)'):
            self.assertTrue(reads(f'SQL = {sql!r}\n'), sql)
        self.assertTrue(reads("sql = f'SELECT 1 FROM holding h WHERE h.owner_id = ANY({owners})'\n"))
        for sql in ('SELECT 1 FROM holding h WHERE h.owner_id = %s', 'SELECT 1 FROM holding h WHERE h.edition_id = ANY(%s)',
                    'SELECT 1 FROM reserved_copies(%s::text[], NULL) r WHERE r.owner_id = ANY(%s)'):
            self.assertFalse(reads(f'SQL = {sql!r}\n'), sql)
        self.assertFalse(reads('def f():\n    """FROM holding WHERE owner_id = ANY(%s)"""\n    return 1\n'))


class EngineTest(unittest.TestCase):
    def test_every_rule_in_the_checker_is_configured_in_the_data_and_the_reverse(self):
        self.assertEqual(set(REAL.RULES), set(boundaries.ARCHITECTURE_RULES))
        self.assertEqual(len(REAL.RULES), 12)

    def test_the_real_tree_passes_every_rule(self):
        self.assertEqual(boundaries.architecture(boundaries.ROOT, REAL)[1], [])

    def test_the_real_pins_hold_todays_values(self):
        pins = boundaries.architecture(boundaries.ROOT, REAL)[0]
        self.assertEqual(pins['set-codes-importers'], sorted(REAL.RULES['set-codes-importers']['importers']))
        self.assertEqual(pins['import-aliases-tsv-readers'], ['api/app/import_aliases.py'])
        self.assertEqual(pins['social-area-complete'], ['app.social'])

    def test_a_rule_in_the_data_without_an_engine_fails_and_so_does_an_unconfigured_engine_rule(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'api/app').mkdir(parents=True)
            failures = boundaries.architecture(directory, rules(invented={}))[1]
        self.assertIn('invented: no such rule in the checker', failures)
        self.assertIn('set-codes-importers: the rule is not configured in python_architecture_rules.py', failures)

    def test_a_module_file_beside_a_package_of_the_same_name_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / 'api/app'
            (app / 'x').mkdir(parents=True)
            for path in ('__init__.py', 'x.py', 'x/__init__.py'):
                (app / path).write_text('')
            failures = boundaries.architecture(directory, rules())[1]
        self.assertIn('modules: two files name module app.x', failures)

    def test_main_prints_a_failure_as_failed_rule_detail(self):
        original = boundaries.architecture
        boundaries.architecture = lambda root, rules: ({}, ['set-codes-importers: unexpected app.export'])
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = boundaries.main([])
        finally:
            boundaries.architecture = original
        self.assertEqual(code, 1)
        self.assertIn('FAILED: set-codes-importers: unexpected app.export', out.getvalue().splitlines())

    def test_show_pins_prints_each_rules_found_set(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = boundaries.main(['--show-pins'])
        self.assertEqual(code, 0)
        self.assertIn('set-codes-importers:', out.getvalue().splitlines())
        self.assertIn('  app.social.friend_reads', out.getvalue().splitlines())


if __name__ == '__main__':
    unittest.main()
