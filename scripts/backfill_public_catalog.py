"""Rebuild the public catalog records in the shared records store from PostgreSQL.

The name is kept for existing runbooks and CI. Run it after scripts/init_public_records.py (or
init_public_projection.py) and whenever the records store was lost, re-initialized empty or
restored from an older copy, or PostgreSQL was restored to a point older than the store.

Steps: scan the store for the highest stored revision and for records PostgreSQL does not
explain, advance the revision clock past that maximum, mark every unexplained target
quarantined/suspended with reason recovery_conflict, then re-enqueue and deliver every target.
Only records that are older than PostgreSQL are written; a second run writes nothing. It never
resets, repairs or initializes the store itself, and it never touches Published Decks or discovery.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app.public_catalog import backfill  # noqa: E402
from app.public_projection import ProjectionUnavailable  # noqa: E402


def main():
    try:
        result = backfill()
    except (ProjectionUnavailable, psycopg.Error):
        print('Public catalog records could not be rebuilt; check the records store and database.', file=sys.stderr)
        return 1
    print(f'Public catalog records rebuilt: {result.written} written, {result.unchanged} unchanged, '
          f'{result.conflicts} recovery conflicts, highest stored revision {result.store_max}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
