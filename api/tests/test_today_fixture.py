"""The CI-only check date: ``today_fixture`` replaces ``today()`` in the two format modules, and only when asked."""
import os
from pathlib import Path
import subprocess
import sys

FIXTURE = Path(__file__).parent / 'catalog_process_fixture'
API = Path(__file__).parent.parent

CODE = '''
from datetime import datetime, timezone
from app import deck_format_checks, discovery, format_standing
real = datetime.now(timezone.utc).date()
print(deck_format_checks.today(), format_standing.today(), discovery.today(), real)
'''


def run(tmp_path, **env):
    full = {k: v for k, v in os.environ.items() if not k.startswith('CATALOG_PROCESS')}
    full.update(env, PYTHONPATH=f'{FIXTURE}:{API}')
    done = subprocess.run([sys.executable, '-c', CODE], capture_output=True, text=True, env=full, cwd=tmp_path)
    assert done.returncode == 0, done.stderr
    return done.stdout.split()


def test_without_the_fixture_directory_the_date_is_real(tmp_path):
    (tmp_path / 'today').write_text('2020-01-02')
    first, second, third, real = run(tmp_path)
    assert first == second == third == real


def test_the_file_sets_every_check_date_and_removing_it_restores_the_real_one(tmp_path):
    (tmp_path / 'today').write_text('2020-01-02\n')
    assert run(tmp_path, CATALOG_PROCESS_FIXTURE_DIR=str(tmp_path))[:3] == ['2020-01-02'] * 3
    (tmp_path / 'today').unlink()
    first, second, third, real = run(tmp_path, CATALOG_PROCESS_FIXTURE_DIR=str(tmp_path))
    assert first == second == third == real
