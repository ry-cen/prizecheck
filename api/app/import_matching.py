"""Match a pasted decklist's card lines to Card Printings (Decklist Import, spec "Matching").

Each card line is matched by the steps in ``MATCHERS``, in order; the first step that answers a line wins, and a line no
step answers is Not found. A line with no set code and number (Can't read) never reaches a step. Ticket #212 has one
step, the code and number through the printed set code table. Ticket #213 adds the import alias table, Basic Energy by
type and names as further steps, each in its own module, appended to ``MATCHERS``; nothing here changes for them.

Every step reads the active catalog generation inside the caller's transaction and answers only active Printings: not
tombstoned, with at least one active Edition.
"""
from dataclasses import dataclass, field
from typing import Callable, Literal
from uuid import UUID

from . import set_codes
from .catalog_browse import NUMBER_KEY
from .decklist_text import CardLine

MatchStatus = Literal['matched', 'by_name', 'energy', 'ambiguous', 'not_found', 'unreadable']


@dataclass(frozen=True)
class Match:
    status: MatchStatus
    printing_id: UUID | None = None                           # matched, by_name and energy
    candidates: tuple[UUID, ...] = field(default_factory=tuple)  # ambiguous: one Printing per card to pick from


# A step: (connection, active generation, the readable lines no earlier step answered) -> the answers it has, by line
# number. A step leaves out the lines it can't answer, so the next step sees them.
Matcher = Callable[[object, UUID, list[CardLine]], dict[int, Match]]


def by_code_and_number(conn, generation: UUID, lines: list[CardLine]) -> dict[int, Match]:
    """The printed set code (``set_codes.sets_for_code``, any case) and the collector number, compared as catalog search
    compares them (``catalog_browse.NUMBER_KEY``: zeros after a number's letters don't count, so 97 finds 097). One
    active Printing is Matched; several (which the set code research never found) ask the collector to pick. A code
    the table doesn't hold, a TCGdex set ID included, answers nothing here: the import never falls back to set IDs.
    There is no name cross-check (the research found every name difference after a code match was a convention)."""
    wanted = [(line.line, set_id, line.number) for line in lines for set_id in set_codes.sets_for_code(line.set_code)]
    if not wanted:
        return {}
    rows = conn.execute(f"""SELECT q.line,gp.printing_id
      FROM unnest(%s::int[],%s::text[],%s::text[]) AS q(line,set_id,number)
      JOIN catalog_generation_printing gp ON gp.generation_id=%s AND gp.set_id=q.set_id AND NOT gp.tombstoned
        AND {NUMBER_KEY.format('gp.collector_number')}={NUMBER_KEY.format('q.number')}
      WHERE EXISTS (SELECT 1 FROM catalog_generation_edition ge
                    WHERE ge.generation_id=gp.generation_id AND ge.printing_id=gp.printing_id AND ge.active)
      ORDER BY q.line,gp.set_id,gp.printing_id""",
                        ([line for line, _, _ in wanted], [set_id for _, set_id, _ in wanted],
                         [number for _, _, number in wanted], generation)).fetchall()
    found: dict[int, list[UUID]] = {}
    for row in rows:
        found.setdefault(row['line'], [])
        if row['printing_id'] not in found[row['line']]:
            found[row['line']].append(row['printing_id'])
    return {line: Match('matched', printing_id=printings[0]) if len(printings) == 1
            else Match('ambiguous', candidates=tuple(printings))
            for line, printings in found.items()}


MATCHERS: tuple[Matcher, ...] = (by_code_and_number,)


def match_lines(conn, generation: UUID | None, cards: list[CardLine]) -> dict[int, Match]:
    """Every card line's Match, by line number. Can't read lines are ``unreadable``; with no active generation (before the
    first catalog import) every other line is Not found."""
    answers: dict[int, Match] = {card.line: Match('unreadable') for card in cards if not card.readable}
    waiting = [card for card in cards if card.readable]
    if generation is not None:
        for matcher in MATCHERS:
            if not waiting:
                break
            found = matcher(conn, generation, waiting)
            answers.update(found)
            waiting = [card for card in waiting if card.line not in found]
    for card in waiting:
        answers[card.line] = Match('not_found')
    return answers
