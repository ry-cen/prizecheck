"""Generate the Mass entry client module from the API OpenAPI schema."""
import json
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
        return " | ".join(json.dumps(option) for option in value["enum"])
    if value.get("type") == "array":
        return f"({ts_type(value['items'])})[]"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean", "null": "null"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_mass_entry_client.py. Do not edit."]
for name in ("MassEntryLineView", "MassEntryView", "PublishedMassEntryView"):
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export class MassEntryError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const base = (id: string) => `/api/decks/${encodeURIComponent(id)}/exports/tcgplayer`;
export async function getMassEntryExport(id: string, signal?: AbortSignal): Promise<MassEntryView> {
  const response = await fetch(base(id), { credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new MassEntryError(response.status, payload?.detail?.code ?? 'MASS_ENTRY_REQUEST_FAILED');
  }
  return response.json() as Promise<MassEntryView>;
}
export const massEntryDownloadHref = (id: string, ownerRevision: number) => `${base(id)}.txt?owner_revision=${ownerRevision}`;
export const MASS_ENTRY_DOWNLOAD_NAME = 'tcgplayer-mass-entry.txt';
// A Published Deck's Mass Entry export: only the token and the snapshot version are sent, and no cookie.
const publishedBase = (token: string, version: number) => `/api/public/decks/${encodeURIComponent(token)}/versions/${version}/exports/tcgplayer`;
export async function getPublishedMassEntry(token: string, version: number, signal?: AbortSignal): Promise<PublishedMassEntryView> {
  const response = await fetch(publishedBase(token, version), { credentials: 'omit', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new MassEntryError(response.status, payload?.detail?.code ?? 'MASS_ENTRY_REQUEST_FAILED');
  }
  return response.json() as Promise<PublishedMassEntryView>;
}
export const publishedMassEntryDownloadHref = (token: string, version: number) => `${publishedBase(token, version)}.txt`;
""")
content = "\n".join(lines)
target = root / "web/src/mass_entry_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Mass entry client is stale")
else:
    target.write_text(content)
