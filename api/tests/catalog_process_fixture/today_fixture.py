"""CI-only check date; loaded by this directory's ``sitecustomize`` when it is on PYTHONPATH.

No production configuration enables this, and the API image copies only ``api/app``, so this file never ships. A Deck's
format check and the format standings both take their date from a module-level ``today()`` (``app.deck_format_checks``
and ``app.format_standing``). With ``$CATALOG_PROCESS_FIXTURE_DIR`` set, those two functions are replaced when their
modules are imported by one that reads ``$CATALOG_PROCESS_FIXTURE_DIR/today`` (an ISO date; a browser spec writes the
file) on every call and answers the real date when the file is missing. A bad date fails the call loudly.

``sitecustomize`` imports ``app.catalog`` before this fixture is installed, and that already imports
``app.format_standing``, so a target module that is already loaded is patched in place; the others are patched as they
are imported.

Importing this module has no side effects; ``install()`` is called once from ``sitecustomize``.
"""
from datetime import date
import os

TODAY_FILE = 'today'


def today_from(directory, real):
    def today():
        try:
            with open(os.path.join(directory, TODAY_FILE)) as handle:
                return date.fromisoformat(handle.read().strip())
        except FileNotFoundError:
            return real()
    return today


def patch_module(directory):
    def patch(module):
        if not callable(getattr(module, 'today', None)):
            raise RuntimeError(f'{module.__name__} must define today')
        module.today = today_from(directory, module.today)
    return patch


def install(environ=None):
    environ = os.environ if environ is None else environ
    directory = environ.get('CATALOG_PROCESS_FIXTURE_DIR')
    if not directory:
        return
    import sys
    from price_fixture import _PatchOnImport
    patch = patch_module(directory)
    targets = {'app.deck_format_checks': patch, 'app.format_standing': patch}
    for name in [name for name in targets if name in sys.modules]:
        patch(sys.modules[name])
        del targets[name]
    sys.meta_path.insert(0, _PatchOnImport(targets, {}))
