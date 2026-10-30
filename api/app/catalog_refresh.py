"""Entry shim: `python -m app.catalog_refresh` runs the scheduled catalog change check (the module lives in app.games.pokemon.catalog)."""
from app.games.pokemon.catalog.catalog_refresh import main

if __name__ == "__main__":
    raise SystemExit(main())
