"""Shared test isolation.

Delivery state lives in PostgreSQL (the dirty-target outbox) while most tests give each test its
own records store. Rows left delivered by an earlier test would claim records a fresh store
never received, so every test starts and ends with an empty outbox.
"""
import os

import pytest


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
