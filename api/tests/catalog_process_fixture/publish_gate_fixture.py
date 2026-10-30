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

Discover (app redesign #182) lists only snapshots that are legal in their Target Format today, so those tests' Listed
snapshots would never show. They exempt each snapshot they list by its token (``exempt_listing``, which
``test_discovery.visibility`` calls): Discover then lists it whatever its result or whether the records store could be
read, and still reads its cost from the store. A token is exempt once ``exempt_listing(token)`` ran in this process, or
while a file named after it exists in ``discover-exempt/`` under the same directory (``exempt_listing`` writes it when
that directory is set, so the Python helpers browser specs run reach the stack's API process;
``web/tests/support/publish-gate.ts`` and the auth suite write it directly). Discover's own tests
(``test_discover_listing.py``, ``discover-page.spec.ts``) exempt nothing.
"""
import os
from pathlib import Path

_exempt: set[str] = set()
_installed = False
_listing_exempt: set[str] = set()
_discovery_installed = False


EXEMPT_DIRECTORY = 'publish-gate-exempt'
LISTING_DIRECTORY = 'discover-exempt'


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


def _listing_marked(token) -> bool:
    root = _root()
    return bool(root) and (Path(root) / LISTING_DIRECTORY / str(token)).is_file()


def _wrap_discovery(discovery):
    """Replace ``discovery.target_status`` with one that answers ``legal`` for exempt tokens. The route looks the name up
    when it runs, so the replacement takes effect for every later Discover read."""
    global _discovery_installed
    if _discovery_installed:
        return
    real = discovery.target_status

    def target_status(token, active, facts, on):
        if token in _listing_exempt or _listing_marked(token):
            return 'legal'
        return real(token, active, facts, on)

    discovery.target_status = target_status
    _discovery_installed = True


def install():
    """Wrap the gate in this process now (pytest and Python helpers, where the app is imported anyway)."""
    from app.games.pokemon.publications import publications
    _wrap(publications)


def install_on_import():
    """Wrap the gate when ``app.publications`` is first imported, if ``PUBLISH_GATE_EXEMPT_DIR`` or
    ``CATALOG_PROCESS_FIXTURE_DIR`` is set (sitecustomize, in the browser stacks' and the auth suite's API processes). Importing nothing early keeps every other process started with this
    directory on PYTHONPATH (price runners, scripts) unchanged."""
    if not _root():
        return
    import sys
    from price_fixture import _PatchOnImport
    sys.meta_path.insert(0, _PatchOnImport({'app.games.pokemon.publications.publications': _wrap, 'app.games.pokemon.publications.discovery': _wrap_discovery}, {}))


def exempt(deck_id):
    """Let ``deck_id`` publish whatever its result, in this process."""
    install()
    _exempt.add(str(deck_id))


def exempt_listing(token):
    """Let Discover list the snapshot ``token`` whatever its Target Format result: in this process, and in the stack's
    API process when a fixture directory is set."""
    from app.games.pokemon.publications import discovery
    _wrap_discovery(discovery)
    _listing_exempt.add(str(token))
    root = _root()
    if root:
        directory = Path(root) / LISTING_DIRECTORY
        directory.mkdir(parents=True, exist_ok=True)
        (directory / str(token)).touch()
