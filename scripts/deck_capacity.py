"""Run the opt-in 25,000-Edition Deck capacity measurement in a newly created disposable database.

No existing DATABASE_URL is used. Never accepts an existing fixture database. Mirrors scripts/local_capacity.py.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

TEST = 'api/tests/test_deck_capacity.py::test_a_25000_edition_deck_counts_every_copy_or_labels_its_cost_incomplete'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--admin-url', required=True, help='Local PostgreSQL administrative connection; no remote hosts accepted')
parser.add_argument('--report', required=True, type=Path, help='Sanitized JSON output path')
args = parser.parse_args()
options = conninfo_to_dict(args.admin_url)
if options.get('host') not in ('127.0.0.1', 'localhost', '::1') or options.get('hostaddr', '127.0.0.1') not in ('127.0.0.1', '::1'):
    parser.error('only an explicit loopback PostgreSQL host is permitted')
name = 'tcg_deck_capacity_' + secrets.token_hex(8)
root = Path(__file__).resolve().parents[1]
args.report = args.report.resolve()
args.report.parent.mkdir(parents=True, exist_ok=True)
env = {**os.environ, 'DATABASE_URL': make_conninfo(args.admin_url, dbname=name),
       'INTERNAL_AUTH_SECRET': secrets.token_hex(32), 'PYTHONPATH': str(root/'api'),
       'DECK_CAPACITY_REPORT': str(args.report)}
for variable in ('PUBLIC_PROJECTION_ADAPTER', 'PUBLIC_PROJECTION_URL', 'PUBLIC_PROJECTION_TOKEN', 'TEST_LOG_DIR'):
    env.pop(variable, None)
created = False
try:
    with psycopg.connect(args.admin_url, autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        created = True
        server = conn.execute('SHOW server_version').fetchone()[0]
    subprocess.run([sys.executable, str(root/'scripts/migrate.py')], env=env, cwd=root, check=True)
    subprocess.run([sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', TEST], env=env, cwd=root, check=True)
    report = json.loads(args.report.read_text())
    report['environment']['postgresql'] = server
    report['recorded_at_utc'] = datetime.now(timezone.utc).isoformat()
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(f'Sanitized report: {args.report}')
finally:
    if created:
        with psycopg.connect(args.admin_url, autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
