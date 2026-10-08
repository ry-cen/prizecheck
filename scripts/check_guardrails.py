"""Deterministic release transport and diagnostic checks; no database required."""
import ast
from pathlib import Path
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


def main():
    failed = False
    for relative in ('scripts/release.py', 'scripts/release_runtime.py'):
        for line, reason in violations((ROOT/relative).read_text(), relative):
            print(f'{relative}:{line}: {reason}')
            failed = True
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
