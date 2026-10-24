"""Near you and card search capacity (Trading #300; resolution "Testing" item 9, design targets to confirm):
``GET /api/social/trade-matches/near`` over 500 nearby candidates and ``GET /api/social/trade-card-search`` over 1,000,
at the signed HTTP seam against PostgreSQL.

Two worlds, both written set-based like ``test_trade_capacity.py``'s: a catalog of ``CATALOG`` Editions, each its own
Card Printing and Card Identity in one set. The viewer and every candidate are in open discovery (zip 00010, spread over
distance bands 1 to 4, all within 50 mi) with no Friends, and each holds one copy of ``LISTABLE`` Editions in one For
trade binder, drawn from the whole catalog by a hash of the collector's number, so any two collectors share about a
tenth of them.
- Near you: 500 candidates, the first 200 of them with ``DECKS`` Decks of ``LINES`` lines (as is the viewer). Every
  candidate holds about 90 Editions on the viewer's Want List, so every one matches and the 100-row cap applies.
- Card search: 1,000 candidates who all hold Edition 0 (the viewer draws normally), no Decks. The 50-holder cap applies.

The p95 targets (2.0 s and 1.0 s) are design targets. Here each test proves the world is built and the read answers
correctly; the numbers are confirmed only in #305's quiet serial run, because the verification host is shared while
the Stage 2 tickets are built.
"""
import math
import statistics
import time
from uuid import uuid4

import pytest

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog import reset_catalog
from test_holdings import call
from test_open_discovery import seed_zips

CATALOG = 20_000
LISTABLE = 2_000
DECKS = 60
LINES = 15
SAMPLES = 20
NEAR = 500
DECK_HOLDERS = 200
NEAR_P95_SECONDS = 2.0
SEARCHERS = 1_000
SEARCH_P95_SECONDS = 1.0


def seed_catalog(conn, generation):
    conn.execute("""CREATE TEMP TABLE capacity ON COMMIT DROP AS SELECT n - 1 AS n, gen_random_uuid() AS identity_id,
      gen_random_uuid() AS printing_id, gen_random_uuid() AS edition_id FROM generate_series(1, %s) n""", (CATALOG,))
    conn.execute("""INSERT INTO catalog_identity(id, identity_key, display_name)
      SELECT identity_id, 'nearcap-' || identity_id, 'Capacity Card ' || lpad(n::text, 5, '0') FROM capacity""")
    conn.execute("""INSERT INTO catalog_printing(id, source, source_id, identity_id)
      SELECT printing_id, 'tcgdex', 'nearcap-' || printing_id, identity_id FROM capacity""")
    conn.execute("INSERT INTO catalog_generation(id, source_count, raw_gzip, raw_sha256) VALUES (%s, 1, %s, 'test')",
                 (generation, b'test'))
    conn.execute("""INSERT INTO catalog_generation_printing(generation_id, printing_id, source_id, set_id, set_name,
        collector_number, display_name, search_name, source_fingerprint, basic_energy, tombstoned)
      SELECT %s, printing_id, 'nearcap-' || printing_id, 'capacity', 'Capacity Set', n::text,
        'Capacity Card ' || lpad(n::text, 5, '0'), 'capacity card ' || n, 'seed', 'not_basic', false FROM capacity""",
                 (generation,))
    conn.execute("""INSERT INTO catalog_edition(id, printing_id, descriptor_key, descriptor)
      SELECT edition_id, printing_id, 'normal', '{"finish":"normal"}'::jsonb FROM capacity""")
    conn.execute("""INSERT INTO catalog_generation_edition(generation_id, edition_id, printing_id)
      SELECT %s, edition_id, printing_id FROM capacity""", (generation,))
    conn.execute('UPDATE catalog_state SET active_generation=%s, revision=revision+1 WHERE singleton', (generation,))


def seed_near_world(candidates: int, deck_holders: int, every_holds_first: bool):
    """The catalog, the viewer and ``candidates`` collectors, all in open discovery and none a Friend, written
    set-based in one transaction; returns (viewer, candidates)."""
    reset_catalog()
    seed_zips()  # the zip foreign key
    tag = uuid4().hex[:8]
    viewer = f'nearcap-{tag}-viewer'
    others = [f'nearcap-{tag}-{n:04d}' for n in range(candidates)]
    everyone = [viewer, *others]
    with connect() as conn, conn.transaction():
        seed_catalog(conn, uuid4())
        # The collectors: number c is 0 for the viewer and 1 to ``candidates`` for the rest.
        conn.execute("""CREATE TEMP TABLE who ON COMMIT DROP AS
          SELECT c - 1 AS c, id FROM unnest(%s::text[]) WITH ORDINALITY AS t(id, c)""", (everyone,))
        conn.execute('INSERT INTO inventory_owner(user_id) SELECT id FROM who')
        # The owner row makes each profile; the Handles and Display Names are set here.
        conn.execute("""UPDATE collector_profile p SET handle = 'near' || %s || lpad(w.c::text, 4, '0'),
            handle_key = lower('near' || %s || lpad(w.c::text, 4, '0')),
            display_name = 'Near ' || lpad(w.c::text, 4, '0')
          FROM who w WHERE p.user_id = w.id""", (tag, tag))
        # Open discovery for everyone, spread over bands 1 to 4 (0.1 degree of latitude is about 6.9 mi); the viewer
        # (c = 0) sits at 40.0.
        conn.execute("""INSERT INTO discovery_setting (user_id, enabled, zip, lat, lon, radius_mi)
          SELECT id, true, '00010', 40.0 + (ARRAY[0.0, 0.1, 0.2, 0.4])[c % 4 + 1], -100.0, 50 FROM who""")
        # One For trade binder each, holding one copy of LISTABLE Editions.
        conn.execute("""CREATE TEMP TABLE binder ON COMMIT DROP AS SELECT c, id AS owner_id, gen_random_uuid() AS id
          FROM who""")
        conn.execute("""INSERT INTO location(id, owner_id, parent_id, name, kind, for_trade)
          SELECT id, owner_id, NULL, 'Trade Binder', 'storage_leaf', true FROM binder""")
        if every_holds_first:
            # Every candidate holds Edition 0 and LISTABLE - 1 others; the viewer draws normally.
            conn.execute("""INSERT INTO holding(owner_id, location_id, edition_id, quantity, version)
              SELECT b.owner_id, b.id, s.edition_id, 1, 1 FROM binder b
              CROSS JOIN LATERAL (SELECT edition_id FROM capacity WHERE b.c = 0 OR n > 0
                ORDER BY md5(b.c || ':listed:' || n) LIMIT CASE WHEN b.c = 0 THEN %s ELSE %s END) s""",
                         (LISTABLE, LISTABLE - 1))
            conn.execute("""INSERT INTO holding(owner_id, location_id, edition_id, quantity, version)
              SELECT b.owner_id, b.id, k.edition_id, 1, 1 FROM binder b CROSS JOIN capacity k
              WHERE b.c > 0 AND k.n = 0 AND NOT EXISTS (SELECT 1 FROM holding h
                WHERE h.owner_id = b.owner_id AND h.edition_id = k.edition_id)""")
        else:
            conn.execute("""INSERT INTO holding(owner_id, location_id, edition_id, quantity, version)
              SELECT b.owner_id, b.id, s.edition_id, 1, 1 FROM binder b
              CROSS JOIN LATERAL (SELECT edition_id FROM capacity ORDER BY md5(b.c || ':listed:' || n) LIMIT %s) s""",
                         (LISTABLE,))
        # DECKS Decks each for the viewer and the first ``deck_holders`` candidates, LINES lines of 2 copies each.
        conn.execute("""CREATE TEMP TABLE capdeck ON COMMIT DROP AS
          SELECT w.c, w.id AS owner_id, d, gen_random_uuid() AS id
          FROM who w, generate_series(0, %s - 1) d WHERE w.c <= %s""", (DECKS, deck_holders))
        conn.execute("""INSERT INTO location(id, owner_id, parent_id, name, kind, created_at)
          SELECT id, owner_id, NULL, 'Capacity Deck ' || d, 'deck', '2026-01-01'::timestamptz + d * interval '1 hour'
          FROM capdeck""")
        conn.execute("""INSERT INTO deck_list_line(owner_id, deck_id, edition_id, quantity)
          SELECT k.owner_id, k.id, s.edition_id, 2 FROM capdeck k
          JOIN (SELECT w.c, x.edition_id, x.rank FROM who w CROSS JOIN LATERAL (
                  SELECT edition_id, row_number() OVER (ORDER BY md5(w.c || ':decks:' || n)) - 1 AS rank
                  FROM capacity ORDER BY md5(w.c || ':decks:' || n) LIMIT %s) x WHERE w.c <= %s) s
            ON s.c = k.c AND s.rank / %s = k.d""", (DECKS * LINES, deck_holders, LINES))
    with connect() as conn:
        conn.execute('ANALYZE')
    return viewer, others


def timed(read, check):
    """One warm-up read is the caller's; this runs ``SAMPLES`` timed reads, each checked, and returns the seconds."""
    samples = []
    for _ in range(SAMPLES):
        started = time.perf_counter()
        body = read()
        samples.append(time.perf_counter() - started)
        check(body)
    return samples


def p95_of(samples):
    return sorted(samples)[math.ceil(len(samples) * 0.95) - 1]


@pytest.mark.slow(reason='capacity: seeds 501 collectors in open discovery with 2,000 listable Editions each and 60 Decks for 200 of them')
@pytest.mark.serial(reason='bounds the 95th percentile of the Near you read, so it runs with nothing else')
def test_near_you_answers_500_nearby_candidates_within_the_design_target():
    viewer, candidates = seed_near_world(NEAR, DECK_HOLDERS, False)
    with connect() as conn:
        assert conn.execute('SELECT count(*) FROM holding WHERE owner_id = ANY(%s)',
                            ([viewer, *candidates],)).fetchone()['count'] == (NEAR + 1) * LISTABLE
        assert conn.execute("SELECT count(*) FROM location WHERE kind = 'deck' AND owner_id = ANY(%s)",
                            ([viewer, *candidates],)).fetchone()['count'] == (DECK_HOLDERS + 1) * DECKS

    def read():
        response = call('GET', '/api/social/trade-matches/near', viewer)
        assert response.status_code == 200, response.text
        return response.json()

    def check(body):
        assert len(body['rows']) == 100

    body = read()  # warm-up, not counted
    # Every candidate shares about a tenth of the catalog with the viewer's wants, so all match and the cap applies.
    assert body['status'] == 'on' and len(body['rows']) == 100
    assert all(len(row['you_get']) == 20 for row in body['rows'])
    order = ['under_5', '5_to_10', '10_to_25', '25_to_50']
    for kind in {row['match'] for row in body['rows']}:
        ranks = [order.index(row['band']) for row in body['rows'] if row['match'] == kind]
        assert ranks == sorted(ranks)
    samples = timed(read, check)
    p95 = p95_of(samples)
    print(f'near-you p95 {p95:.3f}s median {statistics.median(samples):.3f}s', sorted(round(s, 3) for s in samples))
    assert p95 <= NEAR_P95_SECONDS, (p95, sorted(samples))


@pytest.mark.slow(reason='capacity: seeds 1,001 collectors in open discovery with 2,000 listable Editions each')
@pytest.mark.serial(reason='bounds the 95th percentile of the card search read, so it runs with nothing else')
def test_card_search_answers_1000_nearby_candidates_within_the_design_target():
    viewer, candidates = seed_near_world(SEARCHERS, 0, True)
    with connect() as conn:
        assert conn.execute('SELECT count(*) FROM holding WHERE owner_id = ANY(%s)',
                            ([viewer, *candidates],)).fetchone()['count'] == (SEARCHERS + 1) * LISTABLE
        printing = conn.execute("""SELECT p.id FROM catalog_printing p JOIN catalog_identity i ON i.id = p.identity_id
          WHERE i.display_name = 'Capacity Card 00000'""").fetchone()['id']

    def read():
        response = call('GET', f'/api/social/trade-card-search?printing_id={printing}&scope=name', viewer)
        assert response.status_code == 200, response.text
        return response.json()

    def check(body):
        assert len(body['near']) == 50

    body = read()  # warm-up, not counted
    assert body['status'] == 'on' and body['friends'] == [] and len(body['near']) == 50
    assert all(len(holder['cards']) == 1 and holder['more_cards'] == 0 for holder in body['near'])
    order = ['under_5', '5_to_10', '10_to_25', '25_to_50']
    ranks = [order.index(holder['band']) for holder in body['near']]
    assert ranks == sorted(ranks)
    samples = timed(read, check)
    p95 = p95_of(samples)
    print(f'card-search p95 {p95:.3f}s median {statistics.median(samples):.3f}s', sorted(round(s, 3) for s in samples))
    assert p95 <= SEARCH_P95_SECONDS, (p95, sorted(samples))
