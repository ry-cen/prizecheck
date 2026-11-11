"""The bounded SVP scope survives link withdrawal and missing derived metadata."""
NUMBERS = frozenset(('013','014','027','044','051','065','066','075','097','098',
                     '123','129','141','159','173','189','203','209','210'))
REFERENCE_NUMBERS = NUMBERS - {'203', '209', '210'}
LOOKUP_KEYS = frozenset(('variantId','thirdParty','pricing','card_pricing','cardmarket','tcgplayer','tcgOnline'))


def physical(descriptor):
    plain = {key: value for key, value in descriptor.items() if key not in LOOKUP_KEYS}
    if plain.get('type') == 'holo':
        plain.setdefault('size', 'standard')
    if isinstance(plain.get('stamp'), str):
        plain['stamp'] = [plain['stamp']]
    return plain


def number(value):
    text = (value or '').lstrip('0')
    return text.zfill(3) if text.isdigit() else None


def regular_reference(set_id, collector_number, descriptor):
    return ((set_id or '').casefold() == 'svp' and number(collector_number) in REFERENCE_NUMBERS
            and physical(descriptor) == {'type': 'holo', 'size': 'standard'})
