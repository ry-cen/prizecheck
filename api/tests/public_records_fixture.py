"""Real transactional HTTP relay and independent-process fault fixtures."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import time

from app.public_records import FilePublicRecords, HttpPublicRecords
from app.public_projection import ProjectionUnavailable


def store_from_config(config):
    if config['adapter'] == 'http':
        return HttpPublicRecords(config['url'], 'conformance-secret')
    return FilePublicRecords(config['directory'], max_entries=config.get('max_entries', 250_000), max_bytes=config.get('max_bytes', 256 * 1024 * 1024))


def race_writer(config, key, version, barrier, output):
    store = store_from_config(config)
    barrier.wait(timeout=5)
    output.put(store.compare_and_swap({key: version}, {key: {'winner': os.getpid()}}, deadline=time.monotonic() + 3))


def fault_writer(config, phase, reached):
    """Stop an independent writer at the actual OS atomic-pointer boundary."""
    original = os.replace
    def replace(source, destination):
        is_pointer = str(destination).endswith('/records/current.json')
        if is_pointer and phase == 'before':
            reached.set()
            time.sleep(20)
        original(source, destination)
        if is_pointer and phase == 'after':
            reached.set()
            time.sleep(20)
    os.replace = replace
    store = store_from_config(config)
    old = store.read_records(['result:edition', 'quote:edition'], deadline=time.monotonic() + 3)
    store.compare_and_swap({key: record.version for key, record in old.records.items()},
        {'result:edition': {'state': 'absent'}, 'quote:edition': None},
        deadline=time.monotonic() + 30, operation_id='terminal-absence')


def serve_relay(config, connection, phase=None, reached=None):
    store = FilePublicRecords(config['directory'], max_entries=config.get('max_entries', 250_000), max_bytes=config.get('max_bytes', 256 * 1024 * 1024))
    if phase:
        original = os.replace
        def replace(source, destination):
            is_pointer = str(destination).endswith('/records/current.json')
            if is_pointer and phase == 'before':
                reached.set(); time.sleep(20)
            original(source, destination)
            if is_pointer and phase == 'after':
                reached.set(); time.sleep(20)
        os.replace = replace
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            if self.headers.get('Authorization') != 'Bearer conformance-secret':
                self.send_error(401); return
            try:
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                action = self.path.rsplit('/', 1)[-1]
                deadline = time.monotonic() + 3
                if action == 'initialize':
                    store.initialize(deadline=deadline); response = {'initialized': True}
                elif action == 'read':
                    snapshot = store.read_records(body['keys'], generation=body['generation'], deadline=deadline)
                    response = {'generation': snapshot.generation, 'records': {key: {'version': row.version, 'value': row.value} for key, row in snapshot.records.items()}}
                elif action == 'status':
                    response = {'committed': store.operation_status(body['operation_id'], deadline=deadline)}
                elif action == 'transact':
                    response = {'committed': store.compare_and_swap(body['expected'], body['changes'], operation_id=body['operation_id'], deadline=deadline)}
                    if body['operation_id'] == 'lost-response':
                        self.connection.shutdown(2); self.connection.close(); return
                else:
                    self.send_error(404); return
                raw = json.dumps(response).encode()
                self.send_response(200); self.send_header('Content-Length', str(len(raw))); self.end_headers()
                from pathlib import Path
                if (Path(config['directory']) / 'slow-relay').exists():
                    for chunk in [raw[:1], raw[1:2], raw[2:]]:
                        time.sleep(.04)
                        try:
                            self.wfile.write(chunk); self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            break
                else:
                    self.wfile.write(raw)
            except (ProjectionUnavailable, ValueError, KeyError):
                self.send_error(503)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    connection.send(server.server_port)
    connection.close()
    server.serve_forever()
