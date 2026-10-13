"""The owner panel's new-accounts figure (OAuth spec #147, #155): the last day's OAuth account creations from
auth_rate_event against DAILY_SIGNUP_CAP, warning at 80%, with refusals from the bounded auth counter."""
from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import app, connect
from test_catalog import headers

PATH = '/api/admin/operations'


def signups(conn, count, age='0 seconds', kind='signup'):
    conn.execute("INSERT INTO auth_rate_event(kind,ip_key,created_at) SELECT %s,'key-'||g,now()-%s::interval FROM generate_series(1,%s) g",
                 (kind, age, count))


def test_new_accounts_in_the_last_day_warn_at_eighty_percent_of_the_cap(monkeypatch):
    owner = 'signup-capacity-' + str(uuid4())
    with connect() as conn:
        conn.execute('DELETE FROM auth_rate_event')
        conn.execute("DELETE FROM operations_counter WHERE name='too_many_sign_ups'")
        conn.execute('DELETE FROM owner_binding')
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)', (owner,))
        conn.execute('INSERT INTO owner_binding(user_id) VALUES (%s)', (owner,))
        signups(conn, 7)
        signups(conn, 3, age='25 hours')  # older than a day
        signups(conn, 5, kind='start')  # sign-in starts are not accounts
        conn.execute("INSERT INTO operations_counter(name,count) VALUES ('too_many_sign_ups',2)")
    monkeypatch.setenv('DAILY_SIGNUP_CAP', '10')
    try:
        with TestClient(app) as client:
            status = lambda: client.get(PATH, headers=headers(owner, 'GET', PATH)).json()
            below = status()
            assert (below['signups_24h'], below['daily_signup_cap'], below['signup_warning']) == (7, 10, False)
            assert below['signup_refusals'] == 2
            with connect() as conn:
                signups(conn, 1)
            at = status()
            assert (at['signups_24h'], at['signup_warning']) == (8, True)
            monkeypatch.delenv('DAILY_SIGNUP_CAP')
            default = status()
            assert (default['daily_signup_cap'], default['signup_warning']) == (100, False)
            monkeypatch.setenv('DAILY_SIGNUP_CAP', 'lots')
            assert status()['daily_signup_cap'] == 100
    finally:
        with connect() as conn:
            conn.execute('DELETE FROM auth_rate_event')
            conn.execute("DELETE FROM operations_counter WHERE name='too_many_sign_ups'")
