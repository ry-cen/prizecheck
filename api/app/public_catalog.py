"""Compatibility shim: the module lives in app.games.pokemon.catalog.public_catalog. The Playwright specs import it as `app.public_catalog` and are not edited
during the shared-core refactor, so this name resolves to the same module object."""
import sys

from app.games.pokemon.catalog import public_catalog

sys.modules[__name__] = public_catalog
