"""Handles, Display Names and the Invite Link (social network #246) through signed HTTP against PostgreSQL.

Every account has a profile from its first request (migration 100's trigger) and existing accounts get one from the
backfill. The Handle rules: 3 to 20 letters, digits and underscores, unique ignoring case, reserved names and the word
filter refused (``test_name_rules`` covers the lists), one change in 30 days, at most 10 counted attempts an hour, and a
given-up Handle held for 30 days. The signed-out Invite Link page reads the public records store only.
"""
import os
import re
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from app.public_projection import ProjectionUnavailable
from app.public_records import FilePublicRecords, invite_key
from app.social import profile as profile_module
from test_catalog_references import migrate
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_holdings import call, client

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = '100_collector_profile.sql'
GENERATED = re.compile(r'collector_[bcdfghjklmnpqrstvwxz2689]{8}')


def new_owner():
    return f'profile-{uuid4()}'


def profile(owner):
    response = call('GET', '/api/profile', owner)
    assert response.status_code == 200, response.text
    return response.json()


def set_name(owner, name, key=None):
    return call('PUT', '/api/profile/display-name', owner, {'display_name': name, 'idempotency_key': str(key or uuid4())})


def set_handle(owner, handle, key=None):
    return call('PUT', '/api/profile/handle', owner, {'handle': handle, 'idempotency_key': str(key or uuid4())})


def new_link(owner, key=None):
    return call('POST', '/api/profile/invite-link', owner, {'idempotency_key': str(key or uuid4())})


def code(response):
    return response.json()['detail']['code']


def public(token, query=''):
    return client.get(f'/api/public/invites/{token}{query}')


# Consonants only: a hex run can spell an entry of the name filter's word list, which made a random Handle refused now
# and then. A run of consonants never trips it (test_friends.py explains why).
QUIET = 'bcdfghjklmnpqrstvwxz'


def unique_handle(prefix='h'):
    return f"{prefix}_{''.join(secrets.choice(QUIET) for _ in range(12))}"


def age_handle_change(owner, days):
    """Moves the owner's last Handle change, and the hold on the Handle it gave up, ``days`` into the past."""
    with connect() as conn:
        conn.execute("UPDATE collector_profile SET handle_changed_at=handle_changed_at - make_interval(days => %s) "
                     "WHERE user_id=%s", (days, owner))
        conn.execute("UPDATE released_handle SET released_at=released_at - make_interval(days => %s)", (days,))


def test_a_new_account_has_a_generated_handle_the_placeholder_name_and_an_invite_link():
    owner = new_owner()
    body = profile(owner)
    assert set(body) == {'handle', 'display_name', 'handle_change_available_at', 'invite_token'}
    assert GENERATED.fullmatch(body['handle']) and body['display_name'] == 'Collector'
    assert body['handle_change_available_at'] is None
    assert re.fullmatch(r'[A-Za-z0-9_-]{32}', body['invite_token'])
    # The link is made once; reads return the same one.
    assert profile(owner) == body
    assert public(body['invite_token']).json() == {'display_name': 'Collector'}


def test_display_names_are_trimmed_checked_and_shown_on_the_invite_page():
    owner = new_owner()
    token = profile(owner)['invite_token']
    response = set_name(owner, '  Ash Ketchum  ')
    assert response.status_code == 200, response.text
    assert response.json()['display_name'] == 'Ash Ketchum'
    assert public(token).json() == {'display_name': 'Ash Ketchum'}
    for name in ('', '   ', 'x' * 41, 'a‮b', 'tab\there'):
        assert code(set_name(owner, name)) == 'INVALID_DISPLAY_NAME', name
    for name in ('Support Team', 'PrizeCheck', 'Sh1t happens'):
        assert code(set_name(owner, name)) == 'DISPLAY_NAME_NOT_ALLOWED', name
    assert set_name(owner, 'x' * 40).status_code == 200
    assert set_name(owner, 'Zoë 名前').json()['display_name'] == 'Zoë 名前'
    assert profile(owner)['display_name'] == 'Zoë 名前'


def test_commands_replay_by_their_idempotency_key():
    owner = new_owner()
    key = uuid4()
    first = set_name(owner, 'Misty', key)
    assert set_name(owner, 'Misty', key).json() == first.json()
    assert code(set_name(owner, 'Brock', key)) == 'IDEMPOTENCY_KEY_REUSED'
    handle = unique_handle()
    key = uuid4()
    changed = set_handle(owner, handle, key)
    assert changed.status_code == 200, changed.text
    # The replay is the stored answer, not a second change refused by the 30-day limit.
    assert set_handle(owner, handle, key).json() == changed.json()


def test_handle_format_and_reserved_names():
    owner = new_owner()
    for handle in ('ab', 'a' * 21, 'has space', 'dash-ed', 'é' * 5):
        assert code(set_handle(owner, handle)) == 'INVALID_HANDLE', handle
    for handle in ('admin', 'Admin_2', 'support_team', 'PrizeCheckFan', 'sh1t'):
        assert code(set_handle(owner, handle)) == 'HANDLE_NOT_ALLOWED', handle
    # Refusals before the availability check are not counted attempts.
    with connect() as conn:
        assert conn.execute("SELECT count(*) FROM handle_lookup_event WHERE user_id=%s", (owner,)).fetchone()['count'] == 0


def test_handles_are_unique_ignoring_case_and_a_changed_handle_is_held_for_30_days():
    first, second = new_owner(), new_owner()
    handle = unique_handle('Ash')
    assert set_handle(first, handle).json()['handle'] == handle
    assert code(set_handle(second, handle.lower())) == 'HANDLE_TAKEN'
    assert code(set_handle(second, handle.upper())) == 'HANDLE_TAKEN'
    # The first collector moves on after 30 days; the Handle they gave up stays held for 30 more.
    age_handle_change(first, 31)
    other = unique_handle('Red')
    assert set_handle(first, other).status_code == 200
    assert code(set_handle(second, handle)) == 'HANDLE_TAKEN'
    age_handle_change(first, 31)
    claimed = set_handle(second, handle)
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()['handle'] == handle


def test_a_handle_changes_once_in_30_days_but_its_case_changes_any_time():
    owner = new_owner()
    handle = unique_handle('misty')
    body = set_handle(owner, handle).json()
    available = body['handle_change_available_at']
    assert available is not None
    refused = set_handle(owner, unique_handle())
    assert (refused.status_code, code(refused)) == (409, 'HANDLE_CHANGE_TOO_SOON')
    assert refused.json()['detail']['available_at'][:16] == available[:16]
    # Case only: free, and the 30 days still run from the real change.
    recased = set_handle(owner, handle.upper())
    assert recased.status_code == 200 and recased.json()['handle'] == handle.upper()
    assert recased.json()['handle_change_available_at'] == available
    # The current Handle again changes nothing.
    assert set_handle(owner, handle.upper()).json() == recased.json()
    age_handle_change(owner, 30)
    assert profile(owner)['handle_change_available_at'] is None
    assert set_handle(owner, unique_handle()).status_code == 200


def test_ten_counted_attempts_an_hour():
    owner, holder = new_owner(), new_owner()
    held = unique_handle()
    assert set_handle(holder, held).status_code == 200
    for _ in range(10):
        assert code(set_handle(owner, held)) == 'HANDLE_TAKEN'
    refused = set_handle(owner, unique_handle())
    assert (refused.status_code, code(refused)) == (429, 'TOO_MANY_HANDLE_TRIES')
    assert 1 <= refused.json()['detail']['retry_after_minutes'] <= 60
    with connect() as conn:
        conn.execute("UPDATE handle_lookup_event SET created_at=created_at - interval '61 minutes' WHERE user_id=%s",
                     (owner,))
    assert set_handle(owner, unique_handle()).status_code == 200


def test_two_collectors_racing_for_one_handle_get_it_once():
    owners = [new_owner() for _ in range(6)]
    for owner in owners:
        profile(owner)
    handle = unique_handle()
    with ThreadPoolExecutor(len(owners)) as pool:
        results = list(pool.map(lambda owner: set_handle(owner, handle), owners))
    assert sorted(r.status_code for r in results) == [200] + [409] * 5
    with connect() as conn:
        assert conn.execute('SELECT count(*) FROM collector_profile WHERE handle_key=%s',
                            (handle.lower(),)).fetchone()['count'] == 1


def test_a_new_invite_link_stops_the_old_one():
    owner = new_owner()
    set_name(owner, 'Brock')
    old = profile(owner)['invite_token']
    response = new_link(owner)
    assert response.status_code == 200, response.text
    new = response.json()['invite_token']
    assert new != old and profile(owner)['invite_token'] == new
    assert (public(old).status_code, public(old).json()['detail']['code']) == (404, 'INVITE_NOT_FOUND')
    assert public(new).json() == {'display_name': 'Brock'}


def test_the_public_invite_page_reveals_only_the_display_name_and_never_reads_postgresql(monkeypatch):
    owner = new_owner()
    set_handle(owner, unique_handle())
    token = profile(owner)['invite_token']

    def no_database(*args, **kwargs):
        raise AssertionError('the public invite read connected to PostgreSQL')

    monkeypatch.setattr(profile_module, 'connect', no_database)
    monkeypatch.setattr('app.main.connect', no_database)
    response = public(token)
    assert response.status_code == 200 and response.json() == {'display_name': 'Collector'}
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['x-robots-tag'] == 'noindex, nofollow'
    for bad in ('short', 'x' * 33, 'a' * 31 + '!'):
        assert public(bad).status_code == 404
    assert public('A' * 32).json()['detail']['code'] == 'INVITE_NOT_FOUND'
    assert public(token, '?handle=1').json()['detail']['code'] == 'INVALID_REQUEST'


def test_the_handle_and_display_name_never_reach_another_public_response(store):
    owner = new_owner()
    handle = unique_handle('Leaky')
    set_handle(owner, handle)
    set_name(owner, 'Leaky Name')
    token = profile(owner)['invite_token']
    key = invite_key(profile_module.token_hash(token))
    assert store.read_records([key], deadline=time.monotonic() + 5).records[key].value == {'display_name': 'Leaky Name'}
    # The token itself is never stored publicly.
    for path in Path(os.environ['PUBLIC_PROJECTION_DIR']).rglob('*'):
        if path.is_file():
            data = path.read_bytes()
            assert token.encode() not in data and handle.encode() not in data


def test_a_store_outage_fails_the_command_and_its_retry_completes(monkeypatch):
    owner = new_owner()
    token = profile(owner)['invite_token']
    key = uuid4()

    def unavailable(self, *args, **kwargs):
        raise ProjectionUnavailable()

    with monkeypatch.context() as patch:
        patch.setattr(FilePublicRecords, 'compare_and_swap', unavailable)
        failed = set_name(owner, 'Gary', key)
        assert (failed.status_code, code(failed)) == (503, 'PROFILE_UNAVAILABLE')
        # Reading the profile never fails because of the store, and a Handle change doesn't need it.
        assert profile(owner)['display_name'] == 'Gary'
        assert set_handle(owner, unique_handle()).status_code == 200
    # The record still has the old name until a drain succeeds.
    assert public(token).json() == {'display_name': 'Collector'}
    retried = set_name(owner, 'Gary', key)
    assert retried.status_code == 200 and retried.json()['display_name'] == 'Gary'
    assert public(token).json() == {'display_name': 'Gary'}
    with connect() as conn:
        assert conn.execute('SELECT count(*) FROM invite_projection_outbox').fetchone()['count'] == 0


def test_a_drain_that_times_out_after_a_batch_keeps_that_batch_drained(monkeypatch):
    monkeypatch.setattr(profile_module, 'MAX_BATCH', 2)
    with connect() as conn:
        conn.execute('DELETE FROM invite_projection_outbox')
        for index in range(9):
            conn.execute('INSERT INTO invite_projection_outbox(token_hash,display_name) VALUES (%s,%s)',
                         (f'{index:064x}', f'Name {index}'))
    swaps = []
    real = FilePublicRecords.compare_and_swap

    def swap_then_time_out(self, *args, **kwargs):
        if len(swaps) == 4:
            raise ProjectionUnavailable()
        swaps.append(1)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(FilePublicRecords, 'compare_and_swap', swap_then_time_out)
    # Four chunks of two make up the first batch of eight rows; the ninth is the next batch, which times out.
    assert profile_module.drain_invites() is False
    with connect() as conn:
        left = conn.execute('SELECT count(*) FROM invite_projection_outbox').fetchone()['count']
    assert left == 1
    monkeypatch.undo()
    assert profile_module.drain_invites() is True


def test_profile_commands_never_move_the_inventory_revision():
    owner = new_owner()
    profile(owner)
    with connect() as conn:
        before = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s', (owner,)).fetchone()['revision']
    set_name(owner, 'Erika')
    set_handle(owner, unique_handle())
    new_link(owner)
    with connect() as conn:
        assert conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s', (owner,)).fetchone()['revision'] == before


def test_the_profile_needs_a_signed_in_collector():
    assert client.get('/api/profile').status_code == 401
    assert client.put('/api/profile/display-name', json={'display_name': 'x', 'idempotency_key': str(uuid4())}).status_code == 401


def test_migration_100_gives_every_existing_account_a_profile_and_runs_again():
    admin = os.environ.get('RECOVERY_TEST_DATABASE_URL')
    if not admin:
        pytest.skip('RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server')
    name = 'tcg_profile_' + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before=MIGRATION)
        owners = [f'existing-{index}-{uuid4().hex}' for index in range(40)]
        with psycopg.connect(url) as conn:
            for owner in owners:
                conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
        migrate(url)
        query = 'SELECT user_id,handle,handle_key,display_name,handle_changed_at FROM collector_profile ORDER BY user_id'
        with psycopg.connect(url, row_factory=dict_row) as conn:
            rows = conn.execute(query).fetchall()
            assert sorted(row['user_id'] for row in rows) == sorted(owners)
            assert all(GENERATED.fullmatch(row['handle']) and row['handle_key'] == row['handle']
                       and row['display_name'] == 'Collector' and row['handle_changed_at'] is None for row in rows)
            assert len({row['handle_key'] for row in rows}) == len(rows)
            with conn.transaction():
                conn.execute((ROOT / 'migrations' / MIGRATION).read_text())
            assert conn.execute(query).fetchall() == rows
            # A later account gets its profile from the trigger.
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES ('later')")
            assert conn.execute("SELECT count(*) AS n FROM collector_profile WHERE user_id='later'").fetchone()['n'] == 1
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))


def test_invite_records_are_a_protected_key_family():
    from app import public_records as records
    key = invite_key('a' * 64)
    assert key == 'invite:' + 'a' * 64
    assert records.key_family(key).name == 'invite' and not records.key_family(key).evictable
    for bad in ('A' * 64, 'a' * 63, 'token'):
        with pytest.raises(ValueError):
            invite_key(bad)


def test_the_rebuild_restores_lost_invite_records(tmp_path, monkeypatch, capsys):
    import importlib.util
    owner = new_owner()
    set_name(owner, 'Lorelei')
    token = profile(owner)['invite_token']
    # The records store is lost and initialized empty.
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR', str(tmp_path / 'fresh'))
    from app.public_records import public_record_store
    public_record_store().initialize(deadline=time.monotonic() + 5)
    assert public(token).status_code == 404
    spec = importlib.util.spec_from_file_location('rebuild_invite_records', ROOT / 'scripts' / 'rebuild_invite_records.py')
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    assert script.main() == 0
    assert 'rebuilt' in capsys.readouterr().out
    assert public(token).json() == {'display_name': 'Lorelei'}
