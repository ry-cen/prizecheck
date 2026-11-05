"""Supported local verification: host admission, physical dependencies, own native PG16 and TMPDIR.

Fresh narrow selections prepare exclusively, release after verified cleanup, then requeue using their evidence.
--prepare stops after collection; --exclusive forces a serial benchmark baseline or an exclusive run.
"""
import json
import os
from pathlib import Path
import signal
import sys

import local_test_db as db
from local_admission import Registry, SIGNALS, reservation, reset_sigchld, supervise
from local_api_selection import eligible, fingerprint, narrow, source_fingerprint
import verify

ROOT = Path(__file__).resolve().parents[1]


def physical_dependencies(root):
    for name in ('.venv', 'node_modules'):
        path = root / name
        if not path.is_dir() or path.is_symlink() or path.resolve() != path:
            raise RuntimeError(f'{name} must be a physical directory owned by this worktree')


def local_environment(root):
    temp = root / '.scratch/tmp'
    temp.mkdir(parents=True, exist_ok=True)
    if temp.resolve() != temp:
        raise RuntimeError('The local TMPDIR must be a physical directory under this worktree')
    env = {k: v for k, v in os.environ.items() if not k.startswith(('GIT_', 'VERIFY_', 'PYTEST_'))
           and k not in ('TEST_ADMIN_DATABASE_URL', 'DATABASE_URL', 'TMP', 'TEMP')}
    return dict(env, TMPDIR=str(temp))


def arguments(argv):
    # Wrapper options only before --; pytest receives its selectors unchanged.
    front, separator, tail = list(argv), [], []
    if '--' in front:
        index = front.index('--')
        front, separator, tail = front[:index], ['--'], front[index + 1:]
    prepare, exclusive = '--prepare' in front, '--exclusive' in front
    front = [v for v in front if v not in ('--prepare', '--exclusive')]
    sentinel = 'postgresql://unused@127.0.0.1/postgres'
    overrides = any(v.startswith('--') and '--admin-url'.startswith(v.split('=', 1)[0]) for v in front)
    if overrides:
        raise ValueError('verify:local always uses its own native PG16; use verify for CI/admin URLs')
    args = verify.parse_arguments(['--admin-url', sentinel, *front, *separator, *tail])
    # Validate parser semantics, including every accepted abbreviation and equals/separate option spelling.
    # Even repeating the sentinel is forbidden: a forwarded CLI URL would override the real generated URL.
    if args.admin_url != sentinel:
        raise ValueError('verify:local always uses its own native PG16; use verify for CI/admin URLs')
    if args.suite == 'api' and (args.pytest_workers not in (1, 2)
                               or not any(v.split('=', 1)[0] == '--pytest-workers' for v in front)):
        raise ValueError('Local API runs require explicit --pytest-workers 1 or 2')
    if prepare and (args.suite != 'api' or not narrow(args.selectors) or args.shard):
        raise ValueError('--prepare needs an unsharded narrow API selection')
    if args.suite == 'browser' and not any(v.split('=', 1)[0] == '--browser-workers' for v in front):
        front += ['--browser-workers', '1']
    return args, [*front, *separator, *tail], prepare, exclusive


def receipt_clean(receipt, token):
    return receipt.get('token') == token and receipt.get('clean') is True


def collection_report(key):
    cache = ROOT / '.scratch/admission/collections'
    certificate = cache / f'{key}.json'
    return json.loads(certificate.read_text()) if key and certificate.exists() else {}


def classified(report):
    return (report.get('version') == 1 and report.get('complete') is True
            and isinstance(report.get('nodeids'), list) and bool(report['nodeids'])
            and isinstance(report.get('serial'), list))


def run_admitted(args, command_args, prepare, mode, key, registry):
    """One complete resource lifetime. Return only after verified cleanup and reservation release, or fail closed."""
    env = local_environment(ROOT)
    cache = ROOT / '.scratch/admission/collections'
    certificate = cache / f'{key}.json'
    candidate = key is not None
    with reservation(registry, ROOT, mode, args.pytest_workers if mode == 'api' else 0) as token:
        # Revalidate after waiting. Never use evidence for a tree edited while queued.
        if candidate and fingerprint(ROOT, command_args) != key:
            registry.remove(token)  # Nothing has been started.
            raise RuntimeError('Source/dependencies changed while queued; rerun to classify the current tree')
        directory = ROOT / '.scratch/admission' / token
        directory.mkdir(parents=True)
        receipt_path = directory / 'cleanup.json'
        registry.update(token, receipt=str(receipt_path), selection=key)
        instance = db.Instance()
        existing = instance.record()
        if existing and (existing['backend'] != 'native' or existing.get('major') != 16):
            registry.remove(token)
            raise RuntimeError('Local admission requires this checkout\'s native PostgreSQL 16 cluster')
        existing_bins = instance.native_bins(existing) if existing else None
        if existing and existing_bins is None:
            registry.remove(token)
            raise RuntimeError('Cannot verify the existing local cluster; restore its native PG16 tools before running')
        if existing and instance.native_running(existing_bins):
            registry.remove(token)
            raise RuntimeError('Checkout server already running; coordinate legacy work and stop it before admission')
        bins = db.native_bin_dir(db.candidate_bin_dirs(), 16)
        if not bins or db.server_major(db.subprocess.run([str(bins / 'postgres'), '--version'],
                                                        capture_output=True, text=True).stdout) != 16:
            registry.remove(token)
            raise RuntimeError('Native PostgreSQL 16 binaries are required')
        # After starting resources, all exceptions conservatively retain ownership.
        instance, record = db.start(db.argparse.Namespace(backend='native', allow_pull=False))
        if candidate and fingerprint(ROOT, command_args) != key:
            raise RuntimeError('Source/dependencies changed during local setup; reservation retained for cleanup audit')
        env.update(TEST_ADMIN_DATABASE_URL=instance.url(record), VERIFY_ADMISSION_MODE=mode,
                   VERIFY_ADMISSION_TOKEN=token, VERIFY_ADMISSION_RECEIPT=str(receipt_path),
                   VERIFY_ADMISSION_SOURCE=source_fingerprint(ROOT),
                   VERIFY_ADMISSION_PREPARE='1' if prepare else '')
        code, empty = supervise([str(ROOT / '.venv/bin/python'), 'scripts/verify.py', *command_args],
                                 registry, token, env=env, cwd=ROOT)
        # Signals cannot skip the PG stop / receipt decision after child cleanup.
        held = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
        try:
            receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
            clean = empty and receipt_clean(receipt, token)
            if clean:
                with db.state_lock():
                    stopped = db.stop_locked() == 0
                clean = stopped and not instance.native_running(instance.native_bins(record))
            if clean:
                if candidate and fingerprint(ROOT, command_args) == key:
                    collected = Path(receipt['artifacts']) / 'admission-collection.json'
                    if collected.exists():
                        cache.mkdir(parents=True, exist_ok=True)
                        certificate.write_text(collected.read_text())
                registry.remove(token)
            else:
                registry.update(token, status='retained', reason='Cleanup receipt, child exit or local PG stop not verified')
                print(f'RETAINED admission: {token}; inspect status and artifacts before recovery', file=sys.stderr)
                code = code or 1
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, held)
        return code


def main(argv=None):
    reset_sigchld()
    args, command_args, prepare, exclusive = arguments(sys.argv[1:] if argv is None else argv)
    physical_dependencies(ROOT)
    candidate = args.suite == 'api' and not args.shard and not args.burn_in and narrow(args.selectors)
    key = fingerprint(ROOT, command_args) if candidate else None
    registry = Registry()
    report = collection_report(key)
    if candidate and not prepare and not exclusive and not classified(report):
        print('Local API selection needs classification; preparing under exclusive admission.', flush=True)
        code = run_admitted(args, command_args, True, 'exclusive', key, registry)
        if code:
            return code
        # run_admitted must have released after the harness receipt and PG shutdown, before another FIFO request.
        if fingerprint(ROOT, command_args) != key:
            raise RuntimeError('Source/dependencies changed after preparation; no tests were started')
        report = collection_report(key)
        if not classified(report):
            raise RuntimeError('Preparation produced no complete classification; no tests were started')
        print('Classification cleaned up and released; requeueing actual tests.', flush=True)
    mode = 'api' if candidate and not prepare and not exclusive and eligible(report) else 'exclusive'
    return run_admitted(args, command_args, prepare, mode, key, registry)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, db.Failure) as error:
        print(f'local verification: {error}', file=sys.stderr)
        raise SystemExit(1)
