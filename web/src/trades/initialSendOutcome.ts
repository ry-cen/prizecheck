import type { TradeSendResult, TradeView } from "../trade_send_generated";
import { TradesError } from "../trades_generated";

type InitialSendOutcome =
  | { kind: "sent"; trade: TradeView }
  | { kind: "applied_current"; trade: TradeView; label: "Current Trade" };

/** Initial sends alone may answer with explicitly current terms. */
export function initialSendOutcome(
  result: TradeSendResult
): InitialSendOutcome {
  if ("outcome" in result) {
    if (
      result.outcome !== "already_applied" ||
      result.view !== "current" ||
      result.label !== "Current Trade"
    )
      throw new TypeError("Unrecognized initial Trade send result");
    return {
      kind: "applied_current",
      trade: result.trade,
      label: result.label,
    };
  }
  return { kind: "sent", trade: result };
}

export function isAppliedTradeUnavailable(cause: unknown): boolean {
  return (
    cause instanceof TradesError &&
    cause.status === 409 &&
    cause.code === "TRADE_SEND_ALREADY_APPLIED_UNAVAILABLE" &&
    cause.detail.outcome === "already_applied" &&
    cause.detail.view === "unavailable"
  );
}
