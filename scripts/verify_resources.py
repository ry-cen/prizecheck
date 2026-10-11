"""Per-run resources for parallel verification; scripts/ci.sh calls ``verify_resources.py prepare [--pytest] [--stacks]``
after the gate's own database is migrated.

scripts/verify.py creates the databases and reserves the ports and passes them as JSON: VERIFY_PYTEST_DATABASE_URLS
(one database per pytest-xdist worker) and VERIFY_EXTRA_STACKS (database and api/auth/web ports per extra browser
stack). Each database is migrated and initialized exactly like the gate's own, with its own projection directory.
Outputs, all under $VERIFY_WORK:

- ``pytest/gw<i>/env.json``: settings that api/tests/conftest.py applies in pytest-xdist worker gw<i>.
- ``stacks/s<k>/env.sh``: settings ci.sh sources to start stack k (s0 is the gate's own environment).
- ``stacks/stacks.json`` and ``stacks/count``: every stack's settings, for Playwright (web/tests/support/browser-stack.ts).

Without those variables (the release gate runs ci.sh directly) there are no worker databases and only stack 0.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SETUP = ('scripts/migrate.py', 'scripts/init_public_projection.py', 'scripts/backfill_public_catalog.py')
WORKER_KEYS = ('DATABASE_URL', 'PUBLIC_PROJECTION_DIR', 'PRICE_RUNNER_LOCK_DIR', 'CATALOG_PROCESS_FIXTURE_DIR', 'MAIL_FILE')
STACK_KEYS = ('DATABASE_URL', 'API_PORT', 'AUTH_PORT', 'WEB_PORT', 'API_ORIGIN', 'PUBLIC_ORIGIN', 'TEST_ORIGIN', 'TEST_BASE_URL',
              'REVIEW_BROWSER_ORIGIN', 'MAIL_FILE', 'PUBLIC_PROJECTION_DIR', 'CATALOG_PROCESS_FIXTURE_DIR', 'PRICE_RUNNER_LOCK_DIR',
              'VITE_CACHE_DIR')


def private_directories(base):
    """Fresh projection, runner-lock, catalog-fixture and vite-cache directories and an empty mail file under base."""
    for name in ('projection', 'locks', 'catalog-fixture', 'vite-cache'):
        (base / name).mkdir(parents=True)
    (base / 'mail').touch()
    return {'PUBLIC_PROJECTION_DIR': str(base / 'projection'), 'PRICE_RUNNER_LOCK_DIR': str(base / 'locks'),
            'CATALOG_PROCESS_FIXTURE_DIR': str(base / 'catalog-fixture'), 'MAIL_FILE': str(base / 'mail'),
            'VITE_CACHE_DIR': str(base / 'vite-cache')}


def worker_environment(database_url, directories):
    return {'DATABASE_URL': database_url, **{key: directories[key] for key in WORKER_KEYS[1:]}}


def stack_environment(database_url, api_port, auth_port, web_port, directories):
    origin = f'http://localhost:{web_port}'
    return {'DATABASE_URL': database_url, 'API_PORT': str(api_port), 'AUTH_PORT': str(auth_port), 'WEB_PORT': str(web_port),
            'API_ORIGIN': f'http://127.0.0.1:{api_port}', 'PUBLIC_ORIGIN': origin, 'TEST_ORIGIN': origin, 'TEST_BASE_URL': origin,
            'REVIEW_BROWSER_ORIGIN': origin, 'MAIL_FILE': directories['MAIL_FILE'],
            'PUBLIC_PROJECTION_DIR': directories['PUBLIC_PROJECTION_DIR'],
            'CATALOG_PROCESS_FIXTURE_DIR': directories['CATALOG_PROCESS_FIXTURE_DIR'],
            'PRICE_RUNNER_LOCK_DIR': directories['PRICE_RUNNER_LOCK_DIR'], 'VITE_CACHE_DIR': directories['VITE_CACHE_DIR']}


def gate_stack(environ, vite_cache):
    """Stack 0 is the gate's own environment, exactly as ci.sh exported it."""
    api = environ.get('API_PORT', '8000')
    return {'DATABASE_URL': environ['DATABASE_URL'], 'API_PORT': api, 'AUTH_PORT': environ.get('AUTH_PORT', '3001'),
            'WEB_PORT': environ.get('WEB_PORT', '5173'), 'API_ORIGIN': environ.get('API_ORIGIN', f'http://127.0.0.1:{api}'),
            'PUBLIC_ORIGIN': environ['PUBLIC_ORIGIN'], 'TEST_ORIGIN': environ['TEST_ORIGIN'],
            'TEST_BASE_URL': environ['TEST_BASE_URL'], 'REVIEW_BROWSER_ORIGIN': environ['REVIEW_BROWSER_ORIGIN'],
            'MAIL_FILE': environ['MAIL_FILE'], 'PUBLIC_PROJECTION_DIR': environ['PUBLIC_PROJECTION_DIR'],
            'CATALOG_PROCESS_FIXTURE_DIR': environ['CATALOG_PROCESS_FIXTURE_DIR'],
            'PRICE_RUNNER_LOCK_DIR': environ['PRICE_RUNNER_LOCK_DIR'], 'VITE_CACHE_DIR': vite_cache}


def shell_exports(values):
    return ''.join(f'export {key}={shlex.quote(str(value))}\n' for key, value in values.items())


def initialize(values):
    """Migrate one disposable database and initialize its projection directory, as ci.sh does for the gate's own."""
    environment = dict(os.environ, **values)
    for script in SETUP:
        result = subprocess.run([sys.executable, script], cwd=ROOT, env=environment, capture_output=True, text=True)
        if result.returncode != 0:
            database = urlsplit(values['DATABASE_URL']).path.lstrip('/')
            raise RuntimeError(f'{script} failed for {database}:\n{result.stdout}{result.stderr}')


def prepare(work, environ, *, pytest_workers, stacks, setup=initialize):
    work = Path(work)
    pending = []
    if pytest_workers:
        for index, url in enumerate(json.loads(environ.get('VERIFY_PYTEST_DATABASE_URLS') or '[]')):
            base = work / 'pytest' / f'gw{index}'
            values = worker_environment(url, private_directories(base))
            (base / 'env.json').write_text(json.dumps(values))
            pending.append(values)
    if stacks:
        first = work / 'stacks' / 's0'
        (first / 'vite-cache').mkdir(parents=True)
        environments = [gate_stack(environ, str(first / 'vite-cache'))]
        for number, stack in enumerate(json.loads(environ.get('VERIFY_EXTRA_STACKS') or '[]'), start=1):
            directories = private_directories(work / 'stacks' / f's{number}')
            values = stack_environment(stack['database_url'], stack['api_port'], stack['auth_port'], stack['web_port'], directories)
            environments.append(values)
            pending.append(values)
        for number, values in enumerate(environments):
            (work / 'stacks' / f's{number}' / 'env.sh').write_text(shell_exports(values))
        (work / 'stacks' / 'stacks.json').write_text(json.dumps(environments))
        (work / 'stacks' / 'count').write_text(str(len(environments)))
    if pending:
        with ThreadPoolExecutor(max_workers=min(8, len(pending))) as pool:
            list(pool.map(setup, pending))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('prepare')
    command.add_argument('--pytest', action='store_true', help='per-worker databases and settings for pytest-xdist')
    command.add_argument('--stacks', action='store_true', help='per-stack settings for the browser suite')
    args = parser.parse_args(argv)
    prepare(os.environ['VERIFY_WORK'], os.environ, pytest_workers=args.pytest, stacks=args.stacks)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
