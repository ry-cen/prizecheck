"""Riftbound TCGCSV group normaliser (#534), on synthetic groups only; no database, no network.

Case IDs are from docs/planning/shared-core/riftbound-catalog-acceptance.md. Review cases assert retention under the owner-approved rules. Unsupported evidence remains in review;
confirmed Token records remain in the separate excluded-source list. No real source records are fixtures.
"""
import ast
import json
from pathlib import Path

import pytest

from app.games.riftbound.catalog.model import (
    FLAG_CARD_SCOPE_PENDING, FLAG_DUPLICATE_NUMBER_PENDING, FLAG_EXTENDED_FIELD_REPEATED, FLAG_FINISH_POLICY_PENDING,
    FLAG_IDENTITY_TEXT_CONFLICT,
    FLAG_MARKER_GROUPING_PENDING, FLAG_MULTI_VALUE_UNPARSED, FLAG_PRICE_WITHOUT_PRODUCT, FLAG_PRINTING_DETAILS_DIFFER,
    FLAGS)
from app.games.riftbound.catalog import model
from app.games.riftbound.catalog.normalize import SourceResponseError, normalise_group

NEXT_ID = iter(range(9000001, 9100000))


def product(name, number='001/100', card_type='Unit', group=900, domain='DomainA', tag=None, text='Synthetic text.',
            rarity='Common', product_id=None, **extra):
    fields = {'Number': number, 'Card Type': card_type, 'Domain': domain, 'Tag': tag, 'Description': text,
              'Rarity': rarity, **extra}
    pid = product_id or next(NEXT_ID)
    return {'productId': pid, 'name': name, 'cleanName': name, 'groupId': group,
            'imageUrl': f'https://example.invalid/{pid}.jpg', 'modifiedOn': '2026-01-01T00:00:00',
            'extendedData': [{'name': key, 'displayName': key, 'value': value}
                             for key, value in fields.items() if value is not None]}


def price(item, subtype, market=1.5):
    return {'productId': item['productId'], 'low': 1.0, 'mid': 1.25, 'high': 2.0, 'market': market,
            'directLow': None, 'subTypeName': subtype}


def by_id(result):
    return {p.key.product_id: p for p in result.printings}


def codes(result):
    return sorted(item.code for item in result.review)


def test_rb_id_01_alternate_art_is_one_identity_with_two_printings():
    base, alt = product('Synthetic Unit 01'), product('Synthetic Unit 01 (Alternate Art)', number='001a/100')
    result = normalise_group([base, alt], [price(base, 'Normal'), price(alt, 'Foil')])
    assert [(i.display_name, len(i.printings)) for i in result.identities] == [('Synthetic Unit 01', 2)]
    printings = by_id(result)
    assert printings[base['productId']].identity_key == printings[alt['productId']].identity_key is not None
    assert printings[alt['productId']].marker == 'Alternate Art'
    assert printings[alt['productId']].base_name == 'Synthetic Unit 01'
    assert result.review == ()


def test_rb_id_01_unsupported_marker_matches_are_kept_unmerged_for_review():
    base = product('Synthetic Unit 01')
    over = product('Synthetic Unit 01 (Overnumbered)', number='101/100')
    signed = product('Synthetic Unit 01 (Signature)', number='101*/100')
    result = normalise_group([base, over, signed], [price(p, 'Foil') for p in (base, over, signed)])
    printings = by_id(result)
    for item in (over, signed):
        kept = printings[item['productId']]
        assert kept.identity_key is None
        assert kept.base_name == 'Synthetic Unit 01'  # the proposed base name travels with the product
        assert FLAG_MARKER_GROUPING_PENDING in kept.flags
    assert [(i.display_name, len(i.printings)) for i in result.identities] == [('Synthetic Unit 01', 1)]
    assert codes(result) == [FLAG_MARKER_GROUPING_PENDING] * 2
    assert {pid for item in result.review for pid in item.product_ids} == {over['productId'], signed['productId']}


def test_a_different_name_is_a_different_identity():
    first, second = product('Synthetic Unit 03, Alluring'), product('Synthetic Unit 03, Inquisitive', number='002/100')
    result = normalise_group([first, second], [price(first, 'Normal'), price(second, 'Normal')])
    assert sorted(i.display_name for i in result.identities) == ['Synthetic Unit 03, Alluring',
                                                                 'Synthetic Unit 03, Inquisitive']


def test_same_name_with_conflicting_text_goes_to_review_unmerged():
    """The Kai'Sa case: two products, one name, different rules text."""
    first = product('Synthetic Unit 04', text='Draw a card.')
    second = product('Synthetic Unit 04', number='002/100', text='Discard a card.')
    result = normalise_group([first, second], [price(first, 'Normal'), price(second, 'Normal')])
    assert result.identities == ()
    assert [p.identity_key for p in result.printings] == [None, None]
    assert all(FLAG_IDENTITY_TEXT_CONFLICT in p.flags for p in result.printings)
    [item] = result.review
    assert item.code == FLAG_IDENTITY_TEXT_CONFLICT
    assert item.product_ids == (first['productId'], second['productId'])


def test_alternate_art_with_conflicting_text_is_also_not_merged():
    base = product('Synthetic Unit 05', text='Draw a card.')
    alt = product('Synthetic Unit 05 (Alternate Art)', number='001a/100', text='Discard a card.')
    result = normalise_group([base, alt])
    assert result.identities == ()
    assert FLAG_IDENTITY_TEXT_CONFLICT in codes(result)


def test_case_whitespace_and_html_tags_alone_are_not_conflicts():
    """The comparison is conservative comparison: differences other than case, whitespace and HTML tags go to review."""
    base = product('Synthetic Unit 06', text='[KEYWORD]\r\n<br>\r\nDraw  a card.')
    alt = product('Synthetic Unit 06 (Alternate Art)', number='001a/100', text='[keyword] <b>draw a card.</b>')
    result = normalise_group([base, alt])
    assert [len(i.printings) for i in result.identities] == [2]
    assert FLAG_IDENTITY_TEXT_CONFLICT not in codes(result)


@pytest.mark.parametrize('other', [
    '[KEYWORD] <em>(You may pay 1 Resource as an additional cost.)</em>',   # reminder wording differs
    '[KEYWORD]',                                                            # reminder text missing
])
def test_a_difference_inside_the_reminder_text_goes_to_review_unmerged(other):
    """Regression, from the real shape of a same-name pair: the base card and its Alternate Art differ only inside
    the `<em>` reminder text. Conservative comparison: that is a conflict, never silently reconciled."""
    base = product('Synthetic Unit 06', text='[KEYWORD] <em>(You may pay 1 and 1 Resource as an additional cost.)</em>')
    alt = product('Synthetic Unit 06 (Alternate Art)', number='001a/100', text=other)
    result = normalise_group([base, alt])
    assert result.identities == ()
    assert [p.identity_key for p in result.printings] == [None, None]
    [item] = [i for i in result.review if i.code == FLAG_IDENTITY_TEXT_CONFLICT]
    assert item.product_ids == (base['productId'], alt['productId'])


def test_alternate_art_is_grouped_only_as_the_sole_bracketed_part_of_a_name():
    plain = product('Synthetic Unit 07 (Alternate Art)', number='001a/100')
    nested = product('Synthetic Unit 08 (Metal) (Alternate Art)', number='002a/100')
    inner = product('Synthetic Unit 09 (Metal)', number='003/100')
    leading = product('Synthetic Unit 10 (271) Token Copy', number='004/100')
    result = normalise_group([plain, nested, inner, leading])
    printings = by_id(result)
    assert printings[plain['productId']].identity_key is not None
    for item in (nested, inner, leading):
        kept = printings[item['productId']]
        assert kept.identity_key is None and FLAG_MARKER_GROUPING_PENDING in kept.flags
    assert printings[nested['productId']].base_name == 'Synthetic Unit 08 (Metal)'
    assert printings[nested['productId']].marker == 'Alternate Art'
    assert [i.product_ids for i in result.review if i.code == FLAG_MARKER_GROUPING_PENDING] == [
        (nested['productId'],), (inner['productId'],), (leading['productId'],)]


def test_rb_scope_01_a_product_with_number_and_card_type_has_no_scope_flag():
    item = product('Synthetic Unit 01')
    [kept] = normalise_group([item], [price(item, 'Normal')]).printings
    assert FLAG_CARD_SCOPE_PENDING not in kept.flags
    assert (kept.scope.has_number, kept.scope.has_card_type, kept.scope.looks_sealed, kept.scope.looks_token) == (
        True, True, False, False)
    assert kept.number == '001/100'


@pytest.mark.parametrize('case, item, expected', [
    # Approved scope rule: incomplete evidence stays in the output for review.
    ('RB-SCOPE-02 sealed', product('Synthetic Booster Pack', number=None, card_type=None, domain=None, rarity=None),
     (False, False, True, False)),
    ('RB-SCOPE-04 number, no card type', product('Synthetic Unit 07', card_type=None), (True, False, False, False)),
])
def test_rb_scope_incomplete_evidence_is_retained_classified_and_flagged(case, item, expected):
    result = normalise_group([item], [price(item, 'Normal')])
    [kept] = result.printings
    assert (kept.scope.has_number, kept.scope.has_card_type, kept.scope.looks_sealed, kept.scope.looks_token) == expected
    assert FLAG_CARD_SCOPE_PENDING in kept.flags
    assert kept.identity_key is None and result.identities == ()  # no identity without enough scope evidence
    assert result.counts['products'] == 1 and result.counts[FLAG_CARD_SCOPE_PENDING] == 1
    assert kept.name == item['name'] and kept.editions  # nothing lost


def test_the_literal_none_is_no_card_type_and_no_domain():
    item = product('Synthetic Unit 09', card_type='None', domain='None')
    [kept] = normalise_group([item]).printings
    assert kept.card_types == () and kept.domains == ()
    assert FLAG_CARD_SCOPE_PENDING in kept.flags
    assert kept.extended['Card Type'] == 'None'  # the raw value stays


def test_rb_pe_04_the_same_number_in_two_groups_is_two_printings():
    one, two = product('Synthetic Unit 01', group=900), product('Synthetic Promo 01', group=901)
    first, second = normalise_group([one]), normalise_group([two])
    assert first.printings[0].number == second.printings[0].number == '001/100'
    assert first.printings[0].key != second.printings[0].key
    assert (first.printings[0].key.group_id, second.printings[0].key.group_id) == (900, 901)


def test_rb_pe_05_duplicate_numbers_hold_only_affected_products():
    one, two = product('Synthetic Unit 10'), product('Synthetic Unit 11')  # both 001/100
    other = product('Synthetic Unit 12', number='002/100')
    result = normalise_group([one, two, other], [price(p, 'Normal') for p in (one, two, other)])
    printings = by_id(result)
    assert FLAG_DUPLICATE_NUMBER_PENDING in printings[one['productId']].flags
    assert FLAG_DUPLICATE_NUMBER_PENDING in printings[two['productId']].flags
    assert FLAG_DUPLICATE_NUMBER_PENDING not in printings[other['productId']].flags
    [item] = [i for i in result.review if i.code == FLAG_DUPLICATE_NUMBER_PENDING]
    assert item.product_ids == (one['productId'], two['productId'])
    assert len(result.printings) == 3 and len(result.identities) == 3  # nothing refused, all three kept


def test_the_source_number_form_is_kept():
    numbers = ['2/100', '7a/100', '101*/100', 'P-001', '001/100']
    items = [product(f'Synthetic Unit {n}', number=number) for n, number in enumerate(numbers, 20)]
    assert [p.number for p in normalise_group(items).printings] == numbers


def test_rb_fin_01_normal_and_foil_are_two_editions_on_one_printing():
    item = product('Synthetic Unit 01')
    [kept] = normalise_group([item], [price(item, 'Normal', 1.0), price(item, 'Foil', 3.0)]).printings
    assert [(e.subtype, e.finish) for e in kept.editions] == [('Normal', 'normal'), ('Foil', 'foil')]
    assert kept.editions[1].prices[0].market == 3.0  # prices are carried as data
    assert kept.price_subtypes == ('Normal', 'Foil')
    assert FLAG_FINISH_POLICY_PENDING not in kept.flags


@pytest.mark.parametrize('subtype, finish', [('Foil', 'foil'), ('Normal', 'normal')])
def test_rb_fin_02_and_03_only_the_observed_finish_is_an_edition(subtype, finish):
    item = product('Synthetic Unit 01')
    [kept] = normalise_group([item], [price(item, subtype)]).printings
    assert [(e.subtype, e.finish) for e in kept.editions] == [(subtype, finish)]


def test_rb_fin_04_an_eligible_unpriced_product_has_one_unspecified_edition():
    item = product('Synthetic Unit 01')
    result = normalise_group([item], [])
    [kept] = result.printings
    assert [(e.subtype, e.finish, e.prices) for e in kept.editions] == [(None, 'unspecified', ())]
    assert kept.price_subtypes == ()
    assert FLAG_FINISH_POLICY_PENDING not in kept.flags
    assert result.review == ()


def test_rb_fin_06_an_unknown_subtype_is_kept_and_flagged():
    item = product('Synthetic Unit 01')
    result = normalise_group([item], [price(item, 'Normal'), price(item, 'Synthetic Finish', 9.0)])
    [kept] = result.printings
    unknown = [e for e in kept.editions if e.subtype == 'Synthetic Finish']
    assert len(unknown) == 1 and unknown[0].finish is None and unknown[0].prices[0].market == 9.0
    assert unknown[0].flags == (FLAG_FINISH_POLICY_PENDING,)
    assert FLAG_FINISH_POLICY_PENDING in kept.flags
    assert [e.finish for e in kept.editions if e.subtype == 'Normal'] == ['normal']


def test_rb_promo_01_a_promo_without_rarity_is_not_an_error():
    item = product('Synthetic Promo 01', group=901, number='P-001', rarity=None)
    result = normalise_group([item], [price(item, 'Normal')])
    [kept] = result.printings
    assert kept.rarity is None and kept.flags == () and len(kept.editions) == 1
    assert result.review == ()


def test_rb_promo_02_an_apparently_sealed_promo_is_kept_for_review():
    pack = product('Synthetic Promo Pack', group=901, number=None, card_type=None, domain=None, rarity=None)
    result = normalise_group([pack], [price(pack, 'Normal')])
    assert len(result.printings) == 1 and FLAG_CARD_SCOPE_PENDING in result.printings[0].flags
    assert result.printings[0].scope.looks_sealed


def test_rb_dom_01_a_semicolon_splits_domains():
    item = product('Synthetic Unit 01', domain='DomainA;DomainB')
    [kept] = normalise_group([item]).printings
    assert kept.domains == ('DomainA', 'DomainB')
    assert FLAG_MULTI_VALUE_UNPARSED not in kept.flags


def test_rb_dom_03_a_missing_domain_is_an_empty_list():
    item = product('Synthetic Unit 01', domain=None)
    [kept] = normalise_group([item]).printings
    assert kept.domains == () and kept.flags.count(FLAG_MULTI_VALUE_UNPARSED) == 0


@pytest.mark.parametrize('raw', ['DomainA,DomainB', 'DomainA/DomainB', 'DomainA | DomainB', 'DomainA & DomainB'])
def test_rb_dom_04_another_delimiter_is_kept_raw_and_flagged(raw):
    item = product('Synthetic Unit 01', domain=raw)
    result = normalise_group([item])
    [kept] = result.printings
    assert kept.domains == (raw,)
    assert FLAG_MULTI_VALUE_UNPARSED in kept.flags
    assert [i.code for i in result.review if i.code == FLAG_MULTI_VALUE_UNPARSED] == [FLAG_MULTI_VALUE_UNPARSED]


def test_rb_dom_05_tags_are_split_like_domains_and_kept_apart():
    item = product('Synthetic Unit 01', domain='DomainA', tag='TagA;Tag B;TagC')
    [kept] = normalise_group([item]).printings
    assert kept.tags == ('TagA', 'Tag B', 'TagC')
    assert kept.domains == ('DomainA',)
    other = product('Synthetic Unit 02', number='002/100', tag='TagA,TagB')
    [raw] = normalise_group([other]).printings
    assert raw.tags == ('TagA,TagB',) and FLAG_MULTI_VALUE_UNPARSED in raw.flags


def test_flavor_text_html_is_kept_raw_with_a_plain_copy():
    item = product('Synthetic Unit 01', **{'Flavor Text': '<em>"Synthetic &amp; quiet."</em>'})
    [kept] = normalise_group([item]).printings
    assert kept.flavor_text_html == '<em>"Synthetic &amp; quiet."</em>'
    assert kept.flavor_text_plain == '"Synthetic & quiet."'
    [none] = normalise_group([product('Synthetic Unit 02')]).printings
    assert none.flavor_text_html is None and none.flavor_text_plain is None


def test_a_price_for_a_product_not_in_the_group_is_reported():
    item = product('Synthetic Unit 01')
    stray = {'productId': 9099999, 'market': 1.0, 'subTypeName': 'Normal'}
    result = normalise_group([item], [price(item, 'Normal'), stray])
    assert [(i.code, i.product_ids) for i in result.review] == [(FLAG_PRICE_WITHOUT_PRODUCT, (9099999,))]


def test_no_product_and_no_price_row_is_lost_and_the_output_is_ordered():
    items = [product('Synthetic Unit 01'), product('Synthetic Unit 01 (Signature)', number='101*/100'),
             product('Synthetic Booster', number=None, card_type=None), product('Synthetic Unit 02', number='001/100'),
             product('Synthetic Unit 03', number='003/100', domain='A,B')]
    rows = [price(items[0], 'Normal'), price(items[0], 'Foil'), price(items[1], 'Mystery'), price(items[3], 'Foil')]
    result = normalise_group(list(reversed(items)), rows)
    assert [p.key.product_id for p in result.printings] == sorted(i['productId'] for i in items)
    assert sum(len(e.prices) for p in result.printings for e in p.editions) == len(rows)
    assert result.counts['products'] == 5 and result.counts['editions'] == 5
    assert normalise_group(items, rows) == result  # same input, same result


def test_a_response_object_and_a_bare_list_give_the_same_result():
    item = product('Synthetic Unit 01')
    rows = [price(item, 'Normal')]
    envelope = normalise_group({'success': True, 'errors': [], 'results': [item]},
                               {'success': True, 'errors': [], 'results': rows})
    assert envelope == normalise_group([item], rows)


def test_a_synthetic_group_file_round_trips():
    directory = Path(__file__).parent / 'fixtures' / 'riftbound_synthetic'
    products = json.loads((directory / 'group-900-products.json').read_text())
    prices = json.loads((directory / 'group-900-prices.json').read_text())
    result = normalise_group(products, prices)
    assert result.group_id == 900
    assert result.counts['products'] == len(result.printings) + len(result.excluded) == len(products['results'])
    assert all(p.image_url.startswith('https://example.invalid/') for p in result.printings)
    assert {FLAG_CARD_SCOPE_PENDING, FLAG_MARKER_GROUPING_PENDING, FLAG_MULTI_VALUE_UNPARSED,
            FLAG_FINISH_POLICY_PENDING, FLAG_DUPLICATE_NUMBER_PENDING, FLAG_IDENTITY_TEXT_CONFLICT} == set(codes(result))


def alternate_pair(**overrides):
    """A base card and its Alternate Art with the same details, except for the given product() arguments."""
    details = {'domain': 'DomainA', 'tag': 'TagA;TagB', 'card_type': 'Unit', 'rarity': 'Common',
               'Energy Cost': '3', 'Power Cost': '0', 'Might': '2'}
    base = product('Synthetic Unit 20', **details)
    alt = product('Synthetic Unit 20 (Alternate Art)', number='001a/100', **{**details, **overrides})
    return base, alt


def test_printings_with_conflicting_details_are_kept_unmerged_for_review():
    """Decision 5: unmerged candidates do not assert distinct underlying cards."""
    base, alt = alternate_pair(domain=None, tag='TagC')
    result = normalise_group([base, alt], [price(base, 'Normal'), price(alt, 'Normal')])
    assert result.identities == ()
    assert all(p.identity_key is None and FLAG_PRINTING_DETAILS_DIFFER in p.flags for p in result.printings)
    assert FLAG_IDENTITY_TEXT_CONFLICT not in codes(result)
    [item] = [i for i in result.review if i.code == FLAG_PRINTING_DETAILS_DIFFER]
    assert item.product_ids == (base['productId'], alt['productId'])
    assert 'Domain' in item.detail and 'Tag' in item.detail and 'Might' not in item.detail
    assert [p.domains for p in result.printings] == [('DomainA',), ()]  # every value is still on its printing


@pytest.mark.parametrize('field, override', [
    ('Domain', {'domain': 'DomainB'}), ('Tag', {'tag': 'TagC'}), ('Card Type', {'card_type': 'Spell'}),
    ('Energy Cost', {'Energy Cost': '4'}), ('Power Cost', {'Power Cost': '1'}), ('Might', {'Might': '3'})])
def test_each_compared_detail_is_named_when_it_differs(field, override):
    base, alt = alternate_pair(**override)
    result = normalise_group([base, alt], [price(base, 'Normal'), price(alt, 'Normal')])
    [item] = [i for i in result.review if i.code == FLAG_PRINTING_DETAILS_DIFFER]
    assert item.detail.endswith('differ on ' + field)
    assert result.identities == ()
    assert all(p.identity_key is None for p in result.printings)


def test_a_difference_in_rarity_alone_is_not_a_details_difference():
    """Rarity belongs to each printing; artwork versions are expected to differ in it."""
    base, alt = alternate_pair(rarity='Showcase')
    result = normalise_group([base, alt], [price(base, 'Normal'), price(alt, 'Normal')])
    assert [len(i.printings) for i in result.identities] == [2]
    assert FLAG_PRINTING_DETAILS_DIFFER not in codes(result)
    assert all(p.flags == () for p in result.printings)
    assert {p.rarity for p in result.printings} == {'Common', 'Showcase'}


def test_matching_details_and_a_different_order_of_values_are_not_flagged():
    base = product('Synthetic Unit 21', domain='DomainA;DomainB', tag='TagA;TagB')
    alt = product('Synthetic Unit 21 (Alternate Art)', number='001a/100', domain='DomainB;DomainA', tag='TagB;TagA')
    result = normalise_group([base, alt], [price(base, 'Normal'), price(alt, 'Normal')])
    assert FLAG_PRINTING_DETAILS_DIFFER not in codes(result)
    assert all(FLAG_PRINTING_DETAILS_DIFFER not in p.flags for p in result.printings)


def test_every_flag_the_normaliser_emits_is_in_flags():
    assert {value for name, value in vars(model).items() if name.startswith('FLAG_')} == set(FLAGS)
    directory = Path(__file__).parent / 'fixtures' / 'riftbound_synthetic'
    grouped = normalise_group(json.loads((directory / 'group-900-products.json').read_text()),
                              json.loads((directory / 'group-900-prices.json').read_text()))
    repeated = product('Synthetic Unit 30')
    repeated['extendedData'].append({'name': 'Number', 'displayName': 'Number', 'value': '002/100'})
    stray = {'productId': 9099999, 'market': 1.0, 'subTypeName': 'Normal'}
    detail = normalise_group(list(alternate_pair(domain='DomainB')), [stray])
    emitted = set()
    for result in (grouped, normalise_group([repeated], [stray]), detail):
        emitted |= {item.code for item in result.review}
        emitted |= {flag for p in result.printings for flag in p.flags}
        emitted |= {flag for p in result.printings for e in p.editions for flag in e.flags}
    assert FLAG_EXTENDED_FIELD_REPEATED in emitted and FLAG_PRINTING_DETAILS_DIFFER in emitted
    assert FLAG_PRICE_WITHOUT_PRODUCT in emitted
    assert emitted <= set(FLAGS)


@pytest.mark.parametrize('payload', [
    {'success': False, 'errors': ['Rate limited'], 'results': []},
    {'success': True, 'errors': ['Something'], 'results': []},
    {'success': True, 'errors': []},
    {'success': True, 'errors': [], 'results': None},
])
def test_a_failed_or_incomplete_response_is_not_an_empty_group(payload):
    with pytest.raises(SourceResponseError):
        normalise_group(payload, [])
    with pytest.raises(SourceResponseError):
        normalise_group([], payload)


def test_a_successful_empty_response_is_an_empty_group():
    result = normalise_group({'success': True, 'errors': [], 'results': []}, {'success': True, 'errors': [], 'results': []})
    assert result.printings == ()


def test_a_card_type_with_an_unrecognised_separator_is_scope_pending_and_gets_no_identity():
    item = product('Synthetic Unit 11', card_type='Unit, Token')
    result = normalise_group([item], [price(item, 'Normal')])
    [kept] = result.printings
    assert kept.card_types == ('Unit, Token',) and kept.scope.card_type_unparsed
    assert {FLAG_CARD_SCOPE_PENDING, FLAG_MULTI_VALUE_UNPARSED} <= set(kept.flags)
    assert kept.identity_key is None and result.identities == ()


def test_a_repeated_extended_field_keeps_every_value_and_is_flagged():
    item = product('Synthetic Unit 12')
    item['extendedData'].append({'name': 'Number', 'displayName': 'Number', 'value': '002/100'})
    result = normalise_group([item], [price(item, 'Normal')])
    [kept] = result.printings
    assert [value for name, value in kept.extended_entries if name == 'Number'] == ['001/100', '002/100']
    assert len(kept.extended_entries) == len(item['extendedData'])
    assert FLAG_EXTENDED_FIELD_REPEATED in kept.flags
    assert kept.identity_key is None  # which Number or Description counts is not decided here
    assert [i.code for i in result.review if i.code == FLAG_EXTENDED_FIELD_REPEATED] == [FLAG_EXTENDED_FIELD_REPEATED]


def test_a_printing_candidate_is_hashable():
    item = product('Synthetic Unit 13')
    [kept] = normalise_group([item], [price(item, 'Normal')]).printings
    assert isinstance(hash(kept), int)


@pytest.mark.parametrize('products', [
    [{'name': 'x', 'groupId': 900}],
    [{'productId': 9000001}],
    [product('Synthetic Unit 01', product_id=9000001), product('Synthetic Unit 02', product_id=9000001)],
    [product('Synthetic Unit 01', group=900), product('Synthetic Unit 02', group=901)],
    'not a list',
    [{**product('Synthetic Unit 01'), 'extendedData': [{'value': 'x'}]}],
    [{**product('Synthetic Unit 01'), 'extendedData': [{'name': 'Number', 'value': 1}]}],
    [{**product('Synthetic Unit 01'), 'extendedData': 'x'}],
    [{**product('Synthetic Unit 01'), 'name': 5}],
])
def test_a_structurally_broken_payload_is_refused_loudly(products):
    with pytest.raises(ValueError):
        normalise_group(products)


def test_a_price_row_without_an_integer_product_id_is_refused_loudly():
    item = product('Synthetic Unit 01')
    for stray in ({'subTypeName': 'Normal'}, {'productId': None, 'subTypeName': 'Normal'}):
        with pytest.raises(ValueError):
            normalise_group([item], [price(item, 'Normal'), stray, {**stray, 'productId': 9099999}])


def test_an_empty_group_gives_an_empty_result():
    result = normalise_group({'results': []}, {'results': []})
    assert (result.group_id, result.printings, result.identities, result.review) == (None, (), (), ())


def test_the_module_imports_no_pokemon_code():
    root = Path(__file__).parents[1] / 'app' / 'games' / 'riftbound'
    for path in root.rglob('*.py'):
        for node in ast.walk(ast.parse(path.read_text())):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else (
                [node.module or ''] if isinstance(node, ast.ImportFrom) else [])
            assert not any('pokemon' in name for name in names), path


@pytest.mark.parametrize('card_type', ['Token', 'Unit;Token', 'Unit;Battlefield;Token', 'Gear;Token'])
@pytest.mark.parametrize('number', [None, 'T01'])
def test_explicit_token_types_are_excluded_and_the_source_data_is_retained(card_type, number):
    item = product('Synthetic token-shaped product', card_type=card_type, number=number)
    result = normalise_group([item], [price(item, 'Foil')])
    assert result.printings == result.identities == ()
    [excluded] = result.excluded
    assert excluded.scope.exclusion == 'token' and excluded.identity_key is None
    assert excluded.extended_entries == tuple((e['name'], e['value']) for e in item['extendedData'])
    assert excluded.editions[0].prices[0].market == 1.5  # retained source observation, not a catalog proposal
    assert FLAG_CARD_SCOPE_PENDING not in excluded.flags
    assert result.counts['products'] == result.counts['excluded_products'] == 1
    assert normalise_group([item]).excluded[0].editions == ()


@pytest.mark.parametrize('first,second', [('Token', 'Unit'), ('Unit', 'Token')])
def test_a_conflicting_repeated_token_type_is_not_a_confirmed_exclusion(first, second):
    item = product('Synthetic ambiguous type', card_type=first)
    item['extendedData'].append({'name': 'Card Type', 'value': second})
    result = normalise_group([item])
    assert result.excluded == ()
    [kept] = result.printings
    assert kept.scope.exclusion is None
    assert {FLAG_CARD_SCOPE_PENDING, FLAG_EXTENDED_FIELD_REPEATED} <= set(kept.flags)
    assert kept.editions == ()


@pytest.mark.parametrize('number,card_type', [(None, 'Unit'), ('001/100', None), (None, None),
                                                   ('001/100', 'Unit,Token')])
def test_incomplete_or_ambiguous_scope_gets_no_invented_edition(number, card_type):
    result = normalise_group([product('Synthetic Booster Token name alone', number=number, card_type=card_type)])
    assert result.excluded == ()  # names and missing fields never confirm a sealed product or Token
    [kept] = result.printings
    assert FLAG_CARD_SCOPE_PENDING in kept.flags and kept.editions == ()
    assert FLAG_FINISH_POLICY_PENDING not in kept.flags


@pytest.mark.parametrize('label', ['Overnumbered', 'Signature'])
def test_recognised_labels_group_with_explicit_matching_details_and_rules_text(label):
    base, labelled = alternate_pair()
    labelled['name'] = 'Synthetic Unit 20 (' + label + ')'
    result = normalise_group([labelled, base])
    assert [len(i.printings) for i in result.identities] == [2]
    assert all(p.identity_key == result.identities[0].identity_key for p in result.printings)
    assert result.review == ()
    assert len({p.key for p in result.printings}) == 2
    assert all(p.editions[0].finish == 'unspecified' for p in result.printings)


@pytest.mark.parametrize('label', ['Overnumbered', 'Signature', 'Unknown Label', 'Metal', 'Prize Wall'])
def test_name_and_number_matches_and_suffix_stripping_are_not_version_evidence(label):
    base = product('Synthetic Unit 40', text=None)
    labelled = product('Synthetic Unit 40 (' + label + ')', text=None)
    result = normalise_group([base, labelled])
    kept = by_id(result)[labelled['productId']]
    assert kept.identity_key is None and FLAG_MARKER_GROUPING_PENDING in kept.flags
    assert FLAG_DUPLICATE_NUMBER_PENDING in kept.flags
    assert [len(i.printings) for i in result.identities] == [1]


@pytest.mark.parametrize('override,missing', [({'text': None}, 'Description'), ({'tag': None}, 'Tag'),
                                                  ({'domain': '; ;'}, 'Domain'),
                                                  ({'Might': None}, 'Might')])
def test_recognised_label_review_names_the_missing_evidence(override, missing):
    base, labelled = alternate_pair(**override)
    labelled['name'] = 'Synthetic Unit 20 (Signature)'
    result = normalise_group([base, labelled])
    [review] = [i for i in result.review if i.code == FLAG_MARKER_GROUPING_PENDING]
    assert missing in review.detail and 'lacks explicit evidence' in review.detail
    assert by_id(result)[labelled['productId']].identity_key is None


@pytest.mark.parametrize('override,conflict', [({'text': 'Different synthetic rules.'}, 'rules text'),
                                                    ({'tag': 'TagC'}, 'Tag')])
def test_recognised_labels_with_conflicting_evidence_stay_unmerged(override, conflict):
    base, labelled = alternate_pair(**override)
    labelled['name'] = 'Synthetic Unit 20 (Overnumbered)'
    result = normalise_group([base, labelled])
    [review] = [i for i in result.review if i.code == FLAG_MARKER_GROUPING_PENDING]
    assert conflict in review.detail
    assert by_id(result)[labelled['productId']].identity_key is None
    assert [len(i.printings) for i in result.identities] == ([] if conflict == 'Tag' else [1])


def test_labels_cannot_corroborate_each_other_without_an_unmarked_base():
    base, labelled = alternate_pair()
    base['name'], labelled['name'] = 'Synthetic Unit 20 (Overnumbered)', 'Synthetic Unit 20 (Signature)'
    result = normalise_group([base, labelled])
    assert result.identities == ()
    assert all(p.identity_key is None and FLAG_MARKER_GROUPING_PENDING in p.flags for p in result.printings)
    assert all('unmarked base' in i.detail for i in result.review)


@pytest.mark.parametrize('case,override', [('fervent-shape', {'tag': 'TagC'}),
                                               ('graceful-shape', {'domain': None}),
                                               ('forge-god-shape', {'domain': 'DomainB', 'tag': 'TagC'})])
def test_conflicting_detail_shapes_keep_all_source_records_and_prices(case, override):
    base, alt = alternate_pair(**override)
    result = normalise_group([base, alt], [price(base, 'Normal'), price(alt, 'Foil')])
    assert result.identities == () and len(result.printings) == 2
    for raw in (base, alt):
        kept = by_id(result)[raw['productId']]
        assert kept.identity_key is None and FLAG_PRINTING_DETAILS_DIFFER in kept.flags
        assert kept.extended_entries == tuple((e['name'], e['value']) for e in raw['extendedData'])
        assert len(kept.editions[0].prices) == 1


@pytest.mark.parametrize('label', ['Overnumbered', 'Signature', 'Alternate Art'])
@pytest.mark.parametrize('field,override', [
    ('Domain', {'domain': 'DomainB'}), ('Tag', {'tag': 'TagC'}), ('Card Type', {'card_type': 'Spell'}),
    ('Energy Cost', {'Energy Cost': '4'}), ('Power Cost', {'Power Cost': '1'}), ('Might', {'Might': '3'})])
def test_label_detail_conflicts_hold_all_products_with_their_data_and_prices(label, field, override):
    base, labelled = alternate_pair(**override)
    labelled['name'] = 'Synthetic Unit 20 (' + label + ')'
    result = normalise_group([base, labelled], [price(base, 'Normal'), price(labelled, 'Foil')])
    assert result.identities == ()
    [review] = [i for i in result.review if i.code == FLAG_PRINTING_DETAILS_DIFFER]
    assert review.product_ids == (base['productId'], labelled['productId'])
    assert review.detail.endswith('differ on ' + field)
    for raw in (base, labelled):
        kept = by_id(result)[raw['productId']]
        assert kept.identity_key is None and FLAG_PRINTING_DETAILS_DIFFER in kept.flags
        assert kept.extended_entries == tuple((e['name'], e['value']) for e in raw['extendedData'])
        assert kept.editions[0].prices[0].market == 1.5
    if label != 'Alternate Art':
        assert FLAG_MARKER_GROUPING_PENDING in by_id(result)[labelled['productId']].flags


@pytest.mark.parametrize('label', ['Overnumbered', 'Signature'])
def test_marker_evidence_must_also_be_present_on_the_base(label):
    base, labelled = alternate_pair()
    base['extendedData'] = [e for e in base['extendedData'] if e['name'] != 'Description']
    labelled['name'] = 'Synthetic Unit 20 (' + label + ')'
    result = normalise_group([base, labelled])
    [review] = [i for i in result.review if i.code == FLAG_MARKER_GROUPING_PENDING]
    assert review.detail == f'product {base["productId"]} lacks explicit evidence: Description'
    assert by_id(result)[labelled['productId']].identity_key is None


@pytest.mark.parametrize('label', ['Unknown Label', 'Metal', 'Prize Wall'])
def test_unsupported_labels_stay_pending_with_complete_matching_evidence(label):
    base, labelled = alternate_pair()
    labelled['name'] = 'Synthetic Unit 20 (' + label + ')'
    result = normalise_group([base, labelled])
    kept = by_id(result)[labelled['productId']]
    assert kept.identity_key is None and FLAG_MARKER_GROUPING_PENDING in kept.flags
    assert [len(i.printings) for i in result.identities] == [1]


@pytest.mark.parametrize('label', ['Alternate Art', 'Overnumbered', 'Signature'])
def test_text_and_detail_conflicts_both_flag_all_affected_printings(label):
    base, labelled = alternate_pair(tag='TagC', text='Conflicting synthetic rules.')
    labelled['name'] = 'Synthetic Unit 20 (' + label + ')'
    result = normalise_group([base, labelled])
    assert result.identities == ()
    assert all({FLAG_IDENTITY_TEXT_CONFLICT, FLAG_PRINTING_DETAILS_DIFFER} <= set(p.flags)
               for p in result.printings)
