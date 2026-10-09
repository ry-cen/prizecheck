"""Initialize a NEW empty public object store; never use to recover lost data."""
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from app.public_projection import public_projection_store, public_record_store

with public_projection_store().writer(initialize=True):
    pass
public_record_store().initialize(deadline=time.monotonic() + 5)
print('Public projection and shared records initialized')
