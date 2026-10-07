"""Release command boundary checks, independent of a production provider."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class ReleaseTest(unittest.TestCase):
    def test_gate_rejects_commit_other_than_selected_main_without_creating_store(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Path(temp)/'releases'
            result = subprocess.run([str(ROOT/'.venv/bin/python'), str(ROOT/'scripts/release.py'), 'gate', '--commit', 'a38c674', '--main-ref', 'refs/heads/codex/mvp-integration', '--store', str(store), '--admin-url', 'postgresql://localhost/postgres'],capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse(store.exists())
            self.assertIn(b"Exact main commit required", result.stderr)

    def test_activation_requires_a_gated_release(self):
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run([str(ROOT/'.venv/bin/python'),str(ROOT/'scripts/release.py'),'activate','--commit','0'*40,'--store',temp,'--runtime-url','http://127.0.0.1:1'],capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse((Path(temp)/'active').exists())

    @unittest.skipUnless(os.environ.get('RELEASE_DRILL_STORE'), 'explicit disposable local runtime drill only')
    def test_real_runtime_activation_successor_gate_and_rollback(self):
        import psycopg
        from psycopg import sql
        from urllib.parse import urlsplit, urlunsplit
        import secrets
        import socket
        import time
        import urllib.request
        import uuid
        store = Path(os.environ['RELEASE_DRILL_STORE'])
        first = os.environ['RELEASE_DRILL_FIRST']
        second = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
        self.assertNotEqual(first,second)
        admin = os.environ['RECOVERY_TEST_DATABASE_URL']
        name = 'tcg_release_drill_'+uuid.uuid4().hex
        url = urlunsplit(urlsplit(admin)._replace(path='/'+name))
        runtime_root = Path(os.environ['RELEASE_DRILL_RUNTIME'])
        with tempfile.TemporaryDirectory() as temp:
            projection = Path(temp)/'public'
            projection.mkdir()
            env = {**os.environ,'DATABASE_URL':url,'PUBLIC_PROJECTION_DIR':str(projection),'RELEASE_CONTROL_KEY':secrets.token_hex(32),
                   'INTERNAL_AUTH_SECRET':secrets.token_hex(32),'BETTER_AUTH_SECRET':secrets.token_hex(32),'MAIL_MODE':'file','MAIL_FILE':str(Path(temp)/'mail'),
                   'OWNER_EMAIL':'owner@example.test'}
            with psycopg.connect(admin,autocommit=True) as conn:
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
            runtime = None
            try:
                subprocess.run([str(runtime_root/'.venv/bin/python'),str(store/first/'scripts/migrate.py')],env=env,check=True,capture_output=True)
                subprocess.run([str(runtime_root/'.venv/bin/python'),str(store/first/'scripts/init_public_projection.py')],env=env,check=True,capture_output=True)
                with psycopg.connect(url) as conn:
                    conn.execute("INSERT INTO inventory_owner(user_id) VALUES ('release-proof')")
                    location = str(uuid.uuid4())
                    conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,'release-proof','Unsorted','storage_leaf')",(location,))
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1',0))
                    listen_port = sock.getsockname()[1]
                origin = f'http://127.0.0.1:{listen_port}'
                runtime = subprocess.Popen([str(runtime_root/'.venv/bin/python'),str(ROOT/'scripts/release_runtime.py'),'--store',str(store),'--runtime',str(runtime_root),'--port',str(listen_port)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                def status():
                    request = urllib.request.Request(origin+'/__release/status',headers={'x-release-key':env['RELEASE_CONTROL_KEY']})
                    with urllib.request.urlopen(request,timeout=2) as response:
                        return json.loads(response.read())['commit']
                for _ in range(100):
                    try:
                        initial = status()
                        self.assertIn(initial,(None,first))
                        break
                    except OSError:
                        time.sleep(.1)
                else:
                    self.fail('Local runtime did not start')
                base = [str(runtime_root/'.venv/bin/python'),str(ROOT/'scripts/release.py')]
                def switch(command,commit=None):
                    args = base+[command,'--store',str(store),'--runtime',str(runtime_root),'--runtime-url',origin]
                    if commit:
                        args += ['--commit',commit]
                    result = subprocess.run(args,env=env,capture_output=True)
                    self.assertEqual(result.returncode,0,result.stderr.decode())
                if initial is None:
                    switch('activate',first)
                self.assertEqual(status(),first)
                gate = subprocess.run(base+['gate','--commit',second,'--main-ref',os.environ.get('RELEASE_DRILL_MAIN_REF','refs/heads/codex/manual-release'),'--store',str(store),'--runtime',str(runtime_root),'--admin-url',admin],env=env,capture_output=True)
                self.assertEqual(gate.returncode,0,gate.stderr.decode())
                # Fault at the external runtime HTTP seam after real candidate application.
                # The release coordinator must restore the actual previous runtime and active record.
                from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
                import threading
                import urllib.error
                failure = {'pending':True}
                class FaultProxy(BaseHTTPRequestHandler):
                    def log_message(self,*args):
                        pass
                    def request(self):
                        if self.path == '/api/health' and failure['pending'] and status() == second:
                            failure['pending'] = False
                            self.send_response(503)
                            self.end_headers()
                            return
                        length = int(self.headers.get('Content-Length','0'))
                        body = self.rfile.read(length) if length else None
                        request = urllib.request.Request(origin+self.path,data=body,method=self.command,
                          headers={k:v for k,v in self.headers.items() if k.lower() not in ('host','connection')})
                        try:
                            response = urllib.request.urlopen(request,timeout=30)
                        except urllib.error.HTTPError as error:
                            response = error
                        with response:
                            self.send_response(response.status)
                            data = response.read()
                            self.send_header('Content-Length',str(len(data)))
                            self.end_headers()
                            self.wfile.write(data)
                    do_GET = request
                    do_POST = request
                proxy = ThreadingHTTPServer(('127.0.0.1',0),FaultProxy)
                thread = threading.Thread(target=proxy.serve_forever,daemon=True)
                thread.start()
                try:
                    proxy_origin = f'http://127.0.0.1:{proxy.server_port}'
                    failed = subprocess.run(base+['activate','--commit',second,'--store',str(store),'--runtime',str(runtime_root),'--runtime-url',proxy_origin],env=env,capture_output=True)
                    self.assertNotEqual(failed.returncode,0)
                    self.assertFalse(failure['pending'])
                    self.assertEqual(status(),first)
                    self.assertEqual((store/'active').resolve().name,first)
                finally:
                    proxy.shutdown()
                    proxy.server_close()
                    thread.join()
                switch('activate',second)
                self.assertEqual(status(),second)
                switch('rollback')
                self.assertEqual(status(),first)
                self.assertEqual((store/'active').resolve().name,first)
                with psycopg.connect(url) as conn:
                    self.assertEqual(conn.execute("SELECT id::text,name FROM location WHERE owner_id='release-proof'").fetchall(),[(location,'Unsorted')])
                asset = store/second/'dist/web/index.html'
                original = asset.read_bytes()
                try:
                    asset.chmod(0o600)
                    asset.write_bytes(b'tampered')
                    failed = subprocess.run(base+['activate','--commit',second,'--store',str(store),'--runtime-url',origin],env=env,capture_output=True)
                    self.assertNotEqual(failed.returncode,0)
                    self.assertEqual(status(),first)
                    self.assertEqual((store/'active').resolve().name,first)
                finally:
                    asset.write_bytes(original)
                    asset.chmod(0o444)
                report = {'scope':'real local auth/API/assets adapter and disposable database; no production provider',
                          'first_commit':first,'second_commit':second,'checks':['exact selected branch gate','candidate full CI','previous full CI on candidate schema','real runtime activate and protected/public/assets smoke','failed candidate smoke automatically restores previous runtime','successor activation','rollback without reversed migrations','private Location survives','tamper refusal preserves runtime/active'],
                          'migration_delta':'019_operations.sql and 020_signup.sql added in candidate; previous app CI passes against this schema; no reversal on rollback'}
                if os.environ.get('RELEASE_DRILL_REPORT'):
                    Path(os.environ['RELEASE_DRILL_REPORT']).write_text(json.dumps(report,indent=2))
            finally:
                if runtime:
                    runtime.terminate()
                    runtime.wait(timeout=15)
                with psycopg.connect(admin,autocommit=True) as conn:
                    conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))

    @unittest.skipUnless(os.environ.get('RELEASE_RUNTIME_FIXTURE_STORE'), 'existing real gated artifact fixture only')
    def test_adapter_rejects_missing_schema_and_stale_signup_release(self):
        import psycopg
        from psycopg import sql
        import secrets
        import socket
        import time
        import urllib.error
        import urllib.request
        from urllib.parse import urlsplit, urlunsplit
        import uuid
        store = Path(os.environ['RELEASE_RUNTIME_FIXTURE_STORE'])
        first = os.environ['RELEASE_DRILL_FIRST']
        second = os.environ['RELEASE_RUNTIME_FIXTURE_SECOND']
        runtime_root = Path(os.environ['RELEASE_DRILL_RUNTIME'])
        admin = os.environ['RECOVERY_TEST_DATABASE_URL']
        name = 'tcg_release_readiness_'+uuid.uuid4().hex
        url = urlunsplit(urlsplit(admin)._replace(path='/'+name))
        with tempfile.TemporaryDirectory() as temp:
            proof = Path(temp)/'deliberately-stale-synthetic-readiness.json'
            proof.write_text(json.dumps({'schemaVersion':1,'releaseCommit':'0'*40,
              'authorizedByOwner':True,'senderVerified':True,'recipientDeliveryVerified':True,
              'ownerWalkthroughVerified':True,'recoveryVerified':True,'privacyVerified':True,'capacityVerified':True,
              'evidence':'Synthetic rejection probe; no actual production proof'}))
            projection = Path(temp)/'public'
            projection.mkdir()
            env = {**os.environ,'DATABASE_URL':url,'PUBLIC_PROJECTION_DIR':str(projection),
                   'RELEASE_CONTROL_KEY':secrets.token_hex(32),'INTERNAL_AUTH_SECRET':secrets.token_hex(32),
                   'BETTER_AUTH_SECRET':secrets.token_hex(32),'OWNER_EMAIL':'owner@example.test',
                   'SIGNUP_MODE':'public','MAIL_MODE':'http','MAIL_HTTP_URL':'http://127.0.0.1:1',
                   'MAIL_HTTP_KEY':'synthetic-key','SIGNUP_READINESS_FILE':str(proof),'RELEASE_COMMIT':'0'*40}
            with psycopg.connect(admin,autocommit=True) as conn:
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
            runtime = None
            try:
                subprocess.run([str(runtime_root/'.venv/bin/python'),str(store/first/'scripts/migrate.py')],env=env,check=True,capture_output=True)
                subprocess.run([str(runtime_root/'.venv/bin/python'),str(store/first/'scripts/init_public_projection.py')],env=env,check=True,capture_output=True)
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1',0))
                    listen_port = sock.getsockname()[1]
                origin = f'http://127.0.0.1:{listen_port}'
                runtime = subprocess.Popen([str(runtime_root/'.venv/bin/python'),str(ROOT/'scripts/release_runtime.py'),'--store',str(store),'--runtime',str(runtime_root),'--port',str(listen_port)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                def request(path,body=None):
                    value = urllib.request.Request(origin+path,data=None if body is None else json.dumps(body).encode(),
                      headers={'x-release-key':env['RELEASE_CONTROL_KEY'],'Content-Type':'application/json'})
                    with urllib.request.urlopen(value,timeout=30) as response:
                        return json.loads(response.read())
                for _ in range(100):
                    try:
                        self.assertEqual(request('/__release/status')['commit'],first)
                        break
                    except OSError:
                        time.sleep(.1)
                else:
                    self.fail('Baseline runtime did not start')
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    request('/__release/apply',{'commit':second})
                self.assertEqual(failure.exception.code,503)
                failure.exception.close()
                self.assertEqual(request('/__release/status')['commit'],first)
                # After schema readiness is satisfied, inherited stale RELEASE_COMMIT must still
                # be replaced by the actual candidate commit, rejecting the fake readiness file.
                subprocess.run([str(runtime_root/'.venv/bin/python'),str(store/second/'scripts/migrate.py')],env=env,check=True,capture_output=True)
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    request('/__release/apply',{'commit':second})
                self.assertEqual(failure.exception.code,503)
                failure.exception.close()
                self.assertEqual(request('/__release/status')['commit'],first)
            finally:
                if runtime:
                    runtime.terminate()
                    runtime.wait(timeout=15)
                with psycopg.connect(admin,autocommit=True) as conn:
                    conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
