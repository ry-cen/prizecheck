"""No ``/api/social`` response can carry a Location or a Deck (social network #250, ADR 0014, spec "Friend-facing reads:
one choke point").

Friends see only what a collector could lend now, never where it is. ``friend_copies`` answers no Location or Deck, and
this test is the guard behind it against future edits: it walks the generated OpenAPI schema of every response of every
``/api/social`` route, through every ``$ref``, array, union and map, and fails on any field named for a Location or a
Deck. A name is split into words (snake_case and camelCase); a word from ``FORBIDDEN`` fails it.

``ALLOWED`` holds the one exception, ``in_deck``: a count of copies a Deck holds for its own line ("1 in a Deck"),
never which Deck. It must stay a string count. Anything else that needs one of these words in its name is a change to
the privacy rule and needs the owner's say, not an entry here.
"""
import re
from pathlib import Path

from app.main import app

SOCIAL = Path(__file__).resolve().parents[1] / 'app' / 'social'
# Reads of inventory tables. In the social area only friend_copies (the choke point) and hidden_locations (the
# collector's own Locations, and the rule friend_copies' statement calls) may make them.
INVENTORY_READ = re.compile(r'\b(?:FROM|JOIN)\s+(?:holding|deck_list_line|deck_list|location|borrowed_holding)\b'
                            r'|\bhidden_locations\s*\(', re.IGNORECASE)
READERS = {'friend_copies.py', 'hidden_locations.py'}

FORBIDDEN = frozenset({'location', 'locations', 'deck', 'decks', 'leaf', 'leaves', 'unsorted'})
ALLOWED = {'in_deck': {'type': 'string'}}


def words(name: str) -> set[str]:
    """The words of a field name: snake_case, kebab-case and camelCase, lower-cased."""
    spaced = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', name)
    return {word.lower() for word in re.split(r'[^A-Za-z0-9]+', spaced) if word}


def fields(schema, components, path='', seen=None):
    """(path, field name, field schema) for every field the schema can hold, at any depth."""
    seen = set() if seen is None else seen
    if not isinstance(schema, dict):
        return
    if '$ref' in schema:
        name = schema['$ref'].split('/')[-1]
        if name in seen:
            return
        yield from fields(components[name], components, f'{path}<{name}>', seen | {name})
        return
    for field, value in (schema.get('properties') or {}).items():
        yield path, field, value
        yield from fields(value, components, f'{path}.{field}', seen)
    for key in ('items', 'additionalProperties', 'not'):
        if isinstance(schema.get(key), dict):
            yield from fields(schema[key], components, f'{path}[{key}]', seen)
    for key in ('anyOf', 'oneOf', 'allOf', 'prefixItems'):
        for part in schema.get(key) or []:
            yield from fields(part, components, path, seen)


def refused(schema, components) -> list[str]:
    found = []
    for path, field, value in fields(schema, components):
        if field in ALLOWED:
            if {key: value.get(key) for key in ALLOWED[field]} != ALLOWED[field]:
                found.append(f'{path}.{field} must stay a string count')
        elif words(field) & FORBIDDEN:
            found.append(f'{path}.{field}')
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
    assert any(field == 'in_deck' for _, field, _ in routes['GET /api/social/collections/{handle}'])


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
        '.cards[items].deck_id', '.where[additionalProperties].location_name',
        '.loop<Loop>.items[items]<Inner>.deckName', '.in_deck must stay a string count'])
    assert words('parentLocationId') == {'parent', 'location', 'id'} and words('in_deck') == {'in', 'deck'}


def test_only_the_choke_point_reads_inventory_tables_in_the_social_area():
    found = {path.name for path in SOCIAL.glob('*.py') if INVENTORY_READ.search(path.read_text(encoding='utf-8'))}
    assert found == READERS
