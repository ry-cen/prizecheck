// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CatalogGallery } from "./CatalogGallery";
import type { CatalogCardPopup } from "./CatalogCardPopup";
import { useCatalogBrowse } from "./useCatalogBrowse";
import { usePlaces } from "./usePlaces";
import { TOAST_LIFETIME_MS, ToastProvider } from "../ui/Toast";

// An Add that failed after its row closed is reported in a toast: the collector has to read it, and the page shows
// it nowhere else, so it stays up past a confirmation's TOAST_LIFETIME_MS.
vi.mock("../shell/keptRead", () => ({ useFirstReadSettled: () => {} }));
vi.mock("./CatalogFilters", () => ({ CatalogFilters: () => null }));
vi.mock("./usePlaces", () => ({
  usePlaces: vi.fn(() => ({ leaves: [], state: "ready" })),
}));
vi.mock("./useCatalogBrowse", () => ({ useCatalogBrowse: vi.fn() }));
vi.mock("./CatalogCardPopup", () => ({
  CatalogCardPopup: (props: Parameters<typeof CatalogCardPopup>[0]) => {
    popup = props;
    return null;
  },
}));
let popup!: Parameters<typeof CatalogCardPopup>[0];
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(usePlaces).mockReturnValue({
    leaves: [],
    state: "ready",
    path: () => null,
    reload: vi.fn(),
  });
  vi.mocked(useCatalogBrowse).mockReturnValue({
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
  } as unknown as ReturnType<typeof useCatalogBrowse>);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      h(
        ToastProvider,
        null,
        h(CatalogGallery, {
          active: true,
          adding: false,
          fixedTarget: null,
          undoToast: true,
          stick: "page",
        })
      )
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("the late Add failure toast stays up until it is replaced or dismissed", async () => {
  const message = "Add may have completed. Press Add again to check safely.";
  await act(async () => popup.onAddFailed?.(message));
  const toasts = () => host.querySelector("#app-toasts")?.textContent ?? "";
  expect(toasts()).toContain(message);
  await act(async () => vi.advanceTimersByTime(TOAST_LIFETIME_MS * 4));
  expect(toasts()).toContain(message);
});
