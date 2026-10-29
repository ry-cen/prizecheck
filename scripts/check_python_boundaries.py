"""Python boundary check for api/app: no import from core into a game, from a game into another game, or from the shared side
into the composition root; no SQL on the identity tables outside identity_store.py. No database required.

Owners. app.core.* is core, app.games.<g>.* is game <g>, app.main is root. Every other module is listed in
scripts/python_module_owners.txt as `<dotted name> <core|mixed|pokemon|root>`. A module missing from the file fails, and so
does a line naming no module. `mixed` means core mechanics with a game dependency, split by composition in a later package;
for the rules below it counts as core, and `pokemon` means the Pokémon game.

Forbidden edges (an import, a function-level import or an importlib.import_module literal):
- core (or mixed) to any game;
- core (or mixed) to root;
- anything under app.core to a top-level module marked mixed;
- game <g> to game <h>.
Root modules (app.main and the entry shims) may import anything.

Every forbidden edge must be listed in scripts/python_boundary_allowlist.txt as `src -> dst`, and a line that matches no
forbidden edge fails, so the list only shrinks. Its `[sql]` section lists `<module>: <table>` for the SQL hits that exist today.

`--write-baseline` rewrites the allow-list from the code as it stands; it is how the first baseline was made.

Architecture pins. The named rules in scripts/python_architecture_rules.py (data) are run by `architecture` below: exact
importer lists, the social area's reads and imports, the price client's settings. There is no allow-list for them; each
failure prints `FAILED: <rule>: <detail>`. `--show-pins` prints what every rule found on the tree.
"""
import ast
import importlib.util
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'api/app'
OWNERS = ROOT / 'scripts/python_module_owners.txt'
ALLOWLIST = ROOT / 'scripts/python_boundary_allowlist.txt'
ARCHITECTURE = ROOT / 'scripts/python_architecture_rules.py'
CLASSES = ('core', 'mixed', 'pokemon', 'root')
SQL_EXEMPT = 'identity_store.py'
SQL = re.compile(r'(?i)\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+("user"|session|account|verification|auth_send_event|auth_rate_event|owner_binding|released_handle)(?![\w"])')
HEADER = """# Forbidden Python imports and identity-table SQL that exist today, as found by scripts/check_python_boundaries.py.
# Each Now package removes its own lines. Never add a line to get a change through: split the module instead.
# Regenerate (only to record a removal) with: .venv/bin/python scripts/check_python_boundaries.py --write-baseline
"""


def modules(app):
    """{dotted name: (path, is_package)} for every .py under app, named from the directory's own name."""
    found = {}
    for path in sorted(app.rglob('*.py')):
        parts = [app.name, *path.relative_to(app).with_suffix('').parts]
        package = parts[-1] == '__init__'
        found['.'.join(parts[:-1] if package else parts)] = (path, package)
    return found


def known(name, names):
    """The longest prefix of a dotted name that is a module under app, or None."""
    while name:
        if name in names:
            return name
        name = name.rpartition('.')[0]
    return None


def absolute_module(name, package, node):
    """The dotted module an `ast.ImportFrom` in module `name` names, a relative import resolved from the module's own place."""
    if node.level:
        base = name.split('.') if package else name.split('.')[:-1]
        base = base[:len(base) - (node.level - 1)]
        return '.'.join(base + ([node.module] if node.module else []))
    return node.module or ''


def imports(name, path, package, names):
    """(line, target module) for every import in a file: module level, function level and importlib literals."""
    tree = ast.parse(path.read_text(), str(path))
    found = []
    for node in ast.walk(tree):
        targets = []
        if isinstance(node, ast.Import):
            targets = [item.name for item in node.names]
        elif isinstance(node, ast.ImportFrom):
            module = absolute_module(name, package, node)
            targets = [f'{module}.{item.name}' if f'{module}.{item.name}' in names else module for item in node.names]
        elif isinstance(node, ast.Call) and ast.unparse(node.func).rpartition('.')[2] == 'import_module' \
                and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            targets = [node.args[0].value]
        for target in targets:
            resolved = known(target, names)
            if resolved and resolved != name:
                found.append((node.lineno, resolved))
    return found


def sql_hits(path):
    """{table} for each identity table named after a SQL keyword in a string constant of a file."""
    tables = set()
    for node in ast.walk(ast.parse(path.read_text(), str(path))):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            tables.update(match.group(2).strip('"').lower() for match in SQL.finditer(node.value))
    return tables


def read_lines(text):
    return [(number, line.strip()) for number, line in enumerate(text.splitlines(), 1)
            if line.strip() and not line.strip().startswith('#')]


def read_owners(text, failures):
    owners = {}
    for number, line in read_lines(text):
        parts = line.split()
        if len(parts) != 2 or parts[1] not in CLASSES:
            failures.append(f'owners line {number} is not `<module> <{"|".join(CLASSES)}>`: {line}')
        else:
            owners[parts[0]] = parts[1]
    return owners


def read_allowlist(text, failures):
    edges, sql, section = set(), set(), 'edges'
    for number, line in read_lines(text):
        if line in ('[edges]', '[sql]'):
            section = line[1:-1]
        elif section == 'edges' and re.fullmatch(r'[\w.]+ -> [\w.]+', line):
            edges.add(line)
        elif section == 'sql' and re.fullmatch(r'[\w.]+: \w+', line):
            sql.add(line)
        else:
            failures.append(f'allow-list line {number} is not valid in [{section}]: {line}')
    return edges, sql


def owner_of(name, owners):
    """('core'|'mixed'|'root'|'game', game or None) for a module name; None for app.games itself."""
    root = name.partition('.')[0]
    if name == f'{root}.core' or name.startswith(f'{root}.core.'):
        return 'core', None
    if name == f'{root}.games':
        return None
    if name.startswith(f'{root}.games.'):
        return 'game', name.split('.')[2]
    if name == f'{root}.main':
        return 'root', None
    kind = owners.get(name)
    if kind == 'pokemon':
        return 'game', 'pokemon'
    return (kind, None) if kind else None


def forbidden(source, target, owners):
    """The reason an import is forbidden, or None."""
    src, dst = owner_of(source, owners), owner_of(target, owners)
    if not src or not dst:
        return None
    root = source.partition('.')[0]
    package = source == f'{root}.core' or source.startswith(f'{root}.core.')
    if src[0] in ('core', 'mixed'):
        if dst[0] == 'game':
            return f'core to game {dst[1]}'
        if dst[0] == 'root':
            return 'core to root'
        if package and dst[0] == 'mixed':
            return 'core to a mixed module'
    if src[0] == 'game' and dst[0] == 'game' and src[1] != dst[1]:
        return f'game {src[1]} to game {dst[1]}'
    return None


def scan(app, owners_text, failures):
    """(forbidden edges {src -> dst: reason}, sql hits {module: table}); owner problems go to failures."""
    names = modules(app)
    owners = read_owners(owners_text, failures)
    root = app.name
    for name in sorted(names):
        if name not in owners and owner_of(name, owners) is None and name != f'{root}.games':
            failures.append(f'module {name} is missing from the owners file')
    for name in sorted(owners):
        if name not in names:
            failures.append(f'owners line names no module: {name}')
    edges, hits = {}, set()
    for name, (path, package) in names.items():
        for _, target in imports(name, path, package, names):
            reason = forbidden(name, target, owners)
            if reason:
                edges[f'{name} -> {target}'] = reason
        if path.name != SQL_EXEMPT:
            hits.update(f'{name}: {table}' for table in sql_hits(path))
    return edges, hits


def check(app, owners_text, allow_text):
    """The FAILED reasons for a source tree, an owners file and an allow-list."""
    failures = []
    edges, hits = scan(app, owners_text, failures)
    allowed, allowed_sql = read_allowlist(allow_text, failures)
    for edge, reason in sorted(edges.items()):
        if edge not in allowed:
            failures.append(f'forbidden import {edge} ({reason})')
    for edge in sorted(allowed - edges.keys()):
        failures.append(f'stale allow-list edge {edge}: no such forbidden import')
    for hit in sorted(hits - allowed_sql):
        failures.append(f'SQL on an identity table outside {SQL_EXEMPT}: {hit}')
    for hit in sorted(allowed_sql - hits):
        failures.append(f'stale allow-list sql line {hit}: no such SQL')
    return failures


# --- Architecture pins ---------------------------------------------------------------------------------------------

def load_rules(path=ARCHITECTURE):
    spec = importlib.util.spec_from_file_location('python_architecture_rules', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def string_constants(source):
    """Every string constant of a module's source and every piece of its f-strings, docstrings left out: its SQL and
    its messages."""
    tree = ast.parse(source)
    docstrings = {id(node.body[0].value) for node in ast.walk(tree)
                  if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
                  and node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant)}
    return [node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings]


def inventory_reads(source, rules):
    """Whether a module's source reads an inventory table or calls a rule over a collector's Locations: a table after
    FROM, JOIN or a comma in any string constant (docstrings left out) or f-string piece, or a call of the hidden, For
    trade or listable rule anywhere in the source."""
    if rules.HIDDEN_CALL.search(source):
        return True
    return any(rules.INVENTORY_TABLE.search(text) for text in string_constants(source))


def several_owners_reads(source, rules):
    """Whether a module has a string constant (docstrings left out) or f-string piece that reads an inventory table and
    filters on a list of owners or borrowers (``owner_id = ANY(``)."""
    return any(rules.SEVERAL_OWNERS_TABLE.search(text) and rules.SEVERAL_OWNERS_FILTER.search(text)
               for text in string_constants(source))


def app_imports(name, source, package, root):
    """(module, name) of every import inside the app, both absolute: `from ..x import y` in app.social.z is
    ('app.x', 'y'), `from . import y` is ('app.social', 'y'), a plain `import app.x` is ('app.x', '*'), and an
    importlib.import_module literal is (the literal, '*'). Function-level imports count."""
    def inside(module):
        return module == root or module.startswith(f'{root}.')

    found = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom):
            module = absolute_module(name, package, node)
            if inside(module):
                found |= {(module, item.name) for item in node.names}
        elif isinstance(node, ast.Import):
            found |= {(item.name, '*') for item in node.names if inside(item.name)}
        elif isinstance(node, ast.Call) and ast.unparse(node.func).rpartition('.')[2] == 'import_module' \
                and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str) \
                and inside(node.args[0].value):
            found.add((node.args[0].value, '*'))
    return found


class Tree:
    """A repository checkout seen by the architecture rules: the modules under api/app with their text."""

    def __init__(self, root):
        self.root = Path(root)
        self.app = self.root / 'api/app'
        self.names = modules(self.app)
        # x.py beside x/__init__.py both name app.x; `names` keeps one, so the rules would not see the other's text.
        self.duplicates = sorted(name for name in self.names
                                 if (self.app.parent.joinpath(*name.split('.')).with_suffix('.py')).is_file()
                                 and (self.app.parent.joinpath(*name.split('.')) / '__init__.py').is_file())
        self.text = {name: path.read_text(encoding='utf-8') for name, (path, _) in self.names.items()}
        self._imports = {}

    def importers(self, target):
        """The modules with an import that resolves to `target` (or a name under it)."""
        found = set()
        for name, (path, package) in self.names.items():
            if name == target or name.startswith(f'{target}.'):
                continue
            if name not in self._imports:
                self._imports[name] = imports(name, path, package, self.names)
            if any(module == target or module.startswith(f'{target}.') for _, module in self._imports[name]):
                found.add(name)
        return found

    def social(self, packages):
        return {name for name in self.names if any(name == pkg or name.startswith(f'{pkg}.') for pkg in packages)}

    def app_imports(self, name):
        return app_imports(name, self.text[name], self.names[name][1], self.app.name)

    def parse(self, name):
        return ast.parse(self.text[name], str(self.names[name][0]))


def compare(found, expected, exact=True):
    """The detail of how a found set differs from the expected one: unexpected members always, missing ones when exact."""
    parts = []
    if found - expected:
        parts.append('unexpected ' + ', '.join(sorted(map(str, found - expected))))
    if exact and expected - found:
        parts.append('missing ' + ', '.join(sorted(map(str, expected - found))))
    return ['; '.join(parts)] if parts else []


def missing_module(tree, module):
    return [] if module in tree.names else [f'no module {module}']


def rule_importers(tree, data, rules):
    found = tree.importers(data['imported'])
    return sorted(found), compare(found, data['importers'])


def rule_beside(tree, data, rules):
    failures = missing_module(tree, data['module'])
    if failures:
        return [], failures
    target = tree.names[data['module']][0].parent / data['file']
    return [str(target.relative_to(tree.root))], [] if target.is_file() else [f'{data["file"]} is not beside {data["module"]}']


def rule_tsv_readers(tree, data, rules):
    found = {str(path.relative_to(tree.root)) for folder in ('api/app', 'scripts') if (tree.root / folder).is_dir()
             for path in sorted((tree.root / folder).rglob('*.py')) if data['pattern'].search(path.read_text(encoding='utf-8'))}
    return sorted(found), compare(found, data['readers'])


def rule_price_client(tree, data, rules):
    failures = missing_module(tree, data['module'])
    if failures:
        return [], failures
    module = tree.parse(data['module'])
    nodes = list(ast.walk(module))
    origins = [node.value for node in nodes if isinstance(node, ast.Constant) and isinstance(node.value, str)
               and node.value.startswith(('http:', 'https:'))]
    clients = [node for node in nodes if isinstance(node, ast.Call) and ast.unparse(node.func) == data['client']]
    loads = [node for node in nodes if isinstance(node, ast.Call) and ast.unparse(node.func) == data['loads']]
    functions = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == data['function']]
    failures = []
    if origins != data['origins']:
        failures.append(f'origin literals are {origins}, not {data["origins"]}')
    settings = {}
    if len(clients) != 1:
        failures.append(f'{len(clients)} {data["client"]}(...) calls, not exactly one')
    else:
        settings = {keyword.arg: ast.unparse(keyword.value) for keyword in clients[0].keywords}
        for key, value in data['client_keywords'].items():
            if settings.get(key) != value:
                failures.append(f'{data["client"]} keyword {key} is {settings.get(key)}, not {value}')
    if not loads:
        failures.append(f'no {data["loads"]} call')
    for call in loads:
        if data['loads_keyword'] not in {keyword.arg for keyword in call.keywords}:
            failures.append(f'{data["loads"]} on line {call.lineno} passes no {data["loads_keyword"]}')
    arguments = [arg.arg for arg in functions[0].args.args] if functions else None
    if arguments != data['function_arguments']:
        failures.append(f'{data["function"]} takes {arguments}, not {data["function_arguments"]}')
    found = [f'origins {origins}', f'{data["client"]} keywords {settings}', f'{len(loads)} {data["loads"]} calls',
             f'{data["function"]}{arguments}']
    return found, failures


def rule_host(tree, data, rules):
    found = {name for name, text in tree.text.items() if data['host'] in text.lower()}
    return sorted(found), compare(found, data['allowed'], exact=False)


def rule_social_inventory(tree, data, rules):
    found = {name for name in tree.social(rules.SOCIAL_PACKAGES) if inventory_reads(tree.text[name], rules)}
    return sorted(found), compare(found, data['readers'])


def rule_social_imports(tree, data, rules):
    area = tree.social(rules.SOCIAL_PACKAGES)
    failures = [f'the social area and the map differ: {detail}' for detail in compare(area, set(data['allowed']))]
    found = []
    for name in sorted(area & set(data['allowed'])):
        imported = tree.app_imports(name)
        found.extend(f'{name} -> {module} {item}' for module, item in sorted(imported))
        failures.extend(f'{name} imports {module} {item}, which its entry does not allow'
                        for module, item in sorted(imported - set(data['allowed'][name])))
    return found, failures


def rule_pattern_readers(tree, data, rules):
    found = {name for name, text in tree.text.items() if data['pattern'].search(text)}
    return sorted(found), compare(found, data['readers'])


def rule_several_owners(tree, data, rules):
    found = {name for name, text in tree.text.items() if several_owners_reads(text, rules)}
    return sorted(found), compare(found, data['readers'], exact=False)


def rule_no_name(tree, data, rules):
    failures = missing_module(tree, data['module'])
    if failures:
        return [], failures
    found = sorted(f'{module} {item}' for module, item in tree.app_imports(data['module']) if item == data['name'])
    return found, [f'{data["module"]} imports the name {data["name"]}: {entry}' for entry in found]


def rule_social_complete(tree, data, rules):
    found = {'.'.join([tree.app.name, *path.relative_to(tree.app).parts]) for path in tree.app.rglob(data['directory'])
             if path.is_dir() and any(path.rglob('*.py'))}
    return sorted(found), [f'package {name} is not in SOCIAL_PACKAGES' for name in sorted(found - set(rules.SOCIAL_PACKAGES))]


ARCHITECTURE_RULES = {
    'set-codes-importers': rule_importers,
    'format-rules-beside-evaluator': rule_beside,
    'import-aliases-importers': rule_importers,
    'import-aliases-tsv-readers': rule_tsv_readers,
    'price-source-client': rule_price_client,
    'tcgcsv-host': rule_host,
    'social-inventory-readers': rule_social_inventory,
    'social-allowed-imports': rule_social_imports,
    'friends-of-readers': rule_pattern_readers,
    'several-owners-readers': rule_several_owners,
    'trade-steps-no-friend-ids': rule_no_name,
    'social-area-complete': rule_social_complete,
}


def run_rule(tree, name, rules):
    """(what the rule found, [`<rule>: <detail>`]) for one configured rule on a tree."""
    found, details = ARCHITECTURE_RULES[name](tree, rules.RULES[name], rules)
    return found, [f'{name}: {detail}' for detail in details]


def architecture(root, rules):
    """({rule: what it found}, [`<rule>: <detail>`]) for a checkout, running every rule `rules.RULES` configures. A rule
    in the data without an engine fails, and so does an engine rule the data does not configure."""
    pins, failures = {}, []
    for name in sorted(set(rules.RULES) - set(ARCHITECTURE_RULES)):
        failures.append(f'{name}: no such rule in the checker')
    tree = Tree(root)
    failures.extend(f'modules: two files name module {name}' for name in tree.duplicates)
    for name in ARCHITECTURE_RULES:
        if name not in rules.RULES:
            failures.append(f'{name}: the rule is not configured in {ARCHITECTURE.name}')
            continue
        pins[name], found = run_rule(tree, name, rules)
        failures.extend(found)
    return pins, failures


def baseline(app, owners_text):
    failures = []
    edges, hits = scan(app, owners_text, failures)
    lines = [HEADER, '[edges]', *sorted(edges), '', '[sql]', *sorted(hits)]
    return failures, '\n'.join(lines) + '\n'


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    owners_text = OWNERS.read_text()
    if '--write-baseline' in argv:
        failures, text = baseline(APP, owners_text)
        for reason in failures:
            print(f'FAILED: {reason}')
        if failures:
            return 1
        ALLOWLIST.write_text(text)
        print(f'wrote {ALLOWLIST.relative_to(ROOT)}')
        return 0
    pins, architecture_failures = architecture(ROOT, load_rules())
    if '--show-pins' in argv:
        for name, found in pins.items():
            print(f'{name}:')
            for item in found:
                print(f'  {item}')
    failures = check(APP, owners_text, ALLOWLIST.read_text()) + architecture_failures
    for reason in failures:
        print(f'FAILED: {reason}')
    return int(bool(failures))


if __name__ == '__main__':
    sys.exit(main())
