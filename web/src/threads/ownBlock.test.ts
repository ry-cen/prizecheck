// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ThreadTimeline } from "./ThreadTimeline";
import {
  getThreadDetail,
  getThreadTimeline,
  getBlocked,
  getTrader,
  getDiscovery,
  type TradeView,
  type LoanView,
  type TraderView,
} from "../social_generated";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getThreadDetail: vi.fn(),
  getThreadTimeline: vi.fn(),
  getBlocked: vi.fn(),
  getTrader: vi.fn(),
  getDiscovery: vi.fn(),
}));
const trade: TradeView = {
  id: "round",
  thread_id: "item",
  offer_id: "round",
  revision: 2,
  state: "closed",
  closed_reason: "cancelled",
  closed_by: "you",
  role: "proposer",
  other: {
    collector_id: null,
    handle: null,
    trader_id: "public-trader",
    display_name: "Misty",
    friend: false,
    available: false,
    open_to_cash_offers: false,
  },
  countered_from: null,
  you_give: [],
  you_get: [],
  cash: null,
  you_confirmed_swap: false,
  they_confirmed_swap: false,
  needs_you: false,
  waiting: null,
  section: "history",
  actions: [],
  created_at: "2026-11-04T12:00:00Z",
};
const loan: LoanView = {
  id: "round",
  thread_id: "item",
  loan_id: "round",
  revision: 2,
  kind: "borrow_request",
  state: "closed",
  closed_reason: "cancelled",
  closed_by: "you",
  role: "borrower",
  other: { collector_id: "known-friend", display_name: "Misty" },
  return_by: null,
  you_confirmed_handover: false,
  they_confirmed_handover: false,
  lines: [],
  needs_you: false,
  section: "history",
  actions: [],
};
for (const kind of ["trade", "loan"] as const)
  for (const status of ["you_blocked", "unavailable", "open"] as const) {
    it(`S2-05: ${kind} recognizes a Friend-origin Block only from its own precise status (${status})`, async () => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const party = {
        trader_id: "public-trader",
        display_name: "Misty",
        friend: false,
        available: false,
      };
      vi.mocked(getThreadDetail).mockResolvedValue(
        kind === "trade"
          ? {
              id: "item",
              live_offer: trade,
              can_message: false,
              can_report: true,
            }
          : {
              id: "item",
              live_terms: loan,
              other: party,
              can_message: false,
              can_report: true,
            }
      );
      vi.mocked(getThreadTimeline).mockResolvedValue({
        you_are: "low",
        items: [],
        next_before: null,
      });
      // Friends-origin rows deliberately lack trader_id; a colliding name proves nothing.
      vi.mocked(getBlocked).mockResolvedValue({
        blocked: [
          {
            block_id: "private-block",
            display_name: "Misty",
            handle: "misty",
            trader_id: null,
          },
        ],
      });
      const trader: TraderView = {
        trader_id: "public-trader",
        display_name: "Misty",
        friend: false,
        band: null,
        completed_trades: status === "unavailable" ? null : 0,
        open_to_cash_offers: false,
        status,
        conversation_id: null,
        add_friend: null,
      };
      vi.mocked(getTrader).mockResolvedValue(trader);
      vi.mocked(getDiscovery).mockResolvedValue({
        status: "off",
        zip: null,
        radius_mi: 5,
        zip_changes_left: 3,
        visible_beyond_friends: true,
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () =>
          root.render(h(ThreadTimeline, { kind, id: "item" }))
        );
        const link = host.querySelector<HTMLAnchorElement>(
          'a[href="/settings"]'
        );
        if (status === "you_blocked") {
          expect(link?.textContent).toBe("You blocked Misty.");
          expect(getTrader).toHaveBeenCalledWith(
            "public-trader",
            expect.any(AbortSignal)
          );
        } else {
          expect(link).toBeNull();
          expect(host.textContent).not.toMatch(/blocked/i);
        }
        expect(host.querySelector("textarea")).toBeNull();
        for (const secret of ["known-friend", "public-trader", "private-block"])
          expect(host.textContent).not.toContain(secret);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
      }
    });
  }
