import os
from pathlib import Path

import psycopg

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
