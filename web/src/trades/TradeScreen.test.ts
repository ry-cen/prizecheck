// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TradeView } from "../social_generated";
import {
  getTrade,
  cancelTrade,
  declineTrade,
  withdrawTrade,
  SocialError,
} from "../social_generated";
import { acceptTrade, confirmSwap, getTradeSide } from "../trades_generated";
import { ListDetailLayout } from "../ui/ListDetailLayout";
import { ToastProvider } from "../ui/Toast";
import { TradeScreen } from "./TradeScreen";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getTrade: vi.fn(),
  cancelTrade: vi.fn(),
  declineTrade: vi.fn(),
  withdrawTrade: vi.fn(),
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

it("asks before declining a proposal, and Keep it leaves it open", async () => {
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
  expect(declineTrade).not.toHaveBeenCalled();
  const sure = host.querySelector('[role="group"][aria-label="Decline"]')!;
  expect(sure.textContent).toContain("You can't undo it");
  expect(document.activeElement).toBe(sure.querySelector("p"));
  const keep = [...sure.querySelectorAll("button")].find(
    (button) => button.textContent === "Keep it"
  )!;
  await act(async () =>
    keep.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
  );
  expect(declineTrade).not.toHaveBeenCalled();
  expect(host.querySelector('[role="group"][aria-label="Decline"]')).toBeNull();
  const again = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Decline"
  )!;
  expect(document.activeElement).toBe(again);
  await act(async () => again.click());
  const yes = [
    ...host
      .querySelector('[role="group"][aria-label="Decline"]')!
      .querySelectorAll("button"),
  ].find((button) => button.textContent === "Decline")!;
  await act(async () => yes.click());
  expect(declineTrade).toHaveBeenCalledTimes(1);
  expect(declineTrade).toHaveBeenCalledWith(
    "item",
    expect.objectContaining({ offer_id: "old-round", revision: 1 })
  );
  expect(host.querySelector('[role="group"][aria-label="Decline"]')).toBeNull();
});
it("closes the Decline question and focuses the heading when the Trade has moved on", async () => {
  vi.mocked(getTrade)
    .mockResolvedValueOnce({ ...trade, actions: ["decline"] })
    .mockResolvedValue({
      ...trade,
      state: "closed",
      actions: [],
      closed_reason: "withdrawn",
    });
  vi.mocked(declineTrade).mockRejectedValue(
    new SocialError(409, "TRADE_CHANGED")
  );
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
  const press = async (label: string, within: ParentNode = host) =>
    act(async () =>
      [...within.querySelectorAll("button")]
        .find((button) => button.textContent === label)!
        .click()
    );
  await press("Decline");
  await press(
    "Decline",
    host.querySelector('[role="group"][aria-label="Decline"]')!
  );
  expect(declineTrade).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="group"][aria-label="Decline"]')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector("h1, h2"));
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
  expect(confirmSwap).not.toHaveBeenCalled();
  expect(disclosure.textContent).toContain(
    "Confirm the swap with Misty? You can't undo it."
  );
  expect(document.activeElement?.textContent).toBe(
    "Confirm the swap with Misty? You can't undo it."
  );
  await act(async () =>
    [...disclosure.querySelectorAll("button")]
      .find((b) => b.textContent === "Not yet")!
      .click()
  );
  expect(document.activeElement).toBe(buttons[0]);
  await act(async () => buttons[0].click());
  await act(async () =>
    disclosure
      .querySelector('[role="group"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
  );
  expect(document.activeElement).toBe(buttons[0]);
  await act(async () => buttons[0].click());
  const yes = disclosure.querySelector(
    '[role="group"] button'
  ) as HTMLButtonElement;
  await act(async () => {
    yes.click();
    yes.click();
  });
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

it("S2-08: keeps compact phone terms together and every consent fact before the one swap action", async () => {
  const card = {
    edition_id: "iono",
    name: "Iono",
    set_code: "PAL",
    set_name: "Paldea Evolved",
    collector_number: "185",
    descriptor: { finish: "normal" },
    image_url: null,
    copies: "1",
  };
  vi.mocked(getTrade).mockResolvedValue({
    ...trade,
    state: "accepted",
    you_give: [card],
    you_get: [
      {
        ...card,
        edition_id: "arven",
        name: "Arven",
        set_code: "SVI",
        collector_number: "166",
      },
    ],
    actions: ["confirm_swap"],
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
  const give = host.querySelector('ul[aria-label="You give"]')!,
    get = host.querySelector('ul[aria-label="You get"]')!;
  const terms = give.parentElement!.parentElement!;
  expect(terms.contains(get)).toBe(true);
  expect(terms.classList.contains("phone:grid-cols-2")).toBe(true);
  expect(give.textContent).toContain("×1");
  expect(get.textContent).toContain("×1");
  const disclosure = host.querySelector(
      '[aria-label="Confirm swap with Misty"]'
    )!,
    confirm = [...disclosure.querySelectorAll("button")].find(
      (b) => b.textContent === "Confirm swap"
    )!;
  expect(
    [...host.querySelectorAll("button")].filter(
      (b) => b.textContent === "Confirm swap"
    )
  ).toHaveLength(1);
  for (const text of [
    "Leaves your Collection: 1 Iono (PAL 185)",
    "Arrives in Unsorted: 1 Arven (SVI 166)",
    "Only confirm after the physical swap",
    "The swap can't be undone.",
    "Your destination, picks and Deck switches are private.",
  ]) {
    const paragraph = [...disclosure.querySelectorAll("p")].find((p) =>
      p.textContent!.includes(text)
    )!;
    expect(paragraph, text).toBeDefined();
    expect(
      paragraph.compareDocumentPosition(confirm) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  }
  expect(
    disclosure.querySelector("select")?.getAttribute("disabled")
  ).toBeNull();
  expect(disclosure.textContent).toContain(
    "Only confirm after the physical swap. The swap can't be undone."
  );
  expect(disclosure.textContent).not.toContain("Deck switches you ticked");
  expect(confirmSwap).not.toHaveBeenCalled();
});

async function openWithdraw() {
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
  vi.stubGlobal("visualViewport", {
    offsetLeft: 0,
    offsetTop: 0,
    width: 1024,
    height: 768,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const opener = host.querySelector<HTMLButtonElement>(
    '[aria-label="More for this Trade"]'
  )!;
  vi.spyOn(opener, "getBoundingClientRect").mockReturnValue(
    new DOMRect(20, 20, 30, 30)
  );
  await act(async () => opener.click());
  await act(async () =>
    document.querySelector<HTMLElement>('[role="menuitem"]')!.click()
  );
}
function withdrawQuestion() {
  return host.querySelector('[role="group"][aria-label="Withdraw"]')!;
}
it("asks before withdrawing, Keep it restores focus, and double confirmation sends once", async () => {
  vi.mocked(getTrade).mockResolvedValue({
    ...trade,
    role: "proposer",
    actions: ["withdraw"],
  });
  let finish!: (value: TradeView) => void;
  vi.mocked(withdrawTrade).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await openWithdraw();
  expect(withdrawTrade).not.toHaveBeenCalled();
  const question = withdrawQuestion();
  expect(question).not.toBeNull();
  expect(question.textContent).toContain(
    "Withdraw this Trade Proposal to Misty? None of these cards stay promised."
  );
  const yes = question.querySelector("button")!;
  // Initial focus reads the ask; the irreversible button remains the next Tab stop.
  expect(document.activeElement).toBe(question.querySelector("p"));
  await act(async () =>
    [...question.querySelectorAll("button")]
      .find((b) => b.textContent === "Keep it")!
      .click()
  );
  expect(withdrawTrade).not.toHaveBeenCalled();
  expect(withdrawQuestion()).toBeNull();
  const menu = host.querySelector<HTMLButtonElement>(
    '[aria-label="More for this Trade"]'
  )!;
  expect(document.activeElement).toBe(menu);
  await act(async () => menu.click());
  await act(async () =>
    document.querySelector<HTMLElement>('[role="menuitem"]')!.click()
  );
  const confirm = withdrawQuestion().querySelector("button")!;
  await act(async () => confirm.click());
  expect(confirm.getAttribute("aria-disabled")).toBe("true");
  await act(async () => confirm.click());
  expect(withdrawTrade).toHaveBeenCalledTimes(1);
  expect(withdrawTrade).toHaveBeenCalledWith(
    "item",
    expect.objectContaining({ offer_id: "old-round", revision: 1 })
  );
  await act(async () =>
    finish({
      ...trade,
      role: "proposer",
      state: "closed",
      closed_reason: "withdrawn",
      actions: [],
    })
  );
  expect(withdrawQuestion()).toBeNull();
  expect(document.activeElement).toBe(host.querySelector("h1, h2"));
  expect(host.querySelector("h1, h2")?.textContent).toContain(
    "withdrew this Trade Proposal"
  );
});
it("re-reads a refused withdrawal and focuses the heading", async () => {
  vi.mocked(getTrade)
    .mockResolvedValueOnce({
      ...trade,
      role: "proposer",
      actions: ["withdraw"],
    })
    .mockResolvedValue({ ...trade, state: "accepted", actions: [] });
  vi.mocked(withdrawTrade).mockRejectedValue(
    new SocialError(409, "TRADE_CHANGED")
  );
  await openWithdraw();
  expect(withdrawQuestion()).not.toBeNull();
  expect(withdrawTrade).not.toHaveBeenCalled();
  vi.mocked(getTrade).mockClear();
  await act(async () =>
    withdrawQuestion().querySelector<HTMLButtonElement>("button")!.click()
  );
  expect(withdrawTrade).toHaveBeenCalledTimes(1);
  expect(getTrade).toHaveBeenCalledWith("item", expect.any(AbortSignal));
  expect(withdrawQuestion()).toBeNull();
  expect(document.activeElement).toBe(host.querySelector("h1, h2"));
  expect(host.textContent).toContain(
    "This Trade has changed. Check it and try again."
  );
});
it.each(["withdraw", "cancel"] as const)(
  "Escape dismisses %s and restores the menu opener",
  async (action) => {
    vi.mocked(getTrade).mockResolvedValue({
      ...trade,
      role: "proposer",
      state: action === "cancel" ? "accepted" : "proposed",
      actions: [action],
    });
    await openWithdraw();
    const question = host.querySelector(
      '[role="group"][aria-label="' +
        (action === "cancel" ? "Cancel Trade" : "Withdraw") +
        '"]'
    )!;
    expect(question).not.toBeNull();
    await act(async () =>
      question
        .querySelector("button")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        )
    );
    expect(question.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      host.querySelector('[aria-label="More for this Trade"]')
    );
    expect(withdrawTrade).not.toHaveBeenCalled();
  }
);

it.each(["decline", "withdraw", "cancel"] as const)(
  "pending %s consumes Escape and ignores Keep it",
  async (action) => {
    const request =
      action === "decline"
        ? declineTrade
        : action === "withdraw"
          ? withdrawTrade
          : cancelTrade;
    let finish!: (value: TradeView) => void;
    vi.mocked(request).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    vi.mocked(getTrade).mockResolvedValue({
      ...trade,
      role: action === "decline" ? "recipient" : "proposer",
      state: action === "cancel" ? "accepted" : "proposed",
      actions: [action],
    });
    if (action === "decline") {
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
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent === "Decline")!
          .click()
      );
    } else await openWithdraw();
    const label =
      action === "cancel"
        ? "Cancel Trade"
        : action === "decline"
          ? "Decline"
          : "Withdraw";
    const question = host.querySelector(
      `[role="group"][aria-label="${label}"]`
    )!;
    const yes = question.querySelector("button")!;
    const keep = [...question.querySelectorAll("button")].find(
      (b) => b.textContent === "Keep it"
    )!;
    await act(async () => yes.click());
    expect(request).toHaveBeenCalledTimes(1);
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => yes.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(question.getAttribute("aria-label")).toBe(label);
    expect(question.isConnected).toBe(true);
    // Initial focus reads the ask; the irreversible button remains the next Tab stop.
    expect(document.activeElement).toBe(question.querySelector("p"));
    await act(async () => keep.click());
    expect(question.getAttribute("aria-label")).toBe(label);
    expect(question.isConnected).toBe(true);
    expect(keep.getAttribute("aria-disabled")).toBe("true");
    await act(async () => finish({ ...trade, state: "closed", actions: [] }));
    expect(question.isConnected).toBe(false);
  }
);

it("keeps the Friend handle link free of leading whitespace", async () => {
  vi.mocked(getTrade).mockResolvedValue({
    ...trade,
    state: "closed",
    closed_reason: "declined",
    closed_by: "you",
    actions: [],
    other: { ...trade.other, friend: true, handle: "misty" },
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
  const link = host.querySelector('a[href="/friends/misty"]')!;
  expect(link.textContent).toBe("@misty");
  expect(link.parentElement?.textContent).toBe("Trade with Misty @misty");
});
it("names ticked Deck switches only when they are shown", async () => {
  const card = {
    edition_id: "iono",
    name: "Iono",
    set_code: "PAL",
    set_name: "Paldea Evolved",
    collector_number: "185",
    descriptor: { finish: "normal" },
    image_url: null,
    copies: "1",
  };
  vi.mocked(getTrade).mockResolvedValue({
    ...trade,
    state: "accepted",
    you_give: [card],
    you_get: [
      {
        ...card,
        edition_id: "arven",
        name: "Arven",
        set_code: "SVI",
        collector_number: "166",
      },
    ],
    actions: ["confirm_swap"],
  });
  vi.mocked(getTradeSide).mockResolvedValue({
    trade_id: "old-round",
    picks: [],
    suggested: [],
    deck_switches: [
      {
        deck_id: "deck",
        deck_name: "My Deck",
        from_edition_id: "iono",
        to_edition_id: "arven",
        count: "1",
        from_card: card,
        to_card: { ...card, edition_id: "arven", name: "Arven" },
      },
    ],
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
  const give = host.querySelector('ul[aria-label="You give"]')!,
    get = host.querySelector('ul[aria-label="You get"]')!;
  const terms = give.parentElement!.parentElement!;
  expect(terms.contains(get)).toBe(true);
  expect(terms.classList.contains("phone:grid-cols-2")).toBe(true);
  expect(give.textContent).toContain("×1");
  expect(get.textContent).toContain("×1");
  const disclosure = host.querySelector(
      '[aria-label="Confirm swap with Misty"]'
    )!,
    confirm = [...disclosure.querySelectorAll("button")].find(
      (b) => b.textContent === "Confirm swap"
    )!;
  expect(
    [...host.querySelectorAll("button")].filter(
      (b) => b.textContent === "Confirm swap"
    )
  ).toHaveLength(1);
  expect(disclosure.textContent).toContain(
    "The Deck switches you ticked happen when you confirm."
  );
  const checkbox = disclosure.querySelector(
    'input[type="checkbox"]'
  ) as HTMLInputElement;
  await act(async () => checkbox.click());
  expect(disclosure.textContent).not.toContain("Deck switches you ticked");
  expect(disclosure.textContent).toContain(
    "Only confirm after the physical swap. The swap can't be undone."
  );
});
