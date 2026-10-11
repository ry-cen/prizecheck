"""The active frozen Published Deck snapshot behind anonymous enrichment routes (ticket 12 cost; tickets 13 and 14 reuse
it for the Live and Mass Entry exports). The export routes (tickets 13 and 14) use
`read_for_export` and `revalidate_for_export`, which turn every failure into an HTTP error.

A public enrichment route's only inputs are the token and the snapshot version in its path. Everything else (rows, opaque
references, frozen quantities and the frozen-content digest) is derived here from the active public projection, and the
projection is read again before a response, so a revoke, a republish or a rewritten snapshot can never be answered with
enrichment computed for other content. Nothing here touches PostgreSQL, a session or private inventory. Every read is
bounded by the caller's monotonic deadline; the projection adapter's own five-second timeout never bounds it.
"""
import hashlib
import json
import re
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request
from pydantic import ValidationError

from . import prices
from .public_projection import ProjectionUnavailable, public_projection_store
from .publications import PUBLIC_HEADERS, TOKEN, PublicSnapshot

VERSION = re.compile(r'[1-9][0-9]{0,17}')
QUANTITY = re.compile(r'[1-9][0-9]{0,63}')


class SnapshotGone(Exception):
    """The token is not active: never published, revoked, or removed from the projection."""


class SnapshotChanged(Exception):
    """The active snapshot is another version, or its frozen content changed since it was first read."""


class SnapshotLate(Exception):
    """The projection could not be read before the caller's deadline."""


@dataclass(frozen=True)
class FrozenRow:
    name: str
    set_id: str
    set_name: str
    collector_number: str
    variant: dict
    image_url: str | None
    quantity: int
    edition_ref: str | None
    printing_ref: str | None


@dataclass(frozen=True)
class ActiveSnapshot:
    token: str
    version: int
    digest: str
    visibility: str
    snapshot: PublicSnapshot
    rows: tuple[FrozenRow, ...]

    @property
    def total_copies(self) -> int:
        return sum(row.quantity for row in self.rows)


def error(status: int, code: str) -> HTTPException:
    return HTTPException(status, {'code': code}, headers=dict(PUBLIC_HEADERS))


def public_path(request: Request, token: str, version: str) -> int:
    """The only accepted inputs: no query string and no body, then token and version syntax. Returns the version."""
    if request.url.query or request.headers.get('content-length', '0') != '0' or 'transfer-encoding' in request.headers:
        raise error(422, 'INVALID_REQUEST')
    if not TOKEN.fullmatch(token) or not VERSION.fullmatch(version):
        raise error(404, 'PUBLISHED_DECK_NOT_FOUND')
    return int(version)


def snapshot_digest(stored) -> str:
    raw = json.dumps(stored, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def _quantity(text: str) -> int:
    if not QUANTITY.fullmatch(text):
        raise ValueError('quantity')
    return int(text)


def _record(token: str, timeout: float):
    return public_projection_store().read_state(timeout=timeout)[0].get(token)


def read_active(token: str, version: int, *, deadline: float) -> ActiveSnapshot:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SnapshotLate()
    try:
        record = prices._bounded(lambda: _record(token, max(0.001, remaining)), remaining)
    except prices._Late:
        raise SnapshotLate() from None
    if record is None:
        raise SnapshotGone()
    try:
        visibility, stored = record['visibility'], record['snapshot']
        if visibility not in ('listed', 'unlisted'):
            raise ValueError('visibility')
        snapshot = PublicSnapshot.model_validate(stored)
        # A row's name is its own Card Printing name; a snapshot published before Deck Lists 09 has only its group's
        # Card Identity name.
        rows = tuple(FrozenRow(edition.printing_name or identity.name, edition.set_id, edition.set_name,
                               edition.collector_number, edition.variant, edition.image_url, _quantity(edition.quantity),
                               edition.edition_ref, edition.printing_ref)
                     for identity in snapshot.identities for edition in identity.editions)
    except (KeyError, TypeError, ValueError, ValidationError):
        raise ProjectionUnavailable() from None
    if snapshot.version != version:
        raise SnapshotChanged()
    return ActiveSnapshot(token, version, snapshot_digest(stored), visibility, snapshot, rows)


def revalidate(active: ActiveSnapshot, *, deadline: float) -> None:
    """Raise unless the token is still active with the same version and byte-for-byte the same frozen content."""
    if read_active(active.token, active.version, deadline=deadline).digest != active.digest:
        raise SnapshotChanged()


def printing_matches(frozen_printing_ref, catalog_printing_ref) -> bool:
    """The one reference-proof rule: a frozen Printing reference is present and the public Edition record names it."""
    return frozen_printing_ref is not None and catalog_printing_ref == frozen_printing_ref


def same_printing(row: FrozenRow, printing_ref) -> bool:
    """The row's opaque reference resolves to the Printing frozen with it (False for legacy rows and any mismatch)."""
    return row.edition_ref is not None and printing_matches(row.printing_ref, printing_ref)


# --- Shared by the export routes (tickets 13 and 14): unbudgeted, so every failure is an HTTP error -----------------
EXPORT_SECONDS = 5.0  # Never slower than the snapshot route's own adapter timeout.


def export_deadline() -> float:
    return time.monotonic() + EXPORT_SECONDS


def _raise_for(exc: Exception):
    if isinstance(exc, SnapshotGone):
        raise error(404, 'PUBLISHED_DECK_NOT_FOUND') from None
    if isinstance(exc, SnapshotChanged):
        raise error(409, 'PUBLISHED_DECK_CHANGED') from None
    raise error(503, 'PUBLIC_PROJECTION_UNAVAILABLE') from None


def read_for_export(token: str, version: int, *, deadline: float) -> ActiveSnapshot:
    try:
        return read_active(token, version, deadline=deadline)
    except (SnapshotGone, SnapshotChanged, SnapshotLate, ProjectionUnavailable) as exc:
        _raise_for(exc)


def revalidate_for_export(active: ActiveSnapshot, *, deadline: float) -> None:
    """Before any export answer, including before a .txt stream starts: same token, version and frozen content."""
    try:
        revalidate(active, deadline=deadline)
    except (SnapshotGone, SnapshotChanged, SnapshotLate, ProjectionUnavailable) as exc:
        _raise_for(exc)
