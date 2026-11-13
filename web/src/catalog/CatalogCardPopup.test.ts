import type { ReactNode } from "react";
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { CatalogCardPopup } from "./CatalogCardPopup";
import { useAddToast } from "./useAddToast";
import { addToCollection, type AddOutcome } from "./cardActions";
import { applyUndo, listUndo } from "../inventoryUndo";
import { useToast, ToastProvider } from "../ui/Toast";

vi.mock("../ui/CardPopup", () => ({
  CardPopup: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? h("div", { role: "dialog" }, children) : null,
  CardArt: () => null,
}));
vi.mock("./cardActions", () => ({ addToCollection: vi.fn() }));
vi.mock("../inventoryUndo", () => ({ applyUndo: vi.fn(), listUndo: vi.fn() }));
vi.mock("../EditionPrice", () => ({ EditionPrice: () => null }));
vi.mock("./useCardDetails", () => ({
  useCardDetails: () => ({
    reload: vi.fn(),
    details: {
      state: "ready",
      browse: "ok",
      rows: [],
      printing: {
        id: "p",
        name: "Switch",
        identity_name: "Switch",
        source: "tcgdex",
        editions: [],
      },
      editions: [
        { id: "e", active: true, descriptor: { finish: "normal" }, owned: 0 },
        {
          id: "f",
          active: true,
          descriptor: { finish: "reverse_holo" },
          owned: 0,
        },
      ],
    },
  }),
  useCopiesWhere: () => ({ state: "ready", holdings: [] }),
}));
vi.mock("./usePlaces", () => ({
  usePlaces: () => ({
    state: "ready",
    leaves: [{ id: "u", label: "Unsorted" }],
  }),
}));
vi.mock("../social/FriendsWhoHaveThis", () => ({
  FriendsWhoHaveThis: () => null,
}));
vi.mock("../trades/AskToTrade", () => ({ AskToTrade: () => null }));

test("the Add row visibly labels its Location and retains the Add to Collection group", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(
          ToastProvider,
          null,
          h(CatalogCardPopup, {
            request: {
              printingId: "p",
              editionId: "e",
              row: null,
              report: null,
            },
            onClose: vi.fn(),
            position: null,
            canPrevious: false,
            canNext: false,
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            pendingFor: () => ({ current: null }),
            location: null,
            onLocation: vi.fn(),
            alsoOffer: null,
            onAdded: async () => null,
            onReported: vi.fn(),
          })
        )
      )
    );
    const group = document.querySelector(
      '[role="group"][aria-label="Add to Collection"]'
    )!;
    expect(group).not.toBeNull();
    expect(group.firstElementChild?.textContent).toBe("Location");
    expect(
      group.querySelector("select")?.labels?.[0]?.firstElementChild?.textContent
    ).toBe("Location");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

const result: AddOutcome = {
  ok: true,
  locationId: "u",
  path: "Unsorted",
  items: [{ editionId: "e", quantity: 1 }],
  settledEarlier: false,
  copies: 1,
  editions: 1,
  ownerRevision: 1,
  undoId: "first",
};
const removed = {
  copy_count: "1",
  source_count: 0,
  owner_revision: 2,
  edition_count: 1,
  already_at_destination_count: "0",
};
async function journey(
  run: (ui: {
    button: (text: string) => HTMLButtonElement;
    render: (printing: string | null) => Promise<void>;
    host: HTMLElement;
  }) => Promise<void>
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(addToCollection).mockResolvedValue(result);
  vi.mocked(listUndo).mockResolvedValue([{ id: "first" }] as Awaited<
    ReturnType<typeof listUndo>
  >);
  vi.mocked(applyUndo).mockResolvedValue(removed);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Probe({ printing }: { printing: string | null }) {
    const kit = useToast();
    const notify = useAddToast({ shown: true, onUndone: vi.fn() });
    return h(CatalogCardPopup, {
      request: printing
        ? { printingId: printing, editionId: "e", row: null, report: null }
        : null,
      onClose: vi.fn(),
      position: null,
      canPrevious: false,
      canNext: false,
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      pendingFor: () => ({ current: null }),
      location: null,
      onLocation: vi.fn(),
      alsoOffer: null,
      onAdded: notify,
      onAddFailed: (message: string) => {
        kit.show({ message });
      },
      onReported: vi.fn(),
    });
  }
  const render = async (printing: string | null) => {
    await act(async () =>
      root.render(h(ToastProvider, null, h(Probe, { printing })))
    );
  };
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
  try {
    await render("p");
    await run({ host, button, render });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  }
}
const undoCount = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].filter((b) => b.textContent === "Undo")
    .length;

test.each(["card", "edition", "close/reopen"])(
  "%s releases inline ownership without recreating or replaying the notice",
  async (transition) => {
    await journey(async ({ host, button, render }) => {
      await act(async () => button("Add 1").click());
      expect(undoCount(host)).toBe(1);
      expect(host.querySelector("#app-toasts button")?.textContent).not.toBe(
        "Undo"
      );
      const toast = host.querySelector("#app-toasts p");
      if (transition === "card") await render("other");
      if (transition === "edition")
        await act(async () =>
          [...host.querySelectorAll("button[aria-pressed]")][1].dispatchEvent(
            new MouseEvent("click", { bubbles: true })
          )
        );
      if (transition === "close/reopen") {
        await render(null);
        await render("p");
      }
      expect(undoCount(host)).toBe(1);
      expect(host.querySelector("#app-toasts p")).toBe(toast);
      expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain(
        "Added 1 copy"
      );
      expect(host.querySelector("#app-toasts button")?.textContent).toBe(
        "Undo"
      );
    });
  }
);

test("closing during Add leaves its eventual Undo with the toast and reopening cannot claim it", async () => {
  await journey(async ({ host, button, render }) => {
    let finish!: (value: AddOutcome) => void;
    vi.mocked(addToCollection).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await act(async () => button("Add 1").click());
    await render(null);
    await act(async () => finish(result));
    expect(undoCount(host)).toBe(1);
    await render("p");
    expect(undoCount(host)).toBe(1);
    expect(host.querySelector("#app-toasts button")?.textContent).toBe("Undo");
  });
});

test("a newer add replaces the older inline action and Undo applies only that record", async () => {
  await journey(async ({ host, button }) => {
    await act(async () => button("Add 1").click());
    vi.mocked(addToCollection).mockResolvedValueOnce({
      ...result,
      undoId: "second",
    });
    vi.mocked(listUndo).mockResolvedValueOnce([{ id: "second" }] as Awaited<
      ReturnType<typeof listUndo>
    >);
    await act(async () => button("Add 1").click());
    expect(undoCount(host)).toBe(1);
    await act(async () => button("Undo").click());
    expect(applyUndo).toHaveBeenCalledExactlyOnceWith(
      "second",
      expect.any(String)
    );
    expect(undoCount(host)).toBe(0);
  });
});

test("add, retryable failure and Undo success each change the inline announcement once, with no replay on close", async () => {
  await journey(async ({ host, button, render }) => {
    const messages: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const node =
          record.target.nodeType === Node.TEXT_NODE
            ? record.target.parentElement
            : (record.target as Element);
        if (node?.closest('[role="status"]') && node.textContent)
          messages.push(node.textContent);
      }
    });
    observer.observe(host, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    await act(async () => button("Add 1").click());
    vi.mocked(applyUndo).mockRejectedValueOnce(new TypeError("lost"));
    await act(async () => button("Undo").click());
    await act(async () => button("Undo").click());
    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(3);
    expect(messages[0]).toBe("Added 1 copy to Unsorted.");
    expect(messages[2]).toBe("Undo removed 1 card from Unsorted.");
    await render(null);
    expect(messages).toHaveLength(3);
    observer.disconnect();
  });
});

test("stepping edition during Undo permits the next Edition's new inline Undo", async () => {
  await journey(async ({ host, button }) => {
    await act(async () => button("Add 1").click());
    let finish!: (value: typeof removed) => void;
    vi.mocked(applyUndo).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await act(async () => button("Undo").click());
    await act(async () =>
      [...host.querySelectorAll("button[aria-pressed]")][1].dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
    vi.mocked(addToCollection).mockResolvedValueOnce({
      ...result,
      undoId: "second",
    });
    vi.mocked(listUndo).mockResolvedValueOnce([{ id: "second" }] as Awaited<
      ReturnType<typeof listUndo>
    >);
    await act(async () => button("Add 1").click());
    expect(button("Undo").getAttribute("aria-disabled")).toBeNull();
    await act(async () => finish(removed));
    expect(undoCount(host)).toBe(1);
    await act(async () => button("Undo").click());
    expect(applyUndo).toHaveBeenCalledTimes(2);
    expect(vi.mocked(applyUndo).mock.calls[1][0]).toBe("second");
  });
});

test.each([false, true])(
  "failed Add is reported once (closed mid-Add: %s)",
  async (closed) => {
    await journey(async ({ host, button, render }) => {
      let finish!: (value: AddOutcome) => void;
      vi.mocked(addToCollection).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      await act(async () => button("Add 1").click());
      if (closed) await render(null);
      await act(async () =>
        finish({
          ok: false,
          code: "EDITION_UNAVAILABLE",
          editionId: "e",
          retry: false,
        })
      );
      const feedback = closed
        ? host.querySelector("#app-toasts p")
        : host.querySelector('[role="alert"]');
      expect(feedback?.textContent).toBe(
        "This Edition is no longer available to add."
      );
      expect(
        [...host.querySelectorAll("p")].filter(
          (p) => p.textContent === feedback?.textContent
        )
      ).toHaveLength(1);
      if (closed) {
        await render("p");
        expect(host.querySelector("#app-toasts p")).toBe(feedback);
      }
    });
  }
);

test("close during outstanding Undo preserves restored opener focus and never revives Undo on reopen", async () => {
  await journey(async ({ host, button, render }) => {
    await act(async () => button("Add 1").click());
    let finish!: (value: typeof removed) => void;
    vi.mocked(applyUndo).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await act(async () => button("Undo").click());
    await render(null);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    try {
      await act(async () => finish(removed));
      expect(document.activeElement).toBe(opener);
      expect(host.querySelector("#app-toasts p")?.textContent).toBe(
        "Undo removed 1 card from Unsorted."
      );
      await render("p");
      expect(undoCount(host)).toBe(0);
    } finally {
      opener.remove();
    }
  });
});
