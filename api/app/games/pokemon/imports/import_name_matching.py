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
from app.games.pokemon.imports.import_match_core import ACTIVE, NEWEST_COLUMNS, RELEASE_JOINS, Match, newest_first, release_params

# Capitalised words that end Pokémon names and fit the set token's grammar (two to eight capitals or digits).
NAME_SUFFIXES = frozenset({'EX', 'GX', 'VMAX', 'VSTAR', 'VUNION', 'BREAK', 'LEGEND', 'PRIME', 'FB', 'GL'})


# Every active Printing of the generation whose name matches each query name, by the query's own key: q(key,name).
NAMED = f"""WITH q AS (
    SELECT q.key,replace(catalog_search_words(q.name),' ','') AS name_key
    FROM unnest(%s::int[],%s::text[]) AS q(key,name)),
  names AS (
    SELECT gp.printing_id,gp.search_key AS name_key FROM catalog_generation_printing gp
      WHERE gp.generation_id=%s AND NOT gp.tombstoned AND gp.search_key IN (SELECT name_key FROM q WHERE name_key<>'')
    UNION
    SELECT gp.printing_id,replace(catalog_search_words(catalog_card_identity_key(gp.display_name)),' ','')
      FROM catalog_generation_printing gp
      WHERE gp.generation_id=%s AND NOT gp.tombstoned AND gp.display_name LIKE '%%(%%'
        -- The base name's key is a prefix of the whole name's key, so this cheap test keeps every candidate and
        -- spares the identity-key and normalisation work on the rest.
        AND EXISTS (SELECT 1 FROM q WHERE name_key<>'' AND starts_with(gp.search_key,q.name_key)))
  SELECT DISTINCT q.key,gp.printing_id,g.group_id,{NEWEST_COLUMNS}
  FROM q JOIN names n ON n.name_key=q.name_key AND q.name_key<>''
  JOIN catalog_generation_printing gp ON gp.generation_id=%s AND gp.printing_id=n.printing_id
  LEFT JOIN catalog_reprint_group_member g ON g.printing_id=gp.printing_id
  {RELEASE_JOINS}
  WHERE {ACTIVE}"""


def named_printings(conn, generation: UUID, wanted: list[tuple[int, str]]) -> dict[int, list]:
    """(key, name) pairs -> each key's active Printings whose names match (the module docstring's comparison), newest
    first, as rows with printing_id, group_id (None outside any Reprint Group), set_id and the newest-first columns. A
    key nothing matches is left out. Collection Import's name step reads it too (``collection_import_matcher``)."""
    if not wanted:
        return {}
    rows = conn.execute(NAMED, ([key for key, _ in wanted], [name for _, name in wanted], generation, generation,
                                generation, *release_params())).fetchall()
    found: dict[int, list] = {}
    for row in sorted(rows, key=newest_first):
        found.setdefault(row['key'], []).append(row)
    return found


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
    for line, rows in named_printings(conn, generation, [(line.line, line.name) for line in named]).items():
        newest: dict[tuple, dict] = {}
        for row in rows:
            # An ungrouped Printing is a card of its own. Rows are newest first: keep each group's first.
            group = ('group', row['group_id']) if row['group_id'] is not None else ('printing', row['printing_id'])
            newest.setdefault(group, row)
        printings = [row['printing_id'] for row in newest.values()]
        answers[line] = (Match('by_name', printing_id=printings[0]) if len(printings) == 1
                         else Match('ambiguous', candidates=tuple(printings)))
    return answers
