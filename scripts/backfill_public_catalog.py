"""Idempotently publish public-safe catalog records from PostgreSQL into the shared records store.

Run after scripts/init_public_records.py (or init_public_projection.py) on existing installs,
and to retry after a records-store outage: catalog imports and Printing/Edition approvals publish
best effort after they commit, and a failed write is repaired here. Only missing or changed
records are written. It never resets, repairs or initializes the store itself.
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
        print('Public catalog records could not be published; check the records store and database.', file=sys.stderr)
        return 1
    print(f'Public catalog records published: {result.written} written, {result.unchanged} unchanged')
    return 0


if __name__ == '__main__':
    sys.exit(main())
