"""scripts/purge_price_records.py and the record store's treatment of retired families (ADR 0019, #356).

Every test runs against a synthetic store in its own temp directory. The retired keys are written the way production
wrote them: with the seven families registered again for the seeding only (``legacy_families``)."""
import importlib.util
from pathlib import Path
import re
import time

import pytest

from app import public_records as records
from app.public_projection import ProjectionUnavailable
from app.public_records import FilePublicRecords, catalog_edition_key, invite_key, price_key, quarantine_key

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'purge_price_records.py'
spec = importlib.util.spec_from_file_location('purge_price_records', SCRIPT)
purge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(purge)

REF = 'a' * 48
OTHER = 'b' * 48
RETIRED = {
    'quote': [f'quote:{REF}:1', f'quote:{OTHER}:2'],
    'result': [f'result:{REF}:1'],
    'fence': [f'fence:{REF}:1'],
    'work': [f'work:{REF}:1'],
    'admission': ['admission:price:scheduler', 'admission:price:ledger:3'],
    'lease': ['lease:price:runner:0'],
    'backoff': ['backoff:price:source', f'backoff:price:edition:{REF}.1'],
}
LIVE = {catalog_edition_key(REF): {'name': 'Furret'}, price_key(REF): {'amount': '0.25', 'mapping_revision': 1},
        quarantine_key(OTHER): {'state': 'quarantined'}, invite_key('c' * 64): {'display_name': 'Ash'}}


def deadline():
    return time.monotonic() + 5


@pytest.fixture
def legacy_families(monkeypatch):
    """Registers the retired families again (quote evictable, as it was) until ``done()`` is called."""
    saved = records._FAMILIES
    retired = tuple((name, pattern, name == 'quote') for name, pattern in purge.FAMILIES)

    def done():
        monkeypatch.setattr(records, '_FAMILIES', saved)
    monkeypatch.setattr(records, '_FAMILIES', saved + retired)
    return done


def write(store, changes):
    current = store.read_records(list(changes), deadline=deadline()).records
    assert store.compare_and_swap({key: row.version for key, row in current.items()}, changes, deadline=deadline())


@pytest.fixture
def seeded(tmp_path, legacy_families):
    store = FilePublicRecords(tmp_path)
    store.initialize(deadline=deadline())
    write(store, LIVE)
    write(store, {key: {'v': 1} for keys in RETIRED.values() for key in keys})
    legacy_families()
    return store


def run(store, *argv):
    return purge.main(list(argv), store=store)


def test_the_store_no_longer_registers_the_retired_families():
    for keys in RETIRED.values():
        for key in keys:
            with pytest.raises(ValueError):
                records.key_family(key)
    assert all(not evictable for _, _, evictable in records._FAMILIES)


def test_a_store_holding_retired_keys_opens_and_serves_the_live_families(tmp_path, seeded):
    again = FilePublicRecords(tmp_path)
    again.initialize(deadline=deadline())  # idempotent open of an established store
    rows = again.read_all(list(LIVE), deadline=deadline()).records
    assert {key: row.value for key, row in rows.items()} == LIVE
    write(again, {price_key(OTHER): {'amount': '1.00', 'mapping_revision': 2}, price_key(REF): None})
    rows = again.read_records([price_key(REF), price_key(OTHER)], deadline=deadline()).records
    assert rows[price_key(REF)].value is None and rows[price_key(OTHER)].value['amount'] == '1.00'
    with pytest.raises(ValueError):
        again.read_records([RETIRED['quote'][0]], deadline=deadline())  # no live call accepts a retired key


def test_capacity_eviction_still_handles_retired_quote_payloads(tmp_path, legacy_families):
    store = FilePublicRecords(tmp_path, max_entries=1, max_bytes=1024)
    store.initialize(deadline=deadline())
    write(store, {RETIRED['quote'][0]: {'amount': '1.00'}})
    legacy_families()
    write(store, {price_key(REF): {'amount': '0.25', 'mapping_revision': 1}})
    assert set(store.unregistered_records(deadline=deadline())) == {RETIRED['quote'][0]}


def test_dry_run_is_the_default_counts_by_family_and_deletes_nothing(seeded, capsys):
    before = seeded.unregistered_records(deadline=deadline())
    for argv in ((), ('--dry-run',)):
        assert run(seeded, *argv) == 0
        out = capsys.readouterr().out
        for name, keys in RETIRED.items():
            assert re.search(rf'\b{name} {len(keys)}\b', out), out
        assert 'total 10' in out
    assert seeded.unregistered_records(deadline=deadline()) == before


def test_delete_removes_every_retired_key_and_a_rerun_finds_none(seeded, capsys):
    assert run(seeded, '--delete') == 0
    out = capsys.readouterr().out
    assert out.startswith('deleted ') and 'quote 2' in out and 'backoff 2' in out and 'total 10' in out
    assert purge.legacy(seeded) == {}
    assert run(seeded, '--delete') == 0
    assert 'total 0' in capsys.readouterr().out
    assert run(seeded) == 0 and 'total 0' in capsys.readouterr().out
    rows = seeded.read_all(list(LIVE), deadline=deadline()).records
    assert {key: row.value for key, row in rows.items()} == LIVE


def test_deleting_retired_quotes_releases_their_capacity(tmp_path, legacy_families):
    store = FilePublicRecords(tmp_path, max_entries=2, max_bytes=1024)
    store.initialize(deadline=deadline())
    write(store, {RETIRED['quote'][0]: {'amount': '1.00'}, RETIRED['quote'][1]: {'amount': '2.00'}})
    legacy_families()
    assert run(store, '--delete') == 0
    manifest = store._manifest(store._current(deadline()), deadline())
    assert manifest['evictable'] == {'count': 0, 'bytes': 0}


def test_unknown_keys_and_live_families_are_never_counted_or_touched(tmp_path, monkeypatch, capsys):
    stray = 'mystery:thing'
    monkeypatch.setattr(records, '_FAMILIES', records._FAMILIES + (('mystery', re.compile(r'mystery:[a-z]+'), False),))
    store = FilePublicRecords(tmp_path)
    store.initialize(deadline=deadline())
    write(store, {stray: {'keep': True}, **LIVE})
    monkeypatch.undo()
    assert stray in store.unregistered_records(deadline=deadline())
    assert run(store, '--delete') == 0 and 'total 0' in capsys.readouterr().out
    assert store.unregistered_records(deadline=deadline())[stray]
    with pytest.raises(ValueError):
        store.delete_unregistered({price_key(REF): 'x'}, deadline=deadline())  # a live family is refused outright


def test_a_lost_batch_is_reread_and_retried(seeded, monkeypatch, capsys):
    real = seeded.delete_unregistered
    calls = []

    def racing(expected, *, deadline):
        calls.append(len(expected))
        if len(calls) == 1:
            return False  # another writer moved a version: nothing was published
        return real(expected, deadline=deadline)
    monkeypatch.setattr(seeded, 'delete_unregistered', racing)
    assert run(seeded, '--delete') == 0
    assert 'total 10' in capsys.readouterr().out and len(calls) == 2
    assert purge.legacy(seeded) == {}


def test_batches_hold_at_most_128_keys(tmp_path, legacy_families, monkeypatch):
    store = FilePublicRecords(tmp_path)
    store.initialize(deadline=deadline())
    keys = [f'result:{index:048x}:1' for index in range(300)]
    for start in range(0, 300, 100):
        write(store, {key: {'state': 'absent'} for key in keys[start:start + 100]})
    legacy_families()
    sizes = []
    real = store.delete_unregistered
    monkeypatch.setattr(store, 'delete_unregistered', lambda expected, *, deadline: sizes.append(len(expected)) or real(expected, deadline=deadline))
    assert run(store, '--delete') == 0
    assert sizes == [128, 128, 44] and purge.legacy(store) == {}


def test_unresolved_conflicts_exit_2_and_leave_the_keys(seeded, monkeypatch, capsys):
    monkeypatch.setattr(seeded, 'delete_unregistered', lambda expected, *, deadline: False)
    assert run(seeded, '--delete') == 2
    captured = capsys.readouterr()
    assert 'deleted ' in captured.out and 'total 0' in captured.out and 'rerun' in captured.out
    assert len(purge.legacy(seeded)) == 10


def test_a_store_failure_exits_1_with_a_message(seeded, monkeypatch, capsys):
    def down(*args, **kwargs):
        raise ProjectionUnavailable()
    monkeypatch.setattr(seeded, 'unregistered_records', down)
    for argv in ((), ('--delete',)):
        assert run(seeded, *argv) == 1
        assert 'record store is unavailable' in capsys.readouterr().err


def test_a_corrupt_store_fails_closed(tmp_path, seeded, capsys):
    (tmp_path / 'records' / 'current.json').write_text('{"format": 2, "generation": "zz"}')
    assert run(FilePublicRecords(tmp_path), '--delete') == 1
    assert 'record store is unavailable' in capsys.readouterr().err
