"""price_import_job.py --rematch: the flag runs the promo re-evaluation after an import, and only then; a rematch that
verified any Edition rebinds."""
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.games.pokemon.prices import price_import

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "price_import_job.py"


class Conn:
    def close(self):
        pass


def test_the_script_lists_the_flag():
    out = subprocess.run([sys.executable, "-I", str(SCRIPT), "--help"], capture_output=True, text=True)
    assert out.returncode == 0 and "--rematch" in out.stdout and "--force" in out.stdout


@pytest.mark.parametrize("code,flag,changed,expected,outcome", [
    (0, True, 4, ["run", "rematch", "rebind"], "imported"), (3, True, 4, ["run", "rematch", "rebind"], "partial"),
    (0, True, 0, ["run", "rematch"], "unchanged"), (2, True, 4, ["run"], "failed"), (1, True, 4, ["run"], "failed"),
    (0, False, 4, ["run"], "imported"),
    (0, True, 4, ["run"], "locked")])  # another job holds the import lock: this one does no work at all
def test_the_rematch_runs_after_a_finished_import_only_when_asked(monkeypatch, capsys, code, flag, changed, expected, outcome):
    seen = []
    monkeypatch.setattr("app.db.connect", lambda **_: Conn())
    monkeypatch.setattr(price_import, "run",
                        lambda conn, force: seen.append("run") or SimpleNamespace(exit_code=code, outcome=outcome))
    monkeypatch.setattr("app.games.pokemon.prices.catalog_targets.rematch_promos", lambda conn: seen.append("rematch") or changed)
    monkeypatch.setattr(price_import, "rebind_only", lambda conn: seen.append("rebind") or 0)
    assert price_import.main(["--force", "--rematch"] if flag else ["--force"]) == code
    assert seen == expected
    assert (f"rematch changed {changed}" in capsys.readouterr().out) == ("rematch" in expected)


def test_a_rematch_that_raises_anything_is_logged_by_class_and_never_raised(monkeypatch, capsys):
    def explode(conn):
        raise ValueError("secret detail")
    monkeypatch.setattr("app.games.pokemon.prices.catalog_targets.rematch_promos", explode)
    price_import.rematch(Conn())
    output = capsys.readouterr().out
    assert "the rematch failed (ValueError)" in output and "secret detail" not in output
