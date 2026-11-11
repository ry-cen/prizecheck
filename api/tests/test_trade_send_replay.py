"""Initial-send compatibility through the real signed POST and real migration.

Literal old fingerprints/responses come from dev 59f7dc57's pre-thread schema.
No replay/mapping/reach reader is mocked. Every migration fixture is committed
before DDL and DATABASE_URL includes the adapter's separately opened snapshot.
"""
import copy
import hashlib
import json
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from psycopg import sql

from app.db import connect
from app.games.pokemon.trading.trade_inventory import SendTradeProposal, trade_send_payload
from app.location_tree import VOID_DIGEST
from app.social.threads import normalize_text
from test_catalog_references import migrate
from test_deck_cost import launches, store  # noqa: F401
from test_holdings import call
from test_operation_counts import writer  # noqa: F401
from test_thread_migration import MIGRATION, old, apply, mapped  # noqa: F401
from test_trade_migrations import collector, scratch  # noqa: F401
from test_trades import counter, read, trade_step

GOLD = json.loads((Path(__file__).parent / 'trade_send_fixtures/legacy.json').read_text())
OWNER, OTHER = GOLD['owner'], 'legacy-recipient'
EDITION = GOLD['response']['you_give'][0]['edition_id']
ROUND = GOLD['response']['id']
KEY = GOLD['key']
UNAVAILABLE = {'detail': {'code': 'TRADE_SEND_ALREADY_APPLIED_UNAVAILABLE',
                          'outcome': 'already_applied', 'view': 'unavailable'}}


def body(variant='omitted', key=KEY):
    return {**copy.deepcopy(next(v['body'] for v in GOLD['variants'] if v['name'] == variant)),
            'idempotency_key': key}


def retry(variant='omitted', key=KEY, caller=OWNER, **changes):
    return call('POST', '/api/trades', caller, {**body(variant, key), **changes})


def snapshot():
    """All persisted rows, not just counts: includes quotas, timestamps and read markers."""
    with connect() as conn:
        tables = [r['tablename'] for r in conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")]
        return {t: conn.execute(sql.SQL('SELECT to_jsonb(t) AS row FROM {} t ORDER BY to_jsonb(t)::text')
                                .format(sql.Identifier(t))).fetchall() for t in tables}


def unchanged_retries(expected_status, expected=None, **kwargs):
    before = snapshot()
    for _ in range(2):
        response = retry(**kwargs)
        assert response.status_code == expected_status, response.text
        if expected is not None:
            assert response.json() == expected
        assert snapshot() == before
    return response


def replace_receipt(value, digest=None):
    with connect() as conn:
        conn.execute('UPDATE location_command SET response=%s::jsonb WHERE owner_id=%s AND request_key=%s',
                     (json.dumps(value), OWNER, KEY))
        if digest is not None:
            conn.execute('UPDATE location_command SET request_digest=%s WHERE owner_id=%s AND request_key=%s',
                         (digest, OWNER, KEY))


@pytest.fixture
def legacy(old, scratch, monkeypatch, store, writer):
    # HTTP request telemetry has its own asynchronous DB writer, independent of
    # the command. Use its established fixture seam so exhaustive snapshots can
    # keep every public table (including operations_hour) without masking a
    # domain/receipt/quota write or racing a background telemetry flush.
    writer(None)
    monkeypatch.setenv('DATABASE_URL', scratch)
    sender_location = collector(old, OWNER)
    collector(old, OTHER)
    old.execute("UPDATE collector_profile SET display_name=CASE user_id WHEN %s THEN 'Ash' ELSE 'Misty' END",
                (OWNER,))
    old.execute('UPDATE collector_profile SET trader_id=%s,handle=%s,handle_key=%s WHERE user_id=%s',
                (GOLD['response']['other']['trader_id'], 'legacy_recipient', 'legacy_recipient', OTHER))
    low, high = sorted((OWNER, OTHER))
    old.execute("INSERT INTO friendship(user_low,user_high,state,requested_by) VALUES (%s,%s,'accepted',%s)",
                (low, high, OWNER))
    # Same minimal catalog convention as test_trade_migrations.edition, with an
    # explicit Edition id so the literal digest really names the seeded card.
    identity = old.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES ('legacy-iono','Iono') RETURNING id").fetchone()['id']
    printing = old.execute("INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',%s) RETURNING id", (identity,)).fetchone()['id']
    old.execute("INSERT INTO catalog_edition(id,printing_id,descriptor_key,descriptor) VALUES (%s,%s,'normal','{}')",
                (EDITION, printing))
    old.execute('UPDATE location SET for_trade=true WHERE id=%s', (sender_location,))
    old.execute('INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,5,1)',
                (OWNER, sender_location, EDITION))
    old.execute("""INSERT INTO trade(id,state,proposer_id,recipient_id,proposer_name,recipient_name,created_at)
      VALUES (%s,'proposed',%s,%s,'Ash','Misty','2020-01-02')""", (ROUND, OWNER, OTHER))
    old.execute("INSERT INTO trade_line(trade_id,side,edition_id,position,quantity) VALUES (%s,'proposer',%s,0,1)",
                (ROUND, EDITION))
    old.execute("INSERT INTO trade_pick(trade_id,side,owner_id,edition_id,source_location_id,quantity) VALUES (%s,'proposer',%s,%s,%s,1)",
                (ROUND, OWNER, EDITION, sender_location))
    old.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s::jsonb)',
                (OWNER, KEY, GOLD['variants'][0]['digest'], json.dumps(GOLD['response'])))
    # Loan and Trade can share a round UUID; kind is part of mapping identity.
    old.execute("INSERT INTO loan(id,kind,state,lender_id,borrower_id,lender_name,borrower_name) VALUES (%s,'borrow_request','requested',%s,%s,'Ash','Misty')", (ROUND, OWNER, OTHER))
    apply(old)
    # apply() runs only the thread migration. The send path under test is current code, so record that migration and
    # apply every later root migration too (migrate() applies the remaining files in filename order).
    old.execute('INSERT INTO schema_migration(name) VALUES (%s)', (MIGRATION,))
    old.commit()
    migrate(scratch)
    return {'thread_id': str(mapped(old, 'trade', UUID(ROUND))), 'id': ROUND, 'offer_id': ROUND, 'revision': 1}


def test_legacy_golden_send_survives_real_thread_migration(legacy):
    assert GOLD['provenance']['commit'] == '59f7dc57050fcb005f97dbeca75f3cd85f1d764e'
    for variant in ('omitted', 'null', 'trader'):
        # The trader family has a different literal digest and its own old key.
        if variant == 'trader':
            replace_receipt(GOLD['response'], next(v['digest'] for v in GOLD['variants'] if v['name'] == variant))
        response = unchanged_retries(201, variant=variant)
        result = response.json()
        assert set(result) == {'outcome', 'view', 'label', 'trade'}
        assert (result['outcome'], result['view'], result['label']) == ('already_applied', 'current', 'Current Trade')
        assert result['trade']['thread_id'] == legacy['thread_id']
        assert result['trade']['offer_id'] == ROUND
        assert result['trade']['you_give'][0]['edition_id'] == EDITION


def test_legacy_send_returns_current_tip_after_counter_and_closure(legacy):
    current = retry().json()['trade']
    other_view = read(OTHER, current).json()
    changed = counter(OTHER, other_view, get=[(EDITION, 2)])
    assert changed.status_code == 200, changed.text
    latest = unchanged_retries(201).json()['trade']
    assert latest['offer_id'] != ROUND and latest['role'] == 'recipient'
    assert latest['you_give'][0]['copies'] == '2'
    second = counter(OWNER, latest, give=[(EDITION, 3)])
    assert second.status_code == 200, second.text
    latest = unchanged_retries(201).json()['trade']
    assert latest['role'] == 'proposer' and latest['you_give'][0]['copies'] == '3'
    closed = trade_step(OWNER, latest, 'withdraw')
    assert closed.status_code == 200, closed.text
    assert unchanged_retries(201).json()['trade']['state'] == 'closed'


def test_legacy_pre_party_fields_validate_but_are_not_returned(legacy):
    replace_receipt(GOLD['pre_party_response'])
    with connect() as conn:
        conn.execute("UPDATE collector_profile SET display_name='Current Misty' WHERE user_id=%s", (OTHER,))
    result = unchanged_retries(201).json()['trade']
    assert result['other']['display_name'] == 'Current Misty'
    assert result['other']['available'] is True
    assert result['other']['trader_id'] == GOLD['response']['other']['trader_id']


@pytest.mark.parametrize('fault', ['missing_map', 'loan_only', 'wrong_pair_map', 'wrong_owner', 'missing_member',
                                  'missing_counterpart_member', 'missing_original', 'deleted_counterpart',
                                  'block_out', 'block_in', 'suspended_caller', 'suspended_other', 'missing_profile'])
def test_legacy_mapping_is_kind_owner_and_member_scoped(legacy, fault):
    with connect() as conn:
        if fault in ('missing_map', 'loan_only'):
            conn.execute("DELETE FROM thread_round_source WHERE kind='trade' AND round_id=%s", (ROUND,))
        elif fault == 'wrong_pair_map':
            for owner in ('other-a', 'other-z'):
                collector(conn, owner)
            tid = uuid4()
            conn.execute("INSERT INTO thread(id,kind,user_low,user_high,created_at,last_activity_at,changed_at) VALUES (%s,'trade','other-a','other-z',now(),now(),now())", (tid,))
            conn.execute("UPDATE thread_round_source SET thread_id=%s WHERE kind='trade' AND round_id=%s", (tid, ROUND))
        elif fault == 'wrong_owner':
            # A valid historical send snapshot of the recipient is not ownership
            # of the original send, despite membership in the same thread.
            other_payload = {'action': 'trade_send', **{k: v for k, v in body().items() if k != 'idempotency_key'}, 'recipient_id': OWNER}
            digest = hashlib.sha256(json.dumps(other_payload, sort_keys=True).encode()).hexdigest()
            conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s::jsonb)', (OTHER, KEY, digest, json.dumps(GOLD['response'])))
        elif fault in ('missing_member', 'missing_counterpart_member'):
            conn.execute('DELETE FROM thread_member WHERE thread_id=%s AND member_id=%s',
                         (legacy['thread_id'], OWNER if fault == 'missing_member' else OTHER))
        elif fault == 'missing_original':
            conn.execute('DELETE FROM trade WHERE id=%s', (ROUND,))
        elif fault == 'deleted_counterpart':
            conn.execute('DELETE FROM inventory_owner WHERE user_id=%s', (OTHER,))
        elif fault in ('block_out', 'block_in'):
            blocker, blocked = (OWNER, OTHER) if fault == 'block_out' else (OTHER, OWNER)
            conn.execute('INSERT INTO block(blocker_id,blocked_id) VALUES (%s,%s)', (blocker, blocked))
        elif fault.startswith('suspended'):
            conn.execute('UPDATE collector_profile SET suspended_at=now() WHERE user_id=%s',
                         (OWNER if fault == 'suspended_caller' else OTHER,))
        elif fault == 'missing_profile':
            conn.execute('DELETE FROM collector_profile WHERE user_id=%s', (OTHER,))
    # Only caller membership is required. A missing other member is an
    # inaccessible relationship too, and cannot return a special current view.
    unchanged_retries(409, UNAVAILABLE, caller=OTHER, recipient_id=OWNER) if fault == 'wrong_owner' else unchanged_retries(409, UNAVAILABLE)


@pytest.mark.parametrize('fault', ['partial_thread', 'partial_offer', 'null_ids', 'invalid_ids', 'not_dict',
                                  'missing_field', 'extra_field', 'step', 'recipient', 'revision', 'counter', 'json_null'])
def test_legacy_applied_unavailable_is_terminal_and_neutral(legacy, fault):
    stored = copy.deepcopy(GOLD['response'])
    if fault == 'partial_thread': stored['thread_id'] = legacy['thread_id']
    elif fault == 'partial_offer': stored['offer_id'] = ROUND
    elif fault == 'null_ids': stored.update(thread_id=None, offer_id=None)
    elif fault == 'invalid_ids': stored.update(thread_id='bad', offer_id=ROUND)
    elif fault == 'not_dict': stored = ['not a receipt']
    elif fault == 'json_null': stored = None
    elif fault == 'missing_field': stored.pop('you_give')
    elif fault == 'extra_field': stored['unexpected'] = 'private stale value'
    elif fault == 'step': stored['state'] = 'accepted'
    elif fault == 'recipient': stored['role'] = 'recipient'
    elif fault == 'revision': stored['revision'] = 2
    elif fault == 'counter': stored['countered_from'] = ROUND
    replace_receipt(stored)
    unchanged_retries(409, UNAVAILABLE)


def test_readable_blocked_history_does_not_enable_send_adapter(legacy):
    with connect() as conn:
        conn.execute('INSERT INTO block(blocker_id,blocked_id) VALUES (%s,%s)', (OTHER, OWNER))
    assert read(OWNER, legacy).status_code == 200
    unchanged_retries(409, UNAVAILABLE)


def test_current_send_receipt_is_exact_after_counter_and_access_change(legacy):
    key = str(uuid4())
    first = retry(key=key)
    assert first.status_code == 201, first.text
    assert 'outcome' not in first.json()
    changed = counter(OTHER, read(OTHER, first.json()).json(), get=[(EDITION, 2)])
    assert changed.status_code == 200, changed.text
    with connect() as conn:
        conn.execute('INSERT INTO block(blocker_id,blocked_id) VALUES (%s,%s)', (OTHER, OWNER))
    assert unchanged_retries(201, key=key).content == first.content


@pytest.mark.parametrize('message,code', [('', 'EMPTY_MESSAGE'), (' \r\n ', 'EMPTY_MESSAGE'),
                                        ('\u202e\u0000', 'EMPTY_MESSAGE'), ('x' * 1001, 'MESSAGE_TOO_LONG')])
def test_empty_message_is_existing_shape_error(legacy, message, code):
    unchanged_retries(422, {'detail': {'code': code}}, message=message)


def test_message_fingerprint_is_raw_and_quota_counts_once(legacy):
    raw = next(v for v in GOLD['variants'] if v['name'] == 'raw')
    normalized = next(v for v in GOLD['variants'] if v['name'] == 'normalized')
    key = str(uuid4())
    first = retry('raw', key=key)
    assert first.status_code == 201, first.text
    with connect() as conn:
        receipt = conn.execute('SELECT request_digest FROM location_command WHERE owner_id=%s AND request_key=%s', (OWNER, key)).fetchone()
        assert receipt['request_digest'] == raw['digest']
        messages = conn.execute('SELECT body FROM thread_message WHERE thread_id=%s', (first.json()['thread_id'],)).fetchall()
        assert messages == [{'body': 'Hello\nCafé'}]
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'message' FROM generate_series(1,119)", (OWNER,))
    assert unchanged_retries(201, variant='raw', key=key).content == first.content
    unchanged_retries(409, {'detail': {'code': 'IDEMPOTENCY_KEY_REUSED'}}, variant='normalized', key=key)
    assert normalize_text(raw['body']['message']) == normalize_text(normalized['body']['message']) == 'Hello\nCafé'


def test_void_precedes_digest_and_adapter(legacy):
    replace_receipt(GOLD['response'], VOID_DIGEST)
    unchanged_retries(409, {'detail': {'code': 'IDEMPOTENCY_KEY_VOID'}}, you_get=[{'edition_id': str(uuid4()), 'quantity': '1'}])


def test_different_action_digest_is_refused_before_adaptation(legacy):
    canonical = json.dumps({'action': 'trade_withdraw', 'trade_id': ROUND, 'revision': 1}, sort_keys=True)
    replace_receipt(GOLD['response'], hashlib.sha256(canonical.encode()).hexdigest())
    unchanged_retries(409, {'detail': {'code': 'IDEMPOTENCY_KEY_REUSED'}})


def test_owner_key_collision_never_reads_other_owners_receipt(legacy):
    with connect() as conn:
        conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s::jsonb)',
                     (OTHER, KEY, VOID_DIGEST, '{}'))
    unchanged_retries(201)
    unchanged_retries(409, {'detail': {'code': 'IDEMPOTENCY_KEY_VOID'}}, caller=OTHER, recipient_id=OWNER)


def test_legacy_replay_has_no_writes_even_when_repeated(legacy):
    unchanged_retries(201)
    with connect() as conn:
        conn.execute('DELETE FROM thread_member WHERE thread_id=%s AND member_id=%s', (legacy['thread_id'], OWNER))
    unchanged_retries(409, UNAVAILABLE)


@pytest.mark.parametrize('variant', GOLD['variants'], ids=lambda v: v['name'])
def test_literal_send_fingerprint_families(variant):
    command = SendTradeProposal.model_validate({**variant['body'], 'idempotency_key': KEY})
    payload = trade_send_payload(command)
    canonical = json.dumps(payload, sort_keys=True, default=str)
    assert canonical == variant['canonical']
    assert hashlib.sha256(canonical.encode()).hexdigest() == variant['digest']
    assert variant['digest'] != GOLD['buggy_null_digest']


def test_quantity_text_and_line_order_remain_distinct():
    original = body()
    def digest(value):
        payload = trade_send_payload(SendTradeProposal.model_validate(value))
        return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    assert digest(original) != digest({**original, 'you_give': [{'edition_id': EDITION, 'quantity': '01'}]})
    lines = original['you_give'] + [{'edition_id': '55555555-5555-4555-8555-555555555555', 'quantity': '2'}]
    assert digest({**original, 'you_give': lines}) != digest({**original, 'you_give': list(reversed(lines))})


def test_unexpected_snapshot_database_error_stays_unknown_and_rolls_back(legacy, monkeypatch):
    import psycopg
    from app.social import trades
    before = snapshot()
    def unavailable_connection():
        raise psycopg.OperationalError('synthetic snapshot connection outage')
    # Fault the separately opened database connection, not the adapter, mapping,
    # membership, or view. The actual POST must let the unexpected error escape.
    monkeypatch.setattr(trades, 'connect', unavailable_connection)
    with pytest.raises(psycopg.OperationalError, match='snapshot connection outage'):
        retry()
    assert snapshot() == before


def test_new_send_omitted_and_null_message_replay_exactly(legacy):
    key = str(uuid4())
    first = retry(key=key)
    assert first.status_code == 201, first.text
    assert unchanged_retries(201, variant='null', key=key).content == first.content


def test_changed_quantity_is_reused_key_before_current_resolution(legacy):
    unchanged_retries(409, {'detail': {'code': 'IDEMPOTENCY_KEY_REUSED'}},
                      you_give=[{'edition_id': EDITION, 'quantity': '2'}])


@pytest.mark.parametrize('commands', [0, 120], ids=['below_quota', 'at_quota'])
def test_json_null_send_receipt_is_terminal_before_quota(legacy, commands):
    with connect() as conn:
        conn.execute("UPDATE location_command SET response='null'::jsonb WHERE owner_id=%s AND request_key=%s",
                     (OWNER, KEY))
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'trade_command' FROM generate_series(1,%s)",
                     (OWNER, commands))
        # A mistaken call to the quota helper below the limit would also prune
        # this row. All rows, receipt bytes and timestamps must remain equal.
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind,created_at) VALUES (%s,'trade_command',now()-interval '2 hours')",
                     (OWNER,))
    unchanged_retries(409, UNAVAILABLE)


@pytest.mark.parametrize('commands', [0, 120], ids=['below_quota', 'at_quota'])
@pytest.mark.parametrize('digest,code', [('0' * 64, 'IDEMPOTENCY_KEY_REUSED'),
                                       (VOID_DIGEST, 'IDEMPOTENCY_KEY_VOID')], ids=['mismatched_digest', 'void'])
def test_json_null_receipt_keeps_void_then_digest_precedence(legacy, commands, digest, code):
    with connect() as conn:
        conn.execute("UPDATE location_command SET response='null'::jsonb,request_digest=%s WHERE owner_id=%s AND request_key=%s",
                     (digest, OWNER, KEY))
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'trade_command' FROM generate_series(1,%s)",
                     (OWNER, commands))
    # A valid but different request makes the digest mismatch explicit even for
    # the void case. Neither quota nor the null adapter may win over this gate.
    unchanged_retries(409, {'detail': {'code': code}},
                      you_give=[{'edition_id': EDITION, 'quantity': '2'}])


def test_genuinely_absent_trade_send_key_counts_and_mutates_once(legacy):
    key = str(uuid4())
    before = snapshot()
    assert not any(row['row']['owner_id'] == OWNER and row['row']['request_key'] == key
                   for row in before['location_command'])
    first = retry(key=key)
    assert first.status_code == 201, first.text
    result = first.json()
    assert 'outcome' not in result and result['id'] != ROUND
    after = snapshot()
    for table, increase in [('trade', 1), ('trade_line', 1), ('trade_pick', 1),
                             ('thread', 1), ('thread_member', 2), ('location_command', 1),
                             ('handle_lookup_event', 1)]:
        assert len(after[table]) == len(before[table]) + increase, table
    assert after['loan'] == before['loan']
    assert after['loan_line'] == before['loan_line']
    assert after['loan_pick'] == before['loan_pick']
    assert after['thread_message'] == before['thread_message']
    command_events = [row['row'] for row in after['handle_lookup_event']
                      if row['row']['user_id'] == OWNER and row['row']['kind'] == 'trade_command']
    assert len(command_events) == 1
    assert unchanged_retries(201, key=key).content == first.content
    assert snapshot() == after


def test_genuinely_absent_trade_send_key_still_respects_quota(legacy):
    key = str(uuid4())
    with connect() as conn:
        assert conn.execute('SELECT 1 FROM location_command WHERE owner_id=%s AND request_key=%s',
                            (OWNER, key)).fetchone() is None
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'trade_command' FROM generate_series(1,120)",
                     (OWNER,))
    response = unchanged_retries(429, key=key)
    detail = response.json()['detail']
    assert set(detail) == {'code', 'retry_after_minutes'}
    assert detail['code'] == 'TOO_MANY_CHANGES'
    assert isinstance(detail['retry_after_minutes'], int) and 1 <= detail['retry_after_minutes'] <= 60


# The only before/after seam retargeting for the real late-observation proof.
_INITIAL_SEND_GATE = 'replay_owner_receipt'
_ABSENT_GATE_TAIL = (False, None)
_LOAN_SEND_CANONICAL = '{"action": "loan_send", "deck_id": null, "lender_id": "legacy-recipient", "lines": [{"edition_id": "11111111-1111-4111-8111-111111111111", "quantity": "1"}], "return_by": null}'
_LOAN_SEND_DIGEST = '5eb82ebc6b9a4d8960d3485c3f75be0d9311a9015c7deddeb5b4bf412b941360'


def _peer_receipt(key, kind):
    assert hashlib.sha256(_LOAN_SEND_CANONICAL.encode()).hexdigest() == _LOAN_SEND_DIGEST
    digest = VOID_DIGEST if kind == 'void' else _LOAN_SEND_DIGEST
    with connect() as peer:
        row = peer.execute("INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,'{}'::jsonb) RETURNING request_key,request_digest,response,created_at",
                           (OWNER, key, digest)).fetchone()
    return row  # context exit committed before the POST's barrier is released


def _save_receipt_proof(name, key, proof):
    import os
    directory = Path(os.environ['TEST_LOG_DIR']) / 'ta-b2-proofs'
    directory.mkdir(exist_ok=True)
    path = directory / f'{name}-{key}.json'
    with path.open('x') as stream:
        json.dump(proof, stream, sort_keys=True, default=str)
    print('TA-B2 proof', path.name, json.dumps({
        'observed_gate': proof['gate_result'], 'peer': proof['peer_insert'],
        'first': proof['first_result'], 'all_states_equal': proof['all_states_equal'],
    }, default=str))


def _late_receipt_proof(monkeypatch, peer_kind, at_quota):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    import psycopg
    from app.games.pokemon.trading import trade_inventory

    key = str(uuid4())
    with connect() as conn:
        assert conn.execute('SELECT 1 FROM location_command WHERE owner_id=%s AND request_key=%s',
                            (OWNER, key)).fetchone() is None
        if at_quota:
            conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'trade_command' FROM generate_series(1,120)", (OWNER,))
    reached, resume = Event(), Event()
    real_gate = getattr(trade_inventory, _INITIAL_SEND_GATE)
    observed = []

    def after_actual_lookup(*args, **kwargs):
        result = real_gate(*args, **kwargs)
        assert result[1:] == _ABSENT_GATE_TAIL
        observed.append(result)
        reached.set()
        assert resume.wait(timeout=10), 'late-receipt barrier was not released'
        return result  # the actual real gate return, unchanged

    collision, response = None, None
    with monkeypatch.context() as scoped:
        scoped.setattr(trade_inventory, _INITIAL_SEND_GATE, after_actual_lookup)
        with ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(retry, key=key)
            try:
                assert reached.wait(timeout=10), 'real absent lookup did not reach the barrier'
                peer = _peer_receipt(key, peer_kind)
                after_peer = snapshot()
            finally:
                resume.set()
            try:
                response = request.result(timeout=20)
            except psycopg.errors.UniqueViolation as cause:
                collision = cause
    # The command transaction has exited before checking every persisted value.
    states = [after_peer, snapshot()]
    expected = {'detail': {'code': 'IDEMPOTENCY_KEY_VOID' if peer_kind == 'void' else 'IDEMPOTENCY_KEY_REUSED'}}
    retry_results = []
    for _ in range(2):
        retried = retry(key=key)
        retry_results.append({'status': retried.status_code, 'body': retried.json()})
        assert retried.status_code == 409 and retried.json() == expected
        states.append(snapshot())
    first = {'constraint': collision.diag.constraint_name} if collision is not None else {
        'status': response.status_code, 'body': response.json()}
    proof = {'gate_result': observed, 'peer_insert': peer, 'peer_kind': peer_kind,
             'at_quota': at_quota, 'first_result': first, 'retry_results': retry_results,
             'snapshots': states, 'all_states_equal': all(state == after_peer for state in states)}
    _save_receipt_proof('late-quota' if at_quota else 'late-collision', key, proof)
    assert proof['all_states_equal']
    return collision, response


@pytest.mark.parametrize('peer_kind', ['void', 'loan_send'])
def test_initial_send_receipt_inserted_after_absence_rolls_back(legacy, monkeypatch, peer_kind):
    collision, response = _late_receipt_proof(monkeypatch, peer_kind, at_quota=False)
    assert collision is not None, f'Expected location_command_pkey collision, got HTTP {response.status_code}: {response.text}'
    assert collision.diag.constraint_name == 'location_command_pkey'


@pytest.mark.parametrize('peer_kind', ['void', 'loan_send'])
def test_initial_send_late_receipt_does_not_bypass_fresh_quota(legacy, monkeypatch, peer_kind):
    collision, response = _late_receipt_proof(monkeypatch, peer_kind, at_quota=True)
    assert collision is None
    assert response.status_code == 429, f'Late receipt bypassed fresh quota: {response.status_code} {response.text}'
    detail = response.json()['detail']
    assert set(detail) == {'code', 'retry_after_minutes'} and detail['code'] == 'TOO_MANY_CHANGES'
    assert isinstance(detail['retry_after_minutes'], int) and 1 <= detail['retry_after_minutes'] <= 60


def _insert_observed_receipt(key, digest, stored):
    with connect() as peer:
        if stored is None:
            row = peer.execute("INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,'null'::jsonb) RETURNING request_key,request_digest,response,created_at",
                               (OWNER, key, digest)).fetchone()
        else:
            row = peer.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s::jsonb) RETURNING request_key,request_digest,response,created_at',
                               (OWNER, key, digest, json.dumps(stored))).fetchone()
    return row


@pytest.mark.parametrize('at_quota', [False, True], ids=['below_quota', 'at_quota'])
@pytest.mark.parametrize('family', ['void', 'loan_send', 'null', 'current', 'legacy'])
def test_initial_send_validates_receipt_committed_before_lookup(legacy, monkeypatch, family, at_quota):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from app.social import owners

    key = str(uuid4())
    current = None
    if family in ('current', 'void'):
        current_key = str(uuid4())
        current = retry(key=current_key)
        assert current.status_code == 201 and 'outcome' not in current.json(), current.text
        with connect() as conn:
            current_stored = conn.execute('SELECT response FROM location_command WHERE owner_id=%s AND request_key=%s',
                                          (OWNER, current_key)).fetchone()['response']
            if family == 'current':
                conn.execute('INSERT INTO block(blocker_id,blocked_id) VALUES (%s,%s)', (OTHER, OWNER))
        if family == 'current':
            assert read(OWNER, current.json()).json()['other']['available'] is False
            assert current.json()['other']['available'] is True
    digest = GOLD['variants'][0]['digest']
    stored = copy.deepcopy(GOLD['response'])
    if family == 'void':
        digest, stored = VOID_DIGEST, current_stored
    elif family == 'loan_send':
        digest = _LOAN_SEND_DIGEST
    elif family == 'null':
        stored = None
    elif family == 'current':
        stored = current_stored
    with connect() as conn:
        assert conn.execute('SELECT 1 FROM location_command WHERE owner_id=%s AND request_key=%s',
                            (OWNER, key)).fetchone() is None
        counted = conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE user_id=%s AND kind='trade_command' AND created_at>now()-interval '1 hour'", (OWNER,)).fetchone()['n']
        if at_quota:
            conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'trade_command' FROM generate_series(1,%s)", (OWNER, 120-counted))
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind,created_at) VALUES (%s,'trade_command',now()-interval '2 hours')", (OWNER,))
    reached, resume = Event(), Event()
    real_lookup = owners.replay_with_presence
    calls, returns = [], []

    def before_real_lookup(*args, **kwargs):
        calls.append('real owner preparation completed; receipt SELECT not yet called')
        reached.set()
        assert resume.wait(timeout=10), 'before-lookup barrier was not released'
        result = real_lookup(*args, **kwargs)
        returns.append(result)
        return result

    with monkeypatch.context() as scoped:
        scoped.setattr(owners, 'replay_with_presence', before_real_lookup)
        with ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(retry, key=key)
            try:
                assert reached.wait(timeout=10), 'prepared real lookup did not reach the barrier'
                peer = _insert_observed_receipt(key, digest, stored)
                after_peer = snapshot()
            finally:
                resume.set()
            response = request.result(timeout=20)
    assert len(calls) == 1
    states = [after_peer, snapshot()]
    replies = [{'status': response.status_code, 'body': response.json()}]
    for _ in range(2):
        repeated = retry(key=key)
        assert repeated.content == response.content and repeated.status_code == response.status_code
        replies.append({'status': repeated.status_code, 'body': repeated.json()})
        states.append(snapshot())
    proof = {'gate_result': returns, 'peer_insert': peer, 'family': family, 'at_quota': at_quota,
             'first_result': replies[0], 'retry_results': replies[1:], 'snapshots': states,
             'real_lookup_calls': calls, 'all_states_equal': all(state == after_peer for state in states)}
    _save_receipt_proof('before-lookup-'+family, key, proof)
    assert proof['all_states_equal']
    if family in ('void', 'loan_send'):
        expected = 'IDEMPOTENCY_KEY_VOID' if family == 'void' else 'IDEMPOTENCY_KEY_REUSED'
        assert response.status_code == 409 and response.json() == {'detail': {'code': expected}}
    elif family == 'null':
        assert response.status_code == 409 and response.json() == UNAVAILABLE
    elif family == 'current':
        assert response.status_code == 201 and response.content == current.content
    else:
        result = response.json()
        assert response.status_code == 201 and (result['outcome'], result['view'], result['label']) == ('already_applied', 'current', 'Current Trade')
        assert result['trade']['offer_id'] == ROUND and result['trade']['thread_id'] == legacy['thread_id']


def test_replay_presence_and_legacy_pair_use_real_receipts(legacy):
    import inspect
    from fastapi import HTTPException
    from app.location_tree import replay, replay_with_presence
    from app.social import owners

    assert list(inspect.signature(replay).parameters) == ['conn', 'user_id', 'key', 'payload']
    assert list(inspect.signature(owners.replay_owner_command).parameters) == ['conn', 'user_id', 'key', 'payload', 'kind']
    payload, digest = json.loads(GOLD['variants'][0]['canonical']), GOLD['variants'][0]['digest']
    absent = str(uuid4())
    before = snapshot()
    with connect() as conn:
        assert replay_with_presence(conn, OWNER, absent, payload) == (digest, False, None)
        assert replay(conn, OWNER, absent, payload) == (digest, None)
    assert snapshot() == before
    for value in [None, False, 0, '', [], {}, GOLD['response']]:
        replace_receipt(value)
        before = snapshot()
        with connect() as conn:
            actual = replay_with_presence(conn, OWNER, KEY, payload)
            pair = replay(conn, OWNER, KEY, payload)
        assert actual[:2] == (digest, True) and actual[1] is True
        assert type(actual[2]) is type(value) and actual[2] == value
        assert len(pair) == 2 and pair == (digest, value) and type(pair[1]) is type(value)
        assert snapshot() == before
    for stored_digest, code in [(VOID_DIGEST, 'IDEMPOTENCY_KEY_VOID'), (_LOAN_SEND_DIGEST, 'IDEMPOTENCY_KEY_REUSED')]:
        replace_receipt(None, stored_digest)
        before = snapshot()
        for reader in (replay, replay_with_presence):
            with connect() as conn, pytest.raises(HTTPException) as refused:
                reader(conn, OWNER, KEY, payload)
            assert refused.value.status_code == 409 and refused.value.detail == {'code': code}
        assert snapshot() == before


@pytest.mark.parametrize('family', ['absent', 'null', 'dict'])
def test_begin_owner_command_preserves_null_count_condition(legacy, family):
    from app.social import owners
    payload, digest = json.loads(GOLD['variants'][0]['canonical']), GOLD['variants'][0]['digest']
    key = str(uuid4()) if family == 'absent' else KEY
    stored = {'done': True} if family == 'dict' else None
    if family != 'absent':
        replace_receipt(stored)
    before = snapshot()
    with connect() as conn:
        def count():
            return conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE user_id=%s AND kind='trade_command'", (OWNER,)).fetchone()['n']
        initial = count()
        assert owners.replay_owner_command(conn, OWNER, key, payload, 'trade') == (digest, stored)
        assert count() == initial
        assert owners.replay_owner_receipt(conn, OWNER, key, payload, 'trade') == (digest, family != 'absent', stored)
        assert count() == initial
        assert owners.begin_owner_command(conn, OWNER, key, payload, 'trade') == (digest, stored)
        assert count() == initial + (0 if family == 'dict' else 1)
        conn.rollback()
    assert snapshot() == before
