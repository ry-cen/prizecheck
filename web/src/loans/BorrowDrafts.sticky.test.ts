// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDecks } from "../decks_generated";
import { getWaitingLoans } from "../social_generated";
import { TOAST_LIFETIME_MS, ToastProvider } from "../ui/Toast";
import { BorrowDraftsProvider, useBorrowDrafts } from "./BorrowDrafts";
import { RECOVERY_TEXT } from "./loanText";
import type { FlowOutcome } from "./loanIntents";

// A failure or an outcome the collector has to read, and that the page shows nowhere else, must outlast a
// confirmation's TOAST_LIFETIME_MS. Each case below is one of the Borrow Request toasts that have no Undo.
const hoisted = vi.hoisted(() => ({
  send: vi.fn(),
  blocked: { value: false },
  intents: { value: [] as unknown[] },
}));
vi.mock("./LoanRecovery", () => ({
  useLoanRecovery: () => ({
    store: {
      blockerFor: () => (hoisted.blocked.value ? { operationId: "op" } : null),
    },
    blockerFor: () => null,
    intents: hoisted.intents.value,
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
// The tray's notice for a Borrow Request that may not have been sent: pressing its button reports an outcome.
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

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let drafts!: NonNullable<ReturnType<typeof useBorrowDrafts>>;
const originals: Record<string, PropertyDescriptor | undefined> = {};

function Probe() {
  drafts = useBorrowDrafts()!;
  return null;
}
const toasts = () => host.querySelector("#app-toasts")?.textContent ?? "";
const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (node) => node.textContent === name
  )!;
const tick = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

beforeEach(async () => {
  vi.useFakeTimers();
  hoisted.blocked.value = false;
  hoisted.intents.value = [];
  hoisted.send.mockReset();
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
          userId: "sticky",
          onOpenLoan: vi.fn(),
          children: h(Probe),
        })
      )
    )
  );
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

it("the toast for a draft held back by an unfinished request stays up", async () => {
  hoisted.blocked.value = true;
  await act(async () => drafts.set(friend, card, 1, 3, "", null));
  const message = RECOVERY_TEXT.blockedDraft.replace("{name}", "Misty");
  expect(toasts()).toContain(message);
  await tick(TOAST_LIFETIME_MS * 4);
  expect(toasts()).toContain(message);
});

it("the toast for a refused request nobody can still ask for stays up", async () => {
  vi.mocked(getWaitingLoans).mockResolvedValue({ lines: [] });
  await act(async () => drafts.set(friend, card, 1, 3, "", null));
  await act(async () => drafts.review("misty"));
  hoisted.send.mockResolvedValue({
    kind: "voided",
    otherAccount: false,
    refusal: {
      status: 409,
      code: "NOT_LENDABLE",
      detail: { edition_id: "iono", available: 0 },
    },
  } satisfies FlowOutcome);
  await act(async () => button("Send Borrow Request").click());
  const message = "Misty can't lend Iono now.";
  expect(toasts()).toContain(message);
  await tick(TOAST_LIFETIME_MS * 4);
  expect(toasts()).toContain(message);
});

it.each([
  ["voided", { kind: "voided", refusal: null, otherAccount: false }],
  ["not_sent", { kind: "not_sent" }],
  ["busy", { kind: "busy" }],
  ["not_saved", { kind: "not_saved" }],
  ["no_locks", { kind: "no_locks" }],
  ["settled_elsewhere", { kind: "settled_elsewhere" }],
] as [string, FlowOutcome][])(
  "a recovered %s outcome says so until it is dismissed",
  async (_name, outcome) => {
    hoisted.intents.value = [
      { operationId: "op", scope: "borrow_request:gone" },
    ];
    await act(async () => drafts.set(friend, card, 1, 3, "", null));
    await act(async () => report(outcome));
    expect(toasts()).not.toBe("");
    const message = toasts();
    await tick(TOAST_LIFETIME_MS * 4);
    expect(toasts()).toBe(message);
  }
);

it("a recovered send is a confirmation, so it still leaves on its own", async () => {
  hoisted.intents.value = [{ operationId: "op", scope: "borrow_request:gone" }];
  await act(async () => drafts.set(friend, card, 1, 3, "", null));
  await act(async () => report({ kind: "done", response: {} }));
  expect(toasts()).toContain(RECOVERY_TEXT.done);
  await tick(TOAST_LIFETIME_MS);
  expect(toasts()).toBe("");
});
