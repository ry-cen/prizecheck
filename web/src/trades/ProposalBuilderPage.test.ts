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
  expect(host.querySelector("output")?.textContent).toBe("2");
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
  expect(host.querySelector("output")?.textContent).toBe("2");
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
  expect(host.querySelector("output")?.textContent).toBe("2");
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
  expect(host.querySelector("output")?.getAttribute("role")).toBe("none");
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
