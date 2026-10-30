"""Entry shim: `python -m app.catalog_import` runs the Pokémon catalog import (the module lives in app.games.pokemon.catalog)."""
from app.games.pokemon.catalog.catalog_import import main

if __name__ == '__main__':
    raise SystemExit(main())
