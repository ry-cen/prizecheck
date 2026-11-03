"""Signed inventory page cursors and carried sort values, shared by Collection, Holdings and Catalog Browse."""
import base64
import hashlib
import hmac
import json
import os
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException

from app.api_errors import api_error as fail


def encode_cursor(context, key):
    data=json.dumps({'context':context,'key':key},separators=(',',':')).encode()
    signature=hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(),data,hashlib.sha256).digest()
    return base64.urlsafe_b64encode(data+signature).decode().rstrip('=')


def cursor_key(token,context):
    """The key of a cursor signed for this context. 409 when only a revision moved; otherwise 400 INVALID_CURSOR."""
    try:
        raw=base64.urlsafe_b64decode(token+'='*(-len(token)%4))
        data,signature=raw[:-32],raw[-32:]
        if not hmac.compare_digest(signature,hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(),data,hashlib.sha256).digest()):
            raise ValueError
        payload=json.loads(data)
        old=payload['context']
        if old[:-2]!=context[:-2]: raise ValueError
        if old[-2]!=context[-2]: fail(409,'INVENTORY_CHANGED')
        if old[-1]!=context[-1]: fail(409,'CATALOG_CHANGED')
        return payload['key']
    except HTTPException: raise
    except (ValueError,KeyError,TypeError,UnicodeDecodeError): fail(400,'INVALID_CURSOR')


def decode_cursor(token,context):
    """The Collection page cursor: [sort value, Edition id]."""
    key=cursor_key(token,context)
    try:
        if not isinstance(key,list) or len(key)!=2: raise ValueError
        UUID(key[1])
        return key
    except (ValueError,TypeError,AttributeError): fail(400,'INVALID_CURSOR')


# A holding cursor carries the last row's sort values, so the next page never re-runs the listing to find
# its anchor. The signed context binds both revisions, so the values are still current when it returns.
# The Location path is left out (up to 12 × 120 characters); the next page re-reads it for one Location.
ANCHOR_TYPES = {'edition_id': UUID, 'location_id': UUID, 'number_missing': bool,
                'number_value': Decimal, 'edition_total': Decimal}


def anchor_columns(keys):
    """The sort columns a holding cursor carries, in key order."""
    return [column for column, _ in keys if column != 'location_key']


def anchor_json(value):
    return value if isinstance(value, (bool, str)) else str(value)


def anchor_value(column, raw):
    """One carried sort value, back in the type the listing compares it as. Raises on a wrong shape."""
    kind = ANCHOR_TYPES.get(column, str)
    if kind is bool:
        if not isinstance(raw, bool):
            raise ValueError
        return raw
    if not isinstance(raw, str):
        raise ValueError
    if kind is Decimal:
        value = Decimal(raw)
        if not value.is_finite():
            raise ValueError
        return value
    return UUID(raw) if kind is UUID else raw
