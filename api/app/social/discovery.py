"""Open discovery: the caller's own setting and zip code (Trading #297, spec "Zip codes and distance" and "Open
discovery switch", resolution "Identity: trader ids, Handles and user ids").

``GET /api/social/discovery`` reads the caller's setting and ``PUT /api/social/discovery`` sets it. Both answer
``DiscoverySettings``, the one response in the API that carries a zip code, and it is always the caller's own. No
response carries a ``trader_id``, a latitude, a longitude or a distance; the centroid is copied from ``zip_centroid``
into ``discovery_setting`` when a zip is stored and is never sent out.

``PUT`` takes optional fields, and ``None`` or an absent field keeps what is stored. A radius-only change is allowed in
any status, is stored and is never counted. A zip cannot be cleared. A body that changes no stored value writes nothing.
Switching off keeps the zip, the centroid and the rolling limit.

Status is ``suspended`` before ``removed`` before ``on``, and ``off`` otherwise (a collector with no profile row or no
setting row is ``off``). ``visible_beyond_friends`` is true when the status is ``on``, and also when a collector who is
not their Friend, and shares a conversation with them, is in their reach (that collector can read their Trade List
through the conversation, whatever the switch says).

This module also holds the Python side of the reach rule (``reach``, ``reach_one``: one call to the SQL function
``trade_reach``, migration 148), the helpers that go with it (``trader_user``, ``require_not_suspended``,
``lock_discovery``, ``account_state``, ``switch_off``, ``remove_from_discovery``, ``restore_discovery``) and the
distance bands. Callers call ``reach`` or ``reach_one`` after their own locks; the reach helpers take no lock and write
nothing, and the discovery writers say which locks they expect. This
module and ``friend_copies`` (the choke point) are the only ones whose SQL calls the reach function. ``nearby`` (Near you
and card search, #300) is the one Python call of the nearby-candidates function, and ``search_setting`` is the status and
radius those reads need.

Limit: a counted zip change is a change from one stored zip to a different one (a first zip is free), and a collector
may make 3 of them in a rolling 24 hours. Counted changes are ``handle_lookup_event`` rows of kind ``zip_change``,
pruned by ``PUT`` only. ``GET`` counts and never prunes or writes.

Locks: ``PUT`` runs ``ensure_owner``, then the advisory lock ``prizecheck.discovery:<user>`` (so one collector's
count-then-insert cannot race), then ``lock_owners``. Every later writer of ``discovery_setting`` for a collector (owner
removal, restore, suspension's switch off) must take the same advisory key before any ``inventory_owner`` row lock, or
it builds a deadlock cycle with a concurrent ``PUT``. ``lock_discovery`` is that key; the owner's removal, restore and
suspension (``reports``) call it, then ``remove_from_discovery``, ``restore_discovery`` or ``switch_off``.

Refusals, in the order they are checked after the body parses (a malformed body is FastAPI's own 422 first): 403
``ACCOUNT_SUSPENDED`` (switching on while suspended), 409 ``DISCOVERY_UNAVAILABLE`` (switching on while removed), 422
``INVALID_ZIP``, 422 ``UNKNOWN_ZIP``, 429 ``ZIP_CHANGE_LIMIT`` with ``retry_after_minutes``, 422 ``ZIP_REQUIRED`` (switching
on with no zip, given or stored).

This is the only module under ``app`` whose SQL names ``discovery_setting``, ``zip_centroid`` or ``open_discovery``
(``test_social_contract.py`` enforces it).
"""
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..location_tree import error
from ..db import connect
from ..identity import verified_user
from .owners import ensure_owner, lock_owners

router = APIRouter(prefix='/api/social/discovery', tags=['social'])

ZIP_CHANGES_PER_DAY = 3
ZIP_FORMAT = re.compile(r'[0-9]{5}(?:-[0-9]{4})?')
DiscoveryStatus = Literal['off', 'on', 'removed', 'suspended']
Radius = Literal[5, 10, 25, 50]
# The distance bands collectors see, never a distance (spec "Bands"); the SQL side answers the band number.
Band = Literal['under_5', '5_to_10', '10_to_25', '25_to_50']
BANDS: dict[int, Band] = {1: 'under_5', 2: '5_to_10', 3: '10_to_25', 4: '25_to_50'}
REACH = 'SELECT other_id, how, band FROM trade_reach(%(viewer)s, %(others)s::text[])'
# The collectors this collector shares a conversation with, as user ids (a deleted collector's side is NULL).
PARTNERS = """SELECT CASE WHEN user_low = %(me)s THEN user_high ELSE user_low END AS other FROM conversation
  WHERE (user_low = %(me)s OR user_high = %(me)s) AND user_low IS NOT NULL AND user_high IS NOT NULL"""


@dataclass(frozen=True)
class Reach:
    """Why one collector is in another's reach: ``how`` is ``'friend'``, ``'conversation'`` (they share a conversation)
    or ``'near'`` (both in open discovery within 50 miles), in that order of precedence. ``band`` is the distance band
    while both are in open discovery, else None."""
    how: Literal['friend', 'conversation', 'near']
    band: Band | None


def reach(conn, viewer: str, others: Iterable[str | None]) -> dict[str, Reach]:
    """The reach rule for ``viewer`` over ``others``: one statement, no lock. Collectors not in reach (and the viewer,
    unknown ids and None) are absent. Call it after the step's own locks."""
    ids = sorted({other for other in others if other is not None})
    if not ids:
        return {}
    rows = conn.execute(REACH, {'viewer': viewer, 'others': ids}).fetchall()
    return {row['other_id']: Reach(how=row['how'], band=None if row['band'] is None else BANDS[row['band']])
            for row in rows}


def reach_one(conn, viewer: str, other: str | None) -> Reach | None:
    """``reach`` for one collector: None when ``other`` is None or not in reach."""
    if other is None:
        return None
    return reach(conn, viewer, [other]).get(other)


def trader_user(conn, trader_id: UUID) -> str | None:
    """The user id behind a trader id, or None. A lookup only: it says nothing about reach."""
    row = conn.execute('SELECT user_id FROM collector_profile WHERE trader_id = %s', (trader_id,)).fetchone()
    return row['user_id'] if row else None


def require_not_suspended(conn, user_id: str) -> None:
    """Refuses with 403 ``ACCOUNT_SUSPENDED`` when the collector is suspended: the one definition every contact step
    shares. A collector with no profile is not suspended. Takes no lock and writes nothing."""
    row = conn.execute('SELECT suspended_at IS NOT NULL AS suspended FROM collector_profile WHERE user_id = %s',
                       (user_id,)).fetchone()
    if row and row['suspended']:
        error(403, 'ACCOUNT_SUSPENDED')


def lock_discovery(conn, user_id: str) -> None:
    """Takes the advisory lock ``prizecheck.discovery:<user>``, the key every writer of ``discovery_setting`` takes
    before any ``inventory_owner`` row lock. It is the first lock of the step, then the collector's owner row. Writes
    nothing."""
    conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.discovery:' || %s))", (user_id,))


@dataclass(frozen=True)
class AccountState:
    """Whether a collector is suspended and whether they were removed from open discovery."""
    suspended: bool
    removed: bool


def account_state(conn, user_id: str) -> AccountState | None:
    """The collector's suspension and removal flags, or None when there is no profile. Takes no lock and writes
    nothing."""
    row = conn.execute(SETTING, (user_id,)).fetchone()
    return None if row is None else AccountState(suspended=bool(row['suspended']), removed=bool(row['removed']))


def switch_off(conn, user_id: str) -> None:
    """Switches the collector's open discovery off, keeping the zip and radius. Does nothing with no setting row. The
    caller holds ``lock_discovery`` and then the collector's owner row. Writes nothing else."""
    conn.execute('UPDATE discovery_setting SET enabled = false, updated_at = now() WHERE user_id = %s AND enabled',
                 (user_id,))


def remove_from_discovery(conn, user_id: str) -> None:
    """Removes the collector from open discovery: ``removed_at`` set (the first time stays) and discovery off. The
    caller holds ``lock_discovery`` and then the collector's owner row, and has checked that the profile exists. Writes
    nothing else."""
    conn.execute("""INSERT INTO discovery_setting (user_id, enabled, removed_at, updated_at)
      VALUES (%s, false, now(), now())
      ON CONFLICT (user_id) DO UPDATE SET enabled = false,
        removed_at = coalesce(discovery_setting.removed_at, now()), updated_at = now()""", (user_id,))


def restore_discovery(conn, user_id: str) -> bool:
    """Clears ``removed_at`` and leaves ``enabled`` alone. True when a removal was cleared. The caller holds
    ``lock_discovery`` and then the collector's owner row. Writes nothing else."""
    return conn.execute("""UPDATE discovery_setting SET removed_at = NULL, updated_at = now()
      WHERE user_id = %s AND removed_at IS NOT NULL RETURNING 1""", (user_id,)).fetchone() is not None


# The radius filters by band edges (spec "Radius"), so 25 keeps bands 1 to 3 and nobody beyond 50 mi is ever a candidate.
MAX_BAND: dict[int, int] = {5: 1, 10: 2, 25: 3, 50: 4}
NEARBY = 'SELECT other_id, band FROM nearby_collectors(%(viewer)s, %(max_band)s::smallint, %(rows)s)'
SETTING = """SELECT p.suspended_at IS NOT NULL AS suspended, d.enabled, d.zip, d.radius_mi,
    d.removed_at IS NOT NULL AS removed
  FROM collector_profile p LEFT JOIN discovery_setting d ON d.user_id = p.user_id
  WHERE p.user_id = %s"""


@dataclass(frozen=True)
class SearchSetting:
    """The status and radius a Near you or card search read needs: the caller's own setting, nothing about anyone else."""
    status: DiscoveryStatus
    radius_mi: Radius


def status_of(row) -> DiscoveryStatus:
    """The status ladder: suspended before removed before on, else off (no row, no profile, no setting is off)."""
    if row and row['suspended']:
        return 'suspended'
    if row and row['removed']:
        return 'removed'
    if row and row['enabled']:
        return 'on'
    return 'off'


def search_setting(conn, user_id: str) -> SearchSetting:
    """The caller's status and radius (25 with no setting row). Takes no lock, writes nothing, and skips the zip-change
    count and ``visible_beyond_friends``."""
    row = conn.execute(SETTING, (user_id,)).fetchone()
    return SearchSetting(status=status_of(row), radius_mi=row['radius_mi'] if row and row['radius_mi'] else 25)


def nearby(conn, viewer: str, radius: Radius, limit: int) -> dict[str, Band]:
    """The collectors in open discovery within ``radius`` (by band), never Friends or anyone blocked either way, at most
    ``limit``, as ``{user id: band}`` in the SQL's order (band, then the per-viewer hash). The cut inside a band is that
    hash, so it never ranks by distance. Empty when the viewer is not in open discovery. One statement, no lock."""
    rows = conn.execute(NEARBY, {'viewer': viewer, 'max_band': MAX_BAND[radius], 'rows': limit}).fetchall()
    return {row['other_id']: BANDS[row['band']] for row in rows}


class DiscoverySettings(BaseModel):
    """The caller's own Open discovery setting: its status, their zip code, the radius they search, the zip changes they
    have left in the last 24 hours and whether collectors who are not their Friends can see them."""
    status: DiscoveryStatus
    zip: str | None
    radius_mi: Radius
    zip_changes_left: int
    visible_beyond_friends: bool


class SetDiscovery(BaseModel):
    """Changes to the caller's setting. A field that is None or absent keeps the stored value."""
    enabled: bool | None = None
    zip: str | None = Field(default=None, max_length=32)
    radius_mi: Radius | None = None


def read_discovery(conn, user_id: str) -> DiscoverySettings:
    """The caller's setting as ``DiscoverySettings``. Writes nothing."""
    row = conn.execute(SETTING, (user_id,)).fetchone()
    used = conn.execute("""SELECT count(*) AS used FROM handle_lookup_event
      WHERE user_id=%s AND kind='zip_change' AND created_at >= now() - interval '24 hours'""", (user_id,)).fetchone()
    status = status_of(row)
    return DiscoverySettings(
        status=status, zip=row['zip'] if row else None, radius_mi=row['radius_mi'] if row and row['radius_mi'] else 25,
        zip_changes_left=max(0, ZIP_CHANGES_PER_DAY - used['used']),
        visible_beyond_friends=status == 'on' or conversation_in_reach(conn, user_id))


def conversation_in_reach(conn, user_id: str) -> bool:
    """Whether a collector the caller shares a conversation with is in the caller's reach by that conversation. Reach is
    symmetric, so that collector can read the caller's Trade List through it."""
    partners = [row['other'] for row in conn.execute(PARTNERS, {'me': user_id})]
    return any(found.how == 'conversation' for found in reach(conn, user_id, partners).values())


def count_zip_change(conn, user_id: str) -> None:
    """Counts one zip change, or refuses with 429 ``ZIP_CHANGE_LIMIT`` when the collector has made 3 in the last 24
    hours. Inside the request transaction, so a refusal is not counted."""
    conn.execute("""DELETE FROM handle_lookup_event
      WHERE user_id=%s AND kind='zip_change' AND created_at < now() - interval '24 hours'""", (user_id,))
    recent = conn.execute("""SELECT count(*) AS changes, min(created_at) AS oldest FROM handle_lookup_event
      WHERE user_id=%s AND kind='zip_change'""", (user_id,)).fetchone()
    if recent['changes'] >= ZIP_CHANGES_PER_DAY:
        wait = conn.execute("SELECT ceil(extract(epoch FROM %s + interval '24 hours' - now()) / 60) AS wait",
                            (recent['oldest'],)).fetchone()['wait']
        raise HTTPException(429, {'code': 'ZIP_CHANGE_LIMIT', 'retry_after_minutes': max(1, int(wait))})
    conn.execute("INSERT INTO handle_lookup_event(user_id,kind) VALUES (%s,'zip_change')", (user_id,))


@router.get('', response_model=DiscoverySettings)
def get_discovery(user_id: str = Depends(verified_user)):
    """The caller's own Open discovery setting. Writes nothing and makes no owner row."""
    with connect() as conn, conn.transaction():
        return read_discovery(conn, user_id)


@router.put('', response_model=DiscoverySettings)
def set_discovery(command: SetDiscovery, user_id: str = Depends(verified_user)):
    """Switches Open discovery on or off, stores a zip code and sets the radius. Idempotent by value: a body that
    changes nothing writes nothing. See the module docstring for the order of the refusals."""
    with connect() as conn, conn.transaction():
        ensure_owner(conn, user_id)
        lock_discovery(conn, user_id)
        lock_owners(conn, user_id)
        conn.execute('SELECT create_collector_profile(%s)', (user_id,))
        stored = conn.execute("""SELECT p.suspended_at IS NOT NULL AS suspended, d.enabled, d.zip, d.lat, d.lon,
            d.radius_mi, d.removed_at IS NOT NULL AS removed
          FROM collector_profile p LEFT JOIN discovery_setting d ON d.user_id = p.user_id
          WHERE p.user_id = %s""", (user_id,)).fetchone()
        was = (bool(stored['enabled']), stored['zip'], stored['lat'], stored['lon'], stored['radius_mi'] or 25)
        if command.enabled is True and stored['suspended']:
            error(403, 'ACCOUNT_SUSPENDED')
        if command.enabled is True and stored['removed']:
            error(409, 'DISCOVERY_UNAVAILABLE')
        zip5 = centroid = None
        if command.zip is not None:
            given = command.zip.strip()
            if not ZIP_FORMAT.fullmatch(given):
                error(422, 'INVALID_ZIP')
            zip5 = given[:5]
            centroid = conn.execute('SELECT lat, lon FROM zip_centroid WHERE zip = %s', (zip5,)).fetchone()
            if centroid is None:
                error(422, 'UNKNOWN_ZIP')
            if stored['zip'] is not None and zip5 != stored['zip']:
                count_zip_change(conn, user_id)
        if command.enabled is True and zip5 is None and stored['zip'] is None:
            error(422, 'ZIP_REQUIRED')
        enabled = was[0] if command.enabled is None else command.enabled
        place = (zip5, centroid['lat'], centroid['lon']) if zip5 is not None else was[1:4]
        radius = was[4] if command.radius_mi is None else command.radius_mi
        if (enabled, *place, radius) != was:
            conn.execute("""INSERT INTO discovery_setting (user_id, enabled, zip, lat, lon, radius_mi, updated_at)
              VALUES (%s, %s, %s, %s, %s, %s, now())
              ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, zip = EXCLUDED.zip, lat = EXCLUDED.lat,
                lon = EXCLUDED.lon, radius_mi = EXCLUDED.radius_mi, updated_at = now()""",
                         (user_id, enabled, *place, radius))
        return read_discovery(conn, user_id)
