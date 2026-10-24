"""Conversations (Trading #298): migration 147, the Trade triggers and, in the sections below it, the routes
(``app.social.conversations``) through signed HTTP against PostgreSQL.

The migration section runs on disposable databases and on the test database. Pairs are ordered by byte, not by locale:
the ids used here start with ``B-`` and ``a-``, which a locale collation sorts the other way round.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi import HTTPException
from psycopg.rows import dict_row

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.social import trades
from app.social.conversations import normalize_text
from test_catalog_references import migrate
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_ending_friendship import remove
from test_friend_copies import block, collector, ok
from test_holdings import call
from test_loans import pair
from test_trade_migrations import collector as owner_row, run_again, scratch  # noqa: F401
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


def old_trade(conn, proposer, recipient, state='closed', age_days=1):
    """One Trade by SQL, created ``age_days`` ago; a closed one is declined. Returns (id, created_at)."""
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
        trades['p1'] = [old_trade(conn, pairs['p1'][0], pairs['p1'][1], age_days=3),
                        old_trade(conn, pairs['p1'][1], pairs['p1'][0], age_days=1)]
        # P2: not Friends, one proposed Trade. Covered.
        trades['p2'] = [old_trade(conn, pairs['p2'][1], pairs['p2'][0], state='proposed', age_days=2)]
        # P3: ex-Friends, only closed Trades. Not covered.
        trades['p3'] = [old_trade(conn, pairs['p3'][0], pairs['p3'][1], age_days=5)]
        # P4: Friends with no Trades. Not covered.
        friends(conn, *pairs['p4'])
        # P5: an accepted friendship and a Block, only closed Trades. Not covered.
        friends(conn, *pairs['p5'])
        conn.execute('INSERT INTO block(blocker_id, blocked_id) VALUES (%s, %s)', (pairs['p5'][1], pairs['p5'][0]))
        trades['p5'] = [old_trade(conn, pairs['p5'][0], pairs['p5'][1], age_days=4)]
    migrate(scratch)

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
    migrate(scratch)
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


def test_a_trade_inserted_without_a_conversation_gets_the_pairs_with_both_member_rows(store):
    first, second = pair_ids()
    with connect() as conn:
        owner_row(conn, first)
        owner_row(conn, second)

    def insert(proposer, recipient):
        with connect() as conn:
            trade = uuid4()
            conn.execute("""INSERT INTO trade(id, state, proposer_id, recipient_id, proposer_name, recipient_name)
              VALUES (%s, 'proposed', %s, %s, 'Ash', 'Misty')""", (trade, proposer, recipient))
            return trade

    def conversations(conn):
        return conn.execute('SELECT * FROM conversation WHERE user_low = %s AND user_high = %s',
                            (first, second)).fetchall()

    one = insert(first, second)
    with connect() as conn:
        [row] = conversations(conn)
        assert conn.execute('SELECT conversation_id FROM trade WHERE id = %s', (one,)).fetchone() \
            == {'conversation_id': row['id']}
        assert {member['member_id'] for member in conn.execute(
            'SELECT member_id FROM conversation_member WHERE conversation_id = %s', (row['id'],))} == {first, second}
        assert (row['low_name'], row['high_name']) == ('Ash', 'Misty')
    two = insert(second, first)
    with connect() as conn:
        [again] = conversations(conn)
        assert again['id'] == row['id']
        assert conn.execute('SELECT conversation_id FROM trade WHERE id = %s', (two,)).fetchone() \
            == {'conversation_id': row['id']}
        assert again['last_activity_at'] > row['last_activity_at'] and again['changed_at'] > row['changed_at']
        assert conn.execute('SELECT count(*) AS n FROM conversation_member WHERE conversation_id = %s',
                            (row['id'],)).fetchone() == {'n': 2}

        # Changing a name stored on the Trade moves neither time; a step (revision) moves changed_at only.
        conn.execute("UPDATE trade SET proposer_name = 'X' WHERE id = %s", (two,))
    with connect() as conn:
        [named] = conversations(conn)
        assert (named['changed_at'], named['last_activity_at']) == (again['changed_at'], again['last_activity_at'])
        conn.execute('UPDATE trade SET revision = revision + 1 WHERE id = %s', (two,))
    with connect() as conn:
        [stepped] = conversations(conn)
        assert stepped['changed_at'] > named['changed_at']
        assert stepped['last_activity_at'] == named['last_activity_at']


def test_a_rename_follows_into_conversations_without_moving_them(store):
    first, second = pair_ids()
    with connect() as conn:
        owner_row(conn, first)
        owner_row(conn, second)
        conn.execute("""INSERT INTO trade(id, state, proposer_id, recipient_id, proposer_name, recipient_name)
          VALUES (%s, 'proposed', %s, %s, 'Ash', 'Misty')""", (uuid4(), first, second))
        before = conn.execute('SELECT * FROM conversation WHERE user_low = %s AND user_high = %s',
                              (first, second)).fetchone()
    with connect() as conn:
        conn.execute("UPDATE collector_profile SET display_name = 'Ash Renamed' WHERE user_id = %s", (first,))
    with connect() as conn:
        after = conn.execute('SELECT * FROM conversation WHERE id = %s', (before['id'],)).fetchone()
    assert after['low_name'] == 'Ash Renamed' and after['high_name'] == before['high_name']
    assert after['changed_at'] == before['changed_at']
    assert after['last_activity_at'] == before['last_activity_at']


# Routes (Trading #298)


def trader_of(user):
    with connect() as conn:
        return str(conn.execute('SELECT trader_id FROM collector_profile WHERE user_id = %s', (user,)).fetchone()['trader_id'])


def say(user, conversation_id, body, key=None):
    return call('POST', f'/api/social/conversations/{conversation_id}/messages', user,
                {'body': body, 'idempotency_key': str(key or uuid4())})


def say_to(user, trader_id, body, key=None):
    return call('POST', f'/api/social/traders/{trader_id}/messages', user,
                {'body': body, 'idempotency_key': str(key or uuid4())})


def view(user, conversation_id, before=None):
    return call('GET', f'/api/social/conversations/{conversation_id}' + (f'?before={before}' if before else ''), user)


def view_with(user, trader_id, before=None):
    return call('GET', f'/api/social/conversations/with/{trader_id}' + (f'?before={before}' if before else ''), user)


def listed(user, archived=False, before=None):
    query = f'?archived={str(archived).lower()}' + (f'&before={before}' if before else '')
    return ok(call('GET', '/api/social/conversations' + query, user))


def pulse(user):
    return ok(call('GET', '/api/social/conversations/pulse', user))


def mark_read(user, conversation_id, through):
    return call('POST', f'/api/social/conversations/{conversation_id}/read', user, {'through': through})


def archive(user, conversation_id, undo=False):
    return call('POST', f"/api/social/conversations/{conversation_id}/{'unarchive' if undo else 'archive'}", user)


def detail(response):
    return response.status_code, response.json()['detail']


def conversation_of(message):
    with connect() as conn:
        return conn.execute('SELECT conversation_id FROM message WHERE id = %s', (message['id'],)).fetchone()['conversation_id']


def start(sender, recipient, body='Hello'):
    """The pair's conversation id, opened by a message from ``sender``."""
    return str(conversation_of(ok(say_to(sender, trader_of(recipient), body), 201)))


def cursor_of(at, kind, item):
    return base64.urlsafe_b64encode(f'{at}|{kind}|{item}'.encode()).rstrip(b'=').decode()


def messages_stored(conn, user=None):
    return conn.execute('SELECT count(*) AS n FROM handle_lookup_event WHERE user_id = %s AND kind = %s',
                        (user, 'message')).fetchone()['n']


def test_one_conversation_per_pair_whoever_starts(store):
    ids, ash, misty, binder, box = trading()
    first = ok(say_to(ash, trader_of(misty), 'Hello Misty'), 201)
    assert (first['from'], first['body']) == ('you', 'Hello Misty')
    conversation = conversation_of(first)
    second = ok(say_to(misty, trader_of(ash), 'Hi Ash'), 201)
    assert second['from'] == 'you' and conversation_of(second) == conversation
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    assert trade['conversation_id'] == str(conversation)
    for user in (ash, misty):
        assert len(listed(user)['conversations']) == 1
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM conversation WHERE user_low = %s OR user_high = %s',
                            (ash, ash)).fetchone() == {'n': 1}


def test_a_friend_opens_and_uses_a_conversation_and_old_trade_links_still_open(store):
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    # A Friend pair with no Trades and no conversation: an empty one, ready for the composer.
    other_ash, other_misty = pair()
    empty = ok(view_with(other_ash, trader_of(other_misty)))
    assert (empty['id'], empty['items'], empty['next_before'], empty['status'], empty['can_message']) == (
        None, [], None, 'open', True)
    assert empty['other'] == {'trader_id': trader_of(other_misty), 'display_name': 'Misty W.', 'friend': True,
                              'handle': handle_of(other_misty), 'band': None, 'completed_trades': 0}
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM conversation WHERE user_low = %s OR user_high = %s',
                            (other_ash, other_ash)).fetchone() == {'n': 0}
    message = ok(say_to(other_ash, trader_of(other_misty), 'Hello'), 201)
    conversation = str(conversation_of(message))
    by_id, by_trader = ok(view(other_ash, conversation)), ok(view_with(other_ash, trader_of(other_misty)))
    assert by_id == by_trader and by_id['id'] == conversation
    assert [item['message']['body'] for item in by_id['items']] == ['Hello']
    # The Trade link of Stage 1 still opens, and its card is in the pair's timeline.
    assert ok(read(ash, trade))['conversation_id'] == trade['conversation_id']
    items = ok(view(ash, trade['conversation_id']))['items']
    assert [item['trade']['id'] for item in items if item['kind'] == 'trade'] == [trade['id']]


def test_a_collector_who_is_not_a_friend_and_has_no_conversation_gets_none(store):
    (one, _), (two, _) = collector('Ash K.'), collector('Misty W.')
    for target in (trader_of(two), str(uuid4()), trader_of(one)):
        assert detail(view_with(one, target)) == (404, {'code': 'CONVERSATION_NOT_FOUND'})
        assert detail(say_to(one, target, 'Hello')) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM conversation WHERE user_low = %s OR user_high = %s',
                            (one, one)).fetchone() == {'n': 0}
        assert messages_stored(conn, one) == 0


def test_an_ex_friend_keeps_messaging_in_their_conversation(store):
    ash, misty = pair()
    conversation = start(ash, misty)
    ok(remove(ash, misty))
    ok(say(misty, conversation, 'Still here'), 201)
    seen = ok(view(ash, conversation))
    assert (seen['status'], seen['other']['friend'], seen['other']['handle']) == ('open', False, None)
    assert ok(say_to(ash, trader_of(misty), 'And me'), 201)['from'] == 'you'


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


def test_the_api_refuses_empty_and_oversized_bodies_and_stores_the_normalised_text(store):
    ash, misty = pair()
    conversation = start(ash, misty)
    assert detail(say(ash, conversation, '   ')) == (422, {'code': 'EMPTY_MESSAGE'})
    assert detail(say(ash, conversation, 'x' * 1001)) == (422, {'code': 'MESSAGE_TOO_LONG'})
    assert say(ash, conversation, 'x' * 4001).status_code == 422
    message = ok(say(ash, conversation, ' a\r\nb\x00 '), 201)
    assert message['body'] == 'a\nb'
    with connect() as conn:
        assert conn.execute('SELECT body FROM message WHERE id = %s', (message['id'],)).fetchone() == {'body': 'a\nb'}


def test_a_replay_by_key_answers_the_stored_message(store):
    ash, misty = pair()
    conversation = start(ash, misty)
    key = uuid4()
    first = ok(say(ash, conversation, 'One', key), 201)
    with connect() as conn:
        counted = messages_stored(conn, ash)
    assert ok(say(ash, conversation, 'One', key), 201) == first
    assert ok(say(ash, conversation, 'Another body', key), 201) == first
    assert ok(say_to(ash, trader_of(misty), 'Elsewhere', key), 201) == first
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM message WHERE client_key = %s', (key,)).fetchone() == {'n': 1}
        assert messages_stored(conn, ash) == counted
    # The same key from the other side is a message of its own.
    other = ok(say(misty, conversation, 'Two', key), 201)
    assert other['id'] != first['id'] and other['body'] == 'Two'


def test_the_121st_message_in_an_hour_is_rate_limited(store):
    ash, misty = pair()
    conversation = start(ash, misty)
    key = uuid4()
    first = ok(say(ash, conversation, 'Early', key), 201)

    def seed(minutes):
        with connect() as conn:
            conn.execute("DELETE FROM handle_lookup_event WHERE user_id = %s AND kind = 'message'", (ash,))
            conn.execute("""INSERT INTO handle_lookup_event(user_id, kind, created_at)
              SELECT %s, 'message', now() - make_interval(mins => %s) FROM generate_series(1, 120)""", (ash, minutes))

    seed(30)
    with connect() as conn:
        stored = conn.execute('SELECT count(*) AS n FROM message').fetchone()['n']
    assert detail(say(ash, conversation, 'Too many')) == (429, {'code': 'MESSAGE_RATE_LIMITED', 'retry_after_minutes': 30})
    assert detail(say_to(ash, trader_of(misty), 'Too many')) == (
        429, {'code': 'MESSAGE_RATE_LIMITED', 'retry_after_minutes': 30})
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM message').fetchone()['n'] == stored
    assert ok(say(ash, conversation, 'Early', key), 201) == first
    seed(61)
    ok(say(ash, conversation, 'Allowed again'), 201)


def test_the_timeline_mixes_rounds_and_messages_in_order_across_pages(store):
    ids, ash, misty, binder, box = trading()
    conversation = start(ash, misty)
    with connect() as conn:
        conn.execute("""INSERT INTO message(id, conversation_id, from_low, client_key, body, created_at)
          SELECT gen_random_uuid(), %s, i %% 2 = 0, gen_random_uuid(), 'm' || i, now() - make_interval(mins => i + 10)
          FROM generate_series(1, 55) i""", (conversation,))
    original = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    answer = countered(ash, original, give=[(ids['SVI 166'], 1)], get=[(ids['PAL 185'], 1)])
    at = datetime.now(timezone.utc) - timedelta(minutes=5)
    with connect() as conn:
        conn.execute('UPDATE trade SET created_at = %s WHERE id = ANY(%s)', (at, [original['id'], answer['id']]))
        conn.execute("""INSERT INTO message(id, conversation_id, from_low, client_key, body, created_at)
          VALUES (gen_random_uuid(), %s, true, gen_random_uuid(), 'same time', %s)""", (conversation, at))
    first = ok(view(ash, conversation))
    assert len(first['items']) == 50 and first['next_before']
    second = ok(view(ash, conversation, first['next_before']))
    assert len(second['items']) == 9 and second['next_before'] is None
    everything = first['items'] + second['items']

    def key(item):
        return item['kind'] + item['message']['id'] if item['kind'] == 'message' else item['kind'] + item['trade']['id']

    assert len({key(item) for item in everything}) == 59

    def ordered(one, two):
        when, then = datetime.fromisoformat(one['at']), datetime.fromisoformat(two['at'])
        one_id = (one['message'] or one['trade'])['id']
        two_id = (two['message'] or two['trade'])['id']
        return when > then or (when == then and (one['kind'] < two['kind'] or (one['kind'] == two['kind'] and one_id > two_id)))

    assert all(ordered(one, two) for one, two in zip(everything, everything[1:]))
    same = [item for item in everything if datetime.fromisoformat(item['at']) == at]
    assert [item['kind'] for item in same] == ['message', 'trade', 'trade']
    rounds = {item['trade']['id']: item['trade'] for item in everything if item['kind'] == 'trade'}
    assert set(rounds) == {original['id'], answer['id']}
    assert rounds[original['id']]['closed_reason'] == 'countered'
    assert all((item['message'] is None) == (item['kind'] == 'trade') and (item['trade'] is None) == (item['kind'] == 'message')
               for item in everything)


def test_a_malformed_cursor_is_invalid_cursor(store):
    ash, misty = pair()
    conversation = start(ash, misty)
    other_ash, other_misty = pair()
    elsewhere = start(other_ash, other_misty)
    now = datetime.now(timezone.utc).isoformat()
    item = uuid4()
    bad = ['nope', cursor_of('x', 'y', 'z'), cursor_of(now, 'bogus', item), cursor_of(now, 'message', 'not-a-uuid'),
           cursor_of('2026-10-23T10:00:00', 'message', item), 'A' * 201, cursor_of(now, 'conversation', item),
           'ab+/', cursor_of(now, 'message', item) + '=', cursor_of(now, 'message', item) + '|x', '\u00e9']
    for cursor in bad:
        for response in (view(ash, conversation, cursor), view_with(ash, trader_of(misty), cursor)):
            assert detail(response) == (422, {'code': 'INVALID_CURSOR'}), cursor
        assert detail(mark_read(ash, conversation, cursor)) == (422, {'code': 'INVALID_CURSOR'}), cursor
    for cursor in [value for value in bad if value != cursor_of(now, 'conversation', item)]:
        assert detail(call('GET', f'/api/social/conversations?before={cursor}', ash)) == (
            422, {'code': 'INVALID_CURSOR'}), cursor
    assert detail(call('GET', f"/api/social/conversations?before={cursor_of(now, 'message', item)}", ash)) == (
        422, {'code': 'INVALID_CURSOR'})
    # A read names a real item of this conversation, at its own time.
    real = ok(view(ash, conversation))['items'][0]
    other = ok(view(other_ash, elsewhere))['items'][0]
    later = (datetime.fromisoformat(real['at']) + timedelta(seconds=1)).isoformat()
    for cursor in (cursor_of(now, 'message', item), other['cursor'], cursor_of(later, 'message', real['message']['id']),
                   cursor_of(real['at'], 'trade', real['message']['id'])):
        assert detail(mark_read(ash, conversation, cursor)) == (422, {'code': 'INVALID_CURSOR'}), cursor
    assert mark_read(ash, conversation, real['cursor']).status_code == 200


def test_unknown_and_non_member_conversations_are_not_found(store):
    ash, misty = pair()
    conversation = start(ash, misty)
    (stranger, _) = collector('Brock S.')
    cursor = cursor_of(datetime.now(timezone.utc).isoformat(), 'message', uuid4())
    for target in (str(uuid4()), conversation):
        for user in ((ash,) if target != conversation else (stranger,)):
            gone = (404, {'code': 'CONVERSATION_NOT_FOUND'})
            assert detail(view(user, target)) == gone
            assert detail(say(user, target, 'Hello')) == gone
            assert detail(mark_read(user, target, cursor)) == gone
            assert detail(archive(user, target)) == gone
            assert detail(archive(user, target, undo=True)) == gone


def test_unread_read_and_archive(store):
    ids, ash, misty, binder, box = trading()
    conversation = start(ash, misty, 'First')
    assert not listed(ash)['conversations'][0]['unread'] and listed(misty)['conversations'][0]['unread']
    assert pulse(ash)['unread_conversations'] == 0 and pulse(misty)['unread_conversations'] == 1
    ok(say(misty, conversation, 'Second'), 201)
    assert listed(ash)['conversations'][0]['unread'] and pulse(ash)['unread_conversations'] == 1

    def marker():
        with connect() as conn:
            return conn.execute('SELECT read_at FROM conversation_member WHERE conversation_id = %s AND member_id = %s',
                                (conversation, ash)).fetchone()['read_at']

    newest = ok(view(ash, conversation))['items']
    summary = ok(mark_read(ash, conversation, newest[0]['cursor']))
    assert summary['unread'] is False and pulse(ash)['unread_conversations'] == 0
    read_at = marker()
    assert ok(mark_read(ash, conversation, newest[1]['cursor']))['unread'] is False and marker() == read_at
    future = (datetime.fromisoformat(newest[0]['at']) + timedelta(hours=1)).isoformat()
    assert detail(mark_read(ash, conversation, cursor_of(future, 'message', newest[0]['message']['id']))) == (
        422, {'code': 'INVALID_CURSOR'})
    assert marker() == read_at

    # Archive: out of the list, into the archived one.
    assert ok(archive(ash, conversation))['archived'] is True
    assert listed(ash)['conversations'] == []
    assert [row['archived'] for row in listed(ash, archived=True)['conversations']] == [True]
    # Any later message, either side's, or a Trade proposal brings it back.
    ok(say(misty, conversation, 'Third'), 201)
    assert [row['archived'] for row in listed(ash)['conversations']] == [False]
    assert listed(ash, archived=True)['conversations'] == []
    for act in (lambda: ok(say(ash, conversation, 'Mine'), 201),
                lambda: proposed(misty, ash, give=[(ids['PAL 185'], 1)])):
        ok(archive(ash, conversation))
        assert listed(ash)['conversations'] == []
        act()
        assert [row['archived'] for row in listed(ash)['conversations']] == [False]
    ok(archive(ash, conversation))
    assert ok(archive(ash, conversation, undo=True))['archived'] is False
    assert len(listed(ash)['conversations']) == 1
    # An archived unread conversation is not in the badge until new activity brings it back.
    ok(say(misty, conversation, 'Fourth'), 201)
    assert pulse(ash)['unread_conversations'] == 1
    ok(archive(ash, conversation))
    assert pulse(ash)['unread_conversations'] == 0
    ok(say(misty, conversation, 'Fifth'), 201)
    assert pulse(ash)['unread_conversations'] == 1


def test_the_list_pages_by_last_activity(store):
    ash, misty = pair()
    start(ash, misty)
    with connect() as conn:
        for index in range(51):
            other = f'listed-{uuid4()}'
            conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (other,))
            conversation = conn.execute('SELECT pair_conversation(%s, %s, %s, %s) AS id',
                                        (ash, other, 'Ash K.', f'Other {index}')).fetchone()['id']
            conn.execute("UPDATE conversation SET last_activity_at = now() - make_interval(hours => %s) WHERE id = %s",
                         (index + 1, conversation))
    first = listed(ash)
    assert len(first['conversations']) == 50 and first['next_before']
    second = listed(ash, before=first['next_before'])
    assert len(second['conversations']) == 2 and second['next_before'] is None
    rows = first['conversations'] + second['conversations']
    assert len({row['id'] for row in rows}) == 52
    times = [datetime.fromisoformat(row['last_activity_at']) for row in rows]
    assert times == sorted(times, reverse=True)
    assert rows[0]['other']['display_name'] == 'Misty W.'


def test_read_only_states_and_can_report(store):
    ash, misty = pair()
    conversation = start(ash, misty)
    flags = lambda seen: (seen['can_message'], seen['can_propose'], seen['can_report'])  # noqa: E731
    block(ash, misty)
    blocker, blocked = ok(view(ash, conversation)), ok(view(misty, conversation))
    assert (blocker['status'], flags(blocker)) == ('you_blocked', (False, False, True))
    assert (blocked['status'], flags(blocked)) == ('unavailable', (False, False, True))
    assert blocked['other'] == {'trader_id': trader_of(ash), 'display_name': 'Ash K.', 'friend': False, 'handle': None,
                                'band': None, 'completed_trades': None}
    assert detail(say(ash, conversation, 'Hi')) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    assert detail(say(misty, conversation, 'Hi')) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    assert detail(say_to(misty, trader_of(ash), 'Hi')) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    ok(call('POST', f'/api/social/blocks/{misty}/unblock', ash, {'idempotency_key': str(uuid4())}))
    assert ok(view(ash, conversation))['status'] == 'open' and ok(view(misty, conversation))['status'] == 'open'

    # The same conversation with a suspended other reads like the blocked side's.
    one, two = pair()
    suspended_conversation = start(one, two)
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (two,))
    away = ok(view(one, suspended_conversation))
    assert (away['status'], flags(away)) == ('unavailable', (False, False, True))

    def alike(seen):
        return {**{key: value for key, value in seen.items() if key not in ('id', 'items')},
                'other': {key: value for key, value in seen['other'].items() if key not in ('display_name', 'trader_id')}}

    block(ash, misty)
    assert alike(ok(view(misty, conversation))) == alike(away)
    # A suspended viewer still sees an open conversation but cannot write to it.
    mine = ok(view(two, suspended_conversation))
    assert (mine['status'], flags(mine)) == ('open', (False, False, True))
    assert detail(say(two, suspended_conversation, 'Hi')) == (403, {'code': 'ACCOUNT_SUSPENDED'})

    # A deleted account: unavailable, no trader id, cannot be reported, the name stays.
    third, fourth = pair()
    deleted_conversation = start(third, fourth)
    with connect() as conn:
        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (fourth,))
    gone = ok(view(third, deleted_conversation))
    assert (gone['status'], flags(gone)) == ('unavailable', (False, False, False))
    assert gone['other'] == {'trader_id': None, 'display_name': 'Misty W.', 'friend': False, 'handle': None,
                             'band': None, 'completed_trades': None}


def test_the_pulse_moves_on_a_message_a_trade_step_and_an_inbox_update_and_not_on_a_rename(store):
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    conversation = trade['conversation_id']
    marks = {'ash': pulse(ash)['watermark'], 'misty': pulse(misty)['watermark']}

    def moved(*who):
        now = {'ash': pulse(ash)['watermark'], 'misty': pulse(misty)['watermark']}
        changed = {name for name in now if now[name] != marks[name]}
        marks.update(now)
        assert changed == set(who), (changed, who)

    ok(call('PUT', '/api/profile/display-name', misty, {'display_name': 'Misty Renamed', 'idempotency_key': str(uuid4())}))
    moved()
    ok(say(misty, conversation, 'Hello'), 201)
    moved('ash', 'misty')
    ok(trade_step(misty, trade, 'withdraw'))
    moved('ash', 'misty')
    other = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    moved('ash', 'misty')
    with connect() as conn:
        conn.execute("""INSERT INTO inbox_update(id, recipient_id, kind, trade_id, other_name)
          VALUES (%s, %s, 'declined', %s, 'Misty W.')""", (uuid4(), ash, other['id']))
    moved('ash')
    with connect() as conn:
        conn.execute('UPDATE inbox_update SET read_at = now() WHERE recipient_id = %s', (ash,))
    moved('ash')
    with connect() as conn:
        conn.execute('UPDATE inbox_update SET dismissed_at = now() WHERE recipient_id = %s', (ash,))
    moved('ash')
    newest = ok(view(ash, conversation))['items'][0]['cursor']
    ok(mark_read(ash, conversation, newest))
    moved('ash')
    ok(archive(ash, conversation))
    moved('ash')
    ok(archive(ash, conversation, undo=True))
    moved('ash')
    # A new account's pulse is a read: it makes no owner row.
    fresh = f'pulse-{uuid4()}'
    assert pulse(fresh)['unread_conversations'] == 0
    with connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM inventory_owner WHERE user_id = %s', (fresh,)).fetchone() == {'n': 0}


def swapped(conn, proposer, recipient, both=True):
    trade = uuid4()
    conn.execute("""INSERT INTO trade(id, state, closed_reason, proposer_id, recipient_id, proposer_name, recipient_name,
        proposer_swap_at, recipient_swap_at, closed_at)
      VALUES (%s, 'closed', 'swapped', %s, %s, 'Proposer', 'Recipient', now(), CASE WHEN %s THEN now() END, now())""",
                 (trade, proposer, recipient, both))
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
    assert ok(call('GET', f'/api/social/trades/{done}', ash))['other']['completed_trades'] == 1
    assert ok(call('GET', f'/api/social/trades/{half}', ash))['other']['completed_trades'] == 1
    conversation = ok(call('GET', f'/api/social/trades/{done}', ash))['conversation_id']
    assert ok(view(ash, conversation))['other']['completed_trades'] == 1
    assert ok(call('GET', f'/api/social/trade-matches/{misty}', ash))['completed_trades'] == 1
    assert ok(call('GET', f'/api/social/trade-lists/{handle_of(misty)}', ash))['completed_trades'] == 1
    with connect() as conn:
        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (misty,))
        assert trades.completed_trades(conn, [ash]) == {ash: 1}
    assert ok(call('GET', f'/api/social/trades/{done}', ash))['other']['completed_trades'] is None


def test_a_trade_view_names_its_conversation_and_a_left_out_trade_names_none(store):
    ids, ash, misty, binder, box = trading()
    trade = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    conversation = start(ash, misty)
    assert trade['conversation_id'] == conversation
    with connect() as conn:
        conn.execute('UPDATE trade SET conversation_id = NULL WHERE id = %s', (trade['id'],))
    left_out = call('GET', f"/api/social/trades/{trade['id']}", ash)
    assert left_out.status_code == 200 and left_out.json()['conversation_id'] is None


def test_a_message_to_an_existing_conversation_attaches_the_pairs_earlier_trades(store):
    ids, ash, misty, binder, box = trading()
    proposal = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    conversation = proposal['conversation_id']
    with connect() as conn:
        old, old_at = old_trade(conn, ash, misty, age_days=30)
        conn.execute('UPDATE trade SET conversation_id = NULL WHERE id = %s', (old,))
        before = conn.execute('SELECT changed_at, last_activity_at FROM conversation WHERE id = %s',
                              (conversation,)).fetchone()
    ok(say_to(ash, trader_of(misty), 'Hello again'), 201)
    with connect() as conn:
        assert str(conn.execute('SELECT conversation_id FROM trade WHERE id = %s', (old,)).fetchone()['conversation_id']) \
            == conversation
        assert conn.execute('SELECT count(*) AS n FROM conversation WHERE user_low = least(%s COLLATE "C", %s COLLATE "C") '
                            'AND user_high = greatest(%s COLLATE "C", %s COLLATE "C")', (ash, misty, ash, misty)
                            ).fetchone()['n'] == 1
        after = conn.execute('SELECT changed_at, last_activity_at FROM conversation WHERE id = %s',
                             (conversation,)).fetchone()
    assert after['changed_at'] > before['changed_at'] and after['last_activity_at'] > before['last_activity_at']
    shown = [item['trade']['id'] for item in ok(view(ash, conversation))['items'] if item['kind'] == 'trade']
    assert str(old) in shown and proposal['id'] in shown


def test_renames_racing_accepts_and_messages_never_deadlock(store):
    ids, ash, misty, binder, box = trading()
    first = proposed(misty, ash, give=[(ids['PAL 185'], 1)])
    proposals = [first, proposed(misty, ash, give=[(ids['PAL 185'], 1)]), proposed(misty, ash, give=[(ids['PAL 185'], 1)])]
    conversation = first['conversation_id']
    for index, trade in enumerate(proposals):
        with ThreadPoolExecutor(max_workers=3) as executor:
            rename = executor.submit(call, 'PUT', '/api/profile/display-name', ash,
                                     {'display_name': f'Ash R{index}', 'idempotency_key': str(uuid4())})
            accepting = executor.submit(accept_trade, ash, trade)
            talking = executor.submit(say, misty, conversation, f'Round {index}')
            answers = [rename.result(), accepting.result(), talking.result()]
        assert all(answer.status_code < 500 for answer in answers), [answer.text for answer in answers]
        assert [answer.status_code for answer in answers] == [200, 200, 201], [answer.text for answer in answers]


def test_first_contact_from_both_sides_at_once_makes_one_conversation(store):
    for _ in range(3):
        ids, ash, misty, binder, box = trading()
        with ThreadPoolExecutor(max_workers=3) as executor:
            from_ash = executor.submit(propose, ash, misty, [(ids['SVI 166'], 1)])
            from_misty = executor.submit(propose, misty, ash, [(ids['PAL 185'], 1)])
            talking = executor.submit(say_to, ash, trader_of(misty), 'Hello')
            answers = [from_ash.result(), from_misty.result(), talking.result()]
        assert all(answer.status_code < 500 for answer in answers), [answer.text for answer in answers]
        assert [answer.status_code for answer in answers] == [201, 201, 201], [answer.text for answer in answers]
        with connect() as conn:
            [row] = conn.execute('SELECT * FROM conversation WHERE user_low = %s OR user_high = %s', (ash, ash)).fetchall()
            assert conn.execute('SELECT count(*) AS n FROM conversation_member WHERE conversation_id = %s',
                                (row['id'],)).fetchone() == {'n': 2}
            assert {str(item['conversation_id']) for item in conn.execute(
                'SELECT conversation_id FROM trade WHERE proposer_id = %s OR recipient_id = %s', (ash, ash))} == {str(row['id'])}
            assert conn.execute('SELECT conversation_id FROM message WHERE id = %s',
                                (answers[2].json()['id'],)).fetchone() == {'conversation_id': row['id']}
