"""Loan thread protocol: exact returns, replay and privacy against PostgreSQL."""
from uuid import uuid4

import pytest

from app.main import connect  # noqa: F401
from test_catalog_targets import isolated_rules  # noqa: F401
from test_deck_cost import store  # noqa: F401
from test_deck_counting import hold
from test_friend_copies import ok, place
from test_holdings import call
from test_operation_counts import writer  # noqa: F401
from test_loans import accept, pair, sent, view
from test_returns import confirm_return, lent_loan, start_return
from want_list_swap_fixtures import seed_swap_catalog


def terms(user, loan, edition, copies, key=None, *, deck_id=None):
    return call('POST', f"/api/loans/{loan['thread_id']}/terms", user, {
        'loan_id': loan['loan_id'], 'revision': loan['revision'], 'idempotency_key': str(key or uuid4()),
        'lines': [{'edition_id': edition, 'quantity': str(copies)}], 'deck_id': deck_id, 'return_by': None})


def test_stale_confirm_cannot_confirm_a_later_return(store):
    edition, borrower, lender, _, loan, _ = lent_loan({'Binder': 3}, 3)
    a = ok(start_return(borrower, loan, [(edition, 1)]))
    stale = {'loan_id': a['loan_id'], 'return_id': a['pending_return']['return_id'],
             'revision': a['revision'], 'idempotency_key': str(uuid4())}
    ok(confirm_return(lender, loan))
    b = ok(start_return(borrower, loan, [(edition, 1)]))
    before = view(lender, b)
    response = call('POST', f"/api/loans/{loan['thread_id']}/returns/confirm", lender, stale)
    assert response.status_code == 409
    assert 'RETURN_CHANGED' in response.text
    assert view(lender, b) == before
    assert view(lender, b)['pending_return']['return_id'] == b['pending_return']['return_id']


def test_terms_replay_precedes_live_round_and_revision_checks(store):
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    hold(lender, place(lender, 'Binder'), edition, 4)
    loan = sent(borrower, lender, [(edition, 4)])
    key = uuid4()
    edited = ok(terms(borrower, loan, edition, 3, key))
    assert edited['thread_id'] == loan['thread_id']
    assert edited['loan_id'] != loan['loan_id']
    ok(accept(lender, edited, [(edition, 3)]))
    assert ok(terms(borrower, loan, edition, 3, key)) == edited
    assert terms(borrower, loan, edition, 2).status_code == 409
    with connect() as conn:
        events = conn.execute('SELECT kind, data FROM thread_event WHERE thread_id=%s',
                              (loan['thread_id'],)).fetchall()
    assert {'requested', 'edited', 'accepted'} <= {row['kind'] for row in events}
    assert all('location' not in str(row['data']) and 'deck' not in str(row['data']) for row in events)


def test_all_back_and_strict_handover_revision(store):
    edition, borrower, lender, _, loan, _ = lent_loan({'Binder': 2}, 2)
    response = call('POST', f"/api/loans/{loan['thread_id']}/handover", lender, {
        'loan_id': loan['loan_id'], 'revision': loan['revision'], 'idempotency_key': str(uuid4())})
    assert response.status_code == 409
    current = view(borrower, loan)
    ok(call('POST', f"/api/loans/{loan['thread_id']}/returns", borrower, {
        'loan_id': current['loan_id'], 'revision': current['revision'],
        'idempotency_key': str(uuid4()), 'all': True}))
    assert ok(confirm_return(lender, loan))['closed_reason'] == 'returned'


def test_old_social_mutation_route_is_gone(store):
    borrower, _ = pair()
    assert call('POST', f'/api/social/loans/{uuid4()}/withdraw', borrower, {}).status_code == 404


def test_partial_accept_logs_exact_diff_and_changed_return_date_without_picks(store):
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    secret = place(lender, 'Private binder')
    hold(lender, secret, edition, 4)
    loan = sent(borrower, lender, [(edition, 4)], return_by='2099-01-01')
    accepted = ok(call('POST', f"/api/loans/{loan['thread_id']}/accept", lender, {
        'loan_id': loan['loan_id'], 'revision': loan['revision'], 'idempotency_key': str(uuid4()),
        'lines': [{'edition_id': edition, 'promised': '3'}], 'return_by': '2099-02-01'}))
    assert accepted['state'] == 'accepted'
    assert accepted['return_by'] == '2099-02-01'
    timeline = ok(call('GET', f"/api/loans/{loan['thread_id']}/timeline", borrower))
    assert timeline['you_are'] in ('low', 'high')
    event = next(item['event'] for item in timeline['items'] if item['event'] and
                 item['event']['kind'] == 'partly_accepted')
    assert event['data'] == {
        'lines': [{'giver': 'high' if timeline['you_are'] == 'low' else 'low', 'edition_id': edition,
                   'from_qty': 4, 'to_qty': 3}],
        'not_lent': [{'edition_id': edition, 'quantity': 1}],
        'return_by': {'from': '2099-01-01', 'to': '2099-02-01'}}
    borrower_detail = ok(call('GET', f"/api/loans/{loan['thread_id']}", borrower))
    assert borrower_detail['live_terms']['loan_id'] == loan['loan_id']
    assert 'handle' not in borrower_detail['live_terms']['other']
    for payload in (timeline, borrower_detail):
        assert 'Private binder' not in str(payload) and secret not in str(payload)


def test_handover_rejects_stale_revision_while_step_is_still_allowed(store):
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    hold(lender, place(lender, 'Binder'), edition, 2)
    accepted = ok(accept(lender, sent(borrower, lender, [(edition, 2)]), [(edition, 2)]))
    ok(call('POST', f"/api/loans/{accepted['thread_id']}/return-by", lender, {
        'loan_id': accepted['loan_id'], 'revision': accepted['revision'],
        'idempotency_key': str(uuid4()), 'return_by': '2099-01-01'}))
    response = call('POST', f"/api/loans/{accepted['thread_id']}/handover", borrower, {
        'loan_id': accepted['loan_id'], 'revision': accepted['revision'], 'idempotency_key': str(uuid4())})
    assert (response.status_code, response.json()['detail']['code']) == (409, 'LOAN_CHANGED')
    assert not view(borrower, accepted)['you_confirmed_handover']


def test_end_loans_returns_threads_and_writes_one_closure_event_per_item(store):
    from uuid import UUID
    from app.social.loans import end_loans_between
    from app.social.owners import lock_owners
    from app.social.threads import touch_threads
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    hold(lender, place(lender, 'Binder'), edition, 3)
    requested = sent(borrower, lender, [(edition, 1)])
    accepted = ok(accept(lender, sent(borrower, lender, [(edition, 1)]), [(edition, 1)]))
    expected = {UUID(item['thread_id']) for item in (requested, accepted)}
    with connect() as conn, conn.transaction():
        lock_owners(conn, borrower, lender)
        touched = end_loans_between(conn, borrower, lender, 'closed_unfriended')
        assert touched == expected
        events = conn.execute("SELECT thread_id,kind FROM thread_event WHERE thread_id=ANY(%s) "
                              "AND kind LIKE 'closed_%%'", (list(expected),)).fetchall()
        assert {(row['thread_id'], row['kind']) for row in events} == {
            (tid, 'closed_unfriended') for tid in expected}
        assert len(events) == 2
        assert end_loans_between(conn, borrower, lender, 'closed_unfriended') == set()
        touch_threads(conn, list(touched))
    assert view(borrower, requested)['state'] == view(borrower, accepted)['state'] == 'closed'



def all_back(user, loan):
    current = view(user, loan)
    return call('POST', f"/api/loans/{loan['thread_id']}/returns", user, {
        'loan_id': current['loan_id'], 'revision': current['revision'],
        'idempotency_key': str(uuid4()), 'all': True})


def two_edition_loan(*, decline_arven):
    from test_handover import handover
    ids = seed_swap_catalog()
    borrower, lender = pair()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    binder = place(lender, 'Binder')
    hold(lender, binder, iono, 2)
    hold(lender, binder, arven, 1)
    requested = sent(borrower, lender, [(iono, 2), (arven, 1)])
    accepted = ok(accept(lender, requested, [(iono, 2), (arven, 0 if decline_arven else 1)]))
    ok(handover(lender, accepted))
    ok(handover(borrower, accepted))
    return borrower, lender, accepted, iono, arven


def assert_return_lines(loan, expected):
    pending = loan['pending_return']
    assert {line['edition_id']: line['copies'] for line in pending['lines']} == expected
    with connect() as conn:
        stored = conn.execute('SELECT edition_id, quantity FROM loan_return_line WHERE return_id=%s',
                              (pending['return_id'],)).fetchall()
    assert {str(row['edition_id']): str(row['quantity']) for row in stored} == expected
    assert all(row['quantity'] > 0 for row in stored)


def test_all_back_omits_declined_request_lines(store):
    borrower, lender, loan, iono, arven = two_edition_loan(decline_arven=True)
    returned = ok(all_back(borrower, loan))
    assert_return_lines(returned, {iono: '2'})
    assert arven not in {line['edition_id'] for line in returned['pending_return']['lines']}
    assert ok(confirm_return(lender, loan))['closed_reason'] == 'returned'


def test_all_back_omits_editions_already_fully_returned(store):
    borrower, lender, loan, iono, arven = two_edition_loan(decline_arven=False)
    ok(start_return(borrower, loan, [(iono, 2)]))
    first = ok(confirm_return(lender, loan))
    assert first['state'] == 'handed_over'
    returned = ok(all_back(borrower, loan))
    assert_return_lines(returned, {arven: '1'})
    assert iono not in {line['edition_id'] for line in returned['pending_return']['lines']}
    completed = ok(confirm_return(lender, loan))
    assert completed['closed_reason'] == 'returned'
    assert {line['edition_id']: line['returned'] for line in completed['lines']} == {iono: '2', arven: '1'}



@pytest.mark.parametrize('action', ['decline', 'withdraw', 'cancel'])
def test_never_accepted_closures_keep_requested_counts_without_false_line_changes(store, action):
    from uuid import UUID
    from app.social.loans import end_loans_between, event_snapshot
    from app.social.owners import lock_owners
    from app.social.threads import EventView, touch_threads
    from test_loans import step
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    hold(lender, place(lender, 'Binder'), edition, 3)
    loan = sent(borrower, lender, [(edition, 3)])
    if action == 'cancel':
        # A friendship closure cancels an unanswered request; its ordinary cancel action is unavailable.
        with connect() as conn, conn.transaction():
            lock_owners(conn, borrower, lender)
            touched = end_loans_between(conn, borrower, lender, 'closed_unfriended')
            assert touched == {UUID(loan['thread_id'])}
            touch_threads(conn, list(touched))
        expected_kind = 'closed_unfriended'
    else:
        ok(step(lender if action == 'decline' else borrower, loan, action))
        expected_kind = 'declined' if action == 'decline' else 'withdrawn'
    with connect() as conn:
        closed = conn.execute('SELECT * FROM loan WHERE id=%s', (loan['loan_id'],)).fetchone()
        assert closed['state'] == 'closed' and closed['accepted_at'] is None
        assert event_snapshot(conn, closed) == {edition: 3}
        events = conn.execute('SELECT id, actor, kind, round_id, return_id, data, created_at AS at '
                              'FROM thread_event WHERE thread_id=%s AND kind=%s',
                              (loan['thread_id'], expected_kind)).fetchall()
    assert len(events) == 1
    assert events[0]['data'].get('lines', []) == []
    # The public timeline schema validates stored event data and preserves its closed shape.
    assert EventView.model_validate(events[0]).model_dump(mode='json')['data'] == events[0]['data']


def test_accepted_then_closed_snapshot_uses_promised_counts_even_after_write_off(store):
    from app.social.loans import event_snapshot
    from test_handover import handover
    from test_write_off import write_off
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    hold(lender, place(lender, 'Binder'), edition, 3)
    requested = sent(borrower, lender, [(edition, 3)])
    accepted = ok(accept(lender, requested, [(edition, 2)]))
    ok(handover(lender, accepted))
    ok(handover(borrower, accepted))
    ok(write_off(lender, accepted, [(edition, 1)]))
    from test_write_off import choose
    ok(choose(borrower, accepted, 'remove'))
    ok(start_return(borrower, accepted, [(edition, 1)]))
    completed = ok(confirm_return(lender, accepted))
    assert completed['state'] == 'closed' and completed['closed_reason'] == 'written_off'
    with connect() as conn:
        closed = conn.execute('SELECT * FROM loan WHERE id=%s', (accepted['loan_id'],)).fetchone()
        assert closed['accepted_at'] is not None
        assert event_snapshot(conn, closed) == {edition: 2}
        events = conn.execute("SELECT data FROM thread_event WHERE thread_id=%s "
                              "AND kind IN ('return_recorded', 'return_confirmed')",
                              (accepted['thread_id'],)).fetchall()
    assert len(events) == 2
    assert all(event['data']['lines'] == [] for event in events)


def _terms_account_body(loan, edition, key, binding, borrower):
    body = {'loan_id': loan['loan_id'], 'revision': loan['revision'], 'idempotency_key': key,
            'lines': [{'edition_id': edition, 'quantity': '3'}], 'deck_id': None, 'return_by': None}
    if binding != 'omitted':
        body['account_id'] = borrower if binding == 'correct' else None
    return body


def _terms_full_state():
    from psycopg import sql
    with connect() as conn:
        tables = [row['tablename'] for row in conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")]
        return {table: conn.execute(sql.SQL('SELECT to_jsonb(t) AS row FROM {} t ORDER BY to_jsonb(t)::text')
                                    .format(sql.Identifier(table))).fetchall() for table in tables}


def _terms_account_setup():
    ids = seed_swap_catalog()
    borrower, lender = pair()
    edition = ids['PAL 185']
    hold(lender, place(lender, 'Account neutral Binder'), edition, 4)
    return borrower, lender, edition, sent(borrower, lender, [(edition, 4)])


def _save_terms_account_proof(key, record):
    import json
    import os
    from pathlib import Path
    directory = Path(os.environ['TEST_LOG_DIR']) / 'ta-u01-proofs'
    directory.mkdir(exist_ok=True)
    with (directory / f'{key}.json').open('x') as stream:
        json.dump(record, stream, default=str, sort_keys=True)
    print('TA-U01', key, record['first_binding'], record.get('retry_binding', 'wrong'),
          [reply['status'] for reply in record['retries']], record['all_states_equal'])


@pytest.mark.parametrize('first_binding,retry_binding', [
    ('omitted', 'null'), ('omitted', 'correct'), ('null', 'omitted'),
    ('null', 'correct'), ('correct', 'omitted'), ('correct', 'null'),
])
def test_terms_replay_is_account_neutral(store, writer, first_binding, retry_binding):
    # Operational telemetry alone is controlled through its established fixture;
    # every domain/receipt/quota writer and every public table remains real.
    writer(None)
    borrower, lender, edition, loan = _terms_account_setup()
    key = str(uuid4())
    path = f"/api/loans/{loan['thread_id']}/terms"
    original_body = _terms_account_body(loan, edition, key, first_binding, borrower)
    first = call('POST', path, borrower, original_body)
    assert first.status_code == 200, first.text
    edited = first.json()
    accepted = ok(accept(lender, edited, [(edition, 3)]))
    assert accepted['state'] == 'accepted' and accepted['revision'] > edited['revision']
    before = _terms_full_state()
    retried_body = _terms_account_body(loan, edition, key, retry_binding, borrower)
    responses, states = [], [before]
    for _ in range(2):
        response = call('POST', path, borrower, retried_body)
        responses.append(response)
        states.append(_terms_full_state())
    proof = {'first_binding': first_binding, 'retry_binding': retry_binding,
             'first_body': original_body, 'retry_body': retried_body,
             'first_response': {'status': first.status_code, 'body': first.json()},
             'later_accepted_revision': accepted['revision'],
             'retries': [{'status': r.status_code, 'body': r.json()} for r in responses],
             'snapshots': states, 'all_states_equal': all(state == before for state in states)}
    _save_terms_account_proof(key, proof)
    assert proof['all_states_equal']
    for response in responses:
        assert response.status_code == 200, response.text
        assert response.content == first.content


@pytest.mark.parametrize('first_binding', ['omitted', 'null', 'correct'])
def test_terms_wrong_account_precedes_replay(store, writer, first_binding):
    writer(None)
    borrower, lender, edition, loan = _terms_account_setup()
    key = str(uuid4())
    path = f"/api/loans/{loan['thread_id']}/terms"
    first_body = _terms_account_body(loan, edition, key, first_binding, borrower)
    first = call('POST', path, borrower, first_body)
    assert first.status_code == 200, first.text
    ok(accept(lender, first.json(), [(edition, 3)]))
    before = _terms_full_state()
    wrong_body = {**first_body, 'account_id': lender}
    responses, states = [], [before]
    for _ in range(2):
        response = call('POST', path, borrower, wrong_body)
        responses.append(response)
        states.append(_terms_full_state())
    proof = {'first_binding': first_binding, 'first_body': first_body, 'wrong_body': wrong_body,
             'first_response': {'status': first.status_code, 'body': first.json()},
             'retries': [{'status': r.status_code, 'body': r.json()} for r in responses],
             'snapshots': states, 'all_states_equal': all(state == before for state in states)}
    _save_terms_account_proof(key, proof)
    assert proof['all_states_equal']
    for response in responses:
        assert response.status_code == 409 and response.json() == {'detail': {'code': 'ACCOUNT_CHANGED'}}
