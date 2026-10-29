"""08-A: the bounded TCGdex source client and the pure record validation. A local fake server stands in for TCGdex."""
import ast
import copy
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app.games.pokemon.prices import price_source

from app.games.pokemon.prices import tcgdex_record
from app.games.pokemon.catalog.catalog import source_descriptor as catalog_source_descriptor
from app.games.pokemon.prices.tcgdex_record import Absent, Failure, Quote, select_quote

APP = Path(__file__).parent.parent / 'app'


class Fake:
    """Serves scripted responses; each script step is a callable(handler) run for one request."""

    def __init__(self):
        self.script, self.requests, self.lock = [], [], threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_GET(self):
                with fake.lock:
                    fake.requests.append(self.path)
                    step = fake.script.pop(0) if fake.script else respond(404)
                try:
                    step(self)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.server.handle_error = lambda *args: None
        self.origin = 'http://127.0.0.1:%d' % self.server.server_address[1]
        # shutdown() waits up to one poll interval (0.5 s by default) for serve_forever to notice.
        threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def respond(status, body=b'{}', headers=()):
    def step(handler):
        handler.send_response(status)
        handler.send_header('Content-Length', str(len(body)))
        for key, value in headers:
            handler.send_header(key, value)
        handler.end_headers()
        handler.wfile.write(body)
    return step


@pytest.fixture
def fake(monkeypatch):
    server = Fake()
    monkeypatch.setattr(price_source, 'ORIGIN', server.origin)
    yield server
    server.close()


GOOD = json.dumps({'id': 'swsh3-136', 'marketPrice': 0.25, 'big': 12345678901234567890}).encode()


def test_success_parses_floats_as_text_and_requests_the_encoded_path(fake):
    fake.script = [respond(200, GOOD)]
    result = price_source.fetch('swsh3-136')
    assert result.ok and result.attempts == 1 and result.reason is None
    assert result.record['marketPrice'] == '0.25'
    assert fake.requests == ['/v2/en/cards/swsh3-136']


def test_floats_are_text_never_floats(fake):
    fake.script = [respond(200, b'{"a": 0.1000000000000000055511151231257827, "b": 1e-7}')]
    record = price_source.fetch('x').record
    assert record == {'a': '0.1000000000000000055511151231257827', 'b': '1e-7'}


def test_redirect_is_never_followed(fake):
    target = Fake()
    try:
        fake.script = [respond(302, b'', [('Location', target.origin + '/v2/en/cards/x')])]
        result = price_source.fetch('x')
        assert (result.ok, result.reason, result.attempts) == (False, 'redirect', 1)
        assert target.requests == []
    finally:
        target.close()


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
@pytest.mark.slow(reason='wall-clock: waits out the real 2 s fetch deadline')
def test_drip_fed_body_fails_within_the_deadline(fake):
    def drip(handler):
        handler.send_response(200)
        handler.send_header('Content-Length', '100000')
        handler.end_headers()
        for _ in range(100):
            handler.wfile.write(b' ')
            handler.wfile.flush()
            time.sleep(0.1)
    fake.script = [drip, drip]
    start = time.monotonic()
    result = price_source.fetch('x')
    elapsed = time.monotonic() - start
    assert not result.ok and result.reason == 'timeout'
    assert elapsed <= 2.05, elapsed


def test_oversize_body_fails_without_reading_further(fake):
    sent = []

    def big(handler):
        handler.send_response(200)
        handler.end_headers()
        chunk = b'a' * 65536
        try:
            for _ in range(200):
                handler.wfile.write(chunk)
                handler.wfile.flush()
                sent.append(len(chunk))
        except (BrokenPipeError, ConnectionResetError):
            pass
        handler.close_connection = True
    fake.script = [big]
    result = price_source.fetch('x')
    assert (result.ok, result.reason, result.attempts) == (False, 'too_large', 1)


def test_exactly_the_cap_is_read_and_one_more_byte_fails(fake):
    cap = price_source.MAX_BYTES
    body = b'"' + b'a' * (cap - 2) + b'"'
    fake.script = [respond(200, body)]
    assert price_source.fetch('x').ok
    fake.script = [respond(200, body + b' ')]
    assert price_source.fetch('x').reason == 'too_large'


@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
@pytest.mark.slow(reason='wall-clock: waits a real retry interval')
def test_503_then_200_retries_after_a_bounded_wait(fake):
    fake.script = [respond(503), respond(200, GOOD)]
    start = time.monotonic()
    result = price_source.fetch('swsh3-136')
    elapsed = time.monotonic() - start
    assert result.ok and result.attempts == 2
    assert 0.5 <= elapsed <= 1.2, elapsed
    assert len(fake.requests) == 2


@pytest.mark.slow(reason='wall-clock: waits real retry intervals')
def test_two_503s_stop_and_report_the_status(fake):
    fake.script = [respond(503), respond(503), respond(200, GOOD)]
    result = price_source.fetch('x')
    assert (result.ok, result.reason, result.status, result.attempts) == (False, 'http_status', 503, 2)
    assert len(fake.requests) == 2


def test_404_and_400_are_not_retried(fake):
    for status in (404, 400, 403):
        fake.requests.clear()
        fake.script = [respond(status), respond(200, GOOD)]
        result = price_source.fetch('x')
        assert (result.ok, result.reason, result.status, result.attempts) == (False, 'http_status', status, 1)
        assert len(fake.requests) == 1


def test_429_is_retried_and_retry_after_is_returned(fake):
    fake.script = [respond(429, headers=[('Retry-After', '1')]), respond(429, headers=[('Retry-After', '1')])]
    result = price_source.fetch('x')
    assert (result.reason, result.status, result.retry_after, result.attempts) == ('http_status', 429, 1, 2)


def test_a_retry_after_longer_than_the_retry_window_is_not_retried_early(fake):
    fake.script = [respond(429, headers=[('Retry-After', '120')]), respond(200, GOOD)]
    asked = []
    result = price_source.fetch('x', may_retry=lambda: asked.append(1) or True)
    assert (result.ok, result.reason, result.status, result.retry_after, result.attempts) == (False, 'http_status', 429, 120, 1)
    assert (len(fake.requests), asked) == (1, [])


def test_retry_hook_can_refuse_the_second_attempt(fake):
    fake.script = [respond(503), respond(200, GOOD)]
    asked = []
    result = price_source.fetch('x', may_retry=lambda: asked.append(1) or False)
    assert (result.ok, result.attempts, asked) == (False, 1, [1])
    assert len(fake.requests) == 1


def test_retry_hook_is_not_called_for_non_retryable_failures(fake):
    fake.script = [respond(404)]
    price_source.fetch('x', may_retry=lambda: pytest.fail('asked'))


def test_transport_error_is_retried(fake):
    def drop(handler):
        handler.close_connection = True
        handler.connection.close()
    fake.script = [drop, respond(200, GOOD)]
    result = price_source.fetch('x')
    assert result.ok and result.attempts == 2


def test_refused_connection_is_transport(monkeypatch):
    monkeypatch.setattr(price_source, 'ORIGIN', 'http://127.0.0.1:1')
    result = price_source.fetch('x', may_retry=lambda: False)
    assert (result.ok, result.reason) == (False, 'transport')


def test_retry_is_skipped_when_the_budget_cannot_cover_the_wait(fake, monkeypatch):
    monkeypatch.setattr(price_source, 'DEADLINE_S', 0.6)
    monkeypatch.setattr(price_source, '_uniform', lambda a, b: 0.5)
    fake.script = [respond(503), respond(200, GOOD)]
    result = price_source.fetch('x')
    assert (result.ok, result.attempts) == (False, 1)


@pytest.mark.parametrize('value, expected', [
    ('1', 1), ('3600', 3600), ('99999', 3600), ('0', None), ('-5', None), ('abc', None), ('1.5', None), ('', None), (None, None)])
def test_retry_after_seconds(value, expected):
    assert price_source.parse_retry_after(value, now=1_000_000) == expected


def test_retry_after_http_date():
    from email.utils import formatdate
    assert price_source.parse_retry_after(formatdate(1_000_090, usegmt=True), now=1_000_000) in (89, 90)
    assert price_source.parse_retry_after(formatdate(999_000, usegmt=True), now=1_000_000) is None
    assert price_source.parse_retry_after(formatdate(1_000_000 + 7200, usegmt=True), now=1_000_000) == 3600


def test_non_json_or_non_utf8_is_malformed(fake):
    fake.script = [respond(200, b'<html>'), respond(200, b'\xff\xfe')]
    assert price_source.fetch('x').reason == 'malformed'
    assert price_source.fetch('x').reason == 'malformed'


@pytest.mark.parametrize('card', ['', 'a/b', 'a b', '../x', 'a?b', 'a#b', 'é', 'x' * 129, None, 5, 'a\nb'])
def test_invalid_card_id_makes_no_request(fake, card):
    result = price_source.fetch(card)
    assert (result.ok, result.reason, result.attempts) == (False, 'malformed', 0)
    assert fake.requests == []


def test_card_id_is_percent_encoded(fake):
    fake.script = [respond(200, b'{}')]
    price_source.fetch('a%b!c')
    assert fake.requests == ['/v2/en/cards/a%25b%21c']


def test_result_carries_only_fixed_diagnostics(fake):
    result = price_source.fetch('x', may_retry=lambda: False)
    assert set(vars(result)) >= {'ok', 'reason', 'status', 'retry_after', 'attempts', 'record'}
    assert result.reason in price_source.REASONS


# --- static checks -------------------------------------------------------------------------------------------------

def test_single_origin_literal_and_safe_client_settings():
    assert price_source.ORIGIN == 'https://api.tcgdex.net'


# --- select_quote ---------------------------------------------------------------------------------------------------

def entry(**changes):
    value = {'type': 'normal', 'size': 'standard', 'variantId': 'n-1',
             'pricing': {'tcgplayer': {'unit': 'USD', 'updated': '2026-10-07T22:55:02Z',
                                       'normal': {'productId': 219333, 'marketPrice': '0.25'}}}}
    value.update(changes)
    return value


def record(*entries, id='swsh3-136'):
    return {'id': id, 'variants_detailed': list(entries) or [entry()]}


DESCRIPTOR = {'type': 'normal', 'size': 'standard'}
LOOKUP = {'card': 'swsh3-136', 'variant': 'normal'}


def select(rec, **overrides):
    args = dict(descriptor=DESCRIPTOR, lookup=LOOKUP, product_id='219333')
    args.update(overrides)
    return select_quote(rec, args['descriptor'], args['lookup'], args['product_id'])


def test_source_descriptor_moved_without_behaviour_change():
    assert catalog_source_descriptor is tcgdex_record.source_descriptor
    value = {'type': 'x', 'variantId': 'v', 'pricing': {}, 'cardmarket': 1, 'tcgplayer': 2, 'none': None,
             'stamps': [{'b': 1}, {'a': 2}]}
    assert tcgdex_record.source_descriptor(value) == {'type': 'x', 'stamps': [{'a': 2}, {'b': 1}]}


def test_valid_quote():
    assert select(record()) == Quote(amount='0.25', card='swsh3-136', variant='normal',
                                     provider_updated_at='2026-10-07T22:55:02Z')


def test_integer_price_is_text():
    rec = record(entry(pricing={'tcgplayer': {'updated': '2026-10-07T22:55:02Z', 'normal': {'productId': 219333, 'marketPrice': 5}}}))
    assert select(rec).amount == '5'


@pytest.mark.parametrize('updated', [None, 'garbage', '2026-10-07T22:55:02', 5, ''])
def test_provider_updated_at_is_null_when_missing_or_naive(updated):
    rec = record()
    block = rec['variants_detailed'][0]['pricing']['tcgplayer']
    if updated is None:
        del block['updated']
    else:
        block['updated'] = updated
    result = select(rec)
    assert isinstance(result, Quote) and result.provider_updated_at is None


@pytest.mark.parametrize('price', [None, 'MISSING'])
def test_null_or_missing_market_price_is_absent(price):
    rec = record()
    node = rec['variants_detailed'][0]['pricing']['tcgplayer']['normal']
    if price is None:
        node['marketPrice'] = None
    else:
        del node['marketPrice']
    assert select(rec) == Absent()


@pytest.mark.parametrize('price', ['-1', '1e-5', 'NaN', '0.1234567', '1234567890123', True, [], {}, 'abc', ''])
def test_garbled_price_is_malformed_never_absent(price):
    rec = record()
    rec['variants_detailed'][0]['pricing']['tcgplayer']['normal']['marketPrice'] = price
    assert select(rec) == Failure('malformed')


def test_zero_price_is_a_real_quote():
    rec = record()
    rec['variants_detailed'][0]['pricing']['tcgplayer']['normal']['marketPrice'] = '0'
    assert select(rec).amount == '0'


@pytest.mark.parametrize('rec', [None, [], 'x', {}, {'id': 5}, {'id': 'other', 'variants_detailed': []},
                                 {'id': 'swsh3-136'}, {'id': 'swsh3-136', 'variants_detailed': 'x'}])
def test_malformed_records(rec):
    assert select(rec) == Failure('malformed')


def test_descriptor_mismatch_is_lookup_drift():
    assert select(record(entry(size='jumbo'))) == Failure('lookup_drift')
    assert select(record(entry(size='jumbo'), entry(type='reverse')), descriptor={'type': 'holo'}) == Failure('lookup_drift')


def test_only_the_exactly_matching_entry_is_used():
    assert select(record(entry(size='jumbo'), entry())).amount == '0.25'


def test_two_matching_entries_are_ambiguous():
    assert select(record(entry(), entry(variantId='n-2'))) == Failure('ambiguous')


def test_an_entry_listed_twice_is_one_entry():
    # TCGdex lists some variants twice, entry for entry (gym2-75).
    assert select(record(entry(), entry())).amount == '0.25'


def test_non_dict_entries_are_ignored_for_matching():
    assert select(record('junk', entry())).amount == '0.25'


def test_product_id_mismatch_is_lookup_drift():
    assert select(record(), product_id='219334') == Failure('lookup_drift')
    assert select(record(), product_id=None) == Failure('lookup_drift')


def test_variant_key_must_equal_lookup_variant():
    assert select(record(), lookup={'card': 'swsh3-136', 'variant': 'reverse-holofoil'}) == Failure('lookup_drift')


def test_lookup_card_must_equal_record_id():
    assert select(record(), lookup={'card': 'swsh3-137', 'variant': 'normal'}) == Failure('malformed')


def test_missing_or_failing_block_is_a_failure_never_absent():
    for changes in ({'pricing': {}}, {'pricing': None}, {'pricing': {'tcgplayer': None}},
                    {'pricing': {'tcgplayer': {'unit': 'USD'}}},
                    {'pricing': {'tcgplayer': {'normal': {'marketPrice': '1'}}}}):
        assert select(record(entry(**changes))) == Failure('lookup_drift'), changes


def test_a_repeated_card_block_is_read_at_the_published_variant_only():
    # TCGdex repeats the card's whole TCGplayer block inside every variant.
    pricing = {'tcgplayer': {'updated': '2026-10-07T22:55:02Z', 'normal': {'productId': 219333, 'marketPrice': '1'},
                             'holofoil': {'productId': 5, 'marketPrice': '2'}}}
    assert select(record(entry(pricing=pricing))).amount == '1'
    assert select(record(entry(pricing=pricing)), product_id='5') == Failure('lookup_drift')
    assert select(record(entry(pricing=pricing)), lookup={'card': 'swsh3-136', 'variant': 'reverse-holofoil'}) == Failure('lookup_drift')


def test_a_variant_without_a_block_reads_the_cards_block_at_its_own_finish_only():
    # TCGdex often keeps the TCGplayer block on the card instead of inside each variant.
    card = {'tcgplayer': {'updated': '2026-10-07T22:55:02Z', 'normal': {'productId': 219333, 'marketPrice': '1'},
                          'reverse-holofoil': {'productId': 219333, 'marketPrice': '2'}}}
    bare = {key: value for key, value in entry().items() if key != 'pricing'}
    rec = {**record(bare), 'pricing': card}
    assert select(rec).amount == '1'
    reverse = {**bare, 'type': 'reverse'}
    assert select({**record(reverse), 'pricing': card}, descriptor={'type': 'reverse', 'size': 'standard'},
                  lookup={'card': 'swsh3-136', 'variant': 'reverse-holofoil'}).amount == '2'
    # A variant's own block wins, and a stamped variant borrows nothing from the card.
    assert select({**record(), 'pricing': {'tcgplayer': {'normal': {'productId': 219333, 'marketPrice': '9'}}}}).amount == '0.25'
    stamped = {**bare, 'stamp': ['set-logo']}
    assert select({**record(stamped), 'pricing': card}, descriptor={**DESCRIPTOR, 'stamp': ['set-logo']}) == Failure('lookup_drift')


def test_the_import_and_the_price_fetch_read_the_same_borrowed_entry():
    from app.games.pokemon.catalog.catalog import edition_metadata
    from app.games.pokemon.prices.catalog_targets import MatchingRulesV3
    card = {'tcgplayer': {'updated': '2026-10-07T22:55:02Z', 'normal': {'productId': 219333, 'marketPrice': '1'},
                          'reverse-holofoil': {'productId': 219333, 'marketPrice': '2'}}}
    bare = [{key: value for key, value in entry(type=finish, variantId=finish).items() if key != 'pricing'}
            for finish in ('normal', 'reverse')]
    rec = {**record(*bare), 'pricing': card}
    for variant, key in zip(bare, ('normal', 'reverse-holofoil')):
        descriptor = tcgdex_record.source_descriptor(variant)
        lookup = edition_metadata(rec, descriptor, False)['mapping_candidate']['candidate']
        problem, products = MatchingRulesV3.products(MatchingRulesV3.narrow(lookup, MatchingRulesV3.finish_key(descriptor)))
        assert (problem, products) == (None, {key: 219333})
        quote = select(rec, descriptor=descriptor, lookup={'card': 'swsh3-136', 'variant': key})
        assert quote.amount == card['tcgplayer'][key]['marketPrice']


def test_third_party_conflict_fails():
    for listed, expected in ((1, Failure('lookup_drift')), (219333, None)):
        third = {'tcgplayer': listed}
        result = select(record(entry(thirdParty=third)), descriptor={**DESCRIPTOR, 'thirdParty': third})
        assert result == expected if expected else isinstance(result, Quote)


def test_select_quote_does_not_mutate_inputs():
    rec, lookup, descriptor = record(), dict(LOOKUP), dict(DESCRIPTOR)
    before = copy.deepcopy((rec, lookup, descriptor))
    select_quote(rec, descriptor, lookup, '219333')
    assert (rec, lookup, descriptor) == before


def test_failure_reasons_are_contract_reasons():
    from app.quote_contract import EDITION_BACKOFF_REASONS
    for reason in ('malformed', 'ambiguous', 'lookup_drift', *price_source.REASONS):
        assert reason in EDITION_BACKOFF_REASONS


def test_end_to_end_fetch_then_select(fake):
    body = json.dumps(record()).replace('"0.25"', '0.25').encode()
    fake.script = [respond(200, body)]
    result = price_source.fetch('swsh3-136')
    assert select(result.record) == Quote(amount='0.25', card='swsh3-136', variant='normal',
                                          provider_updated_at='2026-10-07T22:55:02Z')
