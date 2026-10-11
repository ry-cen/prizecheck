"""Real transactional HTTP relay and independent-process fault fixtures.

Everything that knows the private on-disk layout of the filesystem adapter, or
injects faults at OS boundaries, lives here so conformance tests only assert
observable ordering through the public adapter API.
"""
from contextlib import contextmanager
import errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import time

from app.public_records import FilePublicRecords, HttpPublicRecords, OperationConflict, quote_key, result_key
from app.public_projection import ProjectionUnavailable

REF = 'c' * 48
STORE_OPTIONS = ('max_entries', 'max_bytes', 'operation_ttl', 'generation_retention', 'tombstone_ttl')


def backend_from_config(config):
    return FilePublicRecords(config['directory'], **{name: config[name] for name in STORE_OPTIONS if name in config})


def store_from_config(config, url=None):
    if config['adapter'] == 'http':
        return HttpPublicRecords(url or config['url'], 'conformance-secret')
    return backend_from_config(config)


# --- OS-boundary fault injection, toggled by marker files -------------------
def _fault_dir(config_or_directory):
    directory = config_or_directory['directory'] if isinstance(config_or_directory, dict) else config_or_directory
    return Path(directory) / 'faults'


def _active(directory, name):
    return (_fault_dir(directory) / name).exists()


_FAULTS = {'directory': None, 'active': set()}


def install_faults(directory, active=()):
    """Patch fsync/unlink/replace once in THIS process to honour fault markers.

    Relay processes poll marker files (they cannot share memory with the test);
    the test process uses the in-memory set so it pays no per-syscall stat.
    """
    _FAULTS['directory'] = directory
    _FAULTS['active'] = set(active)
    if getattr(os, '_records_faults_installed', False):
        return
    fsync, unlink, replace = os.fsync, os.unlink, os.replace

    def on(name):
        return name in _FAULTS['active'] or (_FAULTS['directory'] is not None and _active(_FAULTS['directory'], name))

    def faulty_fsync(descriptor):
        if on('enospc'):
            raise OSError(errno.ENOSPC, 'No space left on device')
        return fsync(descriptor)

    def faulty_unlink(path, *args, **kwargs):
        if '/records/' in str(path) and on('unlink-fails'):
            raise PermissionError(errno.EACCES, 'cleanup denied')
        return unlink(path, *args, **kwargs)

    def faulty_replace(source, destination, *args, **kwargs):
        result = replace(source, destination, *args, **kwargs)
        if str(destination).endswith('/records/current.json') and on('slow-pointer'):
            time.sleep(.4)
        return result

    os.fsync, os.unlink, os.replace = faulty_fsync, faulty_unlink, faulty_replace
    os._records_faults_installed = True


def fault_value(directory, name):
    """The text a fault marker carries (for example a delay in seconds), or None when the fault is off."""
    marker = _fault_dir(directory) / name
    return marker.read_text() if marker.exists() else None


@contextmanager
def fault(config, name, value=''):
    """Turn a fault on. ``value`` is stored in the marker file for relay faults that take a parameter
    (``delay-transact``: seconds to sleep inside the relay before executing a transact)."""
    if config['adapter'] == 'filesystem':
        install_faults(None, {name})
        try:
            yield
        finally:
            _FAULTS['active'] = set()
        return
    marker = _fault_dir(config) / name
    marker.parent.mkdir(exist_ok=True)
    marker.write_text(str(value))
    try:
        yield
    finally:
        marker.unlink()


# --- Private-layout helpers (filesystem adapter only) ------------------------
def _records_dir(config):
    return Path(config['directory']) / 'records'


def corrupt_pointer(config):
    (_records_dir(config) / 'current.json').write_text('{}')


def corrupt_generation(config, generation):
    path = _records_dir(config) / f'generation-{generation}.json'
    path.write_bytes(path.read_bytes().replace(b'"format":2', b'"format":0'))


def scramble_mtimes(config):
    """Coarse/identical timestamps: GC must not rely on mtime ordering."""
    for path in _records_dir(config).iterdir():
        os.utime(path, (1_000_000_000, 1_000_000_000))


def write_legacy_store(directory, rows):
    """A format-1 records store as written by the pre-ticket-03 checkpoint."""
    import hashlib
    from uuid import uuid4
    records = Path(directory) / 'records'
    records.mkdir(parents=True)
    entries = {}
    for key, value in rows.items():
        raw = json.dumps(value, separators=(',', ':')).encode()
        blob = hashlib.sha256(raw).hexdigest()
        (records / f'blob-{blob}.json').write_bytes(raw)
        entries[key] = {'version': uuid4().hex, 'blob': blob, 'size': len(raw), 'evictable': False, 'order': 1}
    generation = uuid4().hex
    raw = json.dumps({'format': 1, 'generation': generation, 'records': entries, 'operations': {}},
                     separators=(',', ':')).encode()
    digest = hashlib.sha256(raw).hexdigest()
    (records / f'generation-{generation}.json').write_bytes(raw)
    (records / f'generation-{generation}.sha256').write_text(digest)
    (records / 'current.json').write_text(json.dumps({'generation': generation, 'digest': digest}))
    (records / 'initialized').write_text('1')


def store_size(config):
    return sum(path.stat().st_size for path in _records_dir(config).iterdir() if path.is_file())


@contextmanager
def read_only_storage(config):
    directory = _records_dir(config)
    files = [path for path in directory.iterdir() if path.is_file()]
    for path in files:
        path.chmod(0o400)
    directory.chmod(0o500)
    try:
        yield
    finally:
        directory.chmod(0o700)
        for path in files:
            if path.exists():
                path.chmod(0o600)


# --- Independent processes ----------------------------------------------------
def race_writer(config, url, key, version, barrier, output):
    store = store_from_config(config, url)
    barrier.wait(timeout=5)
    output.put(store.compare_and_swap({key: version}, {key: {'winner': os.getpid()}}, deadline=time.monotonic() + 5))


def stale_writer(config, url, key, version, output):
    store = store_from_config(config, url)
    output.put(store.compare_and_swap({key: version}, {key: {'stale': True}}, deadline=time.monotonic() + 3))


def _pause_at_pointer(phase, reached):
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


def fault_writer(config, phase, reached):
    """Stop an independent writer at the actual OS atomic-pointer boundary."""
    if config['adapter'] == 'filesystem':
        _pause_at_pointer(phase, reached)
    store = store_from_config(config)
    keys = [result_key(REF, 1), quote_key(REF, 1)]
    old = store.read_records(keys, deadline=time.monotonic() + 3)
    store.compare_and_swap({key: record.version for key, record in old.records.items()},
        {result_key(REF, 1): {'state': 'absent'}, quote_key(REF, 1): None},
        deadline=time.monotonic() + 30, operation_id='terminal-absence')


def serve_relay(config, connection, phase=None, reached=None):
    """Reference relay: translates the HTTP contract onto the filesystem adapter."""
    store = backend_from_config(config)
    install_faults(config['directory'])
    if phase:
        _pause_at_pointer(phase, reached)
    connections = Path(config['directory']) / 'relay-connections.log'

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        # Headers and body go out as separate writes; with Nagle on, the body
        # waits ~40 ms for the client's delayed ACK on every response.
        disable_nagle_algorithm = True

        def log_message(self, *args):
            pass

        def _send(self, status, response):
            raw = json.dumps(response).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            if status == 200 and _active(config['directory'], 'slow-relay'):
                for chunk in [raw[:1], raw[1:2], raw[2:]]:
                    time.sleep(.04)
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        break
            else:
                self.wfile.write(raw)

        def do_POST(self):
            with connections.open('a') as log:
                log.write(f'{self.client_address[1]}\n')
            if self.headers.get('Authorization') != 'Bearer conformance-secret':
                self.send_error(401)
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                action = self.path.rsplit('/', 1)[-1]
                timeout_ms = body.get('timeout_ms')
                if type(timeout_ms) is not int or not 0 < timeout_ms <= 30_000:
                    self._send(400, {'error': 'invalid_timeout'})
                    return
                deadline = time.monotonic() + timeout_ms / 1000
                if action == 'initialize':
                    store.initialize(deadline=deadline)
                    response = {'initialized': True}
                elif action == 'read':
                    snapshot = store.read_records(body['keys'], generation=body['generation'], deadline=deadline)
                    response = {'generation': snapshot.generation, 'records': {key: {'version': row.version, 'value': row.value} for key, row in snapshot.records.items()}}
                    if _active(config['directory'], 'malformed-records'):
                        response['records'] = list(response['records'])
                elif action == 'status':
                    response = {'committed': store.operation_status(body['operation_id'], deadline=deadline)}
                elif action == 'transact':
                    delay = fault_value(config['directory'], 'delay-transact')
                    if delay:
                        time.sleep(float(delay))
                    response = {'committed': store.compare_and_swap(body['expected'], body['changes'], operation_id=body['operation_id'], deadline=deadline)}
                    if response['committed'] and 'admission:price:scheduler' in body['changes']:
                        with (Path(config['directory']) / 'scheduler-commits.log').open('a') as log:
                            log.write(json.dumps(body['changes']['admission:price:scheduler']) + '\n')
                    if body['operation_id'] == 'lost-response':
                        self.connection.shutdown(2)
                        self.connection.close()
                        return
                else:
                    self.send_error(404)
                    return
                self._send(200, response)
            except OperationConflict:
                self._send(409, {'error': 'operation_conflict'})
            except ValueError:
                self._send(400, {'error': 'invalid_request'})
            except (ProjectionUnavailable, KeyError, TypeError):
                self._send(503, {'error': 'unavailable'})

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    connection.send(server.server_port)
    connection.close()
    server.serve_forever()
