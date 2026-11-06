"""The actual initial-send OpenAPI closure, independent of stale broad snapshots."""
import json
from pathlib import Path

from app.main import app

FIXTURE = Path(__file__).parent / 'trade_send_fixtures/contract.json'


def contract():
    document = app.openapi()
    operation = document['paths']['/api/trades']['post']
    schemas = document['components']['schemas']
    found = {}

    def walk(value):
        if isinstance(value, dict):
            if '$ref' in value:
                name = value['$ref'].split('/')[-1]
                if name not in found:
                    found[name] = schemas[name]
                    walk(schemas[name])
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
    walk(operation)
    return {'operation': operation, 'schemas': dict(sorted(found.items()))}


def test_initial_send_operation_and_schema_closure():
    assert contract() == json.loads(FIXTURE.read_text())


def test_plain_and_explicit_current_response_are_disjoint_and_metadata_required():
    current = contract()
    success = current['operation']['responses']['201']['content']['application/json']['schema']
    assert success['anyOf'] == [{'$ref': '#/components/schemas/TradeView'},
                                {'$ref': '#/components/schemas/ReplayedTradeSend'}]
    envelope = current['schemas']['ReplayedTradeSend']
    assert set(envelope['required']) == {'outcome', 'view', 'label', 'trade'}
    for name, value in [('outcome', 'already_applied'), ('view', 'current'), ('label', 'Current Trade')]:
        assert envelope['properties'][name]['const'] == value
    assert 'outcome' not in current['schemas']['TradeView']['properties']
    assert {'thread_id', 'offer_id'} <= set(current['schemas']['TradeView']['required'])


def test_steps_keep_exact_round_and_revision_requirements():
    schemas = app.openapi()['components']['schemas']
    for name in ('TradeStep', 'ChangeOffer', 'ConfirmSwap'):
        assert {'offer_id', 'revision', 'idempotency_key'} <= set(schemas[name]['required'])
        assert schemas[name]['properties']['revision']['minimum'] == 1
        assert 'message' not in schemas[name]['properties']
