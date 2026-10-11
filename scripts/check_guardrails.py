"""Deterministic release transport, diagnostic, process-scope and test-tier checks; no database required."""
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
    for path in sorted((ROOT/'api/tests').glob('test_*.py')):
        relative = path.relative_to(ROOT).as_posix()
        for line, reason in tier_violations(path.read_text(), relative):
            print(f'{relative}:{line}: {reason}')
            failed = True
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
