"""Format Rules files and the pure format evaluator (ADR 0010).

Each format's rules live in ``format_rules/<format>.toml`` beside this module, maintained by commit. ``load_rules``
parses and validates one file; ``format_rules`` caches the parsed file per format. The rules version a result
reports is the file's revision and publication date.

``evaluate_format`` checks resolved Deck List lines against one format's rules on one date. Like the construction
checks, it is pure: it reads no database and no network, so private Decks and, later, Published Decks share it.

A result is advisory. Any definite violation makes it ``not_legal``; otherwise any gap in the rules or the card data
makes it ``unknown``; otherwise it is ``legal``. A gap is reported only when the missing fact could change the answer:
an unknown ACE SPEC status matters only if it could put the deck over its ACE SPEC limit.
"""
import hashlib
import tomllib
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from functools import cache
from pathlib import Path
from typing import Literal
from uuid import UUID

from .card_attributes import CardAttributes

RULES_DIR = Path(__file__).resolve().parent / "format_rules"
# Formats with a rules file, in response order. Expanded (ticket 15) and Gym Leader Challenge (ticket 16) add theirs.
FORMATS = ("standard",)

Status = Literal["legal", "not_legal", "unknown"]
IssueKind = Literal["deck", "card"]

# Stable issue codes. Violations make a result not_legal:
DECK_SIZE = "deck_size"
NOT_IN_CARD_POOL = "not_in_card_pool"
COPY_LIMIT = "copy_limit"
ACE_SPEC_LIMIT = "ace_spec_limit"
RADIANT_LIMIT = "radiant_limit"
PRISM_STAR_LIMIT = "prism_star_limit"
# Gaps make a result unknown:
SET_DATE_NOT_RECORDED = "set_date_not_recorded"
REGULATION_MARK_NOT_RECORDED = "regulation_mark_not_recorded"
REGULATION_MARK_NOT_IN_RULES = "regulation_mark_not_in_rules"
ATTRIBUTE_UNKNOWN = "attribute_unknown"
RULES_FACT_UNSETTLED = "rules_fact_unsettled"
BEFORE_RULES_COVERAGE = "before_rules_coverage"


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


@dataclass(frozen=True)
class SetExclusion:
    reason: str
    noted_on: date
    set_ids: tuple[str, ...]


@dataclass(frozen=True)
class UnsettledCard:
    identity: str               # Card Identity name
    reason: str
    noted_on: date


@dataclass(frozen=True)
class Limits:
    deck_size: int              # exact
    copies: int                 # per Card Identity
    basic_energy_exempt: bool   # from the copy limit
    ace_spec_per_deck: int
    radiant_per_deck: int
    prism_star_per_name: int    # per Card Identity


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
    sha256: str                                 # of the file bytes

    @property
    def version(self) -> str:
        return f"{self.revision} ({self.published.isoformat()})"


POOLS = ("mark_and_set",)
SET_BASES = ("second_friday", "announced")
_TOP = {"format", "name", "revision", "published", "covers_from", "pool", "basic_energy_always_legal",
        "pokemon_reprint_inheritance", "bans", "limits", "regulation_marks", "sets"}
_TOP_OPTIONAL = {"excluded_sets", "unsettled_cards"}
_LIMITS = {"deck_size", "copies", "basic_energy_exempt", "ace_spec_per_deck", "radiant_per_deck",
           "prism_star_per_name"}


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
    if _list(raw["bans"], "bans"):
        raise FormatRulesError("bans: ban lists are not supported yet (Expanded, ticket 15)")
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
        _keys(entry, where, {"id", "name", "released", "legal_from", "basis"}, {"reference"})
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
        sets[set_id] = SetRule(set_id, _text(entry["name"], f"{where}.name"), released, legal_from, basis, reference)

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

    unsettled = {}
    for index, entry in enumerate(_list(raw.get("unsettled_cards", []), "unsettled_cards")):
        where = f"unsettled_cards[{index}]"
        _keys(entry, where, {"identity", "reason", "noted_on"})
        identity = _text(entry["identity"], f"{where}.identity")
        if identity in unsettled:
            raise FormatRulesError(f"{where}.identity: {identity} listed twice")
        unsettled[identity] = UnsettledCard(identity, _text(entry["reason"], f"{where}.reason"),
                                            _date(entry["noted_on"], f"{where}.noted_on"))

    return FormatRules(format=_text(raw["format"], "format"), name=name,
                       revision=_int(raw["revision"], "revision", 1), published=published, covers_from=covers_from,
                       pool=raw["pool"],
                       basic_energy_always_legal=_bool(raw["basic_energy_always_legal"], "basic_energy_always_legal"),
                       pokemon_reprint_inheritance=_bool(raw["pokemon_reprint_inheritance"],
                                                         "pokemon_reprint_inheritance"),
                       limits=limits, marks=marks, sets=sets, exclusions=tuple(exclusions), excluded=excluded,
                       unsettled=unsettled, sha256=hashlib.sha256(data).hexdigest())


@cache
def format_rules(format_name: str) -> FormatRules:
    """The parsed rules file of one format in ``FORMATS``, read once per process."""
    if format_name not in FORMATS:
        raise KeyError(format_name)
    rules = load_rules((RULES_DIR / f"{format_name}.toml").read_bytes())
    if rules.format != format_name:
        raise FormatRulesError(f"{format_name}.toml: format is {rules.format!r}")
    return rules


# ---------------------------------------------------------------------------------------------------------------------
# Evaluator


@dataclass(frozen=True)
class PrintingFacts:
    """What decides one Card Printing's own legality: its set and its effective card attributes."""
    printing_id: UUID
    set_id: str | None          # None when the active catalog generation has no row for the Printing
    attributes: CardAttributes


@dataclass(frozen=True)
class ResolvedLine:
    """One Deck List line resolved to its Card Printing, Card Identity and attributes."""
    edition_id: UUID
    quantity: int
    identity_id: UUID
    identity_name: str
    printing: PrintingFacts
    # Reprint Groups arrive with ticket 13. Until then every line has None and ``reprint_groups`` is empty.
    reprint_group_id: UUID | None = None


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

    Ticket 13 reuses this for every printing of a Reprint Group, so all date logic stays here.
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
    set_rule = rules.sets.get(set_id) if set_id else None
    if exclusion is not None:
        violations.append(Finding(NOT_IN_CARD_POOL, f"not in the {rules.name} card pool: {exclusion.reason}", True))
    elif set_rule is None:
        gaps.append(Finding(SET_DATE_NOT_RECORDED, f"set legality date not recorded for {set_id or 'an unknown set'}",
                            False))
    elif on < set_rule.legal_from:
        violations.append(Finding(NOT_IN_CARD_POOL, f"{set_rule.name} ({set_id}) not legal in {rules.name} until "
                                                    f"{set_rule.legal_from.isoformat()}", True))
    if not violations:
        mark = attributes.regulation_mark
        if mark is None:
            gaps.append(Finding(REGULATION_MARK_NOT_RECORDED, "regulation mark not recorded", False))
        elif mark not in rules.marks:
            gaps.append(Finding(REGULATION_MARK_NOT_IN_RULES, f"regulation mark {mark} not in rules", False))
        elif not rules.marks[mark].legal_on(on):
            violations.append(Finding(NOT_IN_CARD_POOL, f"regulation mark {mark} not legal in {rules.name} on "
                                                        f"{on.isoformat()}", True))
    if violations:
        if attributes.basic_energy is None and rules.basic_energy_always_legal:
            # A Basic Energy would be legal anyway, so an unknown Basic Energy status leaves the card unknown.
            return Standing("unknown", (Finding(ATTRIBUTE_UNKNOWN, "Basic Energy status unknown", False),))
        return Standing("not_legal", tuple(violations))
    return Standing("unknown", tuple(gaps)) if gaps else LEGAL


def line_standing(line: ResolvedLine, rules: FormatRules, on: date,
                  reprint_groups: Mapping[UUID, Sequence[PrintingFacts]]) -> Standing:
    """A Deck List line's standing in the card pool.

    Ticket 13 extends only this function: when the line's printing is not legal on its own, a Trainer or Energy (and a
    Pokémon when ``rules.pokemon_reprint_inheritance``) is legal if ``own_standing`` finds any printing in
    ``reprint_groups[line.reprint_group_id]`` legal.
    """
    return own_standing(line.printing, line.identity_name, rules, on)


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


def evaluate_format(lines: Sequence[ResolvedLine], rules: FormatRules, on: date,
                    reprint_groups: Mapping[UUID, Sequence[PrintingFacts]] | None = None) -> FormatResult:
    """Check resolved Deck List lines against one format's rules on ``on``.

    ``reprint_groups`` maps a Reprint Group ID to the facts of its printings; it is empty until ticket 13.
    """
    issues = _Issues()
    if on < rules.covers_from:
        issues.add(BEFORE_RULES_COVERAGE, f"{rules.name} rules start on {rules.covers_from.isoformat()}; earlier "
                                          "dates are unknown", "deck", False, ())
        return issues.result(rules, on)
    limits = rules.limits
    total = _quantity(lines)
    if total != limits.deck_size:
        issues.add(DECK_SIZE, f"a {rules.name} deck has exactly {limits.deck_size} cards; this one has {total}",
                   "deck", True, lines)
    for line in lines:
        for finding in line_standing(line, rules, on, reprint_groups or {}).findings:
            issues.add(finding.code, finding.reason, "card", finding.violation, (line,))
    identities = defaultdict(list)
    for line in lines:
        identities[line.identity_id].append(line)
    for group in identities.values():
        name = group[0].identity_name
        if limits.basic_energy_exempt:
            counted = [line for line in group if line.printing.attributes.basic_energy is False]
            unsure = [line for line in group if line.printing.attributes.basic_energy is None]
        else:
            counted, unsure = group, []
        if _quantity(counted) > limits.copies:
            issues.add(COPY_LIMIT, f"more than {limits.copies} copies of {name} ({_quantity(counted)})", "card",
                       True, counted)
        elif _quantity(counted) + _quantity(unsure) > limits.copies:
            issues.add(ATTRIBUTE_UNKNOWN, "Basic Energy status unknown", "card", False, unsure)
        _limit(issues, group, "prism_star", limits.prism_star_per_name, PRISM_STAR_LIMIT,
               f"more than {limits.prism_star_per_name} Prism Star {name}", "Prism Star status unknown", "card")
    _limit(issues, lines, "ace_spec", limits.ace_spec_per_deck, ACE_SPEC_LIMIT,
           f"more than {limits.ace_spec_per_deck} ACE SPEC in the deck", "ACE SPEC status unknown", "deck")
    _limit(issues, lines, "radiant", limits.radiant_per_deck, RADIANT_LIMIT,
           f"more than {limits.radiant_per_deck} Radiant Pokémon in the deck", "Radiant status unknown", "deck")
    return issues.result(rules, on)
