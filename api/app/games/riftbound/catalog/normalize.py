"""Normalise one TCGCSV group's `products` and `prices` JSON into catalog candidates (#534).

Pure: no database, no HTTP, no clock. Nothing is dropped. A product the owner has not ruled on stays in the
result with a flag (see model.FLAGS), and the review list says what is open. Generation promotion, tombstones
and bulk-drop handling are not here.

Rules and where they come from:

* Owner-approved (2026-11-09): one Card Identity per underlying card; `(Alternate Art)` does not change the
  identity; a different name is a different identity; a same-name pair with conflicting text goes to review.
  The text comparison is a conservative comparison applying the owner's approved rule that conflicting or
  uncertain matches go to review: differences other than case, whitespace and HTML tags go to review, so a
  difference inside the reminder text is a conflict. `(Alternate Art)` groups only as a name's sole bracketed
  part, by the same rule. Printings grouped by name and text that differ on other card details keep their
  identity and carry `printing_details_differ` for review.
* Read off real TCGCSV data (the delimiter, the literal `None`): parsing facts only.
* Everything else the acceptance spec proposes (PC-2 card scope, PC-5 finishes, PC-9 other delimiters, other
  name markers, duplicate numbers) is flagged as pending, not decided.
"""
import html
import re
import unicodedata

from .model import (FLAG_CARD_SCOPE_PENDING, FLAG_DUPLICATE_NUMBER_PENDING, FLAG_EXTENDED_FIELD_REPEATED,
                    FLAG_FINISH_POLICY_PENDING, FLAG_IDENTITY_TEXT_CONFLICT, FLAG_MARKER_GROUPING_PENDING,
                    FLAG_MULTI_VALUE_UNPARSED, FLAG_PRICE_WITHOUT_PRODUCT, FLAG_PRINTING_DETAILS_DIFFER, CardScope,
                    EditionCandidate, GroupResult, IdentityCandidate, PriceObservation, PrintingCandidate,
                    PrintingKey, ReviewItem)

# Verified on categories/89 groups 24343, 24344, 24519 and 24528 (2026-11-10): Domain, Tag and Card Type all
# join several values with `;`, e.g. `Fury;Mind`, `Noxus;Dragon`, `Unit;Token`.
MULTI_VALUE_DELIMITER = ';'
# Delimiters that would make a value look multi-valued without being the one above. A value containing any is
# kept raw and flagged, never split.
OTHER_DELIMITERS = (',', '/', '|', '&', '+', '\n', '\t')
# The source writes the literal `None` for "no value" in Domain and Card Type.
NO_VALUE = 'None'

# Card details compared across the printings of one identity. Names are the source's extended field names. The list is
# a working choice for what "uncertain" covers. Rarity is left out: it belongs to each printing, and artwork versions
# are expected to differ in it.
DETAIL_FIELDS = ('Domain', 'Tag', 'Card Type', 'Energy Cost', 'Power Cost', 'Might')
# These hold several values; their order is not compared.
MULTI_VALUE_DETAILS = ('Domain', 'Tag', 'Card Type')

# The one marker the owner approved for automatic grouping.
GROUPED_MARKER = 'alternate art'
_MARKER = re.compile(r'\s*\(([^()]*)\)\s*$')
_BRACKETED = re.compile(r'\(([^()]*)\)')

# Working mapping of price subtypes to finishes. Mapping these two is allowed; deciding what an unpriced product
# or another subtype becomes is not.
FINISH_BY_SUBTYPE = {'Normal': 'normal', 'Foil': 'foil'}

_TAGS = re.compile(r'<[^>]*>')
_SPACE = re.compile(r'\s+')


class SourceResponseError(ValueError):
    """A TCGCSV response that reports failure or has no `results`: not an empty group."""


def results(payload, what):
    """The list of a TCGCSV response (`{success, errors, results}`) or a bare list."""
    if isinstance(payload, dict):
        if payload.get('success') is False or payload.get('errors'):
            raise SourceResponseError(f'{what} response reports failure: {payload.get("errors")!r}')
        if payload.get('results') is None:
            raise SourceResponseError(f'{what} response has no results')
        rows = payload['results']
    else:
        rows = payload
    if not isinstance(rows, (list, tuple)) or not all(isinstance(row, dict) for row in rows):
        raise ValueError(f'{what} is not a list of objects')
    return rows


def fold(text):
    return _SPACE.sub(' ', unicodedata.normalize('NFKC', text)).strip().casefold()


def plain_text(text):
    return _SPACE.sub(' ', html.unescape(_TAGS.sub(' ', text))).strip()


def rules_text(description):
    """The Description as compared for conflicts: a conservative comparison applying the owner's approved rule that
    conflicting or uncertain matches go to review. Differences other than case, whitespace and HTML tags go to
    review, so reminder text counts."""
    return fold(plain_text(description or ''))


def split_name(name):
    """(base name, marker or None, bracketed parts): a trailing parenthetical is the marker. Every bracketed part
    of the name is returned, whether or not it trails."""
    parts = tuple(part.strip() for part in _BRACKETED.findall(name))
    found = _MARKER.search(name)
    if not found:
        return name.strip(), None, parts
    return name[:found.start()].strip(), found.group(1).strip(), parts


def split_values(raw):
    """(values, unrecognised). Splits on MULTI_VALUE_DELIMITER only; a value with another apparent delimiter
    stays whole. A missing value and the literal `None` give no values."""
    if raw is None or raw.strip() in ('', NO_VALUE):
        return (), False
    if any(delimiter in raw for delimiter in OTHER_DELIMITERS):
        return (raw,), True
    return tuple(part.strip() for part in raw.split(MULTI_VALUE_DELIMITER) if part.strip()), False


def extended_entries(product):
    """Every extendedData entry as (name, value), in source order."""
    entries = product.get('extendedData')
    if entries is None:
        return ()
    if not isinstance(entries, (list, tuple)):
        raise ValueError(f'product {product["productId"]} has extendedData that is not a list')
    for entry in entries:
        if not (isinstance(entry, dict) and isinstance(entry.get('name'), str)
                and isinstance(entry.get('value'), (str, type(None)))):
            raise ValueError(f'product {product["productId"]} has a malformed extendedData entry')
    return tuple((entry['name'], entry.get('value')) for entry in entries)


def extended_fields(entries):
    """name -> value, the first value when a name repeats."""
    fields = {}
    for name, value in entries:
        fields.setdefault(name, value)
    return fields


def number_of(extended):
    value = extended.get('Number')
    return value if value and value.strip() else None


def scope_of(number, card_types, card_type_unparsed=False):
    return CardScope(has_number=number is not None, has_card_type=bool(card_types), card_types=card_types,
                     card_type_unparsed=card_type_unparsed,
                     looks_sealed=number is None and not card_types,
                     looks_token=any(fold(value) == 'token' for value in card_types))


def price_observation(row):
    return PriceObservation(low=row.get('low'), mid=row.get('mid'), high=row.get('high'),
                            market=row.get('market'), direct_low=row.get('directLow'))


def editions_of(rows):
    """One EditionCandidate per distinct subtype, in source order."""
    by_subtype = {}
    for row in rows:
        by_subtype.setdefault(row.get('subTypeName'), []).append(price_observation(row))
    return tuple(
        EditionCandidate(subtype=subtype, finish=FINISH_BY_SUBTYPE.get(subtype), prices=tuple(observed),
                         flags=() if subtype in FINISH_BY_SUBTYPE else (FLAG_FINISH_POLICY_PENDING,))
        for subtype, observed in by_subtype.items())


def normalise_group(products, prices=()):
    """GroupResult for one group's products and prices (either a response object or its `results` list).

    Raises ValueError for a structurally broken payload: a product without an integer productId or groupId,
    a repeated productId, or products from more than one group.
    """
    products = results(products, 'products')
    price_rows = results(prices, 'prices')
    for row in price_rows:
        if type(row.get('productId')) is not int:
            raise ValueError('a price row has no integer productId')
    ids, groups = set(), set()
    for product in products:
        if not isinstance(product.get('name', ''), str):
            raise ValueError(f'product {product.get("productId")} has a name that is not text')
        for name in ('productId', 'groupId'):
            if type(product.get(name)) is not int:
                raise ValueError(f'a product has no integer {name}')
        if product['productId'] in ids:
            raise ValueError(f'productId {product["productId"]} appears twice')
        ids.add(product['productId'])
        groups.add(product['groupId'])
    if len(groups) > 1:
        raise ValueError(f'products come from more than one group: {sorted(groups)}')
    group_id = next(iter(groups), None)

    by_product = {}
    for row in price_rows:
        by_product.setdefault(row.get('productId'), []).append(row)

    drafts = [draft(product, group_id, by_product.get(product['productId'], [])) for product in sorted(
        products, key=lambda product: product['productId'])]
    review = []
    flags = {d['key'].product_id: list(d['flags']) for d in drafts}

    def flag(product_ids, code, detail):
        for product_id in product_ids:
            if code not in flags[product_id]:
                flags[product_id].append(code)
        review.append(ReviewItem(code, tuple(product_ids), detail))

    for d in drafts:
        pid = d['key'].product_id
        for code, detail in d['pending']:
            flag([pid], code, detail)

    # Several products with one Number in this group: every one is kept and flagged.
    numbers = {}
    for d in drafts:
        if d['number'] is not None:
            numbers.setdefault(d['number'], []).append(d['key'].product_id)
    for number, product_ids in numbers.items():
        if len(product_ids) > 1:
            flag(product_ids, FLAG_DUPLICATE_NUMBER_PENDING, f'Number {number} is on {len(product_ids)} products')

    # Card Identity: proposed only for a product with no open question about its scope or marker.
    candidates = {}
    for d in drafts:
        pid = d['key'].product_id
        if not (set(flags[pid]) & {FLAG_CARD_SCOPE_PENDING, FLAG_MARKER_GROUPING_PENDING,
                                   FLAG_EXTENDED_FIELD_REPEATED}):
            candidates.setdefault(fold(d['base_name']), []).append(d)
    identities, identity_of = [], {}
    for identity_key, members in candidates.items():
        if len({d['rules_text'] for d in members}) > 1:
            product_ids = [d['key'].product_id for d in members]
            flag(product_ids, FLAG_IDENTITY_TEXT_CONFLICT,
                 f'{members[0]["base_name"]!r}: the products disagree on rules text')
            continue
        differing = differing_details(members)
        if differing:
            flag([d['key'].product_id for d in members], FLAG_PRINTING_DETAILS_DIFFER,
                 f'{members[0]["base_name"]!r}: the printings differ on ' + ', '.join(differing))
        unmarked = [d for d in members if d['marker'] is None]
        identities.append(IdentityCandidate(identity_key, (unmarked or members)[0]['base_name'],
                                            tuple(d['key'] for d in members)))
        identity_of.update({d['key'].product_id: identity_key for d in members})

    printings = tuple(printing(d, identity_of.get(d['key'].product_id), tuple(flags[d['key'].product_id]))
                      for d in drafts)

    for product_id in sorted(set(by_product) - ids):
        review.append(ReviewItem(FLAG_PRICE_WITHOUT_PRODUCT, (product_id,),
                                 f'{len(by_product[product_id])} price rows for a product not in the group'))

    return GroupResult(group_id=group_id, identities=tuple(sorted(identities, key=lambda i: i.identity_key)),
                       printings=printings, review=tuple(review), counts=counts_of(printings, identities, review))


def differing_details(members):
    """The DETAIL_FIELDS on which the products of one identity disagree. A missing value differs from a present one."""
    differing = []
    for field in DETAIL_FIELDS:
        values = set()
        for d in members:
            raw = d['extended'].get(field)
            if raw is None or raw.strip() in ('', NO_VALUE):
                values.add(None)
            elif field in MULTI_VALUE_DETAILS:
                values.add(tuple(sorted(split_values(raw)[0])))
            else:
                values.add(raw.strip())
        if len(values) > 1:
            differing.append(field)
    return differing


def draft(product, group_id, rows):
    """Everything about one product that needs no other product, plus the pending questions it raises."""
    entries = extended_entries(product)
    extended = extended_fields(entries)
    name = product.get('name') or ''
    base_name, marker, brackets = split_name(name)
    number = number_of(extended)
    card_types, card_types_unparsed = split_values(extended.get('Card Type'))
    domains, domains_unparsed = split_values(extended.get('Domain'))
    tags, tags_unparsed = split_values(extended.get('Tag'))
    scope = scope_of(number, card_types, card_types_unparsed)
    pending = []
    if not (scope.has_number and scope.has_card_type) or scope.looks_token or scope.card_type_unparsed:
        missing = [label for label, present in (('Number', scope.has_number), ('Card Type', scope.has_card_type))
                   if not present]
        pending.append((FLAG_CARD_SCOPE_PENDING,
                        'no ' + ' or '.join(missing) if missing else 'Card Type includes Token'
                        if scope.looks_token else 'Card Type has an unrecognised separator'))
    # `(Alternate Art)` groups only as the name's one bracketed part; any other bracketed part, trailing or not,
    # is an open question.
    if brackets and not (len(brackets) == 1 and marker is not None and fold(marker) == GROUPED_MARKER):
        pending.append((FLAG_MARKER_GROUPING_PENDING, 'bracketed parts ' + ', '.join(
            f'({part})' for part in brackets) + f' on proposed base name {base_name!r}'))
    names = [entry_name for entry_name, _ in entries]
    repeated = sorted({entry_name for entry_name in names if names.count(entry_name) > 1})
    if repeated:
        pending.append((FLAG_EXTENDED_FIELD_REPEATED, 'repeated: ' + ', '.join(repeated)))
    subtypes = tuple(dict.fromkeys(row.get('subTypeName') for row in rows))
    if not rows:
        pending.append((FLAG_FINISH_POLICY_PENDING, 'no price rows'))
    elif any(subtype not in FINISH_BY_SUBTYPE for subtype in subtypes):
        pending.append((FLAG_FINISH_POLICY_PENDING, 'price subtype outside Normal and Foil: ' + ', '.join(
            repr(subtype) for subtype in subtypes if subtype not in FINISH_BY_SUBTYPE)))
    unparsed = [label for label, flagged in (('Card Type', card_types_unparsed), ('Domain', domains_unparsed),
                                             ('Tag', tags_unparsed)) if flagged]
    if unparsed:
        pending.append((FLAG_MULTI_VALUE_UNPARSED, 'kept raw: ' + ', '.join(unparsed)))
    return {'key': PrintingKey(group_id, product['productId']), 'product': product, 'extended': extended, 'entries': entries,
            'name': name, 'base_name': base_name, 'marker': marker, 'number': number, 'scope': scope,
            'card_types': card_types, 'domains': domains, 'tags': tags, 'rows': rows, 'subtypes': subtypes,
            'rules_text': rules_text(extended.get('Description')), 'pending': pending, 'flags': ()}


def printing(d, identity_key, flags):
    product, extended = d['product'], d['extended']
    flavor = extended.get('Flavor Text')
    return PrintingCandidate(
        key=d['key'], name=d['name'], clean_name=product.get('cleanName'), base_name=d['base_name'],
        marker=d['marker'], identity_key=identity_key, number=d['number'], rarity=extended.get('Rarity') or None,
        scope=d['scope'], card_types=d['card_types'], domains=d['domains'], tags=d['tags'],
        energy_cost=extended.get('Energy Cost'), power_cost=extended.get('Power Cost'), might=extended.get('Might'),
        description_html=extended.get('Description'), flavor_text_html=flavor,
        flavor_text_plain=plain_text(flavor) if flavor is not None else None, image_url=product.get('imageUrl'),
        modified_on=product.get('modifiedOn'), extended=extended, extended_entries=d['entries'], price_subtypes=d['subtypes'],
        editions=editions_of(d['rows']), flags=flags)


def counts_of(printings, identities, review):
    counts = {'products': len(printings), 'identities': len(identities),
              'editions': sum(len(p.editions) for p in printings),
              'products_without_identity': sum(1 for p in printings if p.identity_key is None),
              'products_flagged': sum(1 for p in printings if p.flags), 'review_items': len(review)}
    for item in review:
        counts[item.code] = counts.get(item.code, 0) + 1
    return counts
