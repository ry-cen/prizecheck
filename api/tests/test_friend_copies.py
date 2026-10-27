"""Browse a Friend's Collection (social network #250): ``social.friend_copies``, the one read of another collector's
inventory, and ``GET /api/social/collections/{handle}``, through signed HTTP against PostgreSQL.

A Friend's copies of a Card Edition are what they could lend now: their Holdings outside every hidden Location, less
the copies reserved for open Loans, split by the shared Spare Copy rule into spare copies and copies a Deck holds for
its own line. Only an accepted Friend with no Block either way sees anything, and nothing names a Location or a Deck.

Every test seeds the Swap catalog (``want_list_swap_fixtures``: Iono PAL 185, PAL 254 and PAF 80 in one Reprint Group;
Arven SVI 166 in two Editions) and starts new collectors.
"""
import secrets
from uuid import UUID, uuid4

from app.main import connect  # noqa: F401
from app.social import counts, friend_reads
from app.social.friend_copies import FriendCopies, friend_copies
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import deck, hold, line
from test_holdings import call
from test_location_tree import change, make, tree
from want_list_swap_fixtures import seed_swap_catalog

# Consonants only: a random run of them never trips the name filter (test_friends.py explains why).
QUIET = 'bcdfghjklmnpqrstvwxz'


def ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def collector(name=None):
    """A new collector with a Handle of their own (and a Display Name when given); returns (id, Handle)."""
    owner = f'friendcards-{uuid4()}'
    handle = 'f' + ''.join(secrets.choice(QUIET) for _ in range(12))
    ok(call('PUT', '/api/profile/handle', owner, {'handle': handle, 'idempotency_key': str(uuid4())}))
    if name:
        ok(call('PUT', '/api/profile/display-name', owner, {'display_name': name, 'idempotency_key': str(uuid4())}))
    return owner, handle


def befriend(a, b):
    assert ok(call('POST', '/api/social/friend-requests', a,
                   {'collector_id': b, 'idempotency_key': str(uuid4())}))['relation'] == 'request_sent'
    assert ok(call('POST', f'/api/social/friend-requests/{a}/accept', b,
                   {'idempotency_key': str(uuid4())}))['relation'] == 'friends'


def block(blocker, blocked):
    assert ok(call('POST', '/api/social/blocks', blocker,
                   {'collector_id': blocked, 'idempotency_key': str(uuid4())}))['relation'] == 'blocked'


def node(owner, name):
    """A Location of the owner by name, or by id (a Deck made by ``deck`` has a unique name)."""
    return next(item for item in tree(owner) if name in (item['name'], item['id']))


def place(owner, name, parent=None):
    """A Location made through the route (inside ``parent``, a Location name, when given); returns its id."""
    return ok(make(owner, name, node(owner, parent) if parent else None), 201)['location']['id']


def hide(owner, name, hidden=True):
    found = node(owner, name)
    ok(call('PUT', f"/api/location-tree/{found['id']}/hidden", owner,
            {'hidden': hidden, 'version': found['version'], 'idempotency_key': str(uuid4())}))


def copies(viewer, friends=None, editions=None):
    """friend_copies as {(Friend, Edition): (spare, in_deck)}."""
    with connect() as conn:
        found = friend_copies(conn, viewer, friends, None if editions is None else [UUID(e) for e in editions])
    return {(item.friend_id, str(item.edition_id)): (item.spare, item.in_deck) for item in found}


def collection(viewer, handle, **params):
    query = '&'.join(f'{name}={value}' for name, value in params.items())
    return call('GET', f'/api/social/collections/{handle}' + (f'?{query}' if query else ''), viewer)


def shown(body):
    """A collection page as {Edition: (spare, in_deck, wanted)}."""
    return {card['edition_id']: (card['spare'], card['in_deck'], card['wanted']) for card in body['cards']}


def test_a_friend_sees_spare_and_in_deck_copies_per_edition_and_nothing_else(store):
    ids = seed_swap_catalog()
    (ash, _), (misty, misty_handle) = collector('Ash K.'), collector('Misty W.')
    befriend(ash, misty)
    unsorted = node(misty, 'Unsorted')['id']
    gyarados = deck(misty, 'Gyarados', 0)
    # Iono PAL 185: 2 loose, and the Deck holds 3 for a line of 2, so 1 is beyond the line: 3 spare, 2 in a Deck.
    hold(misty, unsorted, ids['PAL 185'], 2)
    hold(misty, gyarados, ids['PAL 185'], 3)
    line(misty, gyarados, ids['PAL 185'], 2)
    # Arven SVI 166 only in the Deck for its own line: all in a Deck. A line the Deck holds nothing for adds nothing.
    hold(misty, gyarados, ids['SVI 166'], 1)
    line(misty, gyarados, ids['PAF 80'], 4)
    assert copies(ash) == {(misty, ids['PAL 185']): (3, 2), (misty, ids['SVI 166']): (0, 1)}
    with connect() as conn:
        [item] = friend_copies(conn, ash, [misty], [UUID(ids['SVI 166'])])
    # The function answers four things and nothing else.
    assert item == FriendCopies(friend_id=misty, edition_id=UUID(ids['SVI 166']), spare=0, in_deck=1)
    assert list(vars(item)) == ['friend_id', 'edition_id', 'spare', 'in_deck']
    # Friendship is mutual: Misty sees Ash's (none) and Ash sees Misty's through the route too.
    assert copies(misty) == {}
    body = ok(collection(ash, misty_handle, show='all'))
    assert (body['collector_id'], body['handle'], body['display_name'], body['show']) == (
        misty, misty_handle, 'Misty W.', 'all')
    assert shown(body) == {ids['PAL 185']: ('3', '2', False), ids['SVI 166']: ('0', '1', False)}
    assert body['next_page'] is None
    # Asking about only some Editions, or Friends, narrows the one read.
    assert copies(ash, editions=[ids['PAL 185'], ids['PAL 254']]) == {(misty, ids['PAL 185']): (3, 2)}
    assert copies(ash, friends=[ash, 'nobody']) == {}
    assert copies(ash, friends=[], editions=None) == {} and copies(ash, editions=[]) == {}


def test_strangers_requests_and_blocks_either_way_see_nothing(store):
    ids = seed_swap_catalog()
    (ash, ash_handle), (misty, misty_handle), (brock, _) = collector(), collector(), collector()
    hold(misty, node(misty, 'Unsorted')['id'], ids['PAL 185'], 2)

    def refused_handle(viewer, handle):
        response = collection(viewer, handle)
        assert response.status_code == 404
        return response.content

    def refused(viewer):
        return refused_handle(viewer, misty_handle)

    # A stranger, and a pending Friend Request either way, see nothing.
    assert copies(ash) == {} and copies(ash, [misty]) == {}
    unknown = refused(ash)
    assert unknown == b'{"detail":{"code":"FRIEND_NOT_FOUND"}}'
    assert refused_handle(ash, 'fnobodyhasthis') == unknown
    ok(call('POST', '/api/social/friend-requests', ash, {'collector_id': misty, 'idempotency_key': str(uuid4())}))
    assert copies(ash, [misty]) == {} and copies(misty, [ash]) == {}
    assert refused(ash) == unknown
    # The recipient of a pending request sees the sender's Handle as unknown too, until it is accepted.
    assert refused_handle(misty, ash_handle) == unknown
    ok(call('POST', f'/api/social/friend-requests/{ash}/accept', misty, {'idempotency_key': str(uuid4())}))
    assert copies(ash, [misty]) == {(misty, ids['PAL 185']): (2, 0)}
    # A Block either way ends it, and the Friend's Handle answers as an unknown one, byte for byte.
    befriend(brock, misty)
    block(misty, ash)
    assert copies(ash) == {} and refused(ash) == unknown
    assert copies(brock) == {(misty, ids['PAL 185']): (2, 0)}
    block(brock, misty)
    assert copies(brock) == {} and refused(brock) == unknown
    # A Handle that can't exist answers the same.
    assert refused_handle(ash, 'x!') == unknown


def test_hidden_locations_and_everything_inside_them_are_left_out(store):
    ids = seed_swap_catalog()
    (ash, _), (misty, _) = collector(), collector()
    befriend(ash, misty)
    place(misty, 'Trade Binders')
    place(misty, 'Binder 1', 'Trade Binders')
    hold(misty, node(misty, 'Binder 1')['id'], ids['PAL 185'], 3)
    loose = place(misty, 'Shelf')
    hold(misty, loose, ids['PAL 254'], 1)
    lugia = deck(misty, 'Lugia', 0)
    hold(misty, lugia, ids['SVI 166'], 2)
    line(misty, lugia, ids['SVI 166'], 2)
    everything = {(misty, ids['PAL 185']): (3, 0), (misty, ids['PAL 254']): (1, 0), (misty, ids['SVI 166']): (0, 2)}
    assert copies(ash) == everything
    # Hiding the parent hides the Binder inside it.
    hide(misty, 'Trade Binders')
    assert (misty, ids['PAL 185']) not in copies(ash)
    # So does a Location added inside it later, and a Deck moved inside it.
    hold(misty, place(misty, 'Binder 2', 'Trade Binders'), ids['PAL 254'], 4)
    assert copies(ash)[(misty, ids['PAL 254'])] == (1, 0)
    ok(call('PATCH', f'/api/decks/{lugia}', misty,
            {'version': node(misty, lugia)['version'], 'idempotency_key': str(uuid4()),
             'parent_id': node(misty, 'Trade Binders')['id'], 'parent_version': node(misty, 'Trade Binders')['version']}))
    assert copies(ash) == {(misty, ids['PAL 254']): (1, 0)}
    # Moving the Shelf in hides it at once; moving it out shows it again.
    ok(change(misty, node(misty, 'Shelf'), parent_id=node(misty, 'Trade Binders')['id'],
              parent_version=node(misty, 'Trade Binders')['version']))
    assert copies(ash) == {}
    ok(change(misty, node(misty, 'Shelf'), parent_id=None))
    assert copies(ash) == {(misty, ids['PAL 254']): (1, 0)}
    # A hidden Deck, and Unsorted, can be hidden on their own too.
    hide(misty, 'Trade Binders', False)
    hide(misty, lugia)
    hold(misty, node(misty, 'Unsorted')['id'], ids['PAF 80'], 1)
    hide(misty, 'Unsorted')
    assert copies(ash) == {(misty, ids['PAL 185']): (3, 0), (misty, ids['PAL 254']): (5, 0)}


def test_reserved_copies_come_out_of_the_spare_copies_first_then_the_in_deck_ones(store, monkeypatch):
    ids = seed_swap_catalog()
    (ash, _), (misty, _) = collector(), collector()
    befriend(ash, misty)
    gyarados = deck(misty, 'Gyarados', 0)
    hold(misty, node(misty, 'Unsorted')['id'], ids['PAL 185'], 2)
    hold(misty, gyarados, ids['PAL 185'], 3)
    line(misty, gyarados, ids['PAL 185'], 3)
    asked = []

    def reserving(found):
        def reserved_by_owner(conn, owner_ids, edition_ids=None):
            asked.append((set(owner_ids), set(edition_ids)))
            return found
        monkeypatch.setattr(counts, 'reserved_by_owner', reserved_by_owner)

    key = (misty, UUID(ids['PAL 185']))
    assert copies(ash) == {(misty, ids['PAL 185']): (2, 3)}
    reserving({key: 1})
    assert copies(ash) == {(misty, ids['PAL 185']): (1, 3)}
    reserving({key: 4})
    assert copies(ash) == {(misty, ids['PAL 185']): (0, 1)}
    reserving({key: 5})
    assert copies(ash) == {}
    assert asked[0] == ({misty}, {UUID(ids['PAL 185'])})


def test_one_statement_and_one_reserved_read_cover_every_friend_and_edition(store, monkeypatch):
    ids = seed_swap_catalog()
    ash, _ = collector()
    friends = [collector()[0] for _ in range(3)]
    for number, friend in enumerate(friends):
        befriend(ash, friend)
        hold(friend, node(friend, 'Unsorted')['id'], ids['PAL 185'], number + 1)
        hold(friend, node(friend, 'Unsorted')['id'], ids['PAL 254'], 1)
    reads = []
    monkeypatch.setattr(counts, 'reserved_by_owner', lambda conn, owners, editions=None: reads.append(set(owners)) or {})
    statements = []

    class Counting:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, query, params=None):
            statements.append(query)
            return self.conn.execute(query, params)

    with connect() as conn:
        found = friend_copies(Counting(conn), ash)
    assert len(statements) == 1 and reads == [set(friends)]
    assert {(item.friend_id, str(item.edition_id), item.spare) for item in found} == {
        (friend, ids['PAL 185'], number + 1) for number, friend in enumerate(friends)} | {
        (friend, ids['PAL 254'], 1) for friend in friends}


def test_a_friends_collection_shows_on_my_want_list_by_default_and_follows_the_printings_choice(store):
    ids = seed_swap_catalog()
    (ash, _), (misty, misty_handle) = collector(), collector()
    befriend(ash, misty)
    unsorted = node(misty, 'Unsorted')['id']
    for key in ('PAL 185', 'PAL 254', 'SVI 166 Reverse Holo', 'PAL 172'):
        hold(misty, unsorted, ids[key], 1)
    # Ash's Want List needs Iono PAL 185 and Arven SVI 166 (normal).
    charizard = deck(ash, 'Charizard ex', 0)
    line(ash, charizard, ids['PAL 185'], 2)
    line(ash, charizard, ids['SVI 166'], 1)
    # On my Want List is the default: the same Edition, another finish of the same Printing and, by default, another
    # Printing of the Reprint Group all match.
    body = ok(collection(ash, misty_handle))
    assert body['show'] == 'wanted'
    assert shown(body) == {ids['PAL 185']: ('1', '0', True), ids['PAL 254']: ('1', '0', True),
                           ids['SVI 166 Reverse Holo']: ('1', '0', True)}
    # Exact printings: other Printings don't match.
    assert set(shown(ok(collection(ash, misty_handle, printings='exact')))) == {
        ids['PAL 185'], ids['SVI 166 Reverse Holo']}
    # All cards marks what matches.
    assert shown(ok(collection(ash, misty_handle.upper(), show='all', printings='exact'))) == {
        ids['PAL 185']: ('1', '0', True), ids['PAL 254']: ('1', '0', False),
        ids['SVI 166 Reverse Holo']: ('1', '0', True), ids['PAL 172']: ('1', '0', False)}
    # A line the Collection already covers isn't wanted.
    hold(ash, charizard, ids['SVI 166'], 1)
    assert set(shown(ok(collection(ash, misty_handle)))) == {ids['PAL 185'], ids['PAL 254']}


def test_search_and_pages_by_card_identity(store, monkeypatch):
    ids = seed_swap_catalog()
    (ash, _), (misty, misty_handle) = collector(), collector()
    befriend(ash, misty)
    unsorted = node(misty, 'Unsorted')['id']
    for key in ('PAL 185', 'PAF 80', 'SVI 166', 'SVI 166 Reverse Holo', 'PAL 172', 'SVE 5'):
        hold(misty, unsorted, ids[key], 1)
    # Letters and digits only, any case: "boss's" finds Boss's Orders.
    assert set(shown(ok(collection(ash, misty_handle, show='all', q='BOSS%27S')))) == {ids['PAL 172']}
    assert set(shown(ok(collection(ash, misty_handle, show='all', q='io no')))) == {ids['PAL 185'], ids['PAF 80']}
    assert ok(collection(ash, misty_handle, show='all', q='zzz'))['cards'] == []
    # A query of only punctuation has no letters or digits: it matches no card, where an empty one matches all.
    for punctuation in ('!!!', '%2E%2E', '%20-%20'):
        body = ok(collection(ash, misty_handle, show='all', q=punctuation))
        assert body['cards'] == [] and body['next_page'] is None, punctuation
    assert shown(ok(collection(ash, misty_handle, show='all', q=''))) != {}
    # Two Card Identities a page: a card's Editions are never split, and pages come in card order.
    monkeypatch.setattr(friend_reads, 'PAGE_IDENTITIES', 2)
    first = ok(collection(ash, misty_handle, show='all'))
    assert [card['name'] for card in first['cards']] == ['Arven', 'Arven', 'Basic Psychic Energy']
    assert first['next_page'] == 1
    second = ok(collection(ash, misty_handle, show='all', page=1))
    assert [(card['name'], card['set_code']) for card in second['cards']] == [
        ("Boss's Orders", 'PAL'), ('Iono', 'PAL'), ('Iono', 'PAF')]
    assert second['next_page'] is None
    beyond = ok(collection(ash, misty_handle, show='all', page=2))
    assert (beyond['cards'], beyond['next_page']) == ([], None)


def test_no_location_or_deck_name_or_id_reaches_the_viewer(store):
    ids = seed_swap_catalog()
    (ash, _), (misty, misty_handle) = collector(), collector()
    befriend(ash, misty)
    secret = f'Secret {uuid4().hex[:8]}'
    binder = place(misty, f'{secret} Binder')
    lugia = deck(misty, f'{secret} Deck', 0)
    hold(misty, binder, ids['PAL 185'], 2)
    hold(misty, lugia, ids['SVI 166'], 1)
    line(misty, lugia, ids['SVI 166'], 1)
    for params in ({}, {'show': 'all'}, {'show': 'all', 'q': 'iono'}):
        text = collection(ash, misty_handle, **params).text
        assert secret not in text and binder not in text and lugia not in text
        assert node(misty, 'Unsorted')['id'] not in text
