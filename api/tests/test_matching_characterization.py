"""Gap-only matching characterization before ReprintRules composition (#529)."""
from uuid import UUID, uuid4

import pytest

from app.card_accepts import accepts
from app.main import connect
from app.social import trade_matches
from test_catalog_targets import isolated_rules  # noqa: F401 (autouse fixture)
from test_deck_cost import launches, store  # noqa: F401 (autouse fixtures)
from test_deck_counting import counting, deck, hold, line, new_owner
from test_friend_copies import befriend, collector, node, ok
from test_friend_matches import card, listed, matches, printing_of
from test_trade_matches import binder, matches as trade_rows
from test_trade_wants import set_rule, set_want
from test_want_list import section, want_list
from test_want_list_swap import hint, swap_of
from want_list_swap_fixtures import seed_swap_catalog


def test_exact_acceptance_including_unknown_editions_never_reads_catalog():
    # Seam: card_accepts' exact/empty fast path is independent of catalog and inventory.
    class NoReads:
        def execute(self, *args, **kwargs):
            pytest.fail('exact acceptance must not issue SQL')

    edition = uuid4()
    assert accepts(NoReads(), {}) == {}
    assert accepts(NoReads(), {edition: 'edition'}) == {edition: {edition}}


def test_widened_acceptance_is_one_sorted_batch_and_keeps_unknown_editions(store):
    # Seam: card_accepts batches mixed rules once; absent catalog rows still accept themselves.
    ids = seed_swap_catalog()
    unknown = uuid4()
    rules = {UUID(ids['SVE 13']): 'identity', unknown: 'printing',
             UUID(ids['PAL 172']): 'printing', UUID(ids['SVI 166']): 'edition'}
    reads = []
    with connect() as conn:
        # Acceptance does not apply Swap's active/non-tombstoned new-line filter.
        conn.execute('UPDATE catalog_generation_edition SET active=false WHERE edition_id=%s',
                     (ids['PAL 172 Reverse Holo'],))
        conn.execute('''UPDATE catalog_generation_printing SET tombstoned=true
            WHERE printing_id=(SELECT printing_id FROM catalog_edition WHERE id=%s)''', (ids['SVE 5'],))

        class Counted:
            def execute(self, query, params):
                reads.append(params)
                return conn.execute(query, params)

        found = accepts(Counted(), rules)
    widened = sorted((edition, rule) for edition, rule in rules.items() if rule != 'edition')
    assert reads == [([edition for edition, _ in widened], [rule for _, rule in widened])]
    assert found == {UUID(ids['SVE 13']): {UUID(ids['SVE 13']), UUID(ids['SVE 5'])},
                     unknown: {unknown},
                     UUID(ids['PAL 172']): {UUID(ids['PAL 172']), UUID(ids['PAL 172 Reverse Holo'])},
                     UUID(ids['SVI 166']): {UUID(ids['SVI 166'])}}


def test_friend_copy_ties_use_handle_then_edition_and_wanted_cards_use_uuid(store):
    # Seam: friend_reads orders equal-name Friends by Handle, finishes by UUID, never copy count.
    ids = seed_swap_catalog()
    viewer, _ = collector()
    friends = [collector('Same Name'), collector('same name')]
    wanting = deck(viewer, 'Wanting', 0)
    for key in ('SVI 166', 'PAL 172'):
        line(viewer, wanting, ids[key], 1)
    ok(set_rule(viewer, ids['SVI 166'], 'printing'))
    editions = sorted([ids['SVI 166'], ids['SVI 166 Reverse Holo']], key=UUID)
    for friend, _ in reversed(sorted(friends, key=lambda person: person[1])):
        befriend(viewer, friend)
        shelf = node(friend, 'Unsorted')['id']
        for edition, quantity in zip(reversed(editions), (9, 1)):
            hold(friend, shelf, edition, quantity)
        hold(friend, shelf, ids['PAL 172'], 1)
    body = ok(matches(viewer))
    assert [item['edition_id'] for item in body['cards']] == sorted(
        [ids['SVI 166'], ids['PAL 172']], key=UUID)
    arven = next(item for item in body['cards'] if item['edition_id'] == ids['SVI 166'])
    expected = [(friend, edition, '1' if edition == editions[0] else '9')
                for friend, _ in sorted(friends, key=lambda person: person[1]) for edition in editions]
    assert [(copy['collector_id'], copy['edition_id'], copy['spare']) for copy in arven['copies']] == expected
    assert [(copy['collector_id'], copy['edition_id'], copy['spare'])
            for copy in ok(card(viewer, printing_of(ids['SVI 166'])))['copies']] == expected


def test_friend_popup_does_not_expand_ungrouped_energy_by_identity(store):
    # Seam: friend_reads' Reprint Group reach differs from Will accept's Card Identity expansion.
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector(), collector()
    befriend(viewer, friend)
    shelf = node(friend, 'Unsorted')['id']
    for key in ('SVE 5', 'SVE 13', 'PAL 172 Reverse Holo'):
        hold(friend, shelf, ids[key], 2)
    for printings in ('exact', 'reprint_group'):
        assert listed(ok(card(viewer, printing_of(ids['SVE 5']), printings=printings))) == [
            (friend, ids['SVE 5'], False, '2', '0')]
        assert listed(ok(card(viewer, printing_of(ids['PAL 172']), printings=printings))) == [
            (friend, ids['PAL 172 Reverse Holo'], False, '2', '0')]


def test_swap_equal_quantities_use_card_order_before_candidate_insertion_order(store):
    # Seam: swap_hints resolves equal availability by the Want List's card order.
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, 'Wanting', 0)
    line(owner, wanting, ids['PAL 185'], 4)
    for key in ('PAF 80', 'PAL 254'):
        hold(owner, unsorted, ids[key], 2)
    assert swap_of(want_list(owner), wanting, ids['PAL 185']) == hint(ids['PAL 254'], '2')


def test_swap_identical_card_order_falls_to_edition_uuid(store):
    # Seam: swap_hints' final tie-break is Edition UUID, independent of descriptor/finish.
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, 'Wanting', 0)
    line(owner, wanting, ids['SVI 166'], 3)
    with connect() as conn:
        printing = UUID(printing_of(ids['SVI 166']))
        extra = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
            VALUES (%s,'tie-fixture','{"label":"Tie fixture"}') RETURNING id""", (printing,)).fetchone()['id']
        conn.execute('''INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active)
            SELECT active_generation,%s,%s,true FROM catalog_state WHERE singleton''', (extra, printing))
    for edition in (str(extra), ids['SVI 166 Reverse Holo']):
        hold(owner, unsorted, edition, 2)
    selected = min(extra, UUID(ids['SVI 166 Reverse Holo']))
    descriptor = {'label': 'Tie fixture'} if selected == extra else {'finish': 'reverse'}
    assert swap_of(want_list(owner), wanting, ids['SVI 166']) == {
        'edition_id': str(selected), 'set_code': 'SVI', 'collector_number': '166',
        'descriptor': descriptor, 'count': '2', 'listed': '0'}


@pytest.mark.parametrize('unavailable', ['inactive', 'tombstoned'])
def test_swap_unavailable_candidates_only_count_when_the_deck_already_lists_them(store, unavailable):
    # Seam: swap_hints separates Reprint Group equivalence from new-line eligibility.
    ids = seed_swap_catalog()
    owner, unsorted = new_owner()
    wanting = deck(owner, 'Wanting', 0)
    line(owner, wanting, ids['PAL 185'], 4)
    hold(owner, unsorted, ids['PAL 254'], 1)
    hold(owner, unsorted, ids['PAF 80'], 3)

    def availability(value):
        with connect() as conn:
            if unavailable == 'inactive':
                conn.execute('UPDATE catalog_generation_edition SET active=%s WHERE edition_id=%s',
                             (value, ids['PAF 80']))
            else:
                conn.execute('''UPDATE catalog_generation_printing SET tombstoned=%s
                    WHERE printing_id=(SELECT printing_id FROM catalog_edition WHERE id=%s)''',
                             (not value, ids['PAF 80']))

    availability(False)
    assert swap_of(want_list(owner), wanting, ids['PAL 185']) == hint(ids['PAL 254'], '1')
    availability(True)
    line(owner, wanting, ids['PAF 80'], 1)
    availability(False)
    assert swap_of(want_list(owner), wanting, ids['PAL 185']) == hint(
        ids['PAF 80'], '2', listed='1', code='PAF', number='080')


def test_trade_matching_does_not_implicitly_accept_reprint_group_members(store):
    # Seam: trade_matches uses Will accept, never the popup's automatic Reprint Group expansion.
    ids = seed_swap_catalog()
    (viewer, _), (friend, _) = collector(), collector()
    befriend(viewer, friend)
    wanting = deck(viewer, 'Wanting', 0)
    line(viewer, wanting, ids['PAL 185'], 2)
    hold(friend, binder(friend), ids['PAL 254'], 3)
    assert trade_rows(viewer) == {'has_friends': True, 'rows': []}
    ok(set_rule(viewer, ids['PAL 185'], 'printing'))
    assert trade_rows(viewer) == {'has_friends': True, 'rows': []}
    ok(set_rule(viewer, ids['PAL 185'], 'identity'))
    [row] = trade_rows(viewer)['rows']
    assert [(item['edition_id'], item['copies'], item['need'], item['accepts_as'])
            for item in row['you_get']] == [(ids['PAL 254'], '3', '2', 'same_name')]


def test_trade_discovery_bounds_both_choke_point_reads_to_relevant_editions(store, monkeypatch):
    # Seam: trade_matches delegates one bounded read per side to friend_copies for all Friends.
    ids = seed_swap_catalog()
    viewer, _ = collector()
    friends = [collector()[0] for _ in range(2)]
    line(viewer, deck(viewer, 'Wanting', 0), ids['PAL 185'], 2)
    ok(set_rule(viewer, ids['PAL 185'], 'identity'))
    hold(viewer, binder(viewer), ids['SVE 5'], 1)
    for friend in friends:
        befriend(viewer, friend)
        hold(friend, binder(friend), ids['PAL 254'], 1)
        ok(set_want(friend, ids['SVE 13'], 1))
    reads = []

    def record(name, real):
        def counted(conn, user_id, scope, editions, *, among):
            reads.append((name, user_id, set(scope), set(editions), among))
            return real(conn, user_id, scope, editions, among=among)
        return counted

    for name in ('friend_trade_copies', 'friend_wants'):
        monkeypatch.setattr(trade_matches, name, record(name, getattr(trade_matches, name)))
    assert len(trade_rows(viewer)['rows']) == 2
    assert reads == [
        ('friend_trade_copies', viewer, set(friends), {UUID(ids[key]) for key in ('PAL 185', 'PAL 254', 'PAF 80')},
         'friends'),
        ('friend_wants', viewer, set(friends), {UUID(ids[key]) for key in ('SVE 5', 'SVE 13')}, 'friends')]


@pytest.mark.parametrize('setting,total', [('all_at_once', '5'), ('one_at_a_time', '3')])
def test_want_list_combined_order_keeps_first_deck_appearance_before_global_card_order(store, setting, total):
    # Seam: want_list folds by Edition in first-appearance order, with sum/max quantity semantics.
    ids = seed_swap_catalog()
    owner, _ = new_owner()
    older, newer = deck(owner, 'Older', 0), deck(owner, 'Newer', 1)
    line(owner, older, ids['PAL 185'], 2)
    line(owner, newer, ids['PAL 185'], 3)
    line(owner, newer, ids['SVI 166'], 1)
    counting(owner, setting)
    body = want_list(owner)
    assert [item['edition_id'] for item in section(body, newer)['lines']] == [ids['SVI 166'], ids['PAL 185']]
    assert [(item['edition_id'], item['need'], item['decks']) for item in body['combined']] == [
        (ids['PAL 185'], total, [{'deck_id': older, 'need': '2'}, {'deck_id': newer, 'need': '3'}]),
        (ids['SVI 166'], '1', [{'deck_id': newer, 'need': '1'}])]
