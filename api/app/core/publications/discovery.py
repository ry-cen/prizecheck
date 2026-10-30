"""Game-free discovery cursors and listed snapshot reads."""
import base64
import hashlib
import hmac
import json
import os
from datetime import datetime

from fastapi import HTTPException

from app.core.publications.publish import TOKEN, PUBLIC_HEADERS
from app.public_projection import ProjectionUnavailable, public_projection_store

HEADERS = {**PUBLIC_HEADERS, 'X-Robots-Tag': 'index, follow'}


def invalid_cursor():
    raise HTTPException(400, {'code': 'INVALID_CURSOR'}, headers=HEADERS)


def cursor_encode(query, format_name, revision, key):
    payload = json.dumps({'v': 2, 'q': query, 'f': format_name, 'r': revision, 'k': key}, separators=(',', ':')).encode()
    mac = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + mac).decode().rstrip('=')


def cursor_decode(token, query, format_name, revision):
    try:
        if len(token)>2048:
            raise ValueError()
        raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
        payload, mac = raw[:-32], raw[-32:]
        expected = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, expected):
            raise ValueError()
        value = json.loads(payload)
        if value['v'] != 2 or value['q'] != query or value['f'] != format_name or not isinstance(value['r'], int):
            raise ValueError()
        if value['r'] != revision:
            raise HTTPException(409, {'code': 'DISCOVERY_CHANGED'}, headers=HEADERS)
        key = value['k']
        if not isinstance(key, list) or len(key) != 2 or not all(isinstance(part,str) for part in key) or not TOKEN.fullmatch(key[1]):
            raise ValueError()
        datetime.fromisoformat(key[0])
        return tuple(key)
    except (ValueError, KeyError, TypeError):
        invalid_cursor()


def listed_snapshots(*, parse):
    """Every Listed snapshot as ``(token, public_deck.ActiveSnapshot)``, and the manifest revision. A malformed manifest
    or Listed record is 503, never a shorter list."""
    try:
        objects, revision = public_projection_store().read_state()
        listed = []
        for token, record in objects.items():
            if not TOKEN.fullmatch(token) or record['visibility'] not in ('listed','unlisted'):
                raise ProjectionUnavailable()
            if record['visibility'] == 'listed':
                listed.append((token, parse(token, record)))
        return listed, revision
    except (ProjectionUnavailable, KeyError, TypeError):
        raise HTTPException(503, {'code': 'PUBLIC_PROJECTION_UNAVAILABLE'}, headers=HEADERS) from None
