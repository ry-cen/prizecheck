import type { ReactNode } from "react";
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { CatalogCardPopup } from "./CatalogCardPopup";
import { useAddToast, type InlineUndo } from "./useAddToast";
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
    reload,
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
const onUndone = vi.fn();
const reload = vi.hoisted(() => vi.fn());
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
  }) => Promise<void>,
  staleNext = false
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
    const notify = useAddToast({ shown: true, onUndone });
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
      onAdded: async (added) => {
        const action = await notify(added);
        if (!staleNext || !action) return action;
        return Object.assign(
          async () => ({ ...(await action()), next: action }),
          {
            isAvailable: action.isAvailable,
            claimInline: action.claimInline,
          }
        ) satisfies InlineUndo;
      },
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
    vi.resetAllMocks();
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

test.each(["edition", "card", "reopen"])(
  "a delayed Add failure is announced in the current modal after %s",
  async (transition) => {
    await journey(async ({ host, button, render }) => {
      let finish!: (value: AddOutcome) => void;
      vi.mocked(addToCollection).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      await act(async () => button("Add 1").click());
      if (transition === "edition")
        await act(async () =>
          [...host.querySelectorAll("button[aria-pressed]")][1].dispatchEvent(
            new MouseEvent("click", { bubbles: true })
          )
        );
      if (transition === "card") await render("other");
      if (transition === "reopen") {
        await render(null);
        await render("p");
      }
      const messages: string[] = [];
      const observer = new MutationObserver((records) => {
        const targets = new Set<Element>();
        for (const record of records) {
          const target =
            record.target instanceof Element
              ? record.target
              : record.target.parentElement;
          const alert = target?.closest('[role="alert"]');
          if (alert) targets.add(alert);
        }
        for (const target of targets)
          if (target.textContent) messages.push(target.textContent);
      });
      observer.observe(host, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      try {
        await act(async () =>
          finish({
            ok: false,
            code: "EDITION_UNAVAILABLE",
            editionId: "e",
            retry: false,
          })
        );
        const failure = "This Edition is no longer available to add.";
        expect(
          [...host.querySelectorAll('[role="dialog"] [role="alert"]')].filter(
            (p) => p.textContent === failure
          )
        ).toHaveLength(1);
        expect(host.querySelector("#app-toasts p")).toBeNull();
        expect(messages).toEqual([failure]);
        await render(null);
        await render("p");
        expect(messages).toEqual([failure]);
        expect(host.textContent).not.toContain(failure);
      } finally {
        observer.disconnect();
      }
    });
  }
);

test.each(["older-first", "newer-first"])(
  "two popup adds retain the newest inline Undo regardless of lookup order (%s)",
  async (order) => {
    await journey(async ({ host, button }) => {
      let older!: (entries: Awaited<ReturnType<typeof listUndo>>) => void;
      let newer!: (entries: Awaited<ReturnType<typeof listUndo>>) => void;
      vi.mocked(listUndo)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            older = resolve;
          })
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            newer = resolve;
          })
        );
      await act(async () => button("Add 1").click());
      vi.mocked(addToCollection).mockResolvedValueOnce({
        ...result,
        undoId: "second",
      });
      await act(async () => button("Add 1").click());
      const finishOlder = async () => {
        await act(async () =>
          older([{ id: "first" }] as Awaited<ReturnType<typeof listUndo>>)
        );
      };
      const finishNewer = async () => {
        await act(async () =>
          newer([{ id: "second" }] as Awaited<ReturnType<typeof listUndo>>)
        );
      };
      if (order === "older-first") {
        await finishOlder();
        expect(undoCount(host)).toBe(0);
        await finishNewer();
      } else {
        await finishNewer();
        await finishOlder();
      }
      expect(undoCount(host)).toBe(1);
      expect(host.querySelector("#app-toasts button")?.textContent).not.toBe(
        "Undo"
      );
      await act(async () => button("Undo").click());
      expect(applyUndo).toHaveBeenCalledExactlyOnceWith(
        "second",
        expect.any(String)
      );
    });
  }
);

// The first Undo can settle at any point in the next Add's lifecycle.
test.each(
  ["request", "lookup", "confirmed", "failed", "undoing"].flatMap((stage) =>
    ["same", "reopen", "roundtrip"].flatMap((reopen) =>
      [false, true].map((fails) => ({ stage, reopen, fails }))
    )
  )
)(
  "stale Undo cannot own the row: $stage reopen=$reopen fails=$fails",
  async ({ stage, reopen, fails }) => {
    await journey(async ({ host, button, render }) => {
      await act(async () => button("Add 1").click());
      let resolveA!: (value: typeof removed) => void;
      let rejectA!: (cause: Error) => void;
      vi.mocked(applyUndo).mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveA = resolve;
          rejectA = reject;
        })
      );
      await act(async () => button("Undo").click());
      if (reopen === "roundtrip") {
        for (const index of [1, 0])
          await act(async () => {
            [...host.querySelectorAll("button[aria-pressed]")][
              index
            ].dispatchEvent(new MouseEvent("click", { bubbles: true }));
          });
      }
      if (reopen === "reopen") {
        await render(null);
        await render("p");
      }
      let finishAdd!: (value: AddOutcome) => void;
      let finishLookup!: (value: Awaited<ReturnType<typeof listUndo>>) => void;
      vi.mocked(addToCollection).mockReturnValueOnce(
        new Promise((resolve) => {
          finishAdd = resolve;
        })
      );
      vi.mocked(listUndo).mockReturnValueOnce(
        new Promise((resolve) => {
          finishLookup = resolve;
        })
      );
      await act(async () => button("Add 1").click());
      const second = {
        ...result,
        undoId: "second",
        copies: 2,
        items: [{ editionId: "e", quantity: 2 }],
      };
      if (stage !== "request") {
        await act(async () =>
          finishAdd(
            stage === "failed"
              ? {
                  ok: false,
                  code: "EDITION_UNAVAILABLE",
                  editionId: "e",
                  retry: false,
                }
              : second
          )
        );
      }
      if (["confirmed", "undoing"].includes(stage)) {
        await act(async () =>
          finishLookup([{ id: "second" }] as Awaited<
            ReturnType<typeof listUndo>
          >)
        );
        expect(button("Undo").getAttribute("aria-disabled")).toBeNull();
      }
      let finishB!: (value: typeof removed) => void;
      if (stage === "undoing") {
        vi.mocked(applyUndo).mockReturnValueOnce(
          new Promise((resolve) => {
            finishB = resolve;
          })
        );
        await act(async () => button("Undo").click());
      }
      const focus = host.querySelector<HTMLSelectElement>("select")!;
      focus.focus();
      const refreshed = reload.mock.calls.length;
      const before = host.querySelector('[role="dialog"]')!.textContent;
      await act(async () =>
        fails ? rejectA(new TypeError("lost")) : resolveA(removed)
      );
      expect(onUndone).toHaveBeenCalledTimes(fails ? 0 : 1);
      expect(reload.mock.calls.length).toBe(refreshed + (fails ? 0 : 1));
      expect(document.activeElement).toBe(focus);
      expect(host.querySelector('[role="dialog"]')!.textContent).toBe(before);
      if (stage === "undoing") {
        expect(button("Undo").getAttribute("aria-disabled")).toBe("true");
        await act(async () => finishB(removed));
        expect(undoCount(host)).toBe(0);
      } else if (stage === "confirmed") {
        expect(undoCount(host)).toBe(1);
        expect(host.querySelector("#app-toasts button")?.textContent).not.toBe(
          "Undo"
        );
        await act(async () => button("Undo").click());
        expect(vi.mocked(applyUndo).mock.calls.at(-1)?.[0]).toBe("second");
      } else if (stage !== "failed") {
        if (stage === "request") await act(async () => finishAdd(second));
        await act(async () =>
          finishLookup([{ id: "second" }] as Awaited<
            ReturnType<typeof listUndo>
          >)
        );
        expect(undoCount(host)).toBe(1);
        expect(button("Undo").getAttribute("aria-disabled")).toBeNull();
      } else {
        // B failed: A's still-valid retry belongs only to its existing toast.
        expect(undoCount(host)).toBe(fails ? 1 : 0);
      }
    });
  }
);

test("the row ignores a stale result even when it carries a retry", async () => {
  await journey(async ({ host, button }) => {
    await act(async () => button("Add 1").click());
    let fail!: (cause: Error) => void;
    vi.mocked(applyUndo).mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      })
    );
    await act(async () => button("Undo").click());
    await act(async () => button("Add 1").click());
    const focus = host.querySelector<HTMLSelectElement>("select")!;
    focus.focus();
    await act(async () => fail(new TypeError("lost")));
    expect(document.activeElement).toBe(focus);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Added 1 copy to Unsorted."
    );
    expect(undoCount(host)).toBe(1);
    expect(button("Undo").getAttribute("aria-disabled")).toBeNull();
  }, true);
});

test.each([
  ["a matching Edition", "e", [], []],
  ["a pick", "e", ["f"], ["f"]],
  ["a pick back to the first", "e", ["f", "e"], ["f", "e"]],
  ["an unknown Edition", "missing", [], ["e"]],
  ["no Edition", null, [], ["e"]],
])(
  "onEditionShown reports the Edition shown: %s",
  async (_name, editionId, picks, expected) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const shown = vi.fn();
    try {
      await act(async () =>
        root.render(
          h(
            ToastProvider,
            null,
            h(CatalogCardPopup, {
              request: { printingId: "p", editionId, row: null, report: null },
              onClose: vi.fn(),
              onEditionShown: shown,
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
      // `picks` are the Editions pressed after the first resolution; `expected` what is reported.
      for (const id of picks) {
        const button = [
          ...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
        ].find((b) =>
          b.textContent?.includes(id === "e" ? "Normal" : "Reverse")
        )!;
        await act(async () => button.click());
      }
      expect(shown.mock.calls.map(([id]) => id)).toEqual(expected);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  }
);
