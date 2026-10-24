"""The reach rule at the SQL seam (Trading #299): migration 148's ``trade_reach`` (its branches and exclusions), its
``nearby_collectors``, and the migration itself (existing Blocks stay shown, re-runnable).

The SQL tests name the discovery tables themselves. The Python side (``app.social.discovery.reach``, the choke point's
``among`` and ``visible_beyond_friends``) is covered at the end of the file.
"""
import hashlib
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from app.social import discovery, friend_copies
from stranger_fixtures import strangers
from test_catalog_references import migrate
from test_blocks import unblock
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_ending_friendship import remove
from test_friend_copies import block as api_block, collector, ok
from test_holdings import call
from test_open_discovery import discoverable
from test_trade_migrations import collector as owner_row, run_again, scratch  # noqa: F401
from test_trade_wants import set_want
from test_trades import trading

MIGRATION = '148_trade_reach.sql'
HERE = (40.0, -100.0)
NEAR = (40.1, -100.0)         # about 6.9 miles: band 2
EDGE_IN = (40.7, -100.0)      # about 48.4 miles: band 4
EDGE_OUT = (40.75, -100.0)    # about 51.8 miles: no band
MOVED = (45.0, -100.0)
# nearby_collectors reads every collector in open discovery, and other tests switch collectors on around HERE in the
# same database, so its test measures from a corner of the map no other test uses.
REMOTE = (-30.0, 100.0)


def person(conn, name):
    """An account with an owner row (its profile comes with it); returns its id."""
    user = f'reach-{name}-{uuid4()}'
    owner_row(conn, user)
    return user


def place(conn, user, lat, lon, enabled=True):
    conn.execute("""INSERT INTO discovery_setting (user_id, enabled, zip, lat, lon) VALUES (%s, %s, '00010', %s, %s)
      ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, lat = EXCLUDED.lat, lon = EXCLUDED.lon""",
                 (user, enabled, lat, lon))


def friends(conn, one, two):
    low, high = sorted((one, two))
    conn.execute("INSERT INTO friendship(user_low, user_high, state, requested_by) VALUES (%s, %s, 'accepted', %s)",
                 (low, high, low))


def talk(conn, one, two):
    conn.execute("SELECT pair_conversation(%s, %s, 'A', 'B')", (one, two))


def blocks(conn, blocker, blocked):
    conn.execute('INSERT INTO block (blocker_id, blocked_id) VALUES (%s, %s)', (blocker, blocked))


def suspend(conn, user):
    conn.execute('UPDATE collector_profile SET suspended_at = now() WHERE user_id = %s', (user,))


def reached(conn, viewer, others):
    rows = conn.execute('SELECT other_id, how, band FROM trade_reach(%s, %s::text[])', (viewer, others)).fetchall()
    return {row['other_id']: (row['how'], row['band']) for row in rows}


def trader_of(conn, user):
    return conn.execute('SELECT trader_id FROM collector_profile WHERE user_id = %s', (user,)).fetchone()['trader_id']


def test_each_branch_answers_how_and_band(store):
    with connect() as conn:
        viewer = person(conn, 'viewer')
        place(conn, viewer, *HERE)
        friend = person(conn, 'friend')
        place(conn, friend, *NEAR)
        friends(conn, viewer, friend)
        partner = person(conn, 'partner')
        place(conn, partner, *NEAR)
        talk(conn, viewer, partner)
        quiet = person(conn, 'quiet')
        place(conn, quiet, *NEAR, enabled=False)
        talk(conn, viewer, quiet)
        near = person(conn, 'near')
        place(conn, near, *NEAR)
        edge = person(conn, 'edge')
        place(conn, edge, *EDGE_IN)
        both = person(conn, 'both')
        place(conn, both, *NEAR)
        friends(conn, viewer, both)
        talk(conn, viewer, both)
        out = person(conn, 'out')
        place(conn, out, *EDGE_OUT)
        off = person(conn, 'off')
        place(conn, off, *NEAR, enabled=False)
        unknown = 'reach-unknown-' + uuid4().hex
        answer = reached(conn, viewer, [friend, partner, quiet, near, edge, both, out, off, viewer, unknown, None])
    assert answer == {friend: ('friend', None), partner: ('conversation', 2), quiet: ('conversation', None),
                      near: ('near', 2), edge: ('near', 4), both: ('friend', None)}


@pytest.mark.parametrize('branch', ['friend', 'conversation', 'near'])
@pytest.mark.parametrize('direction', ['viewer_blocks', 'viewer_blocked'])
def test_no_branch_crosses_a_block_either_way(store, branch, direction):
    with connect() as conn:
        viewer = person(conn, 'viewer')
        other = person(conn, 'other')
        place(conn, viewer, *HERE)
        place(conn, other, *NEAR)
        if branch == 'friend':
            friends(conn, viewer, other)
        elif branch == 'conversation':
            talk(conn, viewer, other)
        assert reached(conn, viewer, [other]) != {}
        blocks(conn, *((viewer, other) if direction == 'viewer_blocks' else (other, viewer)))
        assert reached(conn, viewer, [other]) == {}
        assert reached(conn, other, [viewer]) == {}


def test_a_suspended_viewer_or_other_has_no_reach(store):
    with connect() as conn:
        viewer = person(conn, 'viewer')
        place(conn, viewer, *HERE)
        others = {}
        for branch in ('friend', 'conversation', 'near'):
            other = others[branch] = person(conn, branch)
            place(conn, other, *NEAR)
            if branch == 'friend':
                friends(conn, viewer, other)
            elif branch == 'conversation':
                talk(conn, viewer, other)
        ids = list(others.values())
        assert set(reached(conn, viewer, ids)) == set(ids)
        for branch, other in others.items():
            suspend(conn, other)
            assert other not in reached(conn, viewer, ids), branch
        assert reached(conn, viewer, ids) == {}
        # A suspended viewer reaches nobody, including collectors who were in reach.
        viewer_two = person(conn, 'viewer-two')
        place(conn, viewer_two, *HERE)
        friend = person(conn, 'friend-two')
        friends(conn, viewer_two, friend)
        assert reached(conn, viewer_two, [friend]) == {friend: ('friend', None)}
        suspend(conn, viewer_two)
        assert reached(conn, viewer_two, [friend]) == {}


def test_near_needs_both_sides_on_and_not_removed(store):
    with connect() as conn:
        viewer = person(conn, 'viewer')
        other = person(conn, 'other')
        place(conn, viewer, *HERE)
        place(conn, other, *NEAR)
        assert reached(conn, viewer, [other]) == {other: ('near', 2)}
        place(conn, viewer, *HERE, enabled=False)
        assert reached(conn, viewer, [other]) == {}
        place(conn, viewer, *HERE)
        place(conn, other, *NEAR, enabled=False)
        assert reached(conn, viewer, [other]) == {}
        place(conn, other, *NEAR)
        conn.execute('UPDATE discovery_setting SET removed_at = now(), enabled = false WHERE user_id = %s', (other,))
        assert reached(conn, viewer, [other]) == {}


def test_the_conversation_branch_survives_switch_off_and_a_move(store):
    with connect() as conn:
        viewer = person(conn, 'viewer')
        other = person(conn, 'other')
        place(conn, viewer, *HERE)
        place(conn, other, *NEAR)
        talk(conn, viewer, other)
        assert reached(conn, viewer, [other]) == {other: ('conversation', 2)}
        place(conn, other, *NEAR, enabled=False)
        assert reached(conn, viewer, [other]) == {other: ('conversation', None)}
        place(conn, other, *MOVED)
        assert reached(conn, viewer, [other]) == {other: ('conversation', None)}


def test_a_deleted_other_has_no_reach(store):
    with connect() as conn:
        viewer = person(conn, 'viewer')
        other = person(conn, 'other')
        friends(conn, viewer, other)
        talk(conn, viewer, other)
        assert reached(conn, viewer, [other]) == {other: ('friend', None)}
        conn.execute('DELETE FROM inventory_owner WHERE user_id = %s', (other,))
        assert reached(conn, viewer, [other]) == {}


def test_nearby_collectors_leaves_out_friends_blocks_and_the_undiscoverable_and_orders_by_band_then_hash(store):
    lat, lon = REMOTE

    def at(offset):
        return lat + offset, lon

    with connect() as conn:
        viewer = person(conn, 'viewer')
        place(conn, viewer, *at(0))
        strangers = []
        for name, offset in (('here-1', 0), ('here-2', 0), ('near-1', 0.1), ('near-2', 0.1), ('edge', 0.7)):
            stranger = person(conn, name)
            place(conn, stranger, *at(offset))
            strangers.append(stranger)
        friend = person(conn, 'friend')
        place(conn, friend, *at(0.1))
        friends(conn, viewer, friend)
        blocked = person(conn, 'blocked')
        place(conn, blocked, *at(0.1))
        blocks(conn, viewer, blocked)
        blocker = person(conn, 'blocker')
        place(conn, blocker, *at(0.1))
        blocks(conn, blocker, viewer)
        off = person(conn, 'off')
        place(conn, off, *at(0.1), enabled=False)
        suspended = person(conn, 'suspended')
        place(conn, suspended, *at(0.1))
        suspend(conn, suspended)
        removed = person(conn, 'removed')
        place(conn, removed, *at(0.1))
        conn.execute('UPDATE discovery_setting SET removed_at = now(), enabled = false WHERE user_id = %s', (removed,))
        far = person(conn, 'far')
        place(conn, far, *at(0.75))

        bands = {strangers[0]: 1, strangers[1]: 1, strangers[2]: 2, strangers[3]: 2, strangers[4]: 4}
        expected = sorted(strangers, key=lambda user: (
            bands[user], hashlib.md5((viewer + str(trader_of(conn, user))).encode()).hexdigest()))

        def nearby(max_band, max_rows):
            rows = conn.execute('SELECT other_id, band FROM nearby_collectors(%s, %s::smallint, %s)',
                                (viewer, max_band, max_rows)).fetchall()
            return [(row['other_id'], row['band']) for row in rows]

        assert nearby(4, 100) == [(user, bands[user]) for user in expected]
        assert nearby(2, 100) == [(user, bands[user]) for user in expected if bands[user] <= 2]
        assert nearby(4, 3) == [(user, bands[user]) for user in expected[:3]]
        place(conn, viewer, *at(0), enabled=False)
        assert nearby(4, 100) == []


def test_migration_148_keeps_existing_blocks_shown_and_runs_again(scratch):
    migrate(scratch, before=MIGRATION)
    old_blocker, old_blocked = 'old-blocker-' + uuid4().hex, 'old-blocked-' + uuid4().hex
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        owner_row(conn, old_blocker)
        owner_row(conn, old_blocked)
        conn.execute('INSERT INTO block(blocker_id, blocked_id) VALUES (%s, %s)', (old_blocker, old_blocked))
    migrate(scratch)
    new_blocker, new_blocked = 'new-blocker-' + uuid4().hex, 'new-blocked-' + uuid4().hex
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        old = conn.execute('SELECT id, via, handle_shown FROM block WHERE blocker_id = %s', (old_blocker,)).fetchone()
        assert old['id'] is not None and old['via'] == 'collector' and old['handle_shown'] is True
        owner_row(conn, new_blocker)
        owner_row(conn, new_blocked)
        low, high = sorted((new_blocker, new_blocked))
        conn.execute("INSERT INTO friendship(user_low, user_high, state, requested_by) VALUES (%s, %s, 'accepted', %s)",
                     (low, high, low))
        assert conn.execute('SELECT via_trade FROM friendship WHERE user_low = %s', (low,)).fetchone() == {
            'via_trade': False}
        conn.execute('INSERT INTO block(blocker_id, blocked_id) VALUES (%s, %s)', (new_blocker, new_blocked))
        new = conn.execute('SELECT id, via, handle_shown FROM block WHERE blocker_id = %s', (new_blocker,)).fetchone()
        assert new['handle_shown'] is False and new['via'] == 'collector'
    run_again(scratch, MIGRATION)
    run_again(scratch, MIGRATION)
    with psycopg.connect(scratch, row_factory=dict_row) as conn:
        assert conn.execute('SELECT id, via, handle_shown FROM block WHERE blocker_id = %s',
                            (old_blocker,)).fetchone() == old
        assert conn.execute('SELECT id, via, handle_shown FROM block WHERE blocker_id = %s',
                            (new_blocker,)).fetchone() == new
        extra_one, extra_two = 'extra-one-' + uuid4().hex, 'extra-two-' + uuid4().hex
        owner_row(conn, extra_one)
        owner_row(conn, extra_two)
        with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
            conn.execute("INSERT INTO block(blocker_id, blocked_id, via) VALUES (%s, %s, 'x')", (extra_one, extra_two))
        with pytest.raises(psycopg.errors.UniqueViolation), conn.transaction():
            conn.execute('INSERT INTO block(id, blocker_id, blocked_id) VALUES (%s, %s, %s)',
                         (old['id'], extra_one, extra_two))
        assert conn.execute("SELECT * FROM trade_reach('a', ARRAY['b'])").fetchall() == []
        assert conn.execute("SELECT * FROM nearby_collectors('a', 4::smallint, 1)").fetchall() == []


# The Python seam.


def suspended(user, value=True):
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at = CASE WHEN %s THEN now() END WHERE user_id = %s',
                     (value, user))


def test_reach_and_reach_one_answer_the_rule_with_api_bands(store):
    ids, ash, misty, binder, box = trading()
    (stranger, _) = collector('Near N.')
    discoverable(misty, '00010')
    discoverable(stranger, '00011')
    with connect() as conn:
        assert discovery.reach(conn, misty, [ash, stranger, None, str(uuid4()), stranger]) == {
            ash: discovery.Reach('friend', None), stranger: discovery.Reach('near', '5_to_10')}
        assert discovery.reach_one(conn, misty, None) is None
        assert discovery.reach_one(conn, misty, stranger) == discovery.Reach('near', '5_to_10')
        assert discovery.reach(conn, misty, []) == {}


def test_the_choke_point_asks_the_reach_rule(store):
    ids, ash, misty, binder, box = strangers()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ok(set_want(ash, iono, 1))
    with connect() as conn, conn.transaction():
        assert friend_copies.friend_trade_copies(conn, misty, [ash]) == []
        found = friend_copies.friend_trade_copies(conn, misty, [ash], among='reach')
        assert [(item.friend_id, str(item.edition_id), item.listable) for item in found] == [(ash, arven, 2)]
        assert friend_copies.friend_wants(conn, misty, [ash]) == []
        wanted = friend_copies.friend_wants(conn, misty, [ash], among='reach')
        assert [(item.friend_id, str(item.edition_id), item.trade_wants_quantity) for item in wanted] == [(ash, iono, 1)]
        for function in (friend_copies.friend_trade_copies, friend_copies.friend_wants):
            with pytest.raises(ValueError):
                function(conn, misty, None, among='reach')


def test_a_suspended_friend_drops_out_of_find_trades(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    ok(set_want(ash, iono, 1))
    ok(set_want(misty, arven, 1))
    ok(set_want(ash, arven, 1))

    def rows():
        return [row['collector_id'] for row in ok(call('GET', '/api/social/trade-matches', misty))['rows']]

    assert rows() == [ash]
    suspended(ash)
    assert rows() == []
    with connect() as conn, conn.transaction():
        assert friend_copies.friend_trade_copies(conn, misty) == []
        assert friend_copies.friend_wants(conn, misty) == []
    suspended(ash, False)
    assert rows() == [ash]


def test_visible_beyond_friends_holds_for_a_non_friend_in_a_conversation(store):
    ids, ash, misty, binder, box = trading()
    from test_trades import proposed

    def visible():
        return ok(call('GET', '/api/social/discovery', misty))['visible_beyond_friends']

    proposed(misty, ash, give=[(ids['PAL 185'], 1)])      # the pair's conversation
    assert visible() is False
    ok(remove(ash, misty))
    assert visible() is True
    api_block(ash, misty)
    assert visible() is False
    ok(unblock(ash, misty))
    assert visible() is True
    suspended(ash)
    assert visible() is False
    discoverable(misty, '00010')
    assert visible() is True
