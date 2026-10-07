"""Initialize a NEW empty public object store; never use to recover lost data."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from app.public_projection import public_projection_store

with public_projection_store().writer(initialize=True):
    pass
print('Public projection initialized')
