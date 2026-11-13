"""Riftbound's explicit database migration command (IM-11/12/13; ADR 0023)."""
import os
import sys
from pathlib import Path

import psycopg

# Match the Pokémon entry's read-only imports in a verified release store.
sys.dont_write_bytecode = True
import migration_tracks  # noqa: E402
from migration_tracks import Track  # noqa: E402

root = Path(__file__).resolve().parents[1]

# A new database runs the whole core baseline, seed and tail, then its own game track.
# No Pokémon history is replayed and no core file is merely recorded.
TRACKS = (Track("core"), Track("riftbound"))


def main():
    url = os.environ.get("RIFTBOUND_DATABASE_URL")
    if not url:
        raise SystemExit("RIFTBOUND_DATABASE_URL must be set to migrate the Riftbound database")
    with psycopg.connect(url) as conn:
        migration_tracks.apply(conn, root / "migrations", TRACKS)


if __name__ == "__main__":
    main()
