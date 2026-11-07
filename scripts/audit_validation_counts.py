"""Fail-closed accounting for the never-merged combined-sharded validation branch.

Selected counts: real collection on dev 800b8fbd plus this validation tooling.
Skip counts: collected declarations and source-verified runtime skip identities.
Exact per-identity comparison is performed offline against the uploaded artifacts and identity lists.
"""
import argparse
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET


# Each pair is (selected, skipped); executed must equal selected minus skipped.
EXPECTED = {
    'api-1': {'pytest-parallel.xml': (1248, 1), 'pytest-serial.xml': (2, 0)},
    'api-2': {'pytest-parallel.xml': (1249, 3), 'pytest-serial.xml': (15, 1)},
    'api-3': {'pytest-parallel.xml': (1224, 2), 'pytest-serial.xml': (61, 2)},
    'auth': {'vitest.xml': (2462, 5)},
    'operations': {'verification.log': (11, 1)},
    'browser-1': {'playwright-parallel.json': (90, 0), 'playwright-serial.json': (2, 0)},
    'browser-2': {'playwright-parallel.json': (92, 0), 'playwright-serial.json': (0, 0)},
    'browser-3': {'playwright-parallel.json': (83, 0), 'playwright-serial.json': (0, 0)},
    'browser-4': {'playwright-parallel.json': (90, 1), 'playwright-serial.json': (0, 0)},
    'browser-5': {'playwright-parallel.json': (85, 0), 'playwright-serial.json': (0, 0)},
    'browser-6': {'playwright-parallel.json': (91, 0), 'playwright-serial.json': (0, 0)},
    'browser-7': {'playwright-parallel.json': (88, 0), 'playwright-serial.json': (0, 0)},
    'browser-8': {'playwright-parallel.json': (96, 0), 'playwright-serial.json': (0, 0)},
    'browser-9': {'playwright-parallel.json': (80, 0), 'playwright-serial.json': (0, 0)},
    'browser-10': {'playwright-parallel.json': (84, 0), 'playwright-serial.json': (0, 0)},
}


def accounting(selected, skipped):
    if any(type(n) is not int or n < 0 for n in (selected, skipped)) or skipped > selected:
        raise ValueError('invalid selected/skipped counts')
    return dict(selected=selected, skipped=skipped, executed=selected - skipped)


def junit_counts(path):
    root = ET.parse(path).getroot()
    if root.tag not in ('testsuite', 'testsuites'):
        raise ValueError('not a JUnit report')
    suites = [root] if root.tag == 'testsuite' else root.findall('testsuite')
    states = []
    for suite in suites:
        current = []
        for case in suite.findall('testcase'):
            flags = [tag for tag in ('skipped', 'failure', 'error') for _ in case.findall(tag)]
            if len(flags) > 1:
                raise ValueError('ambiguous JUnit case outcome')
            current.append(flags[0] if flags else 'passed')
        totals = dict(tests=len(current), skipped=current.count('skipped'),
                      failures=current.count('failure'), errors=current.count('error'))
        for field, count in totals.items():
            if int(suite.attrib[field]) != count:
                raise ValueError(f'JUnit suite {field} disagrees with its cases')
        states.extend(current)
    if not suites or len(states) != len(list(root.iter('testcase'))):
        raise ValueError('unsupported or unaccounted JUnit case structure')
    totals = dict(tests=len(states), skipped=states.count('skipped'),
                  failures=states.count('failure'), errors=states.count('error'))
    if root.tag == 'testsuites':
        for field, count in totals.items():
            if field in root.attrib and int(root.attrib[field]) != count:
                raise ValueError(f'JUnit aggregate {field} disagrees with its cases')
    return accounting(totals['tests'], totals['skipped'])


def playwright_counts(path):
    report = json.loads(path.read_text())
    stats = {key: report['stats'][key] for key in ('expected', 'unexpected', 'flaky', 'skipped')}
    if any(type(n) is not int or n < 0 for n in stats.values()):
        raise ValueError('invalid Playwright stats')
    walked = dict.fromkeys(stats, 0)

    def walk(suites):
        for suite in suites:
            for spec in suite['specs']:
                for test in spec['tests']:
                    results = test['results']
                    if not isinstance(results, list) or len(results) != 1:
                        raise ValueError('Playwright case needs one terminal attempt; missing results/retries forbidden')
                    result = results[-1]
                    status, expected = result['status'], test['expectedStatus']
                    if type(result['retry']) is not int or result['retry'] != 0:
                        raise ValueError('Playwright retry-only attempt forbidden')
                    if status not in ('passed', 'failed', 'timedOut', 'skipped') or expected not in ('passed', 'failed', 'skipped'):
                        raise ValueError('Playwright case did not finish a terminal execution')
                    if status == 'skipped' and expected != 'skipped':
                        raise ValueError('Playwright didNotRun is not an executed or intentional skipped case')
                    outcome = 'skipped' if status == 'skipped' else 'expected' if status == expected else 'unexpected'
                    if test['status'] != outcome:
                        raise ValueError('Playwright case outcome disagrees with final result')
                    walked[outcome] += 1
            walk(suite.get('suites', []))

    walk(report['suites'])
    if walked != stats:
        raise ValueError(f'Playwright walked outcomes {walked} disagree with stats {stats}')
    return accounting(sum(walked.values()), walked['skipped'])


def operations_counts(path):
    text = path.read_text()
    markers = list(re.finditer(r'^== verify phase: operations (start|end)$', text, re.MULTILINE))
    if [m[1] for m in markers[-2:]] != ['start', 'end']:
        raise ValueError('missing or incomplete last operations phase')
    phase = text[markers[-2].end():markers[-1].start()]
    totals = re.findall(r'^Ran (\d+) tests? in [\d.]+s$', phase, re.MULTILINE)
    skipped = re.findall(r'^OK(?: \(skipped=(\d+)\))?$', phase, re.MULTILINE)
    if len(totals) != 1 or len(skipped) != 1:
        raise ValueError('missing or ambiguous last operations unittest report')
    return accounting(int(totals[0]), int(skipped[0] or 0))


def leg_selection(leg, run):
    suite, _, number = leg.partition('-')
    shard = f'{number}/3' if suite == 'api' else f'{number}/10' if suite == 'browser' else None
    return dict(run=run.name, suite=suite, shard=shard)


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
    selection = leg_selection(args.leg, run)
    try:
        result = json.loads((run / 'result.json').read_text())
        if {field: result[field] for field in selection} != selection:
            raise ValueError(f'result.json does not match leg selection {selection}')
    except (OSError, ValueError, KeyError, TypeError) as error:
        errors.append(f'result.json: missing, invalid or wrong leg/run: {error}')
    expected = {report: accounting(*counts) for report, counts in EXPECTED[args.leg].items()}
    for report, wanted in expected.items():
        try:
            reader = junit_counts if report.endswith('.xml') else playwright_counts if report.endswith('.json') else operations_counts
            actual[report] = reader(run / report)
            print(f'{args.leg} {report}: {actual[report]}; expected {wanted}')
            if actual[report] != wanted:
                errors.append(f'{report}: expected {wanted}, found {actual[report]}')
        except (OSError, ValueError, KeyError, TypeError, AttributeError, ET.ParseError) as error:
            errors.append(f'{report}: missing or invalid report: {error}')
    (run / 'selection-audit.json').write_text(json.dumps({
        'leg': args.leg, 'selection': selection, 'expected': expected, 'actual': actual, 'errors': errors,
    }, indent=2) + '\n')
    for error in errors:
        print(f'{args.leg}: audit failed: {error}')
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
