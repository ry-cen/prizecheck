"""What a stranger never learns (Trading #299; Stage 2 spec "Identity" and its privacy tests).

Two collectors who are not Friends but are both in open discovery (``stranger_fixtures.strangers``: Misty at zip 00010,
Ash at 00011) trade and message by trader id only. These are the five privacy tests the spec names for this slice: no
response Ash reads carries Misty's zip, coordinates, distance, Handle or user id; a Handle lookup never leads to a
trader id; unknown and unreachable trader ids answer byte-identical 404s; a Block reads like a suspension to the
blocked side; and the band shows only while both are in open discovery. The Near you, card search, Report and
Add-as-Friend parts arrive with #300, #303 and #304, which extend these tests.
"""
import json
from datetime import datetime
from uuid import uuid4

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from stranger_fixtures import far_zip, propose_to, strangers, trader_of
from test_blocks import unblock
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_conversations import detail, start, swapped, view
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_friend_copies import block, collector, ok
from test_holdings import call
from test_open_discovery import discoverable, put
from test_trade_wants import set_want

COLLECTOR_UNKNOWN = b'{"detail":{"code":"COLLECTOR_NOT_FOUND"}}'
FORBIDDEN_KEYS = {'miles', 'distance', 'lat', 'lon', 'latitude', 'longitude', 'zip'}


def nearby_pair():
    """strangers(), a message from Ash to Misty and a proposal from Misty to Ash by trader id. Returns
    (ids, ash, misty, conversation_id, trade_id)."""
    ids, ash, misty, _, _ = strangers()
    conversation = start(ash, misty)
    proposal = ok(propose_to(misty, trader_of(ash), give=[(ids['PAL 185'], 1)], get=[(ids['SVI 166'], 1)]), 201)
    return ids, ash, misty, conversation, proposal['id']


def handle_of(user):
    with connect() as conn:
        return conn.execute('SELECT handle FROM collector_profile WHERE user_id = %s', (user,)).fetchone()['handle']


def is_timestamp(text):
    try:
        datetime.fromisoformat(text)
    except ValueError:
        return False
    return True


def walk(value, path=''):
    """Every (path, key or None, leaf) of a JSON body."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield (f'{path}.{key}', key, None)
            yield from walk(item, f'{path}.{key}')
    elif isinstance(value, list):
        for item in value:
            yield from walk(item, path + '[]')
    else:
        yield (path, None, value)


def no_leaks(user, other, paths):
    """Every path answers 200 for ``user`` and carries no zip, coordinate, distance, ``other``'s Handle or user id."""
    handle = handle_of(other).lower()
    for path in paths:
        response = call('GET', path, user)
        assert response.status_code == 200, (path, response.text)
        for where, key, leaf in walk(response.json()):
            assert key not in FORBIDDEN_KEYS, (path, where)
            if isinstance(leaf, str):
                assert other not in leaf and handle not in leaf.lower(), (path, where)
                if not is_timestamp(leaf):
                    assert not any(part in leaf for part in ('00010', '40.00', '40.10', '-100.00')), (path, where)
            if isinstance(leaf, float):
                assert round(leaf, 2) not in (40.0, 40.1, -100.0), (path, where)


def test_no_stranger_response_carries_a_zip_coordinate_distance_handle_or_user_id(store):
    ids, ash, misty, conversation, trade = nearby_pair()
    handle = handle_of(misty).lower()
    paths = ['/api/social/discovery', f'/api/social/traders/{trader_of(misty)}',
             f'/api/social/traders/{trader_of(misty)}/trade-list', f'/api/social/traders/{trader_of(misty)}/matches',
             '/api/social/conversations', f'/api/social/conversations/{conversation}',
             f'/api/social/conversations/with/{trader_of(misty)}', '/api/social/conversations/pulse',
             '/api/social/trades', f'/api/social/trades/{trade}', '/api/social/inbox', '/api/social/blocks',
             '/api/social/friends']
    for path in paths:
        response = call('GET', path, ash)
        assert response.status_code == 200, (path, response.text)
        for where, key, leaf in walk(response.json()):
            if key is not None:
                # Ash's own setting is the one place a zip is allowed.
                assert key not in FORBIDDEN_KEYS or (key == 'zip' and path == '/api/social/discovery'), (path, where)
            if isinstance(leaf, str):
                assert misty not in leaf and handle not in leaf.lower(), (path, where)
                if not is_timestamp(leaf):
                    assert not any(part in leaf for part in ('00010', '40.00', '40.10', '-100.00')), (path, where)
            if isinstance(leaf, float):
                assert round(leaf, 2) not in (40.0, 40.1, -100.0), (path, where)


def test_a_handle_lookup_never_leads_to_a_trader_id(store):
    ids, ash, misty, _, _ = strangers()
    looked = call('POST', '/api/social/lookup', ash, {'handle': handle_of(misty)})
    assert looked.status_code == 200, looked.text
    assert trader_of(misty) not in looked.text
    ok(call('POST', '/api/social/blocks', ash, {'collector_id': misty, 'idempotency_key': str(uuid4())}))
    blocks = call('GET', '/api/social/blocks', ash)
    assert blocks.status_code == 200 and trader_of(misty) not in blocks.text
    assert [{k: v for k, v in row.items() if k != 'block_id'} for row in blocks.json()['blocked']] == [
        {'display_name': 'Misty W.', 'handle': None, 'trader_id': None}]
    assert misty not in blocks.text
    ok(unblock(ash, misty))
    assert call('POST', '/api/social/lookup', ash, {'handle': handle_of(misty)}).status_code == 200
    # The near branch holds, but a send by user id needs a Friend.
    refused = call('POST', '/api/trades', ash, {'recipient_id': misty, 'you_give': [], 'idempotency_key': str(uuid4()),
                                                'you_get': [{'edition_id': ids['PAL 185'], 'quantity': '1'}]})
    assert detail(refused) == (409, {'code': 'COLLECTOR_UNAVAILABLE'})
    with connect() as conn:
        low, high = sorted((ash, misty))
        assert conn.execute('SELECT count(*) AS n FROM trade WHERE proposer_id IN (%s, %s)', (ash, misty)).fetchone()['n'] == 0
        assert conn.execute('SELECT count(*) AS n FROM conversation WHERE user_low = %s AND user_high = %s',
                            (low, high)).fetchone()['n'] == 0
    # Add as Friend from a both-confirmed Trade (trading #304): nothing Ash reads holds Misty's Handle or user id.
    with connect() as conn:
        trade = swapped(conn, misty, ash)
    sent = call('POST', f'/api/social/trades/{trade}/add-friend', ash, {'idempotency_key': str(uuid4())})
    assert sent.status_code == 200 and sent.json() == {'relation': 'request_sent'}, sent.text
    assert handle_of(misty).lower() not in sent.text.lower() and misty not in sent.text
    reads = ['/api/social/friends', f'/api/social/traders/{trader_of(misty)}', f'/api/social/trades/{trade}',
             '/api/social/conversations']

    def holds_neither():
        for path in reads:
            response = call('GET', path, ash)
            assert response.status_code == 200, (path, response.text)
            assert handle_of(misty).lower() not in response.text.lower() and misty not in response.text, path

    holds_neither()
    ok(call('POST', '/api/social/blocks', ash, {'collector_id': misty, 'idempotency_key': str(uuid4())}))
    for path in ('/api/social/friends', f'/api/social/traders/{trader_of(misty)}'):
        response = call('GET', path, ash)
        assert response.status_code == 200, (path, response.text)
        assert handle_of(misty).lower() not in response.text.lower() and misty not in response.text, path
    with connect() as conn:
        low, high = sorted((ash, misty))
        assert conn.execute('SELECT count(*) AS n FROM friendship WHERE user_low = %s AND user_high = %s',
                            (low, high)).fetchone()['n'] == 0
    # The Block was made while Ash's via_trade request was pending: the Blocked list holds no Handle or user id.
    blocks = call('GET', '/api/social/blocks', ash)
    assert blocks.status_code == 200, blocks.text
    assert [{k: v for k, v in row.items() if k != 'block_id'} for row in blocks.json()['blocked']] == [
        {'display_name': 'Misty W.', 'handle': None, 'trader_id': None}]
    assert handle_of(misty).lower() not in blocks.text.lower()
    assert trader_of(misty) not in blocks.text and misty not in blocks.text


def test_unknown_and_unreachable_trader_ids_answer_byte_identical_404s(store):
    ids, ash, misty, _, _ = strangers()
    far, _ = collector('Far W.')
    discoverable(far, far_zip())
    blocker, _ = collector('Blocker')
    blocked, _ = collector('Blocked')
    discoverable(blocker, '00010')
    discoverable(blocked, '00010')
    block(blocker, ash)
    block(ash, blocked)
    answers = set()
    for other in (str(uuid4()), trader_of(ash), trader_of(far), trader_of(blocker), trader_of(blocked)):
        for suffix in ('', '/trade-list', '/matches'):
            response = call('GET', f'/api/social/traders/{other}{suffix}', ash)
            answers.add((response.status_code, response.content))
    assert answers == {(404, COLLECTOR_UNKNOWN)}


def test_a_block_reads_like_a_suspension_to_the_blocked_side(store):
    def conversing(name):
        viewer, _ = collector(f'{name} Viewer')
        other, _ = collector(f'{name} Other')
        discoverable(viewer, '00010')
        discoverable(other, '00011')
        return viewer, other, start(viewer, other)

    viewer_a, other_a, conversation_a = conversing('Blocked')
    viewer_b, other_b, conversation_b = conversing('Suspended')
    block(other_a, viewer_a)
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (other_b,))

    def alike(seen):
        return {**{key: value for key, value in seen.items()
                   if key not in ('id', 'items', 'trader_id', 'display_name', 'conversation_id')},
                'other': {key: value for key, value in seen.get('other', {}).items()
                          if key not in ('display_name', 'trader_id')}}

    header_a = ok(call('GET', f'/api/social/traders/{trader_of(other_a)}', viewer_a))
    header_b = ok(call('GET', f'/api/social/traders/{trader_of(other_b)}', viewer_b))
    assert header_a['status'] == 'unavailable' and alike(header_a) == alike(header_b)
    assert alike(ok(view(viewer_a, conversation_a))) == alike(ok(view(viewer_b, conversation_b)))


def test_no_band_while_either_side_has_discovery_off(store):
    ids, ash, misty, conversation, _ = nearby_pair()

    def bands():
        header = ok(call('GET', f'/api/social/traders/{trader_of(misty)}', ash))['band']
        listed = ok(call('GET', f'/api/social/traders/{trader_of(misty)}/trade-list', ash))['band']
        talking = ok(view(ash, conversation))['other']['band']
        return header, listed, talking

    assert bands() == ('5_to_10',) * 3
    ok(put(misty, {'enabled': False}))
    assert bands() == (None, None, None)
    ok(put(misty, {'enabled': True}))
    assert bands() == ('5_to_10',) * 3
    ok(put(ash, {'enabled': False}))
    assert bands() == (None, None, None)


def test_near_you_and_card_search_carry_no_zip_coordinate_distance_handle_or_user_id(store):
    ids, ash, misty, _, _ = strangers()
    ok(set_want(ash, ids['PAL 185'], 1))
    handle = handle_of(misty).lower()
    printing = trade_printing(ids['PAL 185'])
    paths = ['/api/social/trade-matches/near'] + [
        f'/api/social/trade-card-search?printing_id={printing}&scope={scope}' for scope in ('name', 'set', 'printing')]
    for path in paths:
        body = call('GET', path, ash)
        assert body.status_code == 200, (path, body.text)
        body = body.json()
        assert trader_of(misty) in json.dumps(body), path
        for where, key, leaf in walk(body):
            if key is not None:
                assert key not in FORBIDDEN_KEYS, (path, where)
            if key == 'radius_mi':
                continue
            if isinstance(leaf, str):
                assert misty not in leaf and handle not in leaf.lower(), (path, where)
                if not is_timestamp(leaf):
                    assert not any(part in leaf for part in ('00010', '40.00', '40.10', '-100.00')), (path, where)
            if isinstance(leaf, float):
                assert round(leaf, 2) not in (40.0, 40.1, -100.0), (path, where)
        radii = [leaf for where, key, leaf in walk(body) if key is None and where.endswith('.radius_mi')]
        assert all(radius in (5, 10, 25, 50) for radius in radii), path


def trade_printing(edition):
    with connect() as conn:
        return str(conn.execute('SELECT printing_id FROM catalog_edition WHERE id = %s', (edition,)).fetchone()['printing_id'])


def test_a_refused_first_contact_names_only_its_code_and_wait(store):
    ids, ash, misty, _, _ = strangers()
    other, _ = collector('Brock S.')
    discoverable(other, '00011')
    with connect() as conn:
        conn.execute("""INSERT INTO handle_lookup_event(user_id, kind, created_at)
          SELECT %s, 'new_conversation', now() - interval '1 hour' FROM generate_series(1, 10)""", (ash,))
    response = call('POST', f'/api/social/traders/{trader_of(other)}/messages', ash,
                    {'body': 'Hi', 'idempotency_key': str(uuid4())})
    assert response.status_code == 429, response.text
    assert set(response.json()['detail']) == {'code', 'retry_after_minutes'}
    assert response.json()['detail']['code'] == 'TOO_MANY_NEW_CONVERSATIONS'
    for where, key, leaf in walk(response.json()):
        assert key not in FORBIDDEN_KEYS | {'handle', 'user_id', 'collector_id'}, where


def test_identity_routes_never_tie_a_user_id_to_a_trader_id_through_a_block(store):
    from test_blocks import same
    from test_stranger_blocks import block_row
    ids, ash, misty, _, _ = strangers()
    brock, _ = collector('Brock')
    ok(call('POST', f'/api/social/traders/{trader_of(misty)}/block', ash, {'idempotency_key': str(uuid4())}))
    first = block_row(ash, misty)
    same(unblock(ash, misty), unblock(ash, brock))
    same(call('POST', '/api/social/blocks', ash, {'collector_id': misty, 'idempotency_key': str(uuid4())}),
         call('POST', '/api/social/blocks', ash, {'collector_id': brock, 'idempotency_key': str(uuid4())}))
    assert dict(block_row(ash, misty)) == dict(first)
    [row] = [row for row in ok(call('GET', '/api/social/blocks', ash))['blocked'] if row['block_id'] == str(first['id'])]
    assert row['trader_id'] == trader_of(misty)


def test_a_trader_block_reads_like_a_suspension_to_the_blocked_side(store):
    from test_stranger_blocks import block_trader

    def conversing(name):
        viewer, _ = collector(f'{name} Viewer')
        other, _ = collector(f'{name} Other')
        discoverable(viewer, '00010')
        discoverable(other, '00011')
        return viewer, other, start(viewer, other)

    viewer_a, other_a, conversation_a = conversing('Blocked')
    viewer_b, other_b, conversation_b = conversing('Suspended')
    ok(block_trader(other_a, trader_of(viewer_a)))
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (other_b,))

    def alike(seen):
        return {**{key: value for key, value in seen.items()
                   if key not in ('id', 'items', 'trader_id', 'display_name', 'conversation_id')},
                'other': {key: value for key, value in seen.get('other', {}).items()
                          if key not in ('display_name', 'trader_id')}}

    header_a = ok(call('GET', f'/api/social/traders/{trader_of(other_a)}', viewer_a))
    header_b = ok(call('GET', f'/api/social/traders/{trader_of(other_b)}', viewer_b))
    assert header_a['status'] == 'unavailable' and alike(header_a) == alike(header_b)
    assert alike(ok(view(viewer_a, conversation_a))) == alike(ok(view(viewer_b, conversation_b)))


def test_the_blocked_list_and_friends_carry_no_zip_handle_or_user_id_after_a_trader_block(store):
    from test_stranger_blocks import block_trader
    ids, ash, misty, conversation, trade = nearby_pair()
    ok(block_trader(ash, trader_of(misty)))
    no_leaks(ash, misty, ['/api/social/blocks', '/api/social/friends', '/api/social/conversations',
                          f'/api/social/conversations/{conversation}',
                          f'/api/social/conversations/with/{trader_of(misty)}',
                          f'/api/social/traders/{trader_of(misty)}'])
    [row] = ok(call('GET', '/api/social/blocks', ash))['blocked']
    assert row['trader_id'] == trader_of(misty) and row['handle'] is None


def test_add_as_friend_shows_the_requester_no_handle_or_user_id_before_acceptance(store):
    ids, ash, misty, conversation, _ = nearby_pair()
    with connect() as conn:
        trade = swapped(conn, misty, ash)
    handle = handle_of(misty).lower()

    def command(path):
        response = call('POST', f'/api/social/trades/{trade}/{path}', ash, {'idempotency_key': str(uuid4())})
        assert response.status_code == 200, (path, response.text)
        return response

    def holds_neither(label, response):
        for where, _, leaf in walk(response.json()):
            if isinstance(leaf, str):
                assert misty not in leaf and handle not in leaf.lower(), (label, where)

    assert command('add-friend').json() == {'relation': 'request_sent'}
    assert command('add-friend/withdraw').json() == {'relation': 'none'}
    answers = [command('add-friend')]
    assert answers[0].json() == {'relation': 'request_sent'}
    for answer in answers:
        holds_neither('add-friend', answer)
    paths = ['/api/social/discovery', f'/api/social/traders/{trader_of(misty)}',
             f'/api/social/traders/{trader_of(misty)}/trade-list', f'/api/social/traders/{trader_of(misty)}/matches',
             '/api/social/conversations', f'/api/social/conversations/{conversation}',
             f'/api/social/conversations/with/{trader_of(misty)}', '/api/social/conversations/pulse',
             '/api/social/trades', f'/api/social/trades/{trade}', '/api/social/inbox', '/api/social/blocks',
             '/api/social/friends']
    for path in paths:
        response = call('GET', path, ash)
        assert response.status_code == 200, (path, response.text)
        holds_neither(path, response)
    accepted = call('POST', f'/api/social/friend-requests/{ash}/accept', misty, {'idempotency_key': str(uuid4())})
    assert ok(accepted) == {'relation': 'friends'}
    assert handle in call('GET', '/api/social/friends', ash).text.lower()
