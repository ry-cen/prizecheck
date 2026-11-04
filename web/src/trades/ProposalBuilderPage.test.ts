// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SocialError,
  getTrade,
  getTraderMatch,
  getTraderTradeList,
  type TradeView,
} from "../social_generated";
import { TradesError, counterTrade, getTradeList } from "../trades_generated";
import { ToastProvider } from "../ui/Toast";
import { peekProposalSeed } from "./openProposal";
import { CounterPage } from "./CounterPage";
import { ProposalBuilderPage } from "./ProposalBuilderPage";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getTrade: vi.fn(),
  getTraderMatch: vi.fn(),
  getTraderTradeList: vi.fn(),
}));
vi.mock("../trades_generated", async (original) => ({
  ...(await original<typeof import("../trades_generated")>()),
  counterTrade: vi.fn(),
  getTradeList: vi.fn(),
}));
vi.mock("./useTradeValue", async (original) => ({
  ...(await original<typeof import("./useTradeValue")>()),
  useTradeValue: () => ({ kind: "none" }),
}));
vi.mock("./openProposal", async (original) => ({
  ...(await original<typeof import("./openProposal")>()),
  peekProposalSeed: vi.fn(),
}));
const card = {
  edition_id: "Iono",
  name: "Iono",
  copies: "1",
  set_code: "PAL",
  set_name: "Paldea",
  collector_number: "185",
  descriptor: { finish: "normal" },
  image_url: null,
};
const original: TradeView = {
  id: "A",
  offer_id: "A",
  thread_id: "thread",
  revision: 1,
  state: "proposed",
  closed_reason: null,
  closed_by: null,
  role: "recipient",
  other: {
    collector_id: null,
    handle: null,
    trader_id: "misty",
    available: true,
    friend: true,
    display_name: "Misty",
    open_to_cash_offers: false,
  },
  countered_from: null,
  you_give: [],
  you_get: [card],
  cash: null,
  you_confirmed_swap: false,
  they_confirmed_swap: false,
  needs_you: true,
  waiting: "answer",
  section: "needs_you",
  actions: ["counter"],
  created_at: "2026-11-04T00:00:00Z",
};
const replacement: TradeView = {
  ...original,
  id: "B",
  offer_id: "B",
  revision: 2,
  you_get: [{ ...card, copies: "2" }],
};
let current: TradeView;
let root: Root, host: HTMLDivElement;
const navigate = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  );
  window.history.replaceState(null, "", "/trades/thread/counter");
  current = original;
  vi.mocked(getTrade).mockImplementation(async () => current);
  vi.mocked(getTradeList).mockResolvedValue({ cards: [], locations: [] });
  vi.mocked(getTraderTradeList).mockImplementation(async () => ({
    trader_id: "misty",
    display_name: "Misty",
    band: null,
    completed_trades: 0,
    cards: [{ ...card, copies: current === original ? "2" : "1" }],
    next_page: null,
  }));
  vi.mocked(getTraderMatch).mockResolvedValue({
    trader_id: "misty",
    display_name: "Misty",
    band: null,
    completed_trades: 0,
    open_to_cash_offers: false,
    match: null,
    you_get: [],
    you_give: [],
    more_you_get: 0,
    more_you_give: 0,
    you_get_groups: [],
    you_give_groups: [],
  });
  vi.mocked(counterTrade).mockResolvedValue(replacement);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
function button(name: string) {
  const found = [...host.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.trim() === name || b.getAttribute("aria-label") === name
  );
  expect(
    found,
    `Visible button: ${name}; page: ${host.textContent}`
  ).toBeDefined();
  return found!;
}
const send = () => button("Send Counter");
const increase = () => button("Increase Iono (PAL 185) you get");
const decrease = () => button("Decrease Iono (PAL 185) you get");
async function click(b: HTMLButtonElement) {
  await act(async () => b.click());
}
async function mount(counterPage = false) {
  await act(async () =>
    root.render(
      h(ToastProvider, {
        children: counterPage
          ? h(CounterPage, { tradeId: "thread", onNavigate: navigate })
          : h(ProposalBuilderPage, {
              traderId: "misty",
              counter: original,
              onNavigate: navigate,
            }),
      })
    )
  );
}
it("recovers an obsolete FIRST inventory read through visible confirmation, matching counts and a real Send", async () => {
  current = replacement;
  vi.mocked(getTrade).mockResolvedValueOnce(original); // CounterPage read A; first inventory version check sees B.
  await mount(true);
  expect(button("I reviewed the current offer").disabled).toBe(false);
  expect(send().disabled).toBe(true);
  expect(counterTrade).not.toHaveBeenCalled();
  await click(button("I reviewed the current offer"));
  expect(send().disabled).toBe(false);
  await click(increase());
  await click(increase());
  expect(increase().disabled).toBe(true); // available1 + reserved2 = 3, never the old2 + new2 = 4.
  await click(decrease());
  await click(decrease());
  await click(send());
  expect(counterTrade).toHaveBeenCalledWith(
    "thread",
    expect.objectContaining({
      offer_id: "B",
      revision: 2,
      you_get: [{ edition_id: "Iono", quantity: "1" }],
    })
  );
});
it("recovers an initial inventory transport failure with visible Retry and then Send", async () => {
  vi.mocked(getTradeList).mockRejectedValueOnce(new TypeError("offline"));
  await mount();
  expect(host.textContent).toContain("Available copies couldn't be loaded");
  expect(send().disabled).toBe(true);
  await click(button("Retry available copies"));
  await click(increase());
  expect(send().disabled).toBe(false);
  await click(send());
  expect(counterTrade).toHaveBeenCalledTimes(1);
});
it("recovers a failed replacement fresh read without hiding Retry, the preserved draft or confirmation", async () => {
  await mount();
  await click(increase());
  vi.mocked(counterTrade).mockRejectedValueOnce(
    new TradesError(409, "OFFER_CHANGED")
  );
  vi.mocked(getTrade).mockRejectedValueOnce(new TypeError("offline"));
  await click(send());
  expect(host.textContent).toContain("The current offer couldn't be loaded");
  expect(send().disabled).toBe(true);
  current = replacement;
  await click(button("Retry current offer"));
  expect(button("I reviewed the current offer").disabled).toBe(false);
  expect(counterTrade).toHaveBeenCalledTimes(1);
  await click(button("I reviewed the current offer"));
  expect(
    host.querySelector('[role="group"][aria-label="Iono (PAL 185) you get"]')
      ?.textContent
  ).toBe("2");
  await click(decrease());
  await click(send());
  expect(vi.mocked(counterTrade).mock.calls[1][1].offer_id).toBe("B");
});
it("fences OFFER_CHANGED after Send until actual confirmation and submits only the reviewed replacement", async () => {
  await mount();
  await click(increase());
  current = replacement;
  vi.mocked(counterTrade).mockRejectedValueOnce(
    new TradesError(409, "OFFER_CHANGED")
  );
  await click(send());
  expect(send().disabled).toBe(true);
  expect(host.textContent).toContain("1 before, 2 now");
  await click(send());
  expect(counterTrade).toHaveBeenCalledTimes(1);
  await click(button("I reviewed the current offer"));
  expect(
    host.querySelector('[role="group"][aria-label="Iono (PAL 185) you get"]')
      ?.textContent
  ).toBe("2");
  await click(decrease());
  await click(send());
  expect(vi.mocked(counterTrade).mock.calls[1][1]).toMatchObject({
    offer_id: "B",
    revision: 2,
  });
});
it("retries an unknown transport outcome with an identical retained key/body and no fresh version adoption", async () => {
  await mount();
  await click(increase());
  const reads = vi.mocked(getTrade).mock.calls.length;
  vi.mocked(counterTrade).mockRejectedValueOnce(new TypeError("lost response"));
  await click(send());
  expect(send().disabled).toBe(false);
  expect(host.textContent).toContain(
    "The Counter may not have been sent. Check your connection and try again."
  );
  await click(send());
  expect(vi.mocked(counterTrade).mock.calls[1]).toEqual(
    vi.mocked(counterTrade).mock.calls[0]
  );
  expect(getTrade).toHaveBeenCalledTimes(reads);
});
it("shows a way back and no enabled Send when the current item is gone", async () => {
  vi.mocked(getTrade).mockRejectedValue(
    new SocialError(404, "TRADE_NOT_FOUND")
  );
  await mount();
  expect(host.textContent).toContain("no longer accepts an offer change");
  expect(send().disabled).toBe(true);
  expect(host.querySelector('a[href="/trades/thread"]')).not.toBeNull();
  expect(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "I reviewed the current offer"
    )
  ).toBeUndefined();
  expect(counterTrade).not.toHaveBeenCalled();
});

it("keeps cached replacement terms and confirmation visible beside Retry when another check fails", async () => {
  await mount();
  await click(increase());
  current = replacement;
  vi.mocked(counterTrade).mockRejectedValueOnce(
    new TradesError(409, "OFFER_CHANGED")
  );
  await click(send());
  vi.mocked(getTrade).mockRejectedValueOnce(new TypeError("offline"));
  await click(button("Check current offer"));
  expect(host.textContent).toContain("1 before, 2 now");
  expect(button("I reviewed the current offer").disabled).toBe(false);
  expect(button("Retry current offer").disabled).toBe(false);
  expect(send().disabled).toBe(true);
  await click(button("Retry current offer"));
  await click(button("I reviewed the current offer"));
  await click(decrease());
  await click(send());
  expect(vi.mocked(counterTrade).mock.calls[1][1]).toMatchObject({
    offer_id: "B",
    revision: 2,
  });
});
it("freezes draft controls while sending, then exposes the identical-key retry after a lost response", async () => {
  await mount();
  await click(increase());
  let reject!: (cause: Error) => void;
  vi.mocked(counterTrade).mockReturnValueOnce(
    new Promise<TradeView>((_, no) => {
      reject = no;
    })
  );
  await click(send());
  expect(send().disabled).toBe(true);
  expect(increase().matches(":disabled")).toBe(true);
  await click(increase());
  expect(
    host.querySelector('[role="group"][aria-label="Iono (PAL 185) you get"]')
      ?.textContent
  ).toBe("2");
  await act(async () => reject(new TypeError("lost response")));
  expect(send().disabled).toBe(false);
  await click(send());
  expect(vi.mocked(counterTrade).mock.calls[1]).toEqual(
    vi.mocked(counterTrade).mock.calls[0]
  );
});

it("announces a Counter as a Counter after sending", async () => {
  navigate.mockImplementationOnce((path: string) =>
    window.history.replaceState(null, "", path)
  );
  await mount();
  await click(increase());
  await click(send());
  expect(
    host.querySelector('[aria-label="Notifications"]')?.textContent
  ).toContain("Counter sent to Misty");
});
it("keeps one outcome announcement when an unavailable replay replaces the mounted new draft", async () => {
  vi.mocked(peekProposalSeed).mockReturnValue({
    give: [],
    get: [{ ...card, copies: "3", quantity: 1 }],
  });
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    })
  );
  vi.stubGlobal("fetch", fetch);
  await act(async () =>
    root.render(
      h(ToastProvider, {
        children: h(ProposalBuilderPage, {
          traderId: "misty",
          onNavigate: navigate,
        }),
      })
    )
  );
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(host.querySelector("output")).toBeNull();
  expect(
    host.querySelector('[role="group"][aria-label="Iono (PAL 185) you get"]')
      ?.textContent
  ).toBe("1");
  const submit = button("Send Trade Proposal");
  await act(async () => {
    submit.click();
    submit.click();
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish(
      new Response(
        JSON.stringify({
          detail: {
            code: "TRADE_SEND_ALREADY_APPLIED_UNAVAILABLE",
            outcome: "already_applied",
            view: "unavailable",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } }
      )
    )
  );
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "Your proposal was already sent. This Trade isn't available to view."
  );
  expect(host.querySelector("output")).toBeNull();
  expect(
    [...host.querySelectorAll("button")].some(
      (b) => b.textContent === "Send Trade Proposal"
    )
  ).toBe(false);
});

it.each(["sending", "retry_send"])(
  "S1-07: late GET404 during %s preserves byte-identical replay",
  async (phase) => {
    await mount();
    await click(increase());
    current = replacement;
    vi.mocked(counterTrade).mockRejectedValueOnce(
      new TradesError(409, "OFFER_CHANGED")
    );
    await click(send());
    let failCheck!: (cause: Error) => void;
    vi.mocked(getTrade).mockImplementationOnce(
      () =>
        new Promise<TradeView>((_, no) => {
          failCheck = no;
        })
    );
    await click(button("Check current offer"));
    await click(button("I reviewed the current offer"));
    await click(decrease());
    let failPost!: (cause: Error) => void;
    vi.mocked(counterTrade).mockReturnValueOnce(
      new Promise<TradeView>((_, no) => {
        failPost = no;
      })
    );
    await click(send());
    const bytes = JSON.stringify(vi.mocked(counterTrade).mock.calls[1]);
    if (phase === "retry_send")
      await act(async () => failPost(new TypeError("lost response")));
    await act(async () => failCheck(new SocialError(404, "TRADE_NOT_FOUND")));
    if (phase === "sending")
      await act(async () => failPost(new TypeError("lost response")));
    expect(send().disabled).toBe(false);
    expect(host.textContent).not.toContain(
      "This Trade no longer accepts an offer change"
    );
    await click(send());
    expect(JSON.stringify(vi.mocked(counterTrade).mock.calls[2])).toBe(bytes);
  }
);

it.each(["refusal", "edit-after-unknown"])(
  "S1-08: %s must not leave checking with no read or Retry",
  async (outcome) => {
    await mount();
    await click(increase());
    // A definitive version conflict may read the same version; explicit review is still required.
    vi.mocked(counterTrade).mockRejectedValueOnce(
      new TradesError(409, "OFFER_CHANGED")
    );
    await click(send());
    expect(button("I reviewed the current offer").disabled).toBe(false);
    let finishCheck!: (offer: TradeView) => void;
    vi.mocked(getTrade).mockImplementationOnce(
      () =>
        new Promise<TradeView>((yes) => {
          finishCheck = yes;
        })
    );
    await click(button("Check current offer"));
    // Make only the searched library fail. Selected-edition inventory still loads normally.
    vi.mocked(getTraderTradeList).mockImplementation(async (_id, opts) => {
      if (opts?.q !== undefined) throw new TypeError("library offline");
      return {
        trader_id: "misty",
        display_name: "Misty",
        band: null,
        completed_trades: 0,
        cards: [{ ...card, copies: "2" }],
        next_page: null,
      };
    });
    await click(button("I reviewed the current offer"));
    await click(increase()); // Quantity 3, so lowering to 2 still differs from the reviewed quantity 1.
    expect(send().disabled).toBe(false);
    expect(button("Retry").disabled).toBe(false);
    let refusePost!: (cause: Error) => void;
    vi.mocked(counterTrade).mockImplementationOnce(
      () =>
        new Promise<TradeView>((_, no) => {
          refusePost = no;
        })
    );
    await click(send());
    // Library stays interactive during send. Retry also starts a new selected-inventory read.
    vi.mocked(getTraderTradeList).mockResolvedValue({
      trader_id: "misty",
      display_name: "Misty",
      band: null,
      completed_trades: 0,
      cards: [{ ...card, copies: "2" }],
      next_page: null,
    });
    vi.mocked(getTrade)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(replacement);
    await click(button("Retry"));
    // The obsolete selected read reuses the already-outstanding version check. Its result is newer
    // than the obsolete completion, but its request ID predates the selected-inventory request.
    await act(async () => finishCheck(original));
    const readsBeforeRelease = vi.mocked(getTrade).mock.calls.length;
    if (outcome === "refusal")
      await act(async () =>
        refusePost(
          new TradesError(409, "NOT_TRADEABLE", {
            edition_id: "Iono",
            side: "you_get",
            available: "2",
          })
        )
      );
    else {
      await act(async () => refusePost(new TypeError("lost response")));
      expect(send().disabled).toBe(false);
      await click(decrease()); // Explicit edit abandons exact replay and starts a fresh check.
    }
    expect(vi.mocked(getTrade).mock.calls.length).toBeGreaterThan(
      readsBeforeRelease
    );
    // A fresh same-version observation now returns through matching inventory without another confirmation.
    expect(
      [...host.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "I reviewed the current offer"
      )
    ).toBe(false);
    if (outcome === "refusal") await click(decrease());
    expect(send().disabled).toBe(false);
    const calls = vi.mocked(counterTrade).mock.calls.length;
    await click(send());
    expect(counterTrade).toHaveBeenCalledTimes(calls + 1);
    expect(vi.mocked(counterTrade).mock.calls.at(-1)?.[1]).toMatchObject({
      offer_id: current.offer_id,
      revision: current.revision,
      you_get: [{ edition_id: "Iono", quantity: "2" }],
    });
  }
);

it.each([false, true])(
  "announces a full library card inside Cards once, then a quantity edit once (phone=%s)",
  async (phone) => {
    vi.useFakeTimers();
    const scroll = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    try {
      vi.mocked(window.matchMedia).mockImplementation((query) => ({
        matches: phone && query.includes("max-width"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      const arven = {
        ...card,
        edition_id: "Arven",
        name: "Arven",
        set_code: "SVI",
        collector_number: "166",
        copies: "2",
      };
      vi.mocked(getTraderTradeList).mockResolvedValue({
        trader_id: "misty",
        display_name: "Misty",
        band: null,
        completed_trades: 0,
        cards: [arven],
        next_page: null,
      });
      vi.mocked(peekProposalSeed).mockReturnValue({
        give: [],
        get: [{ ...arven, quantity: 2 }],
      });
      await act(async () =>
        root.render(
          h(ToastProvider, {
            children: h(ProposalBuilderPage, {
              traderId: "misty",
              onNavigate: navigate,
            }),
          })
        )
      );
      const library = host.querySelector("aside")!;
      const tile = [...library.querySelectorAll("button")].find((b) =>
        b.getAttribute("aria-label")?.includes("Add to You get")
      )!;
      expect(tile).toBeDefined();
      expect(tile.getAttribute("aria-disabled")).toBe("true");
      await click(tile);
      await act(async () => {
        vi.advanceTimersByTime(60);
      });
      expect(library.querySelector('[role="status"]')?.textContent).toBe(
        "All 2 Arven (SVI 166) are in You get."
      );
      expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
      if (phone) {
        const proposalTab = [
          ...host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
        ].find((b) => b.textContent?.startsWith("Proposal"))!;
        await click(proposalTab);
      }
      await click(button("Decrease Arven (SVI 166) you get"));
      await act(async () => {
        vi.advanceTimersByTime(60);
      });
      expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        "Arven (SVI 166): 1 in You get"
      );
      expect(library.querySelector('[role="status"]')).toBeNull();
    } finally {
      if (scroll)
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scroll);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      vi.useRealTimers();
    }
  }
);

it.each(
  ["refusal", "edit-after-unknown"].flatMap((outcome) => [
    { outcome, changed: false, retryCheck: false },
    { outcome, changed: true, retryCheck: false },
    { outcome, changed: false, retryCheck: true },
  ])
)(
  "S1-09: quiet $outcome refreshes before Send (changed=$changed, retry=$retryCheck)",
  async ({ outcome, changed, retryCheck }) => {
    await mount();
    await click(increase());
    const reads = vi.mocked(getTrade).mock.calls.length;
    const ownReads = vi.mocked(getTradeList).mock.calls.length;
    let finish!: (offer: TradeView) => void;
    let failFresh!: (cause: Error) => void;
    vi.mocked(getTrade).mockImplementationOnce(
      () =>
        new Promise<TradeView>((resolve, reject) => {
          finish = resolve;
          failFresh = reject;
        })
    );
    vi.mocked(counterTrade).mockRejectedValueOnce(
      outcome === "refusal"
        ? new TradesError(409, "NOT_TRADEABLE", {
            edition_id: "Iono",
            side: "you_get",
            available: "1",
          })
        : new TypeError("lost response")
    );
    await click(send());
    if (outcome === "edit-after-unknown") {
      expect(send().disabled).toBe(false);
      await click(increase()); // explicit edit, still the same selected edition
    } else expect(host.textContent).toContain("can trade only 1 Iono");
    expect(vi.mocked(getTrade).mock.calls.length).toBeGreaterThan(reads);
    expect(finish).toBeTypeOf("function");
    expect(send().disabled).toBe(true);
    expect(counterTrade).toHaveBeenCalledTimes(1);
    expect(
      host.querySelector('[role="group"][aria-label="Iono (PAL 185) you get"]')
        ?.textContent
    ).toBe(outcome === "refusal" ? "2" : "3");
    if (retryCheck) {
      await act(async () => failFresh(new TypeError("fresh check offline")));
      expect(button("Retry current offer").disabled).toBe(false);
      vi.mocked(getTrade).mockImplementationOnce(
        () =>
          new Promise<TradeView>((resolve) => {
            finish = resolve;
          })
      );
      await click(button("Retry current offer"));
      expect(send().disabled).toBe(true);
    }
    current = changed ? replacement : original;
    if (!changed && outcome === "refusal")
      vi.mocked(getTraderTradeList).mockResolvedValue({
        trader_id: "misty",
        display_name: "Misty",
        band: null,
        completed_trades: 0,
        cards: [{ ...card, copies: "1" }],
        next_page: null,
      });
    await act(async () => finish(current));
    if (changed) {
      expect(send().disabled).toBe(true);
      expect(button("I reviewed the current offer").disabled).toBe(false);
      await click(send());
      expect(counterTrade).toHaveBeenCalledTimes(1);
      await click(button("I reviewed the current offer"));
      if (outcome === "refusal") await click(decrease()); // draft quantity 2 equals B; make a changed Counter
    } else {
      expect(
        [...host.querySelectorAll("button")].some(
          (b) => b.textContent?.trim() === "I reviewed the current offer"
        )
      ).toBe(false);
      if (outcome === "refusal") expect(increase().disabled).toBe(true); // refreshed cap is 2, not the previous 3
    }
    expect(vi.mocked(getTradeList).mock.calls.length).toBeGreaterThan(ownReads);
    expect(send().disabled).toBe(false);
    await click(send());
    const [first, retry] = vi.mocked(counterTrade).mock.calls;
    expect(retry[1]).toMatchObject({
      offer_id: current.offer_id,
      revision: current.revision,
      you_get: [
        {
          edition_id: "Iono",
          quantity:
            changed && outcome === "refusal"
              ? "1"
              : outcome === "refusal"
                ? "2"
                : "3",
        },
      ],
    });
    expect(retry[1].idempotency_key).not.toBe(first[1].idempotency_key);
  }
);
