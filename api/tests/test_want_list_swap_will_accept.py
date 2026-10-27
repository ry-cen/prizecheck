"""The Want List's Swap hint with Will accept (Trading #275): a line whose card has a widened Will accept choice is also
offered the Card Editions that choice accepts (``card_accepts.accepts``), with the Reprint Group's rules otherwise:
the same availability, one pass over every Deck oldest first that never offers a copy twice, one Edition per hint and
the same Deck List changes batch. It applies even when the line's Printing is in no Reprint Group. With this exact card
nothing changes: test_want_list_swap.py passes unchanged, and so does every case here before a choice is made.

Every test seeds the Swap catalog (``want_list_swap_fixtures``): Basic Psychic Energy SVE 5 and SVE 13 share one Card
Identity and no Reprint Group (their set has no printed code, so a hint names it by its TCGdex set ID, ``sve``), and
Boss's Orders PAL 172 has two finishes and no group.
"""
from app.main import connect  # noqa: F401
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import counting, deck, detail, hold, line, new_owner
from test_friend_copies import ok
from test_trade_wants import set_rule, without_swaps
from test_want_list import check_shape, section, want_list
from test_want_list_swap import deck_list, swap, swap_of
from want_list_swap_fixtures import seed_swap_catalog


def offer(edition, count, code, number, finish='normal', listed='0'):
    return {'edition_id': edition, 'set_code': code, 'collector_number': number, 'descriptor': {'finish': finish},
            'count': count, 'listed': listed}


def test_any_card_with_the_same_name_offers_an_owned_spare_and_taking_it_lowers_the_need(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, 'Wanting', 0)
    line(owner, wanting, ids['SVE 13'], 4)
    hold(owner, unsorted, ids['SVE 5'], 2)
    before = want_list(owner)
    # This exact card: SVE 13 is in no Reprint Group, so no hint.
    assert swap_of(before, wanting, ids['SVE 13']) is None
    ok(set_rule(owner, ids['SVE 13'], 'identity'))
    body = want_list(owner)
    check_shape(body)
    # Any card with the same name: the two spare SVE 5 are offered, and nothing else in the answer moved.
    assert swap_of(body, wanting, ids['SVE 13']) == offer(ids['SVE 5'], '2', 'sve', '005')
    assert without_swaps(body) == without_swaps(before)
    response, _ = swap(owner, body, wanting, ids['SVE 13'])
    assert response.status_code == 200, response.text
    # One batch: SVE 13 lowered to 2 and SVE 5 added at 2, so the Deck needs 2 fewer.
    assert deck_list(owner, wanting)[1] == {ids['SVE 13']: '2', ids['SVE 5']: '2'}
    after = want_list(owner)
    [left] = section(after, wanting)['lines']
    assert (left['edition_id'], left['need'], left['swap']) == (ids['SVE 13'], '2', None)
    assert detail(owner, wanting)['to_get'] == '2'


def test_any_finish_offers_another_finish_of_a_printing_in_no_reprint_group(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, 'Wanting', 0)
    line(owner, wanting, ids['PAL 172'], 2)
    hold(owner, unsorted, ids['PAL 172 Reverse Holo'], 3)
    hold(owner, unsorted, ids['SVE 5'], 3)
    assert swap_of(want_list(owner), wanting, ids['PAL 172']) is None
    ok(set_rule(owner, ids['PAL 172'], 'printing'))
    assert swap_of(want_list(owner), wanting, ids['PAL 172']) == offer(
        ids['PAL 172 Reverse Holo'], '2', 'PAL', '172', finish='reverse')
    # Any finish never reaches another card.
    ok(set_rule(owner, ids['SVE 13'], 'printing'))
    line(owner, wanting, ids['SVE 13'], 1)
    assert swap_of(want_list(owner), wanting, ids['SVE 13']) is None


def test_an_accepted_spare_is_offered_to_one_line_only_oldest_deck_first(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    older, newer = deck(owner, 'Older', 0), deck(owner, 'Newer', 1)
    for deck_id in (older, newer):
        line(owner, deck_id, ids['SVE 13'], 2)
    hold(owner, unsorted, ids['SVE 5'], 1)
    ok(set_rule(owner, ids['SVE 13'], 'identity'))
    body = want_list(owner)
    # Every Deck built at once: one spare, one offer, to the older Deck.
    assert swap_of(body, older, ids['SVE 13']) == offer(ids['SVE 5'], '1', 'sve', '005')
    assert swap_of(body, newer, ids['SVE 13']) is None
    # One Deck at a time: each Deck counts every copy, so each is offered it.
    counting(owner, 'one_at_a_time')
    body = want_list(owner)
    assert swap_of(body, older, ids['SVE 13']) == offer(ids['SVE 5'], '1', 'sve', '005')
    assert swap_of(body, newer, ids['SVE 13']) == offer(ids['SVE 5'], '1', 'sve', '005')


def test_the_group_and_the_choice_share_one_pass_and_one_edition_per_hint(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, 'Wanting', 0)
    line(owner, wanting, ids['PAL 185'], 4)
    hold(owner, unsorted, ids['PAL 254'], 1)
    # Iono PAL 185's group already offers PAL 254; the same-name choice adds no other Iono here, and one Edition is
    # named: the one with the most copies available.
    ok(set_rule(owner, ids['PAL 185'], 'identity'))
    assert swap_of(want_list(owner), wanting, ids['PAL 185']) == offer(ids['PAL 254'], '1', 'PAL', '254')
    hold(owner, unsorted, ids['PAF 80'], 2)
    assert swap_of(want_list(owner), wanting, ids['PAL 185']) == offer(ids['PAF 80'], '2', 'PAF', '080')


def test_a_copy_a_deck_holds_for_its_own_line_is_never_offered_through_the_choice(store):
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    keeper, wanting = deck(owner, 'Keeper', 0), deck(owner, 'Wanting', 1)
    hold(owner, keeper, ids['SVE 5'], 2)    # listed and held: Keeper's own copies
    line(owner, wanting, ids['SVE 13'], 2)
    ok(set_rule(owner, ids['SVE 13'], 'identity'))
    assert swap_of(want_list(owner), wanting, ids['SVE 13']) is None
    counting(owner, 'one_at_a_time')
    assert swap_of(want_list(owner), wanting, ids['SVE 13']) == offer(ids['SVE 5'], '2', 'sve', '005')


def test_a_scoped_read_offers_what_the_all_decks_read_offers_that_deck(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    # The catalog links Boss's Orders PAL 172 to Iono's Card Identity, as a Card Identity merge would, so its same-name
    # choice accepts every Iono while the Iono group doesn't reach it.
    with connect() as conn:
        conn.execute("""UPDATE catalog_printing SET identity_id=(SELECT identity_id FROM catalog_printing
          WHERE source_id='sv02-185') WHERE source_id='sv02-172'""")
    older, newer = deck(owner, 'Older', 0), deck(owner, 'Newer', 1)
    line(owner, older, ids['PAL 172'], 1)
    line(owner, newer, ids['PAL 185'], 1)
    hold(owner, unsorted, ids['PAL 254'], 1)
    ok(set_rule(owner, ids['PAL 172'], 'identity'))
    for setting in ('all_at_once', 'one_at_a_time'):
        counting(owner, setting)
        whole = want_list(owner)
        for deck_id in (older, newer):
            assert want_list(owner, deck_id)['sections'] == [section(whole, deck_id)], setting
    counting(owner, 'all_at_once')
    whole = want_list(owner)
    # The older Deck's Boss's Orders line takes the one spare Iono first, so the newer Deck is offered nothing, in
    # its own scoped read too.
    assert swap_of(whole, older, ids['PAL 172']) == offer(ids['PAL 254'], '1', 'PAL', '254')
    assert swap_of(want_list(owner, newer), newer, ids['PAL 185']) is None


def test_this_exact_card_and_a_choice_on_a_covered_line_change_no_hint(store):
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, 'Wanting', 0)
    line(owner, wanting, ids['PAL 185'], 4)
    line(owner, wanting, ids['SVE 13'], 1)
    hold(owner, wanting, ids['SVE 13'], 1)   # covered: it needs nothing
    hold(owner, unsorted, ids['PAL 254'], 1)
    hold(owner, unsorted, ids['SVE 5'], 1)
    before = want_list(owner)
    ok(set_rule(owner, ids['PAL 185'], 'edition'))
    ok(set_rule(owner, ids['SVE 13'], 'identity'))
    after = want_list(owner)
    assert {**after, 'owner_revision': None} == {**before, 'owner_revision': None}
    assert after['owner_revision'] == before['owner_revision']
