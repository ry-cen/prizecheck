"""CI-only card art upstream redirect; loaded by this directory's ``sitecustomize`` when it is on PYTHONPATH.

No production configuration enables this, and the API image copies only ``api/app``, so this file never ships. The art
fetcher (``app.core.art.store``) checks every URL against its exact-host allowlist (``https://assets.tcgdex.net``) first; only
afterwards does it ask ``upstream_target`` where to send the request. In production that is the URL itself. With this
fixture installed, when ``app.core.art.store`` is imported its module-level ``upstream_target`` is replaced by a function that
reads ``$CATALOG_PROCESS_FIXTURE_DIR/art-upstream-origin`` on every call (a browser spec writes the file) and returns that
loopback http origin plus the URL's path. With no file it returns a loopback port that refuses connections, so a test
never reaches the internet.

Importing this module has no side effects; ``install()`` is called once from ``sitecustomize``.
"""
import importlib.abc
import importlib.machinery
import os
import sys
from urllib.parse import urlsplit

ORIGIN_FILE = 'art-upstream-origin'
REFUSED = 'http://127.0.0.1:9'


def loopback_origin(origin):
    parts = urlsplit(origin)
    if parts.scheme != 'http' or parts.hostname not in ('127.0.0.1', 'localhost') or parts.port is None \
            or parts.path not in ('', '/') or parts.query or parts.fragment or parts.username:
        raise RuntimeError(f'{ORIGIN_FILE} must hold a loopback http origin with a port')
    return f'{parts.scheme}://{parts.netloc}'


def upstream_target_from(directory):
    def upstream_target(url):
        try:
            with open(os.path.join(directory, ORIGIN_FILE)) as handle:
                origin = loopback_origin(handle.read().strip())
        except FileNotFoundError:
            origin = REFUSED
        return origin + urlsplit(url).path
    return upstream_target


class _PatchOnImport(importlib.abc.MetaPathFinder):
    def __init__(self, directory):
        self.directory = directory

    def find_spec(self, name, path=None, target=None):
        if name != 'app.core.art.store':
            return None
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return None
        loader = spec.loader
        original = loader.exec_module
        directory = self.directory

        def exec_module(module):
            original(module)
            if not callable(getattr(module, 'upstream_target', None)):
                raise RuntimeError('app.core.art.store must define upstream_target')
            module.upstream_target = upstream_target_from(directory)
        loader.exec_module = exec_module
        return spec


def install(environ=None):
    environ = os.environ if environ is None else environ
    if environ.get('CATALOG_PROCESS_FIXTURE_DIR'):
        sys.meta_path.insert(0, _PatchOnImport(environ['CATALOG_PROCESS_FIXTURE_DIR']))
