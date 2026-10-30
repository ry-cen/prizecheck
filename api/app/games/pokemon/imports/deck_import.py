"""Decklist Import (spec "Import interfaces"; ticket #212): review a pasted list, then create a Deck with it.

``POST /api/decks/import/review`` reads a pasted decklist (``decklist_text``), matches its card lines
(``import_matching``) and says which Card Editions each line becomes (``import_allocation``): owned copies first, under
the owned-cards setting (``owned``: **Exact printings** or **Use cards I own**, ticket #214) and the Want List counting
setting, then new copies. A Not found line carries the prefill of its Missing cards report (``MissingCardPrefill``,
ticket #213). It is read-only and stateless: the review screen posts again, with the setting and the collector's fixes
so far, whenever either changes. It is a POST only because the text is long, and it needs no idempotency key.

Like adding a card by its Printing (``games.pokemon.decks.printing``), the review chooses new copies' Editions from stored quotes
only and is not a price access (ADR 0006): it admits no refresh, waits for no runner and writes nothing to the record
store. Its steps: one read-only snapshot of the catalog (the matches, every Printing the lines reach and their
Editions); one capture of the owned copies under the owner row lock (``import_owned.capture_owned``), which never
creates the caller's inventory owner; the stored quotes with no connection or lock held; then the answer. It writes
nothing to PostgreSQL. A catalog change between the snapshot and the capture can leave an Edition the review offers
unavailable; saving then answers 422 EDITION_UNAVAILABLE and the screen reviews again.

With a ``deck_id`` (Replace, ticket #215) the review is of that Deck's new Deck List: the capture checks the Deck is the
caller's (404 DECK_NOT_FOUND) and reads it under the same lock, its own copies come first, and ``replace`` carries the
Deck List revision, the changes batch saving sends and the Surplus preview (``import_replace``). Replace has no route of
its own: the web saves through the Deck List changes batch.

Copy to my Decks (#216) posts a Published Deck's token instead of text: its snapshot's rows are the card lines
(``import_publication``), read from the public projection before the catalog snapshot, and the answer carries the
Published Deck's title, Target Format and snapshot version.

``POST /api/decks/import`` creates the Deck, sets its Target Format and writes its Deck List lines in one transaction,
idempotently, like every Location and Deck List command. It trusts the Editions it is sent and never reads the text
again. Undo is the existing Deck deletion (``deck_deletion``): an imported Deck holds no cards.
"""
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from . import import_aliases
from ..prices import prices
from ..catalog import set_codes
from app.games.pokemon.imports import import_publication
from app.copy_allocation import Availability
from app.core.prices.cost import summarize
from .decklist_text import MAX_CARD_LINES, CardLine, TooLong, TooManyLines, read
from ..formats.deck_format_checks import TargetFormat
from app.core.decks.store import MAX_DECK_LIST_CHANGES, keep_response
from app.games.pokemon.decks.models import DeckListCommandResult
from app.games.pokemon.decks.commands import advance_deck_list, replayed
from ..formats.format_evaluator import FORMATS
from app.holdings import parse_quantity
from app.games.pokemon.imports.import_allocation import ChosenBy, OwnedCards, Part, Resolved, Source, merged, parts_for
from .import_matching import Match, match_lines
from app.games.pokemon.imports.import_owned import capture_owned, groups
from app.games.pokemon.imports.import_replace import ImportReplace, replacement
from app.location_tree import TreeNode, check_name, cleaned_name, error, node_model, owner_and_rows, replay
from app.db import connect
from app.identity import verified_user
from app.settings import WantListCounting

router = APIRouter(prefix='/api/decks', tags=['decks'])

LineStatus = Literal['matched', 'by_name', 'energy', 'picked', 'ambiguous', 'not_found', 'unreadable', 'dropped']
Section = Literal['pokemon', 'trainer', 'energy']
# The statuses Save waits for: the collector picks a card or drops the line.
NEEDS_YOU = ('ambiguous', 'not_found', 'unreadable')


class ImportSource(BaseModel):
    """Exactly one of ``text`` (a pasted list) and ``publication`` (a Published Deck's token: Copy to my Decks, #216);
    anything else answers 422 INVALID_SOURCE."""
    text: str | None = None
    publication: str | None = None
    # Copy only: the snapshot version the screen's first answer read. Another active version answers 409
    # PUBLISHED_DECK_CHANGED, so a fix never lands on another row.
    version: int | None = None


class ImportFix(BaseModel):
    """One collector choice for one card line: exactly one of ``drop``, ``printing_id`` and ``edition_id``."""
    line: int = Field(ge=1)
    drop: bool = False
    printing_id: UUID | None = None   # this card, at the rule's Edition
    edition_id: UUID | None = None    # this Card Edition (on a matched line, an Edition of its Printing)


class ReviewImport(BaseModel):
    source: ImportSource
    # The owned-cards setting: ``exact`` (Exact printings) uses owned copies of the named Printing only; ``owned`` (Use
    # cards I own, the web's default) also uses the other Printings the line reaches.
    owned: OwnedCards = 'owned'
    fixes: list[ImportFix] = Field(default_factory=list, max_length=MAX_CARD_LINES)
    # Replace (#215): the caller's Deck whose Deck List the paste replaces (404 DECK_NOT_FOUND otherwise). Its own
    # copies are used first, and the answer carries ``replace``. None reviews a new Deck.
    deck_id: UUID | None = None


class ImportPrinting(BaseModel):
    printing_id: UUID
    name: str
    set_id: str
    set_code: str              # the printed code ("PAL"), or the TCGdex set ID when it has none (set_codes)
    set_name: str
    collector_number: str
    image_url: str | None      # the small artwork (art-route URL), or None
    card_kind: Literal['pokemon', 'trainer', 'energy'] | None


class ImportEdition(BaseModel):
    """One active Edition of the line's Printing, in catalog order, for the Edition chooser."""
    edition_id: UUID
    descriptor: dict
    display_price: str | None  # the stored quote, rounded ("$0.25", "<$0.01"); None when unpriced


class ImportPlace(BaseModel):
    """Where owned copies are: a Location, or a Deck (its copies beyond its own list, or under One Deck at a time the
    copies it holds for its own list)."""
    location_id: UUID
    name: str
    deck: bool
    quantity: str


class ImportPart(BaseModel):
    """Copies of one Card Edition that one pasted line becomes."""
    edition_id: UUID
    quantity: str
    source: Source               # in_deck: this Deck's copies (Replace); elsewhere: owned copies elsewhere; new: to get
    chosen_by: ChosenBy | None   # how a new copy's Edition was chosen; None for owned copies
    # The part's own card and Edition: under Use cards I own an owned copy can be another Printing than the line's.
    printing_id: UUID
    name: str
    set_code: str
    collector_number: str
    descriptor: dict
    places: list[ImportPlace]    # elsewhere: where the copies are, in the order they are used; empty otherwise


class ImportKept(BaseModel):
    """Copies of the line's card another Deck keeps, so the import leaves them alone (Every Deck built at once)."""
    deck_id: UUID
    name: str                    # the Deck's name
    quantity: str
    # own_line: the Deck holds them for its own list. counted: Spare Copies that older Deck counts for its list.
    reason: Literal['own_line', 'counted']


class MissingCardPrefill(BaseModel):
    """What a Not found line's Missing cards link fills in on the existing report form (``missing_cards.ReportInput``):
    a Missing Printing with the pasted English name and number. The pasted code goes into ``set_id`` only when a code
    table maps it (``set_codes.tsv``, or ``import_aliases.tsv`` and its rules): that TCGdex set ID, with the number
    those rules give (``PR-SW 281`` is ``swshp`` ``SWSH281``). Otherwise the code goes into ``set_name`` and the note,
    never into ``set_id``: a manual Printing keyed by an unmapped code is one no code table can reach. Each value is cut
    to the report form's limit."""
    kind: Literal['printing']
    english_name: str
    collector_number: str | None
    set_id: str | None
    set_name: str | None
    note: str


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
    # ambiguous: the cards to pick from (one per code and number, or one per Reprint Group for a name). energy: every
    # Basic Energy Printing of the line's type, newest first, for Change.
    candidates: list[ImportPrinting]
    editions: list[ImportEdition]            # the printing's active Editions; empty without a printing
    parts: list[ImportPart]                  # what the line becomes; empty unless resolved
    # Copies of the card (under the setting: its Printing, or every Printing the line reaches) that other Decks keep,
    # oldest Deck first; only on a line that still gets new copies, and only under Every Deck built at once.
    kept: list[ImportKept]
    report: MissingCardPrefill | None        # not_found: the Missing cards report form's prefill; None otherwise


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
    owned: str         # copies the resolved lines use from the collector's own cards
    to_get: str        # new copies on the resolved lines
    # Stored quotes only (ADR 0006). Copies of ``to_get`` with a stored quote; None when a stored row couldn't be
    # checked, so the cost is incomplete. An unpriced copy is never counted as $0.
    to_get_priced: str | None
    to_get_amount: str | None    # the exact sum over the priced copies; None when none is priced
    to_get_display: str | None   # its one rounded form ("$12.34", "<$0.01"); None when none is priced


class ImportPublication(BaseModel):
    """The Published Deck a Copy review read (#216): the new Deck's default name and Target Format, and the snapshot
    version the screen pins."""
    token: str
    version: int
    title: str
    target_format: TargetFormat


class ImportReview(BaseModel):
    lines: list[ReviewLine]
    ignored: list[IgnoredImportLine]
    deck_list: list[ImportDeckListEntry]   # what saving would write: resolved lines merged by Edition
    totals: ImportTotals
    owned: OwnedCards                      # the owned-cards setting used
    want_list_counting: WantListCounting   # the counting setting the owned copies follow
    settings_revision: int
    owner_revision: int
    catalog_revision: int
    # Replace (#215): the Deck List revision, the batch saving sends and the Surplus preview; None for a new Deck.
    replace: ImportReplace | None = None
    publication: ImportPublication | None = None   # Copy to my Decks only (#216)


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
        art.small_art_url AS image_url,ca.card_kind
      FROM catalog_generation_printing gp LEFT JOIN catalog_card_attribute ca ON ca.printing_id=gp.printing_id
      LEFT JOIN catalog_printing_art art ON art.printing_id=gp.printing_id
      WHERE gp.generation_id=%s AND gp.printing_id=ANY(%s) AND NOT gp.tombstoned""",
                        (generation, list(printing_ids))).fetchall()
    return {row['printing_id']: ImportPrinting(
        printing_id=row['printing_id'], name=row['name'], set_id=row['set_id'], set_code=set_codes.code_for(row['set_id']),
        set_name=row['set_name'], collector_number=row['collector_number'],
        image_url=row['image_url'], card_kind=row['card_kind'])
        for row in rows}


def _editions(conn, generation, printing_ids) -> dict[UUID, list[dict]]:
    """Each Printing's active Editions in catalog order (descriptor_key, id: the order catalog search shows). A
    Printing with none is missing: it can't be on a Deck List (``decks.printing.AVAILABLE_EDITIONS``)."""
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


def _own(match: Match) -> set[UUID]:
    """The Printings a resolved line keeps its status on: its own, and for Basic Energy matched by type every Basic
    Energy Printing of that type (Change)."""
    if match.printing_id is None:
        return set()
    return {match.printing_id, *match.candidates} if match.status == 'energy' else {match.printing_id}


def _resolve(card: CardLine, match: Match, fix: ImportFix | None,
             edition_printing: dict[UUID, UUID]) -> tuple[LineStatus, UUID | None, UUID | None]:
    """(status, Printing, the collector's Edition) for one card line after its fix. A resolved line (matched, by
    name, or Basic Energy by type) keeps its status when the fix names one of its own Printings (``_own``); any other
    card makes it picked."""
    if fix is not None and fix.drop:
        return 'dropped', None, None
    if fix is not None and fix.printing_id is not None:
        return (match.status if fix.printing_id in _own(match) else 'picked'), fix.printing_id, None
    if fix is not None and fix.edition_id is not None:
        printing = edition_printing[fix.edition_id]
        if match.printing_id is not None and printing not in _own(match):
            # The Edition chooser lists the line's own Printings' Editions; another card is picked by printing_id.
            error(422, 'INVALID_FIX')
        return ('picked' if match.printing_id is None else match.status), printing, fix.edition_id
    return match.status, match.printing_id, None


def _report(card: CardLine) -> MissingCardPrefill:
    """The Missing cards prefill for a Not found line (``MissingCardPrefill``)."""
    mapped = import_aliases.report_set(card.set_code, card.number) if card.set_code else None
    note = f'Pasted decklist line: "{card.text}".'
    if mapped is None and card.set_code and card.set_code != 'Energy':
        note += f" PrizeCheck's code tables don't map the set code {card.set_code}."
    return MissingCardPrefill(
        kind='printing', english_name=card.name[:160],
        collector_number=(mapped[1] if mapped else card.number or '')[:80] or None,
        set_id=mapped[0][:80] if mapped else None,
        set_name=None if mapped else (card.set_code or '')[:160] or None,
        note=note[:2000])


@router.post('/import/review', response_model=ImportReview)
def review_import(command: ReviewImport, user_id: str = Depends(verified_user)):
    # A synchronous route on purpose: the HTTP record-store adapter refuses to run on an event loop.
    source = command.source
    # Exactly one source; a version only pins a publication.
    if ((source.text is None) == (source.publication is None)
            or (source.version is not None and source.publication is None)
            or (source.publication is not None and command.deck_id is not None)):
        error(422, 'INVALID_SOURCE')
    copied = None
    if source.publication is not None:
        # Copy to my Decks (#216): the snapshot's rows, read before any connection opens.
        copied = import_publication.read(source.publication, source.version)
        cards, ignored = copied.cards, []
    else:
        try:
            reading = read(source.text)
        except TooLong:
            error(422, 'IMPORT_TOO_LONG')
        except TooManyLines:
            error(422, 'IMPORT_TOO_MANY_LINES')
        cards, ignored = list(reading.cards), list(reading.ignored)
    fixes = _fixes(command, cards)
    # 1. One read-only snapshot: the matches, the fixes' cards and every resolved Printing's Editions.
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        state = conn.execute('SELECT active_generation,revision FROM catalog_state WHERE singleton').fetchone()
        generation = state['active_generation']
        if copied is None:
            matches, published = match_lines(conn, generation, cards), {}
        else:
            matches, published = import_publication.resolve(conn, generation, copied)
        edition_printing = _edition_printings(conn, generation, [fix.edition_id for fix in fixes.values()
                                                                  if fix.edition_id is not None])
        if any(fix.edition_id is not None and fix.edition_id not in edition_printing for fix in fixes.values()):
            error(422, 'EDITION_UNAVAILABLE')
        resolved = {card.line: _resolve(card, matches[card.line], fixes.get(card.line), edition_printing)
                    for card in cards}
        # Dropped lines and lines that need the collector have no Printing (``_resolve``).
        chosen = {printing for _, printing, _ in resolved.values() if printing is not None}
        candidates = {candidate for match in matches.values() for candidate in match.candidates}
        # Use cards I own reaches the other Printings of each resolved card (import_owned.groups).
        others = groups(conn, generation, chosen) if command.owned == 'owned' and generation is not None else {}
        reached = {printing for found in others.values() for printing in found}
        editions = _editions(conn, generation, chosen | reached) if generation is not None else {}
        if any(fix.printing_id is not None and fix.printing_id not in editions for fix in fixes.values()):
            error(422, 'PRINTING_UNAVAILABLE')
        printings = _printings(conn, generation, chosen | candidates | reached) if generation is not None else {}
    # 2. The owned copies of every Edition the lines reach, under the owner row lock.
    capture = capture_owned(user_id, [edition['edition_id'] for found in editions.values() for edition in found],
                            command.deck_id)
    # 3. Stored quotes only, with no connection or lock held. None means the cache could not be read in time.
    wanted = [edition['edition_id'] for printing in chosen for edition in editions[printing]]
    views = prices.stored_edition_quotes(wanted) if wanted else {}
    if views is None:
        error(503, 'PRICES_UNAVAILABLE')
    # 4. The answer.
    catalog_order = {printing: [edition['edition_id'] for edition in found] for printing, found in editions.items()}
    parts = parts_for([_resolved(card, resolved[card.line], published.get(card.line), command.owned)
                       for card in cards if resolved[card.line][1] is not None],
                      catalog_order, views, command.owned, others, capture.availability.editions)
    edition_of = {edition['edition_id']: (printing, edition['descriptor'])
                  for printing, found in editions.items() for edition in found}
    lines = []
    for card in cards:
        status, printing, _ = resolved[card.line]
        lines.append(ReviewLine(
            line=card.line, text=card.text, section=card.section, quantity=str(card.quantity), name=card.name,
            set_code=card.set_code, number=card.number, ph=card.ph, status=status,
            printing=printings[printing] if printing is not None else None,
            candidates=[printings[candidate] for candidate in matches[card.line].candidates]
            if status in ('ambiguous', 'energy') else [],
            editions=[ImportEdition(edition_id=edition['edition_id'], descriptor=edition['descriptor'],
                                    display_price=_display_price(views.get(edition['edition_id'])))
                      for edition in editions[printing]] if printing is not None else [],
            parts=[_part(part, *edition_of[part.edition_id], printings, capture.availability)
                   for part in parts.get(card.line, [])],
            kept=_kept(parts.get(card.line, []), [catalog_order[each] for each in (printing, *others.get(printing, ()))]
                       if printing is not None else [], capture.availability),
            report=(_report(card) if copied is None else MissingCardPrefill(**copied.report(card.line)))
            if status == 'not_found' else None))
    every_part = [part for card in cards for part in parts.get(card.line, [])]
    deck_list = merged(every_part)
    to_get: dict[UUID, int] = {}
    for part in every_part:
        if part.source == 'new':
            to_get[part.edition_id] = to_get.get(part.edition_id, 0) + part.quantity
    cost = summarize(to_get, {edition: views[edition] for edition in to_get})
    priced = cost.get('priced_copies')   # None when a stored row couldn't be checked
    return ImportReview(
        lines=lines, ignored=[IgnoredImportLine(line=line.line, text=line.text) for line in ignored],
        deck_list=[ImportDeckListEntry(edition_id=edition, quantity=str(quantity)) for edition, quantity in deck_list],
        totals=ImportTotals(card_lines=len(cards),
                            cards=str(sum(card.quantity for card in cards if resolved[card.line][0] != 'dropped')),
                            ignored=len(ignored),
                            to_resolve=sum(1 for card in cards if resolved[card.line][0] in NEEDS_YOU),
                            owned=str(sum(part.quantity for part in every_part if part.source != 'new')),
                            to_get=str(sum(to_get.values())), to_get_priced=priced,
                            to_get_amount=cost.get('amount') if priced not in (None, '0') else None,
                            to_get_display=cost.get('display_amount') if priced not in (None, '0') else None),
        owned=command.owned, want_list_counting=capture.counting, settings_revision=capture.settings_revision,
        owner_revision=capture.owner_revision, catalog_revision=state['revision'],
        replace=replacement(capture.replaced, deck_list) if capture.replaced is not None else None,
        publication=ImportPublication(token=copied.token, version=copied.version, title=copied.title,
                                      target_format=copied.target_format) if copied is not None else None)


def _resolved(card: CardLine, resolution: tuple[LineStatus, UUID | None, UUID | None],
              published: tuple[UUID, UUID] | None, owned: OwnedCards) -> Resolved:
    """One resolved line for the allocation. Copy to my Decks under Exact printings (#216): copies the collector doesn't
    own keep the Edition the Published Deck's row named (``published``: that Edition and its Printing), unless the
    collector chose an Edition or another card."""
    _, printing, edition = resolution
    if edition is None and owned == 'exact' and published is not None and published[1] == printing:
        return Resolved(card.line, card.quantity, printing, published[0], 'published')
    return Resolved(card.line, card.quantity, printing, edition)


def _display_price(view) -> str | None:
    return view.display_amount if view is not None and view.status == 'quote' else None


def _part(part: Part, printing: UUID, descriptor: dict, printings: dict[UUID, ImportPrinting],
          availability: Availability) -> ImportPart:
    card = printings[printing]
    return ImportPart(edition_id=part.edition_id, quantity=str(part.quantity), source=part.source,
                      chosen_by=part.chosen_by, printing_id=printing, name=card.name, set_code=card.set_code,
                      collector_number=card.collector_number, descriptor=descriptor,
                      places=[ImportPlace(location_id=location, name=availability.places[location].name,
                                          deck=availability.places[location].deck, quantity=str(copies))
                              for location, copies in part.places])


def _kept(parts: list[Part], reached: list[list[UUID]], availability: Availability) -> list[ImportKept]:
    """Copies of the Editions a line could use (``reached``: its Printing's, and under Use cards I own the other
    Printings') that other Decks keep, by Deck and reason, oldest Deck first. Only a line that still gets new copies
    says so: a line its owned copies cover needs nothing from anywhere."""
    if not any(part.source == 'new' for part in parts):
        return []
    totals: dict[tuple[UUID, bool], int] = {}
    for edition in (edition for found in reached for edition in found):
        available = availability.editions.get(edition)
        for kept in available.kept if available else ():
            totals[(kept.deck_id, kept.counted)] = totals.get((kept.deck_id, kept.counted), 0) + kept.copies
    rank = {deck: index for index, deck in enumerate(availability.order)}
    return [ImportKept(deck_id=deck, name=availability.places[deck].name, quantity=str(copies),
                       reason='counted' if counted else 'own_line')
            for (deck, counted), copies in sorted(totals.items(), key=lambda item: (rank[item[0][0]], item[0][1]))]


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
