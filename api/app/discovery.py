"""Anonymous Listed Deck discovery reads only sanitized public objects."""
import base64
import hashlib
import hmac
import json
import os
import unicodedata
from datetime import datetime
from xml.sax.saxutils import escape

from fastapi import APIRouter, HTTPException, Response
from pydantic import ValidationError

from .publications import PublicModel, PublicSnapshot, TOKEN, PUBLIC_HEADERS
from .public_projection import public_projection_store, ProjectionUnavailable

router = APIRouter(tags=['public discovery'])
HEADERS = {**PUBLIC_HEADERS, 'X-Robots-Tag': 'index, follow'}


class PublicCheckSummary(PublicModel):
    size_status: str
    shortage: str
    excess: str
    over_limit_groups: int
    unresolved_groups: int


class PublicDeckSummary(PublicModel):
    url: str
    title: str
    total: str
    published_at: datetime
    checks: PublicCheckSummary
    image_url: str | None


class DiscoveryPage(PublicModel):
    decks: list[PublicDeckSummary]
    revision: int
    next_cursor: str | None


def invalid_cursor():
    raise HTTPException(400, {'code': 'INVALID_CURSOR'}, headers=HEADERS)


def cursor_encode(query, revision, key):
    payload = json.dumps({'v': 1, 'q': query, 'r': revision, 'k': key}, separators=(',', ':')).encode()
    mac = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + mac).decode().rstrip('=')


def cursor_decode(token, query, revision):
    try:
        if len(token)>2048:
            raise ValueError()
        raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
        payload, mac = raw[:-32], raw[-32:]
        expected = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, expected):
            raise ValueError()
        value = json.loads(payload)
        if value['v'] != 1 or value['q'] != query or not isinstance(value['r'], int):
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


def listed_snapshots():
    try:
        objects, revision = public_projection_store().read_state()
        listed = []
        for token, record in objects.items():
            if not TOKEN.fullmatch(token) or record['visibility'] not in ('listed','unlisted'):
                raise ProjectionUnavailable()
            if record['visibility'] == 'listed':
                listed.append((token, PublicSnapshot.model_validate(record['snapshot'])))
        return listed, revision
    except (ProjectionUnavailable, ValidationError, KeyError, TypeError):
        raise HTTPException(503, {'code': 'PUBLIC_PROJECTION_UNAVAILABLE'}, headers=HEADERS) from None


def summary(token, public):
    checks = public.checks
    images = [edition.image_url for identity in public.identities for edition in identity.editions if edition.image_url]
    return PublicDeckSummary(url=f'/published/{token}', title=public.title, total=public.total, published_at=public.published_at,
        checks=PublicCheckSummary(size_status=checks.size_status, shortage=checks.shortage, excess=checks.excess,
             over_limit_groups=sum(item.status=='over_limit' for item in checks.identities),
             unresolved_groups=sum(item.status=='unresolved' for item in checks.identities)), image_url=images[0] if images else None)


def matches_query(public, query):
    """Title, Card Identity name, or any row's own Card Printing name, so a subtitled card ("Professor's Research
    (Professor Juniper)") stays findable by its subtitle after Card Identity dropped it."""
    return (query in public.title.casefold()
            or any(query in identity.name.casefold() for identity in public.identities)
            or any(edition.printing_name is not None and query in edition.printing_name.casefold()
                   for identity in public.identities for edition in identity.editions))


@router.get('/api/public/discovery', response_model=DiscoveryPage)
def discover(response: Response, q: str = '', cursor: str | None = None):
    response.headers.update(HEADERS)
    query = ' '.join(unicodedata.normalize('NFC',q).split()).casefold()
    if len(query)>120:
        raise HTTPException(422, {'code':'INVALID_SEARCH'}, headers=HEADERS)
    objects, revision = listed_snapshots()
    key = cursor_decode(cursor, query, revision) if cursor else None
    matches = [(token, public) for token, public in objects if not query or matches_query(public, query)]
    ordered = sorted(matches, key=lambda item: (item[1].published_at.isoformat(),item[0]), reverse=True)
    if key:
        ordered = [item for item in ordered if (item[1].published_at.isoformat(),item[0]) < key]
    page = ordered[:30]
    return DiscoveryPage(decks=[summary(token, public) for token,public in page], revision=revision,
        next_cursor=cursor_encode(query, revision, [page[-1][1].published_at.isoformat(),page[-1][0]]) if len(ordered)>30 else None)


@router.get('/api/public/sitemap.xml', response_class=Response)
def sitemap():
    objects, _ = listed_snapshots()
    origin = os.environ.get('PUBLIC_ORIGIN','http://localhost:5173').rstrip('/')
    urls = ''.join(f'<url><loc>{escape(origin + "/published/" + token)}</loc><lastmod>{public.published_at.date().isoformat()}</lastmod></url>'
                   for token, public in sorted(objects))
    xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls + '</urlset>'
    return Response(xml, media_type='application/xml', headers=HEADERS)
