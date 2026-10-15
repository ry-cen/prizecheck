"""The printed set code table (app redesign #173, api/app/set_codes.tsv): every row follows the table's own evidence
rule, no code conflicts with another set's code or with a different set's TCGdex set ID, and the table stays apart from
the Live export table. No database is needed."""
import re
from pathlib import Path

from app import set_codes
from app.catalog_targets import LiveRulesV1

APP = Path(set_codes.__file__).parent
# A printed code that reads the same as a different set's TCGdex set ID. The code wins in search; the other set shows
# its own code (Generations is GEN).
SAME_AS_ANOTHER_SETS_ID = {"G1": ("gym1", "g1")}


def imported_sets():
    rows = (line.split("\t") for line in (APP / "format_rules/imported_sets.txt").read_text().splitlines()
            if line and not line.startswith("#"))
    return {row[0]: row[2] for row in rows}


def test_every_row_names_an_imported_set_with_its_name_and_a_well_formed_code():
    imported = imported_sets()
    rows = [line.split("\t") for line in set_codes.PATH.read_text().splitlines() if line and not line.startswith("#")]
    assert len(rows) == len(set_codes.CODES) == 136
    for set_id, code, name, _ in rows:
        assert set_id in imported, set_id
        assert name == imported[set_id], set_id
        assert re.fullmatch(r"[A-Z0-9]{2,4}", code), set_id


def test_every_row_has_two_sources_a_card_scan_and_a_source_or_inherits_its_main_sets_code():
    for set_id, sources in set_codes.SOURCES.items():
        keys = sources.split(",")
        inherited = [key[2:] for key in keys if key.startswith("I:")]
        if inherited:
            main = inherited[0]
            assert keys == [f"I:{main}"], set_id
            assert set_codes.CODES[main] == set_codes.CODES[set_id], set_id
            assert not set_codes.SOURCES[main].startswith("I:"), set_id
            continue
        scans = [key for key in keys if key.startswith("S:")]
        assert all(re.fullmatch(rf"S:{re.escape(set_id)}-\w+", key) for key in scans), set_id
        independent = {"L", "J"} & set(keys)
        assert len(independent) + min(len(scans), 1) >= 2, set_id
        assert set(keys) <= {"L", "J", *scans}, set_id


def test_no_code_conflicts_with_another_set():
    by_code = {}
    for set_id, code in set_codes.CODES.items():
        by_code.setdefault(code.casefold(), []).append(set_id)
    for code, sets in by_code.items():
        # One main set per code; any other set with it is a subset that inherits it.
        mains = [set_id for set_id in sets if not set_codes.SOURCES[set_id].startswith("I:")]
        assert len(mains) == 1, (code, sets)
        assert set_codes.sets_for_code(code.upper())[0] == mains[0]
    ids = {set_id.casefold(): set_id for set_id in imported_sets()}
    for set_id, code in set_codes.CODES.items():
        other = ids.get(code.casefold())
        if other and other != set_id:
            assert SAME_AS_ANOTHER_SETS_ID.get(code) == (set_id, other), (code, set_id, other)
    assert set_codes.code_for("fixture") == "fixture"  # a set without a code shows its TCGdex set ID


def test_the_display_table_is_not_the_live_export_table():
    assert LiveRulesV1.SET_CODES == {}
    importers = sorted(path.name for path in APP.glob("*.py")
                       if re.search(r"^from \. import .*\bset_codes\b|^from \.set_codes import", path.read_text(), re.M))
    # The decklist import (#212, #213) reads the printed code table too, to match and show a pasted line and to read
    # its alias rules (import_aliases); display and matching, not export. The Want List's Swap hint (#211) shows
    # the owned Edition's code ("PAL 254").
    assert importers == ["catalog_browse.py", "deck_import.py", "import_aliases.py", "import_matching.py",
                         "swap_hints.py"]
