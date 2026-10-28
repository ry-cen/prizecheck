import httpx
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

    def respond(url):
        calls.append(url)
        if url.endswith('/cards'):
            body = [{'id': 'exu-!'}, {'id': 'exu-%3F'}]
        elif url.endswith('/series/tcgp'):
            body = {'id': 'tcgp', 'sets': [{'id': 'A1'}]}
        elif url.endswith('/sets/A1'):
            body = {'id': 'A1', 'serie': {'id': 'tcgp'}, 'cards': []}
        else:
            body = {'id': 'exu-%3F'}
        return httpx.Response(200, json=body, request=httpx.Request('GET', url))

    source._response = respond
    assert source.enumerate() == {'exu-!', 'exu-%3F'}
    assert source.fetch('exu-%3F')['id'] == 'exu-%3F'
    assert calls[-1].endswith('/cards/exu-%253F')
    source.client.close()


def test_a_card_fetch_keeps_only_the_import_record_and_no_price_view():
    source = TCGdexSource()
    body = (b'{"id":"sv01-001","name":"Pikachu","pricing":{"tcgplayer":{"normal":{"productId":7,"marketPrice":0.10}}}}')
    source._response = lambda url: httpx.Response(200, content=body, request=httpx.Request('GET', url))
    record = source.fetch('sv01-001')
    assert record['pricing']['tcgplayer']['normal']['marketPrice'] == 0.1  # the import's record still parses floats
    assert not hasattr(source, 'price_views')
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
