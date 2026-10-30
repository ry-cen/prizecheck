"""The Pokémon price runner: the core runner (``app.core.prices.runner``) bound to the Pokémon card source, record rules
and quote values (design D11). ``python -m app.price_runner`` starts ``main`` through the root shim.

The card source and the record rules are bound lazily: the supervisor must claim its slot before importing them, and the
forked worker imports them while that claim is in flight (the runner touches ``fetch`` and ``select_quote`` to do so)."""
import importlib

from app.core.prices import runner
from app.games.pokemon.prices import quote_values


class _Lazy:
    """A module named now and imported on first use."""

    def __init__(self, name):
        self._name = name

    def __getattr__(self, attr):
        return getattr(importlib.import_module(self._name), attr)


def main(argv=None):
    return runner.main(argv, card_source=_Lazy('app.games.pokemon.prices.price_source'),
                       record_rules=_Lazy('app.games.pokemon.prices.tcgdex_record'), source=quote_values.SOURCE,
                       currency=quote_values.CURRENCY)
