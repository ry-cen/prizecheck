"""Local provider-neutral public object projection, with atomic replacement.

Only sanitized snapshots and their public visibility reside here. The same
filesystem must be shared by all local API processes; adapters for eventual
hosting must provide equivalent serialized atomic snapshot/discovery updates.
"""
import fcntl
import json
import os
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path


class ProjectionUnavailable(Exception):
    pass


def _manifest(value) -> tuple[dict, int]:
    """The decks and revision of a parsed file manifest, or ProjectionUnavailable when it is not a valid one."""
    if not isinstance(value, dict) or value.get('format') != 1 or not isinstance(value.get('decks'), dict):
        raise ProjectionUnavailable()
    revision = value.get('revision', 0)
    if not isinstance(revision, int) or revision < 0:
        raise ProjectionUnavailable()
    return value['decks'], revision


def _record_texts(decks: dict) -> dict[str, str]:
    """Each record as compact JSON text: a cached parse hands out fresh objects, so no caller can change a shared one."""
    return {token: json.dumps(record, ensure_ascii=False, separators=(',', ':')) for token, record in decks.items()}


def _identity(path, stat) -> tuple:
    return (str(path), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


_records_lock = threading.Lock()  # misses open and parse under it, so a newer entry is never replaced by an older one
_file_records = None  # (identity, open file of that manifest, {token: record JSON}); the open file pins the inode
_http_records = None  # ((url, bearer token), strong ETag, {token: record JSON})


class FilePublicProjection:
    def __init__(self):
        self.directory = Path(os.environ.get('PUBLIC_PROJECTION_DIR', '.local/public-projections')).resolve()
        self.path = self.directory / 'current.json'

    def read_state(self, timeout=None):
        try:
            with self.path.open(encoding='utf-8') as stream:
                return _manifest(json.load(stream))
        except (OSError, ValueError) as exc:
            raise ProjectionUnavailable() from exc

    def read(self):
        return self.read_state()[0]

    def read_record(self, token, timeout=None):
        """One Deck's record as a fresh object, or None. Every reader in this process shares one parse of each manifest
        the writer installs; any replacement, the writer's or an out-of-band os.replace, is seen by the next read."""
        text = self._records().get(token)
        return None if text is None else json.loads(text)

    def _records(self):
        global _file_records
        try:
            cached = _file_records
            if cached and cached[0] == _identity(self.path, os.stat(self.path)) and _file_records is cached:
                return cached[2]
            with _records_lock:
                cached = _file_records
                if cached and cached[0] == _identity(self.path, os.stat(self.path)):
                    return cached[2]
                stream = self.path.open('rb')
                try:
                    identity = _identity(self.path, os.fstat(stream.fileno()))
                    records = _record_texts(_manifest(json.loads(stream.read().decode('utf-8')))[0])
                except BaseException:
                    stream.close()
                    raise
                _file_records = (identity, stream, records)
                if cached:
                    cached[1].close()
                return records
        except (OSError, ValueError) as exc:
            raise ProjectionUnavailable() from exc

    @contextmanager
    def writer(self, initialize=False):
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            with (self.directory / 'writer.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                if initialize and not self.path.exists():
                    self.replace({})
                self.read()
                yield self
        except OSError as exc:
            raise ProjectionUnavailable() from exc

    def replace(self, decks):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=self.directory, prefix='.pending-', delete=False) as stream:
                temporary = stream.name
                revision = self.read_state()[1] + 1 if self.path.exists() else 0
                json.dump({'format': 1, 'revision': revision, 'decks': decks}, stream, ensure_ascii=False, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            temporary = None
            directory_fd = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except (OSError, ValueError) as exc:
            raise ProjectionUnavailable() from exc
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def apply(self, token, projection):
        decks = self.read()
        if projection is None:
            decks.pop(token, None)
        else:
            decks[token] = projection
        self.replace(decks)


class HttpPublicProjection:
    """Linearizable manifest relay with strong-ETag compare-and-swap writes."""
    def __init__(self):
        from urllib.parse import urlsplit
        self.url = os.environ.get('PUBLIC_PROJECTION_URL', '')
        self.token = os.environ.get('PUBLIC_PROJECTION_TOKEN', '')
        parsed = urlsplit(self.url)
        local = parsed.hostname in ('localhost','127.0.0.1','::1')
        if not self.token or parsed.username or parsed.password or parsed.fragment or not (
            parsed.scheme == 'https' or (parsed.scheme == 'http' and local and os.environ.get('NODE_ENV') != 'production')
        ):
            raise ProjectionUnavailable()

    def _request(self, method, timeout=5, **kwargs):
        import httpx
        try:
            response = httpx.request(method,self.url,headers={
                'Authorization':'Bearer '+self.token,'Cache-Control':'no-cache, no-store',**kwargs.pop('headers',{})
            },timeout=timeout,follow_redirects=False,trust_env=False,**kwargs)
            return response
        except (httpx.HTTPError,ValueError) as exc:
            raise ProjectionUnavailable() from exc

    def _load(self, initialize=False, timeout=5):
        response = self._request('GET', timeout=timeout)
        if initialize and response.status_code == 404:
            return {},-1,None
        return self._checked(response)

    def _checked(self, response):
        if response.status_code != 200:
            raise ProjectionUnavailable()
        etag = response.headers.get('ETag','')
        if len(etag)<2 or not etag.startswith('"') or not etag.endswith('"') or '\r' in etag or '\n' in etag:
            raise ProjectionUnavailable()
        try:
            value = response.json()
            if (not isinstance(value,dict) or value.get('format') != 1 or not isinstance(value.get('decks'),dict)
                    or type(value.get('revision')) is not int or value['revision']<0):
                raise ProjectionUnavailable()
            return value['decks'],value['revision'],etag
        except (ValueError,KeyError,TypeError) as exc:
            raise ProjectionUnavailable() from exc

    def read_state(self, timeout=5):
        decks,revision,_ = self._load(timeout=timeout)
        return decks,revision

    def read(self):
        return self.read_state()[0]

    def read_record(self, token, timeout=5):
        """One Deck's record as a fresh object, or None. Every read still asks the relay; a 304 for the cached strong
        ETag reuses this process's parse of that manifest, and a relay that ignores If-None-Match answers 200 as before."""
        global _http_records
        scope = (self.url, self.token)  # credentials could select another representation at the same URL
        held = _http_records
        cached = held if held and held[0] == scope else None
        response = self._request('GET', timeout=timeout, headers={'If-None-Match': cached[1]} if cached else {})
        if response.status_code == 304:
            if cached is None or response.headers.get('ETag') != cached[1]:
                raise ProjectionUnavailable()
            records = cached[2]
        else:
            decks, _, etag = self._checked(response)
            records = _record_texts(decks)
            _http_records = (scope, etag, records)
        text = records.get(token)
        return None if text is None else json.loads(text)

    def _replace(self, decks, revision, etag):
        response = self._request('PUT',headers={'If-Match':etag} if etag else {'If-None-Match':'*'},
            json={'format':1,'revision':revision+1,'decks':decks})
        if response.status_code == 412:
            return False
        if not 200 <= response.status_code < 300:
            raise ProjectionUnavailable()
        return True

    @contextmanager
    def writer(self, initialize=False):
        decks,revision,etag = self._load(initialize=initialize)
        if etag is None:
            self._replace(decks,revision,None)
            self.read_state()
        yield self

    def apply(self, token, projection):
        for _ in range(3):
            decks,revision,etag = self._load()
            if projection is None:
                decks.pop(token,None)
            else:
                decks[token] = projection
            if self._replace(decks,revision,etag):
                return
        raise ProjectionUnavailable()


def public_projection_store():
    """Only adapter selection seam; callers retain identical projection semantics."""
    adapter = os.environ.get('PUBLIC_PROJECTION_ADAPTER','filesystem')
    if adapter == 'filesystem':
        return FilePublicProjection()
    if adapter == 'http':
        return HttpPublicProjection()
    raise ProjectionUnavailable()


def public_record_store():
    """Select independent shared records without advancing discovery revisions."""
    from .public_records import public_record_store as select_records
    return select_records()
