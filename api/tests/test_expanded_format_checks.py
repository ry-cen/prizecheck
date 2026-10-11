"""GET /api/decks/{deck_id}/format-checks against Expanded (Deck Lists 15, issue #96), through signed HTTP.

The cards are imported from minimal TCGdex records, so their attributes and Reprint Groups come from the real rules, and
the rules are the real Expanded rules file. Records whose ID starts with "fixture-" are made up for one rule.
"""
from test_card_attributes import ACE_SPEC_BW, ENERGY_BW, ENERGY_SV, EX_BW, card
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_deck_format_checks import deck_with, format_checks, issues, lines

NET_TEXT = "Put 1 of your Pokémon that isn't a Pokémon V or a Pokémon-GX into your hand. (Discard all attached cards.)"
# Banned in Expanded (Rebel Clash 165/192).
SCOOP_UP_NET = card(id="swsh2-165", name="Scoop Up Net", localId="165", category="Trainer",
                    set={"id": "swsh2", "name": "Rebel Clash"}, regulationMark="D", rarity="Uncommon",
                    trainerType="Item", effect=NET_TEXT)
# An identical reprint the ban list does not name: the same Card Identity and text, so the same Reprint Group.
NET_REPRINT = card(id="fixture-sv01-905", name="Scoop Up Net", localId="905", category="Trainer",
                   set={"id": "sv01", "name": "Scarlet & Violet"}, regulationMark="G", rarity="Common",
                   trainerType="Item", effect=NET_TEXT)
# Card Identities that may not share an Expanded deck: Boss's Orders and Lysandre; the three professors.
BOSS = card(id="sv02-172", name="Boss's Orders (Ghetsis)", localId="172", category="Trainer",
            set={"id": "sv02", "name": "Paldea Evolved"}, regulationMark="G", rarity="Rare", trainerType="Supporter")
LYSANDRE = card(id="xy2-90", name="Lysandre", localId="90", category="Trainer", set={"id": "xy2", "name": "Flashfire"},
                rarity="Uncommon", trainerType="Supporter")
RESEARCH_JUNIPER = card(id="swsh4.5-60", name="Professor's Research (Professor Juniper)", localId="60",
                        category="Trainer", set={"id": "swsh4.5", "name": "Shining Fates"}, regulationMark="D",
                        rarity="Rare", trainerType="Supporter")
JUNIPER = card(id="bw1-101", name="Professor Juniper", localId="101", category="Trainer",
               set={"id": "bw1", "name": "Black & White"}, rarity="Uncommon", trainerType="Supporter")
# A Basic Pokémon from Black & White, legal in Expanded by its set: every deck needs one.
SNIVY = card(id="bw1-1", name="Snivy", localId="1", category="Pokemon", set={"id": "bw1", "name": "Black & White"},
             stage="Basic", rarity="Common", types=["Grass"])
CARDS = (SCOOP_UP_NET, NET_REPRINT, ACE_SPEC_BW, EX_BW, ENERGY_BW, ENERGY_SV, BOSS, LYSANDRE, RESEARCH_JUNIPER, JUNIPER,
         SNIVY)


def checked(owner, deck, as_of="2026-10-11"):
    body = format_checks(owner, deck, f"?format=expanded&as_of={as_of}")
    assert [result["format"] for result in body["results"]] == ["expanded"]
    return body["results"][0]


def test_black_and_white_cards_are_expanded_legal_without_a_regulation_mark():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("bw7-137", 1), ("bw6-124", 1), ("bw1-1", 1), ("bw1-105", 57)])
    result = checked(owner, deck)
    assert (result["status"], result["issues"], result["rules_version"]) == ("legal", [], "2 (2026-10-11)")
    body = format_checks(owner, deck, "?as_of=2026-10-11")
    statuses = {result["format"]: result["status"] for result in body["results"]}
    assert (statuses["standard"], statuses["expanded"]) == ("not_legal", "legal")
    before = checked(owner, deck, "2026-04-09")
    assert (before["status"], [issue["code"] for issue in before["issues"]]) == ("unknown", ["before_rules_coverage"])


def test_an_identical_reprint_of_a_banned_printing_is_not_expanded_legal():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("fixture-sv01-905", 1), ("bw1-1", 1), ("sv02-278", 58)])
    result = checked(owner, deck)
    assert result["status"] == "not_legal"
    assert issues(result) == {("banned", "banned in Expanded as an identical reprint of Scoop Up Net (swsh2 165)",
                               "card", "not_legal", lines("fixture-sv01-905"))}
    owner, deck = deck_with([("swsh2-165", 1), ("bw1-1", 1), ("sv02-278", 58)])
    assert issues(checked(owner, deck)) == {("banned", "banned in Expanded", "card", "not_legal", lines("swsh2-165"))}


def test_boss_and_lysandre_or_two_professors_in_one_deck_are_not_expanded_legal():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("sv02-172", 2), ("xy2-90", 2), ("bw1-1", 1), ("sv02-278", 55)])
    assert issues(checked(owner, deck)) == {
        ("exclusive_cards", "an Expanded deck may hold only one of Boss's Orders or Lysandre", "deck", "not_legal",
         lines("sv02-172", "xy2-90"))}
    owner, deck = deck_with([("swsh4.5-60", 1), ("bw1-101", 1), ("bw1-1", 1), ("sv02-278", 57)])
    assert issues(checked(owner, deck)) == {
        ("exclusive_cards", "an Expanded deck may hold only one of Professor's Research, Professor Sycamore or "
                            "Professor Juniper", "deck", "not_legal", lines("swsh4.5-60", "bw1-101"))}
    owner, deck = deck_with([("sv02-172", 4), ("bw1-1", 1), ("sv02-278", 55)])
    assert checked(owner, deck)["status"] == "legal"
