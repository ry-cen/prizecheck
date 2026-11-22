// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BorrowedDialog } from "./BorrowedDialog";
import { LendOfferDialog } from "./LendOfferDialog";
import { LoanRecoveryProvider } from "./LoanRecovery";
import { fixture, deferred } from "./testing/loanFakes";
import { createLoanIntentStore, createTabContext } from "./loanIntents";
import { indexLocations } from "../workspace/locationTree";

vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getBorrowed: vi.fn(),
  getFriends: vi.fn(),
}));
import { getBorrowed, getFriends } from "../social_generated";

const MOVE = "/api/loans/borrowed/move";
const OFFER = "/api/loans/offers";
const box = {
  id: "box",
  name: "Box",
  kind: "storage",
  parent_id: null,
  version: 1,
  depth: 0,
};
const card = {
  loan_id: "loan",
  edition_id: "card",
  name: "Iono",
  set_code: "PAL",
  set_name: "Paldea Evolved",
  collector_number: "185",
  descriptor: {},
  image_url: null,
  location_id: "old-box",
  location_name: "Old box",
  copies: "1",
  lender: "Misty W.",
};

let host: HTMLDivElement;
let root: Root;
let descriptors: (PropertyDescriptor | undefined)[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const proto = HTMLDialogElement.prototype;
  descriptors = ["showModal", "close"].map((name) =>
    Object.getOwnPropertyDescriptor(proto, name)
  );
  Object.defineProperty(proto, "showModal", {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  Object.defineProperty(proto, "close", {
    configurable: true,
    value() {
      this.open = false;
    },
  });
  vi.mocked(getBorrowed).mockResolvedValue({ cards: [card], copies: "1" });
  vi.mocked(getFriends).mockResolvedValue({ friends: [] } as never);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  ["showModal", "close"].forEach((name, i) => {
    const descriptor = descriptors[i];
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const flush = () => act(async () => {});
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
const statuses = () =>
  [...host.querySelectorAll('[role="status"]')]
    .map((e) => e.textContent?.trim())
    .filter(Boolean);
const alerts = () =>
  [...host.querySelectorAll('[role="alert"]')]
    .map((e) => e.textContent?.trim())
    .filter(Boolean);

/** A saved intent whose answer was lost, so the dialog opens on a recovery notice. */
async function lostIntent(
  f: ReturnType<typeof fixture>,
  tab: ReturnType<typeof createTabContext>,
  draft: Parameters<ReturnType<typeof createLoanIntentStore>["send"]>[1]
) {
  const store = createLoanIntentStore("A", f.ports, tab);
  try {
    f.server.loseNextAnswer = true;
    expect((await store.send(store.bind()!, draft)).kind).toBe("pending");
  } finally {
    store.dispose();
  }
}
const lostMove = (
  f: ReturnType<typeof fixture>,
  tab: ReturnType<typeof createTabContext>
) =>
  lostIntent(f, tab, {
    kind: "move_borrowed",
    scope: "move_borrowed",
    path: MOVE,
    fields: {
      loan_id: "loan",
      edition_id: "card",
      from_location_id: "old-box",
      to_location_id: "box",
      quantity: "1",
    },
  });

function borrowed(
  f: ReturnType<typeof fixture>,
  tab: ReturnType<typeof createTabContext>,
  onMoved: () => void
) {
  return (open: boolean) =>
    h(LoanRecoveryProvider, {
      accountId: "A",
      accountName: "Ana",
      ports: f.ports,
      tab,
      children: h(BorrowedDialog, {
        open,
        onClose: vi.fn(),
        onMoved,
        index: indexLocations([box]),
      }),
    });
}

it("Borrowed: a recovery that finishes after the dialog closed still refreshes Collection", async () => {
  const f = fixture(),
    tab = createTabContext(),
    onMoved = vi.fn();
  await lostMove(f, tab);
  const render = borrowed(f, tab, onMoved);
  await act(async () => root.render(render(true)));
  const gate = deferred();
  f.server.gate = (path) => (path === MOVE ? gate.promise : undefined);
  await act(async () => {
    button("Send it again").click();
  });
  expect(onMoved).not.toHaveBeenCalled();
  await act(async () => root.render(render(false)));
  expect(statuses()).toEqual([]);
  await act(async () => {
    gate.resolve();
  });
  await flush();
  expect(onMoved).toHaveBeenCalledTimes(1);
  expect(statuses()).toEqual([]);
  expect(alerts()).toEqual([]);
});

it("Borrowed: a confirmed recovery says it was sent in a status, not an alert", async () => {
  const f = fixture(),
    tab = createTabContext(),
    onMoved = vi.fn();
  await lostMove(f, tab);
  await act(async () => root.render(borrowed(f, tab, onMoved)(true)));
  await act(async () => {
    button("Send it again").click();
  });
  await flush();
  expect(onMoved).toHaveBeenCalledTimes(1);
  expect(statuses()).toContain("It was sent.");
  expect(alerts()).toEqual([]);
});

it("Borrowed: an ordinary Move that lands does not say it was sent", async () => {
  const f = fixture(),
    tab = createTabContext(),
    onMoved = vi.fn();
  await act(async () => root.render(borrowed(f, tab, onMoved)(true)));
  await flush();
  await act(async () => {
    button("Move…").click();
  });
  const select = host.querySelector("select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value"
    )!.set!.call(select, "box");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    button("Move").click();
  });
  await flush();
  expect(f.server.effects.get("A")).toBe(1);
  expect(onMoved).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("It was sent.");
  expect(statuses().filter((t) => !t!.startsWith("Loading"))).toEqual([]);
  expect(alerts()).toEqual([]);
});

it("Lend to a Friend: a confirmed recovery's note goes when the dialog closes", async () => {
  const f = fixture(),
    tab = createTabContext();
  await lostIntent(f, tab, {
    kind: "lend_offer",
    scope: "lend_offer",
    path: OFFER,
    fields: { borrower_id: "friend", copies: [], return_by: null },
  });
  const render = (open: boolean) =>
    h(LoanRecoveryProvider, {
      accountId: "A",
      accountName: "Ana",
      ports: f.ports,
      tab,
      children: h(LendOfferDialog, {
        open,
        rows: [],
        onClose: vi.fn(),
        onSent: vi.fn(),
        onLoansChanged: vi.fn(),
        onOpenLoan: vi.fn(),
      }),
    });
  await act(async () => root.render(render(true)));
  await act(async () => {
    button("Send it again").click();
  });
  await flush();
  expect(statuses()).toContain("It was sent.");
  await act(async () => root.render(render(false)));
  expect(statuses()).toEqual([]);
  expect(alerts()).toEqual([]);
  expect(host.textContent).not.toContain("It was sent.");
});

/**
 * Ports whose lock holds its answer back after the call finishes. The store has removed the intent and told its
 * subscribers by then, so React can commit the blocker's removal before the lock's promise resolves.
 */
function slowRelease(f: ReturnType<typeof fixture>) {
  const inner = f.ports.locks!;
  const locks = {
    request: ((
      name: string,
      options: LockOptions,
      cb: LockGrantedCallback<unknown>
    ) =>
      inner.request(name, options, async (lock) => {
        const result = await cb(lock);
        await new Promise((resolve) => setTimeout(resolve, 150));
        return result;
      })) as LockManager["request"],
  };
  return { ...f.ports, locks };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Presses a button outside act, so React commits on its own schedule while the lock is still held. */
async function pressUnbatched(text: string, whileHeld: () => void = () => {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  try {
    button(text).click();
    await sleep(50);
    whileHeld();
    await sleep(300);
  } finally {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  }
}

it.each([true, false])(
  "Borrowed: onMoved runs once when the blocker clears before the lock is released (still open=%s)",
  async (stayOpen) => {
    const f = fixture(),
      tab = createTabContext(),
      onMoved = vi.fn();
    await lostMove(f, tab);
    const render = borrowed({ ...f, ports: slowRelease(f) }, tab, onMoved);
    await act(async () => root.render(render(true)));
    await pressUnbatched("Send it again", () => {
      // The blocker is already gone from the dialog while the lock is still held.
      expect(
        [...host.querySelectorAll("button")].some(
          (b) => b.textContent === "Send it again"
        )
      ).toBe(false);
      if (!stayOpen) root.render(render(false));
    });
    expect(onMoved).toHaveBeenCalledTimes(1);
    if (stayOpen) {
      expect(statuses()).toContain("It was sent.");
      expect(alerts()).toEqual([]);
    } else {
      await act(async () => {});
      expect(statuses()).toEqual([]);
    }
  }
);

it.each([true, false])(
  "Lend to a Friend: onLoansChanged runs once when the blocker clears before the lock is released (still open=%s)",
  async (stayOpen) => {
    const f = fixture(),
      tab = createTabContext(),
      onLoansChanged = vi.fn();
    await lostIntent(f, tab, {
      kind: "lend_offer",
      scope: "lend_offer",
      path: OFFER,
      fields: { borrower_id: "friend", copies: [], return_by: null },
    });
    const ports = slowRelease(f);
    const render = (open: boolean) =>
      h(LoanRecoveryProvider, {
        accountId: "A",
        accountName: "Ana",
        ports,
        tab,
        children: h(LendOfferDialog, {
          open,
          rows: [],
          onClose: vi.fn(),
          onSent: vi.fn(),
          onLoansChanged,
          onOpenLoan: vi.fn(),
        }),
      });
    await act(async () => root.render(render(true)));
    await pressUnbatched("Send it again", () => {
      expect(
        [...host.querySelectorAll("button")].some(
          (b) => b.textContent === "Send it again"
        )
      ).toBe(false);
      if (!stayOpen) root.render(render(false));
    });
    expect(onLoansChanged).toHaveBeenCalledTimes(1);
    if (stayOpen) expect(statuses()).toContain("It was sent.");
    else {
      await act(async () => {});
      expect(statuses()).toEqual([]);
    }
  }
);

const OLD_MESSAGE = "It was sent.";

it("Borrowed: a recovery's message does not follow a later request's notice", async () => {
  const f = fixture(),
    tab = createTabContext(),
    onMoved = vi.fn();
  await lostMove(f, tab);
  await act(async () => root.render(borrowed(f, tab, onMoved)(true)));
  await act(async () => {
    button("Send it again").click();
  });
  await flush();
  expect(statuses()).toContain(OLD_MESSAGE);
  // Same dialog, still open: another Move loses its answer.
  await act(async () => {
    button("Move…").click();
  });
  const select = host.querySelector("select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value"
    )!.set!.call(select, "box");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  f.server.loseNextAnswer = true;
  await act(async () => {
    button("Move").click();
  });
  await flush();
  expect(statuses().join(" ")).toContain(
    "Your Move of borrowed cards may not have finished."
  );
  expect(host.textContent).not.toContain(OLD_MESSAGE);
});

it("Lend to a Friend: a recovery's message does not follow a later request's notice", async () => {
  const f = fixture(),
    tab = createTabContext();
  vi.mocked(getFriends).mockResolvedValue({
    friends: [
      { collector_id: "friend", handle: "misty", display_name: "Misty" },
    ],
  } as never);
  await lostIntent(f, tab, {
    kind: "lend_offer",
    scope: "lend_offer",
    path: OFFER,
    fields: { borrower_id: "friend", copies: [], return_by: null },
  });
  await act(async () =>
    root.render(
      h(LoanRecoveryProvider, {
        accountId: "A",
        accountName: "Ana",
        ports: f.ports,
        tab,
        children: h(LendOfferDialog, {
          open: true,
          rows: [
            {
              key: "k",
              locationId: "old-box",
              editionId: "card",
              count: 1,
              card: "Iono",
            },
          ],
          onClose: vi.fn(),
          onSent: vi.fn(),
          onLoansChanged: vi.fn(),
          onOpenLoan: vi.fn(),
        }),
      })
    )
  );
  await flush();
  await act(async () => {
    button("Send it again").click();
  });
  await flush();
  expect(statuses()).toContain(OLD_MESSAGE);
  const select = host.querySelector("select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value"
    )!.set!.call(select, "friend");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  f.server.loseNextAnswer = true;
  await act(async () => {
    button("Send offer of 1 card").click();
  });
  await flush();
  expect(statuses().join(" ")).toContain(
    "Your Lend Offer may not have been sent."
  );
  expect(host.textContent).not.toContain(OLD_MESSAGE);
});
