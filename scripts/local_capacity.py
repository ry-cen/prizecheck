"""Run explicit local capacity proof in a newly created disposable database.

No existing DATABASE_URL is used. Never accepts an existing fixture database.
"""
import argparse
import json
from datetime import datetime, timezone
import os
from pathlib import Path
import secrets
import subprocess
import sys

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--admin-url', required=True, help='Local PostgreSQL administrative connection; no remote hosts accepted')
parser.add_argument('--report', required=True, type=Path, help='Sanitized JSON output path')
args = parser.parse_args()
options = conninfo_to_dict(args.admin_url)
if options.get('host') not in ('127.0.0.1','localhost','::1') or options.get('hostaddr', '127.0.0.1') not in ('127.0.0.1','::1'):
    parser.error('only an explicit loopback PostgreSQL host is permitted')
name = 'tcg_load_' + secrets.token_hex(8)
root = Path(__file__).resolve().parents[1]
args.report = args.report.resolve()
args.report.parent.mkdir(parents=True,exist_ok=True)
env = {**os.environ, 'DATABASE_URL':make_conninfo(args.admin_url,dbname=name),
       'INTERNAL_AUTH_SECRET':secrets.token_hex(32),'PYTHONPATH':str(root/'api'),
       'LOCAL_CAPACITY_REPORT':str(args.report)}
created = False
try:
    with psycopg.connect(args.admin_url,autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        created = True
    subprocess.run([sys.executable,str(root/'scripts/migrate.py')],env=env,cwd=root,check=True)
    subprocess.run([sys.executable,'-m','pytest','-q','api/tests/test_local_capacity.py'],env=env,cwd=root,check=True)
    subprocess.run([sys.executable,'-m','pytest','-q','api/tests/test_moves.py::test_failed_25000_edition_move_is_wholly_rejected','api/tests/test_moves.py::test_rollback_when_destination_write_fails'],env=env,cwd=root,check=True)
    report = json.loads(args.report.read_text())
    report['recorded_at_utc'] = datetime.now(timezone.utc).isoformat()
    report['boundary_checks'] = ['five successful atomic 25000-Edition Moves with exact source/destination balances', 'stale 25000-Edition Move rejected without any changes', 'forced destination write failure rolls back and retry succeeds']
    args.report.write_text(json.dumps(report,indent=2))
    print(f'Sanitized report: {args.report}')
finally:
    if created:
        with psycopg.connect(args.admin_url,autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))
