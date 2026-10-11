"""The rules-file check in the test gate (Deck Lists 12, issue #93; ban entries, Deck Lists 13, issue #94; Expanded,
Deck Lists 15, issue #96; Gym Leader Challenge, Deck Lists 16, issue #97).

Every rules file in api/app/format_rules parses, every entry is dated, and every imported set has a legal-from date or
an explicit exclusion. No database: these tests run with plain pytest.
"""
from datetime import date

import pytest

from app.card_attributes import CardAttributeRules
from app.format_evaluator import FORMATS, RULES_DIR, FormatRulesError, format_rules, load_rules, second_friday_after

# Editing a rules file changes its digest: bump its `revision`, set `published`, and pin the new pair here.
PINNED_RULES = {"standard": (1, "bc0d234758d673925a6da168317a4ecfef28d9fbafc297b4e1c50ba7026aff98"),
                "expanded": (2, "6151d5e9612ea3c58ea9fc8fe99836d160357d2949758158a96960daabfbc431"),
                "glc": (1, "4315377a8f58f031935bf9bab311b5ddd1f30c926f0d50e75fa19d4014f84f3d")}


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
        listed = rules.sets.keys() | rules.excluded.keys() | rules.unsettled_sets.keys()
        assert len(listed) == len(rules.sets) + len(rules.excluded) + len(rules.unsettled_sets)
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
        printing_ranges = [entry for entries in rules.unsettled_printings.values() for entry in entries]
        for entry in (*rules.exclusions, *rules.unsettled.values(), *rules.unsettled_set_groups, *printing_ranges):
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


def test_every_ban_names_a_printing_in_a_dated_imported_set():
    imported = imported_sets()
    for name in FORMATS:
        rules = format_rules(name)
        for set_id, number in rules.bans:
            assert set_id in imported and set_id in rules.sets, (name, set_id, number)


EXPANDED_BANS = {
    ("bw3", "67"), ("bw5", "110"), ("sm10", "165"), ("xy9", "98"), ("xy9", "98a"), ("xy9", "98b"), ("sm12", "83"),
    ("sm6", "83"), ("swsh2", "22"), ("swsh4.5sv", "SV013"), ("swsh10tg", "TG02"), ("swshp", "SWSH022"), ("xy7", "74"),
    ("bw9", "101"), ("bw9", "115"), ("xy7", "75"), ("xy7", "75a"), ("sm12", "194"), ("sm12", "265"), ("sm115", "58"),
    ("sm115", "68"), ("sm10", "178"), ("sm115", "60"), ("xy4", "99"), ("xy4", "118"), ("sm3.5", "45"), ("smp", "SM85"),
    ("xy5", "133"), ("xy5", "158"), ("swsh7", "83"), ("swsh7", "185"), ("swsh7", "186"), ("xy2", "23"), ("sm10", "78"),
    ("sm5", "114"), ("xy9", "109"), ("xy1", "124"), ("g1", "71"), ("sm11", "206"), ("sm11", "206a"), ("sm11", "253"),
    ("bw5", "62"), ("swsh2", "165"), ("swsh2", "207"), ("xy6", "77"), ("xy6", "77a"), ("xy6", "106"), ("sm8", "90"),
    ("sm8", "91")}


def test_expanded_rules_hold_the_settled_facts():
    rules = format_rules("expanded")
    assert (rules.name, rules.pool, rules.covers_from, rules.version) == (
        "Expanded", "by_set", date(2026, 4, 10), "2 (2026-10-11)")
    # Official "cannot be in the same deck" rulings (2020), not a shared copy count.
    assert [group.names for group in rules.exclusive_groups] == [
        ("Boss's Orders", "Lysandre"), ("Professor's Research", "Professor Sycamore", "Professor Juniper")]
    assert rules.copy_groups == ()
    assert {mark: (rule.legal_from, rule.rotates_on) for mark, rule in rules.marks.items()} == {
        mark: (date(2026, 4, 10), None) for mark in "DEFGHIJ"}
    limits = rules.limits
    assert (limits.deck_size, limits.copies, limits.basic_energy_exempt, limits.ace_spec_per_deck,
            limits.radiant_per_deck, limits.prism_star_per_name) == (60, 4, True, 1, 1, 1)
    assert rules.pokemon_reprint_inheritance is False and rules.basic_energy_always_legal is True
    by_set = {set_id for set_id, set_rule in rules.sets.items() if set_rule.legal_by == "set"}
    by_mark = {set_id for set_id, set_rule in rules.sets.items() if set_rule.legal_by == "mark"}
    assert {"bw1", "bw10", "bw11", "dv1", "bwp", "xy0", "xya", "xyp", "dc1", "g1", "sm115", "sma", "smp", "det1",
            "2011bw", "2021swsh", "tk-bw-e", "tk-bw-z", "tk-sm-l", "tk-sm-r"} <= by_set
    assert {"swsh1", "swshp", "cel25", "fut2020", "2022swsh", "2023sv", "2024sv", "sv01", "svp", "me01", "mep",
            "30th"} <= by_mark
    assert len(by_set) == 69 and len(by_mark) == 56
    assert set(rules.unsettled_sets) == {"cel25cc", "30th-c"}
    assert {"col1", "hgss4", "hgssp", "miscp", "tk-hs-g", "tk-dp-l", "tk-ex-p", "base1"} <= set(rules.excluded)
    assert [(entry.prefix, entry.first, entry.last) for entry in rules.unsettled_printings["smp"]] == [("SM", 1, 157)]
    assert set(rules.bans) == EXPANDED_BANS
    assert {ban.banned_from for ban in rules.bans.values()} == {date(2026, 4, 10)}
    assert all(ban.lifted_on is None for ban in rules.bans.values())
    assert {set_id: rules.sets[set_id].legal_from for set_id in ("me02.5", "me04", "me05", "30th")} == {
        "me02.5": date(2026, 3, 6), "me04": date(2026, 6, 5), "me05": date(2026, 7, 31), "30th": date(2026, 9, 25)}
    assert rules.unsettled == {}


GLC_BANS = {
    ("xy4", "99"): date(2025, 4, 24), ("xy4", "118"): date(2025, 4, 24), ("sm5", "114"): date(2025, 4, 24),
    ("xy7", "74"): date(2025, 4, 24), ("sm10", "165"): date(2025, 4, 24), ("sm7", "133"): date(2025, 4, 24),
    ("sma", "SV85"): date(2025, 4, 24), ("swsh4.5", "21"): date(2025, 4, 24), ("sm11", "205"): date(2025, 4, 24),
    ("swsh4", "50"): date(2025, 4, 24), ("sm3.5", "45"): date(2025, 4, 24), ("smp", "SM85"): date(2025, 4, 24),
    ("sm12", "83"): date(2025, 4, 24), ("sm3.5", "69"): date(2025, 4, 24), ("bw4", "92"): date(2025, 4, 24),
    ("bw11", "113"): date(2025, 4, 24), ("xy1", "130"): date(2025, 4, 24), ("xy4", "111"): date(2025, 4, 24),
    ("g1", "74"): date(2025, 4, 24), ("xy10", "114"): date(2025, 4, 24), ("xy12", "90"): date(2025, 4, 24),
    ("sm1", "136"): date(2025, 4, 24), ("sm2", "166"): date(2025, 4, 24), ("swsh2", "174"): date(2025, 4, 24),
    ("swsh2", "209"): date(2025, 4, 24), ("xy4", "93"): date(2026, 4, 20)}


def test_glc_rules_hold_the_settled_facts():
    rules = format_rules("glc")
    assert (rules.name, rules.pool, rules.covers_from, rules.version) == (
        "Gym Leader Challenge", "by_set", date(2025, 4, 24), "1 (2026-10-11)")
    assert rules.exclusive_groups == ()  # One shared copy per group already keeps them apart.
    assert rules.marks == {}
    limits = rules.limits
    assert (limits.deck_size, limits.copies, limits.basic_energy_exempt, limits.ace_spec_per_deck,
            limits.radiant_per_deck, limits.prism_star_per_name) == (60, 1, True, 0, 0, 0)
    assert rules.pokemon_reprint_inheritance is False and rules.basic_energy_always_legal is True
    assert (rules.excluded_attributes, rules.single_pokemon_type) == (("rule_box", "ace_spec"), True)
    assert [group.names for group in rules.copy_groups] == [
        ("Boss's Orders", "Lysandre"), ("Professor's Research", "Professor Sycamore", "Professor Juniper")]
    # Expanded's dated sets, all admitted by set, except the products Expanded admits only by an unrecorded mark.
    mark_only = {"mfb", "2022swsh", "2023sv", "2024sv"}
    assert {set_rule.legal_by for set_rule in rules.sets.values()} == {"set"} and len(rules.sets) == 121
    assert set(rules.sets) == set(format_rules("expanded").sets) - mark_only
    assert set(rules.unsettled_sets) == {"cel25cc", "30th-c"} | mark_only
    assert set(rules.excluded) == set(format_rules("expanded").excluded)
    assert {key: ban.banned_from for key, ban in rules.bans.items()} == GLC_BANS
    assert all(ban.lifted_on is None for ban in rules.bans.values())
    assert rules.unsettled == {} and rules.unsettled_printings == {}


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


EXPANDED = (RULES_DIR / "expanded.toml").read_text()


@pytest.mark.parametrize("old, new, message", [
    ('pool = "by_set"', 'pool = "mark_and_set"', "only a by_set pool takes legal_by"),
    ('legal_by = "set"\n', 'legal_by = "both"\n', "legal_by: expected one of set, mark"),
    ('legal_by = "set"\n', "", "legal_by: expected one of set, mark"),
    ('sets = ["cel25cc", "30th-c"]', 'sets = ["cel25cc", "bw1"]', "bw1 listed twice"),
    ('sets = ["cel25cc", "30th-c"]', 'sets = []', "unsettled_sets\\[0\\].sets: empty"),
    ('[[unsettled_printings]]\nset = "smp"', '[[unsettled_printings]]\nset = "smx"',
     "smx is not in \\[\\[sets\\]\\]"),
    ('to = 157', 'to = 0', "to: expected an integer of at least 1"),
    ('prefix = "SM"', 'prefix = " SM"', "prefix: expected text without surrounding whitespace"),
    ('noted_on = 2026-10-11\n\n[[excluded_sets]]', 'noted_on = 2026-10-11\nextra = 1\n\n[[excluded_sets]]',
     "unknown key extra"),
    ('names = ["Boss\'s Orders", "Lysandre"]', 'names = ["Boss\'s Orders"]',
     "exclusive_groups\\[0\\].names: expected at least two Card Identity names"),
    ('names = ["Boss\'s Orders", "Lysandre"]', 'names = ["Boss\'s Orders (Ghetsis)", "Lysandre"]',
     "is not a Card Identity name"),
    ('"Professor Juniper"]', '"Lysandre"]', "exclusive_groups\\[1\\].names: Lysandre listed twice"),
])
def test_the_loader_rejects_broken_expanded_rules(old, new, message):
    assert old in EXPANDED
    with pytest.raises(FormatRulesError, match=message):
        load_rules(EXPANDED.replace(old, new, 1).encode())


GLC = (RULES_DIR / "glc.toml").read_text()


@pytest.mark.parametrize("old, new, message", [
    ('excluded_attributes = ["rule_box", "ace_spec"]', 'excluded_attributes = ["rule_box", "radiant"]',
     "excluded_attributes\\[1\\]: expected one of rule_box, ace_spec"),
    ('excluded_attributes = ["rule_box", "ace_spec"]', 'excluded_attributes = ["rule_box", "rule_box"]',
     "rule_box listed twice"),
    ("ace_spec_per_deck = 0", "ace_spec_per_deck = 1", "must be 0 when ace_spec is excluded"),
    ("radiant_per_deck = 0", "radiant_per_deck = 1", "must be 0 when rule_box is excluded"),
    ("single_pokemon_type = true", 'single_pokemon_type = "yes"', "single_pokemon_type: expected true or false"),
    ('names = ["Boss\'s Orders", "Lysandre"]', 'names = ["Boss\'s Orders"]', "at least two Card Identity names"),
    ('names = ["Boss\'s Orders", "Lysandre"]', 'names = ["Boss\u2019s Orders", "Lysandre"]',
     "is not a Card Identity name"),
    ('"Professor Juniper"]', '"Professor\'s Research (Professor Juniper)"]', "is not a Card Identity name"),
    ('"Professor Juniper"]', '"Lysandre"]', "Lysandre listed twice"),
    ('names = ["Boss\'s Orders", "Lysandre"]', 'names = ["Boss\'s Orders", "Lysandre"]\nsize = 2', "unknown key size"),
])
def test_the_loader_rejects_broken_glc_rules(old, new, message):
    assert old in GLC
    with pytest.raises(FormatRulesError, match=message):
        load_rules(GLC.replace(old, new, 1).encode())
