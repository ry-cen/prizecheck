"""Match a pasted decklist's card lines to Card Printings (Decklist Import, spec "Matching").

Each card line is matched by the steps in ``MATCHERS``, in order; the first step that answers a line wins, and a line no
step answers is Not found. A line with no set code and number (Can't read) never reaches a step. The steps:

1. the code and number: the printed set code table (``by_code_and_number``, ticket #212), then the import alias table
   and its rules (``import_aliases.by_alias``, #213). There is no name cross-check after a code match;
2. Basic Energy by type, when the name is a Basic Energy (``import_energy_matching.by_basic_energy``, #213);
3. the name, counting Reprint Groups (``import_name_matching.by_name``, #213). A line with no code is never matched
   by name.

``Match`` and the lookups the steps share live in ``import_match_core``; each step lives in its own module.
"""
from uuid import UUID

from ..catalog import set_codes
from .decklist_text import CardLine
from .import_aliases import by_alias
from .import_energy_matching import by_basic_energy
from app.import_match_core import Match, MatchStatus, Matcher, at_code_and_number
from .import_name_matching import by_name

__all__ = ['Match', 'MatchStatus', 'Matcher', 'MATCHERS', 'by_code_and_number', 'match_lines']


def by_code_and_number(conn, generation: UUID, lines: list[CardLine]) -> dict[int, Match]:
    """The printed set code (``set_codes.sets_for_code``, any case) and the collector number, compared as catalog search
    compares them (``catalog_browse.NUMBER_KEY``: zeros after a number's letters don't count, so 97 finds 097). One
    active Printing is Matched; several (which the set code research never found) ask the collector to pick. A code
    the table doesn't hold, a TCGdex set ID included, answers nothing here: the import never falls back to set IDs.
    There is no name cross-check (the research found every name difference after a code match was a convention)."""
    return at_code_and_number(conn, generation, [(line.line, set_id, line.number) for line in lines
                                                 for set_id in set_codes.sets_for_code(line.set_code)])


MATCHERS: tuple[Matcher, ...] = (by_code_and_number, by_alias, by_basic_energy, by_name)


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
