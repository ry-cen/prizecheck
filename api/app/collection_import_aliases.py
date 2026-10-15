"""How Collection Import reads a row's set and number (spec "Matching", step 2; ticket #228).

**The set.** A row's set name goes through the collection set-name alias table (``collection_import_aliases.tsv``,
keyed by the detected tracker and the set name) and, when the table has no entry, through naive normalisation
(``set_key``), compared with the TCGdex set names of the active catalog generation. The table holds only what naive
normalisation misses: promo, Energy and renamed sets. A loose file (another app's CSV) may use any tracker's names, so
it reads every tracker's entries, and so does a pasted list (#234). Dragon Shield and Sorted rows carry a set code
close to the printed one; the matcher tries it in the printed set code table (``set_codes``) before the name. Other
trackers' codes are their own (the TCGplayer app writes ``RR`` for two sets), so they are never read as printed codes.
A pasted line's code is decklist import's, so the matcher tries the printed set code table and decklist import's alias
table for it (``collection_import_matcher``).

``set_key`` folds accents and case, reads ``&`` as "and", drops apostrophes and turns every other run of punctuation
into one space. On the tracker's side it first drops an era prefix ending in a colon or a spaced dash (the TCGplayer
app's ``SV01: Scarlet & Violet Base Set``, ``SWSH12: Silver Tempest Trainer Gallery``, ``SM - Burning Shadows``): one to
four letters, up to three digits, then ``:`` or `` - ``. TCGdex's own names are never cut.

**The number** (``number_readings``) loses any denominator (``042/102``, ``TG01/TG30``, ``SV032/SV122``, ``040 / 096``)
and a leading ``#``, and then gets these rules, each as one more reading after the plain one:

- a promo denominator puts its letters before the number: ``037/DP-P`` is ``DP037``;
- a number with a suffix of two or more letters (Dragon Shield's ``012VL``) is also read without it: ``012``. A
  one-letter suffix (``52a``) is part of real collector numbers, so it stays;
- a number with an era promo prefix (``SWSH138``, ``SM190``, ``DP037``) is also looked for in that era's Black Star
  Promos set (``promo_set``), whatever set the row names: PriceCharting files ``Hydreigon C #SWSH138`` under
  Celebrations, the set it came with.

The matcher compares each reading with catalog search's number key (``import_match_core.at_code_and_number``), so
``TG5`` finds ``TG05`` and ``62`` finds ``062``.

Pure, apart from ``generation_sets``, which reads the generation's set names. Nothing here writes, reads prices or
starts a catalog pull.
"""
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from .collection_import_reader import LOOSE, PASTE, SOURCES

PATH = Path(__file__).with_name("collection_import_aliases.tsv")
# A pasted list (#234) is read with the loose file's names: it has no tracker of its own.
TRACKERS = frozenset(SOURCES) - {LOOSE, PASTE}
EVIDENCE = re.compile(r"(?:T1|C1|C2|P1|TC1|D1|S1):[1-9][0-9]*|R:(?:collectr|new-work)")
SET_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9.\-]*")
_ERA_PREFIX = re.compile(r"[a-z]{1,4}[0-9]{0,3}\s*(?::|\s-)\s+")
# Each era's Black Star Promos set, by the prefix its collector numbers carry (TCGdex: SWSH001, SM01, XY01, BW01, DP01,
# HGSS01; read from https://api.tcgdex.net/v2/en/sets/<id> on 2026-10-15). SVP and MEP promos have plain numbers.
PROMO_SETS = {"SWSH": "swshp", "SM": "smp", "XY": "xyp", "BW": "bwp", "DP": "dpp", "HGSS": "hgssp"}
_PROMO_NUMBER = re.compile(r"(SWSH|HGSS|SM|XY|BW|DP)0*[0-9]+", re.IGNORECASE)
_PROMO_DENOMINATOR = re.compile(r"([A-Za-z]{1,4})-P", re.IGNORECASE)
_LETTER_SUFFIX = re.compile(r"([0-9]+)[A-Za-z]{2,}")


@dataclass(frozen=True)
class Alias:
    tracker: str      # a detected source (collection_import_reader.SOURCES), never loose
    set_name: str     # as the tracker writes it
    set_id: str       # the TCGdex set it names
    evidence: tuple[str, ...]


def set_key(name: str, tracker: bool = True) -> str:
    """A set name as naive normalisation compares it. ``tracker``: a tracker's set name, whose era prefix is cut."""
    text = "".join(char for char in unicodedata.normalize("NFKD", name) if not unicodedata.combining(char))
    text = " ".join(text.casefold().split())
    prefix = _ERA_PREFIX.match(text) if tracker else None
    if prefix:
        text = text[prefix.end():]
    text = text.replace("&", " and ").replace("'", "")
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text).split())


def _load(text: str) -> tuple[Alias, ...]:
    """The table's rows. Raises ValueError on a malformed or repeated row."""
    rows: list[Alias] = []
    seen: set[tuple[str, str]] = set()
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 4:
            raise ValueError(f"collection_import_aliases.tsv line {number}: expected four columns")
        tracker, set_name, set_id, evidence = parts
        keys = tuple(evidence.split(","))
        key = (tracker, set_key(set_name))
        if (tracker not in TRACKERS or not key[1] or set_name != set_name.strip() or not SET_ID.fullmatch(set_id)
                or not all(EVIDENCE.fullmatch(item) for item in keys) or key in seen):
            raise ValueError(f"collection_import_aliases.tsv line {number}: malformed or repeated row")
        seen.add(key)
        rows.append(Alias(tracker, set_name, set_id, keys))
    return tuple(rows)


ALIASES = _load(PATH.read_text(encoding="utf-8"))
_BY_KEY: dict[tuple[str, str], list[str]] = {}
for _alias in ALIASES:
    _BY_KEY.setdefault((_alias.tracker, set_key(_alias.set_name)), []).append(_alias.set_id)
    _BY_KEY.setdefault((LOOSE, set_key(_alias.set_name)), []).append(_alias.set_id)


@dataclass(frozen=True)
class GenerationSets:
    """The active generation's sets: every set ID, and set IDs by ``set_key`` of their TCGdex name."""
    ids: frozenset
    by_key: dict


def generation_sets(conn, generation: UUID) -> GenerationSets:
    """The sets that hold at least one Printing of ``generation`` that isn't withdrawn."""
    by_key: dict[str, list[str]] = {}
    ids = set()
    for row in conn.execute("""SELECT DISTINCT set_id,set_name FROM catalog_generation_printing
        WHERE generation_id=%s AND NOT tombstoned ORDER BY set_id""", (generation,)):
        ids.add(row["set_id"])
        by_key.setdefault(set_key(row["set_name"], tracker=False), []).append(row["set_id"])
    return GenerationSets(frozenset(ids), by_key)


def sets_for_name(source: str, set_name: str, sets: GenerationSets) -> list[str]:
    """The TCGdex sets a row's set name names in this generation: the alias table's entries for the row's tracker (any
    tracker for a loose file), else the sets whose names are equal under ``set_key``. Empty when neither has one."""
    key = set_key(set_name)
    if not key:
        return []
    aliased = [set_id for set_id in _BY_KEY.get((source, key), []) if set_id in sets.ids]
    return aliased or list(sets.by_key.get(key, []))


def number_readings(number: str) -> list[str]:
    """The collector numbers a row's number may be, in the order the matcher tries them (module docstring)."""
    text = number.strip().lstrip("#").strip()
    head, slash, tail = text.partition("/")
    head, tail = head.strip(), tail.strip()
    if not head:
        return []
    promo = _PROMO_DENOMINATOR.fullmatch(tail) if slash else None
    first = promo.group(1).upper() + head if promo and head.isdigit() else head
    readings = [first]
    suffix = _LETTER_SUFFIX.fullmatch(first)
    if suffix:
        readings.append(suffix.group(1))
    return readings


def promo_set(number: str) -> str | None:
    """The era's Black Star Promos set a promo-prefixed number belongs in (``SWSH138`` is swshp), or None."""
    found = _PROMO_NUMBER.fullmatch(number)
    return PROMO_SETS[found.group(1).upper()] if found else None
