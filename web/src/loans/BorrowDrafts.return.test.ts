// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDecks } from "../decks_generated";
import { getWaitingLoans } from "../social_generated";
import { ToastProvider } from "../ui/Toast";
import { BorrowDraftsProvider, useBorrowDrafts } from "./BorrowDrafts";
import { RECOVERY_TEXT } from "./loanText";
import type { FlowOutcome } from "./loanIntents";

// A Review that names `onSent` (the card dialog's) hears about a request the composer sent, once: not about one closed
// unsent, one recovered afterwards, or one opened from somewhere else. When it takes the confirmation over, the toast
// stays quiet and leaves focus alone.
const hoisted = vi.hoisted(() => ({
  send: vi.fn(),
  composerBlocker: { value: null as unknown },
}));
vi.mock("./LoanRecovery", () => ({
  useLoanRecovery: () => ({
    store: { blockerFor: () => null },
    blockerFor: () => hoisted.composerBlocker.value,
    intents: [],
    accountName: "Ash",
  }),
  useFlowGuard: () => ({ capture: () => 1, live: () => true }),
  useDurableSend: () => ({
    send: hoisted.send,
    fence: {
      command: { current: null },
      pending: false,
      boundary: { current: null },
    },
  }),
}));
let report!: (o: FlowOutcome) => void;
vi.mock("./PendingLoanNotice", () => ({
  PendingLoanNotice: ({
    onOutcome,
  }: {
    onOutcome: (o: FlowOutcome) => void;
  }) => {
    report = onOutcome;
    return null;
  },
}));
vi.mock("../workspace/media", () => ({
  MOBILE_QUERY: "phone",
  useMediaQuery: () => false,
}));
vi.mock("../decks_generated", () => ({ getDecks: vi.fn() }));
vi.mock("../inbox/Inbox", () => ({
  usePulseChanged: () => 0,
  useLoansChanged: () => 0,
  useNoteLoansChanged: () => vi.fn(),
}));
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getWaitingLoans: vi.fn(),
}));

const friend = {
  collector_id: "misty",
  handle: "misty",
  display_name: "Misty",
};
const card = {
  edition_id: "iono",
  name: "Iono",
  set_code: "PAL",
  collector_number: "185",
  descriptor: {},
  image_url: null,
};
const SENT = "Borrow Request sent to Misty.";

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let drafts!: NonNullable<ReturnType<typeof useBorrowDrafts>>;
const originals: Record<string, PropertyDescriptor | undefined> = {};

function Probe() {
  drafts = useBorrowDrafts()!;
  return null;
}
const toasts = () => host.querySelector("#app-toasts") as HTMLElement;
const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (node) => node.textContent === name
  )!;
const composerOpen = () =>
  host.querySelector("dialog[open]")?.textContent?.includes("Send") ?? false;
const sendBorrowRequest = () =>
  act(async () => button("Send Borrow Request").click());
const done = { kind: "done", response: {} } satisfies FlowOutcome;

beforeEach(async () => {
  vi.useFakeTimers();
  hoisted.send.mockReset();
  hoisted.composerBlocker.value = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.mocked(getWaitingLoans).mockResolvedValue({ lines: [] });
  vi.mocked(getDecks).mockResolvedValue({
    decks: [],
    owner_revision: 1,
    next_cursor: null,
  } as never);
  window.sessionStorage.clear();
  const dialog = HTMLDialogElement.prototype;
  for (const name of ["showModal", "close"] as const) {
    originals[name] = Object.getOwnPropertyDescriptor(dialog, name);
    Object.defineProperty(dialog, name, {
      configurable: true,
      writable: true,
      value(this: HTMLDialogElement) {
        if (name === "showModal") this.setAttribute("open", "");
        else this.removeAttribute("open");
      },
    });
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      h(
        ToastProvider,
        null,
        h(BorrowDraftsProvider, {
          userId: "return",
          onOpenLoan: vi.fn(),
          children: h(Probe),
        })
      )
    )
  );
  hoisted.send.mockResolvedValue(done);
  await act(async () => drafts.set(friend, card, 1, 3, "", null));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const name of ["showModal", "close"] as const) {
    const original = originals[name];
    if (original)
      Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("a sent request calls the Review's onSent once with the confirmation, and the toast keeps quiet and leaves focus", async () => {
  const onSent = vi.fn(() => true);
  await act(async () => drafts.review("misty", null, { onSent }));
  expect(composerOpen()).toBe(true);
  await sendBorrowRequest();
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(onSent).toHaveBeenCalledWith(SENT);
  expect(composerOpen()).toBe(false);
  expect(toasts().textContent).toContain(SENT);
  expect(toasts().getAttribute("aria-live")).toBe("off");
  expect(toasts().contains(document.activeElement)).toBe(false);
});

it("when onSent does not take it over, the toast announces and takes focus as it always did", async () => {
  const onSent = vi.fn(() => false);
  await act(async () => drafts.review("misty", null, { onSent }));
  await sendBorrowRequest();
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(toasts().textContent).toContain(SENT);
  expect(toasts().getAttribute("aria-live")).toBe("polite");
  expect(toasts().contains(document.activeElement)).toBe(true);
});

it("a composer opened without onSent sends as it always did", async () => {
  await act(async () => drafts.review("misty"));
  await sendBorrowRequest();
  expect(toasts().textContent).toContain(SENT);
  expect(toasts().getAttribute("aria-live")).toBe("polite");
  expect(toasts().contains(document.activeElement)).toBe(true);
});

it("a composer closed unsent forgets onSent, so a later send from elsewhere does not call it", async () => {
  const onSent = vi.fn(() => true);
  await act(async () => drafts.review("misty", null, { onSent }));
  await act(async () => button("Keep draft").click());
  expect(composerOpen()).toBe(false);
  await act(async () => drafts.review("misty"));
  await sendBorrowRequest();
  expect(onSent).not.toHaveBeenCalled();
  expect(toasts().getAttribute("aria-live")).toBe("polite");
});

it("a composer discarded forgets onSent too", async () => {
  const onSent = vi.fn(() => true);
  await act(async () => drafts.review("misty", null, { onSent }));
  await act(async () => button("Discard").click());
  await act(async () => drafts.set(friend, card, 1, 3, "", null));
  await act(async () => drafts.review("misty"));
  await sendBorrowRequest();
  expect(onSent).not.toHaveBeenCalled();
});

it("opening a composer without onSent replaces the one a Review named", async () => {
  const onSent = vi.fn(() => true);
  await act(async () => drafts.review("misty", null, { onSent }));
  await act(async () => drafts.review("misty"));
  await sendBorrowRequest();
  expect(onSent).not.toHaveBeenCalled();
});

it("a recovered send finishes as it always did, and does not call onSent", async () => {
  hoisted.composerBlocker.value = { operationId: "op" };
  const onSent = vi.fn(() => true);
  await act(async () => drafts.review("misty", null, { onSent }));
  await act(async () => report(done));
  expect(onSent).not.toHaveBeenCalled();
  expect(composerOpen()).toBe(false);
  expect(toasts().textContent).toContain(RECOVERY_TEXT.done);
  expect(toasts().getAttribute("aria-live")).toBe("polite");
  expect(toasts().contains(document.activeElement)).toBe(true);
});
