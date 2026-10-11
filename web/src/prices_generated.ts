// Generated from FastAPI OpenAPI by scripts/generate_prices_client.py. Do not edit.
export type PriceRow = { status: 'quote' | 'unavailable' | 'failed' | 'pending'; reason: 'not_found' | 'unverified' | 'quarantined' | 'unspecified_variant' | 'no_quote_variant' | 'not_cached' | 'confirmed_absent' | 'lookup_mismatch' | 'invalid_quote' | 'store_unavailable' | 'deadline' | 'validation_unavailable' | null; amount: string | null; display_amount: string | null; currency: 'USD'; provider_updated_at: string | null; checked_at: string | null; age: 'known' | 'unknown'; stale: boolean | null; refresh: 'background' | 'refreshed' | 'timeout' | 'busy' | 'backoff' | 'failed' | null; refresh_failed_at: string | null; edition_id: string };
export type PricesResponse = { prices: PriceRow[]; withheld: boolean };
export type DeckCostFigures = { status: 'priced' | 'empty' | 'no_quotes' | 'incomplete'; reason: 'deadline' | 'store_unavailable' | 'validation_unavailable' | 'inventory_unavailable' | null; total_copies: string | null; priced_copies: string | null; stale_copies: string | null; unknown_age_copies: string | null; fallback_copies: string | null; amount: string | null; display_amount: string | null; currency: 'USD' };
export type DeckCost = { deck_id: string; status: 'priced' | 'empty' | 'no_quotes' | 'incomplete'; reason: 'deadline' | 'store_unavailable' | 'validation_unavailable' | 'inventory_unavailable' | null; owner_revision: number | null; total_copies: string | null; priced_copies: string | null; stale_copies: string | null; unknown_age_copies: string | null; fallback_copies: string | null; amount: string | null; display_amount: string | null; currency: 'USD'; deck_list_revision: number | null; deck_list_cost: DeckCostFigures; cost_to_complete: DeckCostFigures };
export type PublishedDeckCost = { version: number; digest: string | null; status: 'priced' | 'empty' | 'no_quotes' | 'incomplete'; reason: 'deadline' | 'store_unavailable' | 'validation_unavailable' | 'inventory_unavailable' | null; total_copies: string | null; priced_copies: string | null; stale_copies: string | null; unknown_age_copies: string | null; fallback_copies: string | null; amount: string | null; display_amount: string | null; currency: 'USD' };

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
// One access prices every copy of the Deck server-side; the browser never sums rows or pages.
export async function getDeckCost(deckId: string, signal?: AbortSignal): Promise<DeckCost> {
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/cost`, { method: 'GET', credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new PriceError(response.status, payload?.detail?.code ?? 'PRICE_REQUEST_FAILED');
  }
  return response.json() as Promise<DeckCost>;
}
// One anonymous access prices every frozen copy of one Published Deck snapshot version. Only the token and the version
// are sent, and no cookie: the gateway treats every /api/public/ route as anonymous anyway.
export async function getPublishedDeckCost(token: string, version: number, signal?: AbortSignal): Promise<PublishedDeckCost> {
  const response = await fetch(`/api/public/decks/${encodeURIComponent(token)}/versions/${version}/cost`, { method: 'GET', credentials: 'omit', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new PriceError(response.status, payload?.detail?.code ?? 'PRICE_REQUEST_FAILED');
  }
  return response.json() as Promise<PublishedDeckCost>;
}
