"""Blocks (social network #248) through signed HTTP against PostgreSQL.

A Block ends any friendship or Friend Request between the two and stops the blocked collector's Handle lookup, Invite
Link use and Friend Requests. The blocked collector is never told: each of those answers exactly as it would for a
collector who doesn't exist, from the same statements. The blocker sees the collector with Unblock, and Settings ›
Privacy lists them.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app.social import friends as friends_module
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_friends import invite_token, lookup, lookups_counted, new_owner, relation, rows, send, step, view
from test_holdings import call, client

ROOT = Path(__file__).resolve().parents[2]


def block(owner, other, key=None):
    return call('POST', '/api/social/blocks', owner, {'collector_id': other, 'idempotency_key': str(key or uuid4())})


def unblock(owner, other):
    return call('POST', f'/api/social/blocks/{other}/unblock', owner, {'idempotency_key': str(uuid4())})


def blocked(owner):
    response = call('GET', '/api/social/blocks', owner)
    assert response.status_code == 200, response.text
    return [person['collector_id'] for person in response.json()['blocked']]


def befriend(a, b):
    send(a, b)
    assert relation(step(b, 'accept', a)) == 'friends'


def same(first, second):
    """Two answers a collector can't tell apart: status, body bytes and the headers that describe the body."""
    assert first.status_code == second.status_code
    assert first.content == second.content
    for header in ('content-type', 'content-length'):
        assert first.headers.get(header) == second.headers.get(header), header


class Recording:
    """A connection that writes down the text of every statement it runs."""

    def __init__(self, conn, log):
        self._conn, self._log = conn, log

    def execute(self, query, params=None):
        self._log.append(str(query))
        return self._conn.execute(query, params)

    def __getattr__(self, name):
        return getattr(self._conn, name)


def statements(monkeypatch, request):
    """Runs ``request()`` with every connection the social module opens recorded; returns its answer and statements."""
    log = []

    @contextmanager
    def recorded():
        with connect() as conn:
            yield Recording(conn, log)
    monkeypatch.setattr(friends_module, 'connect', recorded)
    try:
        return request(), log
    finally:
        monkeypatch.setattr(friends_module, 'connect', connect)


def test_block_ends_the_friendship_and_stops_lookup_invites_and_requests(monkeypatch):
    calls = []
    monkeypatch.setattr(friends_module, 'friendship_ended', lambda conn, a, b: calls.append((a, b)))
    (ash, ash_handle), (misty, misty_handle) = new_owner(), new_owner()
    befriend(ash, misty)
    assert relation(block(misty, ash)) == 'blocked'
    assert calls == [(misty, ash)]
    assert rows(ash, misty) == []
    assert view(ash) == view(misty) == {'received': [], 'friends': [], 'sent': []}
    with connect() as conn:
        assert friends_module.friend_ids(conn, ash) == friends_module.friend_ids(conn, misty) == set()
    # Ash can't find Misty, use her link or ask her again.
    assert (lookup(ash, misty_handle).status_code, lookup(ash, misty_handle).json()) == (
        404, {'detail': {'code': 'COLLECTOR_NOT_FOUND'}})
    opened = call('GET', f'/api/social/invites/{invite_token(misty)}', ash)
    assert (opened.status_code, opened.json()) == (404, {'detail': {'code': 'INVITE_NOT_FOUND'}})
    asked = send(ash, misty)
    assert (asked.status_code, asked.json()) == (404, {'detail': {'code': 'COLLECTOR_NOT_FOUND'}})
    assert rows(ash, misty) == []
    # Misty sees Ash, with Unblock, and in her Blocked list; asking Ash changes nothing while she blocks him.
    found = lookup(misty, ash_handle)
    assert found.json() == {'collector_id': ash, 'handle': ash_handle, 'display_name': 'Collector', 'relation': 'blocked'}
    assert call('GET', f'/api/social/invites/{invite_token(ash)}', misty).json()['relation'] == 'blocked'
    assert relation(send(misty, ash)) == 'blocked'
    assert rows(ash, misty) == []
    assert blocked(misty) == [ash] and blocked(ash) == []


def test_block_withdraws_a_pending_request_either_way():
    (ash, _), (misty, _), (brock, _) = new_owner(), new_owner(), new_owner()
    send(ash, misty)
    send(misty, brock)
    block(misty, ash)
    block(misty, brock)
    assert rows(ash, misty) == rows(misty, brock) == []
    assert view(misty) == {'received': [], 'friends': [], 'sent': []}


def test_a_blocked_you_answer_and_an_unknown_one_are_the_same_bytes_from_the_same_statements(monkeypatch):
    (ash, _), (misty, misty_handle) = new_owner(), new_owner()
    misty_token = invite_token(misty)
    block(misty, ash)
    unknown_handle, unknown_id = f'zz_{uuid4().hex[:12]}', f'nobody-{uuid4()}'
    cases = [
        (lambda: lookup(ash, misty_handle), lambda: lookup(ash, unknown_handle)),
        (lambda: call('GET', f'/api/social/invites/{misty_token}', ash),
         lambda: call('GET', f'/api/social/invites/{"Z" * 32}', ash)),
        (lambda: send(ash, misty), lambda: send(ash, unknown_id)),
    ]
    for blocked_you, unknown in cases:
        first, first_sql = statements(monkeypatch, blocked_you)
        second, second_sql = statements(monkeypatch, unknown)
        assert first.status_code == 404
        same(first, second)
        assert first_sql == second_sql and first_sql
    # Both lookups counted.
    assert lookups_counted(ash) == 2


def test_unblock_reverses_a_block_and_nothing_else():
    (ash, ash_handle), (misty, misty_handle) = new_owner(), new_owner()
    befriend(ash, misty)
    block(misty, ash)
    assert relation(unblock(misty, ash)) == 'none'
    assert blocked(misty) == []
    assert lookup(ash, misty_handle).json()['relation'] == 'none'
    assert lookup(misty, ash_handle).json()['relation'] == 'none'
    # Not Friends again: Ash asks anew.
    assert view(ash)['friends'] == []
    assert relation(send(ash, misty)) == 'request_sent'
    # Unblocking someone not blocked changes nothing, and answers how the two stand.
    assert relation(unblock(misty, ash)) == 'request_received'


def test_blocks_both_ways_hide_each_collector_from_the_other():
    (ash, ash_handle), (misty, misty_handle) = new_owner(), new_owner()
    block(misty, ash)
    # Ash may block Misty although she blocked him first: the answer reveals nothing.
    assert relation(block(ash, misty)) == 'blocked'
    assert lookup(ash, misty_handle).status_code == 404
    assert lookup(misty, ash_handle).status_code == 404
    assert blocked(ash) == [misty] and blocked(misty) == [ash]
    # Each unblocks from Settings; until both have, each still finds nobody.
    unblock(misty, ash)
    assert lookup(misty, ash_handle).status_code == 404
    assert lookup(ash, misty_handle).json()['relation'] == 'blocked'
    unblock(ash, misty)
    assert lookup(misty, ash_handle).json()['relation'] == 'none'


def test_a_blocked_collectors_old_commands_answer_as_after_an_unfriend():
    (ash, _), (misty, _) = new_owner(), new_owner()
    (brock, _), (erika, _) = new_owner(), new_owner()
    befriend(ash, misty)
    befriend(brock, erika)
    block(misty, ash)
    step(erika, 'remove', brock)
    for action in ('remove', 'accept', 'decline', 'withdraw'):
        same(step(ash, action, misty), step(brock, action, erika))
        assert relation(step(ash, action, misty)) == 'none'


def test_friends_of_drops_a_pair_with_a_block_either_way():
    (ash, _), (misty, _), (brock, _) = new_owner(), new_owner(), new_owner()
    befriend(ash, misty)
    befriend(ash, brock)
    # A friendship row that a Block would have deleted, written behind the API's back.
    with connect() as conn:
        conn.execute('INSERT INTO block(blocker_id,blocked_id) VALUES (%s,%s), (%s,%s)', (misty, ash, ash, brock))
        found = conn.execute('SELECT viewer_id,friend_id FROM friends_of(%s)', ([ash, misty, brock],)).fetchall()
    assert found == []


def test_blocks_are_listed_by_name_and_need_a_known_collector():
    ash, _ = new_owner()
    others = []
    for name in ('zoe', 'Brock', 'misty'):
        other = new_owner()[0]
        call('PUT', '/api/profile/display-name', other, {'display_name': name, 'idempotency_key': str(uuid4())})
        block(ash, other)
        others.append((name.casefold(), other))
    assert blocked(ash) == [other for _, other in sorted(others)]
    missing = block(ash, f'nobody-{uuid4()}')
    assert (missing.status_code, missing.json()) == (404, {'detail': {'code': 'COLLECTOR_NOT_FOUND'}})
    assert block(ash, ash).json()['detail']['code'] == 'OWN_ACCOUNT'
    key = uuid4()
    target = new_owner()[0]
    assert block(ash, target, key).json() == block(ash, target, key).json() == {'relation': 'blocked'}
    assert client.get('/api/social/blocks').status_code == 401


def test_a_request_racing_a_block_never_leaves_a_request_from_the_blocked_collector():
    pairs = [(new_owner()[0], new_owner()[0]) for _ in range(8)]
    work = [('send', a, b) for a, b in pairs] + [('block', b, a) for a, b in pairs]

    def run(item):
        action, owner, other = item
        return send(owner, other) if action == 'send' else block(owner, other)
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(run, work))
    assert all(response.status_code in (200, 404) for response in results), [r.text for r in results]
    for a, b in pairs:
        assert rows(a, b) == []
        assert blocked(b) == [a]


@pytest.mark.serial(reason='alters handle_lookup_event and friends_of, which other tests write to')
def test_migration_103_runs_again():
    with connect() as conn, conn.transaction():
        conn.execute((ROOT / 'migrations' / '103_blocks.sql').read_text())
        # The kind check still allows Friend commands, and is there once.
        kinds = conn.execute("""SELECT count(*) FROM pg_constraint WHERE conrelid='handle_lookup_event'::regclass
          AND contype='c' AND pg_get_constraintdef(oid) LIKE '%kind%'""").fetchone()['count']
        assert kinds == 1
        conn.execute("""INSERT INTO handle_lookup_event(user_id,kind)
          SELECT user_id,'friend_command' FROM inventory_owner LIMIT 1""")
        raise psycopg.Rollback()


@pytest.mark.serial(reason='alters handle_lookup_event and friends_of, which other tests write to')
def test_migration_103_widens_the_old_kind_check():
    """Migration 100's check, as a database that has run 100 and 102 but not yet 103 has it."""
    owner = new_owner()[0]
    with connect() as conn, conn.transaction():
        for name in conn.execute("""SELECT conname FROM pg_constraint WHERE conrelid='handle_lookup_event'::regclass
          AND contype='c' AND pg_get_constraintdef(oid) LIKE '%kind%'""").fetchall():
            conn.execute(f'ALTER TABLE handle_lookup_event DROP CONSTRAINT "{name["conname"]}"')
        conn.execute("""ALTER TABLE handle_lookup_event ADD CONSTRAINT handle_lookup_event_kind_check
          CHECK (kind IN ('lookup','handle_change')) NOT VALID""")
        try:
            with conn.transaction():
                conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,'friend_command')", (owner,))
            raise AssertionError('the old check should refuse friend_command')
        except psycopg.errors.CheckViolation:
            pass
        conn.execute('DROP TABLE friend_request_declined')
        conn.execute((ROOT / 'migrations' / '103_blocks.sql').read_text())
        kinds = conn.execute("""SELECT count(*) FROM pg_constraint WHERE conrelid='handle_lookup_event'::regclass
          AND contype='c' AND pg_get_constraintdef(oid) LIKE '%kind%'""").fetchone()['count']
        assert kinds == 1
        conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,'friend_command')", (owner,))
        assert conn.execute("SELECT to_regclass('friend_request_declined') AS t").fetchone()['t']
        raise psycopg.Rollback()
