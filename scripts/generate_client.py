"""Small deterministic OpenAPI-to-TypeScript generator for this initial API contract."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402

schema = app.openapi()
assert "/api/locations" in schema["paths"]
assert "/api/health" in schema["paths"]


def typescript_type(value):
    if "$ref" in value:
        return value["$ref"].split("/")[-1]
    if "anyOf" in value:
        return " | ".join(typescript_type(part) for part in value["anyOf"])
    if value.get("type") == "array":
        return f"{typescript_type(value['items'])}[]"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean", "null": "null"}[value["type"]]


lines = ["// Generated from FastAPI OpenAPI by scripts/generate_client.py. Do not edit."]
for name in ("Location", "LocationsResponse", "HealthResponse"):
    definition = schema["components"]["schemas"][name]
    fields = []
    for key, value in definition["properties"].items():
        optional = "" if key in definition.get("required", []) else "?"
        fields.append(f"{key}{optional}: {typescript_type(value)}")
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
content = "\n".join(lines) + "\n" + """export async function getLocations(): Promise<LocationsResponse> {
  const response = await fetch('/api/locations', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Locations request failed (${response.status})`);
  return response.json() as Promise<LocationsResponse>;
}
"""
target = root / "web/src/generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated TypeScript client is stale")
else:
    target.write_text(content)
