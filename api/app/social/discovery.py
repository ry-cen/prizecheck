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
setting row is ``off``). ``visible_beyond_friends`` is true exactly when the status is ``on``; the conversation clause of
the reach rule belongs to a later ticket.

Limit: a counted zip change is a change from one stored zip to a different one (a first zip is free), and a collector
may make 3 of them in a rolling 24 hours. Counted changes are ``handle_lookup_event`` rows of kind ``zip_change``,
pruned by ``PUT`` only. ``GET`` counts and never prunes or writes.

Locks: ``PUT`` runs ``ensure_owner``, then the advisory lock ``prizecheck.discovery:<user>`` (so one collector's
count-then-insert cannot race), then ``lock_owners``. Every later writer of ``discovery_setting`` for a collector (owner
removal, restore, suspension's switch off) must take the same advisory key before any ``inventory_owner`` row lock, or
it builds a deadlock cycle with a concurrent ``PUT``.

Refusals, in the order they are checked after the body parses (a malformed body is FastAPI's own 422 first): 409
``DISCOVERY_UNAVAILABLE`` (switching on while removed or suspended), 422 ``INVALID_ZIP``, 422 ``UNKNOWN_ZIP``, 429
``ZIP_CHANGE_LIMIT`` with ``retry_after_minutes``, 422 ``ZIP_REQUIRED`` (switching on with no zip, given or stored).

This is the only module under ``app`` whose SQL names ``discovery_setting``, ``zip_centroid`` or ``open_discovery``
(``test_social_contract.py`` enforces it).
"""
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..location_tree import error
from ..main import connect, verified_user
from .owners import ensure_owner, lock_owners

router = APIRouter(prefix='/api/social/discovery', tags=['social'])

ZIP_CHANGES_PER_DAY = 3
ZIP_FORMAT = re.compile(r'[0-9]{5}(?:-[0-9]{4})?')
DiscoveryStatus = Literal['off', 'on', 'removed', 'suspended']
Radius = Literal[5, 10, 25, 50]


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
    row = conn.execute("""SELECT p.suspended_at IS NOT NULL AS suspended, d.enabled, d.zip, d.radius_mi,
        d.removed_at IS NOT NULL AS removed
      FROM collector_profile p LEFT JOIN discovery_setting d ON d.user_id = p.user_id
      WHERE p.user_id = %s""", (user_id,)).fetchone()
    used = conn.execute("""SELECT count(*) AS used FROM handle_lookup_event
      WHERE user_id=%s AND kind='zip_change' AND created_at >= now() - interval '24 hours'""", (user_id,)).fetchone()
    if row and row['suspended']:
        status = 'suspended'
    elif row and row['removed']:
        status = 'removed'
    elif row and row['enabled']:
        status = 'on'
    else:
        status = 'off'
    return DiscoverySettings(
        status=status, zip=row['zip'] if row else None, radius_mi=row['radius_mi'] if row and row['radius_mi'] else 25,
        zip_changes_left=max(0, ZIP_CHANGES_PER_DAY - used['used']), visible_beyond_friends=status == 'on')


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
        conn.execute("SELECT pg_advisory_xact_lock(hashtext('prizecheck.discovery:' || %s))", (user_id,))
        lock_owners(conn, user_id)
        conn.execute('SELECT create_collector_profile(%s)', (user_id,))
        stored = conn.execute("""SELECT p.suspended_at IS NOT NULL AS suspended, d.enabled, d.zip, d.lat, d.lon,
            d.radius_mi, d.removed_at IS NOT NULL AS removed
          FROM collector_profile p LEFT JOIN discovery_setting d ON d.user_id = p.user_id
          WHERE p.user_id = %s""", (user_id,)).fetchone()
        was = (bool(stored['enabled']), stored['zip'], stored['lat'], stored['lon'], stored['radius_mi'] or 25)
        if command.enabled is True and (stored['suspended'] or stored['removed']):
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
