"""Synthetic lifecycle decisions only: no database, network, clock, writer or live source samples."""
from copy import deepcopy
from dataclasses import replace

import pytest

from app.games.riftbound.catalog.lifecycle import compare_group
from app.games.riftbound.catalog.model import (FLAGS, FLAG_DUPLICATE_NUMBER_PENDING, GroupSnapshot, PrintingKey,
                                              ReviewItem)
from app.games.riftbound.catalog.normalize import SourceResponseError, normalise_group


def product(pid=9000001, number='001/100', card_type='Unit'):
    return {'productId': pid, 'groupId': 900, 'name': f'Synthetic unit {pid}',
            'extendedData': [{'name': key, 'value': value} for key, value in
                             [('Number', number), ('Card Type', card_type), ('Description', 'Synthetic rules.')]]}


def price(pid=9000001, subtype='Normal', market=1.5):
    return {'productId': pid, 'subTypeName': subtype, 'market': market}


def snapshot(products=None, prices=None):
    result = normalise_group(products if products is not None else [product()],
                             prices if prices is not None else [price()])
    return GroupSnapshot(900, result.printings)


@pytest.mark.parametrize('pull', [None, SourceResponseError('synthetic failure')])
@pytest.mark.parametrize('quality', ['acceptable', 'suspicious', 'unknown'])
def test_failed_pulls_keep_the_exact_previous_snapshot_with_no_changes(pull, quality):
    previous = snapshot()
    decision = compare_group(previous, pull, quality=quality)
    assert decision.status == 'pull_failed' and decision.snapshot is previous
    assert decision.held_missing == decision.held_review == ()


@pytest.mark.parametrize('quality,status', [('suspicious', 'pull_suspicious'), ('unknown', 'quality_unknown')])
def test_untrusted_quality_keeps_previous_even_for_a_structurally_valid_pull(quality, status):
    previous = snapshot()
    decision = compare_group(previous, normalise_group([product(9000002)]), quality=quality)
    assert decision.status == status and decision.snapshot is previous
    assert decision.held_missing == decision.held_review == ()


def test_quality_is_a_required_explicit_verdict():
    previous, pull = snapshot(), normalise_group([product()])
    with pytest.raises(TypeError, match='quality'):
        compare_group(previous, pull)
    for invalid in (None, False, True, '', 'good'):
        with pytest.raises(ValueError, match='quality'):
            compare_group(previous, pull, quality=invalid)


def test_missing_products_are_held_and_never_removed_from_the_snapshot():
    previous = snapshot([product(), product(9000002, number='002/100')])
    decision = compare_group(previous, normalise_group([product()]), quality='acceptable')
    assert decision.status == 'compared'
    assert decision.held_missing == (PrintingKey(900, 9000002),)
    assert [p.key for p in decision.snapshot.printings] == [p.key for p in previous.printings]
    assert decision.snapshot.printings[1] is previous.printings[1]
    repeated = compare_group(decision.snapshot, normalise_group([product()]), quality='acceptable')
    assert repeated.held_missing == decision.held_missing  # still retained on subsequent pulls


def test_successful_empty_pulls_hold_every_product_without_a_numeric_threshold():
    previous = snapshot([product(9000002), product()])
    decision = compare_group(previous, normalise_group([]), quality='acceptable')
    assert decision.held_missing == (PrintingKey(900, 9000001), PrintingKey(900, 9000002))
    assert decision.snapshot.printings == previous.printings
    assert compare_group(previous, normalise_group([]), quality='suspicious').snapshot is previous


def test_duplicate_number_holds_are_present_and_unrelated_products_still_proceed():
    previous = snapshot([product(), product(9000002, number='002/100')])
    pull = normalise_group([product(), product(9000002), product(9000003, number='003/100')])
    assert all(FLAG_DUPLICATE_NUMBER_PENDING in p.flags for p in pull.printings[:2])
    decision = compare_group(previous, pull, quality='acceptable')
    assert decision.held_missing == ()
    assert decision.held_review == (PrintingKey(900, 9000001), PrintingKey(900, 9000002))
    assert len(decision.snapshot.printings) == 3
    assert not decision.snapshot.printings[2].flags


@pytest.mark.parametrize('flag', FLAGS)
def test_any_review_flag_is_presence_evidence_even_without_a_catalog_candidate(flag):
    previous = snapshot()
    pull = replace(normalise_group([]), review=(ReviewItem(flag, (9000001,), 'Synthetic held source record'),))
    decision = compare_group(previous, pull, quality='acceptable')
    assert decision.held_missing == ()
    assert decision.held_review == (PrintingKey(900, 9000001),)
    assert decision.snapshot.printings == previous.printings


@pytest.mark.parametrize('flag', FLAGS)
def test_a_printing_flag_alone_is_also_a_review_hold(flag):
    previous = snapshot()
    pull = normalise_group([product()])
    pull = replace(pull, printings=(replace(pull.printings[0], flags=(flag,)),), review=())
    decision = compare_group(previous, pull, quality='acceptable')
    assert decision.held_missing == ()
    assert decision.held_review == (PrintingKey(900, 9000001),)


def test_an_edition_review_flag_is_not_lost_when_the_printing_has_none():
    previous = snapshot()
    pull = normalise_group([product()], [price(subtype='Unknown synthetic finish')])
    pull = replace(pull, printings=(replace(pull.printings[0], flags=()),), review=())
    assert compare_group(previous, pull, quality='acceptable').held_review == (PrintingKey(900, 9000001),)


def test_a_previously_accepted_product_now_explicitly_excluded_is_not_a_deletion():
    previous = snapshot()
    pull = normalise_group([product(card_type='Unit;Token')])
    assert pull.printings == () and len(pull.excluded) == 1
    decision = compare_group(previous, pull, quality='acceptable')
    assert decision.held_missing == ()
    assert decision.held_review == (PrintingKey(900, 9000001),)
    assert decision.snapshot.printings == previous.printings


def test_disappearing_prices_preserve_editions_and_clear_only_the_missing_observations():
    previous = snapshot(prices=[price(), price(subtype='Foil', market=4)])
    pull = normalise_group([product()], [price(market=2.5)])
    decision = compare_group(previous, pull, quality='acceptable')
    [kept] = decision.snapshot.printings
    assert [(e.subtype, e.finish) for e in kept.editions] == [('Normal', 'normal'), ('Foil', 'foil')]
    assert kept.editions[0].prices[0].market == 2.5
    assert kept.editions[1].prices == ()
    assert previous.printings[0].editions[1].prices[0].market == 4  # prior data is untouched


def test_no_prices_preserves_both_named_editions_alongside_the_unpriced_candidate():
    previous = snapshot(prices=[price(), price(subtype='Foil')])
    decision = compare_group(previous, normalise_group([product()]), quality='acceptable')
    assert {e.finish for e in decision.snapshot.printings[0].editions} == {'normal', 'foil', 'unspecified'}
    assert all(e.prices == () for e in decision.snapshot.printings[0].editions)


def test_unspecified_is_never_automatically_reassigned_when_a_named_finish_appears():
    previous = snapshot(prices=[])
    unspecified = previous.printings[0].editions[0]
    pull = normalise_group([product()], [price(subtype='Foil')])
    decision = compare_group(previous, pull, quality='acceptable')
    assert [(e.subtype, e.finish) for e in decision.snapshot.printings[0].editions] == [
        ('Foil', 'foil'), (None, 'unspecified')]
    assert decision.snapshot.printings[0].editions[1] == unspecified
    repeated = compare_group(decision.snapshot, pull, quality='acceptable')
    assert repeated.snapshot == decision.snapshot  # no duplicate preserved edition


def test_comparison_is_pure_and_scoped_to_one_group():
    previous, pull = snapshot(), normalise_group([product()], [price(subtype='Foil')])
    before = deepcopy((previous, pull))
    assert compare_group(previous, pull, quality='acceptable') == compare_group(previous, pull, quality='acceptable')
    assert (previous, pull) == before
    with pytest.raises(ValueError, match='different groups'):
        compare_group(previous, replace(pull, group_id=901), quality='acceptable')
    with pytest.raises(ValueError, match='unique source keys'):
        compare_group(replace(previous, printings=previous.printings * 2), pull, quality='acceptable')


def test_a_group_with_no_previous_products_can_add_candidates():
    decision = compare_group(GroupSnapshot(900, ()), normalise_group([product()]), quality='acceptable')
    assert decision.status == 'compared' and len(decision.snapshot.printings) == 1
    assert decision.held_missing == decision.held_review == ()


@pytest.mark.parametrize('unpriced', [False, True])
def test_preserved_unknown_editions_keep_their_review_hold(unpriced):
    previous = snapshot(prices=[price(), price(subtype='Unknown synthetic finish')])
    pull = normalise_group([product()], [] if unpriced else [price(market=2.5)])
    decision = compare_group(previous, pull, quality='acceptable')
    assert decision.held_missing == ()
    assert decision.held_review == (PrintingKey(900, 9000001),)
    [kept] = [e for e in decision.snapshot.printings[0].editions if e.subtype == 'Unknown synthetic finish']
    assert kept.flags == ('finish_policy_pending',) and kept.prices == ()
    assert {e.finish for e in decision.snapshot.printings[0].editions} == (
        {'normal', 'unspecified', None} if unpriced else {'normal', None})
    assert previous.printings[0].editions[1].prices[0].market == 1.5
    repeated = compare_group(decision.snapshot, pull, quality='acceptable')
    assert repeated.held_review == decision.held_review and repeated.snapshot == decision.snapshot
