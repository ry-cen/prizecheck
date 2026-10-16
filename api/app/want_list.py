"""The Want List (decklist import #209; spec "The Want List" and "The Want List page").

``GET /api/want-list`` answers what the collector's Decks still need from outside the Collection under the account's
Want List counting setting: one section per Deck, oldest Deck first, and a combined total listing each card once with
the Decks that need it. ``?deck=<id>`` scopes the answer to one Deck: its section only, and a combined total of that
Deck's needs. It is derived only; nothing here is stored.

Every count comes from ``copy_allocation.allocate``, the one allocation behind the Deck detail's ``to_get``, the cost
to complete and Buy missing, so a Deck's section needs exactly what its builder says it does. Counting is per Card
Edition, so the scoped read allocates only that Deck's Editions and still counts every older Deck that lists them.

- **Every Deck built at once:** the combined total of a card is the sum of the sections' needs.
- **One Deck at a time:** it is the largest need any one Deck has.

``capture_want_list`` is one capture under the owner row lock (``owner_and_rows``) that every Holding, Deck List and
settings writer takes, so the setting, the Holdings and the Deck Lists belong to one committed state. Its reads are
range reads paired in memory, never a join: the owner's Locations (the lock read), its Decks' creation times and Deck
List revisions, the Deck List lines, and the Holdings of the Editions those lines name. The work grows with the
collector's Decks and Deck List lines, never with the rest of the Collection. The catalog display read runs after the
capture commits, for the lines that still need copies only.

This is not a price access (ADR 0006): it reads no quote, admits no refresh and waits for no runner. The cost of the
same scope (#210) and its Mass Entry export reuse ``capture_want_list`` and ``combined``.

The Swap hint (#211, ``swap_hints``) is ``WantListLine.swap``. The route asks the capture for it (``swaps=True``), which
reads the Reprint Groups of the lines that still need copies in the same transaction; other callers don't pay for it.
"""
import hashlib
import re
from dataclasses import dataclass, field
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .copy_allocation import Allocation, LineCount, allocate, deck_order
from .deck_list_display import read_line_display
from .location_tree import error, owner_and_rows
from .main import connect, verified_user
from .settings import WantListCounting, read_settings
from .swap_hints import GroupEdition, SwapCapture, SwapHint, capture_swaps, hints, swap_hint

router = APIRouter(prefix='/api/want-list', tags=['want-list'])


class WantListDeck(BaseModel):
    """One Deck, for the page's Deck chips."""
    id: UUID
    name: str


class CountedFromDeck(BaseModel):
    """Copies another Deck holds for its own line that this line counts (One Deck at a time only)."""
    deck_id: UUID
    quantity: str


class WantListLine(BaseModel):
    """One Deck List line that still needs copies. ``held + spare + other_decks + lent + need == quantity``."""
    edition_id: UUID
    # Display data, as a Deck List line carries it (``deck_list_display``).
    name: str
    set_id: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    quantity: str           # The line's intended copies (M in "N of M").
    held: str               # This Deck's own copies, up to the line.
    spare: str              # Spare Copies counted for the line.
    other_decks: str        # Copies other Decks hold for their own lines, counted for this one (One Deck at a time).
    counted_from: list[CountedFromDeck]  # Where ``other_decks`` come from, oldest Deck first.
    lent: str               # Copies lent to Friends, counted for the line (social network #253): they come back.
    owned: str              # Every copy of the Edition the collector owns, wherever it is.
    need: str               # Copies still needed from outside the Collection (N in "N of M").
    swap: SwapHint | None = None  # Another Edition of the line's Reprint Group the collector can Swap in (#211).


class WantListSection(BaseModel):
    deck_id: UUID
    name: str
    deck_list_revision: int
    to_get: str                  # The Deck's need: its builder's "to complete" copies.
    lines: list[WantListLine]    # Only the lines that still need copies; none for a Deck that needs nothing.


class CombinedDeckNeed(BaseModel):
    deck_id: UUID
    need: str


class CombinedRow(BaseModel):
    """One card of the combined total, with the Decks that need it, oldest first."""
    edition_id: UUID
    name: str
    set_id: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    need: str
    decks: list[CombinedDeckNeed]


class WantList(BaseModel):
    want_list_counting: WantListCounting
    # The settings and inventory revisions the capture read; the setting moves neither the inventory revision nor any
    # Deck List revision, so a figure reused later is paired on all three.
    settings_revision: int
    owner_revision: int
    # Every Deck's id and Deck List revision as one opaque value (#210): a Deck List edit moves neither revision above,
    # so the cost and the Mass Entry export of this answer are paired on it too.
    deck_lists_digest: str
    deck_id: UUID | None          # The scope, or null for All Decks.
    decks: list[WantListDeck]     # Every Deck, oldest first, whatever the scope.
    sections: list[WantListSection]  # Every Deck oldest first, or the one in scope.
    combined: list[CombinedRow]   # Each card once: the total, or the scoped Deck's needs.
    to_get: str                   # Copies in ``combined``.


@dataclass(frozen=True)
class CapturedDeck:
    id: UUID
    name: str
    deck_list_revision: int


@dataclass(frozen=True)
class WantListCapture:
    counting: WantListCounting
    settings_revision: int
    owner_revision: int
    scope: UUID | None
    decks: tuple[CapturedDeck, ...]       # Every Deck, oldest first.
    allocation: Allocation                # Every line naming an Edition the Decks in scope list.
    swaps: SwapCapture = field(default_factory=SwapCapture)  # What the Swap hints read, when asked for (#211).

    def needs(self, deck_id: UUID) -> list[LineCount]:
        """The Deck's lines that still need copies, in Edition order."""
        return sorted((line for (deck, _), line in self.allocation.lines.items() if deck == deck_id and line.need > 0),
                      key=lambda line: line.edition_id)

    def shown(self) -> tuple[CapturedDeck, ...]:
        """The Decks whose sections the answer shows."""
        return tuple(deck for deck in self.decks if self.scope is None or deck.id == self.scope)

    @property
    def deck_lists_digest(self) -> str:
        """Every Deck's id and Deck List revision, whatever the scope: under Every Deck built at once an older Deck's
        list changes a newer Deck's need. A Deck List revision only grows, so an equal digest means the same Deck Lists."""
        decks = sorted(self.decks, key=lambda deck: str(deck.id))
        text = ','.join(f'{deck.id}:{deck.deck_list_revision}' for deck in decks)
        return hashlib.sha256(text.encode()).hexdigest()[:32]


def capture_want_list(user_id: str, deck_id: UUID | None = None, timeout_ms: int | None = None,
                      swaps: bool = False) -> WantListCapture:
    """Raises 404 ``DECK_NOT_FOUND`` when ``deck_id`` names a missing, foreign or non-Deck Location. ``timeout_ms``
    bounds every statement and lock wait, for a budgeted caller (#210). ``swaps`` also reads what the Swap hints of the
    lines in scope need (#211)."""
    with connect() as conn, conn.transaction():
        if timeout_ms is not None:
            conn.execute(f'SET LOCAL statement_timeout = {max(1, int(timeout_ms))}')
            conn.execute(f'SET LOCAL lock_timeout = {max(1, int(timeout_ms))}')
        revision, rows = owner_and_rows(conn, user_id)
        if deck_id is not None and (deck_id not in rows or rows[deck_id]['kind'] != 'deck'):
            error(404, 'DECK_NOT_FOUND')
        settings = read_settings(conn, user_id)
        lists = {row['deck_id']: row['revision'] for row in conn.execute(
            'SELECT deck_id,revision FROM deck_list WHERE owner_id=%s', (user_id,))}
        decks = tuple(CapturedDeck(id=deck, name=rows[deck]['name'], deck_list_revision=lists[deck])
                      for deck in deck_order(conn, user_id))
        scoped = ' AND deck_id=%s' if deck_id is not None else ''
        editions = {row['edition_id'] for row in conn.execute(
            f'SELECT edition_id FROM deck_list_line WHERE owner_id=%s{scoped}',
            (user_id, deck_id) if deck_id is not None else (user_id,))}
        allocation = allocate(conn, user_id, editions, settings.want_list_counting)
        needed = {edition for (deck, edition), line in allocation.lines.items()
                  if line.need > 0 and (deck_id is None or deck == deck_id)}
        swap_capture = capture_swaps(conn, user_id, needed, settings.want_list_counting) if swaps else SwapCapture()
        capture = WantListCapture(counting=settings.want_list_counting, settings_revision=settings.revision,
                                  owner_revision=revision, scope=deck_id, decks=decks, allocation=allocation,
                                  swaps=swap_capture)
    return capture


def combined(capture: WantListCapture, needs: dict[UUID, list[LineCount]]) -> list[tuple[UUID, int, list[LineCount]]]:
    """The combined total of the shown sections: each card once, in the order it first appears in them, with its need
    and the lines that need it. ``needs`` holds each shown Deck's lines; the caller sorts them the way the route does,
    and the total keeps that order. Under Every Deck built at once a card's need is the sum of those lines' needs;
    under One Deck at a time it is the largest one."""
    rows: dict[UUID, list[LineCount]] = {}
    for deck in capture.shown():
        for line in needs[deck.id]:
            rows.setdefault(line.edition_id, []).append(line)
    pick = sum if capture.counting == 'all_at_once' else max
    return [(edition, pick(line.need for line in lines), lines) for edition, lines in rows.items()]


NUMBER_PARTS = re.compile(r'^([a-z]*)(\d*)(.*)$', re.DOTALL)


def number_order(number: str) -> tuple:
    """A collector number in natural order, compared the way catalog search compares it (``catalog_browse.NUMBER_KEY``:
    zeros after a number's letters don't count, so 097 reads as 97): plain numbers by value (2 before 10), a letter
    suffix after its number, numbers with a letter prefix after the plain ones. The raw text breaks a tie."""
    key = re.sub(r'^([a-z]*)0*([0-9])', r'\1\2', number.lower())
    prefix, digits, rest = NUMBER_PARTS.match(key).groups()
    return prefix != '', prefix, int(digits) if digits else -1, rest, number


DISPLAY_FIELDS = ('name', 'set_id', 'set_name', 'collector_number', 'descriptor', 'image_url')


@router.get('', response_model=WantList)
def want_list(deck: UUID | None = None, user_id: str = Depends(verified_user)):
    capture = capture_want_list(user_id, deck, swaps=True)
    needs = {shown.id: capture.needs(shown.id) for shown in capture.shown()}
    with connect() as conn:
        display = read_line_display(conn, {line.edition_id for lines in needs.values() for line in lines})

    def shown_of(edition: UUID) -> dict:
        return {key: display[edition][key] for key in DISPLAY_FIELDS}

    # Lines read by card, then by Edition: name, set, collector number, then the Edition id for a stable order.
    def card_order(line: LineCount):
        fields = display[line.edition_id]
        return fields['name'].casefold(), fields['set_name'], number_order(fields['collector_number']), line.edition_id

    for lines in needs.values():
        lines.sort(key=card_order)

    # The Swap hints (#211), handed out in the same card order over every Deck, oldest first.
    def group_order(edition: GroupEdition):
        return edition.name.casefold(), edition.set_name, number_order(edition.collector_number), edition.edition_id

    offered = hints(capture.swaps, [captured.id for captured in capture.decks], group_order)
    sections = [WantListSection(
        deck_id=shown.id, name=shown.name, deck_list_revision=shown.deck_list_revision,
        to_get=str(sum(line.need for line in needs[shown.id])),
        lines=[WantListLine(
            edition_id=line.edition_id, **shown_of(line.edition_id), quantity=str(line.quantity), held=str(line.held),
            spare=str(line.spare), other_decks=str(line.other_decks),
            counted_from=[CountedFromDeck(deck_id=other, quantity=str(count)) for other, count in line.from_decks],
            lent=str(line.lent),
            owned=str(capture.allocation.owned.get(line.edition_id, 0)), need=str(line.need),
            swap=swap_hint(offered.get((shown.id, line.edition_id)), capture.swaps))
            for line in needs[shown.id]]) for shown in capture.shown()]
    total = combined(capture, needs)
    rows = [CombinedRow(edition_id=edition, **shown_of(edition), need=str(need),
                        decks=[CombinedDeckNeed(deck_id=line.deck_id, need=str(line.need)) for line in lines])
            for edition, need, lines in total]
    return WantList(want_list_counting=capture.counting, settings_revision=capture.settings_revision,
                    owner_revision=capture.owner_revision, deck_lists_digest=capture.deck_lists_digest,
                    deck_id=capture.scope,
                    decks=[WantListDeck(id=shown.id, name=shown.name) for shown in capture.decks],
                    sections=sections, combined=rows, to_get=str(sum(need for _, need, _ in total)))
