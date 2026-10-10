"""Shared test isolation.

Delivery state lives in PostgreSQL (the dirty-target outbox) while most tests give each test its
own records store. Rows left delivered by an earlier test would claim records a fresh store
never received, so every test starts and ends with an empty outbox.

Under pytest-xdist each worker has its own database, projection directory, runner lock directory,
catalog fixture directory and mail file. scripts/verify_resources.py writes them to
$VERIFY_PYTEST_WORKER_ROOT/<worker>/env.json, and this module applies them before any test module
is imported. Tier markers: ``slow`` tests are left out by ``npm run verify -- --fast``; ``serial``
tests run in a second, single-process pass (scripts/run_pytest.py).
"""
import json
import os
from pathlib import Path

import pytest


def _isolate_xdist_worker():
    worker = os.environ.get('PYTEST_XDIST_WORKER')
    if not worker:
        return
    root = os.environ.get('VERIFY_PYTEST_WORKER_ROOT')
    if not root:
        raise RuntimeError('Parallel pytest needs per-worker databases; run it through npm run verify')
    settings = Path(root) / worker / 'env.json'
    if not settings.is_file():
        raise RuntimeError(f'No prepared verification resources for pytest worker {worker}')
    os.environ.update(json.loads(settings.read_text()))


_isolate_xdist_worker()


def pytest_configure(config):
    config.addinivalue_line('markers', 'slow(reason): launches real processes, waits out real time, sleeps or builds '
                                       'capacity-sized data; left out by npm run verify -- --fast')
    config.addinivalue_line('markers', 'serial(reason): asserts wall-clock bounds or launches real runner processes; '
                                       'runs alone after the parallel pass')


def _empty_outbox():
    if not os.environ.get('DATABASE_URL'):
        return
    import psycopg
    from psycopg.errors import UndefinedTable
    with psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as conn:
        try:
            conn.execute('DELETE FROM catalog_public_outbox')
        except UndefinedTable:
            pass  # A test database that is not migrated yet.


@pytest.fixture(autouse=True)
def empty_public_outbox():
    _empty_outbox()
    yield
    _empty_outbox()
