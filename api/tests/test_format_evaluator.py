"""The pure format evaluator (Deck Lists 12, issue #93): the Standard rule matrix with fixture rules and attributes.
Reprint Group legality and bans (Deck Lists 13, issue #94) use the same fixture rules, with a fixture ban.

No database: these tests run with plain pytest (``PYTHONPATH=api .venv/bin/pytest api/tests/test_format_evaluator.py``).
"""
from datetime import date
from uuid import NAMESPACE_URL, uuid4, uuid5

from app.card_attributes import UNKNOWN, CardAttributes
from app.format_evaluator import (ACE_SPEC_LIMIT, ATTRIBUTE_UNKNOWN, BANNED, BEFORE_RULES_COVERAGE, COPY_LIMIT,
                                  DECK_SIZE, NOT_IN_CARD_POOL, PRISM_STAR_LIMIT, RADIANT_LIMIT,
                                  REGULATION_MARK_NOT_IN_RULES, REGULATION_MARK_NOT_RECORDED, REPRINT_LEGALITY_UNKNOWN,
                                  RULES_FACT_UNSETTLED, SET_DATE_NOT_RECORDED, PrintingFacts, ResolvedLine,
                                  evaluate_format, format_rules, load_rules)

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
    assert issues(result) == {(NOT_IN_CARD_POOL, "regulation mark G not legal in Standard on 2026-04-10", "card",
                               "not_legal", edition(g))}
    j = line("New Trainer", 4, mark="J")
    assert check(deck(j), date(2026, 3, 5)).status == "not_legal"
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
        (NOT_IN_CARD_POOL, "regulation mark G not legal in Standard on 2026-10-11", "card", "not_legal",
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
