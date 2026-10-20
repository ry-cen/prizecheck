// Generated from FastAPI OpenAPI by scripts/generate_trades_client.py. Do not edit.
import type { TradeStep, TradeView } from "./social_generated";
export type TradeListPlace = { location_id: string; copies: string };
export type TradeListLocation = { id: string; name: string; path: string[]; hidden: boolean };
export type TradeListCard = { edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; copies: string; places: TradeListPlace[] };
export type OwnTradeList = { locations: TradeListLocation[]; cards: TradeListCard[] };
export type TradeLineRequest = { edition_id: string; quantity: string };
export type SendTradeProposal = { recipient_id: string; you_give?: TradeLineRequest[]; you_get?: TradeLineRequest[]; idempotency_key: string };
export type TradePickPlace = { edition_id: string; location_id: string | null; name: string; copies: string; short: string };
export type OwnTradeSide = { trade_id: string; picks: TradePickPlace[]; suggested: TradePickPlace[] };
export type ConfirmSwap = { revision: number; idempotency_key: string; destination_id?: string | null };

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
// Send a Friend a Trade Proposal (#270), idempotent: retry a failed one with the same idempotency_key. It reserves the
// cards you give, and answers the Trade as both sides read it.
export const sendTradeProposal = (body: SendTradeProposal) => request<TradeView>('/api/trades', 'POST', body);
// Accept a Trade Proposal sent to you, whole (#271), idempotent: it reserves the cards you give and answers the Trade.
export const acceptTrade = (id: string, body: TradeStep) =>
  request<TradeView>(`/api/trades/${encodeURIComponent(id)}/accept`, 'POST', body);
// Your own side of a Trade (#272): where your picks take the cards you give from, which are out of date, and the
// suggested picks.
export const getTradeSide = (id: string, signal?: AbortSignal) =>
  request<OwnTradeSide>(`/api/trades/${encodeURIComponent(id)}/side`, 'GET', undefined, signal);
// Replace your out-of-date picks with the suggested ones (#272), idempotent.
export const useSuggestedTradePicks = (id: string, body: TradeStep) =>
  request<TradeView>(`/api/trades/${encodeURIComponent(id)}/picks/use-suggested`, 'POST', body);
// Confirm the swap for your own Collection (#272), idempotent: the cards you give leave it, the cards you get arrive in
// destination_id (null: Unsorted), and the second confirmation closes the Trade.
export const confirmSwap = (id: string, body: ConfirmSwap) =>
  request<TradeView>(`/api/trades/${encodeURIComponent(id)}/confirm-swap`, 'POST', body);
