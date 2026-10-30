"""A disposable PostgreSQL server for this checkout's local test runs, and a check of what those runs need.

`npm run verify` needs TEST_ADMIN_DATABASE_URL, a loopback PostgreSQL role that may create and drop databases. This
script starts one server per checkout from tools the host already has, never downloads one, and passes its URL to a
command without printing it:

    python3 scripts/local_test_db.py doctor                 # what this checkout can run, and what is missing
    python3 scripts/local_test_db.py run -- npm run verify -- --suite api -- api/tests/test_prices.py
    python3 scripts/local_test_db.py stop                   # stop the server; `start` or `run` brings it back
    python3 scripts/local_test_db.py destroy                # remove the server and everything it stored
    python3 scripts/local_test_db.py hooks                  # write this worktree's .husky/_ (git config untouched)

Backends, in the order `--backend auto` tries them:
- native: initdb, pg_ctl and postgres from $PG_BIN, PATH, `pg_config --bindir` or a usual install directory. The
  cluster lives in .scratch/local-test-db/data, listens on 127.0.0.1 only, on a free port, with no unix socket.
- docker, podman: a container from postgres:16-alpine (the image docker-compose.yml uses), named and labelled for this
  checkout, publishing 127.0.0.1:<port>, with its data on tmpfs (no volume). The image is pulled only with --allow-pull.

Everything the script makes is recorded in .scratch/local-test-db/owner.json; stop and destroy touch only what that
record names, after checking the container's label or the data directory's place. The superuser's password is random,
test-only, kept in a 0600 file next to the record, and never printed. Standard library only: it runs before .venv exists.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
STATE_NAME = Path('.scratch') / 'local-test-db'
IMAGE = 'docker.io/library/postgres:16-alpine'  # qualified: Podman has no default registry
LABEL = 'dev.prizecheck.local-test-db'
PRODUCTION_MAJOR = 16
READY_TIMEOUT_S = 60
SERVER_SETTINGS = {
    # Loopback TCP only. A unix socket path under a deep worktree can pass the kernel's 107-byte limit.
    'listen_addresses': "'127.0.0.1'",
    'unix_socket_directories': "''",
    # A full gate runs up to 6 pytest workers and 4 browser stacks, each with pools.
    'max_connections': '300',
    # Disposable data: durability buys nothing here and slows every test that writes.
    'fsync': 'off',
    'synchronous_commit': 'off',
    'full_page_writes': 'off',
}
NATIVE_TOOLS = ('initdb', 'pg_ctl', 'postgres')
NATIVE_GLOBS = ('/usr/lib/postgresql/*/bin', '/usr/pgsql-*/bin', '/opt/homebrew/opt/postgresql@*/bin',
                '/usr/local/opt/postgresql@*/bin', '/Applications/Postgres.app/Contents/Versions/*/bin')
HUSKY_HOOKS = ('pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'applypatch-msg',
               'pre-applypatch', 'post-applypatch', 'pre-rebase', 'post-rewrite', 'post-checkout', 'post-merge',
               'pre-push', 'pre-auto-gc')

NO_SERVER = """No PostgreSQL server is available to this checkout. DB-free checks still run (see `doctor`). Choose one:
  1. A PostgreSQL 16 server package from the system package manager, then rerun (or set PG_BIN to its bin directory).
     Installing system software needs the host owner's approval. On Debian and Ubuntu, first set
     `create_main_cluster = false` in /etc/postgresql-common/createcluster.conf so the package creates and starts no
     default cluster; never stop or reconfigure a PostgreSQL service other work may use.
  2. Docker or Podman already usable by this user: rerun with --backend docker (or podman); add --allow-pull once to
     fetch docker.io/library/postgres:16-alpine.
  3. A disposable loopback server of your own: export TEST_ADMIN_DATABASE_URL and `run` passes it through.
See docs/agents/local-testing.md."""


class Failure(Exception):
    """A setup problem the user can act on; main() prints it without a traceback."""


def instance_id(root=None):
    """Stable per checkout, so two worktrees never share a container name."""
    root = root or ROOT
    return hashlib.sha256(str(Path(root).resolve()).encode()).hexdigest()[:12]


def container_name(root=None):
    return f'prizecheck-test-db-{instance_id(root)}'


def state_dir(root=None):
    root = root or ROOT
    return Path(root) / STATE_NAME


def admin_url(password, port):
    return f'postgresql://postgres:{quote(password, safe="")}@127.0.0.1:{port}/postgres'


def redact(text, password):
    """Error text from tools may echo a connection string; the password never reaches the console."""
    return text.replace(password, '***').replace(quote(password, safe=''), '***') if password else text


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def port_free(port):
    """Whether a server could listen on 127.0.0.1:port now. Anything accepting connections there makes it busy. The
    bind uses SO_REUSEADDR, as PostgreSQL does, so the TIME_WAIT connections a stopped server leaves behind do not count
    as the port being in use; Linux still refuses that bind while any socket listens on the port, and the connect
    probe covers the BSD and macOS rule that lets it succeed beside a wildcard (0.0.0.0) listener."""
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(('127.0.0.1', port)) == 0:
            return False
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            return False
    return True


def is_loopback_url(url):
    """The same rule verify.py applies: a postgres URI whose host is loopback."""
    parts = urlsplit(url)
    return parts.scheme in ('postgres', 'postgresql') and parts.hostname in ('localhost', '127.0.0.1', '::1')


def server_major(version_text):
    """16 from 'postgres (PostgreSQL) 16.4 (Debian ...)', None when unreadable."""
    match = re.search(r'\(PostgreSQL\)\s+(\d+)', version_text)
    return int(match[1]) if match else None


def candidate_bin_dirs(environ=os.environ, which=shutil.which, run=subprocess.run, glob=None):
    """Directories that may hold the server tools, most specific first, without duplicates."""
    found = []
    if environ.get('PG_BIN'):
        found.append(Path(environ['PG_BIN']))
    for tool in ('pg_ctl', 'initdb', 'postgres'):
        path = which(tool)
        if path:
            found.append(Path(path).resolve().parent)
    if which('pg_config'):
        try:
            found.append(Path(run(['pg_config', '--bindir'], capture_output=True, text=True, check=True).stdout.strip()))
        except (OSError, subprocess.CalledProcessError):
            pass
    glob = glob or (lambda pattern: sorted(Path('/').glob(pattern.lstrip('/')), reverse=True))
    for pattern in NATIVE_GLOBS:
        found.extend(glob(pattern))
    unique = []
    for directory in found:
        if directory not in unique:
            unique.append(directory)
    return unique


def native_bin_dir(directories, major=None):
    """The first directory holding initdb, pg_ctl and postgres, or None. $PG_BIN and PATH come first in directories;
    among the rest a directory named for `major` (default 16, what CI and production run) wins over newer ones."""
    usable = [Path(d) for d in directories if all(os.access(Path(d) / tool, os.X_OK) for tool in NATIVE_TOOLS)]
    if not usable:
        return None
    wanted = str(major or PRODUCTION_MAJOR)
    explicit = usable[0] if os.environ.get('PG_BIN') and usable[0] == Path(os.environ['PG_BIN']) else None
    return explicit or next((d for d in usable if wanted in d.parts or f'pgsql-{wanted}' in d.parts or f'postgresql@{wanted}' in str(d)), usable[0])


def container_runtime(name, which=shutil.which, run=subprocess.run):
    """The runtime's path when its CLI exists and its daemon answers this user, else None."""
    path = which(name)
    if not path:
        return None
    try:
        answered = run([path, 'info'], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return None
    return path if answered else None


def choose_backend(requested, bin_dir, runtimes):
    """('native', bin_dir) or (runtime name, path). runtimes maps docker/podman to a path or None."""
    if requested in ('auto', 'native') and bin_dir:
        return 'native', bin_dir
    for name in ('docker', 'podman'):
        if requested in ('auto', name) and runtimes.get(name):
            return name, runtimes[name]
    if requested == 'native':
        raise Failure('No initdb, pg_ctl and postgres found together (set PG_BIN to their directory).\n\n' + NO_SERVER)
    if requested in ('docker', 'podman'):
        raise Failure(f'{requested} is not installed, or its daemon does not answer this user.\n\n' + NO_SERVER)
    raise Failure(NO_SERVER)


def container_run_command(runtime, root, port, password_file, allow_pull):
    """`docker run` for this checkout's server: loopback port, tmpfs data, password from a file, never --privileged."""
    return [runtime, 'run', '--detach', '--name', container_name(root), '--label', f'{LABEL}={instance_id(root)}',
            '--pull', 'missing' if allow_pull else 'never',
            '--publish', f'127.0.0.1:{port}:5432', '--tmpfs', '/var/lib/postgresql/data',
            '--volume', f'{password_file}:/run/prizecheck-password:ro,z',
            '--env', 'POSTGRES_PASSWORD_FILE=/run/prizecheck-password', '--env', 'POSTGRES_USER=postgres',
            IMAGE, '-c', f'max_connections={SERVER_SETTINGS["max_connections"]}', '-c', 'fsync=off',
            '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off']


def server_conf(port):
    lines = [f'{key} = {value}' for key, value in SERVER_SETTINGS.items()]
    return '\n# prizecheck local-test-db\n' + '\n'.join([*lines, f'port = {port}']) + '\n'


class Instance:
    """This checkout's server, as recorded in .scratch/local-test-db/owner.json."""

    def __init__(self, root=None):
        self.root = Path(root or ROOT)
        self.dir = state_dir(root)
        self.record_file = self.dir / 'owner.json'
        self.password_file = self.dir / 'password'
        self.data = self.dir / 'data'
        self.log = self.dir / 'postgres.log'

    def record(self):
        if not self.record_file.exists():
            return None
        record = json.loads(self.record_file.read_text())
        if record.get('id') != instance_id(self.root) or Path(record.get('root', '')) != self.root.resolve():
            raise Failure(f'{self.record_file} belongs to another checkout ({record.get("root")}); leaving it alone.')
        return record

    def save(self, record):
        self.record_file.write_text(json.dumps(record, indent=2) + '\n')

    def password(self):
        return self.password_file.read_text().strip()

    def url(self, record):
        return admin_url(self.password(), record['port'])

    def create_state(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.dir, 0o700)
        if not self.password_file.exists():
            descriptor = os.open(self.password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w') as handle:
                handle.write(secrets.token_urlsafe(24) + '\n')

    # Native cluster

    def native_running(self, bin_dir):
        if not (self.data / 'PG_VERSION').exists():
            return False
        return subprocess.run([str(bin_dir / 'pg_ctl'), 'status', '-D', str(self.data)], capture_output=True).returncode == 0

    def native_start(self, bin_dir, record):
        if not (self.data / 'PG_VERSION').exists():
            initialised = subprocess.run(
                [str(bin_dir / 'initdb'), '-D', str(self.data), '-U', 'postgres', f'--pwfile={self.password_file}',
                 '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C'], capture_output=True, text=True)
            if initialised.returncode:
                raise Failure('initdb failed:\n' + redact(initialised.stderr, self.password()))
            with (self.data / 'postgresql.conf').open('a') as conf:
                conf.write(server_conf(record['port']))
        if self.native_running(bin_dir):
            return
        if not port_free(record['port']):
            record['port'] = free_port()
        started = subprocess.run([str(bin_dir / 'pg_ctl'), 'start', '-D', str(self.data), '-l', str(self.log), '-w',
                                  '-t', str(READY_TIMEOUT_S), '-o', f'-p {record["port"]}'], capture_output=True, text=True)
        if started.returncode:
            raise Failure(f'The server did not start; see {self.log}\n' + redact(started.stderr, self.password()))

    def native_bins(self, record):
        """The recorded bin directory, or another holding the cluster's major version (a package upgrade may have moved
        it), or None."""
        major = (self.data / 'PG_VERSION').read_text().strip() if (self.data / 'PG_VERSION').exists() else None
        found = native_bin_dir([Path(record['bin_dir'])])
        if found:
            return found
        candidate = native_bin_dir(candidate_bin_dirs(), major)
        if candidate and major and server_major(subprocess.run([str(candidate / 'postgres'), '--version'],
                                                               capture_output=True, text=True).stdout) == int(major):
            return candidate
        return None

    def pid_alive(self):
        """Whether data/postmaster.pid names a live process; a reboot leaves a stale file behind."""
        try:
            pid = int((self.data / 'postmaster.pid').read_text().split()[0])
            os.kill(pid, 0)
        except (OSError, ValueError, IndexError):
            return False
        return True

    def native_stop(self, record):
        """True when it stopped a server. A cluster that may be running with no pg_ctl to stop it is an error, so that
        destroy never deletes the data directory of a live server."""
        bin_dir = self.native_bins(record)
        if bin_dir is None:
            if self.pid_alive():
                raise Failure(f'{record["bin_dir"]} no longer holds pg_ctl and no PostgreSQL {record.get("major", "")} '
                              'tools were found, but data/postmaster.pid says the server may be running. Set PG_BIN to '
                              'its bin directory and rerun; nothing was stopped or removed.')
            return False
        if not self.native_running(bin_dir):
            return False
        subprocess.run([str(bin_dir / 'pg_ctl'), 'stop', '-D', str(self.data), '-m', 'fast', '-w'], check=True,
                       capture_output=True)
        return True

    # Container

    def owned_container(self, runtime):
        """'running', 'stopped' or None. A container with this name but another label is someone else's: refuse."""
        found = subprocess.run([runtime, 'container', 'inspect', '--format', f'{{{{index .Config.Labels "{LABEL}"}}}} {{{{.State.Running}}}}',
                                container_name(self.root)], capture_output=True, text=True)
        if found.returncode:
            return None
        label, running = (found.stdout.split() + ['', ''])[:2]
        if label != instance_id(self.root):
            raise Failure(f'A container named {container_name(self.root)} exists without this checkout\'s label; leaving it alone.')
        return 'running' if running == 'true' else 'stopped'

    def container_start(self, runtime, record, allow_pull):
        state = self.owned_container(runtime)
        if state == 'running':
            return
        if state == 'stopped':
            self.container_remove(runtime)
        if not port_free(record['port']):
            record['port'] = free_port()
        created = subprocess.run(container_run_command(runtime, self.root, record['port'], self.password_file, allow_pull),
                                 capture_output=True, text=True)
        if created.returncode:
            image_missing = not allow_pull and re.search(r'image|manifest|pull', created.stderr, re.IGNORECASE)
            hint = f'\nThe image is not on this host; rerun with --allow-pull to fetch {IMAGE}.' if image_missing else ''
            raise Failure(f'{runtime} could not start the container:\n{created.stderr.strip()}{hint}')
        deadline = time.monotonic() + READY_TIMEOUT_S
        while time.monotonic() < deadline:
            # -h 127.0.0.1: the image's first-boot server listens on its socket only, the final one on TCP.
            if subprocess.run([runtime, 'exec', container_name(self.root), 'pg_isready', '-q', '-h', '127.0.0.1', '-U',
                               'postgres'], capture_output=True).returncode == 0:
                return
            time.sleep(0.5)
        raise Failure(f'The container did not become ready in {READY_TIMEOUT_S} s; see `{runtime} logs {container_name(self.root)}`.')

    def container_remove(self, runtime):
        """True when it removed this checkout's container."""
        if not self.owned_container(runtime):
            return False
        subprocess.run([runtime, 'rm', '--force', container_name(self.root)], check=True, capture_output=True)
        return True


def resolve(requested):
    directories = candidate_bin_dirs()
    runtimes = {name: container_runtime(name) for name in ('docker', 'podman') if requested in ('auto', name)}
    return choose_backend(requested, native_bin_dir(directories), runtimes)


@contextmanager
def state_lock():
    """One command at a time on this checkout's server: start, stop and destroy each take it once (flock is held per
    open file, so a nested take in the same process would wait on itself)."""
    lock_file = ROOT / '.scratch' / 'local-test-db.lock'
    lock_file.parent.mkdir(exist_ok=True)
    with lock_file.open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def start(args):
    """Start (or reuse) this checkout's server and return (instance, record)."""
    with state_lock():
        return start_locked(args)


def start_locked(args):
    instance = Instance()
    record = instance.record()
    if record:
        backend = record['backend']
        if args.backend not in ('auto', backend):
            raise Failure(f'This checkout\'s server uses the {backend} backend; run `destroy` first to switch to {args.backend}.')
        if backend == 'native':
            where = instance.native_bins(record)
            if where is None:
                raise Failure(f'{record["bin_dir"]} no longer holds initdb, pg_ctl and postgres, and no other directory '
                              f'has PostgreSQL {record.get("major", "")}; set PG_BIN, or run `destroy` and start again.')
            record['bin_dir'] = str(where)
        else:
            where = record['runtime']
            if not shutil.which(where):
                raise Failure(f'{where} is gone; this checkout\'s container cannot be reached. Reinstall it, or remove the '
                              f'container {record["container"]} by hand and then .scratch/local-test-db.')
    else:
        backend, where = resolve(args.backend)
        instance.create_state()
        record = {'id': instance_id(), 'root': str(ROOT.resolve()), 'backend': backend, 'port': free_port(),
                  'created': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        if backend == 'native':
            record['bin_dir'] = str(where)
            record['major'] = server_major(subprocess.run([str(where / 'postgres'), '--version'], capture_output=True,
                                                          text=True).stdout)
        else:
            record['runtime'], record['container'] = str(where), container_name()
        instance.save(record)
    if backend == 'native':
        instance.native_start(where, record)
    else:
        instance.container_start(where, record, args.allow_pull)
    instance.save(record)
    return instance, record


def describe(record):
    where = f'cluster in {STATE_NAME}/data, binaries {record["bin_dir"]}' if record['backend'] == 'native' \
        else f'container {record["container"]} ({record["runtime"]})'
    return f'{record["backend"]}: {where}, 127.0.0.1:{record["port"]}'


def command_start(args):
    _, record = start(args)
    print(f'local-test-db running: {describe(record)}. The URL stays in {STATE_NAME}; use `run -- <command>`.')
    return 0


def command_run(args):
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        raise Failure('Name a command after --, for example: run -- npm run verify -- --suite api')
    env = dict(os.environ)
    if env.get('TEST_ADMIN_DATABASE_URL') and not args.local:
        print('local-test-db: using TEST_ADMIN_DATABASE_URL from the environment (pass --local to use this checkout\'s server).',
              flush=True)
    else:
        instance, record = start(args)
        env['TEST_ADMIN_DATABASE_URL'] = instance.url(record)
        print(f'local-test-db: TEST_ADMIN_DATABASE_URL set for the command ({describe(record)}).', flush=True)
    try:
        os.execvpe(command[0], command, env)
    except OSError as error:
        raise Failure(f'Could not run {command[0]}: {error}')


def command_status(args):
    instance = Instance()
    record = instance.record()
    if not record:
        print(f'local-test-db: none for this checkout ({STATE_NAME} has no record).')
        return 0
    if record['backend'] == 'native':
        bin_dir = instance.native_bins(record)
        running = bool(bin_dir) and instance.native_running(bin_dir)
    else:
        running = shutil.which(record['runtime']) and instance.owned_container(record['runtime']) == 'running'
    print(f'local-test-db: {"running" if running else "stopped"}; {describe(record)}')
    return 0


def command_stop(args):
    with state_lock():
        return stop_locked()


def stop_locked():
    instance = Instance()
    record = instance.record()
    if not record:
        print('local-test-db: nothing to stop.')
        return 0
    if record['backend'] == 'native':
        stopped = instance.native_stop(record)
    else:
        if not shutil.which(record['runtime']):
            raise Failure(f'{record["runtime"]} is gone, so container {record["container"]} cannot be checked or '
                          'removed; nothing was removed. Reinstall it, or remove the container by hand and then '
                          '.scratch/local-test-db.')
        # The container keeps its data on tmpfs, so stopping it and removing it lose the same thing.
        stopped = instance.container_remove(record['runtime'])
    print(f'local-test-db: {"stopped" if stopped else "was not running"} ({describe(record)}).')
    return 0


def command_destroy(args):
    with state_lock():
        return destroy_locked()


def destroy_locked():
    instance = Instance()
    record = instance.record()
    if record:
        stop_locked()
    elif instance.pid_alive():
        raise Failure(f'{STATE_NAME} has no owner.json, but data/postmaster.pid names a running process; stop that '
                      'server with pg_ctl first. Nothing was removed.')
    if instance.dir.exists():
        resolved = instance.dir.resolve()
        if resolved.parent != (ROOT / '.scratch').resolve() or resolved.name != STATE_NAME.name:
            raise Failure(f'Refusing to remove {resolved}: not this checkout\'s {STATE_NAME}.')
        shutil.rmtree(resolved)
    print(f'local-test-db: removed {STATE_NAME} and the server it recorded.')
    return 0


GIT_CONFIG_SOURCES = ('GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM')


def git_environment(environ):
    """environ without the GIT_* variables a git hook exports (GIT_DIR, GIT_INDEX_FILE, ...), so git finds the repository
    from cwd. The config-source variables stay: they choose which config files git reads, never which repository."""
    return {key: value for key, value in environ.items() if not key.startswith('GIT_') or key in GIT_CONFIG_SOURCES}


def git(*args, root=None):
    env = git_environment(os.environ)
    result = subprocess.run(['git', *args], cwd=root or ROOT, capture_output=True, text=True, env=env)
    return result.stdout.strip() if result.returncode == 0 else None


def hooks_dir(root=None):
    """The directory git runs hooks from in this checkout, and whether git config names it."""
    root = root or ROOT
    configured = git('config', '--get', 'core.hooksPath', root=root)
    if not configured:
        return None, False
    path = Path(configured)
    return (path if path.is_absolute() else Path(root) / path), True


def command_hooks(args):
    """husky writes .husky/_ and sets core.hooksPath; the config is shared by every worktree of the repository, so in a
    worktree this writes the files only, after checking the shared config already points at .husky/_."""
    configured = git('config', '--get', 'core.hooksPath')
    if configured != '.husky/_':
        raise Failure(f'core.hooksPath is {configured!r}, not .husky/_; run `npx husky` in the main checkout (it sets it).')
    source = ROOT / 'node_modules' / 'husky' / 'husky'
    if not source.exists():
        raise Failure('node_modules/husky is missing; install dependencies first (docs/agents/local-testing.md).')
    target = ROOT / '.husky' / '_'
    target.mkdir(parents=True, exist_ok=True)
    (target / '.gitignore').write_text('*')
    shutil.copyfile(source, target / 'h')
    for hook in HUSKY_HOOKS:
        (target / hook).write_text('#!/usr/bin/env sh\n. "$(dirname "$0")/h"')
        os.chmod(target / hook, 0o755)
    print('hooks: wrote .husky/_ for this worktree; git config unchanged.')
    return 0


def playwright_chromium(root=None, environ=os.environ):
    """(revision, installed) for the Chromium this checkout's Playwright expects, or (None, False)."""
    root = root or ROOT
    browsers = Path(root) / 'node_modules' / 'playwright-core' / 'browsers.json'
    if not browsers.exists():
        return None, False
    revision = next((b['revision'] for b in json.loads(browsers.read_text())['browsers'] if b['name'] == 'chromium'), None)
    cache = Path(environ.get('PLAYWRIGHT_BROWSERS_PATH') or Path.home() / ('Library/Caches/ms-playwright' if sys.platform == 'darwin'
                                                                         else '.cache/ms-playwright'))
    return revision, bool(revision) and (cache / f'chromium-{revision}').is_dir()


def doctor_rows(root=None, environ=os.environ):
    """(check, ok, detail) rows. Never includes a URL or password."""
    root = Path(root or ROOT)
    rows = []
    node = shutil.which('node')
    node_version = subprocess.run([node, '--version'], capture_output=True, text=True).stdout.strip() if node else ''
    rows.append(('node >= 22', bool(node_version) and int(node_version.lstrip('v').split('.')[0]) >= 22, node_version or 'missing'))
    modules = root / 'node_modules'
    rows.append(('node_modules', (modules / '.package-lock.json').exists() and not modules.is_symlink(),
                 ('symlink to ' + str(modules.resolve().parent) + ': replace with an own install (Vite and Vitest '
                  'write caches through it)') if modules.is_symlink() else 'own install' if modules.exists() else 'missing: HUSKY=0 npm ci'))
    venv_python = root / '.venv' / 'bin' / 'python'
    imports = venv_python.exists() and subprocess.run([str(venv_python), '-c', 'import psycopg, pytest, fastapi, xdist'],
                                                      capture_output=True).returncode == 0
    rows.append(('.venv', imports and not (root / '.venv').is_symlink(),
                 ('symlink: replace with an own install' if (root / '.venv').is_symlink() else 'own install') if imports
                 else 'missing or incomplete: python3 -m venv .venv && .venv/bin/pip install -r api/requirements.txt'))
    hooks, configured = hooks_dir(root)
    hooks_ok = bool(hooks) and (hooks / 'pre-commit').exists()
    rows.append(('git hooks', hooks_ok, f'{hooks}' if hooks_ok else
                 (f'{hooks} missing: git would skip pre-commit and commit-msg; run `python3 scripts/local_test_db.py hooks`'
                  if configured else 'core.hooksPath unset: run `npx husky` once in the main checkout')))
    rows.append(('full git history', git('rev-parse', '--is-shallow-repository', root=root) == 'false',
                 'needed by the operations suite\'s runtime fixtures'))
    revision, chromium = playwright_chromium(root, environ)
    rows.append(('Playwright Chromium', chromium, f'chromium-{revision}' + ('' if chromium else ' missing: npx playwright install chromium')))
    for tool in ('psql', 'pg_dump'):
        rows.append((tool, bool(shutil.which(tool)), shutil.which(tool) or 'missing: the operations suite and recovery tests call it'))
    url = environ.get('TEST_ADMIN_DATABASE_URL')
    rows.append(('TEST_ADMIN_DATABASE_URL', not url or is_loopback_url(url),
                 ('set, loopback' if is_loopback_url(url) else 'set but not a loopback postgres URI') if url else 'unset (run supplies it)'))
    bin_dir = native_bin_dir(candidate_bin_dirs(environ))
    runtimes = {name: container_runtime(name) for name in ('docker', 'podman')}
    if bin_dir:
        major = server_major(subprocess.run([str(bin_dir / 'postgres'), '--version'], capture_output=True, text=True).stdout)
        detail = f'native {bin_dir} (PostgreSQL {major})' + ('' if major == PRODUCTION_MAJOR else f'; CI and prod run {PRODUCTION_MAJOR}')
    else:
        detail = next((f'{name} ({path})' for name, path in runtimes.items() if path), None)
    rows.append(('local server backend', bool(bin_dir or detail or url),
                 detail or ('none needed: TEST_ADMIN_DATABASE_URL is set' if url else 'none: no server binaries, Docker or Podman')))
    return rows


def tiers(rows):
    ok = {name: good for name, good, _ in rows}
    deps = ok['node >= 22'] and ok['node_modules'] and ok['.venv']
    db = ok['local server backend'] and ok['TEST_ADMIN_DATABASE_URL']
    return [
        ('DB-free: npm run check, guardrails, test:unit, build', deps),
        ('DB-backed: verify --suite api / --suite auth', deps and db),
        ('browser: verify --suite browser', deps and db and ok['Playwright Chromium']),
        ('operations: verify --suite operations, full gate', deps and db and ok['Playwright Chromium'] and ok['psql']
         and ok['pg_dump'] and ok['full git history']),
    ]


def command_doctor(args):
    rows = doctor_rows()
    for name, good, detail in rows:
        print(f'  [{"ok" if good else "!!"}] {name}: {detail}')
    print()
    for name, ready in tiers(rows):
        print(f'  {"ready  " if ready else "blocked"}  {name}')
    if not dict((name, good) for name, good, _ in rows)['local server backend']:
        print('\n' + NO_SERVER)
    return 0 if tiers(rows)[0][1] else 1


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='name', required=True)
    for name, handler in (('doctor', command_doctor), ('start', command_start), ('status', command_status),
                          ('stop', command_stop), ('destroy', command_destroy), ('run', command_run), ('hooks', command_hooks)):
        sub = commands.add_parser(name)
        sub.set_defaults(handler=handler)
        if name in ('start', 'run'):
            sub.add_argument('--backend', choices=('auto', 'native', 'docker', 'podman'), default='auto')
            sub.add_argument('--allow-pull', action='store_true', help=f'let docker or podman fetch {IMAGE} if missing')
        if name == 'run':
            sub.add_argument('--local', action='store_true', help='use this checkout\'s server even when TEST_ADMIN_DATABASE_URL is set')
            sub.add_argument('command', nargs=argparse.REMAINDER)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_arguments(argv)
    try:
        return args.handler(args)
    except Failure as failure:
        print(f'local-test-db: {failure}', file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as error:
        print(f'local-test-db: {error.cmd[0]} failed with exit code {error.returncode}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
