"""Generate the Catalog browse client module (app redesign #173) from the API OpenAPI schema."""
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
    if value.get("type") == "object":
        return "Record<string, unknown>"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean", "null": "null"}[value["type"]]


schema = app.openapi()
assert "/api/catalog/editions" in schema["paths"] and "/api/catalog/sets" in schema["paths"]
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_catalog_browse_client.py. Do not edit."]
for name in ("FormatStandingView", "EditionStandings", "BrowseEdition", "BrowseSearch", "BrowsePage", "CatalogSet",
             "CatalogSetList"):
    definition = schema["components"]["schemas"][name]
    # The routes always serialize every field, so every field is present even where the model has a default.
    fields = [f"{field}: {ts_type(value)}" for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export type BrowseKind = 'pokemon' | 'supporter' | 'item' | 'tool' | 'stadium' | 'energy';
export type BrowseFormat = 'standard' | 'expanded' | 'glc';
export type BrowseQuery = { q?: string; kind?: BrowseKind | null; format?: BrowseFormat | null; set_id?: string | null;
                            owned?: boolean; deck_id?: string | null; printing_id?: string | null };

/** A failed browse request. ``code`` is the API's error code: CATALOG_CHANGED or INVENTORY_CHANGED (409: start again
 * from page one), FORMAT_STANDING_BUSY (503: retry), DECK_NOT_FOUND (404), INVALID_CURSOR (400), or
 * CATALOG_BROWSE_FAILED when the response carried none. */
export class CatalogBrowseError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function browseRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new CatalogBrowseError(response.status, payload?.detail?.code ?? 'CATALOG_BROWSE_FAILED');
  }
  return response.json() as Promise<T>;
}

/** One page of Card Editions (60 rows). Pass the previous page's ``next_cursor`` with the same query for the next one. */
export function browseEditions(query: BrowseQuery, cursor?: string | null, signal?: AbortSignal): Promise<BrowsePage> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.kind) params.set('kind', query.kind);
  if (query.format) params.set('format', query.format);
  if (query.set_id) params.set('set_id', query.set_id);
  if (query.owned) params.set('owned', 'true');
  if (query.deck_id) params.set('deck_id', query.deck_id);
  if (query.printing_id) params.set('printing_id', query.printing_id);
  if (cursor) params.set('cursor', cursor);
  const suffix = params.toString() ? '?' + params.toString() : '';
  return browseRequest<BrowsePage>(`/api/catalog/editions${suffix}`, signal);
}

/** Every set in the active catalog, A-Z by name, for the set picker. */
export function getCatalogSets(signal?: AbortSignal): Promise<CatalogSetList> {
  return browseRequest<CatalogSetList>('/api/catalog/sets', signal);
}
""")
content = "\n".join(lines)
target = root / "web/src/catalog_browse_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated catalog browse client is stale")
else:
    target.write_text(content)
