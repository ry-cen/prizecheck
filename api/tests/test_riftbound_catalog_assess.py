"""Synthetic response-envelope and group-verdict checks, without network or DB."""
from copy import deepcopy

import pytest

from app.games.riftbound.catalog import assess, plan
from app.games.riftbound.catalog.lifecycle import compare_group
from app.games.riftbound.catalog.model import GroupSnapshot
from app.games.riftbound.catalog.normalize import SourceResponseError
from test_riftbound_catalog_plan import product, price

INFO = plan.GroupInfo(900, 'Synthetic Set 900')


def envelope(rows, **extra):
    return {'success': True, 'errors': [], 'results': rows, **extra}


@pytest.mark.parametrize('count', [False, True])
def test_complete_pull_is_acceptable(count):
    products, prices = envelope([product()]), envelope([price()])
    if count:
        products['totalItems'] = prices['totalItems'] = 1
    p = assess.assess_pull(INFO, products, prices)
    assert p.quality == 'acceptable' and p.reasons == ()
    assert compare_group(GroupSnapshot(900, ()), p.result, quality=p.quality).status == 'compared'


def test_empty_complete_group_is_acceptable():
    assert assess.assess_pull(INFO, envelope([], totalItems=0), envelope([])).quality == 'acceptable'


@pytest.mark.parametrize('which', ['products', 'prices'])
@pytest.mark.parametrize('case,reason,status', [
    ('false','response_not_success','pull_failed'), ('absent','response_not_success','pull_failed'),
    ('errors','response_not_success','pull_failed'), ('missing','response_not_success','pull_failed'),
    ('bare','response_not_success','pull_failed'), ('not_list','response_not_success','pull_failed'),
    ('count','total_items_mismatch','pull_suspicious'), ('str_count','total_items_mismatch','pull_suspicious'),
    ('bool_count','total_items_mismatch','pull_suspicious'), ('malformed','malformed_response','pull_failed')])
def test_response_failures(which, case, reason, status):
    payloads = {'products': envelope([product()]), 'prices': envelope([price()])}
    p = payloads[which]
    if case == 'false': p['success'] = False
    if case == 'absent': del p['success']
    if case == 'errors': p['errors'] = ['Synthetic failure']
    if case == 'missing': del p['results']
    if case == 'bare': payloads[which] = p['results']
    if case == 'not_list': p['results'] = {}
    if case == 'count': p['totalItems'] = 2
    if case == 'str_count': p['totalItems'] = '1'
    if case == 'bool_count': p['totalItems'] = True
    if case == 'malformed': p['results'] = [{}]
    result = assess.assess_pull(INFO, **payloads)
    assert result.quality == 'suspicious' and result.reasons == (reason,)
    assert compare_group(GroupSnapshot(900, ()), result.result, quality=result.quality).status == status


def test_fetch_failed():
    result = assess.assess_pull(INFO, None, None, fetch_error='Synthetic HTTP failure')
    assert result.quality == 'suspicious' and result.reasons == ('fetch_failed',)
    assert result.raw == {'error': 'Synthetic HTTP failure'}
    assert compare_group(GroupSnapshot(900, ()), result.result, quality=result.quality).status == 'pull_failed'


@pytest.mark.parametrize('field,value,reason', [('groupId',901,'wrong_group'), ('categoryId',1,'wrong_category')])
def test_wrong_source_scope(field, value, reason):
    p = product(); p[field] = value
    result = assess.assess_pull(INFO, envelope([p]), envelope([]))
    assert result.quality == 'suspicious' and result.reasons == (reason,)
    assert compare_group(GroupSnapshot(900, ()), result.result, quality=result.quality).status == 'pull_suspicious'


def test_never_returns_unknown():
    for products in (None, [], envelope([]), envelope([product()], totalItems=100)):
        assert assess.assess_pull(INFO, products, envelope([])).quality in ('acceptable','suspicious')


def test_listed_groups_requires_success_and_category_89():
    good = envelope([{'groupId':901,'name':'Synthetic B','categoryId':89},
                     {'groupId':900,'name':'Synthetic A','categoryId':89}])
    assert assess.listed_groups(good) == (plan.GroupInfo(900,'Synthetic A'), plan.GroupInfo(901,'Synthetic B'))
    for bad in ([], {}, {**good,'success':False}, {**good,'errors':['error']}, {**good,'results':None}):
        with pytest.raises(SourceResponseError): assess.listed_groups(bad)
    for field,value in [('groupId',True), ('groupId','900'), ('name',None), ('categoryId',1)]:
        bad = deepcopy(good); bad['results'][0][field] = value
        with pytest.raises(ValueError): assess.listed_groups(bad)


def test_collects_sorted_reasons_and_keeps_raw():
    p = {**product(gid=901), 'categoryId':1}
    products = envelope([p], totalItems=2)
    result = assess.assess_pull(INFO, products, envelope([]))
    assert result.reasons == ('total_items_mismatch','wrong_category','wrong_group')
    assert result.raw['products'] is products


@pytest.mark.parametrize('subtype', [[], {}], ids=['list', 'object'])
def test_malformed_price_subtype_becomes_group_hold(subtype):
    result = assess.assess_pull(INFO, envelope([product()]),
                                envelope([{**price(), 'subTypeName': subtype}]))
    assert result.quality == 'suspicious'
    assert result.reasons == ('malformed_response',)
    assert result.result is None
    assert compare_group(GroupSnapshot(900, ()), result.result, quality=result.quality).status == 'pull_failed'
    planned = plan.plan_run(plan.PreviousState({}, {}, {}), [result])
    assert len(planned.reviews) == 1
    review = planned.reviews[0]
    assert (review.source_id, review.kind, review.detail) == ('group:900', 'group_pull_held', 'malformed_response')
    assert review.candidate == {'group_id': 900, 'status': 'pull_failed', 'reasons': ['malformed_response']}


@pytest.mark.parametrize('error_type', [ValueError, TypeError, KeyError, AttributeError, IndexError])
def test_normalisation_shape_errors_are_held(monkeypatch, error_type):
    def malformed(*args):
        raise error_type('Synthetic malformed source shape')
    monkeypatch.setattr(assess, 'normalise_group', malformed)
    result = assess.assess_pull(INFO, envelope([product()]), envelope([price()]))
    assert result.result is None
    assert result.quality == 'suspicious' and result.reasons == ('malformed_response',)


def test_normalisation_error_outside_caught_tuple_propagates(monkeypatch):
    error = RuntimeError('Synthetic error outside the caught tuple')
    def unexpected(*args):
        raise error
    monkeypatch.setattr(assess, 'normalise_group', unexpected)
    with pytest.raises(RuntimeError) as caught:
        assess.assess_pull(INFO, envelope([product()]), envelope([price()]))
    assert caught.value is error


@pytest.mark.parametrize('which', ['products', 'prices'])
@pytest.mark.parametrize('identifier', [-1, 0, 10**19, True, '5'])
def test_invalid_product_id_is_held_while_sibling_is_compared(which, identifier):
    payloads = {'products': envelope([product()]), 'prices': envelope([price()])}
    payloads[which]['results'][0]['productId'] = identifier
    held = assess.assess_pull(INFO, **payloads)
    sibling = assess.assess_pull(plan.GroupInfo(901, 'Synthetic Set 901'),
                                 envelope([product(9000002, '002', gid=901)]), envelope([]))
    assert held.quality == 'suspicious' and 'invalid_id' in held.reasons
    result = plan.plan_run(plan.PreviousState({}, {}, {}), [held, sibling])
    assert [(o.group_id, o.status) for o in result.outcomes] == [(900, 'pull_failed'), (901, 'compared')]
    assert result.compared == 1 and [p.source_id for p in result.printings] == ['9000002']
    assert len(result.reviews) == 1
    assert result.reviews[0].kind == 'group_pull_held'
    assert result.reviews[0].source_id == 'group:900'
    assert 'invalid_id' in result.reviews[0].candidate['reasons']


@pytest.mark.parametrize('identifier', [-1, 0, 2147483648, True])
def test_listed_groups_rejects_out_of_domain_id(identifier):
    with pytest.raises(ValueError):
        assess.listed_groups(envelope([{'groupId': identifier, 'name': 'Synthetic', 'categoryId': 89}]))


@pytest.mark.parametrize('which', ['products', 'prices'])
@pytest.mark.parametrize('identifier', [-1, 0, 2147483648, True, '5'])
def test_raw_group_ids_must_fit_storage_domain(which, identifier):
    payloads = {'products': envelope([product()]), 'prices': envelope([price()])}
    payloads[which]['results'][0]['groupId'] = identifier
    held = assess.assess_pull(INFO, **payloads)
    assert held.quality == 'suspicious' and 'invalid_id' in held.reasons


@pytest.mark.parametrize('field,identifier', [('product_id', -1), ('product_id', 10**19), ('group_id', 2147483648)])
def test_normalised_printing_keys_are_rechecked(monkeypatch, field, identifier):
    from dataclasses import replace
    result = assess.normalise_group(envelope([product()]), envelope([]))
    printing = result.printings[0]
    result = replace(result, printings=(replace(printing, key=replace(printing.key, **{field: identifier})),))
    monkeypatch.setattr(assess, 'normalise_group', lambda *args: result)
    held = assess.assess_pull(INFO, envelope([product()]), envelope([]))
    assert held.quality == 'suspicious' and held.reasons == ('invalid_id',)
    assert held.result is None


def test_id_domain_upper_and_lower_bounds_are_accepted():
    for gid in (1, 2_147_483_647):
        assert assess.listed_groups(envelope([{'groupId': gid, 'name': 'Synthetic', 'categoryId': 89}]))[0].group_id == gid
        for pid in (1, 9_999_999_999_999_999_999):
            result = assess.assess_pull(plan.GroupInfo(gid, 'Synthetic'),
                envelope([product(pid=pid, gid=gid)]), envelope([price(pid=pid)]))
            assert result.quality == 'acceptable'
