import os
import sys
from pathlib import Path

import psycopg

import set_code_migration

root = Path(__file__).resolve().parents[1]
with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
    for path in sorted((root / "migrations").glob("*.sql")):
        if conn.execute("SELECT 1 FROM schema_migration WHERE name = %s", (path.name,)).fetchone():
            continue
        with conn.transaction():
            conn.execute(path.read_text())
            conn.execute("INSERT INTO schema_migration (name) VALUES (%s)", (path.name,))
        print(f"Applied {path.name}")

    # The printed set codes (WP-C1): the table must equal set_codes.tsv and the view must give each Printing its code.
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
