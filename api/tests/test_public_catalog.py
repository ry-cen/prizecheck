"""Trusted DB-to-shared-records writer: public-safe catalog records for opaque references."""
from timing_support import within_budget
import json
import os
import time
from pathlib import Path

import pytest

from app.main import connect
from app.public_projection import FilePublicProjection, ProjectionUnavailable, public_record_store
from app.public_records import FilePublicRecords, catalog_edition_key, catalog_format_key, catalog_printing_key
from app.games.pokemon.prices.catalog_targets import LIVE, MATCHING
from app.public_records import quarantine_key
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_search import promote
from test_catalog_targets import activate, card, isolated_rules, metadata, run  # noqa: F401  (isolated_rules is an autouse fixture)
from test_decks import create
from test_holdings import fixture
from test_publications import command, list_cards

PRINTING_KEYS = {'printing_ref', 'name', 'set_id', 'set_name', 'collector_number', 'image_url', 'revision', 'live'}
LIVE_KEYS = {'state', 'reason', 'rule_version', 'identity'}
EDITION_KEYS = {'edition_ref', 'printing_ref', 'descriptor', 'revision', 'marketplace'}
MARKETPLACE_KEYS = {'state', 'reason', 'mapping_revision', 'product_id', 'quote_lookup'}
QUARANTINE_KEYS = {'edition_ref', 'revision', 'mapping_revision', 'state'}
FORMAT_KEYS = {'printing_ref', 'revision', 'set_id', 'collector_number', 'identity', 'reprint_group', 'attributes'}
ATTRIBUTE_KEYS = {'regulation_mark', 'card_kind', 'basic_energy', 'types', 'rule_box', 'ace_spec', 'radiant', 'prism_star',
                  'basic_pokemon'}


@pytest.fixture(autouse=True)
def stores(tmp_path, monkeypatch):
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path))
    with FilePublicProjection().writer(initialize=True):
        pass
    public_record_store().initialize(deadline=time.monotonic() + 5)


def deadline():
    return time.monotonic() + 5


def read(*keys):
    return public_record_store().read_records(list(keys), deadline=deadline()).records


def catalog_rows(conn):
    return conn.execute("""SELECT p.id AS printing_id,p.public_ref AS printing_ref,e.public_ref AS edition_ref,e.descriptor
      FROM catalog_printing p JOIN catalog_edition e ON e.printing_id=p.id ORDER BY p.id,e.descriptor_key""").fetchall()


def test_rebuild_publishes_exact_allowlisted_records_and_is_idempotent():
    from app.games.pokemon.catalog.public_catalog import rebuild
    reset_catalog()
    owner, _, _, _, edition, _ = fixture()
    with connect() as conn:
        row = conn.execute("""SELECT p.id,p.public_ref AS printing_ref,e.public_ref AS edition_ref,pm.public_revision AS printing_revision,
          em.public_revision AS edition_revision,em.mapping_revision,ci.identity_key FROM catalog_edition e
          JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_printing_metadata pm ON pm.printing_id=p.id
          JOIN catalog_identity ci ON ci.id=p.identity_id
          JOIN catalog_edition_metadata em ON em.edition_id=e.id WHERE e.id=%s""", (edition,)).fetchone()
        result = rebuild(conn)
    assert result.written == 2 and result.unchanged == 0
    printing_key, edition_key, quarantine = (catalog_printing_key(row['printing_ref']), catalog_edition_key(row['edition_ref']),
                                             quarantine_key(row['edition_ref']))
    format_key = catalog_format_key(row['printing_ref'])
    records = read(printing_key, edition_key, quarantine, format_key)
    printing, published, held = records[printing_key].value, records[edition_key].value, records[quarantine].value
    facts = records[format_key].value
    # Allowlist: exactly these keys, no internal identifier, owner, source or inventory field.
    assert set(printing) == PRINTING_KEYS and set(printing['live']) == LIVE_KEYS
    assert set(published) == EDITION_KEYS and set(published['marketplace']) == MARKETPLACE_KEYS
    assert set(held) == QUARANTINE_KEYS
    assert set(facts) == FORMAT_KEYS and set(facts['identity']) == {'key', 'name'} and set(facts['attributes']) == ATTRIBUTE_KEYS
    # Format facts: the immutable display set, the Card Identity, the Reprint Group slot and the effective attributes.
    assert facts == {'printing_ref': row['printing_ref'], 'revision': row['printing_revision'], 'set_id': 'base',
                     'collector_number': '25',
                     'identity': {'key': row['identity_key'], 'name': 'Pikachu'}, 'reprint_group': None,
                     'attributes': {'regulation_mark': None, 'card_kind': 'pokemon', 'basic_energy': False,
                                    'types': ['Lightning'], 'rule_box': False, 'ace_spec': False, 'radiant': False,
                                    'prism_star': False, 'basic_pokemon': True}}
    assert printing == {'printing_ref': row['printing_ref'], 'name': 'Pikachu', 'set_id': 'base', 'set_name': 'Base Set',
                        'collector_number': '25', 'image_url': None, 'revision': row['printing_revision'],
                        'live': {'state': 'unsupported', 'reason': 'no_active_rule', 'rule_version': None, 'identity': None}}
    assert published == {'edition_ref': row['edition_ref'], 'printing_ref': row['printing_ref'],
                         'descriptor': {'label': 'Unspecified Variant'}, 'revision': row['edition_revision'],
                         'marketplace': {'state': 'unverified', 'reason': 'unspecified_variant',
                                         'mapping_revision': row['mapping_revision'], 'product_id': None, 'quote_lookup': None}}
    assert held == {'edition_ref': row['edition_ref'], 'revision': row['edition_revision'],
                    'mapping_revision': row['mapping_revision'], 'state': 'clear'}
    serialized = json.dumps(printing) + json.dumps(published) + json.dumps(held) + json.dumps(facts)
    for internal in (str(row['id']), edition, owner):
        assert internal not in serialized
    versions = {key: record.version for key, record in records.items()}
    with connect() as conn:
        again = rebuild(conn)
    assert again.written == 0 and again.unchanged == 2
    assert {key: record.version for key, record in read(*versions).items()} == versions


def test_verified_priced_edition_and_eligible_printing_publish_only_the_reviewed_public_fields():
    from app.games.pokemon.catalog.public_catalog import rebuild
    reset_catalog()
    activate(MATCHING, 1)
    activate(LIVE, 99)
    run(Records(card(1)))
    printing, editions = metadata()
    with connect() as conn:
        rebuild(conn)
        refs = conn.execute("SELECT public_ref FROM catalog_printing WHERE id=%s", (printing['printing_id'],)).fetchone()['public_ref']
        normal = conn.execute("SELECT public_ref FROM catalog_edition WHERE id=%s", (editions['normal']['id'],)).fetchone()['public_ref']
    shown = read(catalog_printing_key(refs), catalog_edition_key(normal), quarantine_key(normal))
    live = shown[catalog_printing_key(refs)].value['live']
    assert live == {'state': 'eligible', 'reason': None, 'rule_version': 99,
                    'identity': {'category': 'Pokemon', 'name': 'Furret', 'set_code': 'DAA', 'number': '1'}}
    market = shown[catalog_edition_key(normal)].value['marketplace']
    assert market == {'state': 'verified', 'reason': None, 'mapping_revision': editions['normal']['mapping_revision'],
                      'product_id': 1001, 'quote_lookup': {'source': 'tcgdex', 'card': 'meta-1', 'variant': 'normal'}}
    assert shown[quarantine_key(normal)].value['state'] == 'clear'
    # Reviewer, evidence, free-text reason, fingerprints and candidates are never published.
    text = json.dumps({key: record.value for key, record in shown.items()})
    for private in ('reviewer', 'evidence', 'https://example.org', 'fingerprint', 'candidate', 'owner-'):
        assert private not in text


def test_quote_lookup_is_public_only_when_verified_and_a_quote_variant_is_set():
    from app.games.pokemon.catalog.public_catalog import rebuild
    reset_catalog()
    activate(MATCHING, 1)
    record = card(1)
    record['variants_detailed'] = [{'type': 'normal', 'size': 'standard', 'variantId': 'n-1',
                                    'pricing': {'tcgplayer': {'unit': 'USD', 'holofoil': {'productId': 55}}}}]
    run(Records(record))
    _, rows = metadata()
    with connect() as conn:
        rebuild(conn)
        ref = conn.execute("SELECT public_ref FROM catalog_edition WHERE id=%s", (rows['normal']['id'],)).fetchone()['public_ref']
    # Product check passed, variant check did not: product-eligible but unpriced.
    market = read(catalog_edition_key(ref))[catalog_edition_key(ref)].value['marketplace']
    assert (market['state'], market['product_id'], market['quote_lookup']) == ('verified', 55, None)


def test_catalog_import_publishes_every_printing_and_edition_after_commit():
    promote({'card-1': 'Pikachu', 'card-2': 'Raichu'})
    with connect() as conn:
        assert conn.execute("SELECT outcome FROM catalog_run").fetchone()['outcome'] == 'succeeded'
        rows = catalog_rows(conn)
    assert len(rows) >= 3
    for row in rows:
        printing_key, edition_key = catalog_printing_key(row['printing_ref']), catalog_edition_key(row['edition_ref'])
        records = read(printing_key, edition_key, quarantine_key(row['edition_ref']))
        printing, edition = records[printing_key].value, records[edition_key].value
        assert set(printing) == PRINTING_KEYS and printing['printing_ref'] == row['printing_ref']
        assert set(edition) == EDITION_KEYS and edition['printing_ref'] == row['printing_ref']
        assert set(records[quarantine_key(row['edition_ref'])].value) == QUARANTINE_KEYS
        assert edition['descriptor'] == row['descriptor'] and edition['edition_ref'] == row['edition_ref']


def test_records_store_failure_does_not_roll_back_import_or_change_publication(monkeypatch):
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    list_cards(owner, deck, {edition: 1})
    assert command(owner, deck).status_code == 200
    current = Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json'
    published = current.read_bytes()

    attempts = []

    def unavailable(*args, **kwargs):
        attempts.append(kwargs)
        raise ProjectionUnavailable()

    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', unavailable)
    promote({'card-1': 'Pikachu'})
    # The post-commit write was really attempted (and failed); the run still succeeded.
    assert attempts
    with connect() as conn:
        assert conn.execute("SELECT outcome FROM catalog_run").fetchone()['outcome'] == 'succeeded'
        state = conn.execute("SELECT active_generation,revision FROM catalog_state").fetchone()
        assert state['active_generation'] is not None and state['revision'] > 0
        assert conn.execute("SELECT count(*) AS n FROM catalog_printing").fetchone()['n'] == 1
    # Snapshot objects, visibility and the discovery revision all live in current.json.
    assert current.read_bytes() == published
    with connect() as conn:  # Nothing was delivered, so the work is still queued for the next drain.
        assert conn.execute("SELECT count(*) AS n FROM catalog_public_outbox WHERE delivered_at IS NULL").fetchone()['n'] >= 2


def test_backfill_recovers_a_missing_record_and_is_idempotent():
    from app.games.pokemon.catalog.public_catalog import backfill
    promote({'card-1': 'Pikachu'})
    with connect() as conn:
        row = catalog_rows(conn)[0]
    key = catalog_edition_key(row['edition_ref'])
    assert public_record_store().compare_and_swap({key: read(key)[key].version}, {key: None}, deadline=deadline())
    assert read(key)[key].value is None
    assert backfill().written == 1
    assert read(key)[key].value['edition_ref'] == row['edition_ref']
    assert backfill().written == 0 and backfill().written == 0


def test_backfill_script_publishes_existing_data_and_refuses_an_uninitialized_store(tmp_path):
    import subprocess
    import sys
    root = Path(__file__).resolve().parents[2]
    _, _, _, _, edition, _ = fixture()
    with connect() as conn:
        row = conn.execute("SELECT p.public_ref AS printing_ref,e.public_ref AS edition_ref FROM catalog_edition e "
                           "JOIN catalog_printing p ON p.id=e.printing_id WHERE e.id=%s", (edition,)).fetchone()
    script = [sys.executable, str(root / 'scripts/backfill_public_catalog.py')]
    empty = tmp_path / 'never-initialized'
    refused = subprocess.run(script, env={**os.environ, 'PUBLIC_PROJECTION_DIR': str(empty)}, capture_output=True, text=True)
    assert refused.returncode == 1 and 'Traceback' not in refused.stderr and not empty.exists()
    done = subprocess.run(script, env=os.environ, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    assert 'rebuilt' in done.stdout and 'recovery conflicts' in done.stdout
    key = catalog_edition_key(row['edition_ref'])
    assert read(key)[key].value['printing_ref'] == row['printing_ref']


def test_catalog_and_quote_record_writes_leave_snapshots_discovery_revision_and_cursor_unchanged():
    from app.core.publications.discovery import cursor_encode
    from app.games.pokemon.catalog.public_catalog import backfill
    from app.public_records import quote_key, result_key
    from test_discovery import visibility
    from test_holdings import client
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    list_cards(owner, deck, {edition: 4})
    token = command(owner, deck).json()['token']
    assert visibility(owner, deck, 'listed').status_code == 200
    projection = Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json'
    before_bytes = projection.read_bytes()
    published = client.get(f'/api/public/decks/{token}')
    page = client.get('/api/public/discovery').json()
    cursor = cursor_encode('', None, page['revision'], [json.loads(before_bytes)['decks'][token]['snapshot']['published_at'], token])
    with connect() as conn:
        row = conn.execute("SELECT e.public_ref AS edition_ref FROM catalog_edition e WHERE e.id=%s", (edition,)).fetchone()
    # Catalog records, a quote payload and its current-result marker all go to the shared store.
    assert backfill().written >= 2
    quote, result = quote_key(row['edition_ref'], 1), result_key(row['edition_ref'], 1)
    versions = {key: record.version for key, record in read(quote, result).items()}
    assert public_record_store().compare_and_swap(
        versions, {quote: {'attempt': 1, 'amount': '1.00'}, result: {'state': 'quote', 'attempt': 1}}, deadline=deadline())
    assert projection.read_bytes() == before_bytes
    assert client.get(f'/api/public/decks/{token}').content == published.content
    assert client.get('/api/public/discovery').json() == page
    assert client.get('/api/public/discovery', params={'cursor': cursor}).status_code == 200


@pytest.mark.timing
@pytest.mark.slow(reason='capacity: a full-scale catalog')
def test_full_catalog_scale_publishes_in_bounded_batches_without_a_whole_run_deadline(monkeypatch):
    from app.games.pokemon.catalog import public_catalog
    cards = {f'card-{index}': f'Card {index}' for index in range(1, 301)}
    calls = []
    original = FilePublicRecords.compare_and_swap

    def counted(self, expected, changes, **kwargs):
        calls.append(len(changes))
        return original(self, expected, changes, **kwargs)

    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', counted)
    started = time.monotonic()
    promote(cards)
    elapsed = time.monotonic() - started
    with connect() as conn:
        # Two records per Printing (catalog and format facts) and two per Edition (catalog and quarantine).
        total = conn.execute("SELECT 2*(SELECT count(*) FROM catalog_printing)+2*(SELECT count(*) FROM catalog_edition) AS n").fetchone()['n']
    assert total >= 900 and sum(calls) == total and max(calls) <= 128
    assert public_catalog.backfill().written == 0
    within_budget(elapsed, 60, 'test_full_catalog_scale_publishes_in_bounded_batches_without_a_whole_run_deadline', unit='s')


# ------------------------------------------------------------------ fail-closed readers sharing one generation


def staged_refs():
    from app.games.pokemon.catalog.public_catalog import drain
    reset_catalog()
    with connect() as conn:
        conn.execute('DELETE FROM tcgplayer_price')  # an earlier test's rows would bind during the import's rebind
    activate(MATCHING, 1)
    activate(LIVE, 99)
    run(Records(card(1)))
    printing, editions = metadata()
    with connect() as conn:
        drain(conn)
        pref = conn.execute('SELECT public_ref FROM catalog_printing WHERE id=%s', (printing['printing_id'],)).fetchone()['public_ref']
        refs = {key: conn.execute('SELECT public_ref FROM catalog_edition WHERE id=%s', (row['id'],)).fetchone()['public_ref']
                for key, row in editions.items()}
    return pref, refs


def swap(changes):
    keys = list(changes)
    records = read(*keys)
    assert public_record_store().compare_and_swap({key: records[key].version for key in keys}, changes, deadline=deadline())


def test_marketplace_and_live_readers_use_one_generation_and_expose_quotes_only_for_verified_priced_editions():
    from app.games.pokemon.catalog.public_catalog import live_states, marketplace_states
    from app.public_records import price_key
    pref, refs = staged_refs()
    normal = refs['normal']
    mapping_revision = read(quarantine_key(normal))[quarantine_key(normal)].value['mapping_revision']
    swap({price_key(normal): {'mapping_revision': mapping_revision, 'product_id': 1001, 'amount': '1.00'}})
    store = public_record_store()
    states = marketplace_states(store, list(refs.values()), deadline())
    market = states[normal]
    assert market.state == 'verified' and market.product_eligible and market.product_id == 1001
    assert market.quote_lookup == {'source': 'tcgdex', 'card': 'meta-1', 'variant': 'normal'}
    assert market.price == {'mapping_revision': mapping_revision, 'product_id': 1001, 'amount': '1.00'}
    assert states[refs['reverse']].price is None  # no price: record for it
    assert {state.generation for state in states.values()} == {market.generation}
    live = live_states(store, [pref], deadline())[pref]
    assert live.eligible and live.identity['set_code'] == 'DAA' and live.rule_version == 99
    # Pinning: later writes are invisible at the earlier generation, so catalog and quote state stay consistent.
    pinned = market.generation
    swap({quarantine_key(normal): {**read(quarantine_key(normal))[quarantine_key(normal)].value, 'state': 'quarantined'}})
    assert marketplace_states(store, [normal], deadline(), generation=pinned)[normal].state == 'verified'
    assert marketplace_states(store, [normal], deadline())[normal].state == 'quarantined'
    assert marketplace_states(store, [], deadline()) == {} and live_states(store, [], deadline()) == {}


def test_a_price_record_is_kept_only_when_exactly_the_allowlist_and_it_agrees_with_the_edition_record(monkeypatch):
    from app.games.pokemon.catalog.public_catalog import marketplace_states
    from app.public_records import price_key
    pref, refs = staged_refs()
    normal = refs['normal']
    store = public_record_store()
    revision = read(quarantine_key(normal))[quarantine_key(normal)].value['mapping_revision']
    good = {'mapping_revision': revision, 'product_id': 1001, 'amount': '1.00'}

    def price(value):
        swap({price_key(normal): value})
        return marketplace_states(store, [normal], deadline())[normal].price

    assert price(good) == good
    for bad in ({**good, 'mapping_revision': revision + 1}, {**good, 'product_id': 1002}, {**good, 'extra': 1},
                {'mapping_revision': revision, 'product_id': 1001}, {**good, 'amount': '1.0000000'}, {**good, 'amount': 1.0},
                {**good, 'amount': '-1'}, {**good, 'amount': '0'}, {**good, 'amount': '0.00'}, {**good, 'mapping_revision': True}, 'x', [], None):
        assert price(bad) is None, bad
    price(good)
    # Quarantined: no price is exposed even though the record remains.
    swap({quarantine_key(normal): {**read(quarantine_key(normal))[quarantine_key(normal)].value, 'state': 'quarantined'}})
    assert marketplace_states(store, [normal], deadline())[normal].price is None
    assert read(price_key(normal))[price_key(normal)].value == good


def test_price_reads_off_reads_no_price_record(monkeypatch):
    from app.games.pokemon.catalog.public_catalog import marketplace_states
    from app.public_records import FilePublicRecords, price_key
    pref, refs = staged_refs()
    normal = refs['normal']
    revision = read(quarantine_key(normal))[quarantine_key(normal)].value['mapping_revision']
    swap({price_key(normal): {'mapping_revision': revision, 'product_id': 1001, 'amount': '1.00'}})
    read_keys, original = [], FilePublicRecords.read_records

    def spy(self, keys, **kwargs):
        read_keys.extend(keys)
        return original(self, keys, **kwargs)
    monkeypatch.setattr(FilePublicRecords, 'read_records', spy)
    monkeypatch.setenv('PRICE_READS', 'off')
    state = marketplace_states(public_record_store(), [normal], deadline())[normal]
    assert state.state == 'verified' and state.product_eligible and state.price is None
    assert read_keys and not [key for key in read_keys if key.startswith('price:')]


def test_readers_fail_closed_on_missing_malformed_or_inconsistent_records():
    from app.games.pokemon.catalog.public_catalog import live_states, marketplace_states
    pref, refs = staged_refs()
    normal, reverse = refs['normal'], refs['reverse']
    store = public_record_store()
    key, held = catalog_edition_key(normal), quarantine_key(normal)
    original = read(key, held)
    good, hold = original[key].value, original[held].value

    def state(edition=good, quarantine=hold):
        swap({key: edition, held: quarantine})
        return marketplace_states(store, [normal], deadline())[normal]

    assert state().state == 'verified'
    mismatches = [
        (good, {**hold, 'revision': hold['revision'] + 1}),
        (good, {**hold, 'mapping_revision': hold['mapping_revision'] + 1}),
        ({**good, 'marketplace': {**good['marketplace'], 'mapping_revision': 99}}, hold),
        ({**good, 'edition_ref': 'f' * 48}, hold),
        ({k: v for k, v in good.items() if k != 'marketplace'}, hold),
        ({**good, 'extra': 1}, hold),
        ({**good, 'marketplace': {**good['marketplace'], 'product_id': '1001'}}, hold),
        ({**good, 'marketplace': {**good['marketplace'], 'state': 'bogus'}}, hold),
        ({**good, 'marketplace': {**good['marketplace'], 'product_id': None}}, hold),
        ({**good, 'marketplace': {**good['marketplace'], 'reason': 7}}, hold),
        ('not a record', hold), (good, ['not', 'a', 'record']), (good, {**hold, 'state': 'bogus'}),
    ]
    for edition, quarantine in mismatches:
        result = state(edition, quarantine)
        assert result.state == 'unknown' and not result.product_eligible, (edition, quarantine)
    assert state(good, {**hold, 'state': 'quarantined'}).state == 'quarantined'
    quarantined = state({**good, 'marketplace': {**good['marketplace'], 'state': 'quarantined', 'reason': 'candidate_changed',
                                                'product_id': None, 'quote_lookup': None}}, {**hold, 'state': 'quarantined'})
    assert (quarantined.state, quarantined.reason, quarantined.product_id) == ('quarantined', 'candidate_changed', None)
    swap({key: None, held: None})
    assert marketplace_states(store, [normal], deadline())[normal].state == 'unknown'  # missing records
    swap({key: good, held: hold})
    assert marketplace_states(store, [normal], deadline())[normal].state == 'verified'
    # A different Edition of the same Printing is judged on its own records only.
    assert marketplace_states(store, [reverse], deadline())[reverse].state == 'verified'
    # Live: per Printing, fail closed on shape, independent of any Edition.
    pkey = catalog_printing_key(pref)
    published = read(pkey)[pkey].value
    assert live_states(store, [pref], deadline())[pref].eligible
    for broken in ({**published, 'live': {**published['live'], 'identity': None}},
                   {**published, 'live': {**published['live'], 'state': 'maybe'}},
                   {**published, 'live': {**published['live'], 'identity': {'name': 'x'}}},
                   {**published, 'live': {**published['live'], 'reason': 7}},
                   {**published, 'live': {**published['live'], 'rule_version': '99'}},
                   {**published, 'live': {**published['live'], 'rule_version': 0}},
                   {**published, 'revision': -1}, {**published, 'printing_ref': 'e' * 48}, {**published, 'live': 'eligible'}):
        swap({pkey: broken})
        assert live_states(store, [pref], deadline())[pref].state == 'unknown'
    swap({pkey: {**published, 'live': {**published['live'], 'state': 'suspended', 'reason': 'source_changed', 'identity': None}}})
    suspended = live_states(store, [pref], deadline())[pref]
    assert (suspended.state, suspended.reason, suspended.eligible) == ('suspended', 'source_changed', False)


# ------------------------------------------------------------------ format facts (Deck Lists 18)


def printing_state(source_id='meta-1'):
    with connect() as conn:
        return conn.execute("""SELECT p.id,p.public_ref,m.public_revision FROM catalog_printing p
          JOIN catalog_printing_metadata m ON m.printing_id=p.id WHERE p.source_id=%s""", (source_id,)).fetchone()


def printing_outbox(printing_id):
    with connect() as conn:
        return [row['revision'] for row in conn.execute("""SELECT revision FROM catalog_public_outbox
          WHERE target_kind='printing' AND target_id=%s ORDER BY revision""", (printing_id,))]


def test_format_facts_are_restamped_only_when_a_published_fact_changes():
    from app.games.pokemon.catalog.public_catalog import drain
    reset_catalog()
    run(Records(card(1)))
    with connect() as conn:
        drain(conn)
    before = printing_state()
    key = catalog_format_key(before['public_ref'])
    assert read(key)[key].value['attributes']['regulation_mark'] is None
    # A rules-version-only rewrite of the derived row changes no fact: no stamp, nothing enqueued.
    with connect() as conn, conn.transaction():
        conn.execute("SELECT catalog_begin_correction()")
        conn.execute("UPDATE catalog_derived_attribute SET rules_version=rules_version+1 WHERE printing_id=%s", (before['id'],))
    assert printing_state()['public_revision'] == before['public_revision']
    assert printing_outbox(before['id']) == [revision for revision in printing_outbox(before['id'])
                                            if revision <= before['public_revision']]
    # A derived value change and an identity rename each re-stamp the Printing once and are delivered. (Corrections
    # need a decision row; the HTTP decision path in test_published_format_checks covers them.)
    changes = (
        ("UPDATE catalog_derived_attribute SET regulation_mark='H' WHERE printing_id=%s", ('attributes', 'regulation_mark'), 'H'),
        ("UPDATE catalog_identity SET display_name='Furret Renamed' WHERE id=(SELECT identity_id FROM catalog_printing WHERE id=%s)",
         ('identity', 'name'), 'Furret Renamed'),
    )
    for statement, path, expected in changes:
        stamped = printing_state()['public_revision']
        with connect() as conn, conn.transaction():
            conn.execute("SELECT catalog_begin_correction()")
            conn.execute(statement, (before['id'],))
        after = printing_state()['public_revision']
        assert after > stamped and printing_outbox(before['id'])[-1] == after
        with connect() as conn:
            drain(conn)
        value = read(key)[key].value
        assert value['revision'] == after and value[path[0]][path[1]] == expected
        printing = read(catalog_printing_key(before['public_ref']))[catalog_printing_key(before['public_ref'])].value
        assert printing['revision'] == after and printing['live']['state'] == 'unsupported'


def test_backfill_publishes_format_facts_into_a_store_written_before_them():
    from app.games.pokemon.catalog.public_catalog import rebuild
    reset_catalog()
    fixture()
    with connect() as conn:
        rebuild(conn)
        refs = [row['public_ref'] for row in conn.execute('SELECT public_ref FROM catalog_printing')]
        edition_keys = [key for row in catalog_rows(conn) for key in (catalog_edition_key(row['edition_ref']),
                                                                       quarantine_key(row['edition_ref']))]
    # The store a release before Deck Lists 18 wrote: catalog records, no format facts.
    format_keys = [catalog_format_key(ref) for ref in refs]
    current = read(*format_keys)
    assert public_record_store().compare_and_swap({key: current[key].version for key in format_keys},
                                                  {key: None for key in format_keys}, deadline=deadline())
    printing_keys = [catalog_printing_key(ref) for ref in refs]
    printings = {key: record.value for key, record in read(*printing_keys).items()}
    editions = {key: record.version for key, record in read(*edition_keys).items()}
    with connect() as conn:
        result = rebuild(conn)
    assert (result.conflicts, result.written) == (0, len(refs))
    assert all(record.value['printing_ref'] == ref for ref, record in zip(refs, read(*format_keys).values()))
    assert {key: record.value for key, record in read(*printing_keys).items()} == printings  # Live state unchanged
    assert {key: record.version for key, record in read(*edition_keys).items()} == editions  # Editions untouched
    with connect() as conn:
        assert rebuild(conn).written == 0


def test_a_format_record_that_differs_at_the_same_revision_is_rewritten_not_stuck():
    from app.games.pokemon.catalog.public_catalog import drain
    reset_catalog()
    fixture()
    with connect() as conn:
        drain(conn)
    with connect() as conn:
        state = conn.execute("SELECT id,public_ref FROM catalog_printing").fetchone()
    key = catalog_format_key(state['public_ref'])
    good = read(key)[key]
    drifted = {**good.value, 'attributes': {**good.value['attributes'], 'regulation_mark': 'Z'}}
    assert public_record_store().compare_and_swap({key: good.version}, {key: drifted}, deadline=deadline())
    with connect() as conn:
        conn.execute("UPDATE catalog_public_outbox SET delivered_at=NULL WHERE target_kind='printing' AND target_id=%s",
                     (state['id'],))
        conn.commit()
        drain(conn)
        stuck = conn.execute("""SELECT count(*) AS n FROM catalog_public_outbox WHERE delivered_at IS NULL
          OR last_error IN ('RevisionValueMismatch','StoreAhead')""").fetchone()['n']
    assert stuck == 0 and read(key)[key].value == good.value


def test_format_facts_reader_fails_closed_on_missing_or_malformed_records():
    from app.games.pokemon.catalog.public_catalog import FormatFacts, format_facts
    pref, _ = staged_refs()
    store = public_record_store()
    key = catalog_format_key(pref)
    good = read(key)[key].value
    facts = format_facts(store, [pref], deadline())[pref]
    assert isinstance(facts, FormatFacts) and facts.identity_name == good['identity']['name']
    assert facts.identity_key == good['identity']['key'] and facts.set_id == good['set_id']
    assert facts.collector_number == good['collector_number']
    assert format_facts(store, [], deadline()) == {}
    attributes = good['attributes']
    for broken in (None, 'not a record', {**good, 'extra': 1}, {k: v for k, v in good.items() if k != 'set_id'},
                   {**good, 'printing_ref': 'e' * 48}, {**good, 'revision': -1}, {**good, 'revision': '3'},
                   {**good, 'reprint_group': 'a' * 48}, {**good, 'set_id': ''}, {**good, 'set_id': 7},
                   {**good, 'collector_number': ''}, {k: v for k, v in good.items() if k != 'collector_number'},
                   {**good, 'identity': {'key': 'Furret'}}, {**good, 'identity': {'key': '', 'name': 'Furret'}},
                   {**good, 'attributes': {**attributes, 'regulation_mark': 'h'}},
                   {**good, 'attributes': {**attributes, 'regulation_mark': 'HH'}},
                   {**good, 'attributes': {**attributes, 'card_kind': 'item'}},
                   {**good, 'attributes': {**attributes, 'basic_energy': 'false'}},
                   {**good, 'attributes': {**attributes, 'rule_box': 0}},
                   {**good, 'attributes': {**attributes, 'types': ['Fire', 'Fire']}},
                   {**good, 'attributes': {**attributes, 'types': ['Fairy Energy']}},
                   {**good, 'attributes': {**attributes, 'types': 'Fire'}},
                   {**good, 'attributes': {k: v for k, v in attributes.items() if k != 'radiant'}}):
        swap({key: broken})
        assert format_facts(store, [pref], deadline())[pref] is None, broken
    # A Reprint Group: a well-formed reference and a sorted list of distinct printing references.
    group = {'ref': 'c' * 48, 'printings': sorted([pref, 'd' * 48])}
    swap({key: {**good, 'reprint_group': group}})
    grouped = format_facts(store, [pref], deadline())[pref]
    assert (grouped.reprint_group, grouped.reprint_printings) == ('c' * 48, tuple(group['printings']))
    assert (facts.reprint_group, facts.reprint_printings) == (None, ())
    for broken in ({'ref': 'c' * 48}, {**group, 'extra': 1}, {**group, 'ref': 'C' * 48}, {**group, 'ref': 'c' * 47},
                   {**group, 'printings': list(reversed(group['printings']))}, {**group, 'printings': [pref, pref]},
                   {**group, 'printings': ['e' * 49]}, {**group, 'printings': pref}, 'c' * 48,
                   {**group, 'printings': sorted('%048x' % n for n in range(1025))}):
        swap({key: {**good, 'reprint_group': broken}})
        assert format_facts(store, [pref], deadline())[pref] is None, broken
    swap({key: good})
    assert format_facts(store, [pref], deadline())[pref].attributes == facts.attributes


def test_a_reprint_group_longer_than_readers_accept_is_published_with_a_warning(monkeypatch, caplog):
    """The writer publishes every member, but a reader refuses a list over MAX_REPRINT_PRINTINGS and the group's
    printings check as unknown publicly, so the writer logs the group (Deck Lists 19, from #99)."""
    from app.games.pokemon.catalog import public_catalog
    from app.games.pokemon.catalog.card_attributes import ATTRIBUTE_COLUMNS
    monkeypatch.setattr(public_catalog, 'MAX_REPRINT_PRINTINGS', 2)
    row = {'printing_ref': 'a' * 48, 'public_revision': 3, 'format_set_id': 'sv01', 'format_collector_number': '191',
           'identity_key': 'rare-candy', 'identity_name': 'Rare Candy', 'reprint_group_id': 'f' * 32,
           **{column: None for column in ATTRIBUTE_COLUMNS}}
    for count, warned in ((2, False), (3, True)):
        printings = sorted('%048x' % n for n in range(count))
        caplog.clear()
        with caplog.at_level('WARNING', logger='app.games.pokemon.catalog.public_catalog'):
            value = public_catalog.format_value({**row, 'reprint_printings': printings})
        assert value['reprint_group']['printings'] == printings      # published whole either way
        ref = value['reprint_group']['ref']
        warnings = [record.getMessage() for record in caplog.records if record.levelname == 'WARNING']
        assert warnings == ([f'Reprint Group {ref} has 3 printings, more than the 2 a public reader accepts: its '
                             'printings check as unknown on Published Decks'] if warned else []), warnings
        assert (public_catalog._format(row['printing_ref'], value, None) is None) is warned
