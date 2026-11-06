"""Fail-closed per-pass accounting for the never-merged combined-sharded validation branch.

EXPECTED comes from the exact-head identity reconciliation at 6e25fe272a9be8dd73f17e4b8e51c7b442e90174.
This repair changes no test-selection inputs. Counts include skipped cases, not just passes.
"""
import argparse
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET


EXPECTED = {
    'api-1': {'pytest-parallel.xml': 1248, 'pytest-serial.xml': 2},
    'api-2': {'pytest-parallel.xml': 1249, 'pytest-serial.xml': 15},
    'api-3': {'pytest-parallel.xml': 1224, 'pytest-serial.xml': 61},
    'auth': {'vitest.xml': 2462},
    'operations': {'verification.log': 11},
    'browser-1': {'playwright-parallel.json': 87, 'playwright-serial.json': 2},
    'browser-2': {'playwright-parallel.json': 92, 'playwright-serial.json': 0},
    'browser-3': {'playwright-parallel.json': 85, 'playwright-serial.json': 0},
    'browser-4': {'playwright-parallel.json': 86, 'playwright-serial.json': 0},
    'browser-5': {'playwright-parallel.json': 89, 'playwright-serial.json': 0},
    'browser-6': {'playwright-parallel.json': 87, 'playwright-serial.json': 0},
    'browser-7': {'playwright-parallel.json': 82, 'playwright-serial.json': 0},
    'browser-8': {'playwright-parallel.json': 94, 'playwright-serial.json': 0},
    'browser-9': {'playwright-parallel.json': 80, 'playwright-serial.json': 0},
    'browser-10': {'playwright-parallel.json': 84, 'playwright-serial.json': 0},
}


def report_count(path):
    if path.suffix == '.xml':
        root = ET.parse(path).getroot()
        if root.tag not in ('testsuite', 'testsuites'):
            raise ValueError('not a JUnit report')
        return len(list(root.iter('testcase')))
    if path.suffix == '.json':
        stats = json.loads(path.read_text())['stats']
        counts = [stats[key] for key in ('expected', 'unexpected', 'flaky', 'skipped')]
        if any(type(count) is not int or count < 0 for count in counts):
            raise ValueError('invalid Playwright counts')
        return sum(counts)
    # unittest writes its report to stderr, captured in verification.log. Exclude setup's tooling summary.
    phases = re.findall(r'^== verify phase: operations start\n(.*?)^== verify phase: operations end$',
                        path.read_text(), re.MULTILINE | re.DOTALL)
    summaries = re.findall(r'^Ran (\d+) tests? in [\d.]+s$', phases[0], re.MULTILINE) if len(phases) == 1 else []
    if len(summaries) != 1:
        raise ValueError('missing or ambiguous operations unittest report')
    return int(summaries[0])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('leg', choices=EXPECTED)
    parser.add_argument('artifacts', nargs='?', type=Path, default=Path('.scratch/verification'))
    args = parser.parse_args(argv)
    try:
        runs = [path for path in args.artifacts.iterdir() if path.is_dir()]
        if len(runs) != 1:
            raise ValueError(f'expected exactly one verification run, found {len(runs)}')
        run = runs[0]
    except (OSError, ValueError) as error:
        print(f'{args.leg}: audit failed: {error}')
        return 1
    actual, errors = {}, []
    for report, expected in EXPECTED[args.leg].items():
        try:
            actual[report] = report_count(run / report)
            print(f'{args.leg} {report}: {actual[report]} cases; expected {expected} (including skips)')
            if actual[report] != expected:
                errors.append(f'{report}: expected {expected} cases, found {actual[report]}')
        except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as error:
            errors.append(f'{report}: missing or invalid report: {error}')
    (run / 'selection-audit.json').write_text(json.dumps({
        'leg': args.leg, 'expected': EXPECTED[args.leg], 'actual': actual, 'errors': errors,
    }, indent=2) + '\n')
    for error in errors:
        print(f'{args.leg}: audit failed: {error}')
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
