"""Decklist import matching (ticket #213): the import alias table and its rules, Basic Energy by type, names, and the
Missing cards prefill, all through POST /api/decks/import/review with signed HTTP against PostgreSQL.

The catalog is seeded through the real catalog import. Reprint Groups come from the records' rules text: Trainers with
equal effect text share a group, and Pokémon with different attacks don't. A record with no rules text is in no group.
Records carry no release dates, so "newest" uses the format rules files' dates, as Catalog does: sv02 2023-06-09,
sve 2023-03-31, me01 2025-09-26, mee 2025-09-25, sm1 2017-02-03.
"""
import time
from uuid import uuid4

import pytest

from app.main import app  # noqa: F401  (main first: it includes every router while loading)
from app import price_launcher
from app.public_records import public_record_store
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_targets import isolated_rules  # noqa: F401  (autouse)
from test_deck_lists import code
from test_holdings import call
from deck_import_fixtures import FIXTURES, LIST_CARDS, LIST_EXPECTED, basic_energy, pokemon, printed, trainer

REVIEW = "/api/decks/import/review"
BOSS = "You may switch in 1 of your opponent's Benched Pokémon to the Active Spot."
RESEARCH = "Discard your hand and draw 7 cards."


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "filesystem")
    public_record_store().initialize(deadline=time.monotonic() + 5)
    return public_record_store()


@pytest.fixture(autouse=True)
def launches(monkeypatch):
    """Records any runner launch; reviewing a list must never cause one."""
    calls = []
    monkeypatch.setattr(price_launcher, "spawn", lambda slot, owner: calls.append((slot, owner)) or True)
    return calls


# One Printing for each alias row and rule, plus the cards the Basic Energy and name tests need.
MATCHING_CARDS = (
    # The printed code table (set_codes.tsv).
    trainer("sv02", "Paldea Evolved", "172", "Boss's Orders", BOSS),
    printed("swsh11", "Lost Origin", "131", "Giratina VSTAR", "Pokemon"),
    printed("swsh11", "Lost Origin", "130", "Giratina V", "Pokemon"),
    printed("cel25", "Celebrations", "24", "Birthday Pikachu", "Pokemon"),
    # The alias table's rows.
    printed("svp", "SVP Black Star Promos", "075", "Mimikyu", "Pokemon"),
    printed("svp", "SVP Black Star Promos", "001", "Sprigatito", "Pokemon"),
    printed("swshp", "SWSH Black Star Promos", "SWSH281", "Regidrago V", "Pokemon"),
    printed("swshp", "SWSH Black Star Promos", "SWSH167", "Professor Burnet", "Trainer", trainerType="Supporter"),
    printed("smp", "SM Black Star Promos", "SM30", "Tapu Koko", "Pokemon"),
    printed("smp", "SM Black Star Promos", "SM62", "Golisopod-GX", "Pokemon"),
    printed("xyp", "XY Black Star Promos", "XY01", "Pikachu", "Pokemon"),
    printed("bwp", "BW Black Star Promos", "BW100", "N", "Trainer", trainerType="Supporter"),
    printed("bwp", "BW Black Star Promos", "BW01", "Snivy", "Pokemon"),
    printed("hgssp", "HGSS Black Star Promos", "HGSS01", "Ho-Oh", "Pokemon"),
    printed("dpp", "DP Black Star Promos", "DP01", "Turtwig", "Pokemon"),
    basic_energy("sve", "Scarlet & Violet Energies", "005", "Basic Psychic Energy"),
    basic_energy("sve", "Scarlet & Violet Energies", "013", "Basic Psychic Energy"),
    basic_energy("sve", "Scarlet & Violet Energies", "007", "Basic Darkness Energy"),
    basic_energy("sve", "Scarlet & Violet Energies", "015", "Basic Darkness Energy"),
    basic_energy("mee", "Mega Evolution Energy", "005", "Basic Psychic Energy"),
    printed("cel25cc", "Celebrations Classic Collection", "CC001", "Charizard", "Pokemon"),
    # The rules.
    printed("swsh9tg", "Brilliant Stars Trainer Gallery", "TG05", "Pikachu", "Pokemon"),
    printed("swsh12.5gg", "Crown Zenith Galarian Gallery", "GG25", "Bibarel", "Pokemon"),
    printed("g1", "Generations", "RC5", "Snivy", "Pokemon"),
    printed("swsh4.5sv", "Shining Fates Shiny Vault", "SV001", "Rowlet", "Pokemon"),
    printed("sma", "Hidden Fates Shiny Vault", "SV1", "Charmander", "Pokemon"),
    # Basic Energy by type: Fire only in sm1, Water only in sm1.
    basic_energy("sm1", "Sun & Moon", "165", "Fire Energy"),
    basic_energy("sm1", "Sun & Moon", "166", "Water Energy"),
    printed("swsh9", "Brilliant Stars", "151", "Double Turbo Energy", "Energy", energyType="Special",
            effect="This card provides 2 Energy."),
    # Names: Boss's Orders is one Reprint Group in two sets (equal text); Meowth ex is two groups, one of them in two
    # sets; Professor's Research (Professor Juniper) has a subtitle; the two Pikachu promos have no rules text.
    trainer("me01", "Mega Evolution", "114", "Boss's Orders", BOSS),
    pokemon("me01", "Mega Evolution", "150", "Meowth ex", "Tuck Tail"),
    pokemon("sv04.5", "Paldean Fates", "078", "Meowth ex", "Tuck Tail"),
    pokemon("sv02", "Paldea Evolved", "120", "Meowth ex", "Scratch"),
    trainer("swsh1", "Sword & Shield", "178", "Professor's Research (Professor Juniper)", RESEARCH),
    printed("svp", "SVP Black Star Promos", "027", "Pikachu", "Pokemon"),
    printed("swsh1", "Sword & Shield", "065", "Giratina", "Pokemon"),
)


def seed():
    reset_catalog()
    run(Records(*MATCHING_CARDS))


def review(owner, text, fixes=(), expect=200):
    response = call("POST", REVIEW, owner, {"source": {"text": text}, "fixes": list(fixes)})
    assert response.status_code == expect, response.text
    return response.json()


def lines(owner, text, fixes=()):
    return review(owner, text, fixes)["lines"]


def found(line):
    """(status, set code, collector number) of the card a line resolved to."""
    printing = line["printing"]
    return line["status"], printing and printing["set_code"], printing and printing["collector_number"]


# ------------------------------------------------------------------ step 1: the alias table and its rules


def test_each_alias_row_finds_its_printing():
    seed()
    owner = str(uuid4())
    pasted = {
        "1 Mimikyu PR-SV 75": ("SVP", "075"),
        "1 Sprigatito SVP 1": ("SVP", "001"),
        "1 Regidrago V PR-SW 281": ("swshp", "SWSH281"),
        "1 Professor Burnet SP 167": ("swshp", "SWSH167"),
        "1 Tapu Koko SMP 30": ("smp", "SM30"),
        "2 Golisopod-GX PR-SM SM62": ("smp", "SM62"),
        "1 Tapu Koko PR-SM 30": ("smp", "SM30"),
        "1 Pikachu XYP 1": ("xyp", "XY01"),
        "1 Snivy BWP 1": ("bwp", "BW01"),
        "4 N PR-BLW BW100": ("bwp", "BW100"),
        "1 Ho-Oh HSP 1": ("hgssp", "HGSS01"),
        "1 Turtwig DPP 1": ("dpp", "DP01"),
        "6 Basic {P} Energy SVE 13": ("sve", "013"),
        "3 Psychic Energy MEE 5": ("mee", "005"),
        "1 Charizard CEL CC1": ("cel25cc", "CC001"),
        "1 Birthday Pikachu CEL 24": ("CEL", "24"),
    }
    body = review(owner, "\n".join(pasted))
    assert [found(line) for line in body["lines"]] == [("matched", *where) for where in pasted.values()]
    assert body["totals"]["to_resolve"] == 0


def test_the_subset_split_and_the_shining_vault_numbers_find_their_printings():
    seed()
    got = lines(str(uuid4()), "1 Pikachu BRS-TG 5\n2 Bibarel CRZ-GG 25\n1 Snivy GEN-RC 5\n1 Rowlet SHF 74\n"
                              "1 Charmander HIF 70\n1 Pikachu BRS-TG TG05\n")
    assert [found(line) for line in got] == [("matched", "BRS", "TG05"), ("matched", "CRZ", "GG25"),
                                             ("matched", "GEN", "RC5"), ("matched", "SHF", "SV001"),
                                             ("matched", "HIF", "SV1"), ("matched", "BRS", "TG05")]


def test_no_name_cross_check_after_a_code_match():
    seed()
    got = lines(str(uuid4()), "2 Pikachu PR-SV 75\n1 Meowth ex PAL 172\n1 Boss's Orders PAL 172\n")
    assert [found(line) for line in got] == [("matched", "SVP", "075"), ("matched", "PAL", "172"),
                                             ("matched", "PAL", "172")]
    assert [line["printing"]["name"] for line in got] == ["Mimikyu", "Boss's Orders", "Boss's Orders"]


# ------------------------------------------------------------------ step 2: Basic Energy by type


def test_basic_energy_whose_code_fails_matches_its_type_in_the_newest_set_in_any_spelling():
    seed()
    got = lines(str(uuid4()), "1 Basic {P} Energy SVALT 135\n7 Psychic Energy Energy 31\n3 Basic Psychic Energy MEE 13\n"
                              "1 Basic {D} Energy SVALT 137\n3 Fire Energy MEE 10\n* 20 Water Energy  12\n")
    assert [found(line) for line in got] == [
        ("energy", "mee", "005"), ("energy", "mee", "005"), ("energy", "mee", "005"),
        # sve holds two Darkness Energy: the lowest number is the default.
        ("energy", "sve", "007"),
        # mee holds no Fire or Water Energy here, so the newest set with one is sm1.
        ("energy", "SUM", "165"), ("energy", "SUM", "166")]
    assert [[c["set_code"], c["collector_number"]] for c in got[0]["candidates"]] == [
        ["mee", "005"], ["sve", "005"], ["sve", "013"]]
    assert all(line["parts"] and line["parts"][0]["chosen_by"] == "catalog_order" for line in got)


def test_basic_energy_of_a_type_the_catalog_lacks_and_special_energy_are_not_matched_by_type():
    seed()
    got = lines(str(uuid4()), "1 Basic {Y} Energy SVALT 1\n3 Double Turbo Energy SVALT 9\n")
    assert [found(line) for line in got] == [("not_found", None, None), ("by_name", "BRS", "151")]


def test_change_picks_another_basic_energy_of_the_type_and_its_edition():
    seed()
    owner = str(uuid4())
    text = "6 Basic {P} Energy SVALT 135\n1 Boss's Orders PAL 172\n"
    first, boss = lines(owner, text)
    sve13 = first["candidates"][2]["printing_id"]
    changed = lines(owner, text, [{"line": 1, "printing_id": sve13}])[0]
    assert found(changed) == ("energy", "sve", "013")
    assert len(changed["candidates"]) == 3
    edition = changed["editions"][0]["edition_id"]
    chosen = lines(owner, text, [{"line": 1, "edition_id": edition}])[0]
    assert found(chosen) == ("energy", "sve", "013")
    assert chosen["parts"] == [{"edition_id": edition, "quantity": "6", "source": "new", "chosen_by": "collector"}]
    refused = call("POST", REVIEW, owner, {"source": {"text": text}, "fixes": [
        {"line": 1, "edition_id": boss["parts"][0]["edition_id"]}]})
    assert refused.status_code == 422 and code(refused) == "INVALID_FIX"
    picked = lines(owner, text, [{"line": 1, "printing_id": boss["printing"]["printing_id"]}])[0]
    assert picked["status"] == "picked" and picked["candidates"] == []


# ------------------------------------------------------------------ step 3: the name


def test_a_failed_code_whose_name_names_one_reprint_group_is_matched_by_name_on_its_newest_printing():
    seed()
    got = lines(str(uuid4()), "1 Boss's Orders SWSHALT 127\n1 Professor's Research SWSHALT 60\n1 Iono PAL 999\n"
                              "1 Bosss Orders PAL 999\n")
    assert [found(line) for line in got[:2]] == [("by_name", "MEG", "114"), ("by_name", "SSH", "178")]
    assert got[2]["status"] == "not_found"
    # Letters and digits only: "Bosss Orders" is "Boss's Orders".
    assert found(got[3]) == ("by_name", "MEG", "114")
    assert all(line["candidates"] == [] for line in got)


def test_a_failed_code_whose_name_names_several_reprint_groups_asks_to_pick_one_per_group():
    seed()
    owner = str(uuid4())
    meowth, pikachu = lines(owner, "1 Meowth ex SVALT 62\n1 Pikachu SVALT 9\n")
    assert meowth["status"] == "ambiguous" and meowth["printing"] is None and meowth["parts"] == []
    # One candidate per group, each its newest Printing, newest first: the Tuck Tail group's me01 150, then sv02 120.
    assert [(c["set_code"], c["collector_number"]) for c in meowth["candidates"]] == [("MEG", "150"), ("PAL", "120")]
    # Printings in no Reprint Group are cards of their own.
    assert pikachu["status"] == "ambiguous"
    assert sorted((c["set_code"], c["collector_number"]) for c in pikachu["candidates"]) == [
        ("BRS", "TG05"), ("SVP", "027"), ("xyp", "XY01")]
    picked = lines(owner, "1 Meowth ex SVALT 62\n", [{"line": 1, "printing_id": meowth["candidates"][1]["printing_id"]}])
    assert found(picked[0]) == ("picked", "PAL", "120")


def test_a_line_with_no_code_is_never_matched_by_name():
    seed()
    got = lines(str(uuid4()), "4 Boss's Orders\n* 3 Double Turbo Energy  12\n1 Giratina VSTAR 131\n"
                              "2 Charizard EX 12\n1 Giratina ex 131\n")
    assert [line["status"] for line in got] == ["unreadable", "not_found", "unreadable", "unreadable", "unreadable"]
    assert all(line["printing"] is None and line["candidates"] == [] for line in got)


# ------------------------------------------------------------------ the Missing cards prefill


def test_not_found_lines_prefill_the_missing_cards_report_with_a_mapped_code_as_the_set_id():
    seed()
    owner = str(uuid4())
    got = lines(owner, "1 Regidrago VSTAR PR-SW 999\n1 Cresselia LOR 74\n1 Lillie BRS-TG 99\n1 Snorlax SHF 99\n"
                       "1 Boss's Orders PAL 172\n")
    assert [line["report"] for line in got[:4]] == [
        {"kind": "printing", "english_name": "Regidrago VSTAR", "collector_number": "SWSH999", "set_id": "swshp",
         "set_name": None, "note": 'Pasted decklist line: "1 Regidrago VSTAR PR-SW 999".'},
        {"kind": "printing", "english_name": "Cresselia", "collector_number": "74", "set_id": "swsh11",
         "set_name": None, "note": 'Pasted decklist line: "1 Cresselia LOR 74".'},
        {"kind": "printing", "english_name": "Lillie", "collector_number": "TG99", "set_id": "swsh9tg",
         "set_name": None, "note": 'Pasted decklist line: "1 Lillie BRS-TG 99".'},
        {"kind": "printing", "english_name": "Snorlax", "collector_number": "SV26", "set_id": "swsh4.5sv",
         "set_name": None, "note": 'Pasted decklist line: "1 Snorlax SHF 99".'},
    ]
    assert got[4]["report"] is None


def test_an_unmapped_code_goes_into_the_set_name_and_note_never_the_set_id():
    seed()
    owner = str(uuid4())
    got = lines(owner, "1 Professor Oak's Setup SWSHALT 9\n1 Iono SV02 999\n" + "1 " + "Long" * 50 + " ZZZ 1\n")
    assert got[0]["report"] == {
        "kind": "printing", "english_name": "Professor Oak's Setup", "collector_number": "9", "set_id": None,
        "set_name": "SWSHALT",
        "note": 'Pasted decklist line: "1 Professor Oak\'s Setup SWSHALT 9". '
                "PrizeCheck's code tables don't map the set code SWSHALT."}
    # A TCGdex set ID is not a code.
    assert got[1]["report"]["set_id"] is None and got[1]["report"]["set_name"] == "SV02"
    assert len(got[2]["report"]["english_name"]) == 160
    # Dropped and resolved lines carry no prefill.
    dropped = lines(owner, "1 Professor Oak's Setup SWSHALT 9\n", [{"line": 1, "drop": True}])
    assert dropped[0]["report"] is None


def test_the_prefill_is_a_report_the_missing_cards_queue_accepts():
    seed()
    owner = str(uuid4())
    reports = [line["report"] for line in lines(owner, "1 Cresselia LOR 74\n1 Professor Oak's Setup SWSHALT 9\n"
                                                       "1 " + "Long" * 50 + " ZZZ 1\n")]
    for report in reports:
        response = call("POST", "/api/missing-card-reports", owner, report)
        assert response.status_code == 201, response.text
    mine = call("GET", "/api/missing-card-reports", owner).json()
    assert {(r["kind"], r["english_name"], r["set_id"], r["set_name"], r["collector_number"]) for r in mine} == {
        ("printing", "Cresselia", "swsh11", None, "74"),
        ("printing", "Professor Oak's Setup", None, "SWSHALT", "9"),
        ("printing", ("Long" * 50)[:160], None, "ZZZ", "1")}


# ------------------------------------------------------------------ whole lists


def test_the_tcg_live_and_limitless_lists_resolve_with_only_the_expected_lines_changed(launches):
    reset_catalog()
    run(Records(*LIST_CARDS))
    owner = str(uuid4())
    for key in ("F1", "F3"):
        body = review(owner, FIXTURES[key])
        assert [(line["line"], line["status"]) for line in body["lines"]] == LIST_EXPECTED[key], key
        assert body["totals"]["to_resolve"] == 0, key
        assert sum(int(entry["quantity"]) for entry in body["deck_list"]) == 60, key
    assert launches == []
