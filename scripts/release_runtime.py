"""Foreground local release adapter: private control, real auth/API/assets, no provider account."""
import argparse
import hmac
import json
import mimetypes
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request

from release import dependencies, runtime_fingerprint, verify
import socket


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        return sock.getsockname()[1]


class Runtime:
    def __init__(self,store,runtime,origin):
        self.store,self.runtime,self.origin = store,runtime,origin
        self.lock = threading.RLock()
        self.current = None

    def stop(self,bundle):
        if bundle:
            for process in bundle['processes']:
                process.terminate()
            for process in bundle['processes']:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            bundle['temp'].cleanup()

    def apply(self,commit):
        if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
            raise ValueError('Full release commit required')
        release = self.store/commit
        receipt = verify(release)
        if receipt['commit'] != commit:
            raise ValueError('Release identity mismatch')
        if receipt['runtime_fingerprint'] != runtime_fingerprint(self.runtime):
            raise ValueError('Installed runtime differs from gate')
        temp = tempfile.TemporaryDirectory(prefix='tcg-release-runtime-')
        checkout = Path(temp.name)/'app'
        processes = []
        bundle = {'temp':temp,'processes':processes,'commit':commit,'assets':checkout/'dist/web'}
        try:
            shutil.copytree(release,checkout)
            for path in [checkout,*checkout.rglob('*')]:
                path.chmod(0o700 if path.is_dir() else 0o600)
            dependencies(checkout,self.runtime)
            api_port,auth_port = port(),port()
            env = {**os.environ,'PYTHONPATH':str(checkout/'api'),'API_ORIGIN':f'http://127.0.0.1:{api_port}',
                   'AUTH_PORT':str(auth_port),'AUTH_HOST':'127.0.0.1','PUBLIC_ORIGIN':self.origin,'NODE_ENV':'development'}
            processes.append(subprocess.Popen([str(self.runtime/'.venv/bin/python'),'-m','uvicorn','app.main:app','--host','127.0.0.1','--port',str(api_port),'--no-access-log'],cwd=checkout,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            processes.append(subprocess.Popen(['node','--import','tsx','auth/src/server.ts'],cwd=checkout,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            bundle['auth'] = f'http://127.0.0.1:{auth_port}'
            for _ in range(100):
                if any(p.poll() is not None for p in processes):
                    raise ValueError('Candidate runtime failed')
                try:
                    with urllib.request.urlopen(bundle['auth']+'/api/health',timeout=.5) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(.1)
            else:
                raise ValueError('Candidate readiness timed out')
            # Keep old processes alive until the candidate is ready; caller runs full frontend smoke afterward.
            with self.lock:
                old,self.current = self.current,bundle
                self.stop(old)
            return commit
        except Exception:
            self.stop(bundle)
            raise


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):
        pass  # URLs may contain public tokens and private routes.

    def reply(self,status,body,content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.end_headers()
        self.wfile.write(body)

    def handle_request(self):
        runtime = self.server.runtime
        if self.path.startswith('/__release/'):
            if not hmac.compare_digest(self.headers.get('x-release-key',''),self.server.key):
                self.reply(404,b'{}')
                return
            try:
                if self.command == 'POST' and self.path == '/__release/apply':
                    length = int(self.headers.get('Content-Length','0'))
                    if not 0 < length <= 256:
                        raise ValueError('Invalid control payload')
                    body = json.loads(self.rfile.read(length))
                    commit = runtime.apply(body['commit'])
                    self.reply(200,json.dumps({'commit':commit}).encode())
                elif self.command == 'POST' and self.path == '/__release/clear':
                    with runtime.lock:
                        runtime.stop(runtime.current)
                        runtime.current = None
                    self.reply(200,b'{"commit":null}')
                elif self.command == 'GET' and self.path == '/__release/status':
                    with runtime.lock:
                        commit = runtime.current['commit'] if runtime.current else None
                    self.reply(200,json.dumps({'commit':commit,'runtime_fingerprint':runtime_fingerprint(runtime.runtime)}).encode())
                else:
                    self.reply(404,b'{}')
            except Exception:
                self.reply(503,b'{"error":"Local runtime application failed"}')
            return
        with runtime.lock:
            bundle = runtime.current
            if bundle is None:
                self.reply(503,b'{}')
                return
            if self.path.startswith(('/api/','/auth/')):
                length = int(self.headers.get('Content-Length','0'))
                body = self.rfile.read(length) if length else None
                headers = {k:v for k,v in self.headers.items() if k.lower() not in ('host','connection','x-release-key')}
                request = urllib.request.Request(bundle['auth']+self.path,data=body,headers=headers,method=self.command)
                try:
                    response = urllib.request.urlopen(request,timeout=30)
                except urllib.error.HTTPError as error:
                    response = error
                except OSError:
                    self.reply(503,b'{}')
                    return
                with response:
                    data = response.read()
                    self.send_response(response.status)
                    for key,value in response.headers.items():
                        if key.lower() not in ('connection','transfer-encoding','content-length'):
                            self.send_header(key,value)
                    self.send_header('Content-Length',str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                return
            if self.command != 'GET':
                self.reply(405,b'{}')
                return
            path = (bundle['assets']/self.path.split('?')[0].lstrip('/')).resolve()
            if bundle['assets'].resolve() not in path.parents:
                path = bundle['assets']/'index.html'
            elif not path.is_file():
                path = bundle['assets']/'index.html'
            self.reply(200,path.read_bytes(),mimetypes.guess_type(path.name)[0] or 'application/octet-stream')

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_PATCH = handle_request
    do_DELETE = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store',type=Path,required=True)
    parser.add_argument('--runtime',type=Path,required=True)
    parser.add_argument('--port',type=int,required=True)
    args = parser.parse_args()
    key = os.environ.get('RELEASE_CONTROL_KEY','')
    if len(key) < 32 or not os.environ.get('DATABASE_URL') or not os.environ.get('PUBLIC_PROJECTION_DIR'):
        parser.error('Private control key, database and public projection configuration required')
    def terminate(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM,terminate)
    server = ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    server.key = key
    server.runtime = Runtime(args.store.resolve(),args.runtime.resolve(),f'http://127.0.0.1:{args.port}')
    try:
        active = args.store/'active'
        if active.is_symlink():
            server.runtime.apply(active.resolve().name)
        server.serve_forever()
    finally:
        server.runtime.stop(server.runtime.current)
        server.server_close()

if __name__ == '__main__':
    main()
