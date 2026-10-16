"""Friends' cards on the Want List and in the card popup (social network #251): ``GET /api/social/want-list-matches``
and ``GET /api/social/card-matches``, through signed HTTP against PostgreSQL.

Both answer Friends' copies from ``friend_copies`` only: for each card the Want List still needs (under the account's
counting setting and the Deck in scope), or for one Card Printing, the copies the viewer's ``printings`` choice
reaches, spare copies first. Neither carries a need, a Location or a Deck.

Every test seeds the Swap catalog (``want_list_swap_fixtures``) and starts new collectors.
"""
from uuid import UUID, uuid4

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.social import friend_reads
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import counting, deck, hold, line
from test_friend_copies import befriend, block, collector, hide, node, ok, place
from test_holdings import call
from want_list_swap_fixtures import seed_swap_catalog

COPY_FIELDS = ['collector_id', 'handle', 'display_name', 'edition_id', 'name', 'set_code', 'collector_number',
               'descriptor', 'other_printing', 'spare', 'in_deck']


def matches(viewer, **params):
    query = '&'.join(f'{name}={value}' for name, value in params.items())
    return call('GET', '/api/social/want-list-matches' + (f'?{query}' if query else ''), viewer)


def card(viewer, printing_id, **params):
    query = '&'.join(f'{name}={value}' for name, value in {'printing_id': printing_id, **params}.items())
    return call('GET', f'/api/social/card-matches?{query}', viewer)


def by_card(body):
    """want-list-matches as {wanted Edition: [(Friend, Edition, other_printing, spare, in_deck)]}."""
    return {item['edition_id']: [(copy['collector_id'], copy['edition_id'], copy['other_printing'], copy['spare'],
                                  copy['in_deck']) for copy in item['copies']] for item in body['cards']}


def listed(body):
    """card-matches as [(Friend, Edition, other_printing, spare, in_deck)]."""
    return [(copy['collector_id'], copy['edition_id'], copy['other_printing'], copy['spare'], copy['in_deck'])
            for copy in body['copies']]


def printing_of(edition_id):
    with connect() as conn:
        return str(conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s', (edition_id,)).fetchone()[
            'printing_id'])


def test_each_needed_card_lists_its_friends_copies_spare_first_then_its_own_printing(store):
    ids = seed_swap_catalog()
    (ash, _), (misty, misty_handle), (brock, brock_handle) = collector(), collector('Misty W.'), collector('Brock S.')
    befriend(ash, misty)
    befriend(ash, brock)
    charizard = deck(ash, 'Charizard ex', 0)
    line(ash, charizard, ids['PAL 185'], 2)
    # Misty: one PAL 185 her Deck holds for its own line, and a loose PAF 80. Brock: a loose PAL 185 and PAL 254.
    gyarados = deck(misty, 'Gyarados', 0)
    hold(misty, gyarados, ids['PAL 185'], 1)
    line(misty, gyarados, ids['PAL 185'], 1)
    hold(misty, node(misty, 'Unsorted')['id'], ids['PAF 80'], 1)
    for key in ('PAL 185', 'PAL 254'):
        hold(brock, node(brock, 'Unsorted')['id'], ids[key], 1)
    body = ok(matches(ash))
    assert body['has_friends'] is True
    # Spare copies first, the wanted card's own Printing first among them, then by Friend; copies in a Deck last.
    assert by_card(body) == {ids['PAL 185']: [
        (brock, ids['PAL 185'], False, '1', '0'), (brock, ids['PAL 254'], True, '1', '0'),
        (misty, ids['PAF 80'], True, '1', '0'), (misty, ids['PAL 185'], False, '0', '1')]}
    [wanted] = body['cards']
    assert list(wanted) == ['edition_id', 'copies']
    assert all(list(copy) == COPY_FIELDS for copy in wanted['copies'])
    # A match of another Printing carries its set and number; every copy names its Friend.
    other = wanted['copies'][1]
    assert (other['handle'], other['display_name'], other['name'], other['set_code'], other['collector_number']) == (
        brock_handle, 'Brock S.', 'Iono', 'PAL', '254')
    assert wanted['copies'][3]['handle'] == misty_handle
    # Exact printings: only the wanted card's own Printing.
    assert by_card(ok(matches(ash, printings='exact'))) == {ids['PAL 185']: [
        (brock, ids['PAL 185'], False, '1', '0'), (misty, ids['PAL 185'], False, '0', '1')]}
    # Nothing names a Deck or a Location, the viewer's or the Friend's.
    text = matches(ash).text
    for secret in (charizard, gyarados, node(misty, 'Unsorted')['id'], node(brock, 'Unsorted')['id'], 'Gyarados',
                   'Charizard', 'need'):
        assert secret not in text


def test_the_cards_follow_the_counting_setting_and_the_deck_in_scope(store):
    ids = seed_swap_catalog()
    (ash, _), (misty, _) = collector(), collector()
    befriend(ash, misty)
    for key in ('PAL 185', 'SVI 166'):
        hold(misty, node(misty, 'Unsorted')['id'], ids[key], 1)
    # Ash's oldest Deck holds the two PAL 185 it lists; a newer one lists two more and holds none; a third lists Arven.
    first, second, third = deck(ash, 'First', 0), deck(ash, 'Second', 1), deck(ash, 'Third', 2)
    hold(ash, first, ids['PAL 185'], 2)
    line(ash, first, ids['PAL 185'], 2)
    line(ash, second, ids['PAL 185'], 2)
    line(ash, third, ids['SVI 166'], 1)
    # Every Deck built at once: the newer Deck still needs its two.
    counting(ash, 'all_at_once')
    assert set(by_card(ok(matches(ash)))) == {ids['PAL 185'], ids['SVI 166']}
    assert set(by_card(ok(matches(ash, deck=second)))) == {ids['PAL 185']}
    assert set(by_card(ok(matches(ash, deck=third)))) == {ids['SVI 166']}
    assert by_card(ok(matches(ash, deck=first))) == {}
    # One Deck at a time: the oldest Deck's copies cover the newer one.
    counting(ash, 'one_at_a_time')
    assert set(by_card(ok(matches(ash)))) == {ids['SVI 166']}
    assert by_card(ok(matches(ash, deck=second))) == {}
    # A Deck that isn't the viewer's, or no Deck at all, is 404.
    for other in (deck(misty, 'Lugia', 0), node(ash, 'Unsorted')['id'], str(uuid4())):
        response = matches(ash, deck=other)
        assert (response.status_code, response.json()) == (404, {'detail': {'code': 'DECK_NOT_FOUND'}})


def test_no_friends_strangers_blocks_and_hidden_locations_answer_nothing(store):
    ids = seed_swap_catalog()
    (ash, _), (misty, _) = collector(), collector()
    line(ash, deck(ash, 'Charizard ex', 0), ids['PAL 185'], 2)
    hold(misty, node(misty, 'Unsorted')['id'], ids['PAL 185'], 2)
    printing = printing_of(ids['PAL 185'])
    nothing = ({'has_friends': False, 'cards': []}, {'has_friends': False, 'copies': []})
    # No Friends, a stranger, and a pending Friend Request: nothing, and the page can leave Get from Friends out.
    assert (ok(matches(ash)), ok(card(ash, printing))) == nothing
    ok(call('POST', '/api/social/friend-requests', ash, {'collector_id': misty, 'idempotency_key': str(uuid4())}))
    assert (ok(matches(ash)), ok(card(ash, printing))) == nothing
    ok(call('POST', f'/api/social/friend-requests/{ash}/accept', misty, {'idempotency_key': str(uuid4())}))
    assert by_card(ok(matches(ash))) == {ids['PAL 185']: [(misty, ids['PAL 185'], False, '2', '0')]}
    # A hidden Location's copies aren't there; Friends with nothing that matches still count as Friends.
    hide(misty, 'Unsorted')
    assert ok(matches(ash)) == {'has_friends': True, 'cards': []}
    assert ok(card(ash, printing)) == {'has_friends': True, 'copies': []}
    hold(misty, place(misty, 'Shelf'), ids['PAL 185'], 1)
    assert by_card(ok(matches(ash))) == {ids['PAL 185']: [(misty, ids['PAL 185'], False, '1', '0')]}
    # A Block either way ends it.
    block(misty, ash)
    assert (ok(matches(ash)), ok(card(ash, printing))) == nothing
    assert (ok(matches(misty)), ok(card(misty, printing))) == nothing


def test_the_card_popup_lists_friends_copies_of_the_printing_and_its_reprint_group(store):
    ids = seed_swap_catalog()
    (ash, _), (misty, _), (brock, _) = collector(), collector('Misty W.'), collector('Brock S.')
    befriend(ash, misty)
    befriend(ash, brock)
    hold(misty, node(misty, 'Unsorted')['id'], ids['PAL 185'], 1)
    hold(misty, node(misty, 'Unsorted')['id'], ids['PAF 80'], 2)
    hold(brock, node(brock, 'Unsorted')['id'], ids['SVI 166 Reverse Holo'], 1)
    iono = printing_of(ids['PAL 185'])
    assert listed(ok(card(ash, iono))) == [(misty, ids['PAL 185'], False, '1', '0'),
                                          (misty, ids['PAF 80'], True, '2', '0')]
    assert listed(ok(card(ash, iono, printings='exact'))) == [(misty, ids['PAL 185'], False, '1', '0')]
    # From another Printing of the group, PAL 185 is the other one.
    assert listed(ok(card(ash, printing_of(ids['PAF 80'])))) == [(misty, ids['PAF 80'], False, '2', '0'),
                                                                (misty, ids['PAL 185'], True, '1', '0')]
    # Every finish of the Printing is the same card, even under Exact printings.
    assert listed(ok(card(ash, printing_of(ids['SVI 166']), printings='exact'))) == [
        (brock, ids['SVI 166 Reverse Holo'], False, '1', '0')]
    # A Printing nobody has, or none at all.
    assert ok(card(ash, printing_of(ids['PAL 172']))) == {'has_friends': True, 'copies': []}
    assert ok(card(ash, str(uuid4()))) == {'has_friends': True, 'copies': []}
    assert card(ash, 'not-a-uuid').status_code == 422


def test_one_friend_copies_read_covers_every_friend_and_card(store, monkeypatch):
    ids = seed_swap_catalog()
    ash, _ = collector()
    charizard = deck(ash, 'Charizard ex', 0)
    for key in ('PAL 185', 'SVI 166', 'SVE 5'):
        line(ash, charizard, ids[key], 1)
    friends = [collector()[0] for _ in range(3)]
    for friend in friends:
        befriend(ash, friend)
        for key in ('PAL 254', 'SVI 166', 'SVE 13'):
            hold(friend, node(friend, 'Unsorted')['id'], ids[key], 1)
    reads = []
    real = friend_reads.friend_copies

    def counted(conn, viewer, friend_ids=None, edition_ids=None):
        reads.append((friend_ids, set(edition_ids)))
        return real(conn, viewer, friend_ids, edition_ids)

    monkeypatch.setattr(friend_reads, 'friend_copies', counted)
    found = by_card(ok(matches(ash)))
    # Basic Energy isn't grouped by type: SVE 13 doesn't match SVE 5.
    assert set(found) == {ids['PAL 185'], ids['SVI 166']}
    assert {len(copies) for copies in found.values()} == {3}
    assert len(reads) == 1 and reads[0][0] is None
    assert reads[0][1] >= {UUID(ids['PAL 185']), UUID(ids['PAL 254']), UUID(ids['PAF 80']), UUID(ids['SVE 5'])}
    reads.clear()
    assert len(ok(card(ash, printing_of(ids['SVI 166'])))['copies']) == 3 and len(reads) == 1
