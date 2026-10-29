"""Advisory format results of one Published Deck snapshot version (Deck Lists 18), in its Target Format only (app
redesign #183).

Anonymous, unbudgeted and PostgreSQL-free, like the Published Deck exports. The inputs are the token and the version in
the path plus the private route's ``?as_of=`` (``public_deck``). The Format is the one the snapshot was published in
(``PublicSnapshot.target_format``; a snapshot published before #178 reads as Standard), never a request input. Rows and
quantities come from the active frozen snapshot. Each row's Card Printing, Card Identity, set, collector number, Reprint Group and card attributes come
from the current public format facts (``public_catalog.format_facts``), and so do the facts of every printing in those
Reprint Groups, read at the same store generation. Results therefore follow rotations, bans, reviewed corrections,
re-derived attributes and Reprint Groups, and identity merges without republishing. The pure evaluator and the private
route's result formatting decide; only the line references differ: a line is the row's public Edition reference
(``row:<n>`` for a legacy row without one). Results are never saved, so ``computed_at`` is the request's time. The
snapshot is revalidated (token, version, digest) before any answer.

Contract: docs/public-projections.md ("Published Deck format results").
"""
from datetime import date, datetime, timezone
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import format_evaluator as evaluator
from app import public_deck
from ..catalog.card_attributes import UNKNOWN
from .deck_format_checks import DISCLAIMER, format_check, parse_as_of, today
from ..catalog.public_catalog import format_facts
from app.public_projection import ProjectionUnavailable
from app.public_records import public_record_store

router = APIRouter(tags=['published-format-checks'])
QUERY = frozenset({'as_of'})
# A row whose Printing cannot be proven against well-formed public format records is checked with no facts at all. The
# evaluator then reports its set and mark as not recorded; those two gaps are replaced by this one.
UNAVAILABLE = 'card_data_unavailable'
UNAVAILABLE_REASON = 'card data not available for this published card'
REPLACED = frozenset({evaluator.SET_DATE_NOT_RECORDED, evaluator.REGULATION_MARK_NOT_RECORDED})


class PublishedFormatIssue(BaseModel):
    code: str
    reason: str
    kind: Literal['deck', 'card']
    effect: Literal['not_legal', 'unknown']
    # The frozen rows the issue concerns: each row's public Edition reference, or "row:<n>" (its 0-based position among
    # the snapshot's rows) for a legacy row without one; empty for an issue about the date.
    lines: list[str]


class PublishedFormatCheck(BaseModel):
    format: str
    status: Literal['legal', 'not_legal', 'unknown']
    issues: list[PublishedFormatIssue]
    rules_version: str
    evaluated_on: date
    notes: list[str]
    # When this result was computed: always this request, since public results are never saved.
    computed_at: datetime


class PublishedDeckFormatChecks(BaseModel):
    version: int
    digest: str
    results: list[PublishedFormatCheck]
    disclaimer: str = DISCLAIMER


def _query(request: Request) -> tuple[date, date]:
    """The evaluation date and today; a refusal carries the public headers."""
    current = today()
    try:
        on = parse_as_of(request.query_params.get('as_of'), current)
    except HTTPException:
        raise public_deck.error(422, 'INVALID_AS_OF') from None
    return on, current


def read_facts(store, printing_refs, deadline, *, generation=None) -> dict:
    """Format facts of ``printing_refs`` and of every printing in their Reprint Groups, by Printing reference, all read at
    one store generation (``generation`` when given); ``None`` where a record is missing or malformed.
    ProjectionUnavailable and ValueError propagate. Shared with Discover (``discovery``)."""
    refs = list(dict.fromkeys(printing_refs))
    if not refs:
        return {}
    facts = format_facts(store, refs, deadline, generation=generation)
    members = sorted({ref for found in facts.values() if found is not None for ref in found.reprint_printings}
                     - facts.keys())
    if members:
        generation = next(found.generation for found in facts.values() if found is not None)
        facts.update(format_facts(store, members, deadline, generation=generation))
    return facts


def _facts(active, deadline) -> dict:
    """Format facts of the rows' Printings and of every printing in their Reprint Groups (``read_facts``)."""
    refs = [row.printing_ref for row in active.rows if row.printing_ref is not None]
    if not refs:
        return {}
    try:
        return read_facts(public_record_store(), refs, deadline)
    except (ProjectionUnavailable, ValueError):
        raise public_deck.error(503, 'PUBLIC_CATALOG_UNAVAILABLE') from None


def _printing_id(printing_ref: str) -> UUID:
    return uuid5(NAMESPACE_URL, f'prizecheck:printing:{printing_ref}')


def _printing(printing_ref: str, found) -> evaluator.PrintingFacts:
    return evaluator.PrintingFacts(_printing_id(printing_ref), found.set_id, found.attributes, found.collector_number)


def _group(found, facts) -> list[evaluator.PrintingFacts] | None:
    """The facts of every printing in ``found``'s Reprint Group, or None when any of them is unproven: a missing or
    malformed record, or a record that names another group (records delivered at different times)."""
    group = []
    for ref in found.reprint_printings:
        member = facts.get(ref)
        if member is None or member.reprint_group != found.reprint_group:
            return None
        group.append(_printing(ref, member))
    return group


def resolve(active, facts) -> tuple[list[evaluator.ResolvedLine], dict, dict[UUID, str], set[UUID]]:
    """Evaluator inputs for the frozen rows: (lines, reprint groups, synthetic line ID -> public line reference,
    unproven line IDs).

    Rows of one Edition are one line. A line is proven when every one of its rows has the same frozen Printing reference,
    that reference has well-formed format facts and, when it is in a Reprint Group, every printing of the group has
    well-formed facts naming the same group. Otherwise it is checked with unknown facts and no group under the frozen
    Card Identity name of its row group. The evaluator needs UUIDs, so lines, identities, Printings and groups get
    synthetic ones; a Printing has the same one as a line's printing and as a group member.
    """
    names = [identity.name for identity in active.snapshot.identities for _ in identity.editions]
    grouped = {}
    for index, (row, name) in enumerate(zip(active.rows, names)):
        key = row.edition_ref if row.edition_ref is not None else f'row:{index}'
        line = grouped.setdefault(key, {'quantity': 0, 'printing_ref': row.printing_ref, 'name': name})
        line['quantity'] += row.quantity
        if line['printing_ref'] != row.printing_ref:
            line['printing_ref'] = None
    lines, reprint_groups, keys, unproven = [], {}, {}, set()
    for position, (key, line) in enumerate(grouped.items(), start=1):
        line_id = UUID(int=position)
        keys[line_id] = key
        found = facts.get(line['printing_ref']) if line['printing_ref'] is not None else None
        group_id = members = None
        if found is not None and found.reprint_group is not None:
            members = _group(found, facts)
            if members is None:
                found = None
            else:
                group_id = uuid5(NAMESPACE_URL, f'prizecheck:reprint-group:{found.reprint_group}')
                reprint_groups[group_id] = members
        if found is None:
            unproven.add(line_id)
            identity_key, identity_name = line['name'], line['name']
            printing = evaluator.PrintingFacts(uuid5(NAMESPACE_URL, f'prizecheck:line:{key}'), None, UNKNOWN)
        else:
            identity_key, identity_name = found.identity_key, found.identity_name
            printing = _printing(line['printing_ref'], found)
        lines.append(evaluator.ResolvedLine(edition_id=line_id, quantity=line['quantity'],
                                            identity_id=uuid5(NAMESPACE_URL, f'prizecheck:card-identity:{identity_key}'),
                                            identity_name=identity_name, printing=printing, reprint_group_id=group_id))
    return lines, reprint_groups, keys, unproven


def _order(issue: PublishedFormatIssue):
    """The evaluator's issue order (``format_evaluator._Issues``)."""
    return issue.effect != 'not_legal', issue.kind != 'deck', issue.code, issue.reason


def published_check(result: evaluator.FormatResult, rules: evaluator.FormatRules, current: date,
                    computed_at: datetime, keys: dict, unproven: set) -> PublishedFormatCheck:
    """The private route's FormatCheck with public line references, and one ``card_data_unavailable`` gap in place of
    the set and mark gaps of unproven lines."""
    check = format_check(result, rules, current, computed_at)
    issues = []
    for issue in check.issues:
        lines = [line for line in issue.lines if not (issue.code in REPLACED and line in unproven)]
        if lines or not issue.lines:
            issues.append(PublishedFormatIssue(code=issue.code, reason=issue.reason, kind=issue.kind, effect=issue.effect,
                                               lines=sorted(keys[line] for line in lines)))
    if unproven and result.evaluated_on >= rules.covers_from:
        issues.append(PublishedFormatIssue(code=UNAVAILABLE, reason=UNAVAILABLE_REASON, kind='card', effect='unknown',
                                           lines=sorted(keys[line] for line in unproven)))
    issues.sort(key=_order)
    status = ('not_legal' if any(issue.effect == 'not_legal' for issue in issues)
              else 'unknown' if issues else 'legal')
    return PublishedFormatCheck(format=check.format, status=status, issues=issues, rules_version=check.rules_version,
                                evaluated_on=check.evaluated_on, notes=check.notes, computed_at=check.computed_at)


def checks_for(active, facts, names, on: date, current: date, computed_at: datetime) -> list[PublishedFormatCheck]:
    """The published result of ``active`` in each of ``names`` on ``on``, from ``facts`` (``read_facts``). Pure: the one
    evaluation behind this route and Discover's listing (``discovery``), so the two never disagree."""
    lines, reprint_groups, keys, unproven = resolve(active, facts)
    results = []
    for name in names:
        rules = evaluator.format_rules(name)
        results.append(published_check(evaluator.evaluate_format(lines, rules, on, reprint_groups), rules, current,
                                       computed_at, keys, unproven))
    return results


def published_format_checks(token: str, version: int, on: date, current: date) -> PublishedDeckFormatChecks:
    """The snapshot's result in its Target Format only (app redesign #183): the one Format it was published in."""
    deadline = public_deck.export_deadline()
    active = public_deck.read_for_export(token, version, deadline=deadline)
    results = checks_for(active, _facts(active, deadline), (active.snapshot.target_format,), on, current,
                         datetime.now(timezone.utc))
    public_deck.revalidate_for_export(active, deadline=deadline)
    return PublishedDeckFormatChecks(version=active.version, digest=active.digest, results=results)


@router.get('/api/public/decks/{token}/versions/{version}/format-checks', response_model=PublishedDeckFormatChecks)
def published_deck_format_checks(request: Request, token: str, version: str,
                                 as_of: str | None = Query(default=None)):
    # Synchronous on purpose: the HTTP record-store adapter refuses to run on an event loop. The declared query
    # parameter documents the contract; public_path and _query read and validate the raw query themselves. There is no
    # ``format``: the answer is the snapshot's Target Format, and a ``format`` parameter is 422 INVALID_REQUEST.
    number = public_deck.public_path(request, token, version, query=QUERY)
    on, current = _query(request)
    checks = published_format_checks(token, number, on, current)
    return JSONResponse(checks.model_dump(mode='json'), headers=dict(public_deck.PUBLIC_HEADERS))
