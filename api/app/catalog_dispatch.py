"""Explicit owner dispatch; no queue polling or request-lifetime import work."""
import os
from pathlib import Path
import subprocess
import sys
from threading import Thread
from uuid import UUID

from fastapi import HTTPException

DISPATCH_LOCK = 914702
RUNNER_LOCK = 914703


def launch_import(run_id: UUID):
    """Fixed executable/arguments, detached session, nonblocking output, reaped child."""
    child = subprocess.Popen([sys.executable, '-m', 'app.catalog_import', '--run-id', str(run_id)],
        cwd=Path(__file__).resolve().parents[1], env=os.environ.copy(),
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True)
    # One finite waiter per child, rather than a permanent job-polling loop.
    Thread(target=child.wait, daemon=True, name='catalog-child-reaper').start()
    return child


def dispatch_import(conn):
    runner_owned = False
    conn.execute('SELECT pg_advisory_lock(%s)', (DISPATCH_LOCK,))
    conn.commit()
    try:
        runner_owned = conn.execute('SELECT pg_try_advisory_lock(%s) AS acquired',(RUNNER_LOCK,)).fetchone()['acquired']
        with conn.transaction():
            active = conn.execute("""SELECT id,coalesce(lease_until,started_at+interval '2 minutes')>clock_timestamp() AS healthy
              FROM catalog_run WHERE outcome IS NULL FOR UPDATE""").fetchone()
            if active and (not runner_owned or active['healthy']):
                return active['id']
            if not runner_owned:
                # No visible active row while publication is committing. A new
                # reservation here would misrepresent the live runner's state.
                return None
            if active:
                conn.execute("""UPDATE catalog_run SET phase='failed',outcome='failed',
                  error='Catalog import interrupted; start a new pull',finished_at=now(),lease_until=NULL
                  WHERE id=%s AND outcome IS NULL""",(active['id'],))
            run_id = conn.execute('INSERT INTO catalog_run DEFAULT VALUES RETURNING id').fetchone()['id']
        conn.commit()  # Reservation must be durable before the child can claim it.
        conn.execute('SELECT pg_advisory_unlock(%s)',(RUNNER_LOCK,))
        conn.commit()
        runner_owned = False
        try:
            launch_import(run_id)
        except Exception:
            conn.execute("""UPDATE catalog_run SET phase='failed',outcome='failed',error='CATALOG_DISPATCH_FAILED',
              finished_at=now(),lease_until=NULL WHERE id=%s AND outcome IS NULL""",(run_id,))
            conn.commit()
            raise HTTPException(503,{'code':'CATALOG_DISPATCH_FAILED'}) from None
        return run_id
    finally:
        conn.rollback()
        if runner_owned:
            conn.execute('SELECT pg_advisory_unlock(%s)',(RUNNER_LOCK,))
        conn.execute('SELECT pg_advisory_unlock(%s)',(DISPATCH_LOCK,))
        conn.commit()
