"""Deterministic release transport, diagnostic, process-scope, test-tier, flake-pattern and colour-token checks; no database required."""
import ast
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]


def violations(source, filename):
    tree = ast.parse(source, filename)
    found = []
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for item in node.names:
                if item.asname:
                    aliases[item.asname] = item.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for item in node.names:
                aliases[item.asname or item.name] = node.module + '.' + item.name
    external_errors = {node.name for node in ast.walk(tree) if isinstance(node, ast.ExceptHandler) and node.name}

    def canonical(name):
        first, *tail = name.split('.')
        return '.'.join([aliases.get(first, first), *tail])

    def visit(node, function='', safe_error=frozenset()):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            function = node.name
        if isinstance(node, ast.If):
            approved = isinstance(node.test, ast.Call) and ast.unparse(node.test.func) == 'isinstance' and len(node.test.args) == 2 and isinstance(node.test.args[0], ast.Name) and ast.unparse(node.test.args[1]) == 'ReleaseError'
            for child in node.body:
                visit(child, function, safe_error | ({node.test.args[0].id} if approved else set()))
            for child in node.orelse:
                visit(child, function, safe_error)
            return
        if isinstance(node, ast.Call):
            name = canonical(ast.unparse(node.func))
            if name in ('urllib.request.urlopen', 'urllib.request.build_opener') and not (Path(filename).name == 'release.py' and function == 'direct_http_open'):
                found.append((node.lineno, 'Use direct_http_open for private release HTTP'))
            if name == 'ReleaseError' and (not node.args or not isinstance(node.args[0], ast.Constant) or not isinstance(node.args[0].value, str)):
                found.append((node.lineno, 'ReleaseError diagnostics must be fixed strings'))
            if name == 'print' and any(isinstance(value, ast.Name) and value.id in external_errors - safe_error for arg in node.args for value in ast.walk(arg)):
                found.append((node.lineno, 'Use fixed diagnostics for external exceptions'))
        for child in ast.iter_child_nodes(node):
            visit(child, function, safe_error)

    visit(tree)
    if filename.endswith('release.py'):
        helpers = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'direct_http_open']
        if not helpers or 'urllib.request.ProxyHandler({})' not in ast.unparse(helpers[0]) or 'NoRedirect()' not in ast.unparse(helpers[0]):
            found.append((1, 'Private HTTP helper must disable proxies and redirects'))
    return found


PROCESS_SEARCH = re.compile(r'\b(pkill|pgrep|killall)\b')
PROCESS_SCOPE = ('api/tests', 'auth/tests', 'web/tests', 'tests/operations', 'scripts/ci.sh', 'scripts/verify.py',
                 'scripts/run_pytest.py', 'scripts/run_playwright.py', 'scripts/verify_resources.py', 'scripts/verify_report.py',
                 'scripts/verify_reaper.py')
TIER_CATEGORIES = ('process', 'wall-clock', 'capacity', 'sleep')


def process_search_violations(source):
    """Tests and the verification harness stop only the processes they started: no host-wide process search."""
    return [(number, 'Stop only processes the test started; never pkill, pgrep or killall')
            for number, line in enumerate(source.splitlines(), 1) if PROCESS_SEARCH.search(line)]


def tier_violations(source, filename):
    """A test with a `proc` parameter launches real runners: it is marked serial and slow. A slow mark's reason starts
    with its category (process, wall-clock, capacity or sleep); a serial mark has a reason."""
    found = []
    for node in ast.walk(ast.parse(source, filename)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or not node.name.startswith('test_'):
            continue
        marks = {}
        for decorator in node.decorator_list:
            call = decorator if isinstance(decorator, ast.Call) else None
            name = ast.unparse(call.func if call else decorator)
            if name not in ('pytest.mark.slow', 'pytest.mark.serial'):
                continue
            reasons = [keyword.value.value for keyword in (call.keywords if call else [])
                       if keyword.arg == 'reason' and isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str)]
            marks[name.rsplit('.', 1)[1]] = reasons[0] if reasons else ''
        if 'slow' in marks and marks['slow'].split(':', 1)[0] not in TIER_CATEGORIES:
            found.append((node.lineno, f'{node.name}: pytest.mark.slow needs reason="<process|wall-clock|capacity|sleep>: why"'))
        if 'serial' in marks and not marks['serial'].strip():
            found.append((node.lineno, f'{node.name}: pytest.mark.serial needs a reason'))
        if any(argument.arg == 'proc' for argument in node.args.args) and not {'slow', 'serial'} <= marks.keys():
            found.append((node.lineno, f'{node.name}: a test that launches real runners (proc) must be marked serial and slow'))
    return found


# Flake-prone test patterns (docs/agents/verification.md). A flagged line may carry an exemption in the block of //
# comment lines directly above it: `// flake-exempt <rule> (<category>): why`, with a category the rule accepts and a
# reason of at least three words. touch-target takes no exemption.
FLAKE_SCOPE = ('web/tests', 'auth/tests')
FLAKE_EXEMPTIONS = {'wait-for-timeout': ('quiet',), 'one-shot-read': ('invariant',), 'counted-wait': ('retry',)}
FLAKE_EXEMPTION = re.compile(r'^\s*//\s*flake-exempt\s+(?P<rule>[a-z-]+)\s+\((?P<category>[a-z-]+)\):\s*(?P<why>.*\S)\s*$')
WAIT_FOR_TIMEOUT = re.compile(r'\.waitForTimeout\(')
# expect(await <locator chain>.<read>()): one read of state the page can still change, where a retrying assertion waits.
ONE_SHOT_READ = re.compile(
    r'\bexpect(?:\.soft)?\(\s*await\s+(?:[^;()]|\((?:[^()]|\([^()]*\))*\))*?'
    r'\.(?:isVisible|isHidden|isEnabled|isDisabled|isChecked|isEditable|textContent|innerText|innerHTML|inputValue'
    r'|count|getAttribute|boundingBox|allTextContents|allInnerTexts)\(')
COUNTED_LOOP = re.compile(r'\bfor\s*\(\s*let\s+(\w+)\s*=\s*0\s*;\s*\1\s*<[^;]*;\s*\1\s*(?:\+\+|\+=\s*1)\s*\)')
LOOP_SLEEP = re.compile(r'\bsleep\(|\bsetTimeout\(|\.waitForTimeout\(')
# Workspace specs sign in as the stack's one owner; each test starts as a new owner (web/tests/support/owner.ts).
WORKSPACE_SPEC = re.compile(r'web/tests/workspace-[^/]+\.spec\.ts')
WORKSPACE_SIGN_IN = re.compile(r'\basync function signIn\(')
TOUCH_TARGET_SIZE = re.compile(r'\.toBeGreaterThan(?:OrEqual)?\(\s*4[34](?:\.\d+)?\s*\)')


def loop_body(source, start):
    """The statement after a for(...) header at `start`: a balanced {...} block, or a single statement up to its ;."""
    index = start
    while index < len(source) and source[index].isspace():
        index += 1
    depth = 0
    for end in range(index, len(source)):
        character = source[end]
        if character in '([{':
            depth += 1
        elif character in ')]}':
            depth -= 1
            if depth == 0 and source[index] == '{':
                return source[index:end + 1]
        elif character == ';' and depth == 0 and source[index] != '{':
            return source[index:end + 1]
    return source[index:]


def flake_exemption(lines, number, rule):
    """(exempt, problem) for line `number` (1-based): a flake-exempt line for `rule` in the // comment block directly
    above it, and what is wrong with it if anything."""
    index = number - 2
    while index >= 0 and lines[index].lstrip().startswith('//'):
        match = FLAKE_EXEMPTION.match(lines[index])
        if match and match['rule'] == rule:
            categories = FLAKE_EXEMPTIONS[rule]
            if match['category'] not in categories:
                return True, f'flake-exempt {rule} takes ({"|".join(categories)}), not ({match["category"]})'
            if len(match['why'].split()) < 3:
                return True, f'flake-exempt {rule} needs a reason of at least three words'
            return True, None
        index -= 1
    return False, None


def flake_violations(source, filename):
    """Flake-prone patterns in a TypeScript test file under web/tests or auth/tests: fixed sleeps and one-shot reads
    of browser state where a retrying assertion waits, 44 px checks outside expectTouchTarget, a workspace spec whose
    signIn reuses the owner earlier tests filled, and counted loops that sleep where a wait should run to a deadline."""
    lines = source.splitlines()
    found = []

    def check(offset, rule, reason):
        line_start = source.rfind('\n', 0, offset) + 1
        if '//' in source[line_start:offset]:  # a mention in a comment
            return
        number = source.count('\n', 0, offset) + 1
        exempt, problem = flake_exemption(lines, number, rule) if rule in FLAKE_EXEMPTIONS else (False, None)
        if problem or not exempt:
            found.append((number, problem or reason))

    if filename.startswith('web/tests/'):
        for match in WAIT_FOR_TIMEOUT.finditer(source):
            check(match.start(), 'wait-for-timeout', 'Wait for a state with a retrying assertion, not page.waitForTimeout; a quiet '
                  'period before a negative check takes // flake-exempt wait-for-timeout (quiet): why')
        for match in ONE_SHOT_READ.finditer(source):
            check(match.start(), 'one-shot-read', 'Assert browser state with a retrying assertion (await expect(locator)...), '
                  'not expect(await locator.<read>()); a sample of an invariant takes // flake-exempt one-shot-read (invariant): why')
        if filename != 'web/tests/support/touch-target.ts':
            for match in TOUCH_TARGET_SIZE.finditer(source):
                check(match.start(), 'touch-target', 'Check 44 px touch targets with expectTouchTarget (web/tests/support/touch-target.ts)')
        sign_in = WORKSPACE_SIGN_IN.search(source)
        # A call in a // comment does not count. signIn is matched in its function form, which every spec uses.
        if WORKSPACE_SPEC.fullmatch(filename) and sign_in and not re.search(r'^(?!\s*//).*startAsNewOwner\(', source, re.M):
            check(sign_in.start(), 'fresh-owner', 'A workspace spec\'s signIn calls startAsNewOwner (web/tests/support/owner.ts), '
                  'so each test starts with an empty Location tree')
    if filename.startswith('auth/tests/'):
        for match in COUNTED_LOOP.finditer(source):
            if LOOP_SLEEP.search(loop_body(source, match.end())):
                check(match.start(), 'counted-wait', 'Wait to a deadline (waitForServer, serverReady or dropDatabase in '
                      'auth/tests/support/servers.ts, or expect.poll), not a counted loop that sleeps')
    return found


def flake_scope_files():
    for entry in FLAKE_SCOPE:
        yield from sorted((ROOT/entry).rglob('*.ts'))


FAKE_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']""")
FAKE_SPECIFIER = re.compile(r'(^|/)testing(/|$)|oauth-fake')


def oauth_fake_import_violations(source):
    """Shipped auth source (auth/src) never loads the OAuth test fake (auth/testing/): no import, re-export, dynamic
    import or require of it, and no mention of its consent path."""
    found = []
    for number, line in enumerate(source.splitlines(), 1):
        if any(FAKE_SPECIFIER.search(specifier) for specifier in FAKE_IMPORT.findall(line)):
            found.append((number, 'Shipped auth source must not import the OAuth test fake (auth/testing/)'))
        elif '__fake-oauth' in line:
            found.append((number, 'Shipped auth source must not mention the OAuth test fake'))
    return found


# The ONNX runtime enters the web build through one module, so the bundle-boundary check has one place to guard
# (ADR 0017, resolution D13). Subpath imports ("onnxruntime-web/wasm") and dynamic imports count.
ORT_MODULE = 'web/src/scanner/worker/ort.ts'
ORT_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']onnxruntime-web(?:/[^"']*)?["']""")


def onnxruntime_import_violations(source, filename):
    """`onnxruntime-web` is imported only in web/src/scanner/worker/ort.ts."""
    if filename == ORT_MODULE:
        return []
    return [(number, f'Import onnxruntime-web only in {ORT_MODULE}')
            for number, line in enumerate(source.splitlines(), 1)
            if ORT_IMPORT.search(line) and not line.lstrip().startswith(('//', '*', '/*'))]


# Card art (ADR 0020, #354, #360): a Printing's art comes from one place, the `catalog_printing_art` view, and the
# signed-in app shows it through the art route. TCGdex's `/low.webp` and `/high.webp` file names are built only by the
# art-URL module (`api/app/games/pokemon/art/urls.py`, the scanner's TCGdex-only rule) and the scanner's own query; the web build
# never spells them, so a client cannot derive a size by editing an address.
WEBP_SUFFIX = re.compile(r'/(?:low|high)\.webp')
WEBP_SUFFIX_MODULES = ('api/app/games/pokemon/scanner/scanner.py', 'api/app/games/pokemon/art/urls.py')


def webp_suffix_violations(source, filename):
    """No `/low.webp` or `/high.webp` outside the modules that own the TCGdex file names."""
    if filename in WEBP_SUFFIX_MODULES:
        return []
    return [(number, 'Build card art addresses through the art route (api/app/games/pokemon/art/urls.py, catalog_printing_art), '
                     'not with a /low.webp or /high.webp suffix')
            for number, line in enumerate(source.splitlines(), 1)
            if WEBP_SUFFIX.search(line) and not line.lstrip().startswith(('#', '//', '*', '/*'))]


def art_source_files():
    yield from sorted((ROOT/'api/app').rglob('*.py'))
    yield from web_source_files()


def web_source_files():
    for suffix in ('*.ts', '*.tsx'):
        yield from sorted((ROOT/'web/src').rglob(suffix))


def dockerignore_violations(text):
    """The OAuth test fake never enters an image build context."""
    lines = {line.strip() for line in text.splitlines()}
    return [] if 'auth/testing/' in lines else [(1, 'List auth/testing/ in .dockerignore so the OAuth test fake never enters an image')]


def process_scope_files():
    for entry in PROCESS_SCOPE:
        path = ROOT/entry
        if path.is_file():
            yield path
        elif path.is_dir():
            yield from sorted(item for item in path.rglob('*') if item.is_file() and item.suffix in ('.py', '.ts', '.sh'))


# Tailwind arbitrary values (bg-[...], hover:text-[...]) and arbitrary properties ([color:...], md:[background:...]).
# Colours come only from the token roles (ADR 0012), so neither may spell a colour itself.
ARBITRARY_VALUE = re.compile(r'(?<=[a-z0-9])-\[([^\[\]\s]+)\]')
ARBITRARY_PROPERTY = re.compile(r'(?:^|(?<=[\s"\'`:!{(]))\[([a-z-]+:[^\[\]\s]+)\]')
HEX_COLOUR = re.compile(r'#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z-])')
COLOUR_FUNCTION = re.compile(r'(?<![A-Za-z0-9-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(', re.IGNORECASE)
NON_COLOUR_TEXT = re.compile(r'url\([^)]*\)|\'[^\']*\'|"[^"]*"')
ARBITRARY_VARIABLE = re.compile(r'(?<=[a-z0-9])-\((--[^\s()]+(?:\([^()]*\))?[^\s()]*)\)')
CSS_NAMED_COLOURS = frozenset("""
aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood
cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred
midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue
slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white
whitesmoke yellow yellowgreen
""".split())
COLOUR_SCOPE = ('web/index.html', 'web/src')


def literal_colour(value):
    """True when an arbitrary value spells a colour (hex, colour function or CSS colour name) instead of reading a
    token variable such as var(--color-bg)."""
    value = NON_COLOUR_TEXT.sub('', value)
    if HEX_COLOUR.search(value) or COLOUR_FUNCTION.search(value):
        return True
    bare = value.split(':', 1)[1] if value.lower().startswith('color:') else value
    return any(part.lower() in CSS_NAMED_COLOURS for part in re.split(r'[_,()/\s]+', bare))


def arbitrary_colour_violations(source):
    """Classes and @apply lines take colours from the token roles (bg-surface, text-text-muted), never from an
    arbitrary value such as bg-[#123], text-[rgb(0_0_0)], shadow-[0_0_0_1px_black], [color:red] or a
    literal fallback in the variable shorthand, bg-(--x,#123)."""
    found = []
    for number, line in enumerate(source.splitlines(), 1):
        values = [match.group(1) for match in ARBITRARY_VALUE.finditer(line)]
        values += [match.group(1).split(':', 1)[1] for match in ARBITRARY_PROPERTY.finditer(line)]
        values += [match.group(1).split(',', 1)[1] for match in ARBITRARY_VARIABLE.finditer(line) if ',' in match.group(1)]
        if any(literal_colour(value) for value in values):
            found.append((number, 'Use a token colour role such as bg-surface or text-text-muted; '
                                  'arbitrary colour values like bg-[#123] are banned'))
    return found


# Scrolling regions (#399): the browser's scroll bar is hidden on desktop, so a region that scrolls must be a
# ScrollArea (web/src/ui/ScrollArea.tsx, the one file that sets overflow-auto itself) or carry an
# OverlayScrollbarFor, which draws the replacement bar. An overflow-auto/-scroll class elsewhere makes a region
# with no visible bar.
SCROLL_CLASS = re.compile(r'(?<![\w-])overflow-(?:[xy]-)?(?:auto|scroll)(?![\w-])')
SCROLL_AREA_MODULE = 'web/src/ui/ScrollArea.tsx'
# Files that may name the class, each with why. A native <pre> or <textarea> that styles itself from a parent's
# class list can scroll by itself, with OverlayScrollbarFor drawing its bar.
SCROLL_CLASS_ALLOWED = {
    'web/src/decks/ExportDialog.tsx': 'the export <pre> and <textarea> scroll themselves; ExportOutput gives them an OverlayScrollbarFor',
}


def scroll_class_violations(source, filename):
    """Lines that set overflow-auto, overflow-scroll or their -x/-y forms outside ScrollArea and the allowlist."""
    if filename == SCROLL_AREA_MODULE or filename in SCROLL_CLASS_ALLOWED:
        return []
    return [(number, 'Scroll inside a ScrollArea (web/src/ui/ScrollArea.tsx), not with an overflow-auto class: the browser '
                     'scroll bar is hidden on desktop and ScrollArea draws the replacement')
            for number, line in enumerate(source.splitlines(), 1) if SCROLL_CLASS.search(line)]


# A bare <textarea> scrolls with no overlay bar (its browser bar is hidden on desktop). The kit's TextArea
# (web/src/ui/TextField.tsx) draws one, and so does ExportOutput's read-only copy of an export.
BARE_TEXTAREA = re.compile(r'<textarea\b')
TEXTAREA_ALLOWED = ('web/src/ui/TextField.tsx', 'web/src/ExportOutput.tsx')


def bare_textarea_violations(source, filename):
    """Lines that open a <textarea> outside the two modules that pair it with an OverlayScrollbarFor."""
    if filename in TEXTAREA_ALLOWED:
        return []
    return [(number, 'Use the kit TextArea (web/src/ui/TextField.tsx): a bare <textarea> has no overlay scroll bar')
            for number, line in enumerate(source.splitlines(), 1) if BARE_TEXTAREA.search(line)]


def colour_scope_files():
    for entry in COLOUR_SCOPE:
        path = ROOT/entry
        if path.is_file():
            yield path
        elif path.is_dir():
            yield from sorted(item for item in path.rglob('*') if item.is_file() and item.suffix in ('.ts', '.tsx', '.css', '.html'))


def set_code_migration_violations(migrations, tsv_text):
    """``migrations`` maps file name to text. The newest migration that opens with a set_codes.tsv digest line must carry
    the digest of the TSV as it is now, or the TSV changed without its migration."""
    import hashlib
    for name in sorted(migrations, reverse=True):
        found = re.match(r'-- set_codes\.tsv digest: ([0-9a-f]{16})(?:\n|$)', migrations[name])
        if found:
            if found.group(1) == hashlib.sha256(tsv_text.encode()).hexdigest()[:16]:
                return []
            return [(name, 'FAILED: set_codes.tsv changed; run scripts/set_code_migration.py <next number>')]
    return [('migrations', 'FAILED: no migration carries a set_codes.tsv digest; run scripts/set_code_migration.py <next number>')]


def main():
    failed = False
    migrations = {path.name: path.read_text() for path in (ROOT/'migrations').glob('*.sql')}
    for name, reason in set_code_migration_violations(migrations, (ROOT/'api/app/games/pokemon/catalog/set_codes.tsv').read_text(encoding='utf-8')):
        print(f'{name}: {reason}')
        failed = True
    for relative in ('scripts/release.py', 'scripts/release_runtime.py'):
        for line, reason in violations((ROOT/relative).read_text(), relative):
            print(f'{relative}:{line}: {reason}')
            failed = True
    for path in process_scope_files():
        relative = path.relative_to(ROOT).as_posix()
        for line, reason in process_search_violations(path.read_text()):
            print(f'{relative}:{line}: {reason}')
            failed = True
    for path in sorted((ROOT/'auth/src').rglob('*.ts')):
        relative = path.relative_to(ROOT).as_posix()
        for line, reason in oauth_fake_import_violations(path.read_text()):
            print(f'{relative}:{line}: {reason}')
            failed = True
    for path in web_source_files():
        relative = path.relative_to(ROOT).as_posix()
        for line, reason in onnxruntime_import_violations(path.read_text(), relative):
            print(f'{relative}:{line}: {reason}')
            failed = True
    for path in art_source_files():
        relative = path.relative_to(ROOT).as_posix()
        for line, reason in webp_suffix_violations(path.read_text(), relative):
            print(f'{relative}:{line}: {reason}')
            failed = True
    for line, reason in dockerignore_violations((ROOT/'.dockerignore').read_text()):
        print(f'.dockerignore:{line}: {reason}')
        failed = True
    for path in sorted((ROOT/'api/tests').glob('test_*.py')):
        relative = path.relative_to(ROOT).as_posix()
        for line, reason in tier_violations(path.read_text(), relative):
            print(f'{relative}:{line}: {reason}')
            failed = True
    for path in flake_scope_files():
        relative = path.relative_to(ROOT).as_posix()
        for line, reason in flake_violations(path.read_text(), relative):
            print(f'{relative}:{line}: {reason}')
            failed = True
    for path in colour_scope_files():
        relative = path.relative_to(ROOT).as_posix()
        for line, reason in arbitrary_colour_violations(path.read_text()):
            print(f'{relative}:{line}: {reason}')
            failed = True
    for path in web_source_files():
        relative = path.relative_to(ROOT).as_posix()
        for line, reason in scroll_class_violations(path.read_text(), relative):
            print(f'{relative}:{line}: {reason}')
            failed = True
        for line, reason in bare_textarea_violations(path.read_text(), relative):
            print(f'{relative}:{line}: {reason}')
            failed = True
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
