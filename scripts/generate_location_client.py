"""Generate the Location command client from FastAPI's OpenAPI models."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402

schema = app.openapi()
names = ("TreeNode", "TreeResponse", "LocationCommandResult", "CreateLocation", "EditLocation", "DeleteLocation", "DeleteLocationResult")


def ts_type(value):
    if "$ref" in value:
        return value["$ref"].split("/")[-1]
    if "anyOf" in value:
        return " | ".join(ts_type(part) for part in value["anyOf"])
    if value.get("type") == "array":
        return f"{ts_type(value['items'])}[]"
    return {"string": "string", "integer": "number", "number": "number", "null": "null", "boolean": "boolean"}[value["type"]]


lines = ["// Generated from FastAPI OpenAPI by scripts/generate_location_client.py. Do not edit."]
for name in names:
    definition = schema["components"]["schemas"][name]
    fields = [f"{key}{'' if key in definition.get('required', []) else '?'}: {ts_type(value)}" for key, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export class LocationError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function locationRequest<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new LocationError(response.status, payload?.detail?.code ?? 'LOCATION_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export const getLocationTree = () => locationRequest<TreeResponse>('/api/location-tree');
export const createLocation = (body: CreateLocation) => locationRequest<LocationCommandResult>('/api/location-tree', 'POST', body);
export const editLocation = (id: string, body: EditLocation) => locationRequest<LocationCommandResult>(`/api/location-tree/${id}`, 'PATCH', body);
export const deleteLocation = (id: string, body: DeleteLocation) => locationRequest<DeleteLocationResult>(`/api/location-tree/${id}`, 'DELETE', body);
""")
content = "\n".join(lines)
target = root / "web/src/location_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Location client is stale")
else:
    target.write_text(content)
