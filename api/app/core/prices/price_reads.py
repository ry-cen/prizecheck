"""The price-reads kill switch (ADR 0019, design 4.11).

Unset, empty or ``on`` reads normally. Any other value, such as ``off``, makes every price row answer unavailable/no_price
without a query, so a mistyped value fails safe. The variable is read at call time, so tests and operators need no restart
of the module.
"""
import os


def price_reads_enabled() -> bool:
    return os.environ.get('PRICE_READS', '').strip().lower() in ('', 'on')
