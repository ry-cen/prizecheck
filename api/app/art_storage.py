"""Where card art bytes live (#358, ADR 0020): a small get/put/delete interface by key, and a directory-on-disk
implementation. An S3-compatible implementation can follow behind the same interface; ``tests/test_art_storage.py`` is
the contract any implementation must pass.

Objects are at most 2 MiB, so bytes in memory are fine. ``put`` is atomic and overwrites: a reader sees either nothing
or the whole object, and two writers of one key are both safe.
"""
import os
import re
import uuid
from pathlib import Path
from typing import Protocol

KEY = re.compile(r"^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$")
MAX_KEY = 255


class ArtStorage(Protocol):
    def get(self, key: str) -> bytes | None: ...

    def put(self, key: str, data: bytes) -> None: ...

    def delete(self, key: str) -> None: ...


def check_key(key: str) -> str:
    """The key itself, or ValueError: lowercase segments joined by single slashes, no '..' segment, at most 255 chars."""
    if (not isinstance(key, str) or len(key) > MAX_KEY or not KEY.fullmatch(key)
            or any(part == ".." for part in key.split("/"))):
        raise ValueError("invalid art storage key")
    return key


class DiskArtStorage:
    def __init__(self, root: Path):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        check_key(key)
        root = self.root.resolve()
        path = (root / key).resolve()
        if root != path and root not in path.parents:
            raise ValueError("invalid art storage key")
        return path

    def get(self, key: str) -> bytes | None:
        try:
            return self._path(key).read_bytes()
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
            return None

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(f"{path.name}.tmp-{uuid.uuid4().hex}")
        try:
            with open(temp, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, path)
        except BaseException:
            try:
                temp.unlink()
            except OSError:
                pass
            raise

    def delete(self, key: str) -> None:
        try:
            self._path(key).unlink()
        except (FileNotFoundError, NotADirectoryError):
            pass


def storage() -> ArtStorage:
    """The art store for ART_STORE_DIR (default .local/art), resolved on every call."""
    return DiskArtStorage(Path(os.environ.get("ART_STORE_DIR", ".local/art")))
