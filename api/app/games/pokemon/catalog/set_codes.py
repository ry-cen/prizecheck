"""Printed set codes for display and search (app redesign #173), read from ``set_codes.tsv``.

The code a collector reads on a card or in a deck list ("PAL" for TCGdex set ``sv02``). Catalog shows it in place of
the TCGdex set ID, and its smart search accepts it. A set without a code shows its TCGdex set ID. Several TCGdex sets
share one code only when a subset inherits its main set's code (the Trainer Gallery, Galarian Gallery and Shiny Vault
subsets, numbered TG01, GG01 or SV1); a search by that code looks in all of them.

This is not the Live export table (``catalog_targets.LiveRulesV1.SET_CODES``): nothing here feeds an export, a Format
Standing or a public record. ``DIGEST`` changes whenever the table does, so a browse cursor issued before a deploy that
changed it restarts (409) instead of being read under a different search.
"""
import hashlib
import re
from pathlib import Path

PATH = Path(__file__).with_name("set_codes.tsv")
CODE = re.compile(r"^[A-Z0-9]{2,4}$")


def _load(text: str) -> tuple[dict[str, str], dict[str, str]]:
    """(code by TCGdex set ID, sources by TCGdex set ID). Raises ValueError on a malformed row."""
    codes, sources = {}, {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 4 or not CODE.fullmatch(parts[1]) or parts[0] in codes:
            raise ValueError(f"set_codes.tsv line {number}: malformed or repeated row")
        codes[parts[0]], sources[parts[0]] = parts[1], parts[3]
    return codes, sources


_TEXT = PATH.read_text(encoding="utf-8")
CODES, SOURCES = _load(_TEXT)
DIGEST = hashlib.sha256(_TEXT.encode()).hexdigest()[:16]
_BY_CODE: dict[str, list[str]] = {}
for _set_id, _code in CODES.items():
    _BY_CODE.setdefault(_code.casefold(), []).append(_set_id)


def code_for(set_id: str) -> str:
    """The printed code of a TCGdex set, or the TCGdex set ID itself when it has none."""
    return CODES.get(set_id, set_id)


def sets_for_code(word: str) -> list[str]:
    """The TCGdex sets printed with this code (any case), main set first; empty when it is no known code."""
    return list(_BY_CODE.get(word.casefold(), []))
