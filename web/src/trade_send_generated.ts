// Generated from FastAPI OpenAPI by scripts/generate_trade_send_client.py. Do not edit.
import { TradesError } from "./trades_generated";
export type TradeLineRequest = { edition_id: string; quantity: string };
export type TradeCashRequest = { cents: string; payer: "you" | "them" };
export type SendTradeProposal = { recipient_id?: string | null; recipient_trader_id?: string | null; you_give?: TradeLineRequest[]; you_get?: TradeLineRequest[]; cash?: TradeCashRequest | null; idempotency_key: string; message?: string | null };
export type TradeParty = { collector_id: string | null; handle: string | null; trader_id?: string | null; display_name: string; open_to_cash_offers: boolean; friend?: boolean; available?: boolean; completed_trades?: number | null };
export type TradeCard = { edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; copies: string };
export type TradeCash = { cents: string; payer: "you" | "them" };
export type TradeView = { id: string; thread_id: string; offer_id: string; state: "proposed" | "accepted" | "closed"; closed_reason: "declined" | "withdrawn" | "countered" | "cancelled" | "swapped" | null; closed_by: "you" | "them" | null; role: "proposer" | "recipient"; other: TradeParty; countered_from: string | null; you_give: TradeCard[]; you_get: TradeCard[]; cash: TradeCash | null; you_confirmed_swap: boolean; they_confirmed_swap: boolean; needs_you: boolean; waiting: "answer" | "fix_picks" | "confirm_swap" | null; section: "needs_you" | "to_swap" | "pending" | "history"; actions: ("accept" | "decline" | "counter" | "confirm_swap" | "use_suggested_picks" | "withdraw" | "cancel" | "change_offer")[]; revision: number; created_at: string; conversation_id?: string | null };
export type ReplayedTradeSend = { outcome: "already_applied"; view: "current"; label: "Current Trade"; trade: TradeView };
export type TradeSendResult = TradeView | ReplayedTradeSend;
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.detail && typeof payload.detail === 'object' ? payload.detail : {};
    throw new TradesError(response.status, detail.code ?? 'TRADES_REQUEST_FAILED', detail);
  }
  return response.json() as Promise<T>;
}
export const sendTradeProposal = (body: SendTradeProposal): Promise<TradeSendResult> => request<TradeSendResult>('/api/trades', 'POST', body);
