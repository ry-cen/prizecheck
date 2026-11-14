// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDecks } from "../decks_generated";
import { getWaitingLoans, type WaitingLine } from "../social_generated";
import {
  AskControl,
  BorrowDraftsProvider,
  useBorrowDrafts,
} from "./BorrowDrafts";
import { earlierFor, earlierText, useEarlierRequests } from "./earlierRequests";

const { send, toast } = vi.hoisted(() => ({
  send: vi.fn(),
  toast: { show: vi.fn(), setLift: vi.fn() },
}));
vi.mock("./LoanRecovery", () => ({
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
  useNoteLoansChanged: () => vi.fn(),
}));
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getWaitingLoans: vi.fn(),
}));

const line = (
  lender_id: string | null,
  edition_id: string,
  deck_id: string | null,
  state: "requested" | "accepted" = "requested",
  copies = "2"
): WaitingLine => ({
  lender: lender_id === "other" ? "Brock" : "Misty",
  lender_id,
  edition_id,
  deck_id,
  state,
  copies,
});

beforeEach(() => {
  pulse = 0;
  vi.resetAllMocks();
  vi.mocked(getWaitingLoans).mockResolvedValue({ lines: [] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());

it("earlierFor matches only the same lender and Edition", () => {
  const lines = [
    line("misty", "A", null),
    line("other", "A", null),
    line("misty", "B", null),
    line(null, "A", null),
    line("misty", "A", "D1", "accepted", "1"),
  ];
  expect(earlierFor(lines, "misty", "A")).toEqual([lines[0], lines[4]]);
});

it("earlierText says requested and accepted lines, with and without a place", () => {
  expect(earlierText(line("misty", "A", null), "Unsorted")).toBe(
    "Asked Misty for 2 · Unsorted"
  );
  expect(earlierText(line("misty", "A", "D", "accepted", "1"), "Sky")).toBe(
    "Misty agreed to lend 1 · Sky"
  );
  expect(earlierText(line("misty", "A", "D"), null)).toBe("Asked Misty for 2");
});

async function hook() {
  const host = document.createElement("div");
  const root = createRoot(host);
  let latest!: ReturnType<typeof useEarlierRequests>;
  function Probe() {
    latest = useEarlierRequests();
    return null;
  }
  const render = () => act(async () => root.render(h(Probe)));
  await render();
  return {
    read: () => latest,
    render,
    done: () => act(async () => root.unmount()),
  };
}

it("reads on mount, on a pulse, on return to the tab, and not while hidden", async () => {
  const view = await hook();
  try {
    expect(getWaitingLoans).toHaveBeenCalledTimes(1);
    expect(view.read().state).toBe("ready");
    pulse++;
    await view.render();
    expect(getWaitingLoans).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(getWaitingLoans).toHaveBeenCalledTimes(3);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    pulse++;
    await view.render();
    expect(getWaitingLoans).toHaveBeenCalledTimes(3);
  } finally {
    vi.restoreAllMocks();
    await view.done();
  }
});

it("a failure with no answer is failed, and one after an answer keeps the lines", async () => {
  vi.mocked(getWaitingLoans).mockRejectedValueOnce(new Error("offline"));
  const view = await hook();
  try {
    expect(view.read().state).toBe("failed");
    vi.mocked(getWaitingLoans).mockResolvedValue({
      lines: [line("misty", "A", null)],
    });
    await act(async () => view.read().retry());
    expect(view.read().state).toBe("ready");
    expect(view.read().lines).toHaveLength(1);
    vi.mocked(getWaitingLoans).mockRejectedValue(new Error("offline"));
    await act(async () => view.read().retry());
    expect(view.read().state).toBe("ready");
    expect(view.read().lines).toHaveLength(1);
  } finally {
    await view.done();
  }
});

// The composer, mounted over a draft to Misty for Iono.
async function composer(
  then: (view: {
    host: HTMLElement;
    button: (name: string) => HTMLButtonElement;
  }) => Promise<void>
) {
  vi.mocked(getDecks).mockResolvedValue({
    decks: [],
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
  const friend = {
    collector_id: "misty",
    handle: "misty",
    display_name: "Misty",
  };
  const card = (id: string) => ({
    edition_id: id,
    name: "Iono",
    set_code: "PAL",
    collector_number: id,
    descriptor: {},
    image_url: null,
  });
  function Seed() {
    const drafts = useBorrowDrafts()!;
    return h(
      "div",
      null,
      h(
        "button",
        { onClick: () => drafts.set(friend, card("A"), 1, 3, "", null) },
        "Seed"
      ),
      h(AskControl, { friend, card: card("A"), cap: 3, lendable: "" })
    );
  }
  const button = (name: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (node) => node.textContent === name
    )!;
  try {
    await act(async () =>
      root.render(
        h(BorrowDraftsProvider, {
          userId: "earlier",
          onOpenLoan: vi.fn(),
          children: h(Seed),
        })
      )
    );
    await act(async () => button("Seed").click());
    await act(async () => button("Review").click());
    await then({ host, button });
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

it("warns about an earlier request to the same Friend for the same card and still sends", async () => {
  vi.mocked(getWaitingLoans).mockResolvedValue({
    lines: [
      line("misty", "A", null),
      line("other", "A", null),
      line("misty", "B", null),
    ],
  });
  await composer(async ({ host, button }) => {
    const dialog = button("Send Borrow Request").closest("dialog")!;
    expect(
      dialog.textContent!.match(/Asked Misty for 2 · Unsorted/g)
    ).toHaveLength(1);
    expect(dialog.textContent).not.toContain("Asked Brock");
    const summary = Array.from(dialog.querySelectorAll("p")).find((p) =>
      p.textContent?.startsWith("Some of these cards are already asked for.")
    )!;
    expect(summary.textContent).toBe(
      "Some of these cards are already asked for. Sending asks Misty again."
    );
    expect(summary.getAttribute("role")).toBeNull();
    const sendButton = button("Send Borrow Request");
    expect(sendButton.getAttribute("aria-describedby")).toBe(summary.id);
    expect(sendButton.disabled).toBe(false);
    await act(async () => sendButton.click());
    expect(send).toHaveBeenCalledTimes(1);
  });
});

it("still sends when earlier requests couldn't be checked", async () => {
  vi.mocked(getWaitingLoans).mockRejectedValue(new Error("offline"));
  await composer(async ({ host, button }) => {
    const dialog = button("Send Borrow Request").closest("dialog")!;
    expect(dialog.textContent).toContain(
      "Couldn't check what you've already asked Misty for."
    );
    expect(button("Send Borrow Request").disabled).toBe(false);
    expect(dialog.querySelector('[role="status"]')).toBeNull();
    const calls = vi.mocked(getWaitingLoans).mock.calls.length;
    await act(async () =>
      dialog
        .querySelector<HTMLButtonElement>(
          '[aria-label="Retry checking earlier requests"]'
        )!
        .click()
    );
    expect(vi.mocked(getWaitingLoans).mock.calls.length).toBe(calls + 1);
  });
});
