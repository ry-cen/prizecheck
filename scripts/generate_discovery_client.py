"""Generate Discovery response types from the API OpenAPI schema."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402


def ts_type(value):
    if "$ref" in value:
        return value["$ref"].split("/")[-1]
    if "anyOf" in value:
        return " | ".join(ts_type(part) for part in value["anyOf"])
    if "enum" in value:
        return " | ".join(f"'{item}'" for item in value["enum"])
    if "const" in value:
        return f"'{value['const']}'"
    if value.get("type") == "array":
        return f"{ts_type(value['items'])}[]"
    return {"string": "string", "integer": "number", "number": "number", "null": "null"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
names = ("PublicCheckSummary", "DiscoverCost", "PublicDeckSummary", "DiscoveryPage")
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_discovery_client.py. Do not edit."]
for name in names:
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
/** A Target Format to filter by; absent means every Format. */
export type DiscoverFormat = 'standard' | 'expanded' | 'glc';

export class DiscoveryError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', signal,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new DiscoveryError(response.status, payload?.detail?.code ?? 'DISCOVERY_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export const discoverDecks = (q = '', cursor?: string, format?: DiscoverFormat | null, signal?: AbortSignal) => {
  const params = new URLSearchParams({ q }); if (cursor) params.set('cursor', cursor); if (format) params.set('format', format);
  return request<DiscoveryPage>('/api/public/discovery?' + params, 'GET', undefined, signal);
};
""")
content = "\n".join(lines)
target = root / "web/src/discovery_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Discovery client is stale")
else:
    target.write_text(content)
