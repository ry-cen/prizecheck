"""Explicitly bind owner privilege to an immutable Better Auth user ID."""
import os
import sys

import psycopg

if len(sys.argv) != 2:
    raise SystemExit("Usage: python scripts/bind_owner.py <immutable-user-id>")
user_id = sys.argv[1]
with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
    exists = conn.execute('SELECT 1 FROM "user" WHERE id = %s', (user_id,)).fetchone()
    if not exists:
        raise SystemExit("User ID does not exist in Better Auth")
    conn.execute("INSERT INTO inventory_owner (user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user_id,))
    conn.execute("INSERT INTO owner_binding (singleton, user_id) VALUES (true, %s)", (user_id,))
print("Owner bound to immutable user ID")
