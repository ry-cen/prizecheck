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
