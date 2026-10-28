"""Anonymous Listed Deck discovery reads only sanitized public objects (app redesign #182, spec "Publishing and public
routes": Discover).

Discover lists only the Listed Published Decks whose snapshot is ``legal`` in its Target Format today, newest first, 30
to a page, optionally narrowed by a search (``q``) and by Target Format (``format``). It never connects to PostgreSQL or
looks up a session: the snapshots come from the manifest, and everything else from the shared public records store.

Legality. A snapshot's result is the Published Deck format route's own evaluation (``published_format_checks.checks_for``)
over the frozen rows and the current public format facts, so Discover and the Published Deck page never disagree. Each
result is cached in this process by the snapshot digest, the Target Format, its rules file's SHA-256, the deciding code's
SHA-256 (``CODE_SHA256``), the rule-date window (``format_evaluator.next_rule_date`` of today) and the public format-fact
revision (``facts_revision``: a digest of every format fact the check reads, the rows' Printings and every printing of
their Reprint Groups), and recomputed when any of them moves. The facts are read on every request, because reading them
is what confirms a result: a cached result never stands in for an unreadable store. A snapshot whose facts can't be read
in time (store unavailable, deadline) is left out, never listed unchecked.

Cost. Each summary carries ``cost: {amount, priced_copies, total_copies}`` from the public ``price:`` records alone, read at the same
store generation as the facts with the Published Deck cost route's eligibility proof and price view (``published_cost._view``) and fold
(``deck_cost.summarize``). Discover writes nothing: no record, no manifest byte, no discovery revision. No price age is sent.

Contract: docs/public-projections.md ("Discover lists legal decks").
"""
import base64
import hashlib
import hmac
import json
import os
import threading
import time
import unicodedata
from collections import OrderedDict
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

from fastapi import APIRouter, HTTPException, Query, Response

from . import card_attributes, deck_format_checks, prices, public_catalog, public_deck, published_format_checks
from . import format_evaluator as evaluator
from .deck_cost import summarize
from .deck_format_checks import TargetFormat, today
from .public_catalog import marketplace_states
from .public_projection import ProjectionUnavailable, public_projection_store
from .public_records import public_record_store
from .published_cost import _view
from .publications import PublicModel, TOKEN, PUBLIC_HEADERS

router = APIRouter(tags=['public discovery'])
HEADERS = {**PUBLIC_HEADERS, 'X-Robots-Tag': 'index, follow'}
PAGE = 30
# Every Discover request confirms its decks within this many seconds of store reads; decks not confirmed by then are left
# out of the answer.
DISCOVER_SECONDS = 3.0
# Decks confirmed per store read: a page of 30 plus the one that says another page exists, with room for a few that
# aren't legal.
CHUNK = 32
CACHE_ENTRIES = 4096
# A cached result is reusable only while the code that decided it is unchanged: the evaluator, the attribute reader, the
# public fact reader and the published result formatting.
CODE_SHA256 = hashlib.sha256(b''.join(Path(path).read_bytes() for path in (
    evaluator.__file__, card_attributes.__file__, public_catalog.__file__, published_format_checks.__file__,
    deck_format_checks.__file__))).hexdigest()


class PublicCheckSummary(PublicModel):
    size_status: str
    shortage: str
    excess: str
    over_limit_groups: int
    unresolved_groups: int


class DiscoverCost(PublicModel):
    """The deck's cost from cached quotes only (base-10 strings, like the Published Deck cost)."""
    amount: str | None          # exact decimal subtotal of the priced copies; None when no copy is priced
    priced_copies: str          # copies with a cached quote, stale ones included
    total_copies: str           # every copy in the snapshot


class PublicDeckSummary(PublicModel):
    url: str
    title: str
    total: str
    published_at: datetime
    checks: PublicCheckSummary
    image_url: str | None       # the featured card's art (``featured``)
    featured_name: str | None   # the featured card's name, for its alt text
    target_format: TargetFormat
    target_format_status: evaluator.Status  # always 'legal': only legal decks are listed
    cost: DiscoverCost


class DiscoveryPage(PublicModel):
    decks: list[PublicDeckSummary]
    revision: int
    next_cursor: str | None


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


def listed_snapshots():
    """Every Listed snapshot as ``(token, public_deck.ActiveSnapshot)``, and the manifest revision. A malformed manifest
    or Listed record is 503, never a shorter list."""
    try:
        objects, revision = public_projection_store().read_state()
        listed = []
        for token, record in objects.items():
            if not TOKEN.fullmatch(token) or record['visibility'] not in ('listed','unlisted'):
                raise ProjectionUnavailable()
            if record['visibility'] == 'listed':
                listed.append((token, public_deck.parse_record(token, record)))
        return listed, revision
    except (ProjectionUnavailable, KeyError, TypeError):
        raise HTTPException(503, {'code': 'PUBLIC_PROJECTION_UNAVAILABLE'}, headers=HEADERS) from None


# --- Legality ------------------------------------------------------------------------------------------------------
_cache: OrderedDict = OrderedDict()
_cache_lock = threading.Lock()


def _fact_value(found):
    if found is None:
        return None
    value = asdict(found)
    del value['generation']
    return value


def facts_revision(active, facts) -> str:
    """The public format-fact revision of one snapshot: a digest of every format fact its check reads (each row's
    Printing and every printing of their Reprint Groups; a missing or malformed record counts as None). Any fact a
    Printing re-stamp delivers moves it, a fact on one Reprint Group member included."""
    refs = {row.printing_ref for row in active.rows if row.printing_ref is not None}
    members = {ref for printing in refs if facts.get(printing) is not None for ref in facts[printing].reprint_printings}
    parts = [[ref, _fact_value(facts.get(ref))] for ref in sorted(refs | members)]
    return hashlib.sha256(json.dumps(parts, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def target_status(token, active, facts, on):
    """The snapshot's result in its Target Format on ``on``, or None when its facts couldn't be read (``facts`` None).

    Cached by digest, Target Format, rules SHA-256, ``CODE_SHA256``, rule-date window and ``facts_revision``. ``token``
    names the snapshot for the CI-only publish gate fixture, which wraps this function to list the snapshots of tests
    written before legal-only Discover (``api/tests/catalog_process_fixture/publish_gate_fixture.py``)."""
    if facts is None:
        return None
    name = active.snapshot.target_format
    rules = evaluator.format_rules(name)
    key = (active.digest, name, rules.sha256, CODE_SHA256, evaluator.next_rule_date(rules, on),
           facts_revision(active, facts))
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    [check] = published_format_checks.checks_for(active, facts, (name,), on, on, datetime.now(timezone.utc))
    with _cache_lock:
        _cache[key] = check.status
        while len(_cache) > CACHE_ENTRIES:
            _cache.popitem(last=False)
    return check.status


# --- Summaries -----------------------------------------------------------------------------------------------------
def cost(active, states) -> DiscoverCost:
    """The snapshot's cost from the public price records only. ``states`` is None when the store
    couldn't be read (only a fixture-listed snapshot gets this far then): every copy is unpriced."""
    quantities, frozen = {}, {}
    for index, row in enumerate(active.rows):
        key = row.edition_ref if row.edition_ref is not None else f'legacy:{index}'
        quantities[key] = quantities.get(key, 0) + row.quantity
        if row.edition_ref is not None:
            frozen[key] = row.printing_ref if frozen.get(key, row.printing_ref) == row.printing_ref else None
    views = {key: prices._unavailable('not_found') for key in quantities if key not in frozen or states is None}
    for key, printing_ref in frozen.items():
        if states is not None:
            views[key] = _view(states[key], printing_ref)
    figures = summarize(quantities, views)
    return DiscoverCost(amount=figures['amount'] if figures['status'] == 'priced' else None,
                        priced_copies=figures.get('priced_copies', '0'), total_copies=figures['total_copies'])


def featured(active, facts):
    """The featured card ``(image_url, name)``: the rule-box Pokémon (ex, V and the like) with the most copies, else the
    Pokémon with the most copies, else the first card with art; ties go to the snapshot's order. Only rows with art
    count, and a row's kind comes from its Printing's public format facts."""
    def attributes(row):
        found = (facts or {}).get(row.printing_ref) if row.printing_ref is not None else None
        return found.attributes if found is not None else None

    pictured = [row for row in active.rows if row.image_url]
    pokemon = [row for row in pictured if (attributes(row) or card_attributes.UNKNOWN).card_kind == 'pokemon']
    ruled = [row for row in pokemon if attributes(row).rule_box]
    for rows in (ruled, pokemon):
        if rows:
            best = max(rows, key=lambda row: row.quantity)  # max keeps the first of equal quantities
            return best.image_url, best.name
    return (pictured[0].image_url, pictured[0].name) if pictured else (None, None)


def summary(token, active, facts, states) -> PublicDeckSummary:
    public = active.snapshot
    checks = public.checks
    image_url, name = featured(active, facts)
    return PublicDeckSummary(url=f'/published/{token}', title=public.title, total=public.total, published_at=public.published_at,
        checks=PublicCheckSummary(size_status=checks.size_status, shortage=checks.shortage, excess=checks.excess,
             over_limit_groups=sum(item.status=='over_limit' for item in checks.identities),
             unresolved_groups=sum(item.status=='unresolved' for item in checks.identities)),
        image_url=image_url, featured_name=name, target_format=public.target_format, target_format_status='legal',
        cost=cost(active, states))


def confirm(chunk, deadline, on) -> tuple[dict[str, PublicDeckSummary], bool]:
    """The summaries of the snapshots in ``chunk`` (``(token, ActiveSnapshot)`` pairs) that are legal in their Target Format
    on ``on``, and whether the store could be read in time. Quotes and format facts are read once for the whole chunk, at
    one store generation."""
    editions = sorted({row.edition_ref for _, active in chunk for row in active.rows if row.edition_ref is not None})
    printings = sorted({row.printing_ref for _, active in chunk for row in active.rows if row.printing_ref is not None})
    readable = True
    try:
        store = public_record_store()
        states = marketplace_states(store, editions, deadline)
        generation = next(iter(states.values())).generation if states else None
        facts = published_format_checks.read_facts(store, printings, deadline, generation=generation)
        if time.monotonic() > deadline:
            raise ProjectionUnavailable()
    except (ProjectionUnavailable, ValueError):
        states = facts = None
        readable = False
    return ({token: summary(token, active, facts, states) for token, active in chunk
             if target_status(token, active, facts, on) == 'legal'}, readable)


def matches_query(public, query):
    """Title, Card Identity name, or any row's own Card Printing name, so a subtitled card ("Professor's Research
    (Professor Juniper)") stays findable by its subtitle after Card Identity dropped it."""
    return (query in public.title.casefold()
            or any(query in identity.name.casefold() for identity in public.identities)
            or any(edition.printing_name is not None and query in edition.printing_name.casefold()
                   for identity in public.identities for edition in identity.editions))


def _order_key(item):
    return item[1].snapshot.published_at.isoformat(), item[0]


@router.get('/api/public/discovery', response_model=DiscoveryPage)
def discover(response: Response, q: str = '', cursor: str | None = None,
             format_name: str | None = Query(default=None, alias='format')):
    # Synchronous on purpose: the HTTP record-store adapter refuses to run on an event loop.
    response.headers.update(HEADERS)
    query = ' '.join(unicodedata.normalize('NFC',q).split()).casefold()
    if len(query)>120:
        raise HTTPException(422, {'code':'INVALID_SEARCH'}, headers=HEADERS)
    if format_name is not None and format_name not in evaluator.FORMATS:
        raise HTTPException(422, {'code': 'UNKNOWN_FORMAT'}, headers=HEADERS)
    objects, revision = listed_snapshots()
    key = cursor_decode(cursor, query, format_name, revision) if cursor else None
    matches = [(token, active) for token, active in objects
               if (format_name is None or active.snapshot.target_format == format_name)
               and (not query or matches_query(active.snapshot, query))]
    ordered = sorted(matches, key=_order_key, reverse=True)
    if key:
        ordered = [item for item in ordered if _order_key(item) < key]
    deadline, on = time.monotonic() + DISCOVER_SECONDS, today()
    page = []
    stopped = False     # the walk stopped on the deadline or an unreadable store with candidates left
    unreadable = False  # some chunk couldn't be confirmed
    for start in range(0, len(ordered), CHUNK):
        if len(page) > PAGE:
            break
        if time.monotonic() > deadline:
            stopped = True
            break
        chunk = ordered[start:start + CHUNK]
        confirmed, readable = confirm(chunk, deadline, on)
        page.extend((item, confirmed[item[0]]) for item in chunk if item[0] in confirmed)
        if not readable:
            unreadable = True
            if start + CHUNK < len(ordered):
                stopped = True
                break
    if not page and (stopped or unreadable):
        # Nothing could be confirmed: that is an outage, not an empty Discover.
        raise HTTPException(503, {'code': 'PUBLIC_CATALOG_UNAVAILABLE'}, headers=HEADERS)
    shown = page[:PAGE]
    more = len(page) > PAGE or stopped  # a stopped walk keeps the older Listed decks reachable
    return DiscoveryPage(decks=[found for _, found in shown], revision=revision,
        next_cursor=cursor_encode(query, format_name, revision, list(_order_key(shown[-1][0]))) if more else None)


@router.get('/api/public/sitemap.xml', response_class=Response)
def sitemap():
    objects, _ = listed_snapshots()
    origin = os.environ.get('PUBLIC_ORIGIN','http://localhost:5173').rstrip('/')
    urls = ''.join(f'<url><loc>{escape(origin + "/published/" + token)}</loc><lastmod>{active.snapshot.published_at.date().isoformat()}</lastmod></url>'
                   for token, active in sorted(objects, key=lambda item: item[0]))
    xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls + '</urlset>'
    return Response(xml, media_type='application/xml', headers=HEADERS)
