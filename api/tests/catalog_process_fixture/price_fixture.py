"""CI-only price-refresh hooks; loaded by this directory's ``sitecustomize`` when it is on PYTHONPATH.

No production configuration enables this. Hooks are inert unless their environment variable is set:

- ``PRICE_FIXTURE_SOURCE_ORIGIN=http://127.0.0.1:<port>``: when ``app.games.pokemon.prices.price_source`` is imported, its module-level
  ``ORIGIN`` string is replaced by this loopback origin. Production code has no origin parameter, so this is the
  only way a test points the source client at a local server. Only loopback http origins are accepted.
- ``$PRICE_RUNNER_LOCK_DIR/fixture-source-origin``: the same redirect for launched runners. The launcher's environment
  allowlist drops ``PRICE_FIXTURE_SOURCE_ORIGIN`` but keeps ``PRICE_RUNNER_LOCK_DIR``, so a test writes the loopback
  origin into this file. It is read when ``app.games.pokemon.prices.price_source`` is imported (not at start), the environment variable wins
  when both are present, and a non-loopback value fails the import loudly. While a redirect is active, requests from a
  runner process (``--slot n`` on its command line) carry ``x-fixture-slot``, ``x-fixture-pid`` and ``x-fixture-pgid``
  so a fake source can attribute concurrency per slot and stop or kill the exact process group.
- ``PRICE_FIXTURE_LAUNCHER=record|fail``: when ``app.price_launcher`` is imported, ``spawn`` is replaced. ``record``
  starts nothing and returns True (the reservation then expires on its own); ``fail`` returns False. If
  ``PRICE_FIXTURE_LAUNCH_LOG`` names a file, each call appends ``{"slot", "owner", "outcome", "pid"}`` as one JSON line.
- Loopback-only connect guard: in any process that is started as the price runner (the import system is asked for
  ``app.price_runner``) while ``PRICE_RUNNER_LOCK_DIR`` is set, ``socket.connect`` to a non-loopback IP address
  raises ``NonLoopbackConnection`` and appends a line to ``$PRICE_RUNNER_LOCK_DIR/guard-violations.log``. The trigger
  is the import request, not an environment flag, because the runner's environment is an allowlist. The same process
  appends every connect destination (loopback and AF_UNIX included) to ``connects.log`` as ``{"pid", "address"}``, and
  registers itself as ``runner-pids/<pid>`` (``supervisor``) and each child it forks (``worker``), so tests count and
  clean up exactly the runners they launched without any host-wide process search.

Importing this module has no side effects; ``install()`` is called once from ``sitecustomize``.
"""
import importlib.abc
import importlib.machinery
import ipaddress
import json
import os
import socket
import sys
from urllib.parse import urlsplit

SOURCE_ORIGIN = 'PRICE_FIXTURE_SOURCE_ORIGIN'
LAUNCHER = 'PRICE_FIXTURE_LAUNCHER'
LAUNCH_LOG = 'PRICE_FIXTURE_LAUNCH_LOG'
LOCK_DIR = 'PRICE_RUNNER_LOCK_DIR'
VIOLATIONS = 'guard-violations.log'
ORIGIN_FILE = 'fixture-source-origin'
PIDS_DIR = 'runner-pids'
CONNECTS = 'connects.log'


class NonLoopbackConnection(OSError):
    """A price runner tried to reach a non-loopback address."""


def loopback_origin(origin):
    parts = urlsplit(origin)
    if parts.scheme != 'http' or parts.hostname not in ('127.0.0.1', 'localhost', '::1') or parts.port is None \
            or parts.path not in ('', '/') or parts.query or parts.fragment or parts.username:
        raise RuntimeError(f'{SOURCE_ORIGIN} must be a loopback http origin with a port')
    return f'{parts.scheme}://{parts.netloc}'


def _is_loopback(address):
    if not isinstance(address, tuple) or not address:
        return True  # AF_UNIX paths and other non-IP addresses are not network connections
    try:
        return ipaddress.ip_address(str(address[0]).split('%')[0]).is_loopback
    except ValueError:
        return False  # An unresolved host name: refuse rather than guess.


def _shown(address):
    """A JSON-safe connect destination: ``[host, port, ...]`` for IP sockets, the path for AF_UNIX."""
    if isinstance(address, tuple):
        return [item if isinstance(item, (str, int)) else repr(item) for item in address]
    if isinstance(address, bytes):
        return address.decode('utf-8', 'replace')
    return address if isinstance(address, str) else repr(address)


def install_connect_guard(violation_log=None, connect_log=None):
    """Patch ``socket.socket.connect``/``connect_ex``. Returns a function that restores them."""
    real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex

    def check(address):
        if connect_log:
            with open(connect_log, 'a') as log:
                log.write(json.dumps({'pid': os.getpid(), 'address': _shown(address)}) + '\n')
        if not _is_loopback(address):
            if violation_log:
                with open(violation_log, 'a') as log:
                    log.write(f'{address!r}\n')
            raise NonLoopbackConnection(f'price runner may only connect to loopback, not {address!r}')

    def connect(self, address):
        check(address)
        return real_connect(self, address)

    def connect_ex(self, address):
        check(address)
        return real_connect_ex(self, address)

    socket.socket.connect, socket.socket.connect_ex = connect, connect_ex

    def uninstall():
        socket.socket.connect, socket.socket.connect_ex = real_connect, real_connect_ex
    return uninstall


class _HeaderedHttpx:
    """``httpx`` as ``app.games.pokemon.prices.price_source`` sees it: every attribute is the real one (so ``httpx.TimeoutException`` still
    classifies timeouts), except that ``Client`` merges the fixture headers into the client's own."""

    def __init__(self, real, headers):
        self._real, self._headers = real, headers

    def __getattr__(self, name):
        return getattr(self._real, name)

    def Client(self, *args, headers=None, **kwargs):  # noqa: N802 - mirrors httpx.Client
        merged = dict(headers or {})
        merged.update(self._headers())
        return self._real.Client(*args, headers=merged, **kwargs)


def runner_slot(argv=None):
    """The ``--slot`` of a price runner's command line, or None in any other process."""
    argv = sys.argv if argv is None else argv
    for index, item in enumerate(argv[:-1]):
        if item == '--slot' and argv[index + 1] in ('0', '1'):
            return argv[index + 1]
    return None


def source_redirect(origin):
    """The ``app.games.pokemon.prices.price_source`` patch: a loopback origin, plus attribution headers when this process is a runner."""
    def redirect(module):
        if type(getattr(module, 'ORIGIN', None)) is not str:
            raise RuntimeError('app.games.pokemon.prices.price_source must define a module-level ORIGIN string')
        module.ORIGIN = origin
        slot = runner_slot()
        if slot is not None:
            module.httpx = _HeaderedHttpx(module.httpx, lambda: {
                'x-fixture-slot': slot, 'x-fixture-pid': str(os.getpid()), 'x-fixture-pgid': str(os.getpgid(0))})
    return redirect


def origin_from_file(directory):
    """The redirect for a launched runner, decided when ``app.games.pokemon.prices.price_source`` is imported: the file, if present."""
    def redirect(module):
        path = os.path.join(directory, ORIGIN_FILE)
        try:
            with open(path) as handle:
                text = handle.read().strip()
        except FileNotFoundError:
            return
        try:
            origin = loopback_origin(text)
        except RuntimeError:
            raise RuntimeError(f'{path} must hold a loopback http origin with a port') from None
        source_redirect(origin)(module)
    return redirect


def register_runner(directory):
    """Record this process (``supervisor``) and every child it forks (``worker``) under ``runner-pids/``."""
    registry = os.path.join(directory, PIDS_DIR)

    def write(role):
        try:
            os.makedirs(registry, exist_ok=True)
            with open(os.path.join(registry, str(os.getpid())), 'w') as handle:
                handle.write(role)
        except OSError:
            pass
    write('supervisor')
    os.register_at_fork(after_in_child=lambda: write('worker'))


def launcher_hook(mode, log_path=None):
    """The replacement ``spawn``: records the call, starts nothing, and reports success (record) or failure (fail)."""
    if mode not in ('record', 'fail'):
        raise RuntimeError(f'{LAUNCHER} must be record or fail')

    def spawn(slot, owner):
        outcome = mode == 'record'
        if log_path:
            with open(log_path, 'a') as log:
                log.write(json.dumps({'slot': slot, 'owner': owner, 'outcome': outcome, 'pid': os.getpid()}) + '\n')
        return outcome
    return spawn


class _PatchOnImport(importlib.abc.MetaPathFinder):
    """Runs a callback on a module right after it executes, and an action when the import system looks it up."""

    def __init__(self, patches, on_lookup):
        self.patches, self.on_lookup = patches, on_lookup

    def find_spec(self, name, path=None, target=None):
        if name in self.on_lookup:
            self.on_lookup[name]()
        if name not in self.patches:
            return None
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return None
        loader, patch = spec.loader, self.patches[name]
        original = loader.exec_module

        def exec_module(module):
            original(module)
            patch(module)
        loader.exec_module = exec_module
        return spec


def install(environ=None):
    environ = os.environ if environ is None else environ
    patches, on_lookup = {}, {}
    if environ.get(SOURCE_ORIGIN):
        patches['app.games.pokemon.prices.price_source'] = source_redirect(loopback_origin(environ[SOURCE_ORIGIN]))
    elif environ.get(LOCK_DIR):
        patches['app.games.pokemon.prices.price_source'] = origin_from_file(environ[LOCK_DIR])
    if environ.get(LAUNCHER):
        spawn = launcher_hook(environ[LAUNCHER], environ.get(LAUNCH_LOG))
        patches['app.price_launcher'] = lambda module: setattr(module, 'spawn', spawn)
    if environ.get(LOCK_DIR):
        directory = environ[LOCK_DIR]
        state = {'done': False}

        def guard():
            if not state['done']:
                state['done'] = True
                install_connect_guard(os.path.join(directory, VIOLATIONS), os.path.join(directory, CONNECTS))
                register_runner(directory)
        on_lookup['app.price_runner'] = guard
    if patches or on_lookup:
        sys.meta_path.insert(0, _PatchOnImport(patches, on_lookup))
