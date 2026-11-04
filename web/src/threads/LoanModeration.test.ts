// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ThreadTimeline } from "./ThreadTimeline";
import {
  getThreadDetail,
  getThreadTimeline,
  getBlocked,
  getDiscovery,
  getFriends,
  getLoanViews,
  getTradeViews,
  blockTrader,
  reportCollector,
  type LoanDetail,
  type LoanView,
} from "../social_generated";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getThreadDetail: vi.fn(),
  getThreadTimeline: vi.fn(),
  getBlocked: vi.fn(),
  getDiscovery: vi.fn(),
  getFriends: vi.fn(),
  getLoanViews: vi.fn(),
  getTradeViews: vi.fn(),
  blockTrader: vi.fn(),
  reportCollector: vi.fn(),
}));
const loan: LoanView = {
  id: "round",
  loan_id: "round",
  thread_id: "item",
  kind: "borrow_request",
  state: "requested",
  closed_reason: null,
  closed_by: null,
  role: "borrower",
  other: { collector_id: "known-friend", display_name: "Misty" },
  return_by: null,
  you_confirmed_handover: false,
  they_confirmed_handover: false,
  lines: [],
  needs_you: false,
  section: "pending",
  actions: [],
  revision: 1,
};
const detail: LoanDetail = {
  id: "item",
  live_terms: loan,
  other: {
    trader_id: "public-trader",
    display_name: "Misty",
    friend: true,
    available: true,
  },
  can_message: true,
  can_report: true,
};
async function mounted(
  value: LoanDetail,
  check: (host: HTMLDivElement) => Promise<void>
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
    1000
  );
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    1000
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 10, 30, 30)
  );
  vi.mocked(getThreadDetail).mockResolvedValue(value);
  vi.mocked(getThreadTimeline).mockResolvedValue({
    you_are: "low",
    items: [],
    next_before: null,
  });
  vi.mocked(getBlocked).mockResolvedValue({ blocked: [] });
  vi.mocked(getDiscovery).mockResolvedValue({
    status: "off",
    zip: null,
    radius_mi: 5,
    zip_changes_left: 3,
    visible_beyond_friends: true,
  });
  vi.mocked(getFriends).mockResolvedValue({
    friends: [
      { collector_id: "known-friend", display_name: "Misty", handle: "misty" },
    ],
    received: [],
    sent: [],
  });
  vi.mocked(getLoanViews).mockResolvedValue([loan]);
  vi.mocked(getTradeViews).mockResolvedValue([]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(h(ThreadTimeline, { kind: "loan", id: "item" }))
    );
    await check(host);
    expect(host.textContent).not.toContain("known-friend");
    expect(host.textContent).not.toContain("public-trader");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
}
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
it("S2-02: Loan Block keeps the ending warning, explicit confirmation and public target", async () => {
  await mounted(detail, async (host) => {
    const more = host.querySelector<HTMLButtonElement>(
      '[aria-label="More for Misty"]'
    )!;
    expect(more).not.toBeNull();
    await act(async () => more.click());
    expect(
      [...host.querySelectorAll('[role="menuitem"]')].map(
        (node) => node.textContent
      )
    ).toEqual(["Block", "Report"]);
    await act(async () => button(host, "Block").click());
    expect(host.textContent).toContain("Block Misty? They won't be told.");
    expect(host.textContent).toContain(
      "This cancels 1 open Loan that hasn't been handed over."
    );
    expect(blockTrader).not.toHaveBeenCalled();
    await act(async () => button(host, "Cancel").click());
    expect(document.activeElement).toBe(more);
    await act(async () => more.click());
    await act(async () => button(host, "Block").click());
    vi.mocked(getThreadDetail).mockResolvedValue({
      ...detail,
      can_message: false,
    });
    vi.mocked(blockTrader).mockResolvedValue({ relation: "blocked" });
    await act(async () => button(host, "Block").click());
    expect(blockTrader).toHaveBeenCalledExactlyOnceWith("public-trader", {
      idempotency_key: expect.any(String),
    });
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain("Blocked Misty. They aren't told.");
  });
});
for (const state of ["requested", "closed"] as const)
  for (const writable of [true, false]) {
    it(`S2-02: ${state} Loan with writable=${writable} offers Report and uses the shared safeguards`, async () => {
      const value: LoanDetail = {
        ...detail,
        can_message: writable,
        other: { ...detail.other, available: writable },
        live_terms: {
          ...loan,
          state,
          closed_reason: state === "closed" ? "declined" : null,
          closed_by: state === "closed" ? "them" : null,
        },
      };
      await mounted(value, async (host) => {
        const more = host.querySelector<HTMLButtonElement>(
          '[aria-label="More for Misty"]'
        )!;
        await act(async () => more.click());
        expect(
          [...host.querySelectorAll('[role="menuitem"]')].map(
            (node) => node.textContent
          )
        ).toEqual(writable ? ["Block", "Report"] : ["Report"]);
        await act(async () => button(host, "Report").click());
        expect(host.textContent).toContain("Report Misty?");
        expect(host.querySelector('input[type="radio"]')).toBe(
          document.activeElement
        );
        expect(reportCollector).not.toHaveBeenCalled();
        await act(async () => button(host, "Cancel").click());
        expect(document.activeElement).toBe(more);
        await act(async () => more.click());
        await act(async () => button(host, "Report").click());
        await act(async () =>
          host
            .querySelector<HTMLInputElement>('input[value="harassment"]')!
            .click()
        );
        vi.mocked(getThreadDetail).mockResolvedValue({
          ...value,
          can_message: false,
        });
        vi.mocked(reportCollector).mockResolvedValue({
          reported: true,
        });
        await act(async () => button(host, "Report").click());
        expect(reportCollector).toHaveBeenCalledExactlyOnceWith({
          trader_id: "public-trader",
          reason: "harassment",
          note: null,
          source: "conversation",
          trade_id: null,
          idempotency_key: expect.any(String),
        });
        expect(host.textContent).toContain(
          "Reported Misty. They're blocked and aren't told."
        );
        expect(host.querySelector("textarea")).toBeNull();
      });
    });
  }
it("S2-02: a deleted Loan party has no invented moderation target", async () => {
  await mounted(
    {
      ...detail,
      can_message: false,
      can_report: false,
      other: {
        ...detail.other,
        trader_id: null,
        friend: false,
        available: false,
      },
      live_terms: {
        ...loan,
        other: { collector_id: null, display_name: "Misty" },
      },
    },
    async (host) => {
      expect(host.querySelector('[aria-label="More for Misty"]')).toBeNull();
      expect(host.querySelector("textarea")).toBeNull();
      expect(blockTrader).not.toHaveBeenCalled();
      expect(reportCollector).not.toHaveBeenCalled();
    }
  );
});
