import pytest

from app.catalog import CatalogError, TCGdexSource


def pocket_listing(overrides=None):
    """Mock TCGdex responses with a Pocket series of two sets beside physical cards."""
    responses = {
        '/cards': [{'id': 'sv01-001'}, {'id': 'A1-001'}, {'id': 'P-A-001'}],
        '/series/tcgp': {'id': 'tcgp', 'sets': [{'id': 'A1'}, {'id': 'P-A'}]},
        '/sets/A1': {'id': 'A1', 'serie': {'id': 'tcgp'}, 'cards': [{'id': 'A1-001'}, {'id': 'A1-002'}]},
        '/sets/P-A': {'id': 'P-A', 'serie': {'id': 'tcgp'}, 'cards': [{'id': 'P-A-001'}]},
        **(overrides or {})}
    calls = []

    def get(url):
        calls.append(url)
        return responses[url.removeprefix('https://api.tcgdex.net/v2/en')]
    source = TCGdexSource()
    source._get = get
    return source, calls


def test_live_enumeration_id_shapes_round_trip_through_card_urls():
    source = TCGdexSource()
    calls = []

    def get(url):
        calls.append(url)
        if url.endswith('/cards'):
            return [{'id': 'exu-!'}, {'id': 'exu-%3F'}]
        if url.endswith('/series/tcgp'):
            return {'id': 'tcgp', 'sets': [{'id': 'A1'}]}
        if url.endswith('/sets/A1'):
            return {'id': 'A1', 'serie': {'id': 'tcgp'}, 'cards': []}
        return {'id': 'exu-%3F'}

    source._get = get
    assert source.enumerate() == {'exu-!', 'exu-%3F'}
    assert source.fetch('exu-%3F')['id'] == 'exu-%3F'
    assert calls[-1].endswith('/cards/exu-%253F')
    source.client.close()


def test_enumeration_leaves_out_the_pocket_series():
    source, calls = pocket_listing()
    assert source.enumerate() == {'sv01-001'}
    assert source.excluded_sets == frozenset({'A1', 'P-A'})
    assert source.excluded_ids == frozenset({'A1-001', 'A1-002', 'P-A-001'})
    assert not any('/cards/' in url for url in calls)
    source.client.close()


@pytest.mark.parametrize('overrides', [
    {'/series/tcgp': {'id': 'tcgp', 'sets': []}},
    {'/series/tcgp': {'id': 'other', 'sets': [{'id': 'A1'}]}},
    {'/series/tcgp': {'id': 'tcgp', 'sets': [{'id': '../A1'}]}},
    {'/sets/A1': {'id': 'A1', 'serie': {'id': 'sv'}, 'cards': [{'id': 'A1-001'}]}},
    {'/sets/A1': {'id': 'A1', 'serie': {'id': 'tcgp'}}},
    {'/sets/A1': {'id': 'A1', 'serie': {'id': 'tcgp'}, 'cards': [{'name': 'Bulbasaur'}]}},
    {'/sets/A1': ['not', 'a', 'set']},
    {'/sets/A1': {'id': 'A2', 'serie': {'id': 'tcgp'}, 'cards': []}},
    {'/series/tcgp': {'id': 'tcgp', 'sets': {'id': 'A1'}}},
    {'/series/tcgp': {'id': 'tcgp', 'sets': [{'id': '..'}]}},
])
def test_doubtful_pocket_listing_fails_closed(overrides):
    source, _ = pocket_listing(overrides)
    with pytest.raises(CatalogError):
        source.enumerate()
    source.client.close()
