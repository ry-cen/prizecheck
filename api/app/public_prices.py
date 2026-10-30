"""Compatibility shim: the module lives in app.games.pokemon.prices.public_prices. The Playwright specs import it as `app.public_prices` and are not edited
during the shared-core refactor, so this name resolves to the same module object."""
import sys

from app.games.pokemon.prices import public_prices

sys.modules[__name__] = public_prices
