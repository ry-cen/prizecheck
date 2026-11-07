"""Audited PC image identities are independent of swapped upstream pricing IDs."""
from copy import deepcopy
import json
import unicodedata
from pathlib import Path
import time

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.core.art import editions
from app.core.art.urls import route_address
from app.core.catalog.card_facts import card_facts
from app.db import connect
from app.games.pokemon.catalog import public_catalog
from app.games.pokemon.catalog.catalog import execute_run
from app.games.pokemon.decks.line_display import read_line_display, with_line_display
from app.games.pokemon.art.hosts import linked_product_url
from app.games.pokemon.art.selection import public_images
from app.main import app
from app.public_projection import FilePublicProjection, public_record_store, ProjectionUnavailable
from app.public_records import catalog_edition_key, edition_art_key
from test_catalog import Source, headers, reset_catalog, claim_current
from test_catalog_search import search

client = TestClient(app)
PLAIN = {'type': 'holo', 'size': 'standard'}
PC = {**PLAIN, 'stamp': ['pokemon-center']}


class PromoSource(Source):
    def __init__(self):
        super().__init__(ids=('svp-173',))

    def fetch(self, source_id):
        return {'id': source_id, 'name': 'Eevee', 'localId': '173', 'category': 'Pokemon',
                'set': {'id': 'svp', 'name': 'SVP Black Star Promos'},
                'image': 'https://assets.tcgdex.net/en/sv/svp/173',
                'variants': {'holo': True, 'normal': False, 'reverse': False},
                'variants_detailed': [
                    {**PLAIN, 'thirdParty': {'tcgplayer': 610757}},
                    {**PC, 'thirdParty': {'tcgplayer': 610758}}]}


def seed_pair():
    """Browser/API fixture. Source product IDs deliberately retain the audited upstream swap."""
    reset_catalog()
    with connect() as conn:
        conn.execute('INSERT INTO catalog_run DEFAULT VALUES')
        execute_run(conn, claim_current(conn), PromoSource())
    with connect() as conn:
        rows = conn.execute("SELECT * FROM catalog_edition WHERE descriptor->>'type'='holo' ORDER BY descriptor_key").fetchall()
    regular = next(row for row in rows if not row['descriptor'].get('stamp'))
    pc = next(row for row in rows if row['descriptor'].get('stamp'))
    with connect() as conn:
        public_catalog.drain_to_completion(conn)
    return regular, pc


@pytest.fixture(autouse=True)
def curated_config_isolation():
    with connect() as conn:
        original = conn.execute('SELECT source_id,display_name,collector_number,pc_product_id FROM catalog_pokemon_promo_art').fetchall()
    try:
        yield
    finally:
        with connect() as conn:
            conn.execute('DELETE FROM catalog_pokemon_promo_art')
            for row in original:
                conn.execute('INSERT INTO catalog_pokemon_promo_art(source_id,display_name,collector_number,pc_product_id) VALUES (%s,%s,%s,%s)',
                             (row['source_id'], row['display_name'], row['collector_number'], row['pc_product_id']))


@pytest.fixture
def pair(monkeypatch, tmp_path):
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path / 'public'))
    monkeypatch.setenv('ART_STORE_DIR', str(tmp_path / 'art'))
    with FilePublicProjection().writer(initialize=True):
        pass
    public_record_store().initialize(deadline=time.monotonic() + 5)
    return seed_pair()


def art(eid):
    with connect() as conn:
        return conn.execute('SELECT * FROM catalog_edition_art WHERE edition_id=%s', (eid,)).fetchone()


def redirect(url):
    return client.get(url, follow_redirects=False)


def test_audited_pc_uses_correct_product_without_applying_price_correction(pair):
    regular, pc = pair
    plain, selected = art(regular['id']), art(pc['id'])
    assert plain['small_art_url'].endswith('&reference=1')
    assert selected['linked_art']['product_id'] == 610757
    assert pc['descriptor']['thirdParty']['tcgplayer'] == 610758
    assert route_address(pc['printing_id'], selected['low_image_url']) == selected['small_art_url']
    for size in ('small', 'large'):
        answer = redirect(selected[f'{size}_art_url'])
        assert answer.status_code == 302
        assert answer.headers['location'] == linked_product_url(610757, size)
        assert answer.headers['cache-control'] == 'no-store'
    with connect() as conn:
        display = read_line_display(conn, [regular['id'], pc['id']])
        facts = card_facts(conn, [pc['id']])
    assert display[pc['id']]['image_url'] == facts[pc['id']].image_url == selected['small_art_url']
    assert display[regular['id']]['image_url'] == plain['small_art_url']
    printing = search(name='Eevee').json()['printings'][0]
    assert printing['low_image_url'].startswith('/api/art/')
    assert next(row for row in printing['editions'] if row['id'] == str(pc['id']))['image_url'] == selected['small_art_url']
    path = '/api/catalog/editions'
    page = client.get(path, params={'printing_id': str(pc['printing_id'])}, headers=headers('art-reader', 'GET', path))
    assert page.status_code == 200
    assert next(row for row in page.json()['editions'] if row['edition_id'] == str(pc['id']))['image_url'] == selected['small_art_url']


def test_linked_art_uses_no_database_fetcher_or_storage_on_anonymous_request(pair, monkeypatch):
    _, pc = pair
    selected = art(pc['id'])
    def forbidden(*args, **kwargs):
        raise AssertionError('linked image path touched private DB, storage or upstream')
    from app.games.pokemon.art import route
    monkeypatch.setattr(psycopg, 'connect', forbidden)
    monkeypatch.setattr(route, 'fetcher', forbidden)
    monkeypatch.setattr(route, 'tcgplayer_fetcher', forbidden)
    monkeypatch.setattr('app.core.art.art_storage.storage', forbidden)
    assert redirect(selected['large_art_url']).headers['location'] == linked_product_url(610757, 'large')


def test_reviewed_art_change_invalidates_both_old_urls_and_uses_ordered_delivery(pair):
    _, pc = pair
    selected = art(pc['id'])
    record_store = public_record_store()
    key = edition_art_key(pc['public_ref'])
    before = record_store.read_all([key], deadline=time.monotonic() + 5).records[key]
    # Synthetic review withdrawal; a static image identity change is independent of pricing.
    with connect() as conn:
        conn.execute("DELETE FROM catalog_pokemon_promo_art WHERE source_id='svp-173'")
    assert art(pc['id'])['small_art_url'] is None
    with connect() as conn:
        public_catalog.drain_to_completion(conn)
    assert record_store.compare_and_swap({key: before.version}, {key: before.value}, deadline=time.monotonic() + 5) is False
    for size in ('small', 'large'):
        assert redirect(selected[f'{size}_art_url']).status_code == 404


def test_mapping_revision_change_changes_urls_but_keeps_audited_image_identity(pair):
    _, pc = pair
    selected = art(pc['id'])
    with connect() as conn:
        conn.execute('UPDATE catalog_edition_metadata SET mapping_revision=mapping_revision+1 WHERE edition_id=%s', (pc['id'],))
    current = art(pc['id'])
    assert current['small_art_url'] != selected['small_art_url']
    assert current['linked_art']['product_id'] == 610757
    with connect() as conn:
        public_catalog.drain_to_completion(conn)
    assert redirect(selected['small_art_url']).status_code == 404
    assert redirect(current['small_art_url']).headers['location'] == linked_product_url(610757, 'small')


def test_failed_publication_is_pending_until_retry(pair, monkeypatch):
    _, pc = pair
    selected = art(pc['id'])
    record_store = public_record_store()
    with connect() as conn:
        conn.execute("DELETE FROM catalog_pokemon_promo_art WHERE source_id='svp-173'")
    with monkeypatch.context() as patch:
        def unavailable(*args, **kwargs):
            raise ProjectionUnavailable()
        patch.setattr(record_store, 'compare_and_swap', unavailable)
        with connect() as conn:
            assert public_catalog.drain(conn, record_store).pending > 0
    # Private state is withdrawn; public delivery is explicitly still pending.
    assert art(pc['id'])['small_art_url'] is None
    with connect() as conn:
        public_catalog.drain_to_completion(conn)
    assert redirect(selected['small_art_url']).status_code == 404


@pytest.mark.parametrize('field', ['edition_ref', 'printing_ref', 'product_id', 'mapping_revision', 'revision'])
def test_inconsistent_public_fence_never_redirects(pair, field):
    _, pc = pair
    selected = art(pc['id'])
    record_store = public_record_store()
    key = edition_art_key(pc['public_ref'])
    before = record_store.read_all([key], deadline=time.monotonic() + 5).records[key]
    wrong = deepcopy(before.value)
    wrong[field] = 'f' * 48 if field.endswith('_ref') else wrong[field] + 1
    assert record_store.compare_and_swap({key: before.version}, {key: wrong}, deadline=time.monotonic() + 5)
    assert redirect(selected['small_art_url']).status_code == 404


@pytest.mark.parametrize('descriptor', [
    {'type': 'holo', 'stamp': ['1st-edition']}, {'type': 'holo', 'stamp': ['staff']},
    {'type': 'reverse'}, {'label': 'Unspecified Variant'}, {'type': 'holo', 'unknown': 'facet'}])
def test_other_variants_keep_existing_printing_art(pair, descriptor):
    regular, _ = pair
    with connect() as conn:
        row = conn.execute('INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,%s,%s) RETURNING id',
                           (regular['printing_id'], json.dumps(descriptor), json.dumps(descriptor))).fetchone()
        expected = conn.execute('SELECT small_art_url FROM catalog_printing_art WHERE printing_id=%s', (regular['printing_id'],)).fetchone()['small_art_url']
    assert art(row['id'])['small_art_url'] == expected
    assert public_images(None, None, descriptor, 'https://example.test/reference.jpg', None, {}, excluded_prefixes=())[0] == 'https://example.test/reference.jpg'


def test_unknown_pc_or_missing_reference_never_borrows_regular_image():
    assert public_images(None, 'a' * 48, PC, 'https://example.test/wrong.jpg', None, {}, excluded_prefixes=(), set_id='svp') == (None, None)


def test_reviewed_identity_matches_cached_product_names_numbers_and_group():
    fixture = json.loads((Path(__file__).parent / 'fixtures/svp_art_products.json').read_text())
    products = {row['productId']: row for row in fixture['products']}
    with connect() as conn:
        rows = conn.execute('SELECT * FROM catalog_pokemon_promo_art ORDER BY source_id').fetchall()
    assert len(rows) == 19 and len(products) == 38
    assert len(fixture['visual_qa']['pc_products']) == 19
    assert {'543947', '543949', '594468'} <= fixture['visual_qa']['pc_products'].keys()
    for row in rows:
        pc = products[row['pc_product_id']]
        assert pc['groupId'] == 22872 and pc['number'] == row['collector_number'] and pc['imageCount'] > 0
        if row['source_id'] == 'svp-203':
            assert (row['display_name'], row['collector_number'], row['pc_product_id']) == (
                "Team Rocket's Wobbuffet", '203', 635468)
            assert pc['name'] == "Team Rocket's Wobbuffet (Pokemon Center Exclusive)"
        else:
            assert pc['name'].startswith(row['display_name'] + ' - ')
        assert 'Pokemon Center' in unicodedata.normalize('NFKD', pc['name']).encode('ascii', 'ignore').decode()
        assert str(row['pc_product_id']) in fixture['visual_qa']['pc_products']
        for size in ('small', 'large'):
            assert linked_product_url(row['pc_product_id'], size) == pc['imageUrl']


def test_pc_images_outside_svp_keep_existing_reference_behavior():
    assert public_images(None, None, PC, 'https://example.test/existing.jpg', None, {},
                         excluded_prefixes=(), set_id='other-set')[0] == 'https://example.test/existing.jpg'


def test_legacy_public_snapshot_and_discovery_prefer_current_pc_selection_without_postgres(pair, monkeypatch):
    from types import SimpleNamespace
    from app.games.pokemon.publications import publications
    from app.games.pokemon.publications.discovery import featured
    from app.games.pokemon.publications.public_deck import FrozenRow
    regular, pc = pair
    selected = art(pc['id'])
    reviewed = editions.read_selections([pc['public_ref']])
    row = FrozenRow('Eevee', 'svp', 'Promos', '173', PC, 'https://example.test/old-unstamped.jpg', 1,
                    pc['public_ref'], selected['linked_art']['printing_ref'])
    assert featured(SimpleNamespace(rows=[row]), None, reviewed)[0] == selected['small_art_url']
    assert featured(SimpleNamespace(rows=[row]), None, {}) == (None, None, None)
    record = {'visibility': 'unlisted', 'snapshot': {
        'title': 'Legacy deck', 'published_at': '2026-11-01T00:00:00Z', 'version': 1, 'total': '1',
        'identities': [{'name': 'Eevee', 'quantity': '1', 'editions': [{
            'set_id': 'svp', 'set_name': 'Promos', 'collector_number': '173', 'variant': PC,
            'image_url': row.image_url, 'quantity': '1', 'edition_ref': pc['public_ref'],
            'printing_ref': row.printing_ref}]}],
        'checks': {'size_status': 'short', 'shortage': '59', 'excess': '0', 'identities': []}}}
    monkeypatch.setattr(publications, 'public_projection_store', lambda: SimpleNamespace(read_record=lambda token: record))
    def forbidden(*args, **kwargs):
        raise AssertionError('public snapshot opened PostgreSQL')
    monkeypatch.setattr(psycopg, 'connect', forbidden)
    response = client.get('/api/public/decks/' + 'a' * 32)
    assert response.status_code == 200
    display = response.json()['identities'][0]['editions'][0]
    for size, field in [('small', 'image_url'), ('large', 'large_image_url')]:
        assert display[field] == selected[f'{size}_art_url']
    record['snapshot']['identities'][0]['editions'][0]['edition_ref'] = None
    display = client.get('/api/public/decks/' + 'a' * 32).json()['identities'][0]['editions'][0]
    assert display['image_url'] is None and display['large_image_url'] is None


def test_current_identity_drift_suppresses_reviewed_pc_link(pair):
    _, pc = pair
    with connect() as conn:
        conn.execute("UPDATE catalog_pokemon_promo_art SET display_name='Wrong card' WHERE source_id='svp-173'")
    assert art(pc['id'])['small_art_url'] is None
    with connect() as conn:
        public_catalog.drain_to_completion(conn)
    assert editions.read_selections([pc['public_ref']])[pc['public_ref']]['mode'] == 'withheld'


def test_reference_large_route_ignores_wrong_marketplace_upgrade(pair, monkeypatch):
    import httpx
    from app.core.art.store import ArtFetcher, RateLimiter
    from app.games.pokemon.art import route
    regular, _ = pair
    requested = []
    def respond(request):
        requested.append(str(request.url))
        return httpx.Response(200, content=b'\x89PNG\r\n\x1a\nfixture', headers={'content-type': 'image/png'})
    monkeypatch.setattr(route, '_fetcher', ArtFetcher(allowed_host=route.ALLOWED_HOST,
                        transport=httpx.MockTransport(respond), limiter=RateLimiter(100000)))
    def forbidden():
        raise AssertionError('reference image fetched marketplace pixels')
    monkeypatch.setattr(route, 'tcgplayer_fetcher', forbidden)
    with connect() as conn:
        conn.execute('INSERT INTO catalog_printing_art_product(printing_id,product_id) VALUES (%s,610757)', (regular['printing_id'],))
        import hashlib
        from app.core.art.art_storage import storage
        wrong = b'\x89PNG\r\n\x1a\nwrong-stamp'
        storage().put('tcgplayer/wrong-stamp', wrong)
        conn.execute("""INSERT INTO art_object(printing_id,size,source_url,storage_key,sha256,content_type,byte_size)
          VALUES (%s,'large','https://tcgplayer-cdn.tcgplayer.com/product/610757_in_1000x1000.jpg',
          'tcgplayer/wrong-stamp',%s,'image/png',%s)""", (regular['printing_id'], hashlib.sha256(wrong).hexdigest(), len(wrong)))
    url = art(regular['id'])['large_art_url']
    answer = client.get(url, headers=headers('art-reader', 'GET', url.split('?')[0]))
    assert answer.status_code == 200
    assert requested == ['https://assets.tcgdex.net/en/sv/svp/173/high.webp']


@pytest.mark.parametrize('printing_ref,descriptor,set_id', [
    (None, PC, 'svp'), ('f' * 48, PC, 'svp'), (None, PLAIN, 'svp'),
    ('current', PLAIN, 'svp'), ('current', PC, 'other-set')])
def test_valid_current_selection_cannot_picture_an_incompatible_frozen_row(pair, printing_ref, descriptor, set_id):
    _, pc = pair
    reviewed = editions.read_selections([pc['public_ref']])
    if printing_ref == 'current':
        printing_ref = reviewed[pc['public_ref']]['printing_ref']
    assert public_images(pc['public_ref'], printing_ref, descriptor, 'https://example.test/old.jpg', None, reviewed,
                         excluded_prefixes=(), set_id=set_id, collector_number='173') == (None, None)


@pytest.mark.parametrize('case', ['missing', 'old', 'malformed', 'unreachable', 'withdrawn', 'legacy'])
def test_regular_reference_safety_survives_absent_or_withdrawn_sidecars(pair, monkeypatch, case):
    from app.core.art.public import write_pointer
    from app.core.art.art_storage import storage
    regular, pc = pair
    with connect() as conn:
        ref = conn.execute('SELECT public_ref FROM catalog_printing WHERE id=%s', (regular['printing_id'],)).fetchone()['public_ref']
    for size in ('small', 'large'):
        write_pointer(ref, size, storage_key='tcgplayer/wrong-stamp', sha256='f' * 64, content_type='image/jpeg')
    record_store = public_record_store()
    if case in ('missing', 'old', 'malformed'):
        key = edition_art_key(regular['public_ref'])
        old = record_store.read_all([key], deadline=time.monotonic() + 5).records[key]
        value = None if case == 'missing' else {'old': True} if case == 'old' else {'mode': 'reference'}
        assert record_store.compare_and_swap({key: old.version}, {key: value}, deadline=time.monotonic() + 5)
    if case == 'withdrawn':
        with connect() as conn:
            conn.execute("DELETE FROM catalog_pokemon_promo_art WHERE source_id='svp-173'")
        with connect() as conn:
            public_catalog.drain_to_completion(conn)
        assert art(regular['id'])['small_art_url'].endswith('&reference=1')
        assert art(regular['id'])['large_art_url'].endswith('&reference=1')
    if case == 'unreachable':
        def unavailable(*args, **kwargs):
            raise ProjectionUnavailable()
        monkeypatch.setattr(editions, 'public_record_store', unavailable)
    reviewed = editions.read_selections([regular['public_ref']])
    small = 'https://assets.tcgdex.net/en/sv/svp/173/low.webp'
    large = 'https://assets.tcgdex.net/en/sv/svp/173/high.webp'
    ref_id = None if case == 'legacy' else regular['public_ref']
    assert public_images(ref_id, ref, PLAIN, small, large, reviewed, excluded_prefixes=(),
                         set_id='svp', collector_number='173') == (small, large)
    # Without a known TCGdex direct source, a missing sidecar cannot grant access
    # to the stored PC upgrade just because the regular reference is unavailable.
    if not reviewed.get(regular['public_ref']):
        assert public_images(ref_id, ref, PLAIN, None, None, {}, excluded_prefixes=(),
                             set_id='svp', collector_number='173') == (None, None)


def test_complete_and_incomplete_deck_replays_refresh_only_mutable_image_selection(pair):
    _, pc = pair
    with connect() as conn:
        fields = read_line_display(conn, [pc['id']])[pc['id']]
        line = {**fields, 'edition_id': str(pc['id']), 'quantity': '3', 'image_url': '/api/art/old-printing/small'}
        response = {'command_id': 'old-command', 'deck_list': {'revision': 17, 'lines': [line]}}
        updated = with_line_display(conn, response)
    assert updated['deck_list']['lines'][0]['image_url'] == art(pc['id'])['small_art_url']
    assert updated['command_id'] == 'old-command' and updated['deck_list']['revision'] == 17
    assert updated['deck_list']['lines'][0]['quantity'] == '3'
    with connect() as conn:
        conn.execute("DELETE FROM catalog_pokemon_promo_art WHERE source_id='svp-173'")
    for stored in (response, {**response, 'deck_list': {**response['deck_list'], 'lines': [{key: value for key, value in line.items() if key != 'name'}]}}):
        with connect() as conn:
            result = with_line_display(conn, stored)
        assert result['deck_list']['lines'][0]['image_url'] is None
        assert result['deck_list']['lines'][0]['quantity'] == '3'


class PromotionSource(PromoSource):
    def __init__(self, *, present=True, image=True):
        ids = [f'fixture-{i}' for i in range(100)] + (['svp-173'] if present else [])
        Source.__init__(self, ids=ids)
        self.image = image

    def fetch(self, source_id):
        if source_id != 'svp-173':
            return Source.fetch(self, source_id)
        card = PromoSource.fetch(self, source_id)
        card['image'] = card['image'] if self.image else None
        return card


def generation_art_state(edition):
    """Retain enqueue, delivery-error and pinned public-pair evidence on assertion failure."""
    with connect() as conn:
        metadata = conn.execute("""SELECT m.public_revision,m.mapping_revision,p.public_ref AS printing_ref
          FROM catalog_edition_metadata m JOIN catalog_edition e ON e.id=m.edition_id
          JOIN catalog_printing p ON p.id=e.printing_id WHERE m.edition_id=%s""", (edition['id'],)).fetchone()
        outbox = conn.execute("""SELECT sequence,revision,attempts,delivered_at,last_error
          FROM catalog_public_outbox WHERE target_kind='edition' AND target_id=%s ORDER BY sequence""",
                             (edition['id'],)).fetchall()
        errors = conn.execute("""SELECT sequence,target_kind,target_id,revision,attempts,last_error
          FROM catalog_public_outbox WHERE delivered_at IS NULL AND last_error IS NOT NULL
          ORDER BY sequence LIMIT 10""").fetchall()
    state = {'metadata': metadata, 'outbox': outbox, 'pending_errors': errors}
    parent_key, sidecar_key = catalog_edition_key(edition['public_ref']), edition_art_key(edition['public_ref'])
    try:
        snapshot = public_record_store().read_all([parent_key, sidecar_key], deadline=time.monotonic() + 5)
        state.update(generation=snapshot.generation, parent=snapshot.records[parent_key].value,
                     sidecar=snapshot.records[sidecar_key].value)
    except ProjectionUnavailable as exc:
        state['public_error'] = type(exc).__name__
    return state


def deliver_generation_art(edition, *, phase, mode, previous=None):
    before = generation_art_state(edition)
    diagnostic = {'phase': phase, 'before': before, 'previous': previous}
    assert before['metadata'] is not None, diagnostic
    metadata = before['metadata']
    if previous is not None:
        assert metadata['mapping_revision'] == previous['metadata']['mapping_revision'], diagnostic
        assert metadata['public_revision'] > previous['metadata']['public_revision'], {
            'failure': 'public revision did not advance', **diagnostic}
    covering = [row for row in before['outbox'] if row['revision'] == metadata['public_revision']]
    # Require the promotion's own enqueue before delivery; never create replacement work.
    # Best-effort publication may already have delivered this row.
    assert covering, {'failure': 'current revision missing from outbox', **diagnostic}
    with connect() as conn:  # Fresh idle connection: drain must not commit an inspection transaction.
        delivered = public_catalog.drain(conn)
    after = generation_art_state(edition)
    diagnostic = {**diagnostic, 'drain': delivered, 'after': after}
    assert not delivered.busy and delivered.pending == 0, {'failure': 'delivery incomplete', **diagnostic}
    assert after['metadata'] == metadata, diagnostic
    current = [row for row in after['outbox'] if row['revision'] == metadata['public_revision']]
    assert current and {row['sequence'] for row in current} == {row['sequence'] for row in covering}, diagnostic
    assert all(row['delivered_at'] is not None and row['last_error'] is None for row in current), {
        'failure': 'target delivery not confirmed', **diagnostic}
    parent, sidecar = after.get('parent'), after.get('sidecar')
    diagnostic = {'failure': 'stale or inconsistent public pair', **diagnostic}
    assert isinstance(parent, dict) and isinstance(sidecar, dict), diagnostic
    assert parent.get('revision') == sidecar.get('revision') == metadata['public_revision'], diagnostic
    assert parent.get('edition_ref') == sidecar.get('edition_ref') == edition['public_ref'], diagnostic
    assert parent.get('printing_ref') == sidecar.get('printing_ref') == metadata['printing_ref'], diagnostic
    assert parent.get('descriptor') == sidecar.get('descriptor') == edition['descriptor'], diagnostic
    assert sidecar.get('mapping_revision') == metadata['mapping_revision'], diagnostic
    assert editions.selection(sidecar, parent) == sidecar and sidecar['mode'] == mode, diagnostic
    return after


def test_normal_generation_withdrawal_reinstatement_and_image_change_deliver_art(pair):
    from test_catalog_reconciliation import run
    regular, pc = pair
    # 101 -> 100 sources respects the existing 1% drop guard; no bypass or fixture patch.
    run(PromotionSource())
    baseline = deliver_generation_art(pc, phase='initial promotion', mode='linked')
    before = art(pc['id'])
    assert baseline['sidecar']['product_id'] == 610757, baseline
    assert all(before[f'{size}_art_url'] for size in ('small', 'large')), baseline
    run(PromotionSource(present=False))
    private = art(pc['id'])
    assert private['small_art_url'] is None and private['large_art_url'] is None, generation_art_state(pc)
    withdrawn = deliver_generation_art(pc, phase='withdrawal', mode='withheld', previous=baseline)
    for size in ('small', 'large'):
        assert redirect(before[f'{size}_art_url']).status_code == 404, withdrawn
    run(PromotionSource())
    reinstated = deliver_generation_art(pc, phase='reinstatement', mode='linked', previous=withdrawn)
    renewed = art(pc['id'])
    assert reinstated['sidecar']['product_id'] == 610757, reinstated
    for size in ('small', 'large'):
        assert renewed[f'{size}_art_url'] and renewed[f'{size}_art_url'] != before[f'{size}_art_url'], reinstated
        answer = redirect(renewed[f'{size}_art_url'])
        assert answer.status_code == 302 and answer.headers['location'] == linked_product_url(610757, size), reinstated
        assert redirect(before[f'{size}_art_url']).status_code == 404, reinstated


def legacy_catalog():
    """Actual frozen pre-art contract functions with the legacy two-key writer path."""
    import types
    namespace = dict(vars(public_catalog))
    for name, function in vars(public_catalog).items():
        if isinstance(function, types.FunctionType) and function.__module__ == public_catalog.__name__:
            copied = types.FunctionType(function.__code__, namespace, name, function.__defaults__, function.__closure__)
            copied.__kwdefaults__ = function.__kwdefaults__
            namespace[name] = copied
    namespace['sidecars_enabled'] = lambda: False
    namespace['EDITION_CAS'] = 64
    fixture = json.loads((Path(__file__).parent / 'fixtures/edition_art_legacy_contract.json').read_text())
    for name, source in fixture['function_sources'].items():
        exec(compile(source, f'pre-art-{fixture["base"]}:{name}', 'exec'), namespace)
    return types.SimpleNamespace(**namespace)


def verify_mapping_for_compatibility(row):
    from uuid import uuid4
    owner = f'art-compat-{uuid4()}'
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
        activation = conn.execute("""INSERT INTO catalog_rule_activation(kind,reviewer_id,evidence_url,reason,clock_revision)
          VALUES ('marketplace_matching',%s,'https://example.test/fixture','Synthetic compatibility rule',1) RETURNING id""", (owner,)).fetchone()['id']
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='verified',mapping_reason=NULL,product_id=610757,
          mapping_basis='matching_rule',matching_activation_id=%s,auto_closed=true,mapping_revision=mapping_revision+1
          WHERE edition_id=%s""", (activation, row['id']))
    with connect() as conn:
        public_catalog.drain_to_completion(conn)


def mapping_receipt(eid):
    with connect() as conn:
        row = conn.execute('SELECT mapping_state,mapping_reason,mapping_revision,product_id FROM catalog_edition_metadata WHERE edition_id=%s', (eid,)).fetchone()
        decisions = conn.execute('SELECT count(*) AS n FROM catalog_metadata_decision').fetchone()['n']
    return dict(row), decisions


def test_old_reader_writer_and_rebuild_preserve_prices_exports_with_sidecars_present(pair, monkeypatch):
    from app import public_records as records
    _, pc = pair
    verify_mapping_for_compatibility(pc)
    store = public_record_store()
    old = legacy_catalog()
    parent, quarantine, sidecar, price = (catalog_edition_key(pc['public_ref']), records.quarantine_key(pc['public_ref']),
                                         edition_art_key(pc['public_ref']), records.price_key(pc['public_ref']))
    before = store.read_all([parent, quarantine, sidecar, price], deadline=time.monotonic() + 5).records
    assert set(before[parent].value) == public_catalog.EDITION_KEYS
    market = before[parent].value['marketplace']
    assert store.compare_and_swap({price: before[price].version},
        {price: {'mapping_revision': market['mapping_revision'], 'product_id': 610757, 'amount': '9.50'}}, deadline=time.monotonic() + 5)
    receipt = mapping_receipt(pc['id'])
    # The old typed adapter cannot request art keys, but it can preserve them
    # while reading/writing its original known records in the same format-2 store.
    with monkeypatch.context() as patch:
        patch.setattr(records, '_FAMILIES', tuple(row for row in records._FAMILIES if row[0] != 'edition_art'))
        current = store.read_all([parent, quarantine], deadline=time.monotonic() + 5).records
        assert old._marketplace(pc['public_ref'], current[parent].value, current[quarantine].value)[0] == 'verified'
        states = old.marketplace_states(store, [pc['public_ref']], time.monotonic() + 5)
        assert states[pc['public_ref']].product_eligible and states[pc['public_ref']].price['amount'] == '9.50'
        with connect() as conn:
            assert old.rebuild(conn, store).conflicts == 0
    assert mapping_receipt(pc['id']) == receipt
    after = store.read_all([parent, quarantine, sidecar], deadline=time.monotonic() + 5).records
    assert after[sidecar].value == before[sidecar].value
    assert public_catalog.marketplace_states(store, [pc['public_ref']], time.monotonic() + 5)[pc['public_ref']].product_eligible


def test_old_writer_new_reader_fences_stale_art_then_art_rebuild_changes_no_eligibility(pair):
    _, pc = pair
    verify_mapping_for_compatibility(pc)
    old = legacy_catalog()
    with connect() as conn:
        conn.execute("DELETE FROM catalog_pokemon_promo_art WHERE source_id='svp-173'")
    receipt = mapping_receipt(pc['id'])
    with connect() as conn:
        assert old.drain(conn).pending == 0
    assert editions.read_selections([pc['public_ref']])[pc['public_ref']] is None
    state = old.marketplace_states(public_record_store(), [pc['public_ref']], time.monotonic() + 5)[pc['public_ref']]
    assert state.product_eligible
    with connect() as conn:
        assert public_catalog.rebuild(conn).conflicts == 0
    assert editions.read_selections([pc['public_ref']])[pc['public_ref']]['mode'] == 'withheld'
    assert mapping_receipt(pc['id']) == receipt


def test_art_only_mismatch_and_future_revision_never_quarantine_marketplace(pair):
    _, pc = pair
    verify_mapping_for_compatibility(pc)
    store = public_record_store()
    key = edition_art_key(pc['public_ref'])
    before = store.read_all([key], deadline=time.monotonic() + 5).records[key]
    wrong = {**before.value, 'revision': before.value['revision'] + 1000000,
             'mapping_revision': before.value['mapping_revision'] + 1000000, 'mode': 'corrupt'}
    assert store.compare_and_swap({key: before.version}, {key: wrong}, deadline=time.monotonic() + 5)
    receipt = mapping_receipt(pc['id'])
    with connect() as conn:
        assert public_catalog.rebuild(conn).conflicts == 0
    assert mapping_receipt(pc['id']) == receipt
    assert editions.read_selections([pc['public_ref']])[pc['public_ref']]['mode'] == 'linked'


def test_older_http_relay_path_never_requests_sidecars_until_explicitly_enabled(pair, monkeypatch):
    _, pc = pair
    store = public_record_store()
    class LegacyRelay:
        def read_all(self, keys, **kwargs):
            assert all(not key.startswith('art:edition:') for key in keys)
            return store.read_all(keys, **kwargs)

        def compare_and_swap(self, expected, changes, **kwargs):
            assert all(not key.startswith('art:edition:') for key in changes)
            return store.compare_and_swap(expected, changes, **kwargs)
    monkeypatch.setenv('PUBLIC_PROJECTION_ADAPTER', 'http')
    monkeypatch.delenv('PUBLIC_ART_SIDECARS', raising=False)
    monkeypatch.setattr(editions, 'public_record_store', lambda: LegacyRelay())
    with connect() as conn:
        public_catalog.mark_all_dirty(conn)
        conn.commit()
        assert public_catalog.drain(conn, LegacyRelay()).pending == 0
    assert editions.read_selections([pc['public_ref']]) == {}
    states = public_catalog.marketplace_states(LegacyRelay(), [pc['public_ref']], time.monotonic() + 5)
    assert states[pc['public_ref']].printing_ref is not None


def test_generation_source_image_addition_delivers_reference_without_mapping_change(pair):
    from test_catalog_reconciliation import run
    reset_catalog()
    run(PromotionSource(image=False))
    with connect() as conn:
        regular = conn.execute("""SELECT e.* FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          WHERE p.source_id='svp-173' AND NOT e.descriptor ? 'stamp'""").fetchone()
    initial = deliver_generation_art(regular, phase='promotion without reference image', mode='reference')
    before = initial['sidecar']
    assert before['reference_small'] is None and art(regular['id'])['small_art_url'] is None
    run(PromotionSource(image=True))
    added = deliver_generation_art(regular, phase='source image addition', mode='reference', previous=initial)
    after = added['sidecar']
    assert after['revision'] != before['revision']
    assert after['reference_small'] == 'https://assets.tcgdex.net/en/sv/svp/173/low.webp'
    assert after['reference_large'] == 'https://assets.tcgdex.net/en/sv/svp/173/high.webp'
    assert after['mapping_revision'] == before['mapping_revision']


def test_new_writer_batches_parent_quarantine_and_art_within_single_cas(pair, monkeypatch):
    _, pc = pair
    store = public_record_store()
    writes = []
    class RecordingStore:
        def read_all(self, *args, **kwargs):
            return store.read_all(*args, **kwargs)

        def compare_and_swap(self, expected, changes, **kwargs):
            writes.append(changes)
            assert len(expected) <= 128
            return store.compare_and_swap(expected, changes, **kwargs)
    with connect() as conn:
        conn.execute('UPDATE catalog_edition_metadata SET mapping_revision=mapping_revision+1 WHERE edition_id=%s', (pc['id'],))
    with connect() as conn:
        assert public_catalog.drain(conn, RecordingStore()).pending == 0
    sidecar = edition_art_key(pc['public_ref'])
    parent = catalog_edition_key(pc['public_ref'])
    from app.public_records import quarantine_key
    batch = next(change for change in writes if sidecar in change)
    assert parent in batch and quarantine_key(pc['public_ref']) in batch
    assert batch[sidecar]['revision'] == batch[parent]['revision'] == batch[quarantine_key(pc['public_ref'])]['revision']


def test_sidecar_and_parent_are_read_at_one_pinned_generation(pair, monkeypatch):
    _, pc = pair
    store = public_record_store()
    pinned = []
    class RecordingStore:
        def read_all(self, keys, **kwargs):
            assert catalog_edition_key(pc['public_ref']) in keys and edition_art_key(pc['public_ref']) in keys
            snapshot = store.read_all(keys, **kwargs)
            pinned.append(snapshot.generation)
            return snapshot
    monkeypatch.setattr(editions, 'public_record_store', lambda: RecordingStore())
    assert editions.read_selections([pc['public_ref']])[pc['public_ref']]['mode'] == 'linked'
    assert len(pinned) == 1


def test_regular_scope_policy_matches_migrated_scope_even_without_link_config():
    from app.games.pokemon.art.scope import NUMBERS, REFERENCE_NUMBERS
    with connect() as conn:
        rows = conn.execute('SELECT * FROM catalog_pokemon_promo_art_scope').fetchall()
    assert {row['source_id'].split('-')[1] for row in rows} == NUMBERS
    assert {row['source_id'].split('-')[1] for row in rows if row['reference_only']} == REFERENCE_NUMBERS


def test_current_printing_mode_publication_preserves_other_variants_through_withdrawal(pair, monkeypatch):
    from types import SimpleNamespace
    from test_catalog_reconciliation import run
    from app.games.pokemon.publications import publications
    variants = [
        {'type': 'reverse', 'size': 'standard'},
        {'type': 'holo', 'size': 'standard', 'stamp': ['staff']},
        {'type': 'holo', 'size': 'standard', 'stamp': ['1st-edition']},
    ]
    class OtherVariantSource(PromotionSource):
        def fetch(self, source_id):
            card = super().fetch(source_id)
            if source_id == 'svp-173':
                card['variants_detailed'] += deepcopy(variants)
            return card
    run(OtherVariantSource())
    with connect() as conn:
        rows = conn.execute("""SELECT e.id,e.public_ref,e.descriptor,p.public_ref AS printing_ref
          FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='svp-173'""").fetchall()
    current = [row for row in rows if row['descriptor'] in variants]
    assert len(current) == 3
    initial = {row['id']: deliver_generation_art(
        row, phase=f"other-variant initial promotion: {row['descriptor']}", mode='printing') for row in current}
    small = 'https://assets.tcgdex.net/en/sv/svp/173/low.webp'
    large = 'https://assets.tcgdex.net/en/sv/svp/173/high.webp'
    frozen = {'visibility': 'unlisted', 'snapshot': {
        'title': 'Existing other variants', 'published_at': '2026-11-01T00:00:00Z', 'version': 1, 'total': '3',
        'identities': [{'name': 'Eevee', 'quantity': '3', 'editions': [{
            'set_id': 'svp', 'set_name': 'Promos', 'collector_number': '173', 'variant': row['descriptor'],
            'image_url': small, 'quantity': '1', 'edition_ref': row['public_ref'],
            'printing_ref': row['printing_ref']} for row in current]}],
        'checks': {'size_status': 'short', 'shortage': '57', 'excess': '0', 'identities': []}}}
    original_frozen = deepcopy(frozen)
    monkeypatch.setattr(publications, 'public_projection_store', lambda: SimpleNamespace(read_record=lambda token: frozen))
    def assert_original_images():
        selected = editions.read_selections(row['public_ref'] for row in current)
        assert all(selected[row['public_ref']]['mode'] == 'printing' for row in current)
        answer = client.get('/api/public/decks/' + 'a' * 32)
        assert answer.status_code == 200
        for displayed in answer.json()['identities'][0]['editions']:
            assert displayed['image_url'] == small
            assert displayed['large_image_url'] == large
        assert frozen == original_frozen
        return selected
    assert_original_images()
    # 101 -> 100 honors the normal 1% source-drop guard. Sidecars are delivered
    # normally; this regression must not pass by supplying an empty reviewed map.
    run(OtherVariantSource(present=False))
    withdrawal = {row['id']: deliver_generation_art(
        row, phase=f"other-variant withdrawal: {row['descriptor']}", mode='printing',
        previous=initial[row['id']]) for row in current}
    withdrawn = assert_original_images()
    assert all(withdrawn[row['public_ref']]['set_id'] == '' and
               withdrawn[row['public_ref']]['collector_number'] == '' for row in current)
    run(OtherVariantSource())
    for row in current:
        deliver_generation_art(row, phase=f"other-variant reinstatement: {row['descriptor']}", mode='printing',
                               previous=withdrawal[row['id']])
    reinstated = assert_original_images()
    assert all(reinstated[row['public_ref']]['set_id'] == 'svp' for row in current)
