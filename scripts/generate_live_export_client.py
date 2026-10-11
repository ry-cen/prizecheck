"""Generate the Live export client module from the API OpenAPI schema."""
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
        return " | ".join(f'"{item}"' for item in value["enum"])
    if value.get("type") == "array":
        return f"{ts_type(value['items'])}[]"
    if value.get("type") == "object":
        return "Record<string, unknown>"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean", "null": "null"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_live_export_client.py. Do not edit."]
for name in ("LiveBlockerView", "LiveExportView", "PublishedLiveBlockerView", "PublishedLiveExportView"):
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export class LiveExportError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export async function getLiveExport(deckId: string): Promise<LiveExportView> {
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/exports/live`, { credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new LiveExportError(response.status, payload?.detail?.code ?? 'LIVE_EXPORT_FAILED');
  }
  return response.json() as Promise<LiveExportView>;
}
export const liveExportDownloadHref = (deckId: string, ownerRevision: number, deckListRevision?: number | null) =>
  `/api/decks/${encodeURIComponent(deckId)}/exports/live.txt?owner_revision=${ownerRevision}${deckListRevision == null ? '' : `&deck_list_revision=${deckListRevision}`}`;

// A Published Deck's Live export: only the token and the snapshot version are sent, and no cookie.
export async function getPublishedLiveExport(token: string, version: number, signal?: AbortSignal): Promise<PublishedLiveExportView> {
  const response = await fetch(`/api/public/decks/${encodeURIComponent(token)}/versions/${version}/exports/live`, { credentials: 'omit', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new LiveExportError(response.status, payload?.detail?.code ?? 'LIVE_EXPORT_FAILED');
  }
  return response.json() as Promise<PublishedLiveExportView>;
}
export const publishedLiveExportDownloadHref = (token: string, version: number) =>
  `/api/public/decks/${encodeURIComponent(token)}/versions/${version}/exports/live.txt`;
""")
content = "\n".join(lines)
target = root / "web/src/live_export_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Live export client is stale")
else:
    target.write_text(content)
