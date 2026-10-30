"""Rebuild every stale stored Format Standing now (migration 042, app redesign spec "Stored Format Standing").

Scheduled daily at 00:05 UTC (docs/operations/portable-jobs.md), it picks up each rule date: a set's legal-from date, a
rotation, or a ban taking effect or lifting. It also builds the standings for the first time after migration 042, and
after a deploy that changes a rules file, although the API's startup and the first reader do that too. Formats that are
already current are left alone, so running it again changes nothing.

Exit codes: 0 current or rebuilt, 1 the database is unreachable, 3 another rebuild held a Format's lock for longer than
the wait (retry when it has finished; nothing was changed).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app.games.pokemon.formats.format_standing import StandingBusy, ensure_current  # noqa: E402


def main():
    try:
        state = ensure_current()
    except StandingBusy:
        print('Another Format Standing rebuild is running; nothing was changed. Retry when it has finished.',
              file=sys.stderr)
        return 3
    except psycopg.Error:
        print('Format Standing could not be rebuilt; check the database.', file=sys.stderr)
        return 1
    print(f'Format Standing rebuilt: {", ".join(state.rebuilt) or "nothing (every Format is current)"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
