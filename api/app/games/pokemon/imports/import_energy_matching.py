"""Basic Energy by type (Decklist Import, spec "Matching" step 2; ticket #213).

A line whose code and number found nothing, but whose name is a Basic Energy in any spelling (``Basic {P} Energy``,
``Psychic Energy``, ``Basic Psychic Energy``), is matched by its Energy type. The code didn't resolve because:
- it is a game-only code (``SVALT 135``);
- it is Limitless's ``Energy N`` pseudo-set (``Psychic Energy Energy 31``);
- it is a set the catalog doesn't hold yet (``MEE 10`` before TCGdex has it);
- it is TCG Online's empty set code (``Water Energy  12``).

The default Printing is that type's Basic Energy Printing in the newest set that has one, in catalog search's
newest-first order (``import_match_core.newest_first``): the set's release date, then the lowest collector number within
the set. The review shows it as ``energy`` with **Change**, which lists every Basic Energy Printing of the type
(``Match.candidates``, newest first). Its Edition comes from add-by-Printing's rule, like any new copy
(``import_allocation``).

A catalog Printing is a Basic Energy of a type when its effective Basic Energy attribute is true
(``catalog_card_attribute``, migration 030 as corrected by 033) and its name is ``{Type} Energy`` or
``Basic {Type} Energy``. That name is how ``card_attributes`` recognised it as Basic Energy in the first place. The
attribute's ``types`` column can't give the type: it is empty for every Energy card.
"""
import re
from uuid import UUID

from .decklist_text import CardLine
from app.games.pokemon.imports.import_match_core import ACTIVE, NEWEST_COLUMNS, RELEASE_JOINS, Match, newest_first, release_params

# TCG Live's Energy symbols.
SYMBOLS = {'G': 'Grass', 'R': 'Fire', 'W': 'Water', 'L': 'Lightning', 'P': 'Psychic', 'F': 'Fighting', 'D': 'Darkness',
           'M': 'Metal', 'Y': 'Fairy'}
TYPES = tuple(SYMBOLS.values())
# A pasted Basic Energy name, any case: "Basic {P} Energy", "{P} Energy", "Psychic Energy", "Basic Psychic Energy".
PASTED = re.compile(rf"(?:basic )?(?:\{{([{''.join(SYMBOLS)}])\}}|({'|'.join(TYPES)})) energy", re.IGNORECASE)
# A catalog Basic Energy's name (card_attributes.CardAttributeRules.BASIC_ENERGY_NAME), its type captured.
CATALOG_NAME = rf"^(?:Basic )?({'|'.join(TYPES)}) Energy$"


def energy_type(name: str) -> str | None:
    """The Energy type a pasted name spells ("Psychic"), or None when it isn't a Basic Energy name."""
    found = PASTED.fullmatch(' '.join(name.split()))
    if not found:
        return None
    symbol, word = found.groups()
    return SYMBOLS[symbol.upper()] if symbol else word.capitalize()


def basic_energy_printings(conn, generation: UUID, types) -> dict[str, list[tuple[UUID, str]]]:
    """Every active Basic Energy Printing of each of ``types`` ("Psychic"), newest first, as (Printing, TCGdex set ID).
    A type the catalog holds no active Basic Energy for is left out. Collection Import's Basic Energy step reads it too
    (``collection_import_matcher``)."""
    wanted = sorted({energy for energy in types if energy})
    if not wanted:
        return {}
    rows = conn.execute(f"""SELECT gp.printing_id,substring(gp.display_name from %s) AS energy_type,{NEWEST_COLUMNS}
      FROM catalog_generation_printing gp
      JOIN catalog_card_attribute ca ON ca.printing_id=gp.printing_id AND ca.basic_energy IS TRUE
      {RELEASE_JOINS}
      WHERE gp.generation_id=%s AND NOT gp.tombstoned AND substring(gp.display_name from %s)=ANY(%s) AND {ACTIVE}""",
                        (CATALOG_NAME, *release_params(), generation, CATALOG_NAME, wanted)).fetchall()
    by_type: dict[str, list[tuple[UUID, str]]] = {}
    for row in sorted(rows, key=newest_first):
        by_type.setdefault(row['energy_type'], []).append((row['printing_id'], row['set_id']))
    return by_type


def by_basic_energy(conn, generation: UUID, lines: list[CardLine]) -> dict[int, Match]:
    """Each Basic Energy line's default Printing, with every Basic Energy Printing of its type as candidates. A type the
    catalog holds no active Basic Energy for answers nothing, so the line goes on to the name step."""
    types = {line.line: energy_type(line.name) for line in lines}
    by_type = {energy: [printing for printing, _ in found]
               for energy, found in basic_energy_printings(conn, generation, types.values()).items()}
    return {line: Match('energy', printing_id=by_type[energy][0], candidates=tuple(by_type[energy]))
            for line, energy in types.items() if energy in by_type}
