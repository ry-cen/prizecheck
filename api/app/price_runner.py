"""Entry shim for ``python -m app.price_runner`` (design D11, rule 5). The runner is ``app.core.prices.runner``; the
Pokémon card source, record rules and quote values are bound in ``app.games.pokemon.prices.runner_entry``. The CI connect
guard arms on the lookup of this module name, so this shim is the first module the runner process imports, before any
PostgreSQL code (it imports none)."""
import sys

from app.games.pokemon.prices.runner_entry import main

if __name__ == '__main__':
    sys.exit(main())
