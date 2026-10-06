"""Local provider-neutral public object projection, with atomic replacement.

Only sanitized snapshots and their public visibility reside here. The same
filesystem must be shared by all local API processes; adapters for eventual
hosting must provide equivalent serialized atomic snapshot/discovery updates.
"""
import fcntl
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path


class ProjectionUnavailable(Exception):
    pass


class FilePublicProjection:
    def __init__(self):
        self.directory = Path(os.environ.get('PUBLIC_PROJECTION_DIR', '.local/public-projections')).resolve()
        self.path = self.directory / 'current.json'

    def read(self):
        try:
            with self.path.open() as stream:
                value = json.load(stream)
            if not isinstance(value, dict) or value.get('format') != 1 or not isinstance(value.get('decks'), dict):
                raise ProjectionUnavailable()
            return value['decks']
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
                json.dump({'format': 1, 'decks': decks}, stream, ensure_ascii=False, separators=(',', ':'))
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
