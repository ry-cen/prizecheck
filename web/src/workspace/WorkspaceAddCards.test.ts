// @vitest-environment jsdom
// #689: Add cards on a Location link waits for the tree to show that Location, so it opens set to it rather than
// with the picker preselecting Unsorted.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRoute } from "../shell/useRoute";
import { ToastProvider } from "../ui/Toast";
import type { TreeResponse } from "../location_generated";
import { Workspace } from "./Workspace";

type Read = {
  resolve: (ids: string[]) => void;
  reject: () => void;
};
const tree = vi.hoisted(() => ({ reads: [] as Read[] }));

vi.mock("../location_generated", async (original) => ({
  ...(await original<typeof import("../location_generated")>()),
  getLocationTree: () =>
    new Promise<TreeResponse>((resolve, reject) => {
      tree.reads.push({
        resolve: (ids) =>
          resolve({
            locations: ids.map((id) => ({
              id,
              name: id,
              kind: "storage",
              parent_id: null,
              version: 1,
              depth: 0,
              copy_count: "0",
              hidden: false,
              hidden_by: null,
              own_for_trade: false,
              for_trade: false,
              for_trade_by: null,
            })),
            owner_revision: tree.reads.length,
            lent_copies: "0",
            borrowed_copies: "0",
          }),
        reject: () => reject(new Error("unavailable")),
      });
    }),
}));
// Add cards itself is the catalog gallery; here it shows only whether it is open and what it adds to.
const adding = vi.hoisted(() => ({
  onTargetGone: (() => {}) as () => void,
}));
vi.mock("./AddCardsGallery", () => ({
  AddCardsGallery: (props: {
    open: boolean;
    target: { label: string } | null;
    onTargetGone: () => void;
  }) => {
    adding.onTargetGone = props.onTargetGone;
    return props.open
      ? h("div", { "data-testid": "adding" }, props.target?.label ?? "picker")
      : null;
  },
}));
vi.mock("./useGalleryData", async () => {
  const { EMPTY_GALLERY } = await import("./galleryModel");
  const ready = {
    ...EMPTY_GALLERY,
    status: "ready",
    ownerRevision: 1,
    reload: () => {},
    refresh: () => false,
    refreshing: false,
  };
  return { useGalleryData: () => ready };
});
vi.mock("./useOwnedSets", () => ({ useOwnedSets: () => [] }));
vi.mock("./useInventoryActions", () => ({
  useInventoryActions: () => ({
    busy: false,
    dialog: null,
    pending: null,
    toast: null,
    actionsButton: { current: null },
    hostNotice: { current: null },
    superseded: () => {},
  }),
}));
vi.mock("./useStaleCollection", () => ({
  useStaleCollection: () => ({ stale: false, note: null }),
}));
vi.mock("./tileDrag", () => ({
  useTileDrag: () => ({ badge: null, drop: null }),
  DragBadge: () => null,
}));
vi.mock("./Gallery", () => ({ Gallery: () => null }));
vi.mock("./Inspector", () => ({
  Inspector: () => null,
  DetailsSheet: () => null,
}));
vi.mock("./CorrectionsNotice", () => ({ CorrectionsNotice: () => null }));
vi.mock("../shell/HeaderActions", () => ({ PhoneHeaderActions: () => null }));
vi.mock("../loans/BorrowedDialog", () => ({ BorrowedDialog: () => null }));
vi.mock("../loans/LentOutDialog", () => ({ LentOutDialog: () => null }));
vi.mock("../loans/LendOfferDialog", () => ({ LendOfferDialog: () => null }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  tree.reads.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(path: string) {
  window.history.replaceState(null, "", path);
  function Page() {
    const route = useRoute();
    return h(Workspace, {
      userId: "add-cards-collector",
      address: route.address,
      active: true,
      onNavigate: route.navigate,
      onCloseCard: route.closeOverlay,
      onOpenDeck: () => {},
      onImport: () => {},
      onOpenLoan: () => {},
    });
  }
  await act(async () => root.render(h(ToastProvider, null, h(Page))));
}

const addCards = () =>
  [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Add cards"
  )!;
const dialog = () => host.querySelector('[data-testid="adding"]');
async function answer(read: number, ids: string[] | "error") {
  await act(async () => {
    if (ids === "error") tree.reads[read].reject();
    else tree.reads[read].resolve(ids);
  });
}
async function press(button: HTMLButtonElement) {
  await act(async () => button.click());
}

it("waits for the first tree read, then opens set to the Location", async () => {
  await open("/collection?location=A");
  expect(tree.reads).toHaveLength(1);
  expect(addCards().disabled).toBe(true);
  await press(addCards());
  expect(dialog()).toBeNull();
  await answer(0, ["A", "B"]);
  expect(addCards().disabled).toBe(false);
  await press(addCards());
  expect(dialog()?.textContent).toBe("A");
});

it("stays unavailable through the second read and opens set to a Location it finds", async () => {
  await open("/collection?location=A");
  await answer(0, ["B"]);
  expect(tree.reads).toHaveLength(2);
  expect(addCards().disabled).toBe(true);
  expect(window.location.search).toBe("?location=A");
  await answer(1, ["A", "B"]);
  expect(window.location.search).toBe("?location=A");
  expect(addCards().disabled).toBe(false);
  await press(addCards());
  expect(dialog()?.textContent).toBe("A");
});

it("stays unavailable when the second read fails, and Retry brings back the fixed Location", async () => {
  await open("/collection?location=A");
  await answer(0, ["B"]);
  await answer(1, "error");
  expect(window.location.search).toBe("?location=A");
  expect(addCards().disabled).toBe(true);
  await press(addCards());
  expect(dialog()).toBeNull();
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry"
  )!;
  await press(retry);
  await answer(2, ["A", "B"]);
  expect(addCards().disabled).toBe(false);
  await press(addCards());
  expect(dialog()?.textContent).toBe("A");
});

it("opens with the picker once the second read confirms the Location is gone", async () => {
  await open("/collection?location=A");
  await answer(0, ["B"]);
  await answer(1, ["B"]);
  expect(window.location.search).toBe("");
  expect(addCards().disabled).toBe(false);
  await press(addCards());
  expect(dialog()?.textContent).toBe("picker");
});

it("after a failed first read, Retry brings back the fixed Location", async () => {
  await open("/collection?location=A");
  await answer(0, "error");
  expect(addCards().disabled).toBe(true);
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry"
  )!;
  await press(retry);
  expect(addCards().disabled).toBe(true);
  await answer(1, ["A"]);
  expect(addCards().disabled).toBe(false);
  await press(addCards());
  expect(dialog()?.textContent).toBe("A");
});

it("never disables Add cards while a resolved Location's tree is read again", async () => {
  await open("/collection?location=A");
  await answer(0, ["A"]);
  await act(async () => adding.onTargetGone());
  expect(tree.reads).toHaveLength(2);
  expect(addCards().disabled).toBe(false);
  await answer(1, ["A"]);
  expect(addCards().disabled).toBe(false);
});

it("keeps Add cards available on All owned before the tree answers", async () => {
  await open("/collection");
  expect(addCards().disabled).toBe(false);
  await press(addCards());
  expect(dialog()?.textContent).toBe("picker");
});
