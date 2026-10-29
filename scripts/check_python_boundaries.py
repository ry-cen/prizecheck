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
"""
import ast
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'api/app'
OWNERS = ROOT / 'scripts/python_module_owners.txt'
ALLOWLIST = ROOT / 'scripts/python_boundary_allowlist.txt'
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


def imports(name, path, package, names):
    """(line, target module) for every import in a file: module level, function level and importlib literals."""
    tree = ast.parse(path.read_text(), str(path))
    found = []
    for node in ast.walk(tree):
        targets = []
        if isinstance(node, ast.Import):
            targets = [item.name for item in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = name.split('.') if package else name.split('.')[:-1]
                base = base[:len(base) - (node.level - 1)]
                module = '.'.join(base + ([node.module] if node.module else []))
            else:
                module = node.module or ''
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
    failures = check(APP, owners_text, ALLOWLIST.read_text())
    for reason in failures:
        print(f'FAILED: {reason}')
    return int(bool(failures))


if __name__ == '__main__':
    sys.exit(main())
