"""price_import_job.py --rematch: the flag runs the promo re-evaluation after an import, and only then; a rematch that
verified any Edition rebinds."""
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import price_import

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "price_import_job.py"


class Conn:
    def close(self):
        pass


def test_the_script_lists_the_flag():
    out = subprocess.run([sys.executable, "-I", str(SCRIPT), "--help"], capture_output=True, text=True)
    assert out.returncode == 0 and "--rematch" in out.stdout and "--force" in out.stdout


@pytest.mark.parametrize("code,flag,changed,expected", [
    (0, True, 4, ["run", "rematch", "rebind"]), (3, True, 4, ["run", "rematch", "rebind"]),
    (0, True, 0, ["run", "rematch"]), (2, True, 4, ["run"]), (1, True, 4, ["run"]), (0, False, 4, ["run"])])
def test_the_rematch_runs_after_a_finished_import_only_when_asked(monkeypatch, capsys, code, flag, changed, expected):
    seen = []
    monkeypatch.setattr("app.db.connect", lambda **_: Conn())
    monkeypatch.setattr(price_import, "run", lambda conn, force: seen.append("run") or SimpleNamespace(exit_code=code))
    monkeypatch.setattr("app.catalog_targets.rematch_promos", lambda conn: seen.append("rematch") or changed)
    monkeypatch.setattr(price_import, "rebind_only", lambda conn: seen.append("rebind") or 0)
    assert price_import.main(["--force", "--rematch"] if flag else ["--force"]) == code
    assert seen == expected
    assert (f"rematch changed {changed}" in capsys.readouterr().out) == ("rematch" in expected)
