"""Collection Import matching (#228): a TCGplayer product ID first, then the row's set and number through the
collection set-name alias table (collection_import_aliases.tsv) or naive set-name normalisation, the printed set code
for Dragon Shield and Sorted, each number rule, and Basic Energy by type; repeated rows sum at save, and a quantity
that isn't a whole number from 1 up is Can't read. Signed HTTP against PostgreSQL, with test_collection_import's
catalog seed and MATCHING_CARDS: real TCGdex set IDs, set names (imported_sets.txt) and collector numbers, read from
https://api.tcgdex.net/v2/en on 2026-10-15.

The three match-rate fixtures (collection_import_fixtures/match-rate-*.csv) are reconstructions, not the research
exports, and share no data line with them (only each file format's header line): they keep the research slice's
rows' edge cases (T1 tcgplayer-app, C1 and C2 collectr, TC1 tcg-collector: set-name spellings, number shapes, finish
words, blank cells, quoting, quantities) with other values (TCGplayer product and SKU IDs replaced by 9100xx and 8100xx,
and Koraidon's by a lookup ID this seed lists; Collectr's portfolio, prices and dates, TCG Collector's conditions and
notes made up), padded with plain rows of this seed's cards. The padding is the fewest rows that reach the ticket's
floor while every rule works, so losing any one hard row drops the fixture below it. The rows still not found are the
ones the ticket leaves to later work: catch-all sets (Miscellaneous, League, Prize Pack, Deck Exclusives, Battle
Academy), and cards this seed doesn't hold.
"""
import csv
import io
from pathlib import Path

import pytest

from app import collection_import_aliases as aliases
from app.main import connect  # first: app.main imports the routers, and they import it
from test_batch_add import held
from test_collection_import import _card, _detailed, all_rows, collector, edition, save, seed_import_catalog, started
from test_collection_import_finishes import (COLLECTR, DRAGON_SHIELD, PRICECHARTING, SORTED, TCG_COLLECTOR,
                                             TCGPLAYER, edition_where)
from test_set_codes import imported_sets

FIXTURES = Path(__file__).parent / "collection_import_fixtures"
SET_NAMES = imported_sets()
# The TCGdex lookup ID Koraidon ex's record lists (thirdParty.tcgplayer): the TCGplayer rate fixture's row uses it.
KORAIDON_PRODUCT = 9200001
READY = ("matched", "finish_unknown", "by_name")


def _set_of(source_id):
    set_id = source_id.rsplit("-", 1)[0]
    return set_id, SET_NAMES[set_id]


def pokemon(source_id, name, number, variants=None, **extra):
    return _card(source_id, name, number, *_set_of(source_id), variants=variants, category="Pokemon",
                 types=["Colorless"], **extra)


def trainer(source_id, name, number, variants=None):
    return _card(source_id, name, number, *_set_of(source_id), variants=variants, category="Trainer",
                 trainerType="Supporter")


def energy(source_id, name, number, variants=None):
    return _card(source_id, name, number, *_set_of(source_id), variants=variants, category="Energy",
                 energyType="Normal")


NORMAL_REVERSE = {"normal": True, "reverse": True}
HOLO = {"holo": True}
# Every Printing these tests match, beside seed_import_catalog's (Base Set, Jungle, Team Rocket Returns, Fixture ...).
MATCHING_CARDS = (
    pokemon("sv01-008", "Scatterbug", "008", NORMAL_REVERSE),
    pokemon("sv01-013", "Sprigatito", "013", NORMAL_REVERSE),
    pokemon("sv01-039", "Charcadet", "039", NORMAL_REVERSE),
    pokemon("sv01-254", "Koraidon ex", "254", HOLO, thirdParty={"tcgplayer": KORAIDON_PRODUCT}),
    pokemon("swsh1-2", "Roselia", "2"),
    pokemon("np-37", "Kyogre ex", "37", HOLO),
    pokemon("ecard1-1", "Alakazam", "1", HOLO),
    pokemon("svp-062", "Sinistea", "062", HOLO),
    pokemon("svp-129", "Pecharunt", "129", HOLO),
    pokemon("svp-160", "Squawkabilly ex", "160", HOLO),
    pokemon("swshp-SWSH138", "Hydreigon C", "SWSH138", HOLO),
    pokemon("mep-024", "Oricorio ex", "024", HOLO),
    pokemon("sv03.5-027", "Sandshrew", "027", NORMAL_REVERSE),
    pokemon("sv03.5-132", "Ditto", "132"),
    energy("sve-001", "Basic Grass Energy", "001"),
    energy("sve-002", "Basic Fire Energy", "002"),
    energy("sve-004", "Basic Lightning Energy", "004", NORMAL_REVERSE),
    energy("sve-007", "Basic Darkness Energy", "007"),
    energy("sve-008", "Basic Metal Energy", "008"),
    energy("sve-012", "Basic Lightning Energy", "012"),
    energy("base4-129", "Psychic Energy", "129"),
    pokemon("dpp-DP37", "Dialga", "DP37", HOLO),
    pokemon("swsh4.5sv-SV032", "Barraskewda", "SV032", HOLO),
    pokemon("swsh12tg-TG01", "Braixen", "TG01", HOLO),
    pokemon("me05-012", "Armarouge", "012", NORMAL_REVERSE),
    pokemon("cel25-1", "Ho-Oh", "1", HOLO),
    pokemon("neo3-14", "Suicune", "14", HOLO),
    trainer("swsh6-145", "Klara", "145", NORMAL_REVERSE),
    trainer("swsh6-194", "Klara", "194", HOLO),
    pokemon("pl2-113", "Flying Pikachu", "113", HOLO),
    pokemon("sv07-013", "Dipplin", "013", NORMAL_REVERSE),
    pokemon("xy1-1", "Venusaur EX", "1", HOLO),
    pokemon("sv09-001", "Caterpie", "001", NORMAL_REVERSE),
    pokemon("sv09-002", "Metapod", "002", NORMAL_REVERSE),
    pokemon("sv09-003", "Butterfree", "003", {"holo": True, "reverse": True}),
    pokemon("sv09-006", "Petilil", "006", NORMAL_REVERSE),
    trainer("swsh10-135", "Adaman", "135", {"holo": True, "reverse": True}),
    pokemon("swsh10tg-TG05", "Gardevoir", "TG05", HOLO),
    pokemon("gym2-98", "Sabrina's Porygon", "98", {"normal": True, "firstEdition": True}),
    pokemon("gym1-8", "Lt. Surge's Magneton", "8", HOLO),
    pokemon("sma-SV38", "Gible", "SV38", HOLO),
    trainer("swsh12-157", "Furisode Girl", "157", NORMAL_REVERSE),
    pokemon("me02.5-284", "Mega Gengar ex", "284", HOLO),
    pokemon("sv10.5b-059", "Krookodile", "059", None,
            variants_detailed=_detailed({"type": "normal"}, {"type": "reverse"},
                                        {"type": "reverse", "foil": "pokeball"},
                                        {"type": "reverse", "foil": "masterball"})),
)
# One card of each alias row's TCGdex set: (Printing, card name, number as the tracker writes it).
PROBES = {
    "sv01": ("sv01-013", "Sprigatito", "013/198"),
    "swsh1": ("swsh1-2", "Roselia", "002/202"),
    "np": ("np-37", "Kyogre ex", "037"),
    "ecard1": ("ecard1-1", "Alakazam", "1/165"),
    "base1": ("base1-64", "Starmie", "064/102"),
    "svp": ("svp-062", "Sinistea", "062"),
    "swshp": ("swshp-SWSH138", "Hydreigon C", "SWSH138"),
    "mep": ("mep-024", "Oricorio ex", "024"),
    "sv03.5": ("sv03.5-132", "Ditto", "132/165"),
    "sve": ("sve-001", "Basic Grass Energy", "1"),
}


def seed():
    seed_import_catalog(*MATCHING_CARDS)


def csv_file(header: str, *rows) -> bytes:
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerows(rows)
    return (header + out.getvalue()).encode()


def tcgplayer(name, set_name, number, printing="Normal", product="", code="", quantity="1"):
    """One row of the TCGplayer app's 12 columns; its Simple Name is the name without tags."""
    simple = name.split(" (")[0].split(" - ")[0]
    return [quantity, name, simple, set_name, number, code, printing, "Near Mint", "English", "Common", product, "1"]


def collectr(name, set_name, number, variance="Normal", quantity="1"):
    return ["Main", "Pokemon", set_name, name, number, "Rare", variance, "Ungraded", "Near Mint", "0", quantity,
            "0.10", "false", "2026-10-01"]


def tcg_collector(name, set_name, number, variant="Normal", quantity="1"):
    return ["International", set_name, number, "1", name, "Rare", variant, "English", "Near Mint", "", quantity]


def pricecharting(product_name, set_name, quantity="1"):
    return ["5000001", product_name, f"Pokemon {set_name}", "10", "Ungraded", "Normal wear", "", "", "0", quantity,
            "2026-10-01", "", "", "", "Collection"]


def dragon_shield(name, code, set_name, number, printing="Normal"):
    return ["Binder", "1", "0", name, code, set_name, number, "NearMint", printing, "English", "0", "2026-10-01", "0",
            "0", "0"]


def sorted_row(name, code, set_name, number, printing="Normal"):
    return ["Folder", "Binder", "pok", "", "", "1", name, code, set_name, number, "NearMint", printing, "Rare", "en",
            "0", "2026-10-01", "", "", "0.10", "1", ""]


HEADERS = {"tcgplayer_app": TCGPLAYER, "collectr": COLLECTR, "tcg_collector": TCG_COLLECTOR}
ROWS = {"tcgplayer_app": tcgplayer, "collectr": collectr, "tcg_collector": tcg_collector}


def printings() -> dict:
    """Printing id (text) -> TCGdex source ID, for every Printing in the catalog."""
    with connect() as conn:
        return {str(row["id"]): row["source_id"]
                for row in conn.execute("SELECT id,source_id FROM catalog_printing")}


def outcomes(owner, summary):
    """(status, the matched Printing's source ID or None) per row, in file order."""
    by_id = printings()
    return [(row["status"], by_id[str(row["card"]["printing_id"])] if row["card"] else None)
            for row in all_rows(owner, summary["id"])]


def candidates(summary):
    """Each row's stored candidates, as source IDs, in file order."""
    by_id = printings()
    with connect() as conn:
        found = conn.execute("""SELECT candidates FROM collection_import_row WHERE import_id=%s ORDER BY row_number""",
                             (summary["id"],)).fetchall()
    return [[by_id[printing] for printing in row["candidates"]] for row in found]


def imported(header, *rows):
    owner, unsorted = collector()
    summary = started(owner, unsorted, csv_file(header, *rows))
    return owner, unsorted, summary


def verify(edition_id, product_id):
    """A verified Marketplace Mapping of this Edition to `product_id` (test_deck_cost.verified_editions writes one)."""
    with connect() as conn:
        reviewer = f"reviewer-{edition_id}"
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (reviewer,))
        activation = conn.execute("""INSERT INTO catalog_rule_activation(kind,reviewer_id,evidence_url,reason,
            clock_revision) VALUES ('marketplace_matching',%s,'https://example.org/rule','Fixture activation',1)
          RETURNING id""", (reviewer,)).fetchone()["id"]
        updated = conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='verified',mapping_reason=NULL,
            product_id=%s,quote_variant='normal',mapping_basis='matching_rule',matching_activation_id=%s,
            auto_closed=true
          WHERE edition_id=%s""", (product_id, activation, edition_id)).rowcount
    assert updated == 1


def test_the_alias_table_holds_only_names_naive_normalisation_misses_each_with_evidence():
    assert aliases.ALIASES, "the alias table is empty"
    for alias in aliases.ALIASES:
        assert alias.tracker in aliases.TRACKERS, alias
        assert alias.set_id in SET_NAMES, alias
        assert alias.set_id in PROBES, alias
        assert alias.evidence and all(aliases.EVIDENCE.fullmatch(key) for key in alias.evidence), alias
        # Naive normalisation doesn't already reach the set, or the row isn't needed.
        assert aliases.set_key(alias.set_name) != aliases.set_key(SET_NAMES[alias.set_id], tracker=False), alias
    for name in ("Miscellaneous Cards & Products", "League & Championship Cards", "Prize Pack Series Cards",
                 "Deck Exclusives", "Battle Academy"):
        assert all(aliases.set_key(alias.set_name) != aliases.set_key(name) for alias in aliases.ALIASES), name


@pytest.mark.parametrize("text", [
    "tcgplayer_app\tSV01: Scarlet & Violet Base Set\tsv01\n",  # three columns
    "loose\tBase Set (Unlimited)\tbase1\tR:collectr\n",  # not a tracker
    "collectr\tBase Set (Unlimited)\tbase1\tX9:4\n",  # no such evidence key
    "collectr\tBase Set (Unlimited)\tbase1\t\n",  # no evidence
    "collectr\tBase Set (Unlimited) \tbase1\tR:collectr\n",  # padded name
    "collectr\t!!\tbase1\tR:collectr\n",  # no name left
    "collectr\tBase Set (Unlimited)\tbase 1\tR:collectr\n",  # not a set ID
    "tcgplayer_app\tSV01: Scarlet & Violet Base Set\tsv01\tT1:16\n"
    "tcgplayer_app\tScarlet and Violet Base Set\tsv01\tT1:17\n",  # the same name twice
])
def test_a_malformed_alias_table_is_refused(text):
    with pytest.raises(ValueError):
        aliases._load(text)


def test_every_alias_row_matches_its_set_in_its_trackers_file():
    seed()
    for tracker in sorted({alias.tracker for alias in aliases.ALIASES}):
        entries = [alias for alias in aliases.ALIASES if alias.tracker == tracker]
        rows = [ROWS[tracker](PROBES[alias.set_id][1], alias.set_name, PROBES[alias.set_id][2]) for alias in entries]
        owner, _, summary = imported(HEADERS[tracker], *rows)
        assert [card for _, card in outcomes(owner, summary)] == [PROBES[alias.set_id][0] for alias in entries], \
            tracker
        assert all(status in READY for status, _ in outcomes(owner, summary)), tracker


def test_naive_set_names_cut_an_era_prefix_and_ignore_case_accents_and_punctuation():
    assert aliases.set_key("SV01: Scarlet & Violet Base Set") == "scarlet and violet base set"
    assert aliases.set_key("SWSH12: Silver Tempest Trainer Gallery") == "silver tempest trainer gallery"
    assert aliases.set_key("SM - Burning Shadows") == "burning shadows"
    assert aliases.set_key("Pokémon  Rumble") == "pokemon rumble"
    assert aliases.set_key("Champion's Path") == "champions path"
    # Not an era prefix: names with a colon or dash of their own stay whole.
    assert aliases.set_key("Hidden Fates: Shiny Vault") == "hidden fates shiny vault"
    assert aliases.set_key("Celebrations: Classic Collection") == "celebrations classic collection"
    assert aliases.set_key("Base Set - Shadowless") == "base set shadowless"
    assert aliases.set_key("XY") == "xy"
    # TCGdex's own names are never cut.
    assert aliases.set_key("SV: Scarlet", tracker=False) == "sv scarlet"
    seed()
    owner, _, summary = imported(TCGPLAYER, tcgplayer("Klara", "SWSH06: Chilling Reign", "145/198"),
                                 tcgplayer("Suicune", "neo revelation", "14/64", "Holofoil"),
                                 tcgplayer("Venusaur EX", "XY", "1/146", "Holofoil"),
                                 tcgplayer("Ho-Oh", "CELEBRATIONS", "001/025", "Holofoil"))
    assert outcomes(owner, summary) == [("matched", "swsh6-145"), ("matched", "neo3-14"), ("matched", "xy1-1"),
                                        ("matched", "cel25-1")]


@pytest.mark.parametrize("number, readings, promo", [
    ("042/102", ["042"], None),
    ("TG01/TG30", ["TG01"], None),
    ("SV032/SV122", ["SV032"], None),
    ("040 / 096", ["040"], None),
    ("037/DP-P", ["DP037"], "dpp"),
    ("012VL", ["012VL", "012"], None),
    ("#SWSH138", ["SWSH138"], "swshp"),
    ("SM190", ["SM190"], "smp"),
    ("52a", ["52a"], None),
    ("", [], None),
    ("/102", [], None),
])
def test_each_number_rule_reads_the_collector_number(number, readings, promo):
    assert aliases.number_readings(number) == readings
    assert (aliases.promo_set(readings[0]) if readings else None) == promo


def test_each_number_rule_matches_its_fixture_row():
    seed()
    cases = [
        ("n/m", TCGPLAYER, tcgplayer("Starmie", "Base Set", "064/102"), "base1-64"),
        ("TG01/TG30 under an era prefix", TCGPLAYER,
         tcgplayer("Braixen", "SWSH12: Silver Tempest Trainer Gallery", "TG01/TG30", "Holofoil"), "swsh12tg-TG01"),
        ("SV032/SV122", COLLECTR, collectr("Barraskewda ", "Shining Fates: Shiny Vault", "SV032/SV122", "Holofoil"),
         "swsh4.5sv-SV032"),
        ("040 / 096", DRAGON_SHIELD, dragon_shield("Sandshrew", "MEW", "Pokémon 151", "027 / 165"), "sv03.5-027"),
        ("037/DP-P", COLLECTR, collectr("Dialga ", "DP-P Promos", "037/DP-P", "Holofoil"), "dpp-DP37"),
        ("012VL", DRAGON_SHIELD, dragon_shield("Armarouge", "PBL", "Pitch Black", "012VL"), "me05-012"),
        ("#SWSH138 under the set it came with", PRICECHARTING,
         pricecharting("Hydreigon C #SWSH138", "Celebrations"), "swshp-SWSH138"),
    ]
    for rule, header, row, expected in cases:
        owner, _, summary = imported(header, row)
        [(status, card)] = outcomes(owner, summary)
        assert status in READY and card == expected, rule


def test_dragon_shield_and_sorted_codes_go_first_and_other_trackers_codes_are_never_read():
    seed()
    owner, _, summary = imported(DRAGON_SHIELD, dragon_shield("Ditto", "MEW", "Pokémon 151", "132 / 165"),
                                 dragon_shield("Sprigatito", "SVI", "Base Set", "013"))
    assert outcomes(owner, summary) == [("matched", "sv03.5-132"), ("matched", "sv01-013")]
    owner, _, summary = imported(SORTED, sorted_row("Sprigatito", "SVI", "Scarlet and Violet Base", "013"))
    assert outcomes(owner, summary) == [("matched", "sv01-013")]
    # The TCGplayer app's codes are its own: BS with a set name nothing knows is not Base Set, so the row is Pick one
    # by its name (#229), never matched.
    owner, _, summary = imported(TCGPLAYER, tcgplayer("Starmie", "Base Set Mystery Edition", "064/102", code="BS"))
    assert outcomes(owner, summary) == [("ambiguous", None)] and candidates(summary) == [["base1-64"]]


def test_two_sets_of_one_name_ask_the_collector_with_both_cards_as_candidates():
    seed()
    owner, _, summary = imported(TCGPLAYER, tcgplayer("Pikachu", "Fixture Promos", "1"))
    assert outcomes(owner, summary) == [("ambiguous", None)]
    assert candidates(summary) == [["fixtureimporta-1", "fixtureimportb-1"]]


def test_a_basic_energy_row_matches_by_type_and_never_takes_another_card_at_its_number():
    seed()
    owner, _, summary = imported(
        TCGPLAYER,
        # SV01 008 is Scatterbug: the TCGplayer app files Scarlet & Violet Basic Energy there.
        tcgplayer("Basic Metal Energy", "SV01: Scarlet & Violet Base Set", "008"),
        tcgplayer("Scatterbug", "SV01: Scarlet & Violet Base Set", "008"),
        tcgplayer("Water Energy", "Base Set", "102/102"),  # its own Printing at its number
        tcgplayer("Psychic Energy", "Base Set 2", ""),  # the row's own set has one
        tcgplayer("Psychic Energy", "SWSH01: Sword & Shield Base Set", ""),  # it hasn't: the newest
        tcgplayer("Lightning Energy", "Battle Academy 2022", ""),  # no own set: the newest of two
        tcgplayer("Basic {D} Energy", "Brilliant Stars", ""))
    assert outcomes(owner, summary) == [("matched", "sve-008"), ("matched", "sv01-008"), ("matched", "base1-102"),
                                        ("matched", "base4-129"), ("matched", "base1-101"), ("matched", "sve-004"),
                                        ("matched", "sve-007")]
    found = candidates(summary)
    assert found[0] == ["sve-008"] and found[1] == [] and found[2] == []
    assert found[3] == ["base4-129", "base1-101"] and found[4] == ["base1-101", "base4-129"]
    assert found[5] == ["sve-004", "sve-012"]


def test_a_product_id_wins_over_set_and_number_a_verified_mapping_first():
    seed()
    row = tcgplayer("Koraidon ex", "Base Set", "064/102", "Holofoil", product=str(KORAIDON_PRODUCT))
    unknown = tcgplayer("Starmie", "Base Set", "064/102", product="999999")
    owner, _, summary = imported(TCGPLAYER, row, unknown)
    # TCGdex lists the product for Koraidon ex; the row's set and number (Starmie) don't count. An unknown product
    # goes on to the set and number.
    assert outcomes(owner, summary) == [("matched", "sv01-254"), ("matched", "base1-64")]
    verify(edition("base1-64", "normal"), KORAIDON_PRODUCT)
    owner, _, summary = imported(TCGPLAYER, row)
    assert outcomes(owner, summary) == [("matched", "base1-64")]


def test_the_legacy_export_matches_by_verified_product_ids():
    seed()
    legacy = (FIXTURES / "tcgplayer-legacy.csv").read_bytes()
    owner, unsorted = collector()
    # Its rows hold only a product ID: with no mapping and no TCGdex lookup ID naming one, nothing reads them.
    assert [status for status, _ in outcomes(owner, started(owner, unsorted, legacy))] == ["unreadable"] * 3
    verify(edition("base1-42", "normal"), 900002)
    verify(edition("base1-64", "normal"), 900003)
    verify(edition("base2-48", "normal"), 900005)
    summary = started(owner, unsorted, legacy)
    assert outcomes(owner, summary) == [("matched", "base1-42"), ("finish_unknown", "base2-48"),
                                        ("matched", "base1-64")]


def test_rows_naming_the_same_card_edition_are_summed_at_save():
    seed()
    owner, unsorted, summary = imported(
        PRICECHARTING, pricecharting("Starmie #64", "Base Set"), pricecharting("Starmie #64", "Base Set", "2"))
    assert save(owner, summary["id"]).status_code == 200
    assert held(owner, unsorted) == {edition("base1-64", "normal"): "3"}
    owner, unsorted, summary = imported(
        TCG_COLLECTOR, tcg_collector("Petilil", "Journey Together", "006/159", quantity="2"),
        tcg_collector("Petilil", "Journey Together", "006/159", quantity="1"),
        tcg_collector("Basic Grass Energy", "Scarlet & Violet Energies", "1", quantity="4"),
        tcg_collector("Basic Grass Energy", "Scarlet & Violet Energies", "1", "Cosmos Holo"))
    assert save(owner, summary["id"]).status_code == 200
    assert held(owner, unsorted) == {edition("sv09-006", "normal"): "3", edition("sve-001", "normal"): "5"}


def test_a_blank_quantity_is_one_copy_and_a_zero_or_fractional_one_is_unreadable():
    seed()
    owner, _, summary = imported(TCGPLAYER, *(tcgplayer("Starmie", "Base Set", "064/102", quantity=quantity)
                                              for quantity in ("", "0", "1.5", "-1", "2")))
    found = all_rows(owner, summary["id"])
    assert [(row["status"], row["quantity"]) for row in found] == [
        ("matched", "1"), ("unreadable", None), ("unreadable", None), ("unreadable", None), ("matched", "2")]
    assert summary["counts"]["needs_you"] == 3 and summary["cards_to_add"] == "3"


TCGPLAYER_RATE = [
    ("matched", "base1-102"), ("matched", "base1-42"), ("matched", "base1-64"), ("matched", "base1-64"),
    ("matched", "base1-101"), ("matched", "base4-129"), ("matched", "base2-32"), ("finish_unknown", "base2-48"),
    ("matched", "neo3-14"), ("not_found", None), ("matched", "np-37"), ("not_found", None), ("matched", "pl2-113"),
    ("matched", "ex7-35"), ("matched", "sv01-013"), ("matched", "sv01-254"), ("matched", "sv01-039"),
    ("matched", "sve-008"), ("matched", "base1-101"), ("matched", "swsh6-194"), ("matched", "swsh6-145"),
    ("not_found", None), ("matched", "swsh12tg-TG01"), ("matched", "base1-101"), ("matched", "sve-002"),
]
COLLECTR_RATE = [
    ("matched", "swsh10-135"), ("matched", "swsh10tg-TG05"), ("not_found", None), ("matched", "sve-007"),
    ("not_found", None), ("finish_unknown", "gym2-98"), ("matched", "gym1-8"), ("matched", "sma-SV38"),
    ("not_found", None), ("matched", "swsh4.5sv-SV032"), ("matched", "swsh12-157"), ("matched", "me02.5-284"),
    ("matched", "sv10.5b-059"), ("not_found", None), ("not_found", None), ("not_found", None), ("matched", "mep-024"),
    ("not_found", None), ("matched", "svp-062"), ("matched", "swshp-SWSH138"), ("matched", "base1-64"),
]
TCG_COLLECTOR_RATE = [
    ("matched", "sv09-001"), ("matched", "sv09-002"), ("matched", "sv09-003"), ("matched", "sv09-006"),
    ("matched", "sv09-006"), ("matched", "sv03.5-132"), ("matched", "sve-001"), ("matched", "sve-001"),
    ("matched", "sve-004"), ("matched", "sve-004"), ("matched", "sve-012"), ("matched", "svp-062"),
    ("matched", "svp-129"), ("matched", "svp-160"),
]


@pytest.mark.parametrize("fixture, hard_rows, floor", [
    ("match-rate-tcgplayer.csv", TCGPLAYER_RATE, 0.94),
    ("match-rate-collectr.csv", COLLECTR_RATE, 0.80),
    ("match-rate-tcg-collector.csv", TCG_COLLECTOR_RATE, 0.89),
])
def test_each_trackers_reconstruction_matches_at_least_the_tickets_share_of_card_rows(fixture, hard_rows, floor):
    seed()
    owner, unsorted = collector()
    summary = started(owner, unsorted, (FIXTURES / fixture).read_bytes())
    found = outcomes(owner, summary)
    # The research slice's rows first, each with its expected outcome; then the plain padding rows, all ready.
    assert found[:len(hard_rows)] == hard_rows
    assert all(status in READY for status, _ in found[len(hard_rows):])
    ready = sum(status in READY for status, _ in found)
    assert ready / len(found) >= floor, (ready, len(found))
    # The padding is the fewest rows that reach the floor: one hard row fewer and the fixture falls below it.
    hard_ready = sum(status in READY for status, _ in hard_rows)
    if hard_ready < len(hard_rows) or len(found) > len(hard_rows):
        assert (ready - 1) / len(found) < floor, (ready, len(found))
