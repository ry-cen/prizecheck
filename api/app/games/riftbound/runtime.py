"""Riftbound's runtime: its own database, gateway key and request counter.

The cursor key is derived from the gateway key with a fixed label, so a cursor signed here never verifies under
Pokémon's key, even if an operator configures both games with the same secret.
"""
import hashlib
import hmac
import os

from app.core.game_runtime import GameRuntime
from app.core.ops.operation_counts import OperationCounter
from app.games.riftbound import db as rb_db, identity as rb_identity

CURSOR_LABEL = b'prizecheck riftbound inventory cursor v1'

RIFTBOUND = GameRuntime(
    game='riftbound',
    connect=lambda **options: rb_db.connect(**options),
    verify=lambda request, user, stamp, signature: rb_identity.verified_user(request, user, stamp, signature),
    cursor_secret=lambda: hmac.new(os.environ[rb_identity.SECRET_ENV].encode(), CURSOR_LABEL, hashlib.sha256).digest(),
    counter=OperationCounter(),
)
