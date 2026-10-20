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
# a module (and the pieces of its f-strings), never its docstrings. A collector's own Trade Wants and Will accept choices
# (trading #268) count as inventory: in the social area only the choke point may read them.
INVENTORY_TABLE = re.compile(
    r'(?:\bFROM|\bJOIN|,)\s+(?:ONLY\s+)?(?:"?\w+"?\s*\.\s*)?"?'
    r'(?:holding|deck_list_line|deck_list|location|borrowed_holding|trade_want|trade_accept)"?\b',
    re.IGNORECASE)
# The rules over a collector's own Locations that the choke point's statements call: hidden Locations (migration 101),
# For trade Locations (140) and the listable rule (142, trading #269). Matched against the whole source text, docstrings
# and comments too, so a social module's prose must never write one of these names followed by an open parenthesis.
HIDDEN_CALL = re.compile(r'\b(?:hidden_location(?:s|_ids)|for_trade_locations|trade_listable)\s*\(')
# In the social area only friend_copies (the choke point) and hidden_locations (the rule it calls) may read inventory.
READERS = {'social/friend_copies.py', 'social/hidden_locations.py'}
# Calls of migration 142's placement rule and listable rule (trading #268, ADR 0015) and of migration 140's For trade
# rule, matched against string constants only (SQL text and f-string pieces, never docstrings), as inventory_reads
# matches: no error message or other string may write a call form. Only these modules may call them: counts for one
# owner, and the choke point for Friends, for the placement rule; the Trade List and the choke point for the listable
# rule (trading #269); the Trade List alone for the For trade rule. The choke point calls the placement rule for its
# Friend wants read (trading #276).
RESERVING_PICKS_CALL = re.compile(r'\breserving_picks\s*\(')
LISTABLE_CALL = re.compile(r'\btrade_listable\s*\(')
FOR_TRADE_CALL = re.compile(r'\bfor_trade_locations\s*\(')
RESERVING_PICKS_CALLERS = {'social/counts.py', 'social/friend_copies.py'}
LISTABLE_CALLERS = {'trade_list.py', 'social/friend_copies.py'}
FOR_TRADE_CALLERS = {'trade_list.py'}
# A read of several collectors' inventory in one statement (ADR 0015): a string constant that reads an inventory table
# and filters on a list of owners or borrowers. Only the choke point may write one. Owner and admin aggregate reads in
# another form are exempt by the ADR, and review catches the forms this misses (IN lists, joins, split constants).
SEVERAL_OWNERS_TABLE = re.compile(
    r'(?:\bFROM|\bJOIN|,)\s+(?:ONLY\s+)?(?:"?\w+"?\s*\.\s*)?"?(?:holding|deck_list_line|location|borrowed_holding)"?\b',
    re.IGNORECASE)
SEVERAL_OWNERS_FILTER = re.compile(r'\b(?:owner_id|borrower_id)\s*=\s*ANY\s*\(', re.IGNORECASE)
# What each social module may import from inside the app, as (module as written, relative to this package, name). A new
# import of the Want List, copy allocation, the Location readers, hidden_locations or friend_copies.READ fails here
# until someone justifies it by adding it.
ALLOWED_IMPORTS = {
    'social/__init__.py': set(),
    'social/counts.py': set(),
    'social/hidden_locations.py': set(),
    'social/name_rules.py': set(),
    'social/owners.py': set(),
    # The choke point counts each Friend's wants with the pure allocation over rows it reads itself (trading #276).
    'social/friend_copies.py': {('.', 'counts'), ('..', 'copy_allocation'), ('..copy_allocation', 'allocate_rows'),
                                ('..copy_allocation', 'AllocationRows')},
    'social/friend_reads.py': {
        ('.', 'name_rules'), ('..', 'set_codes'), ('..main', 'connect'), ('..main', 'verified_user'),
        # Only the error helper of the Location readers; the Want List's capture and card order drive the wanted cards.
        ('..location_tree', 'error'), ('..want_list', 'capture_want_list'), ('..want_list', 'number_order'),
        ('.friend_copies', 'friend_copies')},
    # A Friend's Trade List (trading #269): the Friend by Handle and the card facts as a Friend's Collection reads them,
    # and their listable copies from the choke point. Discovery and Ask to trade (trading #276): the viewer's own wants
    # (the Want List's capture, their Trade Wants and their Will accept choices) and Trade List from the inventory
    # modules, the Friends' copies and wants from the choke point, the catalog's Will accept expansion, and the one
    # definition of "are Friends", a set of account ids.
    'social/trade_matches.py': {
        ('.', 'name_rules'), ('..main', 'connect'), ('..main', 'verified_user'), ('..location_tree', 'error'),
        ('.friend_copies', 'friend_trade_copies'), ('.friend_reads', 'FRIEND_BY_HANDLE'),
        ('.friend_reads', 'PAGE_IDENTITIES'), ('.friend_reads', 'card_facts'), ('.friend_reads', 'search_key'),
        ('..trade_list', 'own_trade_copies'), ('..trade_wants', 'own_wants'), ('..trade_wants', 'own_rules'),
        ('..want_list', 'capture_want_list'), ('.friend_copies', 'friend_wants'), ('..card_accepts', 'accepts'),
        ('.friends', 'friend_ids')},
    'social/friends.py': {
        ('.', 'name_rules'), ('..main', 'connect'), ('..main', 'verified_user'), ('..publications', 'TOKEN'),
        ('..location_tree', 'error'), ('..location_tree', 'replay'), ('.owners', 'ensure_owner'),
        ('.owners', 'lock_owners'), ('.profile', 'token_hash'),
        # Ending a friendship cancels the pair's Loans nobody has confirmed a handover for (#260), then their Trades
        # nobody has confirmed the swap for (trading #274), inside the command that already locked both owners; the
        # Loan and Trade rows are written in app.social.loans and app.social.trades, never here.
        ('.loans', 'end_loans_between'), ('.trades', 'end_trades_between')},
    # The Loans both sides read and the steps that change no inventory (#252). Card facts are catalog facts; the owner
    # lock and the command plumbing are the Friend commands'. Steps that touch a collector's own inventory are in
    # app.loan_inventory, outside this area.
    'social/loans.py': {
        # The borrower's own count of written-off copies awaiting their keep-or-remove choice (#257): a count per Loan,
        # read for the reader's Loans as borrower only, never a Location; the read stays in app.borrowed_copies.
        ('..borrowed_copies', 'awaiting_choice'),
        # Which of the reader's Loans as lender have a reserved pick out of date, so Needs you and the inbox list them
        # (#259): a set of Loan ids from the lender's own Holdings, never a Location; the read stays in app.loan_picks.
        ('..loan_picks', 'stale_pick_loans'),
        ('..main', 'connect'), ('..main', 'verified_user'), ('..location_tree', 'error'), ('..location_tree', 'replay'),
        ('.friend_reads', 'card_facts'), ('.owners', 'ensure_owner'), ('.owners', 'lock_owners'),
        # Whether the lender is still the reader's Friend, so Edit and resend is offered only then (owner's decision,
        # 2026-10-16): the one definition of "are Friends", a set of account ids, never anything of their inventory.
        ('.friends', 'friend_ids')},
    # The inbox (#259): the reader's own Loans through the Loans' one definition of what waits on them, and the updates
    # stored for them. Nothing of another collector's inventory.
    'social/inbox.py': {
        ('..main', 'connect'), ('..main', 'verified_user'), ('.loans', 'LOANS'), ('.loans', 'LoanView'),
        ('.loans', 'loan_facts'), ('.loans', 'loan_views'), ('.loans', 'role_of'),
        # The nudge's 14 days, so a nudge's update says when it began to apply (owner's decision, 2026-10-16).
        ('.loans', 'NUDGE_DAYS'),
        # The reader's own Trades through the Trades' one definition of what waits on them, and since when (trading
        # #273): the Trade view both sides read, never a pick or a Location.
        ('.trades', 'TRADES'), ('.trades', 'TradeView'), ('.trades', 'trade_facts'), ('.trades', 'trade_views'),
        ('.trades', 'waiting_trade_step'), ('.trades', 'trade_waiting_since')},
    # Trade Proposals and Trades both sides read (trading #270), as the Loans read theirs: card facts, the owner lock and
    # the Loans' revision helper. Steps that touch a collector's own inventory are in app.trade_inventory. Which of the
    # reader's Trades have a pick out of date, so Needs you and the inbox list them (``trade_picks.stale_pick_trades``,
    # #273): a set of Trade ids from the reader's own Holdings, never a Location; the read stays in app.trade_picks. The
    # Friends set is allowed ahead of Counter (#278), as the resolution lists it; ending a friendship's Trades (#274)
    # needs none. ``friend_ids`` must be imported inside the function that uses it, as in social/loans.py, because
    # app.social.friends imports this module (``end_trades_between``).
    'social/trades.py': {
        ('..trade_picks', 'stale_pick_trades'), ('..main', 'connect'), ('..main', 'verified_user'),
        ('..location_tree', 'error'), ('..location_tree', 'replay'), ('.friend_reads', 'card_facts'),
        ('.owners', 'ensure_owner'), ('.owners', 'lock_owners'), ('.loans', 'advance_revision'), ('.loans', 'NOW'),
        ('.friends', 'friend_ids')},
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
          ('FriendTradeCard', 'descriptor'), ('TradeCard', 'descriptor'), ('TradeMatchCard', 'descriptor'),
          ('TradeCardOffer', 'descriptor'), ('ValidationError', 'ctx')}


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


def string_constants(source: str) -> list[str]:
    """Every string constant of a module's source and every piece of its f-strings, docstrings left out: its SQL and
    its messages."""
    tree = ast.parse(source)
    docstrings = {id(node.body[0].value) for node in ast.walk(tree)
                  if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
                  and node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant)}
    return [node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings]


def inventory_reads(source: str) -> bool:
    """Whether a module's source reads an inventory table or calls a rule over a collector's Locations: a table after
    FROM, JOIN or a comma in any string constant (docstrings left out) or f-string piece, or a call of the hidden, For
    trade or listable rule anywhere in the source."""
    if HIDDEN_CALL.search(source):
        return True
    return any(INVENTORY_TABLE.search(text) for text in string_constants(source))


def several_owners_reads(source: str) -> bool:
    """Whether a module has a string constant (docstrings left out) or f-string piece that reads an inventory table and
    filters on a list of owners or borrowers (``owner_id = ANY(``)."""
    return any(SEVERAL_OWNERS_TABLE.search(text) and SEVERAL_OWNERS_FILTER.search(text)
               for text in string_constants(source))


def callers(pattern: re.Pattern) -> set[str]:
    """The modules under ``api/app``, relative to it, with a string constant that matches ``pattern``."""
    return {str(path.relative_to(APP)) for path in APP.rglob('*.py')
            if any(pattern.search(text) for text in string_constants(path.read_text(encoding='utf-8')))}


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
    # A Friend's Trade List (trading #269): cards and their copies, read by the walk like every other route.
    trade_list = {field for _, field, _ in routes['GET /api/social/trade-lists/{handle}']}
    assert {'copies', 'descriptor', 'next_page'} <= trade_list, trade_list
    # Discovery and Ask to trade (trading #276): matched cards with their counts, read by the walk like the rest.
    for route in ('GET /api/social/trade-matches', 'GET /api/social/trade-matches/{collector_id}'):
        matched = {field for _, field, _ in routes[route]}
        assert {'you_get', 'you_give', 'copies', 'need', 'want_list_need', 'origin', 'accepts_as', 'descriptor',
                'open_to_cash_offers', 'more_you_get'} <= matched, (route, matched)
    offers = {field for _, field, _ in routes['GET /api/social/trade-card-matches']}
    assert {'offers', 'copies', 'descriptor', 'display_name'} <= offers, offers
    # Trades (trading #270): both sides' cards and the other side, read by the walk on the list, one Trade and each
    # step under /api/social (withdraw, #270; decline and cancel, #271).
    for route in ('GET /api/social/trades', 'GET /api/social/trades/{trade_id}',
                  'POST /api/social/trades/{trade_id}/withdraw', 'POST /api/social/trades/{trade_id}/decline',
                  'POST /api/social/trades/{trade_id}/cancel'):
        trade = {field for _, field, _ in routes[route]}
        assert {'you_give', 'you_get', 'other', 'copies', 'descriptor', 'open_to_cash_offers'} <= trade, (route, trade)
    # Open to cash offers (trading #277): one setting, read and set by value.
    for route in ('GET /api/social/trade-settings', 'PUT /api/social/trade-settings'):
        assert {field for _, field, _ in routes[route]} == {'open_to_cash_offers'}, route


def test_each_sides_own_trade_reads_and_inventory_steps_stay_outside_the_social_area():
    # Trading #272: a side's own picks name its own Locations, so its side read, Use suggested picks and Confirm swap
    # live under /api/trades (app.trade_inventory), never under /api/social, and the Trade both sides read never grows
    # a pick, a suggestion or a destination.
    paths = app.openapi()['paths']
    for route, method in (('/api/trades/{trade_id}/side', 'get'),
                          ('/api/trades/{trade_id}/picks/use-suggested', 'post'),
                          ('/api/trades/{trade_id}/confirm-swap', 'post')):
        assert method in paths[route], route
    assert not [route for route in paths if route.startswith('/api/social') and
                ('/side' in route or 'confirm-swap' in route or 'use-suggested' in route)]
    trade_view = app.openapi()['components']['schemas']['TradeView']['properties']
    assert not {'picks', 'suggested', 'destination_id', 'deck_switches'} & set(trade_view)


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
                'SELECT 1 FROM friend f JOIN deck_list_line l ON true', 'select 1 from Location', 'FROM borrowed_holding',
                'SELECT quantity FROM trade_want w', 'SELECT 1 FROM friend f JOIN trade_accept a ON true'):
        assert caught(sql), sql
    assert inventory_reads("sql = f'SELECT 1 FROM friend f JOIN {schema}.x x ON true JOIN public.location l ON true'")
    assert inventory_reads("sql = f'SELECT 1 FROM friend f, {extra} JOIN holding h ON true'")
    assert inventory_reads("sql = 'SELECT 1 ' 'FROM holding'")
    assert inventory_reads('rows = hidden_locations(conn, owners)') and inventory_reads('ids = hidden_location_ids(x)')
    # The For trade and listable rules count too, in a string or in prose (trading #269).
    assert inventory_reads("SQL = 'SELECT 1 FROM for_trade_locations(ARRAY[%s]::text[]) f'\n")
    assert inventory_reads('"""Calls trade_listable (owners)."""\n') and inventory_reads('# for_trade_locations(x)\n')
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


def test_the_trade_statement_never_reads_borrowed_holdings():
    from app.social import friend_copies
    assert 'borrowed_holding' not in friend_copies.TRADE_READ


def test_only_the_choke_point_reads_several_owners_inventory():
    found = {str(path.relative_to(APP)) for path in APP.rglob('*.py')
             if several_owners_reads(path.read_text(encoding='utf-8'))}
    assert found <= {'social/friend_copies.py'}, found


def test_the_several_owners_guard_catches_a_filter_on_a_list_of_owners():
    for sql in ('SELECT 1 FROM holding h WHERE h.owner_id = ANY(%s)',
                'SELECT 1 FROM public.location l WHERE owner_id=any (%s)',
                'SELECT 1 FROM friend f JOIN deck_list_line l ON true WHERE l.owner_id = ANY(%s::text[])',
                'SELECT 1 FROM borrowed_holding b WHERE b.borrower_id = ANY(%s)'):
        assert several_owners_reads(f'SQL = {sql!r}\n'), sql
    assert several_owners_reads("sql = f'SELECT 1 FROM holding h WHERE h.owner_id = ANY({owners})'\n")
    # One owner, a filter on something else, a table that isn't inventory, or prose in a docstring: not a read of
    # several collectors' inventory.
    for sql in ('SELECT 1 FROM holding h WHERE h.owner_id = %s', 'SELECT 1 FROM holding h WHERE h.edition_id = ANY(%s)',
                'SELECT 1 FROM reserved_copies(%s::text[], NULL) r WHERE r.owner_id = ANY(%s)'):
        assert not several_owners_reads(f'SQL = {sql!r}\n'), sql
    assert not several_owners_reads('def f():\n    """FROM holding WHERE owner_id = ANY(%s)"""\n    return 1\n')


def test_only_counts_and_the_choke_point_call_reserving_picks():
    found = callers(RESERVING_PICKS_CALL)
    assert 'social/counts.py' in found and found <= RESERVING_PICKS_CALLERS, found
    # counts reads it for one owner only; several owners' picks are read only by the choke point.
    calls = [text for text in string_constants((SOCIAL / 'counts.py').read_text(encoding='utf-8'))
             if RESERVING_PICKS_CALL.search(text)]
    assert calls and all(re.search(r'\breserving_picks\s*\(\s*ARRAY\[%s\]', text) for text in calls), calls


def test_only_the_trade_list_and_the_choke_point_call_the_listable_rule():
    assert callers(LISTABLE_CALL) == LISTABLE_CALLERS
    assert callers(FOR_TRADE_CALL) == FOR_TRADE_CALLERS


def test_the_call_guards_match_string_constants_and_never_docstrings():
    called = ("SQL = 'SELECT 1 FROM reserving_picks (ARRAY[%s]::text[], %s::uuid[])'\nLISTED = f'FROM trade_listable({x})'\n"
              "MARKED = 'SELECT 1 FROM for_trade_locations(ARRAY[%s]::text[]) f'\n")
    found = string_constants(called)
    assert any(RESERVING_PICKS_CALL.search(text) for text in found)
    assert any(LISTABLE_CALL.search(text) for text in found)
    assert any(FOR_TRADE_CALL.search(text) for text in found)
    described = ('def f():\n    """Reads reserving_picks(owners), trade_listable(owners) and for_trade_locations(owners)."""\n'
                 '    return 1\n')
    assert not any(RESERVING_PICKS_CALL.search(text) or LISTABLE_CALL.search(text) or FOR_TRADE_CALL.search(text)
                   for text in string_constants(described))
    # A name without the call form is not a call.
    assert not any(RESERVING_PICKS_CALL.search(text) for text in string_constants("NOTE = 'reserving_picks'\n"))
