"""Route-isolation check for the web build: no private page in a public page's static graph, no lazy page in the entry.

web/src/shell/lazyPages.ts loads every page on its first visit, so a phone that opens a Published Deck link downloads
only the shell, the sign-in screens and that one page. One stray static import undoes that quietly: the bundler folds
the page into the entry or into a chunk a public page loads, and the build still passes. This script fails in that case.
It checks that
- no lazy page's module is in the entry's static chunk graph, and every lazy page has a chunk of its own;
- no private lazy page, nor any module in EXTRA_PRIVATE_MODULES, is in the static graph of a public page (the lazyPages
  exports that web/src/public/PublicPageView.tsx imports) together with the entry's;
- Vite reports no ineffective dynamic import.

scripts/ci.sh runs it right after ``npm run build``. It builds its own copy into a temporary directory with a manifest
and source maps, because dist/web is the release artifact and must carry neither; the extra build takes about 2 seconds.
The page lists come from lazyPages.ts and PublicPageView.tsx, so adding a page needs no change here.

``python scripts/check_bundle_boundary.py [--out DIR] [--report PATH]``: --out checks an existing build made with
``--manifest --sourcemap`` instead of building; --report writes the result as JSON (ci.sh puts it in the run's artifacts).
Exit code 0 when the boundary holds, 1 otherwise.
"""
import argparse
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
LAZY_PAGES = 'src/shell/lazyPages.ts'  # relative to web/
PUBLIC_VIEW = 'src/public/PublicPageView.tsx'
# Inner modules of private pages that are not lazy pages themselves but must stay out of public graphs: the Trades
# sub-screens, and the owner review screens.
EXTRA_PRIVATE_MODULES = (
    'src/trades/ProposalBuilderPage.tsx',
    'src/trades/TradeScreen.tsx',
    'src/CatalogReview.tsx',
    'src/MetadataReview.tsx',
)
INEFFECTIVE = 'dynamic import will not move module into another chunk'


def lazy_pages(source):
    """{component name: module path relative to web/ without extension, or None} for each lazy component in lazyPages.ts."""
    parts = [part for part in re.split(r'(?m)^(?=export\s)', source) if re.match(r'export const (\w+)\s*=', part)]
    loaders = {}
    for part in parts:
        name, spec = re.match(r'export const (\w+)\s*=', part)[1], re.search(r'\bimport\(\s*"([^"]+)"\s*\)', part)
        if 'lazy(' not in part and spec:
            loaders[name] = spec[1]
    pages = {}
    for part in parts:
        if 'lazy(' not in part:
            continue
        name, spec = re.match(r'export const (\w+)\s*=', part)[1], re.search(r'\bimport\(\s*"([^"]+)"\s*\)', part)
        if spec:
            target = spec[1]
        else:
            loader = re.search(r'\blazy\(\s*\(\)\s*=>\s*(\w+)\(\)', part)
            target = loaders.get(loader[1]) if loader else None
        pages[name] = posixpath.normpath(posixpath.join('src/shell', target)) if target else None
    return pages


def public_page_names(source):
    """The lazyPages exports that PublicPageView.tsx imports."""
    match = re.search(r'import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"\.\./shell/lazyPages"', source)
    return [name.strip() for name in match[1].split(',') if name.strip()] if match else []


def resolve_module(web_root, module):
    for extension in ('.tsx', '.ts'):
        if (Path(web_root) / (module + extension)).is_file():
            return module + extension
    return None


def page_sets(web_root):
    """(public pages, private pages, extra private modules, problems), each sorted, as paths relative to web/."""
    web_root, problems = Path(web_root), []
    pages = lazy_pages((web_root / LAZY_PAGES).read_text())
    modules = {}
    for name, module in pages.items():
        if module is None:
            problems.append(f'{name} in lazyPages.ts has no import path')
        elif (path := resolve_module(web_root, module)) is None:
            problems.append(f'{module} from lazyPages.ts is not a file')
        else:
            modules[name] = path
    public_names = public_page_names((web_root / PUBLIC_VIEW).read_text())
    for name in public_names:
        if name not in pages:
            problems.append(f'{name} imported by PublicPageView.tsx is not a lazy page')
    public = sorted(path for name, path in modules.items() if name in public_names)
    private = sorted(path for name, path in modules.items() if name not in public_names)
    if not public:
        problems.append('no public lazy pages found')
    if not private:
        problems.append('no private lazy pages found')
    for module in EXTRA_PRIVATE_MODULES:
        if not (web_root / module).is_file():
            problems.append(f'{module} in EXTRA_PRIVATE_MODULES is not a file')
    return public, private, sorted(EXTRA_PRIVATE_MODULES), problems


def closure(manifest, key, problems):
    """The manifest keys reached from key through static imports only (dynamicImports are never followed)."""
    seen, stack = [], [key]
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        if current not in manifest:
            problems.append(f'manifest has no record for {current}')
            continue
        seen.append(current)
        stack.extend(reversed(manifest[current].get('imports', [])))
    return seen


def chunk_sources(out, file):
    """The real paths of the modules in one chunk, from its source map, or None when the chunk has no map."""
    path = Path(out) / (file + '.map')
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    map_dir, source_root = (Path(out) / file).parent, data.get('sourceRoot') or ''
    return {os.path.realpath(os.path.normpath(os.path.join(map_dir, source_root, source)))
            for source in data.get('sources', []) if '\x00' not in source}  # Rollup's virtual modules


def check(out, web_root, public, private, extra, build_output=''):
    out, web_root = Path(out), Path(web_root)
    problems = []

    def report(routes=()):
        return {'ok': not problems, 'public_pages': public, 'private_pages': private, 'extra_modules': extra,
                'routes': list(routes), 'problems': problems}

    path = out / '.vite' / 'manifest.json'
    if not path.exists():
        problems.append(f'no Vite manifest in {out}')
        return report()
    manifest = json.loads(path.read_text())
    entries = [key for key, record in manifest.items() if record.get('isEntry')]
    if len(entries) != 1:
        problems.append(f'expected one entry in the manifest, found {len(entries)}')
        return report()
    entry = entries[0]
    for page in public + private:
        if not manifest.get(page, {}).get('isDynamicEntry'):
            problems.append(f'{page} has no chunk of its own; something imports it statically')
    entry_keys = closure(manifest, entry, problems)
    routes = [('entry', entry_keys, public + private + extra)]
    for page in public:
        if page in manifest:
            routes.append((page, entry_keys + [key for key in closure(manifest, page, problems) if key not in entry_keys],
                           private + extra))
    sources, results = {}, []
    for route, keys, forbidden in routes:
        files = [manifest[key]['file'] for key in keys]
        leaks = []
        for file in files:
            if file not in sources:
                sources[file] = chunk_sources(out, file)
            if sources[file] is None:
                problems.append(f'no source map for {file}')
                continue
            for module in forbidden:
                if os.path.realpath(web_root / module) in sources[file]:
                    leaks.append({'module': module, 'chunk': file})
                    problems.append(f'{module} is in {file} on the {route} route')
        results.append({'route': route, 'chunks': len(files), 'leaks': leaks,
                        'bytes': sum((out / file).stat().st_size for file in files if (out / file).exists())})
    for line in build_output.splitlines():
        if INEFFECTIVE in line:
            problems.append(f'Vite reports an ineffective dynamic import: {line.strip()}')
            break
    return report(results)


def build(out):
    """Vite build into out with a manifest and source maps; (exit code, its output)."""
    done = subprocess.run(['node', str(ROOT / 'node_modules/vite/bin/vite.js'), 'build', '--config', 'web/vite.config.ts',
                           '--outDir', str(out), '--emptyOutDir', '--manifest', '--sourcemap', '--logLevel', 'warn'],
                          cwd=ROOT, capture_output=True, text=True)
    return done.returncode, done.stdout + done.stderr


def run(out, build_output):
    public, private, extra, problems = page_sets(ROOT / 'web')
    result = check(out, ROOT / 'web', public, private, extra, build_output)
    result['problems'] = problems + result['problems']
    result['ok'] = not result['problems']
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--out', help='check an existing build made with --manifest --sourcemap instead of building')
    parser.add_argument('--report', help='write the result here as JSON')
    options = parser.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix='tcg-bundle-') as temp:
        if options.out:
            result = run(Path(options.out).resolve(), '')
        else:
            out = Path(temp).resolve() / 'web'
            code, output = build(out)
            if code:
                print('\n'.join(output.splitlines()[-40:]))
                result = {'ok': False, 'public_pages': [], 'private_pages': [], 'extra_modules': [], 'routes': [],
                          'problems': [f'the check build failed (exit {code})']}
            else:
                result = run(out, output)
    lines = []
    if result['public_pages'] or result['private_pages']:
        total = len(result['public_pages']) + len(result['private_pages'])
        lines.append(f"{total} lazy pages, {len(result['public_pages'])} public: {', '.join(result['public_pages'])}; "
                     f"{len(result['extra_modules'])} more private modules")
    lines += [f"{route['route']}: {route['chunks']} chunk(s), {route['bytes']} bytes" for route in result['routes']]
    if result['ok']:
        lines.append('ok')
    else:
        lines += [f'FAILED: {problem}' for problem in result['problems']]
        lines.append('see docs/agents/verification.md, Bundle boundary')
    for line in lines:
        print(f'== bundle boundary: {line}')
    if options.report:
        Path(options.report).write_text(json.dumps(result, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
