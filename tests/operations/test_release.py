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
                        self.assertIsNone(status())
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
                switch('activate',first)
                self.assertEqual(status(),first)
                gate = subprocess.run(base+['gate','--commit',second,'--main-ref','refs/heads/codex/manual-release','--store',str(store),'--runtime',str(runtime_root),'--admin-url',admin],env=env,capture_output=True)
                self.assertEqual(gate.returncode,0,gate.stderr.decode())
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
                          'first_commit':first,'second_commit':second,'checks':['exact selected branch gate','candidate full CI','previous full CI on candidate schema','real runtime activate and protected/public/assets smoke','successor activation','rollback without reversed migrations','private Location survives','tamper refusal preserves runtime/active'],
                          'migration_delta':'none between these two application releases; real deployed schema upgrades remain separate proof'}
                if os.environ.get('RELEASE_DRILL_REPORT'):
                    Path(os.environ['RELEASE_DRILL_REPORT']).write_text(json.dumps(report,indent=2))
            finally:
                if runtime:
                    runtime.terminate()
                    runtime.wait(timeout=15)
                with psycopg.connect(admin,autocommit=True) as conn:
                    conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
