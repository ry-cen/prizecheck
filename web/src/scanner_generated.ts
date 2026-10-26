// Generated from FastAPI OpenAPI by scripts/generate_scanner_client.py. Do not edit.
import type { PrintingView } from './generated';
export type ScannerManifestCards = { key: string; url: string; bytes: number };
export type ScannerManifestFingerprints = { sha256: string; url: string; bytes: number; count: number; dim: number };
export type ScannerManifest = { format: 1; model: string; catalog_revision: number; cards: ScannerManifestCards; fingerprints: ScannerManifestFingerprints | null };
export type ScannerPrintingsRequest = { printing_ids: string[] };
export type ScannerPrintingsResponse = { catalog_revision: number; printings: ScannerPrinting[]; missing: string[] };
export type ScanSaveItem = { edition_id: string; quantity: string };
export type ScanSave = { location_id: string; idempotency_key: string; items: ScanSaveItem[] };
export type ScanSaveResult = { location_id: string; edition_count: number; copy_count: string; owner_revision: number };
export type ScannerPrinting = PrintingView & { default_edition_id: string | null };

/** A failed scanner request. `code` is the API's error code (CARDS_NOT_CURRENT, FINGERPRINTS_NOT_FOUND,
 * CATALOG_UNAVAILABLE) or SCANNER_REQUEST_FAILED when the response carried none. */
export class ScannerError extends Error {
  constructor(public status: number, public code: string, public detail: Record<string, unknown> = {}) { super(code); }
}
/** One Edition that EDITIONS_CHANGED names; `printing_id` is null for an Edition the catalog never had. */
export type ScanSaveChangedEdition = { edition_id: string; printing_id: string | null };
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.detail;
    throw new ScannerError(response.status, typeof detail?.code === 'string' ? detail.code : 'SCANNER_REQUEST_FAILED',
      typeof detail === 'object' && detail !== null && !Array.isArray(detail) ? detail : {});
  }
  return response;
}
/** Which index to use for `model` (at most 64 characters); `fingerprints` is null when none is built for it. */
export const getScannerManifest = async (model: string): Promise<ScannerManifest> =>
  (await request(`/api/scanner/manifest?${new URLSearchParams({ model })}`)).json();
/** The number table or the fingerprint file at a manifest's `url`, as the stream the device verifies and caches.
 * The number table is gzip with no Content-Encoding: inflate it with DecompressionStream; 404 CARDS_NOT_CURRENT means
 * read the manifest again. */
export const fetchScannerAsset = (url: string): Promise<Response> => request(url);
/** One to 100 Printing ids; ids that are tombstoned or unknown come back in `missing`. */
export const resolveScannerPrintings = async (printingIds: string[]): Promise<ScannerPrintingsResponse> =>
  (await request('/api/scanner/printings', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ printing_ids: printingIds } satisfies ScannerPrintingsRequest) })).json();
/** Adds a confirmed tray to one Storage Leaf in one step. Retry with the same `idempotency_key` after a network or 503
 * failure; the receipt lasts 30 days. Refusals are ScannerError codes: DESTINATION_CHANGED (409), EDITIONS_CHANGED (409,
 * `detail.editions` is a ScanSaveChangedEdition[]), IDEMPOTENCY_KEY_REUSED, REPLAY_OUTCOME_UNAVAILABLE (409),
 * QUANTITY_OVERFLOW, DUPLICATE_ADD_ITEM (422), INVENTORY_TEMPORARILY_UNAVAILABLE (503). */
export const saveScannerTray = async (save: ScanSave): Promise<ScanSaveResult> =>
  (await request('/api/scanner/save', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(save) })).json();
