"""Card attributes derived from catalog source records (Deck Lists 02, issue #83).

The records are minimal copies of real TCGdex English records from the 2026-10-10 crawl
(docs/planning/deck-format-validation/wayfinder/research/tcgdex-legality-data.md), cut down to the fields the
derivation rules read.
"""
import os
from uuid import uuid4

import psycopg
import pytest

from app.card_attributes import RULES, UNKNOWN, CardAttributeRules, CardAttributes, attribute_revision, \
    read_card_attributes, rules_digest
from app.catalog import RunnerBusy, rederive_card_attributes
from app.main import connect
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run, seed_manual
from test_deck_lists import add_line, detail
from test_holdings import add, call

# Changing a derivation rule changes this digest: bump CardAttributeRules.VERSION and pin the new pair here.
PINNED_RULES = (1, "858926b6998227fa6fdcf791535cb3bb81bd372d481b01d97ce4bc739afd668a")


def card(**fields):
    return {**fields, "variants": {"normal": True}}


ENERGY_BW = card(id="bw1-105", name="Grass Energy", localId="105", category="Energy",
                 set={"id": "bw1", "name": "Black & White"}, energyType="Normal", stage="Basic", rarity="Common")
ENERGY_SV = card(id="sv02-278", name="Basic Grass Energy", localId="278", category="Energy",
                 set={"id": "sv02", "name": "Paldea Evolved"}, energyType="Normal", rarity="Hyper rare", types=["Grass"])
# TCGdex labels this Special Energy "Normal"; sv02-192 is the correctly labelled printing of the same card.
REVERSAL_MISLABELLED = card(id="sv04-266", name="Reversal Energy", localId="266", category="Energy",
                            set={"id": "sv04", "name": "Paradox Rift"}, energyType="Normal", regulationMark="G",
                            rarity="Hyper rare")
REVERSAL = card(id="sv02-192", name="Reversal Energy", localId="192", category="Energy",
                set={"id": "sv02", "name": "Paldea Evolved"}, energyType="Special", regulationMark="G", rarity="Uncommon")
TRAINER_KIT_ENERGY = card(id="tk-hs-g-10", name="Water Energy", localId="10", category="Energy",
                          set={"id": "tk-hs-g", "name": "HS trainer Kit (Gyarados)"}, rarity="None", types=["Water"])
OLD_DARKNESS_ENERGY = card(id="dp2-119", name="Darkness Energy", localId="119", category="Energy",
                           set={"id": "dp2", "name": "Mysterious Treasures"}, energyType="Special", rarity="Uncommon")
EX_BW = card(id="bw6-124", name="Giratina-EX", localId="124", category="Pokemon",
             set={"id": "bw6", "name": "Dragons Exalted"}, suffix="EX", rarity="Ultra Rare", types=["Dragon"])
GX_PROMO = card(id="smp-SM232", name="Pikachu GX", localId="SM232", category="Pokemon",
                set={"id": "smp", "name": "SM Black Star Promos"}, rarity="Promo", types=["Lightning"])
MEGA_EX = card(id="xy11-109", name="M Steelix EX", localId="109", category="Pokemon",
               set={"id": "xy11", "name": "Steam Siege"}, suffix="EX", stage="MEGA", rarity="Ultra Rare",
               types=["Metal", "Fighting"])
VMAX = card(id="swsh1-116", name="Stonjourner VMAX", localId="116", category="Pokemon",
            set={"id": "swsh1", "name": "Sword & Shield"}, regulationMark="D", stage="VMAX", rarity="Holo Rare VMAX",
            types=["Fighting"])
EX_SV = card(id="sv01-032", name="Arcanine ex", localId="032", category="Pokemon",
             set={"id": "sv01", "name": "Scarlet & Violet"}, regulationMark="G", suffix="ex", stage="Stage1",
             rarity="Double rare", types=["Fire"])
EX_ME_UPPER_SUFFIX = card(id="me04-015", name="Mega Pyroar ex", localId="015", category="Pokemon",
                          set={"id": "me04", "name": "Chaos Rising"}, regulationMark="J", suffix="EX", stage="Stage1",
                          rarity="Double rare", types=["Fire"])
EX_ME_NO_SUFFIX = card(id="me02-018", name="Oricorio ex", localId="018", category="Pokemon",
                       set={"id": "me02", "name": "Phantasmal Flames"}, regulationMark="I", stage="Basic",
                       rarity="Double rare", types=["Fire"])
DELTA_EX = card(id="ex15-90", name="Altaria ex δ", localId="90", category="Pokemon",
                set={"id": "ex15", "name": "Dragon Frontiers"}, suffix="ex", stage="Stage1", rarity="Rare", types=["Water"])
RAICHU_SUFFIX_EX = card(id="sv02-064", name="Raichu", localId="064", category="Pokemon",
                        set={"id": "sv02", "name": "Paldea Evolved"}, regulationMark="G", suffix="ex", stage="Stage1",
                        rarity="Uncommon", types=["Lightning"])
ZACIAN_STAGE_BREAK = card(id="swshp-SWSH135", name="Zacian", localId="SWSH135", category="Pokemon",
                          set={"id": "swshp", "name": "SWSH Black Star Promos"}, stage="BREAK", rarity="Promo",
                          types=["Metal"])
UNOWN_V = card(id="dp6-79", name="Unown V", localId="79", category="Pokemon",
               set={"id": "dp6", "name": "Legends Awakened"}, stage="Basic", rarity="Uncommon", types=["Psychic"])
LEGEND = card(id="hgss1-111", name="Ho-Oh LEGEND", localId="111", category="Pokemon",
              set={"id": "hgss1", "name": "HeartGold SoulSilver"}, suffix="Legend", stage="Basic", rarity="LEGEND",
              types=["Fire"])
POKEMON_STAR = card(id="pop5-16", name="Espeon ★", localId="16", category="Pokemon",
                    set={"id": "pop5", "name": "POP Series 5"}, stage="Basic", rarity="Rare", types=["Psychic"])
RADIANT = card(id="swsh10-046", name="Radiant Greninja", localId="046", category="Pokemon",
               set={"id": "swsh10", "name": "Astral Radiance"}, regulationMark="F", stage="Basic", rarity="Radiant Rare",
               types=["Water"])
PRISM_TRAINER = card(id="sm5-120", name="Cyrus ◇", localId="120", category="Trainer",
                     set={"id": "sm5", "name": "Ultra Prism"}, rarity="Rare")
PRISM_POKEMON = card(id="sm5-58", name="Giratina ◇", localId="58", category="Pokemon",
                     set={"id": "sm5", "name": "Ultra Prism"}, stage="Basic", rarity="Rare", types=["Psychic"])
ACE_SPEC_SV = card(id="sv05-157", name="Prime Catcher", localId="157", category="Trainer",
                   set={"id": "sv05", "name": "Temporal Forces"}, regulationMark="H", rarity="ACE SPEC Rare")
ACE_SPEC_ENERGY = card(id="sv05-162", name="Neo Upper Energy", localId="162", category="Energy",
                       set={"id": "sv05", "name": "Temporal Forces"}, energyType="Special", regulationMark="H",
                       rarity="ACE SPEC Rare")
ACE_SPEC_BW = card(id="bw7-137", name="Computer Search", localId="137", category="Trainer",
                   set={"id": "bw7", "name": "Boundaries Crossed"}, rarity="Rare")
# An ACE SPEC by name: Black & White printings carry no ACE SPEC marker.
ACE_SPEC_BW_PLASMA = card(id="bw10-95", name="Scoop Up Cyclone", localId="95", category="Trainer",
                          set={"id": "bw10", "name": "Plasma Blast"}, rarity="Rare")
# Near-misses of ACE SPEC names (Scramble Switch, Energy Search Pro).
SWITCH_ME = card(id="me01-130", name="Switch", localId="130", category="Trainer",
                 set={"id": "me01", "name": "Mega Evolution"}, regulationMark="I", rarity="Common")
ENERGY_SEARCH = card(id="sv01-172", name="Energy Search", localId="172", category="Trainer",
                     set={"id": "sv01", "name": "Scarlet & Violet"}, regulationMark="G", rarity="Common")
ENERGY_MEE = card(id="mee-001", name="Grass Energy", localId="001", category="Energy",
                  set={"id": "mee", "name": "Mega Evolution Energy"}, energyType="Normal", rarity="Common")
# A set the ACE SPEC research has not settled (me06 Delta Reign was unreleased on 2026-10-10).
UNSETTLED_TRAINER = card(id="fixture-me06-1", name="Fixture Trainer", localId="1", category="Trainer",
                         set={"id": "me06", "name": "Delta Reign"}, regulationMark="J", rarity="Uncommon")
UNSETTLED_ENERGY = card(id="fixture-me06-2", name="Fire Energy", localId="2", category="Energy",
                        set={"id": "me06", "name": "Delta Reign"}, energyType="Normal", rarity="Common")
COMPUTER_SEARCH_BASE = card(id="base1-71", name="Computer Search", localId="71", category="Trainer",
                            set={"id": "base1", "name": "Base Set"}, rarity="Rare")
RARE_CANDY_ME = card(id="me01-125", name="Rare Candy", localId="125", category="Trainer",
                     set={"id": "me01", "name": "Mega Evolution"}, regulationMark="I", rarity="Common")
RARE_CANDY_SM = card(id="sm1-129", name="Rare Candy", localId="129", category="Trainer",
                     set={"id": "sm1", "name": "Sun & Moon"}, rarity="Uncommon")
LOWER_CASE_MARK = card(id="mep-051", name="Oshawott", localId="051", category="Pokemon",
                       set={"id": "mep", "name": "MEP Black Star Promos"}, regulationMark="j", stage="Basic",
                       rarity="Promo", types=["Water"])
NONE_MARK = card(id="mfb-33", name="Potion", localId="33", category="Trainer",
                 set={"id": "mfb", "name": "My First Battle"}, regulationMark="None", rarity="None")
NO_TYPES = card(id="swshp-SWSH215", name="Morpeko V-UNION", localId="SWSH215", category="Pokemon",
                set={"id": "swshp", "name": "SWSH Black Star Promos"}, regulationMark="E", suffix="V", rarity="Promo")
DUAL_TYPE = card(id="xy11-11", name="Shiftry", localId="11", category="Pokemon",
                 set={"id": "xy11", "name": "Steam Siege"}, stage="Stage2", rarity="Rare", types=["Grass", "Darkness"])
NO_CATEGORY = card(id="fixture-no-category", name="Arcanine ex", localId="1", set={"id": "fixture", "name": "Fixture"},
                   regulationMark="G", suffix="ex", stage="Stage1", types=["Fire"])


def attributes(mark=None, kind=None, basic=None, types=None, rule_box=None, ace=None, radiant=None, prism=None):
    return CardAttributes(mark, kind, basic, types, rule_box, ace, radiant, prism)


def pokemon(mark, types, rule_box, radiant=False, prism=False):
    return attributes(mark, "pokemon", False, types, rule_box, False, radiant, prism)


def trainer(mark, ace=False, rule_box=False, prism=False):
    return attributes(mark, "trainer", False, (), rule_box, ace, False, prism)


def energy(mark, basic, ace=False):
    return attributes(mark, "energy", basic, (), False, ace, False, False)


EXPECTED = {
    "bw1-105": energy(None, True),
    "sv02-278": energy(None, True),
    "sv04-266": energy("G", False),
    "sv02-192": energy("G", False),
    "tk-hs-g-10": energy(None, None),
    "dp2-119": energy(None, False),
    "bw6-124": pokemon(None, ("Dragon",), True),
    "smp-SM232": pokemon(None, ("Lightning",), True),
    "xy11-109": pokemon(None, ("Metal", "Fighting"), True),
    "swsh1-116": pokemon("D", ("Fighting",), True),
    "sv01-032": pokemon("G", ("Fire",), True),
    "me04-015": pokemon("J", ("Fire",), True),
    "me02-018": pokemon("I", ("Fire",), True),
    "ex15-90": pokemon(None, ("Water",), True),
    "sv02-064": pokemon("G", ("Lightning",), None),
    "swshp-SWSH135": pokemon(None, ("Metal",), None),
    "dp6-79": pokemon(None, ("Psychic",), None),
    "hgss1-111": pokemon(None, ("Fire",), None),
    "pop5-16": pokemon(None, ("Psychic",), None),
    "swsh10-046": pokemon("F", ("Water",), True, radiant=True),
    "sm5-120": trainer(None, rule_box=True, prism=True),
    "sm5-58": pokemon(None, ("Psychic",), True, prism=True),
    "sv05-157": trainer("H", ace=True),
    "sv05-162": energy("H", False, ace=True),
    "bw7-137": trainer(None, ace=True),
    "bw10-95": trainer(None, ace=True),
    "me01-130": trainer("I"),
    "sv01-172": trainer("G"),
    "mee-001": energy(None, True),
    "fixture-me06-1": trainer("J", ace=None),
    "fixture-me06-2": energy(None, True),
    "base1-71": trainer(None),
    "me01-125": trainer("I"),
    "sm1-129": trainer(None),
    "mep-051": pokemon("J", ("Water",), False),
    "mfb-33": trainer(None),
    "swshp-SWSH215": pokemon("E", None, True),
    "xy11-11": pokemon(None, ("Grass", "Darkness"), False),
    "fixture-no-category": attributes("G"),
}
CARDS = (ENERGY_BW, ENERGY_SV, REVERSAL_MISLABELLED, REVERSAL, TRAINER_KIT_ENERGY, OLD_DARKNESS_ENERGY, EX_BW, GX_PROMO,
         MEGA_EX, VMAX, EX_SV, EX_ME_UPPER_SUFFIX, EX_ME_NO_SUFFIX, DELTA_EX, RAICHU_SUFFIX_EX, ZACIAN_STAGE_BREAK,
         UNOWN_V, LEGEND, POKEMON_STAR, RADIANT, PRISM_TRAINER, PRISM_POKEMON, ACE_SPEC_SV, ACE_SPEC_ENERGY, ACE_SPEC_BW,
         COMPUTER_SEARCH_BASE, RARE_CANDY_ME, RARE_CANDY_SM, LOWER_CASE_MARK, NONE_MARK, NO_TYPES, DUAL_TYPE, NO_CATEGORY,
         ACE_SPEC_BW_PLASMA, SWITCH_ME, ENERGY_SEARCH, ENERGY_MEE, UNSETTLED_TRAINER, UNSETTLED_ENERGY)


def printing_ids(*source_ids):
    with connect() as conn:
        rows = conn.execute("SELECT source_id,id FROM catalog_printing WHERE source_id=ANY(%s)", (list(source_ids),))
        return {row["source_id"]: row["id"] for row in rows}


def attributes_of(*source_ids):
    ids = printing_ids(*source_ids)
    with connect() as conn:
        found = read_card_attributes(conn, ids.values())
    return {source_id: found[printing_id] for source_id, printing_id in ids.items()}


def revision():
    with connect() as conn:
        return attribute_revision(conn)


def edition_of(source_id):
    with connect() as conn:
        return str(conn.execute("""SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          WHERE p.source_id=%s""", (source_id,)).fetchone()["id"])


def test_derivation_rules_are_pinned():
    assert (RULES.VERSION, rules_digest()) == PINNED_RULES


def test_import_derives_every_attribute_on_cards_across_eras():
    reset_catalog()
    run(Records(*CARDS))
    assert attributes_of(*EXPECTED) == EXPECTED


def test_missing_or_contradictory_source_data_leaves_attributes_unknown():
    reset_catalog()
    run(Records(TRAINER_KIT_ENERGY, RAICHU_SUFFIX_EX, UNOWN_V, NONE_MARK, NO_TYPES, UNSETTLED_TRAINER, NO_CATEGORY))
    found = attributes_of("tk-hs-g-10", "sv02-064", "dp6-79", "mfb-33", "swshp-SWSH215", "fixture-me06-1",
                          "fixture-no-category")
    assert found["tk-hs-g-10"].basic_energy is None          # no energyType
    assert found["sv02-064"].rule_box is None                # suffix "ex" on a name without ex
    assert found["dp6-79"].rule_box is None                  # a bare " V" without the V suffix
    assert found["mfb-33"].regulation_mark is None           # regulationMark "None"
    assert found["swshp-SWSH215"].types is None              # no types
    assert found["fixture-me06-1"].ace_spec is None          # a set whose ACE SPECs are not settled
    assert found["fixture-no-category"] == CardAttributes(regulation_mark="G")


def test_manual_printings_have_unknown_attributes():
    reset_catalog()
    run(Records(EX_SV))
    manual, _ = seed_manual()
    with connect() as conn:
        assert read_card_attributes(conn, [manual]) == {manual: UNKNOWN}
    run(Records(EX_SV))
    with connect() as conn:
        assert read_card_attributes(conn, [manual]) == {manual: UNKNOWN}


def test_attribute_revision_advances_once_when_any_printings_attributes_change():
    reset_catalog()
    before = revision()
    run(Records(*CARDS))
    imported = revision()
    assert imported == before + 1
    run(Records(*CARDS))
    assert revision() == imported
    # Prices and set growth are not attribute inputs.
    priced = {**ENERGY_BW, "pricing": {"tcgplayer": {"unit": "USD", "normal": {"productId": 1, "marketPrice": 0.1}}},
              "set": {**ENERGY_BW["set"], "cardCount": {"official": 114, "total": 115}}}
    run(Records(priced, *CARDS[1:]))
    assert revision() == imported
    typed = {**TRAINER_KIT_ENERGY, "energyType": "Normal"}
    tagged = {**RARE_CANDY_SM, "rarity": "ACE SPEC Rare"}
    unchanged = [record for record in CARDS if record["id"] not in ("tk-hs-g-10", "sm1-129")]
    run(Records(typed, tagged, *unchanged))
    assert revision() == imported + 1
    found = attributes_of("tk-hs-g-10", "sm1-129")
    assert found["tk-hs-g-10"].basic_energy is True and found["sm1-129"].ace_spec is True


def test_a_rules_change_reaches_unchanged_records_on_the_next_import(monkeypatch):
    reset_catalog()
    run(Records(*CARDS))
    imported = revision()
    monkeypatch.setattr(CardAttributeRules, "VERSION", RULES.VERSION + 1)
    run(Records(*CARDS))
    assert revision() == imported  # A new rules version that derives the same values changes nothing.
    monkeypatch.setattr(CardAttributeRules, "ACE_SPEC_NAMES", CardAttributeRules.ACE_SPEC_NAMES + ("Rare Candy",))
    run(Records(*CARDS))
    assert revision() == imported + 1
    assert {card.ace_spec for card in attributes_of("sm1-129", "me01-125").values()} == {True}


def test_a_pending_name_review_keeps_the_established_attributes():
    reset_catalog()
    run(Records(RAICHU_SUFFIX_EX))
    renamed = {**RAICHU_SUFFIX_EX, "name": "Raichu ex"}
    run(Records(renamed))
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_review WHERE kind='name_change' AND status='pending'"
                            ).fetchone()["n"] == 1
    assert attributes_of("sv02-064")["sv02-064"].rule_box is None


def test_rederiving_fills_printings_imported_before_card_attributes_and_waits_for_imports():
    reset_catalog()
    run(Records(*CARDS))
    with connect() as conn:
        conn.execute("DELETE FROM catalog_derived_attribute")  # The state migration 026 leaves an existing catalog in.
    assert set(attributes_of(*EXPECTED).values()) == {UNKNOWN}
    with psycopg.connect(os.environ["DATABASE_URL"]) as importer:
        importer.execute("SELECT pg_advisory_lock(914703)")
        with connect() as conn, pytest.raises(RunnerBusy):
            rederive_card_attributes(conn)
        importer.execute("SELECT pg_advisory_unlock(914703)")
    assert set(attributes_of(*EXPECTED).values()) == {UNKNOWN}
    with connect() as conn:
        assert rederive_card_attributes(conn) == len(CARDS)
    assert attributes_of(*EXPECTED) == EXPECTED
    with connect() as conn:
        assert rederive_card_attributes(conn) == 0


def test_basic_energy_exemption_reads_the_derived_attribute_in_both_check_modes():
    reset_catalog()
    run(Records(ENERGY_BW, ENERGY_SV, REVERSAL_MISLABELLED, TRAINER_KIT_ENERGY, EX_SV))
    owner = f"attributes-{uuid4()}"
    created = call("POST", "/api/decks", owner, {"name": "Energy deck", "idempotency_key": str(uuid4())})
    assert created.status_code == 201, created.text
    deck = created.json()["location"]["id"]
    # Lines first, then the same copies as Holdings, so both check modes see five of each card.
    list_revision = 1
    for source_id in ("bw1-105", "sv02-278", "sv04-266", "tk-hs-g-10", "sv01-032"):
        response = add_line(owner, deck, edition_of(source_id), "5", list_revision)
        assert response.status_code == 200, response.text
        list_revision = response.json()["deck_list"]["revision"]
        response = add(owner, deck, edition_of(source_id), "5")
        assert response.status_code == 200, response.text
    expected = {"Grass Energy": "basic_energy_exempt", "Basic Grass Energy": "basic_energy_exempt",
                "Reversal Energy": "over_limit",  # sv04-266 is a Special Energy even though TCGdex says Normal
                "Water Energy": "unresolved", "Arcanine ex": "over_limit"}
    body = detail(owner, deck)
    for checks in (body["checks"], body["deck_list_checks"]):
        assert checks["total"] == "25"
        assert {row["name"]: row["status"] for row in checks["identities"]} == expected
        assert {row["quantity"] for row in checks["identities"]} == {"5"}
