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
