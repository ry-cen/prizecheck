"""Entry shim for the name ``app.quote_contract`` (design D11, rule 5): the record contract now lives in
``app.core.prices.quote_contract``, which takes the quote ``source`` and ``currency`` as keyword-only parameters. This
module re-exports every name from it, and wraps the two functions that take those values with the Pokémon ones, so callers
that name ``app.quote_contract`` (the price-runner harness script and the api tests) keep working.

Core and mixed modules import ``app.core.prices.quote_contract`` directly, never this shim. Still pure: it imports no
PostgreSQL code and not ``app.main``.
"""
from app.core.prices import quote_contract as _core
from app.games.pokemon.prices import quote_values

globals().update({name: value for name, value in vars(_core).items() if not name.startswith('__')})
__all__ = _core.__all__


def new_quote_payload(attempt, amount, card, variant, provider_updated_at):
    return _core.new_quote_payload(attempt, amount, card, variant, provider_updated_at,
                                   source=quote_values.SOURCE, currency=quote_values.CURRENCY)


def validate_quote_payload(record):
    return _core.validate_quote_payload(record, source=quote_values.SOURCE, currency=quote_values.CURRENCY)
