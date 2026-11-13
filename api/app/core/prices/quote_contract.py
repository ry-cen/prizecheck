"""The price amount grammar and the module clock (ADR 0019). Pure: no I/O, no psycopg, no ``app.main``.

``parse_amount`` is the one strict decimal grammar every price reader and writer validates against; ``wall_ms`` is the
wall clock the private price read ages quotes by, so tests can patch one place.
"""
from decimal import Decimal
import re
import time

__all__ = ['wall_ms', 'parse_amount']


# --- Clock ---------------------------------------------------------------------------------------------------------
def wall_ms() -> int:
    """Epoch milliseconds; tests patch it (``monkeypatch.setattr(quote_contract, 'wall_ms', ...)``). Callers must reach
    it as ``quote_contract.wall_ms()``."""
    return int(time.time() * 1000)


# --- Amount grammar ------------------------------------------------------------------------------------------------
_AMOUNT = re.compile(r'(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?')


def parse_amount(value) -> Decimal | None:
    """Strict decimal text -> Decimal, or None. Floats, exponents, signs, NaN/Infinity and long values are refused."""
    if type(value) is not str or not _AMOUNT.fullmatch(value):
        return None
    amount = Decimal(value)
    return amount if amount.is_finite() and amount >= 0 else None
