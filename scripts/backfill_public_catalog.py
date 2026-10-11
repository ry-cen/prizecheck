"""Rebuild the public catalog records in the shared records store from PostgreSQL.

The name is kept for existing runbooks and CI. Run it after scripts/init_public_records.py (or
init_public_projection.py) and whenever the records store was lost, re-initialized empty or
restored from an older copy, or PostgreSQL was restored to a point older than the store. Run it once
after activating the first release with Published Deck format results (migration 032) to publish each
Printing's format facts, again after activating the first release with Basic Pokémon status (migration 034) to rewrite
the format records it left without that attribute, and again after rolling forward from a rollback below either release.

Steps: scan the store for the highest stored revision and for records PostgreSQL does not
explain, advance the revision clock past that maximum, mark every unexplained target
quarantined/suspended with reason recovery_conflict, then re-enqueue and deliver every target.
Only records that are older than PostgreSQL are written; a second run writes nothing. It never
resets, repairs or initializes the store itself, and it never touches Published Decks or discovery.

Exit codes: 0 rebuilt, 1 the store or database is unreachable or delivery could not finish, 3 another
drain held the delivery lock for the whole wait (retry later; nothing is wrong).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app.public_catalog import RebuildBusy, backfill  # noqa: E402
from app.public_projection import ProjectionUnavailable  # noqa: E402


def main():
    try:
        result = backfill()
    except RebuildBusy:
        print('Another drain is running (for example an import or rule activation still delivering); nothing was changed. '
              'Retry when it has finished.', file=sys.stderr)
        return 3
    except (ProjectionUnavailable, psycopg.Error):
        print('Public catalog records could not be rebuilt; check the records store and database.', file=sys.stderr)
        return 1
    print(f'Public catalog records rebuilt: {result.written} written, {result.unchanged} unchanged, '
          f'{result.conflicts} recovery conflicts, highest stored revision {result.store_max}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
