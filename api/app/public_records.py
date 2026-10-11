"""Independent public-safe shared records; never mutates publication/discovery.

Keys are typed (see ``key_family``): catalog Printing/Edition metadata,
quarantine, and -- keyed by public Edition reference plus mapping revision --
quote payloads, current-result/supersession markers, fences and coalesced
in-flight work; plus admission, lease and backoff scopes. Only ``quote`` payloads are evictable; every other family is protected
and never counted against or removed by payload capacity.

Store API (both adapters; every call takes the caller's absolute monotonic
``deadline`` and never extends it):

* ``read_records(keys, deadline=, generation=None)`` -> ``RecordSnapshot`` for
  <=128 distinct keys. Every key is present; a missing/deleted/evicted value is
  ``Record(version, None)``. Versions are opaque and never repeat for a key, so
  delete/recreate and tombstone compaction cannot satisfy a stale expectation.
  Reads are lock-free and never write storage. ``generation`` pins a snapshot
  that remains readable for ``generation_retention`` seconds after it was
  superseded; afterwards (or if corrupt/unknown) the read fails closed.
* ``read_all(keys, deadline=)`` chunks any number of keys at one pinned
  generation, preserving complete all-row semantics.
* ``compare_and_swap(expected, changes, deadline=, operation_id=None)`` is one
  linearizable conditional transaction over <=128 keys. Every changed key needs
  an expected version; ``None`` deletes. Returns True when committed, False on
  version conflict (a failed CAS publishes nothing). ProjectionUnavailable means
  the outcome is unknown: resolve it with ``operation_status`` or by re-reading.
  Reusing an operation ID for different content raises ``OperationConflict``
  (a programming error).
* ``operation_status(operation_id, deadline=)`` -> True if that explicit
  operation ID committed within ``operation_ttl`` seconds, else None (unknown:
  re-read the records). Failed CAS attempts are not logged.
* ``quote_states(store, [(edition_ref, mapping_revision)], deadline=)`` reads
  result marker plus quote payload at one generation: a pending marker
  suppresses the payload, absence supersedes it, an evicted/mismatched payload
  is unknown, and no other mapping revision is ever consulted.

Filesystem layout (private): ``records/current.json`` is the atomic pointer to
an immutable content-addressed generation manifest. The index is sharded into
64 pages x 64 segments of immutable content-addressed objects, so a commit
rewrites only the touched segments/pages plus a small manifest, not the index.
Writers serialize on a shared flock; garbage collection is write-side,
amortised, best-effort, and always keeps the pointer's generation and every
generation superseded less than ``generation_retention`` seconds ago.

HTTP relay protocol: see docs/http-public-projection.md.
"""
from collections import OrderedDict
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import threading
import time
from uuid import uuid4

from .public_projection import ProjectionUnavailable

MAX_BATCH = 128
MAX_ENTRIES = 250_000
MAX_BYTES = 256 * 1024 * 1024
MAX_VALUE_BYTES = 1024 * 1024
OPERATION_TTL = 120.0          # >= 60 s job lifetime plus margin.
GENERATION_RETENTION = 15.0    # Pin window for pinned/chunked reads (5x the 3 s budget).
TOMBSTONE_TTL = 600.0
FORMAT = 2
PAGES = 64
SLOTS = 64
QUEUE_CHUNK = 512
COMPACT_BUDGET = 256
GC_INTERVAL = 16
GC_MAX_AGE = 60.0
GC_MAX_UNLINKS = 4096
_HEX64 = re.compile(r'[0-9a-f]{64}')


class OperationConflict(ValueError):
    """An operation ID was reused for a different transaction."""


@dataclass(frozen=True)
class Record:
    version: str
    value: object


@dataclass(frozen=True)
class RecordSnapshot:
    generation: str
    records: dict[str, Record]


@dataclass(frozen=True)
class QuoteState:
    status: str          # 'quote' | 'absent' | 'pending' | 'unknown' | 'invalid' (this row's records are malformed)
    result: object       # Current-result marker value, or None.
    quote: object        # Usable quote payload only when status == 'quote'.
    generation: str


# --- Typed key families ---------------------------------------------------------
_SCOPE = re.compile(r'[A-Za-z0-9_.:-]{1,200}')
_REF = re.compile(r'[0-9a-f]{48}')
MAX_REVISION = 2 ** 63 - 1


@dataclass(frozen=True)
class KeyFamily:
    name: str
    evictable: bool


# Protected vs evictable is decided by family, never by caller. Only quote
# payloads are evictable; every marker/metadata/coordination family is protected.
_FAMILIES = (
    ('catalog_printing', re.compile(r'catalog:printing:([0-9a-f]{48})'), False),
    ('catalog_edition', re.compile(r'catalog:edition:([0-9a-f]{48})'), False),
    ('quarantine', re.compile(r'quarantine:edition:([0-9a-f]{48})'), False),
    ('quote', re.compile(r'quote:([0-9a-f]{48}):([1-9][0-9]{0,18})'), True),
    ('result', re.compile(r'result:([0-9a-f]{48}):([1-9][0-9]{0,18})'), False),
    ('fence', re.compile(r'fence:([0-9a-f]{48}):([1-9][0-9]{0,18})'), False),
    ('work', re.compile(r'work:([0-9a-f]{48}):([1-9][0-9]{0,18})'), False),
    ('admission', re.compile(r'admission:([A-Za-z0-9_.:-]{1,200})'), False),
    ('lease', re.compile(r'lease:([A-Za-z0-9_.:-]{1,200})'), False),
    ('backoff', re.compile(r'backoff:([A-Za-z0-9_.:-]{1,200})'), False),
)
_REVISIONED = ('quote', 'result', 'fence', 'work')


def key_family(key):
    """Classify a record key; raises ValueError for untyped/malformed keys."""
    if isinstance(key, str):
        for name, pattern, evictable in _FAMILIES:
            match = pattern.fullmatch(key)
            if match and (name not in _REVISIONED or int(match.group(2)) <= MAX_REVISION):
                return KeyFamily(name, evictable)
    raise ValueError('untyped or malformed public record key')


def _ref(ref):
    if not isinstance(ref, str) or not _REF.fullmatch(ref):
        raise ValueError('invalid public reference')
    return ref


def _revision(revision):
    if type(revision) is not int or not 0 < revision <= MAX_REVISION:
        raise ValueError('invalid mapping revision')
    return str(revision)


def _scope(scope):
    if not isinstance(scope, str) or not _SCOPE.fullmatch(scope):
        raise ValueError('invalid coordination scope')
    return scope


def catalog_printing_key(printing_ref):
    return 'catalog:printing:' + _ref(printing_ref)


def catalog_edition_key(edition_ref):
    return 'catalog:edition:' + _ref(edition_ref)


def quarantine_key(edition_ref):
    return 'quarantine:edition:' + _ref(edition_ref)


def quote_key(edition_ref, mapping_revision):
    return 'quote:' + _ref(edition_ref) + ':' + _revision(mapping_revision)


def result_key(edition_ref, mapping_revision):
    return 'result:' + _ref(edition_ref) + ':' + _revision(mapping_revision)


def fence_key(edition_ref, mapping_revision):
    return 'fence:' + _ref(edition_ref) + ':' + _revision(mapping_revision)


def work_key(edition_ref, mapping_revision):
    """In-flight source work for one Edition/mapping revision (coalescing)."""
    return 'work:' + _ref(edition_ref) + ':' + _revision(mapping_revision)


def admission_key(scope):
    return 'admission:' + _scope(scope)


def lease_key(scope):
    return 'lease:' + _scope(scope)


def backoff_key(scope):
    return 'backoff:' + _scope(scope)


# --- Validation helpers -----------------------------------------------------------
def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProjectionUnavailable()
    return remaining


def _encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False, sort_keys=True).encode()


def _keys(keys):
    keys = list(keys)
    if len(keys) > MAX_BATCH or len(keys) != len(set(keys)):
        raise ValueError('record batches require at most 128 distinct keys')
    for key in keys:
        key_family(key)
    return keys


def _transaction(expected, changes):
    if not isinstance(expected, dict) or not isinstance(changes, dict):
        raise ValueError('expected and changes must be mappings')
    _keys(set(expected) | set(changes))
    if not set(changes) <= set(expected):
        raise ValueError('every changed record requires an expected version')
    if any(not isinstance(version, str) or not 0 < len(version) <= 128 for version in expected.values()):
        raise ValueError('invalid record version')
    if any(value is not None and len(_encode(value)) > MAX_VALUE_BYTES for value in changes.values()):
        raise ValueError('record value too large')
    return hashlib.sha256(_encode({'expected': expected, 'changes': changes})).hexdigest()


def _operation_id(operation_id):
    if not isinstance(operation_id, str) or not 0 < len(operation_id) <= 128:
        raise ValueError('invalid operation ID')
    return operation_id


def _shard(key):
    shard = int.from_bytes(hashlib.sha256(key.encode()).digest()[:2], 'big') % (PAGES * SLOTS)
    return divmod(shard, SLOTS)


def _positive(value, name, allow_zero=True):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
            or value < 0 or (value == 0 and not allow_zero):
        raise ValueError('invalid ' + name)
    return value


# --- Per-process cache of verified immutable objects ------------------------------
# Objects are content-addressed, so a verified parse can be shared across store
# instances and directories. Callers must treat cached values as read-only.
_CACHE = OrderedDict()
_CACHE_LIMIT = 64 * 1024 * 1024
_cache_lock = threading.Lock()
_cache_bytes = 0


def _cache_get(digest):
    with _cache_lock:
        item = _CACHE.get(digest)
        if item is not None:
            _CACHE.move_to_end(digest)
            return item[0]
    return None


def _cache_put(digest, value, size):
    global _cache_bytes
    with _cache_lock:
        if digest in _CACHE or size > _CACHE_LIMIT // 8:
            return
        _CACHE[digest] = (value, size)
        _cache_bytes += size
        while _cache_bytes > _CACHE_LIMIT:
            _, (_, evicted) = _CACHE.popitem(last=False)
            _cache_bytes -= evicted


def _clear_cache():
    global _cache_bytes
    with _cache_lock:
        _CACHE.clear()
        _cache_bytes = 0


# --- Shared adapter behaviour -------------------------------------------------------
class _Records:
    def read_all(self, keys, *, deadline, generation=None):
        """Complete row semantics at one pinned generation, including empty rows.

        ``generation`` starts the read at an already-pinned snapshot so several reads share it.
        """
        keys = list(dict.fromkeys(keys))
        rows = {}
        for offset in range(0, max(1, len(keys)), MAX_BATCH):
            batch = self.read_records(keys[offset:offset + MAX_BATCH], deadline=deadline, generation=generation)
            generation = batch.generation
            rows.update(batch.records)
        return RecordSnapshot(generation, rows)

    def read_many(self, keys, *, deadline, snapshot=None):
        return self.read_records(keys, deadline=deadline, generation=snapshot)

    def transact(self, expected_versions, puts, deletes=(), *, deadline, operation_id):
        changes = dict(puts)
        changes.update({key: None for key in deletes})
        return self.compare_and_swap(expected_versions, changes, deadline=deadline, operation_id=operation_id)


class _Transaction:
    """Copy-on-write view of one generation; mutated only by a locked writer."""

    def __init__(self, store, manifest, now, deadline):
        self.store = store
        self.now = now
        self.deadline = deadline
        self.pages = list(manifest['pages'])
        self.page_slots = {}
        self.segments = {}
        self.dirty = set()
        self.count = manifest['evictable']['count']
        self.bytes = manifest['evictable']['bytes']
        queue = manifest['queue']
        self.queue_index = queue['index']
        self.loaded_chunks = None
        self.head = queue['head']
        self.items = queue['items']
        self.cursor = queue['cursor']
        self.released = set()

    @property
    def chunks(self):
        # The queue index is only needed by writers; readers never load it.
        if self.loaded_chunks is None:
            digests = [] if self.queue_index is None else self.store._object(self.queue_index, 'queue-index', self.deadline)['chunks']
            self.loaded_chunks = [{'digest': digest, 'items': None} for digest in digests]
        return self.loaded_chunks

    # Index access -------------------------------------------------------------
    def _slots(self, page):
        if page not in self.page_slots:
            digest = self.pages[page]
            self.page_slots[page] = [None] * SLOTS if digest is None else list(
                self.store._object(digest, 'page', self.deadline)['segments'])
        return self.page_slots[page]

    def _segment(self, shard):
        if shard not in self.segments:
            digest = self._slots(shard[0])[shard[1]]
            if digest is None:
                self.segments[shard] = {'absent': 0, 'entries': {}, 'copied': True}
            else:
                segment = self.store._object(digest, 'segment', self.deadline)
                self.segments[shard] = {'absent': segment['absent'], 'entries': segment['entries'], 'copied': False}
        return self.segments[shard]

    def entry(self, key):
        return self._segment(_shard(key))['entries'].get(key)

    def version(self, key):
        entry = self.entry(key)
        return entry['v'] if entry is not None else 'absent-' + str(self._segment(_shard(key))['absent'])

    def _set(self, key, entry):
        shard = _shard(key)
        segment = self._segment(shard)
        if not segment['copied']:
            segment['entries'] = dict(segment['entries'])
            segment['copied'] = True
        segment['entries'][key] = entry
        self.dirty.add(shard)

    # Mutation -------------------------------------------------------------------
    def put(self, key, value):
        evictable = key_family(key).evictable
        old = self.entry(key)
        if evictable and old is not None and 'd' in old:
            self.count -= 1
            self.bytes -= old['s']
        version = uuid4().hex
        if value is None:
            self._set(key, {'v': version, 't': self.now})
            return
        entry = {'v': version, 'd': deepcopy(value)}  # Never alias caller-owned values.
        if evictable:
            entry['s'] = len(_encode(value))
            self.count += 1
            self.bytes += entry['s']
            self._append([key, version])
        self._set(key, entry)

    def _live(self, item):
        entry = self.entry(item[0])
        return entry is not None and entry['v'] == item[1] and 'd' in entry

    def _chunk(self, index):
        chunk = self.chunks[index]
        if chunk['items'] is None:
            chunk['items'] = list(self.store._object(chunk['digest'], 'queue', self.deadline)['items'])
        return chunk['items']

    def _append(self, item):
        if not self.chunks or len(self._chunk(-1)) >= QUEUE_CHUNK:
            self.chunks.append({'digest': None, 'items': []})
        self._chunk(-1).append(item)
        self.chunks[-1]['digest'] = None
        self.items += 1

    def _pop(self):
        while self.chunks:
            items = self._chunk(0)
            if self.head < len(items):
                item = items[self.head]
                self.head += 1
                self.items -= 1
                return item
            self.chunks.pop(0)
            self.head = 0
            self.cursor = max(0, self.cursor - 1)
        return None

    def enforce_capacity(self):
        """Evict oldest payloads; eviction is a new tombstone version (never fallback)."""
        while self.count > self.store.max_entries or self.bytes > self.store.max_bytes:
            item = self._pop()
            if item is None:
                raise ValueError('payload accounting is inconsistent')
            if self._live(item):
                entry = self.entry(item[0])
                self.count -= 1
                self.bytes -= entry['s']
                self._set(item[0], {'v': uuid4().hex, 't': self.now})
        if self.chunks and self.head >= QUEUE_CHUNK // 2:
            # Drop consumed head items so the chunk does not retain them.
            self.chunks[0] = {'digest': None, 'items': self._chunk(0)[self.head:]}
            self.head = 0

    def compact_queue(self):
        """Bounded incremental removal of superseded queue items, preserving order."""
        if self.items <= 2 * self.count + 2 * QUEUE_CHUNK or not self.chunks:
            return
        budget = COMPACT_BUDGET
        if self.cursor >= len(self.chunks):
            self.cursor = 0
        while budget > 0 and self.cursor < len(self.chunks):
            index = self.cursor
            items = self._chunk(index)
            start = self.head if index == 0 else 0
            kept = items[:start] + [item for item in items[start:] if self._live(item)]
            budget -= len(items) - start
            self.items -= len(items) - len(kept)
            # Merge with the following chunk when both fit, bounding chunk count.
            if index + 1 < len(self.chunks) and len(kept) + len(self._chunk(index + 1)) <= QUEUE_CHUNK:
                kept += self._chunk(index + 1)
                self.chunks.pop(index + 1)
            self.chunks[index] = {'digest': None, 'items': kept}
            if not kept and index > 0:
                self.chunks.pop(index)
            else:
                self.cursor += 1
        if self.cursor >= len(self.chunks):
            self.cursor = 0

    # Persistence ----------------------------------------------------------------
    def write(self, writer):
        horizon = self.now - self.store.tombstone_ttl
        for shard in sorted(self.dirty):
            old = self._slots(shard[0])[shard[1]]
            segment = self.segments[shard]
            entries = segment['entries']
            expired = [key for key, entry in entries.items() if 'd' not in entry and entry['t'] < horizon]
            if expired:
                for key in expired:
                    del entries[key]
                # A new absent epoch keeps every earlier version of these keys stale.
                segment['absent'] += 1
            self._slots(shard[0])[shard[1]] = writer({'kind': 'segment', 'absent': segment['absent'], 'entries': entries})
            self.released.add(old)
        for page in sorted({shard[0] for shard in self.dirty}):
            self.released.add(self.pages[page])
            self.pages[page] = writer({'kind': 'page', 'segments': self.page_slots[page]})
        index = self.queue_index
        if self.loaded_chunks is not None:
            before = {chunk['digest'] for chunk in self.loaded_chunks}
            for chunk in self.loaded_chunks:
                if chunk['digest'] is None:
                    chunk['digest'] = writer({'kind': 'queue', 'items': chunk['items']})
            after = [chunk['digest'] for chunk in self.loaded_chunks]
            self.released.update(before - set(after))
            index = writer({'kind': 'queue-index', 'chunks': after}) if after else None
            if index != self.queue_index:
                self.released.add(self.queue_index)
        return {
            'pages': self.pages,
            'evictable': {'count': self.count, 'bytes': self.bytes},
            'queue': {'index': index, 'head': self.head, 'items': self.items, 'cursor': self.cursor},
        }


class FilePublicRecords(_Records):
    def __init__(self, directory=None, *, max_entries=MAX_ENTRIES, max_bytes=MAX_BYTES,
                 operation_ttl=OPERATION_TTL, generation_retention=GENERATION_RETENTION, tombstone_ttl=TOMBSTONE_TTL):
        self.directory = Path(directory or os.environ.get('PUBLIC_PROJECTION_DIR', '.local/public-projections')).resolve() / 'records'
        self.pointer = self.directory / 'current.json'
        if type(max_entries) is not int or not 0 <= max_entries <= MAX_ENTRIES \
                or type(max_bytes) is not int or not 0 <= max_bytes <= MAX_BYTES:
            raise ValueError('invalid payload capacity')
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.operation_ttl = _positive(operation_ttl, 'operation TTL', allow_zero=False)
        self.generation_retention = _positive(generation_retention, 'generation retention')
        self.tombstone_ttl = _positive(tombstone_ttl, 'tombstone TTL')

    # Low-level storage --------------------------------------------------------------
    @contextmanager
    def _lock(self, deadline):
        try:
            _remaining(deadline)
            stream = (self.directory / 'writer.lock').open('a')
        except OSError as exc:
            raise ProjectionUnavailable() from exc
        try:
            while True:
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(min(.002, _remaining(deadline)))
                except OSError as exc:
                    raise ProjectionUnavailable() from exc
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)
        finally:
            stream.close()

    def _sync_directory(self):
        descriptor = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _write_file(self, path, raw):
        temporary = self.directory / ('.pending-' + uuid4().hex)
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                view = memoryview(raw)
                while view:
                    view = view[os.write(descriptor, view):]
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            os.replace(temporary, path)
            temporary = None
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def _put_object(self, value):
        raw = _encode(value)
        digest = hashlib.sha256(raw).hexdigest()
        path = self.directory / ('obj-' + digest + '.json')
        try:
            if hashlib.sha256(path.read_bytes()).hexdigest() == digest:
                return digest
        except FileNotFoundError:
            pass
        self._write_file(path, raw)
        _cache_put(digest, value, len(raw))
        return digest

    def _object(self, digest, kind, deadline):
        value = _cache_get(digest)
        if value is None:
            _remaining(deadline)
            if not isinstance(digest, str) or not _HEX64.fullmatch(digest):
                raise ValueError('invalid object reference')
            raw = (self.directory / ('obj-' + digest + '.json')).read_bytes()
            if hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError('corrupt object')
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError('unexpected object')
            _cache_put(digest, value, len(raw))
        if value.get('kind') != kind:
            raise ValueError('unexpected object')
        return value

    def _current(self, deadline):
        _remaining(deadline)
        pointer = json.loads(self.pointer.read_bytes())
        if not isinstance(pointer, dict) or pointer.get('format') != FORMAT \
                or not isinstance(pointer.get('generation'), str) or not _HEX64.fullmatch(pointer['generation']):
            raise ValueError('invalid pointer')
        return pointer['generation']

    def _manifest(self, generation, deadline):
        _remaining(deadline)
        if not isinstance(generation, str) or not _HEX64.fullmatch(generation):
            raise ValueError('invalid generation')
        raw = (self.directory / ('generation-' + generation + '.json')).read_bytes()
        if hashlib.sha256(raw).hexdigest() != generation:
            raise ValueError('corrupt generation')
        manifest = json.loads(raw)
        if not isinstance(manifest, dict) or manifest.get('format') != FORMAT or type(manifest.get('sequence')) is not int \
                or not isinstance(manifest.get('pages'), list) or len(manifest['pages']) != PAGES \
                or not isinstance(manifest.get('operations'), list) or not isinstance(manifest.get('queue'), dict) \
                or not isinstance(manifest.get('evictable'), dict):
            raise ValueError('invalid generation')
        return manifest

    def _write_manifest(self, manifest):
        raw = _encode(manifest)
        generation = hashlib.sha256(raw).hexdigest()
        self._write_file(self.directory / ('generation-' + generation + '.json'), raw)
        return generation

    def _publish(self, generation):
        """The commit point: atomically switch the pointer."""
        self._write_file(self.pointer, _encode({'format': FORMAT, 'generation': generation}))

    @staticmethod
    def _empty_manifest(now):
        return {'format': FORMAT, 'sequence': 0, 'previous': None, 'created_at': now, 'nonce': uuid4().hex,
                'pages': [None] * PAGES, 'evictable': {'count': 0, 'bytes': 0},
                'queue': {'index': None, 'head': 0, 'items': 0, 'cursor': 0}, 'operations': [], 'released': None,
                'gc_at': now}

    # Lifecycle ------------------------------------------------------------------------
    def initialize(self, *, deadline):
        """Create a NEW empty store, or upgrade an empty legacy one. Never repairs.

        Idempotent for an established store. Refuses (ProjectionUnavailable) if
        established state is missing or corrupt, or if a legacy store holds
        records; restore those from backup instead.
        """
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            with self._lock(deadline):
                if self.pointer.exists():
                    if not self._upgrade_empty_legacy(deadline):
                        self._manifest(self._current(deadline), deadline)
                    return
                if (self.directory / 'initialized').exists() or any(
                        path.name.startswith(('generation-', 'obj-', 'blob-')) for path in self.directory.iterdir()):
                    raise ProjectionUnavailable()
                self._create(deadline)
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            raise ProjectionUnavailable() from exc

    def _create(self, deadline):
        generation = self._write_manifest(self._empty_manifest(time.time()))
        self._sync_directory()
        _remaining(deadline)
        self._publish(generation)
        self._write_file(self.directory / 'initialized', b'2')
        self._sync_directory()

    def _upgrade_empty_legacy(self, deadline):
        """Format-1 stores were never written by production code; upgrade only if empty."""
        pointer = json.loads(self.pointer.read_bytes())
        if not isinstance(pointer, dict) or 'format' in pointer:
            return False
        legacy = self.directory / ('generation-' + pointer['generation'] + '.json')
        raw = legacy.read_bytes()
        state = json.loads(raw)
        if hashlib.sha256(raw).hexdigest() != pointer['digest'] or state.get('format') != 1:
            raise ProjectionUnavailable()
        if any(entry.get('blob') for entry in state['records'].values()):
            raise ProjectionUnavailable()  # Holds records: restore or migrate deliberately.
        self._create(deadline)
        for path in self.directory.iterdir():
            name = path.name
            legacy_generation = name.startswith('generation-') and len(name) in (48, 50)  # 32-hex IDs.
            if name.startswith(('blob-', 'pin-')) or legacy_generation:
                path.unlink(missing_ok=True)
        return True

    # Reads (lock-free; never write storage) ---------------------------------------------
    def read_records(self, keys, *, deadline, generation=None):
        keys = _keys(keys)
        try:
            # Even pinned reads fail closed if the authoritative pointer is corrupt.
            current = self._current(deadline)
            generation = current if generation is None else generation
            view = _Transaction(self, self._manifest(generation, deadline), 0, deadline)
            rows = {}
            for key in keys:
                entry = view.entry(key)
                # Copy out: cached immutable objects must never alias caller-owned values.
                rows[key] = Record(view.version(key), None if entry is None else deepcopy(entry.get('d')))
            _remaining(deadline)
            return RecordSnapshot(generation, rows)
        except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as exc:
            raise ProjectionUnavailable() from exc

    def _bucket_seconds(self):
        return self.operation_ttl / 12

    def _live_buckets(self, operations, now):
        horizon = now - self.operation_ttl
        return [[bucket, digest] for bucket, digest in operations if (bucket + 1) * self._bucket_seconds() >= horizon]

    def _operations(self, manifest, now, deadline):
        horizon = now - self.operation_ttl
        live = {}
        for _, digest in self._live_buckets(manifest['operations'], now):
            for operation_id, (fingerprint, committed_at) in self._object(digest, 'operations', deadline)['items'].items():
                if committed_at >= horizon:
                    live[operation_id] = fingerprint
        return live

    def operation_status(self, operation_id, *, deadline):
        operation_id = _operation_id(operation_id)
        try:
            manifest = self._manifest(self._current(deadline), deadline)
            return True if operation_id in self._operations(manifest, time.time(), deadline) else None
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            raise ProjectionUnavailable() from exc

    # Writes -----------------------------------------------------------------------------
    def compare_and_swap(self, expected, changes, *, deadline, operation_id=None):
        fingerprint = _transaction(expected, changes)
        explicit = operation_id is not None
        if explicit:
            _operation_id(operation_id)
        with self._lock(deadline):
            try:
                now = time.time()
                previous = self._current(deadline)
                manifest = self._manifest(previous, deadline)
                prior = self._operations(manifest, now, deadline).get(operation_id) if explicit else None
                if prior is not None:
                    if prior != fingerprint:
                        raise OperationConflict('operation ID reused for another transaction')
                    return True
                transaction = _Transaction(self, manifest, now, deadline)
                if any(transaction.version(key) != version for key, version in expected.items()):
                    return False  # Publishes nothing.
                gc_at = self._collect(manifest, previous, now, deadline)
                for key, value in changes.items():
                    transaction.put(key, value)
                transaction.enforce_capacity()
                transaction.compact_queue()
                state = transaction.write(self._put_object)
                operations = self._live_buckets(manifest['operations'], now)
                if explicit:
                    operations = self._log(operations, operation_id, fingerprint, now, deadline)
                # Objects the previous generation referenced but this one does not;
                # GC keeps them while any retained generation could still read them.
                released = (transaction.released | {digest for _, digest in manifest['operations']}) \
                    - {digest for _, digest in operations} - {None}
                generation = self._write_manifest({
                    'format': FORMAT, 'sequence': manifest['sequence'] + 1, 'previous': previous,
                    'created_at': now, 'nonce': uuid4().hex, 'operations': operations, 'gc_at': gc_at,
                    'released': self._put_object({'kind': 'released', 'items': sorted(released)}) if released else None,
                    **state})
                self._sync_directory()
                _remaining(deadline)  # Last deadline check before the commit point.
                self._publish(generation)
            except (OperationConflict, ProjectionUnavailable):
                raise
            except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as exc:
                raise ProjectionUnavailable() from exc
            try:
                self._sync_directory()
            except OSError as exc:
                # The pointer switched but durability is uncertain: resolve via operation_status.
                raise ProjectionUnavailable() from exc
            return True

    def _log(self, operations, operation_id, fingerprint, now, deadline):
        bucket = int(now // self._bucket_seconds())
        items = {}
        if operations and operations[-1][0] == bucket:
            items = dict(self._object(operations.pop()[1], 'operations', deadline)['items'])
        items[operation_id] = [fingerprint, now]
        operations.append([bucket, self._put_object({'kind': 'operations', 'items': items})])
        return operations

    def _collect(self, manifest, current, now, deadline):
        """Best-effort amortised GC on the write path; returns the next gc_at.

        Retains the pointer's generation and every generation superseded within
        generation_retention (which keeps pinned readers' evicted payloads), plus
        every object they reference. Uses stored chain links, never file mtimes.
        """
        previous_gc = manifest.get('gc_at', 0)
        if manifest['sequence'] % GC_INTERVAL and now - previous_gc < GC_MAX_AGE and previous_gc:
            return previous_gc
        try:
            retained = {current: manifest}
            successor = manifest
            while successor.get('previous') and now - successor['created_at'] < self.generation_retention:
                previous = successor['previous']
                try:
                    successor = self._manifest(previous, deadline)
                except (OSError, ValueError):
                    break
                retained[previous] = successor
            # Everything the current generation references, plus everything a
            # retained generation released (an object an older retained
            # generation still references was released by a newer retained one).
            referenced = {digest for _, digest in manifest['operations']}
            for digest in manifest['pages']:
                if digest:
                    referenced.add(digest)
                    referenced.update(self._object(digest, 'page', deadline)['segments'])
            index = manifest['queue']['index']
            if index:
                referenced.add(index)
                referenced.update(self._object(index, 'queue-index', deadline)['chunks'])
            for kept in retained.values():
                if kept.get('released'):
                    referenced.add(kept['released'])
                    referenced.update(self._object(kept['released'], 'released', deadline)['items'])
            _remaining(deadline)
            garbage = []
            for name in os.listdir(self.directory):
                if name.startswith('obj-'):
                    if name[4:-5] not in referenced:
                        garbage.append(name)
                elif name.startswith('generation-'):
                    if name[11:-5] not in retained:
                        garbage.append(name)
                elif name.startswith('.pending-'):  # Only crashed writers leave these.
                    garbage.append(name)
            # Bounded per run so one commit never pays for a whole burst; the
            # remainder is collected by the following commits.
            for name in garbage[:GC_MAX_UNLINKS]:
                try:
                    os.unlink(self.directory / name)
                except OSError:
                    pass
            _remaining(deadline)
            return now if len(garbage) <= GC_MAX_UNLINKS else 0  # 0: continue next commit.
        except (OSError, ValueError, KeyError, TypeError, AttributeError, ProjectionUnavailable):
            return previous_gc


# --- HTTP adapter ----------------------------------------------------------------------
class _Transport:
    """One persistent event loop + pooled AsyncClient per process (connection reuse)."""
    _instance = None
    _guard = threading.Lock()

    @classmethod
    def get(cls):
        with cls._guard:
            if cls._instance is None or cls._instance.pid != os.getpid():
                cls._instance = cls()
            return cls._instance

    def __init__(self):
        import asyncio
        import httpx
        self.pid = os.getpid()
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, name='public-records-http', daemon=True).start()

        async def client():
            return httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=None,
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=16, keepalive_expiry=30))
        self.client = asyncio.run_coroutine_threadsafe(client(), self.loop).result()

    def post(self, url, body, token, deadline):
        import asyncio

        async def request():
            async with self.client.stream('POST', url, json=body, timeout=_remaining(deadline), headers={
                    'Authorization': 'Bearer ' + token, 'Cache-Control': 'no-cache, no-store'}) as response:
                chunks = []
                size = 0
                async for chunk in response.aiter_bytes():
                    _remaining(deadline)
                    size += len(chunk)
                    if size > MAX_BYTES + 1024 * 1024:
                        raise ProjectionUnavailable()
                    chunks.append(chunk)
                return response.status_code, b''.join(chunks)

        async def bounded():
            return await asyncio.wait_for(request(), timeout=_remaining(deadline))

        future = asyncio.run_coroutine_threadsafe(bounded(), self.loop)
        try:
            return future.result(timeout=_remaining(deadline) + .05)
        except TimeoutError:
            future.cancel()
            raise


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
        # Synchronous adapter methods run on the API's worker threads. Reject
        # accidental event-loop blocking rather than extending its deadline.
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise ProjectionUnavailable()
        body = {**body, 'timeout_ms': max(1, int(_remaining(deadline) * 1000))}
        try:
            status, raw = _Transport.get().post(self.url + '/' + action, body, self.token, deadline)
            _remaining(deadline)
            if status == 409:
                raise OperationConflict('operation ID reused for another transaction')
            if status != 200:
                raise ProjectionUnavailable()
            response = json.loads(raw)
            if not isinstance(response, dict):
                raise ProjectionUnavailable()
            return response
        except (OperationConflict, ProjectionUnavailable):
            raise
        except (TimeoutError, asyncio.CancelledError, httpx.HTTPError, OSError, ValueError, KeyError, TypeError) as exc:
            raise ProjectionUnavailable() from exc

    def initialize(self, *, deadline):
        if self._request('initialize', {}, deadline) != {'initialized': True}:
            raise ProjectionUnavailable()

    def read_records(self, keys, *, deadline, generation=None):
        keys = _keys(keys)
        response = self._request('read', {'keys': keys, 'generation': generation}, deadline)
        rows = response.get('records')
        returned = response.get('generation')
        if not isinstance(rows, dict) or not isinstance(returned, str) or not 0 < len(returned) <= 128 \
                or set(rows) != set(keys) or (generation is not None and returned != generation):
            raise ProjectionUnavailable()
        result = {}
        for key, row in rows.items():
            if not isinstance(row, dict) or 'value' not in row or not isinstance(row.get('version'), str) \
                    or not 0 < len(row['version']) <= 128:
                raise ProjectionUnavailable()
            result[key] = Record(row['version'], row['value'])
        return RecordSnapshot(returned, result)

    def compare_and_swap(self, expected, changes, *, deadline, operation_id=None):
        _transaction(expected, changes)
        if operation_id is not None:
            _operation_id(operation_id)
        response = self._request('transact', {'expected': expected, 'changes': changes,
                                              'operation_id': operation_id}, deadline)
        if type(response.get('committed')) is not bool:
            raise ProjectionUnavailable()
        return response['committed']

    def operation_status(self, operation_id, *, deadline):
        response = self._request('status', {'operation_id': _operation_id(operation_id)}, deadline)
        committed = response.get('committed', False)
        if committed is not None and type(committed) is not bool:
            raise ProjectionUnavailable()
        return True if committed is True else None


def public_record_store():
    adapter = os.environ.get('PUBLIC_PROJECTION_ADAPTER', 'filesystem')
    if adapter == 'filesystem':
        return FilePublicRecords()
    if adapter == 'http':
        return HttpPublicRecords()
    raise ProjectionUnavailable()


# --- Domain read helper ------------------------------------------------------------------
_RESULT_STATES = ('quote', 'absent', 'pending')


def quote_states(store, pairs, *, deadline, generation=None):
    """Current quote state per (edition_ref, mapping_revision), at one generation.

    Result marker values: {'state': 'pending', ...} suppresses any payload;
    {'state': 'absent', ...} (confirmed unavailability) supersedes any payload;
    {'state': 'quote', 'attempt': A, ...} exposes the quote payload only when it
    is present with the same 'attempt'. A missing marker, or an evicted or
    mismatched payload, is 'unknown'. Other mapping revisions are never read.
    A malformed marker or payload makes only that row 'invalid' (never usable); the batch still succeeds, and store
    unavailability still raises ProjectionUnavailable. ``generation``
    reads at a snapshot pinned by an earlier read (for example the catalog eligibility read).
    """
    pairs = list(dict.fromkeys((_ref(edition), mapping_revision) for edition, mapping_revision in pairs))
    keys = []
    for edition, mapping_revision in pairs:
        keys += [result_key(edition, mapping_revision), quote_key(edition, mapping_revision)]
    snapshot = store.read_all(keys, deadline=deadline, generation=generation)
    states = {}
    for pair in pairs:
        result = snapshot.records[result_key(*pair)].value
        payload = snapshot.records[quote_key(*pair)].value
        if result is None:
            states[pair] = QuoteState('unknown', None, None, snapshot.generation)
            continue
        # A malformed row is that row's problem only (status 'invalid'); store unavailability raised above.
        if not isinstance(result, dict) or result.get('state') not in _RESULT_STATES \
                or (payload is not None and not isinstance(payload, dict)):
            states[pair] = QuoteState('invalid', None, None, snapshot.generation)
            continue
        if result['state'] != 'quote':
            states[pair] = QuoteState(result['state'], result, None, snapshot.generation)
            continue
        attempt = result.get('attempt')
        if isinstance(attempt, bool) or not isinstance(attempt, (int, str)):
            states[pair] = QuoteState('invalid', None, None, snapshot.generation)
            continue
        usable = payload is not None and type(payload.get('attempt')) is type(attempt) and payload['attempt'] == attempt
        states[pair] = QuoteState('quote' if usable else 'unknown', result, payload if usable else None, snapshot.generation)
    return states
