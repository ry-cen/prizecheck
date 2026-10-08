"""Disposable sealed runtime fixtures, never CI attestations or deployable receipts.

The historical source comes from this repository's history, not retained /tmp
artifacts. Only this test's temporary store receives synthetic integrity receipts.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
WORK = None
FIXTURE = None


def runtime_fixtures():
    global WORK, FIXTURE
    if FIXTURE:
        return FIXTURE
    WORK = tempfile.TemporaryDirectory(prefix='tcg-runtime-tests-')
    store = Path(WORK.name)/'store'
    store.mkdir(mode=0o700)
    history = Path(os.environ.get('RELEASE_TEST_HISTORY_ROOT', ROOT))
    first = subprocess.check_output(['git', 'rev-parse', '47ff191^{commit}'], cwd=history, text=True).strip()
    second = hashlib.sha256(b'isolated current working-tree runtime fixture').hexdigest()[:40]
    for commit in (first, second):
        target = store/commit
        target.mkdir()
        if commit == first:
            archive = Path(WORK.name)/'baseline.tar'
            archive.write_bytes(subprocess.check_output(['git', 'archive', first], cwd=history))
            with tarfile.open(archive) as source:
                source.extractall(target, filter='data')
        else:
            for name in ('api', 'auth', 'scripts', 'migrations', 'web'):
                shutil.copytree(ROOT/name, target/name, ignore=shutil.ignore_patterns('__pycache__', '.pytest_cache'))
            for name in ('package.json', 'package-lock.json', 'vitest.config.ts'):
                shutil.copy2(ROOT/name, target/name)
        for name in ('.venv', 'node_modules'):
            (target/name).symlink_to((ROOT/name).resolve(), target_is_directory=True)
        subprocess.run(['npm', 'run', 'build'], cwd=target, check=True, stdout=subprocess.DEVNULL)
        for name in ('.venv', 'node_modules'):
            (target/name).unlink()
    # Reuse the actual runtime's integrity algorithm, without pretending to run a CI gate.
    import sys
    sys.path.insert(0, str(ROOT/'scripts'))
    from release import runtime_fingerprint, digest
    fingerprint = runtime_fingerprint(ROOT)
    for commit in (first, second):
        target = store/commit
        files = {str(path.relative_to(target)): digest(path) for path in target.rglob('*') if path.is_file()}
        (target/'release.json').write_text(json.dumps({'gate':'fixed-ci-v2', 'commit':commit,
          'files':files, 'runtime_fingerprint':fingerprint, 'previous_commit':None if commit==first else first,
          'scope':'temporary synthetic runtime test fixture; NOT a CI attestation'}))
    (store/'active').symlink_to(first, target_is_directory=True)
    FIXTURE = store, first, second
    return FIXTURE


def cleanup():
    global WORK, FIXTURE
    if WORK:
        WORK.cleanup()
    WORK = FIXTURE = None
