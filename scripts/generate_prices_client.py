"""Generate the Price client module from the API OpenAPI schema."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402,F401
from app.prices import router  # noqa: E402

# The router is the source of truth; the owning ticket extends the body below.
assert router is not None
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_prices_client.py. Do not edit.", "export {};"]
content = "\n".join(lines) + "\n"
target = root / "web/src/prices_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Price client is stale")
else:
    target.write_text(content)
