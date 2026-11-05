"""Eligibility evidence, deliberately narrower than the verification runner's selector interface."""
import hashlib
import json
import os
from pathlib import Path
import subprocess


def narrow(selectors):
    """Only explicit test files/node ids and optional -k. Stateful/plugin/config selectors stay exclusive."""
    paths = 0
    index = 0
    while index < len(selectors):
        value = selectors[index]
        if value == '-k' and index + 1 < len(selectors):
            index += 2
            continue
        path = value.split('::', 1)[0]
        if not path.startswith('api/tests/test_') or not path.endswith('.py') or '..' in Path(path).parts:
            return False
        paths += 1
        index += 1
    return paths > 0


def source_fingerprint(root, files=None):
    root = Path(root)
    if files is None:
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
                                        cwd=root, env=env).decode().split('\0')
    digest = hashlib.sha256()
    for relative in sorted(set(files) - {''}):
        path = root / relative
        if path.is_file():
            digest.update(relative.encode() + b'\0' + path.read_bytes())
    return digest.hexdigest()


def fingerprint(root, arguments):
    """Hash copied source bytes and installed dependency metadata. Never share certificates between worktrees.

    Dependencies must be immutable during verification. Stat metadata includes installed files, so normal installs
    invalidate evidence; this is a cooperating workflow, not protection against deliberately forged files/stamps.
    """
    root = Path(root).resolve()
    digest = hashlib.sha256(json.dumps([str(root), arguments], sort_keys=True).encode())
    digest.update(source_fingerprint(root).encode())
    for dependency in ('.venv', 'node_modules'):
        for path in sorted((root / dependency).rglob('*')):
            if '__pycache__' in path.parts or any(p.startswith('.vite') or p == '.cache' for p in path.parts):
                continue
            if path.is_file():
                stat = path.stat()
                digest.update(str(path.relative_to(root)).encode())
                digest.update(str((stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)).encode())
    return digest.hexdigest()


def eligible(report):
    return (report.get('version') == 1 and report.get('complete') is True
            and isinstance(report.get('nodeids'), list) and len(report['nodeids']) > 0
            and report.get('serial') == [])
