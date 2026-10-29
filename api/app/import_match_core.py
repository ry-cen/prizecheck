"""What every Decklist Import matching step shares (spec "Matching"; ticket #213 moved it out of ``import_matching``).

- ``Match``, the answer a step gives for one card line, and ``Matcher``, a step's signature;
- ``at_code_and_number``, the lookup of TCGdex sets and a collector number that the printed code table step and the
  alias step both make;
- the newest-first order catalog search lists Printings in (``catalog_browse``), which picks a Reprint Group's newest
  Printing and the default Basic Energy.

Each step lives in its own module and imports from here; ``import_matching.MATCHERS`` puts them in order. Every step
reads the active catalog generation inside the caller's transaction and answers only active Printings: not tombstoned,
with at least one active Edition.
"""
from dataclasses import dataclass, field
from typing import Callable, Literal
from uuid import UUID

from app.games.pokemon.catalog.catalog_browse import NUMBER_KEY, _rules_release_dates
from app.games.pokemon.imports.decklist_text import CardLine

MatchStatus = Literal['matched', 'by_name', 'energy', 'ambiguous', 'not_found', 'unreadable']


@dataclass(frozen=True)
class Match:
    status: MatchStatus
    printing_id: UUID | None = None   # matched, by_name and energy
    # ambiguous: one Printing per card to pick from. energy: every Basic Energy Printing of the line's type, newest
    # first (the first is printing_id), for the review's Change.
    candidates: tuple[UUID, ...] = field(default_factory=tuple)


# A step: (connection, active generation, the readable lines no earlier step answered) -> the answers it has, by line
# number. A step leaves out the lines it can't answer, so the next step sees them.
Matcher = Callable[[object, UUID, list[CardLine]], dict[int, Match]]

# The Printing (alias gp) has at least one active Edition.
ACTIVE = """EXISTS (SELECT 1 FROM catalog_generation_edition ge
  WHERE ge.generation_id=gp.generation_id AND ge.printing_id=gp.printing_id AND ge.active)"""


def at_code_and_number(conn, generation: UUID, wanted: list[tuple[int, str, str]]) -> dict[int, Match]:
    """Look up (line, TCGdex set ID, collector number) triples, comparing numbers as catalog search does
    (``catalog_browse.NUMBER_KEY``: zeros after a number's letters don't count, so 97 finds 097 and TG5 finds TG05).
    A line with one active Printing is Matched; several (which the set code research never found) ask the collector to
    pick. Lines with none are left out."""
    if not wanted:
        return {}
    rows = conn.execute(f"""SELECT q.line,gp.printing_id
      FROM unnest(%s::int[],%s::text[],%s::text[]) AS q(line,set_id,number)
      JOIN catalog_generation_printing gp ON gp.generation_id=%s AND gp.set_id=q.set_id AND NOT gp.tombstoned
        AND {NUMBER_KEY.format('gp.collector_number')}={NUMBER_KEY.format('q.number')}
      WHERE {ACTIVE}
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


# Newest first, as Catalog lists Printings (catalog_browse.NAME_ORDER): the set's release date the last catalog import
# stored, else its date in the format rules files, latest first, with undated sets last; then the TCGdex set ID; then
# the collector number in natural order (2 before 10, plain numbers before prefixed ones); then the Printing id. A query
# selects NEWEST_COLUMNS with RELEASE_JOINS (whose two parameters are release_params()) and sorts with newest_first.
NEWEST_COLUMNS = """gp.set_id,
    coalesce(gs.release_date,rd.released) IS NULL AS release_missing,
    coalesce(date '9999-12-31'-coalesce(gs.release_date,rd.released),0) AS release_rank,
    substring(gp.collector_number from '^[0-9]+') IS NULL AS number_missing,
    coalesce(substring(gp.collector_number from '^[0-9]+')::numeric,0) AS number_value,
    lower(gp.collector_number) AS number_key"""
RELEASE_JOINS = """LEFT JOIN catalog_generation_set gs ON gs.generation_id=gp.generation_id AND gs.set_id=gp.set_id
  LEFT JOIN unnest(%s::text[],%s::date[]) AS rd(set_id,released) ON rd.set_id=gp.set_id"""


def release_params() -> tuple[list[str], list]:
    """RELEASE_JOINS' two parameters: the format rules files' release dates, Catalog's fallback for a set the last
    import stored no date for."""
    return _rules_release_dates()


def newest_first(row) -> tuple:
    """The sort key of a row that selected NEWEST_COLUMNS and printing_id."""
    return (row['release_missing'], row['release_rank'], row['set_id'], row['number_missing'], row['number_value'],
            row['number_key'], str(row['printing_id']))
