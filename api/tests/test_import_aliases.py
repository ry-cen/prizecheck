"""The decklist import alias table (ticket #213, api/app/import_aliases.tsv). Each row names an imported set and cites
its evidence. No row contradicts the printed set code table, and no name suffix is a code. The table stays apart from
exports, Format Standing and public records. No database is needed."""
import re
from pathlib import Path

from app import import_aliases, set_codes
from app.catalog_targets import LiveRulesV1
from app.import_name_matching import NAME_SUFFIXES
from test_set_codes import imported_sets

APP = Path(import_aliases.__file__).parent
ROOT = APP.parent.parent


def test_the_table_holds_the_specs_rows_each_naming_an_imported_set_with_its_evidence():
    assert [(a.code, a.set_id, a.prefix, a.rule) for a in import_aliases.ALIASES] == [
        ("PR-SV", "svp", "", "-"), ("SVP", "svp", "", "-"),
        ("PR-SW", "swshp", "SWSH", "add"), ("SP", "swshp", "SWSH", "add"),
        ("SMP", "smp", "SM", "add"), ("PR-SM", "smp", "SM", "add"),
        ("XYP", "xyp", "XY", "add"),
        ("BWP", "bwp", "BW", "add"), ("PR-BLW", "bwp", "BW", "add"),
        ("HSP", "hgssp", "HGSS", "add"),
        ("DPP", "dpp", "DP", "add"),
        ("SVE", "sve", "", "-"), ("MEE", "mee", "", "-"),
        ("CEL", "cel25cc", "CC", "only"),
    ]
    imported = imported_sets()
    for alias in import_aliases.ALIASES:
        assert alias.set_id in imported, alias
        assert set(alias.sources) & import_aliases.PASTED_SOURCES, alias
        assert not alias.prefix or "X" in alias.sources, alias


def test_a_malformed_row_is_refused():
    good = "PR-SV\tsvp\t-\t-\tF,V\n"
    assert import_aliases._load(good)[0].code == "PR-SV"
    for bad in ("PR-SV\tsvp\t-\t-\n", "pr-sv\tsvp\t-\t-\tF\n", "PR-SW\tswshp\tSWSH\tadd\tF\n",
                "PR-SW\tswshp\t-\tadd\tF,X\n", "SVE\tsve\t-\t-\tX\n", "SVE\tsve\t-\t-\tQ\n", good + good):
        try:
            import_aliases._load(bad)
        except ValueError:
            continue
        raise AssertionError(bad)


def test_no_alias_contradicts_the_printed_code_table():
    for alias in import_aliases.ALIASES:
        printed = set_codes.sets_for_code(alias.code)
        # A code both tables hold names the same set, unless the row is for prefixed numbers only (CEL CC1).
        assert not printed or alias.rule == "only" or printed[0] == alias.set_id, alias
    for code in import_aliases.FLAT_NUMBERS:
        assert len(set_codes.sets_for_code(code)) == 2, code   # the main set and its Shiny Vault


def test_no_name_suffix_is_a_set_code():
    codes = {code.casefold() for code in set_codes.CODES.values()}
    codes |= {alias.code.casefold() for alias in import_aliases.ALIASES}
    assert not {suffix.casefold() for suffix in NAME_SUFFIXES} & codes
    assert all(re.fullmatch(r"[A-Z0-9]{2,8}", suffix) for suffix in NAME_SUFFIXES)


def test_the_alias_table_feeds_no_export_format_standing_or_public_record():
    assert LiveRulesV1.SET_CODES == {}
