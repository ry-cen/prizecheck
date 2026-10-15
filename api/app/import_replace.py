"""Replace a Deck's list through the import review (decklist import #215; spec "Replace" and "Import interfaces").

``POST /api/decks/import/review`` with a ``deck_id`` reviews a paste as the new Deck List of that Deck:

- **Ownership.** ``read_replaced`` runs inside the owned-copies capture (``import_owned.capture_owned``), under the
  owner row lock and before ``copy_allocation.available_to``, and answers 404 DECK_NOT_FOUND unless ``deck_id`` is one of
  the caller's Decks. ``available_to`` would raise KeyError for any other id.
- **One committed state.** Under that lock it reads the Deck's name, its Deck List revision and lines, and every one of
  its Holdings (not only those of the Editions the paste reaches) with their versions and display data.
- **The answer** (``replacement``): the batch saving sends to ``POST /api/decks/{id}/deck-list/changes`` at that
  revision (every Edition of the new list at its total, then ``0`` for every current line the new list doesn't name),
  the current lines (the web's Undo is the inverse batch over the same Editions), and the Surplus preview: the Deck's
  copies beyond the new list, by ``deck_ownership.beyond_list``, the rule the deck builder's Surplus group reads. Nothing
  moves on save, so after saving the builder's Surplus equals the preview.

It writes nothing. It never imports ``set_codes`` (``test_set_codes.py`` pins the importers): the preview carries the
builder's display data.
"""
from dataclasses import dataclass
from uuid import UUID

from pydantic import BaseModel

from .deck_list_display import read_line_display
from .deck_ownership import SurplusHolding, beyond_list, surplus_holdings
from .location_tree import error


class ReplaceLine(BaseModel):
    edition_id: UUID
    quantity: str


class ImportReplace(BaseModel):
    """What saving a Replace sends and what it leaves behind, read with the owned copies under the owner row lock."""
    deck_id: UUID
    name: str                        # the Deck's name
    deck_list_revision: int          # the Deck List revision saving sends; STALE_DECK_LIST if it moved since
    current: list[ReplaceLine]       # the Deck List at that revision, in Edition order; Undo restores it
    # The changes batch saving sends: every Edition of ``deck_list`` at its total, in that order, then "0" for every
    # current line the new list doesn't name, in Edition order. Its length counts against MAX_DECK_LIST_CHANGES.
    changes: list[ReplaceLine]
    # The Surplus preview: the Deck's copies beyond the new list, exactly as the Deck detail's ``surplus`` reads them
    # once the batch is saved (no Holding moves).
    surplus: list[SurplusHolding]


@dataclass(frozen=True)
class ReplacedDeck:
    deck_id: UUID
    name: str
    revision: int
    lines: dict[UUID, int]          # the current Deck List, by Edition
    holdings: dict[UUID, int]       # every copy the Deck holds, by Edition
    versions: dict[UUID, int]       # each Holding's version
    display: dict[UUID, dict]       # each held Edition's display data (``read_line_display``)


def read_replaced(conn, user_id: str, deck_id: UUID) -> ReplacedDeck:
    """The Deck being replaced, or 404 DECK_NOT_FOUND for a missing, foreign or non-Deck Location. The caller holds the
    owner row lock. Primary-key range reads (``deck_ownership.read_ownership``'s pattern, never a join), plus the display
    data of the Editions the Deck holds, so the answer is built without another connection."""
    deck = conn.execute("SELECT name FROM location WHERE owner_id=%s AND id=%s AND kind='deck'",
                        (user_id, deck_id)).fetchone()
    if deck is None:
        error(404, 'DECK_NOT_FOUND')
    revision = conn.execute('SELECT revision FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                            (user_id, deck_id)).fetchone()['revision']
    lines = {row['edition_id']: row['quantity'] for row in conn.execute(
        'SELECT edition_id,quantity FROM deck_list_line WHERE owner_id=%s AND deck_id=%s', (user_id, deck_id))}
    held = conn.execute('SELECT edition_id,quantity,version FROM holding WHERE owner_id=%s AND location_id=%s',
                        (user_id, deck_id)).fetchall()
    return ReplacedDeck(deck_id=deck_id, name=deck['name'], revision=revision, lines=lines,
                        holdings={row['edition_id']: row['quantity'] for row in held},
                        versions={row['edition_id']: row['version'] for row in held},
                        display=read_line_display(conn, [row['edition_id'] for row in held]))


def replacement(replaced: ReplacedDeck, deck_list: list[tuple[UUID, int]]) -> ImportReplace:
    """The answer for a Replace whose merged new Deck List is ``deck_list`` ((Edition, total) in first-appearance
    order). Pure."""
    new = dict(deck_list)
    removed = sorted(edition for edition in replaced.lines if edition not in new)
    beyond = beyond_list(replaced.holdings, new)
    return ImportReplace(
        deck_id=replaced.deck_id, name=replaced.name, deck_list_revision=replaced.revision,
        current=[ReplaceLine(edition_id=edition, quantity=str(quantity))
                 for edition, quantity in sorted(replaced.lines.items())],
        changes=[*(ReplaceLine(edition_id=edition, quantity=str(quantity)) for edition, quantity in deck_list),
                 *(ReplaceLine(edition_id=edition, quantity='0') for edition in removed)],
        surplus=surplus_holdings(beyond, replaced.versions, replaced.display))
