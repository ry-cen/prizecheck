"""WP2b's additive need-group contract, through signed HTTP on both sides and scopes."""
import json
import pytest

from app.social import trade_matches
from stranger_fixtures import trader_of
from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import launches, store  # noqa: F401
from test_deck_counting import deck, hold, line
from test_friend_copies import befriend, collector, ok
from test_holdings import call
from test_open_discovery import discoverable
from test_trade_matches import binder, cards
from test_trade_wants import set_rule, set_want
from want_list_swap_fixtures import seed_swap_catalog

SCOPES = pytest.mark.parametrize('scope', ['friends', 'near'])
SIDES = pytest.mark.parametrize('side', ['you_get', 'you_give'])


def world(scope, side, offers, wants, rules=(), trade_wants=()):
    ids = seed_swap_catalog()
    receiver, _ = collector('Receiver')
    giver, _ = collector('Giver')
    if scope == 'friends':
        befriend(receiver, giver)
    else:
        discoverable(receiver, '00010')
        discoverable(giver, '00011')
    shelf = binder(giver)
    for key, quantity in offers:
        hold(giver, shelf, ids[key], quantity)
    location = deck(receiver, 'Private Deck', 0)
    for key, quantity in wants:
        line(receiver, location, ids[key], quantity)
    for key, rule in rules:
        ok(set_rule(receiver, ids[key], rule))
    for key, quantity in trade_wants:
        ok(set_want(receiver, ids[key], quantity))
    viewer, other = (receiver, giver) if side == 'you_get' else (giver, receiver)
    return ids, viewer, other, location


def read(scope, viewer):
    path = '/api/social/trade-matches' + ('/near' if scope == 'near' else '')
    rows = ok(call('GET', path, viewer))['rows']
    assert len(rows) == 1
    return rows[0]


def groups(row, side):
    found = row[side + '_groups']
    assert all(set(group) == {'id', 'need', 'cards'} for group in found)
    assert len({group['id'] for group in found}) == len(found)
    indexed = {group['id']: group for group in found}
    assert set(indexed) == {key for card in row[side] for key in card['need_groups']}
    for card in row[side]:
        assert len(set(card['need_groups'])) == len(card['need_groups'])
        assert sum(int(indexed[key]['need']) for key in card['need_groups']) == int(card['need'])
    return indexed


@SCOPES
@SIDES
@pytest.mark.parametrize('rule', ['printing', 'identity'])
def test_single_widened_want_has_one_shared_group(store, scope, side, rule):
    keys = ('PAL 172', 'PAL 172 Reverse Holo') if rule == 'printing' else ('PAL 185', 'PAF 80')
    ids, viewer, _, _ = world(scope, side, [(key, 2) for key in keys], [(keys[0], 2)], [(keys[0], rule)])
    row = read(scope, viewer)
    found = groups(row, side)
    assert [(g['need'], g['cards']) for g in found.values()] == [('2', '2')]
    assert len(row[side]) == 2
    assert all(card['need'] == '2' and card['need_groups'] == list(found) for card in row[side])


@SCOPES
@SIDES
def test_exact_trade_want_overlaps_a_widened_want_without_merging_groups(store, scope, side):
    ids, viewer, _, _ = world(scope, side, [('PAL 185', 2), ('PAF 80', 2)], [('PAL 185', 2)],
                               [('PAL 185', 'identity')], [('PAF 80', 1)])
    row = read(scope, viewer)
    found = groups(row, side)
    by_id = {card['edition_id']: card for card in row[side]}
    pal, paf = by_id[ids['PAL 185']], by_id[ids['PAF 80']]
    assert (pal['need'], paf['need']) == ('2', '3')
    shared = pal['need_groups'][0]
    assert paf['need_groups'][0] == shared
    assert found[shared]['need'] == '2' and found[shared]['cards'] == '2'
    exact = paf['need_groups'][1]
    assert found[exact]['need'] == '1' and found[exact]['cards'] == '1'
    assert (pal['want_list_need'], paf['want_list_need']) == ('2', '2')


@SCOPES
@SIDES
def test_two_widened_wants_reach_one_card_as_separate_parts(store, scope, side):
    _, viewer, _, _ = world(scope, side, [('PAL 254', 8)], [('PAL 185', 2), ('PAF 80', 1)],
                            [('PAL 185', 'identity'), ('PAF 80', 'identity')])
    row = read(scope, viewer)
    found = groups(row, side)
    assert sorted((g['need'], g['cards']) for g in found.values()) == [('1', '1'), ('2', '1')]
    assert row[side][0]['need'] == '3'
    assert row[side][0]['want_list_need'] == '3'


@SCOPES
@SIDES
def test_available_copies_do_not_change_the_reported_need(store, scope, side):
    _, viewer, _, _ = world(scope, side, [('PAL 185', 1)], [('PAL 185', 5)])
    row = read(scope, viewer)
    found = groups(row, side)
    assert (row[side][0]['copies'], row[side][0]['need']) == ('1', '5')
    assert [(g['need'], g['cards']) for g in found.values()] == [('5', '1')]


@SCOPES
@SIDES
def test_truncation_counts_all_members_and_omits_groups_with_no_carried_member(store, monkeypatch, scope, side):
    ids, viewer, other, _ = world(scope, side, [('PAL 185', 2), ('PAL 254', 2), ('PAF 80', 2)],
                                  [('PAL 185', 2)], [('PAL 185', 'identity')], [('PAF 80', 1)])
    monkeypatch.setattr(trade_matches, 'CARDS_PER_SIDE', 2)
    row = read(scope, viewer)
    assert len(row[side]) == 2 and row['more_' + side] == 1
    assert ids['PAF 80'] not in {card['edition_id'] for card in row[side]}
    found = groups(row, side)
    assert [(g['need'], g['cards']) for g in found.values()] == [('2', '3')]
    path = (f'/api/social/trade-matches/{other}' if scope == 'friends'
            else f'/api/social/traders/{trader_of(other)}/matches')
    full = ok(call('GET', path, viewer))
    assert len(full[side]) == 3 and full['more_' + side] == 0
    assert sorted((g['need'], g['cards']) for g in groups(full, side).values()) == [('1', '1'), ('2', '3')]


@SCOPES
@SIDES
def test_new_group_fields_are_opaque_and_carry_no_private_identity(store, scope, side):
    ids, viewer, other, private_deck = world(scope, side, [('PAL 185', 2)], [('PAL 185', 2)])
    first, second = read(scope, viewer), read(scope, viewer)
    first_ids, second_ids = set(groups(first, side)), set(groups(second, side))
    assert first_ids.isdisjoint(second_ids)
    added = json.dumps({'groups': first[side + '_groups'],
                        'memberships': [card['need_groups'] for card in first[side]]})
    for secret in [*ids.values(), viewer, other, private_deck, 'Private Deck']:
        assert secret not in added
    if scope == 'near':
        assert not {'handle', 'collector_id', 'zip'} & set(first)


@SCOPES
@SIDES
def test_existing_match_fields_keep_their_values(store, scope, side):
    ids, viewer, _, _ = world(scope, side, [('PAL 185', 2)], [('PAL 185', 3)])
    row = read(scope, viewer)
    groups(row, side)
    assert cards(row[side]) == {ids['PAL 185']: ('2', '3', '3', 'want_list', 'exact' if side == 'you_get' else None)}
    assert row['match'] == ('has_what_you_want' if side == 'you_get' else 'wants_what_you_have')
    assert row['more_you_get'] == row['more_you_give'] == 0


@SCOPES
@SIDES
def test_trader_read_has_the_same_group_semantics_without_extra_privacy_keys(store, scope, side):
    _, viewer, other, _ = world(scope, side, [('PAL 185', 2), ('PAF 80', 2)], [('PAL 185', 2)],
                                [('PAL 185', 'identity')])
    listed = read(scope, viewer)
    full = ok(call('GET', f'/api/social/traders/{trader_of(other)}/matches', viewer))
    assert sorted((g['need'], g['cards']) for g in groups(full, side).values()) == sorted(
        (g['need'], g['cards']) for g in groups(listed, side).values())
    assert cards(full[side]) == cards(listed[side])
    assert set(full) == {'trader_id', 'display_name', 'band', 'completed_trades', 'open_to_cash_offers', 'match',
                         'you_get', 'you_give', 'more_you_get', 'more_you_give', 'you_get_groups', 'you_give_groups'}
