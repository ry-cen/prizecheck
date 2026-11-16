"""Compare against untouched origin/dev 989fbfcbc4ae57938fc0f05e696694e5c40780e3.

The two snapshots were captured before extraction, using the same serialization
below. They include endpoint/model identity as well as route registration order.
"""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

from app.core import app_builder
from app.main import app, health, HealthResponse

CONTRACT = Path(__file__).parent / 'app_builder_contract'


def build(**options):
    return app_builder.build_app(title='Test', version='1', routers=(),
                                 lifespan_hooks=((), ()), health_endpoint=health,
                                 health_response_model=HealthResponse, **options)


def test_complete_route_identity_and_canonical_openapi_match_before_extraction():
    rows = []
    for route in app.routes:
        for item in (route.effective_route_contexts() if hasattr(route, 'effective_route_contexts') else [route]):
            endpoint = item.endpoint
            rows.append([item.path, sorted(item.methods) if getattr(item, 'methods', None) else None,
                         item.name, endpoint.__module__, endpoint.__qualname__,
                         str(getattr(item, 'response_model', None))])
    assert rows == json.loads((CONTRACT / 'routes.json').read_text())
    assert json.dumps(app.openapi(), sort_keys=True, separators=(',', ':')) == (CONTRACT / 'openapi.txt').read_text()


@pytest.mark.parametrize('method,path,status,expected', [
    ('GET', '/api/health', 200, None),
    ('GET', '/api/public/example', 503, None),
    ('GET', '/outside', 503, None),
    ('POST', '/api/prices/editions', 503, None),
    ('GET', '/api/decks/example/cost', 503, None),
    ('GET', '/api/want-list/cost', 503, None),
    ('POST', '/api/trades/value', 503, None),
    ('GET', '/api/private', 200, (0, 0, 0)),
    ('GET', '/api/private', 401, (0, 1, 0)),
    ('GET', '/api/private', 403, (0, 1, 0)),
    ('GET', '/api/private', 503, (1, 0, 0)),
    ('GET', '/api/publication', 503, (1, 0, 1)),
])
def test_original_middleware_stack_and_counting_conditions(monkeypatch, method, path, status, expected):
    from starlette.responses import Response
    recorded = []
    monkeypatch.setattr(app_builder, 'operation_counter', SimpleNamespace(record=recorded.append))
    router = APIRouter()
    router.add_api_route(path, lambda: Response(status_code=status), methods=[method])
    candidate = app_builder.build_app(title='Test', version='1', routers=(router,),
                                     lifespan_hooks=((), ()), health_endpoint=health,
                                     health_response_model=HealthResponse)
    assert len(candidate.user_middleware) == len(app.user_middleware) == 1
    middleware = candidate.user_middleware[0]
    assert middleware.cls is BaseHTTPMiddleware
    assert middleware.kwargs['dispatch'].__name__ == 'bounded_operational_counts'
    response = TestClient(candidate).request(method, path)
    assert response.status_code == status
    if expected is None:
        assert recorded == []
    else:
        assert len(recorded) == 1
        count = recorded[0]
        assert (count.failures, count.authorization_denials, count.projection_failures) == expected
        assert count.elapsed_ms >= 0


def test_lifespan_order_and_repeated_builds_do_not_register_writer(monkeypatch):
    events = []
    monkeypatch.setattr(app_builder, 'operation_counter', SimpleNamespace(stop=lambda: events.append('stop')))
    hooks = ([lambda: events.append('start-1'), lambda: events.append('start-2')],
             [lambda: events.append('shutdown-1'), lambda: events.append('shutdown-2')])
    first = app_builder.build_app(title='One', version='1', routers=(), lifespan_hooks=hooks,
                                 health_endpoint=health, health_response_model=HealthResponse)
    second = build()
    assert first is not second

    async def run():
        async with first.router.lifespan_context(first):
            events.append('yield')
    asyncio.run(run())
    assert events == ['start-1', 'start-2', 'yield', 'shutdown-1', 'shutdown-2', 'stop']


def test_main_import_serves_health():
    assert TestClient(app).get('/api/health').json() == {'status': 'ok'}
