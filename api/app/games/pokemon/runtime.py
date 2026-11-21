"""Pokémon's runtime: its own database, gateway key and cursor key, and the process-wide request counter."""
import os

from app import db, identity
from app.core.game_runtime import GameRuntime
from app.core.ops import operation_counts

# db and identity are read at call time, so a patched app.db.connect still reaches core handlers.
POKEMON = GameRuntime(
    game='pokemon',
    connect=lambda **options: db.connect(**options),
    verify=lambda request, user, stamp, signature: identity.verified_user(request, user, stamp, signature),
    cursor_secret=lambda: os.environ['INTERNAL_AUTH_SECRET'].encode(),
    counter=operation_counts.counter,
)
