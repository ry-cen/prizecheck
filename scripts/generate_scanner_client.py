"""Generate the card scanner's request and response types and fetch helpers from the API's OpenAPI schema (#310)."""
import client_generator as gen

TARGET = "web/src/scanner_generated.ts"
NAMES = ("ScannerManifestCards", "ScannerManifestFingerprints", "ScannerManifest", "ScannerPrintingsRequest",
         "ScannerPrintingsResponse", "ScanSaveItem", "ScanSave", "ScanSaveResult")
ERROR = gen.error_class(
    "ScannerError", "public detail: Record<string, unknown> = {}",
    doc="""/** A failed scanner request. `code` is the API's error code (CARDS_NOT_CURRENT, FINGERPRINTS_NOT_FOUND,
 * CATALOG_UNAVAILABLE) or SCANNER_REQUEST_FAILED when the response carried none. */""")

BODY = """
%(error)s
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
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    # ScannerPrinting is PrintingView plus the starting Edition, as the route's model subclasses it.
    extra = gen.DOUBLE.fields(schemas["ScannerPrinting"], all_required=True,
                              only=lambda field: field not in schemas["PrintingView"]["properties"])
    return gen.assemble([gen.header("generate_scanner_client"),
                         "import type { PrintingView } from './generated';",
                         *gen.DOUBLE.aliases(schemas, NAMES),
                         f"export type ScannerPrinting = PrintingView & {{ {'; '.join(extra)} }};",
                         BODY % {"error": ERROR}])


if __name__ == "__main__":
    gen.main(__name__)
