// Generated from FastAPI OpenAPI by scripts/generate_trades_client.py. Do not edit.
export type TradeListPlace = { location_id: string; copies: string };
export type TradeListLocation = { id: string; name: string; path: string[]; hidden: boolean };
export type TradeListCard = { edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; copies: string; places: TradeListPlace[] };
export type OwnTradeList = { locations: TradeListLocation[]; cards: TradeListCard[] };

/** A refused Trades request: the API's code, and its detail. */
export class TradesError extends Error {
  constructor(public status: number, public code: string, public detail: Record<string, unknown> = {}) { super(code); }
}
async function request<T>(path: string, method: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', signal,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.detail && typeof payload.detail === 'object' ? payload.detail : {};
    throw new TradesError(response.status, detail.code ?? 'TRADES_REQUEST_FAILED', detail);
  }
  return response.json() as Promise<T>;
}
// Your own Trade List (#269): every card you offer now, with its copies and the For trade Locations they sit in.
export const getTradeList = (signal?: AbortSignal) => request<OwnTradeList>('/api/trades/list', 'GET', undefined, signal);
