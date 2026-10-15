// Generated from FastAPI OpenAPI by scripts/generate_collection_import_client.py. Do not edit.
export type CollectionImportCounts = { rows: number; needs_you: number; ready: number; finish_unknown: number; by_name: number; skipped: number };
export type CollectionImportSummary = { id: string; draft_revision: number; location_id: string; location_name: string | null; counts: CollectionImportCounts; cards_to_add: string; expires_at: string };
export type CollectionImportSource = { quantity: string; name: string; set_name: string; number: string; finish: string };
export type CollectionImportCard = { printing_id: string; name: string; set_name: string; collector_number: string };
export type CollectionImportEdition = { edition_id: string; descriptor: Record<string, unknown> };
export type CollectionImportRow = { row_number: number; status: "matched" | "finish_unknown" | "by_name" | "ambiguous" | "not_found" | "unreadable"; needs_you: boolean; quantity: string | null; source: CollectionImportSource; skipped: boolean; card: CollectionImportCard | null; edition: CollectionImportEdition | null; editions: CollectionImportEdition[]; candidates: CollectionImportCard[]; picked: boolean; by_name: boolean };
export type CollectionImportRowsPage = { rows: CollectionImportRow[]; next_cursor: string | null; draft_revision: number };
export type CollectionImportPick = { printing_id?: string | null; edition_id?: string | null };
export type CollectionImportChange = { rows?: number[] | null; filter?: "needs" | "finish" | "name" | "all" | "skipped" | null; pick?: CollectionImportPick | null; finish?: Record<string, unknown> | null; skip?: boolean; restore?: boolean };
export type ChangeCollectionImport = { draft_revision: number; changes: CollectionImportChange[] };
export type CollectionImportChangeResult = { applied: number; not_applied: number[] };
export type CollectionImportChanges = { summary: CollectionImportSummary; results: CollectionImportChangeResult[] };
export type SaveCollectionImport = { draft_revision: number; idempotency_key: string };
export type CollectionImportSaveResult = { import_id: string; location_id: string; edition_count: number; copy_count: string; owner_revision: number };
export type CollectionImportRowFilter = "needs" | "finish" | "name" | "all" | "skipped";

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
