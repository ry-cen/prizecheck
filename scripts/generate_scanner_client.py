"""Generate the card scanner's request and response types and fetch helpers from the API's OpenAPI schema (#310)."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402


def ts_type(value):
    if "$ref" in value:
        return value["$ref"].split("/")[-1]
    if "const" in value:
        return json.dumps(value["const"])
    if "enum" in value:
        return " | ".join(json.dumps(option) for option in value["enum"])
    if "anyOf" in value:
        return " | ".join(ts_type(part) for part in value["anyOf"])
    if value.get("type") == "array":
        return f"{ts_type(value['items'])}[]"
    return {"string": "string", "integer": "number", "number": "number", "null": "null", "boolean": "boolean"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
names = ("ScannerManifestCards", "ScannerManifestFingerprints", "ScannerManifest", "ScannerPrintingsRequest",
         "ScannerPrintingsResponse", "ScanSaveItem", "ScanSave", "ScanSaveResult")
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_scanner_client.py. Do not edit.",
         "import type { PrintingView } from './generated';"]
for name in names:
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
# ScannerPrinting is PrintingView plus the starting Edition, as the route's model subclasses it.
extra = [f"{field}: {ts_type(value)}" for field, value in schema["ScannerPrinting"]["properties"].items()
         if field not in schema["PrintingView"]["properties"]]
lines.append(f"export type ScannerPrinting = PrintingView & {{ {'; '.join(extra)} }};")
lines.append("""
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
""")
content = "\n".join(lines)
target = root / "web/src/scanner_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated scanner client is stale")
else:
    target.write_text(content)
