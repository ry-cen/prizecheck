"""Compatibility shim: the module lives in app.games.pokemon.prices.catalog_targets. The Playwright specs import it as
`app.catalog_targets` and are not edited during the shared-core refactor, so this name resolves to the same module object."""
import sys

from app.games.pokemon.prices import catalog_targets

sys.modules[__name__] = catalog_targets
