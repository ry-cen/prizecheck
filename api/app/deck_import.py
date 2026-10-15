"""Decklist Import (spec "Import interfaces"; ticket #212): review a pasted list, then create a Deck with it.

``POST /api/decks/import/review`` reads a pasted decklist (``decklist_text``), matches its card lines
(``import_matching``) and says which Card Edition each line becomes (``import_allocation``). It is read-only and
stateless: the review screen posts again, with the collector's fixes so far, whenever a fix changes. It is a POST only
because the text is long, and it needs no idempotency key.

Like adding a card by its Printing (``deck_list_printing``), the review chooses new copies' Editions from stored quotes
only and is not a price access (ADR 0006): it admits no refresh, waits for no runner and writes nothing to the record
store. Its steps are add-by-Printing's: one read-only snapshot of the catalog, then the stored quotes with no connection
or lock held, then the answer. It writes nothing to PostgreSQL either: it never creates the caller's inventory owner,
and it reads the owner revision as the catalog browse does. Ticket #214 adds the owned-copies capture under the owner
row lock.

``POST /api/decks/import`` creates the Deck, sets its Target Format and writes its Deck List lines in one transaction,
idempotently, like every Location and Deck List command. It trusts the Editions it is sent and never reads the text
again. Undo is the existing Deck deletion (``deck_deletion``): an imported Deck holds no cards.
"""
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from . import prices, set_codes
from .decklist_text import MAX_CARD_LINES, CardLine, TooLong, TooManyLines, read
from .decks import MAX_DECK_LIST_CHANGES, DeckListCommandResult, advance_deck_list, keep_response, replayed
from .format_evaluator import FORMATS
from .holdings import parse_quantity
from .import_allocation import ChosenBy, Part, Resolved, Source, merged, parts_for
from .import_matching import Match, match_lines
from .location_tree import TreeNode, check_name, cleaned_name, error, node_model, owner_and_rows, replay
from .main import connect, verified_user

router = APIRouter(prefix='/api/decks', tags=['decks'])

LineStatus = Literal['matched', 'by_name', 'energy', 'picked', 'ambiguous', 'not_found', 'unreadable', 'dropped']
Section = Literal['pokemon', 'trainer', 'energy']
# The statuses Save waits for: the collector picks a card or drops the line.
NEEDS_YOU = ('ambiguous', 'not_found', 'unreadable')


class ImportSource(BaseModel):
    # The pasted text. Ticket #216 adds a publication token as the other source.
    text: str


class ImportFix(BaseModel):
    """One collector choice for one card line: exactly one of ``drop``, ``printing_id`` and ``edition_id``."""
    line: int = Field(ge=1)
    drop: bool = False
    printing_id: UUID | None = None   # this card, at the rule's Edition
    edition_id: UUID | None = None    # this Card Edition (on a matched line, an Edition of its Printing)


class ReviewImport(BaseModel):
    source: ImportSource
    fixes: list[ImportFix] = Field(default_factory=list, max_length=MAX_CARD_LINES)


class ImportPrinting(BaseModel):
    printing_id: UUID
    name: str
    set_id: str
    set_code: str              # the printed code ("PAL"), or the TCGdex set ID when it has none (set_codes)
    set_name: str
    collector_number: str
    image_url: str | None      # the small artwork (low.webp), or None
    card_kind: Literal['pokemon', 'trainer', 'energy'] | None


class ImportEdition(BaseModel):
    """One active Edition of the line's Printing, in catalog order, for the Edition chooser."""
    edition_id: UUID
    descriptor: dict
    display_price: str | None  # the stored quote, rounded ("$0.25", "<$0.01"); None when unpriced
    stale: bool | None = None  # the quote is more than 48 hours old (ADR 0006); None when unpriced


class ImportPart(BaseModel):
    """Copies of one Card Edition that one pasted line becomes."""
    edition_id: UUID
    quantity: str
    source: Source               # always 'new' in ticket #212; #214 adds owned copies
    chosen_by: ChosenBy | None   # how a new copy's Edition was chosen


class ReviewLine(BaseModel):
    line: int                  # the line number in the pasted text, from 1; fixes name it
    text: str                  # the line as pasted (PH, bullets and doubled spaces kept)
    section: Section | None    # the section header above it; None before any header
    quantity: str
    name: str                  # the pasted name
    set_code: str | None       # the pasted set token; '' for TCG Online's empty-set Energy line; None when unreadable
    number: str | None         # the pasted number; None when unreadable
    ph: bool
    status: LineStatus
    printing: ImportPrinting | None          # the card the line resolved to; None when it needs the collector or is dropped
    candidates: list[ImportPrinting]         # ambiguous: the cards to pick from
    editions: list[ImportEdition]            # the printing's active Editions; empty without a printing
    parts: list[ImportPart]                  # what the line becomes; empty unless resolved


class IgnoredImportLine(BaseModel):
    line: int
    text: str


class ImportDeckListEntry(BaseModel):
    edition_id: UUID
    quantity: str


class ImportTotals(BaseModel):
    card_lines: int    # card lines, Can't read lines included
    cards: str         # copies on every line not dropped, resolved or not; never a header's number
    ignored: int       # ignored lines
    to_resolve: int    # lines that need the collector (Pick one, Not found, Can't read)


class ImportReview(BaseModel):
    lines: list[ReviewLine]
    ignored: list[IgnoredImportLine]
    deck_list: list[ImportDeckListEntry]   # what saving would write: resolved lines merged by Edition
    totals: ImportTotals
    owner_revision: int
    catalog_revision: int


class ImportDeckLine(BaseModel):
    edition_id: UUID
    quantity: str


class ImportDeck(BaseModel):
    name: str
    # Checked by the route, so an unknown name answers UNKNOWN_FORMAT like the Target Format command.
    target_format: str
    lines: list[ImportDeckLine] = Field(max_length=MAX_DECK_LIST_CHANGES)
    idempotency_key: UUID


class ImportDeckResult(DeckListCommandResult):
    """The new Deck's Location node and inventory revision (as Create Deck answers) with the Deck List command result."""
    location: TreeNode
    owner_revision: int


# --- the review --------------------------------------------------------------------------------------------------

def _fixes(command: ReviewImport, cards: list[CardLine]) -> dict[int, ImportFix]:
    """The fixes by line number. A fix must name a card line, once, with exactly one choice (422 INVALID_FIX)."""
    lines = {card.line for card in cards}
    found: dict[int, ImportFix] = {}
    for fix in command.fixes:
        choices = [fix.drop, fix.printing_id is not None, fix.edition_id is not None].count(True)
        if fix.line not in lines or fix.line in found or choices != 1:
            error(422, 'INVALID_FIX')
        found[fix.line] = fix
    return found


def _printings(conn, generation, printing_ids) -> dict[UUID, ImportPrinting]:
    if not printing_ids:
        return {}
    rows = conn.execute("""SELECT gp.printing_id,gp.display_name AS name,gp.set_id,gp.set_name,gp.collector_number,
        gp.image_url,ca.card_kind
      FROM catalog_generation_printing gp LEFT JOIN catalog_card_attribute ca ON ca.printing_id=gp.printing_id
      WHERE gp.generation_id=%s AND gp.printing_id=ANY(%s) AND NOT gp.tombstoned""",
                        (generation, list(printing_ids))).fetchall()
    return {row['printing_id']: ImportPrinting(
        printing_id=row['printing_id'], name=row['name'], set_id=row['set_id'], set_code=set_codes.code_for(row['set_id']),
        set_name=row['set_name'], collector_number=row['collector_number'],
        image_url=f"{row['image_url']}/low.webp" if row['image_url'] else None, card_kind=row['card_kind'])
        for row in rows}


def _editions(conn, generation, printing_ids) -> dict[UUID, list[dict]]:
    """Each Printing's active Editions in catalog order (descriptor_key, id: the order catalog search shows). A
    Printing with none is missing: it can't be on a Deck List (``deck_list_printing.AVAILABLE_EDITIONS``)."""
    if not printing_ids:
        return {}
    found: dict[UUID, list[dict]] = {}
    for row in conn.execute("""SELECT ge.printing_id,ge.edition_id,e.descriptor FROM catalog_generation_edition ge
        JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
        JOIN catalog_edition e ON e.id=ge.edition_id
        WHERE ge.generation_id=%s AND ge.printing_id=ANY(%s) AND ge.active AND NOT gp.tombstoned
        ORDER BY ge.printing_id,e.descriptor_key,e.id""", (generation, list(printing_ids))).fetchall():
        found.setdefault(row['printing_id'], []).append({'edition_id': row['edition_id'], 'descriptor': row['descriptor']})
    return found


def _edition_printings(conn, generation, edition_ids) -> dict[UUID, UUID]:
    """The Printing of each active Edition of a Printing that isn't withdrawn."""
    if not edition_ids or generation is None:
        return {}
    return {row['edition_id']: row['printing_id'] for row in conn.execute(
        """SELECT ge.edition_id,ge.printing_id FROM catalog_generation_edition ge
          JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
          WHERE ge.generation_id=%s AND ge.edition_id=ANY(%s) AND ge.active AND NOT gp.tombstoned""",
        (generation, list(edition_ids))).fetchall()}


def _resolve(card: CardLine, match: Match, fix: ImportFix | None,
             edition_printing: dict[UUID, UUID]) -> tuple[LineStatus, UUID | None, UUID | None]:
    """(status, Printing, the collector's Edition) for one card line after its fix."""
    if fix is not None and fix.drop:
        return 'dropped', None, None
    if fix is not None and fix.printing_id is not None:
        same = match.status == 'matched' and match.printing_id == fix.printing_id
        return ('matched' if same else 'picked'), fix.printing_id, None
    if fix is not None and fix.edition_id is not None:
        printing = edition_printing[fix.edition_id]
        if match.printing_id is not None and printing != match.printing_id:
            # The Edition chooser lists the line's own Printing's Editions; another card is picked by printing_id.
            error(422, 'INVALID_FIX')
        return ('picked' if match.printing_id is None else match.status), printing, fix.edition_id
    return match.status, match.printing_id, None


@router.post('/import/review', response_model=ImportReview)
def review_import(command: ReviewImport, user_id: str = Depends(verified_user)):
    # A synchronous route on purpose: the HTTP record-store adapter refuses to run on an event loop.
    try:
        reading = read(command.source.text)
    except TooLong:
        error(422, 'IMPORT_TOO_LONG')
    except TooManyLines:
        error(422, 'IMPORT_TOO_MANY_LINES')
    cards = list(reading.cards)
    fixes = _fixes(command, cards)
    # 1. One read-only snapshot: the matches, the fixes' cards and every resolved Printing's Editions.
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        state = conn.execute('SELECT active_generation,revision FROM catalog_state WHERE singleton').fetchone()
        owner = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s', (user_id,)).fetchone()
        generation = state['active_generation']
        matches = match_lines(conn, generation, cards)
        edition_printing = _edition_printings(conn, generation, [fix.edition_id for fix in fixes.values()
                                                                  if fix.edition_id is not None])
        if any(fix.edition_id is not None and fix.edition_id not in edition_printing for fix in fixes.values()):
            error(422, 'EDITION_UNAVAILABLE')
        resolved = {card.line: _resolve(card, matches[card.line], fixes.get(card.line), edition_printing)
                    for card in cards}
        # Dropped lines and lines that need the collector have no Printing (``_resolve``).
        chosen = {printing for _, printing, _ in resolved.values() if printing is not None}
        candidates = {candidate for match in matches.values() for candidate in match.candidates}
        editions = _editions(conn, generation, chosen) if generation is not None else {}
        if any(fix.printing_id is not None and fix.printing_id not in editions for fix in fixes.values()):
            error(422, 'PRINTING_UNAVAILABLE')
        printings = _printings(conn, generation, chosen | candidates) if generation is not None else {}
    # 2. Stored quotes only, with no connection or lock held. None means the cache could not be read in time.
    wanted = [edition['edition_id'] for printing in chosen for edition in editions[printing]]
    views = prices.stored_edition_quotes(wanted) if wanted else {}
    if views is None:
        error(503, 'PRICES_UNAVAILABLE')
    # 3. The answer.
    parts = parts_for([Resolved(card.line, card.quantity, resolved[card.line][1], resolved[card.line][2])
                       for card in cards if resolved[card.line][1] is not None],
                      {printing: [edition['edition_id'] for edition in found] for printing, found in editions.items()},
                      views)
    lines = []
    for card in cards:
        status, printing, _ = resolved[card.line]
        lines.append(ReviewLine(
            line=card.line, text=card.text, section=card.section, quantity=str(card.quantity), name=card.name,
            set_code=card.set_code, number=card.number, ph=card.ph, status=status,
            printing=printings[printing] if printing is not None else None,
            candidates=[printings[candidate] for candidate in matches[card.line].candidates] if status == 'ambiguous'
            else [],
            editions=[ImportEdition(edition_id=edition['edition_id'], descriptor=edition['descriptor'],
                                    display_price=_display_price(views.get(edition['edition_id'])),
                                    stale=_stale(views.get(edition['edition_id'])))
                      for edition in editions[printing]] if printing is not None else [],
            parts=[_part(part) for part in parts.get(card.line, [])]))
    deck_list = merged([part for card in cards for part in parts.get(card.line, [])])
    return ImportReview(
        lines=lines, ignored=[IgnoredImportLine(line=line.line, text=line.text) for line in reading.ignored],
        deck_list=[ImportDeckListEntry(edition_id=edition, quantity=str(quantity)) for edition, quantity in deck_list],
        totals=ImportTotals(card_lines=len(cards),
                            cards=str(sum(card.quantity for card in cards if resolved[card.line][0] != 'dropped')),
                            ignored=len(reading.ignored),
                            to_resolve=sum(1 for card in cards if resolved[card.line][0] in NEEDS_YOU)),
        owner_revision=owner['revision'] if owner else 1, catalog_revision=state['revision'])


def _display_price(view) -> str | None:
    return view.display_amount if view is not None and view.status == 'quote' else None


def _stale(view) -> bool | None:
    return bool(view.stale) if view is not None and view.status == 'quote' else None


def _part(part: Part) -> ImportPart:
    return ImportPart(edition_id=part.edition_id, quantity=str(part.quantity), source=part.source,
                      chosen_by=part.chosen_by)


# --- creating the Deck -------------------------------------------------------------------------------------------

@router.post('/import', response_model=ImportDeckResult, status_code=201)
def import_deck(command: ImportDeck, user_id: str = Depends(verified_user)):
    """Create a Deck with its Target Format and Deck List lines in one transaction (no moment exists in which the Deck
    is empty). The name is checked as Create Deck checks it; every Edition must be active, of a Printing that isn't
    withdrawn (422 EDITION_UNAVAILABLE), and appear once (422 DUPLICATE_EDITION). An empty list creates an empty Deck.
    The response is Create Deck's (the Location node and the inventory revision, which advances once) together with
    the Deck List command result (the Deck List, its Target Format and that Format's result), stored once for replay."""
    name = cleaned_name(command.name)
    if command.target_format not in FORMATS:
        error(422, 'UNKNOWN_FORMAT')
    totals: dict[UUID, int] = {}
    for line in command.lines:
        if line.edition_id in totals:
            error(422, 'DUPLICATE_EDITION')
        totals[line.edition_id] = parse_quantity(line.quantity)
    # The order of the lines doesn't matter, so the stored request is sorted: the same list in another order replays.
    payload = {'action': 'import_deck', 'name': name, 'target_format': command.target_format,
               'lines': sorted([str(edition), str(quantity)] for edition, quantity in totals.items())}
    with connect() as conn, conn.transaction():
        _, rows = owner_and_rows(conn, user_id)
        # Replay comes before the name check: after the first success the name is taken by this very Deck.
        digest, previous = replay(conn, user_id, command.idempotency_key, payload)
        if previous:
            return replayed(conn, previous)
        check_name(name, None, rows)
        if totals:
            state = conn.execute('SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE').fetchone()
            available = conn.execute("""SELECT count(*) AS n FROM catalog_generation_edition ge
              JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
              WHERE ge.generation_id=%s AND ge.edition_id=ANY(%s) AND ge.active AND NOT gp.tombstoned""",
                                     (state['active_generation'], list(totals))).fetchone()['n']
            if available != len(totals):
                error(422, 'EDITION_UNAVAILABLE')
        # Migration 029's trigger gives the new Deck its Deck List (revision 1, Standard).
        row = conn.execute("""INSERT INTO location(id,owner_id,name,kind)
          VALUES (%s,%s,%s,'deck') RETURNING id,name,kind,parent_id,version""", (uuid4(), user_id, name)).fetchone()
        rows[row['id']] = row
        conn.execute('UPDATE deck_list SET target_format=%s WHERE owner_id=%s AND deck_id=%s',
                     (command.target_format, user_id, row['id']))
        if totals:
            conn.execute("""INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity)
              SELECT %s,%s,edition_id,quantity FROM unnest(%s::uuid[],%s::bigint[]) AS line(edition_id,quantity)""",
                         (user_id, row['id'], list(totals), list(totals.values())))
        revision = conn.execute('UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s RETURNING revision',
                                (user_id,)).fetchone()['revision']
        return keep_response(conn, user_id, command.idempotency_key, digest, ImportDeckResult(
            **advance_deck_list(conn, user_id, row['id']), location=node_model(row, rows), owner_revision=revision))
