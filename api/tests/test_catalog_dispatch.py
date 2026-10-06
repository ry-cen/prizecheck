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
    with patch('app.catalog_dispatch.launch_import') as launcher:
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: start(owner),range(2)))
    assert [response.status_code for response in responses] == [200,200]
    assert responses[0].json()['run']['id'] == responses[1].json()['run']['id']
    assert launcher.call_count == 1


def test_exact_run_child_claim_rejects_superseded_and_completed():
    from app.catalog import claim_run
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
    with patch('app.catalog_dispatch.launch_import',side_effect=OSError('secret credential')):
        response = start(owner)
    assert response.status_code == 503 and response.json()['detail']['code'] == 'CATALOG_DISPATCH_FAILED'
    with connect() as conn:
        failed = conn.execute('SELECT * FROM catalog_run ORDER BY started_at DESC LIMIT 1').fetchone()
    assert failed['outcome'] == 'failed' and failed['error'] == 'CATALOG_DISPATCH_FAILED'
    with patch('app.catalog_dispatch.launch_import') as launcher:
        response = start(owner)
        assert response.status_code == 200 and response.json()['run']['id'] != str(failed['id'])
        assert launcher.call_count == 1


def test_orphan_recovery_waits_startup_grace_and_respects_live_session_lock():
    from app.catalog import claim_run, RunnerBusy
    owner = owner_fixture()
    with patch('app.catalog_dispatch.launch_import') as launcher:
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
    with patch('app.catalog_dispatch.launch_import') as launcher:
        assert start(str(uuid4())).status_code == 403
        launcher.assert_not_called()
