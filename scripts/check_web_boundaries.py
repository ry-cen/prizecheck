"""Web boundary check for web/src (ADR 0023's composition, frontend follow-on): shared code imports no game, and no game
imports another. Standard library only; reads the source as text.

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

What counts as an import, with comments and the text of every string and template literal masked out first, so
import-like text inside them is not code:
- `import ... from "x"`, `import type ... from "x"`, `export ... from "x"`, `export * from "x"` and `export type
  {...} from "x"`, across lines, starting a line or after a `;` or `}` on it;
- `import "x"`, starting a line or after a `;` or `}`;
- `import("x")` anywhere but after `.`, with a quoted or a backtick string without `${`, which covers
  `typeof import("x")`.
A `?query` suffix (`?worker`, `?url`) is dropped. Bare package specifiers are not web/src files and are skipped.
"""
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
WEB = 'web/src'
ALLOWLIST = ROOT / 'scripts/web_boundary_allowlist.txt'
SOURCES = ('.ts', '.tsx')
TESTS = ('.test.ts', '.test.tsx')
# Each pattern ends at a string's opening quote; the string's text is read from its span. A statement starts a line or
# follows a `;` or a `}` on the same line.
START = r'''(?:^|(?<=[;}]))[ \t]*'''
STATIC = re.compile(START + r'''(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])''', re.M)
SIDE_EFFECT = re.compile(START + r'''import\s*(['"])''', re.M)
DYNAMIC = re.compile(r'''(?<![\w$.])import\s*\(\s*(['"`])''')
CLOSE = re.compile(r'\s*[,)]')


def mask(text):
    """(code, strings) for a TypeScript source: the code with comments and every string's and template literal's text
    blanked (quotes and newlines kept, so offsets and line numbers hold), and {opening quote offset: (closing quote
    offset, text)}. Import-like text inside a comment or a string is then not code. A quoted string ends at its line's
    end, so a quote in a regular expression literal costs one line at most."""
    out, strings, i, n = [], {}, 0, len(text)
    while i < n:
        char, pair = text[i], text[i:i + 2]
        if pair == '//':
            end = text.find('\n', i)
            end = n if end == -1 else end
            out.append(' ' * (end - i))
            i = end
        elif pair == '/*':
            end = text.find('*/', i + 2)
            end = n if end == -1 else end + 2
            out.append(re.sub(r'[^\n]', ' ', text[i:end]))
            i = end
        elif char in '\'"`':
            j = i + 1
            while j < n and text[j] != char and (char == '`' or text[j] != '\n'):
                j += 2 if text[j] == '\\' else 1
            j = min(j, n)
            strings[i] = (j, text[i + 1:j])
            out.append(char + re.sub(r'[^\n]', ' ', text[i + 1:j]) + text[j:j + 1])
            i = j + 1
        else:
            out.append(char)
            i += 1
    return ''.join(out), strings


def specifiers(text):
    """(line, specifier) for every import, re-export and literal dynamic import in a TypeScript source."""
    code, strings = mask(text)
    found = set()
    for pattern in (STATIC, SIDE_EFFECT, DYNAMIC):
        for match in pattern.finditer(code):
            quote = match.start(1)
            end, value = strings.get(quote, (None, ''))
            if end is None or not value or '\n' in value:
                continue
            if pattern is DYNAMIC and ('${' in value or not CLOSE.match(code, end + 1)):
                continue
            found.add((code.count('\n', 0, quote) + 1, value))
    return sorted(found)


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


def scan(files):
    """({`src -> dst`: reason}, [failures]) for {path: text}."""
    edges, failures = {}, []
    for path, text in files.items():
        if owner_of(path) == ('games', None):
            failures.append(f'{path} is directly under {WEB}/games: put it in a game')
        for line, specifier in specifiers(text):
            target = resolve(path, specifier, files)
            reason = target and forbidden(path, target)
            if reason:
                edges.setdefault(f'{path} -> {target}', f'{reason}, line {line}')
    return edges, failures


def check(files, allow_text):
    """The FAILED reasons for {path: text} and an allow-list's text."""
    edges, failures = scan(files)
    allowed = read_allowlist(allow_text, failures)
    for edge, reason in sorted(edges.items()):
        if edge not in allowed:
            failures.append(f'forbidden import {edge} ({reason})')
    for edge in sorted(allowed - edges.keys()):
        failures.append(f'stale allow-list edge {edge}: no such forbidden import')
    return failures


def main():
    failures = check(sources(ROOT), ALLOWLIST.read_text(encoding='utf-8'))
    for reason in failures:
        print(f'FAILED: {reason}')
    return int(bool(failures))


if __name__ == '__main__':
    sys.exit(main())
