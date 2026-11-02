import { useEffect, useState } from "react";
import {
  getTraderMatch,
  getOwnTradeNeeds,
  type OwnTradeNeed,
  type TraderMatchRow,
  type TradeView,
} from "../social_generated";

type Context = { match: TraderMatchRow | null; needs: OwnTradeNeed[] };
const EMPTY: Context = { match: null, needs: [] };

/** Optional decision context, scoped to this incoming Trade revision. Listed cards retain response-local groups;
 * only uncovered cards use own-only need, never a trader id. Failed reads stay silent and never block Trade actions. */
export function useIncomingTradeMatch(trade: TradeView | null): Context {
  const incoming =
    trade?.state === "proposed" && trade.role === "recipient" ? trade : null;
  const key = incoming
    ? `${incoming.id}:${incoming.revision}:${incoming.other.trader_id ?? ""}:${incoming.you_get.map((card) => card.edition_id).join(",")}`
    : "";
  const [answer, setAnswer] = useState<{ key: string; value: Context } | null>(
    null
  );
  useEffect(() => {
    if (!incoming) return;
    const controller = new AbortController();
    async function read() {
      const trader = incoming!.other.trader_id;
      const match = trader
        ? await getTraderMatch(trader, controller.signal).catch(() => null)
        : null;
      if (controller.signal.aborted) return;
      setAnswer({ key, value: { match, needs: [] } });
      const listed = new Set(match?.you_get.map((card) => card.edition_id));
      const missing = [
        ...new Set(incoming!.you_get.map((card) => card.edition_id)),
      ].filter((id) => !listed.has(id));
      const needs: OwnTradeNeed[] = [];
      // The own-only route caps each read at 50 Editions. Keep every allowed proposal line covered without changing
      // the proposal's line limit, and keep a failed batch silent rather than discarding other batches' context.
      for (let start = 0; start < missing.length; start += 50) {
        if (controller.signal.aborted) return;
        needs.push(
          ...(await getOwnTradeNeeds(
            missing.slice(start, start + 50),
            controller.signal
          ).catch(() => []))
        );
      }
      if (!controller.signal.aborted)
        setAnswer({ key, value: { match, needs } });
    }
    void read();
    return () => controller.abort();
    // The key names every Trade fact this read uses; object identity must not restart it after unrelated renders.
  }, [key]);
  return key && answer?.key === key ? answer.value : EMPTY;
}
