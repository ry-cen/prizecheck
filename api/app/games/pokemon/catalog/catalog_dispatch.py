"""Explicit owner dispatch; no queue polling or request-lifetime import work."""
import os
from pathlib import Path
import subprocess
import sys
from threading import Thread
from typing import NamedTuple
from uuid import UUID

from fastapi import HTTPException

DISPATCH_LOCK = 914702
RUNNER_LOCK = 914703


def launch_import(run_id: UUID):
    """Fixed executable/arguments, detached session, nonblocking output, reaped child."""
    child = subprocess.Popen([sys.executable, '-m', 'app.catalog_import', '--run-id', str(run_id)],
        cwd=Path(__file__).resolve().parents[4], env=os.environ.copy(),
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True)
    # One finite waiter per child, rather than a permanent job-polling loop.
    Thread(target=child.wait, daemon=True, name='catalog-child-reaper').start()
    return child


class Dispatch(NamedTuple):
    """What dispatch decided inside its locks. run_id is None while a promotion is committing (no run is visible).
    started: this call reserved a new run (and launched it, unless the launch raised). child: the launched process."""
    run_id: UUID | None
    started: bool
    child: subprocess.Popen | None = None
    declined: bool = False  # the caller's guard said a new run is no longer wanted


def dispatch_import(conn):
    """The owner routes' contract: one run id for a new run and for an already-active one, None while a promotion commits."""
    return dispatch_import_detailed(conn).run_id


def dispatch_import_detailed(conn, on_reserved=None, guard=None) -> Dispatch:
    """dispatch_import, but telling a started run from one that was already active, and handing back the child.

    guard(conn) is asked, inside the locks and only when a new run would be reserved, whether to go ahead; False returns
    Dispatch(None, False, declined=True) with nothing reserved (a guard that raises propagates and reserves
    nothing either). on_reserved(conn, run_id) runs once the reservation is committed and before the launch (still inside
    the locks), so a crash or a failed launch stays attributable to the caller. If on_reserved or the launch fails, the run
    is marked CATALOG_DISPATCH_FAILED and the same 503 is raised."""
    runner_owned = False
    conn.execute('SELECT pg_advisory_lock(%s)', (DISPATCH_LOCK,))
    conn.commit()
    try:
        runner_owned = conn.execute('SELECT pg_try_advisory_lock(%s) AS acquired',(RUNNER_LOCK,)).fetchone()['acquired']
        with conn.transaction():
            active = conn.execute("""SELECT id,coalesce(lease_until,started_at+interval '2 minutes')>clock_timestamp() AS healthy
              FROM catalog_run WHERE outcome IS NULL FOR UPDATE""").fetchone()
            if active and (not runner_owned or active['healthy']):
                return Dispatch(active['id'], False)
            if not runner_owned:
                # No visible active row while publication is committing. A new
                # reservation here would misrepresent the live runner's state.
                return Dispatch(None, False)
            if guard is not None and not guard(conn):
                return Dispatch(None, False, declined=True)
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
            if on_reserved is not None:
                on_reserved(conn, run_id)
                conn.commit()
            child = launch_import(run_id)
        except Exception:
            conn.rollback()
            conn.execute("""UPDATE catalog_run SET phase='failed',outcome='failed',error='CATALOG_DISPATCH_FAILED',
              finished_at=now(),lease_until=NULL WHERE id=%s AND outcome IS NULL""",(run_id,))
            conn.commit()
            raise HTTPException(503,{'code':'CATALOG_DISPATCH_FAILED'}) from None
        return Dispatch(run_id, True, child)
    finally:
        conn.rollback()
        if runner_owned:
            conn.execute('SELECT pg_advisory_unlock(%s)',(RUNNER_LOCK,))
        conn.execute('SELECT pg_advisory_unlock(%s)',(DISPATCH_LOCK,))
        conn.commit()
