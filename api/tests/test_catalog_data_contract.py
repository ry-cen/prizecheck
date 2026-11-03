"""The migrated catalog shapes and semantics that shared SQL actually consumes (#520).

Run through verify:local, like the other PostgreSQL tests. These fixtures and even the
deliberate incompatible view/function changes roll back; no catalog import or network
source is needed. See docs/planning/shared-core/catalog-data-contract.md for scope.
"""
from contextlib import nullcontext
from dataclasses import dataclass
import re
from uuid import UUID, uuid4

import psycopg
import pytest

from app import card_accepts, deck_list_capture
from app.core.art import store
from app.core.art.urls import route_address
from app.core.catalog.card_facts import CARD_FACTS, card_facts
from app.core.decks import contents
from app.core.trading.trade_wants import AVAILABLE
from app.db import connect


@pytest.fixture
def conn():
    with connect() as connection:
        try:
            yield connection
        finally:
            connection.rollback()


@dataclass(frozen=True)
class SeedCard:
    printing: UUID
    edition: UUID
    identity: UUID


def seed_card(conn, *, name='Identity fallback', identity=None, display=None):
    identity = identity or conn.execute(
        'INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id',
        (str(uuid4()), name)).fetchone()['id']
    printing = conn.execute(
        "INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',%s) RETURNING id",
        (identity,)).fetchone()['id']
    edition = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
        VALUES (%s,'unspecified','{"label":"Unspecified Variant"}') RETURNING id""",
        (printing,)).fetchone()['id']
    if display is not None:
        conn.execute('''INSERT INTO catalog_printing_display
            (printing_id,display_name,set_id,set_name,collector_number,image_url)
            VALUES (%s,%s,%s,%s,%s,%s)''', (printing, *display))
    return SeedCard(printing, edition, identity)


def seed_generation(conn):
    generation = uuid4()
    conn.execute('''INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256)
        VALUES (%s,1,%s,'contract-fixture')''', (generation, b'fixture'))
    return generation


def generation_card(conn, generation, card, *, active=True, tombstoned=False, image=None):
    conn.execute('''INSERT INTO catalog_generation_printing
        (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,
         search_name,source_fingerprint,basic_energy,tombstoned,image_url)
        VALUES (%s,%s,%s,'sv01','Scarlet & Violet','2','Generation name','generation name',
                'contract-fixture','not_basic',%s,%s)''',
        (generation, card.printing, str(uuid4()), tombstoned, image))
    conn.execute('''INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active)
        VALUES (%s,%s,%s,%s)''', (generation, card.edition, card.printing, active))


def test_required_shared_relation_columns_keep_their_postgresql_types(conn):
    # Subsets, not complete table snapshots: additive columns are compatible. Include
    # predicate/join columns and operational/cache reads, not just serialized fields.
    required = {
        'catalog_state': {'singleton': 'boolean', 'active_generation': 'uuid', 'revision': 'bigint'},
        'catalog_edition': {'id': 'uuid', 'printing_id': 'uuid', 'descriptor': 'jsonb'},
        'catalog_printing': {'id': 'uuid', 'identity_id': 'uuid', 'public_ref': 'text'},
        'catalog_identity': {'id': 'uuid', 'display_name': 'text'},
        'catalog_generation_edition': {
            'generation_id': 'uuid', 'edition_id': 'uuid', 'printing_id': 'uuid', 'active': 'boolean'},
        'catalog_generation_printing': {
            'generation_id': 'uuid', 'printing_id': 'uuid', 'tombstoned': 'boolean'},
        'catalog_printing_display': {column: 'uuid' if column == 'printing_id' else 'text'
                                     for column in ('printing_id', 'display_name', 'set_id', 'set_name', 'collector_number')},
        'catalog_printing_set_code': {'printing_id': 'uuid', 'set_code': 'text'},
        'catalog_printing_art': {column: 'uuid' if column == 'printing_id' else 'text'
                                 for column in ('printing_id', 'small_art_url', 'low_image_url', 'high_image_url',
                                                'large_upgrade_url', 'stored_upgrade_url')},
        'catalog_run': {'outcome': 'text'},
        'catalog_review': {'status': 'text'},
        'catalog_public_outbox': {'created_at': 'timestamp with time zone', 'delivered_at': 'timestamp with time zone'},
        'art_object': {'printing_id': 'uuid', 'size': 'text', 'source_url': 'text', 'storage_key': 'text',
                       'sha256': 'text', 'content_type': 'text', 'byte_size': 'integer'},
        'art_large_upgrade': {'printing_id': 'uuid', 'candidate_url': 'text', 'base_url': 'text', 'outcome': 'text',
                              'width': 'integer', 'height': 'integer', 'failures': 'integer', 'reason': 'text',
                              'checked_at': 'timestamp with time zone'},
        'art_fetch_failure': {'printing_id': 'uuid', 'size': 'text', 'source_url': 'text', 'failures': 'integer',
                              'last_failed_at': 'timestamp with time zone', 'reason': 'text'},
        'art_hit': {'printing_id': 'uuid', 'size': 'text', 'hits': 'bigint', 'last_hit_at': 'timestamp with time zone'},
    }
    for relation, columns in required.items():
        actual = {row['attname']: row['type'] for row in conn.execute('''
            SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute
            WHERE attrelid=to_regclass(%s) AND attnum>0 AND NOT attisdropped''', (relation,))}
        for column, expected in columns.items():
            assert actual.get(column) == expected, (
                f'shared catalog SQL requires {relation}.{column}: {expected}; got {actual.get(column)!r}')
    signature = conn.execute("""SELECT prorettype::regtype::text AS result FROM pg_proc
        WHERE oid=to_regprocedure('catalog_search_words(text)')""").fetchone()
    assert signature == {'result': 'text'}, 'shared name search requires catalog_search_words(text) -> text'


def test_card_facts_preserves_bare_printings_and_set_code_join_cardinality(conn):
    bare = seed_card(conn)
    known = seed_card(conn, display=('Flabébé', 'sv01', 'Scarlet & Violet', '097', None))
    unknown = seed_card(conn, display=('Other', 'contract-unmapped', 'Other Set', 'TG01', None))
    ids = [bare.edition, known.edition, unknown.edition]
    # The dict-returning reader alone would hide duplicate join rows.
    rows = conn.execute(CARD_FACTS, (ids,)).fetchall()
    assert len(rows) == len(ids), 'display/art/set-code joins must produce exactly one row per Edition'
    facts = card_facts(conn, [*ids, bare.edition, uuid4()])
    assert set(facts) == set(ids), 'optional metadata must not lose a retained Edition'
    fallback = facts[bare.edition]
    assert (fallback.name, fallback.set_code, fallback.set_name, fallback.collector_number,
            fallback.image_url, fallback.search_key) == ('Identity fallback', '', '', '', None, 'identityfallback')
    assert fallback.descriptor == {'label': 'Unspecified Variant'}
    assert (fallback.printing_id, fallback.identity_id) == (bare.printing, bare.identity)
    assert facts[known.edition].set_code == 'SVI'
    assert facts[known.edition].name == 'Flabébé' and facts[known.edition].search_key == 'flabebe'
    assert facts[unknown.edition].set_code == 'contract-unmapped'
    assert card_facts(conn, []) == {}


def test_shared_search_and_card_order_use_retained_display_not_generation_names(conn):
    cards = [seed_card(conn, display=('Mr. Mime', 'sv01', 'A set', number, None))
             for number in ('TG01', '10', '2a', '002', '2')]
    other_set = seed_card(conn, display=('Mr. Mime', 'sv02', 'B set', '1', None))
    other_name = seed_card(conn, display=('Zubat', 'sv01', 'A set', '1', None))
    twin = conn.execute('''INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
        VALUES (%s,'foil','{"label":"Foil"}') RETURNING id''', (cards[-1].printing,)).fetchone()['id']
    generation = seed_generation(conn)
    generation_card(conn, generation, cards[0])
    conn.execute('UPDATE catalog_state SET active_generation=%s WHERE singleton', (generation,))
    facts = card_facts(conn, [c.edition for c in cards] + [other_set.edition, other_name.edition, twin])
    ordered = sorted(facts.values(), key=lambda card: card.order())
    number_two = sorted([cards[-1].edition, twin])
    assert [card.edition_id for card in ordered] == [
        cards[3].edition, *number_two, cards[2].edition, cards[1].edition, cards[0].edition,
        other_set.edition, other_name.edition]
    assert all(card.search_key == 'mrmime' for card in ordered[:-1])
    for text, key in (("Farfetch’d", 'farfetchd'), ('Porygon-Z', 'porygonz'), ('Ｆlabébé ♀', 'flabebe')):
        bare = seed_card(conn, name=text)
        assert card_facts(conn, [bare.edition])[bare.edition].search_key == key


def test_art_resolver_and_facts_share_active_retained_and_linked_fallbacks(conn):
    retained = 'https://assets.example.test/retained'
    active = 'https://assets.example.test/active'
    card = seed_card(conn, display=('Art', 'sv01', 'Set', '1', retained))
    generation = seed_generation(conn)
    generation_card(conn, generation, card, image=active)
    conn.execute('UPDATE catalog_state SET active_generation=%s WHERE singleton', (generation,))
    conn.execute('INSERT INTO catalog_printing_fallback_art(printing_id,product_id) VALUES (%s,520)', (card.printing,))
    linked = re.compile(r'https://tcgplayer-cdn\.tcgplayer\.com/product/\d+_\d+w\.jpg')

    def assert_source(seed, expected):
        resolved = store.resolve(conn, seed.printing, 'small', allowed_host='assets.example.test', linked_art=linked)
        assert resolved['low_image_url'] == expected + '/low.webp'
        assert resolved['high_image_url'] == expected + '/high.webp'
        assert re.fullmatch('[0-9a-f]{48}', resolved['public_ref'])
        assert card_facts(conn, [seed.edition])[seed.edition].image_url == route_address(seed.printing, expected + '/low.webp')

    assert_source(card, active)
    conn.execute("UPDATE catalog_generation_printing SET image_url='' WHERE generation_id=%s", (generation,))
    assert_source(card, retained)
    conn.execute('UPDATE catalog_state SET active_generation=NULL WHERE singleton')
    assert_source(card, retained)
    bare = seed_card(conn)
    assert store.resolve(conn, bare.printing, 'small', allowed_host='assets.example.test', linked_art=linked) is None
    conn.execute('INSERT INTO catalog_printing_fallback_art(printing_id,product_id) VALUES (%s,521)', (bare.printing,))
    fallback = store.resolve(conn, bare.printing, 'large', allowed_host='assets.example.test', linked_art=linked)
    assert fallback['low_image_url'] == 'https://tcgplayer-cdn.tcgplayer.com/product/521_200w.jpg'
    assert fallback['high_image_url'] == 'https://tcgplayer-cdn.tcgplayer.com/product/521_400w.jpg'
    assert card_facts(conn, [bare.edition])[bare.edition].image_url == route_address(bare.printing, fallback['low_image_url'])


def test_only_matching_won_art_upgrades_change_the_shared_route_version(conn):
    source = 'https://assets.example.test/base'
    card = seed_card(conn, display=('Art', 'sv01', 'Set', '1', source))
    candidate = 'https://tcgplayer-cdn.tcgplayer.com/product/520_in_1000x1000.jpg'
    conn.execute('INSERT INTO catalog_printing_art_product(printing_id,product_id) VALUES (%s,520)', (card.printing,))
    conn.execute('''INSERT INTO art_large_upgrade(printing_id,candidate_url,base_url,outcome,width,height)
        VALUES (%s,%s,%s,'won',1000,1400)''', (card.printing, candidate, source + '/high.webp'))
    row = store.resolve(conn, card.printing, 'large', allowed_host='assets.example.test', linked_art=re.compile('never'))
    assert (row['large_upgrade_url'], row['stored_upgrade_url']) == (candidate, candidate)
    assert card_facts(conn, [card.edition])[card.edition].image_url == route_address(
        card.printing, source + '/low.webp', upgrade=candidate)
    conn.execute("UPDATE art_large_upgrade SET base_url='https://assets.example.test/stale' WHERE printing_id=%s", (card.printing,))
    row = store.resolve(conn, card.printing, 'large', allowed_host='assets.example.test', linked_art=re.compile('never'))
    assert row['stored_upgrade_url'] is None
    assert card_facts(conn, [card.edition])[card.edition].image_url == route_address(card.printing, source + '/low.webp')


def test_availability_is_generation_scoped_but_shared_facts_and_acceptance_are_retained(conn):
    current, old = seed_generation(conn), seed_generation(conn)
    conn.execute('UPDATE catalog_state SET active_generation=%s WHERE singleton', (current,))
    live, inactive, withdrawn, stale, missing = [seed_card(conn) for _ in range(5)]
    generation_card(conn, current, live)
    generation_card(conn, current, inactive, active=False)
    generation_card(conn, current, withdrawn, tombstoned=True)
    generation_card(conn, old, stale)
    # Live rows in an older generation must not rescue current inactive/tombstoned rows.
    generation_card(conn, old, inactive)
    generation_card(conn, old, withdrawn)
    for card, expected in ((live, True), (inactive, False), (withdrawn, False), (stale, False), (missing, False)):
        assert bool(conn.execute(AVAILABLE, (card.edition,)).fetchone()) is expected
    ids = [card.edition for card in (live, inactive, withdrawn, stale, missing)]
    assert set(card_facts(conn, ids)) == set(ids), 'historical cards remain displayable when unavailable for new lines'
    second = seed_card(conn, identity=live.identity)
    foil = conn.execute('''INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
        VALUES (%s,'foil','{}') RETURNING id''', (live.printing,)).fetchone()['id']
    assert card_accepts.accepts(conn, {live.edition: 'printing'}) == {live.edition: {live.edition, foil}}
    assert card_accepts.accepts(conn, {live.edition: 'identity'}) == {
        live.edition: {live.edition, foil, second.edition}}
    assert card_accepts.accepts(conn, {missing.edition: 'edition'}) == {missing.edition: {missing.edition}}
    conn.execute('UPDATE catalog_state SET active_generation=NULL WHERE singleton')
    assert conn.execute(AVAILABLE, (live.edition,)).fetchone() is None
    assert live.edition in card_facts(conn, [live.edition])


def test_detached_shared_deck_captures_bind_the_catalog_revision(conn, monkeypatch):
    owner, deck = str(uuid4()), uuid4()
    conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
    conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Contract deck','deck')", (deck, owner))
    # Only connection ownership changes: both readers execute their real locks/SQL
    # against this transaction's fixtures instead of opening another connection.
    monkeypatch.setattr(contents, 'connect', lambda: nullcontext(conn))
    monkeypatch.setattr(deck_list_capture, 'connect', lambda: nullcontext(conn))
    for _ in range(2):
        revision = conn.execute('UPDATE catalog_state SET revision=revision+1 WHERE singleton RETURNING revision').fetchone()['revision']
        assert contents.capture_deck_contents(deck, owner).catalog_revision == revision
        assert deck_list_capture.capture_deck_list(deck, owner).catalog_revision == revision


def test_incompatible_view_column_is_caught_by_the_real_shared_reader_and_rolled_back(conn):
    card = seed_card(conn)
    with conn.transaction(force_rollback=True):
        conn.execute('ALTER VIEW catalog_printing_set_code RENAME COLUMN set_code TO incompatible_code')
        with pytest.raises(psycopg.errors.UndefinedColumn, match='psc.set_code'):
            card_facts(conn, [card.edition])
    assert card_facts(conn, [card.edition])[card.edition].set_code == ''


def test_incompatible_search_semantics_are_caught_and_rolled_back(conn):
    card = seed_card(conn, name='Flabébé')

    def assert_search():
        actual = card_facts(conn, [card.edition])[card.edition].search_key
        assert actual == 'flabebe', f'shared card search must fold accents; got {actual!r}'

    assert_search()
    with conn.transaction(force_rollback=True):
        conn.execute('''CREATE OR REPLACE FUNCTION catalog_search_words(name text) RETURNS text
            LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE RETURN 'incompatible'::text''')
        with pytest.raises(AssertionError, match='shared card search must fold accents'):
            assert_search()
    assert_search()
