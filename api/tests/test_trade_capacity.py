"""Trade discovery capacity (Trading #276, spec "Matching reads and the choke point", resolution "Friend count
assumption"): ``GET /api/social/trade-matches`` over 200 Friends, at the signed HTTP seam against PostgreSQL.

The figures are a design target, not a measured workload: nothing in the repository states how many Friends a collector
has, so the spec sets 200 Friends, 2,000 listable Editions and 60 Decks per collector, and bounds the matches read's
95th percentile at 1.5 seconds on the verification host. The world is written set-based (the routes are far too slow
for it): a catalog of ``CATALOG`` Editions (the live catalog had 21,256 Printings on 2026-10-13), each its own Card
Printing and Card Identity. The viewer and every Friend each hold one copy of ``LISTABLE`` Editions in one For trade
binder, have ``DECKS`` Decks of ``LINES`` lines of 2 copies each, and keep ``TRADE_WANTS`` Trade Wants lines. Each
collector's Editions are drawn from the whole catalog by a hash of the collector's number, so any two collectors share
about a tenth of them: every Friend matches both ways, with more cards than a row carries, and the Friends' Deck lines
that could match the viewer's Trade List (about 90 each) are allocated for all 200 Friends.
"""
import math
import time
from uuid import uuid4

import pytest

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog import reset_catalog
from test_holdings import call

FRIENDS = 200
LISTABLE = 2_000
DECKS = 60
LINES = 15
TRADE_WANTS = 20
CATALOG = 20_000
SAMPLES = 20
P95_SECONDS = 1.5


def seed_world():
    """The catalog and the 201 collectors, written set-based in one transaction; returns (viewer, friends)."""
    reset_catalog()
    tag = uuid4().hex[:8]
    viewer = f'tradecap-{tag}-viewer'
    friends = [f'tradecap-{tag}-{n:03d}' for n in range(FRIENDS)]
    everyone = [viewer, *friends]
    with connect() as conn, conn.transaction():
        generation = uuid4()
        conn.execute("""CREATE TEMP TABLE capacity ON COMMIT DROP AS SELECT n - 1 AS n, gen_random_uuid() AS identity_id,
          gen_random_uuid() AS printing_id, gen_random_uuid() AS edition_id FROM generate_series(1, %s) n""", (CATALOG,))
        conn.execute("""INSERT INTO catalog_identity(id, identity_key, display_name)
          SELECT identity_id, 'tradecap-' || identity_id, 'Capacity Card ' || lpad(n::text, 5, '0') FROM capacity""")
        conn.execute("""INSERT INTO catalog_printing(id, source, source_id, identity_id)
          SELECT printing_id, 'tcgdex', 'tradecap-' || printing_id, identity_id FROM capacity""")
        conn.execute("INSERT INTO catalog_generation(id, source_count, raw_gzip, raw_sha256) VALUES (%s, 1, %s, 'test')",
                     (generation, b'test'))
        conn.execute("""INSERT INTO catalog_generation_printing(generation_id, printing_id, source_id, set_id, set_name,
            collector_number, display_name, search_name, source_fingerprint, basic_energy, tombstoned)
          SELECT %s, printing_id, 'tradecap-' || printing_id, 'capacity', 'Capacity Set', n::text,
            'Capacity Card ' || lpad(n::text, 5, '0'), 'capacity card ' || n, 'seed', 'not_basic', false FROM capacity""",
                     (generation,))
        conn.execute("""INSERT INTO catalog_edition(id, printing_id, descriptor_key, descriptor)
          SELECT edition_id, printing_id, 'normal', '{"finish":"normal"}'::jsonb FROM capacity""")
        conn.execute("""INSERT INTO catalog_generation_edition(generation_id, edition_id, printing_id)
          SELECT %s, edition_id, printing_id FROM capacity""", (generation,))
        conn.execute('UPDATE catalog_state SET active_generation=%s, revision=revision+1 WHERE singleton', (generation,))
        # The collectors: number c is 0 for the viewer and 1 to 200 for the Friends.
        conn.execute("""CREATE TEMP TABLE who ON COMMIT DROP AS
          SELECT c - 1 AS c, id FROM unnest(%s::text[]) WITH ORDINALITY AS t(id, c)""", (everyone,))
        conn.execute('INSERT INTO inventory_owner(user_id) SELECT id FROM who')
        # The owner row makes each profile; the Handles and Display Names are set here.
        conn.execute("""UPDATE collector_profile p SET handle = 'cap' || %s || lpad(w.c::text, 3, '0'),
            handle_key = lower('cap' || %s || lpad(w.c::text, 3, '0')),
            display_name = 'Capacity Friend ' || lpad(w.c::text, 3, '0')
          FROM who w WHERE p.user_id = w.id""", (tag, tag))
        conn.execute("""INSERT INTO friendship(user_low, user_high, state, requested_by)
          SELECT least(%s COLLATE "C", id COLLATE "C"), greatest(%s COLLATE "C", id COLLATE "C"), 'accepted', %s
          FROM who WHERE c > 0""", (viewer, viewer, viewer))
        # One For trade binder each, holding one copy of LISTABLE Editions.
        conn.execute("""CREATE TEMP TABLE binder ON COMMIT DROP AS SELECT c, id AS owner_id, gen_random_uuid() AS id
          FROM who""")
        conn.execute("""INSERT INTO location(id, owner_id, parent_id, name, kind, for_trade)
          SELECT id, owner_id, NULL, 'Trade Binder', 'storage_leaf', true FROM binder""")
        conn.execute("""INSERT INTO holding(owner_id, location_id, edition_id, quantity, version)
          SELECT b.owner_id, b.id, s.edition_id, 1, 1 FROM binder b
          CROSS JOIN LATERAL (SELECT edition_id FROM capacity ORDER BY md5(b.c || ':listed:' || n) LIMIT %s) s""",
                     (LISTABLE,))
        # DECKS Decks each, oldest first, LINES lines of 2 copies each: DECKS * LINES different Editions.
        conn.execute("""CREATE TEMP TABLE capdeck ON COMMIT DROP AS
          SELECT w.c, w.id AS owner_id, d, gen_random_uuid() AS id FROM who w, generate_series(0, %s - 1) d""",
                     (DECKS,))
        conn.execute("""INSERT INTO location(id, owner_id, parent_id, name, kind, created_at)
          SELECT id, owner_id, NULL, 'Capacity Deck ' || d, 'deck', '2026-01-01'::timestamptz + d * interval '1 hour'
          FROM capdeck""")
        conn.execute("""INSERT INTO deck_list_line(owner_id, deck_id, edition_id, quantity)
          SELECT k.owner_id, k.id, s.edition_id, 2 FROM capdeck k
          JOIN (SELECT w.c, x.edition_id, x.rank FROM who w CROSS JOIN LATERAL (
                  SELECT edition_id, row_number() OVER (ORDER BY md5(w.c || ':decks:' || n)) - 1 AS rank
                  FROM capacity ORDER BY md5(w.c || ':decks:' || n) LIMIT %s) x) s
            ON s.c = k.c AND s.rank / %s = k.d""", (DECKS * LINES, LINES))
        conn.execute("""INSERT INTO trade_want(owner_id, edition_id, quantity)
          SELECT w.id, s.edition_id, 1 FROM who w
          CROSS JOIN LATERAL (SELECT edition_id FROM capacity ORDER BY md5(w.c || ':wants:' || n) LIMIT %s) s""",
                     (TRADE_WANTS,))
    with connect() as conn:
        conn.execute('ANALYZE')
    return viewer, friends


@pytest.mark.slow(reason='capacity: seeds 201 collectors with 2,000 listable Editions and 60 Decks each')
@pytest.mark.serial(reason='bounds the 95th percentile of the matches read, so it runs with nothing else')
def test_trade_matches_answers_200_friends_within_the_design_target():
    viewer, friends = seed_world()
    with connect() as conn:
        assert conn.execute('SELECT count(*) FROM holding WHERE owner_id = ANY(%s)',
                            ([viewer, *friends],)).fetchone()['count'] == (FRIENDS + 1) * LISTABLE
        assert conn.execute("SELECT count(*) FROM location WHERE kind = 'deck' AND owner_id = ANY(%s)",
                            ([viewer, *friends],)).fetchone()['count'] == (FRIENDS + 1) * DECKS

    def read():
        response = call('GET', '/api/social/trade-matches', viewer)
        assert response.status_code == 200, response.text
        return response.json()

    body = read()  # warm-up, not counted
    # Every Friend matches both ways with more cards than a row carries, so nothing was skipped.
    assert body['has_friends'] is True and len(body['rows']) == FRIENDS
    assert {row['match'] for row in body['rows']} == {'two_way'}
    assert all(len(row['you_get']) == 20 and row['more_you_get'] > 0 for row in body['rows'])
    assert all(len(row['you_give']) == 20 and row['more_you_give'] > 0 for row in body['rows'])
    samples = []
    for _ in range(SAMPLES):
        started = time.perf_counter()
        assert len(read()['rows']) == FRIENDS
        samples.append(time.perf_counter() - started)
    p95 = sorted(samples)[math.ceil(len(samples) * 0.95) - 1]
    assert p95 <= P95_SECONDS, (p95, sorted(samples))
