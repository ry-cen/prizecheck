"""Generate Holding request and response types from the API's OpenAPI schema."""
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
    if value.get("type") == "array":
        return f"{ts_type(value['items'])}[]"
    if value.get("type") == "object":
        return "Record<string, unknown>"
    return {"string": "string", "integer": "number", "number": "number", "null": "null", "boolean": "boolean"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
names = ("HoldingView", "LeafHoldings", "AddResult", "AddHolding")
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_holdings_client.py. Do not edit."]
for name in names:
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export class HoldingError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new HoldingError(response.status, payload?.detail?.code ?? 'HOLDING_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export type LeafFilters = { name?: string; set_id?: string; collector_number?: string; sort?: 'name' | 'quantity' };
export const getLeafHoldings = (locationId: string, cursor?: string, filters: LeafFilters = {}) => {
  const query = new URLSearchParams({ ...filters, ...(cursor ? { cursor } : {}) });
  return request<LeafHoldings>(`/api/holdings/${encodeURIComponent(locationId)}?${query}`);
};
export const addHolding = (body: AddHolding) => request<AddResult>('/api/holdings', 'POST', body);
""")
content = "\n".join(lines)
target = root / "web/src/holdings_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Holdings client is stale")
else:
    target.write_text(content)
