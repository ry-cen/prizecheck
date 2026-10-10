"""Record contract for price refresh: builders produce valid records, validators refuse everything else."""
from copy import deepcopy
import json
import subprocess
import sys

import pytest

from app import quote_contract as qc
from app.public_records import key_family

REF = 'a' * 48
OWNER = 'b' * 32
USER = 'user:u1'
ANON = 'anon:' + '0f' * 16


def test_module_is_pure_and_prices_reexports_the_amount_parser():
    code = ("import sys, json; import app.quote_contract; "
            "print(json.dumps([m for m in ('psycopg', 'app.main', 'app.prices') if m in sys.modules]))")
    out = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, check=True)
    assert json.loads(out.stdout) == []
    import app.main  # noqa: F401  (main first: it includes the prices router while loading)
    from app import prices
    assert prices.parse_amount is qc.parse_amount


def test_every_key_builder_yields_a_typed_protected_key():
    keys = [qc.scheduler_key(), qc.ledger_key(0), qc.ledger_key(63), qc.runner_lease_key(0), qc.runner_lease_key(1),
            qc.source_backoff_key(), qc.edition_backoff_key(REF, 3), qc.work_record_key(REF, 3), qc.fence_record_key(REF, 3)]
    assert keys[0] == 'admission:price:scheduler' and keys[3] == 'lease:price:runner:0'
    assert keys[5] == 'backoff:price:source' and keys[6] == f'backoff:price:edition:{REF}:3'
    assert all(not key_family(key).evictable for key in keys)


@pytest.mark.parametrize('bad', [-1, 64, True, '1', None])
def test_bad_shards_and_slots_are_refused(bad):
    with pytest.raises(qc.ContractError):
        qc.ledger_scope(bad)
    with pytest.raises(qc.ContractError):
        qc.runner_scope(bad)


def test_job_ids_round_trip_and_garbage_is_refused():
    assert qc.split_job_id(qc.job_id(REF, 7)) == (REF, 7)
    for bad in ('', REF, REF + ':0', 'x:1', REF + ':99999999999999999999'):
        with pytest.raises(qc.ContractError):
            qc.split_job_id(bad)


def test_ledger_shard_is_stable_and_in_range():
    assert qc.ledger_shard(ANON) == qc.ledger_shard(ANON) and 0 <= qc.ledger_shard(ANON) < qc.LEDGER_SHARDS
    with pytest.raises(qc.ContractError):
        qc.ledger_shard(USER)


def test_wall_clock_is_one_patchable_function(monkeypatch):
    monkeypatch.setattr(qc, 'wall_ms', lambda: 42)
    assert qc.wall_ms() == 42
    assert qc.iso_from_ms(0) == '1970-01-01T00:00:00Z'


def test_edition_backoff_follows_the_schedule():
    assert [qc.edition_backoff_delay_s(k) for k in (1, 2, 3, 4, 5, 6, 40)] == [60, 120, 240, 480, 900, 900, 900]
    assert qc.edition_backoff_delay_s(1, jitter=1.2) == pytest.approx(72)
    assert qc.edition_backoff_delay_s(1, retry_after_s=300) == 300
    for bad in ((0,), (1, 1.3), (True,)):
        with pytest.raises(qc.ContractError):
            qc.edition_backoff_delay_s(*bad)


# --- scheduler ---
def scheduler():
    record = qc.new_scheduler(1000)
    record['jobs'][qc.job_id(REF, 1)] = qc.new_job(USER, 'card-1', 1000)
    record['fifo'][USER] = [qc.job_id(REF, 1)]
    record['ring'] = [USER]
    return record


def test_valid_schedulers_pass_and_survive_json():
    assert qc.validate_scheduler(qc.new_scheduler(5))
    record = scheduler()
    assert qc.validate_scheduler(json.loads(json.dumps(record))) == record


def claim(record):
    key = qc.job_id(REF, 1)
    record['jobs'][key].update(state='running', slot=0, owner=OWNER, attempt=1)
    record['fifo'] = {}
    record['ring'] = []
    record['source']['p1'] = {'caller': USER, 'slot': 0, 'owner': OWNER, 'jobs': [key], 'started_ms': 1100}
    return record


def test_a_claimed_job_needs_a_permit_and_leaves_the_fifo():
    assert qc.validate_scheduler(claim(scheduler()))


BAD_SCHEDULERS = {
    'extra field': lambda r: r.update(extra=1),
    'version': lambda r: r.update(v=2),
    'bool version': lambda r: r.update(v=True),
    'bucket over capacity': lambda r: r['bucket'].update(milli=8001),
    'float time': lambda r: r['bucket'].update(at_ms=1.5),
    'extended expiry': lambda r: r['jobs'][qc.job_id(REF, 1)].update(expires_ms=999999),
    'queued job with attempt': lambda r: r['jobs'][qc.job_id(REF, 1)].update(attempt=1),
    'job missing from fifo': lambda r: (r['fifo'].clear(), r['ring'].clear()),
    'fifo names foreign job': lambda r: r['jobs'][qc.job_id(REF, 1)].update(caller='user:other'),
    'ring mismatch': lambda r: r['ring'].append('user:x'),
    'cursor outside ring': lambda r: r.update(cursor=1),
    'bad caller': lambda r: r['jobs'][qc.job_id(REF, 1)].update(caller='root'),
    'bad card': lambda r: r['jobs'][qc.job_id(REF, 1)].update(card='../x'),
    'ledger over cap': lambda r: r['ledger'].update(count=qc.LEDGER_CAP + 1),
    'negative stat': lambda r: r['stats'].update(joined=-1),
    'permit for queued job': lambda r: r['source'].update(p={'caller': USER, 'slot': 0, 'owner': OWNER,
                                                             'jobs': [qc.job_id(REF, 1)], 'started_ms': 1}),
    'interactive over per-caller cap': lambda r: r['interactive'].update(
        {f'r{i}': {'caller': USER, 'until_ms': 5} for i in range(3)}),
}


@pytest.mark.parametrize('name', sorted(BAD_SCHEDULERS))
def test_malformed_schedulers_are_refused(name):
    record = scheduler()
    BAD_SCHEDULERS[name](record)
    with pytest.raises(qc.ContractError):
        qc.validate_scheduler(record)


def test_a_scheduler_that_is_not_an_object_is_refused():
    for bad in ([], None, 'x'):
        with pytest.raises(qc.ContractError):
            qc.validate_scheduler(bad)


def test_global_and_per_caller_caps_are_enforced():
    record = qc.new_scheduler(0)
    for index in range(qc.MAX_JOBS_PER_CALLER + 1):
        key = qc.job_id(f'{index:048x}', 1)
        record['jobs'][key] = qc.new_job(USER, 'c', 0)
    record['fifo'][USER] = list(record['jobs'])[:qc.MAX_JOBS_PER_CALLER]
    record['ring'] = [USER]
    with pytest.raises(qc.ContractError):
        qc.validate_scheduler(record)
    record = qc.new_scheduler(0)
    for index in range(qc.MAX_SOURCE_PERMITS + 1):
        record['source'][f'p{index}'] = {'caller': f'user:{index}', 'slot': index % 2, 'owner': OWNER, 'jobs': [], 'started_ms': 0}
    with pytest.raises(qc.ContractError):
        qc.validate_scheduler(record)


# --- other coordination records ---
def test_ledger_shards_hold_only_expiries():
    record = qc.new_ledger_shard()
    record['entries'][ANON] = {'expires_ms': 10}
    assert qc.validate_ledger_shard(record, qc.ledger_shard(ANON))
    with pytest.raises(qc.ContractError):
        qc.validate_ledger_shard(record, (qc.ledger_shard(ANON) + 1) % 64)
    for bad in ({'expires_ms': 10, 'ip': '1.2.3.4'}, {'expires_ms': '10'}, {}):
        with pytest.raises(qc.ContractError):
            qc.validate_ledger_shard({'v': 1, 'entries': {ANON: bad}})
    with pytest.raises(qc.ContractError):
        qc.validate_ledger_shard({'v': 1, 'entries': {USER: {'expires_ms': 1}}})


def test_runner_leases():
    assert qc.validate_runner_lease(None) is None
    lease = qc.new_runner_lease(OWNER, 'host-1', 1000, 123)
    assert qc.validate_runner_lease(lease)
    running = {**lease, 'state': 'running', 'claimed_ms': 1100, 'supervisor_pid': 5, 'worker_pid': 6,
               'lease_until_ms': 11100, 'hard_stop_ms': 66100}
    assert qc.validate_runner_lease(running)
    for bad in ({**lease, 'supervisor_pid': 5}, {**running, 'worker_pid': None}, {**running, 'hard_stop_ms': 5},
                {**lease, 'state': 'dead'}, {**lease, 'owner': 'nonce'}, {**lease, 'launcher_pid': 0}, {**lease, 'x': 1}):
        with pytest.raises(qc.ContractError):
            qc.validate_runner_lease(bad)


def test_backoff_records():
    assert qc.validate_source_backoff(qc.new_source_backoff('rate_limited', 5000, 1000))
    assert qc.validate_edition_backoff(qc.new_edition_backoff(2, 1000, 121000, 'timeout'))
    for bad in (qc.new_source_backoff('nope', 5000, 1000), qc.new_source_backoff('retry_after', 1000 + 3_600_001, 1000)):
        with pytest.raises(qc.ContractError):
            qc.validate_source_backoff(bad)
    for bad in (qc.new_edition_backoff(0, 1, 2, 'timeout'), qc.new_edition_backoff(1, 1, 2, 'boom'),
                qc.new_edition_backoff(True, 1, 2, 'timeout')):
        with pytest.raises(qc.ContractError):
            qc.validate_edition_backoff(bad)


def test_work_and_fence():
    work = qc.new_work(REF, 2, 'card-1', 'normal', '12345', USER, 1000)
    assert qc.validate_work(work) and work['expires_ms'] == 61000
    claimed = {**work, 'state': 'running', 'attempt': 3, 'slot': 1, 'owner': OWNER}
    assert qc.validate_work(claimed)
    for bad in ({**work, 'attempt': 1}, {**claimed, 'owner': None}, {**work, 'expires_ms': 61001}, {**work, 'product_id': ''},
                {**work, 'mapping_revision': 0}):
        with pytest.raises(qc.ContractError):
            qc.validate_work(bad)
    assert qc.validate_fence(qc.new_fence()) == {'v': 1, 'attempt': 0}
    for bad in ({'v': 1, 'attempt': -1}, {'v': 1, 'attempt': True}, {'v': 1}):
        with pytest.raises(qc.ContractError):
            qc.validate_fence(bad)


def test_quote_and_result_records():
    result = qc.new_quote_result(2, 1_700_000_000_000)
    payload = qc.new_quote_payload(2, '0.43', 'card-1', 'normal', '2026-10-09T00:00:00Z')
    assert qc.validate_quote_result(result) and qc.validate_quote_payload(payload)
    assert result['attempt'] == payload['attempt']
    absent = qc.new_absent_result(3, 1_700_000_000_000)
    assert qc.validate_quote_result(absent)
    assert absent['expires_at'] == qc.iso_from_ms(1_700_000_000_000 + qc.ABSENT_TTL_MS)
    assert qc.validate_quote_payload({**payload, 'provider_updated_at': None})
    assert qc.validate_quote_payload({**payload, 'amount': '0'})  # a validated zero is a real price
    for bad in ({**result, 'state': 'pending'}, {**result, 'attempt': True}, {**result, 'checked_at': '2026-10-09T00:00:00'},
                {**absent, 'expires_at': None}, {'state': 'quote', 'attempt': 1}):
        with pytest.raises(qc.ContractError):
            qc.validate_quote_result(bad)
    for change in ({'amount': 0.43}, {'amount': '1e3'}, {'amount': '-1'}, {'currency': 'EUR'}, {'source': 'x'},
                   {'attempt': 0}, {'provider_updated_at': 'garbage'}, {'provider_updated_at': '2026-10-09T00:00:00'}):
        with pytest.raises(qc.ContractError):
            qc.validate_quote_payload({**deepcopy(payload), **change})
