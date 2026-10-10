"""Operator tool for price runner slots (docs/price-refresh.md, ADR 0008).

``status`` prints the slot leases and scheduler counts as JSON. ``release --slot n --confirm-terminated`` frees a slot
whose runner could not be proven dead (other host, or a lock file that is gone): the operator asserts the process is
gone, then the slot's permits are released, its unexpired jobs requeued and its expired jobs dropped. Releasing a slot
whose runner is alive can produce a duplicate fetch, never a duplicate write (the fence still rejects the stale writer).
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))

from app import price_launcher  # noqa: E402
from app import quote_contract as qc  # noqa: E402
from app.public_projection import ProjectionUnavailable  # noqa: E402
from app.public_records import public_record_store  # noqa: E402


def status(store):
    keys = [qc.scheduler_key(), qc.source_backoff_key()] + [qc.runner_lease_key(slot) for slot in qc.RUNNER_SLOTS]
    rows = price_launcher.read(store, keys).records
    scheduler = rows[qc.scheduler_key()].value or {}
    jobs = scheduler.get('jobs', {})
    return {'slots': {str(slot): rows[qc.runner_lease_key(slot)].value for slot in qc.RUNNER_SLOTS},
            'source_backoff': rows[qc.source_backoff_key()].value,
            'jobs': len(jobs), 'queued': sum(job['state'] == 'queued' for job in jobs.values()),
            'running': sum(job['state'] == 'running' for job in jobs.values()),
            'source_permits': len(scheduler.get('source', {})), 'stats': scheduler.get('stats'),
            'host': price_launcher.host_id()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('status')
    release = commands.add_parser('release')
    release.add_argument('--slot', type=int, required=True, choices=qc.RUNNER_SLOTS)
    release.add_argument('--confirm-terminated', action='store_true',
                         help='assert that no runner process for this slot is still alive on any host')
    args = parser.parse_args(argv)
    if args.command == 'release' and not args.confirm_terminated:
        print('Refusing: pass --confirm-terminated once you have verified the runner process is gone.', file=sys.stderr)
        return 2
    try:
        store = public_record_store()
        if args.command == 'status':
            print(json.dumps(status(store), indent=2, sort_keys=True))
            return 0
        outcome = price_launcher.release_slot(store, args.slot)
        print(json.dumps({'slot': args.slot, 'result': outcome}))
        return 0 if outcome in ('released', 'not_applicable') else 1
    except ProjectionUnavailable:
        print('Record store unavailable.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
