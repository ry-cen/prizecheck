"""Synthetic, DB-free planner acceptance cases."""
from dataclasses import replace
import hashlib
import json
from uuid import UUID

import pytest

from app.games.riftbound.catalog import plan
from app.games.riftbound.catalog.model import FLAGS, GroupSnapshot
from app.games.riftbound.catalog.normalize import normalise_group, SourceResponseError


def product(pid=9000001, number='001', gid=900, name=None, **fields):
    data = {'Number': number, 'Card Type': 'Unit', 'Description': 'Synthetic rules.', **fields}
    return {'productId': pid, 'groupId': gid, 'name': name or f'Synthetic Unit {pid - 9000000:02}',
            'extendedData': [{'name': k, 'value': v} for k, v in data.items()]}


def price(pid=9000001, finish='Foil'):
    return {'productId': pid, 'subTypeName': finish, 'market': 2.0}


def pull(products=None, prices=(), gid=900, quality='acceptable'):
    products = [product()] if products is None else products
    return plan.GroupPull(plan.GroupInfo(gid, f'Synthetic Set {gid}'), normalise_group(products, list(prices)),
                          quality, {'products': products, 'prices': list(prices)})


def empty():
    return plan.PreviousState({}, {}, {})


def previous(result):
    return plan.PreviousState(result.snapshots, {p.source_id: plan.ExistingPrinting(**{
        **{k: v for k, v in vars(p).items() if k != 'carried'},
        'printing_id': p.printing_id or UUID(int=int(p.source_id))}) for p in result.printings}, result.evidence)


def run(*pulls):
    return plan.plan_run(empty(), pulls)


def kinds(result):
    return {r.kind for r in result.reviews}


def test_first_acceptable_pull_and_alternate_art():
    result = run(pull([product(), product(9000002, '002', name='Synthetic Unit 01 (Alternate Art)'),
                       product(9000003, '003')], [price(), price(9000002, 'Normal')]))
    assert len(result.printings) == 3
    assert result.printings[0].identity_key == result.printings[1].identity_key
    assert [p.editions[0].descriptor for p in result.printings] == [
        {'finish': 'foil'}, {'finish': 'normal'}, plan.UNSPECIFIED]
    assert result.compared == 1 and not result.reviews
    assert result.printings[0].source_fingerprint == hashlib.sha256(json.dumps(
        product(), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def test_same_number_in_two_groups():
    result = run(pull(), pull([product(9000002, gid=901)], gid=901))
    assert len(result.printings) == 2


def test_duplicate_number_holds_only_affected_products():
    result = run(pull([product(), product(9000002), product(9000003, '003')]))
    assert [p.source_id for p in result.printings] == ['9000003']
    assert kinds(result) == {'duplicate_number_pending'}
    assert not result.evidence.keys() & {'synthetic unit 01', 'synthetic unit 02'}


@pytest.mark.parametrize('known', [False, True])
def test_unknown_finish(known):
    result = run(pull(prices=[price(finish='Unknown')] + ([price()] if known else [])))
    assert kinds(result) == {'finish_policy_pending'}
    assert len(result.printings) == int(known)
    if known:
        assert result.printings[0].editions[0].descriptor == {'finish': 'foil'}


@pytest.mark.parametrize('flag', sorted(plan.PRODUCT_HOLD_FLAGS))
def test_each_product_hold_preserves_existing_rows_and_editions(flag):
    accepted = run(pull(prices=[price()]))
    old = previous(accepted)
    current = pull()
    p = replace(current.result.printings[0], flags=(flag,))
    current = replace(current, result=replace(current.result, printings=(p,)))
    result = plan.plan_run(old, [current])
    assert result.printings == (plan.PrintingRow(**vars(old.printings['9000001']), carried=True),)
    assert not result.evidence
    assert not run(current).printings


@pytest.mark.parametrize('variant,code', [
    ('scope', 'card_scope_pending'), ('details', 'printing_details_differ'),
    ('text', 'identity_text_conflict'), ('repeated', 'extended_field_repeated'),
    ('marker', 'marker_grouping_pending')])
def test_normalised_hold_reviews(variant, code):
    products = [product()]
    if variant == 'scope':
        products = [product(number=None)]
    elif variant in ('details', 'text'):
        products.append(product(9000002, '002', name='Synthetic Unit 01 (Alternate Art)',
                                **({'Might': '7'} if variant == 'details' else {'Description': 'Different rules.'})))
    elif variant == 'repeated':
        products[0]['extendedData'].append({'name': 'Number', 'value': '002'})
    else:
        products = [product(name='Synthetic Unit 01 (Unknown)')]
    result = run(pull(products))
    assert code in kinds(result)
    assert not result.printings


def test_token_new_and_existing():
    token = pull([product(**{'Card Type': 'Unit;Token'})])
    assert not run(token).printings and not run(token).reviews
    old = previous(run(pull(prices=[price()])))
    result = plan.plan_run(old, [token])
    assert result.printings[0].carried
    assert kinds(result) == {'card_scope_pending'}
    assert result.printings[0].editions == old.printings['9000001'].editions


def test_missing_and_existing_duplicate():
    old = previous(run(pull(prices=[price()])))
    missing = plan.plan_run(old, [pull([])])
    assert kinds(missing) == {'missing_from_source'} and missing.printings[0].carried
    assert missing.printings[0].editions == old.printings['9000001'].editions
    duplicate = plan.plan_run(old, [pull([product(), product(9000002)])])
    assert kinds(duplicate) == {'duplicate_number_pending'} and duplicate.printings[0].carried


@pytest.mark.parametrize('adds', [True, False])
def test_vanished_foil_price_open_owner_question(monkeypatch, adds):
    monkeypatch.setattr(plan, 'NAMED_FINISH_UNPRICED_ADDS_UNSPECIFIED', adds)
    old = previous(run(pull(prices=[price()])))
    result = plan.plan_run(old, [pull()])
    assert {e.descriptor_key for e in result.printings[0].editions} == {
        plan.descriptor_key({'finish': 'foil'}), *([plan.descriptor_key(plan.UNSPECIFIED)] if adds else [])}


def test_unspecified_then_foil_keeps_both():
    result = plan.plan_run(previous(run(pull())), [pull(prices=[price()])])
    assert len(result.printings[0].editions) == 2


@pytest.mark.parametrize('change', ['name', 'number', 'set_name'])
def test_display_change_keeps_old_display_and_identity(change):
    old = previous(run(pull()))
    current = pull([product(name='Synthetic Changed' if change == 'name' else None,
                            number='002' if change == 'number' else '001')])
    if change == 'set_name':
        current = replace(current, info=plan.GroupInfo(900, 'Changed'))
    result = plan.plan_run(old, [current])
    assert kinds(result) == {'display_change'}
    p, e = result.printings[0], old.printings['9000001']
    assert (p.display_name, p.identity_key, p.collector_number, p.set_name) == (
        e.display_name, e.identity_key, e.collector_number, e.set_name)


def test_moved_group():
    old = previous(run(pull(prices=[price()])))
    result = plan.plan_run(old, [pull([]), pull([product(gid=901)], gid=901)])
    assert kinds(result) == {'group_change', 'missing_from_source'}
    assert result.printings[0].carried and result.printings[0].group_id == 900


@pytest.mark.parametrize('status', ['pull_failed', 'pull_suspicious', 'quality_unknown', 'not_pulled'])
def test_each_noncompared_status_preserves_every_existing_row_and_edition(status):
    old = previous(run(pull(prices=[price(), price(finish='Normal')]), pull([product(9000002, gid=901)], gid=901)))
    current = pull(quality={'pull_suspicious': 'suspicious', 'quality_unknown': 'unknown'}.get(status, 'acceptable'))
    if status == 'pull_failed':
        current = replace(current, result=SourceResponseError('Synthetic failure'))
    result = plan.plan_run(old, [] if status == 'not_pulled' else [current])
    assert result.outcomes[0].status == status
    assert all(p.carried and p.editions == old.printings[p.source_id].editions for p in result.printings)
    assert not result.snapshots and not result.reviews and not result.compared


@pytest.mark.parametrize('conflict', [False, True])
def test_cross_group_identity_evidence(conflict):
    a, b = pull(), pull([product(9000002, gid=901, name='Synthetic Unit 01',
                                Description='Changed.' if conflict else 'Synthetic rules.')], gid=901)
    result = run(a, b)
    assert len(result.printings) == (0 if conflict else 2)
    assert len(result.evidence) == (0 if conflict else 1)
    assert kinds(result) == ({'identity_text_conflict'} if conflict else set())
    assert result == run(b, a)
    old = previous(run(a))
    later = plan.plan_run(old, [b])
    assert len(later.printings) == (1 if conflict else 2)


def test_cross_group_duplicate_including_excluded():
    result = run(pull(), pull([product(gid=901, **{'Card Type': 'Token'})], gid=901))
    assert not result.printings and kinds(result) == {'duplicate_product_id'}


def test_held_missing_corrected_persists_evidence_only_when_written():
    day1 = run(pull([product(), product(9000002)]))
    assert not day1.printings and not day1.evidence
    day2 = plan.plan_run(previous(day1), [pull([])])
    assert not day2.printings and not day2.reviews and not day2.evidence
    day3 = plan.plan_run(previous(day2), [pull()])
    assert len(day3.printings) == 1 and len(day3.evidence) == 1


def test_manual_printing_and_content_digest():
    old = previous(run(pull()))
    e = replace(old.printings['9000001'], source_id=f'manual:{UUID(int=7)}', group_id=None)
    old = replace(old, printings={e.source_id: e, **old.printings})
    result = plan.plan_run(old, [pull([])])
    assert result.printings[-1] == plan.PrintingRow(**vars(e), carried=True)
    assert result.content_sha256 == plan.content_digest(reversed(result.printings))
    assert result.content_sha256 != plan.content_digest(result.printings[:-1])


def test_row_order():
    values = ['9', '10', '9000001', f'manual:{UUID(int=7)}']
    assert sorted(reversed(values), key=plan.row_order) == values
    for bad in ('abc', '', 'manual:bad'):
        with pytest.raises(ValueError):
            plan.row_order(bad)


def test_repeat_plan_is_idempotent():
    current = pull([product(), product(9000002), product(9000003, '003')])
    first = run(current)
    second = plan.plan_run(previous(first), [current])
    assert first.content_sha256 == second.content_sha256
    assert first.reviews == second.reviews
    assert plan.snapshot_to_json(first.snapshots[900]) == plan.snapshot_to_json(second.snapshots[900])


def test_snapshot_json_round_trip():
    result = run(pull(prices=[price(), price(finish='Unknown')]))
    snapshot = result.snapshots[900]
    assert all(not e.prices for p in snapshot.printings for e in p.editions)
    assert plan.snapshot_from_json(json.loads(json.dumps(plan.snapshot_to_json(snapshot)))) == snapshot


def test_quality_has_no_default():
    with pytest.raises(TypeError):
        plan.GroupPull(info=plan.GroupInfo(900, 'Synthetic'), result=None, raw={})


def test_duplicate_group_pull_is_refused():
    with pytest.raises(ValueError, match='duplicate'):
        run(pull(), pull())


def test_review_kinds_cover_every_flag():
    assert plan.REVIEW_KINDS == FLAGS + ('missing_from_source', 'group_change', 'display_change', 'duplicate_product_id')
    assert len(plan.REVIEW_KINDS) == 13


def test_existing_evidence_holds_only_conflicting_group():
    accepted = pull()
    old = previous(run(accepted))
    conflict = pull([product(9000002, gid=901, name='Synthetic Unit 01', Description='Changed.')], gid=901)
    result = plan.plan_run(old, [accepted, conflict])
    assert len(result.printings) == 1 and not result.printings[0].carried
    assert [(r.source_id, r.kind) for r in result.reviews] == [('9000002', 'identity_text_conflict')]


@pytest.mark.parametrize('reason', ['no_identity', 'no_finish', 'duplicate_product_id'])
def test_other_product_holds_keep_accepted_editions(reason):
    old = previous(run(pull(prices=[price()])))
    current = pull(prices=[price()])
    pulls = [current]
    if reason == 'duplicate_product_id':
        pulls.append(pull([product(gid=901)], gid=901))
    else:
        p = current.result.printings[0]
        p = replace(p, identity_key=None) if reason == 'no_identity' else replace(p, editions=())
        pulls = [replace(current, result=replace(current.result, printings=(p,)))]
    result = plan.plan_run(old, pulls)
    assert result.printings == (plan.PrintingRow(**vars(old.printings['9000001']), carried=True),)


def test_snapshot_round_trip_retains_price_observations():
    snapshot = GroupSnapshot(900, pull(prices=[price()]).result.printings)
    assert plan.snapshot_from_json(plan.snapshot_to_json(snapshot)) == snapshot
