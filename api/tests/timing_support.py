"""Performance targets are diagnostics; functional and protocol assertions still fail."""
import json
import os
from pathlib import Path
import sys


def within_budget(measured, budget, what, *, unit='s'):
    """Record a breached performance target without changing the test outcome."""
    if measured <= budget:
        return
    nodeid = os.environ.get('PYTEST_CURRENT_TEST', '').rsplit(' (', 1)[0]
    breach = {'nodeid': nodeid, 'measured': measured, 'budget': budget, 'unit': unit, 'what': what}
    directory = os.environ.get('TEST_LOG_DIR')
    if directory:
        try:
            with (Path(directory) / f'timing-warnings-{os.getpid()}.jsonl').open('a') as output:
                output.write(json.dumps(breach) + '\n')
            return
        except OSError as error:
            print(f'WARNING: could not record timing budget: {error}', file=sys.stderr)
    print(f'WARNING: timing budget exceeded: {nodeid}: {measured} > {budget} {unit} ({what})', file=sys.stderr)
