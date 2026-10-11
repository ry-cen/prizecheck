"""Derive every catalog Printing's card attributes and Reprint Group from its stored source record, without fetching
anything.

Run it once after applying migration 026, and again after applying migration 031. Until it or the next catalog import
runs, the Printings imported before 026 have unknown card attributes, so Deck checks report their Basic Energy
exemption as unresolved; and the Printings imported before 031 are in no Reprint Group, so format checks judge an old
Trainer or Energy printing on its own mark and set alone. Every catalog import re-derives all Printings itself, so it
is never needed again; rerunning it changes nothing.

Changed attributes and Reprint Groups are public format facts (Deck Lists 18): the changed Printings, and every
Printing of a Reprint Group whose membership changed, are enqueued and then delivered to the shared records store
before it exits. When delivery reports pending, run scripts/backfill_public_catalog.py.

Exit codes: 0 derived, 1 the database is unreachable, 3 a catalog import is running (retry when it has finished;
nothing was changed).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app.catalog import RunnerBusy, rederive_card_attributes  # noqa: E402
from app.main import connect  # noqa: E402
from app.public_catalog import publish_catalog_best_effort  # noqa: E402


def main():
    try:
        with connect() as conn:
            changed = rederive_card_attributes(conn)
            delivered = publish_catalog_best_effort(conn)
    except RunnerBusy:
        print('A catalog import is running; nothing was changed. Retry when it has finished.', file=sys.stderr)
        return 3
    except psycopg.Error:
        print('Card attributes could not be derived; check the database.', file=sys.stderr)
        return 1
    print(f'Card attributes derived: {changed} Printings changed; Reprint Groups refreshed; public catalog delivery '
          f'{"delivered" if delivered else "pending (run scripts/backfill_public_catalog.py)"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
