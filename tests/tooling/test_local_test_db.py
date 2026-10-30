"""scripts/local_test_db.py without a database, a container runtime or a network: discovery, backend choice, the
container command, ownership refusals, redaction and the doctor's tiers."""
import importlib.util
import json
import fcntl
import os
import socket
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('local_test_db', ROOT / 'scripts' / 'local_test_db.py')
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)


def git_free_environ():
    """os.environ without GIT_*: under a git hook GIT_DIR points at the real repository, and `git init` or
    `git config` in a temporary directory would then write to it. The user's global and system config are left out
    too, so a core.hooksPath set there cannot change what the tests see."""
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    return dict(env, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')


def scratch_git(directory, *config):
    env = git_free_environ()
    subprocess.run(['git', 'init', '-q', str(directory)], check=True, env=env)
    for key, value in config:
        subprocess.run(['git', '-C', str(directory), 'config', key, value], check=True, env=env)


def make_tools(directory, tools=db.NATIVE_TOOLS):
    directory.mkdir(parents=True, exist_ok=True)
    for tool in tools:
        (directory / tool).write_text('#!/bin/sh\n')
        os.chmod(directory / tool, 0o755)
    return directory


class Discovery(unittest.TestCase):
    def test_native_bin_dir_needs_all_three_server_tools(self):
        with tempfile.TemporaryDirectory() as temp:
            client_only = make_tools(Path(temp) / 'client', ('pg_ctl',))
            server = make_tools(Path(temp) / 'server')
            self.assertIsNone(db.native_bin_dir([client_only]))
            self.assertEqual(db.native_bin_dir([client_only, server]), server)

    def test_pg_bin_comes_first_and_duplicates_drop(self):
        found = db.candidate_bin_dirs(environ={'PG_BIN': '/opt/pg/bin'}, which=lambda tool: None,
                                      glob=lambda pattern: [Path('/opt/pg/bin')] if 'postgresql/*' in pattern else [])
        self.assertEqual(found, [Path('/opt/pg/bin')])

    def test_pg_config_bindir_is_a_candidate(self):
        run = mock.Mock(return_value=subprocess.CompletedProcess([], 0, stdout='/usr/lib/postgresql/16/bin\n'))
        found = db.candidate_bin_dirs(environ={}, which=lambda tool: '/usr/bin/pg_config' if tool == 'pg_config' else None,
                                      run=run, glob=lambda pattern: [])
        self.assertEqual(found, [Path('/usr/lib/postgresql/16/bin')])

    def test_server_major(self):
        self.assertEqual(db.server_major('postgres (PostgreSQL) 16.4 (Debian 16.4-1)'), 16)
        self.assertIsNone(db.server_major('garbage'))

    def test_runtime_without_answering_daemon_is_unavailable(self):
        run = mock.Mock(return_value=subprocess.CompletedProcess([], 1))
        self.assertIsNone(db.container_runtime('docker', which=lambda name: '/usr/bin/docker', run=run))
        self.assertIsNone(db.container_runtime('docker', which=lambda name: None, run=run))


class Versions(unittest.TestCase):
    def test_production_major_wins_over_newer(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('PG_BIN', None)
            newer = make_tools(Path(temp) / 'postgresql' / '17' / 'bin')
            wanted = make_tools(Path(temp) / 'postgresql' / '16' / 'bin')
            self.assertEqual(db.native_bin_dir([newer, wanted]), wanted)
            self.assertEqual(db.native_bin_dir([newer, wanted], major='17'), newer)

    def test_pg_bin_is_kept_whatever_its_version(self):
        with tempfile.TemporaryDirectory() as temp:
            newer = make_tools(Path(temp) / 'postgresql' / '17' / 'bin')
            wanted = make_tools(Path(temp) / 'postgresql' / '16' / 'bin')
            with mock.patch.dict(os.environ, {'PG_BIN': str(newer)}):
                self.assertEqual(db.native_bin_dir([newer, wanted]), newer)


class Ports(unittest.TestCase):
    def assert_busy_while_listening(self, address):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind((address, 0))
            server.listen()
            self.assertFalse(db.port_free(server.getsockname()[1]))

    def test_loopback_listener_is_busy(self):
        self.assert_busy_while_listening('127.0.0.1')

    def test_wildcard_listener_is_busy(self):
        self.assert_busy_while_listening('0.0.0.0')

    def test_closed_port_is_free(self):
        self.assertTrue(db.port_free(db.free_port()))

    def test_port_left_in_time_wait_counts_as_free(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(('127.0.0.1', 0))
            server.listen()
            port = server.getsockname()[1]
            self.assertFalse(db.port_free(port))
            client = socket.create_connection(('127.0.0.1', port))
            accepted, _ = server.accept()
            accepted.close()  # the server side closes first, so its end of the connection waits in TIME_WAIT
            client.close()
        self.assertTrue(db.port_free(port))


class Backend(unittest.TestCase):
    def test_auto_prefers_native_then_docker_then_podman(self):
        self.assertEqual(db.choose_backend('auto', Path('/pg'), {'docker': '/d'}), ('native', Path('/pg')))
        self.assertEqual(db.choose_backend('auto', None, {'docker': None, 'podman': '/p'}), ('podman', '/p'))

    def test_nothing_available_names_the_choices(self):
        with self.assertRaises(db.Failure) as raised:
            db.choose_backend('auto', None, {'docker': None, 'podman': None})
        message = str(raised.exception)
        self.assertIn('create_main_cluster = false', message)
        self.assertIn('--allow-pull', message)
        self.assertNotIn('systemctl', message)

    def test_requested_backend_is_not_swapped_for_another(self):
        with self.assertRaises(db.Failure):
            db.choose_backend('docker', Path('/pg'), {'docker': None})


class Container(unittest.TestCase):
    def test_run_command_is_loopback_tmpfs_labelled_and_does_not_pull_by_default(self):
        command = db.container_run_command('docker', ROOT, 54321, Path('/state/password'), allow_pull=False)
        joined = ' '.join(command)
        self.assertIn('--publish 127.0.0.1:54321:5432', joined)
        self.assertIn('--tmpfs /var/lib/postgresql/data', joined)
        self.assertIn(f'--label {db.LABEL}={db.instance_id(ROOT)}', joined)
        self.assertIn('--pull never', joined)
        self.assertIn('POSTGRES_PASSWORD_FILE=', joined)
        self.assertNotIn('--privileged', joined)
        self.assertNotIn('POSTGRES_PASSWORD=', joined)
        self.assertIn('docker.io/library/postgres:16-alpine', command)
        self.assertIn('/run/prizecheck-password:ro,z', joined)
        self.assertIn('--pull missing', ' '.join(db.container_run_command('docker', ROOT, 1, Path('/p'), allow_pull=True)))

    def test_names_differ_per_checkout(self):
        self.assertNotEqual(db.container_name('/a/one'), db.container_name('/a/two'))

    def test_foreign_container_with_our_name_is_refused(self):
        instance = db.Instance(ROOT)
        foreign = subprocess.CompletedProcess([], 0, stdout='someone-else true\n')
        with mock.patch.object(db.subprocess, 'run', return_value=foreign) as run:
            with self.assertRaises(db.Failure):
                instance.container_remove('docker')
        self.assertEqual(run.call_count, 1)  # inspected, never removed


class Ownership(unittest.TestCase):
    def test_record_of_another_checkout_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            instance = db.Instance(Path(temp))
            instance.dir.mkdir(parents=True)
            instance.record_file.write_text(json.dumps({'id': 'other', 'root': '/elsewhere'}))
            with self.assertRaises(db.Failure):
                instance.record()

    def test_state_is_private_and_password_kept(self):
        with tempfile.TemporaryDirectory() as temp:
            instance = db.Instance(Path(temp))
            instance.create_state()
            first = instance.password()
            instance.create_state()
            self.assertEqual(instance.password(), first)
            self.assertEqual(os.stat(instance.password_file).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(instance.dir).st_mode & 0o777, 0o700)


class NativeStop(unittest.TestCase):
    def test_missing_tools_with_a_live_pid_file_refuse_and_keep_data(self):
        with tempfile.TemporaryDirectory() as temp:
            instance = db.Instance(Path(temp))
            instance.data.mkdir(parents=True)
            (instance.data / 'PG_VERSION').write_text('16\n')
            (instance.data / 'postmaster.pid').write_text(f'{os.getpid()}\n')  # a live process
            record = {'bin_dir': str(Path(temp) / 'gone'), 'major': 16}
            with mock.patch.object(db, 'candidate_bin_dirs', return_value=[]):
                with self.assertRaises(db.Failure):
                    instance.native_stop(record)
            self.assertTrue((instance.data / 'PG_VERSION').exists())

    def test_stale_pid_file_does_not_block(self):
        with tempfile.TemporaryDirectory() as temp:
            instance = db.Instance(Path(temp))
            instance.data.mkdir(parents=True)
            dead = subprocess.Popen(['true'])
            dead.wait()
            (instance.data / 'postmaster.pid').write_text(f'{dead.pid}\n')
            with mock.patch.object(db, 'candidate_bin_dirs', return_value=[]):
                self.assertFalse(instance.native_stop({'bin_dir': str(Path(temp) / 'gone')}))

    def test_missing_tools_without_pid_file_stop_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            instance = db.Instance(Path(temp))
            instance.data.mkdir(parents=True)
            with mock.patch.object(db, 'candidate_bin_dirs', return_value=[]):
                self.assertFalse(instance.native_stop({'bin_dir': str(Path(temp) / 'gone')}))


class Destroy(unittest.TestCase):
    def test_destroy_without_record_refuses_a_live_postmaster(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = db.state_dir(root) / 'data'
            data.mkdir(parents=True)
            (data / 'postmaster.pid').write_text(f'{os.getpid()}\n')  # a live process, and no owner.json
            with mock.patch.object(db, 'ROOT', root):
                with self.assertRaises(db.Failure):
                    db.command_destroy(None)
            self.assertTrue((data / 'postmaster.pid').exists())

    def test_destroy_waits_for_the_state_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db.state_dir(root).mkdir(parents=True)
            finished = threading.Event()

            def destroy():
                with mock.patch('builtins.print'):
                    db.command_destroy(None)
                finished.set()

            with mock.patch.object(db, 'ROOT', root):
                with (root / '.scratch' / 'local-test-db.lock').open('w') as held:
                    fcntl.flock(held, fcntl.LOCK_EX)
                    worker = threading.Thread(target=destroy)
                    worker.start()
                    self.assertFalse(finished.wait(0.3))  # blocked behind the lock another command holds
                    self.assertTrue(db.state_dir(root).exists())
                worker.join(5)
            self.assertTrue(finished.is_set())
            self.assertFalse(db.state_dir(root).exists())

    def test_destroy_removes_only_this_checkouts_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = db.state_dir(root)
            state.mkdir(parents=True)
            (state / 'password').write_text('x')
            sibling = root / '.scratch' / 'verification'
            sibling.mkdir()
            with mock.patch.object(db, 'ROOT', root), mock.patch('builtins.print'):
                self.assertEqual(db.command_destroy(None), 0)
            self.assertFalse(state.exists())
            self.assertTrue(sibling.exists())


class Secrets(unittest.TestCase):
    def test_url_is_loopback_and_quotes_the_password(self):
        url = db.admin_url('p/w@x', 5555)
        self.assertEqual(url, 'postgresql://postgres:p%2Fw%40x@127.0.0.1:5555/postgres')
        self.assertTrue(db.is_loopback_url(url))
        self.assertFalse(db.is_loopback_url('postgresql://u@db.example.com/postgres'))

    def test_redact_hides_raw_and_quoted_password(self):
        self.assertEqual(db.redact('a p/w@x b p%2Fw%40x', 'p/w@x'), 'a *** b ***')

    def test_doctor_never_shows_the_url(self):
        url = 'postgresql://postgres:hunter2-secret@127.0.0.1:5432/postgres'
        # Hermetic: no docker or podman probe, no server binaries, no subprocess beyond the stub.
        with mock.patch.object(db, 'container_runtime', return_value=None), \
                mock.patch.object(db, 'candidate_bin_dirs', return_value=[]), \
                mock.patch.object(db.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, stdout='', stderr='')), \
                mock.patch.object(db, 'git', return_value='false'):
            rows = db.doctor_rows(environ={'TEST_ADMIN_DATABASE_URL': url, 'HOME': os.environ.get('HOME', '/')})
        self.assertNotIn('hunter2', repr(rows))
        self.assertIn(('local server backend', True, 'none needed: TEST_ADMIN_DATABASE_URL is set'), rows)

    def test_server_conf_listens_on_loopback_without_socket(self):
        conf = db.server_conf(6000)
        self.assertIn("listen_addresses = '127.0.0.1'", conf)
        self.assertIn("unix_socket_directories = ''", conf)
        self.assertIn('port = 6000', conf)


class Tiers(unittest.TestCase):
    def rows(self, **overrides):
        names = ('node >= 22', 'node_modules', '.venv', 'git hooks', 'full git history', 'Playwright Chromium', 'psql',
                 'pg_dump', 'TEST_ADMIN_DATABASE_URL', 'local server backend')
        return [(name, overrides.get(name, True), '') for name in names]

    def test_no_server_blocks_only_database_tiers(self):
        ready = dict(db.tiers(self.rows(**{'local server backend': False})))
        self.assertEqual(list(ready.values()), [True, False, False, False])

    def test_missing_chromium_blocks_browser_not_api(self):
        ready = list(dict(db.tiers(self.rows(**{'Playwright Chromium': False}))).values())
        self.assertEqual(ready, [True, True, False, False])


class Hooks(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, git_free_environ(), clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_hooks_write_files_and_leave_git_config_alone(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scratch_git(temp, ('core.hooksPath', '.husky/_'))
            (root / 'node_modules' / 'husky').mkdir(parents=True)
            (root / 'node_modules' / 'husky' / 'husky').write_text('# husky runner\n')
            config_before = (root / '.git' / 'config').read_text()
            with mock.patch.object(db, 'ROOT', root), mock.patch('builtins.print'):
                self.assertEqual(db.command_hooks(None), 0)
            self.assertEqual((root / '.git' / 'config').read_text(), config_before)
            self.assertTrue(os.access(root / '.husky' / '_' / 'pre-commit', os.X_OK))
            self.assertTrue(os.access(root / '.husky' / '_' / 'commit-msg', os.X_OK))

    def test_global_config_cannot_supply_the_hooks_path(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as home:
            Path(home, '.gitconfig').write_text('[core]\n\thooksPath = .husky/_\n')
            scratch_git(temp)
            with mock.patch.dict(os.environ, {'HOME': home}), mock.patch.object(db, 'ROOT', Path(temp)):
                with self.assertRaises(db.Failure):
                    db.command_hooks(None)

    def test_script_git_ignores_a_hooks_git_dir_but_keeps_config_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            scratch_git(temp)
            hook_env = {'GIT_DIR': '/nonexistent/.git', 'GIT_INDEX_FILE': '/nonexistent/index', 'GIT_CONFIG_NOSYSTEM': '1'}
            self.assertEqual(db.git_environment(hook_env), {'GIT_CONFIG_NOSYSTEM': '1'})
            with mock.patch.dict(os.environ, hook_env):
                self.assertEqual(Path(db.git('rev-parse', '--show-toplevel', root=Path(temp))).resolve(), Path(temp).resolve())

    def test_hooks_refuse_another_hooks_path(self):
        with tempfile.TemporaryDirectory() as temp:
            scratch_git(temp)
            with mock.patch.object(db, 'ROOT', Path(temp)):
                with self.assertRaises(db.Failure):
                    db.command_hooks(None)

    def test_missing_hooks_directory_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            scratch_git(temp, ('core.hooksPath', '.husky/_'))
            directory, configured = db.hooks_dir(Path(temp))
            self.assertTrue(configured)
            self.assertFalse((directory / 'pre-commit').exists())


if __name__ == '__main__':
    unittest.main()
