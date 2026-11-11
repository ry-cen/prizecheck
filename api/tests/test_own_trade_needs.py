"""Own-only incoming-Trade need context, independent of another collector's Trade List or identity."""
from uuid import uuid4
import pytest

from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import store  # noqa: F401
from test_deck_counting import counting, deck, hold, line
from test_friend_copies import befriend, collector, ok
from test_holdings import call, client
from test_trade_matches import binder, one
from test_trade_wants import set_rule, set_want
from want_list_swap_fixtures import seed_swap_catalog


def read(viewer, *editions):
    query = '&'.join(f'edition_id={edition}' for edition in editions)
    return call('GET', '/api/social/trade-matches/needs' + (f'?{query}' if query else ''), viewer)


def context(edition, want='0', trade='0', widened=False, shared=False):
    return {'edition_id': edition, 'want_list_need': want, 'trade_wants_quantity': trade, 'widened': widened, 'shared': shared}


@pytest.mark.parametrize('rule,wanted,received,widened', [
    ('edition', 'PAL 185', 'PAL 185', False),
    ('printing', 'PAL 172', 'PAL 172', False),
    ('identity', 'PAL 185', 'PAL 185', False),
    ('printing', 'PAL 172', 'PAL 172 Reverse Holo', True),
    ('identity', 'PAL 185', 'PAF 80', True)])
def test_exact_and_widened_own_need_without_any_other_collector(store, rule, wanted, received, widened):
    ids = seed_swap_catalog()
    viewer, _ = collector()
    own = deck(viewer, 'Private own Deck', 0)
    line(viewer, own, ids[wanted], 3)
    ok(set_rule(viewer, ids[wanted], rule))
    assert ok(read(viewer, ids[received])) == [context(ids[received], '3', widened=widened, shared=rule != 'edition')]


def test_trade_wants_only_do_not_widen_or_become_deck_need(store):
    ids = seed_swap_catalog()
    viewer, _ = collector()
    ok(set_want(viewer, ids['PAL 185'], 4))
    ok(set_rule(viewer, ids['PAL 185'], 'identity'))
    assert ok(read(viewer, ids['PAL 185'], ids['PAF 80'])) == [
        context(ids['PAL 185'], trade='4'), context(ids['PAF 80'])]


def test_mixed_exact_widened_and_trade_need_agrees_with_discovery(store):
    ids = seed_swap_catalog()
    viewer, _ = collector()
    other, _ = collector()
    befriend(viewer, other)
    own = deck(viewer, 'Private own Deck', 0)
    line(viewer, own, ids['PAF 80'], 1)
    line(viewer, own, ids['PAL 185'], 2)
    ok(set_rule(viewer, ids['PAL 185'], 'identity'))
    ok(set_want(viewer, ids['PAF 80'], 4))
    hold(other, binder(other), ids['PAF 80'], 6)
    result = ok(read(viewer, ids['PAF 80']))
    assert result == [context(ids['PAF 80'], '3', '4', widened=True, shared=True)]
    matched = ok(one(viewer, other))['you_get'][0]
    assert matched['want_list_need'] == result[0]['want_list_need']
    assert int(matched['need']) == int(result[0]['want_list_need']) + int(result[0]['trade_wants_quantity'])


@pytest.mark.parametrize('setting,need', [('all_at_once', '5'), ('one_at_a_time', '3')])
def test_need_uses_the_viewers_counting_setting(store, setting, need):
    ids = seed_swap_catalog()
    viewer, _ = collector()
    for index, quantity in enumerate([2, 3]):
        line(viewer, deck(viewer, 'Own', index), ids['PAL 185'], quantity)
    counting(viewer, setting)
    assert ok(read(viewer, ids['PAL 185'])) == [context(ids['PAL 185'], need)]


def test_unknown_unrelated_and_duplicates_are_bounded_own_answers(store):
    ids = seed_swap_catalog()
    viewer, _ = collector()
    unknown = str(uuid4())
    own = deck(viewer, 'Own', 0)
    line(viewer, own, ids['PAL 185'], 2)
    assert ok(read(viewer, unknown, ids['SVI 166'], unknown)) == [context(unknown), context(ids['SVI 166'])]
    assert ok(read(viewer)) == []


def test_other_collectors_cannot_affect_or_appear_in_the_response(store):
    ids = seed_swap_catalog()
    viewer, _ = collector()
    line(viewer, deck(viewer, 'Own', 0), ids['PAL 185'], 2)
    before = ok(read(viewer, ids['PAL 185'], ids['SVI 166']))
    other, _ = collector('Other private collector')
    secret = deck(other, 'Other secret Deck', 0)
    line(other, secret, ids['PAL 185'], 99)
    ok(set_want(other, ids['SVI 166'], 99))
    hold(other, binder(other, 'Other secret Location'), ids['PAL 185'], 50)
    assert ok(read(viewer, ids['PAL 185'], ids['SVI 166'])) == before
    assert before == [context(ids['PAL 185'], '2'), context(ids['SVI 166'])]
    assert all(set(row) == {'edition_id', 'want_list_need', 'trade_wants_quantity', 'widened', 'shared'} for row in before)
    for private in [other, secret, 'Other private collector', 'Other secret Deck', 'Other secret Location']:
        assert private not in str(before)


def test_authentication_id_validation_and_fifty_id_cap(store):
    viewer, _ = collector()
    assert client.get('/api/social/trade-matches/needs').status_code == 401
    assert call('GET', '/api/social/trade-matches/needs?edition_id=not-a-uuid', viewer).status_code == 422
    editions = [str(uuid4()) for _ in range(50)]
    assert ok(read(viewer, *editions)) == [context(edition) for edition in editions]
    assert read(viewer, *editions, str(uuid4())).status_code == 422
