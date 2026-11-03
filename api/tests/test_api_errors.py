"""The game-free error raiser preserves the public error detail contract."""
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.api_errors import api_error as compatibility_api_error
from app.core.ops.api_errors import api_error


@pytest.mark.parametrize('status', [400, 403, 404, 409, 422, 503])
def test_error_preserves_status_and_code(status):
    with pytest.raises(HTTPException) as raised:
        api_error(status, 'example_error')
    assert raised.value.status_code == status
    assert raised.value.detail == {'code': 'example_error'}


def test_error_converts_detail_values_and_omits_only_none():
    with pytest.raises(HTTPException) as raised:
        api_error(409, 'conflict', source='source', quantity=0, enabled=False,
                  amount=Decimal('12.30'), empty='', missing=None)
    assert raised.value.detail == {
        'code': 'conflict', 'source': 'source', 'quantity': '0', 'enabled': 'False',
        'amount': '12.30', 'empty': '',
    }


def test_compatibility_import_uses_the_same_error_raiser():
    assert compatibility_api_error is api_error
    with pytest.raises(HTTPException) as raised:
        compatibility_api_error(409, 'conflict', quantity=0, missing=None)
    assert raised.value.status_code == 409
    assert raised.value.detail == {'code': 'conflict', 'quantity': '0'}
