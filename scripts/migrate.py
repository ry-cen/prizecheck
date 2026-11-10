import os
import sys
from pathlib import Path

import psycopg

# A release runs this file from inside its verified store directory (scripts/release.py), and the runtime then checks every
# file there against the release receipt, so importing the helpers must not leave a __pycache__ beside it.
sys.dont_write_bytecode = True
import migration_tracks  # noqa: E402
import set_code_migration  # noqa: E402
from migration_tracks import Track  # noqa: E402

root = Path(__file__).resolve().parents[1]

# The Pokémon database's entry (IM-12, IM-13): its tracks in apply order, and no run-time setting that picks them. The root
# directory is Pokémon's track, with its names unqualified, and it is split at the cutoff, the last file before the core
# baseline. Pending root files up to the cutoff run first. Then the core track: its baseline and zip seed are RECORDED
# without running, after the runner checks that the objects exist, because root files 001 to 162 already built them (fresh
# and populated databases take this same path; there is no Pokémon squash). Then any pending core tail, then the root files
# after the cutoff. A new game's entry lists Track("core") whole, so the baseline runs there.
CUTOFF = "162_trade_loan_threads.sql"
TRACKS = (
    Track(through=CUTOFF),
    Track("core", recorded=("000_baseline.sql", "001_zip_centroids.sql")),
    Track(after=CUTOFF),
)


def check_set_codes(conn):
    """The printed set codes (WP-C1): the table must equal set_codes.tsv and the view must give each Printing its code."""
    if conn.execute("SELECT to_regclass('catalog_set_code') IS NOT NULL AS present").fetchone()[0]:
        codes = set_code_migration.parse((root / "api/app/games/pokemon/catalog/set_codes.tsv").read_text(encoding="utf-8"))
        problems = []
        stored = {tuple(row) for row in conn.execute("SELECT set_id, code FROM catalog_set_code")}
        wanted = set(codes.items())
        problems += [f"table lacks {row}" for row in sorted(wanted - stored)]
        problems += [f"table has extra {row}" for row in sorted(stored - wanted)]
        # One statement, one snapshot: a catalog pull running beside a release must not make the count and the view differ.
        rows = conn.execute("SELECT v.printing_id, pd.set_id, v.set_code, (SELECT count(*) FROM catalog_printing) AS printings"
                            " FROM catalog_printing_set_code v"
                            " LEFT JOIN catalog_printing_display pd ON pd.printing_id = v.printing_id").fetchall()
        printings = rows[0][3] if rows else conn.execute("SELECT count(*) FROM catalog_printing").fetchone()[0]
        if len(rows) != printings or len({row[0] for row in rows}) != printings:
            problems.append(f"view has {len(rows)} rows for {printings} Printings")
        problems += [f"Printing {row[0]} of set {row[1] or ''!r} reads {row[2]!r}"
                     for row in rows if row[2] != codes.get(row[1] or "", row[1] or "")]
        if problems:
            print(f"set code table disagrees with set_codes.tsv: {'; '.join(problems[:5])}; nothing from this run was committed")
            sys.exit(1)
        print(f"Set codes match set_codes.tsv: {len(stored)} rows, {printings} Printings")


def main():
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        migration_tracks.apply(conn, root / "migrations", TRACKS)
        check_set_codes(conn)


if __name__ == "__main__":
    main()
