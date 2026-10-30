"""The decklist import alias table and its matching step (Decklist Import, spec "The import alias table"; ticket #213).

``import_aliases.tsv`` holds set codes that pasted decklists write but the printed set code table (``set_codes``)
doesn't:
- Limitless's and TCG Live's promo codes (``PR-SV``, ``PR-SW``);
- Limitless's own promo and Energy codes (``SP``, ``SMP``, ``SVE``, ``MEE``);
- TCG Online's promo codes (``PR-SM``, ``PR-BLW``);
- Celebrations' Classic Collection (``CEL CC1``).

Each row cites its own evidence. Two rules are code, not rows:
- ``<code>-TG|GG|RC <n>``, Limitless's Trainer Gallery, Galarian Gallery and Radiant Collection form (``BRS-TG 5``), is
  ``<code>`` with the number ``TG5``;
- ``SHF`` and ``HIF`` flat numbers above 73 and 69 (``SHF 74``) are Shining Vault numbers (``SV1``).

``readings`` lists where a pasted code and number may be after the table and the rules; Collection Import's matcher
reads a pasted line's code and number through it too (``collection_import_matcher``, #234). ``by_alias`` is the
matching step that runs after the printed code table (``import_matching.MATCHERS``). ``report_set`` names the TCGdex
set and number that a Missing cards report fills in.

Like ``set_codes``, nothing here feeds an export, a Format Standing or a public record, and the table never feeds the
Live export table (``catalog_targets.LiveRulesV1.SET_CODES``). ``api/tests/test_import_aliases.py`` guards this.
"""
import re
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from ..catalog import set_codes
from .decklist_text import CardLine
from app.games.pokemon.imports.import_match_core import Match, at_code_and_number

PATH = Path(__file__).with_name('import_aliases.tsv')
# A pasted set token (decklist_text's grammar, without the Energy pseudo-set).
CODE = re.compile(r'^[A-Z0-9]{2,8}(?:-[A-Z0-9]{2,4})?$')
PREFIX = re.compile(r'^[A-Z]{1,4}$')
# Source keys (see the table's header). A row needs one of PASTED_SOURCES, and a row with a number prefix needs X.
SOURCES = frozenset({'F', 'L', 'O', 'V', 'X'})
PASTED_SOURCES = frozenset({'F', 'L', 'O', 'V'})
NUMBER_RULES = ('add', 'only', '-')
DIGITS = re.compile(r'^[0-9]+$')
# Limitless's subset form: the subset's prefix moves from the number into the code (BRS TG5 -> BRS-TG 5).
SUBSET_CODE = re.compile(r'^([A-Z0-9]{2,8})-(TG|GG|RC)$')
# Limitless writes Shining Vault numbers flat, after the main set's last number: SHF SV1 is SHF 74, HIF SV1 is HIF 70.
FLAT_NUMBERS = {'SHF': 73, 'HIF': 69}


@dataclass(frozen=True)
class Alias:
    code: str                  # as pasted, upper case
    set_id: str                # the TCGdex set it names
    prefix: str                # the number prefix, or '' for none
    rule: str                  # 'add', 'only' or '-' (see the table's header)
    sources: tuple[str, ...]


def _load(text: str) -> tuple[Alias, ...]:
    """The table's rows. Raises ValueError on a malformed or repeated row."""
    rows: list[Alias] = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.startswith('#'):
            continue
        parts = line.split('\t')
        if len(parts) != 5:
            raise ValueError(f'import_aliases.tsv line {number}: expected five columns')
        code, set_id, prefix, rule, sources = parts
        prefix = '' if prefix == '-' else prefix
        keys = tuple(sources.split(','))
        if (not CODE.fullmatch(code) or not set_id or rule not in NUMBER_RULES
                or (rule == '-') != (prefix == '') or (prefix and not PREFIX.fullmatch(prefix))
                or not set(keys) <= SOURCES or not set(keys) & PASTED_SOURCES or (prefix and 'X' not in keys)
                or any(row.code == code and row.set_id == set_id for row in rows)):
            raise ValueError(f'import_aliases.tsv line {number}: malformed or repeated row')
        rows.append(Alias(code, set_id, prefix, rule, keys))
    return tuple(rows)


ALIASES = _load(PATH.read_text(encoding='utf-8'))
_BY_CODE: dict[str, list[Alias]] = {}
for _alias in ALIASES:
    _BY_CODE.setdefault(_alias.code.casefold(), []).append(_alias)


@dataclass(frozen=True)
class Reading:
    """One place a pasted code and number may be: any of these TCGdex sets, at this collector number."""
    sets: tuple[str, ...]
    number: str
    report_set: str   # the one set a Missing cards report names


def readings(code: str, number: str) -> list[Reading]:
    """Every reading the alias table and the two rules give a pasted code and number: table rows in table order, then
    the subset split, then the Shining Vault numbers. Empty when none applies. The printed code table's own reading
    (``set_codes.sets_for_code`` with the number as pasted) is not among them."""
    found: list[Reading] = []
    for alias in _BY_CODE.get(code.casefold(), []):
        if alias.rule == 'only' and not number.upper().startswith(alias.prefix):
            continue
        wanted = alias.prefix + number if alias.rule == 'add' and DIGITS.fullmatch(number) else number
        found.append(Reading((alias.set_id,), wanted, alias.set_id))
    subset = SUBSET_CODE.fullmatch(code.upper())
    if subset:
        base, prefix = subset.groups()
        sets = tuple(set_codes.sets_for_code(base))
        # TG and GG need the code's subset (SVI-TG has none; BRS-GG's is a Trainer Gallery). RC numbers sit in the main set.
        has_subset = prefix == 'RC' or (len(sets) > 1 and sets[-1].endswith(prefix.lower()))
        if sets and has_subset and (DIGITS.fullmatch(number) or number.upper().startswith(prefix)):
            # The subset is listed after its main set (set_codes.tsv's I: rows), so the report names the last set.
            found.append(Reading(sets, prefix + number if DIGITS.fullmatch(number) else number, sets[-1]))
    last = FLAT_NUMBERS.get(code.upper())
    if last is not None and DIGITS.fullmatch(number) and int(number) > last:
        sets = tuple(set_codes.sets_for_code(code))
        found.append(Reading(sets, f'SV{int(number) - last}', sets[-1]))
    return found


def by_alias(conn, generation: UUID, lines: list[CardLine]) -> dict[int, Match]:
    """The second half of matching step 1: the lines the printed code table didn't answer, read through the alias
    table and the rules, then compared as the printed code table step compares them. One active Printing is Matched;
    several ask the collector to pick. There is no name cross-check."""
    return at_code_and_number(conn, generation, [(line.line, set_id, reading.number) for line in lines
                                                 for reading in readings(line.set_code, line.number)
                                                 for set_id in reading.sets])


def report_set(code: str, number: str) -> tuple[str, str] | None:
    """The TCGdex set ID and collector number a Missing cards report names for a pasted code and number, or None when
    no code table maps the code. The alias table's and the rules' first reading comes first (``CEL CC1`` is
    ``cel25cc``, ``SHF 74`` is ``swsh4.5sv SV1``), then the printed code table's main set with the number as pasted."""
    found = readings(code, number)
    if found:
        return found[0].report_set, found[0].number
    sets = set_codes.sets_for_code(code)
    if not sets:
        return None
    # A Shining Vault number (SHF SV5) belongs to the code's subset, which is listed after its main set.
    vault = len(sets) > 1 and number.upper().startswith('SV') and sets[-1].endswith('sv')
    return (sets[-1] if vault else sets[0], number)
