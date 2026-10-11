"""Derive every catalog Printing's card attributes from its stored source record, without fetching anything.

Run it once after applying migration 026: until it or the next catalog import runs, the Printings imported before
026 have unknown card attributes, so Deck checks report their Basic Energy exemption as unresolved. Every catalog
import re-derives all Printings itself, so it is never needed again; rerunning it changes nothing.

Exit codes: 0 derived, 1 the database is unreachable, 3 a catalog import is running (retry when it has finished;
nothing was changed).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app.catalog import RunnerBusy, rederive_card_attributes  # noqa: E402
from app.main import connect  # noqa: E402


def main():
    try:
        with connect() as conn:
            changed = rederive_card_attributes(conn)
    except RunnerBusy:
        print('A catalog import is running; nothing was changed. Retry when it has finished.', file=sys.stderr)
        return 3
    except psycopg.Error:
        print('Card attributes could not be derived; check the database.', file=sys.stderr)
        return 1
    print(f'Card attributes derived: {changed} Printings changed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
