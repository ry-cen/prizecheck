"""Owner HTTP dispatch contracts against a disposable PostgreSQL database."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from unittest.mock import patch

import pytest
from app.main import connect
from test_catalog import client, headers, reset_catalog

PATH = '/api/admin/catalog-runs'


def owner_fixture():
    reset_catalog()
    owner = str(uuid4())
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)',(owner,))
        conn.execute('INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)',(owner,))
    return owner


def start(owner):
    return client.post(PATH,headers=headers(owner,'POST',PATH))


def test_concurrent_dispatch_launches_once_and_returns_promptly():
    owner = owner_fixture()
    with patch('app.games.pokemon.catalog.catalog_dispatch.launch_import') as launcher:
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: start(owner),range(2)))
    assert [response.status_code for response in responses] == [200,200]
    assert responses[0].json()['run']['id'] == responses[1].json()['run']['id']
    assert launcher.call_count == 1


def test_exact_run_child_claim_rejects_superseded_and_completed():
    from app.games.pokemon.catalog.catalog import claim_run
    owner_fixture()
    with connect() as conn:
        first = conn.execute('INSERT INTO catalog_run DEFAULT VALUES RETURNING id').fetchone()['id']
        conn.execute("UPDATE catalog_run SET phase='failed',outcome='failed' WHERE id=%s",(first,))
        current = conn.execute('INSERT INTO catalog_run DEFAULT VALUES RETURNING id').fetchone()['id']
        conn.commit()
        assert claim_run(conn,first) is None
        assert claim_run(conn,current) == current
    with connect() as conn:
        conn.execute("UPDATE catalog_run SET phase='complete',outcome='succeeded' WHERE id=%s",(current,))
        conn.commit()
        assert claim_run(conn,current) is None


def test_launch_failure_is_safe_and_next_explicit_start_recovers():
    owner = owner_fixture()
    with patch('app.games.pokemon.catalog.catalog_dispatch.launch_import',side_effect=OSError('secret credential')):
        response = start(owner)
    assert response.status_code == 503 and response.json()['detail']['code'] == 'CATALOG_DISPATCH_FAILED'
    with connect() as conn:
        failed = conn.execute('SELECT * FROM catalog_run ORDER BY started_at DESC LIMIT 1').fetchone()
    assert failed['outcome'] == 'failed' and failed['error'] == 'CATALOG_DISPATCH_FAILED'
    with patch('app.games.pokemon.catalog.catalog_dispatch.launch_import') as launcher:
        response = start(owner)
        assert response.status_code == 200 and response.json()['run']['id'] != str(failed['id'])
        assert launcher.call_count == 1


def test_orphan_recovery_waits_startup_grace_and_respects_live_session_lock():
    from app.games.pokemon.catalog.catalog import claim_run, RunnerBusy
    owner = owner_fixture()
    with patch('app.games.pokemon.catalog.catalog_dispatch.launch_import') as launcher:
        original = start(owner).json()['run']['id']
        assert start(owner).json()['run']['id'] == original
        assert launcher.call_count == 1
        with connect() as conn:
            conn.execute("UPDATE catalog_run SET started_at=now()-interval '3 minutes' WHERE id=%s",(original,))
        # GET is observational and must not recover or launch a process.
        assert client.get(PATH,headers=headers(owner,'GET',PATH)).json()['run']['id'] == original
        assert launcher.call_count == 1
        replacement = start(owner).json()['run']['id']
        assert replacement != original and launcher.call_count == 2
        with connect() as runner:
            assert str(claim_run(runner, replacement)) == replacement
            runner.execute("UPDATE catalog_run SET lease_until=now()-interval '3 minutes',started_at=now()-interval '5 minutes' WHERE id=%s",(replacement,))
            runner.commit()
            assert start(owner).json()['run']['id'] == replacement
            assert launcher.call_count == 2
            with connect() as duplicate:
                with pytest.raises(RunnerBusy):
                    claim_run(duplicate,replacement)
        fresh = start(owner).json()['run']['id']
        assert fresh != replacement and launcher.call_count == 3
        with connect() as delayed:
            assert claim_run(delayed,replacement) is None
    assert client.post(PATH).status_code == 401
    with patch('app.games.pokemon.catalog.catalog_dispatch.launch_import') as launcher:
        assert start(str(uuid4())).status_code == 403
        launcher.assert_not_called()


def test_detailed_dispatch_tells_started_from_active_and_keeps_the_owner_contract():
    from app.games.pokemon.catalog.catalog_dispatch import dispatch_import, dispatch_import_detailed
    owner_fixture()
    with patch('app.games.pokemon.catalog.catalog_dispatch.launch_import') as launcher, connect() as conn:
        first = dispatch_import_detailed(conn)
        assert first.started and first.child is launcher.return_value and first.run_id is not None
        second = dispatch_import_detailed(conn)
        assert (second.run_id, second.started, second.child) == (first.run_id, False, None)
        assert dispatch_import(conn) == first.run_id and launcher.call_count == 1


def test_detailed_dispatch_reports_a_committing_promotion_as_no_run():
    from app.games.pokemon.catalog.catalog_dispatch import dispatch_import_detailed
    owner_fixture()
    with connect() as holder, connect() as conn:
        holder.execute('SELECT pg_advisory_lock(914703)')
        try:
            with patch('app.games.pokemon.catalog.catalog_dispatch.launch_import') as launcher:
                result = dispatch_import_detailed(conn)
        finally:
            holder.execute('SELECT pg_advisory_unlock(914703)')
    assert (result.run_id, result.started, result.declined) == (None, False, False)
    launcher.assert_not_called()


def test_dispatch_guard_declines_before_reserving_and_on_reserved_runs_before_the_launch():
    from app.games.pokemon.catalog.catalog_dispatch import dispatch_import_detailed
    owner_fixture()
    order = []
    with patch('app.games.pokemon.catalog.catalog_dispatch.launch_import', side_effect=lambda run_id: order.append('launch')) as launcher, connect() as conn:
        declined = dispatch_import_detailed(conn, guard=lambda c: False)
        assert declined.declined and declined.run_id is None and not declined.started
        assert conn.execute('SELECT count(*) AS n FROM catalog_run').fetchone()['n'] == 0
        started = dispatch_import_detailed(conn, guard=lambda c: True,
                                           on_reserved=lambda c, run_id: order.append(('reserved', run_id)))
        assert order == [('reserved', started.run_id), 'launch']
        assert conn.execute('SELECT outcome FROM catalog_run WHERE id=%s', (started.run_id,)).fetchone()['outcome'] is None


def test_a_failing_on_reserved_marks_the_run_failed_without_launching():
    from app.games.pokemon.catalog.catalog_dispatch import dispatch_import_detailed
    from fastapi import HTTPException
    owner_fixture()

    def broken(c, run_id):
        raise RuntimeError('secret')

    with patch('app.games.pokemon.catalog.catalog_dispatch.launch_import') as launcher, connect() as conn:
        with pytest.raises(HTTPException) as caught:
            dispatch_import_detailed(conn, on_reserved=broken)
        assert caught.value.detail == {'code': 'CATALOG_DISPATCH_FAILED'}
        assert conn.execute('SELECT outcome,error FROM catalog_run').fetchone() == {'outcome': 'failed', 'error': 'CATALOG_DISPATCH_FAILED'}
    launcher.assert_not_called()


def test_expired_lease_is_stale_only_when_no_session_holds_the_runner_lock():
    from app.games.pokemon.catalog.catalog_dispatch import RUNNER_LOCK
    owner = owner_fixture()
    with connect() as conn:
        conn.execute("INSERT INTO catalog_run(phase,started_at,lease_until) VALUES ('promoting',now()-interval '10 minutes',now()-interval '5 minutes')")
        conn.commit()
    def stale():
        response = client.get(PATH,headers=headers(owner,'GET',PATH))
        assert response.status_code == 200
        run = response.json()['run']
        assert run['phase'] == 'promoting'
        return run['heartbeat_stale']
    assert stale() is True
    with connect() as runner:
        assert runner.execute('SELECT pg_try_advisory_lock(%s) AS got',(RUNNER_LOCK,)).fetchone()['got']
        try:
            assert stale() is False
        finally:
            runner.execute('SELECT pg_advisory_unlock(%s)',(RUNNER_LOCK,))
    assert stale() is True


def test_importer_holds_the_runner_lock_through_promotion_so_an_expired_lease_is_not_stale():
    from app.games.pokemon.catalog.catalog import claim_run, execute_run
    from test_catalog_metadata import Records, furret
    owner = owner_fixture()
    seen = {}
    with connect() as conn:
        run_id = conn.execute('INSERT INTO catalog_run DEFAULT VALUES RETURNING id').fetchone()['id']
        conn.commit()
        claim_run(conn,run_id)

        def during_promotion():
            # The importer's own transaction is open here; expire the lease from another session.
            with connect() as other:
                other.execute("UPDATE catalog_run SET lease_until=now()-interval '5 minutes' WHERE id=%s",(run_id,))
                other.commit()
            response = client.get(PATH,headers=headers(owner,'GET',PATH))
            assert response.status_code == 200
            seen.update(response.json()['run'])

        execute_run(conn,run_id,Records(furret()),before_promotion=during_promotion)
        conn.commit()
    assert seen['phase'] == 'promoting' and seen['heartbeat_stale'] is False
    with connect() as conn:
        assert conn.execute('SELECT outcome FROM catalog_run WHERE id=%s',(run_id,)).fetchone()['outcome'] == 'succeeded'
