"""CI-only publish gate exemptions for publishing tests written before ADR 0011.

Publishing needs a legal result in the Deck's Target Format (``publications.require_legal``). Tests of exports, cost,
discovery, snapshots and catalog references publish small Deck Lists that are not legal in any Format, and their
assertions depend on exactly those lines, so they exempt the Decks they publish instead of padding them to 60 cards. An
exempt Deck still gets its Target Format frozen in the snapshot; every other Deck meets the real gate, so the gate's own
tests (test_publish_gate.py, target-format.spec.ts) never exempt anything.

A Deck is exempt once ``exempt(deck_id)`` ran in this process (pytest, and the Python helpers browser specs run), or while
a file named after its id exists in ``publish-gate-exempt/`` under ``$PUBLISH_GATE_EXEMPT_DIR`` or, failing that,
``$CATALOG_PROCESS_FIXTURE_DIR`` (the API processes of the browser stacks and of the auth suite, which load this through
sitecustomize; ``web/tests/support/publish-gate.ts`` and ``auth/tests/published-cost.test.ts`` write the file). Each stack
has its own CATALOG_PROCESS_FIXTURE_DIR (scripts/verify_resources.py), which its Playwright worker sees too.
PUBLISH_GATE_EXEMPT_DIR exists for suites that must not set CATALOG_PROCESS_FIXTURE_DIR, because that variable also
swaps the catalog source; it enables nothing but this exemption. No production configuration loads this.
"""
import os
from pathlib import Path

_exempt: set[str] = set()
_installed = False


EXEMPT_DIRECTORY = 'publish-gate-exempt'


def _root():
    return os.environ.get('PUBLISH_GATE_EXEMPT_DIR') or os.environ.get('CATALOG_PROCESS_FIXTURE_DIR')


def _marked(deck_id) -> bool:
    root = _root()
    return bool(root) and (Path(root) / EXEMPT_DIRECTORY / str(deck_id)).is_file()


def _wrap(publications):
    """Replace ``publications.require_legal`` with one that lets exempt Decks through. ``mutate`` looks the name up when it
    runs, so the replacement takes effect for every later publish and republish."""
    global _installed
    if _installed:
        return
    real = publications.require_legal

    def require_legal(conn, owner, deck_id):
        if str(deck_id) in _exempt or _marked(deck_id):
            return conn.execute('SELECT target_format FROM deck_list WHERE owner_id=%s AND deck_id=%s',
                                (owner, deck_id)).fetchone()['target_format']
        return real(conn, owner, deck_id)

    publications.require_legal = require_legal
    _installed = True


def install():
    """Wrap the gate in this process now (pytest and Python helpers, where the app is imported anyway)."""
    from app import publications
    _wrap(publications)


def install_on_import():
    """Wrap the gate when ``app.publications`` is first imported, if ``PUBLISH_GATE_EXEMPT_DIR`` or
    ``CATALOG_PROCESS_FIXTURE_DIR`` is set (sitecustomize, in the browser stacks' and the auth suite's API processes). Importing nothing early keeps every other process started with this
    directory on PYTHONPATH (price runners, scripts) unchanged."""
    if not _root():
        return
    import sys
    from price_fixture import _PatchOnImport
    sys.meta_path.insert(0, _PatchOnImport({'app.publications': _wrap}, {}))


def exempt(deck_id):
    """Let ``deck_id`` publish whatever its result, in this process."""
    install()
    _exempt.add(str(deck_id))
