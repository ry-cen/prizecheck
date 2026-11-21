"""Pick named routes out of a core router so a game mounts only the commands it serves."""
from fastapi import APIRouter


def only(router: APIRouter, *names: str) -> APIRouter:
    """A new router holding the routes of ``router`` called ``names``, in the source router's order.

    Raises ValueError for no names, a repeated name, a name no route has, or a name more than one route has.
    The source is never changed. The result is read-only until it is passed to ``include_router``.
    """
    if not names:
        raise ValueError('only() needs at least one route name')
    if len(set(names)) != len(names):
        raise ValueError('only() was given a route name twice')
    for name in names:
        found = sum(1 for route in router.routes if getattr(route, 'name', None) == name)
        if found == 0:
            raise ValueError(f'no route named {name!r}')
        if found > 1:
            raise ValueError(f'route name {name!r} is ambiguous: {found} routes have it')
    picked = APIRouter()
    picked.routes.extend(route for route in router.routes if getattr(route, 'name', None) in names)
    return picked
