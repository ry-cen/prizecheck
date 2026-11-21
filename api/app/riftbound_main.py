"""Riftbound API entry, local and test only. Not mounted by app.main and named in no deploy, gateway or compose file.

Run it only against a disposable Riftbound database: RIFTBOUND_DATABASE_URL for data, RIFTBOUND_INTERNAL_AUTH_SECRET
for the gateway's signature. It never reads DATABASE_URL or INTERNAL_AUTH_SECRET. Its runtime (app.games.riftbound.runtime)
owns its own request counter, so importing this module leaves Pokémon's process counter alone.
"""
from pydantic import BaseModel

from .core.app_builder import build_app
from app.games.riftbound.app import LIFESPAN_HOOKS, ROUTERS
from app.games.riftbound.runtime import RIFTBOUND


class HealthResponse(BaseModel):
    status: str


def health():
    return HealthResponse(status="ok")


app = build_app(
    title="PrizeCheck Riftbound API", version="0.1.0", routers=ROUTERS,
    lifespan_hooks=LIFESPAN_HOOKS, health_endpoint=health,
    health_response_model=HealthResponse,
    runtime=RIFTBOUND,
)
