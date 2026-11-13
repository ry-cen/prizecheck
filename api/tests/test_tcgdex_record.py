"""The TCGdex record identity helpers that catalog import and metadata review use (ADR 0019 keeps them; the price
selection they once fed is retired)."""
from app.games.pokemon.catalog.catalog import source_descriptor as catalog_source_descriptor
from app.games.pokemon.prices import tcgdex_record


def test_catalog_import_uses_the_record_modules_source_descriptor():
    assert catalog_source_descriptor is tcgdex_record.source_descriptor
    value = {'type': 'x', 'variantId': 'v', 'pricing': {}, 'cardmarket': 1, 'tcgplayer': 2, 'none': None,
             'stamps': [{'b': 1}, {'a': 2}]}
    assert tcgdex_record.source_descriptor(value) == {'type': 'x', 'stamps': [{'a': 2}, {'b': 1}]}


def test_a_variant_listed_twice_entry_for_entry_is_one_variant():
    twin = {'type': 'normal', 'pricing': {'tcgplayer': {'normal': {'productId': 1}}}}
    other = {'type': 'reverse'}
    assert tcgdex_record.distinct_variants([twin, dict(twin), other]) == [twin, other]


def test_the_module_keeps_only_identity_helpers():
    public = {name for name in vars(tcgdex_record) if not name.startswith('_')}
    assert {'source_descriptor', 'priced_variant', 'distinct_variants'} <= public
    assert not public & {'select_quote', 'Quote', 'Absent', 'Failure'}
