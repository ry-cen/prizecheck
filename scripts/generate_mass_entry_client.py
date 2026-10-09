"""Generate the Mass entry client module from the API OpenAPI schema."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402,F401
from app.deck_mass_entry import router  # noqa: E402

# The router is the source of truth; the owning ticket extends the body below.
assert router is not None
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_mass_entry_client.py. Do not edit.", "export {};"]
content = "\n".join(lines) + "\n"
target = root / "web/src/mass_entry_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Mass entry client is stale")
else:
    target.write_text(content)
