from app.catalog import TCGdexSource


def test_live_enumeration_id_shapes_round_trip_through_card_urls():
    source = TCGdexSource()
    calls = []

    def get(url):
        calls.append(url)
        if url.endswith('/cards'):
            return [{'id': 'exu-!'}, {'id': 'exu-%3F'}]
        return {'id': 'exu-%3F'}

    source._get = get
    assert source.enumerate() == {'exu-!', 'exu-%3F'}
    assert source.fetch('exu-%3F')['id'] == 'exu-%3F'
    assert calls[-1].endswith('/cards/exu-%253F')
    source.client.close()
