"""Private object boundary. Configured provider adapters implement the same protocol."""
import importlib
import os
from pathlib import Path, PurePosixPath
import shutil
import tempfile
from typing import Protocol

class PrivateBackupStore(Protocol):
    # put atomically replaces a complete object; list excludes unfinished writes.
    def put(self,key: str,source: Path) -> None: ...
    def get(self,key: str,destination: Path) -> None: ...
    def list(self,prefix: str) -> list[str]: ...
    def delete(self,key: str) -> None: ...

class FilePrivateBackupStore:
    def __init__(self,directory: str):
        self.directory = Path(directory).resolve()
        public_config = os.environ.get('PUBLIC_PROJECTION_DIR','.local/public-projections')
        if not public_config.strip():
            raise ValueError('Empty public storage setting')
        public = Path(public_config).resolve()
        if self.directory==public or public in self.directory.parents or self.directory in public.parents:
            raise ValueError('Private and public stores must be separate')
        self.directory.mkdir(mode=0o700,parents=True,exist_ok=True)
        if self.directory.stat().st_mode & 0o077:
            raise ValueError('Private store requires mode 0700')

    def path(self,key):
        relative = PurePosixPath(key)
        if relative.is_absolute() or '..' in relative.parts or not relative.parts:
            raise ValueError('Invalid object key')
        path = (self.directory/str(relative)).resolve()
        if self.directory not in path.parents:
            raise ValueError('Object escaped private store')
        return path

    def put(self,key,source):
        path = self.path(key)
        path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        fd,temporary = tempfile.mkstemp(dir=path.parent,prefix='.upload-')
        try:
            with os.fdopen(fd,'wb') as output,Path(source).open('rb') as data:
                shutil.copyfileobj(data,output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary,path)
            parent = os.open(path.parent,os.O_RDONLY)
            try: os.fsync(parent)
            finally: os.close(parent)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def get(self,key,destination):
        with self.path(key).open('rb') as source,Path(destination).open('wb') as output:
            shutil.copyfileobj(source,output)
        Path(destination).chmod(0o600)

    def list(self,prefix):
        return sorted(str(path.relative_to(self.directory)) for path in self.directory.rglob('*')
                      if path.is_file() and not path.is_symlink() and str(path.relative_to(self.directory)).startswith(prefix) and not path.name.startswith('.upload-'))

    def delete(self,key):
        self.path(key).unlink(missing_ok=True)


def configured_store() -> PrivateBackupStore:
    factory = os.environ.get('BACKUP_STORE_FACTORY')
    if factory:
        module,name = factory.split(':',1)
        return getattr(importlib.import_module(module),name)()
    return FilePrivateBackupStore(os.environ['BACKUP_PRIVATE_DIR'])
