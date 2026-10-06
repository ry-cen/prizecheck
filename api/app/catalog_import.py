"""One detached import, one exact server-generated run ID, then exit."""
import argparse
from uuid import UUID

from .catalog import RunnerBusy, claim_run, execute_run
from .main import connect


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-id', required=True, type=UUID)
    args = parser.parse_args(argv)
    try:
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
