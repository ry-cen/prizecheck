// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BorrowedDialog } from "./BorrowedDialog";
import { BorrowDraftsProvider, useBorrowDrafts } from "./BorrowDrafts";
import { LendOfferDialog } from "./LendOfferDialog";
import { LoanRecoveryProvider, useLoanRecovery } from "./LoanRecovery";
import { createTabContext, type LoanIntentStore } from "./loanIntents";
import { deferred, fixture, reply } from "./testing/loanFakes";
import {
  getBorrowed,
  getFriends,
  sendBorrowRequest,
  sendLendOffer,
  moveBorrowed,
} from "../social_generated";
import { getDecks } from "../decks_generated";
import { ToastProvider } from "../ui/Toast";
import { useRoute } from "../shell/useRoute";
import { indexLocations } from "../workspace/locationTree";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getBorrowed: vi.fn(),
  getFriends: vi.fn(),
  sendBorrowRequest: vi.fn(),
  sendLendOffer: vi.fn(),
  moveBorrowed: vi.fn(),
}));
vi.mock("../decks_generated", async (original) => ({
  ...(await original<typeof import("../decks_generated")>()),
  getDecks: vi.fn(),
}));
vi.mock("../workspace/media", () => ({
  MOBILE_QUERY: "(max-width: 760px)",
  useMediaQuery: () => false,
}));
const prototype = HTMLDialogElement.prototype;
let descriptors: (PropertyDescriptor | undefined)[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  window.history.replaceState(null, "", "/collection");
  window.sessionStorage.clear();
  window.localStorage.clear();
  descriptors = ["showModal", "close"].map((name) =>
    Object.getOwnPropertyDescriptor(prototype, name)
  );
  Object.defineProperty(prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  vi.mocked(getFriends).mockResolvedValue({
    received: [],
    sent: [],
    friends: [
      { collector_id: "friend", display_name: "Misty", handle: "misty" },
    ],
  });
  vi.mocked(getDecks).mockResolvedValue({
    decks: [],
    owner_revision: 0,
    next_cursor: null,
  });
  vi.mocked(getBorrowed).mockResolvedValue({
    copies: "3",
    cards: [
      {
        loan_id: "round",
        edition_id: "iono",
        name: "Iono",
        set_code: "PAL",
        set_name: "Paldea Evolved",
        collector_number: "185",
        descriptor: { finish: "normal" },
        image_url: null,
        location_id: "one",
        location_name: "Box",
        copies: "3",
        lender: "Misty",
      },
    ],
  });
});
afterEach(() => {
  for (const [i, name] of ["showModal", "close"].entries()) {
    if (descriptors[i]) Object.defineProperty(prototype, name, descriptors[i]!);
    else Reflect.deleteProperty(prototype, name);
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
type Kind = "borrow" | "lend" | "borrowed move";
async function setup(
  kind: Kind,
  mode: "delayed" | "lost" | "unsent" | "refused"
) {
  const f = fixture(),
    gate = deferred(),
    tab = createTabContext();
  const path =
    kind === "borrow"
      ? "/api/loans"
      : kind === "lend"
        ? "/api/loans/offers"
        : "/api/loans/borrowed/move";
  const packets: string[] = [];
  let navigate = () => {};
  f.ports.fetchImpl = async (url, init) => {
    if (String(url) !== path) return f.server.fetchImpl(url, init);
    packets.push(String(init?.body));
    const saved = [...f.shared.data.entries()].find(([key]) =>
      key.includes("loan-body")
    );
    expect(saved).toBeDefined();
    expect(JSON.parse(saved![1]).body).toBe(init?.body);
    if (packets.length === 1) {
      navigate();
      if (mode === "delayed") await gate.promise;
      if (mode === "refused")
        return reply(409, {
          detail: {
            code:
              kind === "borrowed move" ? "LOCATION_NOT_FOUND" : "NOT_FRIENDS",
          },
        });
      if (mode === "unsent") throw new TypeError("not delivered");
      const response = await f.server.fetchImpl(url, init);
      if (mode === "lost") throw new TypeError("answer lost");
      return response;
    }
    return f.server.fetchImpl(url, init);
  };
  let store!: LoanIntentStore;
  const moved = vi.fn(),
    sent = vi.fn();
  function Probe() {
    store = useLoanRecovery().store;
    return null;
  }
  function BorrowOpener() {
    const drafts = useBorrowDrafts()!;
    return h(
      "button",
      {
        onClick: () => {
          drafts.set(
            { collector_id: "friend", display_name: "Misty", handle: "misty" },
            {
              edition_id: "iono",
              name: "Iono",
              set_code: "PAL",
              collector_number: "185",
              descriptor: { finish: "normal" },
              image_url: null,
            },
            3,
            3,
            "3 available"
          );
          drafts.review("friend");
        },
      },
      "Open"
    );
  }
  function View() {
    const route = useRoute();
    navigate = () => route.navigate("/decks");
    const [open, setOpen] = useState(true);
    return h(
      ToastProvider,
      null,
      h(Probe),
      h("button", { onClick: navigate }, "Navigate"),
      h("button", { onClick: () => setOpen(true) }, "Open"),
      kind === "borrowed move"
        ? h(BorrowedDialog, {
            open,
            onClose: () => setOpen(false),
            onMoved: moved,
            index: indexLocations([
              {
                id: "one",
                name: "Box",
                kind: "storage",
                parent_id: null,
                version: 1,
                depth: 0,
              },
              {
                id: "two",
                name: "Binder",
                kind: "storage",
                parent_id: null,
                version: 1,
                depth: 0,
              },
            ]),
          })
        : kind === "lend"
          ? h(LendOfferDialog, {
              open,
              rows: [
                {
                  key: "line",
                  locationId: "place",
                  editionId: "iono",
                  count: 3,
                  card: "Iono",
                },
              ],
              onClose: () => setOpen(false),
              onSent: sent,
              onLoansChanged: moved,
              onOpenLoan: vi.fn(),
            })
          : h(BorrowDraftsProvider, {
              userId: "A",
              onOpenLoan: vi.fn(),
              children: h(BorrowOpener),
            })
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find(
      (node) => node.textContent === name
    )!;
  const openBorrow = () =>
    [...host.querySelectorAll("button")].find(
      (node) =>
        node.textContent === "Open" && node !== host.querySelector("button")
    )!;
  await act(async () =>
    root.render(
      h(LoanRecoveryProvider, {
        accountId: "A",
        accountName: "Ana",
        ports: f.ports,
        tab,
        children: h(View),
      })
    )
  );
  if (kind === "borrow")
    await act(async () => {
      const buttons = [...host.querySelectorAll("button")].filter(
        (node) => node.textContent === "Open"
      );
      buttons.at(-1)!.click();
    });
  else {
    if (kind === "borrowed move")
      await act(async () => button("Move…").click());
    await act(async () => {
      const field = host.querySelector("select")!;
      field.value = kind === "lend" ? "friend" : "two";
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const sendName =
    kind === "borrow"
      ? "Send Borrow Request"
      : kind === "lend"
        ? "Send offer of 3 cards"
        : "Move";
  return {
    ...f,
    host,
    root,
    packets,
    gate,
    button,
    openBorrow,
    store,
    sendName,
    send: () => act(async () => button(sendName).click()),
    close: () =>
      act(async () => {
        if (kind === "borrow") button("Keep draft").click();
        else
          host
            .querySelector<HTMLButtonElement>(
              kind === "lend"
                ? '[aria-label="Close Lend to a Friend"]'
                : '[aria-label="Close Borrowed"]'
            )!
            .click();
      }),
    cleanup: async () => {
      gate.resolve();
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
for (const kind of ["borrow", "lend", "borrowed move"] as const) {
  it(`keeps the ${kind} command through close, edits and navigation while its POST is out`, async () => {
    const f = await setup(kind, "delayed");
    try {
      await f.send();
      expect(f.packets).toHaveLength(1);
      await f.close();
      expect(f.host.querySelector("dialog[open]")).not.toBeNull();
      expect(window.location.pathname).toBe("/collection");
      expect(
        window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
      ).toBe(false);
      if (kind === "borrow") {
        expect(f.host.querySelector("fieldset")?.disabled).toBe(true);
        expect(f.button("Discard").disabled).toBe(true);
      } else expect(f.host.querySelector("select")?.disabled).toBe(true);
      expect(
        f.host
          .querySelector<HTMLInputElement>('input[type="date"]')
          ?.matches(":disabled") ?? kind === "borrowed move"
      ).toBe(true);
      await act(async () => f.button("Navigate").click());
      expect(window.location.pathname).toBe("/collection");
      expect(f.packets).toHaveLength(1);
      await act(async () => f.gate.resolve());
      expect(f.store.list()).toEqual([]);
      expect(
        window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
  it(`frees leaving after a lost ${kind} answer and keeps the intent blocked`, async () => {
    const f = await setup(kind, "lost");
    try {
      await f.send();
      expect(f.store.list()).toHaveLength(1);
      await f.close();
      expect(f.host.querySelector("dialog[open]")).toBeNull();
      await act(async () => f.button("Navigate").click());
      expect(window.location.pathname).toBe("/decks");
      expect(
        window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
      ).toBe(true);
      expect(f.store.list()).toHaveLength(1);
      expect(f.packets).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });
  it(`replays the stored ${kind} bytes and key from the reopened notice`, async () => {
    const f = await setup(kind, "lost");
    try {
      await f.send();
      const original = f.packets[0];
      await f.close();
      await act(async () => {
        const buttons = [...f.host.querySelectorAll("button")].filter(
          (node) => node.textContent === "Open"
        );
        buttons.at(-1)!.click();
      });
      await act(async () => f.button("Send it again").click());
      expect(f.packets).toHaveLength(2);
      expect(f.packets[1]).toBe(original);
      expect(f.store.list()).toEqual([]);
      expect(f.server.effects.get("A")).toBe(1);
      expect(sendBorrowRequest).not.toHaveBeenCalled();
      expect(sendLendOffer).not.toHaveBeenCalled();
      expect(moveBorrowed).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
  it(`Don't send it voids the ${kind} and frees the form`, async () => {
    const f = await setup(kind, "unsent");
    try {
      await f.send();
      expect(f.store.list()).toHaveLength(1);
      await act(async () => f.button("Don't send it").click());
      expect(f.store.list()).toEqual([]);
      expect(f.packets).toHaveLength(1);
      expect(f.button(f.sendName).matches(":disabled")).toBe(false);
      expect(f.server.effects.get("A") ?? 0).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it(`a refused ${kind} keeps its draft or form and clears the intent`, async () => {
    const f = await setup(kind, "refused");
    try {
      await f.send();
      expect(f.store.list()).toEqual([]);
      expect(f.packets).toHaveLength(1);
      expect(f.host.querySelector("dialog[open]")).not.toBeNull();
      expect(f.host.textContent).toContain(
        kind === "borrowed move" ? "Location" : "Friend"
      );
      expect(
        f.host.querySelector("select, fieldset")?.matches(":disabled")
      ).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
}

it("an orphaned wildcard intent stays visible without any Borrow Request draft", async () => {
  const f = fixture();
  const operation = "00000000-0000-4000-8000-000000000002";
  f.ports.storage!.setItem(
    `prizecheck:loan-intent:v2:A:${operation}`,
    JSON.stringify({
      accountId: "A",
      key: "00000000-0000-4000-8000-000000000001",
    })
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(LoanRecoveryProvider, {
          accountId: "A",
          accountName: "Ana",
          ports: f.ports,
          tab: createTabContext(),
          children: h(ToastProvider, {
            children: h(BorrowDraftsProvider, {
              userId: "A",
              onOpenLoan: vi.fn(),
              children: null,
            }),
          }),
        })
      )
    );
    expect(host.textContent).toContain(
      "A Loan change may not have gone through."
    );
    const cancel = [...host.querySelectorAll("button")].find(
      (node) => node.textContent === "Don't send it"
    )!;
    expect(cancel).toBeDefined();
    await act(async () => cancel.click());
    expect(
      f.ports.storage!.getItem(`prizecheck:loan-intent:v2:A:${operation}`)
    ).toBeNull();
    expect(
      f.server.fetchImpl.mock.calls
        .filter(([path]) => String(path) !== "/auth/session")
        .map(([path]) => String(path))
    ).toEqual(["/api/loans/command-keys/void"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
