"""Shared-record adapter conformance at the agreed storage seam."""
import time

from app.public_records import FilePublicRecords


def deadline():
    return time.monotonic() + 3


def test_atomic_record_versions_and_publication_independence(tmp_path):
    store = FilePublicRecords(tmp_path)
    store.initialize(deadline=deadline())
    initial = store.read_records(['catalog:one', 'result:one'], deadline=deadline())
    assert store.compare_and_swap(
        {key: record.version for key, record in initial.records.items()},
        {'catalog:one': {'revision': 1}, 'result:one': {'state': 'absent'}},
        deadline=deadline(),
    )
    assert not store.compare_and_swap(
        {'catalog:one': initial.records['catalog:one'].version},
        {'catalog:one': {'revision': 2}}, deadline=deadline(),
    )
    current = store.read_records(['catalog:one', 'result:one'], deadline=deadline())
    assert current.records['catalog:one'].value == {'revision': 1}
    assert current.records['result:one'].value == {'state': 'absent'}

import multiprocessing
import os
import pytest
from app.public_projection import ProjectionUnavailable, FilePublicProjection
from public_records_fixture import store_from_config, race_writer, fault_writer, serve_relay


@pytest.fixture(params=['filesystem', 'http'])
def adapter(request, tmp_path):
    config = {'adapter': request.param, 'directory': str(tmp_path), 'max_entries': 2, 'max_bytes': 1024}
    backend = FilePublicRecords(tmp_path, max_entries=2, max_bytes=1024)
    backend.initialize(deadline=deadline())
    process = None
    if request.param == 'http':
        context = multiprocessing.get_context('spawn')
        receive, send = context.Pipe(duplex=False)
        process = context.Process(target=serve_relay, args=(config, send))
        process.start()
        assert receive.poll(5)
        config['url'] = f'http://127.0.0.1:{receive.recv()}/manifest'
        receive.close()
    yield store_from_config(config), config
    if process:
        process.terminate(); process.join(5)
        assert not process.is_alive()


def write(store, changes, operation_id=None):
    prior = store.read_records(changes, deadline=deadline())
    assert store.compare_and_swap({key: row.version for key, row in prior.records.items()}, changes,
        deadline=deadline(), operation_id=operation_id)


def test_independent_processes_have_one_cas_winner(adapter):
    store, config = adapter
    write(store, {'admission:global': {'active': 0}})
    version = store.read_records(['admission:global'], deadline=deadline()).records['admission:global'].version
    context = multiprocessing.get_context('spawn')
    barrier = context.Barrier(2)
    output = context.Queue()
    processes = [context.Process(target=race_writer, args=(config, 'admission:global', version, barrier, output)) for _ in range(2)]
    for process in processes:
        process.start()
    for process in processes:
        process.join(7)
        assert process.exitcode == 0
    assert sorted([output.get(timeout=1), output.get(timeout=1)]) == [False, True]
    assert store.read_records(['admission:global'], deadline=deadline()).records['admission:global'].value['winner'] in [process.pid for process in processes]


def test_versions_prevent_delete_recreate_aba_and_transaction_is_atomic(adapter):
    store, _ = adapter
    write(store, {'fence:a': {'owner': 'first'}, 'fence:b': {'owner': 'first'}})
    first = store.read_records(['fence:a', 'fence:b'], deadline=deadline())
    write(store, {'fence:a': None})
    write(store, {'fence:a': {'owner': 'first'}})
    assert not store.compare_and_swap({key: row.version for key, row in first.records.items()},
        {'fence:a': {'owner': 'stale'}, 'fence:b': {'owner': 'stale'}}, deadline=deadline())
    assert store.read_records(['fence:a', 'fence:b'], deadline=deadline()).records['fence:b'].value == {'owner': 'first'}


def test_protected_absence_survives_full_payload_capacity(adapter):
    store, _ = adapter
    write(store, {'result:edition': {'state': 'quote'}, 'quote:edition': {'amount': '5.00'}})
    write(store, {'quote:other': {'amount': '6.00'}, 'quote:new': {'amount': '7.00'}})
    assert store.read_records(['quote:edition'], deadline=deadline()).records['quote:edition'].value is None
    write(store, {'result:edition': {'state': 'pending', 'fence': 3}})
    write(store, {'result:edition': {'state': 'absent', 'expires_at': '2099-01-01'}, 'quote:edition': None})
    write(store, {'quote:fourth': {'amount': '8.00'}, 'catalog:edition': {'quarantined': True}})
    current = store.read_records(['result:edition', 'quote:edition', 'catalog:edition'], deadline=deadline())
    assert current.records['result:edition'].value == {'state': 'absent', 'expires_at': '2099-01-01'}
    assert current.records['quote:edition'].value is None
    assert current.records['catalog:edition'].value == {'quarantined': True}


def test_byte_capacity_eviction_never_falls_back_and_protected_state_is_independent(adapter):
    store, _ = adapter
    write(store, {'catalog:edition': {'evidence': 'x' * 1400}, 'result:edition': {'state': 'absent'}})
    write(store, {'quote:edition': {'amount': '4.00'}})
    write(store, {'quote:edition': {'oversized': 'x' * 1100}})
    current = store.read_records(['catalog:edition', 'result:edition', 'quote:edition'], deadline=deadline())
    assert current.records['quote:edition'].value is None
    assert current.records['result:edition'].value == {'state': 'absent'}
    assert len(current.records['catalog:edition'].value['evidence']) == 1400


def test_batches_pin_complete_generation_and_enforce_limit(adapter):
    store, _ = adapter
    for offset in range(0, 260, 128):
        write(store, {f'catalog:{index}': {'number': index} for index in range(offset, min(offset + 128, 260))})
    snapshot = store.read_records(['catalog:0'], deadline=deadline())
    write(store, {'catalog:129': {'number': -1}})
    pinned = store.read_records(['catalog:129'], generation=snapshot.generation, deadline=deadline())
    assert pinned.records['catalog:129'].value == {'number': 129}
    complete = store.read_all([f'catalog:{index}' for index in range(260)], deadline=deadline())
    assert len(complete.records) == 260
    assert complete.records['catalog:259'].value == {'number': 259}
    assert complete.records['catalog:129'].value == {'number': -1}
    with pytest.raises(ValueError):
        store.read_records([f'catalog:{index}' for index in range(129)], deadline=deadline())


def test_operation_id_is_durable_and_replays_do_not_overwrite(adapter):
    store, config = adapter
    old = store.read_records(['result:edition'], deadline=deadline())
    expected = {'result:edition': old.records['result:edition'].version}
    changes = {'result:edition': {'state': 'absent'}}
    assert store.compare_and_swap(expected, changes, deadline=deadline(), operation_id='absence-once')
    write(store, {'result:edition': {'state': 'pending', 'fence': 2}})
    reconnected = store_from_config(config)
    assert reconnected.operation_status('absence-once', deadline=deadline()) is True
    assert reconnected.compare_and_swap(expected, changes, deadline=deadline(), operation_id='absence-once')
    assert reconnected.read_records(['result:edition'], deadline=deadline()).records['result:edition'].value == {'state': 'pending', 'fence': 2}


def test_http_lost_response_can_resolve_commit_without_reapplying(adapter):
    store, config = adapter
    if config['adapter'] != 'http':
        pytest.skip('HTTP lost-response transport case')
    old = store.read_records(['result:edition'], deadline=deadline())
    with pytest.raises(ProjectionUnavailable):
        store.compare_and_swap({'result:edition': old.records['result:edition'].version},
            {'result:edition': {'state': 'absent'}}, deadline=deadline(), operation_id='lost-response')
    assert store.operation_status('lost-response', deadline=deadline()) is True
    assert store.read_records(['result:edition'], deadline=deadline()).records['result:edition'].value == {'state': 'absent'}


def test_expired_deadline_fails_closed(adapter):
    store, _ = adapter
    with pytest.raises(ProjectionUnavailable):
        store.read_records(['catalog:a'], deadline=time.monotonic() - .1)
    with pytest.raises(ProjectionUnavailable):
        store.compare_and_swap({'catalog:a': 'missing'}, {'catalog:a': {}}, deadline=time.monotonic() - .1)


@pytest.mark.parametrize('phase', ['before', 'after'])
def test_process_crash_keeps_pending_or_committed_absence_never_old_result(adapter, phase):
    store, config = adapter
    write(store, {'quote:edition': {'amount': '5.00'}, 'result:edition': {'state': 'pending', 'fence': 2}})
    context = multiprocessing.get_context('spawn')
    reached = context.Event()
    if config['adapter'] == 'filesystem':
        process = context.Process(target=fault_writer, args=(config, phase, reached))
        process.start()
    else:
        receive, send = context.Pipe(duplex=False)
        process = context.Process(target=serve_relay, args=(config, send, phase, reached))
        process.start()
        assert receive.poll(5)
        crash_config = {**config, 'url': f'http://127.0.0.1:{receive.recv()}/manifest'}
        receive.close()
        # Submit from a separate process so the test can kill the relay in flight.
        writer_event = context.Event()
        writer = context.Process(target=fault_writer, args=(crash_config, 'none', writer_event))
        writer.start()
    try:
        assert reached.wait(5)
    finally:
        process.kill(); process.join(5)
        if config['adapter'] == 'http':
            writer.join(5)
            if writer.is_alive():
                writer.kill(); writer.join(5)
    recovered = store.read_records(['result:edition', 'quote:edition'], deadline=deadline())
    assert recovered.records['result:edition'].value['state'] == ('pending' if phase == 'before' else 'absent')
    if phase == 'after':
        assert recovered.records['quote:edition'].value is None
        assert store.operation_status('terminal-absence', deadline=deadline()) is True


def test_corrupt_authoritative_pointer_never_falls_back(adapter):
    store, config = adapter
    write(store, {'result:edition': {'state': 'absent'}})
    from pathlib import Path
    (Path(config['directory']) / 'records' / 'current.json').write_text('{}')
    with pytest.raises(ProjectionUnavailable):
        store.read_records(['result:edition'], deadline=deadline())


def test_record_work_does_not_advance_publication_revision(tmp_path, monkeypatch):
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path))
    publication = FilePublicProjection()
    with publication.writer(initialize=True):
        publication.apply('public-token', {'title': 'Frozen', 'version': 1})
    before = publication.read_state()
    records = FilePublicRecords(tmp_path)
    records.initialize(deadline=deadline())
    write(records, {'result:edition': {'state': 'absent'}, 'admission:global': {'active': 2}})
    assert publication.read_state() == before


def test_active_generation_remains_pinned_through_many_concurrent_commits(adapter):
    store, _ = adapter
    write(store, {'catalog:edition': {'revision': 1}})
    pinned = store.read_records(['catalog:edition'], deadline=deadline())
    for revision in range(2, 14):
        write(store, {'catalog:edition': {'revision': revision}})
    assert store.read_records(['catalog:edition'], generation=pinned.generation, deadline=deadline()).records['catalog:edition'].value == {'revision': 1}


def test_payload_eviction_fails_closed_for_older_pinned_generation(adapter):
    store, _ = adapter
    write(store, {'quote:edition': {'amount': '4.00'}})
    pinned = store.read_records(['quote:edition'], deadline=deadline())
    write(store, {'quote:next': {'amount': '5.00'}, 'quote:last': {'amount': '6.00'}})
    with pytest.raises(ProjectionUnavailable):
        store.read_records(['quote:edition'], generation=pinned.generation, deadline=deadline())


def test_pinned_generation_corruption_is_unavailable(adapter):
    store, config = adapter
    write(store, {'result:edition': {'state': 'pending'}})
    pinned = store.read_records(['result:edition'], deadline=deadline())
    write(store, {'result:edition': {'state': 'absent'}})
    from pathlib import Path
    path = Path(config['directory']) / 'records' / f'generation-{pinned.generation}.json'
    path.write_text(path.read_text().replace('"format":1', '"format":0'))
    with pytest.raises(ProjectionUnavailable):
        store.read_records(['result:edition'], generation=pinned.generation, deadline=deadline())


def test_http_total_deadline_cuts_off_trickling_response(adapter):
    store, config = adapter
    if config['adapter'] != 'http':
        pytest.skip('HTTP streaming deadline case')
    from pathlib import Path
    (Path(config['directory']) / 'slow-relay').touch()
    started = time.monotonic()
    with pytest.raises(ProjectionUnavailable):
        store.read_records(['catalog:edition'], deadline=started + .06)
    assert time.monotonic() - started < .12
