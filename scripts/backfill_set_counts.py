"""Fill catalog_generation_set_count (migration 150) for the active catalog generation.

Run it once after activating the release that adds the table, before the scanner routes are reachable: imports fill the
table from then on, but the generation already active has no rows. It reads the stored card records in
catalog_generation.raw_gzip and applies the import's rule (api/app/set_counts.py). Rows already there stay as they are
(ON CONFLICT DO NOTHING), so a second run changes nothing.

Exit codes: 0 filled (or already full), 1 the database is unreachable, 2 stopped without writing: there is no active
generation, or its stored records carry no set.cardCount, so the counts would have to be guessed.
"""
import gzip
import json
import os
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app.games.pokemon.catalog.set_counts import carries_card_count, insert_set_counts, set_counts  # noqa: E402


def main():
    try:
        with psycopg.connect(os.environ['DATABASE_URL']) as conn, conn.transaction():
            row = conn.execute("""SELECT g.id,g.raw_gzip FROM catalog_state s JOIN catalog_generation g ON g.id=s.active_generation
              WHERE s.singleton""").fetchone()
            if not row:
                print('No active catalog generation; nothing was changed.', file=sys.stderr)
                return 2
            generation_id, raw = row
            try:
                records = json.loads(gzip.decompress(raw))
            except (OSError, EOFError, ValueError, zlib.error):
                records = None
            if not isinstance(records, list) or not carries_card_count(records):
                print('The stored card records of the active generation carry no set.cardCount; nothing was changed. '
                      'Import the catalog again, or settle where the counts come from, before running this.', file=sys.stderr)
                return 2
            counts = set_counts(records)
            added = insert_set_counts(conn, generation_id, counts)
    except psycopg.Error:
        print('Set counts could not be filled; check the database.', file=sys.stderr)
        return 1
    print(f'Set counts: {added} added, {len(counts) - added} already present, {len(counts)} sets with a count')
    return 0


if __name__ == '__main__':
    sys.exit(main())
