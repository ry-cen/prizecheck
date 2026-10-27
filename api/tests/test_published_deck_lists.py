"""Publishing a Deck snapshots its Deck List (Deck Lists 09, issue #90), through signed HTTP and anonymous public reads.

A Published Deck freezes the Deck List's Card Edition and quantity rows, owned or not, and never the Deck's Holdings.
Rows group by Card Identity, which drives copy counts, while each row keeps its own Card Printing name for display, Mass
Entry lines and discovery search. Snapshots published before this change stay valid and unchanged.

Every test adds a Deck List line before putting copies into a Deck, never above the line's quantity, and makes surplus
only by removing a line, so the tests hold whether or not Holdings added to a Deck also extend its Deck List (ticket 05).
"""
import json
import os
from pathlib import Path
from uuid import uuid4

import psycopg

from app.main import app, connect  # noqa: F401
from test_card_identity import JUNIPER, MAGNOLIA, PLAIN, printings
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_targets import isolated_rules  # noqa: F401  (autouse: clears rule activations)
from test_deck_lists import add_line, change_line, remove_line
from test_decks import create
from test_discovery import visibility
from test_holdings import add, call, client, fixture
from test_moves import edition_like, leaf
from test_publications import command, list_cards, stored_decks
from test_published_cost import USER, body_of, launches, public_cost, publish, seed, store  # noqa: F401  (store, launches: autouse)
from test_published_live_export import live_world

JUNIPER_NAME = "Professor's Research (Professor Juniper)"
MAGNOLIA_NAME = "Professor's Research (Professor Magnolia)"
SNAPSHOT_KEYS = {'title', 'published_at', 'version', 'target_format', 'total', 'identities', 'checks'}
EDITION_KEYS = {'set_id', 'set_name', 'collector_number', 'variant', 'image_url', 'quantity', 'edition_ref', 'printing_ref',
                'printing_name', 'card_kind', 'trainer_type', 'evolves_from', 'evolution_root', 'evolution_stage'}


def ok(response):
    assert response.status_code == 200, response.text
    return response


def revision_after(response):
    return ok(response).json()['deck_list']['revision']


def public(token):
    return ok(client.get(f'/api/public/decks/{token}')).json()


def edition_ref(edition_id):
    with connect() as conn:
        return conn.execute('SELECT public_ref FROM catalog_edition WHERE id=%s', (edition_id,)).fetchone()['public_ref']


def rows(snapshot):
    return {edition['edition_ref']: edition['quantity'] for identity in snapshot['identities'] for edition in identity['editions']}


def content(snapshot):
    """Everything but the per-publication title and time."""
    return {key: value for key, value in snapshot.items() if key not in ('title', 'published_at')}


def export(token, version, kind):
    return body_of(client.get(f'/api/public/decks/{token}/versions/{version}/exports/{kind}'))


def test_publishing_freezes_the_deck_list_with_cards_not_owned_and_never_the_holdings():
    owner, other, unsorted, _, edition, generation = fixture()
    binder = leaf(owner, 'Binder of secrets')
    elsewhere, not_owned, surplus = (edition_like(edition, generation) for _ in range(3))
    deck = create(owner, 'Secret shelf deck').json()['location']['id']
    revision = revision_after(add_line(owner, deck, edition, '3', 1))
    revision = revision_after(add_line(owner, deck, elsewhere, '2', revision))
    revision = revision_after(add_line(owner, deck, not_owned, '4', revision))
    revision = revision_after(add_line(owner, deck, surplus, '5', revision))
    # In this Deck: 3 of edition. Elsewhere: 2 in the binder. Not owned: not_owned, held nowhere.
    for location, item, quantity in ((deck, edition, '3'), (binder, elsewhere, '2'), (deck, surplus, '5')):
        ok(add(owner, location, item, quantity))
    # Cut the line while its five copies stay in the Deck: surplus Holdings, not on the Deck List.
    revision = revision_after(remove_line(owner, deck, surplus, revision))

    published = ok(command(owner, deck, title='Shared plan'))
    token = published.json()['token']
    snapshot = public(token)
    assert set(snapshot) == SNAPSHOT_KEYS
    assert (snapshot['total'], snapshot['version']) == ('9', 1)
    assert rows(snapshot) == {edition_ref(edition): '3', edition_ref(elsewhere): '2', edition_ref(not_owned): '4'}
    [identity] = snapshot['identities']
    assert (identity['name'], identity['quantity']) == ('Pikachu', '9')
    assert all(set(row) == EDITION_KEYS and row['printing_name'] == 'Pikachu' for row in identity['editions'])
    assert snapshot['checks']['identities'] == [{'name': 'Pikachu', 'quantity': '9', 'status': 'over_limit'}]

    # Nothing about ownership or Locations: no private ids or names, and no ownership vocabulary anywhere.
    serialized = json.dumps(snapshot)
    for private in (owner, other, deck, binder, unsorted, edition, elsewhere, not_owned, surplus, 'Secret shelf deck',
                    'Binder of secrets', 'Unsorted', 'in_deck', 'owned', 'elsewhere', 'surplus', 'location', 'holding'):
        assert private not in serialized, private

    # The same Deck List published by a collector who owns none of it is the same snapshot.
    stranger = f'stranger-{uuid4()}'
    empty_handed = create(stranger, 'Another private name').json()['location']['id']
    revision = 1
    for item, quantity in ((edition, '3'), (elsewhere, '2'), (not_owned, '4')):
        revision = revision_after(add_line(stranger, empty_handed, item, quantity, revision))
    twin = public(ok(command(stranger, empty_handed, title='Shared plan')).json()['token'])
    assert content(twin) == content(snapshot)


def test_republish_freezes_the_current_deck_list_and_a_deck_list_without_lines_publishes_nothing_it_holds():
    owner, _, _, _, edition, generation = fixture()
    not_owned = edition_like(edition, generation)
    deck = create(owner).json()['location']['id']
    revision = revision_after(add_line(owner, deck, not_owned, '2', 1))
    token = ok(command(owner, deck)).json()['token']
    first = public(token)
    assert (first['total'], rows(first)) == ('2', {edition_ref(not_owned): '2'})

    # Private Deck List edits and Holdings change nothing public until a republish.
    revision = revision_after(change_line(owner, deck, not_owned, '5', revision))
    revision = revision_after(add_line(owner, deck, edition, '1', revision))
    ok(add(owner, deck, edition, '1'))
    assert public(token) == first
    assert ok(command(owner, deck, 'PUT', 'Second version')).json() == {'token': token, 'version': 2, 'revoked': False}
    second = public(token)
    assert (second['version'], second['total']) == (2, '6')
    assert rows(second) == {edition_ref(not_owned): '5', edition_ref(edition): '1'}

    # A Deck whose list is empty publishes an empty snapshot, whatever it holds.
    held = create(owner, 'Holds cards, lists none').json()['location']['id']
    revision = revision_after(add_line(owner, held, edition, '3', 1))
    ok(add(owner, held, edition, '3'))
    revision_after(remove_line(owner, held, edition, revision))
    empty = public(ok(command(owner, held)).json()['token'])
    assert (empty['total'], empty['identities'], empty['checks']['identities']) == ('0', [], [])
    assert (empty['checks']['size_status'], empty['checks']['shortage']) == ('shortage', '60')


def test_subtitled_printings_keep_their_own_names_while_one_card_identity_counts_their_copies():
    reset_catalog()
    run(Records(JUNIPER, MAGNOLIA, PLAIN))
    found = printings("Professor's Research")
    juniper, magnolia = found['swsh4.5-60']['editions'][0]['id'], found['swsh1-178']['editions'][0]['id']
    collector = f'subtitles-{uuid4()}'
    deck = create(collector, 'Professor deck').json()['location']['id']
    revision = revision_after(add_line(collector, deck, juniper, '3', 1))
    revision_after(add_line(collector, deck, magnolia, '2', revision))
    token = ok(command(collector, deck, title='Research plan')).json()['token']
    ok(visibility(collector, deck, 'listed'))

    snapshot = public(token)
    [identity] = snapshot['identities']
    assert (identity['name'], identity['quantity']) == ("Professor's Research", '5')
    assert {row['printing_name']: row['quantity'] for row in identity['editions']} == {JUNIPER_NAME: '3', MAGNOLIA_NAME: '2'}
    assert snapshot['checks']['identities'] == [{'name': "Professor's Research", 'quantity': '5', 'status': 'over_limit'}]

    # Discovery still finds the deck by either subtitle, and by the Card Identity name.
    for query in ('Juniper', 'professor magnolia', "Professor's Research"):
        listed = ok(client.get('/api/public/discovery', params={'q': query})).json()['decks']
        assert [item['url'] for item in listed] == [f'/published/{token}'], query
    assert ok(client.get('/api/public/discovery', params={'q': 'Sycamore'})).json()['decks'] == []

    # Mass Entry names each line by its own Card Printing.
    body = export(token, 1, 'tcgplayer')
    assert body['total_copies'] == '5'
    assert sorted(line['text'] for line in body['lines']) == [f'2 {MAGNOLIA_NAME}', f'3 {JUNIPER_NAME}']


def published_before_deck_lists(token):
    """Rewrite one published snapshot as Deck Lists 09 found it: references but no printing_name, in canonical jsonb key
    order (the order the private outbox stores), so a later visibility change can be compared byte for byte."""
    path = Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json'
    state = json.loads(path.read_text())
    snapshot = state['decks'][token]['snapshot']
    for identity in snapshot['identities']:
        for edition in identity['editions']:
            del edition['printing_name']
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        snapshot = conn.execute('SELECT %s::jsonb', (json.dumps(snapshot),)).fetchone()[0]
    state['decks'][token]['snapshot'] = snapshot
    path.write_text(json.dumps(state, ensure_ascii=False, separators=(',', ':')))


def stored_text(token):
    return json.dumps(stored_decks()['decks'][token]['snapshot'], ensure_ascii=False, separators=(',', ':'))


def test_a_snapshot_published_before_deck_lists_stays_valid_and_unchanged():
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    list_cards(owner, deck, {edition: 3})
    token = ok(command(owner, deck)).json()['token']
    published_before_deck_lists(token)
    before = stored_text(token)
    assert 'printing_name' not in before and 'edition_ref' in before

    snapshot = public(token)
    assert [(row['printing_name'], row['quantity']) for i in snapshot['identities'] for row in i['editions']] == [(None, '3')]
    ok(visibility(owner, deck, 'listed'))
    assert stored_text(token) == before
    assert len(ok(client.get('/api/public/discovery', params={'q': 'pikachu'})).json()['decks']) == 1
    # Readers fall back to the Card Identity name the snapshot was frozen with.
    assert [line['text'] for line in export(token, 1, 'tcgplayer')['lines']] == ['3 Pikachu']
    assert [blocker['name'] for blocker in export(token, 1, 'live')['blockers']] == ['Pikachu']
    assert body_of(public_cost(token, 1))['total_copies'] == '3'
    assert stored_text(token) == before


def test_published_cost_and_both_exports_answer_for_a_deck_that_owns_none_of_its_cards(store):
    editions, _ = live_world()
    normal, plain = editions['normal'], editions['unspecified']
    seed(store, normal, '0.25')
    deck, token = publish({normal['id']: 3, plain['id']: 1})
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM holding WHERE owner_id=%s AND edition_id=ANY(%s)',
                            (USER, [normal['id'], plain['id']])).fetchone()['n'] == 0
    cost = body_of(public_cost(token, 1))
    assert (cost['display_amount'], cost['priced_copies'], cost['total_copies']) == ('$0.75', '3', '4')
    live = export(token, 1, 'live')
    assert (live['status'], live['text'], live['total_copies']) == ('ok', 'Pokémon: 4\n3 Furret DAA 136\n1 Furret DAA 2', '4')
    mass = export(token, 1, 'tcgplayer')
    assert (mass['status'], mass['fallback_reason'], mass['total_copies']) == ('text', 'missing_mapping', '4')
    assert sorted(line['text'] for line in mass['lines']) == ['1 Furret', '3 Furret']
