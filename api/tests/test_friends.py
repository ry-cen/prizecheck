"""Friends and Friend Requests (social network #247) through signed HTTP against PostgreSQL.

A collector finds another by exact Handle (case ignored, 30 lookups an hour, only lookups count) or by their Invite
Link signed in, and sends a Friend Request. Friendship is one row per pair: accepting makes it mutual, declining and
withdrawing delete the request, and Remove Friend ends it for both.
"""
import secrets
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app.social import friends as friends_module
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_holdings import call, client

ROOT = Path(__file__).resolve().parents[2]
# Consonants only: a random run of them never trips the name filter. Its vowel-less words (bbw, nsfw, xxx and the like)
# match whole words only, which a 12-letter run never is, and every inside-word entry has a vowel.
QUIET = 'bcdfghjklmnpqrstvwxz'


def quiet(length=12):
    return ''.join(secrets.choice(QUIET) for _ in range(length))


def new_owner(prefix='friend'):
    """A collector with a profile and a Handle of their own."""
    owner = f'{prefix}-{uuid4()}'
    handle = f'f{quiet()}'
    response = call('PUT', '/api/profile/handle', owner, {'handle': handle, 'idempotency_key': str(uuid4())})
    assert response.status_code == 200, response.text
    return owner, handle


def lookup(owner, handle):
    return call('POST', '/api/social/lookup', owner, {'handle': handle})


def view(owner):
    response = call('GET', '/api/social/friends', owner)
    assert response.status_code == 200, response.text
    return {part: [person['collector_id'] for person in people] for part, people in response.json().items()}


def send(owner, other, key=None):
    return call('POST', '/api/social/friend-requests', owner,
                {'collector_id': other, 'idempotency_key': str(key or uuid4())})


def step(owner, action, other, key=None):
    path = (f'/api/social/friends/{other}/remove' if action == 'remove'
            else f'/api/social/friend-requests/{other}/{action}')
    return call('POST', path, owner, {'idempotency_key': str(key or uuid4())})


def relation(response):
    assert response.status_code == 200, response.text
    return response.json()['relation']


def code(response):
    return response.json()['detail']['code']


def rows(a, b):
    low, high = sorted((a, b))
    with connect() as conn:
        return conn.execute('SELECT user_low,user_high,state,requested_by FROM friendship WHERE user_low=%s AND user_high=%s',
                            (low, high)).fetchall()


def lookups_counted(owner):
    with connect() as conn:
        return conn.execute("SELECT count(*) FROM handle_lookup_event WHERE user_id=%s AND kind='lookup'",
                            (owner,)).fetchone()['count']


def invite_token(owner):
    return call('GET', '/api/profile', owner).json()['invite_token']


def test_a_friend_request_becomes_a_mutual_friendship_when_accepted():
    (ash, _), (misty, misty_handle) = new_owner(), new_owner()
    found = lookup(ash, misty_handle)
    assert found.status_code == 200, found.text
    assert found.json() == {'collector_id': misty, 'handle': misty_handle, 'display_name': 'Collector',
                            'relation': 'none'}
    assert relation(send(ash, misty)) == 'request_sent'
    assert view(ash) == {'received': [], 'friends': [], 'sent': [misty]}
    assert view(misty) == {'received': [ash], 'friends': [], 'sent': []}
    assert lookup(ash, misty_handle).json()['relation'] == 'request_sent'
    assert relation(step(misty, 'accept', ash)) == 'friends'
    assert view(ash) == {'received': [], 'friends': [misty], 'sent': []}
    assert view(misty) == {'received': [], 'friends': [ash], 'sent': []}
    # Stored once, for the pair, in byte order.
    low, high = sorted((ash, misty))
    assert rows(ash, misty) == [{'user_low': low, 'user_high': high, 'state': 'accepted', 'requested_by': ash}]
    with connect() as conn:
        assert friends_module.friend_ids(conn, ash) == {misty}
        assert friends_module.friend_ids(conn, misty) == {ash}


def test_decline_and_withdraw_delete_the_request():
    (ash, _), (misty, misty_handle) = new_owner(), new_owner()
    send(ash, misty)
    assert relation(step(misty, 'decline', ash)) == 'none'
    assert rows(ash, misty) == []
    assert view(ash) == view(misty) == {'received': [], 'friends': [], 'sent': []}
    # The sender can ask again, and withdraw.
    assert relation(send(ash, misty)) == 'request_sent'
    assert relation(step(ash, 'withdraw', misty)) == 'none'
    assert rows(ash, misty) == []
    assert lookup(ash, misty_handle).json()['relation'] == 'none'
    # Only the recipient declines or accepts, and only the sender withdraws: anything else changes nothing.
    send(ash, misty)
    assert relation(step(ash, 'accept', misty)) == 'request_sent'
    assert relation(step(ash, 'decline', misty)) == 'request_sent'
    assert relation(step(misty, 'withdraw', ash)) == 'request_received'
    assert rows(ash, misty)[0]['state'] == 'pending'


def test_a_request_while_one_is_pending_either_way_changes_nothing():
    (ash, ash_handle), (misty, _) = new_owner(), new_owner()
    send(ash, misty)
    # Misty asks back: she is told a request is waiting for her, and the pending one stays Ash's.
    assert relation(send(misty, ash)) == 'request_received'
    assert lookup(misty, ash_handle).json()['relation'] == 'request_received'
    assert relation(send(ash, misty)) == 'request_sent'
    assert [row['requested_by'] for row in rows(ash, misty)] == [ash]
    step(misty, 'accept', ash)
    assert relation(send(ash, misty)) == 'friends'
    assert relation(send(misty, ash)) == 'friends'
    assert len(rows(ash, misty)) == 1


def test_remove_friend_ends_it_for_both_and_runs_the_loan_hook(monkeypatch):
    calls = []
    monkeypatch.setattr(friends_module, 'friendship_ended', lambda conn, a, b: calls.append((a, b)))
    (ash, _), (misty, _), (brock, _) = new_owner(), new_owner(), new_owner()
    for other in (misty, brock):
        send(ash, other)
        step(other, 'accept', ash)
    assert relation(step(ash, 'remove', misty)) == 'none'
    assert relation(step(brock, 'remove', ash)) == 'none'
    assert calls == [(ash, misty), (brock, ash)]
    assert view(ash) == view(misty) == view(brock) == {'received': [], 'friends': [], 'sent': []}
    # Not Friends: nothing to end, and the hook doesn't run; nor do declines and withdrawals.
    assert relation(step(ash, 'remove', misty)) == 'none'
    send(ash, misty)
    step(misty, 'decline', ash)
    send(ash, brock)
    step(ash, 'withdraw', brock)
    assert calls == [(ash, misty), (brock, ash)]


def test_lookup_is_exact_and_ignores_case():
    ash, ash_handle = new_owner()
    misty, chosen = f'friend-{uuid4()}', f'Misty_{quiet(8)}'
    assert call('PUT', '/api/profile/handle', misty, {'handle': chosen, 'idempotency_key': str(uuid4())}).status_code == 200
    for typed in (chosen, chosen.lower(), chosen.upper(), f'  {chosen}  '):
        found = lookup(ash, typed)
        assert found.status_code == 200, typed
        # Shown in the case Misty chose.
        assert found.json()['handle'] == chosen
    for typed in (chosen[:-1], f'{chosen}x', 'zz_' + uuid4().hex[:12]):
        missed = lookup(ash, typed)
        assert (missed.status_code, missed.json()) == (404, {'detail': {'code': 'COLLECTOR_NOT_FOUND'}}), typed
    assert lookup(ash, ash_handle).json()['relation'] == 'self'
    # A Handle that can't exist is refused before the count.
    before = lookups_counted(ash)
    for typed in ('ab', 'has space', 'dash-ed', 'x' * 21, ''):
        assert code(lookup(ash, typed)) == 'INVALID_HANDLE', typed
    assert lookups_counted(ash) == before


def test_thirty_lookups_an_hour_then_too_many_and_only_lookups_count():
    (ash, _), (misty, misty_handle) = new_owner(), new_owner()
    for index in range(30):
        # Hits and misses both count.
        response = lookup(ash, misty_handle if index % 2 else f'zz_{uuid4().hex[:12]}')
        assert response.status_code in (200, 404)
    refused = lookup(ash, misty_handle)
    assert refused.status_code == 429
    assert refused.json()['detail']['code'] == 'TOO_MANY_LOOKUPS'
    assert 1 <= refused.json()['detail']['retry_after_minutes'] <= 60
    assert lookups_counted(ash) == 30
    # Invite Link reads and Friend Requests don't count, and still work.
    assert call('GET', f'/api/social/invites/{invite_token(misty)}', ash).status_code == 200
    assert relation(send(ash, misty)) == 'request_sent'
    assert relation(step(ash, 'withdraw', misty)) == 'none'
    assert lookups_counted(ash) == 30
    # Another collector has their own allowance.
    assert lookup(misty, misty_handle).status_code == 200
    # An hour on, the oldest lookups have run out; the next lookup prunes them.
    with connect() as conn:
        conn.execute("""UPDATE handle_lookup_event SET created_at=created_at - interval '61 minutes'
          WHERE user_id=%s AND kind='lookup'""", (ash,))
    assert lookup(ash, misty_handle).status_code == 200
    assert lookups_counted(ash) == 1


def test_the_minutes_to_wait_follow_the_oldest_counted_lookup():
    (ash, _), (_, misty_handle) = new_owner(), new_owner()
    with connect() as conn:
        conn.execute("""INSERT INTO handle_lookup_event(user_id,kind,created_at)
          SELECT %s,'lookup',now() - interval '50 minutes' FROM generate_series(1,30)""", (ash,))
    refused = lookup(ash, misty_handle)
    assert refused.status_code == 429
    assert refused.json()['detail']['retry_after_minutes'] in (10, 11)


def test_the_invite_link_signed_in_names_its_collector_and_never_sends_a_request():
    (ash, _), (misty, misty_handle) = new_owner(), new_owner()
    token = invite_token(misty)
    opened = call('GET', f'/api/social/invites/{token}', ash)
    assert opened.status_code == 200, opened.text
    assert opened.json() == {'collector_id': misty, 'handle': misty_handle, 'display_name': 'Collector',
                             'relation': 'none'}
    assert rows(ash, misty) == []
    assert call('GET', f'/api/social/invites/{token}', misty).json()['relation'] == 'self'
    send(ash, misty)
    assert call('GET', f'/api/social/invites/{token}', ash).json()['relation'] == 'request_sent'
    assert call('GET', f'/api/social/invites/{invite_token(ash)}', misty).json()['relation'] == 'request_received'
    # A replaced link, an unknown one and a malformed one answer alike.
    call('POST', '/api/profile/invite-link', misty, {'idempotency_key': str(uuid4())})
    for stale in (token, 'A' * 32, 'short'):
        missed = call('GET', f'/api/social/invites/{stale}', ash)
        assert (missed.status_code, missed.json()) == (404, {'detail': {'code': 'INVITE_NOT_FOUND'}}), stale
    assert lookups_counted(ash) == 0


def test_commands_replay_by_their_idempotency_key_and_never_move_the_inventory_revision():
    (ash, _), (misty, _) = new_owner(), new_owner()
    with connect() as conn:
        before = {row['user_id']: row['revision'] for row in conn.execute(
            'SELECT user_id,revision FROM inventory_owner WHERE user_id = ANY(%s)', ([ash, misty],))}
    key = uuid4()
    assert relation(send(ash, misty, key)) == 'request_sent'
    step(ash, 'withdraw', misty)
    # The replay is the stored answer, not a new request.
    assert relation(send(ash, misty, key)) == 'request_sent'
    assert rows(ash, misty) == []
    assert code(step(ash, 'withdraw', misty, key)) == 'IDEMPOTENCY_KEY_REUSED'
    send(ash, misty)
    step(misty, 'accept', ash)
    step(misty, 'remove', ash)
    with connect() as conn:
        after = {row['user_id']: row['revision'] for row in conn.execute(
            'SELECT user_id,revision FROM inventory_owner WHERE user_id = ANY(%s)', ([ash, misty],))}
    assert after == before


def test_commands_need_another_known_collector():
    ash, _ = new_owner()
    for response in (send(ash, f'nobody-{uuid4()}'), step(ash, 'accept', f'nobody-{uuid4()}'),
                     step(ash, 'remove', f'nobody-{uuid4()}')):
        assert (response.status_code, response.json()) == (404, {'detail': {'code': 'COLLECTOR_NOT_FOUND'}})
    assert code(send(ash, ash)) == 'OWN_ACCOUNT'
    assert client.get('/api/social/friends').status_code == 401
    assert client.post('/api/social/lookup', json={'handle': 'anyone'}).status_code == 401


def test_pairs_are_stored_in_byte_order_whatever_the_database_collation():
    # Upper-case letters sort before lower-case ones byte by byte, but not in most language collations.
    stem = uuid4().hex[:8]
    upper, lower = f'B-{stem}', f'a-{stem}'
    for owner in (upper, lower):
        assert call('GET', '/api/profile', owner).status_code == 200
    assert relation(send(lower, upper)) == 'request_sent'
    assert relation(step(upper, 'accept', lower)) == 'friends'
    assert rows(upper, lower)[0]['user_low'] == upper


def test_requests_crossing_from_both_sides_leave_one_row():
    pairs = [(new_owner()[0], new_owner()[0]) for _ in range(8)]
    work = [(a, b) for a, b in pairs] + [(b, a) for a, b in pairs]
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda pair: send(*pair), work))
    assert all(response.status_code == 200 for response in results), [r.text for r in results]
    for a, b in pairs:
        stored = rows(a, b)
        assert len(stored) == 1 and stored[0]['state'] == 'pending'
        first = stored[0]['requested_by']
        assert {relation(send(a, b)), relation(send(b, a))} == {'request_sent', 'request_received'}
        assert first in (a, b)


def test_friends_are_listed_by_name_and_requests_oldest_first():
    ash = new_owner()[0]
    named = []
    for name in ('zoe', 'Brock', 'misty'):
        other = new_owner()[0]
        call('PUT', '/api/profile/display-name', other, {'display_name': name, 'idempotency_key': str(uuid4())})
        send(ash, other)
        step(other, 'accept', ash)
        named.append((name.casefold(), other))
    asked = [new_owner()[0] for _ in range(3)]
    for other in asked:
        send(other, ash)
    assert view(ash) == {'received': asked, 'friends': [other for _, other in sorted(named)], 'sent': []}


def test_migration_102_runs_again():
    with connect() as conn, conn.transaction():
        conn.execute((ROOT / 'migrations' / '102_friends.sql').read_text())
