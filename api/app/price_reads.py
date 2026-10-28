"""The price-reads kill switch (ADR 0019, design 4.11).

``PRICE_READS=off`` makes every price row answer unavailable/no_price without a query. Unset or ``on`` reads normally; any
other value also reads normally. The variable is read at call time, so tests and operators need no restart of the module.
"""
import os


def price_reads_enabled() -> bool:
    return os.environ.get('PRICE_READS', 'on') != 'off'
