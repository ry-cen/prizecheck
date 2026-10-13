"""Deterministic release transport, diagnostic, process-scope, test-tier and flake-pattern checks; no database required."""
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


def main():
    failed = False
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
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
