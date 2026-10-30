import json
from collections.abc import Mapping
from uuid import UUID
from pydantic import BaseModel, Field
from app.location_tree import EditLocation, error
from app.borrowed_copies import borrowed_at, physical
from app.copy_allocation import held_for_line
from app.core.decks.ownership import held_in


class CreateDeck(BaseModel):
    name: str
    idempotency_key: UUID


class EditDeck(EditLocation):
    """Rename a Deck, move it to another parent, or both. The fields and rules are the Location edit's."""


class AddDeckListLine(BaseModel):
    edition_id: UUID
    quantity: str
    revision: int = Field(ge=1)
    idempotency_key: UUID


class ChangeDeckListLine(BaseModel):
    quantity: str
    revision: int = Field(ge=1)
    idempotency_key: UUID


class RemoveDeckListLine(BaseModel):
    revision: int = Field(ge=1)
    idempotency_key: UUID


class SetDeckCover(BaseModel):
    edition_id: UUID | None           # None clears the pick.
    expected_edition_id: UUID | None  # The pick the client last read; a different current pick is STALE_DECK_COVER.
    idempotency_key: UUID


class DeckCoverResult(BaseModel):
    deck_id: UUID
    cover_edition_id: UUID | None


# The most lines one batch Deck List change sets (app redesign #177): far more than one add, remove, swap or a burst of
# taps the builder merges into one batch.
MAX_DECK_LIST_CHANGES = 200


class DeckListChange(BaseModel):
    edition_id: UUID
    # The line's new total. "0" removes the line; a 0 for an Edition the Deck List doesn't have changes nothing.
    quantity: str


class ChangeDeckList(BaseModel):
    revision: int = Field(ge=1)
    idempotency_key: UUID
    changes: list[DeckListChange] = Field(max_length=MAX_DECK_LIST_CHANGES)


class DeckListLineBase(BaseModel):
    edition_id: UUID
    quantity: str
    in_deck: str


def require_deck(rows, deck_id: UUID):
    deck = rows.get(deck_id)
    if not deck or deck['kind'] != 'deck':
        error(404, 'DECK_NOT_FOUND')
    return deck


def read_cover(conn, user_id: str, deck_id: UUID) -> UUID | None:
    row = conn.execute('SELECT edition_id FROM deck_cover WHERE owner_id=%s AND deck_id=%s', (user_id, deck_id)).fetchone()
    return row['edition_id'] if row else None


def check_revision(conn, user_id: str, deck_id: UUID, expected: int):
    current = conn.execute('SELECT revision FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                           (user_id, deck_id)).fetchone()
    if current is None:
        raise RuntimeError('Deck has no Deck List')
    if current['revision'] != expected:
        error(409, 'STALE_DECK_LIST')


def line_exists(conn, user_id: str, deck_id: UUID, edition_id: UUID) -> bool:
    return bool(conn.execute('SELECT 1 FROM deck_list_line WHERE owner_id=%s AND deck_id=%s AND edition_id=%s',
                             (user_id, deck_id, edition_id)).fetchone())


def write_deck_list(conn, user_id: str, deck_id: UUID, totals: Mapping[UUID, int]) -> None:
    """The Deck List changes batch's write part (Trading #279): each Edition's new line total, 0 removing the line. It
    runs no lock, replay, revision or availability check; the caller holds the owner lock and has done the checks it
    needs. It touches no Holding, the inventory revision or the inventory Undo records, and advances no revision
    (``advance_deck_list`` does)."""
    removed = [edition for edition, quantity in totals.items() if quantity == 0]
    if removed:
        conn.execute('DELETE FROM deck_list_line WHERE owner_id=%s AND deck_id=%s AND edition_id=ANY(%s)',
                     (user_id, deck_id, removed))
    kept = [(edition, quantity) for edition, quantity in totals.items() if quantity > 0]
    if kept:
        conn.execute("""INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity)
          SELECT %s,%s,edition_id,quantity FROM unnest(%s::uuid[],%s::bigint[]) AS change(edition_id,quantity)
          ON CONFLICT (owner_id,deck_id,edition_id) DO UPDATE SET quantity=EXCLUDED.quantity""",
                     (user_id, deck_id, [edition for edition, _ in kept], [quantity for _, quantity in kept]))


def keep_response(conn, user_id: str, key: UUID, digest: str, result: BaseModel) -> dict:
    """Store a Deck List command's response for replay and return it."""
    response = result.model_dump(mode='json')
    conn.execute('INSERT INTO location_command(owner_id,request_key,request_digest,response) VALUES (%s,%s,%s,%s)',
                 (user_id, key, digest, json.dumps(response)))
    return response


def read_deck_list_revision(conn, user_id: str, deck_id: UUID) -> int:
    header = conn.execute('SELECT revision FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                          (user_id, deck_id)).fetchone()
    if header is None:
        # Migration 029 and its location trigger give every Deck a Deck List.
        raise RuntimeError('Deck has no Deck List')
    return header['revision']


def read_deck_list(conn, user_id: str, deck_id: UUID, *, display, line) -> tuple[int, list]:
    revision = read_deck_list_revision(conn, user_id, deck_id)
    # Two primary-key range reads paired here, never a join (see deck_ownership.read_ownership).
    lines = conn.execute('SELECT edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND deck_id=%s '
                         'ORDER BY edition_id', (user_id, deck_id)).fetchall()
    # The Deck's physical copies: its Holdings and its Borrowed Copies (#254).
    held = physical(held_in(conn, user_id, deck_id), borrowed_at(conn, user_id, deck_id))
    display = display(conn, [row['edition_id'] for row in lines])
    return (revision, [
        line(edition_id=row['edition_id'], quantity=str(row['quantity']),
                     in_deck=str(held_for_line(row['quantity'], held.get(row['edition_id'], 0))),
                     **display[row['edition_id']])
        for row in lines])


def advance_deck_list_revision(conn, user_id: str, deck_id: UUID) -> None:
    conn.execute('UPDATE deck_list SET revision=revision+1 WHERE owner_id=%s AND deck_id=%s', (user_id, deck_id))
