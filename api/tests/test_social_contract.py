"""No ``/api/social`` response can carry a Location or a Deck (social network #250, ADR 0014, spec "Friend-facing reads:
one choke point").

Friends see only what a collector could lend now, never where it is. ``friend_copies`` answers no Location or Deck, and
this test is the guard behind it against future edits: it walks the generated OpenAPI schema of every response of every
``/api/social`` route, through every ``$ref``, array, union and map, and fails on any field named for a Location or a
Deck. A name is split into words (snake_case and camelCase); a word from ``FORBIDDEN`` fails it.

A ``$ref`` is followed only after its component's own name passes the same words, so a ``source`` field that points at
a ``DeckSummary {id, name}`` fails. Any word containing ``deck`` or ``location`` fails too (``decklist``). An object
schema that is free-form (``additionalProperties: true``, or no ``properties`` at all) could carry anything, so it fails
unless ``OPAQUE`` names it.

``ALLOWED`` holds the one exception, ``in_deck``: a count of copies a Deck holds for its own line ("1 in a Deck"),
never which Deck. It must stay a string count. Anything else that needs one of these words in its name is a change to
the privacy rule and needs the owner's say, not an entry here.
"""
import ast
import re
from pathlib import Path

from app.main import app

APP = Path(__file__).resolve().parents[1] / 'app'
SOCIAL = APP / 'social'
# The one place that may ask which Friends a collector has (ADR 0014: "only code"); everything else goes through them.
FRIENDS_OF_READERS = {'social/friends.py', 'social/friend_copies.py', 'social/friend_reads.py'}
# Reads of inventory tables, schema-qualified, quoted, ONLY or comma-joined too. Matched against the string constants of
# a module (and the pieces of its f-strings), never its docstrings.
INVENTORY_TABLE = re.compile(
    r'(?:\bFROM|\bJOIN|,)\s+(?:ONLY\s+)?(?:"?\w+"?\s*\.\s*)?"?(?:holding|deck_list_line|deck_list|location|borrowed_holding)"?\b',
    re.IGNORECASE)
# The collector's own Locations, and the rule friend_copies' statement calls: matched against the whole source text.
HIDDEN_CALL = re.compile(r'\bhidden_location(?:s|_ids)\s*\(')
# In the social area only friend_copies (the choke point) and hidden_locations (the rule it calls) may read inventory.
READERS = {'social/friend_copies.py', 'social/hidden_locations.py'}
# What each social module may import from inside the app, as (module as written, relative to this package, name). A new
# import of the Want List, copy allocation, the Location readers, hidden_locations or friend_copies.READ fails here
# until someone justifies it by adding it.
ALLOWED_IMPORTS = {
    'social/__init__.py': set(),
    'social/counts.py': set(),
    'social/hidden_locations.py': set(),
    'social/name_rules.py': set(),
    'social/owners.py': set(),
    'social/friend_copies.py': {('.', 'counts'), ('..', 'copy_allocation')},
    'social/friend_reads.py': {
        ('.', 'name_rules'), ('..', 'set_codes'), ('..main', 'connect'), ('..main', 'verified_user'),
        # Only the error helper of the Location readers; the Want List's capture and card order drive the wanted cards.
        ('..location_tree', 'error'), ('..want_list', 'capture_want_list'), ('..want_list', 'number_order'),
        ('.friend_copies', 'friend_copies')},
    'social/friends.py': {
        ('.', 'name_rules'), ('..main', 'connect'), ('..main', 'verified_user'), ('..publications', 'TOKEN'),
        ('..location_tree', 'error'), ('..location_tree', 'replay'), ('.owners', 'ensure_owner'),
        ('.owners', 'lock_owners'), ('.profile', 'token_hash')},
    # The Loans both sides read and the steps that change no inventory (#252). Card facts are catalog facts; the owner
    # lock and the command plumbing are the Friend commands'. Steps that touch a collector's own inventory are in
    # app.loan_inventory, outside this area.
    'social/loans.py': {
        # The borrower's own count of written-off copies awaiting their keep-or-remove choice (#257): a count per Loan,
        # read for the reader's Loans as borrower only, never a Location; the read stays in app.borrowed_copies.
        ('..borrowed_copies', 'awaiting_choice'),
        ('..main', 'connect'), ('..main', 'verified_user'), ('..location_tree', 'error'), ('..location_tree', 'replay'),
        ('.friend_reads', 'card_facts'), ('.owners', 'ensure_owner'), ('.owners', 'lock_owners')},
    'social/profile.py': {
        ('.', 'name_rules'), ('..main', 'connect'), ('..main', 'verified_user'),
        ('..location_tree', 'error'), ('..location_tree', 'owner_and_rows'), ('..location_tree', 'replay'),
        ('..public_projection', 'ProjectionUnavailable'), ('..public_records', 'MAX_BATCH'),
        ('..public_records', 'invite_key'), ('..public_records', 'public_record_store'),
        ('..publications', 'PUBLIC_HEADERS'), ('..publications', 'TOKEN')},
}

FORBIDDEN = frozenset({'location', 'locations', 'deck', 'decks', 'leaf', 'leaves', 'unsorted',
                       'binder', 'shelf', 'storage'})
ALLOWED = {'in_deck': {'type': 'string'}}
# Free-form objects a social response may hold, as (component, field): Catalog's card descriptor, a document of card
# facts that names no Location or Deck.
# ``ValidationError.ctx`` is FastAPI's own 422 body (the error's context, as the framework builds it): no social code
# fills it with a Location or a Deck.
OPAQUE = {('FriendCard', 'descriptor'), ('FriendCopy', 'descriptor'), ('LoanCard', 'descriptor'),
          ('ValidationError', 'ctx')}


def words(name: str) -> set[str]:
    """The words of a field name: snake_case, kebab-case and camelCase, lower-cased."""
    spaced = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', name)
    return {word.lower() for word in re.split(r'[^A-Za-z0-9]+', spaced) if word}


def name_refused(name: str) -> bool:
    """Whether a field or component name is named for a Location or a Deck: a forbidden word, or any word that
    contains ``deck`` or ``location`` (``decklist``)."""
    found = words(name)
    return bool(found & FORBIDDEN) or any('deck' in word or 'location' in word for word in found)


def is_opaque(schema: dict) -> bool:
    """An object schema that says nothing of what it holds."""
    return schema.get('additionalProperties') is True or not schema.get('properties')


def nodes(schema, components, path='', seen=None, owner='', via=''):
    """Every (kind, path, name, schema, owner) the schema can hold, at any depth. ``field``: a property. ``ref``: a
    component reached by ``$ref`` (named ``name``). ``object``: an object schema, ``name`` the field it is the value of,
    ``owner`` the component it is in."""
    seen = set() if seen is None else seen
    if not isinstance(schema, dict):
        return
    if '$ref' in schema:
        name = schema['$ref'].split('/')[-1]
        yield 'ref', path, name, schema, owner
        if name not in seen:
            yield from nodes(components[name], components, f'{path}<{name}>', seen | {name}, name, via)
        return
    if schema.get('type') == 'object' or 'properties' in schema or schema.get('additionalProperties') is not None:
        yield 'object', path, via, schema, owner
    for field, value in (schema.get('properties') or {}).items():
        yield 'field', path, field, value, owner
        yield from nodes(value, components, f'{path}.{field}', seen, owner, field)
    for key in ('items', 'additionalProperties', 'not'):
        if isinstance(schema.get(key), dict):
            yield from nodes(schema[key], components, f'{path}[{key}]', seen, owner, via)
    for key in ('anyOf', 'oneOf', 'allOf', 'prefixItems'):
        for part in schema.get(key) or []:
            yield from nodes(part, components, path, seen, owner, via)


def fields(schema, components):
    """(path, field name, field schema) for every field the schema can hold, at any depth."""
    for kind, path, name, value, _ in nodes(schema, components):
        if kind == 'field':
            yield path, name, value


def refused(schema, components) -> list[str]:
    found = []
    for kind, path, name, value, owner in nodes(schema, components):
        if kind == 'ref':
            if name_refused(name):
                found.append(f'{path}<{name}> (component name)')
        elif kind == 'object':
            if is_opaque(value) and (owner, name) not in OPAQUE:
                found.append(f'{path} (free-form object)')
        elif name in ALLOWED:
            if {key: value.get(key) for key in ALLOWED[name]} != ALLOWED[name]:
                found.append(f'{path}.{name} must stay a string count')
        elif name_refused(name):
            found.append(f'{path}.{name}')
    return found


def inventory_reads(source: str) -> bool:
    """Whether a module's source reads an inventory table or calls the hidden-Locations rule: a table after FROM, JOIN or
    a comma in any string constant (docstrings left out) or f-string piece, or a ``hidden_locations(`` call anywhere."""
    if HIDDEN_CALL.search(source):
        return True
    tree = ast.parse(source)
    docstrings = {id(node.body[0].value) for node in ast.walk(tree)
                  if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
                  and node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant)}
    return any(isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings
               and INVENTORY_TABLE.search(node.value) for node in ast.walk(tree))


def app_imports(source: str) -> set[tuple[str, str]]:
    """(module, name) of every import that reaches inside the app, relative to ``app.social`` as a relative import
    writes it: ``..want_list`` for ``app.want_list`` however it is spelled, a plain ``import app.x`` with name ``*``."""
    def relative(module: str) -> str | None:
        if module == 'app.social' or module.startswith('app.social.'):
            return module.removeprefix('app.social') or '.'
        if module == 'app' or module.startswith('app.'):
            return '..' + module.removeprefix('app').lstrip('.')
        return None

    found = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom):
            module = '.' * node.level + (node.module or '') if node.level else relative(node.module or '')
            found |= {(module, alias.name) for alias in node.names} if module else set()
        elif isinstance(node, ast.Import):
            found |= {(relative(alias.name), '*') for alias in node.names if relative(alias.name)}
    return found


def social_responses():
    """(route, status, schema) for every response of every /api/social route."""
    spec = app.openapi()
    for route, methods in spec['paths'].items():
        if not route.startswith('/api/social'):
            continue
        for method, operation in methods.items():
            for status, response in operation.get('responses', {}).items():
                for media in (response.get('content') or {}).values():
                    yield f'{method.upper()} {route}', status, media.get('schema') or {}


def test_no_social_response_has_a_location_or_deck_field():
    components = app.openapi()['components']['schemas']
    found = {f'{route} {status}: {field}' for route, status, schema in social_responses()
             for field in refused(schema, components)}
    assert found == set()


def test_every_social_route_answers_success_with_a_schema_the_walk_reads():
    components = app.openapi()['components']['schemas']
    routes = {}
    for route, status, schema in social_responses():
        if status.startswith('2'):
            routes[route] = list(fields(schema, components))
    # A route without a response model would have an empty schema and pass the walk without being read.
    assert routes and all(routes.values()), [route for route, found in routes.items() if not found]
    # The Friend reads are among them.
    assert 'GET /api/social/collections/{handle}' in routes
    for route in ('GET /api/social/collections/{handle}', 'GET /api/social/want-list-matches',
                  'GET /api/social/card-matches'):
        assert any(field == 'in_deck' for _, field, _ in routes[route]), route


def test_the_walk_finds_a_location_or_deck_field_at_any_depth():
    components = {
        'Inner': {'properties': {'spare': {'type': 'string'}, 'deckName': {'type': 'string'}}},
        'Loop': {'properties': {'next': {'$ref': '#/components/schemas/Loop'},
                                'items': {'type': 'array', 'items': {'$ref': '#/components/schemas/Inner'}}}},
    }
    schema = {'properties': {
        'cards': {'type': 'array', 'items': {'anyOf': [{'type': 'null'}, {'properties': {'deck_id': {'type': 'string'}}}]}},
        'where': {'type': 'object', 'additionalProperties': {'properties': {'location_name': {'type': 'string'}}}},
        'loop': {'$ref': '#/components/schemas/Loop'},
        'in_deck': {'type': 'integer'},
        'spare': {'type': 'string'},
        'loc': {'type': 'array'},
    }}
    assert sorted(refused(schema, components)) == sorted([
        '.cards[items].deck_id', '.where[additionalProperties].location_name', '.where (free-form object)',
        '.loop<Loop>.items[items]<Inner>.deckName', '.in_deck must stay a string count'])
    assert words('parentLocationId') == {'parent', 'location', 'id'} and words('in_deck') == {'in', 'deck'}


def test_the_walk_refuses_the_names_and_shapes_that_slip_past_a_plain_field_check():
    components = {
        'DeckSummary': {'properties': {'id': {'type': 'string'}, 'name': {'type': 'string'}}},
        'Plain': {'properties': {'id': {'type': 'string'}}},
        'Card': {'properties': {'descriptor': {'anyOf': [{'type': 'object', 'additionalProperties': True},
                                                         {'type': 'null'}]}}},
    }

    def refusals(**properties):
        return refused({'properties': properties}, components)

    # A clean field name that points at a component named for a Deck.
    assert refusals(source={'$ref': '#/components/schemas/DeckSummary'}) == ['.source<DeckSummary> (component name)']
    assert refusals(source={'$ref': '#/components/schemas/Plain'}) == []
    # A word that only contains deck or location, and the other places a collector keeps cards.
    for name in ('decklist', 'binder_name', 'shelf', 'storage', 'locationId', 'deck_list'):
        assert refusals(**{name: {'type': 'string'}}) == [f'.{name}'], name
    assert refusals(in_deck={'type': 'string'}) == [] and refusals(spare={'type': 'string'}) == []
    # An object that says nothing of what it holds: a map without properties, or additionalProperties: true.
    assert refusals(where={'type': 'object', 'additionalProperties': {'type': 'string'}}) == ['.where (free-form object)']
    assert refusals(extra={'type': 'object', 'additionalProperties': True}) == ['.extra (free-form object)']
    assert refusals(extra={'type': 'object'}) == ['.extra (free-form object)']
    assert refusals(extra={'type': 'object', 'properties': {'a': {'type': 'string'}}, 'additionalProperties': True}) \
        == ['.extra (free-form object)']
    assert refusals(extra={'type': 'object', 'properties': {'a': {'type': 'string'}}}) == []
    # Only the named catalog fields may be free-form, nullable or not.
    assert refused({'properties': {'card': {'$ref': '#/components/schemas/Card'}}}, components) \
        == ['.card<Card>.descriptor (free-form object)']
    components['FriendCard'] = components.pop('Card')
    assert refused({'properties': {'card': {'$ref': '#/components/schemas/FriendCard'}}}, components) == []


def test_the_inventory_guard_catches_every_way_to_read_an_inventory_table():
    def caught(sql: str) -> bool:
        return inventory_reads(f'READ = {sql!r}\n')

    for sql in ('SELECT 1 FROM holding h', 'SELECT 1 FROM public.holding h', 'SELECT 1 FROM "holding"',
                'SELECT 1 FROM "public"."holding"', 'SELECT 1 FROM friend f, holding h', 'SELECT 1 FROM ONLY holding',
                'SELECT 1 FROM friend f JOIN deck_list_line l ON true', 'select 1 from Location', 'FROM borrowed_holding'):
        assert caught(sql), sql
    assert inventory_reads("sql = f'SELECT 1 FROM friend f JOIN {schema}.x x ON true JOIN public.location l ON true'")
    assert inventory_reads("sql = f'SELECT 1 FROM friend f, {extra} JOIN holding h ON true'")
    assert inventory_reads("sql = 'SELECT 1 ' 'FROM holding'")
    assert inventory_reads('rows = hidden_locations(conn, owners)') and inventory_reads('ids = hidden_location_ids(x)')
    # Not a read: other tables and columns, the Friends rule, and prose in a docstring.
    for sql in ('SELECT location_id FROM friends_of(ARRAY[%s]::text[]) f', 'SELECT 1 FROM collector_profile p',
                'SELECT holding_id, deck_list_id FROM friendship', 'UPDATE x SET location = 1'):
        assert not caught(sql), sql
    assert not inventory_reads('"""Reads from holding, location and deck_list."""\ndef f():\n    """FROM holding"""\n')


def test_the_import_guard_reads_every_way_to_import_inside_the_app():
    assert app_imports('from ..want_list import capture_want_list\nfrom . import counts\nfrom .x import y\nimport json') \
        == {('..want_list', 'capture_want_list'), ('.', 'counts'), ('.x', 'y')}
    assert app_imports('from app.want_list import capture_want_list\nimport app.location_tree as lt\n'
                       'from app.social.friend_copies import READ\nfrom app import copy_allocation\n'
                       'def f():\n    from ..hidden_locations import x') \
        == {('..want_list', 'capture_want_list'), ('..location_tree', '*'), ('.friend_copies', 'READ'),
            ('..', 'copy_allocation'), ('..hidden_locations', 'x')}


def sources() -> dict[str, str]:
    return {str(path.relative_to(APP)): path.read_text(encoding='utf-8') for path in SOCIAL.rglob('*.py')}


def test_only_the_choke_point_reads_inventory_tables_in_the_social_area():
    found = {path for path, source in sources().items() if inventory_reads(source)}
    assert found == READERS


def test_social_modules_import_only_what_they_are_allowed_to():
    found = {path: app_imports(source) for path, source in sources().items()}
    assert set(found) == set(ALLOWED_IMPORTS), 'a new social module needs an entry in ALLOWED_IMPORTS'
    assert {path: imports - ALLOWED_IMPORTS[path] for path, imports in found.items()} \
        == {path: set() for path in found}


def test_only_the_friend_code_asks_which_friends_a_collector_has():
    found = {str(path.relative_to(APP)) for path in APP.rglob('*.py')
             if re.search(r'\bfriends_of\b', path.read_text(encoding='utf-8'))}
    assert found == FRIENDS_OF_READERS


def test_the_choke_points_statement_never_reads_borrowed_holdings():
    from app.social import friend_copies
    assert 'borrowed_holding' not in friend_copies.READ
