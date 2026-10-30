import base64
import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from uuid import UUID
from app.location_tree import error
from app.borrowed_copies import borrowed_in
from app.copy_allocation import held_for_line


def deck_cursor_encode(user_id, revision, row):
    payload = json.dumps({'v': 1, 'u': user_id, 'r': revision,
                          'k': [row['sort_name'], str(row['id'])]}, separators=(',', ':')).encode()
    mac = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + mac).decode().rstrip('=')


def deck_cursor_decode(token, user_id, revision):
    try:
        if len(token) > 2048:
            raise ValueError()
        raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
        payload, mac = raw[:-32], raw[-32:]
        expected = hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, expected):
            raise ValueError()
        data = json.loads(payload)
        if data['v'] != 1 or data['u'] != user_id or not isinstance(data['r'], int):
            raise ValueError()
        if data['r'] != revision:
            error(409, 'INVENTORY_CHANGED')
        if len(data['k']) != 2 or not isinstance(data['k'][0], str):
            raise ValueError()
        return data['k'][0], UUID(data['k'][1])
    except (ValueError, KeyError, TypeError):
        error(400, 'INVALID_CURSOR')


def cover_candidates(lines: list[tuple[UUID, int]], picked: UUID | None) -> list[UUID]:
    """The Editions that can lead a Deck's tile: none for an empty Deck List, the collector's pick when there is one
    (the database keeps it on the list), else every Edition tied for the most copies."""
    if not lines:
        return []
    if picked is not None:
        return [picked]
    most = max(quantity for _, quantity in lines)
    return [edition for edition, quantity in lines if quantity == most]


@dataclass(frozen=True)
class IndexCounts:
    deck_list_total: int
    in_deck: int
    lines: list[tuple[UUID, int]]
    pick: UUID | None


def index_counts(conn, user_id: str, deck_ids: list[UUID]) -> dict[UUID, IndexCounts]:
    if not deck_ids:
        return {}
    held = {(row['location_id'], row['edition_id']): row['quantity'] for row in conn.execute(
        'SELECT location_id,edition_id,quantity FROM holding WHERE owner_id=%s AND location_id=ANY(%s)',
        (user_id, deck_ids))}
    # A Deck's Borrowed Copies are in it too (#254).
    for key, copies in borrowed_in(conn, user_id, deck_ids).items():
        held[key] = held.get(key, 0) + copies
    picks = {row['deck_id']: row['edition_id'] for row in conn.execute(
        'SELECT deck_id,edition_id FROM deck_cover WHERE owner_id=%s AND deck_id=ANY(%s)', (user_id, deck_ids))}
    totals = {deck_id: [0, 0] for deck_id in deck_ids}
    lines = {deck_id: [] for deck_id in deck_ids}
    for row in conn.execute('SELECT deck_id,edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND deck_id=ANY(%s)',
                            (user_id, deck_ids)):
        lines[row['deck_id']].append((row['edition_id'], row['quantity']))
        total = totals[row['deck_id']]
        total[0] += row['quantity']
        total[1] += held_for_line(row['quantity'], held.get((row['deck_id'], row['edition_id']), 0))
    return {deck_id: IndexCounts(totals[deck_id][0], totals[deck_id][1], lines[deck_id], picks.get(deck_id))
            for deck_id in deck_ids}
