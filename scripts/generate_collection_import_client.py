"""Generate Collection Import request and response types from the API's OpenAPI schema."""
import json

import client_generator as gen

TARGET = "web/src/collection_import_generated.ts"
NAMES = ("CollectionImportCounts", "CollectionImportSummary", "CollectionImportSource", "CollectionImportLeftOut",
         "CollectionImportGroup", "CollectionImportCard",
         "CollectionImportEdition", "CollectionImportRow", "CollectionImportRowsPage", "CollectionImportPick",
         "CollectionImportChange",
         "ChangeCollectionImport", "CollectionImportChangeResult", "CollectionImportChanges", "SaveCollectionImport",
         "CollectionImportSaveResult")
# ROWS_NEED_YOU names how many rows still need the collector.
ERROR = gen.error_class(
    "CollectionImportError", "public count: string | null = null",
    constructor_doc="/** How many rows still need the collector, for ROWS_NEED_YOU. */")
FAILURE = '''  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.detail;
    throw new CollectionImportError(response.status,
      typeof detail?.code === 'string' ? detail.code : 'COLLECTION_IMPORT_REQUEST_FAILED',
      typeof detail?.count === 'string' ? detail.count : null);
  }'''

BODY = """
%(error)s
async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
%(failure)s
  return response.json() as Promise<T>;
}
/** Uploads the file's bytes as the body; the draft lands in the Storage Leaf `locationId`. */
export const startCollectionImport = (locationId: string, file: Blob) =>
  send<CollectionImportSummary>(`/api/collection-imports?${new URLSearchParams({ location_id: locationId })}`,
    { method: 'POST', headers: { 'content-type': 'text/csv' }, body: file });
/** The start body for pasted text (#234): JSON, as startCollectionImportPaste sends it. Its size counts against the
 * start route's 5 MiB, escapes included. */
export const collectionImportPasteBody = (text: string) => JSON.stringify({ text });
/** Starts an import from pasted text; the draft lands in the Storage Leaf `locationId`. */
export const startCollectionImportPaste = (locationId: string, text: string) =>
  send<CollectionImportSummary>(`/api/collection-imports?${new URLSearchParams({ location_id: locationId })}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: collectionImportPasteBody(text) });
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
/** The skipped rows as a CSV file in the file's own columns (a pasted list's: its lines, as text), for a download
 * link. */
export const collectionImportSkippedHref = (importId: string) =>
  `/api/collection-imports/${encodeURIComponent(importId)}/skipped.csv`;
/** The rows left out (watchlist, sealed, other games, not in English) as a CSV file in the file's own columns (a pasted
 * list's: its lines, as text). */
export const collectionImportLeftOutHref = (importId: string) =>
  `/api/collection-imports/${encodeURIComponent(importId)}/left-out.csv`;
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    # The rows route's filters, which a change's `filter` selects by too (collection_import.RowFilter).
    filters = next(part["enum"] for part in schemas["CollectionImportChange"]["properties"]["filter"]["anyOf"]
                   if "enum" in part)
    lines = [gen.header("generate_collection_import_client"), *gen.DOUBLE.aliases(schemas, NAMES),
             f"export type CollectionImportRowFilter = {' | '.join(json.dumps(name) for name in filters)};",
             BODY % {"error": ERROR, "failure": FAILURE}]
    return gen.assemble(lines)


if __name__ == "__main__":
    gen.main(__name__)
