"""Advisory format checks of a Deck's Deck List (ADR 0010): ``GET /api/decks/{deck_id}/format-checks``.

One REPEATABLE READ snapshot reads:

- the Deck List;
- each line's Card Printing, Card Identity, Reprint Group (``catalog_reprint_group_member``), and set and collector
  number in the active catalog generation;
- the other printings of those Reprint Groups that the active generation holds and has not withdrawn;
- the effective card attributes of all of them (``catalog_card_attribute``).

The pure evaluator in ``format_evaluator`` decides. Results are computed on every read and never stored; saved results
and results returned by Deck List commands arrive with ticket 17.
"""
import re
from datetime import date, datetime, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from . import format_evaluator as evaluator
from .card_attributes import attribute_revision, read_card_attributes
from .location_tree import error
from .main import connect, verified_user

router = APIRouter(prefix='/api/decks', tags=['decks'])

DISCLAIMER = ('Advisory format checks: a result is not a guarantee of tournament legality. Missing rules or card data '
              'makes a result unknown, never legal.')
ISO_DATE = re.compile(r'\d{4}-\d{2}-\d{2}')

# Each line's Printing, Card Identity, Reprint Group, set and collector number. The set comes from the active catalog
# generation; a Printing without a row there has no set and checks as "set legality date not recorded".
LINES = """SELECT l.edition_id,l.quantity,p.id AS printing_id,ci.id AS identity_id,ci.display_name AS identity_name,
    gp.set_id,gp.collector_number,g.group_id
  FROM deck_list_line l
  JOIN catalog_edition e ON e.id=l.edition_id
  JOIN catalog_printing p ON p.id=e.printing_id
  JOIN catalog_identity ci ON ci.id=p.identity_id
  LEFT JOIN catalog_state s ON s.singleton
  LEFT JOIN catalog_generation_printing gp ON gp.generation_id=s.active_generation AND gp.printing_id=p.id
  LEFT JOIN catalog_reprint_group_member g ON g.printing_id=p.id
  WHERE l.owner_id=%s AND l.deck_id=%s
  ORDER BY l.edition_id"""
# The printings of those Reprint Groups that the active catalog generation holds and has not withdrawn.
MEMBERS = """SELECT g.group_id,g.printing_id,gp.set_id,gp.collector_number
  FROM catalog_reprint_group_member g
  JOIN catalog_state s ON s.singleton
  JOIN catalog_generation_printing gp ON gp.generation_id=s.active_generation AND gp.printing_id=g.printing_id
  WHERE g.group_id=ANY(%s) AND NOT gp.tombstoned
  ORDER BY g.group_id,gp.set_id,gp.collector_number"""


class FormatIssue(BaseModel):
    code: str
    reason: str
    kind: Literal['deck', 'card']
    # Whether this issue makes the result not legal (a violation) or unknown (a gap in rules or card data).
    effect: Literal['not_legal', 'unknown']
    # The Deck List lines (Edition IDs) the issue concerns; empty for an issue about the date.
    lines: list[UUID]


class FormatCheck(BaseModel):
    format: str
    status: Literal['legal', 'not_legal', 'unknown']
    issues: list[FormatIssue]
    rules_version: str
    evaluated_on: date
    notes: list[str]


class DeckFormatChecks(BaseModel):
    deck_id: UUID
    deck_list_revision: int
    attribute_revision: int
    results: list[FormatCheck]
    disclaimer: str = DISCLAIMER


def today() -> date:
    """The default check date: today in UTC."""
    return datetime.now(timezone.utc).date()


def parse_as_of(value: str | None, current: date) -> date:
    if value is None:
        return current
    try:
        if not ISO_DATE.fullmatch(value):
            raise ValueError(value)
        return date.fromisoformat(value)
    except ValueError:
        error(422, 'INVALID_AS_OF')


def format_check(result: evaluator.FormatResult, rules: evaluator.FormatRules, current: date) -> FormatCheck:
    notes = []
    if result.evaluated_on > current:
        notes.append(f'{result.evaluated_on.isoformat()} is in the future: rules published after this rules file '
                     f'({rules.published.isoformat()}) are unknown, so this result assumes no later rule changes.')
    return FormatCheck(format=result.format, status=result.status, rules_version=result.rules_version,
                       evaluated_on=result.evaluated_on, notes=notes,
                       issues=[FormatIssue(code=issue.code, reason=issue.reason, kind=issue.kind, effect=issue.effect,
                                           lines=list(issue.lines)) for issue in result.issues])


def read_lines(conn, user_id: str, deck_id: UUID) -> tuple[list[evaluator.ResolvedLine], dict]:
    """The Deck List's resolved lines, and the facts of every printing in their Reprint Groups by group ID."""
    rows = conn.execute(LINES, (user_id, deck_id)).fetchall()
    groups = sorted({row['group_id'] for row in rows if row['group_id'] is not None}, key=str)
    members = conn.execute(MEMBERS, (groups,)).fetchall() if groups else []
    attributes = read_card_attributes(conn, {row['printing_id'] for row in (*rows, *members)})
    reprint_groups = {}
    for row in members:
        reprint_groups.setdefault(row['group_id'], []).append(evaluator.PrintingFacts(
            row['printing_id'], row['set_id'], attributes[row['printing_id']], row['collector_number']))
    lines = [evaluator.ResolvedLine(
                 edition_id=row['edition_id'], quantity=int(row['quantity']), identity_id=row['identity_id'],
                 identity_name=row['identity_name'],
                 printing=evaluator.PrintingFacts(row['printing_id'], row['set_id'], attributes[row['printing_id']],
                                                  row['collector_number']),
                 reprint_group_id=row['group_id'])
             for row in rows]
    return lines, reprint_groups


@router.get('/{deck_id}/format-checks', response_model=DeckFormatChecks)
def deck_format_checks(deck_id: UUID, format_name: str | None = Query(default=None, alias='format'),
                       as_of: str | None = Query(default=None), user_id: str = Depends(verified_user)):
    if format_name is not None and format_name not in evaluator.FORMATS:
        error(422, 'UNKNOWN_FORMAT')
    names = evaluator.FORMATS if format_name is None else (format_name,)
    current = today()
    on = parse_as_of(as_of, current)
    with connect() as conn, conn.transaction():
        # One snapshot binds the Deck List revision, its lines, the catalog and the attribute revision.
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        if not conn.execute("SELECT 1 FROM location WHERE owner_id=%s AND id=%s AND kind='deck'",
                            (user_id, deck_id)).fetchone():
            error(404, 'DECK_NOT_FOUND')
        header = conn.execute('SELECT revision FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                              (user_id, deck_id)).fetchone()
        if header is None:
            raise RuntimeError('Deck has no Deck List')  # Migration 025 gives every Deck a Deck List.
        lines, reprint_groups = read_lines(conn, user_id, deck_id)
        revision = attribute_revision(conn)
    results = []
    for name in names:
        rules = evaluator.format_rules(name)
        results.append(format_check(evaluator.evaluate_format(lines, rules, on, reprint_groups), rules, current))
    return DeckFormatChecks(deck_id=deck_id, deck_list_revision=header['revision'], attribute_revision=revision,
                            results=results)
