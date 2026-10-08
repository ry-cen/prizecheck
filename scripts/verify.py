"""Isolated verification; optional Playwright selector arguments after --."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--admin-url', default=os.environ.get('TEST_ADMIN_DATABASE_URL', os.environ.get('DATABASE_URL')))
    parser.add_argument('--suite', choices=('all', 'browser', 'auth', 'operations'), default='all')
    parser.add_argument('browser_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not args.admin_url:
        parser.error('Set TEST_ADMIN_DATABASE_URL or supply --admin-url for a local disposable server')
    options = conninfo_to_dict(args.admin_url)
    if options.get('host') not in ('localhost', '127.0.0.1', '::1') or options.get('hostaddr', '127.0.0.1') not in ('127.0.0.1', '::1'):
        parser.error('Explicit loopback test database required')
    identifier = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4)
    artifacts = ROOT/'.scratch/verification'/identifier
    artifacts.mkdir(parents=True, mode=0o700)
    name = 'tcg_verify_'+secrets.token_hex(8)
    created = False
    result = None
    ports = []
    reservations = []
    try:
        for _ in range(6):
            sock = socket.socket()
            sock.bind(('127.0.0.1', 0))
            reservations.append(sock)
            ports.append(sock.getsockname()[1])
        with tempfile.TemporaryDirectory(prefix='tcg-verify-') as temp:
            checkout = Path(temp)/'checkout'
            checkout.mkdir()
            files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
            for relative in files:
                if not relative or not (ROOT/relative).is_file():
                    continue
                target = checkout/relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT/relative, target)
            for dependency in ('.venv', 'node_modules'):
                (checkout/dependency).symlink_to((ROOT/dependency).resolve(), target_is_directory=True)
            api, auth, web, signup, secondary, unavailable = ports
            env = dict({key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'PLAYWRIGHT_BROWSERS_PATH') if key in os.environ}, DATABASE_URL=make_conninfo(args.admin_url, dbname=name),
              RECOVERY_TEST_DATABASE_URL=args.admin_url, API_PORT=str(api), AUTH_PORT=str(auth), WEB_PORT=str(web),
              API_ORIGIN=f'http://127.0.0.1:{api}', TEST_ORIGIN=f'http://localhost:{web}',
              TEST_SIGNUP_PORT=str(signup), TEST_SECONDARY_AUTH_PORT=str(secondary), TEST_UNAVAILABLE_AUTH_PORT=str(unavailable),
              VERIFY_SUITE=args.suite, TEST_LOG_DIR=str(artifacts), TEST_BROWSER_OUTPUT=str(artifacts/'browser'), RELEASE_TEST_HISTORY_ROOT=str(ROOT))
            # Node pg needs a URI, not libpq's keyword connection format.
            from urllib.parse import urlsplit, urlunsplit
            if urlsplit(args.admin_url).scheme not in ('postgres', 'postgresql'):
                parser.error('Supply a PostgreSQL URI compatible with Python and Node')
            env['DATABASE_URL'] = urlunsplit(urlsplit(args.admin_url)._replace(path='/'+name))
            with psycopg.connect(args.admin_url, autocommit=True) as conn:
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
                created = True
            for sock in reservations:
                sock.close()
            selectors = args.browser_args
            if selectors[:1] == ['--']:
                selectors = selectors[1:]
            with (artifacts/'verification.log').open('w') as log:
                result = subprocess.run(['bash', 'scripts/ci.sh', *selectors], cwd=checkout, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
            (artifacts/'result.json').write_text(json.dumps({'run':identifier, 'exit_code':result, 'ports':ports, 'database_removed':False, 'browser_args':selectors, 'suite':args.suite}))
    finally:
        for sock in reservations:
            sock.close()
        if created:
            with psycopg.connect(args.admin_url, autocommit=True) as conn:
                conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
            if (artifacts/'result.json').exists():
                report = json.loads((artifacts/'result.json').read_text())
                report['database_removed'] = True
                (artifacts/'result.json').write_text(json.dumps(report))
        print(f'Verification artifacts: {artifacts}')
    return result if result is not None else 1


if __name__ == '__main__':
    raise SystemExit(main())
