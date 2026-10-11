"""Deleting a Deck returns its cards to Unsorted and discards its Deck List; its Published Deck stays live and is managed
by its public token (Deck Lists 10, issue #91). Exercised through signed HTTP against PostgreSQL and anonymous reads."""
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from test_deck_list_moves import held, move
from test_deck_lists import add_line, code, detail
from test_decks import create
from test_holdings import add, call, client, fixture
from test_location_tree import tree
from test_moves import edition_like, leaf, selected, stage, start
from test_publications import command, list_cards, public_objects, stored_decks  # noqa: F401  (public_objects: autouse)

MAX = 2**63 - 1


def delete(owner, deck, name='Physical Deck', version=1, key=None):
    return call('DELETE', f'/api/decks/{deck}', owner,
                {'name': name, 'version': version, 'idempotency_key': str(key or uuid4())})


def revision(owner):
    return call('GET', '/api/location-tree', owner).json()['owner_revision']


def versions(owner, location):
    return {row['edition_id']: row['version'] for row in call('GET', f'/api/holdings/{location}', owner).json()['holdings']}


def owned(owner):
    response = call('GET', '/api/publications', owner)
    assert response.status_code == 200, response.text
    return response.json()['publications']


def by_token(owner, token, method='DELETE', visibility=None, key=None):
    body = {'idempotency_key': str(key or uuid4())}
    if visibility:
        body['visibility'] = visibility
    path = f'/api/publications/{token}' + ('/visibility' if visibility else '')
    return call(method if not visibility else 'PATCH', path, owner, body)


# Deletion into Unsorted


def test_deleting_a_deck_moves_its_holdings_into_unsorted_and_discards_its_deck_list():
    owner, other, unsorted, _, first, generation = fixture()
    second, planned = edition_like(first, generation), edition_like(first, generation)
    deck = create(owner).json()['location']['id']
    keeper = create(owner, 'Keeper').json()['location']['id']
    assert add(owner, unsorted, first, '5').status_code == 200
    assert add(owner, deck, first, '3').status_code == 200
    assert add(owner, deck, second, '2').status_code == 200
    listed = detail(owner, deck)['deck_list']['revision']
    assert add_line(owner, deck, planned, '4', listed).status_code == 200
    keeper_list = add_line(owner, keeper, first, '1', 1).json()['deck_list']
    before = revision(owner)
    key = uuid4()

    response = delete(owner, deck, key=key)

    assert response.status_code == 200, response.text
    assert response.json() == {'deleted_id': deck, 'unsorted_id': unsorted, 'edition_count': 2, 'copy_count': '5',
                               'owner_revision': before + 1}
    # Copies merge into the Holding Unsorted already had; each moved Holding takes the new inventory revision.
    assert held(owner, unsorted) == {first: '8', second: '2'}
    assert versions(owner, unsorted) == {first: before + 1, second: before + 1}
    assert revision(owner) == before + 1
    # The Deck and its Deck List are gone; the planned line went with them and never reached the Collection.
    assert code(call('GET', f'/api/decks/{deck}', owner)) == 'DECK_NOT_FOUND'
    assert call('GET', f'/api/holdings/{deck}', owner).status_code == 404
    assert code(add_line(owner, deck, first, '1', listed + 1)) == 'DECK_NOT_FOUND'
    assert [d['id'] for d in call('GET', '/api/decks', owner).json()['decks']] == [keeper]
    assert all(node['id'] != deck for node in tree(owner))
    assert planned not in held(owner, unsorted)
    # Unsorted is not a Deck, so no Deck List changed.
    assert detail(owner, keeper)['deck_list'] == keeper_list
    # Idempotent: a replay answers the same and changes nothing; the key is bound to its request.
    assert delete(owner, deck, key=key).json() == response.json()
    assert revision(owner) == before + 1
    assert code(delete(owner, deck, name='Other', key=key)) == 'IDEMPOTENCY_KEY_REUSED'
    assert code(delete(owner, deck)) == 'DECK_NOT_FOUND'
    assert call('GET', f'/api/holdings/{unsorted}', other).status_code == 404


def test_deleting_a_deck_is_confirmed_by_name_and_version_and_other_location_rules_are_unchanged():
    owner, other, unsorted, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    assert add(owner, deck, edition, '2').status_code == 200
    assert add(owner, unsorted, edition, '1').status_code == 200
    before = revision(owner)
    assert code(delete(owner, deck, name='Wrong')) == 'LOCATION_NAME_CONFIRMATION_MISMATCH'
    assert code(delete(owner, deck, version=2)) == 'STALE_LOCATION'
    assert delete(owner, deck, name='   ').status_code == 422
    assert code(delete(other, deck)) == 'DECK_NOT_FOUND'
    assert code(delete(owner, unsorted, name='Unsorted')) == 'DECK_NOT_FOUND'
    assert code(delete(owner, str(uuid4()))) == 'DECK_NOT_FOUND'
    # The Location tree route still refuses Decks and non-empty Locations.
    location_delete = {'name': 'Physical Deck', 'version': 1, 'idempotency_key': str(uuid4())}
    assert code(call('DELETE', f'/api/location-tree/{deck}', owner, location_delete)) == 'DECK_REQUIRES_DECK_COMMAND'
    assert code(call('DELETE', f'/api/location-tree/{unsorted}', owner,
                     {'name': 'Unsorted', 'version': 1, 'idempotency_key': str(uuid4())})) == 'LOCATION_NOT_EMPTY'
    assert held(owner, deck) == {edition: '2'} and revision(owner) == before
    # A Deck without cards deletes without touching Unsorted.
    empty = create(owner, 'Empty').json()['location']['id']
    before = revision(owner)
    response = delete(owner, empty, name='Empty')
    assert response.status_code == 200, response.text
    assert response.json() == {'deleted_id': empty, 'unsorted_id': None, 'edition_count': 0, 'copy_count': '0',
                               'owner_revision': before + 1}
    assert held(owner, unsorted) == {edition: '1'}


def test_a_missing_unsorted_is_recreated_and_an_unsorted_that_cannot_hold_cards_refuses():
    owner, _, unsorted, _, edition, _ = fixture()
    removed = call('DELETE', f'/api/location-tree/{unsorted}', owner,
                   {'name': 'Unsorted', 'version': 1, 'idempotency_key': str(uuid4())})
    assert removed.status_code == 200, removed.text
    deck = create(owner).json()['location']['id']
    assert add(owner, deck, edition, '2').status_code == 200
    response = delete(owner, deck)
    assert response.status_code == 200, response.text
    recreated = response.json()['unsorted_id']
    assert recreated not in (None, unsorted)
    root = next(node for node in tree(owner) if node['id'] == recreated)
    assert (root['name'], root['kind'], root['parent_id']) == ('Unsorted', 'storage_leaf', None)
    assert held(owner, recreated) == {edition: '2'}
    # Giving Unsorted a child makes it an Organizational Location, which cannot hold cards.
    child = call('POST', '/api/location-tree', owner, {'name': 'Pages', 'parent_id': recreated, 'parent_version': root['version'],
                                                       'conversion': 'move_holdings_to_child', 'idempotency_key': str(uuid4())})
    assert child.status_code == 201, child.text
    stocked = create(owner, 'Stocked').json()['location']['id']
    assert add(owner, stocked, edition, '1').status_code == 200
    before = revision(owner)
    assert code(delete(owner, stocked, name='Stocked')) == 'UNSORTED_UNAVAILABLE'
    assert held(owner, stocked) == {edition: '1'} and revision(owner) == before
    empty = create(owner, 'Empty').json()['location']['id']
    assert delete(owner, empty, name='Empty').status_code == 200


def test_a_deck_named_unsorted_gives_the_name_up_and_another_one_refuses_until_then():
    owner, _, unsorted, _, edition, _ = fixture()
    assert call('DELETE', f'/api/location-tree/{unsorted}', owner,
                {'name': 'Unsorted', 'version': 1, 'idempotency_key': str(uuid4())}).status_code == 200
    named = create(owner, 'Unsorted').json()['location']['id']
    other = create(owner, 'Other').json()['location']['id']
    assert add(owner, named, edition, '2').status_code == 200
    assert add(owner, other, edition, '1').status_code == 200
    # The root name Unsorted belongs to a Deck, which cannot take another Deck's cards.
    assert code(delete(owner, other, name='Other')) == 'UNSORTED_UNAVAILABLE'
    assert held(owner, other) == {edition: '1'}
    # Deleting that Deck frees the name for a new Unsorted, which receives its cards.
    response = delete(owner, named, name='Unsorted')
    assert response.status_code == 200, response.text
    recreated = response.json()['unsorted_id']
    assert recreated not in (None, named)
    root = next(node for node in tree(owner) if node['id'] == recreated)
    assert (root['name'], root['kind'], root['parent_id']) == ('Unsorted', 'storage_leaf', None)
    assert held(owner, recreated) == {edition: '2'}
    assert delete(owner, other, name='Other').json()['unsorted_id'] == recreated
    assert held(owner, recreated) == {edition: '3'}


def test_a_spill_that_would_overflow_unsorted_changes_nothing():
    owner, _, unsorted, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    assert add(owner, unsorted, edition, str(MAX - 1)).status_code == 200
    assert add(owner, deck, edition, '2').status_code == 200
    before = revision(owner)
    assert code(delete(owner, deck)) == 'QUANTITY_OVERFLOW'
    assert held(owner, unsorted) == {edition: str(MAX - 1)} and held(owner, deck) == {edition: '2'}
    assert revision(owner) == before


def test_the_spill_is_not_undoable_and_earlier_undo_entries_naming_the_deck_are_incompatible():
    owner, _, unsorted, _, edition, _ = fixture()
    binder = leaf(owner)
    deck = create(owner).json()['location']['id']
    assert add(owner, unsorted, edition, '5').status_code == 200
    move(owner, unsorted, deck, [(edition, 2)])
    entries = call('GET', '/api/moves/undo', owner).json()
    staged_from_deck = start(owner, deck)
    assert delete(owner, deck).status_code == 200
    assert held(owner, unsorted) == {edition: '5'}
    # No undo entry was recorded for the deletion, and the Move into the deleted Deck can no longer be undone.
    assert [entry['id'] for entry in call('GET', '/api/moves/undo', owner).json()] == [entries[0]['id']]
    undo = call('POST', f"/api/moves/undo/{entries[0]['id']}", owner, {'idempotency_key': str(uuid4())})
    assert code(undo) == 'UNDO_INCOMPATIBLE'
    assert held(owner, unsorted) == {edition: '5'}
    # A Move selection staged from the Deck went with it.
    assert stage(owner, staged_from_deck, [selected(edition, 1, 1)]).status_code == 404
    move(owner, unsorted, binder, [(edition, 5)])
    assert held(owner, binder) == {edition: '5'}


def test_concurrent_deletes_of_one_deck_move_its_cards_once():
    owner, _, unsorted, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    assert add(owner, deck, edition, '3').status_code == 200
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: delete(owner, deck), range(2)))
    assert sorted(r.status_code for r in results) == [200, 404]
    assert held(owner, unsorted) == {edition: '3'}


# Published Decks outlive their Deck


def test_a_published_deck_stays_live_after_its_deck_is_deleted_and_is_managed_by_token():
    owner, other, unsorted, _, edition, _ = fixture()
    deck = create(owner, 'Private deck name').json()['location']['id']
    list_cards(owner, deck, {edition: 4})
    token = command(owner, deck).json()['token']
    path = f'/api/public/decks/{token}'
    snapshot = client.get(path).json()
    assert owned(owner) == [{'token': token, 'version': 1, 'title': 'Public deck', 'visibility': 'unlisted',
                             'deck_id': deck, 'projection_pending': False}]
    assert owned(other) == []

    assert delete(owner, deck, name='Private deck name').status_code == 200

    assert client.get(path).json() == snapshot
    assert owned(owner) == [{'token': token, 'version': 1, 'title': 'Public deck', 'visibility': 'unlisted',
                             'deck_id': None, 'projection_pending': False}]
    # Without its Deck there is no Deck List to snapshot: it can't be republished, and the Deck routes are gone.
    assert code(command(owner, deck, 'PUT')) == 'DECK_NOT_FOUND'
    assert code(call('GET', f'/api/decks/{deck}/publication', owner)) == 'DECK_NOT_FOUND'
    assert code(command(owner, deck, 'DELETE')) == 'DECK_NOT_FOUND'
    assert call('PUT', f'/api/publications/{token}', owner, {'title': 'Again', 'idempotency_key': str(uuid4())}).status_code == 405
    # Visibility changes by token keep the frozen snapshot.
    key = uuid4()
    listed = by_token(owner, token, visibility='listed', key=key)
    assert listed.status_code == 200, listed.text
    assert listed.json() == {'token': token, 'version': 1, 'revoked': False}
    assert by_token(owner, token, visibility='listed', key=key).json() == listed.json()
    assert code(by_token(owner, token, visibility='unlisted', key=key)) == 'IDEMPOTENCY_KEY_REUSED'
    assert stored_decks()['decks'][token]['visibility'] == 'listed'
    public = client.get(path)
    assert public.json() == snapshot and public.headers['x-robots-tag'] == 'index, follow'
    assert owned(owner)[0]['visibility'] == 'listed'
    # Another owner's, an unknown and a malformed token are the same 404.
    for caller, target in ((other, token), (owner, 'y' * 32), (owner, 'short')):
        assert code(by_token(caller, target)) == 'PUBLICATION_NOT_FOUND'
        assert code(by_token(caller, target, visibility='unlisted')) == 'PUBLICATION_NOT_FOUND'
    assert client.get(path).status_code == 200
    # Revoking by token takes it down for good.
    revoke_key = uuid4()
    revoked = by_token(owner, token, key=revoke_key)
    assert revoked.status_code == 200, revoked.text
    assert revoked.json() == {'token': token, 'version': 1, 'revoked': True}
    assert client.get(path).status_code == 404 and token not in stored_decks()['decks']
    assert owned(owner) == []
    assert by_token(owner, token, key=revoke_key).json() == revoked.json()
    assert code(by_token(owner, token)) == 'PUBLICATION_REVOKED'
    assert code(by_token(owner, token, visibility='listed')) == 'PUBLICATION_REVOKED'
    assert held(owner, unsorted) == {}


def test_token_routes_manage_a_publication_whose_deck_still_exists():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    list_cards(owner, deck, {edition: 2})
    token = command(owner, deck).json()['token']
    assert by_token(owner, token, visibility='listed').status_code == 200
    assert call('GET', f'/api/decks/{deck}/publication', owner).json()['visibility'] == 'listed'
    assert by_token(owner, token).status_code == 200
    assert call('GET', f'/api/decks/{deck}/publication', owner).json()['token'] is None
    assert client.get(f'/api/public/decks/{token}').status_code == 404
    again = command(owner, deck)
    assert again.status_code == 200 and again.json()['token'] != token


def test_one_active_publication_per_existing_deck_while_unlinked_ones_coexist():
    owner, _, _, _, edition, _ = fixture()
    tokens = []
    for name in ('First', 'Second'):
        deck = create(owner, name).json()['location']['id']
        list_cards(owner, deck, {edition: 1})
        tokens.append(command(owner, deck).json()['token'])
        assert delete(owner, deck, name=name).status_code == 200
    assert [(row['token'], row['deck_id']) for row in owned(owner)] == [(tokens[0], None), (tokens[1], None)]
    assert all(client.get(f'/api/public/decks/{token}').status_code == 200 for token in tokens)
    current = create(owner, 'Current').json()['location']['id']
    assert command(owner, current).status_code == 200
    assert code(command(owner, current)) == 'DECK_ALREADY_PUBLISHED'
    assert len(owned(owner)) == 3


def test_cross_owner_token_commands_are_not_found_even_during_public_storage_outage():
    owner, other, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    list_cards(owner, deck, {edition: 1})
    token = command(owner, deck).json()['token']
    gone = create(owner, 'Revoked').json()['location']['id']
    revoked = command(owner, gone).json()['token']
    assert by_token(owner, revoked).status_code == 200
    (Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json').unlink()
    assert code(by_token(other, token)) == 'PUBLICATION_NOT_FOUND'
    assert code(by_token(other, token, visibility='listed')) == 'PUBLICATION_NOT_FOUND'
    assert code(by_token(owner, token)) == 'PUBLICATION_UNAVAILABLE'
    # The store is opened before the publication's state is read, so an outage answers 503 before PUBLICATION_REVOKED.
    assert code(by_token(owner, revoked)) == 'PUBLICATION_UNAVAILABLE'


def test_lost_publication_responses_replay_after_the_deck_is_deleted():
    owner, _, _, _, edition, _ = fixture()
    published, revoked = create(owner, 'Published').json()['location']['id'], create(owner, 'Revoked').json()['location']['id']
    list_cards(owner, published, {edition: 1})
    list_cards(owner, revoked, {edition: 1})
    publish_key, revoke_key = uuid4(), uuid4()
    first = command(owner, published, key=publish_key)
    assert first.status_code == 200, first.text
    assert command(owner, revoked).status_code == 200
    revoke = command(owner, revoked, 'DELETE', key=revoke_key)
    assert revoke.status_code == 200, revoke.text
    assert delete(owner, published, name='Published').status_code == 200
    assert delete(owner, revoked, name='Revoked').status_code == 200
    # A retry whose first response was lost answers that response, not DECK_NOT_FOUND.
    assert command(owner, published, key=publish_key).json() == first.json()
    assert command(owner, revoked, 'DELETE', key=revoke_key).json() == revoke.json()
    assert code(command(owner, published, title='Other title', key=publish_key)) == 'IDEMPOTENCY_KEY_REUSED'
    assert code(command(owner, published)) == 'DECK_NOT_FOUND'
    assert [row['token'] for row in owned(owner)] == [first.json()['token']]


def test_publishing_and_republishing_racing_a_deck_deletion_never_deadlock():
    owner, _, _, _, edition, _ = fixture()
    for number, action in enumerate(('POST', 'PUT') * 3):
        name = f'Racing {number}'
        deck = create(owner, name).json()['location']['id']
        list_cards(owner, deck, {edition: 1})
        if action == 'PUT':
            assert command(owner, deck).status_code == 200
        with ThreadPoolExecutor(max_workers=2) as executor:
            published = executor.submit(command, owner, deck, action)
            deleted = executor.submit(delete, owner, deck, name)
            published, deleted = published.result(), deleted.result()
        assert deleted.status_code == 200, deleted.text
        assert published.status_code in (200, 404), published.text
        if published.status_code == 200:
            token = published.json()['token']
            assert client.get(f'/api/public/decks/{token}').status_code == 200
            assert next(row for row in owned(owner) if row['token'] == token)['deck_id'] is None


@pytest.mark.parametrize('scope', ['deck', 'token'])
@pytest.mark.parametrize('action', ['revoke', 'visibility'])
def test_revoking_or_changing_visibility_while_the_deck_is_deleted_never_deadlocks(scope, action):
    """An injected trigger holds the command just after it changed its publication row, which it keeps locked until it
    commits, and the deletion starts only then; the deletion needs that row to unlink it. The command took the owner lock
    first, so the deletion waits for it, rather than the command's own owner-referencing insert waiting for the deletion."""
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    list_cards(owner, deck, {edition: 1})
    token = command(owner, deck).json()['token']
    suffix = uuid4().hex
    function_name, trigger_name = f'hold_publication_{suffix}', f'hold_publication_trigger_{suffix}'
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute(f"CREATE FUNCTION {function_name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NULL; END $$")
        # Only a revoke or a visibility change; the deletion's own unlinking update must not wait.
        conn.execute(f"""CREATE TRIGGER {trigger_name} AFTER UPDATE ON deck_publication FOR EACH ROW
          WHEN (OLD.revoked IS DISTINCT FROM NEW.revoked OR OLD.visibility IS DISTINCT FROM NEW.visibility)
          EXECUTE FUNCTION {function_name}()""")
    visibility = 'listed' if action == 'visibility' else None
    if scope == 'deck':
        manage = ((lambda: call('PATCH', f'/api/decks/{deck}/publication/visibility', owner,
                                {'visibility': 'listed', 'idempotency_key': str(uuid4())}))
                  if visibility else (lambda: command(owner, deck, 'DELETE')))
    else:
        manage = lambda: by_token(owner, token, visibility=visibility)  # noqa: E731
    try:
        with ThreadPoolExecutor(max_workers=2) as executor, \
                psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch:
            managed = executor.submit(manage)
            deadline = time.monotonic() + 10
            while not watch.execute("""SELECT 1 FROM pg_stat_activity
                WHERE datname=current_database() AND wait_event='PgSleep'""").fetchone():
                assert time.monotonic() < deadline and not managed.done(), 'the command never reached the trigger'
                time.sleep(0.01)
            deleted = executor.submit(delete, owner, deck)
            managed, deleted = managed.result(), deleted.result()
    finally:
        with psycopg.connect(os.environ['DATABASE_URL']) as conn:
            conn.execute(f'DROP TRIGGER {trigger_name} ON deck_publication')
            conn.execute(f'DROP FUNCTION {function_name}()')
    assert managed.status_code == 200, managed.text
    assert deleted.status_code == 200, deleted.text
    public = client.get(f'/api/public/decks/{token}')
    if action == 'revoke':
        assert public.status_code == 404 and owned(owner) == []
    else:
        assert public.status_code == 200 and public.headers['x-robots-tag'] == 'index, follow'
        assert [(row['token'], row['deck_id'], row['visibility']) for row in owned(owner)] == [(token, None, 'listed')]
