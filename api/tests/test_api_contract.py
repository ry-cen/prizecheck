"""The public HTTP contract: the OpenAPI document and the route table, as generated from the code before the shared-core split.

Both files under api_contract/ were generated once from the code as it stood before the split. There is no regenerate flag: a
change to either file is a change to the API contract and needs the owner's approval.
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
