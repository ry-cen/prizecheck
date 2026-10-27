"""One detached import, one exact server-generated run ID, then exit.

``--drain`` instead delivers the public catalog outbox to completion (started after a rule activation)."""
import argparse
from uuid import UUID

from .catalog import RunnerBusy, claim_run, execute_run
from .db import connect


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-id', type=UUID)
    parser.add_argument('--drain', action='store_true')
    args = parser.parse_args(argv)
    if args.drain == (args.run_id is not None):
        parser.error('Give exactly one of --run-id or --drain')
    try:
        if args.drain:
            from .public_catalog import drain_to_completion
            with connect() as conn:
                return 0 if drain_to_completion(conn).state == 'delivered' else 2
        with connect() as conn:
            run_id = claim_run(conn,args.run_id)
            if run_id is not None:
                execute_run(conn,run_id)
        return 0
    except RunnerBusy:
        return 2
    except KeyboardInterrupt:
        return 130
    except Exception:
        # No raw exception, account details, or source payload reaches logs.
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
