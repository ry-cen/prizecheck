"""See my Trade List and a Friend's Trade List (Trading #269): ``GET /api/trades/list``, the collector's own list with
their own Locations, and ``GET /api/social/trade-lists/{handle}``, a Friend's list of cards and copies only, through
signed HTTP against PostgreSQL, with ``trade_list.own_trade_copies`` and ``friend_copies.friend_trade_copies``, the two
reads of migration 142's one listable rule.

Every test seeds the Swap catalog (``want_list_swap_fixtures``: Iono PAL 185, PAL 254 and PAF 80; Arven SVI 166 in two
Editions; Boss's Orders PAL 172; Basic Psychic Energy SVE 5 and 13) and starts new collectors. Loans go through their
routes; Trades are seeded rows (``test_trade_promises.seed_trade``) until the Trade steps exist, released with
``test_trade_promises.close``.
"""
from uuid import UUID, uuid4

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.social import trade_matches
from app.social.friend_copies import TradeCopies, friend_trade_copies
from app.trade_list import own_trade_copies
from stranger_fixtures import far_zip, strangers, trader_of
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import hold, line
from test_for_trade_locations import deck_in, hide, mark
from test_friend_copies import befriend, block, collector, node, ok, place
from test_handover import handover
from test_holdings import call
from test_lend_offers import offer
from test_loans import accept, revision_of, sent, step, view
from test_location_tree import tree
from test_open_discovery import discoverable
from test_trade_promises import close, move, seed_trade
from want_list_swap_fixtures import seed_swap_catalog

UNKNOWN = b'{"detail":{"code":"FRIEND_NOT_FOUND"}}'


def friends(*names):
    """New collectors with Display Names, all Friends of the first; returns [(id, Handle)]."""
    found = [collector(name) for name in names]
    for other, _ in found[1:]:
        befriend(found[0][0], other)
    return found


def own(owner):
    return ok(call('GET', '/api/trades/list', owner))


def own_cards(owner):
    """The owner's Trade List as {Edition: (copies, {Location path: copies})}, checking that each card's Locations add
    up to its copies and name only Locations the answer lists."""
    body = own(owner)
    paths = {item['id']: ' / '.join(item['path']) for item in body['locations']}
    found = {}
    for card in body['cards']:
        places = {paths[place_['location_id']]: place_['copies'] for place_ in card['places']}
        assert sum(int(copies) for copies in places.values()) == int(card['copies']), card
        found[card['edition_id']] = (card['copies'], places)
    return found


def friend_list(viewer, handle, **params):
    query = '&'.join(f'{name}={value}' for name, value in params.items())
    return call('GET', f'/api/social/trade-lists/{handle}' + (f'?{query}' if query else ''), viewer)


def friend_cards(viewer, handle, **params):
    """A Friend's Trade List page as {Edition: copies}."""
    return {card['edition_id']: card['copies'] for card in ok(friend_list(viewer, handle, **params))['cards']}


def listed(viewer, friend_ids=None, editions=None):
    """friend_trade_copies as {(Friend, Edition): listable}."""
    with connect() as conn:
        found = friend_trade_copies(conn, viewer, friend_ids, None if editions is None else [UUID(e) for e in editions])
    return {(item.friend_id, str(item.edition_id)): item.listable for item in found}


def test_my_trade_list_shows_for_trade_copies_where_they_sit_and_a_move_offers_or_withdraws_at_once(store):
    ids = seed_swap_catalog()
    (misty, _), (ash, _) = friends('Misty W.', 'Ash K.')
    iono, arven = ids['PAL 185'], ids['SVI 166']
    unsorted = node(misty, 'Unsorted')['id']
    binder = place(misty, 'Trade Binder')
    hold(misty, binder, iono, 2)
    hold(misty, unsorted, iono, 1)
    hold(misty, unsorted, arven, 1)
    # Nothing is For trade yet: an empty list, and no Location.
    assert own(misty) == {'locations': [], 'cards': []}
    ok(mark(misty, binder))
    body = own(misty)
    assert body['locations'] == [{'id': binder, 'name': 'Trade Binder', 'path': ['Trade Binder'], 'hidden': False}]
    [card] = body['cards']
    assert (card['edition_id'], card['name'], card['set_code'], card['collector_number'], card['copies']) == (
        iono, 'Iono', 'PAL', '185', '2')
    assert card['places'] == [{'location_id': binder, 'copies': '2'}]
    assert set(card) == {'edition_id', 'name', 'set_code', 'set_name', 'collector_number', 'descriptor', 'image_url',
                         'copies', 'places'}
    # Moving a copy into the binder offers it at once; moving one out withdraws it.
    move(misty, unsorted, binder, arven, 1)
    assert own_cards(misty) == {iono: ('2', {'Trade Binder': '2'}), arven: ('1', {'Trade Binder': '1'})}
    move(misty, binder, unsorted, iono, 1)
    assert own_cards(misty) == {iono: ('1', {'Trade Binder': '1'}), arven: ('1', {'Trade Binder': '1'})}
    # Reading the list moves no revision.
    before = revision_of(misty)
    own(misty)
    assert revision_of(misty) == before


def test_a_hidden_for_trade_location_is_listed_and_says_it_is_hidden_even_when_a_box_above_it_hides_it(store):
    ids = seed_swap_catalog()
    (misty, misty_handle), (ash, _) = friends('Misty W.', 'Ash K.')
    iono = ids['PAL 185']
    box = place(misty, 'Box')
    binder = place(misty, 'Binder', 'Box')
    hold(misty, binder, iono, 1)
    ok(mark(misty, binder))
    assert own(misty)['locations'] == [{'id': binder, 'name': 'Binder', 'path': ['Box', 'Binder'], 'hidden': False}]
    # Hiding the box above hides the binder from Friends; its card stays on both Trade Lists.
    hide(misty, box)
    assert own(misty)['locations'] == [{'id': binder, 'name': 'Binder', 'path': ['Box', 'Binder'], 'hidden': True}]
    assert own_cards(misty) == {iono: ('1', {'Box / Binder': '1'})}
    assert friend_cards(ash, misty_handle) == {iono: '1'}
    # Hiding the binder itself says the same.
    hide(misty, box, False)
    hide(misty, binder)
    assert own(misty)['locations'][0]['hidden'] is True
    assert friend_cards(ash, misty_handle) == {iono: '1'}


def test_a_deck_inside_a_for_trade_box_is_left_out_and_a_marked_binder_inside_a_marked_box_lists_each_copy_once(store):
    ids = seed_swap_catalog()
    (misty, misty_handle), (ash, _) = collector('Misty W.'), collector('Ash K.')
    befriend(ash, misty)
    iono, arven = ids['PAL 185'], ids['SVI 166']
    box = place(misty, 'Box')
    binder = place(misty, 'Binder', 'Box')
    hold(misty, binder, iono, 2)
    gardevoir = deck_in(misty, 'Gardevoir', box)
    hold(misty, gardevoir, arven, 2)
    line(misty, gardevoir, arven, 2)
    ok(mark(misty, binder))
    ok(mark(misty, box))
    assert own_cards(misty) == {iono: ('2', {'Box / Binder': '2'})}
    assert friend_cards(ash, misty_handle) == {iono: '2'}
    assert listed(ash) == {(misty, iono): 2}


def test_copies_a_loan_or_a_trade_promises_leave_both_lists_and_come_back_when_released(store):
    ids = seed_swap_catalog()
    (misty, misty_handle), (ash, _) = collector('Misty W.'), collector('Ash K.')
    befriend(ash, misty)
    iono = ids['PAL 185']
    binder = place(misty, 'Trade Binder')
    hold(misty, binder, iono, 3)
    ok(mark(misty, binder))

    def both():
        mine = own_cards(misty).get(iono, ('0', {}))
        theirs = friend_cards(ash, misty_handle).get(iono, '0')
        assert mine[0] == theirs, (mine, theirs)
        return mine

    assert both() == ('3', {'Trade Binder': '3'})
    # A Lend Offer promises one copy from the binder.
    loan = ok(offer(misty, ash, [(binder, iono, 1)]), 201)
    assert both() == ('2', {'Trade Binder': '2'})
    # A Trade promises another.
    trade = seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, binder, iono, 1)])
    assert both() == ('1', {'Trade Binder': '1'})
    # A second Trade promises the last copy: the card leaves both lists.
    last = seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, binder, iono, 1)])
    assert iono not in own_cards(misty) and friend_cards(ash, misty_handle) == {}
    # Released, they come back.
    close(last)
    close(trade, 'withdrawn')
    assert both() == ('2', {'Trade Binder': '2'})
    ok(step(misty, view(misty, loan), 'withdraw'))
    assert both() == ('3', {'Trade Binder': '3'})


def test_lent_copies_and_borrowed_copies_are_never_listed(store):
    ids = seed_swap_catalog()
    (misty, misty_handle), (ash, ash_handle) = collector('Misty W.'), collector('Ash K.')
    befriend(ash, misty)
    iono = ids['PAL 185']
    binder = place(misty, 'Trade Binder')
    hold(misty, binder, iono, 2)
    ok(mark(misty, binder))
    loan = ok(accept(misty, view(misty, sent(ash, misty, [(iono, 1)])), [(iono, 1)]))
    assert own_cards(misty) == {iono: ('1', {'Trade Binder': '1'})}
    # Handed over: the lent copy is in no Holding and stays off the list.
    assert handover(misty, loan).status_code == 200
    assert own_cards(misty) == {iono: ('1', {'Trade Binder': '1'})}
    # Ash's Borrowed Copy sits in his For trade Unsorted and is never on his list, nor shown to Misty.
    ok(mark(ash, node(ash, 'Unsorted')['id']))
    assert handover(ash, loan).status_code == 200
    assert own(ash) == {'locations': [], 'cards': []}
    assert friend_cards(misty, ash_handle) == {}
    assert listed(misty) == {}


def test_where_the_copies_sit_always_adds_up_to_the_listed_copies(store):
    ids = seed_swap_catalog()
    (misty, misty_handle), (ash, _) = collector('Misty W.'), collector('Ash K.')
    befriend(ash, misty)
    iono = ids['PAL 185']
    first, second, box = place(misty, 'Binder A'), place(misty, 'Binder B'), place(misty, 'Box')
    for location in (first, second, box):
        hold(misty, location, iono, 1)
    ok(mark(misty, first))
    ok(mark(misty, second))
    assert own_cards(misty) == {iono: ('2', {'Binder A': '1', 'Binder B': '1'})}
    # A Lend Offer picks the copy in the Box, which isn't For trade: both binder copies stay listed.
    ok(offer(misty, ash, [(box, iono, 1)]), 201)
    assert own_cards(misty) == {iono: ('2', {'Binder A': '1', 'Binder B': '1'})}
    # The Box's copy moves into Binder B; its pick still names the Box. Three are held there, one is promised: two are
    # listed, and the last Location in tree order gives way.
    move(misty, box, second, iono, 1)
    assert own_cards(misty) == {iono: ('2', {'Binder A': '1', 'Binder B': '1'})}
    # A Trade picks Binder A's copy: Binder A shows none, and only one copy is left to list.
    seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, first, iono, 1)])
    assert own_cards(misty) == {iono: ('1', {'Binder B': '1'})}
    assert [item['name'] for item in own(misty)['locations']] == ['Binder B']
    assert friend_cards(ash, misty_handle) == {iono: '1'}


def test_strangers_requests_blocks_either_way_and_your_own_handle_get_the_unknown_handle_answer(store):
    ids = seed_swap_catalog()
    (ash, ash_handle), (misty, misty_handle), (brock, brock_handle) = collector(), collector(), collector()
    binder = place(misty, 'Trade Binder')
    hold(misty, binder, ids['PAL 185'], 2)
    ok(mark(misty, binder))

    def refused(viewer, handle):
        response = friend_list(viewer, handle)
        assert response.status_code == 404
        return response.content

    # An unknown Handle, a Handle that can't exist, your own Handle and a stranger's all answer alike, byte for byte.
    assert refused(ash, 'fnobodyhasthis') == UNKNOWN
    assert refused(ash, 'x!') == UNKNOWN
    assert refused(misty, misty_handle) == UNKNOWN
    assert refused(ash, misty_handle) == UNKNOWN and listed(ash) == {}
    # A pending Friend Request, either way.
    ok(call('POST', '/api/social/friend-requests', ash, {'collector_id': misty, 'idempotency_key': str(uuid4())}))
    assert refused(ash, misty_handle) == UNKNOWN and refused(misty, ash_handle) == UNKNOWN
    assert listed(ash) == {} and listed(misty) == {}
    ok(call('POST', f'/api/social/friend-requests/{ash}/accept', misty, {'idempotency_key': str(uuid4())}))
    assert friend_cards(ash, misty_handle.upper()) == {ids['PAL 185']: '2'}
    # A Block either way ends it.
    befriend(brock, misty)
    block(misty, ash)
    assert refused(ash, misty_handle) == UNKNOWN and refused(misty, ash_handle) == UNKNOWN and listed(ash) == {}
    assert friend_cards(brock, misty_handle) == {ids['PAL 185']: '2'}
    block(brock, misty)
    assert refused(brock, misty_handle) == UNKNOWN and listed(brock) == {}
    assert refused(misty, brock_handle) == UNKNOWN


def test_own_and_friend_reads_give_the_same_count_from_the_one_rule(store):
    ids = seed_swap_catalog()
    (misty, misty_handle), (ash, _), (brock, _) = collector('Misty W.'), collector('Ash K.'), collector('Brock')
    befriend(ash, misty)
    befriend(brock, misty)
    iono, arven, boss = ids['PAL 185'], ids['SVI 166'], ids['PAL 172']
    binder, box = place(misty, 'Trade Binder'), place(misty, 'Box')
    hold(misty, binder, iono, 3)
    hold(misty, binder, arven, 1)
    hold(misty, box, boss, 2)
    ok(mark(misty, binder))
    gardevoir = deck_in(misty, 'Gardevoir', None)
    hold(misty, gardevoir, iono, 1)
    line(misty, gardevoir, iono, 1)
    seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, binder, iono, 1)])
    ok(offer(misty, brock, [(gardevoir, iono, 1)]), 201)
    expected = {iono: 2, arven: 1}
    with connect() as conn:
        rule = {str(row['edition_id']): row['listable'] for row in conn.execute(
            'SELECT edition_id, listable FROM trade_listable(ARRAY[%s]::text[], NULL)', (misty,))}
        mine = {str(edition): copies for edition, copies in own_trade_copies(conn, misty).items()}
        narrowed = own_trade_copies(conn, misty, [UUID(arven), UUID(boss)])
        assert own_trade_copies(conn, misty, []) == {}
    assert rule == mine == expected
    assert narrowed == {UUID(arven): 1}
    assert {edition: int(copies) for edition, (copies, _) in own_cards(misty).items()} == expected
    assert {edition: int(copies) for edition, copies in friend_cards(ash, misty_handle).items()} == expected
    assert listed(ash) == listed(brock) == {(misty, edition): copies for edition, copies in expected.items()}
    # The read narrows to the Friends and Editions asked about, and returns its own shape only.
    assert listed(ash, [misty], [arven, boss]) == {(misty, arven): 1}
    assert listed(ash, [ash, 'nobody']) == {} and listed(ash, []) == {} and listed(ash, None, []) == {}
    with connect() as conn:
        [item] = friend_trade_copies(conn, ash, [misty], [UUID(arven)])
    assert item == TradeCopies(friend_id=misty, edition_id=UUID(arven), listable=1)
    assert list(vars(item)) == ['friend_id', 'edition_id', 'listable']


def test_a_friends_trade_list_searches_and_pages_by_card_identity(store, monkeypatch):
    ids = seed_swap_catalog()
    (ash, _), (misty, misty_handle) = collector(), collector('Misty W.')
    befriend(ash, misty)
    unsorted = node(misty, 'Unsorted')['id']
    for key in ('PAL 185', 'PAF 80', 'SVI 166', 'SVI 166 Reverse Holo', 'PAL 172', 'SVE 5'):
        hold(misty, unsorted, ids[key], 1)
    ok(mark(misty, unsorted))
    body = ok(friend_list(ash, misty_handle))
    assert (body['collector_id'], body['handle'], body['display_name'], body['next_page']) == (
        misty, misty_handle, 'Misty W.', None)
    assert body['trader_id'] == trader_of(misty)
    assert [(card['name'], card['set_code'], card['copies']) for card in body['cards']] == [
        ('Arven', 'SVI', '1'), ('Arven', 'SVI', '1'), ('Basic Psychic Energy', 'sve', '1'),
        ("Boss's Orders", 'PAL', '1'), ('Iono', 'PAL', '1'), ('Iono', 'PAF', '1')]
    # Letters and digits only, any case.
    assert set(friend_cards(ash, misty_handle, q='BOSS%27S')) == {ids['PAL 172']}
    assert set(friend_cards(ash, misty_handle, q='io no')) == {ids['PAL 185'], ids['PAF 80']}
    assert friend_cards(ash, misty_handle, q='zzz') == {}
    for punctuation in ('!!!', '%2E%2E', '%20-%20'):
        page = ok(friend_list(ash, misty_handle, q=punctuation))
        assert page['cards'] == [] and page['next_page'] is None, punctuation
    # Two Card Identities a page: a card's Editions are never split, and pages come in card order.
    monkeypatch.setattr(trade_matches, 'PAGE_IDENTITIES', 2)
    first = ok(friend_list(ash, misty_handle))
    assert [card['name'] for card in first['cards']] == ['Arven', 'Arven', 'Basic Psychic Energy']
    assert first['next_page'] == 1
    second = ok(friend_list(ash, misty_handle, page=1))
    assert [(card['name'], card['set_code']) for card in second['cards']] == [
        ("Boss's Orders", 'PAL'), ('Iono', 'PAL'), ('Iono', 'PAF')]
    assert second['next_page'] is None
    beyond = ok(friend_list(ash, misty_handle, page=2))
    assert (beyond['cards'], beyond['next_page']) == ([], None)


def test_no_location_or_deck_name_or_id_reaches_a_friend_hidden_or_not(store):
    ids = seed_swap_catalog()
    (misty, misty_handle), (ash, _) = collector('Misty W.'), collector('Ash K.')
    befriend(ash, misty)
    secret = f'Secret {uuid4().hex[:8]}'
    iono, arven, boss = ids['PAL 185'], ids['SVI 166'], ids['PAL 172']
    box = place(misty, f'{secret} Box')
    binder = place(misty, f'{secret} Binder', f'{secret} Box')
    shelf = place(misty, f'{secret} Shelf')
    hold(misty, binder, iono, 2)
    hold(misty, shelf, boss, 1)
    lugia = deck_in(misty, f'{secret} Deck', box)
    hold(misty, lugia, arven, 1)
    line(misty, lugia, arven, 1)
    ok(mark(misty, box))
    ok(mark(misty, shelf))
    hide(misty, box)
    trade = seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, binder, iono, 1)])
    # The collector's own list names their Locations.
    assert own_cards(misty) == {iono: ('1', {f'{secret} Box / {secret} Binder': '1'}),
                                boss: ('1', {f'{secret} Shelf': '1'})}
    # Every Location and Deck id of Misty's, and the Trade's id.
    hidden_ids = [item['id'] for item in tree(misty)] + [str(trade)]
    for params in ({}, {'q': 'iono'}, {'page': 0}):
        response = friend_list(ash, misty_handle, **params)
        assert response.status_code == 200
        assert secret not in response.text
        assert not [found for found in hidden_ids if found in response.text], params
        assert all(set(card) == {'edition_id', 'name', 'set_code', 'set_name', 'collector_number', 'descriptor',
                                 'image_url', 'copies'} for card in response.json()['cards'])
    assert friend_cards(ash, misty_handle) == {iono: '1', boss: '1'}


def test_a_new_collector_has_an_empty_trade_list_and_reading_it_writes_nothing(store):
    seed_swap_catalog()
    newcomer = f'trade-list-{uuid4()}'
    assert own(newcomer) == {'locations': [], 'cards': []}
    with connect() as conn:
        assert conn.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s', (newcomer,)).fetchone() is None


# Trader reads (Trading #299): a collector in reach, by trader id.

COLLECTOR_UNKNOWN = b'{"detail":{"code":"COLLECTOR_NOT_FOUND"}}'
TRADER_LIST_FIELDS = {'trader_id', 'display_name', 'band', 'completed_trades', 'cards', 'next_page'}


def message_to(user, trader, body='hello'):
    """A message to a collector by trader id (test_conversations.say_to, which this module cannot import)."""
    return call('POST', f'/api/social/traders/{trader}/messages', user, {'body': body, 'idempotency_key': str(uuid4())})


def trader_list(viewer, trader, **params):
    query = '&'.join(f'{name}={value}' for name, value in params.items())
    return call('GET', f'/api/social/traders/{trader}/trade-list' + (f'?{query}' if query else ''), viewer)


def trader_header(viewer, trader):
    return call('GET', f'/api/social/traders/{trader}', viewer)


def test_a_nearby_strangers_trade_list_shows_only_listable_copies_with_a_band(store, monkeypatch):
    ids, ash, misty, binder, box = strangers()
    iono, arven, boss = ids['PAL 185'], ids['SVI 166'], ids['PAL 172']
    secret = f'Secret {uuid4().hex[:8]}'
    hidden_box = place(misty, f'{secret} Box')
    hold(misty, hidden_box, boss, 1)
    ok(mark(misty, hidden_box))
    hide(misty, hidden_box)
    seed_trade(misty, ash, gives=[(iono, 1)], picks=[('proposer', misty, binder, iono, 1)])
    with connect() as conn:
        handle = conn.execute('SELECT handle FROM collector_profile WHERE user_id = %s', (misty,)).fetchone()['handle']
    response = trader_list(ash, trader_of(misty))
    body = ok(response)
    assert set(body) == TRADER_LIST_FIELDS and body['band'] == '5_to_10'
    assert (body['trader_id'], body['display_name'], body['completed_trades']) == (trader_of(misty), 'Misty W.', 0)
    # The promised copy is left out; the hidden For trade Location's copy is listed.
    assert {card['edition_id']: card['copies'] for card in body['cards']} == {iono: '2', boss: '1'}
    assert misty not in response.text and handle.lower() not in response.text.lower() and secret not in response.text
    # Search and paging behave as on the Friend route.
    assert [card['edition_id'] for card in ok(trader_list(ash, trader_of(misty), q='BOSS%27S'))['cards']] == [boss]
    assert ok(trader_list(ash, trader_of(misty), q='zzz'))['cards'] == []
    monkeypatch.setattr(trade_matches, 'PAGE_IDENTITIES', 1)
    first = ok(trader_list(ash, trader_of(misty)))
    assert [card['edition_id'] for card in first['cards']] == [boss] and first['next_page'] == 1
    second = ok(trader_list(ash, trader_of(misty), page=1))
    assert [card['edition_id'] for card in second['cards']] == [iono] and second['next_page'] is None
    # The other direction lists Ash's own copies.
    assert [card['edition_id'] for card in ok(trader_list(misty, trader_of(ash)))['cards']] == [arven]


def test_the_trader_trade_list_needs_reach(store):
    ids, ash, misty, binder, box = strangers()
    far, _ = collector('Far W.')
    discoverable(far, far_zip())
    hold(far, place(far, 'Far Box'), ids['PAL 172'], 1)
    blocker, _ = collector('Blocker')
    blocked, _ = collector('Blocked')
    suspended, _ = collector('Suspended')
    for other in (blocker, blocked, suspended):
        discoverable(other, '00010')
    block(blocker, ash)
    block(ash, blocked)
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (suspended,))
    for other in (str(uuid4()), trader_of(ash), trader_of(far), trader_of(blocker), trader_of(blocked),
                  trader_of(suspended)):
        response = trader_list(ash, other)
        assert (response.status_code, response.content) == (404, COLLECTOR_UNKNOWN), other
    # Ex-Friends who share a conversation keep reading each other's Trade List, with no band.
    friend, _ = collector('Gary')
    befriend(ash, friend)
    ok(message_to(ash, trader_of(friend)), 201)
    ok(call('POST', f'/api/social/friends/{friend}/remove', ash, {'idempotency_key': str(uuid4())}))
    response = trader_list(ash, trader_of(friend))
    assert response.status_code == 200 and response.json()['band'] is None


def test_a_traders_header_answers_status_band_and_conversation(store):
    ids, ash, misty, binder, box = strangers()
    header = ok(trader_header(ash, trader_of(misty)))
    assert header == {'trader_id': trader_of(misty), 'display_name': 'Misty W.', 'friend': False, 'band': '5_to_10',
                      'completed_trades': 0, 'open_to_cash_offers': False, 'status': 'open', 'conversation_id': None,
                      'add_friend': None}
    ok(message_to(ash, trader_of(misty)), 201)
    assert ok(trader_header(ash, trader_of(misty)))['conversation_id'] is not None
    block(misty, ash)
    gone = ok(trader_header(ash, trader_of(misty)))
    assert (gone['status'], gone['band'], gone['completed_trades'], gone['add_friend'], gone['open_to_cash_offers']) == (
        'unavailable', None, None, None, False)
    with connect() as conn:
        conn.execute('DELETE FROM block')
    block(ash, misty)
    assert ok(trader_header(ash, trader_of(misty)))['status'] == 'you_blocked'
    # A far stranger with no conversation is unknown; a Friend is a Friend with no band.
    far, _ = collector('Far W.')
    discoverable(far, far_zip())
    response = trader_header(ash, trader_of(far))
    assert (response.status_code, response.content) == (404, COLLECTOR_UNKNOWN)
    friend, _ = collector('Gary')
    befriend(ash, friend)
    mate = ok(trader_header(ash, trader_of(friend)))
    assert (mate['friend'], mate['band'], mate['status']) == (True, None, 'open')
