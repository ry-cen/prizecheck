"""Remove one verification run's artifacts: ``python scripts/verify_discard.py <run-id>``.

The run id is the name scripts/verify.py prints first (``Verification run: <id>``), for example
``20261010T195314Z-28c6ae5f``. Anything else is refused: an empty id, a path, a pattern, or a directory that is not a
run. The artifacts root itself (.scratch/verification) is never removed. Use this instead of ``rm -rf`` on a composed
path, which removes every run's evidence when the id turns out to be empty.
"""
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / '.scratch' / 'verification'
RUN_ID = re.compile(r'\d{8}T\d{6}Z-[0-9a-f]{8}')


def run_directory(run_id, runs=RUNS):
    """The directory of exactly this run, or ValueError."""
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        raise ValueError(f'not a verification run id: {run_id!r}')
    directory = runs / run_id
    if directory.resolve().parent != runs.resolve() or directory.is_symlink() or not directory.is_dir():
        raise ValueError(f'no verification run {run_id} under {runs}')
    if not any((directory / name).exists() for name in ('verification.log', 'result.json')):
        raise ValueError(f'{directory} is not a verification run directory')
    return directory


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 1:
        print('usage: verify_discard.py <run-id>', file=sys.stderr)
        return 2
    try:
        directory = run_directory(arguments[0])
    except ValueError as error:
        print(f'verify_discard: {error}', file=sys.stderr)
        return 2
    shutil.rmtree(directory)
    print(f'Removed {directory}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
