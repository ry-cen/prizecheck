"""The CI-only price hooks: origin redirect, launcher stand-in and the loopback-only runner connect guard."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

import pytest

FIXTURE = Path(__file__).parent / 'catalog_process_fixture'
API = Path(__file__).parent.parent
sys.path.insert(0, str(FIXTURE))
import price_fixture  # noqa: E402


def run(code, tmp_path, **env):
    full = {k: v for k, v in os.environ.items() if not k.startswith(('PRICE_', 'CATALOG_PROCESS'))}
    full.update(env, PYTHONPATH=f'{FIXTURE}:{API}')
    return subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, env=full, cwd=tmp_path)


@pytest.fixture
def listener():
    with socket.socket() as server:
        server.bind(('127.0.0.1', 0))
        server.listen(4)
        yield server.getsockname()


def test_guard_refuses_non_loopback_connects_and_logs_them(listener, tmp_path):
    log = tmp_path / 'violations.log'
    uninstall = price_fixture.install_connect_guard(str(log))
    try:
        with socket.socket() as client:
            with pytest.raises(price_fixture.NonLoopbackConnection):
                client.connect(('192.0.2.1', 9))
            with pytest.raises(price_fixture.NonLoopbackConnection):
                client.connect_ex(('198.51.100.7', 9))
            with pytest.raises(price_fixture.NonLoopbackConnection):
                client.connect(('example.invalid', 9))  # an unresolved name is refused, not guessed
        with socket.socket() as client:
            client.connect(listener)  # loopback still works
        with socket.socket(socket.AF_UNIX) as unix:
            assert unix.connect_ex('/nonexistent.sock') != 0  # not refused by the guard: it fails on its own
    finally:
        uninstall()
    assert log.read_text().splitlines() == ["('192.0.2.1', 9)", "('198.51.100.7', 9)", "('example.invalid', 9)"]
    assert socket.socket.connect.__name__ == 'connect' and socket.socket.connect.__qualname__.startswith('socket.')


def test_the_guard_arms_in_a_process_that_starts_the_runner_and_not_before(tmp_path):
    code = ("import importlib.util, socket\n"
            "def attempt():\n"
            "    s = socket.socket(); s.settimeout(.2)\n"
            "    try:\n        s.connect(('192.0.2.1', 9)); return 'connected'\n"
            "    except OSError as e:\n        return type(e).__name__\n"
            "    finally:\n        s.close()\n"
            "before = attempt()\n"
            "importlib.util.find_spec('app.price_runner')\n"
            "print(before, attempt())\n")
    out = run(code, tmp_path, PRICE_RUNNER_LOCK_DIR=str(tmp_path))
    assert out.returncode == 0, out.stderr
    before, after = out.stdout.split()
    assert before != 'NonLoopbackConnection' and after == 'NonLoopbackConnection'
    assert (tmp_path / price_fixture.VIOLATIONS).read_text().strip() == "('192.0.2.1', 9)"


def test_without_the_lock_dir_nothing_is_installed(tmp_path):
    out = run("import sys; print(any(type(f).__name__ == '_PatchOnImport' for f in sys.meta_path))", tmp_path)
    assert out.stdout.strip() == 'False', out.stderr


@pytest.mark.parametrize('origin', ['https://127.0.0.1:1', 'http://api.tcgdex.net', 'http://127.0.0.1', 'http://u@127.0.0.1:1',
                                    'http://127.0.0.1:1/x', 'http://10.0.0.1:80'])
def test_only_loopback_http_origins_are_accepted(origin):
    with pytest.raises(RuntimeError):
        price_fixture.loopback_origin(origin)
    assert price_fixture.loopback_origin('http://127.0.0.1:8123') == 'http://127.0.0.1:8123'


def test_launcher_hook_records_and_fails_on_demand(tmp_path):
    log = tmp_path / 'launch.log'
    assert price_fixture.launcher_hook('record', str(log))(0, 'a' * 32) is True
    assert price_fixture.launcher_hook('fail', str(log))(1, 'b' * 32) is False
    rows = [json.loads(line) for line in log.read_text().splitlines()]
    assert [(r['slot'], r['outcome']) for r in rows] == [(0, True), (1, False)]
    with pytest.raises(RuntimeError):
        price_fixture.launcher_hook('real')


def test_launcher_hook_patches_the_module_on_import_and_a_bad_origin_is_loud(tmp_path):
    log = tmp_path / 'launch.log'
    code = "from app import price_launcher\nprint(price_launcher.spawn(0, 'a' * 32), price_launcher.spawn(1, 'b' * 32))\n"
    out = run(code, tmp_path, PRICE_FIXTURE_LAUNCHER='record', PRICE_FIXTURE_LAUNCH_LOG=str(log))
    assert out.returncode == 0, out.stderr
    assert out.stdout.split() == ['True', 'True'] and len(log.read_text().splitlines()) == 2
    out = run("from app import price_launcher; print(price_launcher.spawn(0, 'a' * 32))", tmp_path, PRICE_FIXTURE_LAUNCHER='fail')
    assert out.stdout.strip() == 'False', out.stderr
    (tmp_path / "not-a-directory").write_text("")
    out = run("from app import price_launcher; print(price_launcher.spawn(0, 'a' * 32))", tmp_path, PRICE_RUNNER_LOCK_DIR=str(tmp_path / "not-a-directory"))
    assert out.stdout.strip() == 'False', out.stderr  # the real launcher reports a launch failure instead of raising
    bad = run("pass", tmp_path, PRICE_FIXTURE_SOURCE_ORIGIN='https://api.tcgdex.net')
    assert 'loopback' in bad.stderr  # python reports a failing sitecustomize on stderr and carries on


# --- 08-C: launched runners reach the fake source through the lock directory ---------------------------------------
# The launcher's environment allowlist drops PRICE_FIXTURE_SOURCE_ORIGIN, so a launched runner learns the fake origin from
# a file in its (allowlisted) PRICE_RUNNER_LOCK_DIR.
@pytest.fixture
def recorder():
    """A loopback HTTP server that records each request's path and headers; ``hang`` makes it answer too late."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading
    seen, state = [], {'hang': False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            seen.append({'path': self.path, 'headers': {k.lower(): v for k, v in self.headers.items()}})
            if state['hang']:
                threading.Event().wait(4)
            body = b'{"id": "card-1"}'
            try:
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except OSError:
                pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{server.server_port}', seen, state
    server.shutdown()


def test_the_origin_file_in_the_lock_directory_redirects_the_source_and_the_env_wins(tmp_path):
    (tmp_path / price_fixture.ORIGIN_FILE).write_text('http://127.0.0.1:8123\n')
    show = "import app.price_source as s; print(s.ORIGIN)"
    out = run(show, tmp_path, PRICE_RUNNER_LOCK_DIR=str(tmp_path))
    assert out.stdout.strip() == 'http://127.0.0.1:8123', out.stderr
    out = run(show, tmp_path, PRICE_RUNNER_LOCK_DIR=str(tmp_path), PRICE_FIXTURE_SOURCE_ORIGIN='http://127.0.0.1:9001')
    assert out.stdout.strip() == 'http://127.0.0.1:9001', out.stderr
    (tmp_path / price_fixture.ORIGIN_FILE).unlink()
    out = run(show, tmp_path, PRICE_RUNNER_LOCK_DIR=str(tmp_path))
    assert out.stdout.strip() == 'https://api.tcgdex.net', out.stderr  # no file: the production origin is untouched


def test_the_origin_file_is_read_when_the_source_is_imported_not_at_start(tmp_path):
    target = tmp_path / price_fixture.ORIGIN_FILE
    code = ("import pathlib, sys\n"
            "pathlib.Path(sys.argv[1]).write_text('http://127.0.0.1:8124')\n"
            "import app.price_source as s; print(s.ORIGIN)\n")
    full = {k: v for k, v in os.environ.items() if not k.startswith(('PRICE_', 'CATALOG_PROCESS'))}
    full.update(PYTHONPATH=f'{FIXTURE}:{API}', PRICE_RUNNER_LOCK_DIR=str(tmp_path))
    out = subprocess.run([sys.executable, '-c', code, str(target)], capture_output=True, text=True, env=full, cwd=tmp_path)
    assert out.stdout.strip() == 'http://127.0.0.1:8124', out.stderr


@pytest.mark.parametrize('origin', ['https://api.tcgdex.net', 'http://10.0.0.1:80', 'garbage'])
def test_a_bad_origin_file_is_refused_loudly(tmp_path, origin):
    (tmp_path / price_fixture.ORIGIN_FILE).write_text(origin)
    out = run("import app.price_source as s; print(s.ORIGIN)", tmp_path, PRICE_RUNNER_LOCK_DIR=str(tmp_path))
    assert out.returncode != 0 and 'loopback' in out.stderr and 'api.tcgdex.net' not in out.stdout


def test_a_redirected_runner_names_its_slot_pid_and_group_and_a_hang_is_still_a_timeout(tmp_path, recorder):
    origin, seen, state = recorder
    (tmp_path / price_fixture.ORIGIN_FILE).write_text(origin)
    code = ("import os, sys\n"
            "sys.argv[1:] = ['--slot', '1', '--owner', 'a' * 32]\n"
            "import app.price_source as s\n"
            "r = s.fetch('card-1')\n"
            "print(r.ok, r.reason, os.getpid(), os.getpgid(0))\n")
    out = run(code, tmp_path, PRICE_RUNNER_LOCK_DIR=str(tmp_path))
    ok, reason, pid, pgid = out.stdout.split()
    assert (ok, reason) == ('True', 'None'), out.stderr
    headers = seen[0]['headers']
    assert seen[0]['path'] == '/v2/en/cards/card-1'
    assert (headers['x-fixture-slot'], headers['x-fixture-pid'], headers['x-fixture-pgid']) == ('1', pid, pgid)
    assert headers['accept'] == 'application/json'  # the client's own headers survive the merge
    state['hang'] = True
    out = run(code, tmp_path, PRICE_RUNNER_LOCK_DIR=str(tmp_path))
    assert out.stdout.split()[:2] == ['False', 'timeout'], out.stderr  # httpx.TimeoutException is still a timeout


def test_a_process_that_is_not_a_runner_sends_no_fixture_headers(tmp_path, recorder):
    origin, seen, _ = recorder
    (tmp_path / price_fixture.ORIGIN_FILE).write_text(origin)
    out = run("import app.price_source as s; print(s.fetch('card-1').ok)", tmp_path, PRICE_RUNNER_LOCK_DIR=str(tmp_path))
    assert out.stdout.strip() == 'True', out.stderr
    assert not any(key.startswith('x-fixture-') for key in seen[0]['headers'])


def test_runner_processes_register_their_pids_and_log_every_connect(tmp_path, listener):
    code = ("import importlib.util, os, socket\n"
            "importlib.util.find_spec('app.price_runner')\n"
            "child = os.fork()\n"
            "if child == 0:\n"
            f"    s = socket.socket(); s.connect({tuple(listener)!r}); s.close(); os._exit(0)\n"
            "os.waitpid(child, 0)\n"
            "print(os.getpid(), child)\n")
    out = run(code, tmp_path, PRICE_RUNNER_LOCK_DIR=str(tmp_path))
    assert out.returncode == 0, out.stderr
    parent, child = out.stdout.split()
    registry = tmp_path / price_fixture.PIDS_DIR
    assert {p.name: p.read_text() for p in registry.iterdir()} == {parent: 'supervisor', child: 'worker'}
    connects = [json.loads(line) for line in (tmp_path / price_fixture.CONNECTS).read_text().splitlines()]
    assert connects == [{'pid': int(child), 'address': list(listener)}]


def test_the_connect_log_records_unix_sockets_too(tmp_path):
    log = tmp_path / 'connects.log'
    uninstall = price_fixture.install_connect_guard(connect_log=str(log))
    try:
        with socket.socket(socket.AF_UNIX) as unix:
            assert unix.connect_ex('/nonexistent/.s.PGSQL.5432') != 0  # macOS caps AF_UNIX paths at 104 bytes
    finally:
        uninstall()
    assert json.loads(log.read_text())['address'] == '/nonexistent/.s.PGSQL.5432'
