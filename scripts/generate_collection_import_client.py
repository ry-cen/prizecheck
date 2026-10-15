"""Generate Collection Import request and response types from the API's OpenAPI schema."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402


def ts_type(value):
    if "$ref" in value:
        return value["$ref"].split("/")[-1]
    if "enum" in value:
        return " | ".join(json.dumps(option) for option in value["enum"])
    if "anyOf" in value:
        return " | ".join(ts_type(part) for part in value["anyOf"])
    if value.get("type") == "array":
        return f"{ts_type(value['items'])}[]"
    if value.get("type") == "object":
        return "Record<string, unknown>"
    return {"string": "string", "integer": "number", "number": "number", "null": "null", "boolean": "boolean"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
names = ("CollectionImportCounts", "CollectionImportSummary", "CollectionImportSource", "CollectionImportLeftOut",
         "CollectionImportGroup", "CollectionImportCard",
         "CollectionImportEdition", "CollectionImportRow", "CollectionImportRowsPage", "CollectionImportPick",
         "CollectionImportChange",
         "ChangeCollectionImport", "CollectionImportChangeResult", "CollectionImportChanges", "SaveCollectionImport",
         "CollectionImportSaveResult")
# The rows route's filters, which a change's `filter` selects by too (collection_import.RowFilter).
filters = next(part["enum"] for part in schema["CollectionImportChange"]["properties"]["filter"]["anyOf"]
               if "enum" in part)
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_collection_import_client.py. Do not edit."]
for name in names:
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append(f"export type CollectionImportRowFilter = {' | '.join(json.dumps(name) for name in filters)};")
lines.append("""
export class CollectionImportError extends Error {
  /** How many rows still need the collector, for ROWS_NEED_YOU. */
  constructor(public status: number, public code: string, public count: string | null = null) { super(code); }
}
async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.detail;
    throw new CollectionImportError(response.status,
      typeof detail?.code === 'string' ? detail.code : 'COLLECTION_IMPORT_REQUEST_FAILED',
      typeof detail?.count === 'string' ? detail.count : null);
  }
  return response.json() as Promise<T>;
}
/** Uploads the file's bytes as the body; the draft lands in the Storage Leaf `locationId`. */
export const startCollectionImport = (locationId: string, file: Blob) =>
  send<CollectionImportSummary>(`/api/collection-imports?${new URLSearchParams({ location_id: locationId })}`,
    { method: 'POST', headers: { 'content-type': 'text/csv' }, body: file });
export const getCurrentCollectionImport = () => send<CollectionImportSummary>('/api/collection-imports/current');
export const getCollectionImportRows = (importId: string, filter: CollectionImportRowFilter, cursor?: string | null) => {
  const query = new URLSearchParams({ filter, ...(cursor ? { cursor } : {}) });
  return send<CollectionImportRowsPage>(`/api/collection-imports/${encodeURIComponent(importId)}/rows?${query}`);
};
/** Applies `body.changes` in order at `body.draft_revision`; 409 STALE_DRAFT when the draft has moved on. */
export const changeCollectionImport = (importId: string, body: ChangeCollectionImport) =>
  send<CollectionImportChanges>(`/api/collection-imports/${encodeURIComponent(importId)}/changes`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const saveCollectionImport = (importId: string, body: SaveCollectionImport) =>
  send<CollectionImportSaveResult>(`/api/collection-imports/${encodeURIComponent(importId)}/save`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** The skipped rows as a CSV file in the file's own columns, for a download link. */
export const collectionImportSkippedHref = (importId: string) =>
  `/api/collection-imports/${encodeURIComponent(importId)}/skipped.csv`;
/** The rows left out (watchlist, sealed, other games, not in English) as a CSV file in the file's own columns. */
export const collectionImportLeftOutHref = (importId: string) =>
  `/api/collection-imports/${encodeURIComponent(importId)}/left-out.csv`;
""")
content = "\n".join(lines)
target = root / "web/src/collection_import_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Collection Import client is stale")
else:
    target.write_text(content)
