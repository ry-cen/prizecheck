"""CI-only source boundary; opt in by putting this directory on PYTHONPATH.

No production importer configuration enables this fixture. The gate path gives
browser tests time to observe the real detached child before releasing fetch.
"""
import os
from pathlib import Path
import time

if os.environ.get('CATALOG_PROCESS_FIXTURE_DIR'):
    import app.games.pokemon.catalog.catalog
    class FixtureSource(app.games.pokemon.catalog.catalog.TCGdexSource):
        def enumerate(self):
            gate = Path(os.environ['CATALOG_PROCESS_FIXTURE_DIR']) / 'release'
            deadline = time.monotonic()+30
            while not gate.exists() and time.monotonic()<deadline:
                time.sleep(.05)
            return {'process-1'}
        def fetch(self, source_id):
            return {'id':source_id,'name':'Pikachu','localId':'1','set':{'id':'fixture','name':'Fixture Set'},'category':'Pokemon','variants':{'normal':True}}
    app.games.pokemon.catalog.catalog.TCGdexSource = FixtureSource

import price_fixture
price_fixture.install()

import art_fixture
art_fixture.install()

import publish_gate_fixture
publish_gate_fixture.install_on_import()

import today_fixture
today_fixture.install()
