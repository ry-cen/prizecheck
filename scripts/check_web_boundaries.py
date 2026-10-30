"""Web boundary check for web/src (ADR 0023's composition, frontend follow-on): shared code imports no game, and no game
imports another. Standard library only; the imports come from the installed TypeScript parser (scripts/web_imports.mjs).

Owners. A file under web/src/games/<g>/ belongs to game <g>; a file directly under web/src/games belongs to none and
fails. Every other file under web/src is shared.

Forbidden edges, each a relative specifier resolved from the importing file:
- shared to any game;
- game <g> to game <h>.
A game may import shared code. A test file (`*.test.ts`, `*.test.tsx`) outside the games may import a game: it checks
the composition, it is not part of it. A test inside a game is still held to the game-to-game rule.

Mixed composition points. A shared module that passes a game's values into shared code (catalogText.ts passing the
Pokémon Formats into the Catalog's chips, DeckBuilderPage.tsx passing Pokémon's Deck List grouping) is listed in
scripts/web_boundary_allowlist.txt as `<importer> -> <imported>`, repository-relative. A line that matches no forbidden
edge fails, so a module that stops composing leaves the list. See docs/planning/shared-core/frontend-composition.md.

What counts as a reference: scripts/web_imports.mjs parses every file with the installed TypeScript parser and lists
`import`/`export ... from`, `import x = require("x")`, `import("x")`, `typeof import("x")`, `require("x")` and
`new URL("x", import.meta.url)` (how Vite bundles a worker or an asset). Strings, comments, template literals and
regular expressions are parsed as what they are, so text in them is not a reference and code in a `${...}` is.

Fail closed. A reference whose module is not a string literal (`import(name)`, `import.meta.glob(...)`) fails, and so
does a non-relative specifier that is neither a `node:` builtin nor a package package.json declares: the repository has
no path aliases (no tsconfig `paths`, no Vite `resolve.alias`), so such a specifier could name a web/src file the check
does not see. A `?query` suffix (`?worker`, `?url`) is dropped.
"""
from pathlib import Path, PurePosixPath
import json
import posixpath
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WEB = 'web/src'
ALLOWLIST = ROOT / 'scripts/web_boundary_allowlist.txt'
SOURCES = ('.ts', '.tsx')
TESTS = ('.test.ts', '.test.tsx')
READER = ROOT / 'scripts/web_imports.mjs'
PACKAGE = ROOT / 'package.json'


def references(files):
    """{path: [(line, kind, specifier or None)]} for {path: text}, from scripts/web_imports.mjs."""
    node = shutil.which('node')
    if not node:
        raise SystemExit('FAILED: node is not on PATH; the web boundary check reads imports with TypeScript')
    result = subprocess.run([node, str(READER)], input=json.dumps(files), capture_output=True, text=True, cwd=ROOT)
    if result.returncode:
        raise SystemExit(f'FAILED: {READER.name} exited {result.returncode}: {result.stderr.strip()}')
    return {path: [tuple(entry) for entry in found] for path, found in json.loads(result.stdout).items()}


def packages(text):
    """The package names a package.json declares."""
    data = json.loads(text)
    return {name for field in ('dependencies', 'devDependencies') for name in data.get(field, {})}


def package_of(specifier):
    """`react-dom` for `react-dom/client`, `@scope/name` for `@scope/name/x`."""
    parts = specifier.split('/')
    return '/'.join(parts[:2]) if specifier.startswith('@') else parts[0]


def resolve(importer, specifier, files):
    """The repository-relative file a relative specifier names, or its normalised path when no file matches; None for
    a bare package specifier."""
    specifier = specifier.partition('?')[0]
    if not specifier.startswith(('./', '../')):
        return None
    base = posixpath.normpath(posixpath.join(posixpath.dirname(importer), specifier))
    for candidate in (base, *(base + ext for ext in SOURCES), *(f'{base}/index{ext}' for ext in SOURCES)):
        if candidate in files:
            return candidate
    return base


def owner_of(path):
    """('game', g) for a file of game g, ('games', None) for a file directly under web/src/games, ('shared', None) for
    any other file under web/src, None outside it."""
    parts = PurePosixPath(path).parts
    root = PurePosixPath(WEB).parts
    if parts[:len(root)] != root:
        return None
    inside = parts[len(root):]
    if inside[:1] == ('games',):
        return ('game', inside[1]) if len(inside) > 2 else ('games', None)
    return 'shared', None


def forbidden(importer, target):
    """The reason an import is forbidden, or None."""
    src, dst = owner_of(importer), owner_of(target)
    if not src or not dst or dst[0] != 'game':
        return None
    if src[0] == 'shared' and not importer.endswith(TESTS):
        return f'shared to game {dst[1]}'
    if src[0] == 'game' and src[1] != dst[1]:
        return f'game {src[1]} to game {dst[1]}'
    return None


def sources(root):
    """{repository-relative path: text} for every .ts and .tsx file under web/src."""
    return {path.relative_to(root).as_posix(): path.read_text(encoding='utf-8')
            for path in sorted((root / WEB).rglob('*')) if path.suffix in SOURCES and path.is_file()}


def read_allowlist(text, failures):
    edges = set()
    for number, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if re.fullmatch(r'\S+ -> \S+', line):
            edges.add(line)
        else:
            failures.append(f'allow-list line {number} is not `<importer> -> <imported>`: {line}')
    return edges


def scan(files, declared):
    """({`src -> dst`: reason}, [failures]) for {path: text} and the declared package names."""
    edges, failures = {}, []
    found = references(files)
    for path in files:
        if owner_of(path) == ('games', None):
            failures.append(f'{path} is directly under {WEB}/games: put it in a game')
        for line, kind, specifier in found.get(path, []):
            if specifier is None:
                failures.append(f'{path} line {line}: a {kind} reference whose module is not a string literal')
                continue
            bare = specifier.partition('?')[0]
            if not bare.startswith(('./', '../')):
                if not (bare.startswith('node:') or package_of(bare) in declared):
                    failures.append(f'{path} line {line}: {specifier} is neither relative nor a declared package')
                continue
            target = resolve(path, specifier, files)
            reason = forbidden(path, target)
            if reason:
                edges.setdefault(f'{path} -> {target}', f'{reason}, line {line}')
    return edges, failures


def check(files, allow_text, declared):
    """The FAILED reasons for {path: text}, an allow-list's text and the declared package names."""
    edges, failures = scan(files, declared)
    allowed = read_allowlist(allow_text, failures)
    for edge, reason in sorted(edges.items()):
        if edge not in allowed:
            failures.append(f'forbidden import {edge} ({reason})')
    for edge in sorted(allowed - edges.keys()):
        failures.append(f'stale allow-list edge {edge}: no such forbidden import')
    return failures


def main():
    failures = check(sources(ROOT), ALLOWLIST.read_text(encoding='utf-8'), packages(PACKAGE.read_text(encoding='utf-8')))
    for reason in failures:
        print(f'FAILED: {reason}')
    return int(bool(failures))


if __name__ == '__main__':
    sys.exit(main())
