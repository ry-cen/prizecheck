"""Generate Move request and response types from the API OpenAPI schema."""
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
    return {"string": "string", "integer": "number", "number": "number", "null": "null"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
names = ("MoveItem", "MoveManifest", "MoveResult")
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_moves_client.py. Do not edit."]
for name in names:
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export type MoveErrorDetail = { source_id?: string; edition_id?: string; destination_id?: string };
export class MoveError extends Error {
  constructor(public status: number, public code: string, public detail: MoveErrorDetail = {}) { super(code); }
}
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const failure = payload?.detail;
    const detail: MoveErrorDetail = failure && typeof failure === 'object' && !Array.isArray(failure)
      ? { source_id: failure.source_id, edition_id: failure.edition_id, destination_id: failure.destination_id } : {};
    throw new MoveError(response.status, failure?.code ?? 'MOVE_REQUEST_FAILED', detail);
  }
  return response.json() as Promise<T>;
}
export const startMove = (source_id?: string) => request<MoveManifest>('/api/moves/manifests', 'POST', source_id ? { source_id } : {});
export const stageMove = (id: string, items: MoveItem[]) => request<MoveManifest>(`/api/moves/manifests/${encodeURIComponent(id)}/items`, 'PUT', { items });
// put_away marks the deck builder's Put away, whose Undo returns the copies to the Deck as surplus (migration 047).
export const commitMove = (id: string, destination_id: string, idempotency_key: string, put_away = false) => request<MoveResult>(`/api/moves/manifests/${encodeURIComponent(id)}/commit`, 'POST', put_away ? { destination_id, idempotency_key, put_away } : { destination_id, idempotency_key });
""")
content = "\n".join(lines)
target = root / "web/src/moves_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Move client is stale")
else:
    target.write_text(content)
