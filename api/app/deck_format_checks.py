"""Advisory format checks of a Deck's Deck List (ADR 0010): ``GET /api/decks/{deck_id}/format-checks`` and the results
every Deck List command returns (``command_format_checks``).

A check reads, in one snapshot:

- the Deck List;
- each line's Card Printing, Card Identity, Reprint Group (``catalog_reprint_group_member``), and set and collector
  number in the active catalog generation;
- the other printings of those Reprint Groups that the active generation holds and has not withdrawn;
- the effective card attributes of all of them (``catalog_card_attribute``).

The pure evaluator in ``format_evaluator`` decides.

Saved results (Deck Lists 17). The last result for each Deck and format is saved in ``deck_format_result`` under the key
it was computed for (``ResultKey``): the Deck List revision, the rules file (its SHA-256, so any rules deploy changes
it), the code that evaluates (``CODE_SHA256``), the card attribute and Reprint Group revision, the catalog revision (a
catalog activation can move a Printing to another set or out of the active generation), and the evaluation date
normalised to the next rule date (``format_evaluator.next_rule_date``), so a result stays valid until the next rotation,
set legal-from or ban date. A read whose key matches reuses the saved result; any other read recomputes and replaces
it. Nothing re-evaluates in bulk: a result made stale by a Move into the Deck, a correction, a rules deploy or a catalog
import is replaced on that Deck's next read or Deck List command.

A saved result holds the status, issues and rules version. ``evaluated_on`` is the requested date and ``notes`` depend
on today, so both are filled in per request; ``computed_at`` says when the result was computed.

A read takes one REPEATABLE READ, READ ONLY snapshot, as before, and saves what it recomputed afterwards in a separate
short transaction that gives up rather than wait on a Deck List writer (``save_read_results``); a lock wait, a
timeout or a deleted Deck never fails the read. A Deck List command evaluates and saves inside its own transaction,
and its stored idempotent response keeps those results: a replay returns them as computed then.
"""
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from . import card_attributes
from . import format_evaluator as evaluator
from .card_attributes import attribute_revision, read_card_attributes
from .location_tree import error
from .main import connect, verified_user

router = APIRouter(prefix='/api/decks', tags=['decks'])

DISCLAIMER = ('Advisory format checks: a result is not a guarantee of tournament legality. Missing rules or card data '
              'makes a result unknown, never legal.')
ISO_DATE = re.compile(r'\d{4}-\d{2}-\d{2}')
# A saved result is reusable only while the code that produced it is unchanged: any edit to the evaluator, the attribute
# reader or this module makes every saved result stale (one recompute per Deck and format, on its next read).
CODE_SHA256 = hashlib.sha256(b''.join(Path(path).read_bytes()
                                      for path in (evaluator.__file__, card_attributes.__file__, __file__))).hexdigest()
# A read saves its recomputed results best effort: it waits at most this long for a row a Deck List command is writing.
SAVE_LOCK_TIMEOUT = '100ms'
SAVE_STATEMENT_TIMEOUT = '1s'

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

SAVED = """SELECT format,deck_list_revision,rules_sha256,code_sha256,attribute_revision,catalog_revision,valid_until,
    result,computed_at
  FROM deck_format_result WHERE owner_id=%s AND deck_id=%s AND format=ANY(%s)"""

SAVE = """INSERT INTO deck_format_result AS r(owner_id,deck_id,format,deck_list_revision,rules_sha256,code_sha256,
    attribute_revision,catalog_revision,valid_until,result,computed_at)
  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
  ON CONFLICT (owner_id,deck_id,format) DO UPDATE SET deck_list_revision=EXCLUDED.deck_list_revision,
    rules_sha256=EXCLUDED.rules_sha256,code_sha256=EXCLUDED.code_sha256,attribute_revision=EXCLUDED.attribute_revision,
    catalog_revision=EXCLUDED.catalog_revision,valid_until=EXCLUDED.valid_until,result=EXCLUDED.result,
    computed_at=EXCLUDED.computed_at"""


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
    # When this result was computed. A saved result keeps its time while it is reused.
    computed_at: datetime


class DeckFormatChecks(BaseModel):
    deck_id: UUID
    deck_list_revision: int
    attribute_revision: int
    catalog_revision: int
    results: list[FormatCheck]
    disclaimer: str = DISCLAIMER


@dataclass(frozen=True)
class ResultKey:
    """Everything a result depends on besides the Deck List lines its revision covers."""
    deck_list_revision: int
    rules_sha256: str
    code_sha256: str
    attribute_revision: int
    catalog_revision: int
    valid_until: date | None    # the next rule date after the evaluation date; None when none follows


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


def format_check(result: evaluator.FormatResult, rules: evaluator.FormatRules, current: date,
                 computed_at: datetime) -> FormatCheck:
    notes = []
    if result.evaluated_on > current:
        notes.append(f'{result.evaluated_on.isoformat()} is in the future: rules published after this rules file '
                     f'({rules.published.isoformat()}) are unknown, so this result assumes no later rule changes.')
    return FormatCheck(format=result.format, status=result.status, rules_version=result.rules_version,
                       evaluated_on=result.evaluated_on, notes=notes, computed_at=computed_at,
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


def read_revisions(conn) -> tuple[int, int]:
    """The attribute and catalog revisions. Read them before the lines and attributes they cover: in a READ COMMITTED
    transaction a commit landing between the reads then leaves a result keyed older than its content, which only
    makes the next read recompute, never reuse a stale result."""
    catalog = conn.execute('SELECT revision FROM catalog_state WHERE singleton').fetchone()['revision']
    return attribute_revision(conn), catalog


def result_key(deck_list_revision: int, rules: evaluator.FormatRules, revisions: tuple[int, int],
               on: date) -> ResultKey:
    return ResultKey(deck_list_revision, rules.sha256, CODE_SHA256, revisions[0], revisions[1],
                     evaluator.next_rule_date(rules, on))


def saved_key(row) -> ResultKey:
    return ResultKey(row['deck_list_revision'], row['rules_sha256'], row['code_sha256'], row['attribute_revision'],
                     row['catalog_revision'], row['valid_until'])


def saved_form(result: evaluator.FormatResult) -> str:
    """The stored part of a result: everything but the evaluation date."""
    return json.dumps({'status': result.status, 'rules_version': result.rules_version,
                       'issues': [{'code': issue.code, 'reason': issue.reason, 'kind': issue.kind,
                                   'effect': issue.effect, 'lines': [str(line) for line in issue.lines]}
                                  for issue in result.issues]})


def from_saved(format_name: str, saved: dict, on: date) -> evaluator.FormatResult:
    return evaluator.FormatResult(
        format_name, saved['status'],
        tuple(evaluator.FormatIssue(issue['code'], issue['reason'], issue['kind'], issue['effect'],
                                    tuple(UUID(line) for line in issue['lines'])) for issue in saved['issues']),
        saved['rules_version'], on)


def save(conn, user_id: str, deck_id: UUID, format_name: str, key: ResultKey, result: evaluator.FormatResult,
         computed_at: datetime):
    conn.execute(SAVE, (user_id, deck_id, format_name, key.deck_list_revision, key.rules_sha256, key.code_sha256,
                        key.attribute_revision, key.catalog_revision, key.valid_until, saved_form(result),
                        computed_at))


def command_format_checks(conn, user_id: str, deck_id: UUID, deck_list_revision: int) -> DeckFormatChecks:
    """Evaluate a Deck's Deck List in every format as of today, inside a Deck List command's transaction, and save each
    result. The caller holds the owner lock and has just advanced the Deck List revision to ``deck_list_revision``."""
    current = today()
    revisions = read_revisions(conn)
    lines, reprint_groups = read_lines(conn, user_id, deck_id)
    computed_at = datetime.now(timezone.utc)
    results = []
    for name in evaluator.FORMATS:
        rules = evaluator.format_rules(name)
        result = evaluator.evaluate_format(lines, rules, current, reprint_groups)
        save(conn, user_id, deck_id, name, result_key(deck_list_revision, rules, revisions, current), result,
             computed_at)
        results.append(format_check(result, rules, current, computed_at))
    return DeckFormatChecks(deck_id=deck_id, deck_list_revision=deck_list_revision, attribute_revision=revisions[0],
                            catalog_revision=revisions[1], results=results)


def save_read_results(user_id: str, deck_id: UUID, keys: dict, fresh: dict):
    """Save what a read recomputed, in ``FORMATS`` order, in a short transaction of its own.

    Best effort: the read has already answered. It waits at most ``SAVE_LOCK_TIMEOUT`` for a row a Deck List command
    is writing, and a Deck deleted since the read saves nothing; either way the next read recomputes. Concurrent reads
    saving one row leave the last writer's result, which is valid for its own key."""
    try:
        with connect() as conn, conn.transaction():
            conn.execute(f"SET LOCAL lock_timeout = '{SAVE_LOCK_TIMEOUT}'")
            conn.execute(f"SET LOCAL statement_timeout = '{SAVE_STATEMENT_TIMEOUT}'")
            for name in evaluator.FORMATS:
                if name in fresh:
                    result, computed_at = fresh[name]
                    save(conn, user_id, deck_id, name, keys[name], result, computed_at)
    except (psycopg.errors.LockNotAvailable, psycopg.errors.QueryCanceled, psycopg.errors.ForeignKeyViolation):
        pass


@router.get('/{deck_id}/format-checks', response_model=DeckFormatChecks)
def deck_format_checks(deck_id: UUID, format_name: str | None = Query(default=None, alias='format'),
                       as_of: str | None = Query(default=None), user_id: str = Depends(verified_user)):
    if format_name is not None and format_name not in evaluator.FORMATS:
        error(422, 'UNKNOWN_FORMAT')
    names = evaluator.FORMATS if format_name is None else (format_name,)
    current = today()
    on = parse_as_of(as_of, current)
    rules = {name: evaluator.format_rules(name) for name in names}
    with connect() as conn, conn.transaction():
        # One snapshot binds the Deck List revision, its lines, the catalog, the attribute revision and saved results.
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        if not conn.execute("SELECT 1 FROM location WHERE owner_id=%s AND id=%s AND kind='deck'",
                            (user_id, deck_id)).fetchone():
            error(404, 'DECK_NOT_FOUND')
        header = conn.execute('SELECT revision FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                              (user_id, deck_id)).fetchone()
        if header is None:
            raise RuntimeError('Deck has no Deck List')  # Migration 025 gives every Deck a Deck List.
        revisions = read_revisions(conn)
        keys = {name: result_key(header['revision'], rules[name], revisions, on) for name in names}
        answers = {row['format']: (from_saved(row['format'], row['result'], on),
                                   row['computed_at'].astimezone(timezone.utc))
                   for row in conn.execute(SAVED, (user_id, deck_id, list(names))).fetchall()
                   if saved_key(row) == keys[row['format']]}
        stale = [name for name in names if name not in answers]
        lines, reprint_groups = read_lines(conn, user_id, deck_id) if stale else ([], {})
    computed_at = datetime.now(timezone.utc)
    fresh = {name: (evaluator.evaluate_format(lines, rules[name], on, reprint_groups), computed_at)
             for name in stale}
    if fresh:
        save_read_results(user_id, deck_id, keys, fresh)
    answers.update(fresh)
    results = []
    for name in names:
        result, computed = answers[name]
        results.append(format_check(result, rules[name], current, computed))
    return DeckFormatChecks(deck_id=deck_id, deck_list_revision=header['revision'], attribute_revision=revisions[0],
                            catalog_revision=revisions[1], results=results)
