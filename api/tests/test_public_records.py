"""Shared-record adapter conformance at the agreed storage seam.

One suite runs against both adapters. Tests assert observable ordering through
the adapter API; private layout knowledge and OS fault injection stay in
public_records_fixture.
"""
from timing_support import within_budget
import multiprocessing
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time

import pytest

from app import public_records as records
from app.public_projection import FilePublicProjection, ProjectionUnavailable
from app.public_records import (
    FilePublicRecords, OperationConflict, admission_key, backoff_key, catalog_edition_key, fence_key,
    lease_key, quote_key, quote_states, result_key,
)
from public_records_fixture import (
    backend_from_config, corrupt_generation, corrupt_pointer, fault, fault_writer, race_writer,
    read_only_storage, scramble_mtimes, serve_relay, stale_writer, store_from_config, store_size,
    write_legacy_store,
)

REF = 'a' * 48
OTHER = 'b' * 48
CRASH_REF = 'c' * 48


def deadline(seconds=3):
    return time.monotonic() + seconds


def ref(index):
    return f'{index:048x}'


def start_relay(config, phase=None, reached=None):
    context = multiprocessing.get_context('spawn')
    receive, send = context.Pipe(duplex=False)
    process = context.Process(target=serve_relay, args=(config, send, phase, reached))
    process.start()
    assert receive.poll(10)
    url = f'http://127.0.0.1:{receive.recv()}/manifest'
    receive.close()
    return process, url


def stop(process):
    process.terminate()
    process.join(5)
    if process.is_alive():
        process.kill()
        process.join(5)


def store_options(**options):
    """Per-test adapter configuration (capacity, TTLs), applied to both adapters."""
    def decorate(function):
        function.store_options = options
        return function
    return decorate


@pytest.fixture(params=['filesystem', 'http'])
def adapter(request, tmp_path):
    config = {'adapter': request.param, 'directory': str(tmp_path), 'max_entries': 2, 'max_bytes': 1024}
    config.update(getattr(request.function, 'store_options', {}))
    backend_from_config(config).initialize(deadline=deadline())
    relays = []
    if request.param == 'http':
        process, config['url'] = start_relay(config)
        relays.append(process)
        # A second, independent relay process over the same shared storage.
        process, config['second_url'] = start_relay(config)
        relays.append(process)
    yield store_from_config(config), config
    for process in relays:
        stop(process)
        assert not process.is_alive()


def write(store, changes, operation_id=None):
    prior = store.read_records(changes, deadline=deadline())
    assert store.compare_and_swap({key: row.version for key, row in prior.records.items()}, changes,
        deadline=deadline(), operation_id=operation_id)


def values(store, keys, **kwargs):
    return {key: row.value for key, row in store.read_records(keys, deadline=deadline(), **kwargs).records.items()}


# --- Typed key families -------------------------------------------------------
def test_catalog_printing_and_edition_keys_are_namespaced_and_protected():
    printing = records.catalog_printing_key(REF)
    edition = records.catalog_edition_key(REF)
    assert printing != edition
    assert records.key_family(printing).name == 'catalog_printing'
    assert records.key_family(edition).name == 'catalog_edition'
    assert not records.key_family(printing).evictable
    assert not records.key_family(edition).evictable
    assert not records.key_family(records.quarantine_key(REF)).evictable
    # Deck Lists 18: a Printing's format facts are their own protected family under the same reference.
    format_key = records.catalog_format_key(REF)
    assert format_key not in (printing, edition)
    assert records.key_family(format_key).name == 'catalog_format' and not records.key_family(format_key).evictable
    with pytest.raises(ValueError):
        records.catalog_format_key('A' * 48)


def test_price_keys_are_one_protected_family_per_edition_without_a_revision():
    key = records.price_key(REF)
    assert key == 'price:' + REF and key != records.price_key(OTHER)
    assert records.key_family(key).name == 'price' and not records.key_family(key).evictable
    for bad in ('A' * 48, 'a' * 47, None, 7):
        with pytest.raises(ValueError):
            records.price_key(bad)
    for bad in ('price:' + REF + ':1', 'price:' + 'A' * 48, 'price:', 'price:scheduler'):
        with pytest.raises(ValueError):
            records.key_family(bad)


def test_price_records_survive_capacity_eviction_and_replace_and_delete_by_version(tmp_path):
    store = FilePublicRecords(tmp_path, max_entries=1, max_bytes=1024)
    store.initialize(deadline=deadline())
    key, value = records.price_key(REF), {'mapping_revision': 1, 'product_id': 5, 'amount': '1.5'}
    write(store, {key: value})
    write(store, {quote_key(REF, 1): {'x': 1}})
    write(store, {quote_key(OTHER, 1): {'x': 2}})  # evictable quotes churn at capacity 1
    assert values(store, [key]) == {key: value}
    write(store, {key: {**value, 'amount': '2'}})
    write(store, {key: None})
    assert values(store, [key]) == {key: None}


def test_quote_keys_are_exact_to_edition_and_mapping_revision_and_only_quotes_are_evictable():
    assert records.quote_key(REF, 1) != records.quote_key(REF, 2)
    assert records.quote_key(REF, 1) != records.quote_key(OTHER, 1)
    assert records.key_family(records.quote_key(REF, 1)).evictable
    for key in (records.result_key(REF, 1), records.fence_key(REF, 1), records.admission_key('global'),
                records.lease_key('runner-1'), records.backoff_key(REF + '.1'), records.work_key(REF, 1)):
        assert not records.key_family(key).evictable
    assert records.key_family(records.work_key(REF, 1)).name == 'work'
    assert records.work_key(REF, 1) != records.work_key(REF, 2)


@pytest.mark.parametrize('bad', ['A' * 48, 'a' * 47, 'a' * 49, 'g' * 48, '', None, 12])
def test_invalid_public_references_are_rejected(bad):
    with pytest.raises(ValueError):
        records.catalog_edition_key(bad)
    with pytest.raises(ValueError):
        records.quote_key(bad, 1)


@pytest.mark.parametrize('revision', [0, -1, True, '1', 1.0, None, 2 ** 63])
def test_invalid_mapping_revisions_are_rejected(revision):
    with pytest.raises(ValueError):
        records.quote_key(REF, revision)
    with pytest.raises(ValueError):
        records.result_key(REF, revision)


@pytest.mark.parametrize('scope', ['', 'has space', 'x' * 201, 'slash/inside', None])
def test_invalid_coordination_scopes_are_rejected(scope):
    with pytest.raises(ValueError):
        records.lease_key(scope)


@pytest.mark.parametrize('key', ['catalog:one', 'payload:x', 'quote:' + REF, 'quote:' + REF + ':0',
                                 'result:' + REF + ':01', 'unknown:' + REF, 'catalog:edition:' + REF + ':1',
                                 'catalog:format:' + REF + ':1', 'catalog:format:' + REF.upper()])
def test_untyped_or_malformed_keys_are_rejected_by_the_store_boundary(key, tmp_path):
    with pytest.raises(ValueError):
        records.key_family(key)
    store = FilePublicRecords(tmp_path)
    store.initialize(deadline=deadline())
    with pytest.raises(ValueError):
        store.read_records([key], deadline=deadline())
    with pytest.raises(ValueError):
        store.compare_and_swap({key: 'v'}, {key: {}}, deadline=deadline())


# --- Conditional commits ------------------------------------------------------
def test_atomic_record_versions_and_publication_independence(adapter):
    store, _ = adapter
    keys = [catalog_edition_key(REF), result_key(REF, 1)]
    initial = store.read_records(keys, deadline=deadline())
    assert store.compare_and_swap(
        {key: record.version for key, record in initial.records.items()},
        {keys[0]: {'revision': 1}, keys[1]: {'state': 'absent'}}, deadline=deadline())
    assert not store.compare_and_swap({keys[0]: initial.records[keys[0]].version},
        {keys[0]: {'revision': 2}}, deadline=deadline())
    assert values(store, keys) == {keys[0]: {'revision': 1}, keys[1]: {'state': 'absent'}}


def test_more_than_two_independent_contenders_have_exactly_one_cas_winner(adapter):
    store, config = adapter
    key = admission_key('global')
    write(store, {key: {'active': 0}})
    version = store.read_records([key], deadline=deadline()).records[key].version
    context = multiprocessing.get_context('spawn')
    barrier = context.Barrier(4)
    output = context.Queue()
    urls = [config.get('url'), config.get('second_url')] * 2
    processes = [context.Process(target=race_writer, args=(config, url, key, version, barrier, output)) for url in urls]
    for process in processes:
        process.start()
    for process in processes:
        process.join(15)
        assert process.exitcode == 0
    assert sorted(output.get(timeout=1) for _ in processes) == [False, False, False, True]
    assert values(store, [key])[key]['winner'] in [process.pid for process in processes]


def test_conditional_commit_failure_through_an_independent_process_or_relay(adapter):
    store, config = adapter
    key = lease_key('runner-1')
    write(store, {key: {'owner': 'first'}})
    stale = store.read_records([key], deadline=deadline()).records[key].version
    write(store, {key: {'owner': 'second'}})
    context = multiprocessing.get_context('spawn')
    output = context.Queue()
    process = context.Process(target=stale_writer, args=(config, config.get('second_url'), key, stale, output))
    process.start()
    process.join(10)
    assert process.exitcode == 0
    assert output.get(timeout=1) is False
    assert values(store, [key])[key] == {'owner': 'second'}


def test_versions_prevent_delete_recreate_aba_and_transaction_is_atomic(adapter):
    store, _ = adapter
    a, b = fence_key(REF, 1), fence_key(OTHER, 1)
    write(store, {a: {'owner': 'first'}, b: {'owner': 'first'}})
    first = store.read_records([a, b], deadline=deadline())
    write(store, {a: None})
    write(store, {a: {'owner': 'first'}})
    assert not store.compare_and_swap({key: row.version for key, row in first.records.items()},
        {a: {'owner': 'stale'}, b: {'owner': 'stale'}}, deadline=deadline())
    assert values(store, [b])[b] == {'owner': 'first'}


def test_absent_expectation_is_not_satisfied_after_create_and_delete(adapter):
    store, _ = adapter
    key = lease_key('aba')
    never = store.read_records([key], deadline=deadline()).records[key].version
    write(store, {key: {'owner': 'one'}})
    write(store, {key: None})
    assert not store.compare_and_swap({key: never}, {key: {'owner': 'late'}}, deadline=deadline())
    assert values(store, [key])[key] is None


@store_options(tombstone_ttl=0.05, generation_retention=0)
def test_stale_versions_stay_stale_after_tombstones_are_compacted(adapter):
    store, _ = adapter
    key = lease_key('aba')
    never = store.read_records([key], deadline=deadline()).records[key].version
    write(store, {key: {'owner': 'one'}})
    write(store, {key: None})
    tombstone = store.read_records([key], deadline=deadline()).records[key].version
    time.sleep(.1)
    write(store, {key: {'owner': 'two'}})  # Rewrites the tombstone's storage, allowing compaction.
    write(store, {key: None})
    time.sleep(.1)
    write(store, {key: {'owner': 'three'}})
    write(store, {key: None})
    for stale in (never, tombstone):
        assert not store.compare_and_swap({key: stale}, {key: {'owner': 'late'}}, deadline=deadline())
    assert values(store, [key])[key] is None


def test_failed_cas_publishes_nothing(adapter):
    store, _ = adapter
    key = lease_key('runner-1')
    write(store, {key: {'owner': 'first'}})
    before = store.read_records([key], deadline=deadline())
    assert not store.compare_and_swap({key: 'not-the-current-version'}, {key: {'owner': 'x'}},
        deadline=deadline(), operation_id='failed-once')
    after = store.read_records([key], deadline=deadline())
    assert after.generation == before.generation
    assert after.records[key] == before.records[key]
    # A failed attempt is not a durable commit; status is unknown, replay stays failed.
    assert store.operation_status('failed-once', deadline=deadline()) is None
    assert not store.compare_and_swap({key: 'not-the-current-version'}, {key: {'owner': 'x'}},
        deadline=deadline(), operation_id='failed-once')


def test_operation_id_is_durable_and_replays_do_not_overwrite(adapter):
    store, config = adapter
    key = result_key(REF, 1)
    old = store.read_records([key], deadline=deadline())
    expected = {key: old.records[key].version}
    changes = {key: {'state': 'absent'}}
    assert store.compare_and_swap(expected, changes, deadline=deadline(), operation_id='absence-once')
    write(store, {key: {'state': 'pending', 'fence': 2}})
    reconnected = store_from_config(config, config.get('second_url'))
    assert reconnected.operation_status('absence-once', deadline=deadline()) is True
    assert reconnected.compare_and_swap(expected, changes, deadline=deadline(), operation_id='absence-once')
    assert values(reconnected, [key])[key] == {'state': 'pending', 'fence': 2}


def test_operation_id_reuse_with_different_content_is_a_programming_error(adapter):
    store, _ = adapter
    key = result_key(REF, 1)
    old = store.read_records([key], deadline=deadline())
    assert store.compare_and_swap({key: old.records[key].version}, {key: {'state': 'absent'}},
        deadline=deadline(), operation_id='reused')
    with pytest.raises(OperationConflict):
        store.compare_and_swap({key: old.records[key].version}, {key: {'state': 'other'}},
            deadline=deadline(), operation_id='reused')


@store_options(operation_ttl=0.3)
def test_operation_log_expires_to_unknown(adapter):
    store, _ = adapter
    key = result_key(REF, 1)
    write(store, {key: {'state': 'absent'}}, operation_id='short-lived')
    assert store.operation_status('short-lived', deadline=deadline()) is True
    time.sleep(.4)
    write(store, {lease_key('later'): {'n': 1}})
    assert store.operation_status('short-lived', deadline=deadline()) is None


@store_options(operation_ttl=0.2, generation_retention=0.2, tombstone_ttl=0.2)
@pytest.mark.slow(reason='capacity: churns keys under lease renewal')
def test_storage_stays_bounded_under_lease_renewal_and_key_churn(adapter):
    store, config = adapter
    key = lease_key('runner-1')

    def churn(count):
        for index in range(count):
            write(store, {key: {'renewal': index}}, operation_id=f'renew-{time.monotonic_ns()}')
            write(store, {lease_key(f'job-{index}'): {'n': index}})
            write(store, {lease_key(f'job-{index}'): None})

    def settled_size():
        # Measure at quiescence: past every TTL, after enough writes for cleanup.
        time.sleep(.3)
        for index in range(20):
            write(store, {lease_key('settle'): {'n': index}})
        return store_size(config)

    # Steady state: repeating the same renewal/churn workload must not grow
    # storage (operations log, superseded generations and tombstones expire).
    churn(200)
    baseline = settled_size()
    churn(200)
    churn(200)
    assert settled_size() < baseline * 1.1


def test_http_lost_response_can_resolve_commit_without_reapplying(adapter):
    store, config = adapter
    if config['adapter'] != 'http':
        pytest.skip('HTTP lost-response transport case')
    key = result_key(REF, 1)
    old = store.read_records([key], deadline=deadline())
    with pytest.raises(ProjectionUnavailable):
        store.compare_and_swap({key: old.records[key].version}, {key: {'state': 'absent'}},
            deadline=deadline(), operation_id='lost-response')
    assert store.operation_status('lost-response', deadline=deadline()) is True
    assert values(store, [key])[key] == {'state': 'absent'}


def test_expired_deadline_fails_closed(adapter):
    store, _ = adapter
    key = catalog_edition_key(REF)
    with pytest.raises(ProjectionUnavailable):
        store.read_records([key], deadline=time.monotonic() - .1)
    with pytest.raises(ProjectionUnavailable):
        store.compare_and_swap({key: 'missing'}, {key: {}}, deadline=time.monotonic() - .1)


def test_commit_observed_at_the_pointer_is_reported_even_if_the_deadline_then_passes(adapter):
    store, config = adapter
    key = result_key(REF, 1)
    old = store.read_records([key], deadline=deadline())
    with fault(config, 'slow-pointer'):
        try:
            committed = store.compare_and_swap({key: old.records[key].version}, {key: {'state': 'absent'}},
                deadline=time.monotonic() + .3, operation_id='slow-pointer')
        except ProjectionUnavailable:
            assert config['adapter'] == 'http'  # The client cannot know; it must ask.
            committed = store.operation_status('slow-pointer', deadline=deadline())
    assert committed is True
    assert values(store, [key])[key] == {'state': 'absent'}


@store_options(generation_retention=0)
def test_cleanup_failure_never_turns_a_commit_into_a_failure(adapter):
    store, config = adapter
    key = lease_key('r')
    for index in range(5):
        write(store, {key: {'n': index}})
    with fault(config, 'unlink-fails'):
        for index in range(40):
            write(store, {key: {'n': 100 + index}})
    assert values(store, [key])[key] == {'n': 139}


# --- Capacity: protected state is independent of evictable payloads ------------
def test_protected_absence_survives_full_payload_capacity(adapter):
    store, _ = adapter
    result, quote, catalog = result_key(REF, 1), quote_key(REF, 1), catalog_edition_key(REF)
    write(store, {result: {'state': 'quote'}, quote: {'amount': '5.00'}})
    write(store, {quote_key(OTHER, 1): {'amount': '6.00'}, quote_key(OTHER, 2): {'amount': '7.00'}})
    assert values(store, [quote])[quote] is None
    write(store, {result: {'state': 'pending', 'fence': 3}})
    write(store, {result: {'state': 'absent', 'expires_at': '2099-01-01'}, quote: None})
    write(store, {quote_key(OTHER, 3): {'amount': '8.00'}, catalog: {'quarantined': True}})
    assert values(store, [result, quote, catalog]) == {
        result: {'state': 'absent', 'expires_at': '2099-01-01'}, quote: None, catalog: {'quarantined': True}}


def test_byte_capacity_eviction_never_falls_back_and_protected_state_is_independent(adapter):
    store, _ = adapter
    catalog, result, quote = catalog_edition_key(REF), result_key(REF, 1), quote_key(REF, 1)
    write(store, {catalog: {'evidence': 'x' * 1400}, result: {'state': 'absent'}})
    write(store, {quote: {'amount': '4.00'}})
    write(store, {quote: {'oversized': 'x' * 1100}})
    current = values(store, [catalog, result, quote])
    assert current[quote] is None
    assert current[result] == {'state': 'absent'}
    assert len(current[catalog]['evidence']) == 1400


def test_entry_capacity_evicts_oldest_payload_first(adapter):
    store, _ = adapter
    first, second, third = quote_key(REF, 1), quote_key(REF, 2), quote_key(REF, 3)
    write(store, {first: {'amount': '1.00'}})
    write(store, {second: {'amount': '2.00'}})
    write(store, {first: {'amount': '1.50'}})  # Rewritten: now newer than second.
    write(store, {third: {'amount': '3.00'}})
    assert values(store, [first, second, third]) == {first: {'amount': '1.50'}, second: None, third: {'amount': '3.00'}}


def test_absence_during_full_storage_fails_closed_never_old_quote(adapter):
    store, config = adapter
    result, quote = result_key(REF, 1), quote_key(REF, 1)
    write(store, {result: {'state': 'quote', 'attempt': 1}, quote: {'attempt': 1, 'amount': '5.00'}})
    write(store, {result: {'state': 'pending', 'fence': 2}})
    pending = store.read_records([result, quote], deadline=deadline())
    expected = {key: row.version for key, row in pending.records.items()}
    with fault(config, 'enospc'):
        with pytest.raises(ProjectionUnavailable):
            store.compare_and_swap(expected, {result: {'state': 'absent'}, quote: None},
                deadline=deadline(), operation_id='absence-full')
        state = quote_states(store, [(REF, 1)], deadline=deadline())[(REF, 1)]
        assert (state.status, state.quote) == ('pending', None)
    assert store.operation_status('absence-full', deadline=deadline()) is None
    assert quote_states(store, [(REF, 1)], deadline=deadline())[(REF, 1)].status == 'pending'
    # Storage recovers: the retried absence commits and supersedes the quote.
    assert store.compare_and_swap(expected, {result: {'state': 'absent'}, quote: None},
        deadline=deadline(), operation_id='absence-full')
    assert quote_states(store, [(REF, 1)], deadline=deadline())[(REF, 1)].status == 'absent'


# --- Snapshots, pinning and reads ------------------------------------------------
def test_batches_pin_complete_generation_and_enforce_limit(adapter):
    store, _ = adapter
    keys = [catalog_edition_key(ref(index)) for index in range(260)]
    for offset in range(0, 260, 128):
        write(store, {key: {'number': index} for index, key in enumerate(keys) if offset <= index < offset + 128})
    snapshot = store.read_records(keys[:1], deadline=deadline())
    write(store, {keys[129]: {'number': -1}})
    assert values(store, [keys[129]], generation=snapshot.generation)[keys[129]] == {'number': 129}
    complete = store.read_all(keys, deadline=deadline())
    assert len(complete.records) == 260
    assert complete.records[keys[259]].value == {'number': 259}
    assert complete.records[keys[129]].value == {'number': -1}
    with pytest.raises(ValueError):
        store.read_records([catalog_edition_key(ref(index)) for index in range(129)], deadline=deadline())
    with pytest.raises(ValueError):
        store.compare_and_swap({key: 'v' for key in keys[:129]}, {}, deadline=deadline())


def test_read_all_of_empty_rows_is_complete(adapter):
    store, _ = adapter
    keys = [result_key(ref(index), 1) for index in range(300)]
    snapshot = store.read_all(keys, deadline=deadline())
    assert set(snapshot.records) == set(keys)
    assert all(row.value is None for row in snapshot.records.values())


def test_active_generation_remains_pinned_through_many_concurrent_commits(adapter):
    store, _ = adapter
    key = catalog_edition_key(REF)
    write(store, {key: {'revision': 1}})
    pinned = store.read_records([key], deadline=deadline())
    for revision in range(2, 40):
        write(store, {key: {'revision': revision}})
    assert values(store, [key], generation=pinned.generation)[key] == {'revision': 1}


@store_options(generation_retention=1.0)
@pytest.mark.slow(reason='sleep: sleeps 1.1 s past a pin expiry')
def test_pinned_generation_keeps_evicted_payloads_until_pin_expiry_then_fails_closed(adapter):
    store, _ = adapter
    quote = quote_key(REF, 1)
    write(store, {quote: {'amount': '4.00'}})
    pinned = store.read_records([quote], deadline=deadline())
    write(store, {quote_key(OTHER, 1): {'amount': '5.00'}, quote_key(OTHER, 2): {'amount': '6.00'}})
    for index in range(20):
        write(store, {lease_key('renewal'): {'n': index}})
    # The current generation never falls back; the pinned snapshot stays coherent.
    assert values(store, [quote])[quote] is None
    assert values(store, [quote], generation=pinned.generation)[quote] == {'amount': '4.00'}
    time.sleep(1.1)
    for index in range(20):
        write(store, {lease_key('renewal'): {'n': index}})
    with pytest.raises(ProjectionUnavailable):
        store.read_records([quote], generation=pinned.generation, deadline=deadline())


def test_mutating_a_returned_value_does_not_change_stored_state(adapter):
    store, _ = adapter
    key = catalog_edition_key(REF)
    write(store, {key: {'names': ['one'], 'revision': 1}})
    first = values(store, [key])[key]
    first['names'].append('mutated')
    first['revision'] = 99
    assert values(store, [key])[key] == {'names': ['one'], 'revision': 1}


def test_unknown_generation_is_unavailable(adapter):
    store, _ = adapter
    with pytest.raises(ProjectionUnavailable):
        store.read_records([catalog_edition_key(REF)], generation='0' * 64, deadline=deadline())


def test_reads_do_not_write_to_storage(adapter):
    store, config = adapter
    key = catalog_edition_key(REF)
    write(store, {key: {'revision': 1}})
    with read_only_storage(config):
        assert values(store, [key])[key] == {'revision': 1}
        keys = [key] + [result_key(ref(index), 1) for index in range(200)]
        assert len(store.read_all(keys, deadline=deadline()).records) == 201


def _paused_writer(context, config, phase, reached):
    if config['adapter'] == 'filesystem':
        process = context.Process(target=fault_writer, args=(config, phase, reached))
        process.start()
        return process, None
    process, url = start_relay(config, phase, reached)
    unused = context.Event()  # Kept referenced until the child has unpickled it.
    writer = context.Process(target=fault_writer, args=({**config, 'url': url}, 'none', unused))
    writer.start()
    writer.unused_event = unused
    return process, writer


def _stop_paused(process, writer):
    process.kill()
    process.join(5)
    if writer:
        writer.join(5)
        if writer.is_alive():
            writer.kill()
            writer.join(5)


@pytest.mark.timing
@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_reads_are_not_blocked_by_an_in_flight_commit(adapter):
    store, config = adapter
    result, quote = result_key(CRASH_REF, 1), quote_key(CRASH_REF, 1)
    write(store, {quote: {'amount': '5.00'}, result: {'state': 'pending', 'fence': 2}})
    context = multiprocessing.get_context('spawn')
    reached = context.Event()
    process, writer = _paused_writer(context, config, 'before', reached)
    try:
        assert reached.wait(10)
        started = time.monotonic()
        snapshot = values(store, [result, quote])
        within_budget(time.monotonic() - started, .5, 'test_reads_are_not_blocked_by_an_in_flight_commit', unit='s')
        assert snapshot[result] == {'state': 'pending', 'fence': 2}
    finally:
        _stop_paused(process, writer)


@pytest.mark.parametrize('phase', ['before', 'after'])
def test_process_crash_keeps_pending_or_committed_absence_never_old_result(adapter, phase):
    store, config = adapter
    result, quote = result_key(CRASH_REF, 1), quote_key(CRASH_REF, 1)
    write(store, {quote: {'amount': '5.00'}, result: {'state': 'pending', 'fence': 2}})
    context = multiprocessing.get_context('spawn')
    reached = context.Event()
    process, writer = _paused_writer(context, config, phase, reached)
    try:
        assert reached.wait(10)
    finally:
        _stop_paused(process, writer)
    expected_state = 'pending' if phase == 'before' else 'absent'
    recovered = values(store, [result, quote])
    assert recovered[result]['state'] == expected_state
    if phase == 'after':
        assert recovered[quote] is None
        assert store.operation_status('terminal-absence', deadline=deadline()) is True
    # Later writers proceed past the crash and cleanup never loses the current state.
    for index in range(40):
        write(store, {lease_key('after-crash'): {'n': index}})
    assert values(store, [result])[result]['state'] == expected_state


@store_options(generation_retention=0)
def test_cleanup_ignores_coarse_timestamps_and_never_deletes_current_generation(adapter):
    store, config = adapter
    key = catalog_edition_key(REF)
    for index in range(20):
        write(store, {key: {'revision': index}})
    scramble_mtimes(config)
    for index in range(40):
        write(store, {lease_key('churn'): {'n': index}})
        scramble_mtimes(config)
    assert values(store, [key])[key] == {'revision': 19}


def test_corrupt_authoritative_pointer_never_falls_back(adapter):
    store, config = adapter
    key = result_key(REF, 1)
    write(store, {key: {'state': 'absent'}})
    corrupt_pointer(config)
    with pytest.raises(ProjectionUnavailable):
        store.read_records([key], deadline=deadline())
    with pytest.raises(ProjectionUnavailable):
        store.compare_and_swap({key: 'v'}, {key: None}, deadline=deadline())


def test_pinned_generation_corruption_is_unavailable(adapter):
    store, config = adapter
    key = result_key(REF, 1)
    write(store, {key: {'state': 'pending'}})
    pinned = store.read_records([key], deadline=deadline())
    write(store, {key: {'state': 'absent'}})
    corrupt_generation(config, pinned.generation)
    with pytest.raises(ProjectionUnavailable):
        store.read_records([key], generation=pinned.generation, deadline=deadline())


def test_initialize_is_idempotent_and_never_resets_existing_state(adapter):
    store, _ = adapter
    key = catalog_edition_key(REF)
    write(store, {key: {'revision': 1}})
    store.initialize(deadline=deadline())
    assert values(store, [key])[key] == {'revision': 1}


def test_record_work_does_not_advance_publication_revision(tmp_path, monkeypatch):
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path))
    publication = FilePublicProjection()
    with publication.writer(initialize=True):
        publication.apply('public-token', {'title': 'Frozen', 'version': 1})
    before = publication.read_state()
    store = FilePublicRecords(tmp_path)
    store.initialize(deadline=deadline())
    write(store, {result_key(REF, 1): {'state': 'absent'}, admission_key('global'): {'active': 2},
                  quote_key(REF, 1): {'amount': '1.00'}, backoff_key('x'): {'until': 1}})
    assert publication.read_state() == before


# --- HTTP transport ------------------------------------------------------------
@pytest.mark.serial(reason='wall-clock: asserts an upper bound on elapsed time')
def test_http_total_deadline_cuts_off_trickling_response(adapter):
    store, config = adapter
    if config['adapter'] != 'http':
        pytest.skip('HTTP streaming deadline case')
    with fault(config, 'slow-relay'):
        started = time.monotonic()
        with pytest.raises(ProjectionUnavailable):
            store.read_records([catalog_edition_key(REF)], deadline=started + .06)
        assert time.monotonic() - started < .12


def test_http_reuses_connections_across_requests_and_instances(adapter):
    store, config = adapter
    if config['adapter'] != 'http':
        pytest.skip('HTTP connection reuse case')
    log = Path(config['directory']) / 'relay-connections.log'
    values(store, [catalog_edition_key(REF)])
    log.unlink(missing_ok=True)
    for _ in range(5):
        values(store, [catalog_edition_key(REF)])
        values(store_from_config(config), [catalog_edition_key(REF)])
    ports = log.read_text().split()
    assert len(ports) == 10
    assert len(set(ports)) == 1


def test_http_malformed_records_shape_is_unavailable(adapter):
    store, config = adapter
    if config['adapter'] != 'http':
        pytest.skip('HTTP response validation case')
    with fault(config, 'malformed-records'):
        with pytest.raises(ProjectionUnavailable):
            store.read_records([catalog_edition_key(REF)], deadline=deadline())


# --- Quote-state read helper -------------------------------------------------------
def test_quote_state_pending_marker_suppresses_payload(adapter):
    store, _ = adapter
    write(store, {result_key(REF, 1): {'state': 'quote', 'attempt': 1}, quote_key(REF, 1): {'attempt': 1, 'amount': '5.00'}})
    assert quote_states(store, [(REF, 1)], deadline=deadline())[(REF, 1)].quote == {'attempt': 1, 'amount': '5.00'}
    write(store, {result_key(REF, 1): {'state': 'pending', 'fence': 2}})
    state = quote_states(store, [(REF, 1)], deadline=deadline())[(REF, 1)]
    assert (state.status, state.quote) == ('pending', None)


def test_quote_state_absence_supersedes_a_remaining_payload(adapter):
    store, _ = adapter
    write(store, {result_key(REF, 1): {'state': 'absent', 'checked_at': '2026-10-08T00:00:00Z'},
                  quote_key(REF, 1): {'attempt': 1, 'amount': '5.00'}})
    state = quote_states(store, [(REF, 1)], deadline=deadline())[(REF, 1)]
    assert (state.status, state.quote) == ('absent', None)
    assert state.result == {'state': 'absent', 'checked_at': '2026-10-08T00:00:00Z'}


def test_quote_state_evicted_payload_is_unknown(adapter):
    store, _ = adapter
    write(store, {result_key(REF, 1): {'state': 'quote', 'attempt': 1}, quote_key(REF, 1): {'attempt': 1, 'amount': '5.00'}})
    write(store, {quote_key(OTHER, 1): {'amount': '1.00'}, quote_key(OTHER, 2): {'amount': '2.00'}})
    state = quote_states(store, [(REF, 1)], deadline=deadline())[(REF, 1)]
    assert (state.status, state.quote) == ('unknown', None)


def test_quote_state_never_falls_back_to_an_older_mapping_revision_or_attempt(adapter):
    store, _ = adapter
    write(store, {result_key(REF, 1): {'state': 'quote', 'attempt': 1}, quote_key(REF, 1): {'attempt': 1, 'amount': '5.00'}})
    write(store, {result_key(OTHER, 1): {'state': 'quote', 'attempt': 2}, quote_key(OTHER, 1): {'attempt': 1, 'amount': '9.00'}})
    states = quote_states(store, [(REF, 2), (OTHER, 1)], deadline=deadline())
    assert (states[(REF, 2)].status, states[(REF, 2)].quote) == ('unknown', None)
    assert (states[(OTHER, 1)].status, states[(OTHER, 1)].quote) == ('unknown', None)


@pytest.mark.parametrize('result', [{'state': 'bogus'}, ['quote'], {'state': 'quote'}, 'absent',
                                    {'state': 'quote', 'attempt': True}, {'state': 'quote', 'attempt': 1.5}])
def test_quote_state_malformed_result_is_invalid_for_that_row_only(adapter, result):
    store, _ = adapter
    write(store, {result_key(REF, 1): result})
    write(store, {result_key(OTHER, 1): {'state': 'quote', 'attempt': 1}, quote_key(OTHER, 1): {'attempt': 1, 'amount': '5.00'}})
    states = quote_states(store, [(REF, 1), (OTHER, 1)], deadline=deadline())
    assert (states[(REF, 1)].status, states[(REF, 1)].quote) == ('invalid', None)
    assert (states[(OTHER, 1)].status, states[(OTHER, 1)].quote) == ('quote', {'attempt': 1, 'amount': '5.00'})
    assert states[(REF, 1)].generation == states[(OTHER, 1)].generation


def test_quote_state_non_dict_payload_is_invalid_for_that_row_only(adapter):
    store, _ = adapter
    write(store, {result_key(REF, 1): {'state': 'quote', 'attempt': 1}, quote_key(REF, 1): ['nope']})
    write(store, {result_key(OTHER, 1): {'state': 'absent'}})
    states = quote_states(store, [(REF, 1), (OTHER, 1)], deadline=deadline())
    assert (states[(REF, 1)].status, states[(REF, 1)].quote) == ('invalid', None)
    assert states[(OTHER, 1)].status == 'absent'


def test_quote_state_store_unavailability_still_raises(adapter):
    store, _ = adapter
    with pytest.raises(ProjectionUnavailable):
        quote_states(store, [(REF, 1)], deadline=time.monotonic() - 1)


def test_quote_states_cover_more_than_one_batch_at_one_generation(adapter):
    store, _ = adapter
    pairs = [(ref(index), 1) for index in range(100)]
    for offset in range(0, 100, 50):
        write(store, {result_key(edition, revision): {'state': 'absent'} for edition, revision in pairs[offset:offset + 50]})
    states = quote_states(store, pairs + [(REF, 7)], deadline=deadline())
    assert len(states) == 101
    assert all(states[pair].status == 'absent' for pair in pairs)
    assert states[(REF, 7)].status == 'unknown'
    assert len({state.generation for state in states.values()}) == 1


# --- Performance against the 500 ms cached-read p95 budget -----------------------
PERF_RECORDS = 10_000


@pytest.fixture(scope='module')
def populated(tmp_path_factory):
    config = {'adapter': 'filesystem', 'directory': str(tmp_path_factory.mktemp('perf'))}
    backend = backend_from_config(config)
    backend.initialize(deadline=deadline())
    keys = []
    for index in range(PERF_RECORDS // 2):
        keys += [catalog_edition_key(ref(index)), quote_key(ref(index), 1)]
    started = time.monotonic()
    for offset in range(0, len(keys), 128):
        batch = keys[offset:offset + 128]
        current = backend.read_records(batch, deadline=deadline())
        assert backend.compare_and_swap({key: row.version for key, row in current.records.items()},
            {key: {'key': key, 'amount': '1.23', 'checked_at': '2026-10-08T00:00:00Z'} for key in batch},
            deadline=deadline(30))
    return config, keys, time.monotonic() - started


def _p95(samples):
    return statistics.quantiles(samples, n=20)[-1]


@pytest.mark.timing
@pytest.mark.parametrize('adapter_name', ['filesystem', 'http'])
@pytest.mark.serial(reason='capacity: asserts read latency percentiles at 10k records')
@pytest.mark.slow(reason='capacity: builds 10k records')
def test_cached_reads_at_10k_records_are_well_under_the_500ms_budget(populated, adapter_name):
    config, keys, populate = populated
    relay = None
    if adapter_name == 'http':
        relay, url = start_relay(config)
        config = {**config, 'adapter': 'http', 'url': url}
    try:
        store = store_from_config(config)
        records._clear_cache()
        started = time.monotonic()
        assert len(store.read_all(keys[:1000], deadline=deadline()).records) == 1000
        cold = time.monotonic() - started
        single, complete = [], []
        for iteration in range(20):
            batch = keys[iteration * 997 % (len(keys) - 128):][:128]
            started = time.monotonic()
            assert len(store.read_records(batch, deadline=deadline()).records) == 128
            single.append(time.monotonic() - started)
            started = time.monotonic()
            assert len(store.read_all(keys[iteration * ((len(keys) - 1000) // 19):][:1000], deadline=deadline()).records) == 1000
            complete.append(time.monotonic() - started)
        commits = []
        # 60 samples, so a couple of fsync stalls from a busy disk cannot set the p95 alone.
        for iteration in range(60):
            batch = [result_key(ref(iteration), 1), quote_key(ref(iteration), 1), fence_key(ref(iteration), 1)]
            current = store.read_records(batch, deadline=deadline())
            started = time.monotonic()
            assert store.compare_and_swap({key: row.version for key, row in current.records.items()},
                {key: {'n': iteration} for key in batch}, deadline=deadline())
            commits.append(time.monotonic() - started)
        print(f'\n{adapter_name}: populate {PERF_RECORDS} records {populate:.2f}s; first read_all(1000) {cold * 1000:.1f}ms; '
              f'read_records(128) p95 {_p95(single) * 1000:.1f}ms; read_all(1000) p95 {_p95(complete) * 1000:.1f}ms; '
              f'3-key CAS p95 {_p95(commits) * 1000:.1f}ms')
        within_budget(_p95(single), .1, 'test_cached_reads_at_10k_records_are_well_under_the_500ms_budget', unit='s')
        within_budget(_p95(complete), .25, 'test_cached_reads_at_10k_records_are_well_under_the_500ms_budget', unit='s')
        within_budget(cold, .5, 'test_cached_reads_at_10k_records_are_well_under_the_500ms_budget', unit='s')
        within_budget(_p95(commits), .25, 'test_cached_reads_at_10k_records_are_well_under_the_500ms_budget', unit='s')
    finally:
        if relay:
            stop(relay)


# --- Records-only initialization/upgrade for existing installs ------------------
ROOT = Path(__file__).resolve().parents[2]


def run_records_init(directory):
    env = {**os.environ, 'PUBLIC_PROJECTION_DIR': str(directory), 'PUBLIC_PROJECTION_ADAPTER': 'filesystem'}
    return subprocess.run([sys.executable, str(ROOT / 'scripts' / 'init_public_records.py')], env=env,
                          capture_output=True, text=True, timeout=30)


def test_records_init_adds_records_to_an_existing_publication_install_without_touching_it(tmp_path, monkeypatch):
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path))
    publication = FilePublicProjection()
    with publication.writer(initialize=True):
        publication.apply('public-token', {'title': 'Frozen', 'version': 1})
    before = publication.read_state()
    first = run_records_init(tmp_path)
    assert first.returncode == 0, first.stderr
    store = FilePublicRecords(tmp_path)
    write(store, {catalog_edition_key(REF): {'revision': 1}})
    second = run_records_init(tmp_path)
    assert second.returncode == 0, second.stderr
    assert values(store, [catalog_edition_key(REF)])[catalog_edition_key(REF)] == {'revision': 1}
    assert publication.read_state() == before


def test_records_init_refuses_to_recreate_lost_established_records(tmp_path):
    store = FilePublicRecords(tmp_path)
    store.initialize(deadline=deadline())
    write(store, {catalog_edition_key(REF): {'revision': 1}})
    corrupt_pointer({'directory': str(tmp_path)})
    assert run_records_init(tmp_path).returncode != 0
    with pytest.raises(ProjectionUnavailable):
        store.read_records([catalog_edition_key(REF)], deadline=deadline())


def test_empty_legacy_records_store_is_upgraded_and_populated_one_is_refused(tmp_path):
    empty, populated_dir = tmp_path / 'empty', tmp_path / 'populated'
    write_legacy_store(empty, {})
    write_legacy_store(populated_dir, {'catalog:one': {'revision': 1}})
    assert run_records_init(empty).returncode == 0
    store = FilePublicRecords(empty)
    write(store, {catalog_edition_key(REF): {'revision': 1}})
    assert values(store, [catalog_edition_key(REF)])[catalog_edition_key(REF)] == {'revision': 1}
    assert run_records_init(populated_dir).returncode != 0
    with pytest.raises(ProjectionUnavailable):
        FilePublicRecords(populated_dir).read_records([catalog_edition_key(REF)], deadline=deadline())
