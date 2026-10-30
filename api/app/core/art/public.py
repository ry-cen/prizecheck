"""Anonymous art reads use storage pointers only (ADR 0006)."""
import hashlib
import json
import re

from fastapi.responses import JSONResponse, Response

from app.art_storage import check_key, storage
from app.core.art.urls import SIZES

REF = re.compile(r"[0-9a-f]{48}")
SHA = re.compile(r"[0-9a-f]{64}")


def pointer_key(ref, size) -> str:
    if not isinstance(ref, str) or not REF.fullmatch(ref) or size not in SIZES:
        raise ValueError('invalid public art address')
    return f'public/{size}/{ref[:2]}/{ref}'


def write_pointer(ref, size, *, storage_key, sha256, content_type):
    storage().put(pointer_key(ref, size), json.dumps(dict(key=storage_key, sha256=sha256,
                                                       content_type=content_type)).encode())


def delete_pointer(ref, size):
    storage().delete(pointer_key(ref, size))


def read_pointer(ref, size) -> dict | None:
    try:
        value = json.loads(storage().get(pointer_key(ref, size)))
        if not isinstance(value, dict) or set(value) != {'key', 'sha256', 'content_type'}:
            return None
        check_key(value['key'])
        if (not isinstance(value['sha256'], str) or not SHA.fullmatch(value['sha256'])
                or value['content_type'] not in ('image/webp', 'image/png', 'image/jpeg')):
            return None
        return value
    except Exception:
        return None


def public_address(ref: str | None, size: str, *, excluded_prefixes: tuple[str, ...]) -> str | None:
    pointer = read_pointer(ref, size)
    if pointer is None or pointer['key'].split('/')[0] in excluded_prefixes:
        return None
    return f"/api/public/art/{ref}/{size}?v={pointer['sha256'][:8]}"


def serve_public(ref, size, v, *, excluded_prefixes) -> Response:
    pointer = read_pointer(ref, size)
    if pointer is not None and pointer['key'].split('/')[0] not in excluded_prefixes:
        try:
            data = storage().get(pointer['key'])
            if data is not None and hashlib.sha256(data).hexdigest() == pointer['sha256']:
                return Response(data, media_type=pointer['content_type'], headers={
                    'Cache-Control': 'public, max-age=31536000, immutable' if v == pointer['sha256'][:8] else 'public, no-cache',
                    'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff'})
        except (OSError, ValueError):
            pass
    return JSONResponse({'detail': {'code': 'ART_NOT_FOUND'}}, status_code=404,
                        headers={'Cache-Control': 'no-store'})
