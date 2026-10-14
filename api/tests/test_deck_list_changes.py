"""The batch Deck List change command (app redesign #177, spec "Deck List contracts"), through signed HTTP.

``POST /api/decks/{id}/deck-list/changes`` takes ``revision``, ``idempotency_key`` and ``changes: [{edition_id,
quantity}]``, each quantity a line's new total with 0 removing the line. It applies every change atomically, advances
the revision once and answers the usual Deck List command result. The deck builder sends every add, remove and swap
through it, and its Undo is the inverse batch at the revision the first one answered.
"""
import json
import os
from uuid import uuid4

import psycopg

from app.main import connect
from test_deck_lists import DISPLAY_FIELDS, LINE_FIELDS, add_line, change_line, code, core, detail
from test_decks import create
from test_holdings import add, call, client, fixture
from test_moves import commit, edition_like, leaf, selected, stage, start


def changes_path(deck):
    return f'/api/decks/{deck}/deck-list/changes'


def change(owner, deck, changes, revision, key=None):
    return call('POST', changes_path(deck), owner, {
        'revision': revision, 'idempotency_key': str(key or uuid4()),
        'changes': [{'edition_id': edition, 'quantity': quantity} for edition, quantity in changes]})


def quantities(deck_list):
    return {line['edition_id']: line['quantity'] for line in deck_list['lines']}


def retire(generation, edition):
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        conn.execute('UPDATE catalog_generation_edition SET active=false WHERE generation_id=%s AND edition_id=%s',
                     (generation, edition))


def test_a_batch_sets_every_line_at_once_and_advances_the_revision_once():
    owner, _, _, _, first, generation = fixture()
    second, absent = edition_like(first, generation), edition_like(first, generation)
    deck = create(owner).json()['location']['id']
    assert add_line(owner, deck, first, '2', 1).status_code == 200
    contents = call('GET', f'/api/decks/{deck}/contents', owner).json()

    # A raised line, a new line, and a 0 for an Edition the list doesn't have (which changes nothing), in one batch.
    batch = change(owner, deck, [(first, '4'), (second, '1'), (absent, '0')], 2)
    assert batch.status_code == 200, batch.text
    body = batch.json()
    assert (body['deck_id'], body['deck_list']['revision'], body['target_format']) == (deck, 3, 'standard')
    assert quantities(body['deck_list']) == {first: '4', second: '1'}
    # Every line carries its display data, the new one included, and the format result is for the new revision.
    assert all(set(line) == set(LINE_FIELDS) | DISPLAY_FIELDS for line in body['deck_list']['lines'])
    assert body['format_checks']['deck_list_revision'] == 3
    assert detail(owner, deck)['deck_list'] == body['deck_list']

    # A 0 removes a line, while another line changes in the same batch.
    removed = change(owner, deck, [(first, '0'), (second, '3')], 3)
    assert removed.status_code == 200, removed.text
    assert core(removed.json()['deck_list']) == {'revision': 4, 'lines': [
        {'edition_id': second, 'quantity': '3', 'in_deck': '0'}]}
    # A batch that changes nothing still advances the revision once.
    same = change(owner, deck, [(second, '3')], 4)
    assert same.status_code == 200 and same.json()['deck_list']['revision'] == 5

    # The Deck List is a plan: no Holding, no inventory revision and no inventory Undo record moved.
    assert call('GET', f'/api/decks/{deck}/contents', owner).json() == contents
    assert call('GET', '/api/moves/undo', owner).json() == []


def test_one_bad_change_rejects_the_whole_batch():
    owner, _, _, _, first, generation = fixture()
    second, retired = edition_like(first, generation), edition_like(first, generation)
    retire(generation, retired)
    deck = create(owner).json()['location']['id']
    assert add_line(owner, deck, first, '2', 1).status_code == 200
    before = detail(owner, deck)['deck_list']

    # A new line needs an available Edition: a retired or unknown one refuses the batch, the good change included.
    for missing in (retired, str(uuid4())):
        refused = change(owner, deck, [(first, '5'), (missing, '1')], 2)
        assert (refused.status_code, code(refused)) == (422, 'EDITION_UNAVAILABLE')
    for quantity in ('-1', 'x', '', '1.5', '٣', str(2**63)):
        refused = change(owner, deck, [(first, '5'), (second, quantity)], 2)
        assert (refused.status_code, code(refused)) == (422, 'INVALID_QUANTITY'), quantity
    duplicate = change(owner, deck, [(first, '5'), (first, '6')], 2)
    assert (duplicate.status_code, code(duplicate)) == (422, 'DUPLICATE_EDITION')
    empty = change(owner, deck, [], 2)
    assert (empty.status_code, code(empty)) == (422, 'NO_CHANGES')
    many = [(str(uuid4()), '1') for _ in range(201)]
    assert change(owner, deck, many, 2).status_code == 422
    assert detail(owner, deck)['deck_list'] == before

    # A line whose Edition was retired since can still be changed and removed.
    retire(generation, first)
    raised = change(owner, deck, [(first, '3')], 2)
    assert raised.status_code == 200, raised.text
    assert quantities(raised.json()['deck_list']) == {first: '3'}
    gone = change(owner, deck, [(first, '0')], 3)
    assert gone.status_code == 200 and gone.json()['deck_list']['lines'] == []


def test_a_batch_is_revision_checked_idempotent_and_owner_scoped():
    owner, other, _, _, first, generation = fixture()
    second = edition_like(first, generation)
    deck = create(owner).json()['location']['id']
    stale = change(owner, deck, [(first, '1')], 2)
    assert (stale.status_code, code(stale)) == (409, 'STALE_DECK_LIST')

    key = uuid4()
    applied = change(owner, deck, [(first, '2'), (second, '1')], 1, key)
    assert applied.status_code == 200, applied.text
    # A retry replays the stored answer, in any order of the changes, without advancing the revision again; it is
    # checked before the revision, which has moved on.
    assert change(owner, deck, [(first, '2'), (second, '1')], 1, key).json() == applied.json()
    assert change(owner, deck, [(second, '1'), (first, '2')], 1, key).json() == applied.json()
    assert detail(owner, deck)['deck_list']['revision'] == 2
    later = change(owner, deck, [(first, '3')], 2)
    assert later.status_code == 200
    assert change(owner, deck, [(first, '2'), (second, '1')], 1, key).json() == applied.json()
    reused = change(owner, deck, [(first, '9')], 1, key)
    assert (reused.status_code, code(reused)) == (409, 'IDEMPOTENCY_KEY_REUSED')

    # Only the owner's own Deck: another collector's view of it, a Storage Leaf and an unknown id are not found.
    for user, target in ((other, deck), (owner, leaf(owner)), (owner, str(uuid4()))):
        refused = change(user, target, [(first, '1')], 3)
        assert (refused.status_code, code(refused)) == (404, 'DECK_NOT_FOUND')
    body = {'revision': 3, 'idempotency_key': str(uuid4()), 'changes': [{'edition_id': first, 'quantity': '1'}]}
    assert client.post(changes_path(deck), json=body).status_code == 401
    assert quantities(detail(owner, deck)['deck_list']) == {first: '3', second: '1'}


def test_a_swap_and_its_inverse_restore_the_list_and_an_inverse_after_another_edit_is_stale():
    owner, _, _, _, first, generation = fixture()
    second = edition_like(first, generation)
    deck = create(owner).json()['location']['id']
    assert add_line(owner, deck, first, '2', 1).status_code == 200
    before = detail(owner, deck)['deck_list']

    # Swap one copy of the first Edition for the second (the same Card Identity): one batch.
    swap = change(owner, deck, [(first, '1'), (second, '1')], 2)
    assert swap.status_code == 200, swap.text
    assert quantities(swap.json()['deck_list']) == {first: '1', second: '1'}
    # Undo sends the inverse batch at the revision the swap answered: the list is back as it was, one revision on.
    undo = change(owner, deck, [(first, '2'), (second, '0')], swap.json()['deck_list']['revision'])
    assert undo.status_code == 200, undo.text
    assert core(undo.json()['deck_list'])['lines'] == core(before)['lines']
    assert undo.json()['deck_list']['revision'] == 4

    # After another edit, the inverse of the earlier swap is refused and changes nothing.
    swap = change(owner, deck, [(first, '1'), (second, '1')], 4)
    assert swap.status_code == 200
    assert change_line(owner, deck, second, '2', 5).status_code == 200
    late = change(owner, deck, [(first, '2'), (second, '0')], swap.json()['deck_list']['revision'])
    assert (late.status_code, code(late)) == (409, 'STALE_DECK_LIST')
    assert quantities(detail(owner, deck)['deck_list']) == {first: '1', second: '2'}


def test_deck_list_batches_and_inventory_undo_never_undo_each_other():
    owner, _, source, _, edition, generation = fixture()
    planned = edition_like(edition, generation)
    binder = leaf(owner)
    deck = create(owner).json()['location']['id']
    held = add(owner, source, edition, '5').json()
    manifest = start(owner, source)
    stage(owner, manifest, [selected(edition, 2, held['version'])])
    assert commit(owner, manifest, binder).status_code == 200
    undo_records = call('GET', '/api/moves/undo', owner).json()
    assert [entry['action'] for entry in undo_records] == ['move']
    revision = call('GET', '/api/collection/revision', owner).json()['owner_revision']

    # A Deck List batch writes no inventory Undo record and leaves the inventory revision alone, so the move's Undo
    # is still the newest one.
    batch = change(owner, deck, [(planned, '3')], 1)
    assert batch.status_code == 200, batch.text
    assert call('GET', '/api/moves/undo', owner).json() == undo_records
    assert call('GET', '/api/collection/revision', owner).json()['owner_revision'] == revision

    # Undoing the move leaves the Deck List as it was, and the Deck List's own Undo still applies afterwards.
    undone = call('POST', f"/api/moves/undo/{undo_records[0]['id']}", owner, {'idempotency_key': str(uuid4())})
    assert undone.status_code == 200, undone.text
    assert detail(owner, deck)['deck_list'] == batch.json()['deck_list']
    inverse = change(owner, deck, [(planned, '0')], batch.json()['deck_list']['revision'])
    assert inverse.status_code == 200, inverse.text
    assert inverse.json()['deck_list']['lines'] == []
    assert call('GET', f'/api/holdings/{source}', owner).json()['holdings'][0]['quantity'] == '5'


def test_a_replayed_batch_answers_like_every_deck_list_command_replay():
    """A replay goes through ``decks.replayed``, as every Deck List command's does: a stored answer without a Target
    Format (the shape stored before migration 045) or without display data still replays whole."""
    owner, _, _, _, first, _ = fixture()
    deck = create(owner).json()['location']['id']
    key = uuid4()
    stored = change(owner, deck, [(first, '2')], 1, key)
    assert stored.status_code == 200, stored.text
    old = {field: value for field, value in stored.json().items() if field != 'target_format'}
    old['deck_list'] = {**old['deck_list'], 'lines': [
        {field: line[field] for field in LINE_FIELDS} for line in old['deck_list']['lines']]}
    with connect() as conn:
        assert conn.execute('UPDATE location_command SET response=%s WHERE owner_id=%s AND request_key=%s',
                            (json.dumps(old), owner, key)).rowcount == 1
    replay = change(owner, deck, [(first, '2')], 1, key)
    assert replay.status_code == 200, replay.text
    assert replay.json() == stored.json()
