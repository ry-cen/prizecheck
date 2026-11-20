"""The Riftbound app: the routers FastAPI mounts, in route order, and the startup and shutdown hooks (ADR 0023 amendment)."""
from app.games.riftbound.catalog.browse import router as catalog_browse_router

# FastAPI matches routes in registration order; keep this order.
ROUTERS = (catalog_browse_router,)

# No background work starts with the Riftbound app.
STARTUP_HOOKS: list = []
SHUTDOWN_HOOKS: list = []
LIFESPAN_HOOKS = (STARTUP_HOOKS, SHUTDOWN_HOOKS)
