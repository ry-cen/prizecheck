"""The price amount grammar and clock: pure, and the one parser every price path shares."""
import json
import subprocess
import sys

from app.core.prices import quote_contract as qc


def test_module_is_pure_and_prices_reexports_the_amount_parser():
    code = ("import sys, json; import app.core.prices.quote_contract; "
            "print(json.dumps([m for m in ('psycopg', 'app.main', 'app.games.pokemon.prices.prices') if m in sys.modules]))")
    out = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, check=True)
    assert json.loads(out.stdout) == []
    import app.main  # noqa: F401
    from app.games.pokemon.prices import prices
    assert prices.parse_amount is qc.parse_amount


def test_only_the_amount_grammar_and_clock_remain():
    assert qc.__all__ == ['wall_ms', 'parse_amount']


def test_wall_clock_is_one_patchable_function(monkeypatch):
    monkeypatch.setattr(qc, 'wall_ms', lambda: 42)
    assert qc.wall_ms() == 42
