"""Reprint Groups (Deck Lists 13, issue #94): formed on catalog import, stable across re-imports, and read by format
checks over signed HTTP.

The records are minimal copies of real TCGdex English records from the 2026-10-10 crawl, cut down to the fields the
attribute and rules-text rules read. Records whose ID starts with "fixture-" are made up for one rule.
"""
import pytest

from datetime import date
from uuid import uuid4

from app.games.pokemon.catalog.catalog import rederive_card_attributes
from app.main import connect
from app.games.pokemon.catalog.reprint_groups import RULES, ReprintTextRules, read_reprint_groups, rules_digest, text_key
from test_card_attributes import ENERGY_SV, SWITCH_ME, card, edition_of, printing_ids, revision
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run, seed_manual
from test_deck_format_checks import deck_with, every_format, format_checks, issues, lines, standard
from test_deck_lists import add_line
from test_holdings import call

# Changing a rules-text rule changes this digest: bump ReprintTextRules.VERSION and pin the new pair here.
PINNED_RULES = (2, "5a50872fd9eb0144b4d9a74b6aa19e3272827019f966eb18c74575e226cf9038")

ME_CANDY = ("Choose 1 of your Basic Pokémon in play. If you have a Stage 2 card in your hand that evolves from that "
            "Pokémon, put that card onto the Basic Pokémon to evolve it, skipping the Stage 1. You can't use this card "
            "during your first turn or on a Basic Pokémon that was put into play this turn.")
# Sun & Moon wording: functionally the same card, but not the same text. Only maintainer review merges it (ticket 14).
SM_CANDY = ("Choose 1 of your Basic Pokémon in play. If you have a Stage 2 card in your hand that evolves from that "
            "Pokémon, put that card onto the Basic Pokémon to evolve it. You can\u2019t use this card during your first "
            "turn or on a Basic Pokémon that was put into play this turn.")
RESEARCH = "Discard your hand and draw 7 cards."
REVERSAL_TEXT = ("As long as this card is attached to a Pokémon, it provides {C} Energy.\n\nIf you have more Prize cards "
                 "remaining than your opponent, and if this card is attached to an Evolution Pokémon that doesn't have "
                 "a Rule Box (Pokémon ex, Pokémon V, etc. have Rule Boxes), this card provides every type of Energy but "
                 "provides only 3 Energy at a time.")
SCRAPPY_SPARK = [{"cost": ["Lightning", "Lightning", "Colorless"], "name": "Scrappy Spark",
                  "effect": "Flip a coin until you get tails. This attack does 30 more damage for each heads.",
                  "damage": "30+"}]


def candy(source_id, set_id, set_name, mark=None, effect=ME_CANDY, name="Rare Candy", rarity="Common"):
    fields = {"regulationMark": mark} if mark else {}
    return card(id=source_id, name=name, localId=source_id.rsplit("-", 1)[1], category="Trainer",
                set={"id": set_id, "name": set_name}, rarity=rarity, trainerType="Item", effect=effect, **fields)


CANDY_ME = candy("me01-125", "me01", "Mega Evolution", "I")
CANDY_SV = candy("sv01-191", "sv01", "Scarlet & Violet", "G")
CANDY_SWSH = candy("swsh1-180", "swsh1", "Sword & Shield", "D", rarity="Uncommon")
CANDY_CROWN = candy("swsh12.5-141", "swsh12.5", "Crown Zenith", rarity="Uncommon")
CANDY_SM = candy("sm1-129", "sm1", "Sun & Moon", effect=SM_CANDY, rarity="Uncommon")
CANDY_SM_GUARDIANS = candy("sm2-165", "sm2", "Guardians Rising", effect=SM_CANDY, rarity="Secret Rare")
CANDY_FATES = candy("sv04.5-089", "sv04.5", "Paldean Fates", "G")
# The same text spelled as TCGdex sometimes spells it: a typographic apostrophe and a line break.
CANDY_RESPELLED = candy("fixture-sv04.5-901", "sv04.5", "Paldean Fates", "G",
                        effect=ME_CANDY.replace("can't", "can\u2019t").replace(" If you", "\nIf  you"))
# Letter case is kept: "basic" is not "Basic".
CANDY_LOWER_CASE = candy("fixture-sv01-903", "sv01", "Scarlet & Violet", "G",
                         effect=ME_CANDY.replace("of your Basic", "of your basic"))
# Same text, another Card Identity.
CANDY_RENAMED = candy("fixture-me01-904", "me01", "Mega Evolution", "I", name="Fixture Candy")
# A digital-only TCG Pocket printing with Mega Evolution's text.
CANDY_POCKET = candy("A3-144", "A3", "Celestial Guardians", rarity="Two Diamond")
RESEARCH_MAGNOLIA = card(id="swsh1-178", name="Professor's Research (Professor Magnolia)", localId="178",
                         category="Trainer", set={"id": "swsh1", "name": "Sword & Shield"}, regulationMark="D",
                         rarity="Holo Rare", trainerType="Supporter", effect=RESEARCH)
RESEARCH_JUNIPER = card(id="swsh4.5-60", name="Professor's Research (Professor Juniper)", localId="60",
                        category="Trainer", set={"id": "swsh4.5", "name": "Shining Fates"}, regulationMark="D",
                        rarity="Rare", trainerType="Supporter", effect=RESEARCH)
RESEARCH_SV = card(id="sv01-189", name="Professor's Research", localId="189", category="Trainer",
                   set={"id": "sv01", "name": "Scarlet & Violet"}, regulationMark="G", rarity="Rare",
                   trainerType="Supporter", effect=RESEARCH)
REVERSAL = card(id="sv02-192", name="Reversal Energy", localId="192", category="Energy",
                set={"id": "sv02", "name": "Paldea Evolved"}, energyType="Special", regulationMark="G",
                rarity="Uncommon", effect=REVERSAL_TEXT)
# TCGdex labels this Special Energy "Normal"; Energy type is not compared, so it stays with sv02-192.
REVERSAL_MISLABELLED = card(id="sv04-266", name="Reversal Energy", localId="266", category="Energy",
                            set={"id": "sv04", "name": "Paradox Rift"}, energyType="Normal", regulationMark="G",
                            rarity="Hyper rare", effect=REVERSAL_TEXT)
PIKACHU_G = card(id="svp-101", name="Pikachu", localId="101", category="Pokemon",
                 set={"id": "svp", "name": "SVP Black Star Promos"}, regulationMark="G", rarity="Promo", hp=70,
                 types=["Lightning"], stage="Basic", attacks=SCRAPPY_SPARK)
PIKACHU_I = card(id="svp-225", name="Pikachu", localId="225", category="Pokemon",
                 set={"id": "svp", "name": "SVP Black Star Promos"}, regulationMark="I", rarity="Promo", hp=70,
                 types=["Lightning"], stage="Basic", attacks=SCRAPPY_SPARK)
PIKACHU_OTHER_ATTACK = card(id="sv05-051", name="Pikachu", localId="051", category="Pokemon",
                            set={"id": "sv05", "name": "Temporal Forces"}, regulationMark="H", rarity="Common", hp=70,
                            types=["Lightning"], stage="Basic",
                            attacks=[{"cost": ["Lightning"], "name": "Random Spark",
                                      "effect": "This attack does 10 damage to 1 of your opponent's Pokémon. (Don't "
                                                "apply Weakness and Resistance for Benched Pokémon.)"}])
CARDS = (CANDY_ME, CANDY_SV, CANDY_SWSH, CANDY_CROWN, CANDY_SM, CANDY_SM_GUARDIANS, CANDY_RESPELLED, CANDY_LOWER_CASE,
         CANDY_RENAMED, RESEARCH_MAGNOLIA, RESEARCH_JUNIPER, RESEARCH_SV, REVERSAL, REVERSAL_MISLABELLED, PIKACHU_G,
         PIKACHU_I, PIKACHU_OTHER_ATTACK, ENERGY_SV, SWITCH_ME)
EXPECTED_GROUPS = {
    frozenset({"me01-125", "sv01-191", "swsh1-180", "swsh12.5-141", "fixture-sv04.5-901"}),
    frozenset({"sm1-129", "sm2-165"}),
    frozenset({"fixture-sv01-903"}),
    frozenset({"fixture-me01-904"}),
    frozenset({"swsh1-178", "swsh4.5-60", "sv01-189"}),
    frozenset({"sv02-192", "sv04-266"}),
    frozenset({"svp-101", "svp-225"}),
    frozenset({"sv05-051"}),
}
UNGROUPED = ("sv02-278", "me01-130")  # Basic Energy and a Trainer record without effect text


class Withdrawing(Records):
    """Records whose source withdraws ``excluded_ids`` on purpose, as TCGdexSource does for TCG Pocket."""

    def __init__(self, *records, excluded_ids=(), excluded_sets=()):
        super().__init__(*records)
        self.excluded_ids, self.excluded_sets = frozenset(excluded_ids), frozenset(excluded_sets)


def groups_of(*source_ids):
    ids = printing_ids(*source_ids)
    with connect() as conn:
        found = read_reprint_groups(conn, ids.values())
    return {source_id: found[ids[source_id]] for source_id in source_ids}


def partition(groups):
    """The source IDs of each Reprint Group; Printings in no group are left out."""
    members = {}
    for source_id, group in groups.items():
        if group is not None:
            members.setdefault(group, set()).add(source_id)
    return {frozenset(value) for value in members.values()}


def all_ids(records=CARDS):
    return tuple(record["id"] for record in records)


def edited(record, **fields):
    return {**record, **fields}


def test_reprint_text_rules_are_pinned():
    assert (RULES.VERSION, rules_digest()) == PINNED_RULES


def test_rules_text_folds_typography_but_keeps_case_reminder_text_and_missing_data_apart():
    text = ReprintTextRules.rules_text
    base = text(CANDY_ME)
    assert base == {"category": "Trainer", "effect": ME_CANDY}
    assert text(CANDY_RESPELLED) == base
    assert text(edited(CANDY_ME, effect=ME_CANDY.replace("\u00e9", "e\u0301"))) == base  # NFC
    assert text(CANDY_LOWER_CASE) != base
    assert text(edited(CANDY_ME, effect=ME_CANDY + " (This counts as evolving.)")) != base
    assert text(edited(CANDY_ME, effect=" \n ")) is None and text(SWITCH_ME) is None and text(ENERGY_SV) is None
    assert text(None) is None and text(edited(CANDY_ME, category="Item")) is None
    pikachu = text(PIKACHU_G)
    assert pikachu == text(PIKACHU_I) != text(PIKACHU_OTHER_ATTACK)
    reordered = [{**SCRAPPY_SPARK[0], "cost": ["Colorless", "Lightning", "Lightning"]}]
    assert text(edited(PIKACHU_G, attacks=reordered)) == pikachu
    assert text(edited(PIKACHU_G, attacks=[{**SCRAPPY_SPARK[0], "damage": "40+"}])) != pikachu
    assert text(edited(PIKACHU_G, types=["Lightning", "Lightning"])) == pikachu
    assert text(edited(PIKACHU_G, attacks=[{**SCRAPPY_SPARK[0], "damage": 30}])) == \
        text(edited(PIKACHU_G, attacks=[{**SCRAPPY_SPARK[0], "damage": "30"}]))
    times = [{**SCRAPPY_SPARK[0], "damage": "20\u00d7"}]
    assert text(edited(PIKACHU_G, attacks=times)) == text(edited(PIKACHU_G, attacks=[{**times[0], "damage": "20x"}]))
    # Stage, weakness, resistance and retreat are not compared; HP, types, attacks and abilities are.
    assert text(edited(PIKACHU_G, stage=None, retreat=1, weaknesses=[{"type": "Fighting", "value": "x2"}])) == pikachu
    assert text(edited(PIKACHU_G, hp=60)) != pikachu and text(edited(PIKACHU_G, types=["Fire"])) != pikachu
    ability = {"type": "Ability", "name": "Static", "effect": "Fixture ability."}
    assert text(edited(PIKACHU_G, abilities=[ability])) != pikachu
    for broken in ({"hp": None}, {"types": []}, {"attacks": [], "abilities": None}, {"hp": True},
                   {"attacks": [{"cost": ["Lightning"], "damage": 10}]},
                   {"abilities": [{"type": "Ability", "name": "Static"}]}):
        assert text(edited(PIKACHU_G, **broken)) is None, broken



@pytest.mark.parametrize("type_name,symbol", [
    ("Grass", "G"), ("Fire", "R"), ("Water", "W"), ("Lightning", "L"), ("Psychic", "P"),
    ("Fighting", "F"), ("Darkness", "D"), ("Metal", "M"), ("Fairy", "Y"), ("Dragon", "N"), ("Colorless", "C"),
])
def test_energy_spellings_fold_every_energy_type(type_name, symbol):
    brace = "{" + symbol + "}"
    assert RULES.text("[" + symbol + "]") == brace
    assert RULES.text(f'<span class="energy-symbol {type_name}" title="{type_name}">{type_name}</span>') == brace
    assert RULES.text(f"Basic {type_name} Energy") == f"Basic {brace} Energy"
    # Line breaks, doubled spaces and <em> inside the phrase fold the same way.
    for spelled in (f"Basic\n{type_name} Energy", f"Basic  {type_name}\tEnergy", f"Basic <em>{type_name}</em> Energy"):
        assert RULES.text(spelled) == f"Basic {brace} Energy"
    # Older wording and case are deliberately kept.
    assert RULES.text(f"{type_name} Energy") == f"{type_name} Energy"
    assert RULES.text(f"basic {type_name} Energy") == f"basic {type_name} Energy"
    assert RULES.text(f"Basic {type_name.lower()} Energy") == f"Basic {type_name.lower()} Energy"


@pytest.mark.parametrize("printed,canonical", [
    ("Attach [R] Energy.", "Attach {R} Energy."),  # Mega Charizard X ex mep-023 / me02-013
    ("Attach Basic Fire Energy.", "Attach Basic {R} Energy."),  # Delphox mep-074 / me04-013
    ('Attach <span class="energy-symbol Dragon" title="Dragon">Dragon</span> Energy.', "Attach {N} Energy."),
    ("Attack. <em>(Keep this reminder.)</em>", "Attack. (Keep this reminder.)"),  # Pikachu 30th-025
])
def test_v2_spellings_join_the_same_reprint_group_on_import(printed, canonical):
    reset_catalog()
    # These differ under v1: none of its NFC, typography or whitespace folds changes either spelling.
    assert printed != canonical
    first = edited(PIKACHU_G, attacks=[{**SCRAPPY_SPARK[0], "effect": printed}])
    second = edited(PIKACHU_I, attacks=[{**SCRAPPY_SPARK[0], "effect": canonical}])
    run(Records(first, second))
    groups = groups_of(first["id"], second["id"])
    assert groups[first["id"]] is not None
    assert groups[first["id"]] == groups[second["id"]]


@pytest.mark.parametrize("effect,v1_key", [
    (RESEARCH, "f842464c0afea0878907e4daf6b378f203c42a8a0cebddc9d916f0c4d5dc9f82"),
    ("Attach a Fire Energy. (Keep this reminder.)", "45ef9b1c5e21ec81c54163ba967be774d762f55dc76b200a8b0f6226f300317a"),
])
def test_text_without_new_spellings_keeps_its_v1_text_key(effect, v1_key):
    assert text_key(RULES.rules_text({"category": "Trainer", "effect": effect})) == v1_key


def test_rederiving_existing_v1_groups_applies_v2_without_fetching(monkeypatch):
    reset_catalog()
    first = edited(PIKACHU_G, attacks=[{**SCRAPPY_SPARK[0], "effect": "Attach [R] Energy."}])
    second = edited(PIKACHU_I, attacks=[{**SCRAPPY_SPARK[0], "effect": "Attach {R} Energy."}])
    with monkeypatch.context() as old_rules:
        old_rules.setattr(ReprintTextRules, "VERSION", 1)
        # These fixture strings contain no typography, NFC or whitespace differences: v1 keeps them verbatim.
        old_rules.setattr(ReprintTextRules, "text", classmethod(lambda cls, value: value if isinstance(value, str) else None))
        run(Records(first, second))
    before = groups_of(first["id"], second["id"])
    assert before[first["id"]] != before[second["id"]]
    with connect() as conn:
        rederive_card_attributes(conn)
        versions = conn.execute("SELECT DISTINCT rules_version FROM catalog_derived_reprint_group").fetchall()
    after = groups_of(first["id"], second["id"])
    assert after[first["id"]] == after[second["id"]]
    assert [row["rules_version"] for row in versions] == [2]


def test_other_markup_and_symbols_stay_printed():
    for text in ("[r] [Z]", "<strong>Reminder</strong>", '<span class="energy-symbol Unknown">Fire</span>'):
        assert RULES.text(text) == text


def test_import_groups_printings_with_equal_text_within_one_card_identity():
    reset_catalog()
    run(Records(*CARDS))
    manual, _ = seed_manual()
    groups = groups_of(*all_ids())
    assert partition(groups) == EXPECTED_GROUPS
    assert [groups[source_id] for source_id in UNGROUPED] == [None, None]
    with connect() as conn:
        assert read_reprint_groups(conn, [manual]) == {manual: None}


def test_identical_reimports_keep_every_group_and_the_revision():
    reset_catalog()
    run(Records(*CARDS))
    before, imported = groups_of(*all_ids()), revision()
    run(Records(*CARDS))
    assert (groups_of(*all_ids()), revision()) == (before, imported)
    # Rederiving without an import changes nothing either.
    with connect() as conn:
        assert rederive_card_attributes(conn) == 0
    assert (groups_of(*all_ids()), revision()) == (before, imported)


def test_a_new_reprint_joins_its_existing_group_and_the_import_advances_the_revision_once():
    reset_catalog()
    run(Records(*CARDS))
    before, imported = groups_of(*all_ids()), revision()
    # The new Printing gets attributes and a group in the same import: one revision step for both.
    run(Records(*CARDS, CANDY_FATES))
    after = groups_of(*all_ids(), "sv04.5-089")
    assert after["sv04.5-089"] == before["me01-125"]
    assert {source_id: after[source_id] for source_id in before} == before
    assert revision() == imported + 1


def test_a_text_change_moves_a_printing_to_another_group_and_back():
    reset_catalog()
    run(Records(*CARDS))
    before, imported = groups_of(*all_ids()), revision()
    reworded = edited(CANDY_SV, effect=ME_CANDY.replace("first turn", "first two turns"))
    run(Records(*(reworded if record is CANDY_SV else record for record in CARDS)))
    moved = groups_of(*all_ids())
    assert moved["sv01-191"] not in (None, before["sv01-191"])
    assert {source_id: group for source_id, group in moved.items() if source_id != "sv01-191"} == {
        source_id: group for source_id, group in before.items() if source_id != "sv01-191"}
    assert revision() == imported + 1  # Effect text is not an attribute input: only the group changed.
    run(Records(*CARDS))
    assert (groups_of(*all_ids()), revision()) == (before, imported + 2)


def test_a_withdrawn_printing_leaves_its_group():
    reset_catalog()
    run(Records(*CARDS, CANDY_POCKET))
    grouped = groups_of(*all_ids(), "A3-144")
    assert grouped["A3-144"] == grouped["me01-125"]
    imported = revision()
    run(Withdrawing(*CARDS, excluded_ids={"A3-144"}, excluded_sets={"A3"}))
    withdrawn = groups_of(*all_ids(), "A3-144")
    assert withdrawn["A3-144"] is None and withdrawn["me01-125"] == grouped["me01-125"]
    assert revision() == imported + 1


def test_a_pending_name_review_keeps_the_established_group():
    reset_catalog()
    run(Records(*CARDS))
    before = groups_of(*all_ids())
    renamed = edited(CANDY_SV, name="Rare Candy δ", effect=SM_CANDY)
    run(Records(*(renamed if record is CANDY_SV else record for record in CARDS)))
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_review WHERE kind='name_change' AND status='pending'"
                            ).fetchone()["n"] == 1
    assert groups_of(*all_ids()) == before


def test_a_pending_reference_review_keeps_the_established_group():
    reset_catalog()
    run(Records(*CARDS))
    before = groups_of(*all_ids())
    # The source reference now names another set and number, with other text: until the owner reviews it, the record
    # may describe another physical Printing, so it must not move the established Printing to another group.
    moved = edited(CANDY_SV, set={"id": "sv02", "name": "Paldea Evolved"}, localId="999", effect=SM_CANDY)
    run(Records(*(moved if record is CANDY_SV else record for record in CARDS)))
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_review WHERE kind='reference_change' AND status='pending'"
                            ).fetchone()["n"] == 1
    assert groups_of(*all_ids()) == before


def test_the_pending_review_query_reads_by_the_status_index():
    """refresh_reprint_groups reads the Printings with a pending name or reference review once, with PENDING, instead
    of looking reviews up per Printing: catalog_review has no printing_id index (Deck Lists 19, from #94). This checks
    PENDING's plan: it is keyed by catalog_review_pending (its status prefix). Seq scans are priced out, as row counts
    would at catalog scale. The pending-review tests above cover the behaviour."""
    from app.games.pokemon.catalog.reprint_groups import PENDING
    with connect() as conn, conn.transaction():
        conn.execute("SET LOCAL enable_seqscan=off")
        plan = conn.execute("EXPLAIN (FORMAT JSON) " + PENDING).fetchone()["QUERY PLAN"][0]["Plan"]
    keyed = []

    def walk(node):
        if node.get("Index Name") == "catalog_review_pending" and "status" in node.get("Index Cond", ""):
            keyed.append(node["Node Type"])
        for child in node.get("Plans", []):
            walk(child)
    walk(plan)
    assert keyed, plan


def test_rederiving_forms_groups_for_a_catalog_imported_before_reprint_groups():
    reset_catalog()
    run(Records(*CARDS))
    before = groups_of(*all_ids())
    with connect() as conn:
        conn.execute("DELETE FROM catalog_derived_reprint_group")  # The state migration 035 leaves a catalog in.
    assert set(groups_of(*all_ids()).values()) == {None}
    imported = revision()
    with connect() as conn:
        assert rederive_card_attributes(conn) == 0  # It reports attribute changes; none here.
    assert (groups_of(*all_ids()), revision()) == (before, imported + 1)


# Every table Reprint Group membership is stored or derived in. Readers must reach only the stored effective membership.
GROUP_TABLES = ("catalog_reprint_group_membership", "catalog_derived_reprint_group", "catalog_reprint_group_link",
                "catalog_reprint_group_assignment")


def scans(query, params):
    """Every scan of a Reprint Group table in the query's plan as (relation, node type, keyed), where keyed means the
    scan looks rows up by an index condition. Seq scans are priced out, as row counts would at catalog scale."""
    with connect() as conn, conn.transaction():
        conn.execute("SET LOCAL enable_seqscan=off")
        plan = conn.execute("EXPLAIN (FORMAT JSON) " + query, params).fetchone()["QUERY PLAN"][0]["Plan"]
    found = []

    def walk(node):
        if node.get("Relation Name") in GROUP_TABLES:
            children = node.get("Plans", [])
            found.append((node["Relation Name"], node["Node Type"],
                          "Index Cond" in node or any("Index Cond" in child for child in children)))
        for child in node.get("Plans", []):
            walk(child)
    walk(plan)
    return found


def test_format_checks_look_reprint_groups_up_by_index():
    from app.games.pokemon.formats.deck_format_checks import LINES, MEMBERS  # Imported here: the module imports app.main's routers.
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("sv01-191", 4)])
    group = groups_of("sv01-191")["sv01-191"]
    for query, params in ((LINES, (owner, deck)), (MEMBERS, ([group],))):
        found = scans(query, params)
        assert {relation for relation, _, _ in found} == {"catalog_reprint_group_membership"}, (query, found)
        assert all(keyed and "Seq" not in kind for _, kind, keyed in found), (query, found)


def test_old_rare_candy_is_standard_legal_through_its_reprint_group():
    reset_catalog()
    run(Records(*CARDS))
    # Each is out of Standard on its own on 2026-10-11: mark G has rotated, and swsh1 and swsh12.5 are excluded sets.
    owner, deck = deck_with([("sv01-191", 2), ("swsh1-180", 1), ("swsh12.5-141", 1), ("svp-225", 1), ("sv02-278", 55)])
    result = standard(owner, deck, "2026-10-11")
    assert (result["status"], result["issues"]) == ("legal", [])
    # Without a legal printing in the group, each is judged on its own.
    reworded = edited(CANDY_ME, effect=ME_CANDY.replace("first turn", "first two turns"))
    run(Records(*(reworded if record is CANDY_ME else record for record in CARDS)))
    result = standard(owner, deck, "2026-10-11")
    assert result["status"] == "not_legal"
    assert issues(result) == {
        ("not_in_card_pool", "regulation mark G rotated out of Standard on 2026-04-10", "card", "not_legal",
         lines("sv01-191")),
        ("not_in_card_pool", "not in the Standard card pool: Sword & Shield era, regulation marks D to F, all rotated "
                             "out by 2025-04-11", "card", "not_legal", lines("swsh1-180", "swsh12.5-141"))}


def test_reworded_rare_candy_sm1_129_is_its_own_group_until_review_merges_it():
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("sm1-129", 4), ("svp-225", 1), ("sv02-278", 55)])
    result = standard(owner, deck, "2026-10-11")
    assert issues(result) == {("not_in_card_pool", "not in the Standard card pool: printed before Sword & Shield, "
                                                   "without a regulation mark", "card", "not_legal", lines("sm1-129"))}


def test_a_pokemon_with_a_legal_identical_reprint_stays_not_legal():
    reset_catalog()
    run(Records(*CARDS))
    groups = groups_of("svp-101", "svp-225")
    assert groups["svp-101"] == groups["svp-225"] is not None
    owner, deck = deck_with([("svp-101", 4), ("sv02-278", 56)])
    result = standard(owner, deck, "2026-10-11")
    assert issues(result) == {("not_in_card_pool", "regulation mark G rotated out of Standard on 2026-04-10", "card",
                               "not_legal", lines("svp-101"))}
    owner, deck = deck_with([("svp-225", 4), ("sv02-278", 56)])
    assert standard(owner, deck, "2026-10-11")["status"] == "legal"
    owner, deck = deck_with([("svp-101", 4), ("sv02-278", 56)])
    assert standard(owner, deck, "2026-04-09")["status"] == "legal"


def test_a_command_adding_a_card_legal_through_its_reprint_group_returns_legal_and_a_read_reuses_it(monkeypatch):
    """The command path (Deck Lists 17) judges Reprint Groups like the read path, and the read reuses what it saved."""
    from app.games.pokemon.formats import deck_format_checks  # Imported here: the module imports app.main's routers.
    monkeypatch.setattr(deck_format_checks, "today", lambda: date(2026, 10, 11))
    reset_catalog()
    run(Records(*CARDS))
    owner = f"reprint-command-{uuid4()}"
    created = call("POST", "/api/decks", owner, {"name": "Reprint deck", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    assert add_line(owner, deck, edition_of("sv02-278"), "55", 1).status_code == 200
    assert add_line(owner, deck, edition_of("svp-225"), "1", 2).status_code == 200
    # Crown Zenith's Rare Candy has no regulation mark: legal only through me01-125 (mark I) in its Reprint Group.
    response = add_line(owner, deck, edition_of("swsh12.5-141"), "4", 3)
    assert response.status_code == 200, response.text
    checks = response.json()["format_checks"]
    # The command answers the Target Format, Standard (app redesign #178).
    assert [(result["format"], result["status"], result["issues"]) for result in checks["results"]] == [
        ("standard", "legal", [])]
    # The next read reuses the saved result: the same body, computed at the same time.
    assert format_checks(owner, deck) == checks
    assert {result["format"]: (result["status"], result["issues"]) for result in every_format(
        owner, deck, checks["results"][0]["evaluated_on"])} == {
        "standard": ("legal", []), "expanded": ("legal", []),
        "glc": ("not_legal", [{"code": "copy_limit", "reason": "more than 1 copy of Rare Candy (4)", "kind": "card",
                               "effect": "not_legal", "lines": [edition_of("swsh12.5-141")]}])}
