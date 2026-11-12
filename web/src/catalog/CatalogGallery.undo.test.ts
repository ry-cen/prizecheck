// @vitest-environment jsdom
import { act, createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AddQueueAccount } from "./useStoredAddQueue";
import { useCatalogBrowse } from "./useCatalogBrowse";
import { CatalogGallery } from "./CatalogGallery";
import type { CatalogCardPopup } from "./CatalogCardPopup";
import { useAddToast, type AddedCards, type InlineUndo } from "./useAddToast";
import { applyUndo, listUndo } from "../inventoryUndo";
import { ToastProvider } from "../ui/Toast";
import { getCatalogSets } from "../catalog_browse_generated";
import { parseCatalogView } from "./catalogUrl";
import type { BrowseEdition } from "../catalog_browse_generated";

vi.mock("../catalog_browse_generated", async (original) => ({
  ...(await original<typeof import("../catalog_browse_generated")>()),
  getCatalogSets: vi.fn(async () => ({
    available: true,
    catalog_revision: 1,
    sets: [],
  })),
}));
vi.mock("../inventoryUndo", () => ({ applyUndo: vi.fn(), listUndo: vi.fn() }));
vi.mock("../shell/keptRead", () => ({ useFirstReadSettled: () => {} }));
vi.mock("./CatalogFilters", () => ({ CatalogFilters: () => null }));
vi.mock("./AddBar", () => ({
  AddBar: (props: { queue: ReadonlyMap<string, unknown>; onAdd: () => void }) =>
    h(
      "div",
      null,
      h("output", { "data-queue": true }, props.queue.size),
      h("button", { onClick: props.onAdd }, "Add queued")
    ),
}));
vi.mock("./usePlaces", () => ({
  usePlaces: () => ({ leaves: [], state: "ready" }),
}));
vi.mock("./useCatalogBrowse", () => ({
  useCatalogBrowse: vi.fn(() => browse),
}));
vi.mock("./CatalogCardPopup", () => ({
  // Keep Gallery's real close/step callbacks. The popup's local feedback resets on a card step, as AddRows does.
  CatalogCardPopup: (props: Parameters<typeof CatalogCardPopup>[0]) => {
    const [undo, setUndo] = useState<InlineUndo | null>(null);
    useEffect(() => setUndo(null), [props.request?.editionId]);
    if (!props.request) return null;
    return h(
      "div",
      { "data-popup": true },
      h("span", null, props.request.editionId),
      h(
        "button",
        {
          onClick: async () => {
            const offered = await props.onAdded(added);
            setUndo(() => offered);
          },
        },
        "Add"
      ),
      h("button", { onClick: props.onClose }, "Close popup"),
      h("button", { onClick: props.onNext }, "Next card"),
      props.renderAddFeedback
        ? props.renderAddFeedback(vi.fn(), vi.fn())
        : undo && h("button", { onClick: () => void undo() }, "Undo")
    );
  },
}));
const editions: BrowseEdition[] = ["first", "second"].map((id) => ({
  edition_id: id,
  printing_id: id,
  name: id,
  set_id: "set",
  set_name: "Set",
  set_code: "SET",
  collector_number: "1",
  descriptor: { finish: "normal" },
  image_url: null,
  art_url: null,
  card_kind: "trainer",
  trainer_type: "item",
  evolves_from: null,
  regulation_mark: null,
  standing: {
    standard: { status: "legal", reasons: [] },
    expanded: { status: "legal", reasons: [] },
    glc: { status: "legal", reasons: [] },
  },
  owned: 0,
  in_deck: 0,
  free: 0,
}));
const browse = {
  first: { available: true, matches: 2, search: { mode: "all" } },
  editions,
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: "",
  errorMore: false,
  notice: "",
  loadMore: vi.fn(),
  noteAdded: vi.fn(),
};
const added: AddedCards = {
  locationId: "box",
  path: "Box",
  items: [{ editionId: "first", quantity: 1 }],
  copies: 1,
  ownerRevision: 1,
  undoId: "add",
  from: "popup",
};
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.mocked(listUndo).mockResolvedValue([
    {
      id: "add",
      action: "add",
      destination_id: "box",
      source_id: null,
      source_count: 0,
      expires_at: "2099-01-01",
    },
  ]);
  vi.mocked(applyUndo).mockResolvedValue({
    edition_count: 1,
    copy_count: "1",
    source_count: 0,
    owner_revision: 2,
    already_at_destination_count: "0",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Owner() {
    const notify = useAddToast({ shown: true, onUndone: vi.fn() });
    return h(CatalogGallery, {
      active: true,
      adding: true,
      fixedTarget: { id: "box", label: "Box" },
      undoToast: false,
      onAdded: notify,
      stick: "dialog",
    });
  }
  await act(async () => root.render(h(ToastProvider, null, h(Owner))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function button(name: string, scope: ParentNode = host) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === name
  );
}
async function addFromPopup() {
  const tile = host.querySelector<HTMLButtonElement>(
    '[data-edition-id="first"] button'
  )!;
  await act(async () => tile.click());
  await act(async () => button("Add")!.click());
}
test.each(["Close popup", "Next card"])(
  "shared Undo remains reachable after %s",
  async (transition) => {
    await addFromPopup();
    await act(async () => button(transition)!.click());
    // The notification host is behind Add cards in the real app; it cannot satisfy this assertion.
    const scope =
      transition === "Next card"
        ? host.querySelector("[data-popup]")!
        : host.querySelector('[data-edition-id="first"]')!.closest("ul")!
            .parentElement!.parentElement!;
    const undo = button("Undo", scope);
    expect(
      undo,
      "Undo must remain in the active dialog after the popup transition"
    ).toBeDefined();
    await act(async () => undo!.click());
    expect(applyUndo).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyUndo).mock.calls[0][0]).toBe("add");
    expect(scope.textContent).toContain("Undo removed 1 card from Box.");
  }
);

test("an in-flight Undo keeps its busy guard across step and close and focuses the current dialog", async () => {
  await addFromPopup();
  let finish!: (value: Awaited<ReturnType<typeof applyUndo>>) => void;
  vi.mocked(applyUndo).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await act(async () =>
    button("Undo", host.querySelector("[data-popup]")!)!.click()
  );
  await act(async () => button("Next card")!.click());
  const steppedUndo = button("Undo", host.querySelector("[data-popup]")!);
  expect(
    steppedUndo,
    "Undo must persist on a card step during the request"
  ).toBeDefined();
  expect(steppedUndo!.getAttribute("aria-disabled")).toBe("true");
  await act(async () => steppedUndo!.click());
  await act(async () => button("Close popup")!.click());
  const outerUndo = button("Undo", host.firstElementChild!);
  expect(
    outerUndo,
    "Undo must persist in Add cards during the request"
  ).toBeDefined();
  await act(async () => outerUndo!.click());
  expect(applyUndo).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({
      edition_count: 1,
      copy_count: "1",
      source_count: 0,
      owner_revision: 2,
      already_at_destination_count: "0",
    })
  );
  expect(host.firstElementChild!.textContent).toContain(
    "Undo removed 1 card from Box."
  );
  expect(document.activeElement).toBe(
    host.querySelector('input[type="search"]')
  );
});

test("a retry after step and close keeps the original Undo idempotency key", async () => {
  await addFromPopup();
  vi.mocked(applyUndo).mockRejectedValueOnce(new TypeError("lost response"));
  await act(async () =>
    button("Undo", host.querySelector("[data-popup]")!)!.click()
  );
  await act(async () => button("Next card")!.click());
  await act(async () => button("Close popup")!.click());
  const undo = button("Undo", host.firstElementChild!);
  expect(undo, "retry must remain reachable in Add cards").toBeDefined();
  await act(async () => undo!.click());
  expect(applyUndo).toHaveBeenCalledTimes(2);
  expect(vi.mocked(applyUndo).mock.calls[0]).toEqual(
    vi.mocked(applyUndo).mock.calls[1]
  );
});

test("dialog queue survives its fixed Location falling back to the picker", async () => {
  async function render(fixedTarget: { id: string; label: string } | null) {
    await act(async () =>
      root.render(
        h(
          ToastProvider,
          null,
          h(
            AddQueueAccount.Provider,
            { value: "fallback-owner" },
            h(CatalogGallery, {
              active: true,
              adding: true,
              fixedTarget,
              undoToast: false,
              stick: "dialog",
            })
          )
        )
      )
    );
  }
  await render({ id: "box", label: "Box" });
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label^="One more first"]')!
      .click()
  );
  expect(host.querySelector("[data-queue]")?.textContent).toBe("1");
  await render(null);
  expect(host.querySelector("[data-queue]")?.textContent).toBe("1");
});
test("failed restoration exposes a discard action even with no rendered queue", async () => {
  sessionStorage.setItem(
    "prizecheck:add-queue:failed-owner:page",
    JSON.stringify({
      items: [{ editionId: "first", printingId: "first", quantity: 1 }],
      target: null,
      uncertain: false,
    })
  );
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("offline"));
  try {
    await act(async () =>
      root.render(
        h(
          ToastProvider,
          null,
          h(
            AddQueueAccount.Provider,
            { value: "failed-owner" },
            h(CatalogGallery, {
              active: true,
              adding: true,
              fixedTarget: null,
              undoToast: false,
              stick: "page",
            })
          )
        )
      )
    );
    const discard = button("Discard queue");
    expect(discard).toBeDefined();
    expect(discard!.disabled).toBe(false);
    await act(async () => discard!.click());
    expect(
      sessionStorage.getItem("prizecheck:add-queue:failed-owner:page")
    ).toBe(null);
    expect(host.textContent).not.toContain("Couldn't restore");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="One more first"]'
        )!
        .click()
    );
    expect(host.querySelector("[data-queue]")?.textContent).toBe("1");
  } finally {
    fetch.mockRestore();
  }
});

test.each([
  { destination: "a", expected: "1" },
  { destination: "b", expected: "0" },
])(
  "closing A then opening $destination restores only that Location's queue",
  async ({ destination, expected }) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const data = String(input).includes("location-tree")
          ? { locations: [{ id: "a", kind: "storage_leaf" }] }
          : { available: true, editions, next_cursor: null };
        return new Response(JSON.stringify(data), { status: 200 });
      });
    async function opening(id: string | null) {
      await act(async () =>
        root.render(
          h(
            ToastProvider,
            null,
            h(
              AddQueueAccount.Provider,
              { value: "opening-owner" },
              id === null
                ? null
                : h(CatalogGallery, {
                    active: true,
                    adding: true,
                    fixedTarget: { id, label: id },
                    undoToast: false,
                    stick: "dialog",
                  })
            )
          )
        )
      );
    }
    try {
      await opening("a");
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label^="One more first"]'
          )!
          .click()
      );
      expect(host.querySelector("[data-queue]")?.textContent).toBe("1");
      await opening(null);
      await opening(destination);
      expect(host.querySelector("[data-queue]")?.textContent).toBe(expected);
      await opening(null);
      await opening("a");
      expect(host.querySelector("[data-queue]")?.textContent).toBe("1");
    } finally {
      fetch.mockRestore();
    }
  }
);

test.each([
  ["G1", "QUANTITY_OVERFLOW", false],
  ["G2", "EDITION_UNAVAILABLE", true],
] as const)(
  "%s refused add preserves remaining cards across remount (%s)",
  async (_id, code, two) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("holdings/batch"))
          return new Response(
            JSON.stringify({ detail: { code, edition_id: "first" } }),
            { status: 422 }
          );
        if (url.includes("location-tree"))
          return new Response(
            JSON.stringify({
              locations: [{ id: "box", kind: "storage_leaf" }],
              owner_revision: 1,
              lent_copies: "0",
              borrowed_copies: "0",
            })
          );
        return new Response(
          JSON.stringify({ available: true, editions, next_cursor: null })
        );
      });
    async function render() {
      await act(async () =>
        root.render(
          h(
            ToastProvider,
            null,
            h(
              AddQueueAccount.Provider,
              { value: "refusal-owner" },
              h(CatalogGallery, {
                active: true,
                adding: true,
                fixedTarget: { id: "box", label: "Box" },
                undoToast: false,
                stick: "dialog",
              })
            )
          )
        )
      );
    }
    try {
      await render();
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label^="One more first"]'
          )!
          .click()
      );
      if (two)
        await act(async () =>
          host
            .querySelector<HTMLButtonElement>(
              'button[aria-label^="One more second"]'
            )!
            .click()
        );
      await act(async () => button("Add queued")!.click());
      expect(host.querySelector("[data-queue]")?.textContent).toBe("1");
      await act(async () => root.render(null));
      await render();
      expect(host.querySelector("[data-queue]")?.textContent).toBe("1");
    } finally {
      fetch.mockRestore();
    }
  }
);

test("unknown set becomes Any set once the catalog set list is known", async () => {
  const onViewChange = vi.fn();
  await act(async () =>
    root.render(
      h(
        ToastProvider,
        null,
        h(CatalogGallery, {
          active: true,
          adding: false,
          fixedTarget: null,
          undoToast: false,
          stick: "page",
          view: parseCatalogView("/catalog?set=unknown"),
          onViewChange,
        })
      )
    )
  );
  expect(getCatalogSets).toHaveBeenCalled();
  expect(onViewChange).toHaveBeenCalledWith(
    expect.objectContaining({ setId: null })
  );
});

test.each([false, true])(
  "delayed unknown set never browses unresolved and normalises after activation (hidden=%s)",
  async (hidden) => {
    let resolve!: (list: Awaited<ReturnType<typeof getCatalogSets>>) => void;
    vi.mocked(getCatalogSets).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    const onViewChange = vi.fn();
    const render = async (active: boolean) =>
      act(async () =>
        root.render(
          h(
            ToastProvider,
            null,
            h(CatalogGallery, {
              active,
              adding: false,
              fixedTarget: null,
              undoToast: false,
              stick: "page",
              view: parseCatalogView("/catalog?set=unknown"),
              onViewChange,
            })
          )
        )
      );
    await render(true);
    const last = vi.mocked(useCatalogBrowse).mock.calls.at(-1)!;
    expect(last[3]).toBe(false);
    if (hidden) await render(false);
    await act(async () =>
      resolve({ available: true, catalog_revision: 1, sets: [] })
    );
    if (hidden) {
      expect(onViewChange).not.toHaveBeenCalled();
      await render(true);
    }
    expect(onViewChange).toHaveBeenCalledWith(
      expect.objectContaining({ setId: null })
    );
    const final = vi.mocked(useCatalogBrowse).mock.calls.at(-1)!;
    expect(final[0]).toMatchObject({ set_id: null });
    expect(final[3]).toBe(true);
  }
);

test("unknown set resolved while hidden is replayed on activation", async () => {
  let resolve!: (list: Awaited<ReturnType<typeof getCatalogSets>>) => void;
  vi.mocked(getCatalogSets).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    })
  );
  const applied = vi.fn();
  let active = true;
  const onViewChange = (view: unknown) => {
    if (active) applied(view);
  };
  const render = async () =>
    act(async () =>
      root.render(
        h(
          ToastProvider,
          null,
          h(CatalogGallery, {
            active,
            adding: false,
            fixedTarget: null,
            undoToast: false,
            stick: "page",
            view: parseCatalogView("/catalog?set=unknown"),
            onViewChange,
          })
        )
      )
    );
  await render();
  active = false;
  await render();
  await act(async () =>
    resolve({ available: true, catalog_revision: 1, sets: [] })
  );
  active = true;
  await render();
  expect(applied).toHaveBeenCalledWith(
    expect.objectContaining({ setId: null })
  );
});

test("set-list lookup failure can be retried without browsing an unresolved filter", async () => {
  vi.mocked(getCatalogSets).mockRejectedValueOnce(new Error("offline"));
  const onViewChange = vi.fn();
  await act(async () =>
    root.render(
      h(
        ToastProvider,
        null,
        h(CatalogGallery, {
          active: true,
          adding: false,
          fixedTarget: null,
          undoToast: false,
          stick: "page",
          view: parseCatalogView("/catalog?set=unknown"),
          onViewChange,
        })
      )
    )
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Catalog search is temporarily unavailable."
  );
  expect(vi.mocked(useCatalogBrowse).mock.calls.at(-1)![3]).toBe(false);
  await act(async () => button("Retry")!.click());
  expect(onViewChange).toHaveBeenCalledWith(
    expect.objectContaining({ setId: null })
  );
});

test("pending set normalisation keeps a concurrently normalised Add mode", async () => {
  const onViewChange = vi.fn();
  const render = async (address: string) =>
    act(async () =>
      root.render(
        h(
          ToastProvider,
          null,
          h(CatalogGallery, {
            active: true,
            adding: true,
            fixedTarget: null,
            undoToast: false,
            stick: "page",
            view: parseCatalogView(address),
            onViewChange,
          })
        )
      )
    );
  await render("/catalog?set=unknown");
  onViewChange.mockClear();
  await render("/catalog?set=unknown&mode=add");
  expect(onViewChange).toHaveBeenCalledWith(
    expect.objectContaining({ setId: null, mode: "add" })
  );
});
