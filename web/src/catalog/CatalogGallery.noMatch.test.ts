// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CatalogGallery } from "./CatalogGallery";
import { useCatalogBrowse } from "./useCatalogBrowse";
import { usePlaces } from "./usePlaces";
import { ToastProvider } from "../ui/Toast";
import type { CatalogView } from "./catalogUrl";

vi.mock("../catalog_browse_generated", async (original) => ({
  ...(await original<typeof import("../catalog_browse_generated")>()),
  getCatalogSets: vi.fn(async () => ({
    available: true,
    catalog_revision: 1,
    sets: [{ set_id: "base", name: "Base Set", code: "BS" }],
  })),
}));
vi.mock("../shell/keptRead", () => ({ useFirstReadSettled: () => {} }));
vi.mock("./CatalogFilters", () => ({ CatalogFilters: () => null }));
vi.mock("./usePlaces", () => ({
  usePlaces: vi.fn(() => ({ leaves: [], state: "ready" })),
}));
vi.mock("./useCatalogBrowse", () => ({ useCatalogBrowse: vi.fn() }));
vi.mock("./CatalogCardPopup", () => ({ CatalogCardPopup: () => null }));

const empty = {
  first: { available: true, matches: 0, search: { mode: "all" } },
  editions: [],
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: "",
  errorMore: false,
  notice: "",
  loadMore: vi.fn(),
  noteAdded: vi.fn(),
  retry: vi.fn(),
};
const NARROWED: CatalogView = {
  q: "zzzzqq",
  format: "standard",
  kind: "pokemon",
  setId: "base",
  owned: true,
  mode: "add",
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const changes: CatalogView[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(usePlaces).mockReturnValue({
    leaves: [],
    state: "ready",
    path: () => null,
    reload: vi.fn(),
  });
  vi.mocked(useCatalogBrowse).mockReturnValue(
    empty as unknown as ReturnType<typeof useCatalogBrowse>
  );
  changes.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const clearButton = () =>
  [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Clear search and filters"
  );

function Page({ start }: { start: CatalogView }) {
  const [view, setView] = useState(start);
  return h(CatalogGallery, {
    active: true,
    view,
    onViewChange: (next: CatalogView) => {
      changes.push(next);
      setView(next);
    },
    adding: false,
    fixedTarget: null,
    undoToast: true,
    stick: "page",
  });
}
// A new key each time: the page keeps the view it was started with.
let mounts = 0;
const mount = (start: CatalogView) =>
  act(async () =>
    root.render(h(ToastProvider, null, h(Page, { start, key: ++mounts })))
  );

test("an empty search with a search or filters offers one step that clears them all and keeps the mode", async () => {
  await mount(NARROWED);
  expect(host.textContent).toContain("No cards match this search.");
  await act(async () => clearButton()!.click());
  expect(changes).toEqual([
    {
      q: "",
      format: null,
      kind: null,
      setId: null,
      owned: false,
      mode: "add",
    },
  ]);
  expect(document.activeElement).toBe(
    host.querySelector('input[type="search"]')
  );
});

test("each narrowing alone is enough to offer it, and none offers nothing to clear", async () => {
  for (const narrowing of [
    { q: "zzzzqq" },
    { format: "standard" as const },
    { kind: "pokemon" as const },
    { setId: "base" },
    { owned: true },
  ]) {
    await mount({
      ...NARROWED,
      q: "",
      format: null,
      kind: null,
      setId: null,
      owned: false,
      ...narrowing,
    });
    expect(clearButton(), JSON.stringify(narrowing)).toBeDefined();
  }
  await mount({
    ...NARROWED,
    q: "",
    format: null,
    kind: null,
    setId: null,
    owned: false,
  });
  expect(host.textContent).toContain("No cards match this search.");
  expect(clearButton()).toBeUndefined();
});

test("without an address, the page's own search and filters clear together", async () => {
  function Local() {
    return h(CatalogGallery, {
      active: true,
      adding: false,
      fixedTarget: null,
      undoToast: true,
      stick: "page",
    });
  }
  await act(async () => root.render(h(ToastProvider, null, h(Local))));
  const field = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!;
    set.call(field, "zzzzqq");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(field.value).toBe("zzzzqq");
  await act(async () => clearButton()!.click());
  expect(field.value).toBe("");
  expect(clearButton()).toBeUndefined();
});
