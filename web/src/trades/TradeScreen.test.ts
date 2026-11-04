// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TradeView } from "../social_generated";
import { getTrade, declineTrade } from "../social_generated";
import { acceptTrade, confirmSwap, getTradeSide } from "../trades_generated";
import { ListDetailLayout } from "../ui/ListDetailLayout";
import { ToastProvider } from "../ui/Toast";
import { TradeScreen } from "./TradeScreen";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getTrade: vi.fn(),
  declineTrade: vi.fn(),
}));
vi.mock("../trades_generated", async (original) => ({
  ...(await original<typeof import("../trades_generated")>()),
  getTradeSide: vi.fn(),
  acceptTrade: vi.fn(),
  confirmSwap: vi.fn(),
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

it("declines a proposal in one press without a redundant confirmation", async () => {
  vi.mocked(getTrade).mockResolvedValue({ ...trade, actions: ["decline"] });
  vi.mocked(declineTrade).mockResolvedValue({
    ...trade,
    state: "closed",
    actions: [],
    closed_reason: "declined",
  });
  await act(async () =>
    root.render(
      h(ToastProvider, {
        children: h(TradeScreen, {
          tradeId: "item",
          onAllTrades: vi.fn(),
          onNavigate: vi.fn(),
        }),
      })
    )
  );
  const decline = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Decline"
  )!;
  await act(async () => decline.click());
  expect(declineTrade).toHaveBeenCalledTimes(1);
  expect(declineTrade).toHaveBeenCalledWith(
    "item",
    expect.objectContaining({ offer_id: "old-round", revision: 1 })
  );
  expect(host.querySelector('[role="group"][aria-label="Decline"]')).toBeNull();
});
it("shows the physical swap disclosure before its single confirmation control", async () => {
  const agreed: TradeView = {
    ...trade,
    state: "accepted",
    actions: ["confirm_swap"],
  };
  vi.mocked(getTrade).mockResolvedValue(agreed);
  vi.mocked(confirmSwap).mockResolvedValue({
    ...agreed,
    state: "closed",
    closed_reason: "swapped",
    actions: [],
    switched_decks: [],
  });
  await act(async () =>
    root.render(
      h(ToastProvider, {
        children: h(TradeScreen, {
          tradeId: "item",
          onAllTrades: vi.fn(),
          onNavigate: vi.fn(),
        }),
      })
    )
  );
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  const disclosure = host.querySelector(
    '[aria-label="Confirm swap with Misty"]'
  )!;
  expect(disclosure.textContent).toContain(
    "Only confirm after the physical swap"
  );
  expect(disclosure.textContent).toContain("can't be undone");
  expect(disclosure.textContent).toContain("are private");
  const buttons = [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Confirm swap"
  );
  expect(buttons).toHaveLength(1);
  await act(async () => buttons[0].click());
  expect(confirmSwap).toHaveBeenCalledTimes(1);
  expect(confirmSwap).toHaveBeenCalledWith(
    "item",
    expect.objectContaining({
      offer_id: "old-round",
      revision: 1,
      destination_id: null,
      deck_switches: [],
    })
  );
});
it.each([false, true])(
  "links a Handle only for a Friend (friend=%s)",
  async (friend) => {
    vi.mocked(getTrade).mockResolvedValue({
      ...trade,
      other: { ...trade.other, friend, handle: "misty_private" },
    });
    await act(async () =>
      root.render(
        h(ToastProvider, {
          children: h(TradeScreen, {
            tradeId: "item",
            onAllTrades: vi.fn(),
            onNavigate: vi.fn(),
          }),
        })
      )
    );
    expect(
      host.querySelector('a[href="/friends/misty_private"]') !== null
    ).toBe(friend);
    expect(host.textContent?.includes("@misty_private")).toBe(friend);
  }
);
it.each([
  [true, 0, "New to trading"],
  [true, 1, "1 completed trade"],
  [false, 1, null],
] as const)(
  "shows only an available collector's track record (%s/%s)",
  async (available, completed_trades, text) => {
    vi.mocked(getTrade).mockResolvedValue({
      ...trade,
      other: { ...trade.other, available, completed_trades },
    });
    await act(async () =>
      root.render(
        h(ToastProvider, {
          children: h(TradeScreen, {
            tradeId: "item",
            onAllTrades: vi.fn(),
            onNavigate: vi.fn(),
          }),
        })
      )
    );
    if (text) expect(host.textContent).toContain(text);
    else expect(host.textContent).not.toContain("completed trade");
  }
);
