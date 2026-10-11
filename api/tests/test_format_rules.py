"""The rules-file check in the test gate (Deck Lists 12, issue #93; ban entries, Deck Lists 13, issue #94).

Every rules file in api/app/format_rules parses, every entry is dated, and every imported set has a legal-from date or
an explicit exclusion. No database: these tests run with plain pytest.
"""
from datetime import date

import pytest

from app.card_attributes import CardAttributeRules
from app.format_evaluator import FORMATS, RULES_DIR, FormatRulesError, format_rules, load_rules, second_friday_after

# Editing a rules file changes its digest: bump its `revision`, set `published`, and pin the new pair here.
PINNED_RULES = {"standard": (1, "bc0d234758d673925a6da168317a4ecfef28d9fbafc297b4e1c50ba7026aff98")}


def imported_sets() -> set[str]:
    """Set IDs from api/app/format_rules/imported_sets.txt, the committed list of imported sets."""
    rows = (row for row in (RULES_DIR / "imported_sets.txt").read_text().splitlines() if row and not row.startswith("#"))
    return {row.split("\t")[0] for row in rows}


def test_every_rules_file_parses_and_is_pinned():
    assert sorted(path.stem for path in RULES_DIR.glob("*.toml")) == sorted(FORMATS)
    for name in FORMATS:
        rules = format_rules(name)
        assert rules.format == name
        assert (rules.revision, rules.sha256) == PINNED_RULES[name], f"{name}.toml changed: bump revision and re-pin"


def test_every_imported_set_has_a_legal_from_date_or_an_exclusion():
    imported = imported_sets()
    assert len(imported) == 201
    assert imported == set(CardAttributeRules.ACE_SPEC_SETTLED_SETS)
    for name in FORMATS:
        rules = format_rules(name)
        listed = rules.sets.keys() | rules.excluded.keys()
        assert not rules.sets.keys() & rules.excluded.keys()
        assert sorted(imported - listed) == [], f"{name}.toml: imported sets without a legal-from date or exclusion"
        assert sorted(listed - imported) == [], f"{name}.toml: sets not in imported_sets.txt"


def test_every_entry_is_dated():
    for name in FORMATS:
        rules = format_rules(name)
        assert rules.covers_from <= rules.published
        for mark in rules.marks.values():
            assert type(mark.legal_from) is date and rules.covers_from <= mark.legal_from
            assert mark.rotates_on is None or type(mark.rotates_on) is date
        for entry in rules.sets.values():
            assert type(entry.released) is date and type(entry.legal_from) is date
            assert entry.legal_from.weekday() == 4 and entry.legal_from > entry.released
            if entry.basis == "second_friday":
                assert entry.legal_from == second_friday_after(entry.released), entry.set_id
            else:
                assert entry.reference, entry.set_id
        for entry in (*rules.exclusions, *rules.unsettled.values()):
            assert type(entry.noted_on) is date and entry.noted_on <= rules.published
        for ban in rules.bans.values():
            assert type(ban.banned_from) is date and rules.covers_from <= ban.banned_from
            assert ban.lifted_on is None or (type(ban.lifted_on) is date and ban.banned_from < ban.lifted_on)


def test_standard_rules_hold_the_settled_facts():
    rules = format_rules("standard")
    assert rules.version == f"{rules.revision} ({rules.published.isoformat()})"
    windows = {mark: (rule.legal_from, rule.rotates_on) for mark, rule in rules.marks.items()}
    assert windows == {
        "D": (date(2025, 4, 11), date(2025, 4, 11)), "E": (date(2025, 4, 11), date(2025, 4, 11)),
        "F": (date(2025, 4, 11), date(2025, 4, 11)), "G": (date(2025, 4, 11), date(2026, 4, 10)),
        "H": (date(2025, 4, 11), None), "I": (date(2025, 4, 11), None), "J": (date(2026, 3, 6), None)}
    limits = rules.limits
    assert (limits.deck_size, limits.copies, limits.basic_energy_exempt, limits.ace_spec_per_deck,
            limits.radiant_per_deck, limits.prism_star_per_name) == (60, 4, True, 1, 1, 1)
    assert rules.pokemon_reprint_inheritance is False and rules.basic_energy_always_legal is True
    assert {set_id: rules.sets[set_id].legal_from for set_id in ("sv09", "me02.5", "me03", "me04", "me05")} == {
        "sv09": date(2025, 4, 11), "me02.5": date(2026, 3, 6), "me03": date(2026, 4, 10),
        "me04": date(2026, 6, 5), "me05": date(2026, 7, 31)}
    assert set(rules.unsettled) == {"Fairy Energy"}
    assert rules.bans == {}  # No card is banned in Standard.


def test_second_friday_after_a_release():
    assert second_friday_after(date(2026, 3, 27)) == date(2026, 4, 10)    # a Friday release
    assert second_friday_after(date(2026, 9, 16)) == date(2026, 9, 25)    # a Wednesday release
    assert second_friday_after(date(2025, 7, 17)) == date(2025, 7, 25)    # a Thursday release


STANDARD = (RULES_DIR / "standard.toml").read_text()


@pytest.mark.parametrize("old, new, message", [
    ("revision = 1\n", "revision = 1\nedition = 2\n", "unknown key edition"),
    ("published = 2026-10-11\n", "", "missing published"),
    ('id = "sv02"', 'id = "sv01"', "sv01 listed twice"),
    ('"swsh1", ', '"swsh1", "sv01", ', "sv01 listed twice"),
    ("legal_from = 2023-06-23", "legal_from = 2023-06-30", "second Friday after 2023-06-09 is 2023-06-23"),
    ("legal_from = 2026-03-06\nbasis", "legal_from = 2026-03-07\nbasis", "not a Friday"),
    ("rotates_on = 2026-04-10", "rotates_on = 2025-01-01", "rotates_on: before legal_from"),
    ("bans = []", 'bans = [{ set = "sv01", number = "1" }]', "missing banned_from, name"),
    ("bans = []", 'bans = [{ set = "sv01", number = "1", name = "X", banned_from = 2026-01-02, reason = "x" }]',
     "unknown key reason"),
    ("bans = []", 'bans = [{ set = "sv01", number = "1", name = "X", banned_from = 2025-01-02 }]',
     "banned_from: before covers_from"),
    ("bans = []", 'bans = [{ set = "sv01", number = "1", name = "X", banned_from = 2026-01-02, '
                  'lifted_on = 2026-01-02 }]', "lifted_on: not after banned_from"),
    ("bans = []", 'bans = [{ set = "sv01", number = "1", name = "X", banned_from = 2026-01-02 }, '
                  '{ set = "sv01", number = "1", name = "Y", banned_from = 2026-02-06 }]', "sv01 1 listed twice"),
    ("bans = []", 'bans = [{ set = "sv01", number = 1, name = "X", banned_from = 2026-01-02 }]',
     "number: expected non-empty text"),
    ("bans = []", 'bans = [{ set = "sv01 ", number = "1", name = "X", banned_from = 2026-01-02 }]',
     "must not have surrounding whitespace"),
    ("published = 2026-10-11", "published = 2026-10-11T00:00:00", "published: expected a date"),
    ('pool = "mark_and_set"', 'pool = "anything"', "pool: expected one of"),
    ('mark = "H"', 'mark = "h"', "one upper-case letter"),
    ("[limits]", "[limits", "not a TOML file"),
])
def test_the_loader_rejects_broken_rules_files(old, new, message):
    assert old in STANDARD
    with pytest.raises(FormatRulesError, match=message):
        load_rules(STANDARD.replace(old, new, 1).encode())
