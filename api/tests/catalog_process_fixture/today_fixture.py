"""CI-only check date; loaded by this directory's ``sitecustomize`` when it is on PYTHONPATH.

No production configuration enables this, and the API image copies only ``api/app``, so this file never ships. A Deck's
format check and the format standings both take their date from a module-level ``today()`` (``app.deck_format_checks``
and ``app.format_standing``). With ``$CATALOG_PROCESS_FIXTURE_DIR`` set, those two functions are replaced, at once
for a module ``sitecustomize`` has already imported (its ``app.catalog`` import loads ``app.format_standing``) and on
import for the other, by one that reads ``$CATALOG_PROCESS_FIXTURE_DIR/today`` (an ISO date; a browser spec writes the
file) on every call and answers the real date when the file is missing. A bad date fails the call loudly.

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
    patches = {}
    for name in ('app.deck_format_checks', 'app.format_standing'):
        if name in sys.modules:
            patch(sys.modules[name])
        else:
            patches[name] = patch
    sys.meta_path.insert(0, _PatchOnImport(patches, {}))
