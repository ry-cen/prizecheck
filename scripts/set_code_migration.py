"""Write the migration that replaces the rows of ``catalog_set_code`` with ``api/app/set_codes.tsv`` (WP-C1).

``python scripts/set_code_migration.py <NNN>`` writes ``migrations/<NNN>_set_codes.sql`` and refuses when it exists. The
first line carries the TSV's digest (the same computation as ``set_codes.DIGEST``); ``npm run guardrails`` fails when the
newest such line differs from the TSV, so a TSV edit cannot merge without its migration. The parser copies
``set_codes._load`` so the script needs no PYTHONPATH.
"""
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TSV = ROOT / "api/app/games/pokemon/catalog/set_codes.tsv"
CODE = re.compile(r"^[A-Z0-9]{2,4}$")
DIGEST_LINE = re.compile(r"^-- set_codes\.tsv digest: ([0-9a-f]{16})$")


def parse(text):
    """(code by TCGdex set ID) in file order. Raises ValueError on a malformed row."""
    codes = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 4 or not CODE.fullmatch(parts[1]) or parts[0] in codes:
            raise ValueError(f"set_codes.tsv line {number}: malformed or repeated row")
        codes[parts[0]] = parts[1]
    return codes


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def quote(value):
    return "'" + value.replace("'", "''") + "'"


def render(tsv_text):
    rows = ",\n".join(f"({quote(set_id)}, {quote(code)})" for set_id, code in parse(tsv_text).items())
    return (f"-- set_codes.tsv digest: {digest(tsv_text)}\n"
            f"DELETE FROM catalog_set_code;\n"
            f"INSERT INTO catalog_set_code(set_id, code) VALUES\n{rows};\n")


def main(argv):
    if len(argv) != 2 or not re.fullmatch(r"[0-9]{3}", argv[1]):
        print("usage: python scripts/set_code_migration.py <NNN>")
        return 2
    target = ROOT / "migrations" / f"{argv[1]}_set_codes.sql"
    if target.exists():
        print(f"{target.relative_to(ROOT)} already exists")
        return 1
    target.write_text(render(TSV.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"Wrote {target.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
