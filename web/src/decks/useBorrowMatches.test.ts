// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getPendingLoans,
  getTradeMatch,
  getTradeMatches,
  getWaitingLoans,
  getWantListMatches,
  type PendingLoans,
  type WantListMatches,
} from "../social_generated";
import type { WantList } from "../want_list_generated";
import {
  borrowDefault,
  borrowRemainder,
  borrowOffer,
  pendingText,
} from "./pendingLoans";
import {
  pendingApi,
  readBorrowMatches,
  useBorrowMatches,
} from "./useBorrowMatches";
import {
  AskChip,
  AskControl,
  automaticDeck,
  BorrowDraftsProvider,
  useBorrowDrafts,
  useBorrowReadiness,
} from "../loans/BorrowDrafts";
import { getDecks } from "../decks_generated";
import { GetFromFriends } from "../social/WantListFriends";
import { OpenProposalContext } from "../trades/openProposal";
const { send, noteChanged, toast } = vi.hoisted(() => ({
  send: vi.fn(),
  noteChanged: vi.fn(),
  toast: { show: vi.fn(), setLift: vi.fn() },
}));
vi.mock("../loans/LoanRecovery", () => ({
  useLoanRecovery: () => ({
    store: { blockerFor: () => null },
    blockerFor: () => null,
    intents: [],
    accountName: "Ash",
  }),
  useFlowGuard: () => ({ capture: () => 1, live: () => true }),
  useDurableSend: () => ({
    send,
    fence: {
      command: { current: null },
      pending: false,
      boundary: { current: null },
    },
  }),
}));
vi.mock("../ui/Toast", () => ({ useToast: () => toast, useLift: () => 0 }));
vi.mock("../workspace/media", () => ({
  MOBILE_QUERY: "phone",
  useMediaQuery: () => false,
}));
vi.mock("../decks_generated", () => ({ getDecks: vi.fn() }));
let pulse = 0;
vi.mock("../inbox/Inbox", () => ({
  usePulseChanged: () => pulse,
  useLoansChanged: () => 0,
  useNoteLoansChanged: () => noteChanged,
}));
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getPendingLoans: vi.fn(),
  getTradeMatch: vi.fn(),
  getTradeMatches: vi.fn(),
  getWaitingLoans: vi.fn(),
  getWantListMatches: vi.fn(),
}));
const pending = (requested: string, accepted = "0"): PendingLoans => ({
  deck_id: "deck",
  lines: [
    {
      edition_id: "A",
      requested,
      accepted,
      lenders: [
        {
          lender_id: "one",
          lender: "Misty",
          state: accepted === "0" ? "requested" : "accepted",
          copies: accepted === "0" ? requested : accepted,
        },
      ],
    },
  ],
});
const matches = (spare: string): WantListMatches => ({
  has_friends: true,
  cards: [
    {
      edition_id: "A",
      copies: [
        {
          collector_id: "one",
          handle: "misty",
          display_name: "Misty",
          edition_id: "A",
          name: "Iono",
          set_code: "PAL",
          collector_number: "185",
          descriptor: {},
          other_printing: false,
          spare,
          in_deck: "0",
        },
      ],
    },
  ],
});
const list: WantList = {
  deck_id: "deck",
  want_list_counting: "all_at_once",
  settings_revision: 1,
  owner_revision: 1,
  deck_lists_digest: "pins",
  decks: [],
  sections: [],
  combined: [],
  to_get: "3",
};
beforeEach(() => {
  pulse = 0;
  vi.resetAllMocks();
  vi.mocked(getWaitingLoans).mockResolvedValue({ lines: [] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());
it("re-reads availability when a partial acceptance arrives between the paired reads", async () => {
  vi.mocked(getPendingLoans)
    .mockResolvedValueOnce(pending("2"))
    .mockResolvedValue(pending("0", "1"));
  vi.mocked(getWantListMatches)
    .mockResolvedValueOnce(matches("2"))
    .mockResolvedValue(matches("1"));
  const result = await readBorrowMatches("deck", new AbortController().signal);
  expect(getWantListMatches).toHaveBeenCalledTimes(2);
  const coverage = result.pending!.lines[0];
  const cap = borrowRemainder(
    3,
    Number(result.matches.cards[0].copies[0].spare),
    coverage,
    coverage,
    "one"
  );
  expect(cap).toBe(1);
  expect(borrowDefault(3, 1, cap)).toBe(1);
});
it("never enables an offer while pending or availability is delayed, and disables a failed refresh", async () => {
  let releasePending!: (p: PendingLoans) => void;
  let releaseMatches!: (p: WantListMatches) => void;
  vi.mocked(getPendingLoans)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePending = resolve;
        })
    )
    .mockResolvedValue(pending("1"));
  vi.mocked(getWantListMatches).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseMatches = resolve;
      })
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  function Probe() {
    const { friends, pending: read } = useBorrowMatches(list, 0);
    const known =
      friends.kind === "ready" &&
      !friends.pending &&
      read.state.kind === "ready" &&
      !read.state.stale;
    let text = "unknown";
    if (known && friends.kind === "ready" && read.state.kind === "ready") {
      const coverage = read.state.lines.get("A");
      const spare = Number(friends.byCard.get("A")![0].spare);
      const cap = borrowRemainder(3, spare, coverage, coverage, "one");
      text = `offer ${cap}, default ${borrowDefault(3, spare, cap)}`;
    }
    return h("span", null, text);
  }
  try {
    await act(async () => root.render(h(Probe)));
    expect(host.textContent).toBe("unknown");
    await act(async () => releasePending(pending("1")));
    expect(host.textContent).toBe("unknown");
    await act(async () => releaseMatches(matches("2")));
    expect(host.textContent).toBe("offer 1, default 1");
    let releaseAcceptance!: (p: PendingLoans) => void;
    vi.mocked(getPendingLoans)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseAcceptance = resolve;
          })
      )
      .mockResolvedValue(pending("0", "1"));
    vi.mocked(getWantListMatches).mockResolvedValue(matches("1"));
    pulse++;
    await act(async () => root.render(h(Probe)));
    expect(host.textContent).toBe("unknown");
    await act(async () => releaseAcceptance(pending("0", "1")));
    expect(host.textContent).toBe("offer 1, default 1");
    vi.mocked(getPendingLoans).mockRejectedValue(new Error("offline"));
    pulse++;
    await act(async () => root.render(h(Probe)));
    expect(host.textContent).toBe("unknown");
  } finally {
    await act(async () => root.unmount());
  }
});
it("keeps the Friends view up, without the old scope's cards, while another scope's answer loads", async () => {
  vi.mocked(getPendingLoans).mockResolvedValue(pending("0"));
  vi.mocked(getWantListMatches).mockResolvedValueOnce(matches("3"));
  let releaseOther!: (answer: WantListMatches) => void;
  vi.mocked(getWantListMatches).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseOther = resolve;
      })
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  function Probe({ scope }: { scope: WantList }) {
    const { friends } = useBorrowMatches(scope, 0);
    return h(
      "span",
      null,
      friends.kind === "none"
        ? "none"
        : `ready friends=${friends.hasFriends} pending=${friends.pending} cards=${friends.byCard.size}`
    );
  }
  try {
    await act(async () => root.render(h(Probe, { scope: list })));
    expect(host.textContent).toBe("ready friends=true pending=false cards=1");
    await act(async () =>
      root.render(h(Probe, { scope: { ...list, deck_id: "other" } }))
    );
    expect(host.textContent).toBe("ready friends=true pending=true cards=0");
    await act(async () => releaseOther(matches("2")));
    expect(host.textContent).toBe("ready friends=true pending=false cards=1");
  } finally {
    await act(async () => root.unmount());
  }
});
it("keeps its maps and Trade for it steady when the Want List re-renders with the same answer", async () => {
  vi.mocked(getPendingLoans).mockResolvedValue(pending("0"));
  vi.mocked(getWantListMatches).mockResolvedValue(matches("3"));
  const offer = {
    edition_id: "A",
    name: "Iono",
    set_code: "PAL",
    set_name: "Paldea Evolved",
    collector_number: "185",
    descriptor: {},
    image_url: null,
    copies: "1",
    need: "1",
    want_list_need: "1",
    origin: "want_list" as const,
    accepts_as: "exact" as const,
    need_groups: [],
  };
  vi.mocked(getTradeMatches).mockResolvedValue({
    has_friends: true,
    rows: [
      {
        collector_id: "one",
        trader_id: "t1",
        handle: "misty",
        display_name: "Misty",
        completed_trades: 0,
        open_to_cash_offers: false,
        match: "has_what_you_want",
        you_get: [offer],
        you_give: [],
        more_you_get: 0,
        more_you_give: 0,
        you_get_groups: [],
        you_give_groups: [],
      },
    ],
  });
  vi.mocked(getTradeMatch).mockReset();
  const row = {
    edition_id: "A",
    name: "Iono",
    set_id: "PAL",
    set_name: "Paldea Evolved",
    collector_number: "185",
    descriptor: {},
    image_url: null,
    need: "1",
    decks: [],
  };
  const seen: unknown[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Probe({ tick }: { tick: number }) {
    const { friends, pending: read } = useBorrowMatches(list, 0);
    const byCard = friends.kind === "ready" ? friends.byCard : new Map();
    seen.push([friends, read.state, byCard]);
    return h(
      "div",
      { "data-tick": tick },
      h(GetFromFriends, {
        rows: [row],
        byCard,
        deckName: () => "Deck",
        scoped: "deck",
        pending: false,
      })
    );
  }
  const render = (tick: number) =>
    root.render(
      h(OpenProposalContext.Provider, { value: vi.fn() }, h(Probe, { tick }))
    );
  const trade = () =>
    host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Trade for it:"]'
    );
  try {
    await act(async () => render(0));
    const button = trade();
    expect(button).not.toBeNull();
    expect(getTradeMatches).toHaveBeenCalledTimes(1);
    const before = seen.length;
    for (const tick of [1, 2, 3]) {
      await act(async () => render(tick));
      expect(trade()).toBe(button);
    }
    // Same answer in, same identities out: Trade for it re-reads on a changed Friends map only.
    expect(seen.length).toBeGreaterThan(before);
    const latest = seen.at(-1) as unknown[];
    for (const state of seen.slice(before - 1)) {
      expect((state as unknown[])[0]).toBe(latest[0]);
      expect((state as unknown[])[1]).toBe(latest[1]);
      expect((state as unknown[])[2]).toBe(latest[2]);
    }
    expect(getTradeMatches).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("refuses continually changing reads instead of guessing quantities", async () => {
  let count = 0;
  vi.mocked(getPendingLoans).mockImplementation(async () =>
    pending(String(++count))
  );
  vi.mocked(getWantListMatches).mockResolvedValue(matches("3"));
  await expect(
    readBorrowMatches("deck", new AbortController().signal)
  ).rejects.toThrow("changed during");
});

it.each(["pulse", "focus", "pins"])(
  "keeps notes, chip identity, focus and draft quantity during a %s refresh, blocking new asks and sends",
  async (trigger) => {
    let revision = 0;
    const answer = matches("3");
    answer.cards[0].copies.push({
      ...answer.cards[0].copies[0],
      collector_id: "two",
      display_name: "Brock",
    });
    vi.mocked(getPendingLoans).mockResolvedValue(pending("1"));
    vi.mocked(getWantListMatches).mockResolvedValue(answer);
    vi.mocked(getDecks).mockResolvedValue({
      decks: [],
      owner_revision: 1,
      next_cursor: null,
    });
    window.sessionStorage.clear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const dialog = HTMLDialogElement.prototype;
    const originalShow = Object.getOwnPropertyDescriptor(dialog, "showModal");
    const originalClose = Object.getOwnPropertyDescriptor(dialog, "close");
    if (!originalShow)
      Object.defineProperty(dialog, "showModal", {
        configurable: true,
        writable: true,
        value() {},
      });
    if (!originalClose)
      Object.defineProperty(dialog, "close", {
        configurable: true,
        writable: true,
        value() {},
      });
    const show = vi.spyOn(dialog, "showModal").mockImplementation(function (
      this: HTMLDialogElement
    ) {
      this.setAttribute("open", "");
    });
    const close = vi.spyOn(dialog, "close").mockImplementation(function (
      this: HTMLDialogElement
    ) {
      this.removeAttribute("open");
    });
    function Probe() {
      const { friends, pending: read } = useBorrowMatches(
        list,
        0,
        String(revision)
      );
      const note =
        read.state.kind === "ready" ? read.state.lines.get("A") : undefined;
      const copies =
        friends.kind === "ready" ? (friends.byCard.get("A") ?? []) : [];
      const current =
        friends.kind === "ready" &&
        !friends.pending &&
        read.state.kind === "ready" &&
        !read.state.stale;
      return h(
        "div",
        null,
        h("p", null, pendingText(note)),
        ...copies.map((copy) => {
          const offer = borrowOffer(3, copy, note, note);
          return h(AskChip, {
            key: copy.collector_id,
            friend: copy,
            card: { ...copy, image_url: null },
            cap: offer.cap,
            limit: offer.limit,
            initialQuantity: offer.quantity,
            current,
            more: true,
            lendable: "3 spare",
            text: copy.display_name,
            deckId: "deck",
          });
        })
      );
    }
    const render = () =>
      root.render(
        h(BorrowDraftsProvider, {
          userId: "refresh-test",
          onOpenLoan: vi.fn(),
          children: h(Probe),
        })
      );
    const button = (name: string) =>
      Array.from(host.querySelectorAll("button")).find(
        (node) => node.textContent === name
      )!;
    try {
      await act(async () => render());
      const [chip, other] = Array.from(
        host.querySelectorAll<HTMLButtonElement>("[aria-pressed]")
      );
      await act(async () => chip.click());
      expect(chip.textContent).toContain("Ask for 2 more from Misty");
      await act(async () => button("Review").click());
      const decrease = host.querySelector<HTMLButtonElement>(
        '[aria-label^="Decrease Copies of Iono,"]'
      )!;
      await act(async () => decrease.click());
      await act(async () => button("Keep draft").click());
      expect(chip.textContent).toContain("Ask for 1 more from Misty");
      chip.focus();
      let release!: (answer: PendingLoans) => void;
      vi.mocked(getPendingLoans).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      await act(async () => {
        if (trigger === "pulse") pulse++;
        else if (trigger === "pins") revision++;
        else {
          window.dispatchEvent(new Event("blur"));
          window.dispatchEvent(new Event("focus"));
        }
        render();
      });
      expect(host.textContent).toContain("Asked Misty for 1");
      expect(host.querySelectorAll("[aria-pressed]")).toHaveLength(2);
      expect(host.querySelector("[aria-pressed]")).toBe(chip);
      expect(document.activeElement).toBe(chip);
      expect(chip.getAttribute("aria-pressed")).toBe("true");
      expect(other.getAttribute("aria-disabled")).toBe("true");
      await act(async () => other.click());
      expect(other.getAttribute("aria-pressed")).toBe("false");
      await act(async () => button("Review").click());
      expect(button("Send Borrow Request").disabled).toBe(true);
      expect(
        host.querySelector('dialog [role="status"]')?.textContent
      ).toContain("Checking what's available…");
      await act(async () => button("Send Borrow Request").click());
      expect(send).not.toHaveBeenCalled();
      await act(async () => release(pending("1")));
      // A failed read must stop claiming work is in progress while the modal blocks the page Retry.
      vi.mocked(getPendingLoans).mockRejectedValueOnce(new Error("offline"));
      pulse++;
      await act(async () => render());
      const failedCopy = "Couldn't check what's available.";
      expect(
        host.querySelector('dialog [role="status"]')?.textContent
      ).toContain(failedCopy);
      expect(host.textContent).not.toContain("Close this");
      expect(host.textContent).not.toContain("Checking what's available…");
      expect(button("Send Borrow Request").disabled).toBe(true);
      await act(async () => button("Send Borrow Request").click());
      expect(send).not.toHaveBeenCalled();
      // Retry re-runs the read in place; the open composer and its draft stay as they were.
      const retried = host
        .querySelector('dialog [role="status"]')
        ?.closest("dialog");
      button("Retry").focus();
      await act(async () => button("Retry").click());
      // The Retry that held focus is gone; focus stays inside the composer, not on the page behind it.
      expect(retried?.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(document.body);
      expect(retried?.isConnected).toBe(true);
      expect(host.textContent).not.toContain(failedCopy);
      expect(host.querySelector('dialog [role="status"]')).toBeNull();
      expect(
        host.querySelector(
          '[role="group"][aria-label^="Copies of Iono,"] output'
        )?.textContent
      ).toBe("1");

      expect(button("Send Borrow Request").disabled).toBe(false);
      expect(host.textContent).not.toContain("Checking what's available…");
      expect(chip.getAttribute("aria-pressed")).toBe("true");
      expect(chip.textContent).toContain("Ask for 1 more from Misty");
      await act(async () => button("Send Borrow Request").click());
      expect(send).toHaveBeenCalledTimes(1);
      // A newly covered line keeps the chosen draft, still sendable, rather than deleting it on refresh.
      vi.mocked(getPendingLoans).mockResolvedValue(pending("3"));
      pulse++;
      await act(async () => render());
      expect(chip.isConnected).toBe(true);
      expect(chip.getAttribute("aria-pressed")).toBe("true");
      expect(chip.textContent).toContain("Ask for 1 more from Misty");
      // Covering the line later never makes the draft unsendable: only the Friend's own availability can.
      expect(button("Send Borrow Request").disabled).toBe(false);
      expect(host.textContent).not.toContain("Checking what's available…");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      show.mockRestore();
      close.mockRestore();
      if (!originalShow) Reflect.deleteProperty(dialog, "showModal");
      if (!originalClose) Reflect.deleteProperty(dialog, "close");
      window.sessionStorage.clear();
    }
  }
);

it("offers Retry in the composer when the All Decks availability read fails", async () => {
  const everyDeck: WantList = { ...list, deck_id: null };
  vi.mocked(getWantListMatches).mockResolvedValue(matches("3"));
  vi.mocked(getDecks).mockResolvedValue({
    decks: [],
    owner_revision: 1,
    next_cursor: null,
  });
  window.sessionStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const dialog = HTMLDialogElement.prototype;
  const originalShow = Object.getOwnPropertyDescriptor(dialog, "showModal");
  const originalClose = Object.getOwnPropertyDescriptor(dialog, "close");
  if (!originalShow)
    Object.defineProperty(dialog, "showModal", {
      configurable: true,
      writable: true,
      value() {},
    });
  if (!originalClose)
    Object.defineProperty(dialog, "close", {
      configurable: true,
      writable: true,
      value() {},
    });
  const show = vi.spyOn(dialog, "showModal").mockImplementation(function (
    this: HTMLDialogElement
  ) {
    this.setAttribute("open", "");
  });
  const close = vi.spyOn(dialog, "close").mockImplementation(function (
    this: HTMLDialogElement
  ) {
    this.removeAttribute("open");
  });
  function Probe() {
    const { friends, pending: read } = useBorrowMatches(everyDeck, 0);
    // All Decks has no per-Deck `state` and no page Retry here (no notice: the Friends answer is unknown).
    expect(read.state.kind).toBe("idle");
    const copies =
      friends.kind === "ready" ? (friends.byCard.get("A") ?? []) : [];
    return h(
      "div",
      null,
      ...copies.map((copy) =>
        h(AskChip, {
          key: copy.collector_id,
          friend: copy,
          card: { ...copy, image_url: null },
          cap: 3,
          initialQuantity: 2,
          current: friends.kind === "ready" && !friends.pending,
          more: true,
          lendable: "3 spare",
          text: copy.display_name,
          deckId: null,
        })
      )
    );
  }
  const render = () =>
    root.render(
      h(BorrowDraftsProvider, {
        userId: "all-decks-test",
        onOpenLoan: vi.fn(),
        children: h(Probe),
      })
    );
  const button = (name: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (node) => node.textContent === name
    )!;
  try {
    await act(async () => render());
    const chip = host.querySelector<HTMLButtonElement>("[aria-pressed]")!;
    await act(async () => chip.click());
    await act(async () => button("Review").click());
    const date = host.querySelector<HTMLInputElement>('input[type="date"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(date, "2030-01-02");
      date.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const decrease = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Decrease Copies of Iono,"]'
    )!;
    await act(async () => decrease.click());
    const quantity = () =>
      host.querySelector('[role="group"][aria-label^="Copies of Iono,"] output')
        ?.textContent;
    expect(quantity()).toBe("1");

    // The read behind the open composer fails; the page has no Retry for this scope.
    vi.mocked(getWantListMatches).mockRejectedValueOnce(new Error("offline"));
    pulse++;
    await act(async () => render());
    expect(host.querySelector('dialog [role="status"]')?.textContent).toContain(
      "Couldn't check what's available."
    );
    expect(host.textContent).not.toContain("Close this");
    expect(button("Send Borrow Request").disabled).toBe(true);
    await act(async () => button("Send Borrow Request").click());
    expect(send).not.toHaveBeenCalled();

    const composer = host
      .querySelector('dialog [role="status"]')
      ?.closest("dialog");
    button("Retry").focus();
    await act(async () => button("Retry").click());
    expect(composer?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    expect(host.querySelector('dialog [role="status"]')).toBeNull();
    expect(composer?.contains(document.activeElement)).toBe(true);
    expect(button("Send Borrow Request").disabled).toBe(false);
    expect(quantity()).toBe("1");
    expect(
      host.querySelector<HTMLInputElement>('input[type="date"]')!.value
    ).toBe("2030-01-02");
    expect(getWantListMatches).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    show.mockRestore();
    close.mockRestore();
    if (!originalShow) Reflect.deleteProperty(dialog, "showModal");
    if (!originalClose) Reflect.deleteProperty(dialog, "close");
    window.sessionStorage.clear();
  }
});

const everyDeck: WantList = { ...list, deck_id: null };
const waitingOne = (copies: string) => ({
  lines: [
    {
      lender: "Misty",
      lender_id: "one",
      edition_id: "A",
      deck_id: "D1",
      state: "requested" as const,
      copies,
    },
  ],
});
async function probe<T>(
  snapshot: (api: ReturnType<typeof useBorrowMatches>) => T,
  scope: WantList = everyDeck
) {
  const host = document.createElement("div");
  const root = createRoot(host);
  let latest!: T;
  function Probe() {
    latest = snapshot(useBorrowMatches(scope, 0));
    return null;
  }
  await act(async () => root.render(h(Probe)));
  return {
    read: () => latest,
    again: async () => act(async () => root.render(h(Probe))),
    done: () => act(async () => root.unmount()),
  };
}

it("All Decks gives each Deck its own share of what is waiting", async () => {
  vi.mocked(getWantListMatches).mockResolvedValue(matches("3"));
  vi.mocked(getWaitingLoans).mockResolvedValue(waitingOne("3"));
  const view = await probe((api) => api.pending);
  try {
    const first = view.read().forDeck("D1");
    expect(first.kind === "ready" && first.lines.get("A")?.requested).toBe("3");
    const other = view.read().forDeck("D2");
    expect(other.kind === "ready" && other.lines.size).toBe(0);
    expect(view.read().state.kind).toBe("idle");
    expect(view.read().ready).toBe(true);
    expect(view.read().notice).toBeNull();
  } finally {
    await view.done();
  }
});

it("All Decks brackets the Friends' cards with the waiting read and reads again when it moves", async () => {
  vi.mocked(getWaitingLoans)
    .mockResolvedValueOnce(waitingOne("2"))
    .mockResolvedValue(waitingOne("3"));
  vi.mocked(getWantListMatches)
    .mockResolvedValueOnce(matches("2"))
    .mockResolvedValue(matches("1"));
  const result = await readBorrowMatches(null, new AbortController().signal);
  expect(getWantListMatches).toHaveBeenCalledTimes(2);
  expect(getWantListMatches).toHaveBeenCalledWith({}, expect.anything());
  expect(getPendingLoans).not.toHaveBeenCalled();
  expect(result.pending).toBeNull();
  expect(result.waiting!.lines[0].copies).toBe("3");
});

it("a failed All Decks waiting read says so once, and a failed refresh keeps the last answer as stale", async () => {
  vi.mocked(getWantListMatches).mockResolvedValue(matches("3"));
  vi.mocked(getWaitingLoans).mockRejectedValueOnce(new Error("offline"));
  const view = await probe((api) => ({
    notice: api.pending.notice,
    deck: api.pending.forDeck("D1"),
    ready: api.pending.ready,
  }));
  try {
    expect(view.read().notice).toBe("failed");
    expect(view.read().deck.kind).toBe("failed");
    expect(view.read().ready).toBe(false);
    vi.mocked(getWaitingLoans).mockResolvedValue(waitingOne("1"));
    pulse++;
    await view.again();
    expect(view.read().notice).toBeNull();
    expect(view.read().deck.kind).toBe("ready");
    vi.mocked(getWaitingLoans).mockRejectedValueOnce(new Error("offline"));
    pulse++;
    await view.again();
    const kept = view.read().deck;
    expect(view.read().notice).toBe("stale");
    expect(kept.kind === "ready" && kept.stale).toBe(true);
  } finally {
    await view.done();
  }
});

it("a Deck in scope reports idle for any other Deck", () => {
  const state = { kind: "loading" as const, deckId: "D1" };
  const api = pendingApi(state, vi.fn());
  expect(api.forDeck("D1")).toBe(state);
  expect(api.forDeck("other")).toEqual({ kind: "idle" });
  expect(api.ready).toBe(false);
  expect(api.notice).toBeNull();
});

/** A mounted composer: dialog shims, the Decks read, and a host to drive it. */
function composerHarness() {
  vi.mocked(getDecks).mockResolvedValue({
    decks: [
      { id: "A", name: "Deck A", kind: "deck" },
      { id: "B", name: "Deck B", kind: "deck" },
    ],
    owner_revision: 1,
    next_cursor: null,
  } as never);
  window.sessionStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  const dialog = HTMLDialogElement.prototype;
  const originalShow = Object.getOwnPropertyDescriptor(dialog, "showModal");
  const originalClose = Object.getOwnPropertyDescriptor(dialog, "close");
  if (!originalShow)
    Object.defineProperty(dialog, "showModal", {
      configurable: true,
      writable: true,
      value() {},
    });
  if (!originalClose)
    Object.defineProperty(dialog, "close", {
      configurable: true,
      writable: true,
      value() {},
    });
  const show = vi.spyOn(dialog, "showModal").mockImplementation(function (
    this: HTMLDialogElement
  ) {
    this.setAttribute("open", "");
  });
  const close = vi.spyOn(dialog, "close").mockImplementation(function (
    this: HTMLDialogElement
  ) {
    this.removeAttribute("open");
  });
  return {
    host,
    get root() {
      return root;
    },
    async reload() {
      await act(async () => root.unmount());
      root = createRoot(host);
    },
    button: (name: string) =>
      Array.from(host.querySelectorAll("button")).find(
        (node) => node.textContent === name
      )!,
    async finish() {
      await act(async () => root.unmount());
      host.remove();
      show.mockRestore();
      close.mockRestore();
      if (!originalShow) Reflect.deleteProperty(dialog, "showModal");
      if (!originalClose) Reflect.deleteProperty(dialog, "close");
      window.sessionStorage.clear();
    },
  };
}
const friend = {
  collector_id: "one",
  handle: "misty",
  display_name: "Misty",
};
const cardOf = (id: string) => ({
  edition_id: id,
  name: id === "X" ? "Boss" : "Iono",
  set_code: "PAL",
  collector_number: id,
  descriptor: {},
  image_url: null,
});

it("a card needed by two Decks never leaves Send disabled by coverage alone", async () => {
  const view = composerHarness();
  function Chips() {
    const chip = (
      id: string,
      deckId: string,
      cap: number,
      limit: number,
      text: string
    ) =>
      h(AskChip, {
        key: text,
        friend,
        card: cardOf(id),
        cap,
        limit,
        initialQuantity: Math.max(1, Math.min(cap, 2)),
        lendable: "",
        text,
        deckId,
      });
    return h(
      "div",
      null,
      chip("X", "A", 1, 1, "X under A"),
      chip("Y", "B", 2, 3, "Y under B"),
      chip("Y", "A", 0, 3, "Y under A")
    );
  }
  const render = () =>
    view.root.render(
      h(BorrowDraftsProvider, {
        userId: "two-decks",
        onOpenLoan: vi.fn(),
        children: h(Chips),
      })
    );
  try {
    await act(async () => render());
    const press = (text: string) =>
      Array.from(view.host.querySelectorAll("button")).find((node) =>
        node.textContent?.includes(text)
      )!;
    await act(async () => press("X under A").click());
    await act(async () => press("Y under B").click());
    await act(async () => render());
    await act(async () => view.button("Review").click());
    // X names Deck A and Y names Deck B, so no one Deck: the collector chooses A, and A's chips then reconcile.
    const select = view.host.querySelector("select")!;
    expect(select.value).toBe("");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value"
      )!.set!.call(select, "A");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => render());
    expect(select.value).toBe("A");
    expect(
      view.host.querySelector(
        '[role="group"][aria-label^="Copies of Iono,"] output'
      )?.textContent
    ).toBe("2");
    expect(
      view.host.querySelector<HTMLButtonElement>(
        '[aria-label^="Increase Copies of Iono,"]'
      )!.disabled
    ).toBe(true);
    expect(view.button("Send Borrow Request").disabled).toBe(false);
    await act(async () => view.button("Send Borrow Request").click());
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    await view.finish();
  }
});

it("an AskControl stepper never stores a cap under the line's quantity", async () => {
  const view = composerHarness();
  function Seed() {
    const drafts = useBorrowDrafts()!;
    return h(
      "div",
      null,
      h(
        "button",
        {
          onClick: () => drafts.set(friend, cardOf("Y"), 2, 2, "", "A"),
        },
        "Seed"
      ),
      h(AskControl, {
        friend,
        card: cardOf("Y"),
        cap: 0,
        limit: 3,
        lendable: "",
        deckId: null,
      })
    );
  }
  try {
    await act(async () =>
      view.root.render(
        h(BorrowDraftsProvider, {
          userId: "stepper",
          onOpenLoan: vi.fn(),
          children: h(Seed),
        })
      )
    );
    await act(async () => view.button("Seed").click());
    await act(async () =>
      view.host
        .querySelector<HTMLButtonElement>(
          '[aria-label^="Decrease Copies of Iono to ask"]'
        )!
        .click()
    );
    await act(async () => view.button("Review").click());
    expect(
      view.host.querySelector(
        '[role="group"][aria-label^="Copies of Iono,"] output'
      )?.textContent
    ).toBe("1");
    expect(view.button("Send Borrow Request").disabled).toBe(false);
  } finally {
    await view.finish();
  }
});

it("a failed All Decks waiting read blocks sends until a read succeeds", async () => {
  vi.mocked(getWantListMatches).mockResolvedValue(matches("3"));
  const view = composerHarness();
  function Probe() {
    const { friends } = useBorrowMatches(everyDeck, 0);
    const copies =
      friends.kind === "ready" ? (friends.byCard.get("A") ?? []) : [];
    return h(
      "div",
      null,
      ...copies.map((copy) =>
        h(AskChip, {
          key: copy.collector_id,
          friend: copy,
          card: { ...copy, image_url: null },
          cap: 3,
          initialQuantity: 1,
          current: friends.kind === "ready" && !friends.pending,
          lendable: "3 spare",
          text: copy.display_name,
          deckId: null,
        })
      )
    );
  }
  const render = () =>
    view.root.render(
      h(BorrowDraftsProvider, {
        userId: "failed-waiting",
        onOpenLoan: vi.fn(),
        children: h(Probe),
      })
    );
  try {
    await act(async () => render());
    await act(async () =>
      view.host.querySelector<HTMLButtonElement>("[aria-pressed]")!.click()
    );
    await act(async () => view.button("Review").click());
    expect(view.button("Send Borrow Request").disabled).toBe(false);
    vi.mocked(getWaitingLoans).mockRejectedValue(new Error("offline"));
    pulse++;
    await act(async () => render());
    const status = view.host.querySelector('dialog [role="status"]')!;
    expect(status.textContent).toContain("Couldn't check what's available.");
    expect(view.button("Send Borrow Request").disabled).toBe(true);
    vi.mocked(getWaitingLoans).mockResolvedValue({ lines: [] });
    await act(async () =>
      status.parentElement!.querySelector("button")!.click()
    );
    expect(view.host.querySelector('dialog [role="status"]')).toBeNull();
    expect(view.button("Send Borrow Request").disabled).toBe(false);
  } finally {
    await view.finish();
  }
});

it("the automatic For Deck is the one Deck every card names, else none", () => {
  const lines = (...decks: (string | null)[]) =>
    decks.map((deck) => ({ deck }));
  expect(automaticDeck(lines("A"))).toBe("A");
  expect(automaticDeck(lines("A", "A"))).toBe("A");
  expect(automaticDeck(lines("A", "B"))).toBeNull();
  expect(automaticDeck(lines("A", null))).toBeNull();
  expect(automaticDeck(lines(null))).toBeNull();
  expect(automaticDeck([])).toBeNull();
});

/** A draft to Misty driven through `set`, with the composer's For Deck select. */
function forDeckHarness(userId = "for-deck") {
  const view = composerHarness();
  let drafts!: NonNullable<ReturnType<typeof useBorrowDrafts>>;
  function Grab() {
    drafts = useBorrowDrafts()!;
    return null;
  }
  const mount = () =>
    act(async () =>
      view.root.render(
        h(BorrowDraftsProvider, {
          userId,
          onOpenLoan: vi.fn(),
          children: h(Grab),
        })
      )
    );
  return {
    ...view,
    mount,
    ask: (id: string, deck: string | null, quantity = 1) =>
      act(async () => drafts.set(friend, cardOf(id), quantity, 3, "", deck)),
    draft: () => drafts.drafts[0],
    async pick(value: string) {
      await act(async () => view.button("Review").click());
      const select = view.host.querySelector("select")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          "value"
        )!.set!.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    },
  };
}

it("For Deck follows the cards until the collector chooses", async () => {
  const view = forDeckHarness();
  try {
    await view.mount();
    // Two cards with the same sole Deck; a section chip's Deck counts as the card's sole Deck.
    await view.ask("X", "A");
    expect([view.draft().deckId, view.draft().deckChosen]).toEqual([
      "A",
      false,
    ]);
    await view.ask("Y", "A");
    expect(view.draft().deckId).toBe("A");
    // A card with another sole Deck, or none, leaves no one Deck; taking it out brings the Deck back.
    await view.ask("Z", "B");
    expect(view.draft().deckId).toBeNull();
    await view.ask("Z", "B", 0);
    expect(view.draft().deckId).toBe("A");
    await view.ask("W", null);
    expect(view.draft().deckId).toBeNull();
    await view.ask("W", null, 0);
    expect(view.draft().deckId).toBe("A");
  } finally {
    await view.finish();
  }
});

it("a chosen Deck, or an explicit No Deck, is kept as cards change and survives a reload", async () => {
  const view = forDeckHarness();
  try {
    await view.mount();
    await view.ask("X", "A");
    await view.pick("B");
    expect([view.draft().deckId, view.draft().deckChosen]).toEqual(["B", true]);
    await view.ask("Y", "A");
    await view.ask("Z", null);
    expect(view.draft().deckId).toBe("B");
    // A reload reads the draft back from the tab's storage with its choice.
    await view.reload();
    await view.mount();
    expect([view.draft().deckId, view.draft().deckChosen]).toEqual(["B", true]);
    await view.pick("");
    expect([view.draft().deckId, view.draft().deckChosen]).toEqual([
      null,
      true,
    ]);
    // Every card now names Deck A, but No Deck was chosen on purpose.
    await view.ask("Z", null, 0);
    await view.ask("W", "A");
    expect(view.draft().deckId).toBeNull();
  } finally {
    await view.finish();
  }
});

const line = (id: string, deck?: string | null) => ({
  ...cardOf(id),
  quantity: 1,
  cap: 3,
  lendable: "",
  ...(deck === undefined ? {} : { deck }),
});
const stored = (draft: object) =>
  window.sessionStorage.setItem(
    "prizecheck.borrowDrafts.for-deck",
    JSON.stringify([
      { friend, returnBy: "", replaces: null, deckChosen: false, ...draft },
    ])
  );

it("a card's own Deck is fixed when its line is added, and a card with no Deck makes the draft No Deck", async () => {
  const view = forDeckHarness();
  try {
    await view.mount();
    await view.ask("X", "A");
    await view.ask("X", "B", 2);
    expect(view.draft().lines[0].deck).toBe("A");
    expect(view.draft().deckId).toBe("A");
    // The card popup and a Friend's page name no Deck.
    await view.ask("Y", null);
    expect(view.draft().deckId).toBeNull();
  } finally {
    await view.finish();
  }
});

it("a flip between a Deck and No Deck leaves every line's quantity and cap alone", async () => {
  const view = forDeckHarness();
  try {
    await view.mount();
    await view.ask("X", "A", 2);
    const before = view.draft().lines[0];
    await view.ask("Y", null);
    expect(view.draft().deckId).toBeNull();
    expect(view.draft().lines[0]).toEqual(before);
    await view.ask("Y", null, 0);
    expect(view.draft().deckId).toBe("A");
    expect(view.draft().lines).toEqual([before]);
  } finally {
    await view.finish();
  }
});

it("a draft kept before the flag, or one that edits a request, keeps its Deck as the collector's choice", async () => {
  const view = forDeckHarness();
  try {
    stored({ deckId: "A", deckChosen: undefined, lines: [line("X")] });
    await view.mount();
    expect([view.draft().deckId, view.draft().deckChosen]).toEqual(["A", true]);
    await view.ask("Y", null);
    expect(view.draft().deckId).toBe("A");
    await view.reload();
    stored({
      deckId: "B",
      deckChosen: false,
      replaces: "loan",
      lines: [line("X", "B")],
    });
    await view.mount();
    expect([view.draft().deckId, view.draft().deckChosen]).toEqual(["B", true]);
  } finally {
    await view.finish();
  }
});

it("discarding or stepping the last line to 0 starts the next draft with its own automatic Deck", async () => {
  const view = forDeckHarness();
  try {
    await view.mount();
    await view.ask("X", "A");
    await view.pick("B");
    expect(view.draft().deckChosen).toBe(true);
    await act(async () => view.button("Discard").click());
    expect(view.draft()).toBeUndefined();
    await view.ask("Y", "A");
    expect([view.draft().deckId, view.draft().deckChosen]).toEqual([
      "A",
      false,
    ]);
    await view.ask("Y", "A", 0);
    await view.ask("Z", null);
    expect([view.draft().deckId, view.draft().deckChosen]).toEqual([
      null,
      false,
    ]);
  } finally {
    await view.finish();
  }
});

it("after the Deck is gone the draft stays No Deck as cards join", async () => {
  const view = forDeckHarness();
  try {
    await view.mount();
    await view.ask("X", "A");
    send.mockResolvedValue({
      kind: "voided",
      otherAccount: false,
      refusal: { status: 404, code: "DECK_NOT_FOUND", detail: {} },
    });
    await act(async () => view.button("Review").click());
    await act(async () => view.button("Send Borrow Request").click());
    expect(view.draft().deckId).toBeNull();
    expect(view.draft().deckChosen).toBe(true);
    expect(view.draft().lines.map((item) => item.deck)).toEqual([null]);
    await view.ask("Y", "A");
    expect(view.draft().deckId).toBeNull();
  } finally {
    await view.finish();
  }
});

it("a draft that flips from a Deck to No Deck stops waiting on that Deck's failed read", async () => {
  const view = composerHarness();
  let drafts!: NonNullable<ReturnType<typeof useBorrowDrafts>>;
  function Gate() {
    drafts = useBorrowDrafts()!;
    useBorrowReadiness("A", "failed", vi.fn());
    return null;
  }
  try {
    await act(async () =>
      view.root.render(
        h(BorrowDraftsProvider, {
          userId: "for-deck",
          onOpenLoan: vi.fn(),
          children: h(Gate),
        })
      )
    );
    await act(async () => drafts.set(friend, cardOf("X"), 1, 3, "", "A"));
    await act(async () => view.button("Review").click());
    expect(view.button("Send Borrow Request").disabled).toBe(true);
    expect(
      view.host.querySelector('dialog [role="status"]')?.textContent
    ).toContain("Couldn't check what's available.");
    await act(async () => drafts.set(friend, cardOf("Y"), 1, 3, "", null));
    expect(view.button("Send Borrow Request").disabled).toBe(false);
    expect(view.host.querySelector('dialog [role="status"]')).toBeNull();
  } finally {
    await view.finish();
  }
});
