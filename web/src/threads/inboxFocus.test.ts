// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InboxProvider, InboxButton, usePollPulse } from "../inbox/Inbox";
import { LoanScreen as Screen } from "../loans/LoanScreen";
import { LoanRecoveryProvider } from "../loans/LoanRecovery";
import { fixture } from "../loans/testing/loanFakes";
import { createTabContext } from "../loans/loanIntents";
function LoanScreen(props: Parameters<typeof Screen>[0]) {
  const [recovery] = useState(() => ({
    ports: fixture().ports,
    tab: createTabContext(),
  }));
  return h(LoanRecoveryProvider, {
    accountId: "A",
    accountName: "Ana",
    ...recovery,
    children: h(Screen, props),
  });
}
import { TradesPage } from "../trades/TradesPage";
import { getTrades } from "../social_generated";
import { TradeScreen } from "../trades/TradeScreen";
import { ToastProvider } from "../ui/Toast";
import {
  getInbox,
  getThreadPulse,
  getLoan,
  getLoanSide,
  getTrade,
  type LoanView,
  type TradeView,
} from "../social_generated";
import { getTradeSide } from "../trades_generated";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getTrades: vi.fn(),
  getInbox: vi.fn(),
  getThreadPulse: vi.fn(),
  getLoan: vi.fn(),
  getLoanSide: vi.fn(),
  getTrade: vi.fn(),
}));
vi.mock("../trades_generated", async (original) => ({
  ...(await original<typeof import("../trades_generated")>()),
  getTradeSide: vi.fn(),
}));
vi.mock("../trades/useIncomingTradeMatch", () => ({
  useIncomingTradeMatch: () => ({ match: null, needs: [] }),
}));
vi.mock("../trades/useTradeValue", async (original) => ({
  ...(await original<typeof import("../trades/useTradeValue")>()),
  useTradeValue: () => ({ kind: "none" }),
}));
vi.mock("./ThreadTimeline", () => ({ ThreadTimeline: () => null }));
const loan: LoanView = {
  id: "round",
  loan_id: "round",
  thread_id: "item",
  kind: "borrow_request",
  state: "requested",
  closed_reason: null,
  closed_by: null,
  role: "lender",
  other: { collector_id: "friend", display_name: "Misty" },
  return_by: null,
  you_confirmed_handover: false,
  they_confirmed_handover: false,
  lines: [
    {
      edition_id: "iono",
      name: "Iono",
      set_code: "PAL",
      set_name: "Paldea Evolved",
      collector_number: "185",
      descriptor: {},
      image_url: null,
      requested: "1",
      promised: "0",
      written_off: "0",
    },
  ],
  needs_you: true,
  section: "needs_you",
  actions: ["accept", "decline"],
  revision: 1,
  waiting: "answer",
};
const trade: TradeView = {
  id: "round",
  thread_id: "item",
  offer_id: "round",
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
  you_get: [
    {
      edition_id: "iono",
      name: "Iono",
      set_code: "PAL",
      set_name: "Paldea Evolved",
      collector_number: "185",
      descriptor: {},
      image_url: null,
      copies: "1",
    },
  ],
  cash: null,
  you_confirmed_swap: false,
  they_confirmed_swap: false,
  needs_you: true,
  waiting: "answer",
  section: "needs_you",
  actions: ["accept", "decline"],
  created_at: "2026-11-04T00:00:00Z",
};
Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
  configurable: true,
  value() {
    this.setAttribute("open", "");
  },
});
Object.defineProperty(HTMLDialogElement.prototype, "close", {
  configurable: true,
  value() {
    this.removeAttribute("open");
  },
});
for (const kind of ["loan", "trade"] as const)
  for (const fromInbox of [true, false]) {
    it(`S2-06: ${kind} canonicalization ${fromInbox ? "carries Inbox focus to the item heading" : "does not invent Inbox focus for a deep link"}`, async () => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(
        function (this: HTMLDialogElement) {
          this.setAttribute("open", "");
        }
      );
      vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(
        function (this: HTMLDialogElement) {
          this.removeAttribute("open");
        }
      );
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
        length: 1,
        item: () => null,
        [Symbol.iterator]: () => [][Symbol.iterator](),
      });
      window.history.replaceState(
        null,
        "",
        fromInbox ? "/" : `/${kind}s/round`
      );
      vi.mocked(getInbox).mockResolvedValue({
        waiting:
          kind === "loan" ? [{ ...loan, since: "2026-11-04T00:00:00Z" }] : [],
        updates: [],
        trade_waiting:
          kind === "trade" ? [{ ...trade, since: "2026-11-04T00:00:00Z" }] : [],
        trade_updates: [],
      });
      vi.mocked(getThreadPulse).mockResolvedValue({
        watermark: "one",
        trades: { needs_you: 1, waiting: 1, unread: 0 },
        loans: { needs_you: 1, waiting: 1, unread: 0 },
      });
      vi.mocked(getLoan).mockResolvedValue(loan);
      vi.mocked(getLoanSide).mockResolvedValue({
        loan_id: "round",
        deck: null,
        can_promise: [{ edition_id: "iono", available: "1" }],
        picks: [],
        suggested: [],
      });
      vi.mocked(getTrade).mockResolvedValue(trade);
      vi.mocked(getTradeSide).mockResolvedValue({
        trade_id: "round",
        picks: [],
        suggested: [],
        deck_switches: [],
      });
      const canonical = vi.fn();
      function View() {
        const [id, setId] = useState<string | null>(fromInbox ? null : "round");
        const open = (next: string) => {
          window.history.pushState(null, "", `/${kind}s/${next}`);
          setId(next);
        };
        const replace = (next: string) => {
          canonical(next);
          window.history.replaceState(null, "", `/${kind}s/${next}`);
          setId(next);
        };
        return h(ToastProvider, {
          children: h(InboxProvider, {
            onOpenLoan: open,
            onOpenTrade: open,
            children: h(
              "main",
              null,
              h(InboxButton),
              id &&
                (kind === "loan"
                  ? h(LoanScreen, {
                      key: id,
                      loanId: id,
                      onCanonicalLoan: replace,
                      onAllLoans: vi.fn(),
                      onLoanChanged: vi.fn(),
                      onOpenDeck: vi.fn(),
                    })
                  : h(TradeScreen, {
                      key: id,
                      tradeId: id,
                      onAllTrades: vi.fn(),
                      onNavigate: (to, options) => {
                        expect(options).toEqual({ replace: true });
                        replace(to.split("/").at(-1)!);
                      },
                    }))
            ),
          }),
        });
      }
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(h(View)));
        if (fromInbox) {
          await act(async () =>
            host
              .querySelector<HTMLButtonElement>(
                'button[aria-haspopup="dialog"]'
              )!
              .click()
          );
          const link = host.querySelector<HTMLAnchorElement>(
            `dialog a[href="/${kind}s/round"]`
          );
          expect(link).not.toBeNull();
          await act(async () => link!.click());
        }
        expect(canonical).toHaveBeenCalledExactlyOnceWith("item");
        expect(window.location.pathname).toBe(`/${kind}s/item`);
        const heading = host.querySelector("h1");
        expect(heading).not.toBeNull();
        if (fromInbox) expect(document.activeElement).toBe(heading);
        else expect(document.activeElement).not.toBe(heading);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
      }
    });
  }

it("a Trade opened in-app focuses its heading once; a pulse reload later neither refocuses nor scrolls it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/trades/item");
  vi.mocked(getInbox).mockResolvedValue({
    waiting: [],
    updates: [],
    trade_waiting: [],
    trade_updates: [],
  });
  let watermark = "one";
  vi.mocked(getThreadPulse).mockImplementation(async () => ({
    watermark,
    trades: { needs_you: 1, waiting: 1, unread: 0 },
    loans: { needs_you: 0, waiting: 0, unread: 0 },
  }));
  vi.mocked(getTrade).mockResolvedValue(trade);
  vi.mocked(getTradeSide).mockResolvedValue({
    trade_id: "round",
    picks: [],
    suggested: [],
    deck_switches: [],
  });
  let poll: () => void = () => {};
  function Poll() {
    poll = usePollPulse();
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(ToastProvider, {
          children: h(InboxProvider, {
            onOpenLoan: vi.fn(),
            onOpenTrade: vi.fn(),
            children: h(
              "main",
              null,
              h(Poll),
              h(TradeScreen, {
                tradeId: "item",
                focusOnOpen: true,
                onAllTrades: vi.fn(),
                onNavigate: vi.fn(),
              })
            ),
          }),
        })
      )
    );
    const heading = host.querySelector("h1")!;
    expect(document.activeElement).toBe(heading);
    heading.blur();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const calls = vi.mocked(getTrade).mock.calls.length;
    watermark = "two";
    await act(async () => poll());
    await act(async () => {});
    expect(vi.mocked(getTrade).mock.calls.length).toBeGreaterThan(calls);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

// Exercise canonicalization through the routing wrapper as well as the screen.
for (const explicitOpen of [false, true]) {
  it(`TradesPage canonicalization preserves ${explicitOpen ? "an in-app open" : "a direct load"}'s focus intent`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const oldId = "10000000-0000-4000-8000-000000000001";
    const canonicalId = "10000000-0000-4000-8000-000000000002";
    const view = {
      ...trade,
      id: oldId,
      offer_id: oldId,
      thread_id: canonicalId,
    };
    vi.mocked(getTrade).mockResolvedValue(view);
    vi.mocked(getTradeSide).mockResolvedValue({
      trade_id: canonicalId,
      picks: [],
      suggested: [],
      deck_switches: [],
    });
    vi.mocked(getTrades).mockResolvedValue([
      {
        id: oldId,
        kind: "trade",
        other: { trader_id: null, display_name: "Misty", friend: false },
        you_are: "low",
        summary: { you_give: "0", you_get: "1", cards: [], cash: null },
        section: "needs_you",
        state: "proposed",
        waiting: "answer",
        unread: 0,
        needs_you: true,
        last_activity_at: "2026-11-04T00:00:00Z",
      },
    ]);
    const navigate = vi.fn();
    function View() {
      const [section, setSection] = useState<string | null>(
        explicitOpen ? null : oldId
      );
      return h(ToastProvider, {
        children: h(TradesPage, {
          active: true,
          section,
          onNavigate: (to, options) => {
            navigate(to, options);
            setSection(to.slice(8));
          },
        }),
      });
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(View)));
      if (explicitOpen) {
        const row = host.querySelector<HTMLAnchorElement>(
          `a[data-thread="${oldId}"]`
        )!;
        expect(row).not.toBeNull();
        await act(async () => row.click());
      }
      expect(navigate).toHaveBeenCalledWith(`/trades/${canonicalId}`, {
        replace: true,
      });
      const heading = host.querySelector("h1");
      expect(heading).not.toBeNull();
      if (explicitOpen) expect(document.activeElement).toBe(heading);
      else expect(document.activeElement).not.toBe(heading);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  });
}
