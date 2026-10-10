"""Run the Playwright suite for the verification gate; scripts/ci.sh calls it as
``run_playwright.py --workers N [--fast] -- [selectors]``.

Pass 1 runs every test not tagged @serial with one worker per application stack that scripts/verify_resources.py
prepared; web/tests/support/browser-stack.ts points each worker at its own stack. Pass 2 runs the @serial tests with
one worker and nothing else running. ``--fast`` leaves out @slow tests in both passes. Selectors (spec files or
file:line locations) apply to both passes; worker, grep, reporter and output options belong to this runner. Each pass
has its own JSON report and its own output directory, because Playwright empties its output directory when it starts.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
RESERVED = ('--workers', '-j', '--grep', '-g', '--grep-invert', '--reporter', '--output', '--pass-with-no-tests', '--shard',
            '--fully-parallel')


def parse(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, default=1)
    parser.add_argument('--fast', action='store_true')
    parser.add_argument('selectors', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    selectors = args.selectors[1:] if args.selectors[:1] == ['--'] else args.selectors
    return args.workers, args.fast, selectors


def passes(workers, fast):
    """(name, Playwright arguments) of the two passes."""
    parallel = ['--workers', str(workers), '--grep-invert', '@serial|@slow' if fast else '@serial']
    serial = ['--workers', '1', '--grep', '@serial', *(['--grep-invert', '@slow'] if fast else [])]
    return [('parallel', parallel), ('serial', serial)]


def reserved_argument(selectors):
    for argument in selectors:
        if argument.split('=', 1)[0] in RESERVED:
            return argument
    return None


def report_totals(paths):
    totals = {'passed': 0, 'failed': 0, 'flaky': 0, 'skipped': 0}
    for path in paths:
        if not Path(path).exists():
            continue
        stats = json.loads(Path(path).read_text()).get('stats', {})
        for key, field in (('passed', 'expected'), ('failed', 'unexpected'), ('flaky', 'flaky'), ('skipped', 'skipped')):
            totals[key] += int(stats.get(field, 0))
    return totals


def main(argv=None):
    workers, fast, selectors = parse(argv)
    reserved = reserved_argument(selectors)
    if reserved:
        print(f'run_playwright: {reserved} is set by the verification runner; select spec files instead', file=sys.stderr)
        return 2
    logs = Path(os.environ.get('TEST_LOG_DIR') or '.')
    output = Path(os.environ.get('TEST_BROWSER_OUTPUT') or 'test-results')
    codes, reports = [], []
    for name, arguments in passes(workers, fast):
        report = logs / f'playwright-{name}.json'
        reports.append(report)
        environment = dict(os.environ, VERIFY_PLAYWRIGHT_JSON=str(report), TEST_BROWSER_OUTPUT=str(output / name))
        print(f'== playwright {name} pass: {" ".join(arguments)}', flush=True)
        command = ['npx', 'playwright', 'test', *arguments, '--pass-with-no-tests', *selectors]
        codes.append(subprocess.run(command, cwd=ROOT, env=environment).returncode)
    totals = report_totals(reports)
    print(f"== playwright total: {totals['passed']} passed, {totals['failed']} failed, {totals['flaky']} flaky, "
          f"{totals['skipped']} skipped (both passes)", flush=True)
    failed = next((code for code in codes if code), 0)
    if failed:
        return failed
    if sum(totals.values()) == 0:
        print('run_playwright: no Playwright test matched', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
