"""Actual pytest collection evidence and a last-line serial guard for admitted API work."""
import json
import os
from pathlib import Path

import pytest

_serial = []


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_collection_modifyitems(items):
    # Retain cases deselected by -m/-k, and also see marks added by other collection hooks.
    before = [item.nodeid for item in items if item.get_closest_marker('serial') is not None]
    yield
    _serial[:] = sorted(set(before + [item.nodeid for item in items if item.get_closest_marker('serial') is not None]))


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_collection_finish(session):
    yield
    destination = os.environ.get('VERIFY_ADMISSION_COLLECTION')
    if destination:
        serial = sorted(set(_serial + [item.nodeid for item in session.items if item.get_closest_marker('serial') is not None]))
        # Only the parent runner can attest a successful collection exit, including late hook failures.
        report = dict(version=1, complete=False, nodeids=[item.nodeid for item in session.items], serial=serial)
        Path(destination).write_text(json.dumps(report, indent=2))


@pytest.hookimpl(tryfirst=True)
def pytest_runtestloop(session):
    serial = _serial or [item.nodeid for item in session.items if item.get_closest_marker('serial') is not None]
    if not session.config.option.collectonly and os.environ.get('VERIFY_ADMISSION_MODE') == 'api' and serial:
        raise pytest.UsageError('Serial cases appeared after admission; no tests may run. Reclassify exclusively.')
