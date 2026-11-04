// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { getTrades, type ThreadItem } from "../social_generated";
import { TradesPage } from "./TradesPage";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getTrades: vi.fn(),
}));
vi.mock("./TradeScreen", () => ({
  TradeScreen: ({
    onAllTrades,
    onTradeChanged,
  }: {
    onAllTrades: () => void;
    onTradeChanged: () => void;
  }) =>
    h(
      "div",
      null,
      h("button", { onClick: onAllTrades }, "All Trades"),
      h("button", { onClick: onTradeChanged }, "Finish Trade")
    ),
}));
const id = "10000000-0000-4000-8000-000000000001";
const item: ThreadItem = {
  id,
  kind: "trade",
  other: {
    trader_id: null,
    display_name: "Misty",
    friend: false,
  },
  you_are: "low",
  summary: { you_give: "0", you_get: "0", cards: [], cash: null },
  section: "needs_you",
  state: "agreed",
  waiting: "confirm_swap",
  unread: 0,
  needs_you: true,
  last_activity_at: "2026-11-04T10:00:00Z",
};
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("keeps the warm queue and restores its exact row focus after opening a Trade and returning", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.mocked(getTrades).mockResolvedValue([item]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function View() {
    const [section, setSection] = useState<string | null>(null);
    return h(TradesPage, {
      active: true,
      section,
      onNavigate: (path: string) =>
        setSection(path === "/trades" ? null : path.slice(8)),
    });
  }
  try {
    await act(async () => root.render(h(View)));
    const row = host.querySelector<HTMLAnchorElement>(
      `a[data-thread="${id}"]`
    )!;
    expect(row).not.toBeNull();
    row.focus();
    await act(async () => row.click());
    expect(host.querySelector(`a[data-thread="${id}"]`)).toBe(row);
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(getTrades).toHaveBeenCalledTimes(1);
    const back = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "All Trades"
    )!;
    await act(async () => back.click());
    expect(host.querySelector(`a[data-thread="${id}"]`)).toBe(row);
    expect(document.activeElement).toBe(row);
    expect(getTrades).toHaveBeenCalledTimes(1);
    await act(async () => row.click());
    vi.mocked(getTrades).mockResolvedValue([
      {
        ...item,
        waiting: null,
        needs_you: false,
        section: "done",
        state: "closed",
      },
    ]);
    const finish = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Finish Trade"
    )!;
    await act(async () => finish.click());
    expect(getTrades).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[aria-label="Needs you Trades"]')).toBeNull();
    expect(
      host.querySelector('[aria-label="Done Trades"]')?.textContent
    ).toContain("Misty");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
