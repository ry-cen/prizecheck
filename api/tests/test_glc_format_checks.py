"""GET /api/decks/{deck_id}/format-checks against Gym Leader Challenge (Deck Lists 16, issue #97), through signed HTTP.

The cards are imported from minimal TCGdex records, so their attributes come from the real derivation rules, and the
rules are the real Gym Leader Challenge rules file. Records whose ID starts with "fixture-" are made up for one rule.
"""
from test_card_attributes import ACE_SPEC_SV, ENERGY_SV, EX_SV, card
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_deck_format_checks import deck_with, format_checks, issues, lines


def pokemon(number, name, *types):
    return card(id=f"fixture-me01-{number}", name=name, localId=str(number), category="Pokemon",
                set={"id": "me01", "name": "Mega Evolution"}, regulationMark="I", stage="Basic", rarity="Common",
                types=list(types))


FIRE = pokemon(911, "Fixture Charmander", "Fire")
WATER = pokemon(912, "Fixture Squirtle", "Water")
FIRE_WATER = pokemon(913, "Fixture Volcanion", "Fire", "Water")
# Arcanine ex (sv01-032) is a Fire Rule Box Pokémon; Prime Catcher (sv05-157) is an ACE SPEC; sv02-278 is Basic Grass
# Energy.
CARDS = (FIRE, WATER, FIRE_WATER, EX_SV, ACE_SPEC_SV, ENERGY_SV)


def checked(owner, deck):
    body = format_checks(owner, deck, "?format=glc&as_of=2026-10-11")
    assert [result["format"] for result in body["results"]] == ["glc"]
    return body["results"][0]


def test_a_single_type_deck_with_basic_energy_in_any_quantity_is_glc_legal():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("fixture-me01-911", 1), ("fixture-me01-913", 1), ("sv02-278", 58)])
    result = checked(owner, deck)
    assert (result["status"], result["issues"], result["rules_version"]) == ("legal", [], "1 (2026-10-11)")


def test_two_pokemon_types_a_rule_box_pokemon_or_an_ace_spec_make_a_glc_deck_not_legal():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("fixture-me01-911", 1), ("fixture-me01-912", 1), ("sv02-278", 58)])
    assert issues(checked(owner, deck)) == {
        ("single_type", "every Pokémon in a Gym Leader Challenge deck shares one type; these Pokémon have no type in "
                        "common", "deck", "not_legal", lines("fixture-me01-911", "fixture-me01-912"))}
    owner, deck = deck_with([("fixture-me01-911", 1), ("sv01-032", 1), ("sv02-278", 58)])
    assert issues(checked(owner, deck)) == {
        ("rule_box_not_allowed", "Rule Box cards, including Radiant and Prism Star cards, are not allowed in Gym "
                                 "Leader Challenge", "card", "not_legal", lines("sv01-032"))}
    owner, deck = deck_with([("fixture-me01-911", 1), ("sv05-157", 1), ("sv02-278", 58)])
    assert issues(checked(owner, deck)) == {
        ("ace_spec_not_allowed", "ACE SPEC cards are not allowed in Gym Leader Challenge", "card", "not_legal",
         lines("sv05-157"))}
