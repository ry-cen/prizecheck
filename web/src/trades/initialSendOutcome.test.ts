import { describe, expect, it } from "vitest";
import type { TradeView } from "../trade_send_generated";
import { TradesError } from "../trades_generated";
import {
  initialSendOutcome,
  isAppliedTradeUnavailable,
} from "./initialSendOutcome";

const trade: TradeView = {
  id: "round",
  thread_id: "thread",
  offer_id: "round",
  state: "proposed",
  closed_reason: null,
  closed_by: null,
  role: "recipient",
  other: {
    collector_id: null,
    handle: null,
    display_name: "Ash",
    open_to_cash_offers: false,
  },
  countered_from: null,
  you_give: [],
  you_get: [],
  cash: null,
  you_confirmed_swap: false,
  they_confirmed_swap: false,
  needs_you: true,
  waiting: "answer",
  section: "needs_you",
  actions: ["counter"],
  revision: 2,
  created_at: "2026-11-03T00:00:00Z",
};
const detail = {
  code: "TRADE_SEND_ALREADY_APPLIED_UNAVAILABLE",
  outcome: "already_applied",
  view: "unavailable",
};

describe("initial Trade send outcomes", () => {
  it("keeps fresh/current stored replies plain and explicitly labels legacy current terms", () => {
    expect(initialSendOutcome(trade)).toEqual({ kind: "sent", trade });
    expect(
      initialSendOutcome({
        outcome: "already_applied",
        view: "current",
        label: "Current Trade",
        trade,
      })
    ).toEqual({ kind: "applied_current", trade, label: "Current Trade" });
  });
  it("requires the actual TradesError and exact terminal status, code and metadata", () => {
    expect(
      isAppliedTradeUnavailable(new TradesError(409, detail.code, detail))
    ).toBe(true);
    for (const error of [
      new Error(detail.code),
      { status: 409, code: detail.code, detail },
      new TradesError(503, detail.code, detail),
      new TradesError(409, "IDEMPOTENCY_KEY_REUSED", detail),
      new TradesError(409, detail.code),
      new TradesError(409, detail.code, { ...detail, view: "current" }),
      new TradesError(409, detail.code, { ...detail, outcome: "unknown" }),
      new TradesError(422, "EMPTY_MESSAGE"),
      new TypeError("Failed to fetch"),
      null,
    ]) {
      expect(isAppliedTradeUnavailable(error)).toBe(false);
    }
  });
});
