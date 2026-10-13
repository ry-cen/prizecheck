"""Timing and count summary of one verification run directory (.scratch/verification/<run>/).

Reads phases.tsv (scripts/ci.sh), pytest-parallel.xml and pytest-serial.xml (scripts/run_pytest.py), vitest.xml or,
when vitest ran more than once, vitest-1.xml ... vitest-N.xml (scripts/ci.sh), and playwright-parallel.json and
playwright-serial.json (scripts/run_playwright.py). scripts/verify.py calls summarize()
after every run: it writes timings.json and timings.md and appends the same summary to verification.log.
``python scripts/verify_report.py <run-dir>`` prints the summary of an earlier run.
"""
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

PYTEST_REPORTS = ('pytest-parallel.xml', 'pytest-serial.xml')
PLAYWRIGHT_REPORTS = ('playwright-parallel.json', 'playwright-serial.json')
NETWORK_CHANGED = b'net::ERR_NETWORK_CHANGED'


def vitest_reports(directory):
    """vitest.xml, or vitest-1.xml ... vitest-N.xml in run order when ci.sh ran vitest N times (--repeat, --burn-in)."""
    directory = Path(directory)
    runs = sorted((int(match[1]), path) for path in directory.glob('vitest-*.xml')
                  if (match := re.fullmatch(r'vitest-(\d+)\.xml', path.name)))
    single = [directory / 'vitest.xml'] if (directory / 'vitest.xml').exists() else []
    return single + [path for _, path in runs]


def network_changes(directory):
    """The output directories (browser/<pass>/<test>) of failed Playwright tests whose trace shows Chromium dropping
    requests with net::ERR_NETWORK_CHANGED: the host's network configuration changed during the test, so a page load or
    request failed for a reason outside the code under test. Traces are kept only for failed tests (playwright.config.ts)."""
    directory, found = Path(directory), []
    for trace in sorted((directory / 'browser').glob('*/*/trace.zip')):
        try:
            with zipfile.ZipFile(trace) as archive:
                if any(NETWORK_CHANGED in archive.read(name) for name in archive.namelist()
                       if name.endswith(('.network', '.trace'))):
                    found.append(trace.parent.relative_to(directory).as_posix())
        except (OSError, zipfile.BadZipFile):
            continue
    return found


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
    """(counts summed over every vitest run or None when vitest did not run, [(seconds, test, file)] slowest first).
    With --fast, the tests left out by --tags-filter=!slow count as skipped."""
    reports = vitest_reports(directory)
    if not reports:
        return None, []
    counts, cases = {'passed': 0, 'failed': 0, 'errors': 0, 'skipped': 0}, []
    for suite in (suite for path in reports for suite in ET.parse(path).getroot().iter('testsuite')):
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


def failed_tests(directory):
    """Every failed or errored test, as '<suite> <pass>: <test>', read from the same reports as the counts. A flaky
    Playwright test (failed, then passed on a retry) is listed too, marked flaky."""
    directory, failed = Path(directory), []
    reports = [(directory / report, 'pytest ' + report.split('-')[1].split('.')[0], '::') for report in PYTEST_REPORTS]
    reports += [(path, 'vitest' if path.name == 'vitest.xml' else f"vitest run {path.stem.split('-')[1]}", ' › ')
                for path in vitest_reports(directory)]
    for path, suite, separator in reports:
        if not path.exists():
            continue
        for case in ET.parse(path).getroot().iter('testcase'):
            if case.find('failure') is not None or case.find('error') is not None:
                failed.append(f"{suite}: {case.get('classname')}{separator}{case.get('name')}")
    for report in PLAYWRIGHT_REPORTS:
        path = directory / report
        if not path.exists():
            continue
        group = report.split('-')[1].split('.')[0]
        suites = list(json.loads(path.read_text()).get('suites', []))
        while suites:
            suite = suites.pop()
            suites.extend(suite.get('suites', []))
            for spec in suite.get('specs', []):
                for test in spec.get('tests', []):
                    if test.get('status') in ('unexpected', 'flaky'):
                        worker = ','.join(str(result.get('parallelIndex')) for result in test.get('results', []))
                        failed.append(f"playwright {group}: {spec.get('file')}:{spec.get('line')} › {spec.get('title')}"
                                      f" ({test.get('status')}, worker {worker})")
    return sorted(failed)


def markdown(summary):
    lines = []
    if summary.get('failed'):
        lines += ['Failed tests:', *(f'- {name}' for name in summary['failed']), '']
    lines += ['| Phase | Seconds |', '| --- | ---: |']
    lines += [f'| {name} | {seconds} |' for name, seconds in summary['phases'].items()]
    for suite in ('pytest', 'vitest', 'playwright'):
        counts = summary[suite]['counts']
        if counts is None:
            continue
        runs = summary[suite].get('runs', 1)
        scope = (' (one run)' if runs == 1 else f' ({runs} runs)') if suite == 'vitest' else ' (both passes)'
        lines += ['', f'{suite}: ' + ', '.join(f'{value} {key}' for key, value in counts.items()) + scope, '',
                  f'| Slowest {suite} tests | Pass | Seconds |', '| --- | --- | ---: |']
        lines += [f'| {name} | {group} | {seconds:.1f} |' for seconds, name, group in summary[suite]['slowest']]
    return '\n'.join(lines) + '\n'


def collect(directory):
    pytest_counts, pytest_cases = pytest_results(directory)
    vitest_counts, vitest_cases = vitest_results(directory)
    playwright_counts, playwright_cases = playwright_results(directory)
    return {'phases': phases(directory), 'failed': failed_tests(directory),
            'pytest': {'counts': pytest_counts, 'slowest': pytest_cases[:30]},
            'vitest': {'counts': vitest_counts, 'slowest': vitest_cases[:20], 'runs': len(vitest_reports(directory))},
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
    return {'phases': summary['phases'], 'failed': summary['failed'], 'pytest': summary['pytest']['counts'],
            'vitest': summary['vitest']['counts'], 'playwright': summary['playwright']['counts']}


if __name__ == '__main__':
    print(markdown(collect(sys.argv[1])), end='')
