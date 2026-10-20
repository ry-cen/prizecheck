// Generated from FastAPI OpenAPI by scripts/generate_trades_client.py. Do not edit.
import type { TradeStep, TradeView } from "./social_generated";
export type TradeListPlace = { location_id: string; copies: string };
export type TradeListLocation = { id: string; name: string; path: string[]; hidden: boolean };
export type TradeListCard = { edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; copies: string; places: TradeListPlace[] };
export type OwnTradeList = { locations: TradeListLocation[]; cards: TradeListCard[] };
export type TradeLineRequest = { edition_id: string; quantity: string };
export type TradeCashRequest = { cents: string; payer: "you" | "them" };
export type SendTradeProposal = { recipient_id: string; you_give?: TradeLineRequest[]; you_get?: TradeLineRequest[]; cash?: TradeCashRequest | null; idempotency_key: string };
export type TradePickPlace = { edition_id: string; location_id: string | null; name: string; copies: string; short: string };
export type OwnTradeSide = { trade_id: string; picks: TradePickPlace[]; suggested: TradePickPlace[] };
export type ConfirmSwap = { revision: number; idempotency_key: string; destination_id?: string | null };
export type TradeWantLine = { edition_id: string; name: string; set_id: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; quantity: string };
export type WillAcceptChoice = { edition_id: string; rule: "edition" | "printing" | "identity" };
export type TradeWants = { lines: TradeWantLine[]; will_accept: WillAcceptChoice[] };
export type SetTradeWant = { quantity: string };
export type SetWillAccept = { rule: "edition" | "printing" | "identity" };
export type TradeValueLine = { side: "you_give" | "you_get"; edition_id: string; quantity: string };
export type TradeValueRequest = { lines: TradeValueLine[] };
export type SideValue = { status: "priced" | "empty" | "no_quotes" | "incomplete"; display_total: string | null; priced_copies: string | null; total_copies: string };
export type TradeValue = { you_give: SideValue; you_get: SideValue };

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
// Your own Trade Wants and Will accept choices (#275).
export const getTradeWants = (signal?: AbortSignal) =>
  request<TradeWants>('/api/trade-wants', 'GET', undefined, signal);
// Set one Trade Wants line ("0" removes it), idempotent by value; answers the whole list.
export const setTradeWant = (editionId: string, body: SetTradeWant) =>
  request<TradeWants>(`/api/trade-wants/${encodeURIComponent(editionId)}`, 'PUT', body);
// Set what trades will accept for one card ('edition' is this exact card), idempotent by value; answers the whole list.
export const setWillAccept = (editionId: string, body: SetWillAccept) =>
  request<TradeWants>(`/api/trade-wants/will-accept/${encodeURIComponent(editionId)}`, 'PUT', body);
// Each side's estimated total for a proposal being built or reviewed (#277): a budgeted price access, never a
// suggested amount. Cash is not part of it.
export const getTradeValue = (body: TradeValueRequest, signal?: AbortSignal) =>
  request<TradeValue>('/api/trades/value', 'POST', body, signal);
