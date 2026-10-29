"""Copy to my Decks (decklist import #216; spec "Copy to my Decks"): a Published Deck's snapshot as the import review's
card lines.

``POST /api/decks/import/review`` takes a publication token as its source instead of pasted text
(``deck_import.review_import``). Two steps:

- ``read``, before any PostgreSQL connection opens: the token's active snapshot from the public projection, read as the
  public read reads it (``public_deck.read_current``, bounded by the export deadline). A malformed, unknown or revoked
  token answers 404 PUBLISHED_DECK_NOT_FOUND and an unreadable projection 503 PUBLIC_PROJECTION_UNAVAILABLE. The review
  screen pins the version its first answer read, so a fix always names the row it was made on: another active version
  answers 409 PUBLISHED_DECK_CHANGED. Each row (``identities[].editions[]``, in snapshot order) becomes one card line,
  numbered from 1: its quantity, its own Card Printing name (a snapshot published before Deck Lists 09 has only its
  group's Card Identity name), the printed set code (``set_codes.code_for``), the number and the snapshot's card kind
  as the section. More than 200 rows answers 422 IMPORT_TOO_MANY_LINES, as a paste does.
- ``resolve``, inside the review's read-only catalog snapshot. A row's public Edition reference (``catalog_edition.
  public_ref``) that names an active Edition of a Printing that isn't withdrawn resolves to that Edition's Printing
  (Matched), and the review remembers the Edition: under Exact printings the copies the collector doesn't own keep it.
  Otherwise its public Printing reference that names an active Printing (not withdrawn, with an active Edition)
  resolves to it (Matched), and the allocation chooses the Edition. Otherwise the line is Not found. An Edition's
  Printing never changes (migration 021), so the two references can't disagree.

The answers are ``Match`` values, so the review's fixes, allocation, notes and totals treat a copied line as a pasted
one. Nothing here writes, reads prices or touches the owner's inventory.
"""
from dataclasses import dataclass
from uuid import UUID

from . import public_deck

from app.games.pokemon.catalog import set_codes
from app.games.pokemon.imports.decklist_text import MAX_CARD_LINES, CardLine
from .import_match_core import ACTIVE, Match
from .location_tree import error
from .public_projection import ProjectionUnavailable
from .publications import TOKEN

SECTIONS = ('pokemon', 'trainer', 'energy')


@dataclass(frozen=True)
class CopiedRow:
    card: CardLine
    edition_ref: str | None
    printing_ref: str | None
    set_id: str      # the row's TCGdex set ID; '' when the snapshot has none
    set_name: str


@dataclass(frozen=True)
class Publication:
    token: str
    version: int
    title: str
    target_format: str
    rows: tuple[CopiedRow, ...]

    @property
    def cards(self) -> list[CardLine]:
        return [row.card for row in self.rows]

    def report(self, line: int) -> dict:
        """A Not found line's Missing cards prefill (``deck_import.MissingCardPrefill``'s fields): the row's name and
        number, and its TCGdex set ID and name, which the snapshot already holds. Each value is cut to the report form's
        limit."""
        row = self.rows[line - 1]
        return {'kind': 'printing', 'english_name': row.card.name[:160],
                'collector_number': (row.card.number or '')[:80] or None, 'set_id': row.set_id[:80] or None,
                'set_name': row.set_name[:160] or None,
                'note': f'Published Deck "{self.title}", row "{row.card.text}".'[:2000]}


def read(token: str, version: int | None) -> Publication:
    """The token's active snapshot as card lines (see the module docstring for the answers it refuses with)."""
    if not TOKEN.fullmatch(token):
        error(404, 'PUBLISHED_DECK_NOT_FOUND')
    try:
        active = public_deck.read_current(token, deadline=public_deck.export_deadline())
    except public_deck.SnapshotGone:
        error(404, 'PUBLISHED_DECK_NOT_FOUND')
    except (public_deck.SnapshotLate, ProjectionUnavailable):
        error(503, 'PUBLIC_PROJECTION_UNAVAILABLE')
    if version is not None and active.version != version:
        error(409, 'PUBLISHED_DECK_CHANGED')
    snapshot = active.snapshot
    editions = [(identity, edition) for identity in snapshot.identities for edition in identity.editions]
    if len(editions) > MAX_CARD_LINES:
        error(422, 'IMPORT_TOO_MANY_LINES')
    rows = []
    for number, (identity, edition) in enumerate(editions, start=1):
        name = edition.printing_name or identity.name
        code = set_codes.code_for(edition.set_id) if edition.set_id else ''
        quantity = int(edition.quantity)
        text = ' '.join(word for word in (str(quantity), name, code, edition.collector_number) if word)
        card = CardLine(line=number, text=text,
                        section=edition.card_kind if edition.card_kind in SECTIONS else None,
                        quantity=quantity, name=name, set_code=code, number=edition.collector_number, ph=False)
        rows.append(CopiedRow(card, edition.edition_ref, edition.printing_ref, edition.set_id, edition.set_name))
    return Publication(token, active.version, snapshot.title, snapshot.target_format, tuple(rows))


def resolve(conn, generation: UUID | None,
            publication: Publication) -> tuple[dict[int, Match], dict[int, tuple[UUID, UUID]]]:
    """(each line's Match, and for a line resolved by its Edition reference that (Edition, Printing)), by line number.
    With no active generation (before the first catalog import) every line is Not found."""
    rows = publication.rows
    by_edition: dict[str, tuple[UUID, UUID]] = {}
    by_printing: dict[str, UUID] = {}
    if generation is not None:
        edition_refs = sorted({row.edition_ref for row in rows if row.edition_ref})
        if edition_refs:
            by_edition = {found['public_ref']: (found['edition_id'], found['printing_id']) for found in conn.execute(
                """SELECT e.public_ref,ge.edition_id,ge.printing_id FROM catalog_edition e
                  JOIN catalog_generation_edition ge ON ge.generation_id=%s AND ge.edition_id=e.id AND ge.active
                  JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id
                    AND gp.printing_id=ge.printing_id AND NOT gp.tombstoned
                  WHERE e.public_ref=ANY(%s)""", (generation, edition_refs)).fetchall()}
        printing_refs = sorted({row.printing_ref for row in rows
                                if row.printing_ref and row.edition_ref not in by_edition})
        if printing_refs:
            by_printing = {found['public_ref']: found['printing_id'] for found in conn.execute(
                f"""SELECT p.public_ref,gp.printing_id FROM catalog_printing p
                  JOIN catalog_generation_printing gp ON gp.generation_id=%s AND gp.printing_id=p.id
                    AND NOT gp.tombstoned
                  WHERE p.public_ref=ANY(%s) AND {ACTIVE}""", (generation, printing_refs)).fetchall()}
    matches: dict[int, Match] = {}
    published: dict[int, tuple[UUID, UUID]] = {}
    for row in rows:
        line = row.card.line
        if row.edition_ref in by_edition:
            published[line] = by_edition[row.edition_ref]
            matches[line] = Match('matched', printing_id=published[line][1])
        elif row.printing_ref in by_printing:
            matches[line] = Match('matched', printing_id=by_printing[row.printing_ref])
        else:
            matches[line] = Match('not_found')
    return matches, published
