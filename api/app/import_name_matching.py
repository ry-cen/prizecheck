"""The name, when the code failed (Decklist Import, spec "Matching" step 3; ticket #213).

A line whose code and number found nothing, and which isn't a Basic Energy the catalog holds, is matched by its name.
Names are compared on letters and digits only, with migration 048's ``catalog_search_words`` (no accents, apostrophes,
punctuation or spaces), the normalisation catalog search uses. A Printing's trailing parenthetical subtitle is optional,
so "Boss's Orders" matches "Boss's Orders (Giovanni)" (``catalog_card_identity_key``, migration 028).

The answer counts the distinct effective Reprint Groups (``catalog_reprint_group_member``) among the active Printings
whose names match:
- **one group:** Matched by name (``by_name``), on the group's newest Printing in catalog search's newest-first order
  (``import_match_core.newest_first``): its set's release date, then its lowest collector number;
- **several groups:** Pick one (``ambiguous``), with each group's newest Printing as a candidate, in the same order;
- **none:** no answer, so the line is Not found.

A Printing in no Reprint Group counts as a group of its own. Missing rules text is never "equal", so two such
Printings are two cards to the collector.

Lines with no code never reach this step:
- a line with no set token and number is Can't read before matching;
- TCG Online's empty set code (``Water Energy  12``) is answered here with nothing.

A hand-typed line whose last word before the number is a capitalised name suffix (``1 Giratina VSTAR 131``,
``2 Charizard EX 12``) has no code either: the parser read the suffix as the set token. Such a line is Can't read
(``unreadable``), as the same line with a lowercase ``ex`` already is. It is never matched as "Giratina" without its
suffix. ``NAME_SUFFIXES`` holds no code of either code table (``api/tests/test_import_aliases.py``).
"""
from uuid import UUID

from .decklist_text import CardLine
from .import_match_core import ACTIVE, NEWEST_COLUMNS, RELEASE_JOINS, Match, newest_first, release_params

# Capitalised words that end Pokémon names and fit the set token's grammar (two to eight capitals or digits).
NAME_SUFFIXES = frozenset({'EX', 'GX', 'VMAX', 'VSTAR', 'VUNION', 'BREAK', 'LEGEND', 'PRIME', 'FB', 'GL'})


def by_name(conn, generation: UUID, lines: list[CardLine]) -> dict[int, Match]:
    answers: dict[int, Match] = {}
    named: list[CardLine] = []
    for line in lines:
        if not line.set_code:
            continue   # TCG Online's empty set code: no code, so never matched by name
        if line.set_code in NAME_SUFFIXES:
            answers[line.line] = Match('unreadable')
            continue
        named.append(line)
    if not named:
        return answers
    rows = conn.execute(f"""WITH q AS (
        SELECT q.line,replace(catalog_search_words(q.name),' ','') AS key FROM unnest(%s::int[],%s::text[]) AS q(line,name)),
      names AS (
        SELECT gp.printing_id,gp.search_key AS key FROM catalog_generation_printing gp
          WHERE gp.generation_id=%s AND NOT gp.tombstoned AND gp.search_key IN (SELECT key FROM q WHERE key<>'')
        UNION
        SELECT gp.printing_id,replace(catalog_search_words(catalog_card_identity_key(gp.display_name)),' ','')
          FROM catalog_generation_printing gp
          WHERE gp.generation_id=%s AND NOT gp.tombstoned AND gp.display_name LIKE '%%(%%'
            -- The base name's key is a prefix of the whole name's key, so this cheap test keeps every candidate and
            -- spares the identity-key and normalisation work on the rest.
            AND EXISTS (SELECT 1 FROM q WHERE key<>'' AND starts_with(gp.search_key,q.key)))
      SELECT DISTINCT q.line,gp.printing_id,g.group_id,{NEWEST_COLUMNS}
      FROM q JOIN names n ON n.key=q.key AND q.key<>''
      JOIN catalog_generation_printing gp ON gp.generation_id=%s AND gp.printing_id=n.printing_id
      LEFT JOIN catalog_reprint_group_member g ON g.printing_id=gp.printing_id
      {RELEASE_JOINS}
      WHERE {ACTIVE}""",
                        ([line.line for line in named], [line.name for line in named], generation, generation,
                         generation, *release_params())).fetchall()
    groups: dict[int, dict[tuple, dict]] = {}
    for row in sorted(rows, key=newest_first):
        # An ungrouped Printing is a card of its own.
        group = ('group', row['group_id']) if row['group_id'] is not None else ('printing', row['printing_id'])
        groups.setdefault(row['line'], {}).setdefault(group, row)   # rows are newest first: keep each group's first
    for line, newest in groups.items():
        printings = [row['printing_id'] for row in sorted(newest.values(), key=newest_first)]
        answers[line] = (Match('by_name', printing_id=printings[0]) if len(printings) == 1
                         else Match('ambiguous', candidates=tuple(printings)))
    return answers
