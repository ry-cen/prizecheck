import importlib.util
import json
import sys
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('propose_set_groups', ROOT / 'scripts/propose_set_groups.py')
propose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(propose)

# The API rules use only the standard library; importing them needs no database.
sys.path.insert(0, str(ROOT / 'api'))
try:
    from app.games.pokemon.prices.catalog_targets import MatchingRulesV4
finally:
    sys.path.remove(str(ROOT / 'api'))

CORE = propose.CORE_EQUIVALENCES
ALL = propose.ALL_EQUIVALENCES


def product(product_id, name, number, group_id=1):
    return {'product_id': product_id, 'group_id': group_id, 'name': name, 'number': number,
            'number_key': propose.number_key(number)}


def row(set_id, number, name, printing_id=None, descriptor=None, state='unverified', lookup=None, record=None, set_name=None):
    return {'edition_id': f'e-{set_id}-{number}-{json.dumps(descriptor, sort_keys=True)}',
            'printing_id': printing_id or f'p-{set_id}-{number}', 'set_id': set_id, 'set_name': set_name or set_id,
            'collector_number': number, 'name': name, 'descriptor': descriptor or {'size': 'standard', 'type': 'holo'},
            'state': state, 'reason': 'rule_failed', 'lookup': lookup or {}, 'record': record or {}}


def group(group_id, name):
    return {'groupId': group_id, 'name': name, 'abbreviation': 'X', 'isSupplemental': False}


class MatchingRulesParityTests(unittest.TestCase):
    """Pin the deliberately copied V4 helpers, including their existing differences."""

    def test_number_key_parity(self):
        for number in (None, '', '   ', '001', '000', 'DP05', 'SWSH001', 'XY01', '12/108',
                       ' dp05 / 108 ', 'swsh001', 'XY01-002', 'É001', 'E\u0301001', 0, 12):
            with self.subTest(number=number):
                self.assertEqual(propose.number_key(number), MatchingRulesV4.number_key(number))

    def test_match_name_parity(self):
        # strip_number_qualifier is the script's copy of V4.match_name. The
        # separately proposed name equivalences are deliberately not applied here.
        for name in ('', '   ', 'Audino', ' AUDINO  ', 'Poké Ball', 'Poke\u0301 Ball',
                     'Flabébé δ', 'Ampharos (Delta Species)', 'Leafeon-GX', 'Leafeon GX',
                     'Palkia LV.X', 'Mew EX (Full Art)', 'Koga’s Trap', "Koga's Trap"):
            for number in (None, '', '001', 'DP05', 'SWSH001', 'XY01', '12/108'):
                for product_name in (name, f'{name} - {number}', f'{name} ({number})',
                                     f'{name} (999)', f'{name} - [{number}]',
                                     f'{name} ({number}) ({number})'):
                    with self.subTest(name=product_name, number=number):
                        self.assertEqual(propose.strip_number_qualifier(product_name, number),
                                         MatchingRulesV4.match_name(product_name, number))
        # Both name helpers require strings, unlike number_key's nullable input.
        for helper in (propose.strip_number_qualifier, MatchingRulesV4.match_name):
            with self.subTest(helper=helper.__qualname__), self.assertRaises(TypeError):
                helper(None, '001')

    def test_special_parity(self):
        for descriptor in ({}, {'type': 'holo'}, {'finish': 'normal'}, {'size': 'standard'},
                           {'size': 'jumbo'}, {'subtype': 'unlimited'}, {'subtype': 'shadowless'},
                           {'subtype': 'ex'}, {'foil': 'cosmos'}, {'stamp': None}, {'stamp': ''},
                           {'stamp': []}, {'stamp': ['1st-edition']}, {'stamp': ['set-logo']},
                           {'stamp': ['1st-edition', 'set-logo']}, {'stamp': '1st-edition'},
                           {'thirdParty': {'tcgplayer': 5}}, {'unknown': None}):
            with self.subTest(descriptor=descriptor):
                self.assertEqual(propose.is_special(descriptor), MatchingRulesV4.special(descriptor))

    def test_missing_descriptor_difference(self):
        # The script defaults an absent descriptor to {}; V4.special requires
        # a mapping and calls .get on the unchanged None from V3.plain.
        self.assertFalse(propose.is_special(None))
        with self.assertRaises(AttributeError):
            MatchingRulesV4.special(None)

    def test_id_helpers_parity(self):
        lookups = [None, '', ' ', [], {}, {'thirdParty': None}, {'thirdParty': []},
                   {'thirdParty': {'cardmarket': 5}}, {'pricing': None}, {'pricing': []},
                   {'pricing': {'tcgplayer': None}}, {'pricing': {'tcgplayer': []}},
                   {'pricing': {'tcgplayer': {'holofoil': 5}}}]
        for product_id in (None, '', 0, -1, False, '001', 5):
            lookups.extend(({'thirdParty': {'tcgplayer': product_id}},
                            {'pricing': {'tcgplayer': {'holofoil': {'productId': product_id}}}}))
        for lookup in lookups:
            with self.subTest(lookup=lookup):
                self.assertEqual(propose.has_tcgdex_id(lookup), MatchingRulesV4.has_tcgdex_id(lookup))
            for record in (lookup, {'variants_detailed': [None, {}, lookup]},
                           {'variants_detailed': lookup}):
                with self.subTest(record=record):
                    self.assertEqual(propose.record_has_tcgdex_id(record),
                                     MatchingRulesV4.record_has_tcgdex_id(record))

    def test_pricing_metadata_id_difference(self):
        # V4.products excludes metadata keys; the script conservatively treats
        # any nested productId as an ID, even inside unit/updated metadata.
        for key in ('unit', 'updated'):
            lookup = {'pricing': {'tcgplayer': {key: {'productId': 5}}}}
            with self.subTest(key=key):
                self.assertTrue(propose.has_tcgdex_id(lookup))
                self.assertFalse(MatchingRulesV4.has_tcgdex_id(lookup))
                for record in (lookup, {'variants_detailed': [lookup]}):
                    self.assertTrue(propose.record_has_tcgdex_id(record))
                    self.assertFalse(MatchingRulesV4.record_has_tcgdex_id(record))


class NameMatchTests(unittest.TestCase):
    def test_delta_sign_equals_delta_species(self):
        found = propose.match_card('Ampharos δ', '1', [product(83549, 'Ampharos (Delta Species)', '1/101')])
        self.assertEqual(found[0], 'matched')
        self.assertEqual(found[1]['product_id'], 83549)
        self.assertEqual(found[2], 'delta')

    def test_attack_forme_and_prime_stay_unmatched(self):
        deoxys = propose.match_card('Deoxys δ', '3', [product(1, 'Deoxys (Delta Species - Attack Forme)', '3/110')], ALL)
        gengar = propose.match_card('Gengar', '18', [product(2, 'Gengar (Prime)', '18/30')], ALL)
        self.assertEqual(deoxys[0], 'missed')
        self.assertEqual(gengar[0], 'missed')
        self.assertEqual(len(deoxys[3]), 1, 'the unmatched product is still offered as a candidate')

    def test_hyphenated_suffix_equals_spaced_suffix(self):
        for card, wanted in (('Leafeon-GX', 'Leafeon GX'), ('Victini-EX', 'Victini EX'), ('Pikachu-V', 'Pikachu V'),
                             ('Charizard-VMAX', 'Charizard VMAX'), ('Arceus-VSTAR', 'Arceus VSTAR'),
                             ('Miraidon-ex', 'Miraidon ex'), ('Ho-Oh-GX', 'Ho-Oh GX')):
            found = propose.match_card(card, '5', [product(9, wanted, '5/100')])
            self.assertEqual((found[0], found[2]), ('matched', 'hyphen-suffix'), card)

    def test_equivalences_apply_to_both_sides(self):
        found = propose.match_card('Leafeon GX', '5', [product(9, 'Leafeon-GX', '5/100')])
        self.assertEqual((found[0], found[2]), ('matched', 'hyphen-suffix'))

    def test_exact_name_is_exact(self):
        found = propose.match_card('Audino', 'RC17', [product(83665, 'Audino', 'RC17/RC25')])
        self.assertEqual((found[0], found[2]), ('matched', 'exact'))

    def test_nothing_else_is_folded(self):
        for card, wanted in (('Palkia', 'Palkia LV.X'), ('Metagross', 'Metagross (Delta Species)'),
                             ('Genesect EX', 'Genesect EX (Team Plasma)'), ('Mew-EX', 'Mew EX (Full Art)')):
            self.assertEqual(propose.match_card(card, '1', [product(1, wanted, '1/10')], ALL)[0], 'missed', card)

    def test_the_number_decides_the_candidates(self):
        found = propose.match_card('Audino', '17', [product(1, 'Audino', '18/25')])
        self.assertEqual((found[0], found[3]), ('missed', []))

    def test_leading_zeros_and_totals_do_not_matter(self):
        self.assertEqual(propose.match_card('Audino', '017', [product(1, 'Audino', '17/25')])[0], 'matched')

    def test_a_number_qualifier_on_the_product_is_dropped(self):
        found = propose.match_card('Lycanroc-GX', 'SV66', [product(1, 'Lycanroc GX (SV66)', 'SV66/SV94'),
                                                          product(2, 'Lycanroc GX (SV67)', 'SV67/SV94')])
        self.assertEqual((found[0], found[1]['product_id']), ('matched', 1))

    def test_two_equal_products_are_ambiguous(self):
        found = propose.match_card('Audino', '5', [product(1, 'Audino', '5/10'), product(2, 'Audino', '5/20')])
        self.assertEqual((found[0], found[1]), ('ambiguous', None))

    def test_further_equivalences_are_off_for_the_reviewed_pair(self):
        self.assertEqual(propose.match_card('Poké Ball', '5', [product(1, 'Poke Ball', '5/10')], CORE)[0], 'missed')
        self.assertEqual(propose.match_card('Koga’s Trap', '5', [product(1, "Koga's Trap", '5/10')], CORE)[0], 'missed')
        self.assertEqual(propose.match_card('Poké Ball', '5', [product(1, 'Poke Ball', '5/10')], ALL)[2], 'accent')
        self.assertEqual(propose.match_card('Koga’s Trap', '5', [product(1, "Koga's Trap", '5/10')], ALL)[2], 'apostrophe')

    def test_accent_fold_keeps_the_delta_sign(self):
        self.assertEqual(propose.strip_accents('Flabébé δ'), 'Flabebe δ')

    def test_special_editions(self):
        self.assertFalse(propose.is_special({'size': 'standard', 'type': 'holo'}))
        self.assertFalse(propose.is_special({'size': 'standard', 'type': 'holo', 'thirdParty': {'cardmarket': 1}}))
        self.assertFalse(propose.is_special({'type': 'normal', 'stamp': ['1st-edition']}))
        self.assertTrue(propose.is_special({'size': 'standard', 'type': 'holo', 'stamp': ['set-logo']}))
        self.assertTrue(propose.is_special({'size': 'standard', 'type': 'holo', 'stamp': ['tom-roos']}))
        self.assertTrue(propose.is_special({'size': 'jumbo', 'type': 'holo'}))
        self.assertTrue(propose.is_special({'size': 'standard', 'type': 'holo', 'foil': 'cosmos'}))


class IdTests(unittest.TestCase):
    def test_any_tcgplayer_id_counts(self):
        self.assertTrue(propose.has_tcgdex_id({'thirdParty': {'tcgplayer': 5}}))
        self.assertTrue(propose.has_tcgdex_id({'pricing': {'tcgplayer': {'holofoil': {'productId': 5}}}}))
        self.assertFalse(propose.has_tcgdex_id({'thirdParty': {'cardmarket': 5}}))
        self.assertFalse(propose.has_tcgdex_id({'thirdParty': None, 'pricing': None}))
        self.assertFalse(propose.has_tcgdex_id(None))

    def test_a_card_level_or_sibling_variant_id_counts(self):
        card = {'thirdParty': {'tcgplayer': 7}, 'variants_detailed': [{'thirdParty': None, 'pricing': None}]}
        sibling = {'thirdParty': None, 'variants_detailed': [{'thirdParty': None}, {'thirdParty': {'tcgplayer': 8}}]}
        self.assertTrue(propose.record_has_tcgdex_id(card))
        self.assertTrue(propose.record_has_tcgdex_id(sibling))
        self.assertFalse(propose.record_has_tcgdex_id({'thirdParty': {'cardmarket': 1}, 'variants_detailed': [{}]}))

    def test_a_card_with_any_id_never_takes_the_path(self):
        rows = [row('ex15', '1', 'Ampharos δ', record={'thirdParty': {'tcgplayer': 7}}),
                row('ex15', '2', 'Feraligatr δ', lookup={'thirdParty': {'tcgplayer': 7}}),
                row('ex15', '3', 'Heracross δ', record={'variants_detailed': [{'thirdParty': {'tcgplayer': 7}}]}),
                row('ex15', '4', 'Meganium δ')]
        infos = propose.eligible_cards(rows)
        self.assertEqual([card['number'] for card in infos['ex15']['cards'].values()], ['4'])
        self.assertEqual(infos['ex15']['card_total'], 4)

    def test_verified_and_excluded_sets_are_left_out(self):
        rows = [row('ex15', '1', 'Ampharos δ', state='verified'), row('xyp', 'XY1', 'Venusaur'), row('30th', '1', 'Mew'),
                row('ex13', '1', 'Absol δ')]
        self.assertEqual(list(propose.eligible_cards(rows)), ['ex13'])


class ProposalTests(unittest.TestCase):
    def proposal(self, rows, groups, products, enabled=ALL):
        decorated = [{**item, 'cards': products.get(item['groupId'], [])} for item in groups]
        infos = propose.eligible_cards(rows)
        return {set_id: propose.propose_set(info, decorated, {g['groupId']: g['cards'] for g in decorated}, enabled)
                for set_id, info in infos.items()}

    def test_ex15_ampharos(self):
        result = self.proposal([row('ex15', '1', 'Ampharos δ', set_name='Dragon Frontiers')],
                               [group(1411, 'EX Dragon Frontiers')],
                               {1411: [product(83549, 'Ampharos (Delta Species)', '1/101', 1411)]})['ex15']
        self.assertEqual([g['groupId'] for g in result['groups']], [1411])
        self.assertEqual([(item['outcome'], item['method']) for item in result['results']], [('matched', 'delta')])

    def test_sma_leafeon_matches_in_2594_and_never_in_shining_fates(self):
        rows = [row('sma', 'SV46', 'Leafeon-GX', set_name='Hidden Fates Shiny Vault')]
        groups = [group(2594, 'Hidden Fates: Shiny Vault'), group(2781, 'Shining Fates: Shiny Vault'),
                  group(2480, 'Hidden Fates')]
        products = {2594: [product(197770, 'Leafeon GX', 'SV46/SV94', 2594)],
                    2781: [product(5, 'Leafeon GX', 'SV46/SV122', 2781)],
                    2480: [product(6, 'Leafeon GX', '46/68', 2480)]}
        result = self.proposal(rows, groups, products)['sma']
        self.assertEqual([g['groupId'] for g in result['groups']], [2594])
        item = result['results'][0]
        self.assertEqual((item['outcome'], item['product']['product_id'], item['method']), ('matched', 197770, 'hyphen-suffix'))

    def test_bw11_radiant_collection_in_1465(self):
        rows = [row('bw11', 'RC17', 'Audino', set_name='Legendary Treasures'),
                row('bw11', '24', 'Victini-EX', set_name='Legendary Treasures')]
        groups = [group(1409, 'Legendary Treasures'), group(1465, 'Legendary Treasures: Radiant Collection')]
        products = {1409: [product(90351, 'Victini EX', '24/113', 1409)],
                    1465: [product(83665, 'Audino', 'RC17/RC25', 1465)]}
        result = self.proposal(rows, groups, products)['bw11']
        self.assertEqual([g['groupId'] for g in result['groups']], [1409, 1465])
        by_number = {item['number']: item for item in result['results']}
        self.assertEqual(by_number['RC17']['product']['group_id'], 1465)
        self.assertEqual(by_number['24']['product']['group_id'], 1409)
        self.assertIn('several groups', result['flags'])

    def test_unmatched_cards_list_their_candidates_and_special_editions_never_match(self):
        special = {'size': 'standard', 'type': 'holo', 'stamp': ['set-logo']}
        rows = [row('ex11', '3', 'Deoxys δ', set_name='Delta Species'), row('ex11', '4', 'Gengar', set_name='Delta Species'),
                row('ex11', '5', 'Audino', descriptor=special, set_name='Delta Species')]
        products = {1429: [product(1, 'Deoxys (Delta Species - Attack Forme)', '3/113', 1429), product(2, 'Gengar (Prime)', '4/113', 1429),
                           product(3, 'Audino', '5/113', 1429)]}
        result = self.proposal(rows, [group(1429, 'EX Delta Species')], products)['ex11']
        self.assertEqual(result['groups'], [])
        rows.append(row('ex11', '6', 'Audino', set_name='Delta Species'))
        products[1429].append(product(4, 'Audino', '6/113', 1429))
        result = self.proposal(rows, [group(1429, 'EX Delta Species')], products)['ex11']
        outcomes = {item['number']: item['outcome'] for item in result['results']}
        self.assertEqual(outcomes, {'3': 'missed', '4': 'missed', '5': 'special', '6': 'matched'})
        self.assertEqual(result['results'][0]['candidates'][0]['product_id'], 1)

    def test_a_name_twin_that_gains_nothing_is_rejected_and_flagged(self):
        rows = [row('bw1', '7', 'Audino', set_name='Black & White')]
        groups = [group(1400, 'Black and White'), group(1407, 'Black and White Promos')]
        products = {1400: [product(1, 'Audino', '7/114', 1400)], 1407: [product(2, 'Audino', '7/50', 1407)]}
        result = self.proposal(rows, groups, products)['bw1']
        self.assertEqual([g['groupId'] for g in result['groups']], [1400])
        self.assertIn('name twin rejected', result['flags'])

    def test_a_set_with_no_matching_group_has_no_proposal(self):
        rows = [row('xya', '1', 'Pikachu', set_name='Yellow A Alternate')]
        self.assertEqual(self.proposal(rows, [group(1, 'Something Else')], {})['xya']['groups'], [])

    def test_card_products_need_a_number(self):
        raw = [{'productId': 1, 'groupId': 9, 'name': 'Audino', 'extendedData': [{'name': 'Number', 'value': '017/025'}]},
               {'productId': 2, 'groupId': 9, 'name': 'Booster Box', 'extendedData': []},
               {'productId': 3, 'groupId': 9, 'name': 'Sleeves'}]
        found = propose.card_products(raw)
        self.assertEqual([(item['product_id'], item['number_key']) for item in found], [(1, '17')])

    def test_the_report_names_the_sections(self):
        rows = [row('ex15', '1', 'Ampharos δ', set_name='Dragon Frontiers'), row('ex15', '2', 'Gengar', set_name='Dragon Frontiers')]
        groups = [group(1411, 'EX Dragon Frontiers')]
        products = {1411: [product(83549, 'Ampharos (Delta Species)', '1/101', 1411), product(2, 'Gengar (Prime)', '2/101', 1411)]}
        proposals = propose.build_proposals(rows, groups, products, ALL)
        core = propose.build_proposals(rows, groups, products, CORE)
        report = propose.render_report(proposals, core)
        for text in ('## Summary', '## Doubtful sets', '## Sets with no proposal', '### `ex15` Dragon Frontiers', 'delta',
                     'Gengar (Prime)', '**1 cards**', '## Owner review', propose.OWNER_REVIEW):
            self.assertIn(text, report)


class InputTests(unittest.TestCase):
    def test_editions_file_is_json_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'editions.jsonl'
            path.write_text(json.dumps(row('ex15', '1', 'Ampharos δ')) + '\n\n' + json.dumps(row('ex15', '2', 'X')) + '\n')
            self.assertEqual(len(propose.read_editions_file(path)), 2)

    def test_fetch_json_uses_the_cache_and_sends_a_user_agent(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as directory:
            seen = []

            class Response:
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

                def read(self):
                    return b'{"results": [1]}'

            def opener(request, timeout):
                seen.append(request.get_header('User-agent'))
                return Response()

            with mock.patch.object(propose.urllib.request, 'urlopen', opener), mock.patch.object(propose.time, 'sleep'):
                first = propose.fetch_json('tcgplayer/3/groups', directory)
                second = propose.fetch_json('tcgplayer/3/groups', directory)
            self.assertEqual((first, second), ({'results': [1]}, {'results': [1]}))
            self.assertEqual(len(seen), 1)
            self.assertTrue(seen[0] and 'python' not in seen[0].lower())


if __name__ == '__main__':
    unittest.main()
