import { useEffect, useState } from "react";
import {
  getTraderMatch,
  type TraderMatchRow,
  type TradeView,
} from "../social_generated";

/** Optional decision context: failures or loss of reach hide hints without blocking the Trade's own read or actions. */
export function useIncomingTradeMatch(
  trade: TradeView | null
): TraderMatchRow | null {
  const trader =
    trade?.state === "proposed" && trade.role === "recipient"
      ? trade.other.trader_id
      : null;
  const key = trader ? `${trade!.id}:${trade!.revision}:${trader}` : "";
  const [answer, setAnswer] = useState<{
    key: string;
    row: TraderMatchRow;
  } | null>(null);
  useEffect(() => {
    if (!trader) return;
    const controller = new AbortController();
    getTraderMatch(trader, controller.signal).then(
      (row) => {
        if (!controller.signal.aborted) setAnswer({ key, row });
      },
      () => {
        if (!controller.signal.aborted) setAnswer(null);
      }
    );
    return () => controller.abort();
  }, [key, trader]);
  return key && answer?.key === key ? answer.row : null;
}
