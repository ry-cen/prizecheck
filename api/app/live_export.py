"""Pure Pokemon TCG Live deck text formatter.

No framework, database or catalog imports: callers (private Deck export, public
publication export) supply plain rows read from reviewed Live eligibility and receive
either complete deterministic text or the full list of blockers. Row text comes only from
the reviewed Live identity ``{category, name, set_code, number}``; display data is used
only to describe blockers. Nothing is guessed, dropped or substituted.

Layout: ``Pokémon: N`` / ``Trainer: N`` / ``Energy: N`` headings in that order (empty
categories omitted), rows ``{quantity} {name} {set_code} {number}`` sorted by casefolded
name then set code then number, one blank line between groups, no trailing newline and no
footer.
"""
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Iterator, Literal

CATEGORY_HEADINGS = (("Pokemon", "Pokémon"), ("Trainer", "Trainer"), ("Energy", "Energy"))


@dataclass(frozen=True)
class LiveInputRow:
    key: str
    display_name: str
    set_label: str
    collector_number: str
    descriptor: dict
    quantity: int
    state: str
    reason: str | None
    identity: dict | None


@dataclass(frozen=True)
class LiveBlocker:
    key: str
    display_name: str
    set_label: str
    collector_number: str
    descriptor: dict
    quantity: int
    reason: str


@dataclass(frozen=True)
class LiveGroup:
    category: str
    quantity: int
    rows: tuple[tuple[int, dict], ...]


@dataclass(frozen=True)
class LiveExport:
    status: Literal["ok", "blocked", "empty"]
    groups: tuple[LiveGroup, ...]
    blockers: tuple[LiveBlocker, ...]
    total_copies: int


def _clean(value) -> bool:
    """A non-empty single-line string without control, format, separator or unusual whitespace characters."""
    if not isinstance(value, str) or not value or value != value.strip():
        return False
    return all(unicodedata.category(ch)[0] != "C" and unicodedata.category(ch) not in ("Zl", "Zp")
               and (ch == " " or not ch.isspace()) for ch in value)


def _identity_problem(identity) -> bool:
    categories = {category for category, _ in CATEGORY_HEADINGS}
    return not (isinstance(identity, dict) and identity.get("category") in categories
                and all(_clean(identity.get(field)) for field in ("name", "set_code", "number"))
                and " " not in identity["set_code"] and " " not in identity["number"])


def _blocker(item: LiveInputRow, reason: str) -> LiveBlocker:
    return LiveBlocker(item.key, item.display_name, item.set_label, item.collector_number, item.descriptor,
                       item.quantity, reason)


def format_live(rows: Iterable[LiveInputRow]) -> LiveExport:
    blockers: list[LiveBlocker] = []
    totals: dict[tuple, int] = {}
    total = 0
    count = 0
    for item in rows:
        count += 1
        total += item.quantity
        if item.state != "eligible":
            blockers.append(_blocker(item, item.reason or item.state))
        elif item.quantity < 1 or _identity_problem(item.identity):
            blockers.append(_blocker(item, "invalid_input"))
        else:
            identity = item.identity
            key = (identity["category"], identity["name"], identity["set_code"], identity["number"])
            totals[key] = totals.get(key, 0) + item.quantity
    if count == 0:
        return LiveExport("empty", (), (), 0)
    if blockers:
        blockers.sort(key=lambda b: (b.display_name.casefold(), b.display_name, b.set_label, b.collector_number, b.key))
        return LiveExport("blocked", (), tuple(blockers), total)
    groups = []
    for category, _ in CATEGORY_HEADINGS:
        entries = sorted(((key, quantity) for key, quantity in totals.items() if key[0] == category),
                         key=lambda entry: (entry[0][1].casefold(), entry[0][1], entry[0][2], entry[0][3]))
        if entries:
            groups.append(LiveGroup(category, sum(quantity for _, quantity in entries),
                                    tuple((quantity, {"category": key[0], "name": key[1], "set_code": key[2], "number": key[3]})
                                          for key, quantity in entries)))
    return LiveExport("ok", tuple(groups), (), total)


def iter_live_text(export: LiveExport) -> Iterator[str]:
    """Yield the text in small pieces (one per line) so large exports never need one big string."""
    headings = dict(CATEGORY_HEADINGS)
    for index, group in enumerate(export.groups):
        yield ("\n\n" if index else "") + f"{headings[group.category]}: {group.quantity}"
        for quantity, identity in group.rows:
            yield f"\n{quantity} {identity['name']} {identity['set_code']} {identity['number']}"


def live_text(export: LiveExport) -> str:
    return "".join(iter_live_text(export))
