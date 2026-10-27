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
import hashlib
import json
import threading
from uuid import UUID, uuid4

import pytest

from app.main import connect  # noqa: F401
from app.social import friend_copies, trade_matches
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
from test_open_discovery import discoverable, put
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


# Near you and card search (Trading #300).

HOLDER_FIELDS = {'trader_id', 'display_name', 'friend', 'band', 'completed_trades', 'open_to_cash_offers', 'cards',
                 'more_cards'}
NEAR_FIELDS = TRADER_FIELDS


def near(viewer):
    return ok(call('GET', '/api/social/trade-matches/near', viewer))


def search(viewer, printing, scope='name'):
    return ok(call('GET', f'/api/social/trade-card-search?printing_id={printing}&scope={scope}', viewer))


def names(rows):
    return [row['display_name'] for row in rows]


def neighbour(name, zip, holds=(), wants=()):
    """A discoverable collector at ``zip`` holding each ``(Edition, count)`` of ``holds`` in a For trade Location and
    wanting each ``(Edition, count)`` of ``wants``; returns the user id."""
    user, _ = collector(name)
    discoverable(user, zip)
    if holds:
        shelf = binder(user)
        for edition, count in holds:
            hold(user, shelf, edition, count)
    for edition, count in wants:
        ok(set_want(user, edition, count))
    return user


def the_viewer(ids, zip='00010', name='Viewer'):
    """A discoverable viewer with 1 Arven for trade who wants 1 Iono PAL 185."""
    viewer, _ = collector(name)
    discoverable(viewer, zip)
    hold(viewer, binder(viewer), ids['SVI 166'], 1)
    ok(set_want(viewer, ids['PAL 185'], 1))
    return viewer


def remove_discovery(user):
    with connect() as conn:
        conn.execute('UPDATE discovery_setting SET removed_at = now(), enabled = false WHERE user_id = %s', (user,))


def test_near_you_orders_by_kind_then_band_then_name(store):
    ids = seed_swap_catalog()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    viewer = the_viewer(ids)
    neighbour('Zed', '00010', holds=[(iono, 1)], wants=[(arven, 1)])
    neighbour('Amy', '00011', holds=[(iono, 1)], wants=[(arven, 1)])
    neighbour('Bea', '00010', holds=[(iono, 1)])
    neighbour('Abe', '00010', holds=[(iono, 1)])
    neighbour('Cal', '00010', wants=[(arven, 1)])
    neighbour('Dee', '00010', holds=[(iono, 1)])
    neighbour('Dee', '00010', holds=[(iono, 1)])
    neighbour('Ned', '00010')
    gus = neighbour('Gus', '00010', holds=[(iono, 1)])
    befriend(viewer, gus)
    bly = neighbour('Bly', '00010', holds=[(iono, 1)])
    blo = neighbour('Blo', '00010', holds=[(iono, 1)])
    block(viewer, bly)
    block(blo, viewer)
    sus = neighbour('Sus', '00010', holds=[(iono, 1)])
    suspend_user(sus)
    rem = neighbour('Rem', '00010', holds=[(iono, 1)])
    remove_discovery(rem)
    body = near(viewer)
    assert (body['status'], body['radius_mi']) == ('on', 25)
    assert names(body['rows']) == ['Zed', 'Amy', 'Abe', 'Bea', 'Dee', 'Dee', 'Cal']
    dees = [row['trader_id'] for row in body['rows'] if row['display_name'] == 'Dee']
    assert dees == sorted(dees)
    for row in body['rows']:
        assert set(row) == NEAR_FIELDS and row['completed_trades'] == 0
        assert row['band'] == ('5_to_10' if row['display_name'] == 'Amy' else 'under_5')
    assert [row['match'] for row in body['rows']] == ['two_way'] * 2 + ['has_what_you_want'] * 4 + [
        'wants_what_you_have']
    # A Friend is in the Friends read and never in Near you.
    assert names(matches(viewer)['rows']) == ['Gus']
    assert trader_of(gus) not in json.dumps(body)


def test_the_radius_filters_near_you_by_band_and_nobody_beyond_50_mi_appears(store):
    ids = seed_swap_catalog()
    iono = ids['PAL 185']
    viewer = the_viewer(ids)
    for name, zip in (('One', '00010'), ('Two', '00011'), ('Three', '00012'), ('Four', '00014')):
        neighbour(name, zip, holds=[(iono, 1)])
    neighbour('Far', far_zip(), holds=[(iono, 1)])
    talk = neighbour('Talk', '00014', holds=[(iono, 1)])
    with connect() as conn:
        conn.execute("SELECT pair_conversation(%s, %s, 'A', 'B')", (talk, viewer))
    for radius, expected in ((5, ['One']), (10, ['One', 'Two']), (25, ['One', 'Three', 'Two']),
                             (50, ['Four', 'One', 'Talk', 'Three', 'Two'])):
        ok(put(viewer, {'radius_mi': radius}))
        body = near(viewer)
        # A conversation reaches the Trade List but does not widen Near you: Talk (band 4) is in only at 50 mi.
        assert sorted(names(body['rows'])) == [name for name in expected if name != 'Talk' or radius == 50], radius
        assert body['radius_mi'] == radius and 'Far' not in names(body['rows'])


def test_near_you_is_empty_while_discovery_is_off_removed_or_suspended(store):
    ids = seed_swap_catalog()
    neighbour('Misty', '00010', holds=[(ids['PAL 185'], 1)])
    viewer = the_viewer(ids)
    assert len(near(viewer)['rows']) == 1
    ok(put(viewer, {'enabled': False}))
    assert near(viewer) == {'status': 'off', 'radius_mi': 25, 'rows': []}
    ok(put(viewer, {'enabled': True}))
    remove_discovery(viewer)
    assert near(viewer) == {'status': 'removed', 'radius_mi': 25, 'rows': []}
    other = the_viewer(ids, name='Other')
    assert len(near(other)['rows']) == 1
    suspend_user(other)
    assert near(other) == {'status': 'suspended', 'radius_mi': 25, 'rows': []}
    never, _ = collector('Never')
    assert near(never) == {'status': 'off', 'radius_mi': 25, 'rows': []}


def test_near_you_caps_rows_and_cards_a_side(store, monkeypatch):
    ids = seed_swap_catalog()
    viewer = the_viewer(ids)
    assert (trade_matches.NEAR_CANDIDATES, trade_matches.NEAR_ROWS, trade_matches.CARDS_PER_SIDE) == (500, 100, 20)
    for name in ('A1', 'A2', 'A3'):
        neighbour(name, '00010', holds=[(ids['PAL 185'], 1)])
    monkeypatch.setattr(trade_matches, 'NEAR_ROWS', 2)
    assert names(near(viewer)['rows']) == ['A1', 'A2']
    monkeypatch.undo()
    big = neighbour('Big', '00010')
    extra = extra_editions(23)
    want(viewer, extra)
    fill(big, binder(big), extra)
    [row] = [row for row in near(viewer)['rows'] if row['display_name'] == 'Big']
    assert (len(row['you_get']), row['more_you_get'], row['you_give'], row['more_you_give']) == (20, 3, [], 0)


def test_in_band_order_is_by_name_and_the_cap_is_per_viewer(store, monkeypatch):
    ids = seed_swap_catalog()
    iono = ids['PAL 185']
    # The cut is over everyone in open discovery in this database, so earlier tests' collectors are switched off first.
    with connect() as conn:
        conn.execute('UPDATE discovery_setting SET enabled = false')
    first = the_viewer(ids)
    neighbours = {neighbour(name, '00010', holds=[(iono, 1)]): name for name in ('Cara', 'Bo', 'Al')}

    def expected(viewer):
        ranked = sorted(neighbours, key=lambda user: hashlib.md5((viewer + trader_of(user)).encode()).hexdigest())
        return {neighbours[user] for user in ranked[:2]}

    # Viewers are candidates for each other, so only the one being read is in open discovery.
    ok(put(first, {'enabled': False}))
    second = None
    for n in range(20):
        candidate = the_viewer(ids, name=f'Viewer {n}')
        ok(put(candidate, {'enabled': False}))
        if expected(candidate) != expected(first):
            second = candidate
            break
    assert second is not None, 'no second viewer with a different cut in 20 tries'
    monkeypatch.setattr(trade_matches, 'NEAR_CANDIDATES', 2)
    for viewer in (first, second):
        ok(put(viewer, {'enabled': True}))
        seen = names(near(viewer)['rows'])
        assert seen == sorted(expected(viewer)) and names(near(viewer)['rows']) == seen
        ok(put(viewer, {'enabled': False}))
    assert expected(first) != expected(second)


def holders(body, key):
    """A card search list as [(Display Name, [Edition names as 'set number'])] with the cards in the answer's order."""
    return [(holder['display_name'], [(card['set_code'], card['collector_number']) for card in holder['cards']])
            for holder in body[key]]


def test_card_search_scopes_name_set_and_printing_with_friends_before_near(store):
    ids = seed_swap_catalog()
    viewer = the_viewer(ids)
    gary = neighbour('Gary', '00010', holds=[(ids['PAL 185'], 1), (ids['PAF 80'], 1)])
    befriend(viewer, gary)
    neighbour('Misty', '00011', holds=[(ids['PAL 185'], 1), (ids['PAL 254'], 1), (ids['PAL 172'], 1)])
    neighbour('Ned', '00010', holds=[(ids['PAF 80'], 1)])
    printing = printing_of(ids['PAL 185'])
    # Cards come in Card.order(): name, then set name ("Paldea Evolved" before "Paldean Fates"), then number.
    pal185, pal254, paf80 = ('PAL', '185'), ('PAL', '254'), ('PAF', '080')
    expected = {
        'name': ([('Gary', [pal185, paf80])], [('Ned', [paf80]), ('Misty', [pal185, pal254])]),
        'set': ([('Gary', [pal185])], [('Misty', [pal185, pal254])]),
        'printing': ([('Gary', [pal185])], [('Misty', [pal185])]),
    }
    for scope, (friends, nearby) in expected.items():
        body = search(viewer, printing, scope)
        assert list(body) == ['status', 'friends', 'near'] and body['status'] == 'on', scope
        assert (holders(body, 'friends'), holders(body, 'near')) == (friends, nearby), scope
        for holder in body['friends'] + body['near']:
            assert set(holder) == HOLDER_FIELDS and holder['more_cards'] == 0
            assert all(isinstance(card['copies'], str) for card in holder['cards'])
        [gary_holder] = body['friends']
        assert (gary_holder['friend'], gary_holder['band']) == (True, None)
        assert all(holder['friend'] is False for holder in body['near'])
        assert 'Gary' not in names(body['near'])
    assert [holder['band'] for holder in search(viewer, printing)['near']] == ['under_5', '5_to_10']


def test_card_search_answers_friends_whatever_the_discovery_status(store):
    ids = seed_swap_catalog()
    viewer = the_viewer(ids)
    gary, _ = collector('Gary')
    befriend(viewer, gary)
    hold(gary, binder(gary), ids['PAL 185'], 1)
    neighbour('Misty', '00011', holds=[(ids['PAL 185'], 1)])
    printing = printing_of(ids['PAL 185'])
    ok(put(viewer, {'enabled': False}))
    body = search(viewer, printing)
    assert (body['status'], names(body['friends']), body['near']) == ('off', ['Gary'], [])
    ok(put(viewer, {'enabled': True}))
    remove_discovery(viewer)
    body = search(viewer, printing)
    assert (body['status'], names(body['friends']), body['near']) == ('removed', ['Gary'], [])
    # The choke point gives a suspended viewer no copies, so they have no Friends' cards either.
    suspend_user(viewer)
    assert search(viewer, printing) == {'status': 'suspended', 'friends': [], 'near': []}
    suspend_user(viewer, False)
    with connect() as conn:
        conn.execute('UPDATE discovery_setting SET removed_at = NULL WHERE user_id = %s', (viewer,))
    ok(put(viewer, {'enabled': True}))
    body = search(viewer, printing)
    assert (body['status'], names(body['friends']), names(body['near'])) == ('on', ['Gary'], ['Misty'])


def test_card_search_of_an_unknown_printing_answers_empty(store):
    ids = seed_swap_catalog()
    viewer = the_viewer(ids)
    for scope in ('name', 'set', 'printing'):
        assert search(viewer, uuid4(), scope) == {'status': 'on', 'friends': [], 'near': []}
    assert call('GET', f'/api/social/trade-card-search?printing_id={uuid4()}&scope=other', viewer).status_code == 422


def test_card_search_caps_holders_and_cards(store, monkeypatch):
    ids = seed_swap_catalog()
    viewer = the_viewer(ids)
    assert (trade_matches.CARD_SEARCH_CANDIDATES, trade_matches.HOLDERS_PER_LIST,
            trade_matches.CARDS_PER_HOLDER) == (1000, 50, 20)
    iono = ids['PAL 185']
    for name in ('F1', 'F2', 'F3'):
        friend = neighbour(name, '00010', holds=[(iono, 1)])
        befriend(viewer, friend)
    for name in ('N1', 'N2', 'N3'):
        neighbour(name, '00010', holds=[(iono, 1)])
    monkeypatch.setattr(trade_matches, 'HOLDERS_PER_LIST', 2)
    body = search(viewer, printing_of(iono))
    assert (names(body['friends']), names(body['near'])) == (['F1', 'F2'], ['N1', 'N2'])
    monkeypatch.undo()
    big = neighbour('Big', '00010')
    fill(big, binder(big), extra_editions(23))
    body = search(viewer, printing_of(ids['SVI 166']), 'printing')
    [holder] = body['near']
    assert (holder['display_name'], len(holder['cards']), holder['more_cards']) == ('Big', 20, 3)


def test_card_search_never_lists_promised_or_borrowed_copies(store):
    ids = seed_swap_catalog()
    viewer = the_viewer(ids)
    paf, iono = ids['PAF 80'], ids['PAL 185']
    paf_printing = printing_of(paf)
    friend, _ = collector('Ash K.')
    other, _ = collector('Other')
    befriend(viewer, friend)
    befriend(friend, other)
    discoverable(friend, '00010')
    shelf = binder(friend)
    hold(friend, shelf, paf, 1)
    assert names(search(viewer, paf_printing, 'printing')['friends']) == ['Ash K.']
    trade = seed_trade(friend, other, gives=[(paf, 1)], picks=[('proposer', friend, shelf, paf, 1)])
    assert search(viewer, paf_printing, 'printing')['friends'] == []
    close(trade, 'withdrawn')
    assert names(search(viewer, paf_printing, 'printing')['friends']) == ['Ash K.']
    # A nearby stranger's only copy, promised to someone else.
    stranger = neighbour('Stranger', '00010')
    befriend(stranger, other)
    their_shelf = binder(stranger)
    hold(stranger, their_shelf, paf, 1)
    assert 'Stranger' in names(search(viewer, paf_printing, 'printing')['near'])
    trade = seed_trade(stranger, other, gives=[(paf, 1)], picks=[('proposer', stranger, their_shelf, paf, 1)])
    assert 'Stranger' not in names(search(viewer, paf_printing, 'printing')['near'])
    close(trade, 'withdrawn')
    assert 'Stranger' in names(search(viewer, paf_printing, 'printing')['near'])
    # A Borrowed Copy sits in the borrower's Deck, which is no For trade Location, so the borrower is absent.
    borrower, _ = collector('Borrower')
    befriend(viewer, borrower)
    lender, _ = collector('Lender')
    befriend(borrower, lender)
    hold(lender, node(lender, 'Unsorted')['id'], iono, 1)
    gardevoir = deck(borrower, 'Gardevoir', 0)
    borrow = ok(accept(lender, sent(borrower, lender, [(iono, 1)], deck_id=gardevoir), [(iono, 1)]))
    ok(handover(lender, borrow))
    ok(handover(borrower, borrow))
    assert 'Borrower' not in names(search(viewer, printing_of(iono), 'printing')['friends'])


def test_near_you_and_the_friends_read_stay_separate(store):
    ids = seed_swap_catalog()
    iono = ids['PAL 185']
    viewer = the_viewer(ids)
    friend = neighbour('Friend', '00010', holds=[(iono, 1)])
    befriend(viewer, friend)
    neighbour('Nearby', '00011', holds=[(iono, 1)])
    assert names(matches(viewer)['rows']) == ['Friend']
    assert names(near(viewer)['rows']) == ['Nearby']
    assert ok(one(viewer, friend))['display_name'] == 'Friend'
    assert call('GET', '/api/social/trade-matches/near', viewer).status_code == 200
