"""Pin the supported HTTP contract, including item-thread routes and match order.

Snapshot changes accompany owner-approved API changes; equality and route-order
assertions remain mandatory after the shared-core split.
"""
import json
from pathlib import Path
from app.main import app

CONTRACT = Path(__file__).parent / 'api_contract'


def route_table():
    """[sorted methods or None, path, name] for each route in match order, with included routers flattened."""
    rows = []
    for route in app.routes:
        for item in (route.effective_route_contexts() if hasattr(route, 'effective_route_contexts') else [route]):
            rows.append([sorted(item.methods) if getattr(item, 'methods', None) else None, item.path, item.name])
    return rows


def test_openapi_document_matches_the_snapshot():
    assert json.dumps(app.openapi(), indent=1, sort_keys=True) == (CONTRACT / 'openapi.json').read_text()


def test_route_table_matches_the_snapshot_in_order():
    assert route_table() == json.loads((CONTRACT / 'routes.json').read_text())


def test_static_inventory_reads_precede_thread_detail_routes():
    rows = route_table()
    for literal, dynamic in (
        ('/api/trades/list', '/api/trades/{trade_id}'),
        ('/api/loans/lent-out', '/api/loans/{loan_id}'),
        ('/api/loans/pending', '/api/loans/{loan_id}'),
        ('/api/loans/borrowed', '/api/loans/{loan_id}'),
    ):
        def index(path):
            return next(i for i, (methods, found, _) in enumerate(rows) if found.replace(':uuid', '') == path and 'GET' in (methods or []))
        assert index(literal) < index(dynamic), literal


def test_thread_contract_names_real_lists_details_and_offer_edits():
    schema = app.openapi()
    paths = schema['paths']
    for kind, detail, live in (('trade', 'TradeDetail', 'live_offer'), ('loan', 'LoanDetail', 'live_terms')):
        response = paths[f'/api/{kind}s']['get']['responses']['200']['content']['application/json']['schema']
        assert response['type'] == 'array' and response['items']['$ref'].endswith('/ThreadItem')
        assert live in schema['components']['schemas'][detail]['required']
        assert f'/api/{kind}s/{{thread_id}}/timeline' in paths
    assert schema['components']['schemas']['LoanDetail']['properties']['other']['$ref'].endswith('/ThreadParty')
    assert 'other' in schema['components']['schemas']['LoanDetail']['required']
    assert '/api/threads/pulse' in paths
    assert paths['/api/trades/{trade_id}/offer']['post']['requestBody']['content']['application/json']['schema']['$ref'].endswith('/ChangeOffer')
    assert not any('/conversations' in path for path in paths)
