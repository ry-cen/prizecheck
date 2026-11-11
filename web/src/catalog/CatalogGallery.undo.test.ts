// @vitest-environment jsdom
import { act, createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CatalogGallery } from "./CatalogGallery";
import type { CatalogCardPopup } from "./CatalogCardPopup";
import { useAddToast, type AddedCards, type InlineUndo } from "./useAddToast";
import { applyUndo, listUndo } from "../inventoryUndo";
import { ToastProvider } from "../ui/Toast";
import type { BrowseEdition } from "../catalog_browse_generated";

vi.mock("../inventoryUndo", () => ({ applyUndo: vi.fn(), listUndo: vi.fn() }));
vi.mock("../shell/keptRead", () => ({ useFirstReadSettled: () => {} }));
vi.mock("./CatalogFilters", () => ({ CatalogFilters: () => null }));
vi.mock("./AddBar", () => ({ AddBar: () => null }));
vi.mock("./usePlaces", () => ({
  usePlaces: () => ({ leaves: [], state: "ready" }),
}));
vi.mock("./useCatalogBrowse", () => ({ useCatalogBrowse: () => browse }));
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
