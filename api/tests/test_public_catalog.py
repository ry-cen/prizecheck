"""Trusted DB-to-shared-records writer: public-safe catalog records for opaque references."""
import json
import os
import time
from pathlib import Path

import pytest

from app.main import connect
from app.public_projection import FilePublicProjection, ProjectionUnavailable, public_record_store
from app.public_records import FilePublicRecords, catalog_edition_key, catalog_printing_key
from test_catalog_search import promote
from test_decks import create
from test_holdings import add, fixture
from test_publications import command

PRINTING_KEYS = {'printing_ref', 'name', 'set_id', 'set_name', 'collector_number', 'image_url'}
EDITION_KEYS = {'edition_ref', 'printing_ref', 'descriptor'}


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


def test_writer_publishes_exact_allowlisted_records_and_is_idempotent():
    from app.public_catalog import publish_catalog
    owner, _, _, _, edition, _ = fixture()
    with connect() as conn:
        row = conn.execute("""SELECT p.id,p.public_ref AS printing_ref,e.public_ref AS edition_ref FROM catalog_edition e
          JOIN catalog_printing p ON p.id=e.printing_id WHERE e.id=%s""", (edition,)).fetchone()
        result = publish_catalog(conn, printing_ids=[row['id']])
    assert result.written == 2
    printing_key, edition_key = catalog_printing_key(row['printing_ref']), catalog_edition_key(row['edition_ref'])
    records = read(printing_key, edition_key)
    printing, published = records[printing_key].value, records[edition_key].value
    # Allowlist: exactly these keys, no internal identifier, owner, source or inventory field.
    assert set(printing) == PRINTING_KEYS and set(published) == EDITION_KEYS
    assert printing == {'printing_ref': row['printing_ref'], 'name': 'Pikachu', 'set_id': 'base', 'set_name': 'Base Set',
                        'collector_number': '25', 'image_url': None}
    assert published == {'edition_ref': row['edition_ref'], 'printing_ref': row['printing_ref'],
                         'descriptor': {'label': 'Unspecified Variant'}}
    serialized = json.dumps(printing) + json.dumps(published)
    for internal in (str(row['id']), edition, owner):
        assert internal not in serialized
    versions = {key: record.version for key, record in records.items()}
    with connect() as conn:
        again = publish_catalog(conn, printing_ids=[row['id']])
    assert again.written == 0 and again.unchanged == 2
    assert {key: record.version for key, record in read(*versions).items()} == versions


def test_catalog_import_publishes_every_printing_and_edition_after_commit():
    promote({'card-1': 'Pikachu', 'card-2': 'Raichu'})
    with connect() as conn:
        assert conn.execute("SELECT outcome FROM catalog_run").fetchone()['outcome'] == 'succeeded'
        rows = catalog_rows(conn)
    assert len(rows) >= 3
    for row in rows:
        printing_key, edition_key = catalog_printing_key(row['printing_ref']), catalog_edition_key(row['edition_ref'])
        records = read(printing_key, edition_key)
        printing, edition = records[printing_key].value, records[edition_key].value
        assert set(printing) == PRINTING_KEYS and printing['printing_ref'] == row['printing_ref']
        assert set(edition) == EDITION_KEYS and edition['printing_ref'] == row['printing_ref']
        assert edition['descriptor'] == row['descriptor'] and edition['edition_ref'] == row['edition_ref']


def test_records_store_failure_does_not_roll_back_import_or_change_publication(monkeypatch):
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    add(owner, deck, edition, '1')
    assert command(owner, deck).status_code == 200
    current = Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json'
    published = current.read_bytes()

    def unavailable(*args, **kwargs):
        raise ProjectionUnavailable()

    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', unavailable)
    promote({'card-1': 'Pikachu'})
    with connect() as conn:
        assert conn.execute("SELECT outcome FROM catalog_run").fetchone()['outcome'] == 'succeeded'
        state = conn.execute("SELECT active_generation,revision FROM catalog_state").fetchone()
        assert state['active_generation'] is not None and state['revision'] > 0
        assert conn.execute("SELECT count(*) AS n FROM catalog_printing").fetchone()['n'] == 1
    # Snapshot objects, visibility and the discovery revision all live in current.json.
    assert current.read_bytes() == published


def test_backfill_recovers_a_missing_record_and_is_idempotent():
    from app.public_catalog import backfill
    promote({'card-1': 'Pikachu'})
    with connect() as conn:
        row = catalog_rows(conn)[0]
    key = catalog_edition_key(row['edition_ref'])
    assert public_record_store().compare_and_swap({key: read(key)[key].version}, {key: None}, deadline=deadline())
    assert read(key)[key].value is None
    assert backfill().written == 1
    assert read(key)[key].value['edition_ref'] == row['edition_ref']
    assert backfill().written == 0


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
    key = catalog_edition_key(row['edition_ref'])
    assert read(key)[key].value['printing_ref'] == row['printing_ref']


def test_catalog_and_quote_record_writes_leave_snapshots_discovery_revision_and_cursor_unchanged():
    from app.discovery import cursor_encode
    from app.public_catalog import backfill
    from app.public_records import quote_key, result_key
    from test_discovery import visibility
    from test_holdings import client
    owner, _, _, _, edition, _ = fixture()
    deck = create(owner).json()['location']['id']
    add(owner, deck, edition, '4')
    token = command(owner, deck).json()['token']
    assert visibility(owner, deck, 'listed').status_code == 200
    projection = Path(os.environ['PUBLIC_PROJECTION_DIR']) / 'current.json'
    before_bytes = projection.read_bytes()
    published = client.get(f'/api/public/decks/{token}')
    page = client.get('/api/public/discovery').json()
    cursor = cursor_encode('', page['revision'], [json.loads(before_bytes)['decks'][token]['snapshot']['published_at'], token])
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
