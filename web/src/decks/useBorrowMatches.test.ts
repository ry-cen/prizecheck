// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getPendingLoans,
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
import { readBorrowMatches, useBorrowMatches } from "./useBorrowMatches";
import { AskChip, BorrowDraftsProvider } from "../loans/BorrowDrafts";
import { getDecks } from "../decks_generated";
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
      const retried = host.querySelector("dialog");
      await act(async () => button("Retry").click());
      expect(host.querySelector("dialog")).toBe(retried);
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
      // A newly covered line keeps the chosen draft for review/removal, rather than deleting it on refresh.
      vi.mocked(getPendingLoans).mockResolvedValue(pending("3"));
      pulse++;
      await act(async () => render());
      expect(chip.isConnected).toBe(true);
      expect(chip.getAttribute("aria-pressed")).toBe("true");
      expect(chip.textContent).toContain("Ask for 1 more from Misty");
      expect(button("Send Borrow Request").disabled).toBe(true);
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
    // The All Decks Want List has no pending read, so the page shows no Retry of its own.
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

    await act(async () => button("Retry").click());
    expect(host.querySelector('dialog [role="status"]')).toBeNull();
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
