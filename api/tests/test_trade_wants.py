"""A collector's own Trade Wants and Will accept choices (Trading #275): ``GET /api/trade-wants``,
``PUT /api/trade-wants/{edition_id}`` and ``PUT /api/trade-wants/will-accept/{edition_id}`` (``app.trade_wants``), and
the Will accept expansion ``app.card_accepts.accepts``, through signed HTTP against PostgreSQL.

A Trade Wants line is one exact Card Edition and a quantity from 1 to 9999; "0" removes it, and a collector has at most
500. A Will accept choice is one per Card Edition, wherever it appears on the Want List, and outlives the card leaving
it. Neither changes a Want List figure: counts, totals, exports and pins stay exactly as they were, and only the Swap
hint follows Will accept (test_want_list_swap_will_accept.py). Only the collector reads either.

Every test seeds the Swap catalog (``want_list_swap_fixtures``): Iono PAL 185, PAL 254 and PAF 80 in one Reprint Group,
Arven SVI 166 in two finishes, Basic Psychic Energy SVE 5 and SVE 13 (one Card Identity, no group) and Boss's Orders
PAL 172 in two finishes (no group).
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import psycopg

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.card_accepts import accepts
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import buy_missing, counting, deck, detail, hold, line, new_owner
from test_friend_copies import befriend, collector, copies, ok
from test_handover import _asleep, _sleeping
from test_holdings import call
from test_loan_promises import _waiting_on_a_row
from test_prices import client
from test_want_list import check_shape, want_list
from test_want_list_mass_entry import download, export
from want_list_swap_fixtures import seed_swap_catalog


def wants(owner):
    return ok(call('GET', '/api/trade-wants', owner))


def set_want(owner, edition, quantity):
    return call('PUT', f'/api/trade-wants/{edition}', owner, {'quantity': str(quantity)})


def set_rule(owner, edition, rule):
    return call('PUT', f'/api/trade-wants/will-accept/{edition}', owner, {'rule': rule})


def lines_of(body):
    """The Trade Wants as [(Edition, quantity)], in the answer's order."""
    return [(item['edition_id'], item['quantity']) for item in body['lines']]


def rules_of(body):
    return {item['edition_id']: item['rule'] for item in body['will_accept']}


def code(response):
    return response.status_code, response.json()['detail']['code']


def extra_editions(count):
    """``count`` catalog Editions of Arven SVI 166's Printing that no generation lists (so none may start a line),
    for filling Trade Wants up to the cap with direct writes."""
    with connect() as conn:
        printing = conn.execute("SELECT id FROM catalog_printing WHERE source_id='sv01-166'").fetchone()['id']
        return [str(row['id']) for row in conn.execute(
            """INSERT INTO catalog_edition(printing_id, descriptor_key, descriptor)
            SELECT %s, 'cap-' || g, jsonb_build_object('finish', 'cap-' || g)
            FROM generate_series(1, %s) g RETURNING id""", (printing, count))]


def fill(owner, editions):
    with connect() as conn:
        conn.execute('INSERT INTO trade_want(owner_id, edition_id, quantity) SELECT %s, unnest(%s::uuid[]), 1',
                     (owner, editions))


def without_swaps(body):
    """A Want List answer with every Swap hint left out: the only part Will accept may change."""
    return {**body, 'sections': [{**entry, 'lines': [{key: value for key, value in item.items() if key != 'swap'}
                                                     for item in entry['lines']]} for entry in body['sections']]}


# Trade Wants lines.


def test_a_line_is_set_changed_and_removed_with_zero_and_reads_in_card_order(store):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    assert wants(owner) == {'lines': [], 'will_accept': []}
    for edition, quantity in ((ids['PAL 172 Reverse Holo'], 2), (ids['PAF 80'], 1), (ids['PAL 254'], 4),
                              (ids['PAL 254'], 3)):
        assert set_want(owner, edition, quantity).status_code == 200
    body = wants(owner)
    # Boss's Orders, then Iono PAL 254 (Paldea Evolved), then Iono PAF 80 (Paldean Fates): name, set, number.
    assert lines_of(body) == [(ids['PAL 172 Reverse Holo'], '2'), (ids['PAL 254'], '3'), (ids['PAF 80'], '1')]
    assert body['lines'][1] == {
        'edition_id': ids['PAL 254'], 'name': 'Iono', 'set_id': 'sv02', 'set_name': 'Paldea Evolved',
        'collector_number': '254', 'descriptor': {'finish': 'normal'}, 'image_url': body['lines'][1]['image_url'],
        'quantity': '3'}
    # Each setter answers the whole list; "0" removes a line, and removing one that isn't there changes nothing.
    removed = ok(set_want(owner, ids['PAL 254'], 0))
    assert removed == wants(owner) and lines_of(removed) == [(ids['PAL 172 Reverse Holo'], '2'), (ids['PAF 80'], '1')]
    assert ok(set_want(owner, ids['PAL 254'], '0')) == removed
    # The same value again is the same answer: the setter is idempotent by value.
    assert ok(set_want(owner, ids['PAF 80'], 1)) == removed
    assert ok(set_want(owner, ids['PAF 80'], 9999))['lines'][1]['quantity'] == '9999'


def test_a_quantity_outside_0_to_9999_is_refused_and_changes_nothing(store):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    ok(set_want(owner, ids['PAL 254'], 2))
    for raw in ('10000', '-1', '1.5', '', 'x', ' 1', '٣', '1' * 20):
        assert code(set_want(owner, ids['PAL 254'], raw)) == (422, 'INVALID_QUANTITY'), raw
    assert lines_of(wants(owner)) == [(ids['PAL 254'], '2')]


def test_an_edition_that_cannot_start_a_line_is_refused_but_an_existing_line_still_changes(store):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    assert code(set_want(owner, str(uuid4()), 1)) == (422, 'EDITION_UNAVAILABLE')
    ok(set_want(owner, ids['PAL 254'], 2))
    with connect() as conn:
        conn.execute('UPDATE catalog_generation_edition SET active=false WHERE edition_id = ANY(%s)',
                     ([ids['PAL 254'], ids['PAF 80']],))
    # A withdrawn Edition can't start a line, but the collector can still change or remove the one they have.
    assert code(set_want(owner, ids['PAF 80'], 1)) == (422, 'EDITION_UNAVAILABLE')
    assert lines_of(ok(set_want(owner, ids['PAL 254'], 5))) == [(ids['PAL 254'], '5')]
    assert lines_of(ok(set_want(owner, ids['PAL 254'], 0))) == []
    assert lines_of(ok(set_want(owner, ids['PAF 80'], 0))) == []


def test_a_collector_has_at_most_500_lines_and_can_always_change_one_they_have(store):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    fill(owner, extra_editions(499))
    # The 500th line is allowed, and the 501st is not.
    assert (ids['PAL 254'], '1') in lines_of(ok(set_want(owner, ids['PAL 254'], 1)))
    assert len(wants(owner)['lines']) == 500
    assert code(set_want(owner, ids['PAF 80'], 1)) == (422, 'TOO_MANY_LINES')
    # Changing or removing a line at the cap is allowed, and a removal makes room.
    ok(set_want(owner, ids['PAL 254'], 7))
    ok(set_want(owner, ids['PAL 254'], 0))
    ok(set_want(owner, ids['PAF 80'], 1))
    assert len(wants(owner)['lines']) == 500


def test_two_new_lines_at_the_cap_run_one_after_the_other(store):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    fill(owner, extra_editions(499))
    held = _sleeping('trade_want', 'INSERT', f"NEW.owner_id = '{owner}'")
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            first = executor.submit(set_want, owner, ids['PAL 254'], 1)
            _asleep(watch, 1, [first])
            second = executor.submit(set_want, owner, ids['PAF 80'], 1)
            # The second waits on the owner row the first holds, then counts the first's line.
            _waiting_on_a_row(watch, [first, second])
            first, second = first.result(), second.result()
    finally:
        held()
    assert first.status_code == 200, first.text
    assert code(second) == (422, 'TOO_MANY_LINES')
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM trade_want WHERE owner_id=%s', (owner,)).fetchone()['n'] == 500


# Will accept.


def test_will_accept_is_one_choice_per_card_that_outlives_the_card_leaving_the_want_list(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    boss, reverse = ids['PAL 172'], ids['PAL 172 Reverse Holo']
    older, newer = deck(owner, 'Older', 0), deck(owner, 'Newer', 1)
    for deck_id in (older, newer):
        line(owner, deck_id, boss, 2)
    hold(owner, unsorted, reverse, 1)
    body = ok(set_rule(owner, boss, 'printing'))
    assert rules_of(body) == {boss: 'printing'} and body == wants(owner)

    def offered():
        found = want_list(owner)
        return {entry['deck_id']: [item['swap'] and item['swap']['edition_id'] for item in entry['lines']]
                for entry in found['sections']}

    # The one choice covers the card in both Decks: the one spare Reverse Holo is offered once, to the older Deck.
    assert offered() == {older: [reverse], newer: [None]}
    # The card leaves the Want List: the choice stays, and applies again when it comes back.
    for deck_id in (older, newer):
        line(owner, deck_id, boss, 0)
    assert rules_of(wants(owner)) == {boss: 'printing'}
    line(owner, newer, boss, 1)
    assert offered() == {older: [], newer: [reverse]}
    # Changing it replaces it; this exact card removes it, and removing it twice is the same answer.
    assert rules_of(ok(set_rule(owner, boss, 'identity'))) == {boss: 'identity'}
    cleared = ok(set_rule(owner, boss, 'edition'))
    assert rules_of(cleared) == {} and ok(set_rule(owner, boss, 'edition')) == cleared
    assert offered() == {older: [], newer: [None]}


def test_a_widened_choice_needs_a_catalog_edition_and_a_rule_it_knows(store):
    seed_swap_catalog()
    owner, _ = new_owner()
    assert code(set_rule(owner, str(uuid4()), 'identity')) == (422, 'EDITION_UNAVAILABLE')
    assert ok(set_rule(owner, str(uuid4()), 'edition')) == {'lines': [], 'will_accept': []}
    assert set_rule(owner, str(uuid4()), 'reprint_group').status_code == 422
    assert wants(owner) == {'lines': [], 'will_accept': []}


def test_accepts_expands_each_rule_by_the_catalogs_card_identity_in_any_language(store):
    ids = seed_swap_catalog()
    key = {value: name for name, value in ids.items()}

    def names(found):
        return {key[str(wanted)]: sorted(key.get(str(edition), 'other') for edition in editions)
                for wanted, editions in found.items()}

    rules = {UUID(ids['PAL 185']): 'identity', UUID(ids['PAL 172']): 'printing', UUID(ids['SVE 13']): 'identity',
             UUID(ids['SVI 166']): 'edition'}
    with connect() as conn:
        assert names(accepts(conn, rules)) == {
            'PAL 185': ['PAF 80', 'PAL 185', 'PAL 254'], 'PAL 172': ['PAL 172', 'PAL 172 Reverse Holo'],
            'SVE 13': ['SVE 13', 'SVE 5'], 'SVI 166': ['SVI 166']}
        assert accepts(conn, {}) == {}
        # The name rule follows catalog_printing.identity_id, not the printed name: a Printing the catalog links to
        # Iono's Card Identity (as a Card Identity merge does) counts, here a Japanese one. The catalog holds English
        # Printings only today, so the language check is dropped inside a transaction that is rolled back.
        with conn.transaction(force_rollback=True):
            iono = conn.execute("""SELECT p.identity_id FROM catalog_edition e JOIN catalog_printing p
              ON p.id=e.printing_id WHERE e.id=%s""", (ids['PAL 185'],)).fetchone()['identity_id']
            conn.execute('ALTER TABLE catalog_printing DROP CONSTRAINT catalog_printing_language_check')
            printing = conn.execute("""INSERT INTO catalog_printing(source, language, identity_id)
              VALUES ('manual', 'ja', %s) RETURNING id""", (iono,)).fetchone()['id']
            japanese = conn.execute("""INSERT INTO catalog_edition(printing_id, descriptor_key, descriptor)
              VALUES (%s, 'normal', '{"finish": "normal"}') RETURNING id""", (printing,)).fetchone()['id']
            assert japanese in accepts(conn, {UUID(ids['PAL 254']): 'identity'})[UUID(ids['PAL 254'])]
            assert japanese not in accepts(conn, {UUID(ids['PAL 254']): 'printing'})[UUID(ids['PAL 254'])]
            assert accepts(conn, {UUID(ids['SVE 13']): 'identity'})[UUID(ids['SVE 13'])] == {
                UUID(ids['SVE 13']), UUID(ids['SVE 5'])}


# Figure-neutral: Trade Wants and Will accept move no Want List, Deck, export or Friend figure.


def _figures(owner, decks, viewer):
    body = want_list(owner)
    check_shape(body)
    return {'all': without_swaps(body), 'scoped': {d: without_swaps(want_list(owner, d)) for d in decks},
            'export': export(owner), 'exports': {d: export(owner, d) for d in decks},
            'to_get': {d: detail(owner, d)['to_get'] for d in decks},
            'buy_missing': {d: buy_missing(owner, d) for d in decks},
            'friend': copies(viewer, [owner])}


def test_trade_wants_and_will_accept_change_no_want_list_deck_export_or_friend_figure(store):
    ids = seed_swap_catalog()
    (owner, _) = collector()
    (viewer, _) = collector()
    befriend(owner, viewer)
    unsorted = next(item['id'] for item in ok(call('GET', '/api/location-tree', owner))['locations']
                    if item['name'] == 'Unsorted')
    older, newer = deck(owner, 'Older', 0), deck(owner, 'Newer', 1)
    line(owner, older, ids['PAL 185'], 4)
    line(owner, older, ids['SVE 13'], 3)
    line(owner, newer, ids['PAL 172'], 2)
    line(owner, newer, ids['PAL 185'], 2)
    hold(owner, older, ids['PAL 185'], 1)
    for key, copies_ in (('PAL 254', 1), ('SVE 5', 2), ('PAL 172 Reverse Holo', 1), ('SVI 166', 2)):
        hold(owner, unsorted, ids[key], copies_)
    for setting in ('all_at_once', 'one_at_a_time'):
        counting(owner, setting)
        before = _figures(owner, (older, newer), viewer)
        pins = export(owner)
        # Every card widened, a Trade Wants line beside each, and lines for cards no Deck names.
        for key in ('PAL 185', 'SVE 13', 'PAL 172', 'PAL 254', 'SVE 5'):
            ok(set_rule(owner, ids[key], 'identity' if key != 'PAL 172' else 'printing'))
        for key in ('PAL 185', 'SVE 13', 'PAL 172', 'PAF 80', 'SVI 166 Reverse Holo'):
            ok(set_want(owner, ids[key], 5))
        assert _figures(owner, (older, newer), viewer) == before, setting
        # No pin moved: the export the page prepared before the change still downloads, with no 409.
        response = download(owner, pins)
        assert response.status_code == 200, response.text
        for key in ('PAL 185', 'SVE 13', 'PAL 172', 'PAL 254', 'SVE 5'):
            ok(set_rule(owner, ids[key], 'edition'))
        for key in ('PAL 185', 'SVE 13', 'PAL 172', 'PAF 80', 'SVI 166 Reverse Holo'):
            ok(set_want(owner, ids[key], 0))
        assert _figures(owner, (older, newer), viewer) == before, setting


# Privacy and the account.


def test_only_the_collector_reads_their_trade_wants_and_no_friend_view_changes(store):
    ids = seed_swap_catalog()
    (owner, handle) = collector('Misty W.')
    (friend, _) = collector('Ash K.')
    befriend(owner, friend)
    shelf = next(item['id'] for item in ok(call('GET', '/api/location-tree', owner))['locations']
                 if item['name'] == 'Unsorted')
    hold(owner, shelf, ids['PAL 254'], 2)
    reads = ('/api/trade-wants', f'/api/social/collections/{handle}?show=all', f'/api/social/trade-lists/{handle}',
             '/api/social/want-list-matches', '/api/social/trades')
    before = {path: call('GET', path, friend).text for path in reads}
    ok(set_want(owner, ids['PAL 254'], 3))
    ok(set_rule(owner, ids['PAL 185'], 'identity'))
    assert {path: call('GET', path, friend).text for path in reads} == before
    assert json.loads(before['/api/trade-wants']) == {'lines': [], 'will_accept': []}
    # Nothing in the routes names another collector: each reads and writes the signed-in collector's own rows.
    assert lines_of(wants(owner)) == [(ids['PAL 254'], '3')]
    for path in ('/api/trade-wants',):
        assert client.get(path).status_code == 401
    assert client.put(f"/api/trade-wants/{ids['PAL 254']}", json={'quantity': '1'}).status_code == 401
    assert client.put(f"/api/trade-wants/will-accept/{ids['PAL 254']}", json={'rule': 'identity'}).status_code == 401


def test_the_lines_and_choices_go_with_the_account(store):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    (other, _) = collector()
    for user in (owner, other):
        ok(set_want(user, ids['PAL 254'], 2))
        ok(set_rule(user, ids['PAL 185'], 'identity'))
    with connect() as conn:
        conn.execute('DELETE FROM inventory_owner WHERE user_id=%s', (owner,))
        counts = {table: conn.execute(f'SELECT count(*) AS n FROM {table} WHERE owner_id=%s',
                                      (owner,)).fetchone()['n'] for table in ('trade_want', 'trade_accept')}
        kept = conn.execute('SELECT count(*) AS n FROM trade_want WHERE owner_id=%s', (other,)).fetchone()['n']
    assert counts == {'trade_want': 0, 'trade_accept': 0} and kept == 1
