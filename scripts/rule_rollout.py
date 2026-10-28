"""Apply, finish or restore the catalog rules a release ships (ADR 0021, design section 4.15).

    python scripts/rule_rollout.py resume
    python scripts/rule_rollout.py restore --to <commit>

``resume`` applies the newest version of each rule kind when the release (RELEASE_COMMIT) has not yet, and finishes any
unfinished rollout; it prints one line per kind. ``restore`` makes the activations the release ``--to`` knows current
again (the deploy script runs it with the release being rolled back from, whose RELEASE_COMMIT is required); it
re-evaluates nothing.

Exit codes: 0 done (including nothing to change), 1 the database is unreachable, 2 bad arguments, a missing or invalid
RELEASE_COMMIT, or any other failure. Environment: DATABASE_URL, RELEASE_COMMIT, RULE_ROLLOUT_BATCH.
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import psycopg  # noqa: E402
from app import rule_rollout  # noqa: E402
from app.db import connect  # noqa: E402


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        raise SystemExit(2)


def main(argv=None) -> int:
    parser = _Parser(prog='rule_rollout.py')
    commands = parser.add_subparsers(dest='command', required=True, parser_class=_Parser)
    commands.add_parser('resume')
    commands.add_parser('restore').add_argument('--to', required=True, dest='to_commit')
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_:
        return int(exit_.code or 0)
    try:
        if args.command == 'resume':
            outcome = rule_rollout.apply_newest_rules(connect)
            for kind, result in outcome.items():
                print(f'{kind}: {result}')
            return 0
        current = os.environ.get('RELEASE_COMMIT')
        if current is None or not rule_rollout.COMMIT.fullmatch(current):
            print('RELEASE_COMMIT must name the current release (40 hex characters)', file=sys.stderr)
            return 2
        for kind, result in rule_rollout.restore(connect, args.to_commit, current).items():
            print(f'{kind}: {result}')
        return 0
    except psycopg.OperationalError as exc:
        if isinstance(exc, psycopg.errors.LockNotAvailable):
            print(f'rule_rollout failed ({type(exc).__name__})', file=sys.stderr)
            return 2
        print('The database is unreachable', file=sys.stderr)
        return 1
    except Exception as exc:
        print(f'rule_rollout failed ({type(exc).__name__}: {exc})', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
