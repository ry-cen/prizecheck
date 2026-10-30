"""Format Rules files and the pure format evaluator (ADR 0010).

Each format's rules live in ``format_rules/<format>.toml`` beside this module, maintained by commit. ``load_rules``
parses and validates one file; ``format_rules`` caches the parsed file per format. The rules version a result
reports is the file's revision and publication date.

``evaluate_format`` checks resolved Deck List lines against one format's rules on one date. Like the construction
checks, it is pure: it reads no database and no network, so private Decks and, later, Published Decks share it.
``rule_dates`` and ``next_rule_date`` say how long a result holds: it changes only on a rule date, so a saved result
stays valid until the next one.

Legality and bans follow Reprint Groups (``app.games.pokemon.catalog.reprint_groups``). A Trainer or Energy printing that is not legal on its
own is legal when any printing in its group is; a Pokémon printing is not, unless the rules set
``pokemon_reprint_inheritance``. A ban names one printing and applies to every printing in its group.

Two card pools exist. In ``mark_and_set`` (Standard) a printing needs a legal regulation mark and a set past its
legal-from date. In ``by_set`` (Expanded, ticket 15) each set says whether it admits its printings by itself
(``legal_by = "set"``: the Black & White to Sun & Moon sets and the extras) or only with a legal mark
(``legal_by = "mark"``). Facts the research could not settle make a printing unknown: a whole set (``unsettled_sets``)
or a numbered range within one (``unsettled_printings``).

Gym Leader Challenge (ticket 16) adds three optional rules: ``copy_groups`` (Card Identities that share one copy count,
such as Boss's Orders and Lysandre), ``excluded_attributes`` (cards whose Rule Box or ACE SPEC status is true are not
legal; the per-deck limits those exclusions cover are skipped) and ``single_pokemon_type`` (every Pokémon shares one
type; a dual-type Pokémon fits either type, and Colorless is a type of its own).

``exclusive_groups`` (Expanded, ticket 15 revision 2) name Card Identities that may not share a deck at all, such as
Boss's Orders and Lysandre: official rulings, not a shared copy count, so 2 Boss's Orders and 2 Lysandre are not legal
in Expanded although each stays within 4 copies. A deck holding two or more of them is not legal (a deck issue).

Every format also applies the rulebook's deck-building rule that a deck holds at least one Basic Pokémon (ticket 20).
It is in no rules file: the Pokémon TCG Rules state it for every deck ("your deck must have at least one Basic Pokémon
in it"), so it changes with the evaluator's code, not with a format's revision.

A result is advisory. Any definite violation makes it ``not_legal``; otherwise any gap in the rules or the card data
makes it ``unknown``; otherwise it is ``legal``. A gap is reported only when the missing fact could change the answer:
an unknown ACE SPEC status matters only if it could put the deck over its ACE SPEC limit, and an unknown Basic Pokémon
status only if no line is a known Basic Pokémon.
"""
import bisect
import hashlib
import re
import tomllib
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import cache
from pathlib import Path
from typing import Literal
from uuid import UUID

from ..catalog.card_attributes import CardAttributes
from ..catalog.card_identity import card_identity_key

RULES_DIR = Path(__file__).resolve().parent / "format_rules"
# Formats with a rules file, in response order.
FORMATS = ("standard", "expanded", "glc")

Status = Literal["legal", "not_legal", "unknown"]
IssueKind = Literal["deck", "card"]

# Stable issue codes. Violations make a result not_legal:
DECK_SIZE = "deck_size"
NO_BASIC_POKEMON = "no_basic_pokemon"
NOT_IN_CARD_POOL = "not_in_card_pool"
COPY_LIMIT = "copy_limit"
ACE_SPEC_LIMIT = "ace_spec_limit"
RADIANT_LIMIT = "radiant_limit"
PRISM_STAR_LIMIT = "prism_star_limit"
BANNED = "banned"
SINGLE_TYPE = "single_type"
EXCLUSIVE_CARDS = "exclusive_cards"
RULE_BOX_NOT_ALLOWED = "rule_box_not_allowed"
ACE_SPEC_NOT_ALLOWED = "ace_spec_not_allowed"
# Gaps make a result unknown:
SET_DATE_NOT_RECORDED = "set_date_not_recorded"
REGULATION_MARK_NOT_RECORDED = "regulation_mark_not_recorded"
REGULATION_MARK_NOT_IN_RULES = "regulation_mark_not_in_rules"
ATTRIBUTE_UNKNOWN = "attribute_unknown"
RULES_FACT_UNSETTLED = "rules_fact_unsettled"
BEFORE_RULES_COVERAGE = "before_rules_coverage"
REPRINT_LEGALITY_UNKNOWN = "reprint_legality_unknown"


class FormatRulesError(ValueError):
    """A rules file that does not parse or breaks the schema below."""


# ---------------------------------------------------------------------------------------------------------------------
# Rules files


@dataclass(frozen=True)
class MarkRule:
    mark: str
    legal_from: date            # first legal day
    rotates_on: date | None     # first day no longer legal; None while no rotation is announced

    def legal_on(self, on: date) -> bool:
        return self.legal_from <= on and (self.rotates_on is None or on < self.rotates_on)


@dataclass(frozen=True)
class SetRule:
    set_id: str
    name: str
    released: date              # TCGdex releaseDate
    legal_from: date            # first legal day
    basis: str                  # 'second_friday' or 'announced'
    reference: str | None       # the announcement, when basis is 'announced'
    legal_by: str = "mark"      # 'mark': its printings also need a legal mark; 'set': the set admits them (by_set)


@dataclass(frozen=True)
class SetExclusion:
    reason: str
    noted_on: date
    set_ids: tuple[str, ...]


@dataclass(frozen=True)
class UnsettledPrintings:
    """A numbered range within one set whose legality the research has not settled, such as SM01 to SM157."""
    set_id: str
    prefix: str                 # the collector number's text before its digits, such as "SM"
    first: int
    last: int
    reason: str
    noted_on: date

    def covers(self, number: str | None) -> bool:
        """Whether ``number`` is in the range. A number that does not read as the prefix and digits is covered too:
        the rules cannot tell where it falls."""
        match = re.fullmatch(re.escape(self.prefix) + r"(\d+)", number or "")
        return match is None or self.first <= int(match.group(1)) <= self.last


@dataclass(frozen=True)
class UnsettledCard:
    identity: str               # Card Identity name
    reason: str
    noted_on: date


@dataclass(frozen=True)
class BanRule:
    set_id: str
    number: str                 # collector number, as the catalog records it
    name: str                   # the banned card's name, for reasons
    banned_from: date           # first banned day
    lifted_on: date | None      # first day legal again; None while the ban stands

    def in_force(self, on: date) -> bool:
        return self.banned_from <= on and (self.lifted_on is None or on < self.lifted_on)


@dataclass(frozen=True)
class Limits:
    deck_size: int              # exact
    copies: int                 # per Card Identity
    basic_energy_exempt: bool   # from the copy limit
    ace_spec_per_deck: int
    radiant_per_deck: int
    prism_star_per_name: int    # per Card Identity


@dataclass(frozen=True)
class CopyGroup:
    """Card Identities whose copies count together toward the copy limit."""
    names: tuple[str, ...]      # Card Identity names, in rules-file order

    @property
    def label(self) -> str:
        return f"{', '.join(self.names[:-1])} or {self.names[-1]}"


def _a(name: str) -> str:
    """The indefinite article before a format name: "a Standard deck", "an Expanded deck"."""
    return "an" if name[:1] in "AEIOU" else "a"


# Attributes a format may exclude: the issue code, the cards it names, and the gap when the attribute is unknown. Rule
# Box covers Radiant Pokémon and every Prism Star card (card_attributes.CardAttributeRules).
EXCLUDABLE = {
    "rule_box": (RULE_BOX_NOT_ALLOWED, "Rule Box cards, including Radiant and Prism Star cards,",
                 "Rule Box status unknown"),
    "ace_spec": (ACE_SPEC_NOT_ALLOWED, "ACE SPEC cards", "ACE SPEC status unknown"),
}


@dataclass(frozen=True)
class FormatRules:
    format: str
    name: str
    revision: int
    published: date
    covers_from: date
    pool: str
    basic_energy_always_legal: bool
    pokemon_reprint_inheritance: bool
    limits: Limits
    marks: Mapping[str, MarkRule]
    sets: Mapping[str, SetRule]
    exclusions: tuple[SetExclusion, ...]
    excluded: Mapping[str, SetExclusion]        # by set ID
    unsettled: Mapping[str, UnsettledCard]      # by Card Identity name
    bans: Mapping[tuple[str, str], BanRule]     # by (set ID, collector number)
    sha256: str                                 # of the file bytes
    unsettled_set_groups: tuple[SetExclusion, ...] = ()
    unsettled_sets: Mapping[str, SetExclusion] = field(default_factory=dict)          # by set ID
    unsettled_printings: Mapping[str, tuple[UnsettledPrintings, ...]] = field(default_factory=dict)  # by set ID
    copy_groups: tuple[CopyGroup, ...] = ()
    copy_group_of: Mapping[str, CopyGroup] = field(default_factory=dict)  # by Card Identity name
    exclusive_groups: tuple[CopyGroup, ...] = ()  # at most one Card Identity of each group per deck
    excluded_attributes: tuple[str, ...] = ()  # keys of EXCLUDABLE
    single_pokemon_type: bool = False

    @property
    def version(self) -> str:
        return f"{self.revision} ({self.published.isoformat()})"


POOLS = ("mark_and_set", "by_set")
SET_BASES = ("second_friday", "announced")
LEGAL_BY = ("set", "mark")
_TOP = {"format", "name", "revision", "published", "covers_from", "pool", "basic_energy_always_legal",
        "pokemon_reprint_inheritance", "bans", "limits", "regulation_marks", "sets"}
_TOP_OPTIONAL = {"excluded_sets", "unsettled_cards", "unsettled_sets", "unsettled_printings", "copy_groups",
                 "exclusive_groups",
                 "excluded_attributes", "single_pokemon_type"}
_LIMITS = {"deck_size", "copies", "basic_energy_exempt", "ace_spec_per_deck", "radiant_per_deck",
           "prism_star_per_name"}
_BAN = {"set", "number", "name", "banned_from"}
_BAN_OPTIONAL = {"lifted_on"}


def second_friday_after(day: date) -> date:
    """The second Friday after ``day``, the Tournament Handbook's legal date for a set released on ``day``."""
    first = day + timedelta(days=(4 - day.weekday()) % 7 or 7)
    return first + timedelta(days=7)


def _keys(table, where, required, optional=frozenset()):
    if not isinstance(table, dict):
        raise FormatRulesError(f"{where}: expected a table")
    missing, unknown = set(required) - table.keys(), table.keys() - set(required) - set(optional)
    if missing:
        raise FormatRulesError(f"{where}: missing {', '.join(sorted(missing))}")
    if unknown:
        raise FormatRulesError(f"{where}: unknown key {', '.join(sorted(unknown))}")
    return table


def _date(value, where):
    if type(value) is not date:  # tomllib returns datetime (a date subclass) for date-times
        raise FormatRulesError(f"{where}: expected a date such as 2026-04-10")
    return value


def _int(value, where, minimum):
    if type(value) is not int or value < minimum:
        raise FormatRulesError(f"{where}: expected an integer of at least {minimum}")
    return value


def _bool(value, where):
    if type(value) is not bool:
        raise FormatRulesError(f"{where}: expected true or false")
    return value


def _text(value, where):
    if not isinstance(value, str) or not value.strip():
        raise FormatRulesError(f"{where}: expected non-empty text")
    return value


def _list(value, where):
    if not isinstance(value, list):
        raise FormatRulesError(f"{where}: expected an array")
    return value


def _identity_groups(raw, key: str) -> tuple[tuple[CopyGroup, ...], dict[str, CopyGroup]]:
    """The ``[[copy_groups]]`` or ``[[exclusive_groups]]`` of a rules file, and each named Card Identity's group: two or
    more Card Identity names per group, each name in at most one group."""
    groups, group_of = [], {}
    for index, entry in enumerate(_list(raw.get(key, []), key)):
        where = f"{key}[{index}]"
        _keys(entry, where, {"names"})
        names = tuple(_text(value, f"{where}.names") for value in _list(entry["names"], f"{where}.names"))
        if len(names) < 2:
            raise FormatRulesError(f"{where}.names: expected at least two Card Identity names")
        group = CopyGroup(names)
        for identity in names:
            if card_identity_key(identity) != identity:
                raise FormatRulesError(f"{where}.names: {identity!r} is not a Card Identity name (no subtitle, ASCII "
                                       "apostrophes)")
            if identity in group_of:
                raise FormatRulesError(f"{where}.names: {identity} listed twice")
            group_of[identity] = group
        groups.append(group)
    return tuple(groups), group_of


def load_rules(data: bytes) -> FormatRules:
    """Parse and validate one rules file's bytes."""
    try:
        raw = tomllib.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise FormatRulesError(f"not a TOML file: {exc}") from exc
    _keys(raw, "rules", _TOP, _TOP_OPTIONAL)
    name = _text(raw["name"], "name")
    published = _date(raw["published"], "published")
    covers_from = _date(raw["covers_from"], "covers_from")
    if covers_from > published:
        raise FormatRulesError("covers_from: later than published")
    if raw["pool"] not in POOLS:
        raise FormatRulesError(f"pool: expected one of {', '.join(POOLS)}")
    limits = _keys(raw["limits"], "limits", _LIMITS)
    limits = Limits(_int(limits["deck_size"], "limits.deck_size", 1), _int(limits["copies"], "limits.copies", 1),
                    _bool(limits["basic_energy_exempt"], "limits.basic_energy_exempt"),
                    _int(limits["ace_spec_per_deck"], "limits.ace_spec_per_deck", 0),
                    _int(limits["radiant_per_deck"], "limits.radiant_per_deck", 0),
                    _int(limits["prism_star_per_name"], "limits.prism_star_per_name", 0))

    marks = {}
    for index, entry in enumerate(_list(raw["regulation_marks"], "regulation_marks")):
        where = f"regulation_marks[{index}]"
        _keys(entry, where, {"mark", "legal_from"}, {"rotates_on"})
        mark = _text(entry["mark"], f"{where}.mark")
        if len(mark) != 1 or not mark.isascii() or not mark.isupper():
            raise FormatRulesError(f"{where}.mark: expected one upper-case letter")
        if mark in marks:
            raise FormatRulesError(f"{where}.mark: {mark} listed twice")
        legal_from = _date(entry["legal_from"], f"{where}.legal_from")
        rotates_on = _date(entry["rotates_on"], f"{where}.rotates_on") if "rotates_on" in entry else None
        if legal_from < covers_from:
            raise FormatRulesError(f"{where}.legal_from: before covers_from (use covers_from)")
        if rotates_on is not None and rotates_on < legal_from:
            raise FormatRulesError(f"{where}.rotates_on: before legal_from")
        marks[mark] = MarkRule(mark, legal_from, rotates_on)

    sets = {}
    for index, entry in enumerate(_list(raw["sets"], "sets")):
        where = f"sets[{index}]"
        _keys(entry, where, {"id", "name", "released", "legal_from", "basis"}, {"reference", "legal_by"})
        set_id = _text(entry["id"], f"{where}.id")
        if set_id in sets:
            raise FormatRulesError(f"{where}.id: {set_id} listed twice")
        released = _date(entry["released"], f"{where}.released")
        legal_from = _date(entry["legal_from"], f"{where}.legal_from")
        basis = entry["basis"]
        if basis not in SET_BASES:
            raise FormatRulesError(f"{where}.basis: expected one of {', '.join(SET_BASES)}")
        if legal_from <= released:
            raise FormatRulesError(f"{where}.legal_from: not after released")
        if legal_from.weekday() != 4:
            raise FormatRulesError(f"{where}.legal_from: not a Friday")
        if basis == "second_friday" and legal_from != second_friday_after(released):
            raise FormatRulesError(f"{where}.legal_from: the second Friday after {released} is "
                                   f"{second_friday_after(released)}")
        if (basis == "announced") != ("reference" in entry):
            raise FormatRulesError(f"{where}.reference: required exactly when basis is announced")
        reference = _text(entry["reference"], f"{where}.reference") if "reference" in entry else None
        if raw["pool"] == "by_set":
            if entry.get("legal_by") not in LEGAL_BY:
                raise FormatRulesError(f"{where}.legal_by: expected one of {', '.join(LEGAL_BY)} in a by_set pool")
            legal_by = entry["legal_by"]
        elif "legal_by" in entry:
            raise FormatRulesError(f"{where}.legal_by: only a by_set pool takes legal_by")
        else:
            legal_by = "mark"
        sets[set_id] = SetRule(set_id, _text(entry["name"], f"{where}.name"), released, legal_from, basis, reference,
                               legal_by)

    exclusions, excluded = [], {}
    for index, entry in enumerate(_list(raw.get("excluded_sets", []), "excluded_sets")):
        where = f"excluded_sets[{index}]"
        _keys(entry, where, {"reason", "noted_on", "sets"})
        ids = tuple(_text(value, f"{where}.sets") for value in _list(entry["sets"], f"{where}.sets"))
        if not ids:
            raise FormatRulesError(f"{where}.sets: empty")
        exclusion = SetExclusion(_text(entry["reason"], f"{where}.reason"),
                                 _date(entry["noted_on"], f"{where}.noted_on"), ids)
        for set_id in ids:
            if set_id in sets or set_id in excluded:
                raise FormatRulesError(f"{where}.sets: {set_id} listed twice")
            excluded[set_id] = exclusion
        exclusions.append(exclusion)

    unsettled_set_groups, unsettled_sets = [], {}
    for index, entry in enumerate(_list(raw.get("unsettled_sets", []), "unsettled_sets")):
        where = f"unsettled_sets[{index}]"
        _keys(entry, where, {"reason", "noted_on", "sets"})
        ids = tuple(_text(value, f"{where}.sets") for value in _list(entry["sets"], f"{where}.sets"))
        if not ids:
            raise FormatRulesError(f"{where}.sets: empty")
        group = SetExclusion(_text(entry["reason"], f"{where}.reason"), _date(entry["noted_on"], f"{where}.noted_on"),
                             ids)
        for set_id in ids:
            if set_id in sets or set_id in excluded or set_id in unsettled_sets:
                raise FormatRulesError(f"{where}.sets: {set_id} listed twice")
            unsettled_sets[set_id] = group
        unsettled_set_groups.append(group)

    unsettled_printings = {}
    for index, entry in enumerate(_list(raw.get("unsettled_printings", []), "unsettled_printings")):
        where = f"unsettled_printings[{index}]"
        _keys(entry, where, {"set", "prefix", "from", "to", "reason", "noted_on"})
        set_id = _text(entry["set"], f"{where}.set")
        if set_id not in sets:
            raise FormatRulesError(f"{where}.set: {set_id} is not in [[sets]]")
        prefix = entry["prefix"]
        if not isinstance(prefix, str) or prefix != prefix.strip():
            raise FormatRulesError(f"{where}.prefix: expected text without surrounding whitespace")
        first = _int(entry["from"], f"{where}.from", 0)
        last = _int(entry["to"], f"{where}.to", first)
        unsettled_printings.setdefault(set_id, []).append(UnsettledPrintings(
            set_id, prefix, first, last, _text(entry["reason"], f"{where}.reason"),
            _date(entry["noted_on"], f"{where}.noted_on")))

    unsettled = {}
    for index, entry in enumerate(_list(raw.get("unsettled_cards", []), "unsettled_cards")):
        where = f"unsettled_cards[{index}]"
        _keys(entry, where, {"identity", "reason", "noted_on"})
        identity = _text(entry["identity"], f"{where}.identity")
        if identity in unsettled:
            raise FormatRulesError(f"{where}.identity: {identity} listed twice")
        unsettled[identity] = UnsettledCard(identity, _text(entry["reason"], f"{where}.reason"),
                                            _date(entry["noted_on"], f"{where}.noted_on"))

    bans = {}
    for index, entry in enumerate(_list(raw["bans"], "bans")):
        where = f"bans[{index}]"
        _keys(entry, where, _BAN, _BAN_OPTIONAL)
        key = (_text(entry["set"], f"{where}.set"), _text(entry["number"], f"{where}.number"))
        if any(part != part.strip() for part in key):
            raise FormatRulesError(f"{where}: set and number must not have surrounding whitespace")
        if key in bans:
            raise FormatRulesError(f"{where}: {key[0]} {key[1]} listed twice")
        banned_from = _date(entry["banned_from"], f"{where}.banned_from")
        lifted_on = _date(entry["lifted_on"], f"{where}.lifted_on") if "lifted_on" in entry else None
        if banned_from < covers_from:
            raise FormatRulesError(f"{where}.banned_from: before covers_from (use covers_from)")
        if lifted_on is not None and lifted_on <= banned_from:
            raise FormatRulesError(f"{where}.lifted_on: not after banned_from")
        bans[key] = BanRule(key[0], key[1], _text(entry["name"], f"{where}.name"), banned_from, lifted_on)

    excluded_attributes = []
    for index, value in enumerate(_list(raw.get("excluded_attributes", []), "excluded_attributes")):
        where = f"excluded_attributes[{index}]"
        if not isinstance(value, str) or value not in EXCLUDABLE:
            raise FormatRulesError(f"{where}: expected one of {', '.join(EXCLUDABLE)}")
        if value in excluded_attributes:
            raise FormatRulesError(f"{where}: {value} listed twice")
        excluded_attributes.append(value)
    # A format that excludes a kind of card outright keeps no per-deck allowance for it.
    if "ace_spec" in excluded_attributes and limits.ace_spec_per_deck != 0:
        raise FormatRulesError("limits.ace_spec_per_deck: must be 0 when ace_spec is excluded")
    if "rule_box" in excluded_attributes and (limits.radiant_per_deck, limits.prism_star_per_name) != (0, 0):
        raise FormatRulesError("limits.radiant_per_deck and limits.prism_star_per_name: must be 0 when rule_box is "
                               "excluded")

    copy_groups, copy_group_of = _identity_groups(raw, "copy_groups")
    exclusive_groups, _ = _identity_groups(raw, "exclusive_groups")

    return FormatRules(format=_text(raw["format"], "format"), name=name,
                       revision=_int(raw["revision"], "revision", 1), published=published, covers_from=covers_from,
                       pool=raw["pool"],
                       basic_energy_always_legal=_bool(raw["basic_energy_always_legal"], "basic_energy_always_legal"),
                       pokemon_reprint_inheritance=_bool(raw["pokemon_reprint_inheritance"],
                                                         "pokemon_reprint_inheritance"),
                       limits=limits, marks=marks, sets=sets, exclusions=tuple(exclusions), excluded=excluded,
                       unsettled=unsettled, bans=bans, sha256=hashlib.sha256(data).hexdigest(),
                       unsettled_set_groups=tuple(unsettled_set_groups), unsettled_sets=unsettled_sets,
                       unsettled_printings={set_id: tuple(found) for set_id, found in unsettled_printings.items()},
                       copy_groups=copy_groups, copy_group_of=copy_group_of, exclusive_groups=exclusive_groups,
                       excluded_attributes=tuple(excluded_attributes),
                       single_pokemon_type=_bool(raw.get("single_pokemon_type", False), "single_pokemon_type"))


@cache
def format_rules(format_name: str) -> FormatRules:
    """The parsed rules file of one format in ``FORMATS``, read once per process."""
    if format_name not in FORMATS:
        raise KeyError(format_name)
    rules = load_rules((RULES_DIR / f"{format_name}.toml").read_bytes())
    if rules.format != format_name:
        raise FormatRulesError(f"{format_name}.toml: format is {rules.format!r}")
    return rules


def rule_dates(rules: FormatRules) -> tuple[date, ...]:
    """Every date on which a result under ``rules`` can change, sorted: ``covers_from``, each regulation mark's
    ``legal_from`` and ``rotates_on``, each set's ``legal_from``, and each ban's ``banned_from`` and ``lifted_on``.

    The evaluator compares the check date only with these dates (``on < d`` or ``d <= on``) and no reason names the
    check date, so two dates with no rule date between them get the same result apart from ``evaluated_on``. Saved
    results rely on this. A rules field that adds a dated fact adds its dates here, and the window test in
    test_format_evaluator.py checks every format's rules file.
    """
    dates = {rules.covers_from}
    for mark in rules.marks.values():
        dates.add(mark.legal_from)
        if mark.rotates_on is not None:
            dates.add(mark.rotates_on)
    dates.update(set_rule.legal_from for set_rule in rules.sets.values())
    for ban in rules.bans.values():
        dates.add(ban.banned_from)
        if ban.lifted_on is not None:
            dates.add(ban.lifted_on)
    return tuple(sorted(dates))


def next_rule_date(rules: FormatRules, on: date) -> date | None:
    """The first rule date after ``on``: a result for ``on`` holds on every date before it. None when no rule date
    follows ``on``."""
    dates = rule_dates(rules)
    index = bisect.bisect_right(dates, on)
    return dates[index] if index < len(dates) else None


# ---------------------------------------------------------------------------------------------------------------------
# Evaluator


@dataclass(frozen=True)
class PrintingFacts:
    """What decides one Card Printing's own legality: its set, collector number and effective card attributes."""
    printing_id: UUID
    set_id: str | None          # None when the active catalog generation has no row for the Printing
    attributes: CardAttributes
    collector_number: str | None = None  # matches ban entries; None like set_id


@dataclass(frozen=True)
class ResolvedLine:
    """One Deck List line resolved to its Card Printing, Card Identity, Reprint Group and attributes."""
    edition_id: UUID
    quantity: int
    identity_id: UUID
    identity_name: str
    printing: PrintingFacts
    reprint_group_id: UUID | None = None  # None when the printing is in no Reprint Group


@dataclass(frozen=True)
class Finding:
    code: str
    reason: str
    violation: bool             # True: not legal; False: a gap, unknown


@dataclass(frozen=True)
class Standing:
    status: Status
    findings: tuple[Finding, ...] = ()


LEGAL = Standing("legal")


@dataclass(frozen=True)
class FormatIssue:
    code: str
    reason: str
    kind: IssueKind
    effect: Literal["not_legal", "unknown"]
    lines: tuple[UUID, ...]     # Deck List lines (Edition IDs) the issue concerns, sorted; empty for date issues


@dataclass(frozen=True)
class FormatResult:
    format: str
    status: Status
    issues: tuple[FormatIssue, ...]
    rules_version: str
    evaluated_on: date


def own_standing(printing: PrintingFacts, identity_name: str, rules: FormatRules, on: date) -> Standing:
    """Whether one Card Printing is in the format's card pool on ``on`` by its own set and regulation mark.

    ``line_standing`` reuses this for every printing of a Reprint Group, so all date logic stays here.
    """
    unsettled = rules.unsettled.get(identity_name)
    if unsettled is not None:
        return Standing("unknown", (Finding(RULES_FACT_UNSETTLED, unsettled.reason, False),))
    attributes = printing.attributes
    if attributes.basic_energy is True and rules.basic_energy_always_legal:
        return LEGAL
    violations, gaps = [], []
    set_id = printing.set_id
    exclusion = rules.excluded.get(set_id) if set_id else None
    unsettled_set = rules.unsettled_sets.get(set_id) if set_id else None
    set_rule = rules.sets.get(set_id) if set_id else None
    unsettled_numbers = next((entry for entry in rules.unsettled_printings.get(set_id, ())
                              if entry.covers(printing.collector_number)), None) if set_rule else None
    if exclusion is not None:
        violations.append(Finding(NOT_IN_CARD_POOL, f"not in the {rules.name} card pool: {exclusion.reason}", True))
    elif unsettled_set is not None:
        gaps.append(Finding(RULES_FACT_UNSETTLED, unsettled_set.reason, False))
    elif set_rule is None:
        gaps.append(Finding(SET_DATE_NOT_RECORDED, f"set legality date not recorded for {set_id or 'an unknown set'}",
                            False))
    elif on < set_rule.legal_from:
        violations.append(Finding(NOT_IN_CARD_POOL, f"{set_rule.name} ({set_id}) not legal in {rules.name} until "
                                                    f"{set_rule.legal_from.isoformat()}", True))
    elif unsettled_numbers is not None:
        gaps.append(Finding(RULES_FACT_UNSETTLED, unsettled_numbers.reason, False))
    # A mark_and_set pool always reads the mark; a by_set pool reads it only for a set that admits by mark.
    by_mark = rules.pool == "mark_and_set" or (set_rule is not None and set_rule.legal_by == "mark")
    if not violations and by_mark and unsettled_set is None and unsettled_numbers is None:
        mark = attributes.regulation_mark
        if mark is None:
            gaps.append(Finding(REGULATION_MARK_NOT_RECORDED, "regulation mark not recorded", False))
        elif mark not in rules.marks:
            gaps.append(Finding(REGULATION_MARK_NOT_IN_RULES, f"regulation mark {mark} not in rules", False))
        elif not rules.marks[mark].legal_on(on):
            # The reason names a rule date, never the check date, so it holds until the next rule date.
            window = rules.marks[mark]
            reason = (f"regulation mark {mark} not legal in {rules.name} until {window.legal_from.isoformat()}"
                      if on < window.legal_from else
                      f"regulation mark {mark} rotated out of {rules.name} on {window.rotates_on.isoformat()}")
            violations.append(Finding(NOT_IN_CARD_POOL, reason, True))
    if violations:
        if attributes.basic_energy is None and rules.basic_energy_always_legal:
            # A Basic Energy would be legal anyway, so an unknown Basic Energy status leaves the card unknown.
            return Standing("unknown", (Finding(ATTRIBUTE_UNKNOWN, "Basic Energy status unknown", False),))
        return Standing("not_legal", tuple(violations))
    return Standing("unknown", tuple(gaps)) if gaps else LEGAL


def _ban(printing: PrintingFacts, rules: FormatRules, on: date) -> BanRule | None:
    if printing.set_id is None or printing.collector_number is None:
        return None
    ban = rules.bans.get((printing.set_id, printing.collector_number))
    return ban if ban is not None and ban.in_force(on) else None


def _label(printing: PrintingFacts) -> str:
    return " ".join(part for part in (printing.set_id, printing.collector_number) if part) or "in an unknown set"


def _reprint_order(printing: PrintingFacts):
    return (printing.set_id or "", printing.collector_number or "", str(printing.printing_id))


def line_standing(line: ResolvedLine, rules: FormatRules, on: date,
                  reprint_groups: Mapping[UUID, Sequence[PrintingFacts]]) -> Standing:
    """A Deck List line's standing in the card pool.

    1. A ban in force on the line's printing, or on any printing in its Reprint Group, makes it not legal. A ban beats
       legality through a reprint.
    2. A printing legal on its own (``own_standing``) is legal.
    3. A Trainer or Energy (and a Pokémon when ``rules.pokemon_reprint_inheritance``) is legal when any other printing
       in its group is legal on its own. If none is, but the printing is not legal on its own and some reprint's
       legality is unknown, it is unknown. A printing whose card kind is unknown is unknown when a reprint could have
       made it legal.
    4. Otherwise the printing's own standing stands.
    """
    printing = line.printing
    group = reprint_groups.get(line.reprint_group_id, ()) if line.reprint_group_id is not None else ()
    reprints = sorted((member for member in group if member.printing_id != printing.printing_id), key=_reprint_order)
    for candidate in (printing, *reprints):
        ban = _ban(candidate, rules, on)
        if ban is not None:
            # A ban already in force when the rules begin carries covers_from as its date, so its reason names none.
            reason = f"banned in {rules.name}"
            if ban.banned_from > rules.covers_from:
                reason += f" from {ban.banned_from.isoformat()}"
            if candidate is not printing:
                reason += f" as an identical reprint of {ban.name} ({ban.set_id} {ban.number})"
            return Standing("not_legal", (Finding(BANNED, reason, True),))
    own = own_standing(printing, line.identity_name, rules, on)
    kind = printing.attributes.card_kind
    if own.status == "legal" or not reprints or kind == "pokemon" and not rules.pokemon_reprint_inheritance:
        return own
    standings = [(reprint, own_standing(reprint, line.identity_name, rules, on)) for reprint in reprints]
    if kind is None:
        if own.status == "not_legal" and any(standing.status != "not_legal" for _, standing in standings):
            return Standing("unknown", (Finding(ATTRIBUTE_UNKNOWN, "card kind unknown", False),))
        return own
    if any(standing.status == "legal" for _, standing in standings):
        return LEGAL
    if own.status == "not_legal":
        for reprint, standing in standings:
            if standing.status == "unknown":
                reason = (f"not legal on its own; identical reprint {_label(reprint)} is unknown: "
                          f"{standing.findings[0].reason}")
                return Standing("unknown", (Finding(REPRINT_LEGALITY_UNKNOWN, reason, False),))
    return own


class _Issues:
    def __init__(self):
        self._lines = defaultdict(set)

    def add(self, code: str, reason: str, kind: IssueKind, violation: bool, lines):
        self._lines[(code, reason, kind, violation)].update(line.edition_id for line in lines)

    def result(self, rules: FormatRules, on: date) -> FormatResult:
        issues = tuple(FormatIssue(code, reason, kind, "not_legal" if violation else "unknown",
                                   tuple(sorted(lines, key=str)))
                       for (code, reason, kind, violation), lines in sorted(
                           self._lines.items(),
                           key=lambda item: (not item[0][3], item[0][2] != "deck", item[0][0], item[0][1])))
        status = ("not_legal" if any(issue.effect == "not_legal" for issue in issues)
                  else "unknown" if issues else "legal")
        return FormatResult(rules.format, status, issues, rules.version, on)


def _quantity(lines) -> int:
    return sum(line.quantity for line in lines)


def _limit(issues: _Issues, lines, attribute: str, limit: int, code: str, too_many: str, unknown: str, kind: IssueKind):
    """At most ``limit`` copies among ``lines`` whose ``attribute`` is true. Copies whose attribute is unknown are a
    gap only when they could break the limit."""
    known = [line for line in lines if getattr(line.printing.attributes, attribute) is True]
    unsure = [line for line in lines if getattr(line.printing.attributes, attribute) is None]
    if _quantity(known) > limit:
        issues.add(code, f"{too_many} ({_quantity(known)})", kind, True, known)
    elif _quantity(known) + _quantity(unsure) > limit:
        issues.add(ATTRIBUTE_UNKNOWN, unknown, "card", False, unsure)


def _basic_pokemon(issues: _Issues, lines, rules: FormatRules):
    """At least one line is a Basic Pokémon. Lines whose Basic Pokémon status is unknown are a gap only when no line is
    a known Basic Pokémon; a known Trainer or Energy is never one, whatever its status says."""
    if any(line.printing.attributes.basic_pokemon is True for line in lines):
        return
    unsure = [line for line in lines if line.printing.attributes.basic_pokemon is None
              and line.printing.attributes.card_kind not in ("trainer", "energy")]
    if unsure:
        issues.add(ATTRIBUTE_UNKNOWN, "Basic Pokémon status unknown", "card", False, unsure)
    else:
        issues.add(NO_BASIC_POKEMON, f"{_a(rules.name)} {rules.name} deck has at least one Basic Pokémon; this one has "
                                     "none", "deck", True, lines)


def _exclusions(issues: _Issues, line: ResolvedLine, rules: FormatRules):
    """A card whose excluded attribute is true is not legal; one whose excluded attribute is unknown is a gap."""
    for attribute in rules.excluded_attributes:
        code, cards, unknown = EXCLUDABLE[attribute]
        value = getattr(line.printing.attributes, attribute)
        if value is True:
            issues.add(code, f"{cards} are not allowed in {rules.name}", "card", True, (line,))
        elif value is None:
            issues.add(ATTRIBUTE_UNKNOWN, unknown, "card", False, (line,))


def _single_type(issues: _Issues, lines, rules: FormatRules):
    """Every Pokémon shares at least one type. A dual-type Pokémon fits either of its types; Colorless is a type like
    any other. A Pokémon of unknown type, or a card of unknown kind, is a gap only when the deck has another Pokémon it
    could clash with and the known Pokémon do share a type."""
    pokemon = [line for line in lines if line.printing.attributes.card_kind == "pokemon"]
    typed = [line for line in pokemon if line.printing.attributes.types]
    untyped = [line for line in pokemon if not line.printing.attributes.types]
    unknown_kind = [line for line in lines if line.printing.attributes.card_kind is None]
    shared = set.intersection(*(set(line.printing.attributes.types) for line in typed)) if typed else None
    if shared is not None and not shared:
        issues.add(SINGLE_TYPE, f"every Pokémon in {_a(rules.name)} {rules.name} deck shares one type; these Pokémon "
                                "have no type in common", "deck", True, typed)
    elif len(typed) + len(untyped) + len(unknown_kind) > 1:
        if untyped:
            issues.add(ATTRIBUTE_UNKNOWN, "Pokémon type unknown", "card", False, untyped)
        if unknown_kind:
            issues.add(ATTRIBUTE_UNKNOWN, "card kind unknown", "card", False, unknown_kind)


def evaluate_format(lines: Sequence[ResolvedLine], rules: FormatRules, on: date,
                    reprint_groups: Mapping[UUID, Sequence[PrintingFacts]] | None = None) -> FormatResult:
    """Check resolved Deck List lines against one format's rules on ``on``.

    ``reprint_groups`` maps a Reprint Group ID to the facts of its printings (the line's own printing may be among
    them); a line whose group is missing from it is judged on its own printing.
    """
    issues = _Issues()
    if on < rules.covers_from:
        issues.add(BEFORE_RULES_COVERAGE, f"{rules.name} rules start on {rules.covers_from.isoformat()}; earlier "
                                          "dates are unknown", "deck", False, ())
        return issues.result(rules, on)
    limits = rules.limits
    total = _quantity(lines)
    if total != limits.deck_size:
        issues.add(DECK_SIZE, f"{_a(rules.name)} {rules.name} deck has exactly {limits.deck_size} cards; this one has "
                              f"{total}", "deck", True, lines)
    _basic_pokemon(issues, lines, rules)
    for line in lines:
        for finding in line_standing(line, rules, on, reprint_groups or {}).findings:
            issues.add(finding.code, finding.reason, "card", finding.violation, (line,))
        _exclusions(issues, line, rules)
    # Copies count by Card Identity, or by copy group for the identities in one.
    copies = defaultdict(list)
    for line in lines:
        copies[rules.copy_group_of.get(line.identity_name, line.identity_id)].append(line)
    noun = "copy" if limits.copies == 1 else "copies"
    for key, group in copies.items():
        name = key.label if isinstance(key, CopyGroup) else group[0].identity_name
        if limits.basic_energy_exempt:
            counted = [line for line in group if line.printing.attributes.basic_energy is False]
            unsure = [line for line in group if line.printing.attributes.basic_energy is None]
        else:
            counted, unsure = group, []
        if _quantity(counted) > limits.copies:
            issues.add(COPY_LIMIT, f"more than {limits.copies} {noun} of {name} ({_quantity(counted)})", "card",
                       True, counted)
        elif _quantity(counted) + _quantity(unsure) > limits.copies:
            issues.add(ATTRIBUTE_UNKNOWN, "Basic Energy status unknown", "card", False, unsure)
    # Per-deck limits a format's exclusions already cover are skipped: an excluded card is reported once, per card.
    if "rule_box" not in rules.excluded_attributes:
        identities = defaultdict(list)
        for line in lines:
            identities[line.identity_id].append(line)
        for group in identities.values():
            _limit(issues, group, "prism_star", limits.prism_star_per_name, PRISM_STAR_LIMIT,
                   f"more than {limits.prism_star_per_name} Prism Star {group[0].identity_name}",
                   "Prism Star status unknown", "card")
        _limit(issues, lines, "radiant", limits.radiant_per_deck, RADIANT_LIMIT,
               f"more than {limits.radiant_per_deck} Radiant Pokémon in the deck", "Radiant status unknown", "deck")
    if "ace_spec" not in rules.excluded_attributes:
        _limit(issues, lines, "ace_spec", limits.ace_spec_per_deck, ACE_SPEC_LIMIT,
               f"more than {limits.ace_spec_per_deck} ACE SPEC in the deck", "ACE SPEC status unknown", "deck")
    for group in rules.exclusive_groups:
        found = [line for line in lines if line.identity_name in group.names]
        if len({line.identity_name for line in found}) > 1:
            issues.add(EXCLUSIVE_CARDS, f"{_a(rules.name)} {rules.name} deck may hold only one of {group.label}",
                       "deck", True, found)
    if rules.single_pokemon_type:
        _single_type(issues, lines, rules)
    return issues.result(rules, on)
