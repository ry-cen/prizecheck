"""Historical pre-162 Conversation triggers and current thread-scoped chat contracts.

The historical fixtures retain migration 147's assertions. Live API tests cover
item identity, isolation, messages, cursors, quotas, availability and lock races.
"""
import base64
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi import HTTPException
from psycopg.rows import dict_row

from app.main import connect  # noqa: F401
from app.social import conversations, trades
from app.social.conversations import normalize_text
from app.social.owners import lock_owners
from test_catalog_references import migrate
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import store  # noqa: F401  (autouse fixtures)
from stranger_fixtures import far_zip, propose_to, strangers
from test_ending_friendship import remove
from test_friend_copies import block, collector, ok
from test_holdings import call
from test_loan_promises import _waiting_on_a_row
from test_loans import pair
from test_open_discovery import discoverable
from test_trade_migrations import collector as owner_row, run_again, scratch  # noqa: F401
from test_threads import thread as make_thread, message as thread_message, timeline as thread_timeline
from test_trades import accept_trade, countered, handle_of, proposed, propose, read, trade_step, trading

MIGRATION = '147_conversations.sql'
INDEXES = ('conversation_member_member', 'message_timeline', 'conversation_user_high', 'trade_conversation',
           'trade_completed_proposer', 'trade_completed_recipient')


def pair_ids():
    """Two account ids whose byte order differs from a locale order: the first sorts first in bytes."""
    return 'B-' + uuid4().hex, 'a-' + uuid4().hex


def friends(conn, one, two):
    low, high = sorted((one, two))
    conn.execute("""INSERT INTO friendship(user_low, user_high, state, requested_by)
      VALUES (%s, %s, 'accepted', %s)""", (low, high, low))


def old_trade(conn, proposer, recipient, state='closed', age_days=1, *, legacy=False):
    """One Trade by SQL, created ``age_days`` ago; a closed one is declined. Returns (id, created_at)."""
    if not legacy:
        _, trade = make_thread(proposer, recipient, closed=state == 'closed', age=age_days, conn=conn)
        row = conn.execute("""UPDATE trade SET state=%s,proposer_name='Proposer',recipient_name='Recipient',
          created_at=now()-make_interval(days=>%s),
          closed_at=CASE WHEN %s='closed' THEN now()-make_interval(days=>%s) END
          WHERE id=%s RETURNING created_at""", (state,age_days,state,age_days,trade)).fetchone()
        return trade, row['created_at']
    # Migration-147 seeds deliberately predate threads and are never used against 162.
    trade = uuid4()
    reason = 'declined' if state == 'closed' else None
    row = conn.execute("""INSERT INTO trade(id, state, closed_reason, proposer_id, recipient_id, proposer_name,
        recipient_name, created_at, closed_at)
      VALUES (%s, %s, %s, %s, %s, 'Proposer', 'Recipient', now() - make_interval(days => %s),
              CASE WHEN %s = 'closed' THEN now() - make_interval(days => %s) END)
      RETURNING created_at""", (trade, state, reason, proposer, recipient, age_days, state, age_days)).fetchone()
    return trade, row['created_at']


def test_migration_147_backfills_friends_now_and_open_trade_pairs_only_and_runs_again(scratch):
    migrate(scratch, before=MIGRATION)
    pairs = {name: pair_ids() for name in ('p1', 'p2', 'p3', 'p4', 'p5')}
    trades = {}
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        for low, high in pairs.values():
            owner_row(conn, low)
            owner_row(conn, high)
        # P1: Friends, two closed Trades (one proposed from each side). Covered.
        friends(conn, *pairs['p1'])
        trades['p1'] = [old_trade(conn, pairs['p1'][0], pairs['p1'][1], age_days=3, legacy=True),
                        old_trade(conn, pairs['p1'][1], pairs['p1'][0], age_days=1, legacy=True)]
        # P2: not Friends, one proposed Trade. Covered.
        trades['p2'] = [old_trade(conn, pairs['p2'][1], pairs['p2'][0], state='proposed', age_days=2, legacy=True)]
        # P3: ex-Friends, only closed Trades. Not covered.
        trades['p3'] = [old_trade(conn, pairs['p3'][0], pairs['p3'][1], age_days=5, legacy=True)]
        # P4: Friends with no Trades. Not covered.
        friends(conn, *pairs['p4'])
        # P5: an accepted friendship and a Block, only closed Trades. Not covered.
        friends(conn, *pairs['p5'])
        conn.execute('INSERT INTO block(blocker_id, blocked_id) VALUES (%s, %s)', (pairs['p5'][1], pairs['p5'][0]))
        trades['p5'] = [old_trade(conn, pairs['p5'][0], pairs['p5'][1], age_days=4, legacy=True)]
    migrate(scratch, before='162_trade_loan_threads.sql')

    def snapshot(conn):
        return {name: conn.execute('SELECT count(*) AS n FROM ' + name).fetchone()['n']
                for name in ('conversation', 'conversation_member', 'message')}

    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        before = snapshot(conn)
        stamps = conn.execute('SELECT * FROM conversation ORDER BY id').fetchall()
    run_again(scratch, MIGRATION)
    run_again(scratch, MIGRATION)
    run_again(scratch, '141_trades.sql')
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        assert snapshot(conn) == before
        assert before == {'conversation': 2, 'conversation_member': 4, 'message': 0}
        assert conn.execute('SELECT * FROM conversation ORDER BY id').fetchall() == stamps
        for name in ('p1', 'p2'):
            low, high = pairs[name]
            [row] = conn.execute('SELECT * FROM conversation WHERE user_low = %s OR user_high = %s',
                                 (low, low)).fetchall()
            assert (row['user_low'], row['user_high']) == (low, high)
            assert row['user_low'].encode() < row['user_high'].encode()
            members = conn.execute('SELECT member_id, read_at, archived_at FROM conversation_member '
                                   'WHERE conversation_id = %s', (row['id'],)).fetchall()
            assert {member['member_id'] for member in members} == {low, high}
            assert all(member['read_at'] is None and member['archived_at'] is None for member in members)
            assert row['last_from_low_at'] is None and row['last_from_high_at'] is None
            assert row['created_at'] == min(created for _, created in trades[name])
            assert row['last_activity_at'] == max(created for _, created in trades[name])
            for trade, _ in trades[name]:
                assert conn.execute('SELECT conversation_id FROM trade WHERE id = %s',
                                    (trade,)).fetchone() == {'conversation_id': row['id']}
        for name in ('p3', 'p5'):
            for trade, _ in trades[name]:
                assert conn.execute('SELECT conversation_id FROM trade WHERE id = %s',
                                    (trade,)).fetchone() == {'conversation_id': None}
        for name in ('p3', 'p4', 'p5'):
            assert conn.execute('SELECT count(*) AS n FROM conversation WHERE user_low = %s',
                                (pairs[name][0],)).fetchone() == {'n': 0}


def test_migration_147_adds_its_indexes_triggers_and_checks(scratch):
    migrate(scratch, before='162_trade_loan_threads.sql')
    low, high = pair_ids()
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        indexes = {row['indexname']: row['indexdef'] for row in conn.execute(
            "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'")}
        assert set(INDEXES) <= set(indexes)
        for name in ('trade_completed_proposer', 'trade_completed_recipient'):
            assert 'proposer_swap_at IS NOT NULL' in indexes[name]
            assert 'recipient_swap_at IS NOT NULL' in indexes[name]
        triggers = {(row['tgrelid'], row['tgname']) for row in conn.execute(
            """SELECT tgname, tgrelid::regclass::text AS tgrelid FROM pg_trigger WHERE NOT tgisinternal""")}
        assert {('trade', 'trade_joins_conversation'), ('trade', 'trade_conversation_activity'),
                ('collector_profile', 'trade_names_follow_profile_conversations')} <= triggers
        assert conn.execute("SELECT 1 AS found FROM pg_proc WHERE proname = 'pair_conversation'").fetchone()

        owner_row(conn, low)
        owner_row(conn, high)
        conversation = uuid4()
        conn.execute("""INSERT INTO conversation(id, user_low, user_high, low_name, high_name)
          VALUES (%s, %s, %s, 'Low', 'High')""", (conversation, low, high))
        conn.execute('INSERT INTO conversation_member(conversation_id, member_id) VALUES (%s, %s), (%s, %s)',
                     (conversation, low, conversation, high))
        message = ('INSERT INTO message(id, conversation_id, from_low, client_key, body, created_at) '
                   'VALUES (%s, %s, true, %s, %s, now())')
        conn.execute(message, (uuid4(), conversation, uuid4(), 'x' * 1000))
        for body in ('', 'x' * 1001):
            with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
                conn.execute(message, (uuid4(), conversation, uuid4(), body))
        # A pair is ordered by byte: 'a-' follows 'B-'.
        with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
            conn.execute("""INSERT INTO conversation(id, user_low, user_high, low_name, high_name)
              VALUES (%s, %s, %s, 'Low', 'High')""", (uuid4(), high, low))

        # Deleting an account clears its side and keeps the names and the messages.
        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (low,))
        assert conn.execute('SELECT user_low, user_high, low_name, high_name FROM conversation WHERE id = %s',
                            (conversation,)).fetchone() == {'user_low': None, 'user_high': high,
                                                            'low_name': 'Low', 'high_name': 'High'}
        assert conn.execute('SELECT count(*) AS n FROM message WHERE conversation_id = %s',
                            (conversation,)).fetchone() == {'n': 1}
        assert conn.execute('SELECT member_id FROM conversation_member WHERE conversation_id = %s',
                            (conversation,)).fetchall() == [{'member_id': high}]


def test_a_trade_inserted_without_a_conversation_gets_the_pairs_with_both_member_rows(scratch):
    migrate(scratch, before='162_trade_loan_threads.sql')
    first, second = pair_ids()
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        owner_row(conn, first)
        owner_row(conn, second)

    def insert(proposer, recipient):
        with psycopg.connect(scratch, row_factory=dict_row) as conn:
            trade = uuid4()
            conn.execute("""INSERT INTO trade(id, state, proposer_id, recipient_id, proposer_name, recipient_name)
              VALUES (%s, 'proposed', %s, %s, 'Ash', 'Misty')""", (trade, proposer, recipient))
            return trade

    def conversations(conn):
        return conn.execute('SELECT * FROM conversation WHERE user_low = %s AND user_high = %s',
                            (first, second)).fetchall()

    one = insert(first, second)
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        [row] = conversations(conn)
        assert conn.execute('SELECT conversation_id FROM trade WHERE id = %s', (one,)).fetchone() \
            == {'conversation_id': row['id']}
        assert {member['member_id'] for member in conn.execute(
            'SELECT member_id FROM conversation_member WHERE conversation_id = %s', (row['id'],))} == {first, second}
        assert (row['low_name'], row['high_name']) == ('Ash', 'Misty')
    two = insert(second, first)
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        [again] = conversations(conn)
        assert again['id'] == row['id']
        assert conn.execute('SELECT conversation_id FROM trade WHERE id = %s', (two,)).fetchone() \
            == {'conversation_id': row['id']}
        assert again['last_activity_at'] > row['last_activity_at'] and again['changed_at'] > row['changed_at']
        assert conn.execute('SELECT count(*) AS n FROM conversation_member WHERE conversation_id = %s',
                            (row['id'],)).fetchone() == {'n': 2}

        # Changing a name stored on the Trade moves neither time; a step (revision) moves changed_at only.
        conn.execute("UPDATE trade SET proposer_name = 'X' WHERE id = %s", (two,))
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        [named] = conversations(conn)
        assert (named['changed_at'], named['last_activity_at']) == (again['changed_at'], again['last_activity_at'])
        conn.execute('UPDATE trade SET revision = revision + 1 WHERE id = %s', (two,))
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        [stepped] = conversations(conn)
        assert stepped['changed_at'] > named['changed_at']
        assert stepped['last_activity_at'] == named['last_activity_at']


def test_a_rename_follows_into_conversations_without_moving_them(scratch):
    migrate(scratch, before='162_trade_loan_threads.sql')
    first, second = pair_ids()
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        owner_row(conn, first)
        owner_row(conn, second)
        conn.execute("""INSERT INTO trade(id, state, proposer_id, recipient_id, proposer_name, recipient_name)
          VALUES (%s, 'proposed', %s, %s, 'Ash', 'Misty')""", (uuid4(), first, second))
        before = conn.execute('SELECT * FROM conversation WHERE user_low = %s AND user_high = %s',
                              (first, second)).fetchone()
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        conn.execute("UPDATE collector_profile SET display_name = 'Ash Renamed' WHERE user_id = %s", (first,))
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        after = conn.execute('SELECT * FROM conversation WHERE id = %s', (before['id'],)).fetchone()
    assert after['low_name'] == 'Ash Renamed' and after['high_name'] == before['high_name']
    assert after['changed_at'] == before['changed_at']
    assert after['last_activity_at'] == before['last_activity_at']


# Routes (Trading #298)


# Current chat is scoped to an item. There is no pair-level Conversation API.
from app.social.threads import normalize_text, encode_cursor
from test_threads import timeline as thread_timeline


def trader_of(user):
    with connect() as conn:
        return str(conn.execute('SELECT trader_id FROM collector_profile WHERE user_id=%s', (user,)).fetchone()['trader_id'])


def detail(response):
    return response.status_code, response.json()['detail']


def say(user, thread_id, body, key=None):
    return call('POST', f'/api/trades/{thread_id}/messages', user,
                {'body': body, 'idempotency_key': str(key or uuid4())})


def say_to(user, trader_id, body, key=None):
    """Reply on the latest shared item; test callers have already opened chat."""
    with connect() as conn:
        found = conn.execute("""SELECT t.id FROM thread t JOIN collector_profile p ON
          p.user_id=CASE WHEN t.user_low=%s THEN t.user_high ELSE t.user_low END
          WHERE t.kind='trade' AND (t.user_low=%s OR t.user_high=%s) AND p.trader_id=%s
          ORDER BY t.created_at DESC,t.id DESC LIMIT 1""", (user,user,user,trader_id)).fetchone()
    return say(user, found['id'] if found else uuid4(), body, key)


def start(sender, recipient, body='Hello'):
    tid, _ = make_thread(sender, recipient, closed=True)
    ok(say(sender, tid, body), 201)
    return str(tid)


def view(user, thread_id, before=None):
    return call('GET', f'/api/trades/{thread_id}', user)


def pulse(user):
    return ok(call('GET', '/api/threads/pulse', user))


def mark_read(user, thread_id, through):
    return call('POST', f'/api/trades/{thread_id}/read', user, {'through': through})


def kind_count(user, kind):
    with connect() as conn:
        return conn.execute('SELECT count(*) AS n FROM handle_lookup_event WHERE user_id=%s AND kind=%s',
                            (user,kind)).fetchone()['n']


def new_counted(user, count, hours_ago=1):
    with connect() as conn:
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind,created_at) SELECT %s,'new_conversation',"
                     "now()-make_interval(hours=>%s) FROM generate_series(1,%s)", (user,hours_ago,count))


def opened(sender, recipient, edition, message=None, key=None):
    return call('POST','/api/trades',sender,{'recipient_trader_id':trader_of(recipient),
                'you_give':[{'edition_id':edition,'quantity':'1'}], 'message':message,
                'idempotency_key':str(key or uuid4())})


@pytest.mark.parametrize('raw, clean', [
    ('a\r\nb\rc', 'a\nb\nc'), ('e\u0301', '\u00e9'), ('a\x00b\x07c\x7fd\x85e\x9f', 'abcde'), ('a\tb\nc', 'a\tb\nc'),
    ('x\u202ay\u202bz\u202c1\u202d2\u202e3\u20664\u20675\u20686\u20697', 'xyz1234567'), ('  hi \n', 'hi'),
    ('\U0001f600' * 1000, '\U0001f600' * 1000), ('\u00e9' * 1000, '\u00e9' * 1000),
    (' ' + 'x' * 1000 + ' ', 'x' * 1000), ('e\u0301' * 1000, '\u00e9' * 1000)])
def test_normalize_text_applies_each_rule_in_order(raw, clean):
    assert normalize_text(raw) == clean


@pytest.mark.parametrize('raw, code', [(' \n\t\u202e ', 'EMPTY_MESSAGE'), ('', 'EMPTY_MESSAGE'),
                                       ('x' * 1001, 'MESSAGE_TOO_LONG'), ('\U0001f600' * 1001, 'MESSAGE_TOO_LONG')])
def test_normalize_text_refuses_empty_and_long_text(raw, code):
    with pytest.raises(HTTPException) as refused:
        normalize_text(raw)
    assert (refused.value.status_code, refused.value.detail) == (422, {'code': code})


def swapped(conn, proposer, recipient, both=True):
    _, trade = make_thread(proposer, recipient, closed=True, conn=conn)
    conn.execute("""UPDATE trade SET closed_reason='swapped', proposer_name='Proposer', recipient_name='Recipient',
      proposer_swap_at=now(), recipient_swap_at=CASE WHEN %s THEN now() END WHERE id=%s""", (both, trade))
    return trade


def test_completed_trades_count_both_confirmations_and_survive_a_deletion(store):
    ash, misty = pair()
    with connect() as conn:
        assert trades.completed_trades(conn, [ash, misty, None, 'nobody']) == {ash: 0, misty: 0, 'nobody': 0}
        assert trades.completed_trades(conn, []) == {}
        half = swapped(conn, ash, misty, both=False)
        assert trades.completed_trades(conn, [ash, misty]) == {ash: 0, misty: 0}
        done = swapped(conn, misty, ash)
        assert trades.completed_trades(conn, [ash, misty]) == {ash: 1, misty: 1}
    assert ok(read(ash, round_address(done)))['other']['completed_trades'] == 1
    assert ok(read(ash, round_address(half)))['other']['completed_trades'] == 1
    done_thread = round_address(done)['thread_id']
    assert ok(call('GET', f'/api/trades/{done_thread}', ash))['live_offer']['other']['completed_trades'] == 1
    assert ok(call('GET', f'/api/social/trade-matches/{misty}', ash))['completed_trades'] == 1
    assert ok(call('GET', f'/api/social/trade-lists/{handle_of(misty)}', ash))['completed_trades'] == 1
    with connect() as conn:
        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (misty,))
        assert trades.completed_trades(conn, [ash]) == {ash: 1}
    assert ok(read(ash, round_address(done)))['other']['completed_trades'] is None


def round_address(trade_id):
    with connect() as conn:
        row = conn.execute('SELECT thread_id FROM trade WHERE id=%s', (trade_id,)).fetchone()
    return {'id': str(trade_id), 'thread_id': str(row['thread_id'])}


def test_a_trade_view_names_its_durable_thread_and_exact_offer(store):
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    assert trade['thread_id'] != trade['id'] == trade['offer_id']
    seen = ok(call('GET', f"/api/trades/{trade['thread_id']}", ash))
    assert seen['id'] == trade['thread_id']
    assert seen['live_offer']['thread_id'] == trade['thread_id']
    assert seen['live_offer']['offer_id'] == trade['id']
    assert call('GET', f"/api/trades/{trade['id']}", ash).status_code == 404
    with connect() as conn:
        assert str(conn.execute("SELECT thread_id FROM thread_round_source WHERE kind='trade' AND round_id=%s",
                                (trade['id'],)).fetchone()['thread_id']) == trade['thread_id']


def test_a_message_to_a_thread_keeps_other_trades_and_their_activity_separate(store):
    ids, ash, misty, binder, box = trading()
    proposal = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    old_thread, old = make_thread(ash, misty, closed=True, age=30)
    with connect() as conn:
        before = conn.execute('SELECT changed_at,last_activity_at FROM thread WHERE id=%s', (proposal['thread_id'],)).fetchone()
        old_before = conn.execute('SELECT * FROM thread WHERE id=%s', (old_thread,)).fetchone()
    ok(thread_message(ash, proposal['thread_id'], 'Hello again'), 201)
    with connect() as conn:
        assert str(conn.execute('SELECT thread_id FROM trade WHERE id=%s', (old,)).fetchone()['thread_id']) == str(old_thread)
        assert conn.execute('SELECT count(*) AS n FROM thread WHERE user_low=least(%s COLLATE "C",%s COLLATE "C") '
                            'AND user_high=greatest(%s COLLATE "C",%s COLLATE "C")', (ash,misty,ash,misty)).fetchone()['n'] == 2
        after = conn.execute('SELECT changed_at,last_activity_at FROM thread WHERE id=%s', (proposal['thread_id'],)).fetchone()
        assert conn.execute('SELECT * FROM thread WHERE id=%s', (old_thread,)).fetchone() == old_before
    assert after['changed_at'] > before['changed_at'] and after['last_activity_at'] > before['last_activity_at']
    assert [item['message']['body'] for item in thread_timeline(ash, proposal['thread_id'])['items']
            if item['kind'] == 'message'] == ['Hello again']
    assert thread_timeline(ash, old_thread)['items'] == []



def test_each_item_has_its_own_chat_and_a_counter_stays_in_that_item(store):
    ids, ash, misty, binder, box = trading()
    first = proposed(misty, ash, give=[(ids['PAL 185'], 1)], get=[(ids['SVI 166'], 1)])
    other = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    ok(say(ash, first['thread_id'], 'For this offer'), 201)
    changed = countered(ash, first, give=[(ids['SVI 166'], 1)], get=[(ids['PAL 185'], 1)])
    assert changed['thread_id'] == first['thread_id'] != other['thread_id']
    timeline = thread_timeline(misty, changed['thread_id'])['items']
    assert [item['message']['body'] for item in timeline if item['kind']=='message'] == ['For this offer']
    assert {item['event']['round_id'] for item in timeline if item['kind']=='event'} == {first['id'],changed['id']}
    assert all(item['kind'] != 'message' for item in thread_timeline(ash, other['thread_id'])['items'])


@pytest.mark.parametrize('method,path', [('GET','/api/social/conversations'), ('GET','/api/social/conversations/pulse'),
    ('GET','/api/social/conversations/{id}'), ('GET','/api/social/conversations/with/{id}'),
    ('POST','/api/social/conversations/{id}/messages'), ('POST','/api/social/conversations/{id}/read'),
    ('POST','/api/social/conversations/{id}/archive'), ('POST','/api/social/conversations/{id}/unarchive'),
    ('POST','/api/social/traders/{id}/messages')])
def test_retired_pair_chat_routes_are_gone(store, method, path):
    ash, misty = pair()
    assert call(method,path.format(id=uuid4()),ash,{'body':'Hello','idempotency_key':str(uuid4())}).status_code == 404


@pytest.mark.parametrize('operation', ['timeline','message','read','detail'])
def test_thread_membership_refuses_unknown_and_foreign_items_identically(store, operation):
    ash, misty = pair()
    gary, _ = collector('Gary')
    tid = start(ash,misty)
    def request(user, item):
        if operation=='timeline': return call('GET',f'/api/trades/{item}/timeline',user)
        if operation=='message': return say(user,item,'Hello')
        if operation=='read': return mark_read(user,item,thread_timeline(ash,tid)['items'][0]['cursor'])
        return view(user,item)
    actual, missing = request(gary,tid),request(ash,uuid4())
    assert actual.status_code == missing.status_code == 404
    assert actual.content == missing.content == b'{"detail":{"code":"TRADE_NOT_FOUND"}}'


def test_message_shape_storage_replay_and_sender_scoped_keys(store):
    ash,misty = pair()
    tid = start(ash,misty)
    for text,code in [('   ','EMPTY_MESSAGE'),('x'*1001,'MESSAGE_TOO_LONG')]:
        assert detail(say(ash,tid,text)) == (422,{'code':code})
    assert say(ash,tid,'x'*4001).status_code == 422
    key=uuid4()
    first=ok(say(ash,tid,' a\r\nb\x00 ',key),201)
    assert first['body']=='a\nb'
    before=kind_count(ash,'message')
    assert ok(say(ash,tid,'Different retry body',key),201)==first
    assert kind_count(ash,'message')==before
    other=ok(say(misty,tid,'Their message',key),201)
    assert other['id']!=first['id']
    with connect() as conn:
        assert conn.execute('SELECT body FROM thread_message WHERE id=%s',(first['id'],)).fetchone()['body']=='a\nb'
        assert conn.execute('SELECT count(*) AS n FROM thread_message WHERE thread_id=%s AND client_key=%s',
                            (tid,key)).fetchone()['n']==2


def test_message_quota_replay_and_expiry_are_atomic(store):
    ash,misty=pair()
    tid=start(ash,misty)
    key=uuid4()
    first=ok(say(ash,tid,'One',key),201)
    with connect() as conn:
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind,created_at) SELECT %s,'message',"
                     "now()-interval '30 minutes' FROM generate_series(1,118)",(ash,))
    assert kind_count(ash,'message')==120
    before=thread_timeline(ash,tid)
    assert detail(say(ash,tid,'Over quota'))==(429,{'code':'MESSAGE_RATE_LIMITED','retry_after_minutes':30})
    assert detail(say_to(ash,trader_of(misty),'Over quota'))==(429,{'code':'MESSAGE_RATE_LIMITED','retry_after_minutes':30})
    assert thread_timeline(ash,tid)==before
    assert ok(say(ash,tid,'Retry',key),201)==first
    assert kind_count(ash,'message')==120
    with connect() as conn:
        conn.execute("UPDATE handle_lookup_event SET created_at=now()-interval '2 hours' WHERE user_id=%s AND kind='message'",(ash,))
    ok(say(ash,tid,'After expiry'),201)
    assert kind_count(ash,'message')==1


def test_timeline_pages_events_and_messages_with_stable_boundaries(store):
    ids,ash,misty,binder,box=trading()
    trade=proposed(misty,ash,give=[(ids['PAL 185'],1)])
    stored=[]
    for index in range(55):
        stored.append(ok(say(ash,trade['thread_id'],str(index)),201)['id'])
    ok(trade_step(misty,trade,'withdraw'))
    page=thread_timeline(ash,trade['thread_id'])
    assert len(page['items'])==50 and page['next_before']
    items=page['items']+thread_timeline(ash,trade['thread_id'],before=page['next_before'])['items']
    assert len(items)==57 and len({item['cursor'] for item in items})==57
    assert {item['message']['id'] for item in items if item['kind']=='message'}==set(stored)
    assert [item['event']['kind'] for item in items if item['kind']=='event']==['withdrawn','offered']
    times=[datetime.fromisoformat(item['at']) for item in items]
    assert times==sorted(times,reverse=True)


@pytest.mark.parametrize('cursor', ['!', 'eA', '', 'a'*4001])
def test_malformed_timeline_cursors_are_refused(store,cursor):
    ash,misty=pair()
    tid=start(ash,misty)
    if not cursor:
        cursor=base64.urlsafe_b64encode(b'2020-01-01|event|not-a-uuid').decode().rstrip('=')
    response=call('GET',f'/api/trades/{tid}/timeline?before={cursor}',ash)
    assert response.status_code==422


def test_unread_read_markers_only_advance_and_closed_chat_stays_open(store):
    ash,misty=pair()
    tid=start(ash,misty)
    assert pulse(misty)['trades']['unread']==1
    first=thread_timeline(misty,tid)['items'][-1]['cursor']
    ok(mark_read(misty,tid,first))
    assert pulse(misty)['trades']['unread']==0
    ok(say(ash,tid,'Again'),201)
    second=thread_timeline(misty,tid)['items'][0]['cursor']
    assert pulse(misty)['trades']['unread']==1
    ok(mark_read(misty,tid,second))
    ok(mark_read(misty,tid,first))
    assert pulse(misty)['trades']['unread']==0
    assert ok(view(misty,tid))['can_message'] is True
    assert detail(mark_read(misty,tid,encode_cursor(datetime.now(timezone.utc),'message',uuid4())))[0]==422


def test_done_threads_page_by_activity_and_filter_by_trader(store):
    ash,misty=pair()
    ids=[make_thread(ash,misty,closed=True,age=age)[0] for age in range(55)]
    first=ok(call('GET','/api/trades?group=done',ash))
    assert len(first)==50
    last=first[-1]
    before=encode_cursor(datetime.fromisoformat(last['last_activity_at']),'thread',UUID(last['id']))
    second=ok(call('GET',f'/api/trades?group=done&before={before}',ash))
    assert len(second)==5 and {item['id'] for item in first+second}=={str(tid) for tid in ids}
    assert len(ok(call('GET','/api/trades?group=done&with='+trader_of(misty),ash)))==50
    gary,_=collector('Gary')
    assert ok(call('GET','/api/trades?group=done&with='+trader_of(gary),ash))==[]


@pytest.mark.parametrize('cause',['block','suspension','deletion'])
def test_chat_unavailability_and_reporting_after_account_changes(store,cause):
    ash,misty=pair()
    tid=start(ash,misty)
    key=uuid4()
    sent=ok(say(ash,tid,'Before',key),201)
    if cause=='block': block(misty,ash)
    else:
        with connect() as conn:
            if cause=='suspension': conn.execute('UPDATE collector_profile SET suspended_at=now() WHERE user_id=%s',(misty,))
            else: conn.execute('DELETE FROM inventory_owner WHERE user_id=%s',(misty,))
    seen=ok(view(ash,tid))
    assert not seen['can_message'] and seen['can_report']==(cause!='deletion')
    assert detail(say(ash,tid,'After'))==(409,{'code':'COLLECTOR_UNAVAILABLE'})
    assert ok(say(ash,tid,'Replay',key),201)==sent
    assert len(thread_timeline(ash,tid)['items'])==2


def test_unfriend_and_discovery_off_preserve_shared_thread_reach(store):
    ash,misty=pair()
    tid=start(ash,misty)
    ok(remove(ash,misty))
    assert ok(view(ash,tid))['can_message']
    ok(say(ash,tid,'After unfriend'),201)
    ids,ash,misty,binder,box=strangers()
    tid=start(ash,misty)
    ok(call('PUT','/api/social/discovery',ash,{'enabled':False}))
    ok(say(ash,tid,'After discovery off'),201)
    assert ok(view(misty,tid))['can_message']


def test_pulse_changes_for_message_step_and_update_without_presentation(store):
    ids,ash,misty,binder,box=trading()
    trade=proposed(misty,ash,give=[(ids['PAL 185'],1)])
    before=pulse(ash)['watermark']
    ok(say(misty,trade['thread_id'],'Hello'),201)
    assert pulse(ash)['watermark']!=before
    before=pulse(ash)['watermark']
    ok(accept_trade(ash,trade))
    assert pulse(ash)['watermark']!=before
    before=pulse(ash)['watermark']
    ok(call('PUT','/api/profile/display-name',ash,{'display_name':'Ash Renamed','idempotency_key':str(uuid4())}))
    assert pulse(ash)['watermark']==before


def test_renames_racing_accepts_and_messages_never_deadlock(store):
    ids,ash,misty,binder,box=trading()
    for index in range(3):
        trade=proposed(misty,ash,give=[(ids['PAL 185'],1)])
        with ThreadPoolExecutor(max_workers=3) as executor:
            work=[executor.submit(call,'PUT','/api/profile/display-name',ash,{'display_name':f'Ash R{index}','idempotency_key':str(uuid4())}),
                  executor.submit(accept_trade,ash,trade),executor.submit(say,misty,trade['thread_id'],f'Round {index}')]
            answers=[future.result(timeout=20) for future in work]
        assert [answer.status_code for answer in answers]==[200,200,201],[answer.text for answer in answers]


@pytest.mark.parametrize('with_message',[False,True])
def test_first_contact_quota_rolls_back_and_expires(store,with_message):
    ids,ash,misty,binder,box=strangers()
    brock,_=collector('Brock')
    discoverable(brock,'00010')
    new_counted(ash,9,23)
    first=ok(opened(ash,misty,ids['SVI 166'],'Hello' if with_message else None),201)
    assert kind_count(ash,'new_conversation')==10
    key=uuid4()
    before=(kind_count(ash,'trade_command'),kind_count(ash,'message'))
    refused=opened(ash,brock,ids['SVI 166'],'Hello' if with_message else None,key)
    assert refused.status_code==429 and refused.json()['detail']['code']=='TOO_MANY_NEW_CONVERSATIONS'
    assert 55<=refused.json()['detail']['retry_after_minutes']<=60
    assert (kind_count(ash,'trade_command'),kind_count(ash,'message'))==before
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM thread WHERE user_low=%s OR user_high=%s',(brock,brock)).fetchone()['n']==0
        conn.execute("UPDATE handle_lookup_event SET created_at=now()-interval '25 hours' WHERE user_id=%s AND kind='new_conversation'",(ash,))
    ok(opened(ash,brock,ids['SVI 166'],'Hello' if with_message else None,key),201)
    assert kind_count(ash,'new_conversation')==1


def test_only_new_stranger_pairs_count_friends_and_existing_threads_are_exempt(store):
    ids,ash,misty,binder,box=trading()
    new_counted(ash,10)
    ok(opened(ash,misty,ids['SVI 166'],'Friend'),201)
    assert kind_count(ash,'new_conversation')==10
    ids,ash,misty,binder,box=strangers()
    first=ok(opened(ash,misty,ids['SVI 166'],'Stranger'),201)
    assert kind_count(ash,'new_conversation')==1 and kind_count(misty,'new_conversation')==0
    ok(say(misty,first['thread_id'],'Reply'),201)
    ok(opened(misty,ash,ids['PAL 185']),201)
    assert kind_count(ash,'new_conversation')==1 and kind_count(misty,'new_conversation')==0


@pytest.mark.parametrize('with_message',[False,True])
def test_first_contacts_both_ways_make_distinct_items_but_count_one_pair(store,with_message):
    ids,ash,misty,binder,box=strangers()
    with ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(opened,ash,misty,ids['SVI 166'],'Ash' if with_message else None)
        b=pool.submit(opened,misty,ash,ids['PAL 185'],'Misty' if with_message else None)
        answers=[a.result(timeout=20),b.result(timeout=20)]
    assert [answer.status_code for answer in answers]==[201,201],[answer.text for answer in answers]
    assert answers[0].json()['thread_id']!=answers[1].json()['thread_id']
    assert kind_count(ash,'new_conversation')+kind_count(misty,'new_conversation')==1
    for answer in answers:
        messages=[i for i in thread_timeline(ash,answer.json()['thread_id'])['items'] if i['kind']=='message']
        assert len(messages)==int(with_message)


@pytest.mark.parametrize('with_message',[False,True])
def test_two_new_pairs_at_nine_leave_one_refused(store,with_message):
    ids,ash,misty,binder,box=strangers()
    brock,_=collector('Brock')
    discoverable(brock,'00010')
    new_counted(ash,9)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(opened,ash,misty,ids['SVI 166'],'Ash' if with_message else None)
        b=pool.submit(opened,ash,brock,ids['SVI 166'],'Ash' if with_message else None)
        answers=[a.result(timeout=20),b.result(timeout=20)]
    assert sorted(answer.status_code for answer in answers)==[201,429],[answer.text for answer in answers]
    assert kind_count(ash,'new_conversation')==10
    assert [a for a in answers if a.status_code==429][0].json()['detail']['code']=='TOO_MANY_NEW_CONVERSATIONS'


@pytest.mark.parametrize('unavailable',['suspended','far'])
def test_first_trade_contact_outside_reach_or_from_suspended_sender_counts_nothing(store,unavailable):
    ids,ash,misty,binder,box=strangers()
    if unavailable=='suspended':
        with connect() as conn:
            conn.execute('UPDATE collector_profile SET suspended_at=now() WHERE user_id=%s',(ash,))
    else: discoverable(misty,far_zip())
    before=kind_count(ash,'trade_command'),kind_count(ash,'message')
    response=opened(ash,misty,ids['SVI 166'],'Hello')
    assert detail(response)==((403,{'code':'ACCOUNT_SUSPENDED'}) if unavailable=='suspended' else (409,{'code':'COLLECTOR_UNAVAILABLE'}))
    assert (kind_count(ash,'trade_command'),kind_count(ash,'message'))==before
    assert kind_count(ash,'new_conversation')==0


def test_the_lock_check_reads_the_hashtext_key_whatever_its_sign(store):
    key = "hashtext('prizecheck.new_conversation:' || %s)"
    signs = {}
    with connect() as conn:
        for n in range(1000):
            name = f'lock-{n}'
            signs.setdefault(conn.execute(f'SELECT {key} < 0 AS negative', (name,)).fetchone()['negative'], name)
            if len(signs) == 2:
                break
    assert set(signs) == {True, False}
    for name in signs.values():
        other = name + '-other'
        with connect() as conn:
            assert conversations.new_conversation_lock_held(conn, name) is False
            conversations.message_locks(conn, name, both=False)
            assert conversations.new_conversation_lock_held(conn, name) is False
            conversations.new_conversation_lock(conn, name)
            assert conversations.new_conversation_lock_held(conn, name) is True
            assert conversations.new_conversation_lock_held(conn, other) is False
            with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row) as second:
                assert conversations.new_conversation_lock_held(second, name) is False
        with connect() as conn:
            conn.execute(f'SELECT pg_advisory_xact_lock_shared({key})', (name,))
            assert conversations.new_conversation_lock_held(conn, name) is False

def waiters(watch, holder_pid):
    """Sessions of this database (not ``watch`` and not the holder) that wait on a lock, as {pid: blocking pids}."""
    rows = watch.execute("""SELECT pid, pg_blocking_pids(pid) AS by FROM pg_stat_activity
      WHERE datname = current_database() AND pid NOT IN (pg_backend_pid(), %s)
        AND cardinality(pg_blocking_pids(pid)) > 0""", (holder_pid,)).fetchall()
    return {pid: by for pid, by in rows}


def wait_until(watch, holder, submitted, enough):
    """Polls ``waiters`` until ``enough(found)``; fails after 10 seconds or when a submitted call finished first."""
    deadline = time.monotonic() + 10
    while True:
        found = waiters(watch, holder.info.backend_pid)
        if enough(found):
            return found
        assert time.monotonic() < deadline and not any(call_.done() for call_ in submitted), \
            f'the calls did not wait as expected: {found}'
        time.sleep(0.01)


def blocked_by_holder(holder):
    return lambda found: any(holder.info.backend_pid in by for by in found.values())


def two_waiters(holder):
    return lambda found: blocked_by_holder(holder)(found) and len(found) >= 2


@pytest.mark.parametrize('first', ['contact', 'switch'])
@pytest.mark.parametrize('switcher', ['sender', 'recipient'])
@pytest.mark.parametrize('contact', ['message', 'proposal'])
def test_a_switch_off_racing_a_first_contact_lets_the_first_to_lock_win(store, contact, switcher, first):
    ids, ash, misty, binder, box = strangers()
    switching = ash if switcher == 'sender' else misty

    def make_contact():
        if contact == 'message':
            return opened(ash, misty, ids['SVI 166'], 'Hi')
        return propose_to(ash, trader_of(misty), give=[(ids['SVI 166'], 1)])

    def make_switch():
        return call('PUT', '/api/social/discovery', switching, {'enabled': False})

    makers = {'contact': make_contact, 'switch': make_switch}
    later = 'switch' if first == 'contact' else 'contact'
    with psycopg.connect(os.environ['DATABASE_URL']) as holder, \
            psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as watch, \
            ThreadPoolExecutor(max_workers=2) as executor:
        holder.execute('SELECT 1 FROM inventory_owner WHERE user_id = %s FOR UPDATE', (switching,))
        submitted = {first: executor.submit(makers[first])}
        wait_until(watch, holder, list(submitted.values()), blocked_by_holder(holder))
        submitted[later] = executor.submit(makers[later])
        wait_until(watch, holder, list(submitted.values()), two_waiters(holder))
        holder.commit()
        answers = {name: future.result(timeout=10) for name, future in submitted.items()}
    assert all(answer.status_code < 500 for answer in answers.values()), [a.text for a in answers.values()]
    assert answers['switch'].status_code == 200, answers['switch'].text
    won = answers['contact'].status_code == 201
    if switcher != 'sender':
        # With a proposal from the switching sender, Send counts a trade command first, and that insert's foreign key
        # waits FOR KEY SHARE on Ash's owner row. FOR KEY SHARE does not conflict with the switch-off's FOR NO KEY
        # UPDATE, so both are granted together at the commit and either may win; only self-consistency is asserted.
        assert won == (first == 'contact')
    if won:
        assert pair_threads(ash, misty) == 1 and kind_count(ash, 'new_conversation') == 1
        ok(say_to(ash, trader_of(misty), 'Still here'), 201)
    else:
        assert detail(answers['contact']) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
        assert pair_threads(ash, misty) == 0 and kind_count(ash, 'new_conversation') == 0


def pair_threads(a, b):
    with connect() as conn:
        return conn.execute('SELECT count(*) AS n FROM thread WHERE user_low=%s AND user_high=%s',
                            tuple(sorted((a,b)))).fetchone()['n']


@pytest.mark.parametrize('with_message',[False,True])
def test_opposite_first_contacts_wait_on_the_same_owner_order_and_count_once(store, with_message):
    ids,ash,misty,binder,box=strangers()
    low=sorted((ash,misty))[0]
    with psycopg.connect(os.environ['DATABASE_URL']) as holder, \
            psycopg.connect(os.environ['DATABASE_URL'],autocommit=True) as watch, \
            ThreadPoolExecutor(max_workers=2) as pool:
        holder.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE',(low,))
        first=pool.submit(opened,ash,misty,ids['SVI 166'],'Ash' if with_message else None)
        wait_until(watch,holder,[first],blocked_by_holder(holder))
        second=pool.submit(opened,misty,ash,ids['PAL 185'],'Misty' if with_message else None)
        wait_until(watch,holder,[first,second],two_waiters(holder))
        holder.commit()
        answers=first.result(timeout=20),second.result(timeout=20)
    assert [r.status_code for r in answers]==[201,201],[r.text for r in answers]
    assert pair_threads(ash,misty)==2
    assert kind_count(ash,'new_conversation')+kind_count(misty,'new_conversation')==1
    for response in answers:
        tid=response.json()['thread_id']
        with connect() as conn:
            assert conn.execute('SELECT count(*) AS n FROM thread_member WHERE thread_id=%s',(tid,)).fetchone()['n']==2
            assert conn.execute('SELECT count(*) AS n FROM thread_message WHERE thread_id=%s',(tid,)).fetchone()['n']==int(with_message)


def test_legacy_contact_retains_reach_and_does_not_use_a_new_contact_slot(store):
    ids,ash,misty,binder,box=strangers()
    with connect() as conn:
        conn.execute('INSERT INTO legacy_contact(user_low,user_high) VALUES (%s,%s)',tuple(sorted((ash,misty))))
    new_counted(ash,10)
    ok(call('PUT','/api/social/discovery',misty,{'enabled':False}))
    trade=ok(opened(ash,misty,ids['SVI 166'],'Still in touch'),201)
    assert kind_count(ash,'new_conversation')==10
    assert ok(view(misty,trade['thread_id']))['can_message'] is True
    assert [r['message']['body'] for r in thread_timeline(misty,trade['thread_id'])['items'] if r['kind']=='message']==['Still in touch']


def test_refused_opening_message_rolls_back_its_new_contact_slot(store):
    ids,ash,misty,binder,box=strangers()
    with connect() as conn:
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) SELECT %s,'message' FROM generate_series(1,120)",(ash,))
    response=opened(ash,misty,ids['SVI 166'],'Over quota')
    assert response.status_code==429 and response.json()['detail']['code']=='MESSAGE_RATE_LIMITED'
    assert kind_count(ash,'new_conversation')==0 and kind_count(ash,'trade_command')==0
    assert pair_threads(ash,misty)==0
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM trade WHERE proposer_id=%s',(ash,)).fetchone()['n']==0


@pytest.mark.parametrize('messages',[30,55])
def test_equal_timestamp_timeline_boundaries_keep_every_message_and_event(store,messages):
    ash,misty=pair()
    tid,rid=make_thread(ash,misty,closed=True)
    at=datetime(2024,1,2,3,4,5,tzinfo=timezone.utc)
    base=uuid4().int & ~65535
    expected=[]
    with connect() as conn:
        for index in range(60):
            item_id=UUID(int=base+index)
            kind='message' if index<messages else 'event'
            expected.append((kind,str(item_id)))
            if kind=='message':
                conn.execute('INSERT INTO thread_message(id,thread_id,from_low,client_key,body,created_at) VALUES (%s,%s,%s,%s,%s,%s)',
                             (item_id,tid,ash<misty,uuid4(),f'Message {index}',at))
            else:
                conn.execute("INSERT INTO thread_event(id,thread_id,actor,kind,round_id,created_at) VALUES (%s,%s,'low','offered',%s,%s)",
                             (item_id,tid,rid,at))
    first=thread_timeline(misty,tid)
    assert len(first['items'])==50 and first['next_before']
    second=thread_timeline(misty,tid,before=first['next_before'])
    assert len(second['items'])==10 and second['next_before'] is None
    items=first['items']+second['items']
    actual=[(item['kind'],item[item['kind']]['id']) for item in items]
    assert actual==sorted(expected,reverse=True)
    assert len(set(actual))==60
    assert all(datetime.fromisoformat(item['at'])==at for item in items)
    assert all((item['message'] is None)==(item['kind']=='event') and
               (item['event'] is None)==(item['kind']=='message') for item in items)


def test_recipient_only_inbox_updates_create_read_and_dismiss_move_pulse(store):
    ash,misty=pair()
    tid,rid=make_thread(ash,misty,closed=True)
    before={user:pulse(user)['watermark'] for user in (ash,misty)}
    update=uuid4()
    with connect() as conn:
        changed=conn.execute('SELECT changed_at FROM thread WHERE id=%s',(tid,)).fetchone()['changed_at']
        conn.execute("INSERT INTO inbox_update(id,recipient_id,kind,trade_id,other_name) VALUES (%s,%s,'accepted',%s,'Ash')",
                     (update,misty,rid))
    created=pulse(misty)['watermark']
    assert created!=before[misty] and pulse(ash)['watermark']==before[ash]
    marked=ok(call('POST','/api/social/inbox/read',misty,{'ids':[str(update)]}))
    assert next(r for r in marked['trade_updates'] if r['id']==str(update))['read'] is True
    read=pulse(misty)['watermark']
    assert read!=created and pulse(ash)['watermark']==before[ash]
    cleared=ok(call('POST','/api/social/inbox/clear',misty,{'ids':[str(update)]}))
    assert str(update) not in {r['id'] for r in cleared['trade_updates']}
    assert pulse(misty)['watermark']!=read and pulse(ash)['watermark']==before[ash]
    with connect() as conn:
        assert conn.execute('SELECT changed_at FROM thread WHERE id=%s',(tid,)).fetchone()['changed_at']==changed


@pytest.mark.parametrize('case',['alphabet','parts','timestamp','timezone','kind','uuid','length','plus','padding','suffix','unicode','nonascii_payload'])
def test_malformed_cursor_parser_cases_are_invalid_on_thread_routes(store,case):
    ash,misty=pair()
    tid=start(ash,misty)
    now=datetime.now(timezone.utc).isoformat()
    item=uuid4()
    def raw(stamp,kind,item_id):
        return base64.urlsafe_b64encode(f'{stamp}|{kind}|{item_id}'.encode()).rstrip(b'=').decode()
    valid=raw(now,'message',item)
    bad={'alphabet':'nope','parts':base64.urlsafe_b64encode(b'one|two').decode().rstrip('='),
         'timestamp':raw('x','message',item),'timezone':raw('2026-10-23T10:00:00','message',item),
         'kind':raw(now,'bogus',item),'uuid':raw(now,'message','not-a-uuid'),'length':'A'*201,
         'plus':'ab+/','padding':valid+'=','suffix':valid+'|x','unicode':'é',
         'nonascii_payload':raw('é','message',item)}[case]
    for response in (call('GET',f'/api/trades/{tid}/timeline?before={bad}',misty),
                     call('GET',f'/api/trades?group=done&before={bad}',misty),mark_read(misty,tid,bad)):
        assert detail(response)==(422,{'code':'INVALID_CURSOR'}),case


def test_forged_read_cursors_never_advance_the_marker(store):
    ash,misty=pair()
    tid=start(ash,misty)
    other_ash,other_misty=pair()
    foreign=start(other_ash,other_misty)
    real=thread_timeline(misty,tid)['items'][0]
    outside=thread_timeline(other_misty,foreign)['items'][0]
    at=datetime.fromisoformat(real['at'])
    item=UUID(real['message']['id'])
    forged=[encode_cursor(at+timedelta(seconds=1),'message',item),
            encode_cursor(at,'event',item),encode_cursor(at,'message',uuid4()),outside['cursor']]
    for cursor in forged:
        assert detail(mark_read(misty,tid,cursor))==(422,{'code':'INVALID_CURSOR'})
    assert detail(call('GET',f"/api/trades?before={real['cursor']}",misty))==(422,{'code':'INVALID_CURSOR'})
    with connect() as conn:
        assert conn.execute('SELECT read_at FROM thread_member WHERE thread_id=%s AND member_id=%s',(tid,misty)).fetchone()['read_at'] is None
    ok(mark_read(misty,tid,real['cursor']))
    with connect() as conn:
        assert conn.execute('SELECT read_at FROM thread_member WHERE thread_id=%s AND member_id=%s',(tid,misty)).fetchone()['read_at']==at


def test_fresh_owner_pulse_is_read_only_and_empty(store):
    fresh='pulse-'+uuid4().hex
    first=pulse(fresh)
    assert first['trades']==first['loans']=={'needs_you':0,'waiting':0,'unread':0}
    assert first==pulse(fresh)
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM inventory_owner WHERE user_id=%s',(fresh,)).fetchone()['n']==0
