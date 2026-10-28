"""Propose the TCGdex set -> TCGCSV group(s) table for matching rule v6 (design section 4.16, ticket P12).

    python scripts/propose_set_groups.py (--database-url URL | --editions FILE) [--cache-dir DIR] [--out FILE]

Input is every catalog Edition, from one of two sources that produce the same rows:

* ``--database-url`` reads the catalog tables (read only) with the query ``EDITION_QUERY``;
* ``--editions`` reads a JSON Lines file of the same rows, one JSON object per line, as written by running
  ``EDITION_QUERY`` through ``psql -At`` (``--print-query`` prints it).

TCGCSV is downloaded from tcgcsv.com (the host answers 401 to Python's default user agent, so a User-Agent header is
sent) and cached under ``--cache-dir`` (default: the system temp directory), so a rerun reads no network. Products with
no extendedData ``Number`` are sealed products, not cards, and are ignored.

For every set that has main-set cards with no TCGdex TCGplayer id the script proposes the TCGCSV group(s) and reports
which cards would match under rule v6: the card's number key plus its name, with the reviewed name equivalences applied
to both sides. The report ends up in docs/planning/tcgcsv-prices/set-groups-report.md; run
``npx prettier --write`` on it after generating it.

The matching mirrors ``MatchingRulesV4`` in api/app/catalog_targets.py (``number_key``, ``match_name``, ``special``,
``has_tcgdex_id``, ``record_has_tcgdex_id``). It is deliberately a copy, not an import: rule v6 is not built yet, and the
copy is what the owner reviews. Nothing here writes to the database.
"""
import argparse
import json
import re
import sys
import tempfile
import time
import unicodedata
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

BASE_URL = 'https://tcgcsv.com'
POKEMON_CATEGORY = 3
USER_AGENT = 'PrizeCheck-propose-set-groups/1 (+https://prizecheck.dev)'
DEFAULT_OUT = Path(__file__).resolve().parents[1] / 'docs/planning/tcgcsv-prices/set-groups-report.md'

# Sets whose products are already covered by an earlier rule: V4's Black Star promo groups and V5's 30th sets.
EXCLUDED_SETS = frozenset(('basep', 'np', 'dpp', 'hgssp', 'bwp', 'xyp', 'smp', 'swshp', 'svp', 'mep', '30th', '30th-c'))

# The facets an Edition may carry and still take the number path (MatchingRulesV4.PLAIN_FACETS).
PLAIN_FACETS = frozenset(('type', 'finish', 'size', 'subtype', 'stamp'))
FIRST_EDITION = '1st-edition'

# Groups for a set are accepted only when a good share of its no-id cards match; below this the set is doubtful.
LOW_MATCH_RATE = 0.5
# The era prefixes TCGplayer puts in front of a group name ("SM - Hidden Fates", "EX Dragon Frontiers").
ERA_PREFIXES = frozenset(('sm', 'bw', 'xy', 'dp', 'ex', 'hgss', 'sv', 'ss', 'swsh', 'me', 'pop', 'np'))
STOP_TOKENS = frozenset(('the', 'and', 'of', 'a', 'pokemon', 'tcg'))

EDITION_QUERY = """SELECT json_build_object('edition_id', e.id, 'printing_id', p.id, 'set_id', d.set_id, 'set_name', d.set_name,
  'collector_number', d.collector_number, 'name', d.display_name, 'descriptor', e.descriptor,
  'state', em.mapping_state, 'reason', em.mapping_reason,
  'card_count', (pm.source_record->'set'->'cardCount'->>'total')::int,
  'lookup', json_build_object('thirdParty', em.mapping_candidate->'candidate'->'thirdParty',
                              'pricing', em.mapping_candidate->'candidate'->'pricing'),
  'record', json_build_object('thirdParty', pm.source_record->'thirdParty', 'pricing', pm.source_record->'pricing',
    'variants_detailed', (SELECT json_agg(json_build_object('thirdParty', v->'thirdParty', 'pricing', v->'pricing'))
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(pm.source_record->'variants_detailed')='array'
                                     THEN pm.source_record->'variants_detailed' ELSE '[]'::jsonb END) v)))
FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
JOIN catalog_edition_metadata em ON em.edition_id=e.id
JOIN catalog_printing_metadata pm ON pm.printing_id=p.id
JOIN catalog_printing_display d ON d.printing_id=p.id
ORDER BY d.set_id, e.id"""

# Recorded at the top of the report so a regenerated report keeps the owner's decisions (kept equal to the rule by tests).
OWNER_REVIEW = """## Owner review

Decided by the owner on 2026-10-27; final.

- Accepted all 50 proposed sets below, with the group(s) listed for each (`bw11`: 1409 and 1465; `g1`: 1728 and 1729). The
  14 sets with no proposal stay out of the table.
- Accepted all four name equivalences: `delta`, `hyphen-suffix`, `apostrophe` and `accent`. Nothing else is folded.
- Apostrophe-like characters ’ ‘ ʼ ` fold to ', decided by the orchestrator under the owner's delegation, 2026-10-28.
- Matching rule v6 (`MatchingRulesV6.TCGPLAYER_SET_GROUPS` in `api/app/catalog_targets.py`) holds exactly these sets; a test
  keeps the table equal to the Summary below."""


# ------------------------------------------------------------------ pure matching (mirrors MatchingRulesV4)


def number_key(number):
    """Trimmed, uppercase, "/total" dropped, leading zeros of the first digit run removed. None for a missing number."""
    if number is None:
        return None
    text = unicodedata.normalize('NFC', str(number)).strip().split('/', 1)[0].strip().upper()
    if not text:
        return None
    return re.sub(r'\d+', lambda run: run.group().lstrip('0') or '0', text, count=1)


def fold(text):
    return ' '.join(unicodedata.normalize('NFC', text).split()).casefold()


PAREN_QUALIFIER = re.compile(r' \(([^()]+)\)$')


def strip_number_qualifier(product_name, number):
    """The folded product name minus one trailing " - <n>" or " (<n>)" qualifier naming this card's own number."""
    name, own = fold(product_name), number_key(number)
    head, dash, tail = name.rpartition(' - ')
    if dash and own is not None and not re.search(r'[()\[\]]', tail) and number_key(tail) == own:
        return head.rstrip()
    found = PAREN_QUALIFIER.search(name)
    if found and own is not None and number_key(found.group(1)) == own:
        return name[:found.start()].rstrip()
    return name


def has_tcgdex_id(lookup):
    """Whether a lookup (a variant, a card or an Edition's candidate) names a TCGplayer product."""
    if not isinstance(lookup, dict):
        return False
    third_party = lookup.get('thirdParty')
    if isinstance(third_party, dict) and third_party.get('tcgplayer') is not None:
        return True
    pricing = lookup.get('pricing')
    block = pricing.get('tcgplayer') if isinstance(pricing, dict) else None
    return isinstance(block, dict) and any(isinstance(value, dict) and 'productId' in value for value in block.values())


def record_has_tcgdex_id(record):
    """Whether the card record names a TCGplayer product anywhere: the card's own block or any variant's."""
    if not isinstance(record, dict):
        return False
    detailed = record.get('variants_detailed')
    return has_tcgdex_id(record) or (isinstance(detailed, list) and any(has_tcgdex_id(item) for item in detailed))


def edition_has_tcgdex_id(row):
    """Whether any TCGdex TCGplayer id reaches this Edition: its own lookup, the card, or a sibling variant."""
    return has_tcgdex_id(row.get('lookup')) or record_has_tcgdex_id(row.get('record'))


def is_special(descriptor):
    """A stamp other than 1st Edition, foil pattern, another subtype or size: never matched by number or name."""
    plain = {key: value for key, value in (descriptor or {}).items() if key != 'thirdParty'}
    stamps = plain.get('stamp') or []
    return (bool(set(plain) - PLAIN_FACETS) or plain.get('size', 'standard') != 'standard'
            or plain.get('subtype') not in (None, 'unlimited', 'shadowless')
            or not isinstance(stamps, list) or any(stamp != FIRST_EDITION for stamp in stamps))


# ------------------------------------------------------------------ the proposed name equivalences

# "Ampharos δ" (TCGdex) = "Ampharos (Delta Species)" (TCGplayer). Only a trailing delta sign: the product's qualifier must
# be exactly "(Delta Species)", so "Deoxys (Delta Species - Attack Forme)" never equals "Deoxys δ".
DELTA = re.compile(r'^(?P<head>.*?)\s*δ$')
# "Leafeon-GX" = "Leafeon GX": a hyphen before a trailing EX/GX/V/VMAX/VSTAR/ex suffix becomes a space.
HYPHEN_SUFFIX = re.compile(r'(?<=\S)-(?P<suffix>ex|gx|v|vmax|vstar)\b')

# The two reviewed equivalences of design section 4.16, then the further ones this report proposes (each reported on its
# own, so the owner can accept or reject them): TCGplayer writes product names in plain ASCII.
CORE_EQUIVALENCES = frozenset(('delta', 'hyphen-suffix'))
FURTHER_EQUIVALENCES = frozenset(('apostrophe', 'accent'))
ALL_EQUIVALENCES = CORE_EQUIVALENCES | FURTHER_EQUIVALENCES
CURLY_APOSTROPHES = str.maketrans({'\u2019': "'", '\u2018': "'", '\u02bc': "'", '`': "'"})


def strip_accents(text):
    """The text without combining marks (e -> e, o -> o); characters with no decomposition (such as delta) stay."""
    return unicodedata.normalize('NFC', ''.join(char for char in unicodedata.normalize('NFD', text)
                                                if unicodedata.category(char) != 'Mn'))


def apply_equivalences(folded, enabled=CORE_EQUIVALENCES):
    """(name with the enabled equivalences applied, the equivalences that changed it). The input is already folded."""
    used = []
    if 'delta' in enabled:
        found = DELTA.match(folded)
        if found:
            folded = f'{found.group("head")} (delta species)'
            used.append('delta')
    if 'hyphen-suffix' in enabled:
        spaced = HYPHEN_SUFFIX.sub(r' \g<suffix>', folded)
        if spaced != folded:
            folded = spaced
            used.append('hyphen-suffix')
    if 'apostrophe' in enabled:
        straight = folded.translate(CURLY_APOSTROPHES)
        if straight != folded:
            folded = straight
            used.append('apostrophe')
    if 'accent' in enabled:
        plain = strip_accents(folded)
        if plain != folded:
            folded = plain
            used.append('accent')
    return folded, used


def name_forms(card_name, product_name, number, enabled=CORE_EQUIVALENCES):
    """The comparison forms of a card name and a product name: ((exact), (equivalent), equivalences that changed either)."""
    card, product = fold(card_name), strip_number_qualifier(product_name, number)
    card_eq, card_used = apply_equivalences(card, enabled)
    product_eq, product_used = apply_equivalences(product, enabled)
    return (card, product), (card_eq, product_eq), sorted(set(card_used) | set(product_used))


def match_card(card_name, number, products, enabled=CORE_EQUIVALENCES):
    """Match one card against the products of the proposed groups: (outcome, product, method, candidates).

    outcome is "matched" (exactly one product on the card's number has an equal name), "ambiguous" (several) or
    "missed" (none). method is "exact" when the plain V4 comparison equals, else the equivalences that made it equal.
    candidates are the products on the card's number, for a report line on a miss.
    """
    key = number_key(number)
    on_number = [product for product in products if key is not None and product['number_key'] == key]
    equal = []
    for product in on_number:
        plain, equivalent, used = name_forms(card_name, product['name'], number, enabled)
        if plain[0] == plain[1]:
            equal.append((product, 'exact'))
        elif equivalent[0] == equivalent[1]:
            equal.append((product, '+'.join(used)))
    if len(equal) == 1:
        return 'matched', equal[0][0], equal[0][1], on_number
    return ('ambiguous' if equal else 'missed'), None, None, on_number


# ------------------------------------------------------------------ TCGCSV products and groups


def is_card_product(raw):
    return any(item.get('name') == 'Number' and item.get('value') for item in raw.get('extendedData') or ())


def card_products(raw_products):
    """The card products of a TCGCSV group's product list (those with an extendedData Number), as flat records."""
    cards = []
    for raw in raw_products:
        if not is_card_product(raw):
            continue
        number = next(item['value'] for item in raw['extendedData'] if item.get('name') == 'Number')
        cards.append({'product_id': raw['productId'], 'group_id': raw['groupId'], 'name': raw['name'], 'number': number,
                      'number_key': number_key(number)})
    return cards


def name_tokens(text):
    plain = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode().lower()
    return [token for token in re.findall(r'[a-z0-9]+', plain) if token not in STOP_TOKENS]


def group_tokens(group_name):
    tokens = name_tokens(group_name)
    return tokens[1:] if len(tokens) > 1 and tokens[0] in ERA_PREFIXES else tokens


def name_candidate_groups(set_name, groups):
    """(group, kind): kind is "same" when the group's name tokens equal the set's, "subset" when they contain them."""
    wanted = name_tokens(set_name)
    found = []
    for group in groups:
        tokens = group_tokens(group['name'])
        if tokens == wanted:
            found.append((group, 'same'))
        elif wanted and all(token in tokens for token in wanted):
            found.append((group, 'subset'))
    return found


# ------------------------------------------------------------------ proposing


def eligible_cards(rows, excluded=EXCLUDED_SETS):
    """{set_id: info}: the unverified cards of each set that have no TCGdex id anywhere, with their Editions.

    info has set_name, card_total (distinct cards TCGdex lists for the set in the catalog), and cards (printing id ->
    {number, name, editions: [row]}) for the no-id cards that still have an unverified Edition.
    """
    totals, names, cards = defaultdict(set), {}, defaultdict(dict)
    for row in rows:
        totals[row['set_id']].add(row['printing_id'])
        names[row['set_id']] = row['set_name']
        if row['set_id'] in excluded or row['state'] == 'verified' or edition_has_tcgdex_id(row):
            continue
        card = cards[row['set_id']].setdefault(row['printing_id'], {'number': row['collector_number'], 'name': row['name'],
                                                                    'editions': []})
        card['editions'].append(row)
    return {set_id: {'set_name': names[set_id], 'card_total': len(totals[set_id]), 'cards': cards[set_id]}
            for set_id in sorted(cards) if cards[set_id]}


def evaluate_set(info, products, enabled=CORE_EQUIVALENCES):
    """Match every no-id card of a set against the given products.

    Returns {'cards': [result], ...}: each result has printing_id, number, name, outcome, product, method, candidates,
    plain (the Editions that may take the path) and special (those that never do).
    """
    results = []
    for printing_id, card in info['cards'].items():
        plain = [row for row in card['editions'] if not is_special(row['descriptor'])]
        special = [row for row in card['editions'] if is_special(row['descriptor'])]
        if plain:
            outcome, product, method, candidates = match_card(card['name'], card['number'], products, enabled)
        else:
            outcome, product, method, candidates = 'special', None, None, []
        results.append({'printing_id': printing_id, 'number': card['number'], 'name': card['name'], 'outcome': outcome,
                        'product': product, 'method': method, 'candidates': candidates, 'plain': plain, 'special': special})
    return results


def sort_number(value):
    return [int(part) if part.isdigit() else part for part in re.split(r'(\d+)', str(value))]


def propose_set(info, groups, products_by_group, enabled=CORE_EQUIVALENCES):
    """The proposal for one set: chosen groups, per-card results over them, and the review flags.

    Groups whose name tokens equal the set's come first, then groups that contain them (a Radiant Collection or Shiny
    Vault subset). A group joins the proposal only if it matches at least one card the earlier groups did not, so a name
    twin that only collides never does. A card named by two chosen groups is "ambiguous" and stays a miss.
    """
    candidates = name_candidate_groups(info['set_name'], groups)
    candidates.sort(key=lambda pair: (pair[1] != 'same', pair[0]['groupId']))
    chosen, matched_ids, rejected = [], set(), []
    for group, kind in candidates:
        trial = chosen + [group]
        trial_products = [product for item in trial for product in products_by_group[item['groupId']]]
        results = evaluate_set(info, trial_products, enabled)
        now = {item['printing_id'] for item in results if item['outcome'] == 'matched'}
        gained = now - matched_ids
        if gained:
            chosen, matched_ids = trial, now
            group['kind'] = kind
        else:
            rejected.append((group, kind))
    chosen_products = [product for item in chosen for product in products_by_group[item['groupId']]]
    results = evaluate_set(info, chosen_products, enabled) if chosen else []
    flags = []
    matched = [item for item in results if item['outcome'] == 'matched']
    ambiguous = [item for item in results if item['outcome'] == 'ambiguous']
    eligible = [item for item in results if item['outcome'] != 'special']
    if not chosen:
        return {'groups': [], 'results': [], 'flags': [], 'rejected': rejected, 'candidates': candidates}
    if len(chosen) > 1:
        flags.append('several groups')
    if len([pair for pair in candidates if pair[1] == 'same']) > 1:
        flags.append('several groups with the set name')
    if rejected:
        flags.append('name twin rejected')
    if eligible and len(matched) / len(eligible) < LOW_MATCH_RATE:
        flags.append('low match rate')
    if ambiguous:
        flags.append('name collisions')
    if len(chosen) == 1 and card_count_gap(info, chosen, products_by_group):
        flags.append('card counts differ')
    return {'groups': chosen, 'results': results, 'flags': flags, 'rejected': rejected, 'candidates': candidates}


def card_count_gap(info, chosen, products_by_group):
    """Whether the group's card products are far from the set's TCGdex card count (more than 25% either way)."""
    count = sum(len(products_by_group[group['groupId']]) for group in chosen)
    total = info['card_total']
    return bool(total) and abs(count - total) / total > 0.25


def summarize(set_id, info, proposal):
    results = proposal['results']
    matched = [item for item in results if item['outcome'] == 'matched']
    return {'set_id': set_id, 'set_name': info['set_name'], 'groups': proposal['groups'], 'card_total': info['card_total'],
            'no_id': len(results) if results else len(info['cards']), 'cards_gained': len(matched),
            'editions_gained': sum(len(item['plain']) for item in matched),
            'special_only': sum(1 for item in results if item['outcome'] == 'special'),
            'flags': proposal['flags']}


# ------------------------------------------------------------------ report


def cell(text):
    return str(text).replace('|', '\\|').replace('\n', ' ')


def group_label(group):
    return f'{group["groupId"]} {group["name"]}'


def method_counts(results):
    return Counter(item['method'] for item in results if item['outcome'] == 'matched')


def render_report(proposals, core_proposals=()):
    """The Markdown report. proposals is a list of (summary, info, proposal) with every proposed equivalence applied;
    core_proposals the same with only the two reviewed ones (delta, hyphen-suffix), to show what each adds."""
    core_gain = {item[0]['set_id']: item[0]['cards_gained'] for item in core_proposals if item[2]['groups']}
    core_editions = {item[0]['set_id']: item[0]['editions_gained'] for item in core_proposals if item[2]['groups']}
    accepted = [item for item in proposals if item[2]['groups']]
    unproposed = [item for item in proposals if not item[2]['groups']]
    total_cards = sum(item[0]['cards_gained'] for item in accepted)
    total_editions = sum(item[0]['editions_gained'] for item in accepted)
    lines = ['# Matching rule v6: proposed TCGdex set to TCGCSV group table', '',
             'Written by `scripts/propose_set_groups.py` (ticket P12, #378). It lists the main-set cards that have no TCGdex '
             'TCGplayer id, neither on a variant nor on the card, and for each set proposes the TCGCSV group(s) the '
             'rule searches. The rule\'s table contains only the sets the owner accepted.', '', OWNER_REVIEW, '']
    lines += [f'Proposed {len(accepted)} sets. They would gain **{total_cards} cards** ({total_editions} Editions) '
              f'out of {sum(item[0]["no_id"] for item in proposals)} cards with no id in {len(proposals)} sets. '
              f'With only the two reviewed equivalences (`delta`, `hyphen-suffix`) the gain is '
              f'**{sum(core_gain.values())} cards** ({sum(core_editions.values())} Editions) in {len(core_gain)} sets; the '
              f'rest comes from the further equivalences proposed below (`apostrophe`, `accent`), which the owner '
              f'accepted too.', '']
    lines += ['## Summary', '',
              '| Set | Name | Group(s) | TCGdex cards | No id | Would gain | Of those, reviewed equivalences only | Editions | '
              'Special only | Doubtful |',
              '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |']
    for summary, info, proposal in accepted:
        lines.append('| ' + ' | '.join(cell(value) for value in (
            f'`{summary["set_id"]}`', summary['set_name'], '; '.join(group_label(g) for g in summary['groups']),
            summary['card_total'], summary['no_id'], summary['cards_gained'], core_gain.get(summary['set_id'], 0),
            summary['editions_gained'],
            summary['special_only'], ', '.join(summary['flags']) or '')) + ' |')
    doubtful = [item for item in accepted if item[0]['flags']]
    lines += ['', '## Doubtful sets', '']
    if doubtful:
        lines += ['A set is doubtful when it lists several groups, has a low match rate (under 50% of its no-id cards), '
                  'has cards that two products both claim, has a name twin group that was rejected, or whose group has '
                  'a very different card count.', '']
        for summary, info, proposal in doubtful:
            lines.append(f'- `{summary["set_id"]}` {summary["set_name"]}: {", ".join(summary["flags"])}.')
    else:
        lines.append('None.')
    lines += ['', '## Sets with no proposal', '']
    if unproposed:
        lines += ['| Set | Name | No id | Why |', '| --- | --- | ---: | --- |']
        for summary, info, proposal in unproposed:
            why = ('no TCGCSV group has a name containing the set name' if not proposal['candidates']
                   else 'name candidates matched none of its cards: ' + '; '.join(group_label(g) for g, _ in proposal['candidates']))
            lines.append(f'| `{summary["set_id"]}` | {cell(summary["set_name"])} | {summary["no_id"]} | {cell(why)} |')
    else:
        lines.append('None.')
    lines += ['', '## Name equivalences', '',
              'Applied to both sides before the comparison. Nothing else is folded: `LV.X`, `(Prime)`, stamps and forme '
              'qualifiers still fail.', '',
              'Reviewed in design section 4.16:', '',
              '- `delta`: `<name> δ` = `<name> (Delta Species)`.',
              '- `hyphen-suffix`: `-EX`, `-GX`, `-V`, `-VMAX`, `-VSTAR`, `-ex` = the same suffix after a space.', '',
              'Accepted by the owner, because the misses show TCGplayer writing plain ASCII names (reject them and the sets below '
              'lose the cards listed in the table above):', '',
              '- `apostrophe`: the apostrophe-like characters `’` `‘` `ʼ` and a backtick all equal a straight `\'`.',
              '- `accent`: an accented letter = the plain letter (`Poké Ball` = `Poke Ball`).', '',
              'A method named in the lists below is the set of equivalences that changed either name.', '']
    overall = Counter()
    for summary, info, proposal in accepted:
        overall.update(method_counts(proposal['results']))
    lines.append('Matches by method over all proposed sets: ' + (', '.join(f'{method} {count}' for method, count in
                                                                          sorted(overall.items())) or 'none') + '.')
    lines += ['', '## Sets', '']
    for summary, info, proposal in accepted:
        lines += set_section(summary, info, proposal)
    return '\n'.join(lines).rstrip() + '\n'


def set_section(summary, info, proposal):
    results = proposal['results']
    lines = [f'### `{summary["set_id"]}` {summary["set_name"]}', '']
    lines.append('- Group(s): ' + '; '.join(f'{group_label(g)} ({g["kind"]}, {len(g["cards"])} card products)'
                                              for g in summary['groups']))
    lines.append(f'- TCGdex cards: {summary["card_total"]}; cards with no id: {summary["no_id"]}; exact matches: '
                 f'{method_counts(results).get("exact", 0)}; matches by an equivalence: '
                 f'{sum(count for method, count in method_counts(results).items() if method != "exact")}; '
                 f'misses: {sum(1 for item in results if item["outcome"] in ("missed", "ambiguous"))}; '
                 f'special only: {summary["special_only"]}.')
    if summary['flags']:
        lines.append('- Doubtful: ' + ', '.join(summary['flags']) + '.')
    for group, kind in proposal['rejected']:
        lines.append(f'- Rejected name candidate: {group_label(group)} ({kind}); it matched no card the chosen groups missed.')
    matched = sorted((item for item in results if item['outcome'] == 'matched'), key=lambda item: sort_number(item['number']))
    exact = [item for item in matched if item['method'] == 'exact']
    other = [item for item in matched if item['method'] != 'exact']
    lines.append('')
    if other:
        lines += ['<details>', f'<summary>{len(other)} matches by an equivalence</summary>', '',
                  '| Number | Card | Product | Equivalence |', '| --- | --- | --- | --- |']
        for item in other:
            lines.append(f'| {cell(item["number"])} | {cell(item["name"])} | {item["product"]["product_id"]} '
                         f'{cell(item["product"]["name"])} | {item["method"]} |')
        lines += ['', '</details>', '']
    if exact:
        lines += ['<details>', f'<summary>{len(exact)} exact matches</summary>', '',
                  '; '.join(f'{item["number"]} {item["name"]} = {item["product"]["product_id"]}' for item in exact), '',
                  '</details>', '']
    misses = sorted((item for item in results if item['outcome'] in ('missed', 'ambiguous')),
                    key=lambda item: sort_number(item['number']))
    if misses:
        lines += ['Misses:', '', '| Number | Card | Outcome | Candidates on the number |', '| --- | --- | --- | --- |']
        for item in misses:
            names = '; '.join(f'{p["product_id"]} {p["name"]} ({p["number"]})' for p in item['candidates']) or 'none'
            lines.append(f'| {cell(item["number"])} | {cell(item["name"])} | {item["outcome"]} | {cell(names)} |')
        lines.append('')
    special = sorted((item for item in results if item['outcome'] == 'special'), key=lambda item: sort_number(item['number']))
    if special:
        lines += ['Special Editions only (never matched): ' + '; '.join(f'{item["number"]} {item["name"]}' for item in special), '']
    return lines


# ------------------------------------------------------------------ inputs


def read_editions_file(path):
    rows = []
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def read_editions_database(url):
    import psycopg  # Imported here so the pure functions and the tests need no database driver.
    with psycopg.connect(url) as conn, conn.cursor() as cursor:
        conn.read_only = True
        cursor.execute(EDITION_QUERY)
        return [row[0] for row in cursor.fetchall()]


def fetch_json(path, cache_dir, refresh=False, pause=0.2):
    """A TCGCSV JSON document, from the cache or downloaded (one User-Agent header; tcgcsv.com answers 401 without)."""
    target = Path(cache_dir) / (path.strip('/').replace('/', '_') + '.json')
    if target.exists() and not refresh:
        return json.loads(target.read_text(encoding='utf-8'))
    request = urllib.request.Request(BASE_URL + '/' + path.strip('/'), headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
    document = json.loads(body)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.decode('utf-8'), encoding='utf-8')
    time.sleep(pause)
    return document


def load_tcgcsv(cache_dir, wanted_group_ids=None, refresh=False):
    """(groups, {group id: card products}). Only the wanted groups' products are downloaded when given."""
    groups = fetch_json(f'tcgplayer/{POKEMON_CATEGORY}/groups', cache_dir, refresh)['results']
    products = {}
    for group in groups:
        if wanted_group_ids is not None and group['groupId'] not in wanted_group_ids:
            continue
        raw = fetch_json(f'tcgplayer/{POKEMON_CATEGORY}/{group["groupId"]}/products', cache_dir, refresh)['results']
        products[group['groupId']] = card_products(raw)
    return groups, products


def candidate_group_ids(infos, groups):
    ids = set()
    for info in infos.values():
        ids.update(group['groupId'] for group, _ in name_candidate_groups(info['set_name'], groups))
    return ids


def build_proposals(rows, groups, products_by_group, enabled=CORE_EQUIVALENCES, excluded=EXCLUDED_SETS):
    infos = eligible_cards(rows, excluded)
    groups = [{**group, 'cards': products_by_group.get(group['groupId'], [])} for group in groups]
    by_id = {group['groupId']: group for group in groups}
    proposals = []
    for set_id, info in infos.items():
        proposal = propose_set(info, groups, {gid: group['cards'] for gid, group in by_id.items()}, enabled)
        proposals.append((summarize(set_id, info, proposal), info, proposal))
    proposals.sort(key=lambda item: (-item[0]['cards_gained'], item[0]['set_id']))
    return proposals


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--database-url', help='PostgreSQL URL of the catalog (read only)')
    source.add_argument('--editions', help='JSON Lines file of EDITION_QUERY rows')
    parser.add_argument('--cache-dir', default=str(Path(tempfile.gettempdir()) / 'prizecheck-tcgcsv-cache'))
    parser.add_argument('--out', default=str(DEFAULT_OUT))
    parser.add_argument('--refresh', action='store_true', help='download TCGCSV again instead of using the cache')
    parser.add_argument('--print-query', action='store_true', help='print the Edition query and exit')
    args = parser.parse_args(argv)
    if args.print_query:
        print(EDITION_QUERY + ';')
        return 0
    if not (args.database_url or args.editions):
        parser.error('one of --database-url or --editions is required')
    rows = read_editions_database(args.database_url) if args.database_url else read_editions_file(args.editions)
    groups, _ = load_tcgcsv(args.cache_dir, wanted_group_ids=set(), refresh=args.refresh)
    infos = eligible_cards(rows)
    groups, products = load_tcgcsv(args.cache_dir, candidate_group_ids(infos, groups), args.refresh)
    proposals = build_proposals(rows, groups, products, ALL_EQUIVALENCES)
    core = build_proposals(rows, groups, products, CORE_EQUIVALENCES)
    Path(args.out).write_text(render_report(proposals, core), encoding='utf-8')
    print(f'{len(proposals)} sets with no-id cards; wrote {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
