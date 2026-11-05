"""Needs you and pulse count the same items, regardless of paging or closure."""
import pytest

from app.main import connect
from test_deck_cost import launches, store  # noqa: F401
from test_friend_copies import collector, ok
from test_holdings import call
from test_threads import message, thread, timeline


@pytest.mark.parametrize('case', ['old_waiting', 'closed_unread', 'both', 'unread_only'])
def test_badge_equals_unpaged_needs_you_rows(store, case):
    a, _ = collector()
    b, _ = collector()
    if case == 'old_waiting':
        target, _ = thread(a, b, age=100)
        for _ in range(51):
            thread(b, a)
    elif case == 'closed_unread':
        target, _ = thread(a, b, closed=True)
        ok(message(a, target), 201)
    elif case == 'both':
        target, _ = thread(a, b)
        ok(message(a, target), 201)
    else:
        target, _ = thread(b, a)
        ok(message(a, target), 201)
    rows = ok(call('GET', '/api/trades?group=needs_you', b))
    counts = ok(call('GET', '/api/threads/pulse', b))['trades']
    assert [r['id'] for r in rows] == [str(target)]
    assert counts == {'needs_you': 1, 'waiting': int(case in ('old_waiting', 'both')),
                      'unread': int(case != 'old_waiting')}
    if case != 'old_waiting':
        cursor = timeline(b, target)['items'][0]['cursor']
        ok(call('POST', f'/api/trades/{target}/read', b, {'through': cursor}))
        counts = ok(call('GET', '/api/threads/pulse', b))['trades']
        assert counts['unread'] == 0
        assert counts['waiting'] == int(case == 'both')


def test_loan_counts_and_pulse_is_read_only(store):
    a, _ = collector()
    b, _ = collector()
    tid, _ = thread(a, b, kind='loan')
    ok(message(b, tid, kind='loans'), 201)
    first = ok(call('GET', '/api/threads/pulse', a))
    second = ok(call('GET', '/api/threads/pulse', a))
    rows = ok(call('GET', '/api/loans?group=needs_you', a))
    assert first == second
    assert first['loans'] == {'needs_you': len(rows), 'waiting': 1, 'unread': 1}
    with connect() as conn:
        assert conn.execute('SELECT read_at FROM thread_member WHERE thread_id=%s AND member_id=%s',
                            (tid, a)).fetchone()['read_at'] is None


def test_watermark_moves_on_read_block_and_suspension_but_not_rename(store):
    a, _ = collector()
    b, _ = collector()
    tid, _ = thread(a, b, closed=True)
    ok(message(a, tid), 201)
    def pulse():
        return ok(call('GET', '/api/threads/pulse', b))['watermark']
    first = pulse()
    with connect() as conn:
        conn.execute("UPDATE collector_profile SET display_name='New name' WHERE user_id=%s", (a,))
    assert pulse() == first
    cursor = timeline(b, tid)['items'][0]['cursor']
    ok(call('POST', f'/api/trades/{tid}/read', b, {'through': cursor}))
    read = pulse()
    assert read != first
    with connect() as conn:
        conn.execute('INSERT INTO block(blocker_id,blocked_id) VALUES (%s,%s)', (a, b))
    blocked = pulse()
    assert blocked != read
    with connect() as conn:
        conn.execute('DELETE FROM block WHERE blocker_id=%s AND blocked_id=%s', (a, b))
        conn.execute('UPDATE collector_profile SET suspended_at=now() WHERE user_id=%s', (a,))
    assert pulse() != blocked


@pytest.mark.parametrize('kind', ['trade', 'loan'])
def test_pulse_equals_list_marks_without_loading_any_presentation(store, monkeypatch, kind):
    from app.social import threads
    a, _ = collector()
    b, _ = collector()
    tid, _ = thread(a, b, kind=kind)
    # Trade recipient / Loan lender is waiting; also give that reader unread chat.
    reader, sender = (b, a) if kind == 'trade' else (a, b)
    ok(message(sender, tid, kind=kind + 's'), 201)
    rows = ok(call('GET', f'/api/{kind}s?group=needs_you', reader))
    def forbidden(*args, **kwargs):
        raise AssertionError('pulse must never build list/card/timeline presentations')
    monkeypatch.setattr(threads, 'thread_items', forbidden)
    monkeypatch.setattr(threads, 'card_facts', forbidden)
    monkeypatch.setattr(threads, 'timeline_rows', forbidden)
    counts = ok(call('GET', '/api/threads/pulse', reader))[kind + 's']
    assert counts == {'needs_you': len(rows), 'waiting': sum(row['waiting'] is not None for row in rows),
                      'unread': sum(row['unread'] > 0 for row in rows)}


def test_read_closed_history_requires_no_round_facts_or_presentation_on_pulse(store, monkeypatch):
    from app.social import threads, trades, loans
    a, _ = collector()
    b, _ = collector()
    for kind in ('trade', 'loan'):
        for _ in range(8):
            thread(a, b, kind=kind, closed=True)
        assert ok(call('GET', f'/api/{kind}s?group=needs_you', a)) == []
    def forbidden(*args, **kwargs):
        raise AssertionError('read closed history must not load round facts or presentation')
    for module, name in ((threads, 'thread_items'), (threads, 'card_facts'), (threads, 'timeline_rows'),
                         (trades, 'trade_facts'), (loans, 'loan_facts')):
        monkeypatch.setattr(module, name, forbidden)
    pulse = ok(call('GET', '/api/threads/pulse', a))
    assert pulse['trades'] == pulse['loans'] == {'needs_you': 0, 'waiting': 0, 'unread': 0}


def test_list_presentation_reads_only_the_selected_group(store, monkeypatch):
    from app.social import threads
    from want_list_swap_fixtures import seed_swap_catalog
    editions = list(seed_swap_catalog().values())[:2]
    a, _ = collector()
    b, _ = collector()
    visible, visible_round = thread(a, b, closed=True)
    hidden, hidden_round = thread(a, b, closed=True)
    with connect() as conn:
        for rid, edition in zip((visible_round, hidden_round), editions):
            conn.execute("INSERT INTO trade_line(trade_id,side,edition_id,position,quantity) VALUES (%s,'proposer',%s,0,1)",
                         (rid, edition))
    ok(message(a, visible), 201)
    real_facts = threads.card_facts
    requested = []
    def cards(conn, ids):
        requested.extend(str(edition) for edition in ids)
        return real_facts(conn, ids)
    monkeypatch.setattr(threads, 'card_facts', cards)
    assert [row['id'] for row in ok(call('GET', '/api/trades?group=needs_you', b))] == [str(visible)]
    assert requested == [str(editions[0])]
    requested.clear()
    assert [row['id'] for row in ok(call('GET', '/api/trades?group=done', b))] == [str(hidden)]
    assert requested == [str(editions[1])]


def test_pulse_and_needs_you_list_use_the_same_lightweight_seam(store, monkeypatch):
    from app.social import threads
    a, _ = collector()
    b, _ = collector()
    tid, _ = thread(a, b)
    calls = []
    real = threads.needs_you_rows
    def marked(conn, user_id, kind, **kwargs):
        calls.append((user_id, kind, kwargs.get('all_marks', False)))
        return real(conn, user_id, kind, **kwargs)
    monkeypatch.setattr(threads, 'needs_you_rows', marked)
    assert len(ok(call('GET', '/api/trades?group=needs_you', b))) == 1
    assert calls == [(b, 'trade', False)]
    calls.clear()
    assert ok(call('GET', '/api/threads/pulse', b))['trades']['needs_you'] == 1
    assert calls == [(b, 'trade', True), (b, 'loan', True)]


def badge_fixture():
    reader, _ = collector('Reader')
    ash, _ = collector('Ash')
    brock, _ = collector('Brock')
    misty, _ = collector('Misty')
    ash_thread, ash_offer = thread(ash, reader)
    brock_thread, brock_offer = thread(brock, reader)
    misty_thread, _ = thread(misty, reader, closed=True)
    with connect() as conn:
        conn.execute("UPDATE trade SET state='accepted',accepted_at=now() WHERE id=%s", (brock_offer,))
    ok(message(ash, ash_thread), 201)
    ok(message(misty, misty_thread), 201)
    return reader, ash_thread, ash_offer, brock, brock_thread, misty_thread


def badge_counts(reader, waiting, unread, union):
    counts = ok(call('GET', '/api/threads/pulse', reader))['trades']
    rows = ok(call('GET', '/api/trades?group=needs_you', reader))
    assert counts == {'waiting': waiting, 'unread': unread, 'needs_you': union}
    assert len(rows) == union
    assert sum(row['waiting'] is not None for row in rows) == waiting
    assert sum(row['unread'] > 0 for row in rows) == unread
    # Same wording used by the web's itemTabName, with independent subtotals.
    return rows, f'Trades, {union} need you: {waiting} waiting on you, {unread} with new messages'


def open_badge_item(reader, tid):
    cursor = timeline(reader, tid)['items'][0]['cursor']
    ok(call('POST', f'/api/trades/{tid}/read', reader, {'through': cursor}))


def test_three_item_badge_walkthrough_keeps_waiting_after_open_and_refusal(store):
    from uuid import uuid4
    reader, ash, offer, brock, brock_thread, misty = badge_fixture()
    rows, label = badge_counts(reader, 2, 2, 3)
    assert {row['other']['display_name'] for row in rows} == {'Ash', 'Brock', 'Misty'}
    assert label == 'Trades, 3 need you: 2 waiting on you, 2 with new messages'
    # Both eligible participants of the agreed Brock item wait before either confirms.
    other_rows = ok(call('GET', '/api/trades?group=needs_you', brock))
    assert next(row for row in other_rows if row['id'] == str(brock_thread))['waiting'] == 'confirm_swap'
    open_badge_item(reader, ash)
    _, label = badge_counts(reader, 2, 1, 3)
    assert label == 'Trades, 3 need you: 2 waiting on you, 1 with new messages'
    bad = call('POST', f'/api/trades/{ash}/decline', reader,
               {'offer_id': str(offer), 'revision': 999, 'idempotency_key': str(uuid4())})
    assert bad.status_code == 409 and bad.json()['detail']['code'] == 'TRADE_CHANGED'
    badge_counts(reader, 2, 1, 3)
    ok(call('POST', f'/api/trades/{ash}/decline', reader,
            {'offer_id': str(offer), 'revision': 1, 'idempotency_key': str(uuid4())}))
    badge_counts(reader, 1, 1, 2)
    open_badge_item(reader, misty)
    rows, _ = badge_counts(reader, 1, 0, 1)
    assert rows[0]['other']['display_name'] == 'Brock'


def test_already_read_agreed_erika_is_a_fourth_distinct_item(store):
    reader, ash, _, _, _, _ = badge_fixture()
    erika, _ = collector('Erika')
    tid, rid = thread(erika, reader)
    ok(message(erika, tid), 201)
    open_badge_item(reader, tid)
    with connect() as conn:
        conn.execute("UPDATE trade SET state='accepted',accepted_at=now() WHERE id=%s", (rid,))
    rows, label = badge_counts(reader, 3, 2, 4)
    assert {row['other']['display_name'] for row in rows} == {'Ash', 'Brock', 'Misty', 'Erika'}
    assert label == 'Trades, 4 need you: 3 waiting on you, 2 with new messages'
    erika_row = next(row for row in rows if row['id'] == str(tid))
    assert erika_row['waiting'] == 'confirm_swap' and erika_row['unread'] == 0
    assert not any(row['id'] == str(tid) for row in ok(call('GET', '/api/trades?group=open', reader)))
    open_badge_item(reader, ash)
    badge_counts(reader, 3, 1, 4)


@pytest.mark.parametrize('kind', ['trade', 'loan'])
def test_reading_event_only_history_does_not_invalidate_lists_but_unread_reads_do(store, kind):
    from app.social.threads import write_event
    a, _ = collector()
    b, _ = collector()
    tid, rid = thread(a, b, kind=kind)
    with connect() as conn:
        write_event(conn, tid, 'accepted', rid, actor='low')
    def pulse():
        return ok(call('GET', '/api/threads/pulse', b))
    before = pulse()
    cursor = timeline(b, tid, kind=kind+'s')['items'][0]['cursor']
    ok(call('POST', f'/api/{kind}s/{tid}/read', b, {'through': cursor}))
    assert pulse() == before
    ok(message(a, tid, kind=kind+'s'), 201)
    ok(message(a, tid, kind=kind+'s'), 201)
    unread = pulse()
    assert unread[kind+'s']['unread'] == 1 and unread['watermark'] != before['watermark']
    items = timeline(b, tid, kind=kind+'s')['items']
    ok(call('POST', f'/api/{kind}s/{tid}/read', b, {'through': items[1]['cursor']}))
    partial = pulse()
    assert partial[kind+'s'] == unread[kind+'s']
    assert partial['watermark'] != unread['watermark']
    ok(call('POST', f'/api/{kind}s/{tid}/read', b, {'through': items[0]['cursor']}))
    read = pulse()
    assert read[kind+'s']['unread'] == 0 and read['watermark'] != partial['watermark']


def test_pulse_fingerprints_public_unread_marks_not_cursor_storage(monkeypatch):
    from contextlib import nullcontext
    from app.social import threads
    cursor = [1]
    unread = [0]
    class Connection:
        def transaction(self):
            return nullcontext()
        def execute(self, query, params=None):
            self.query = query
            return self
        def fetchone(self):
            value = {'n': 1, 'changed': 1}
            if 'm.read_at' in self.query:
                value.update(read=cursor[0], read_n=1)
            return value
        def fetchall(self):
            return []
    monkeypatch.setattr(threads, 'connect', lambda: nullcontext(Connection()))
    monkeypatch.setattr(threads, 'needs_you_rows', lambda conn, user, kind, **kwargs:
                        [{'id': kind, 'waiting': 'answer', 'unread': unread[0], 'needs_you': True}])
    before = threads.read_pulse('reader')
    cursor[0] += 1
    assert threads.read_pulse('reader') == before
    unread[0] = 2
    message = threads.read_pulse('reader')
    assert message.watermark != before.watermark and message.loans.unread == 1
    unread[0] = 1
    partial = threads.read_pulse('reader')
    assert partial.loans == message.loans and partial.watermark != message.watermark
