import { useEffect, useState } from "react";
import {
  getTradeValue,
  type TradeValue,
  type TradeValueLine,
} from "../trades_generated";
import { useDebouncedValue } from "../workspace/useDebouncedValue";

/** Where the estimated totals stand: none asked for, asked with the last answer to show meanwhile, answered, failed. */
export type ValueLoad =
  | { kind: "none" }
  | { kind: "loading"; last: TradeValue | null }
  | { kind: "ready"; value: TradeValue }
  | { kind: "failed" };

/**
 * Each side's estimated total for a proposal being built or reviewed (Trading #277, spec "Value cues"). It makes one
 * budgeted access per settled set of lines: debounced 400 ms, aborted when superseded or unmounted, with a 3.5 s
 * client timeout. `null` or no lines asks for nothing. There is never a suggested amount: never subtract or compare
 * the two sides' totals.
 */
export function useTradeValue(lines: TradeValueLine[] | null): ValueLoad {
  const body = lines && lines.length > 0 ? JSON.stringify(lines) : "";
  const settled = useDebouncedValue(body, 400);
  const [answer, setAnswer] = useState<{
    body: string;
    value: TradeValue | null;
  }>({ body: "", value: null });
  useEffect(() => {
    if (!settled) return;
    const controller = new AbortController();
    let live = true;
    const timer = window.setTimeout(() => controller.abort(), 3_500);
    getTradeValue(
      { lines: JSON.parse(settled) as TradeValueLine[] },
      controller.signal
    )
      .then((value) => {
        if (live) setAnswer({ body: settled, value });
      })
      .catch(() => {
        if (live) setAnswer({ body: settled, value: null });
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      live = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [settled]);
  if (!body) return { kind: "none" };
  if (answer.body !== body) return { kind: "loading", last: answer.value };
  return answer.value
    ? { kind: "ready", value: answer.value }
    : { kind: "failed" };
}

/** The words under a side's list, or null when the side has no lines or nothing was asked for. */
export function sideValueText(
  load: ValueLoad,
  side: "you_give" | "you_get",
  hasLines: boolean
): string | null {
  if (!hasLines || load.kind === "none") return null;
  if (load.kind === "failed") return "Estimate unavailable";
  const figure = load.kind === "ready" ? load.value[side] : load.last?.[side];
  if (!figure || figure.status === "empty") return "Estimating…";
  if (figure.status === "no_quotes") return "No estimate for these cards";
  if (figure.status === "incomplete") return "Estimate unavailable";
  if (figure.priced_copies === figure.total_copies)
    return `Estimated ${figure.display_total}`;
  return `Estimated ${figure.display_total} for ${figure.priced_copies} of ${figure.total_copies} cards`;
}
