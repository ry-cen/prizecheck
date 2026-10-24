"""Find trades among Friends (Trading #276): ``GET /api/social/trade-matches``, its per-Friend read and
``GET /api/social/trade-card-matches``, and ``friend_copies.friend_wants``, through signed HTTP against PostgreSQL.

A discovery row pairs the Friend's Trade List with the viewer's wants (the cards the viewer would get) and the viewer's
Trade List with the Friend's wants (the cards they would give). A want is a Want List need over the Decks, widened by its
Will accept choice, plus a Trade Wants line for the exact card. A Friend's Want List need is the one their own Want List
shows, over their Decks outside Hidden Locations; the viewer's own counts every Deck. Nothing names a Location or a Deck,
and nothing carries a price.

Every test seeds the Swap catalog (``want_list_swap_fixtures``: Iono PAL 185, PAL 254 and PAF 80; Arven SVI 166 in two
Editions; Boss's Orders PAL 172 in two Editions; Basic Psychic Energy SVE 5 and SVE 13, one Card Identity in two
Printings) and starts new collectors. Loans go through their routes; Trades are seeded rows
(``test_trade_promises.seed_trade``) released with ``test_trade_promises.close``. Open to cash offers is set through its
route (#277).
"""
import json
import threading
from uuid import UUID, uuid4

import pytest

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.social import friend_copies
from app.social.friend_copies import FriendWant, friend_wants
from stranger_fixtures import far_zip, strangers, trader_of
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import counting, deck, hold, line
from test_for_trade_locations import deck_in, hide, mark
from test_friend_copies import befriend, block, collector, node, ok, place
from test_handover import handover
from test_holdings import call
from test_lend_offers import offer, take
from test_loans import accept, sent
from test_open_discovery import discoverable
from test_trade_promises import close, seed_trade
from test_trade_wants import set_rule, set_want
from want_list_swap_fixtures import seed_swap_catalog

UNKNOWN = b'{"detail":{"code":"FRIEND_NOT_FOUND"}}'
ROW_FIELDS = {'collector_id', 'trader_id', 'handle', 'display_name', 'completed_trades', 'open_to_cash_offers', 'match',
              'you_get', 'you_give', 'more_you_get', 'more_you_give'}
CARD_FIELDS = {'edition_id', 'name', 'set_code', 'set_name', 'collector_number', 'descriptor', 'image_url', 'copies',
               'need', 'want_list_need', 'origin', 'accepts_as'}


def matches(viewer):
    return ok(call('GET', '/api/social/trade-matches', viewer))


def one(viewer, friend):
    return call('GET', f'/api/social/trade-matches/{friend}', viewer)


def order(viewer):
    """The rows as [(Display Name, match kind)], in the answer's order."""
    return [(row['display_name'], row['match']) for row in matches(viewer)['rows']]


def cards(found):
    """One side of a row as {Edition: (copies, need, want_list_need, origin, accepts_as)}."""
    return {card['edition_id']: (card['copies'], card['need'], card['want_list_need'], card['origin'],
                                 card['accepts_as']) for card in found}


def row_of(viewer, friend):
    """The Friend's row as (you_get, you_give) cards, or None when they have no row."""
    found = [row for row in matches(viewer)['rows'] if row['collector_id'] == friend]
    return (cards(found[0]['you_get']), cards(found[0]['you_give'])) if found else None


def gets(viewer, friend):
    found = row_of(viewer, friend)
    return found[0] if found else {}


def gives(viewer, friend):
    found = row_of(viewer, friend)
    return found[1] if found else {}


def binder(owner, name='Trade Binder'):
    """A new Location of the owner marked For trade; returns its id."""
    found = place(owner, name)
    ok(mark(owner, found))
    return found


def needed(owner, edition):
    """The owner's own Want List total for one Edition (0 when it needs none)."""
    body = ok(call('GET', '/api/want-list', owner))
    return next((int(row['need']) for row in body['combined'] if row['edition_id'] == edition), 0)


def open_to_cash(owner, value=True):
    ok(call('PUT', '/api/social/trade-settings', owner, {'open_to_cash_offers': value}))


def printing_of(edition):
    with connect() as conn:
        return str(conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s', (edition,)).fetchone()['printing_id'])


def offers(viewer, printing):
    return ok(call('GET', f'/api/social/trade-card-matches?printing_id={printing}', viewer))


def wants_of(viewer, friends=None, editions=None):
    """friend_wants as {(Friend, Edition): (want_list_need, trade_wants_quantity, rule)}."""
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        found = friend_wants(conn, viewer, friends, None if editions is None else [UUID(e) for e in editions])
    return {(item.friend_id, str(item.edition_id)): (item.want_list_need, item.trade_wants_quantity, item.rule)
            for item in found}


# Ordering and matching.


def test_rows_come_two_way_first_then_has_then_wants_and_ties_break_by_display_name_then_handle(store):
    ids = seed_swap_catalog()
    viewer, _ = collector('Misty W.')
    iono, arven, boss = ids['PAL 185'], ids['SVI 166'], ids['PAL 254']
    ok(set_want(viewer, iono, 1))
    hold(viewer, binder(viewer), arven, 1)
    people = {name: collector(name) for name in ('Zed', 'Brock', 'Ash K.', 'ash k.', 'Gary', 'Nobody')}
    for friend, _ in people.values():
        befriend(viewer, friend)
    for name in ('Zed', 'Brock', 'Ash K.', 'ash k.'):
        hold(people[name][0], binder(people[name][0]), iono, 1)
    for name in ('Zed', 'Brock', 'Gary'):
        ok(set_want(people[name][0], arven, 1))
    # Nobody offers a card the viewer doesn't want and wants one the viewer doesn't list: no row.
    hold(people['Nobody'][0], binder(people['Nobody'][0]), boss, 1)
    ok(set_want(people['Nobody'][0], ids['PAF 80'], 1))
    same_name = sorted(('Ash K.', 'ash k.'), key=lambda name: people[name][1].casefold())
    assert order(viewer) == [('Brock', 'two_way'), ('Zed', 'two_way'), (same_name[0], 'has_what_you_want'),
                             (same_name[1], 'has_what_you_want'), ('Gary', 'wants_what_you_have')]
    body = matches(viewer)
    assert body['has_friends'] is True
    for row in body['rows']:
        assert set(row) == ROW_FIELDS
        assert all(set(card) == CARD_FIELDS for card in row['you_get'] + row['you_give'])
        assert (row['more_you_get'], row['more_you_give']) == (0, 0)
    brock = body['rows'][0]
    assert (brock['collector_id'], brock['handle'], brock['open_to_cash_offers']) == (
        people['Brock'][0], people['Brock'][1], False)
    # Open to cash offers is the Friend's own setting, on their row.
    open_to_cash(people['Gary'][0])
    assert [row['open_to_cash_offers'] for row in matches(viewer)['rows'] if row['display_name'] == 'Gary'] == [True]


def test_each_will_accept_rule_matches_its_cards_and_says_the_narrowest_way(store):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    gardevoir = deck(viewer, 'Gardevoir', 0)
    for key in ('PAL 172', 'SVE 13', 'SVI 166'):
        line(viewer, gardevoir, ids[key], 1)
    shelf = binder(friend)
    for key, copies in (('PAL 172 Reverse Holo', 2), ('SVE 5', 3), ('SVI 166 Reverse Holo', 1), ('SVI 166', 1)):
        hold(friend, shelf, ids[key], copies)
    # This exact card, the default, takes only the Edition itself.
    assert gets(viewer, friend) == {ids['SVI 166']: ('1', '1', '1', 'want_list', 'exact')}
    # Any finish takes the other finish of the Printing; any card with the same name takes another Printing of the same
    # Card Identity.
    ok(set_rule(viewer, ids['PAL 172'], 'printing'))
    ok(set_rule(viewer, ids['SVE 13'], 'identity'))
    assert gets(viewer, friend) == {ids['SVI 166']: ('1', '1', '1', 'want_list', 'exact'),
                                    ids['PAL 172 Reverse Holo']: ('2', '1', '1', 'want_list', 'any_finish'),
                                    ids['SVE 5']: ('3', '1', '1', 'want_list', 'same_name')}
    # The narrowest way is how the card relates to the want: another finish is "any finish" under either rule.
    ok(set_rule(viewer, ids['PAL 172'], 'identity'))
    assert gets(viewer, friend)[ids['PAL 172 Reverse Holo']][4] == 'any_finish'
    # Two wants that accept one card add up, and the card that is itself wanted is exact.
    line(viewer, gardevoir, ids['SVE 5'], 2)
    assert gets(viewer, friend)[ids['SVE 5']] == ('3', '3', '3', 'want_list', 'exact')
    # A Friend's choice widens what they would take of the viewer's cards.
    lost = deck(friend, 'Lost Box', 0)
    line(friend, lost, ids['SVE 13'], 2)
    hold(viewer, binder(viewer), ids['SVE 5'], 1)
    assert gives(viewer, friend) == {}
    ok(set_rule(friend, ids['SVE 13'], 'identity'))
    assert gives(viewer, friend) == {ids['SVE 5']: ('1', '2', '2', 'want_list', None)}
    ok(set_rule(friend, ids['SVE 13'], 'edition'))
    assert gives(viewer, friend) == {}


def test_trade_wants_always_match_the_exact_card_even_with_a_widened_choice_left_over(store):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    # A choice that outlived its Want List line widens nothing for a Trade Wants line of the same card.
    ok(set_rule(viewer, ids['SVE 13'], 'identity'))
    ok(set_want(viewer, ids['SVE 13'], 2))
    shelf = binder(friend)
    hold(friend, shelf, ids['SVE 5'], 1)
    assert row_of(viewer, friend) is None
    hold(friend, shelf, ids['SVE 13'], 1)
    assert gets(viewer, friend) == {ids['SVE 13']: ('1', '2', '0', 'trade_wants', 'exact')}
    # The same for a Friend's Trade Wants line.
    ok(set_rule(friend, ids['PAL 172'], 'printing'))
    ok(set_want(friend, ids['PAL 172'], 3))
    mine = binder(viewer)
    hold(viewer, mine, ids['PAL 172 Reverse Holo'], 1)
    assert gives(viewer, friend) == {}
    hold(viewer, mine, ids['PAL 172'], 1)
    assert gives(viewer, friend) == {ids['PAL 172']: ('1', '3', '0', 'trade_wants', None)}


def test_need_adds_trade_wants_to_what_the_decks_need_and_origin_says_which(store):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    gardevoir = deck(viewer, 'Gardevoir', 0)
    line(viewer, gardevoir, ids['PAL 254'], 2)
    line(viewer, gardevoir, ids['PAF 80'], 1)
    ok(set_want(viewer, ids['PAL 254'], 4))
    ok(set_want(viewer, ids['SVI 166'], 1))
    shelf = binder(friend)
    for key in ('PAL 254', 'PAF 80', 'SVI 166'):
        hold(friend, shelf, ids[key], 5)
    # Decks need 2 and Trade Wants say 4: 6 wanted, 2 for Decks.
    assert gets(viewer, friend) == {ids['PAL 254']: ('5', '6', '2', 'both', 'exact'),
                                    ids['PAF 80']: ('5', '1', '1', 'want_list', 'exact'),
                                    ids['SVI 166']: ('5', '1', '0', 'trade_wants', 'exact')}
    # The Friend's side reads the same way.
    lost = deck(friend, 'Lost Box', 0)
    line(friend, lost, ids['PAL 172'], 2)
    ok(set_want(friend, ids['PAL 172'], 4))
    hold(viewer, binder(viewer), ids['PAL 172'], 1)
    assert gives(viewer, friend) == {ids['PAL 172']: ('1', '6', '2', 'both', None)}
    # Trade Wants never change the Want List's own figures.
    assert needed(viewer, ids['PAL 254']) == 2 and needed(friend, ids['PAL 172']) == 2


@pytest.mark.parametrize('setting', ['all_at_once', 'one_at_a_time'])
def test_a_need_follows_each_sides_counting_setting(store, setting):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    iono, arven = ids['PAL 185'], ids['SVI 166']
    # The Friend: two Decks each list 2 Iono, and one loose copy.
    for days in (0, 1):
        line(friend, deck(friend, f'Iono {days}', days), iono, 2)
    hold(friend, node(friend, 'Unsorted')['id'], iono, 1)
    hold(viewer, binder(viewer), iono, 5)
    # The viewer: two Decks each list 2 Arven, none owned.
    for days in (0, 1):
        line(viewer, deck(viewer, f'Arven {days}', days), arven, 2)
    hold(friend, binder(friend), arven, 5)
    counting(friend, setting)
    counting(viewer, setting)
    their_need, my_need = (3, 4) if setting == 'all_at_once' else (1, 2)
    assert gives(viewer, friend)[iono][1:3] == (str(their_need), str(their_need))
    assert gets(viewer, friend)[arven][1:3] == (str(my_need), str(my_need))
    # Each is what that collector's own Want List shows.
    assert needed(friend, iono) == their_need and needed(viewer, arven) == my_need


@pytest.mark.parametrize('setting', ['all_at_once', 'one_at_a_time'])
def test_a_friends_need_counts_the_copies_they_promised_lent_and_borrowed_as_their_want_list_does(store, setting):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _), (gary, _) = collector('Misty W.'), collector('Ash K.'), collector('Gary')
    befriend(viewer, friend)
    befriend(friend, gary)
    iono, boss, arven = ids['PAL 185'], ids['PAL 254'], ids['SVI 166']
    counting(friend, setting)
    unsorted = node(friend, 'Unsorted')['id']
    mine = binder(viewer)
    for edition in (iono, boss, arven):
        hold(viewer, mine, edition, 5)
    gardevoir = deck(friend, 'Gardevoir', 0)
    line(friend, gardevoir, iono, 3)
    line(friend, gardevoir, boss, 1)
    line(friend, gardevoir, arven, 1)
    hold(friend, unsorted, iono, 3)
    hold(friend, unsorted, boss, 1)

    def theirs():
        found = gives(viewer, friend)
        for edition in (iono, boss, arven):
            assert int(found.get(edition, ('0', '0'))[1]) == needed(friend, edition), edition
        return {edition: found[edition][1] for edition in found}

    assert theirs() == {arven: '1'}
    # A Lend Offer promises an Iono: it is no longer a Spare Copy, so the Deck needs one more.
    loan = ok(offer(friend, gary, [(unsorted, iono, 1)]), 201)
    assert theirs() == {arven: '1', iono: '1'}
    # Handed over, the lent copy still counts for the Deck: the need goes again.
    ok(take(gary, loan, [(iono, 1)]))
    ok(handover(friend, loan))
    ok(handover(gary, loan))
    assert theirs() == {arven: '1'}
    # A Trade promises the Boss's Orders the Deck counted.
    trade = seed_trade(friend, gary, gives=[(boss, 1)], picks=[('proposer', friend, unsorted, boss, 1)])
    assert theirs() == {arven: '1', boss: '1'}
    close(trade)
    assert theirs() == {arven: '1'}
    # A Borrowed Copy in the Deck fills its own line.
    hold(gary, node(gary, 'Unsorted')['id'], arven, 1)
    borrow = ok(accept(gary, sent(friend, gary, [(arven, 1)], deck_id=gardevoir), [(arven, 1)]))
    ok(handover(gary, borrow))
    ok(handover(friend, borrow))
    assert theirs() == {}


def test_a_card_is_offered_only_while_the_friends_copy_is_not_promised(store):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _), (gary, _) = collector('Misty W.'), collector('Ash K.'), collector('Gary')
    befriend(viewer, friend)
    befriend(friend, gary)
    paf = ids['PAF 80']
    line(viewer, deck(viewer, 'Iono', 0), paf, 1)
    shelf = binder(friend)
    hold(friend, shelf, paf, 1)
    assert gets(viewer, friend) == {paf: ('1', '1', '1', 'want_list', 'exact')}
    trade = seed_trade(friend, gary, gives=[(paf, 1)], picks=[('proposer', friend, shelf, paf, 1)])
    assert row_of(viewer, friend) is None
    close(trade, 'withdrawn')
    assert gets(viewer, friend) == {paf: ('1', '1', '1', 'want_list', 'exact')}


# Hidden Locations.


def test_a_hidden_older_deck_still_takes_spare_copies_from_a_friends_view(store):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    iono = ids['PAL 185']
    hold(viewer, binder(viewer), iono, 3)
    # Every Deck built at once: the Friend holds 1 Iono, an older hidden Deck needs 1 and a newer visible Deck needs 1.
    older, newer = deck(friend, 'Older', 0), deck(friend, 'Newer', 1)
    line(friend, older, iono, 1)
    line(friend, newer, iono, 1)
    hold(friend, node(friend, 'Unsorted')['id'], iono, 1)
    hide(friend, older)
    # The older Deck took the spare copy, so the visible Deck needs 1: the Friend's own figure for it, not 0 or 2.
    assert gives(viewer, friend) == {iono: ('3', '1', '1', 'want_list', None)}
    shown = ok(call('GET', f'/api/want-list?deck={newer}', friend))['to_get']
    assert shown == '1'
    assert wants_of(viewer) == {(friend, iono): (1, 0, 'edition')}


def test_wants_from_decks_in_hidden_locations_are_absent_while_the_viewers_own_hidden_decks_count(store):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    arven, boss, paf = ids['SVI 166'], ids['PAL 254'], ids['PAF 80']
    mine = binder(viewer)
    hold(viewer, mine, arven, 1)
    hold(viewer, mine, boss, 1)
    # A hidden Deck, and a Deck inside a hidden box.
    hidden = deck(friend, 'Hidden Deck', 0)
    line(friend, hidden, arven, 2)
    box = place(friend, 'Box')
    boxed = deck_in(friend, 'Boxed Deck', box)
    line(friend, boxed, boss, 1)
    assert gives(viewer, friend) == {arven: ('1', '2', '2', 'want_list', None), boss: ('1', '1', '1', 'want_list', None)}
    hide(friend, hidden)
    hide(friend, box)
    assert row_of(viewer, friend) is None
    # Their own Want List still counts both.
    assert needed(friend, arven) == 2 and needed(friend, boss) == 1
    # The viewer's own hidden Deck still says what the viewer wants.
    secret = deck(viewer, 'Secret', 0)
    line(viewer, secret, paf, 1)
    hide(viewer, secret)
    hold(friend, binder(friend), paf, 1)
    assert gets(viewer, friend) == {paf: ('1', '1', '1', 'want_list', 'exact')}


# Owned spares.


def test_owned_spares_of_an_accepted_card_reduce_no_need_until_the_line_is_switched(store):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    sve5, sve13 = ids['SVE 5'], ids['SVE 13']
    # The viewer's Deck needs SVE 13, takes any card with the same name, and owns a spare SVE 5.
    mine = deck(viewer, 'Psychic', 0)
    line(viewer, mine, sve13, 1)
    ok(set_rule(viewer, sve13, 'identity'))
    hold(viewer, node(viewer, 'Unsorted')['id'], sve5, 1)
    hold(friend, binder(friend), sve13, 1)
    assert gets(viewer, friend) == {sve13: ('1', '1', '1', 'want_list', 'exact')}
    # The Friend likewise: their Deck needs 2 SVE 13, their For trade copy fills one, and their spare SVE 5 none.
    theirs = deck(friend, 'Psychic', 0)
    line(friend, theirs, sve13, 2)
    ok(set_rule(friend, sve13, 'identity'))
    hold(friend, node(friend, 'Unsorted')['id'], sve5, 1)
    hold(viewer, binder(viewer), sve13, 1)
    assert gives(viewer, friend) == {sve13: ('1', '1', '1', 'want_list', None)}
    # Switching one of the Friend's copies to the spare they own removes the want.
    line(friend, theirs, sve13, 1)
    line(friend, theirs, sve5, 1)
    assert gives(viewer, friend) == {}


# Size, non-matches and who sees what.


def extra_editions(count):
    """``count`` catalog Editions of Arven SVI 166's Printing, for rows longer than a row carries."""
    with connect() as conn:
        printing = conn.execute("SELECT id FROM catalog_printing WHERE source_id='sv01-166'").fetchone()['id']
        return [str(row['id']) for row in conn.execute(
            """INSERT INTO catalog_edition(printing_id, descriptor_key, descriptor)
              SELECT %s, 'extra-' || n, jsonb_build_object('label', 'Extra ' || n) FROM generate_series(1, %s) n
              RETURNING id""", (printing, count))]


def fill(owner, location, editions):
    """One copy of each Edition in the Location, and a Trade Wants line of 1 for each of ``wants``, written directly."""
    with connect() as conn:
        conn.execute("""INSERT INTO holding(owner_id, location_id, edition_id, quantity, version)
          SELECT %s, %s, unnest(%s::uuid[]), 1, 1""", (owner, location, editions))


def want(owner, editions):
    with connect() as conn:
        conn.execute('INSERT INTO trade_want(owner_id, edition_id, quantity) SELECT %s, unnest(%s::uuid[]), 1',
                     (owner, editions))


def test_a_row_carries_20_cards_a_side_and_counts_the_rest_and_the_friends_read_has_every_card(store):
    seed_swap_catalog()
    (viewer, _), (friend, _) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    extra = extra_editions(44)
    getting, giving = extra[:23], extra[23:]
    want(viewer, getting)
    fill(friend, binder(friend), getting)
    want(friend, giving)
    fill(viewer, binder(viewer), giving)
    [row] = matches(viewer)['rows']
    assert row['match'] == 'two_way' and (row['more_you_get'], row['more_you_give']) == (3, 1)
    # Card order: one name, set and number, so by Edition id.
    assert [card['edition_id'] for card in row['you_get']] == sorted(getting, key=UUID)[:20]
    assert [card['edition_id'] for card in row['you_give']] == sorted(giving, key=UUID)[:20]
    full = ok(one(viewer, friend))
    assert set(full) == ROW_FIELDS and (full['more_you_get'], full['more_you_give']) == (0, 0)
    assert [card['edition_id'] for card in full['you_get']] == sorted(getting, key=UUID)
    assert [card['edition_id'] for card in full['you_give']] == sorted(giving, key=UUID)
    assert {key: full[key] for key in ('collector_id', 'display_name', 'match')} == {
        'collector_id': friend, 'display_name': 'Ash K.', 'match': 'two_way'}


def test_a_friend_who_matches_nothing_has_no_row_and_their_read_says_so(store):
    ids = seed_swap_catalog()
    (viewer, _), (friend, handle) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    assert matches(viewer) == {'has_friends': True, 'rows': []}
    assert ok(one(viewer, friend)) == {
        'collector_id': friend, 'trader_id': trader_of(friend), 'handle': handle, 'display_name': 'Ash K.',
        'completed_trades': 0, 'open_to_cash_offers': False, 'match': None, 'you_get': [], 'you_give': [], 'more_you_get': 0, 'more_you_give': 0}
    # Discovery reads the current Trade List and wants on every open.
    ok(set_want(viewer, ids['PAL 185'], 1))
    shelf = binder(friend)
    hold(friend, shelf, ids['PAL 185'], 1)
    assert order(viewer) == [('Ash K.', 'has_what_you_want')]
    ok(set_want(viewer, ids['PAL 185'], 0))
    assert matches(viewer)['rows'] == []


def test_a_collector_with_no_friends_is_told_so(store):
    ids = seed_swap_catalog()
    viewer, _ = collector('Misty W.')
    ok(set_want(viewer, ids['PAL 185'], 1))
    assert matches(viewer) == {'has_friends': False, 'rows': []}
    assert offers(viewer, printing_of(ids['PAL 185'])) == {'has_friends': False, 'offers': []}


def test_strangers_requests_and_blocks_either_way_see_no_row_and_their_read_answers_as_an_unknown_id(store):
    ids = seed_swap_catalog()
    viewer, _ = collector('Misty W.')
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ok(set_want(viewer, iono, 1))
    hold(viewer, binder(viewer), arven, 1)
    others = {name: collector(name)[0] for name in ('Stranger', 'Pending', 'Blocked', 'Blocker', 'Friend')}
    for owner in others.values():
        hold(owner, binder(owner), iono, 1)
        ok(set_want(owner, arven, 1))
    ok(call('POST', '/api/social/friend-requests', viewer,
            {'collector_id': others['Pending'], 'idempotency_key': str(uuid4())}))
    for name in ('Blocked', 'Blocker', 'Friend'):
        befriend(viewer, others[name])
    block(viewer, others['Blocked'])
    block(others['Blocker'], viewer)
    assert order(viewer) == [('Friend', 'two_way')]
    for collector_id in (others['Stranger'], others['Pending'], others['Blocked'], others['Blocker'], viewer,
                         f'nobody-{uuid4()}'):
        refused = one(viewer, collector_id)
        assert (refused.status_code, refused.content) == (404, UNKNOWN), collector_id
    assert [offer_['display_name'] for offer_ in offers(viewer, printing_of(iono))['offers']] == ['Friend']
    # And none of them sees the viewer.
    for name in ('Stranger', 'Pending', 'Blocked', 'Blocker'):
        assert matches(others[name])['rows'] == [], name


def test_no_answer_names_a_location_or_a_deck_or_carries_a_value(store):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    iono, arven = ids['PAL 185'], ids['SVI 166']
    hidden_box = place(friend, 'Secret Box')
    shelf = place(friend, 'Secret Shelf', 'Secret Box')
    ok(mark(friend, shelf))
    hold(friend, shelf, iono, 2)
    hide(friend, hidden_box)
    lost = deck(friend, 'Lost Zone Box', 0)
    line(friend, lost, arven, 1)
    mine = binder(viewer, 'Misty Binder')
    hold(viewer, mine, arven, 1)
    gardevoir = deck(viewer, 'Gardevoir Control', 0)
    line(viewer, gardevoir, iono, 1)
    names = [node(friend, 'Secret Box')['name'], 'Secret Shelf', node(friend, lost)['name'], 'Misty Binder',
             node(viewer, gardevoir)['name']]
    places = [hidden_box, shelf, lost, mine, gardevoir, node(friend, 'Unsorted')['id']]
    answers = [matches(viewer), ok(one(viewer, friend)), offers(viewer, printing_of(iono)), matches(friend)]
    assert answers[0]['rows'][0]['match'] == 'two_way' and answers[2]['offers']
    text = json.dumps(answers)
    for word in names + places:
        assert word not in text, word
    keys = set()

    def walk(value):
        if isinstance(value, dict):
            for key, item in value.items():
                keys.add(key)
                if key != 'descriptor':
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(answers)
    assert not {key for key in keys if any(word in key for word in ('price', 'value', 'cost', 'total', 'quote',
                                                                     'location', 'deck', 'estimate'))}, keys


def test_open_to_cash_offers_from_its_route_marks_one_way_rows_only_while_on(store):
    ids = seed_swap_catalog()
    viewer, _ = collector('Misty W.')
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ok(set_want(viewer, iono, 1))
    hold(viewer, binder(viewer), arven, 1)
    seller, _ = collector('Brock')
    buyer, _ = collector('Gary')
    for friend in (seller, buyer):
        befriend(viewer, friend)
    hold(seller, binder(seller), iono, 1)          # has what the viewer wants
    ok(set_want(buyer, arven, 1))                  # wants what the viewer has
    assert [row['match'] for row in matches(viewer)['rows']] == ['has_what_you_want', 'wants_what_you_have']

    def flags():
        rows = {row['collector_id']: row for row in matches(viewer)['rows']}
        single = {friend: ok(one(viewer, friend)) for friend in (seller, buyer)}
        assert all(rows[friend] == single[friend] for friend in (seller, buyer))
        return [rows[seller]['open_to_cash_offers'], rows[buyer]['open_to_cash_offers']]
    assert flags() == [False, False]
    open_to_cash(seller)
    open_to_cash(buyer)
    assert flags() == [True, True]
    open_to_cash(seller, False)
    assert flags() == [False, True]
    assert [row['match'] for row in matches(viewer)['rows']] == ['has_what_you_want', 'wants_what_you_have']


# Ask to trade.


def test_ask_to_trade_lists_each_friends_copies_of_the_printings_editions_and_nothing_else(store):
    ids = seed_swap_catalog()
    viewer, _ = collector('Misty W.')
    people = {name: collector(name)[0] for name in ('Brock', 'Ash K.', 'Gary', 'Dawn')}
    for owner in people.values():
        befriend(viewer, owner)
    normal, reverse = ids['PAL 172'], ids['PAL 172 Reverse Holo']
    brock_binder = binder(people['Brock'])
    hold(people['Brock'], brock_binder, normal, 2)
    hold(people['Brock'], brock_binder, reverse, 1)
    # A hidden For trade binder still lists its cards.
    ash_binder = binder(people['Ash K.'])
    hold(people['Ash K.'], ash_binder, reverse, 1)
    hide(people['Ash K.'], ash_binder)
    # Copies outside For trade Locations, and promised copies, are not on offer.
    hold(people['Gary'], node(people['Gary'], 'Unsorted')['id'], normal, 3)
    dawn_binder = binder(people['Dawn'])
    hold(people['Dawn'], dawn_binder, normal, 1)
    trade = seed_trade(people['Dawn'], viewer, gives=[(normal, 1)], picks=[('proposer', people['Dawn'], dawn_binder,
                                                                             normal, 1)])
    body = offers(viewer, printing_of(normal))
    assert body['has_friends'] is True
    # The two Editions of one Printing tie on name, set and number, so card order falls to the Edition id.
    brock = sorted([('Brock', normal, '2'), ('Brock', reverse, '1')], key=lambda item: UUID(item[1]))
    assert [(item['display_name'], item['edition_id'], item['copies']) for item in body['offers']] == [
        ('Ash K.', reverse, '1'), *brock]
    assert set(body['offers'][0]) == {'collector_id', 'handle', 'display_name', 'edition_id', 'name', 'set_code',
                                      'set_name', 'collector_number', 'descriptor', 'image_url', 'copies'}
    assert (body['offers'][1]['collector_id'], body['offers'][1]['name'], body['offers'][1]['set_code'],
            body['offers'][1]['collector_number']) == (people['Brock'], "Boss's Orders", 'PAL', '172')
    close(trade, 'withdrawn')
    assert ('Dawn', normal, '1') in [(item['display_name'], item['edition_id'], item['copies'])
                                     for item in offers(viewer, printing_of(normal))['offers']]
    # A Printing nobody lists, and an unknown one, have no offers.
    assert offers(viewer, printing_of(ids['PAF 80']))['offers'] == []
    assert offers(viewer, uuid4())['offers'] == []


# The read itself.


def test_discovery_never_waits_on_a_friends_locks(store):
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector('Misty W.'), collector('Ash K.')
    befriend(viewer, friend)
    iono = ids['PAL 185']
    line(viewer, deck(viewer, 'Iono', 0), iono, 1)
    line(friend, deck(friend, 'Iono', 0), ids['SVI 166'], 1)
    hold(viewer, binder(viewer), ids['SVI 166'], 1)
    hold(friend, binder(friend), iono, 1)
    answered = {}
    with connect() as held, held.transaction():
        # The Friend's owner row and every Holding of theirs, locked as their own writes lock them.
        held.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE', (friend,))
        held.execute('SELECT 1 FROM holding WHERE owner_id=%s FOR UPDATE', (friend,))
        held.execute('SELECT 1 FROM deck_list_line WHERE owner_id=%s FOR UPDATE', (friend,))
        reader = threading.Thread(target=lambda: answered.update(body=matches(viewer)), daemon=True)
        reader.start()
        reader.join(timeout=20)
        assert not reader.is_alive(), 'discovery waited on a lock the Friend holds'
    assert answered['body']['rows'][0]['match'] == 'two_way'


class Counted:
    """A connection that counts the statements run on it."""

    def __init__(self, conn):
        self.conn, self.statements = conn, 0

    def execute(self, *args, **kwargs):
        self.statements += 1
        return self.conn.execute(*args, **kwargs)


def test_friend_wants_reads_as_many_statements_for_one_friend_as_for_many(store):
    ids = seed_swap_catalog()
    viewer, _ = collector('Misty W.')
    friends = [collector(name)[0] for name in ('Ash K.', 'Brock', 'Gary')]
    editions = [UUID(ids[key]) for key in ('PAL 185', 'SVI 166', 'SVE 13')]
    for index, friend in enumerate(friends):
        befriend(viewer, friend)
        line(friend, deck(friend, 'Deck', index), ids['PAL 185'], 2)
        ok(set_want(friend, ids['SVI 166'], 1))
        ok(set_rule(friend, ids['PAL 185'], 'printing'))
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        alone, together = Counted(conn), Counted(conn)
        first = friend_wants(alone, viewer, friends[:1], editions)
        every = friend_wants(together, viewer, None, editions)
    # Asking about every Friend lists them first (``TRADE_FRIENDS``, one statement), so the count is constant whatever the
    # number of Friends: one more than asking about one Friend by id.
    assert together.statements == alone.statements + 1
    assert first == sorted([FriendWant(friends[0], UUID(ids['PAL 185']), 2, 0, 'printing'),
                            FriendWant(friends[0], UUID(ids['SVI 166']), 0, 1, 'edition')],
                           key=lambda item: item.edition_id)
    assert sorted(every, key=lambda item: (item.friend_id, item.edition_id)) == every
    assert {(item.friend_id, str(item.edition_id)) for item in every} == {
        (friend, ids[key]) for friend in friends for key in ('PAL 185', 'SVI 166')}
    # Asked about other Editions, nobody is allocated at all.
    assert wants_of(viewer, None, [ids['PAF 80']]) == {}


def test_the_friend_wants_statements_never_name_a_location_or_deck_in_what_they_answer():
    # They may read Locations and Borrowed Copies to count a Friend's own Deck lines, but every answer is a count or a
    # rule per Friend and Edition.
    assert set(FriendWant.__dataclass_fields__) == {'friend_id', 'edition_id', 'want_list_need', 'trade_wants_quantity',
                                                    'rule'}
    assert 'borrowed_holding' not in friend_copies.TRADE_READ and 'borrowed_holding' not in friend_copies.READ


# Trader reads (Trading #299): the match row of a collector in reach, by trader id.

TRADER_FIELDS = {'trader_id', 'display_name', 'band', 'completed_trades', 'open_to_cash_offers', 'match', 'you_get',
                 'you_give', 'more_you_get', 'more_you_give'}
COLLECTOR_UNKNOWN = b'{"detail":{"code":"COLLECTOR_NOT_FOUND"}}'


def trader_row(viewer, trader):
    return call('GET', f'/api/social/traders/{trader}/matches', viewer)


def suspend_user(user, value=True):
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = CASE WHEN %s THEN now() END WHERE user_id = %s',
                     (value, user))


def test_a_traders_row_answers_a_nearby_stranger_with_every_card(store):
    ids, ash, misty, binder_, box = strangers()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ok(set_want(ash, iono, 2))
    ok(set_want(misty, arven, 1))
    row = ok(trader_row(ash, trader_of(misty)))
    assert set(row) == TRADER_FIELDS
    assert (row['match'], row['more_you_get'], row['more_you_give'], row['band']) == ('two_way', 0, 0, '5_to_10')
    assert (row['trader_id'], row['display_name'], row['completed_trades']) == (trader_of(misty), 'Misty W.', 0)
    assert [card['edition_id'] for card in row['you_get']] == [iono]
    assert [card['edition_id'] for card in row['you_give']] == [arven]
    with connect() as conn:
        misty_handle = conn.execute('SELECT handle FROM collector_profile WHERE user_id = %s', (misty,)).fetchone()['handle']
    text = json.dumps(row)
    assert misty not in text and misty_handle.lower() not in text.lower()
    # Strangers are in no Friend discovery, though the trader route sees them.
    assert matches(ash) == {'has_friends': False, 'rows': []}


def test_a_strangers_hidden_deck_wants_stay_out_of_their_row(store):
    ids, ash, misty, binder_, box = strangers()
    arven = ids['SVI 166']
    hidden = deck(misty, 'Hidden Deck', 0)
    line(misty, hidden, arven, 2)
    row = ok(trader_row(ash, trader_of(misty)))
    assert row['match'] == 'wants_what_you_have' and [card['edition_id'] for card in row['you_give']] == [arven]
    hide(misty, hidden)
    row = ok(trader_row(ash, trader_of(misty)))
    assert (row['match'], row['you_give'], row['you_get']) == (None, [], [])


def test_the_trader_row_needs_reach_and_a_suspended_friend_has_no_row(store):
    ids, ash, misty, binder_, box = strangers()
    ok(set_want(ash, ids['PAL 185'], 1))
    far, _ = collector('Far W.')
    discoverable(far, far_zip())
    blocker, _ = collector('Blocker')
    blocked, _ = collector('Blocked')
    discoverable(blocker, '00010')
    discoverable(blocked, '00010')
    block(blocker, ash)
    block(ash, blocked)
    for other in (str(uuid4()), trader_of(ash), trader_of(far), trader_of(blocker), trader_of(blocked)):
        response = trader_row(ash, other)
        assert (response.status_code, response.content) == (404, COLLECTOR_UNKNOWN), other
    # A Friend answers through the trader route, with no band.
    friend, _ = collector('Gary')
    befriend(ash, friend)
    hold(friend, binder(friend), ids['PAL 185'], 1)
    row = ok(trader_row(ash, trader_of(friend)))
    assert (row['band'], row['match']) == (None, 'has_what_you_want')
    assert [item['collector_id'] for item in matches(ash)['rows']] == [friend]
    # A suspended Friend has no row anywhere.
    suspend_user(friend)
    response = one(ash, friend)
    assert (response.status_code, response.content) == (404, UNKNOWN)
    assert matches(ash)['rows'] == []
    assert trader_row(ash, trader_of(friend)).status_code == 404
