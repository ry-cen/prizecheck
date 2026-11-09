"""Characterize catalog run transitions and each caller's existing lease boundary."""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from psycopg import sql

from app.games.pokemon.catalog import catalog, catalog_dispatch, catalog_refresh, catalog_status
from app.games.pokemon.catalog import catalog_run_states as states
from app.main import connect
from test_catalog import Source, reset_catalog
from test_catalog_dispatch import owner_fixture


def reserve(conn):
    run_id = conn.execute('INSERT INTO catalog_run DEFAULT VALUES RETURNING id').fetchone()['id']
    conn.commit()
    return run_id


def row(conn, run_id):
    return conn.execute('SELECT * FROM catalog_run WHERE id=%s', (run_id,)).fetchone()


class BrokenEnumeration:
    def enumerate(self):
        raise catalog.CatalogError('enumeration failed')


def test_claim_moves_queued_to_enumerating_and_second_claim_is_a_no_op():
    reset_catalog()
    with connect() as conn:
        run_id = reserve(conn)
        assert row(conn, run_id)['phase'] == states.PHASE_QUEUED
        conn.commit()
        assert catalog.claim_run(conn, run_id) == run_id
        claimed = row(conn, run_id)
        assert claimed['phase'] == states.PHASE_ENUMERATING
        assert claimed['outcome'] is None and claimed['lease_until'] is not None
        conn.commit()
        assert catalog.claim_run(conn, run_id) is None
        assert row(conn, run_id) == claimed


def test_success_follows_the_documented_phases_and_terminal_outcome():
    reset_catalog()
    with connect() as conn:
        run_id = reserve(conn)
        catalog.claim_run(conn, run_id)
        seen = [row(conn, run_id)['phase']]
        progress = catalog._progress

        def record(c, identifier, phase, **counts):
            progress(c, identifier, phase, **counts)
            seen.append(row(c, identifier)['phase'])
            c.commit()

        with patch.object(catalog, '_progress', side_effect=record):
            catalog.execute_run(conn, run_id, Source())
        finished = row(conn, run_id)
        seen.append(finished['phase'])
        assert seen == [states.PHASE_ENUMERATING, states.PHASE_FETCHING, states.PHASE_VALIDATING,
                        states.PHASE_PROMOTING, states.PHASE_COMPLETE]
        for before, after in zip(seen, seen[1:]):
            assert after in states.TRANSITIONS[before]
        assert finished['outcome'] == states.TERMINAL_OUTCOMES[finished['phase']]
        assert finished['finished_at'] is not None and finished['lease_until'] is None


@pytest.mark.parametrize('completed', [False, True])
def test_failure_guard_preserves_a_completed_run_and_repeated_failure_is_a_no_op(completed):
    reset_catalog()
    with connect() as conn:
        run_id = reserve(conn)
        catalog.claim_run(conn, run_id)
        if completed:
            # Publication follows the committed complete/succeeded write. Its exception
            # reaches the same failure handler, whose outcome guard preserves success.
            with patch.object(catalog, '_publish_after_commit', side_effect=RuntimeError('publication failed')):
                with pytest.raises(RuntimeError, match='publication failed'):
                    catalog.execute_run(conn, run_id, Source())
            assert conn.execute('SELECT active_generation FROM catalog_state').fetchone()['active_generation'] == run_id
            conn.commit()
        else:
            with pytest.raises(catalog.CatalogError, match='enumeration failed'):
                catalog.execute_run(conn, run_id, BrokenEnumeration())
        before = row(conn, run_id)
        conn.commit()
        with pytest.raises(catalog.CatalogError, match='enumeration failed'):
            catalog.execute_run(conn, run_id, BrokenEnumeration())
        assert row(conn, run_id) == before
        assert before['phase'] == (states.PHASE_COMPLETE if completed else states.PHASE_FAILED)
        assert before['outcome'] == states.TERMINAL_OUTCOMES[before['phase']]


@pytest.mark.parametrize('failure', ['enumerating', 'fetching', 'validating', 'promoting', 'capacity'])
def test_phase_exceptions_fail_the_run_and_roll_back_publication(failure, monkeypatch):
    reset_catalog()
    if failure == 'capacity':
        # This gate raises after the complete/succeeded write inside the promotion transaction.
        monkeypatch.setenv('CATALOG_DB_MAX_BYTES', '1')
    source = (BrokenEnumeration() if failure == 'enumerating' else
              Source(fail='test-2') if failure == 'fetching' else
              Source(second=('test-1',)) if failure == 'validating' else Source())

    def broken_promotion():
        raise RuntimeError('private promotion failure')

    with connect() as conn:
        run_id = reserve(conn)
        catalog.claim_run(conn, run_id)
        before = conn.execute('SELECT active_generation,revision,last_success FROM catalog_state').fetchone()
        conn.commit()
        with pytest.raises((catalog.CatalogError, RuntimeError)):
            catalog.execute_run(conn, run_id, source,
                                before_promotion=broken_promotion if failure == 'promoting' else None)
        failed = row(conn, run_id)
        assert (failed['phase'], failed['outcome']) == (states.PHASE_FAILED, states.OUTCOME_FAILED)
        assert failed['finished_at'] is not None and failed['lease_until'] is None
        assert 'private promotion failure' not in failed['error']
        assert conn.execute('SELECT active_generation,revision,last_success FROM catalog_state').fetchone() == before
        assert conn.execute('SELECT id FROM catalog_generation WHERE id=%s', (run_id,)).fetchone() is None
        assert not conn.execute('SELECT 1 FROM pg_locks WHERE locktype=\'advisory\' AND pid=pg_backend_pid() '
                                'AND classid=0 AND objid=914703 AND objsubid=1').fetchone()


class FixedClockConnection:
    """Execute the real callers' SQL on PostgreSQL with a fixed clock, including exact equality.

    No sleeps or approximate wall-clock comparisons: only clock_timestamp() is
    replaced, leaving the production predicate, parameters and locks intact.
    """
    def __init__(self, conn):
        self.conn = conn

    def __getattr__(self, name):
        return getattr(self.conn, name)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass  # The test owns the underlying connection's context.

    def execute(self, sql, *args, **kwargs):
        return self.conn.execute(sql.replace('clock_timestamp()', "TIMESTAMPTZ '2040-01-01 00:00:00+00'"),
                                 *args, **kwargs)


@pytest.mark.parametrize('fallback', [False, True], ids=['lease', 'startup-grace'])
@pytest.mark.parametrize('offset', [-1, 0, 1], ids=['expired', 'equal', 'healthy'])
@pytest.mark.parametrize('session_zone', ['UTC', 'Pacific/Kiritimati'])
def test_each_lease_site_keeps_its_boundary_and_dispatch_recovery(offset, fallback, session_zone):
    owner = owner_fixture()
    end = datetime(2040, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=offset)
    with connect() as conn:
        conn.execute(sql.SQL('SET TIME ZONE {}').format(sql.Literal(session_zone)))
        run_id = conn.execute('INSERT INTO catalog_run(started_at,lease_until) VALUES (%s,%s) RETURNING id',
                              (end - timedelta(minutes=2), None if fallback else end)).fetchone()['id']
        conn.execute('INSERT INTO catalog_check(catalog_run_id) VALUES (%s)', (run_id,))
        conn.commit()
        clock = FixedClockConnection(conn)
        # Refresh uses strict < and only observes stale runs here.
        assert [r['id'] for r in catalog_refresh.pause_failures(clock)] == ([run_id] if offset < 0 else [])
        assert row(conn, run_id)['outcome'] is None
        conn.commit()
        # Owner status uses <= and does not mutate or launch a run.
        with patch.object(catalog_status, 'connect', return_value=clock):
            status = catalog_status.owner_catalog_status(user_id=owner)
        assert status.run.heartbeat_stale is (offset <= 0)
        assert row(conn, run_id)['outcome'] is None
        conn.commit()
        # Dispatch keeps only a strictly healthy (>) lease; equality is recovered.
        with patch.object(catalog_dispatch, 'launch_import') as launch:
            result = catalog_dispatch.dispatch_import_detailed(clock)
        assert result.started is (offset <= 0)
        if offset <= 0:
            assert result.run_id != run_id
            launch.assert_called_once_with(result.run_id)
            interrupted = row(conn, run_id)
            assert (interrupted['phase'], interrupted['outcome'], interrupted['error']) == (
                states.PHASE_FAILED, states.OUTCOME_FAILED, catalog_refresh.INTERRUPTED)
            assert interrupted['lease_until'] is None and interrupted['finished_at'] is not None
            assert row(conn, result.run_id)['phase'] == states.PHASE_QUEUED
        else:
            assert result.run_id == run_id
            launch.assert_not_called()
            assert row(conn, run_id)['outcome'] is None


@pytest.mark.parametrize('offset', [-1, 0, 1])
@pytest.mark.parametrize('session_zone', ['UTC', 'Pacific/Kiritimati'])
def test_live_runner_lock_overrides_expired_equal_and_healthy_leases(offset, session_zone):
    owner = owner_fixture()
    end = datetime(2040, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=offset)
    with connect() as holder, connect() as conn:
        conn.execute(sql.SQL('SET TIME ZONE {}').format(sql.Literal(session_zone)))
        run_id = conn.execute('INSERT INTO catalog_run(lease_until) VALUES (%s) RETURNING id', (end,)).fetchone()['id']
        conn.execute('INSERT INTO catalog_check(catalog_run_id) VALUES (%s)', (run_id,))
        conn.commit()
        holder.execute('SELECT pg_advisory_lock(914703)')
        holder.commit()
        clock = FixedClockConnection(conn)
        assert catalog_refresh.pause_failures(clock) == []
        with patch.object(catalog_status, 'connect', return_value=clock):
            assert catalog_status.owner_catalog_status(user_id=owner).run.heartbeat_stale is False
        conn.commit()
        with patch.object(catalog_dispatch, 'launch_import') as launch:
            result = catalog_dispatch.dispatch_import_detailed(clock)
        assert result.run_id == run_id and result.started is False
        launch.assert_not_called()
        assert row(conn, run_id)['outcome'] is None


@pytest.mark.parametrize('lease', [None, '1999-01-01 00:00:00+00', '2040-01-01 00:00:00+00', '2041-01-01 00:00:00+00'])
@pytest.mark.parametrize('session_zone', ['UTC', 'Pacific/Kiritimati'])
def test_child_exit_interrupts_unfinished_runs_regardless_of_lease_and_is_repeatable(lease, caplog, session_zone):
    reset_catalog()
    with connect() as conn:
        conn.execute(sql.SQL('SET TIME ZONE {}').format(sql.Literal(session_zone)))
        run_id = conn.execute('INSERT INTO catalog_run(lease_until) VALUES (%s) RETURNING id', (lease,)).fetchone()['id']
        conn.commit()
        clock = FixedClockConnection(conn)
        assert catalog_refresh._wait_for_pull(clock, run_id, None) == ('interrupted', catalog_refresh.PULL_INTERRUPTED)
        assert any('its lease had expired' in record.message for record in caplog.records) is (lease == '1999-01-01 00:00:00+00')
        interrupted = row(conn, run_id)
        assert (interrupted['phase'], interrupted['outcome']) == (states.PHASE_FAILED, states.OUTCOME_FAILED)
        conn.commit()
        assert catalog_refresh._wait_for_pull(clock, run_id, None) == (states.OUTCOME_FAILED, catalog_refresh.PULL_INTERRUPTED)
        assert row(conn, run_id) == interrupted
