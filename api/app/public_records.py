"""Independent public-safe shared records; no publication manifest mutations.

read_records(keys, deadline=absolute_monotonic, generation=None) returns a
RecordSnapshot with <=128 Record(version, value) entries. Missing values are
None; versions survive deletion (ABA safe). read_all pins one generation across
chunks. compare_and_swap(expected, changes, deadline=..., operation_id=...) is
an atomic conditional transaction; None deletes. It returns False on conflict,
raises ProjectionUnavailable on uncertainty, and supports durable replay by ID.
Every changed key must have an expected version. Protected state is the default;
only quote:/payload: keys are evictable. Current-result, pending-result, negative
meaning, catalog, admission, fences and leases MUST use protected keys. A caller
must commit its pending result marker before source work; this boundary cannot
infer domain supersession from an arbitrary payload. An unresolved pending
marker suppresses the prior payload even when terminal persistence fails.

HTTP relay protocol: POST <manifest-url>/records/{initialize,read,transact,status}.
Authenticated read accepts keys and optional generation and returns generation,
records {key: {version, value}}. transact accepts expected, changes, operation_id
and returns {committed: bool}; status returns {committed: bool|null}. The relay
must implement these operations with this same linearizable/durable contract,
including capacity eviction, immutable generations, and operation deduplication.
Ordinary manifest PUT relays do not satisfy the protocol and fail closed.
"""
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from uuid import uuid4

from .public_projection import ProjectionUnavailable

MAX_BATCH = 128
MAX_ENTRIES = 250_000
MAX_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True)
class Record:
    version: str
    value: object


@dataclass(frozen=True)
class RecordSnapshot:
    generation: str
    records: dict[str, Record]


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProjectionUnavailable()
    return remaining


def _encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def _keys(keys):
    keys = list(keys)
    if len(keys) > MAX_BATCH or len(keys) != len(set(keys)):
        raise ValueError('record batches require at most 128 distinct keys')
    if any(not isinstance(key, str) or not key or len(key.encode()) > 512 for key in keys):
        raise ValueError('invalid public record key')
    return keys


def _transaction(expected, changes):
    _keys(set(expected) | set(changes))
    if not set(changes) <= set(expected):
        raise ValueError('every changed record requires an expected version')
    if any(not isinstance(version, str) or not version for version in expected.values()):
        raise ValueError('invalid record version')
    return hashlib.sha256(_encode({'expected': expected, 'changes': changes})).hexdigest()


def _operation_id(operation_id):
    if not isinstance(operation_id, str) or not operation_id or len(operation_id) > 128:
        raise ValueError('invalid operation ID')
    return operation_id


class _Records:
    def read_all(self, keys, *, deadline):
        """Complete row semantics at one pinned generation, including empty rows."""
        keys = list(dict.fromkeys(keys))
        generation = None
        records = {}
        for offset in range(0, max(1, len(keys)), MAX_BATCH):
            batch = self.read_records(keys[offset:offset + MAX_BATCH], deadline=deadline, generation=generation)
            generation = batch.generation
            records.update(batch.records)
        return RecordSnapshot(generation, records)

    def read_many(self, keys, *, deadline, snapshot=None):
        return self.read_records(keys, deadline=deadline, generation=snapshot)

    def transact(self, expected_versions, puts, deletes=(), *, deadline, operation_id):
        changes = dict(puts)
        changes.update({key: None for key in deletes})
        return self.compare_and_swap(expected_versions, changes, deadline=deadline, operation_id=operation_id)


class FilePublicRecords(_Records):
    def __init__(self, directory=None, *, max_entries=MAX_ENTRIES, max_bytes=MAX_BYTES):
        self.directory = Path(directory or os.environ.get('PUBLIC_PROJECTION_DIR', '.local/public-projections')).resolve() / 'records'
        self.pointer = self.directory / 'current.json'
        if not 0 <= max_entries <= MAX_ENTRIES or not 0 <= max_bytes <= MAX_BYTES:
            raise ValueError('invalid payload capacity')
        self.max_entries = max_entries
        self.max_bytes = max_bytes

    @contextmanager
    def _lock(self, deadline):
        try:
            _remaining(deadline)
            with (self.directory / 'writer.lock').open('a') as stream:
                while True:
                    _remaining(deadline)
                    try:
                        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        time.sleep(min(.005, _remaining(deadline)))
                try:
                    yield
                finally:
                    fcntl.flock(stream, fcntl.LOCK_UN)
        except (OSError, ValueError) as exc:
            raise ProjectionUnavailable() from exc

    def _atomic(self, path, content):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.directory, prefix='.pending-', delete=False) as stream:
                temporary = stream.name
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            temporary = None
            descriptor = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def initialize(self, *, deadline):
        """Only for a NEW store; never repairs corrupt/missing established state."""
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            with self._lock(deadline):
                if self.pointer.exists():
                    self._load(deadline)
                    return
                if (self.directory / 'initialized').exists() or any(self.directory.glob('generation-*.json')):
                    raise ProjectionUnavailable()
                generation = uuid4().hex
                state = {'format': 1, 'generation': generation, 'records': {}, 'operations': {}}
                self._publish(state, deadline)
                self._atomic(self.directory / 'initialized', b'1')
        except (OSError, ValueError) as exc:
            raise ProjectionUnavailable() from exc

    def _load(self, deadline, generation=None):
        _remaining(deadline)
        try:
            # Even pinned reads fail closed if the authoritative pointer is corrupt.
            pointer = json.loads(self.pointer.read_bytes())
            current = pointer['generation']
            if not isinstance(current, str) or len(current) != 32 or any(c not in '0123456789abcdef' for c in current):
                raise ProjectionUnavailable()
            generation = current if generation is None else generation
            if not isinstance(generation, str) or len(generation) != 32 or any(c not in '0123456789abcdef' for c in generation):
                raise ProjectionUnavailable()
            raw = (self.directory / ('generation-' + generation + '.json')).read_bytes()
            digest = (self.directory / ('generation-' + generation + '.sha256')).read_text()
            if hashlib.sha256(raw).hexdigest() != digest or (generation == current and digest != pointer['digest']):
                raise ProjectionUnavailable()
            state = json.loads(raw)
            if state.get('format') != 1 or state.get('generation') != generation or not isinstance(state.get('records'), dict) or not isinstance(state.get('operations'), dict):
                raise ProjectionUnavailable()
            _remaining(deadline)
            return state
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ProjectionUnavailable() from exc

    def _publish(self, state, deadline):
        raw = _encode(state)
        self._atomic(self.directory / ('generation-' + state['generation'] + '.json'), raw)
        self._atomic(self.directory / ('generation-' + state['generation'] + '.sha256'), hashlib.sha256(raw).hexdigest().encode())
        _remaining(deadline)
        self._atomic(self.pointer, _encode({'generation': state['generation'], 'digest': hashlib.sha256(raw).hexdigest()}))
        _remaining(deadline)

    def _collect(self, state):
        """Bound orphan/payload files; old pinned payloads fail closed on eviction.

        Keep eight recent immutable indexes plus deadline-pinned generations.
        Protected data referenced by those indexes remains available. Evictable
        payloads are retained only when referenced by the authoritative index,
        so the cap counts physical payloads rather than just live index rows.
        """
        current_blobs = {entry['blob'] for entry in state['records'].values() if entry['blob']}
        protected_blobs = {entry['blob'] for entry in state['records'].values() if entry['blob'] and not entry['evictable']}
        manifests = sorted(self.directory.glob('generation-*.json'), key=lambda path: path.stat().st_mtime_ns, reverse=True)
        pinned = set()
        for pin in self.directory.glob('pin-*.json'):
            try:
                if float(pin.read_text()) > time.time():
                    pinned.add(pin.name[4:-5])
                else:
                    pin.unlink(missing_ok=True)
            except (OSError, ValueError):
                pin.unlink(missing_ok=True)
        retained_manifests = [manifest for index, manifest in enumerate(manifests)
            if index < 8 or manifest.name[11:-5] in pinned]
        for manifest in retained_manifests:
            try:
                old = json.loads(manifest.read_bytes())
                protected_blobs.update(entry['blob'] for entry in old['records'].values() if entry['blob'] and not entry['evictable'])
            except (OSError, ValueError, KeyError, TypeError):
                # Corrupt history is never considered a source of records.
                continue
        for manifest in manifests:
            if manifest in retained_manifests:
                continue
            manifest.unlink(missing_ok=True)
            manifest.with_suffix('.sha256').unlink(missing_ok=True)
        retained = current_blobs | protected_blobs
        for blob in self.directory.glob('blob-*.json'):
            if blob.name[5:-5] not in retained:
                blob.unlink(missing_ok=True)

    def read_records(self, keys, *, deadline, generation=None):
        keys = _keys(keys)
        with self._lock(deadline):
            state = self._load(deadline)
            self._collect(state)
            result = self._read_records(keys, deadline=deadline, generation=generation)
            pin = self.directory / ('pin-' + result.generation + '.json')
            expires = time.time() + _remaining(deadline)
            previous = float(pin.read_text()) if pin.exists() else 0
            if expires > previous:
                self._atomic(pin, str(expires).encode())
            _remaining(deadline)
            return result

    def _read_records(self, keys, *, deadline, generation=None):
        keys = _keys(keys)
        state = self._load(deadline, generation)
        records = {}
        try:
            for key in keys:
                entry = state['records'].get(key)
                if entry is None:
                    records[key] = Record('missing', None)
                    continue
                blob = entry['blob']
                value = None
                if blob is not None:
                    if not isinstance(blob, str) or len(blob) != 64 or any(c not in '0123456789abcdef' for c in blob):
                        raise ProjectionUnavailable()
                    raw = (self.directory / ('blob-' + blob + '.json')).read_bytes()
                    if hashlib.sha256(raw).hexdigest() != blob:
                        raise ProjectionUnavailable()
                    value = json.loads(raw)
                records[key] = Record(entry['version'], value)
                _remaining(deadline)
            return RecordSnapshot(state['generation'], records)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ProjectionUnavailable() from exc

    def operation_status(self, operation_id, *, deadline):
        operation = self._load(deadline)['operations'].get(_operation_id(operation_id))
        return None if operation is None else operation['committed']

    def compare_and_swap(self, expected, changes, *, deadline, operation_id=None):
        fingerprint = _transaction(expected, changes)
        operation_id = _operation_id(operation_id or uuid4().hex)
        try:
            with self._lock(deadline):
                state = self._load(deadline)
                prior = state['operations'].get(operation_id)
                if prior:
                    if prior['fingerprint'] != fingerprint:
                        raise ValueError('operation ID reused for another transaction')
                    return prior['committed']
                committed = all(state['records'].get(key, {'version': 'missing'})['version'] == version for key, version in expected.items())
                if committed:
                    generation = uuid4().hex
                    for key, value in changes.items():
                        blob = None
                        size = 0
                        if value is not None:
                            raw = _encode(value)
                            size = len(raw)
                            blob = hashlib.sha256(raw).hexdigest()
                            path = self.directory / ('blob-' + blob + '.json')
                            if not path.exists():
                                self._atomic(path, raw)
                        state['records'][key] = {'version': uuid4().hex, 'blob': blob, 'size': size,
                            'evictable': key.startswith(('quote:', 'payload:')), 'order': time.time_ns()}
                    payloads = sorted(((entry['order'], key, entry) for key, entry in state['records'].items()
                        if entry['evictable'] and entry['blob'] is not None))
                    count = len(payloads)
                    size = sum(entry['size'] for _, _, entry in payloads)
                    for _, key, entry in payloads:
                        if count <= self.max_entries and size <= self.max_bytes:
                            break
                        size -= entry['size']
                        count -= 1
                        # Eviction is a new tombstone version: stale readers cannot CAS.
                        state['records'][key] = {**entry, 'version': uuid4().hex, 'blob': None, 'size': 0}
                    state['generation'] = generation
                else:
                    state['generation'] = uuid4().hex
                state['operations'][operation_id] = {'fingerprint': fingerprint, 'committed': committed}
                self._publish(state, deadline)
                self._collect(state)
                return committed
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ProjectionUnavailable() from exc


class HttpPublicRecords(_Records):
    def __init__(self, url=None, token=None):
        from urllib.parse import urlsplit
        self.url = (url or os.environ.get('PUBLIC_PROJECTION_URL', '')).rstrip('/') + '/records'
        self.token = token or os.environ.get('PUBLIC_PROJECTION_TOKEN', '')
        parsed = urlsplit(self.url)
        local = parsed.hostname in ('localhost', '127.0.0.1', '::1')
        if not self.token or parsed.username or parsed.password or parsed.fragment or parsed.query or not (
            parsed.scheme == 'https' or (parsed.scheme == 'http' and local and os.environ.get('NODE_ENV') != 'production')
        ):
            raise ProjectionUnavailable()

    def _request(self, action, body, deadline):
        import asyncio
        import httpx

        async def request():
            async with httpx.AsyncClient(timeout=_remaining(deadline), follow_redirects=False, trust_env=False) as client:
                async with client.stream('POST', self.url + '/' + action, json=body,
                        headers={'Authorization': 'Bearer ' + self.token, 'Cache-Control': 'no-cache, no-store'}) as response:
                    if response.status_code != 200:
                        raise ProjectionUnavailable()
                    chunks = []
                    size = 0
                    async for chunk in response.aiter_bytes():
                        _remaining(deadline)
                        size += len(chunk)
                        if size > MAX_BYTES + 1024 * 1024:
                            raise ProjectionUnavailable()
                        chunks.append(chunk)
                    _remaining(deadline)
                    return json.loads(b''.join(chunks))

        async def bounded():
            remaining = _remaining(deadline)
            return await asyncio.wait_for(request(), timeout=remaining)

        try:
            # Synchronous adapter methods run on the API's worker thread. Reject
            # accidental event-loop blocking rather than extending its deadline.
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                pass
            else:
                raise ProjectionUnavailable()
            return asyncio.run(bounded())
        except (TimeoutError, httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            raise ProjectionUnavailable() from exc

    def initialize(self, *, deadline):
        if self._request('initialize', {}, deadline) != {'initialized': True}:
            raise ProjectionUnavailable()

    def read_records(self, keys, *, deadline, generation=None):
        keys = _keys(keys)
        response = self._request('read', {'keys': keys, 'generation': generation}, deadline)
        try:
            if not isinstance(response['generation'], str) or set(response['records']) != set(keys) or (generation is not None and response['generation'] != generation):
                raise ProjectionUnavailable()
            records = {}
            for key, record in response['records'].items():
                if not isinstance(record['version'], str) or not record['version']:
                    raise ProjectionUnavailable()
                records[key] = Record(record['version'], record['value'])
            return RecordSnapshot(response['generation'], records)
        except (KeyError, TypeError, ValueError) as exc:
            raise ProjectionUnavailable() from exc

    def compare_and_swap(self, expected, changes, *, deadline, operation_id=None):
        _transaction(expected, changes)
        response = self._request('transact', {'expected': expected, 'changes': changes,
            'operation_id': _operation_id(operation_id or uuid4().hex)}, deadline)
        if not isinstance(response, dict) or type(response.get('committed')) is not bool:
            raise ProjectionUnavailable()
        return response['committed']

    def operation_status(self, operation_id, *, deadline):
        response = self._request('status', {'operation_id': _operation_id(operation_id)}, deadline)
        if not isinstance(response, dict) or 'committed' not in response or (response['committed'] is not None and type(response['committed']) is not bool):
            raise ProjectionUnavailable()
        return response['committed']


def public_record_store():
    adapter = os.environ.get('PUBLIC_PROJECTION_ADAPTER', 'filesystem')
    if adapter == 'filesystem':
        return FilePublicRecords()
    if adapter == 'http':
        return HttpPublicRecords()
    raise ProjectionUnavailable()
