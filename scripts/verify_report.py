"""Timing and count summary of one verification run directory (.scratch/verification/<run>/).

Reads phases.tsv (scripts/ci.sh), pytest-parallel.xml and pytest-serial.xml (scripts/run_pytest.py), vitest.xml
(scripts/ci.sh), and playwright-parallel.json and playwright-serial.json (scripts/run_playwright.py). scripts/verify.py calls summarize()
after every run: it writes timings.json and timings.md and appends the same summary to verification.log.
``python scripts/verify_report.py <run-dir>`` prints the summary of an earlier run.
"""
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

PYTEST_REPORTS = ('pytest-parallel.xml', 'pytest-serial.xml')
PLAYWRIGHT_REPORTS = ('playwright-parallel.json', 'playwright-serial.json')


def phases(directory):
    """{phase: seconds} for each phase in phases.tsv with both a start and an end line, in start order."""
    path = Path(directory) / 'phases.tsv'
    starts, durations = {}, {}
    if not path.exists():
        return durations
    for line in path.read_text().splitlines():
        name, mark, stamp = line.split('\t')
        if mark == 'start':
            starts[name] = int(stamp)
        elif mark == 'end' and name in starts:
            durations[name] = int(stamp) - starts[name]
    return durations


def pytest_results(directory):
    """(counts summed over both passes or None when pytest did not run, [(seconds, test id, pass)] slowest first)."""
    counts, cases = None, []
    for report in PYTEST_REPORTS:
        path = Path(directory) / report
        if not path.exists():
            continue
        counts = counts or {'passed': 0, 'failed': 0, 'errors': 0, 'skipped': 0}
        group = report.split('-')[1].split('.')[0]
        for suite in ET.parse(path).getroot().iter('testsuite'):
            tests, failures, errors, skipped = (int(suite.get(key, 0)) for key in ('tests', 'failures', 'errors', 'skipped'))
            counts['passed'] += tests - failures - errors - skipped
            counts['failed'] += failures
            counts['errors'] += errors
            counts['skipped'] += skipped
            for case in suite.iter('testcase'):
                cases.append((float(case.get('time', 0)), f"{case.get('classname')}::{case.get('name')}", group))
    cases.sort(key=lambda case: -case[0])
    return counts, cases


def vitest_results(directory):
    """(counts or None when vitest did not run, [(seconds, test, file)] slowest first). With --fast, the tests left out
    by --tags-filter=!slow count as skipped."""
    path = Path(directory) / 'vitest.xml'
    if not path.exists():
        return None, []
    counts, cases = {'passed': 0, 'failed': 0, 'errors': 0, 'skipped': 0}, []
    for suite in ET.parse(path).getroot().iter('testsuite'):
        tests, failures, errors, skipped = (int(suite.get(key, 0)) for key in ('tests', 'failures', 'errors', 'skipped'))
        counts['passed'] += tests - failures - errors - skipped
        counts['failed'] += failures
        counts['errors'] += errors
        counts['skipped'] += skipped
        for case in suite.iter('testcase'):
            cases.append((float(case.get('time', 0)), f"{case.get('classname')} › {case.get('name')}", 'vitest'))
    cases.sort(key=lambda case: -case[0])
    return counts, cases


def playwright_results(directory):
    """(counts summed over both passes or None when Playwright did not run, [(seconds, test, pass)] slowest first)."""
    counts, cases = None, []
    for report in PLAYWRIGHT_REPORTS:
        path = Path(directory) / report
        if not path.exists():
            continue
        counts = counts or {'passed': 0, 'failed': 0, 'flaky': 0, 'skipped': 0}
        group = report.split('-')[1].split('.')[0]
        data = json.loads(path.read_text())
        stats = data.get('stats', {})
        for key, field in (('passed', 'expected'), ('failed', 'unexpected'), ('flaky', 'flaky'), ('skipped', 'skipped')):
            counts[key] += int(stats.get(field, 0))
        suites = list(data.get('suites', []))
        while suites:
            suite = suites.pop()
            suites.extend(suite.get('suites', []))
            for spec in suite.get('specs', []):
                for test in spec.get('tests', []):
                    seconds = sum(result.get('duration', 0) for result in test.get('results', [])) / 1000
                    cases.append((seconds, f"{spec.get('file')}:{spec.get('line')} › {spec.get('title')}", group))
    cases.sort(key=lambda case: -case[0])
    return counts, cases


def markdown(summary):
    lines = ['| Phase | Seconds |', '| --- | ---: |']
    lines += [f'| {name} | {seconds} |' for name, seconds in summary['phases'].items()]
    for suite in ('pytest', 'vitest', 'playwright'):
        counts = summary[suite]['counts']
        if counts is None:
            continue
        scope = ' (one run)' if suite == 'vitest' else ' (both passes)'
        lines += ['', f'{suite}: ' + ', '.join(f'{value} {key}' for key, value in counts.items()) + scope, '',
                  f'| Slowest {suite} tests | Pass | Seconds |', '| --- | --- | ---: |']
        lines += [f'| {name} | {group} | {seconds:.1f} |' for seconds, name, group in summary[suite]['slowest']]
    return '\n'.join(lines) + '\n'


def collect(directory):
    pytest_counts, pytest_cases = pytest_results(directory)
    vitest_counts, vitest_cases = vitest_results(directory)
    playwright_counts, playwright_cases = playwright_results(directory)
    return {'phases': phases(directory),
            'pytest': {'counts': pytest_counts, 'slowest': pytest_cases[:30]},
            'vitest': {'counts': vitest_counts, 'slowest': vitest_cases[:20]},
            'playwright': {'counts': playwright_counts, 'slowest': playwright_cases[:20]}}


def summarize(directory):
    """Write timings.json and timings.md, append the summary to verification.log, and return the totals for result.json."""
    directory = Path(directory)
    summary = collect(directory)
    (directory / 'timings.json').write_text(json.dumps(summary, indent=2))
    text = markdown(summary)
    (directory / 'timings.md').write_text(text)
    with (directory / 'verification.log').open('a') as log:
        log.write('\n== verification summary\n' + text)
    return {'phases': summary['phases'], 'pytest': summary['pytest']['counts'], 'vitest': summary['vitest']['counts'],
            'playwright': summary['playwright']['counts']}


if __name__ == '__main__':
    print(markdown(collect(sys.argv[1])), end='')
