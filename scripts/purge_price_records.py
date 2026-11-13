"""Delete the retired price refresh's records from the public record store (ADR 0019, issue #356).

    python scripts/purge_price_records.py [--dry-run]    # count only (the default)
    python scripts/purge_price_records.py --delete       # delete them

The seven retired families are known by their own key patterns here, independent of the store's registered families:
quote, result, fence, work, admission, lease and backoff. A dry run prints how many keys of each family the store holds
and changes nothing. ``--delete`` removes them in compare-and-swap batches of at most 128 keys, re-reading and retrying
a batch that lost a version race a bounded number of times, and prints how many it deleted per family; a rerun then
finds none. Keys of every live family, and keys that match none of the seven patterns, are never touched or counted.

Exit codes: 0 done; 1 the store failed (unreachable, corrupt or past its deadline); 2 conflicts were still unresolved
after the retries, so some legacy keys remain (rerun it). Environment: PUBLIC_PROJECTION_DIR (the filesystem adapter
only: production's store).
"""
import argparse
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from app.public_projection import ProjectionUnavailable  # noqa: E402
from app.public_records import FilePublicRecords  # noqa: E402

FAMILIES = (
    ('quote', re.compile(r'quote:([0-9a-f]{48}):([1-9][0-9]{0,18})')),
    ('result', re.compile(r'result:([0-9a-f]{48}):([1-9][0-9]{0,18})')),
    ('fence', re.compile(r'fence:([0-9a-f]{48}):([1-9][0-9]{0,18})')),
    ('work', re.compile(r'work:([0-9a-f]{48}):([1-9][0-9]{0,18})')),
    ('admission', re.compile(r'admission:([A-Za-z0-9_.:-]{1,200})')),
    ('lease', re.compile(r'lease:([A-Za-z0-9_.:-]{1,200})')),
    ('backoff', re.compile(r'backoff:([A-Za-z0-9_.:-]{1,200})')),
)
NAMES = tuple(name for name, _ in FAMILIES)
CHUNK = 128          # the store's batch limit
ATTEMPTS = 4         # re-read-and-retry rounds when a batch loses a compare-and-swap
STEP_SECONDS = 30.0  # deadline for each store call


def family(key):
    if not isinstance(key, str):
        return None
    for name, pattern in FAMILIES:
        match = pattern.fullmatch(key)
        if match and (name not in ('quote', 'result', 'fence', 'work') or int(match.group(2)) <= 2 ** 63 - 1):
            return name
    return None


def legacy(store):
    """``{key: (family, version)}`` for the retired keys the store holds now."""
    found = store.unregistered_records(deadline=time.monotonic() + STEP_SECONDS)
    return {key: (name, version) for key, version in found.items() if (name := family(key)) is not None}


def counts(rows):
    tally = dict.fromkeys(NAMES, 0)
    for name, _ in rows.values():
        tally[name] += 1
    return tally


def delete(store):
    """Delete every retired key; returns (deleted counts by family, keys still left after the retries)."""
    deleted = dict.fromkeys(NAMES, 0)
    rows = legacy(store)
    for _ in range(ATTEMPTS):
        if not rows:
            break
        lost = False
        keys = sorted(rows)
        for start in range(0, len(keys), CHUNK):
            part = keys[start:start + CHUNK]
            if store.delete_unregistered({key: rows[key][1] for key in part}, deadline=time.monotonic() + STEP_SECONDS):
                for key in part:
                    deleted[rows[key][0]] += 1
            else:
                lost = True
        rows = legacy(store)
        if not lost:
            break
    return deleted, rows


def show(label, tally):
    print(label + ' ' + ', '.join(f'{name} {tally[name]}' for name in NAMES) + f' (total {sum(tally.values())})')


def main(argv=None, store=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='count the retired keys by family and change nothing (default)')
    mode.add_argument('--delete', action='store_true', help='delete the retired keys')
    args = parser.parse_args(argv)
    if store is None:
        if os.environ.get('PUBLIC_PROJECTION_ADAPTER', 'filesystem') != 'filesystem':
            print('purge_price_records: only the filesystem record store is supported', file=sys.stderr)
            return 1
        store = FilePublicRecords()
    try:
        if not args.delete:
            show('dry run: would delete', counts(legacy(store)))
            return 0
        deleted, left = delete(store)
    except ProjectionUnavailable:
        print('purge_price_records: the record store is unavailable or corrupt; nothing more was deleted', file=sys.stderr)
        return 1
    show('deleted', deleted)
    if left:
        show('purge_price_records: conflicts left keys in place; rerun to delete', counts(left))
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
