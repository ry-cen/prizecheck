"""Reprint Groups (Deck Lists 13, issue #94): formed on catalog import, stable across re-imports, and read by format
checks over signed HTTP.

The records are minimal copies of real TCGdex English records from the 2026-10-10 crawl, cut down to the fields the
attribute and rules-text rules read. Records whose ID starts with "fixture-" are made up for one rule.
"""
from app.catalog import rederive_card_attributes
from app.main import connect
from app.reprint_groups import RULES, ReprintTextRules, read_reprint_groups, rules_digest
from test_card_attributes import ENERGY_SV, SWITCH_ME, card, printing_ids, revision
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run, seed_manual
from test_deck_format_checks import deck_with, issues, lines, standard

# Changing a rules-text rule changes this digest: bump ReprintTextRules.VERSION and pin the new pair here.
PINNED_RULES = (1, "4c41cbb597dd1b97d2f00bef3476b3342a85e43e6f0e8774b721f381444b9d55")

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


def test_rederiving_forms_groups_for_a_catalog_imported_before_reprint_groups():
    reset_catalog()
    run(Records(*CARDS))
    before = groups_of(*all_ids())
    with connect() as conn:
        conn.execute("DELETE FROM catalog_derived_reprint_group")  # The state migration 031 leaves a catalog in.
    assert set(groups_of(*all_ids()).values()) == {None}
    imported = revision()
    with connect() as conn:
        assert rederive_card_attributes(conn) == 0  # It reports attribute changes; none here.
    assert (groups_of(*all_ids()), revision()) == (before, imported + 1)


def scans(query, params):
    """Every scan of the derived group table in the query's plan as (node type, keyed), where keyed means the scan
    looks rows up by an index condition. Seq scans are priced out, as row counts would at catalog scale."""
    with connect() as conn, conn.transaction():
        conn.execute("SET LOCAL enable_seqscan=off")
        plan = conn.execute("EXPLAIN (FORMAT JSON) " + query, params).fetchone()["QUERY PLAN"][0]["Plan"]
    found = []

    def walk(node):
        if node.get("Relation Name") == "catalog_derived_reprint_group":
            children = node.get("Plans", [])
            found.append((node["Node Type"], "Index Cond" in node or any("Index Cond" in child for child in children)))
        for child in node.get("Plans", []):
            walk(child)
    walk(plan)
    return found


def test_format_checks_look_reprint_groups_up_by_index():
    from app.deck_format_checks import LINES, MEMBERS  # Imported here: the module imports app.main's routers.
    reset_catalog()
    run(Records(*CARDS))
    owner, deck = deck_with([("sv01-191", 4)])
    group = groups_of("sv01-191")["sv01-191"]
    for query, params in ((LINES, (owner, deck)), (MEMBERS, ([group],))):
        found = scans(query, params)
        assert found and all(keyed and "Seq" not in kind for kind, keyed in found), (query, found)


def test_old_rare_candy_is_standard_legal_through_its_reprint_group():
    reset_catalog()
    run(Records(*CARDS))
    # Each is out of Standard on its own on 2026-10-11: mark G has rotated, and swsh1 and swsh12.5 are excluded sets.
    owner, deck = deck_with([("sv01-191", 2), ("swsh1-180", 1), ("swsh12.5-141", 1), ("sv02-278", 56)])
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
    owner, deck = deck_with([("sm1-129", 4), ("sv02-278", 56)])
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
