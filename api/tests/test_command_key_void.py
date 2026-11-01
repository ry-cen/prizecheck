"""S1: authoritative Loan outcomes, permanent key fences and account preconditions."""
import hashlib
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from datetime import date
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import test_holdings
from pydantic import BaseModel, Field, ValidationError

from app import loan_inventory
from app.location_tree import VOID_DIGEST
from app.social import loans
from app.social.owners import COMMANDS_PER_HOUR
from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import launches, store  # noqa: F401
from test_deck_counting import hold
from test_friend_copies import node, ok, place
from test_holdings import call
from test_loans import accept, pair, sent, view
from test_borrowed_copies import lend
from want_list_swap_fixtures import seed_swap_catalog

MAX_LOAN_LINES = 50
connect = loan_inventory.connect


def snapshot():
    """Every no-write check covers all B.13 tables, including owner revisions."""
    with connect() as conn:
        result = {}
        for table in ('loan', 'loan_line', 'borrowed_holding', 'location_command'):
            rows = conn.execute(f'SELECT row_to_json(t) AS row FROM {table} t').fetchall()
            result[table] = sorted(json.dumps(row['row'], sort_keys=True) for row in rows)
        result['revisions'] = conn.execute('SELECT user_id,revision FROM inventory_owner ORDER BY user_id').fetchall()
        return result


def refused(response, code, status=409):
    assert response.status_code == status, response.text
    assert response.json()['detail']['code'] == code, response.text


def void(owner, key, account=None):
    return call('POST', '/api/loans/command-keys/void', owner,
                {'idempotency_key': str(key), 'account_id': account or owner})


def setup_send():
    edition = seed_swap_catalog()['PAL 185']
    borrower, lender = pair()
    source = node(lender, 'Unsorted')['id']
    hold(lender, source, edition, 3)
    return borrower, lender, edition, source


def borrow_body(lender, edition, key=None):
    return {'lender_id': lender, 'lines': [{'edition_id': edition, 'quantity': '1'}],
            'idempotency_key': str(key or uuid4())}


def send(owner, body):
    return call('POST', '/api/loans', owner, body)


def receipt(owner, key):
    with connect() as conn:
        return conn.execute('SELECT * FROM location_command WHERE owner_id=%s AND request_key=%s', (owner, key)).fetchone()


def test_response_loss_then_identical_replay_returns_the_stored_loan_and_creates_one(store):
    borrower, lender, edition, _ = setup_send()
    body = borrow_body(lender, edition)
    first = ok(send(borrower, body), 201)
    before = snapshot()
    assert ok(send(borrower, body), 201) == first
    assert snapshot() == before
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM loan WHERE borrower_id=%s', (borrower,)).fetchone()['n'] == 1


def test_void_after_an_applied_send_answers_applied_and_changes_nothing(store):
    borrower, lender, edition, _ = setup_send()
    body = borrow_body(lender, edition)
    ok(send(borrower, body), 201)
    before = snapshot()
    assert ok(void(borrower, body['idempotency_key'])) == {'outcome': 'applied', 'account_id': borrower}
    assert snapshot() == before


def test_void_is_idempotent(store):
    borrower, _ = pair()
    key = uuid4()
    assert ok(void(borrower, key)) == {'outcome': 'void', 'account_id': borrower}
    before = snapshot()
    assert ok(void(borrower, key)) == {'outcome': 'void', 'account_id': borrower}
    assert snapshot() == before
    row = receipt(borrower, key)
    assert row['request_digest'] == VOID_DIGEST and row['response'] == {}
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE user_id=%s AND kind='loan_command'",
                            (borrower,)).fetchone()['n'] == 1


@pytest.mark.parametrize('race_void', [False, True])
def test_two_identical_requests_or_a_replay_and_a_void_racing_agree(store, race_void):
    borrower, lender, edition, _ = setup_send()
    body = borrow_body(lender, edition)
    gate = threading.Barrier(2)
    def run(fn):
        gate.wait(timeout=10)
        return fn()
    with ThreadPoolExecutor(2) as pool:
        a = pool.submit(run, lambda: send(borrower, body))
        b = pool.submit(run, lambda: void(borrower, body['idempotency_key']) if race_void else send(borrower, body))
        original, other = a.result(), b.result()
    if not race_void:
        assert ok(original, 201) == ok(other, 201)
    elif original.status_code == 201:
        assert ok(other)['outcome'] == 'applied'
    else:
        refused(original, 'IDEMPOTENCY_KEY_VOID')
        assert ok(other)['outcome'] == 'void'
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM loan WHERE borrower_id=%s', (borrower,)).fetchone()['n'] == (original.status_code == 201)


def tagged_connections(monkeypatch):
    name = ContextVar('s1_connection_name', default='s1-unlabelled')
    def opened():
        conn = connect()
        conn.execute("SELECT set_config('application_name', %s, false)", (name.get(),))
        return conn
    monkeypatch.setattr(loan_inventory, 'connect', opened)
    def run(label, fn):
        token = name.set(label)
        try:
            return fn()
        finally:
            name.reset(token)
    return run


def waiting(watch, name, future):
    deadline = time.monotonic() + 10
    while not watch.execute("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() "
                           "AND application_name=%s AND wait_event_type='Lock'", (name,)).fetchone():
        if future.done():
            future.result()
            pytest.fail(f'{name} finished before waiting for its lock')
        assert time.monotonic() < deadline, f'{name} did not wait for its lock'


@pytest.mark.parametrize('void_first', [False, True])
@pytest.mark.parametrize('moving', [False, True])
def test_command_and_void_queued_on_command_or_owner_lock(store, monkeypatch, void_first, moving):
    borrower, lender, edition, _ = setup_send()
    key = uuid4()
    if moving:
        loan = lend(borrower, lender, edition, 1)
        source, target = node(borrower, 'Unsorted')['id'], place(borrower, 'Target')
        body = {'loan_id': loan['id'], 'edition_id': edition, 'from_location_id': source,
                'to_location_id': target, 'quantity': '1', 'idempotency_key': str(key)}
        original = lambda: call('POST', '/api/loans/borrowed/move', borrower, body)
    else:
        original = lambda: send(borrower, borrow_body(lender, edition, key))
    cancelled = lambda: void(borrower, key)
    run = tagged_connections(monkeypatch)
    with connect() as holder, connect(autocommit=True) as watch, ThreadPoolExecutor(2) as pool:
        if moving:
            holder.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR NO KEY UPDATE', (borrower,))
        else:
            holder.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.loan_command:' || %s))", (borrower,))
        first = pool.submit(run, 's1-first', cancelled if void_first else original)
        try:
            waiting(watch, 's1-first', first)
            second = pool.submit(run, 's1-second', original if void_first else cancelled)
            waiting(watch, 's1-second', second)
        finally:
            holder.commit()
        a, b = first.result(), second.result()
    original_response, void_response = (b, a) if void_first else (a, b)
    if void_first:
        refused(original_response, 'IDEMPOTENCY_KEY_VOID')
        assert ok(void_response)['outcome'] == 'void'
    else:
        ok(original_response, 200 if moving else 201)
        assert ok(void_response)['outcome'] == 'applied'


def test_the_receipt_key_alone_fences_an_original_past_its_lookup(store, monkeypatch):
    borrower, lender, edition, _ = setup_send()
    key = uuid4()
    reached, resume = threading.Event(), threading.Event()
    real = loan_inventory.lock_owners
    def paused(conn, *owners):
        reached.set()
        assert resume.wait(timeout=10)
        return real(conn, *owners)
    monkeypatch.setattr(loan_inventory, 'lock_owners', paused)
    with ThreadPoolExecutor(1) as pool:
        original = pool.submit(send, borrower, borrow_body(lender, edition, key))
        try:
            assert reached.wait(timeout=10)
            with connect() as conn:
                conn.execute("INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,'{}')",
                             (borrower, key, VOID_DIGEST))
            before = snapshot()
        finally:
            resume.set()
        with pytest.raises(psycopg.errors.UniqueViolation):
            original.result()
    assert snapshot() == before


ROUTES = ['borrow', 'offer', 'move', 'accept', 'accept-offer', 'decline', 'withdraw', 'cancel', 'handover',
          'picks/use-suggested', 'take-back', 'returns', 'returns/confirm', 'write-off', 'written-off',
          'return-by', 'extension', 'extension/approve', 'extension/decline']


def route_body(route, lender, edition, source, key):
    loan_id = str(uuid4())
    body = {'revision': 1, 'idempotency_key': str(key)}
    if route == 'borrow':
        return '/api/loans', borrow_body(lender, edition, key)
    if route == 'offer':
        return '/api/loans/offers', {'borrower_id': lender, 'copies': [
            {'location_id': source, 'edition_id': edition, 'quantity': '1'}], 'idempotency_key': str(key)}
    if route == 'move':
        return '/api/loans/borrowed/move', {'loan_id': loan_id, 'edition_id': edition,
            'from_location_id': source, 'to_location_id': str(uuid4()), 'quantity': '1', 'idempotency_key': str(key)}
    if route in ('accept', 'accept-offer'):
        body['lines'] = [{'edition_id': edition, 'promised': '1'}]
    if route in ('returns', 'write-off'):
        body['lines'] = [{'edition_id': edition, 'quantity': '1'}]
    if route == 'written-off':
        body.update(choice='keep', places=[{'location_id': source, 'edition_id': edition, 'copies': '1'}])
    if route in ('return-by', 'extension'):
        body['return_by'] = '2099-01-31'
    social = route in ('decline', 'withdraw', 'cancel', 'return-by', 'extension', 'extension/approve', 'extension/decline')
    return f"/api/{'social/loans' if social else 'loans'}/{loan_id}/{route}", body


@pytest.mark.parametrize('route', ROUTES)
def test_every_loan_route_refuses_a_voided_key(store, route):
    borrower, lender, edition, source = setup_send()
    key = uuid4()
    ok(void(borrower, key))
    path, body = route_body(route, lender, edition, source, key)
    before = snapshot()
    refused(call('POST', path, borrower, body), 'IDEMPOTENCY_KEY_VOID')
    assert snapshot() == before


def test_a_voided_key_on_a_location_route_is_refused(store):
    borrower, _ = pair()
    key = uuid4()
    ok(void(borrower, key))
    before = snapshot()
    refused(call('POST', '/api/location-tree', borrower, {'name': 'Cancelled', 'kind': 'storage_leaf',
                                                        'idempotency_key': str(key)}), 'IDEMPOTENCY_KEY_VOID')
    assert snapshot() == before


@pytest.mark.parametrize('cancel', [False, True])
def test_a_refused_replay_only_fences_a_delayed_original_if_voided(store, cancel):
    edition = seed_swap_catalog()['PAL 185']
    borrower, lender = pair()
    body = borrow_body(lender, edition)
    before = snapshot()
    refused(send(borrower, body), 'NOT_LENDABLE')
    assert snapshot() == before
    hold(lender, node(lender, 'Unsorted')['id'], edition, 2)
    if cancel:
        ok(void(borrower, body['idempotency_key']))
        before = snapshot()
        refused(send(borrower, body), 'IDEMPOTENCY_KEY_VOID')
        assert snapshot() == before
    else:
        ok(send(borrower, body), 201)


def test_a_new_key_after_a_void_applies_once_and_the_delayed_original_is_refused(store):
    borrower, lender, edition, _ = setup_send()
    old = borrow_body(lender, edition)
    ok(void(borrower, old['idempotency_key']))
    new = borrow_body(lender, edition)
    answer = ok(send(borrower, new), 201)
    before = snapshot()
    assert ok(send(borrower, new), 201) == answer
    refused(send(borrower, old), 'IDEMPOTENCY_KEY_VOID')
    assert snapshot() == before


def test_a_voided_key_with_an_invalid_body_gets_the_validation_error_and_writes_nothing(store):
    borrower, _ = pair()
    key = uuid4()
    ok(void(borrower, key))
    before = snapshot()
    assert send(borrower, {'idempotency_key': str(key)}).status_code == 422
    assert snapshot() == before


def old_replay(conn, user_id, key, payload):
    # Frozen dev 34d4b8d location_tree.py:238-245, before the sentinel check.
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    row = conn.execute("SELECT request_digest,response FROM location_command WHERE owner_id=%s AND request_key=%s", (user_id, key)).fetchone()
    if row:
        if row['request_digest'] != digest:
            raise HTTPException(409, {'code': 'IDEMPOTENCY_KEY_REUSED'})
        return digest, row['response']
    return digest, None


def test_old_replay_code_refuses_the_sentinel_with_key_reused_and_writes_nothing(store):
    borrower, _ = pair()
    key = uuid4()
    ok(void(borrower, key))
    before = snapshot()
    with connect() as conn, pytest.raises(HTTPException) as caught:
        old_replay(conn, borrower, key, {'action': 'loan_send'})
    assert caught.value.status_code == 409 and caught.value.detail['code'] == 'IDEMPOTENCY_KEY_REUSED'
    assert snapshot() == before


def test_void_digest_is_never_a_sha256_digest():
    assert VOID_DIGEST == 'void:v1'
    assert re.fullmatch('[0-9a-f]{64}', VOID_DIGEST) is None


def test_a_refusal_and_a_deadlock_leave_no_receipt(store, monkeypatch):
    borrower, lender, edition, _ = setup_send()
    body = borrow_body(lender, edition)
    before = snapshot()
    def deadlock(*args):
        raise psycopg.errors.DeadlockDetected()
    with monkeypatch.context() as patch:
        patch.setattr(loan_inventory, 'lock_owners', deadlock)
        patch.setattr(test_holdings, 'client', TestClient(test_holdings.app, raise_server_exceptions=False))
        assert send(borrower, body).status_code == 500

        assert receipt(borrower, body['idempotency_key']) is None
        assert snapshot() == before
        refused(void(borrower, uuid4()), 'INVENTORY_TEMPORARILY_UNAVAILABLE', 503)
        assert snapshot() == before
    loan = sent(borrower, lender, [(edition, 1)])
    before = snapshot()
    with monkeypatch.context() as patch:
        patch.setattr(loans, 'lock_owners', deadlock)
        key = uuid4()
        refused(call('POST', f"/api/social/loans/{loan['id']}/decline", lender,
                     {'revision': loan['revision'], 'idempotency_key': str(key)}), 'INVENTORY_TEMPORARILY_UNAVAILABLE', 503)
        assert receipt(lender, key) is None
    assert snapshot() == before


def test_void_for_another_account_is_refused_and_writes_nothing(store):
    borrower, lender = pair()
    before = snapshot()
    refused(void(lender, uuid4(), borrower), 'ACCOUNT_CHANGED')
    assert snapshot() == before


def test_void_under_another_cookie_does_not_fence_the_first_accounts_key(store):
    borrower, lender, edition, _ = setup_send()
    key = uuid4()
    before = snapshot()
    refused(void(lender, key, borrower), 'ACCOUNT_CHANGED')
    assert snapshot() == before
    ok(send(borrower, borrow_body(lender, edition, key)), 201)


@pytest.mark.parametrize('route', ['borrow', 'offer', 'move', 'decline'])
def test_a_loan_mutation_naming_another_account_is_refused_before_any_write(store, route):
    borrower, lender, edition, source = setup_send()
    path, body = route_body(route, lender, edition, source, uuid4())
    body['account_id'] = lender
    before = snapshot()
    refused(call('POST', path, borrower, body), 'ACCOUNT_CHANGED')
    assert snapshot() == before


@pytest.mark.parametrize('route', ['borrow', 'offer', 'move'])
def test_account_id_is_not_part_of_any_loan_digest(store, route):
    borrower, lender, edition, source = setup_send()
    key = uuid4()
    if route == 'move':
        loan = lend(borrower, lender, edition, 1)
        path, body = route_body(route, lender, edition, source, key)
        body.update(loan_id=loan['id'], from_location_id=node(borrower, 'Unsorted')['id'],
                    to_location_id=place(borrower, 'Target'))
    else:
        path, body = route_body(route, lender, edition, source, key)
        if route == 'offer':
            borrower, lender = lender, borrower
            body['borrower_id'] = lender
    first = ok(call('POST', path, borrower, body), 200 if route == 'move' else 201)
    digest = receipt(borrower, key)['request_digest']
    model = {'borrow': DevSendBorrowRequest, 'offer': DevSendLendOffer, 'move': DevMoveBorrowed}[route]
    action = {'borrow': 'loan_send', 'offer': 'loan_offer', 'move': 'move_borrowed'}[route]
    old_payload = {'action': action, **model.model_validate(body).model_dump(mode='json', exclude={'idempotency_key'})}
    assert digest == hashlib.sha256(json.dumps(old_payload, sort_keys=True, default=str).encode()).hexdigest()
    before = snapshot()
    assert ok(call('POST', path, borrower, {**body, 'account_id': borrower}), 200 if route == 'move' else 201) == first
    assert receipt(borrower, key)['request_digest'] == digest
    assert snapshot() == before


# Frozen pre-D3 model bodies read with git show at the two reviewed heads.


class DevLoanLineRequest(BaseModel):
    edition_id: UUID
    quantity: str


class DevOfferedCopies(BaseModel):
    """Copies of one Holding the lender selected: its Location and Card Edition."""
    location_id: UUID
    edition_id: UUID
    quantity: str


class DevSendBorrowRequest(BaseModel):
    """A Borrow Request to a Friend (``lender_id``, a ``collector_id`` the Friends list or a Friend read gave)."""
    lender_id: str = Field(min_length=1, max_length=200)
    lines: list[DevLoanLineRequest] = Field(min_length=1, max_length=MAX_LOAN_LINES)
    # One of the borrower's own Decks, or None for Unsorted.
    deck_id: UUID | None = None
    return_by: date | None = None
    # A Borrow Request of the caller's to the same Friend, still unanswered, that this one replaces.
    replaces: UUID | None = None
    idempotency_key: UUID


class DevSendLendOffer(BaseModel):
    """A Lend Offer to a Friend (``borrower_id``, a ``collector_id`` the Friends list gave) of the copies the lender
    selected in their Collection (#258)."""
    borrower_id: str = Field(min_length=1, max_length=200)
    copies: list[DevOfferedCopies] = Field(min_length=1, max_length=200)
    return_by: date | None = None
    idempotency_key: UUID


class DevMoveBorrowed(BaseModel):
    """Moves ``quantity`` of one Loan's Borrowed Copies of a card from one of the collector's Locations to another."""
    loan_id: UUID
    edition_id: UUID
    from_location_id: UUID
    to_location_id: UUID
    quantity: str
    idempotency_key: UUID


class DevLoanStep(BaseModel):
    revision: int = Field(ge=1)
    idempotency_key: UUID


class StackLoanLineRequest(BaseModel):
    edition_id: UUID
    quantity: str


class StackOfferedCopies(BaseModel):
    """Copies of one Holding the lender selected: its Location and Card Edition."""
    location_id: UUID
    edition_id: UUID
    quantity: str


class StackSendBorrowRequest(BaseModel):
    model_config = {"extra": "forbid"}
    """A Borrow Request to a Friend (``lender_id``, a ``collector_id`` the Friends list or a Friend read gave)."""
    lender_id: str = Field(min_length=1, max_length=200)
    lines: list[StackLoanLineRequest] = Field(min_length=1, max_length=MAX_LOAN_LINES)
    # One of the borrower's own Decks, or None for Unsorted.
    deck_id: UUID | None = None
    return_by: date | None = None
    idempotency_key: UUID


class StackSendLendOffer(BaseModel):
    """A Lend Offer to a Friend (``borrower_id``, a ``collector_id`` the Friends list gave) of the copies the lender
    selected in their Collection (#258)."""
    borrower_id: str = Field(min_length=1, max_length=200)
    copies: list[StackOfferedCopies] = Field(min_length=1, max_length=200)
    return_by: date | None = None
    idempotency_key: UUID


class StackMoveBorrowed(BaseModel):
    """Moves ``quantity`` of one Loan's Borrowed Copies of a card from one of the collector's Locations to another."""
    loan_id: UUID
    edition_id: UUID
    from_location_id: UUID
    to_location_id: UUID
    quantity: str
    idempotency_key: UUID


class StackLoanStep(BaseModel):
    model_config = {"extra": "forbid"}
    loan_id: UUID
    revision: int = Field(ge=1)
    idempotency_key: UUID


@pytest.mark.parametrize('model,kind,forbidden', [
    (DevSendBorrowRequest, 'borrow', False), (DevSendLendOffer, 'offer', False),
    (DevMoveBorrowed, 'move', False), (DevLoanStep, 'decline', False),
    (StackSendBorrowRequest, 'borrow', True), (StackSendLendOffer, 'offer', False),
    (StackMoveBorrowed, 'move', False), (StackLoanStep, 'decline', True),
])
def test_new_client_body_against_pre_d3_models(model, kind, forbidden):
    _, body = route_body(kind, 'friend', str(uuid4()), str(uuid4()), uuid4())
    if model is StackLoanStep:
        body['loan_id'] = str(uuid4())
    body['account_id'] = 'original-account'
    if forbidden:
        with pytest.raises(ValidationError) as caught:
            model.model_validate(body)
        assert any(e['loc'] == ('account_id',) and e['type'] == 'extra_forbidden' for e in caught.value.errors())
    else:
        assert 'account_id' not in model.model_validate(body).model_dump()


@pytest.mark.parametrize('moving', [False, True])
def test_pre_d3_new_client_under_another_cookie_runs_there_but_cannot_settle_the_first_accounts_key(store, monkeypatch, moving):
    borrower, lender, edition, source = setup_send()
    original_account, _ = pair()
    key = uuid4()
    if moving:
        loan = lend(borrower, lender, edition, 1)
        cookie = borrower
        path, body = route_body('move', lender, edition, source, key)
        body.update(loan_id=loan['id'], from_location_id=node(borrower, 'Unsorted')['id'],
                    to_location_id=place(borrower, 'Target'))
    else:
        cookie = lender
        path, body = route_body('offer', borrower, edition, source, key)
    body['account_id'] = original_account
    before = snapshot()
    refused(call('POST', path, cookie, body), 'ACCOUNT_CHANGED')
    assert snapshot() == before
    with monkeypatch.context() as patch:
        patch.setattr(loans, 'assert_account', lambda *_: None)
        ok(call('POST', path, cookie, body), 200 if moving else 201)
    assert receipt(cookie, key) is not None
    assert receipt(original_account, key) is None
    assert snapshot() != before
    with connect() as conn:
        if moving:
            row = conn.execute('SELECT quantity FROM borrowed_holding WHERE borrower_id=%s AND location_id=%s',
                               (cookie, body['to_location_id'])).fetchone()
            assert row['quantity'] == 1
        else:
            row = conn.execute('SELECT lender_id FROM loan WHERE id=%s', (receipt(cookie, key)['response']['id'],)).fetchone()
            assert row['lender_id'] == cookie
    assert ok(void(original_account, key)) == {'outcome': 'void', 'account_id': original_account}
    before = snapshot()
    refused(call('POST', path, original_account, body), 'IDEMPOTENCY_KEY_VOID')
    assert snapshot() == before


def test_old_client_body_without_account_id_under_another_cookie_runs_there(store):
    borrower, lender, edition, _ = setup_send()
    body = borrow_body(lender, edition)
    original_account, _ = pair()
    answer = ok(send(borrower, body), 201)
    assert receipt(original_account, body['idempotency_key']) is None
    assert answer['role'] == 'borrower'
    assert receipt(borrower, body['idempotency_key']) is not None


def at_limit(owner):
    with connect() as conn:
        conn.execute("DELETE FROM handle_lookup_event WHERE user_id=%s AND kind='loan_command'", (owner,))
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) "
                     "SELECT %s,'loan_command' FROM generate_series(1,%s)", (owner, COMMANDS_PER_HOUR))


def test_void_at_the_hourly_limit_is_429_and_writes_nothing(store):
    borrower, _ = pair()
    at_limit(borrower)
    before = snapshot()
    refused(void(borrower, uuid4()), 'TOO_MANY_CHANGES', 429)
    assert snapshot() == before


@pytest.mark.parametrize('applied', [False, True])
def test_void_of_an_existing_row_at_the_limit_answers(store, applied):
    borrower, lender, edition, _ = setup_send()
    key = uuid4()
    if applied:
        ok(send(borrower, borrow_body(lender, edition, key)), 201)
    else:
        ok(void(borrower, key))
    at_limit(borrower)
    before = snapshot()
    assert ok(void(borrower, key)) == {'outcome': 'applied' if applied else 'void', 'account_id': borrower}
    assert snapshot() == before
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE user_id=%s AND kind='loan_command'",
                            (borrower,)).fetchone()['n'] == COMMANDS_PER_HOUR


def test_database_isolation_is_read_committed():
    with connect() as conn:
        assert conn.execute('SHOW default_transaction_isolation').fetchone()['default_transaction_isolation'] == 'read committed'
