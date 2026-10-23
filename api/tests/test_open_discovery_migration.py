"""Migration 145 (Trading #297), on its own disposable database.

It runs again with nothing changed, gives every existing profile its own trader id, creates the discovery setting with
its checks, view and index, defines distance_band as IMMUTABLE and widens the handle_lookup_event kind CHECK to the
union of every known kind, leaving exactly one.
"""
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from test_catalog_references import migrate
from test_trade_migrations import collector, run_again, scratch  # noqa: F401

MIGRATION = '145_open_discovery.sql'
KINDS = ('lookup', 'handle_change', 'friend_command', 'loan_command', 'trade_command', 'zip_change',
         'new_conversation', 'message')


def test_migration_145_adds_open_discovery_and_runs_again(scratch):
    migrate(scratch, before=MIGRATION)
    first, second = 'collector-' + uuid4().hex, 'collector-' + uuid4().hex
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        collector(conn, first)
        collector(conn, second)
        conn.execute("INSERT INTO handle_lookup_event(user_id, kind) VALUES (%s, 'trade_command')", (first,))
    migrate(scratch, before='146_zip_centroids.sql')
    run_again(scratch, MIGRATION)
    run_again(scratch, MIGRATION)
    # An older widening must skip, not narrow.
    run_again(scratch, '141_trades.sql')
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        profiles = conn.execute('SELECT user_id, trader_id, suspended_at FROM collector_profile WHERE user_id = ANY(%s)',
                                ([first, second],)).fetchall()
        assert len(profiles) == 2
        assert all(row['trader_id'] is not None and row['suspended_at'] is None for row in profiles)
        assert len({row['trader_id'] for row in profiles}) == 2
        assert conn.execute("""SELECT count(*) AS n FROM pg_constraint
          WHERE conrelid = 'collector_profile'::regclass AND contype = 'u'
            AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
              WHERE attrelid = 'collector_profile'::regclass AND attname = 'trader_id')]""").fetchone() == {'n': 1}

        [kinds] = conn.execute("""SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'handle_lookup_event'::regclass AND contype = 'c'""").fetchall()
        for kind in KINDS:
            assert f"'{kind}'" in kinds['definition'], kind
        assert conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE kind='trade_command'").fetchone() \
            == {'n': 1}
        for kind in ('zip_change', 'new_conversation', 'message'):
            conn.execute('INSERT INTO handle_lookup_event(user_id, kind) VALUES (%s, %s)', (first, kind))
        with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
            conn.execute("INSERT INTO handle_lookup_event(user_id, kind) VALUES (%s, 'bogus')", (first,))

        refused = ('INSERT INTO discovery_setting(user_id, enabled) VALUES (%s, true)',
                   "INSERT INTO discovery_setting(user_id, enabled, zip, lon) VALUES (%s, true, '00010', -100)",
                   """INSERT INTO discovery_setting(user_id, enabled, zip, lat, lon, removed_at)
                      VALUES (%s, true, '00010', 40, -100, now())""",
                   'INSERT INTO discovery_setting(user_id, radius_mi) VALUES (%s, 7)')
        for statement in refused:
            with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
                conn.execute(statement, (first,))
        conn.execute('INSERT INTO discovery_setting(user_id) VALUES (%s)', (first,))
        assert conn.execute('SELECT enabled, zip, radius_mi FROM discovery_setting WHERE user_id=%s',
                            (first,)).fetchone() == {'enabled': False, 'zip': None, 'radius_mi': 25}

        [index] = conn.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'discovery_open_lat'").fetchall()
        assert 'WHERE enabled' in index['indexdef']
        assert conn.execute('SELECT user_id FROM open_discovery WHERE user_id = ANY(%s)',
                            ([first, second],)).fetchall() == []
        conn.execute("""UPDATE discovery_setting SET enabled = true, zip = '00010', lat = 40, lon = -100
          WHERE user_id = %s""", (first,))
        conn.execute("""INSERT INTO discovery_setting(user_id, enabled, zip, lat, lon)
          VALUES (%s, true, '00011', 40.1, -100)""", (second,))
        listed = conn.execute('SELECT user_id, trader_id FROM open_discovery WHERE user_id = ANY(%s)',
                              ([first, second],)).fetchall()
        assert {row['user_id'] for row in listed} == {first, second}
        assert {row['trader_id'] for row in listed} == {row['trader_id'] for row in profiles}
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (second,))
        assert [row['user_id'] for row in conn.execute(
            'SELECT user_id FROM open_discovery WHERE user_id = ANY(%s)', ([first, second],))] == [first]
        conn.execute('UPDATE discovery_setting SET enabled = false, removed_at = now() WHERE user_id = %s', (first,))
        assert conn.execute('SELECT user_id FROM open_discovery WHERE user_id = ANY(%s)',
                            ([first, second],)).fetchall() == []

        assert conn.execute("SELECT provolatile FROM pg_proc WHERE proname = 'distance_band'").fetchone() \
            == {'provolatile': 'i'}

        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (first,))
        assert conn.execute('SELECT count(*) AS n FROM discovery_setting WHERE user_id = %s',
                            (first,)).fetchone() == {'n': 0}
