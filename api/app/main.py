"""Pokémon API entry. Only the auth gateway may assert a user identity."""
from pydantic import BaseModel

from .db import connect
from .core.app_builder import build_app
from .core.ops.operation_counts import counter as operation_counter
from app.games.pokemon.app import LIFESPAN_HOOKS, ROUTERS


class HealthResponse(BaseModel):
    status: str


def health():
    return HealthResponse(status="ok")


app = build_app(
    title="PrizeCheck API", version="0.1.0", routers=ROUTERS,
    lifespan_hooks=LIFESPAN_HOOKS, health_endpoint=health,
    health_response_model=HealthResponse,
    connect=lambda **options: connect(**options),
)
