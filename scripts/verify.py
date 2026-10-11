"""Isolated verification. Optional selectors after --: pytest arguments with --suite api, Playwright with --suite browser."""
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
import time
from urllib.parse import urlsplit, urlunsplit

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

from verify_reaper import create_databases, current_owner, reap
from verify_report import summarize

ROOT = Path(__file__).resolve().parents[1]
SUITES = ('all', 'api', 'browser', 'auth', 'operations')


def default_workers():
    """(pytest workers, browser stacks) for this host: 6 and 4 on 12 cores, 2 and 2 on a 4-core CI runner."""
    cores = os.cpu_count() or 2
    return min(6, max(2, cores // 2)), min(4, max(2, cores // 3))


def parse_arguments(argv=None):
    pytest_workers, browser_workers = default_workers()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--admin-url', default=os.environ.get('TEST_ADMIN_DATABASE_URL', os.environ.get('DATABASE_URL')))
    parser.add_argument('--suite', choices=SUITES, default='all')
    parser.add_argument('--fast', action='store_true', help='leave out pytest and vitest tests marked slow, Playwright tests tagged @slow, and the operations suite')
    parser.add_argument('--pytest-workers', type=int, default=pytest_workers, help='pytest-xdist workers, one database each')
    parser.add_argument('--browser-workers', type=int, default=browser_workers, help='Playwright workers, one stack each')
    parser.add_argument('selectors', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.selectors[:1] == ['--']:
        args.selectors = args.selectors[1:]
    if args.selectors and args.suite not in ('api', 'browser'):
        parser.error('Selectors after -- need --suite api or --suite browser')
    if args.pytest_workers < 1 or args.browser_workers < 1:
        parser.error('Worker counts must be at least 1')
    if not args.admin_url:
        parser.error('Set TEST_ADMIN_DATABASE_URL or supply --admin-url for a local disposable server')
    options = conninfo_to_dict(args.admin_url)
    if options.get('host') not in ('localhost', '127.0.0.1', '::1') or options.get('hostaddr', '127.0.0.1') not in ('127.0.0.1', '::1'):
        parser.error('Explicit loopback test database required')
    # Node pg needs a URI, not libpq's keyword connection format.
    if urlsplit(args.admin_url).scheme not in ('postgres', 'postgresql'):
        parser.error('Supply a PostgreSQL URI compatible with Python and Node')
    return args


def effective_workers(suite, pytest_workers, browser_workers):
    """Only the suites that run pytest or Playwright get extra databases and stacks."""
    return (pytest_workers if suite in ('all', 'api') else 1), (browser_workers if suite in ('all', 'browser') else 1)


def runs_operations(suite, fast):
    """The operations (release and recovery) suite runs in the full gate and in --suite operations, not under --fast."""
    return suite == 'operations' or (suite == 'all' and not fast)


def database_names(name, pytest_workers, browser_workers):
    """The run's own database, one per pytest-xdist worker when parallel, and one per extra browser stack."""
    workers = [f'{name}_gw{index}' for index in range(pytest_workers)] if pytest_workers > 1 else []
    return [name, *workers, *(f'{name}_s{number}' for number in range(1, browser_workers))]


def port_count(browser_workers):
    """Six ports for the gate's own stack and auth tests, three (api, auth, web) per extra browser stack."""
    return 6 + 3 * (browser_workers - 1)


def database_url(admin_url, name):
    return urlunsplit(urlsplit(admin_url)._replace(path='/' + name))


SUSPEND_LIMIT_S = 5.0     # wall time beyond the monotonic clock: the host slept (both clocks stop counting together otherwise)
SKEW_LIMIT_S = 2.0        # PostgreSQL's clock against this host's; approval-code expiry compares the two


def database_skew(admin_url):
    """Seconds by which the database server's clock is ahead of this host's (negative when it lags), or None."""
    try:
        with psycopg.connect(admin_url, autocommit=True, connect_timeout=5) as conn:
            before = time.time()
            server = conn.execute('SELECT extract(epoch FROM clock_timestamp())').fetchone()[0]
            after = time.time()
        return round(float(server) - (before + after) / 2, 3)
    except psycopg.Error:
        return None


def clock_warnings(suspended, skews):
    """Lines that say this run's timing and expiry failures are not evidence: the host slept, or the database clock
    disagreed with the host's (Docker's VM clock lags after the host sleeps and catches up later)."""
    lines = []
    if suspended > SUSPEND_LIMIT_S:
        lines.append(f'the host was suspended for about {suspended:.0f} s during this run')
    for when, skew in skews.items():
        if skew is not None and abs(skew) > SKEW_LIMIT_S:
            lines.append(f'the database clock was {skew:+.1f} s off the host clock at the {when} of this run')
    return lines


def gate_command(selectors):
    """ci.sh, kept from idle sleep where the host offers caffeinate (macOS). A closed lid on battery still sleeps."""
    command = ['bash', 'scripts/ci.sh', *selectors]
    return ['caffeinate', '-i', *command] if shutil.which('caffeinate') else command


def drop_databases(admin_url, name, created):
    """Drop the run's databases and anything else left under its name."""
    with psycopg.connect(admin_url, autocommit=True) as conn:
        leftovers = [row[0] for row in conn.execute('SELECT datname FROM pg_database WHERE starts_with(datname, %s)', (name + '_',))]
        for database in dict.fromkeys([*created, *leftovers]):
            conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(database)))


def main(argv=None):
    args = parse_arguments(argv)
    pytest_workers, browser_workers = effective_workers(args.suite, args.pytest_workers, args.browser_workers)
    identifier = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4)
    artifacts = ROOT/'.scratch/verification'/identifier
    artifacts.mkdir(parents=True, mode=0o700)
    # Printed first, so a run that is stopped early still names its own directory (scripts/verify_discard.py).
    print(f'Verification run: {identifier}', flush=True)
    name = 'tcg_verify_'+secrets.token_hex(8)
    names = database_names(name, pytest_workers, browser_workers)
    created = []
    result = None
    ports = []
    reservations = []
    try:
        # Before this run creates anything: drop the databases of verification runs that were killed (scripts/verify_reaper.py).
        try:
            reaper, reaped = reap(args.admin_url)
        except Exception as error:
            reaper, reaped = [f'== reaper: skipped: reaper error ({type(error).__name__})'], []
        for line in reaper:
            print(line, flush=True)
        (artifacts/'verification.log').write_text(''.join(line + '\n' for line in reaper))
        for _ in range(port_count(browser_workers)):
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
            api, auth, web, signup, secondary, unavailable = ports[:6]
            extra = ports[6:]
            stacks = [{'database_url': database_url(args.admin_url, f'{name}_s{number}'), 'api_port': extra[3*number-3],
                       'auth_port': extra[3*number-2], 'web_port': extra[3*number-1]} for number in range(1, browser_workers)]
            workers = [database_url(args.admin_url, database) for database in names if database.startswith(name+'_gw')]
            env = dict({key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'PLAYWRIGHT_BROWSERS_PATH') if key in os.environ},
              DATABASE_URL=database_url(args.admin_url, name), RECOVERY_TEST_DATABASE_URL=args.admin_url,
              API_PORT=str(api), AUTH_PORT=str(auth), WEB_PORT=str(web),
              API_ORIGIN=f'http://127.0.0.1:{api}', TEST_ORIGIN=f'http://localhost:{web}',
              TEST_SIGNUP_PORT=str(signup), TEST_SECONDARY_AUTH_PORT=str(secondary), TEST_UNAVAILABLE_AUTH_PORT=str(unavailable),
              VERIFY_SUITE=args.suite, VERIFY_FAST='1' if args.fast else '',
              VERIFY_OPERATIONS='1' if runs_operations(args.suite, args.fast) else '0',
              VERIFY_PYTEST_DATABASE_URLS=json.dumps(workers), VERIFY_EXTRA_STACKS=json.dumps(stacks),
              TEST_LOG_DIR=str(artifacts), TEST_BROWSER_OUTPUT=str(artifacts/'browser'), RELEASE_TEST_HISTORY_ROOT=str(ROOT))
            with psycopg.connect(args.admin_url, autocommit=True) as conn:
                create_databases(conn, names, current_owner(identifier), created)
            for sock in reservations:
                sock.close()
            skews = {'start': database_skew(args.admin_url)}
            wall, steady = time.time(), time.monotonic()
            with (artifacts/'verification.log').open('a') as log:
                result = subprocess.run(gate_command(args.selectors), cwd=checkout, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
            suspended = round(max(0.0, (time.time() - wall) - (time.monotonic() - steady)), 1)
            skews['end'] = database_skew(args.admin_url)
            warnings = clock_warnings(suspended, skews)
            if warnings:
                with (artifacts/'verification.log').open('a') as log:
                    log.write('\n'.join(f'== WARNING: {line}; wall-clock and expiry failures in this run are not evidence. '
                                         'Keep the host awake and rerun.' for line in warnings) + '\n')
            try:
                timings = summarize(artifacts)
            except Exception as error:  # A broken report never changes the gate's result.
                timings = {'error': type(error).__name__}
            (artifacts/'result.json').write_text(json.dumps({
                'run': identifier, 'exit_code': result, 'suite': args.suite, 'selectors': args.selectors,
                'browser_args': args.selectors if args.suite == 'browser' else [], 'fast': args.fast,
                'pytest_workers': pytest_workers, 'browser_workers': browser_workers, 'ports': ports, 'databases': names,
                'database_removed': False, 'reaper': reaper, 'reaped_databases': reaped, 'timings': timings,
                'host_suspended_seconds': suspended,
                'database_clock_skew_seconds': skews, 'clock_warnings': warnings}))
    finally:
        for sock in reservations:
            sock.close()
        if created:
            drop_databases(args.admin_url, name, created)
            if (artifacts/'result.json').exists():
                report = json.loads((artifacts/'result.json').read_text())
                report['database_removed'] = True
                (artifacts/'result.json').write_text(json.dumps(report))
        if (artifacts/'result.json').exists():
            for line in json.loads((artifacts/'result.json').read_text()).get('clock_warnings', []):
                print(f'WARNING: {line}; timing failures in this run are not evidence. Keep the host awake and rerun.')
        print(f'Verification artifacts: {artifacts}')
    return result if result is not None else 1


if __name__ == '__main__':
    raise SystemExit(main())
