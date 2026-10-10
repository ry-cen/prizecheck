// Generated from FastAPI OpenAPI by scripts/generate_prices_client.py. Do not edit.
export type PriceRow = { status: 'quote' | 'unavailable' | 'failed' | 'pending'; reason: 'not_found' | 'unverified' | 'quarantined' | 'unspecified_variant' | 'no_quote_variant' | 'not_cached' | 'confirmed_absent' | 'lookup_mismatch' | 'invalid_quote' | 'store_unavailable' | 'deadline' | 'validation_unavailable' | null; amount: string | null; display_amount: string | null; currency: 'USD'; provider_updated_at: string | null; checked_at: string | null; age: 'known' | 'unknown'; stale: boolean | null; refresh: 'background' | 'refreshed' | 'timeout' | 'busy' | 'backoff' | 'failed' | null; refresh_failed_at: string | null; edition_id: string };
export type PricesResponse = { prices: PriceRow[]; withheld: boolean };

export const MAX_PRICE_EDITIONS = 64;

export class PriceError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export async function getEditionPrices(editionIds: string[], signal?: AbortSignal): Promise<PricesResponse> {
  const response = await fetch('/api/prices/editions', { method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ edition_ids: editionIds }) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new PriceError(response.status, payload?.detail?.code ?? 'PRICE_REQUEST_FAILED');
  }
  return response.json() as Promise<PricesResponse>;
}
