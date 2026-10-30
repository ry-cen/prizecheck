"""Real detached importer and API lifetime at PostgreSQL/process/HTTP seams."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread
import time
from uuid import uuid4

import httpx

import pytest
from app.main import connect
from test_catalog import headers
from test_catalog_dispatch import owner_fixture, PATH


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        return sock.getsockname()[1]


def eventually(predicate, timeout=15):
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError('Process seam did not reach expected durable state')


@pytest.mark.serial(reason='process: starts real API and importer processes and asserts response times')
@pytest.mark.slow(reason='process: starts real API and importer processes')
def test_detached_child_survives_api_restart_and_exits_after_exact_run(tmp_path):
    owner = owner_fixture()
    entered, release = Event(), Event()
    child_pids, paths = set(), set()
    class FixtureSource(BaseHTTPRequestHandler):
        def do_GET(self):
            child_pids.add(int(self.headers['x-process-fixture']))
            paths.add(self.path)
            if self.path == '/cards':
                entered.set()
                release.wait(15)
                data = [{'id':'process-1'}]
            elif self.path == '/series/tcgp':
                data = {'id':'tcgp','sets':[{'id':'P1'}]}
            elif self.path == '/sets/P1':
                data = {'id':'P1','serie':{'id':'tcgp'},'cards':[]}
            else:
                data = {'id':'process-1','name':'Pikachu','localId':'1','set':{'id':'process','name':'Process Set'},'category':'Pokemon','variants':{'normal':True}}
            body = json.dumps(data).encode()
            self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body)
        def log_message(self,*args):
            pass
    source = ThreadingHTTPServer(('127.0.0.1',0),FixtureSource)
    Thread(target=source.serve_forever,kwargs={'poll_interval':0.02},daemon=True).start()
    # Trusted interpreter bootstrap redirects the external source HTTP boundary,
    # without adding test source/fixture switches to the production importer.
    (tmp_path/'sitecustomize.py').write_text(f"import os, app.games.pokemon.catalog.catalog\napp.games.pokemon.catalog.catalog.BASE_URL='http://127.0.0.1:{source.server_port}/cards'\n_original=app.games.pokemon.catalog.catalog.TCGdexSource.__init__\ndef _fixture_init(self):\n _original(self)\n self.client.headers['x-process-fixture']=str(os.getpid())\napp.games.pokemon.catalog.catalog.TCGdexSource.__init__=_fixture_init\n")
    root = Path(__file__).resolve().parents[2]
    env = {**os.environ,'PYTHONPATH':str(tmp_path)+os.pathsep+str(root/'api')}
    port = free_port()
    url = f'http://127.0.0.1:{port}'
    def start_api():
        return subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1','--port',str(port)],cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    api = start_api()
    try:
        def healthy():
            try: return httpx.get(url+'/api/health',timeout=.2).status_code == 200
            except httpx.HTTPError: return False
        eventually(healthy)
        started = time.monotonic()
        response = httpx.post(url+PATH,headers=headers(owner,'POST',PATH),timeout=3)
        assert response.status_code == 200, response.text
        assert time.monotonic()-started < 2
        run_id = response.json()['run']['id']
        assert entered.wait(5)
        with connect() as conn:
            # PostgreSQL exposes the runner backend PID. OS child survival is
            # observed through its live ownership and durable result below.
            assert conn.execute("SELECT phase,outcome FROM catalog_run WHERE id=%s",(run_id,)).fetchone() == {'phase':'enumerating','outcome':None}
            assert not conn.execute('SELECT pg_try_advisory_lock(914703) AS held').fetchone()['held']
        api.terminate(); api.wait(timeout=5)
        api = start_api(); eventually(healthy)
        while_paused = httpx.get(url+PATH,headers=headers(owner,'GET',PATH)).json()
        assert while_paused['run']['id'] == run_id and while_paused['run']['outcome'] is None
        release.set()
        def completed():
            state = httpx.get(url+PATH,headers=headers(owner,'GET',PATH)).json()
            return state if state['run']['outcome'] else None
        result = eventually(completed)
        assert result['run']['outcome'] == 'succeeded' and result['catalog']['revision'] == 1
        def runner_exited():
            with connect() as conn:
                held = conn.execute('SELECT pg_try_advisory_lock(914703) AS held').fetchone()['held']
                if held: conn.execute('SELECT pg_advisory_unlock(914703)')
                return held
        eventually(runner_exited)
        assert len(child_pids) == 1
        assert {'/series/tcgp', '/sets/P1'} <= paths
        child_pid = next(iter(child_pids))
        def process_exited():
            status = subprocess.run(['ps','-p',str(child_pid),'-o','stat='],capture_output=True,text=True).stdout.strip()
            return not status or status.startswith('Z')
        eventually(process_exited)
        # Finished and missing exact-run children exit without network fetch.
        for supplied in (run_id,str(uuid4())):
            child = subprocess.run([sys.executable,'-m','app.catalog_import','--run-id',supplied],cwd=root/'api',env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
            assert child.returncode == 0
        with connect() as conn:
            assert conn.execute('SELECT revision FROM catalog_state').fetchone()['revision'] == 1
            assert conn.execute('SELECT count(*) AS n FROM catalog_run').fetchone()['n'] == 1
    finally:
        release.set(); api.terminate(); api.wait(timeout=5); source.shutdown(); source.server_close()


@pytest.mark.serial(reason='process: starts real importer processes and asserts their exits')
@pytest.mark.slow(reason='process: starts real importer processes')
def test_exact_child_exit_codes_and_safe_terminal_failures(tmp_path):
    import signal
    owner_fixture()
    root = Path(__file__).resolve().parents[2]
    env = {**os.environ,'PYTHONPATH':str(tmp_path)+os.pathsep+str(root/'api')}
    def reserve():
        with connect() as conn:
            return conn.execute('INSERT INTO catalog_run DEFAULT VALUES RETURNING id').fetchone()['id']
    def child(run_id):
        return subprocess.Popen([sys.executable,'-m','app.catalog_import','--run-id',str(run_id)],cwd=root/'api',env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    run_id = reserve()
    with connect() as runner:
        runner.execute('SELECT pg_advisory_lock(914703)'); runner.commit()
        assert child(run_id).wait(timeout=5) == 2
    # Only this trusted test interpreter's source boundary is replaced.
    (tmp_path/'sitecustomize.py').write_text("import app.games.pokemon.catalog.catalog\nclass Fixture(app.games.pokemon.catalog.catalog.TCGdexSource):\n def enumerate(self): raise RuntimeError('private credentials')\napp.games.pokemon.catalog.catalog.TCGdexSource=Fixture\n")
    assert child(run_id).wait(timeout=5) == 1
    with connect() as conn:
        state = conn.execute('SELECT outcome,error FROM catalog_run WHERE id=%s',(run_id,)).fetchone()
        assert state['outcome'] == 'failed' and 'credentials' not in state['error']
    started = tmp_path/'started'
    (tmp_path/'sitecustomize.py').write_text(f"import app.games.pokemon.catalog.catalog,time\nfrom pathlib import Path\nclass Fixture(app.games.pokemon.catalog.catalog.TCGdexSource):\n def enumerate(self):\n  Path({str(started)!r}).write_text('started')\n  time.sleep(30)\napp.games.pokemon.catalog.catalog.TCGdexSource=Fixture\n")
    run_id = reserve()
    process = child(run_id)
    try:
        eventually(started.exists)
        process.send_signal(signal.SIGINT)
        assert process.wait(timeout=5) == 130
        with connect() as conn:
            assert conn.execute('SELECT outcome FROM catalog_run WHERE id=%s',(run_id,)).fetchone()['outcome'] == 'failed'
    finally:
        if process.poll() is None: process.kill(); process.wait()

    started.unlink()
    killed_run = reserve()
    process = child(killed_run)
    try:
        eventually(started.exists)
        process.kill(); process.wait(timeout=5)
        with connect() as conn:
            assert conn.execute('SELECT outcome FROM catalog_run WHERE id=%s',(killed_run,)).fetchone()['outcome'] is None
            conn.execute("UPDATE catalog_run SET lease_until=now()-interval '1 second' WHERE id=%s",(killed_run,))
        from unittest.mock import patch
        from test_catalog_dispatch import start
        with connect() as conn:
            owner = conn.execute('SELECT user_id FROM owner_binding').fetchone()['user_id']
        with patch('app.games.pokemon.catalog.catalog_dispatch.launch_import'):
            recovered = start(owner)
        assert recovered.status_code == 200 and recovered.json()['run']['id'] != str(killed_run)
        with connect() as conn:
            assert conn.execute('SELECT outcome FROM catalog_run WHERE id=%s',(killed_run,)).fetchone()['outcome'] == 'failed'
    finally:
        if process.poll() is None: process.kill(); process.wait()
