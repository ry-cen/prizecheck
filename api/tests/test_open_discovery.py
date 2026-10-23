"""Open discovery settings and the distance band (Trading #297). Real PostgreSQL; zips 00010 to 00019 are seeded here
and 00009 is deleted, because US codes begin at 00501 and these tests never depend on the generated zip data."""
import math
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from app.main import connect  # noqa: F401  (main first: it includes every router while loading)
from test_holdings import call

ZIPS = {'00010': (40.0, -100.0), '00011': (40.1, -100.0), '00012': (40.2, -100.0), '00013': (40.3, -100.0),
        '00014': (40.4, -100.0)}


def seed_zips():
    with connect() as conn:
        for zip_code, (lat, lon) in ZIPS.items():
            conn.execute("""INSERT INTO zip_centroid (zip, lat, lon, source) VALUES (%s, %s, %s, 'census')
              ON CONFLICT (zip) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, source = EXCLUDED.source""",
                         (zip_code, lat, lon))
        conn.execute("DELETE FROM zip_centroid WHERE zip = '00009'")


def new_user():
    return f'discovery-{uuid4()}'


def discovery(user):
    response = call('GET', '/api/social/discovery', user)
    assert response.status_code == 200, response.text
    return response.json()


def put(user, body):
    return call('PUT', '/api/social/discovery', user, body)


def refusal(response):
    return response.status_code, response.json()['detail']


def discoverable(user, zip='00010') -> dict:
    """Seeds the test zips, switches the collector on at ``zip`` and returns the setting. Later Stage 2 tests import it
    to make a collector who can be found."""
    seed_zips()
    response = put(user, {'enabled': True, 'zip': zip})
    assert response.status_code == 200, response.text
    return response.json()


def zip_change_rows(user):
    with connect() as conn:
        return conn.execute("SELECT count(*) AS n FROM handle_lookup_event WHERE user_id=%s AND kind='zip_change'",
                            (user,)).fetchone()['n']


def backdate(user, interval):
    with connect() as conn:
        conn.execute("UPDATE handle_lookup_event SET created_at = now() - %s::interval WHERE user_id=%s AND kind='zip_change'",
                     (interval, user))


def stored(user):
    with connect() as conn:
        return conn.execute('SELECT * FROM discovery_setting WHERE user_id=%s', (user,)).fetchone()


@pytest.mark.parametrize('miles, band', [(0, 1), (4.99, 1), (5, 2), (9.99, 2), (10, 3), (24.99, 3), (25, 4), (50, 4),
                                         (50.01, None)])
def test_distance_band_edges(miles, band):
    with connect() as conn:
        found = conn.execute('SELECT distance_band(%s, %s, %s, %s) AS band',
                             (0, 0, math.degrees(miles / 3958.8), 0)).fetchone()['band']
    assert found == band


def test_distance_band_is_null_for_a_missing_coordinate_and_never_fails_far_away():
    with connect() as conn:
        for missing in range(4):
            args = [1.0, 2.0, 3.0, 4.0]
            args[missing] = None
            assert conn.execute('SELECT distance_band(%s, %s, %s, %s) AS band', args).fetchone()['band'] is None
        assert conn.execute('SELECT distance_band(0, 0, 0, 180) AS band').fetchone()['band'] is None


def test_a_new_collector_reads_off_and_nothing_is_written():
    user = new_user()
    assert discovery(user) == {'status': 'off', 'zip': None, 'radius_mi': 25, 'zip_changes_left': 3,
                               'visible_beyond_friends': False}
    with connect() as conn:
        assert conn.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s', (user,)).fetchone() is None


def test_switching_on_copies_the_centroid_and_keeps_five_digits():
    seed_zips()
    user = new_user()
    response = put(user, {'enabled': True, 'zip': ' 00010-1234 '})
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body['status'], body['zip'], body['visible_beyond_friends']) == ('on', '00010', True)
    row = stored(user)
    assert (row['lat'], row['lon']) == ZIPS['00010']
    with connect() as conn:
        trader = conn.execute('SELECT trader_id FROM collector_profile WHERE user_id=%s', (user,)).fetchone()['trader_id']
    assert str(trader) not in response.text


def test_the_put_refusals_come_in_order():
    seed_zips()
    for mark in ('UPDATE discovery_setting SET enabled=false, removed_at=now() WHERE user_id=%s',
                 'UPDATE collector_profile SET suspended_at=now() WHERE user_id=%s'):
        user = new_user()
        discoverable(user)
        with connect() as conn:
            conn.execute(mark, (user,))
        assert refusal(put(user, {'enabled': True, 'zip': 'nope'})) == (409, {'code': 'DISCOVERY_UNAVAILABLE'})
    user = new_user()
    for bad in ('1234', '12345-12', '١٢٣٤٥'):
        assert refusal(put(user, {'enabled': True, 'zip': bad})) == (422, {'code': 'INVALID_ZIP'})
    assert refusal(put(user, {'enabled': True, 'zip': '00009'})) == (422, {'code': 'UNKNOWN_ZIP'})
    limited = new_user()
    discoverable(limited)
    for zip_code in ('00011', '00012', '00013'):
        assert put(limited, {'zip': zip_code}).status_code == 200
    assert refusal(put(limited, {'zip': '00009'})) == (422, {'code': 'UNKNOWN_ZIP'})
    fresh = new_user()
    assert refusal(put(fresh, {'enabled': True})) == (422, {'code': 'ZIP_REQUIRED'})
    empty = put(fresh, {})
    assert empty.status_code == 200 and empty.json()['status'] == 'off'
    assert stored(fresh) is None
    removed = new_user()
    discoverable(removed)
    with connect() as conn:
        conn.execute('UPDATE discovery_setting SET enabled=false, removed_at=now() WHERE user_id=%s', (removed,))
    off = put(removed, {'enabled': False})
    assert off.status_code == 200 and off.json()['status'] == 'removed'


def test_a_first_zip_is_not_a_change():
    seed_zips()
    user = new_user()
    first = put(user, {'zip': '00010'}).json()
    assert (first['zip'], first['zip_changes_left'], first['status']) == ('00010', 3, 'off')
    assert put(user, {'enabled': True}).json()['zip_changes_left'] == 3
    assert zip_change_rows(user) == 0


def test_a_fourth_zip_change_in_24_hours_is_refused():
    user = new_user()
    discoverable(user, '00010')
    assert [put(user, {'zip': z}).json()['zip_changes_left'] for z in ('00011', '00012', '00013')] == [2, 1, 0]
    backdate(user, '90 minutes')
    assert refusal(put(user, {'zip': '00014'})) == (429, {'code': 'ZIP_CHANGE_LIMIT', 'retry_after_minutes': 1350})
    assert discovery(user)['zip'] == '00013'
    same = put(user, {'zip': '00013'})
    assert same.status_code == 200 and same.json()['zip_changes_left'] == 0
    for enabled in (False, True):
        response = put(user, {'enabled': enabled})
        assert response.status_code == 200 and response.json()['zip_changes_left'] == 0


def test_a_change_older_than_24_hours_no_longer_counts():
    user = new_user()
    discoverable(user, '00010')
    for zip_code in ('00011', '00012', '00013'):
        assert put(user, {'zip': zip_code}).status_code == 200
    with connect() as conn:
        conn.execute("""UPDATE handle_lookup_event SET created_at = now() - interval '25 hours' WHERE ctid = (
          SELECT ctid FROM handle_lookup_event WHERE user_id=%s AND kind='zip_change' ORDER BY created_at LIMIT 1)""",
                     (user,))
    assert discovery(user)['zip_changes_left'] == 1
    assert put(user, {'zip': '00014'}).json()['zip_changes_left'] == 0


def test_switching_off_keeps_the_zip_the_centroid_and_the_limit():
    user = new_user()
    discoverable(user, '00010')
    assert put(user, {'zip': '00011'}).json()['zip_changes_left'] == 2
    off = put(user, {'enabled': False}).json()
    assert (off['status'], off['zip'], off['zip_changes_left']) == ('off', '00011', 2)
    row = stored(user)
    assert (row['lat'], row['lon']) == ZIPS['00011']
    assert put(user, {'enabled': True}).json()['status'] == 'on'


def test_same_value_writes_change_nothing():
    user = new_user()
    discoverable(user, '00010')
    body = {'enabled': True, 'zip': '00010', 'radius_mi': 25}
    first = put(user, body)
    before = stored(user)['updated_at']
    second = put(user, body)
    assert first.json() == second.json()
    assert stored(user)['updated_at'] == before


def test_the_radius_is_stored_and_kept_when_not_given():
    seed_zips()
    user = new_user()
    assert put(user, {'radius_mi': 10}).json()['radius_mi'] == 10
    assert put(user, {'enabled': True, 'zip': '00010'}).json()['radius_mi'] == 10
    assert put(user, {'radius_mi': 7}).status_code == 422


def test_suspended_reads_before_removed():
    user = new_user()
    discoverable(user)
    with connect() as conn:
        conn.execute('UPDATE discovery_setting SET enabled=false, removed_at=now() WHERE user_id=%s', (user,))
    assert discovery(user)['status'] == 'removed'
    with connect() as conn:
        conn.execute('UPDATE collector_profile SET suspended_at=now() WHERE user_id=%s', (user,))
    both = discovery(user)
    assert both['status'] == 'suspended' and both['visible_beyond_friends'] is False
    narrowed = put(user, {'radius_mi': 10})
    assert narrowed.status_code == 200 and narrowed.json()['radius_mi'] == 10


def test_concurrent_zip_changes_never_pass_the_limit():
    user = new_user()
    discoverable(user, '00010')
    zips = ['00011', '00012', '00013', '00014', '00011', '00012', '00014', '00014']
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda zip_code: put(user, {'zip': zip_code}), zips))
    assert all(response.status_code in (200, 429) for response in results), [r.text for r in results]
    rows = zip_change_rows(user)
    assert rows <= 3
    assert discovery(user)['zip_changes_left'] == 3 - rows
