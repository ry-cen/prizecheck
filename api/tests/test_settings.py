"""Account settings (decklist import #207, spec "Settings") through signed HTTP against PostgreSQL.

The Want List counting setting is stored on the account and defaults to Every Deck built at once (``all_at_once``) for
every account, existing ones included (migration 049). ``GET /api/settings`` reads it with the settings revision;
``PUT /api/settings/want-list-counting`` changes it as an owner command: authenticated, idempotent and revision-checked
(STALE_SETTINGS). It never moves the inventory revision. Nothing reads the setting yet (#208 makes the figures follow it).
"""
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from app.main import app, connect  # noqa: F401  (main first: it includes every router while loading)
from test_catalog_references import migrate
from test_holdings import call, client

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = '049_want_list_counting.sql'
PATH = '/api/settings/want-list-counting'


def new_owner():
    return f'settings-{uuid4()}'


def read(owner):
    response = call('GET', '/api/settings', owner)
    assert response.status_code == 200, response.text
    return response.json()


def change(owner, counting, revision, key=None):
    return call('PUT', PATH, owner,
                {'want_list_counting': counting, 'revision': revision, 'idempotency_key': str(key or uuid4())})


def inventory_revision(owner):
    response = call('GET', '/api/location-tree', owner)
    assert response.status_code == 200, response.text
    return response.json()['owner_revision']


def test_a_new_account_counts_every_deck_built_at_once():
    owner = new_owner()
    assert read(owner) == {'want_list_counting': 'all_at_once', 'revision': 1}
    # Reading onboards a first-time caller like every owner read: the account has its Unsorted.
    names = [location['name'] for location in call('GET', '/api/location-tree', owner).json()['locations']]
    assert names == ['Unsorted']


def test_settings_need_a_signed_request():
    assert client.get('/api/settings').status_code == 401
    body = {'want_list_counting': 'one_at_a_time', 'revision': 1, 'idempotency_key': str(uuid4())}
    assert client.put(PATH, json=body).status_code == 401


def test_changing_the_setting_advances_the_revision_and_reads_back():
    owner = new_owner()
    changed = change(owner, 'one_at_a_time', 1)
    assert changed.status_code == 200, changed.text
    assert changed.json() == {'want_list_counting': 'one_at_a_time', 'revision': 2}
    assert read(owner) == changed.json()
    back = change(owner, 'all_at_once', 2)
    assert back.status_code == 200, back.text
    assert read(owner) == {'want_list_counting': 'all_at_once', 'revision': 3}


def test_choosing_the_current_value_is_accepted_and_still_advances_the_revision():
    owner = new_owner()
    same = change(owner, 'all_at_once', 1)
    assert same.status_code == 200, same.text
    assert same.json() == {'want_list_counting': 'all_at_once', 'revision': 2}


def test_a_stale_revision_is_refused_and_changes_nothing():
    owner = new_owner()
    assert change(owner, 'one_at_a_time', 1).status_code == 200
    for revision in (1, 3):
        stale = change(owner, 'all_at_once', revision)
        assert stale.status_code == 409 and stale.json()['detail']['code'] == 'STALE_SETTINGS', revision
    assert read(owner) == {'want_list_counting': 'one_at_a_time', 'revision': 2}


def test_the_command_is_idempotent_and_a_replay_answers_as_it_did_then():
    owner = new_owner()
    key = uuid4()
    first = change(owner, 'one_at_a_time', 1, key)
    assert first.status_code == 200, first.text
    again = change(owner, 'one_at_a_time', 1, key)
    assert again.status_code == 200 and again.json() == first.json()
    assert read(owner)['revision'] == 2  # advanced once
    # A later change doesn't alter the replay, and the replay doesn't undo the later change.
    assert change(owner, 'all_at_once', 2).status_code == 200
    assert change(owner, 'one_at_a_time', 1, key).json() == first.json()
    assert read(owner) == {'want_list_counting': 'all_at_once', 'revision': 3}
    # The same key with another request is refused.
    reused = change(owner, 'all_at_once', 1, key)
    assert reused.status_code == 409 and reused.json()['detail']['code'] == 'IDEMPOTENCY_KEY_REUSED'


def test_two_changes_at_one_revision_apply_once():
    owner = new_owner()
    read(owner)
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda counting: change(owner, counting, 1), ('one_at_a_time', 'all_at_once')))
    assert sorted(response.status_code for response in results) == [200, 409]
    [won] = [response.json() for response in results if response.status_code == 200]
    assert read(owner) == won and won['revision'] == 2


def test_an_unknown_value_or_a_missing_field_is_refused():
    owner = new_owner()
    for counting in ('every_deck', 'All_at_once', '', None):
        assert change(owner, counting, 1).status_code == 422, counting
    assert call('PUT', PATH, owner, {'want_list_counting': 'one_at_a_time', 'idempotency_key': str(uuid4())}).status_code == 422
    assert call('PUT', PATH, owner, {'want_list_counting': 'one_at_a_time', 'revision': 1}).status_code == 422
    assert change(owner, 'one_at_a_time', 0).status_code == 422
    assert read(owner) == {'want_list_counting': 'all_at_once', 'revision': 1}


def test_the_setting_belongs_to_one_account():
    owner, other = new_owner(), new_owner()
    assert change(owner, 'one_at_a_time', 1).status_code == 200
    assert read(other) == {'want_list_counting': 'all_at_once', 'revision': 1}
    # Another account's revision is its own: the owner's revision 2 is stale for it.
    assert change(other, 'one_at_a_time', 2).status_code == 409
    assert read(owner) == {'want_list_counting': 'one_at_a_time', 'revision': 2}


def test_a_settings_change_never_moves_the_inventory_revision():
    owner = new_owner()
    before = inventory_revision(owner)
    assert change(owner, 'one_at_a_time', 1).status_code == 200
    assert change(owner, 'all_at_once', 2).status_code == 200
    assert inventory_revision(owner) == before


def test_migration_049_makes_existing_accounts_count_every_deck_built_at_once_and_runs_again(monkeypatch):
    admin = os.environ.get('RECOVERY_TEST_DATABASE_URL')
    if not admin:
        pytest.skip('RECOVERY_TEST_DATABASE_URL names the disposable PostgreSQL server')
    name = 'tcg_settings_' + uuid4().hex
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    url = make_conninfo(admin, dbname=name)
    try:
        migrate(url, before=MIGRATION)
        owner = 'collector-' + uuid4().hex
        with psycopg.connect(url) as conn:
            conn.execute('INSERT INTO inventory_owner(user_id,revision) VALUES (%s,7)', (owner,))
        migrate(url)
        with psycopg.connect(url, row_factory=dict_row) as conn:
            columns = 'SELECT revision,want_list_counting,settings_revision FROM inventory_owner WHERE user_id=%s'
            assert conn.execute(columns, (owner,)).fetchone() == {
                'revision': 7, 'want_list_counting': 'all_at_once', 'settings_revision': 1}
            with pytest.raises(psycopg.errors.CheckViolation):
                with conn.transaction():
                    conn.execute("UPDATE inventory_owner SET want_list_counting='sometimes' WHERE user_id=%s", (owner,))
            conn.execute("UPDATE inventory_owner SET want_list_counting='one_at_a_time' WHERE user_id=%s", (owner,))
            # Running the migration again changes nothing.
            with conn.transaction():
                conn.execute((ROOT / 'migrations' / MIGRATION).read_text())
            assert conn.execute(columns, (owner,)).fetchone() == {
                'revision': 7, 'want_list_counting': 'one_at_a_time', 'settings_revision': 1}
        monkeypatch.setenv('DATABASE_URL', url)
        assert read(owner) == {'want_list_counting': 'one_at_a_time', 'revision': 1}
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
