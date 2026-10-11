"""The pure format evaluator (Deck Lists 12, issue #93): the Standard rule matrix with fixture rules and attributes.
Reprint Group legality and bans (Deck Lists 13, issue #94) use the same fixture rules, with a fixture ban. Expanded's
by-set card pool, unsettled sets and promo ranges, and its real ban list (Deck Lists 15, issue #96) follow, then Gym
Leader Challenge's singleton, cross-name groups, exclusions and single-type rule (Deck Lists 16, issue #97).

No database: these tests run with plain pytest (``PYTHONPATH=api .venv/bin/pytest api/tests/test_format_evaluator.py``).
"""
from collections import defaultdict
from itertools import chain
from datetime import date, timedelta
from uuid import NAMESPACE_URL, uuid4, uuid5

import pytest

from app.card_attributes import UNKNOWN, CardAttributes
from app.format_evaluator import (ACE_SPEC_LIMIT, ACE_SPEC_NOT_ALLOWED, ATTRIBUTE_UNKNOWN, BANNED,
                                  BEFORE_RULES_COVERAGE, COPY_LIMIT, DECK_SIZE, FORMATS, NOT_IN_CARD_POOL,
                                  EXCLUSIVE_CARDS, PRISM_STAR_LIMIT, RADIANT_LIMIT, REGULATION_MARK_NOT_IN_RULES,
                                  REGULATION_MARK_NOT_RECORDED, REPRINT_LEGALITY_UNKNOWN, RULE_BOX_NOT_ALLOWED,
                                  RULES_FACT_UNSETTLED, SET_DATE_NOT_RECORDED, SINGLE_TYPE, PrintingFacts,
                                  ResolvedLine, evaluate_format, format_rules, load_rules, next_rule_date, rule_dates)

RULES_TOML = b"""
format = "standard"
name = "Standard"
revision = 7
published = 2026-10-11
covers_from = 2025-04-11
pool = "mark_and_set"
basic_energy_always_legal = true
pokemon_reprint_inheritance = false
bans = []

[limits]
deck_size = 60
copies = 4
basic_energy_exempt = true
ace_spec_per_deck = 1
radiant_per_deck = 1
prism_star_per_name = 1

[[regulation_marks]]
mark = "F"
legal_from = 2025-04-11
rotates_on = 2025-04-11

[[regulation_marks]]
mark = "G"
legal_from = 2025-04-11
rotates_on = 2026-04-10

[[regulation_marks]]
mark = "H"
legal_from = 2025-04-11

[[regulation_marks]]
mark = "J"
legal_from = 2026-03-06

[[sets]]
id = "old"
name = "Old Set"
released = 2023-03-31
legal_from = 2023-04-14
basis = "second_friday"

[[sets]]
id = "new"
name = "New Set"
released = 2026-03-27
legal_from = 2026-04-10
basis = "second_friday"

[[excluded_sets]]
reason = "printed before regulation marks"
noted_on = 2026-10-11
sets = ["vintage"]

[[unsettled_cards]]
identity = "Fairy Energy"
reason = "whether Basic Fairy Energy is legal is not settled"
noted_on = 2026-10-11
"""
RULES = load_rules(RULES_TOML)
BANNED_RULES = load_rules(RULES_TOML.replace(b"bans = []", b"""bans = [
  { set = "old", number = "7", name = "Banned Card", banned_from = 2026-01-02, lifted_on = 2026-07-03 },
]"""))
INHERITING_RULES = load_rules(RULES_TOML.replace(b"pokemon_reprint_inheritance = false",
                                                 b"pokemon_reprint_inheritance = true"))
DAY = date(2026, 10, 11)


def attributes(mark="H", kind="trainer", basic=False, ace=False, radiant=False, prism=False):
    return CardAttributes(mark, kind, basic, ("Fire",) if kind == "pokemon" else (), radiant or prism, ace, radiant,
                          prism)


def line(name, quantity=1, set_id="old", identity=None, **attribute_values):
    raw = attribute_values.pop("raw", None)
    return ResolvedLine(uuid4(), quantity, identity or uuid5(NAMESPACE_URL, name), name,
                        PrintingFacts(uuid4(), set_id, raw if raw is not None else attributes(**attribute_values)))


def energy(quantity, name="Fire Energy", set_id="old"):
    return line(name, quantity, set_id, mark=None, kind="energy", basic=True)


def deck(*lines):
    """The lines plus Basic Energy up to 60 cards."""
    filler = 60 - sum(item.quantity for item in lines)
    return [*lines, energy(filler)] if filler else list(lines)


def check(lines, on=DAY, rules=RULES, groups=None):
    return evaluate_format(lines, rules, on, groups)


def printing(set_id="old", number=None, **attribute_values):
    raw = attribute_values.pop("raw", None)
    return PrintingFacts(uuid4(), set_id, raw if raw is not None else attributes(**attribute_values), number)


def reprinted(name, quantity, own, *reprints):
    """A line of the ``own`` printing in a fresh Reprint Group with ``reprints``, and the group facts."""
    group = uuid4()
    return ResolvedLine(uuid4(), quantity, uuid5(NAMESPACE_URL, name), name, own, group), {group: (own, *reprints)}


def issues(result):
    return {(issue.code, issue.reason, issue.kind, issue.effect, issue.lines) for issue in result.issues}


def edition(item):
    return (item.edition_id,)


def test_a_legal_deck_is_legal_and_names_its_rules_version_and_date():
    result = check(deck(line("Rare Candy", 4), line("Pikachu", 4, kind="pokemon")))
    assert (result.format, result.status, result.issues) == ("standard", "legal", ())
    assert (result.rules_version, result.evaluated_on) == ("7 (2026-10-11)", DAY)


def test_a_deck_has_exactly_sixty_cards():
    for lines, total in ((deck(line("Rare Candy", 4))[:1], 4), (deck(line("Rare Candy", 4)) + [energy(1, "Water Energy")], 61)):
        result = check(lines)
        assert result.status == "not_legal"
        assert issues(result) == {(DECK_SIZE, f"a Standard deck has exactly 60 cards; this one has {total}", "deck",
                                   "not_legal", tuple(sorted((item.edition_id for item in lines), key=str)))}
    assert check([]).status == "not_legal"


def test_copies_count_by_card_identity_across_printings():
    research = uuid5(NAMESPACE_URL, "Professor's Research")
    juniper = line("Professor's Research", 3, identity=research)
    magnolia = line("Professor's Research", 2, identity=research)
    result = check(deck(juniper, magnolia))
    assert result.status == "not_legal"
    assert issues(result) == {(COPY_LIMIT, "more than 4 copies of Professor's Research (5)", "card", "not_legal",
                               tuple(sorted((juniper.edition_id, magnolia.edition_id), key=str)))}
    assert check(deck(line("Professor's Research", 4, identity=research))).status == "legal"


def test_basic_energy_is_exempt_from_the_copy_limit_and_legal_without_a_mark_or_a_dated_set():
    result = check([line("Rare Candy", 4), energy(30), energy(26, "Water Energy", set_id="vintage")])
    assert result.status == "legal", result.issues


def test_an_unknown_basic_energy_status_over_the_copy_limit_is_unknown():
    unsure = line("Water Energy", 6, raw=CardAttributes("H", "energy", None, (), False, False, False, False))
    result = check(deck(unsure))
    assert result.status == "unknown"
    assert issues(result) == {(ATTRIBUTE_UNKNOWN, "Basic Energy status unknown", "card", "unknown", edition(unsure))}
    assert check(deck(line("Water Energy", 4, raw=unsure.printing.attributes))).status == "legal"


def test_an_unknown_copy_does_not_hide_a_known_copy_limit_violation():
    research = uuid5(NAMESPACE_URL, "Professor's Research")
    known = line("Professor's Research", 5, identity=research)
    unsure = line("Professor's Research", 1, identity=research,
                  raw=CardAttributes("H", "trainer", None, (), False, False, False, False))
    result = check(deck(known, unsure))
    assert result.status == "not_legal"
    assert issues(result) == {(COPY_LIMIT, "more than 4 copies of Professor's Research (5)", "card", "not_legal",
                               edition(known))}


def test_basic_copies_of_an_identity_do_not_count_toward_its_copy_limit():
    identity = uuid5(NAMESPACE_URL, "Mixed Energy")
    special = line("Mixed Energy", 2, identity=identity, kind="energy", basic=False)
    basic = line("Mixed Energy", 10, identity=identity, kind="energy", basic=True)
    result = check(deck(special, basic))
    assert not [issue for issue in result.issues if issue.code in (COPY_LIMIT, ATTRIBUTE_UNKNOWN)], result.issues


def test_one_ace_spec_per_deck():
    catcher, upper = line("Prime Catcher", ace=True), line("Neo Upper Energy", kind="energy", ace=True)
    assert check(deck(catcher)).status == "legal"
    result = check(deck(catcher, upper))
    assert result.status == "not_legal"
    assert issues(result) == {(ACE_SPEC_LIMIT, "more than 1 ACE SPEC in the deck (2)", "deck", "not_legal",
                               tuple(sorted((catcher.edition_id, upper.edition_id), key=str)))}
    assert check(deck(line("Prime Catcher", 2, ace=True))).status == "not_legal"


def test_an_unknown_ace_spec_status_is_a_gap_only_when_it_could_break_the_limit():
    unsure = line("New Trainer", raw=CardAttributes("H", "trainer", False, (), False, None, False, False))
    assert check(deck(unsure)).status == "legal"
    result = check(deck(unsure, line("Prime Catcher", ace=True)))
    assert result.status == "unknown"
    assert issues(result) == {(ATTRIBUTE_UNKNOWN, "ACE SPEC status unknown", "card", "unknown", edition(unsure))}


def test_one_radiant_pokemon_per_deck():
    greninja = line("Radiant Greninja", kind="pokemon", radiant=True)
    charizard = line("Radiant Charizard", kind="pokemon", radiant=True)
    assert check(deck(greninja)).status == "legal"
    result = check(deck(greninja, charizard))
    assert issues(result) == {(RADIANT_LIMIT, "more than 1 Radiant Pokémon in the deck (2)", "deck", "not_legal",
                               tuple(sorted((greninja.edition_id, charizard.edition_id), key=str)))}


def test_one_prism_star_card_per_name():
    cyrus, giratina = line("Cyrus ◇", prism=True), line("Giratina ◇", kind="pokemon", prism=True)
    assert check(deck(cyrus, giratina)).status == "legal"
    two = line("Cyrus ◇", 2, prism=True)
    result = check(deck(two, giratina))
    assert issues(result) == {(PRISM_STAR_LIMIT, "more than 1 Prism Star Cyrus ◇ (2)", "card", "not_legal",
                               edition(two))}


def test_regulation_marks_are_legal_inside_their_window():
    g = line("Old Trainer", 4, mark="G")
    assert check(deck(g), date(2026, 4, 9)).status == "legal"
    result = check(deck(g), date(2026, 4, 10))
    assert issues(result) == {(NOT_IN_CARD_POOL, "regulation mark G rotated out of Standard on 2026-04-10", "card",
                               "not_legal", edition(g))}
    # Reasons name the rule date, never the check date, so a result holds until the next rule date.
    assert issues(check(deck(g), date(2026, 5, 1))) == issues(result)
    j = line("New Trainer", 4, mark="J")
    assert issues(check(deck(j), date(2026, 3, 5))) == {
        (NOT_IN_CARD_POOL, "regulation mark J not legal in Standard until 2026-03-06", "card", "not_legal", edition(j))}
    assert check(deck(j), date(2026, 3, 6)).status == "legal"
    assert check(deck(line("Rotated", mark="F")), date(2025, 4, 11)).status == "not_legal"


def test_a_set_is_legal_from_its_legal_from_date():
    fresh = line("Fresh Trainer", 4, set_id="new", mark="J")
    result = check(deck(fresh), date(2026, 4, 9))
    assert issues(result) == {(NOT_IN_CARD_POOL, "New Set (new) not legal in Standard until 2026-04-10", "card",
                               "not_legal", edition(fresh))}
    assert check(deck(fresh), date(2026, 4, 10)).status == "legal"


def test_an_excluded_set_is_out_of_the_card_pool_even_without_a_mark():
    candy = line("Rare Candy", 4, set_id="vintage", mark=None)
    result = check(deck(candy))
    assert issues(result) == {(NOT_IN_CARD_POOL, "not in the Standard card pool: printed before regulation marks",
                               "card", "not_legal", edition(candy))}


def test_a_set_without_a_recorded_legality_date_is_unknown():
    unrecorded, orphan = line("Delta Card", 2, set_id="me06", mark="J"), line("Orphan", 2, set_id=None, mark="H")
    result = check(deck(unrecorded, orphan))
    assert result.status == "unknown"
    assert issues(result) == {
        (SET_DATE_NOT_RECORDED, "set legality date not recorded for me06", "card", "unknown", edition(unrecorded)),
        (SET_DATE_NOT_RECORDED, "set legality date not recorded for an unknown set", "card", "unknown",
         edition(orphan))}


def test_a_regulation_mark_the_rules_have_never_seen_is_unknown():
    future = line("Future Card", 4, mark="K")
    result = check(deck(future))
    assert result.status == "unknown"
    assert issues(result) == {(REGULATION_MARK_NOT_IN_RULES, "regulation mark K not in rules", "card", "unknown",
                               edition(future))}


def test_a_missing_regulation_mark_in_a_dated_set_is_unknown():
    unmarked = line("Unmarked Promo", 1, mark=None)
    result = check(deck(unmarked))
    assert issues(result) == {(REGULATION_MARK_NOT_RECORDED, "regulation mark not recorded", "card", "unknown",
                               edition(unmarked))}


def test_a_card_that_might_be_basic_energy_is_never_ruled_out_of_the_card_pool():
    manual = line("Manual Card", 1, set_id="vintage", raw=UNKNOWN)
    result = check(deck(manual))
    assert result.status == "unknown"
    assert issues(result) == {(ATTRIBUTE_UNKNOWN, "Basic Energy status unknown", "card", "unknown", edition(manual))}


def test_unsettled_cards_are_unknown():
    fairy = energy(10, "Fairy Energy")
    result = check(deck(fairy))
    assert issues(result) == {(RULES_FACT_UNSETTLED, "whether Basic Fairy Energy is legal is not settled", "card",
                               "unknown", edition(fairy))}


def test_any_violation_makes_a_deck_not_legal_and_gaps_are_still_listed():
    rotated, future = line("Old Trainer", 4, mark="G"), line("Future Card", 4, mark="K")
    result = check(deck(rotated, future), date(2026, 5, 1))
    assert result.status == "not_legal"
    assert [(issue.code, issue.effect) for issue in result.issues] == [
        (NOT_IN_CARD_POOL, "not_legal"), (REGULATION_MARK_NOT_IN_RULES, "unknown")]


def test_issues_group_lines_by_reason_and_sort_violations_first():
    first, second = line("Old A", 4, mark="G"), line("Old B", 4, mark="G")
    future = line("Future Card", 1, mark="K")
    result = check([first, second, future], date(2026, 5, 1))
    assert [(issue.code, issue.kind, issue.lines) for issue in result.issues] == [
        (DECK_SIZE, "deck", tuple(sorted((first.edition_id, second.edition_id, future.edition_id), key=str))),
        (NOT_IN_CARD_POOL, "card", tuple(sorted((first.edition_id, second.edition_id), key=str))),
        (REGULATION_MARK_NOT_IN_RULES, "card", edition(future))]


def test_dates_before_the_rules_begin_are_unknown():
    result = check(deck(line("Rare Candy", 4)), date(2025, 4, 10))
    assert result.status == "unknown"
    assert issues(result) == {(BEFORE_RULES_COVERAGE, "Standard rules start on 2025-04-11; earlier dates are unknown",
                               "deck", "unknown", ())}


def test_the_standard_rules_file_rotates_g_and_dates_its_sets():
    rules = format_rules("standard")
    energy_search = line("Energy Search", 4, set_id="sv01", mark="G")
    candy = line("Rare Candy", 4, set_id="me01", mark="I")
    lines = deck(energy_search, candy)
    assert check(lines, date(2026, 4, 9), rules).status == "legal"
    assert {issue.code for issue in check(lines, date(2026, 4, 10), rules).issues} == {NOT_IN_CARD_POOL}
    heroes = line("Ascended Card", 4, set_id="me02.5", mark="J")
    assert check(deck(heroes), date(2026, 3, 5), rules).status == "not_legal"
    assert check(deck(heroes), date(2026, 3, 6), rules).status == "legal"
    assert check(deck(line("Rare Candy", 4, set_id="sm1", mark=None)), DAY, rules).status == "not_legal"
    assert check(deck(line("Delta Card", 4, set_id="me06", mark="J")), DAY, rules).status == "unknown"
    assert check(deck(energy(4, "Fairy Energy", set_id="xy1")), DAY, rules).status == "unknown"


def test_the_next_rule_date_ends_a_results_window():
    # The fixture's rule dates: 2023-04-14 (Old Set), 2025-04-11 (coverage, F, G, H), 2026-03-06 (J) and 2026-04-10
    # (G rotates, New Set).
    assert rule_dates(RULES) == (date(2023, 4, 14), date(2025, 4, 11), date(2026, 3, 6), date(2026, 4, 10))
    assert next_rule_date(RULES, date(2020, 1, 1)) == date(2023, 4, 14)
    assert next_rule_date(RULES, date(2026, 3, 5)) == date(2026, 3, 6)
    assert next_rule_date(RULES, date(2026, 3, 6)) == date(2026, 4, 10)
    assert next_rule_date(RULES, date(2026, 4, 9)) == date(2026, 4, 10)
    assert next_rule_date(RULES, date(2026, 4, 10)) is None


def window_deck(rules):
    """A deck that exercises every dated rule in ``rules``, and the Reprint Groups it needs: a Trainer from each set and
    with each regulation mark; each set and mark again as the only legal printing in a Reprint Group of an excluded
    printing; one group whose members cross every set and mark date; and each ban, both as the banned printing and as an
    identical reprint from the newest set."""
    by_mark = [set_rule for set_rule in rules.sets.values() if set_rule.legal_by == "mark"] or list(rules.sets.values())
    earliest = min(by_mark, key=lambda set_rule: set_rule.legal_from).set_id
    newest = max(rules.sets.values(), key=lambda set_rule: set_rule.legal_from).set_id
    old = sorted(rules.excluded)[0]
    lines = [line(f"Trainer from {set_id}", set_id=set_id) for set_id in rules.sets]
    lines += [line(f"Trainer marked {mark}", set_id=earliest, mark=mark) for mark in (*rules.marks, "Z", None)]
    lines += [line(f"Trainer from {old}", set_id=old), line("Trainer from an unrecorded set", set_id="unrecorded"),
              energy(4)]
    groups = {}

    def grouped(name, own, *reprints):
        item, found = reprinted(name, 1, own, *reprints)
        lines.append(item)
        groups.update(found)

    for set_id in rules.sets:
        grouped(f"Reprinted from {set_id}", printing(old, "1", mark=None), printing(set_id, "2"))
    for mark in rules.marks:
        grouped(f"Reprinted marked {mark}", printing(old, "1", mark=None), printing(earliest, "2", mark=mark))
    grouped("Reprinted everywhere", printing(old, "1", mark=None), *(printing(set_id, "2") for set_id in rules.sets),
            *(printing(earliest, "3", mark=mark) for mark in rules.marks))
    for set_id, number in rules.bans:
        grouped(f"Banned {set_id} {number}", printing(set_id, number), printing(newest, f"{number}r"))
        grouped(f"Reprint of {set_id} {number}", printing(newest, f"{number}r"), printing(set_id, number))
    return lines, groups


@pytest.mark.parametrize("name", FORMATS)
def test_a_result_changes_only_on_a_rule_date(name):
    """Saved results (Deck Lists 17) are reused until the next rule date, so every day before it must give the same
    answer. A rules field that adds a dated fact without adding it to ``rule_dates`` fails here, because the deck
    exercises every dated rule. Every day before ``covers_from`` is unknown for the same reason, so the scan starts a
    week before it."""
    rules = format_rules(name)
    dates = rule_dates(rules)
    lines, groups = window_deck(rules)
    start = rules.covers_from - timedelta(days=7)
    # The scan's end comes from the rules fields, not from ``rule_dates`` under test, so a dropped last date is caught.
    end = max(chain([rules.covers_from], (entry.legal_from for entry in rules.sets.values()),
                    (mark.legal_from for mark in rules.marks.values()),
                    (mark.rotates_on for mark in rules.marks.values() if mark.rotates_on),
                    (ban.banned_from for ban in rules.bans.values()),
                    (ban.lifted_on for ban in rules.bans.values() if ban.lifted_on)))
    answers = defaultdict(set)
    day = start
    while day <= end + timedelta(days=7):
        result = check(lines, day, rules, groups)
        answers[next_rule_date(rules, day)].add((result.status, result.issues))
        day += timedelta(days=1)
    assert set(answers) == {*(rule_date for rule_date in dates if rule_date > start), None}
    assert {until: len(found) for until, found in answers.items() if len(found) != 1} == {}


def test_the_window_deck_exercises_every_ban():
    rules = load_rules(RULES_TOML.replace(b"bans = []", b"""bans = [
  { set = "old", number = "7", name = "Banned Card", banned_from = 2026-01-02, lifted_on = 2026-07-03 },
]"""))
    lines, groups = window_deck(rules)
    found = {issue.reason for issue in check(lines, date(2026, 5, 1), rules, groups).issues if issue.code == BANNED}
    assert found == {"banned in Standard from 2026-01-02",
                     "banned in Standard from 2026-01-02 as an identical reprint of Banned Card (old 7)"}


VINTAGE = "not in the Standard card pool: printed before regulation marks"


def test_an_old_trainer_is_legal_through_a_legal_printing_in_its_reprint_group():
    old = printing("vintage", "129", mark=None)
    candy, groups = reprinted("Rare Candy", 4, old, printing("old", "125", mark="H"))
    assert check(deck(candy), groups=groups).status == "legal"
    # Judged alone, the same printing is out of the card pool.
    assert issues(check(deck(candy))) == {(NOT_IN_CARD_POOL, VINTAGE, "card", "not_legal", edition(candy))}
    # When no other printing in the group is legal, the printing's own reasons stand.
    rotated, rotated_groups = reprinted("Rare Candy", 4, old, printing("old", "191", mark="G"))
    assert issues(check(deck(rotated), groups=rotated_groups)) == {
        (NOT_IN_CARD_POOL, VINTAGE, "card", "not_legal", edition(rotated))}


def test_special_energy_inherits_legality_like_a_trainer():
    old = printing("vintage", "17", mark=None, kind="energy")
    reversal, groups = reprinted("Reversal Energy", 4, old, printing("old", "192", mark="H", kind="energy"))
    assert check(deck(reversal), groups=groups).status == "legal"


def test_a_pokemon_is_legal_only_on_its_own_mark_unless_the_rules_allow_inheritance():
    rotated = printing("old", "101", mark="G", kind="pokemon")
    pikachu, groups = reprinted("Pikachu", 4, rotated, printing("old", "225", mark="H", kind="pokemon"))
    assert issues(check(deck(pikachu), groups=groups)) == {
        (NOT_IN_CARD_POOL, "regulation mark G rotated out of Standard on 2026-04-10", "card", "not_legal",
         edition(pikachu))}
    assert check(deck(pikachu), rules=INHERITING_RULES, groups=groups).status == "legal"


def test_an_unknown_reprint_makes_a_printing_that_is_not_legal_on_its_own_unknown():
    old = printing("vintage", "129", mark=None)
    candy, groups = reprinted("Rare Candy", 4, old, printing("old", "191", mark="G"), printing("old", "141", mark=None))
    result = check(deck(candy), groups=groups)
    assert result.status == "unknown"
    assert issues(result) == {(REPRINT_LEGALITY_UNKNOWN, "not legal on its own; identical reprint old 141 is unknown: "
                                                         "regulation mark not recorded", "card", "unknown",
                               edition(candy))}


def test_a_printing_unknown_on_its_own_stays_unknown_when_no_reprint_is_legal():
    unmarked = printing("old", "141", mark=None)
    candy, groups = reprinted("Rare Candy", 4, unmarked, printing("old", "191", mark="G"))
    assert issues(check(deck(candy), groups=groups)) == {
        (REGULATION_MARK_NOT_RECORDED, "regulation mark not recorded", "card", "unknown", edition(candy))}


def test_a_card_of_unknown_kind_with_a_legal_reprint_is_unknown():
    odd = printing("vintage", "1", raw=CardAttributes(None, None, False, None, False, False, False, False))
    card, groups = reprinted("Odd Card", 1, odd, printing("old", "2", mark="H"))
    assert issues(check(deck(card), groups=groups)) == {
        (ATTRIBUTE_UNKNOWN, "card kind unknown", "card", "unknown", edition(card))}


def test_ban_entries_name_one_printing_and_carry_their_dates():
    ban = BANNED_RULES.bans[("old", "7")]
    assert (ban.name, ban.banned_from, ban.lifted_on) == ("Banned Card", date(2026, 1, 2), date(2026, 7, 3))
    assert [ban.in_force(day) for day in (date(2026, 1, 1), date(2026, 1, 2), date(2026, 7, 2), date(2026, 7, 3))] == [
        False, True, True, False]
    assert RULES.bans == {}


def test_a_ban_on_one_printing_covers_its_whole_reprint_group():
    banned, reprint = printing("old", "7", mark="H"), printing("new", "8", mark="J")
    group, identity = uuid4(), uuid5(NAMESPACE_URL, "Banned Card")
    first = ResolvedLine(uuid4(), 1, identity, "Banned Card", banned, group)
    second = ResolvedLine(uuid4(), 1, identity, "Banned Card", reprint, group)
    # Same name, different text: another Reprint Group, untouched by the ban.
    unrelated = line("Banned Card", 1, identity=identity)
    lines, groups = deck(first, second, unrelated), {group: (banned, reprint)}
    assert issues(check(lines, date(2026, 5, 1), BANNED_RULES, groups)) == {
        (BANNED, "banned in Standard from 2026-01-02", "card", "not_legal", edition(first)),
        (BANNED, "banned in Standard from 2026-01-02 as an identical reprint of Banned Card (old 7)", "card",
         "not_legal", edition(second))}
    # Before the ban the new set's printing is legal only through the banned one; after the ban is lifted, both are.
    assert check(lines, date(2026, 1, 1), BANNED_RULES, groups).status == "legal"
    assert check(lines, date(2026, 7, 3), BANNED_RULES, groups).status == "legal"
    # Without its Reprint Group the reprint escapes the ban.
    assert check(deck(second, unrelated), date(2026, 5, 1), BANNED_RULES).status == "legal"


def test_a_ban_beats_legality_and_covers_pokemon_reprints_too():
    banned = printing("old", "7", mark="H", kind="pokemon")
    sableye, groups = reprinted("Banned Card", 4, printing("old", "9", mark="H", kind="pokemon"), banned)
    assert issues(check(deck(sableye), date(2026, 5, 1), BANNED_RULES, groups)) == {
        (BANNED, "banned in Standard from 2026-01-02 as an identical reprint of Banned Card (old 7)", "card",
         "not_legal", edition(sableye))}


def test_ban_dates_are_rule_dates():
    assert next_rule_date(BANNED_RULES, date(2026, 1, 1)) == date(2026, 1, 2)
    assert next_rule_date(BANNED_RULES, date(2026, 5, 1)) == date(2026, 7, 3)


# ---------------------------------------------------------------------------------------------------------------------
# Expanded (Deck Lists 15, issue #96)

EXPANDED_TOML = b"""
format = "expanded"
name = "Expanded"
revision = 3
published = 2026-10-11
covers_from = 2026-04-10
pool = "by_set"
basic_energy_always_legal = true
pokemon_reprint_inheritance = false
bans = [
  { set = "bw", number = "62", name = "Sableye", banned_from = 2026-04-10 },
  { set = "swsh", number = "83", name = "Medicham V", banned_from = 2026-05-01 },
]

[limits]
deck_size = 60
copies = 4
basic_energy_exempt = true
ace_spec_per_deck = 1
radiant_per_deck = 1
prism_star_per_name = 1

[[exclusive_groups]]
names = ["Boss's Orders", "Lysandre"]

[[exclusive_groups]]
names = ["Professor's Research", "Professor Sycamore", "Professor Juniper"]

[[regulation_marks]]
mark = "D"
legal_from = 2026-04-10

[[regulation_marks]]
mark = "J"
legal_from = 2026-04-10

[[sets]]
id = "bw"
name = "Black & White"
released = 2011-04-25
legal_from = 2011-05-06
basis = "second_friday"
legal_by = "set"

[[sets]]
id = "promo"
name = "SM Black Star Promos"
released = 2017-02-03
legal_from = 2017-02-17
basis = "second_friday"
legal_by = "set"

[[sets]]
id = "swsh"
name = "Sword & Shield"
released = 2020-02-07
legal_from = 2020-02-21
basis = "second_friday"
legal_by = "mark"

[[sets]]
id = "next"
name = "Next Set"
released = 2026-05-22
legal_from = 2026-06-05
basis = "second_friday"
legal_by = "mark"

[[excluded_sets]]
reason = "printed before Black & White"
noted_on = 2026-10-11
sets = ["vintage"]

[[unsettled_sets]]
reason = "whether Classic Collection reprints are legal is not settled"
noted_on = 2026-10-11
sets = ["classic"]

[[unsettled_printings]]
set = "promo"
prefix = "SM"
from = 1
to = 157
reason = "whether SM01 to SM157 are legal is not settled"
noted_on = 2026-10-11
"""
EXPANDED = load_rules(EXPANDED_TOML)
PROMO_UNSETTLED = "whether SM01 to SM157 are legal is not settled"


def expanded_check(lines, on=DAY, groups=None):
    return evaluate_format(lines, EXPANDED, on, groups)


def test_a_set_admitted_by_set_needs_no_mark():
    bw = line("Black & White Trainer", 4, set_id="bw", mark=None)
    marked = line("Odd Marked Trainer", 4, set_id="bw", mark="K")
    result = expanded_check(deck(bw, marked))
    assert (result.format, result.status, result.issues, result.rules_version) == (
        "expanded", "legal", (), "3 (2026-10-11)")


def test_a_set_admitted_by_mark_needs_a_legal_mark():
    marked = line("Marked Trainer", 4, set_id="swsh", mark="D")
    assert expanded_check(deck(marked)).status == "legal"
    unmarked, future = line("Unmarked Trainer", 4, set_id="swsh", mark=None), line("Future", 4, set_id="swsh", mark="K")
    assert issues(expanded_check(deck(unmarked, future))) == {
        (REGULATION_MARK_NOT_RECORDED, "regulation mark not recorded", "card", "unknown", edition(unmarked)),
        (REGULATION_MARK_NOT_IN_RULES, "regulation mark K not in rules", "card", "unknown", edition(future))}


def test_a_set_is_legal_in_expanded_from_its_legal_from_date_whatever_its_mark():
    fresh = line("Fresh Trainer", 4, set_id="next", mark="J")
    assert issues(expanded_check(deck(fresh), date(2026, 6, 4))) == {
        (NOT_IN_CARD_POOL, "Next Set (next) not legal in Expanded until 2026-06-05", "card", "not_legal",
         edition(fresh))}
    assert expanded_check(deck(fresh), date(2026, 6, 5)).status == "legal"


def test_an_unrecorded_set_in_a_by_set_pool_is_one_gap():
    unrecorded = line("Delta Card", 4, set_id="me06", mark="Z")
    assert issues(expanded_check(deck(unrecorded))) == {
        (SET_DATE_NOT_RECORDED, "set legality date not recorded for me06", "card", "unknown", edition(unrecorded))}


def test_cards_printed_before_black_and_white_are_out_unless_a_reprint_is_in():
    old = line("Old Trainer", 4, set_id="vintage", mark=None)
    assert issues(expanded_check(deck(old))) == {
        (NOT_IN_CARD_POOL, "not in the Expanded card pool: printed before Black & White", "card", "not_legal",
         edition(old))}
    candy, groups = reprinted("Rare Candy", 4, printing("vintage", "103", mark=None), printing("bw", "100", mark=None))
    assert expanded_check(deck(candy), groups=groups).status == "legal"
    # A Pokémon does not inherit.
    pokemon, groups = reprinted("Old Pokémon", 4, printing("vintage", "1", kind="pokemon", mark=None),
                                printing("bw", "1", kind="pokemon", mark=None))
    assert expanded_check(deck(pokemon), groups=groups).status == "not_legal"


def test_an_unsettled_set_is_unknown_and_a_trainer_there_inherits_from_a_legal_reprint():
    classic = line("Classic Pokémon", 1, set_id="classic", kind="pokemon", mark=None)
    assert issues(expanded_check(deck(classic))) == {
        (RULES_FACT_UNSETTLED, "whether Classic Collection reprints are legal is not settled", "card", "unknown",
         edition(classic))}
    trainer, groups = reprinted("Classic Trainer", 1, printing("classic", "CC1", mark=None),
                                printing("bw", "9", mark=None))
    assert expanded_check(deck(trainer), groups=groups).status == "legal"


@pytest.mark.parametrize("number, status", [
    ("SM01", "unknown"), ("SM85", "unknown"), ("SM157", "unknown"), ("SM158", "legal"), ("SM248", "legal"),
    ("SM85a", "unknown"), (None, "unknown")])
def test_sm_promos_before_sm158_are_unknown(number, status):
    promo = ResolvedLine(uuid4(), 1, uuid5(NAMESPACE_URL, "Promo"), "Promo",
                         PrintingFacts(uuid4(), "promo", attributes(mark=None, kind="pokemon"), number))
    result = expanded_check(deck(promo))
    assert result.status == status
    if status == "unknown":
        assert issues(result) == {(RULES_FACT_UNSETTLED, PROMO_UNSETTLED, "card", "unknown", edition(promo))}


def test_an_expanded_ban_covers_identical_reprints_and_a_ban_in_force_from_the_start_names_no_date():
    banned, reprint = printing("bw", "62", kind="pokemon", mark=None), printing("swsh", "9", kind="pokemon", mark="D")
    group, identity = uuid4(), uuid5(NAMESPACE_URL, "Sableye")
    first = ResolvedLine(uuid4(), 1, identity, "Sableye", banned, group)
    second = ResolvedLine(uuid4(), 1, identity, "Sableye", reprint, group)
    assert issues(expanded_check(deck(first, second), groups={group: (banned, reprint)})) == {
        (BANNED, "banned in Expanded", "card", "not_legal", edition(first)),
        (BANNED, "banned in Expanded as an identical reprint of Sableye (bw 62)", "card", "not_legal",
         edition(second))}
    medicham = ResolvedLine(uuid4(), 1, uuid5(NAMESPACE_URL, "Medicham V"), "Medicham V",
                            PrintingFacts(uuid4(), "swsh", attributes(mark="D", kind="pokemon"), "83"))
    assert expanded_check(deck(medicham), date(2026, 4, 30)).status == "legal"
    assert issues(expanded_check(deck(medicham), date(2026, 5, 1))) == {
        (BANNED, "banned in Expanded from 2026-05-01", "card", "not_legal", edition(medicham))}


def test_expanded_limits_match_standard():
    computer, cyclone = line("Computer Search", set_id="bw", mark=None, ace=True), line("Scoop Up Cyclone", set_id="bw",
                                                                                        mark=None, ace=True)
    assert {issue.code for issue in expanded_check(deck(computer, cyclone)).issues} == {ACE_SPEC_LIMIT}
    assert {issue.code for issue in expanded_check(deck(line("Ultra Ball", 5, set_id="bw", mark=None))).issues} == {
        COPY_LIMIT}


def test_dates_before_the_expanded_rules_begin_are_unknown():
    assert issues(expanded_check(deck(line("Trainer", 4, set_id="bw", mark=None)), date(2026, 4, 9))) == {
        (BEFORE_RULES_COVERAGE, "Expanded rules start on 2026-04-10; earlier dates are unknown", "deck", "unknown", ())}


def real_line(set_id, number, name, kind="trainer", mark=None, quantity=1):
    return ResolvedLine(uuid4(), quantity, uuid5(NAMESPACE_URL, name), name,
                        PrintingFacts(uuid4(), set_id, attributes(mark=mark, kind=kind), number))


def test_the_expanded_rules_file_holds_the_pool_edges_and_bans():
    rules = format_rules("expanded")

    def status(set_id, number="1", kind="trainer", mark=None, on=DAY):
        return check(deck(real_line(set_id, number, f"Card {set_id} {number}", kind, mark)), on,
                     rules).status
    # The pool's edges: Black & White onward by set, Sword & Shield onward by mark, extras by set, older sets out.
    assert [status(set_id) for set_id in ("bw1", "bw10", "bw11", "dv1", "bwp", "xy0", "xya", "g1", "sma", "det1",
                                          "2011bw", "2021swsh", "tk-bw-e", "tk-xy-sy", "tk-sm-r")] == ["legal"] * 15
    assert [status(set_id) for set_id in ("col1", "hgss4", "tk-hs-g", "tk-dp-l", "base1")] == ["not_legal"] * 5
    assert [status(set_id, mark="D") for set_id in ("swsh1", "swshp", "fut2020", "cel25", "2022swsh", "sv01",
                                                    "me05")] == ["legal"] * 7
    assert [status(set_id) for set_id in ("swsh12.5", "2023sv", "2024sv", "30th")] == ["unknown"] * 4
    assert [status(set_id) for set_id in ("cel25cc", "30th-c", "me06")] == ["unknown"] * 3
    assert [status("smp", number) for number in ("SM01", "SM157", "SM158")] == ["unknown", "unknown", "legal"]
    assert (status("30th", mark="J", on=date(2026, 9, 24)), status("30th", mark="J")) == ("not_legal", "legal")
    # Bans name TCGdex collector numbers; a reprint of a banned printing is banned too.
    for set_id, number, name, kind in (("swsh2", "22", "Flapple", "pokemon"), ("smp", "SM85", "Marshadow", "pokemon"),
                                       ("swsh7", "83", "Medicham V", "pokemon"), ("xy9", "98a", "Delinquent",
                                                                                   "trainer")):
        banned = real_line(set_id, number, name, kind, mark="E")
        assert issues(check(deck(banned), DAY, rules)) == {
            (BANNED, "banned in Expanded", "card", "not_legal", edition(banned))}
    net, groups = reprinted("Scoop Up Net", 1, printing("sv01", "999", mark="G"), printing("swsh2", "165", mark="D"))
    assert issues(check(deck(net), DAY, rules, groups)) == {
        (BANNED, "banned in Expanded as an identical reprint of Scoop Up Net (swsh2 165)", "card", "not_legal",
         edition(net))}
    assert check(deck(line("Rare Candy", 4, set_id="bw1", mark=None)), date(2026, 4, 9), rules).status == "unknown"


# ---------------------------------------------------------------------------------------------------------------------
# Gym Leader Challenge (Deck Lists 16, issue #97)

GLC_TOML = b"""
format = "glc"
name = "Gym Leader Challenge"
revision = 4
published = 2026-10-11
covers_from = 2025-04-24
pool = "by_set"
basic_energy_always_legal = true
pokemon_reprint_inheritance = false
regulation_marks = []
excluded_attributes = ["rule_box", "ace_spec"]
single_pokemon_type = true
bans = [
  { set = "bw", number = "93", name = "Dimension Valley", banned_from = 2026-04-20 },
]

[limits]
deck_size = 60
copies = 1
basic_energy_exempt = true
ace_spec_per_deck = 0
radiant_per_deck = 0
prism_star_per_name = 0

[[copy_groups]]
names = ["Boss's Orders", "Lysandre"]

[[copy_groups]]
names = ["Professor's Research", "Professor Sycamore", "Professor Juniper"]

[[sets]]
id = "bw"
name = "Black & White"
released = 2011-04-25
legal_from = 2011-05-06
basis = "second_friday"
legal_by = "set"

[[sets]]
id = "sv"
name = "Scarlet & Violet"
released = 2023-03-31
legal_from = 2023-04-14
basis = "second_friday"
legal_by = "set"

[[excluded_sets]]
reason = "printed before Black & White"
noted_on = 2026-10-11
sets = ["vintage"]
"""
GLC = load_rules(GLC_TOML)
RULE_BOX_REASON = "Rule Box cards, including Radiant and Prism Star cards, are not allowed in Gym Leader Challenge"
ACE_SPEC_REASON = "ACE SPEC cards are not allowed in Gym Leader Challenge"
TWO_TYPES = "every Pokémon in a Gym Leader Challenge deck shares one type; these Pokémon have no type in common"


def glc(lines, on=DAY, groups=None):
    return evaluate_format(lines, GLC, on, groups)


def card_line(name, quantity=1, kind="trainer", types=(), rule_box=False, ace=False, radiant=False, prism=False,
              basic=False, set_id="sv", raw=None):
    facts = raw if raw is not None else CardAttributes(None, kind, basic, types, rule_box, ace, radiant, prism)
    return ResolvedLine(uuid4(), quantity, uuid5(NAMESPACE_URL, name), name, PrintingFacts(uuid4(), set_id, facts))


def mon(name, *types, **values):
    return card_line(name, kind="pokemon", types=types or ("Fire",), **values)


def lines_of(*items):
    return tuple(sorted((item.edition_id for item in items), key=str))


def test_a_glc_deck_has_one_copy_of_each_card_except_basic_energy():
    result = glc(deck(mon("Charmander"), card_line("Ultra Ball")))
    assert (result.format, result.status, result.issues, result.rules_version) == (
        "glc", "legal", (), "4 (2026-10-11)")
    balls, special = card_line("Ultra Ball", 2), card_line("Double Turbo Energy", 2, kind="energy")
    assert issues(glc(deck(balls, special))) == {
        (COPY_LIMIT, "more than 1 copy of Ultra Ball (2)", "card", "not_legal", edition(balls)),
        (COPY_LIMIT, "more than 1 copy of Double Turbo Energy (2)", "card", "not_legal", edition(special))}
    # Basic Energy in any quantity, of any type.
    assert glc([mon("Charmander"), energy(30, "Water Energy"), energy(29, "Psychic Energy")]).status == "legal"


def test_boss_and_lysandre_and_the_three_professors_share_one_copy():
    boss, lysandre = card_line("Boss's Orders"), card_line("Lysandre")
    research, sycamore = card_line("Professor's Research"), card_line("Professor Sycamore")
    juniper = card_line("Professor Juniper")
    assert issues(glc(deck(boss, lysandre, research, sycamore))) == {
        (COPY_LIMIT, "more than 1 copy of Boss's Orders or Lysandre (2)", "card", "not_legal",
         lines_of(boss, lysandre)),
        (COPY_LIMIT, "more than 1 copy of Professor's Research, Professor Sycamore or Professor Juniper (2)", "card",
         "not_legal", lines_of(research, sycamore))}
    assert glc(deck(lysandre, juniper)).status == "legal"
    # Only these groups: other cards with related names are separate cards.
    others = (card_line("Gloria"), card_line("Brigette"), card_line("Hop"), card_line("Cheren"))
    assert glc(deck(*others)).status == "legal"


def test_the_single_type_rule_covers_pokemon_only():
    assert glc(deck(mon("Charmander"), mon("Charizard"), card_line("Ultra Ball"),
                    energy(10, "Water Energy"))).status == "legal"


def test_a_dual_type_pokemon_fits_either_of_its_types():
    volcarona = mon("Volcarona", "Fire", "Grass")
    assert glc(deck(mon("Charmander", "Fire"), volcarona)).status == "legal"
    assert glc(deck(mon("Bulbasaur", "Grass"), volcarona)).status == "legal"
    water, fire = mon("Squirtle", "Water"), mon("Charmander", "Fire")
    assert issues(glc(deck(water, fire, volcarona))) == {
        (SINGLE_TYPE, TWO_TYPES, "deck", "not_legal", lines_of(water, fire, volcarona))}


def test_colorless_is_a_type_of_its_own():
    fire, snorlax = mon("Charmander", "Fire"), mon("Snorlax", "Colorless")
    assert issues(glc(deck(fire, snorlax))) == {(SINGLE_TYPE, TWO_TYPES, "deck", "not_legal", lines_of(fire, snorlax))}
    assert glc(deck(snorlax, mon("Eevee", "Colorless"))).status == "legal"


def test_an_unknown_type_is_a_gap_only_when_it_could_break_the_rule():
    untyped = mon("Mystery", raw=CardAttributes(None, "pokemon", False, None, False, False, False, False))
    assert glc(deck(untyped)).status == "legal"
    fire = mon("Charmander", "Fire")
    assert issues(glc(deck(untyped, fire))) == {
        (ATTRIBUTE_UNKNOWN, "Pokémon type unknown", "card", "unknown", edition(untyped))}
    water = mon("Squirtle", "Water")
    assert issues(glc(deck(untyped, fire, water))) == {
        (SINGLE_TYPE, TWO_TYPES, "deck", "not_legal", lines_of(fire, water))}
    odd = card_line("Odd Card", raw=CardAttributes(None, None, None, None, None, None, None, None))
    assert issues(glc(deck(odd, fire))) == {
        (ATTRIBUTE_UNKNOWN, "card kind unknown", "card", "unknown", edition(odd)),
        (ATTRIBUTE_UNKNOWN, "Rule Box status unknown", "card", "unknown", edition(odd)),
        (ATTRIBUTE_UNKNOWN, "ACE SPEC status unknown", "card", "unknown", edition(odd))}


def test_rule_box_ace_spec_and_prism_star_cards_are_not_legal():
    ex, radiant = mon("Arcanine ex", rule_box=True), mon("Radiant Charizard", rule_box=True, radiant=True)
    prism, catcher = card_line("Cyrus ◇", rule_box=True, prism=True), card_line("Prime Catcher", ace=True)
    upper = card_line("Neo Upper Energy", kind="energy", ace=True)
    assert issues(glc(deck(ex, radiant, prism, catcher, upper))) == {
        (RULE_BOX_NOT_ALLOWED, RULE_BOX_REASON, "card", "not_legal", lines_of(ex, radiant, prism)),
        (ACE_SPEC_NOT_ALLOWED, ACE_SPEC_REASON, "card", "not_legal", lines_of(catcher, upper))}
    # The exclusions replace the per-deck ACE SPEC, Radiant and Prism Star limits.
    assert not {issue.code for issue in glc(deck(catcher, upper, radiant, prism)).issues} & {
        ACE_SPEC_LIMIT, RADIANT_LIMIT, PRISM_STAR_LIMIT}


def test_an_unknown_rule_box_or_ace_spec_status_is_unknown():
    unsure_box = mon("Mystery ex", raw=CardAttributes(None, "pokemon", False, ("Fire",), None, False, False, False))
    unsure_ace = card_line("New Trainer", raw=CardAttributes(None, "trainer", False, (), False, None, False, False))
    assert issues(glc(deck(unsure_box, unsure_ace))) == {
        (ATTRIBUTE_UNKNOWN, "Rule Box status unknown", "card", "unknown", edition(unsure_box)),
        (ATTRIBUTE_UNKNOWN, "ACE SPEC status unknown", "card", "unknown", edition(unsure_ace))}


def test_the_glc_pool_is_black_and_white_onward_by_set_whatever_the_mark():
    assert glc(deck(mon("Charmander", set_id="bw"), card_line("Rare Candy", set_id="sv"))).status == "legal"
    old = card_line("Old Trainer", set_id="vintage")
    assert issues(glc(deck(old))) == {
        (NOT_IN_CARD_POOL, "not in the Gym Leader Challenge card pool: printed before Black & White", "card",
         "not_legal", edition(old))}
    candy, groups = reprinted("Rare Candy", 1, printing("vintage", "1", mark=None), printing("sv", "2", mark=None))
    assert glc(deck(candy), groups=groups).status == "legal"
    unrecorded = card_line("Delta Card", set_id="me06")
    assert issues(glc(deck(unrecorded))) == {
        (SET_DATE_NOT_RECORDED, "set legality date not recorded for me06", "card", "unknown", edition(unrecorded))}


def test_glc_bans_name_one_printing_with_its_date_and_cover_its_reprint_group():
    valley = ResolvedLine(uuid4(), 1, uuid5(NAMESPACE_URL, "Dimension Valley"), "Dimension Valley",
                          PrintingFacts(uuid4(), "bw", attributes(mark=None), "93"))
    assert glc(deck(valley), date(2026, 4, 19)).status == "legal"
    assert issues(glc(deck(valley), date(2026, 4, 20))) == {
        (BANNED, "banned in Gym Leader Challenge from 2026-04-20", "card", "not_legal", edition(valley))}
    reprint, groups = reprinted("Dimension Valley", 1, printing("sv", "9", mark=None), printing("bw", "93", mark=None))
    assert issues(glc(deck(reprint), date(2026, 4, 20), groups)) == {
        (BANNED, "banned in Gym Leader Challenge from 2026-04-20 as an identical reprint of Dimension Valley (bw 93)",
         "card", "not_legal", edition(reprint))}


def test_the_glc_rules_file_holds_its_bans_groups_and_pool():
    rules = format_rules("glc")

    def result(*items, on=DAY):
        return evaluate_format(deck(*items), rules, on)

    def at(set_id, number, name, kind="trainer", types=()):
        return ResolvedLine(uuid4(), 1, uuid5(NAMESPACE_URL, name), name,
                            PrintingFacts(uuid4(), set_id, CardAttributes(None, kind, False, types, False, False,
                                                                          False, False), number))
    # A printing-specific ban: Kyogre Shining Fates 021 only.
    banned = at("swsh4.5", "21", "Kyogre", "pokemon", ("Water",))
    assert issues(result(banned)) == {(BANNED, "banned in Gym Leader Challenge", "card", "not_legal", edition(banned))}
    assert result(at("sv06", "999", "Kyogre", "pokemon", ("Water",))).status == "legal"
    # Every printing of Double Colorless Energy, and Dimension Valley from 2026-04-20.
    assert {result(at(set_id, number, "Double Colorless Energy", "energy")).status
            for set_id, number in (("sm3.5", "69"), ("bw4", "92"), ("xy1", "130"), ("sm1", "136"))} == {"not_legal"}
    valley = at("xy4", "93", "Dimension Valley")
    assert (result(valley, on=date(2026, 4, 19)).status, result(valley, on=date(2026, 4, 20)).status) == (
        "legal", "not_legal")
    # Expanded's ban list does not apply; GLC does not rotate; marks play no part.
    assert result(at("bw3", "67", "Archeops", "pokemon", ("Colorless",))).status == "legal"
    assert result(at("bw1", "1", "Snivy", "pokemon", ("Grass",)), at("me05", "1", "Fixture Grass", "pokemon",
                                                                    ("Grass",))).status == "legal"
    assert (result(at("30th", "1", "Fixture", "pokemon"), on=date(2026, 9, 24)).status,
            result(at("30th", "1", "Fixture", "pokemon")).status) == ("not_legal", "legal")
    assert [result(at(set_id, "1", "Fixture")).status for set_id in ("cel25cc", "30th-c", "mfb", "2023sv", "base1",
                                                                     "me06")] == [
        "unknown", "unknown", "unknown", "unknown", "not_legal", "unknown"]
    assert {issue.code for issue in result(at("sv02", "172", "Boss's Orders"), at("xy2", "90", "Lysandre")).issues} == {
        COPY_LIMIT}


# ---------------------------------------------------------------------------------------------------------------------
# Expanded cards that may not share a deck (Deck Lists 15, revision 2)

BOSS_OR_LYSANDRE = "an Expanded deck may hold only one of Boss's Orders or Lysandre"
PROFESSORS = "an Expanded deck may hold only one of Professor's Research, Professor Sycamore or Professor Juniper"


def test_boss_and_lysandre_may_not_share_an_expanded_deck_whatever_the_copies():
    boss, lysandre = line("Boss's Orders", 1, set_id="bw", mark=None), line("Lysandre", 1, set_id="bw", mark=None)
    assert issues(expanded_check(deck(boss, lysandre))) == {
        (EXCLUSIVE_CARDS, BOSS_OR_LYSANDRE, "deck", "not_legal", lines_of(boss, lysandre))}
    # Each stays within its own four copies, so the only issue is the exclusion.
    two_boss = line("Boss's Orders", 2, set_id="bw", mark=None)
    two_lysandre = line("Lysandre", 2, set_id="bw", mark=None)
    assert [issue.code for issue in expanded_check(deck(two_boss, two_lysandre)).issues] == [EXCLUSIVE_CARDS]
    # One of them alone, up to four copies, is legal; the copy limit still counts each Card Identity.
    assert expanded_check(deck(line("Boss's Orders", 4, set_id="bw", mark=None))).status == "legal"
    assert {issue.code for issue in expanded_check(deck(line("Lysandre", 5, set_id="bw", mark=None))).issues} == {
        COPY_LIMIT}


def test_the_three_professors_may_not_share_an_expanded_deck():
    # "Professor's Research (Professor Juniper)" is the Card Identity "Professor's Research".
    research = line("Professor's Research", 2, set_id="bw", mark=None)
    sycamore = line("Professor Sycamore", 1, set_id="bw", mark=None)
    juniper = line("Professor Juniper", 1, set_id="bw", mark=None)
    assert issues(expanded_check(deck(research, sycamore, juniper))) == {
        (EXCLUSIVE_CARDS, PROFESSORS, "deck", "not_legal", lines_of(research, sycamore, juniper))}
    assert expanded_check(deck(research, line("Boss's Orders", set_id="bw", mark=None))).status == "legal"


def test_two_printings_of_one_exclusive_card_are_not_an_exclusion():
    identity = uuid5(NAMESPACE_URL, "Boss's Orders")
    first = line("Boss's Orders", 2, set_id="bw", mark=None, identity=identity)
    second = line("Boss's Orders", 2, set_id="swsh", mark="D", identity=identity)
    assert expanded_check(deck(first, second)).status == "legal"


def test_an_expanded_deck_size_reason_reads_an_expanded_deck():
    short = line("Rare Candy", 4, set_id="bw", mark=None)
    assert issues(expanded_check([short])) == {
        (DECK_SIZE, "an Expanded deck has exactly 60 cards; this one has 4", "deck", "not_legal", edition(short))}


def test_glc_copy_groups_already_cover_the_exclusions():
    """GLC's one-copy copy groups subsume Expanded's exclusion: one Boss's Orders and one Lysandre break the shared copy
    limit, so GLC needs no exclusive groups."""
    assert GLC.exclusive_groups == ()
    boss, lysandre = card_line("Boss's Orders"), card_line("Lysandre")
    assert [issue.code for issue in glc(deck(boss, lysandre)).issues] == [COPY_LIMIT]


def test_the_real_expanded_rules_keep_boss_and_lysandre_apart():
    rules = format_rules("expanded")
    boss = ResolvedLine(uuid4(), 1, uuid5(NAMESPACE_URL, "Boss's Orders"), "Boss's Orders",
                        PrintingFacts(uuid4(), "sv02", attributes(mark="G"), "172"))
    lysandre = ResolvedLine(uuid4(), 1, uuid5(NAMESPACE_URL, "Lysandre"), "Lysandre",
                            PrintingFacts(uuid4(), "xy2", attributes(mark=None), "90"))
    assert issues(check(deck(boss, lysandre), DAY, rules)) == {
        (EXCLUSIVE_CARDS, BOSS_OR_LYSANDRE, "deck", "not_legal", lines_of(boss, lysandre))}
