"""scripts/verify_reaper.py against PostgreSQL: tagging at creation, and which leaked runs a reap drops. The pure decision
rules are unit-tested in tests/tooling/test_verify_harness.py. This test reaps only the synthetic runs it creates."""
import importlib.util
import os
from pathlib import Path
import secrets
import sys
import time

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'


def _load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sys.modules.setdefault('verify_discard', _load('verify_discard'))  # verify_reaper imports it as a sibling script
verify_reaper = _load('verify_reaper')
RUN = '20261010T195314Z-28c6ae5f'
HOST = 'reaper-test-host'


def test_reap_drops_only_a_dead_owners_unused_tagged_run():
    admin = os.environ.get('RECOVERY_TEST_DATABASE_URL')
    if not admin:
        pytest.skip('RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server')
    dead, busy, untagged = ('tcg_verify_' + secrets.token_hex(8) for _ in range(3))
    # A fixed host and a probe that finds no process: this test starts no processes (ps is covered in tests/tooling).
    exited = verify_reaper.Owner(RUN, HOST, os.getpid(), None, time.time() - 3600)
    names = [dead, dead + '_gw0', busy, untagged]
    created = []
    try:
        with psycopg.connect(admin, autocommit=True) as conn:
            verify_reaper.create_databases(conn, [dead, dead + '_gw0', busy], exited, created)
            conn.execute(sql.SQL('COMMENT ON DATABASE {} IS NULL').format(sql.Identifier(dead + '_gw0')))  # killed before tagging
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(untagged)))
            created.append(untagged)
            comment = conn.execute("SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = %s", (busy,)).fetchone()[0]
        assert verify_reaper.parse_owner(comment) == exited
        with psycopg.connect(make_conninfo(admin, dbname=busy)):
            reports = {name: verify_reaper.reap(admin, prefix=name, host=HOST, probe=lambda pid: None) for name in (dead, busy, untagged)}
        with psycopg.connect(admin, autocommit=True) as conn:
            remaining = {row[0] for row in conn.execute('SELECT datname FROM pg_database WHERE datname = ANY(%s)', (names,))}
        assert remaining == {busy, untagged}
        lines, dropped = reports[dead]
        assert sorted(dropped) == [dead, dead + '_gw0']
        assert all(line.startswith(f'== reaper: dropped {dead}') for line in lines)
        assert reports[busy][1] == [] and 'in use by 1 session(s)' in reports[busy][0][0]
        assert reports[untagged][1] == [] and 'untagged' in reports[untagged][0][0]
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            for name in names:
                conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
