"""Deck Lists follow Moves (ADR 0009): copies arriving in a Deck are covered by its Deck List, and copies leaving it
never shrink the list. Exercised through the real Holding, Move, undo and reassignment routes over signed HTTP."""
from timing_support import within_budget
import os
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest

from test_deck_lists import add_line, change_line, detail, remove_line
from test_decks import create
from test_holdings import add, call, fixture
from test_moves import commit, edition_like, leaf, selected, stage, start
from test_multi_source_moves import begin, item


def deck_list(owner, deck):
    """The Deck List's revision and its lines as {edition_id: (quantity, in_deck)}."""
    body = detail(owner, deck)['deck_list']
    return body['revision'], {line['edition_id']: (line['quantity'], line['in_deck']) for line in body['lines']}


def held(owner, location):
    return {row['edition_id']: row['quantity'] for row in call('GET', f'/api/holdings/{location}', owner).json()['holdings']}


def staged(owner, source, items):
    """A Move manifest from ``source`` with each (Edition, copies) pair staged at its current Holding version."""
    versions = {row['edition_id']: row['version'] for row in call('GET', f'/api/holdings/{source}', owner).json()['holdings']}
    manifest = start(owner, source)
    response = stage(owner, manifest, [selected(edition, amount, versions[edition]) for edition, amount in items])
    assert response.status_code == 200, response.text
    return manifest


def move(owner, source, destination, items):
    response = commit(owner, staged(owner, source, items), destination)
    assert response.status_code == 200, response.text


def remove(owner, source, items):
    response = call('POST', f'/api/moves/manifests/{staged(owner, source, items)}/remove', owner,
                    {'idempotency_key': str(uuid4())})
    assert response.status_code == 200, response.text


def staged_multi(owner, items):
    """A sourceless Move manifest holding each (source, Edition, copies) triple at its current Holding version."""
    versions = {(location, row['edition_id']): row['version'] for location in {source for source, _, _ in items}
                for row in call('GET', f'/api/holdings/{location}', owner).json()['holdings']}
    manifest = begin(owner)['id']
    response = stage(owner, manifest, [item(source, edition, amount, versions[(source, edition)])
                                       for source, edition, amount in items])
    assert response.status_code == 200, response.text
    return manifest


def move_multi(owner, destination, items):
    response = commit(owner, staged_multi(owner, items), destination)
    assert response.status_code == 200, response.text


def remove_multi(owner, items):
    response = call('POST', f'/api/moves/manifests/{staged_multi(owner, items)}/remove', owner,
                    {'idempotency_key': str(uuid4())})
    assert response.status_code == 200, response.text


def newest_undo(owner):
    return call('GET', '/api/moves/undo', owner).json()[0]['id']


def undo(owner, undo_id, key=None):
    response = call('POST', f'/api/moves/undo/{undo_id}', owner, {'idempotency_key': str(key or uuid4())})
    assert response.status_code == 200, response.text
    return response


def test_a_move_into_a_deck_lists_the_editions_it_does_not_list_yet():
    owner, other, binder, other_leaf, first, generation = fixture()
    second = edition_like(first, generation)
    deck = create(owner).json()['location']['id']
    theirs = create(other).json()['location']['id']
    assert add(owner, binder, first, '5').status_code == 200
    assert add(owner, binder, second, '2').status_code == 200
    move(owner, binder, deck, [(first, 3), (second, 2)])
    assert deck_list(owner, deck) == (2, {first: ('3', '3'), second: ('2', '2')})
    # Another owner's copies arriving in their own Deck reach only their Deck List.
    assert add(other, other_leaf, first, '1').status_code == 200
    move(other, other_leaf, theirs, [(first, 1)])
    assert deck_list(other, theirs) == (2, {first: ('1', '1')})
    # A Move between ordinary Storage Leaves changes no Deck List.
    move(owner, binder, leaf(owner, 'Shelf'), [(first, 2)])
    assert deck_list(owner, deck) == (2, {first: ('3', '3'), second: ('2', '2')})


def test_a_move_into_a_deck_raises_a_line_only_for_copies_it_does_not_cover():
    owner, _, binder, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    assert add(owner, binder, edition, '7').status_code == 200
    assert add_line(owner, deck, edition, '4', 1).status_code == 200
    # Filling a line, as a Pick List does, leaves the Deck List and its revision alone.
    move(owner, binder, deck, [(edition, 3)])
    assert deck_list(owner, deck) == (2, {edition: ('4', '3')})
    # Copies beyond the line raise it to cover them.
    move(owner, binder, deck, [(edition, 2)])
    assert deck_list(owner, deck) == (3, {edition: ('5', '5')})
    # Cutting the line never moves cards; the cut copies stay surplus and only the arriving copy is covered.
    contents = call('GET', f'/api/decks/{deck}/contents', owner).json()
    assert change_line(owner, deck, edition, '2', 3).status_code == 200
    assert call('GET', f'/api/decks/{deck}/contents', owner).json() == contents
    move(owner, binder, deck, [(edition, 1)])
    assert deck_list(owner, deck) == (5, {edition: ('3', '3')})
    # Once the line is removed, arriving copies start a new line for themselves alone.
    assert remove_line(owner, deck, edition, 5).status_code == 200
    move(owner, binder, deck, [(edition, 1)])
    assert deck_list(owner, deck) == (7, {edition: ('1', '1')})
    assert held(owner, deck) == {edition: '7'}


def test_adding_copies_straight_into_a_deck_covers_them_once_per_command():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    key = uuid4()
    first = add(owner, deck, edition, '2', key)
    assert first.status_code == 200, first.text
    assert deck_list(owner, deck) == (2, {edition: ('2', '2')})
    # A replayed Add returns its stored result and raises nothing again.
    assert add(owner, deck, edition, '2', key).json() == first.json()
    assert deck_list(owner, deck) == (2, {edition: ('2', '2')})
    assert add(owner, deck, edition, '3').status_code == 200
    assert deck_list(owner, deck) == (3, {edition: ('5', '5')})


def test_moves_out_and_removals_leave_the_deck_list_unchanged():
    owner, _, binder, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    assert add(owner, deck, edition, '4').status_code == 200
    assert deck_list(owner, deck) == (2, {edition: ('4', '4')})
    move(owner, deck, binder, [(edition, 3)])
    assert deck_list(owner, deck) == (2, {edition: ('4', '1')})
    remove(owner, deck, [(edition, 1)])
    assert held(owner, deck) == {}
    assert deck_list(owner, deck) == (2, {edition: ('4', '0')})


def test_undoing_moves_and_removals_never_shrinks_the_deck_list():
    owner, _, binder, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    assert add(owner, binder, edition, '5').status_code == 200
    move(owner, binder, deck, [(edition, 3)])
    assert deck_list(owner, deck) == (2, {edition: ('3', '3')})
    # Undoing the Move takes the copies back out of the Deck; the line stays.
    undo(owner, newest_undo(owner))
    assert held(owner, deck) == {} and held(owner, binder) == {edition: '5'}
    assert deck_list(owner, deck) == (2, {edition: ('3', '0')})
    # Undoing a Move out of the Deck returns copies the line still covers.
    move(owner, binder, deck, [(edition, 3)])
    move(owner, deck, binder, [(edition, 2)])
    undo(owner, newest_undo(owner))
    assert held(owner, deck) == {edition: '3'}
    assert deck_list(owner, deck) == (2, {edition: ('3', '3')})
    # Undoing a Removal from the Deck does the same.
    remove(owner, deck, [(edition, 3)])
    assert deck_list(owner, deck) == (2, {edition: ('3', '0')})
    undo(owner, newest_undo(owner))
    assert held(owner, deck) == {edition: '3'}
    assert deck_list(owner, deck) == (2, {edition: ('3', '3')})


def test_multi_source_move_and_undo_raise_only_the_cut_line_once():
    owner, _, binder, _, e, generation = fixture()
    f = edition_like(e, generation)
    a, b = create(owner, 'Deck A').json()['location']['id'], create(owner, 'Deck B').json()['location']['id']
    assert add(owner, a, e, '4').status_code == 200 and add(owner, a, f, '2').status_code == 200
    assert add(owner, b, e, '3').status_code == 200
    # A and B each list what they hold; one Move takes E from both and F from A, and moves out never shrink a list.
    assert (deck_list(owner, a), deck_list(owner, b)) == ((3, {e: ('4', '4'), f: ('2', '2')}), (2, {e: ('3', '3')}))
    move_multi(owner, binder, [(a, e, 3), (b, e, 3), (a, f, 2)])
    assert held(owner, binder) == {e: '6', f: '2'} and held(owner, a) == {e: '1'} and held(owner, b) == {}
    # Lines and revisions stay; only the copies in the Decks fall.
    assert deck_list(owner, a) == (3, {e: ('4', '1'), f: ('2', '0')})
    assert deck_list(owner, b) == (2, {e: ('3', '0')})
    # Cut A's E line below the 3 copies the Undo returns; B's line stays covering its copies.
    assert change_line(owner, a, e, '1', 3).status_code == 200
    assert deck_list(owner, a) == (4, {e: ('1', '1'), f: ('2', '0')})
    undo(owner, newest_undo(owner))
    assert held(owner, a) == {e: '4', f: '2'} and held(owner, b) == {e: '3'} and held(owner, binder) == {}
    # A's E line is raised once to cover the 4 copies it holds; F's line already covers its 2; B is untouched.
    assert deck_list(owner, a) == (5, {e: ('4', '4'), f: ('2', '2')})
    assert deck_list(owner, b) == (2, {e: ('3', '3')})


def test_multi_source_move_into_a_deck_covers_arrivals_and_its_undo_never_shrinks_the_list():
    owner, _, binder, _, e, generation = fixture()
    f = edition_like(e, generation)
    a, c = create(owner, 'Deck A').json()['location']['id'], create(owner, 'Deck C').json()['location']['id']
    assert add(owner, binder, e, '3').status_code == 200
    assert add(owner, a, e, '2').status_code == 200 and add(owner, a, f, '1').status_code == 200
    assert deck_list(owner, c) == (1, {})
    move_multi(owner, c, [(binder, e, 3), (a, e, 2), (a, f, 1)])
    assert held(owner, c) == {e: '5', f: '1'} and held(owner, binder) == {} and held(owner, a) == {}
    after_move = deck_list(owner, c)
    assert after_move[1] == {e: ('5', '5'), f: ('1', '1')}
    undo(owner, newest_undo(owner))
    assert held(owner, c) == {} and held(owner, binder) == {e: '3'} and held(owner, a) == {e: '2', f: '1'}
    # The arrivals' lines stay at their quantities; only the copies in Deck C are gone.
    assert deck_list(owner, c) == (after_move[0], {e: ('5', '0'), f: ('1', '0')})
    assert deck_list(owner, a) == (3, {e: ('2', '2'), f: ('1', '1')})


def test_multi_source_removal_and_its_undo_leave_every_deck_list_unchanged():
    owner, _, _, _, e, generation = fixture()
    f = edition_like(e, generation)
    a, b = create(owner, 'Deck A').json()['location']['id'], create(owner, 'Deck B').json()['location']['id']
    assert add(owner, a, e, '3').status_code == 200 and add(owner, a, f, '1').status_code == 200
    assert add(owner, b, e, '2').status_code == 200
    a_lines, b_lines = (3, {e: ('3', '3'), f: ('1', '1')}), (2, {e: ('2', '2')})
    assert (deck_list(owner, a), deck_list(owner, b)) == (a_lines, b_lines)
    remove_multi(owner, [(a, e, 3), (b, e, 2)])
    assert held(owner, a) == {f: '1'} and held(owner, b) == {}
    # Like the single-source Removal above: lines stay, only in_deck falls, and the revision does not advance.
    assert deck_list(owner, a) == (3, {e: ('3', '0'), f: ('1', '1')})
    assert deck_list(owner, b) == (2, {e: ('2', '0')})
    undo(owner, newest_undo(owner))
    assert held(owner, a) == {e: '3', f: '1'} and held(owner, b) == {e: '2'}
    # The returned copies are already covered, so (as with the single-source Undo above) no revision advances.
    assert (deck_list(owner, a), deck_list(owner, b)) == (a_lines, b_lines)


def test_reassigning_an_edition_inside_a_deck_covers_the_replacement():
    owner, _, _, _, edition, generation = fixture()
    deck = create(owner).json()['location']['id']
    replacement = edition_like(edition, generation)
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute("""INSERT INTO catalog_edition_replacement(edition_id,replacement_edition_id,reviewer_id,evidence_url,reason)
          VALUES (%s,%s,%s,'https://example.org/finish','Finish corrected')""", (edition, replacement, owner))
    assert add(owner, deck, edition, '4').status_code == 200
    version = call('GET', f'/api/holdings/{deck}', owner).json()['holdings'][0]['version']
    body = {'location_id': deck, 'edition_id': edition, 'replacement_edition_id': replacement, 'quantity': '3',
            'expected_version': version, 'idempotency_key': str(uuid4())}
    first = call('POST', '/api/holdings/reassign', owner, body)
    assert first.status_code == 200, first.text
    # The old Edition's line stays, like any line whose copies leave the Deck.
    assert deck_list(owner, deck) == (3, {edition: ('4', '1'), replacement: ('3', '3')})
    assert call('POST', '/api/holdings/reassign', owner, body).json() == first.json()
    assert deck_list(owner, deck) == (3, {edition: ('4', '1'), replacement: ('3', '3')})


def test_replayed_and_concurrent_commands_raise_lines_once():
    owner, _, binder, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    assert add(owner, binder, edition, '6').status_code == 200
    manifest = staged(owner, binder, [(edition, 2)])
    key = uuid4()
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: commit(owner, manifest, deck, key), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    assert commit(owner, manifest, deck, key).json() == responses[0].json()
    assert held(owner, deck) == {edition: '2'}
    assert deck_list(owner, deck) == (2, {edition: ('2', '2')})
    # An undo that restores copies the list no longer covers raises the line once, however often it is retried.
    remove(owner, deck, [(edition, 2)])
    assert remove_line(owner, deck, edition, 2).status_code == 200
    entry, undo_key = newest_undo(owner), uuid4()
    first = undo(owner, entry, undo_key)
    assert undo(owner, entry, undo_key).json() == first.json()
    assert held(owner, deck) == {edition: '2'}
    assert deck_list(owner, deck) == (4, {edition: ('2', '2')})


def test_holdings_written_without_the_current_routes_still_extend_the_deck_list():
    """An older application serving during a release or after a rollback writes Holdings without Deck Lists."""
    owner, _, _, _, edition, generation = fixture()
    deck = create(owner).json()['location']['id']
    second = edition_like(edition, generation)
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,2,1),(%s,%s,%s,1,1)',
                     (owner, deck, edition, owner, deck, second))
    assert deck_list(owner, deck) == (2, {edition: ('2', '2'), second: ('1', '1')})
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('UPDATE holding SET quantity=quantity+3,version=version+1 WHERE owner_id=%s AND location_id=%s AND edition_id=%s',
                     (owner, deck, edition))
    assert deck_list(owner, deck) == (3, {edition: ('5', '5'), second: ('1', '1')})


@pytest.mark.timing
@pytest.mark.serial(reason='wall-clock: bounds the Deck List trigger statements at 25,000 Holdings')
@pytest.mark.slow(reason='capacity: 25,000 Holdings in one Deck')
def test_25000_holdings_extend_the_deck_list_after_plans_cached_from_empty_statements():
    """The trigger's dangerous path (ticket 05 review). PL/pgSQL keeps a static trigger statement's plan from its first
    call, so the calls below are empty; then one statement inserts 25,000 Holdings into a Deck and another raises every
    one of them. Joining the transition tables took 31 s here, against 0.96 s for pairing rows by aggregation (migration
    031); a raise reusing a nested loop over deck_list_line planned for one row took 34 s on CI, against under 1 s with
    each firing planned for its rows (migration 039). The bound catches a return of either."""
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    upsert = """INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
      SELECT %s,%s,e.id,1+e.n%%3,1 FROM unnest(%s::uuid[]) WITH ORDINALITY AS e(id,n)
      ON CONFLICT (owner_id,location_id,edition_id)
      DO UPDATE SET quantity=holding.quantity+EXCLUDED.quantity,version=holding.version+1"""
    with psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as conn:
        printing = conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s', (edition,)).fetchone()[0]
        ids = [row[0] for row in conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          SELECT %s,'bulk-' || %s || '-' || n,'{}'::jsonb FROM generate_series(1,25000) AS n
          RETURNING id""", (printing, str(uuid4()))).fetchall()]
        # An empty INSERT ... ON CONFLICT DO UPDATE fires both statement triggers (holding_deck_list_insert and
        # holding_deck_list_update). A trigger statement takes no parameters, so PL/pgSQL would keep the plan of its
        # first call; with hash, merge and index access off, that plan would be a nested loop of sequential scans.
        # Changing these settings does not replan, so only an autovacuum ANALYZE between here and the timed statements
        # could replace a kept plan, which would let a regression pass, never fail a sound trigger.
        planner = ('enable_hashjoin', 'enable_mergejoin', 'enable_indexscan', 'enable_bitmapscan')
        for setting in planner:
            conn.execute(f'SET {setting} = off')
        conn.execute(upsert, (owner, deck, []))
        for setting in planner:
            conn.execute(f'RESET {setting}')
        started = time.monotonic()
        conn.execute(upsert, (owner, deck, ids))
        inserted = time.monotonic() - started
        started = time.monotonic()
        conn.execute('UPDATE holding SET quantity=quantity+1,version=version+1 WHERE owner_id=%s AND location_id=%s',
                     (owner, deck))
        raised = time.monotonic() - started
    line = f'25,000 Holdings: insert {inserted:.2f} s, raise {raised:.2f} s (bound 10 s each)'
    print(f'[deck-list-trigger] {line}')
    if os.environ.get('TEST_LOG_DIR'):
        with open(os.path.join(os.environ['TEST_LOG_DIR'], 'deck-list-trigger-metrics.log'), 'a') as log:
            log.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {line}\n")
    within_budget(inserted, 10, 'Deck List insert', unit='s')
    within_budget(raised, 10, 'Deck List raise', unit='s')
    revision, lines = deck_list(owner, deck)
    assert revision == 3 and len(lines) == 25000
    # n = 12345 arrived with 1 + 12345 % 3 = 1 copy and was raised to 2: its line covers both.
    assert lines[str(ids[12344])] == ('2', '2')
    assert lines[str(ids[0])] == ('3', '3')
