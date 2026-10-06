// Generated from FastAPI OpenAPI by scripts/generate_holdings_client.py. Do not edit.
export type HoldingView = { edition_id: string; quantity: string; version: number; printing_id: string; printing_name: string; set_id: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; location_id: string; location_name: string };
export type LeafHoldings = { holdings: HoldingView[]; owner_revision: number; catalog_revision: number; next_cursor: string | null };
export type AddResult = { location_id: string; edition_id: string; quantity: string; version: number; owner_revision: number };
export type AddHolding = { location_id: string; edition_id: string; quantity: string; idempotency_key: string };

export class HoldingError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new HoldingError(response.status, payload?.detail?.code ?? 'HOLDING_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export type LeafFilters = { name?: string; set_id?: string; collector_number?: string; sort?: 'name' | 'quantity' };
export const getLeafHoldings = (locationId: string, cursor?: string, filters: LeafFilters = {}) => {
  const query = new URLSearchParams({ ...filters, ...(cursor ? { cursor } : {}) });
  return request<LeafHoldings>(`/api/holdings/${encodeURIComponent(locationId)}?${query}`);
};
export const addHolding = (body: AddHolding) => request<AddResult>('/api/holdings', 'POST', body);
