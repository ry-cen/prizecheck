"""DB-free golden vectors for catalog review identity."""
import pytest

from app.games.pokemon.catalog import catalog
from app.games.pokemon.prices import catalog_targets


@pytest.mark.parametrize("value, name, expected_name, expected_digest", [
    ({'name': 'Pokémon é 雪', 'z': 1}, '  Pokémon\t 雪\n', 'Pokémon 雪', '70246a5c940771fe84f7fdf11b8cdbd0d9dcddadcb775f7d1ad48840c9e910f7'),
    ({'z': [None, True, {'b': 2, 'a': 'é'}], 'a': {'n': 1.25}}, '\n Mr.\xa0 Mime  ', 'Mr. Mime', '0b5c335b0f0f25fd74357c7825e7ebed522ced60b03c6d1bd7951bc0fd8c5a19'),
])
def test_catalog_review_identity_golden_vectors(value, name, expected_name, expected_digest):
    for module in (catalog, catalog_targets):
        assert module.normalized_name(name) == expected_name
        assert module.fingerprint(value) == expected_digest
        assert module.fingerprint(dict(reversed(list(value.items())))) == expected_digest
