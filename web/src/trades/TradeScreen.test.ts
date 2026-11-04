// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TradeView } from "../social_generated";
import { getTrade } from "../social_generated";
import { acceptTrade, getTradeSide } from "../trades_generated";
import { ListDetailLayout } from "../ui/ListDetailLayout";
import { ToastProvider } from "../ui/Toast";
import { TradeScreen } from "./TradeScreen";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getTrade: vi.fn(),
}));
vi.mock("../trades_generated", async (original) => ({
  ...(await original<typeof import("../trades_generated")>()),
  getTradeSide: vi.fn(),
  acceptTrade: vi.fn(),
}));
vi.mock("./useIncomingTradeMatch", () => ({
  useIncomingTradeMatch: () => ({ match: null, needs: [] }),
}));
vi.mock("./useTradeValue", async (original) => ({
  ...(await original<typeof import("./useTradeValue")>()),
  useTradeValue: () => ({ kind: "none" }),
}));
vi.mock("../threads/ThreadTimeline", () => ({ ThreadTimeline: () => null }));
const trade: TradeView = {
  id: "old-round",
  thread_id: "item",
  offer_id: "old-round",
  revision: 1,
  state: "proposed",
  closed_reason: null,
  closed_by: null,
  role: "recipient",
  other: {
    collector_id: null,
    handle: null,
    display_name: "Misty",
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
  actions: ["accept"],
  created_at: "2026-11-04T00:00:00Z",
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/trades/old-round");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(getTrade).mockResolvedValue(trade);
  vi.mocked(getTradeSide).mockResolvedValue({
    trade_id: "old-round",
    picks: [],
    suggested: [],
    deck_switches: [],
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("renders one main landmark when Trade details are inside the list/detail layout", async () => {
  await act(async () =>
    root.render(
      h(ToastProvider, {
        children: h(ListDetailLayout, {
          selected: true,
          queue: h("p", null, "Trades"),
          detail: h(TradeScreen, {
            tradeId: null,
            onAllTrades: vi.fn(),
            onNavigate: vi.fn(),
          }),
        }),
      })
    )
  );
  expect(host.querySelectorAll("main")).toHaveLength(1);
  expect(
    host.querySelector('[aria-label="Trade details"]')?.textContent
  ).toContain("Trade not found");
});
it("canonicalizes an old round URL before acceptance so route-scoped feedback stays visible", async () => {
  vi.mocked(acceptTrade).mockResolvedValue({
    ...trade,
    state: "accepted",
    actions: [],
    waiting: null,
  });
  const navigations = vi.fn();
  function Screen() {
    const [id, setId] = useState("old-round");
    return h(TradeScreen, {
      tradeId: id,
      onAllTrades: vi.fn(),
      onNavigate: (path, options) => {
        navigations(path, options);
        window.history.replaceState(null, "", path);
        setId(path.split("/").at(-1)!);
      },
    });
  }
  await act(async () => root.render(h(ToastProvider, { children: h(Screen) })));
  expect(navigations).toHaveBeenCalledWith("/trades/item", { replace: true });
  const accept = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Accept"
  );
  expect(accept).toBeDefined();
  await act(async () => accept!.click());
  expect(acceptTrade).toHaveBeenCalledWith(
    "item",
    expect.objectContaining({ offer_id: "old-round", revision: 1 })
  );
  expect(
    host.querySelector('[aria-label="Notifications"]')?.textContent
  ).toContain("Accepted. Swap the cards in person, then confirm.");
});
